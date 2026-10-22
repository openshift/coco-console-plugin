import type { KataConfigKind, MachineConfigPoolKind, NodeKind } from '../k8s/types';
import { computeNodeReadiness } from './nodeReadiness';

const node = (name: string, extra: Partial<NodeKind> = {}): NodeKind => ({
  metadata: { name, labels: { 'node-role.kubernetes.io/worker': '' }, ...extra.metadata },
  status: {
    conditions: [{ type: 'Ready', status: 'True' }],
    ...extra.status,
  },
});

const tdxNode = (name: string, extra: Partial<NodeKind> = {}): NodeKind =>
  node(name, {
    metadata: {
      labels: {
        'node-role.kubernetes.io/worker': '',
        'intel.feature.node.kubernetes.io/tdx': 'true',
        'intel.feature.node.kubernetes.io/sgx': 'true',
        ...extra.metadata?.labels,
      },
      ...extra.metadata,
    },
    status: {
      conditions: [{ type: 'Ready', status: 'True' }],
      allocatable: {
        'sgx.intel.com/enclave': '10',
        'sgx.intel.com/provision': '10',
        ...extra.status?.allocatable,
      },
      ...extra.status,
    },
  });

const snpNode = (name: string): NodeKind =>
  node(name, {
    metadata: {
      labels: {
        'node-role.kubernetes.io/worker': '',
        'amd.feature.node.kubernetes.io/snp': 'true',
      },
    },
  });

const kataConfig = (overrides: Partial<KataConfigKind['status']> = {}): KataConfigKind => ({
  metadata: { name: 'example-kataconfig' },
  status: {
    kataNodes: {
      installed: [],
      installing: [],
      waitingToInstall: [],
      failedToInstall: [],
    },
    ...overrides,
  },
});

const pool = (name: string, extra: Partial<MachineConfigPoolKind> = {}): MachineConfigPoolKind => ({
  metadata: { name },
  ...extra,
});

describe('computeNodeReadiness', () => {
  it('returns eligible for a fully ready TDX worker with kata installed', () => {
    const n = tdxNode('w1');
    const kc = kataConfig({ kataNodes: { installed: ['w1'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.eligible).toBe(true);
    expect(r.teeType).toBe('tdx');
    expect(r.reasons).toEqual([]);
  });

  it('returns eligible for an SNP worker with kata installing', () => {
    const n = snpNode('w2');
    const kc = kataConfig({ kataNodes: { installing: ['w2'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.eligible).toBe(true);
    expect(r.teeType).toBe('snp');
    expect(r.kataInstalling).toBe(true);
  });

  it('reports ineligible for a plain worker without TEE labels', () => {
    const n = node('plain');
    const r = computeNodeReadiness(n);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('No TEE label (TDX/SNP) or GPU-CC detected');
  });

  it('reports ineligible for a master/control-plane node', () => {
    const n: NodeKind = {
      metadata: {
        name: 'master-0',
        labels: {
          'node-role.kubernetes.io/master': '',
          'node-role.kubernetes.io/control-plane': '',
        },
      },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
    const r = computeNodeReadiness(n);
    expect(r.isWorker).toBe(false);
    expect(r.reasons).toContain('Not a worker node');
  });

  it('reports kata installation failed', () => {
    const n = tdxNode('w3');
    const kc = kataConfig({ kataNodes: { failedToInstall: ['w3'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.kataFailed).toBe(true);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('Kata installation failed');
  });

  it('reports kata not installed when KataConfig exists but node is not listed', () => {
    const n = tdxNode('w4');
    const kc = kataConfig();
    const r = computeNodeReadiness(n, kc);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('Kata runtime not installed');
  });

  it('does not report kata missing when no KataConfig exists', () => {
    const n = tdxNode('w5');
    const r = computeNodeReadiness(n);
    expect(r.reasons).not.toContain('Kata runtime not installed');
  });

  it('reports Node not Ready', () => {
    const n = tdxNode('w6', {
      status: {
        conditions: [{ type: 'Ready', status: 'False' }],
        allocatable: {
          'sgx.intel.com/enclave': '10',
          'sgx.intel.com/provision': '10',
        },
      },
    });
    const kc = kataConfig({ kataNodes: { installed: ['w6'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('Node is not Ready');
  });

  it('reports MCP updating', () => {
    const n = tdxNode('w7');
    const kc = kataConfig({ kataNodes: { installed: ['w7'] } });
    const pools = [
      pool('worker', {
        status: {
          machineCount: 3,
          updatedMachineCount: 1,
          conditions: [{ type: 'Updating', status: 'True' }],
        },
      }),
    ];
    const r = computeNodeReadiness(n, kc, pools);
    expect(r.mcpUpdating).toBe(true);
    expect(r.mcpUpdated).toBe(false);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('MachineConfigPool update in progress');
  });

  it('reports SGX not detected for TDX node without SGX labels', () => {
    const n = node('w8', {
      metadata: {
        labels: {
          'node-role.kubernetes.io/worker': '',
          'intel.feature.node.kubernetes.io/tdx': 'true',
        },
      },
    });
    const kc = kataConfig({ kataNodes: { installed: ['w8'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.reasons).toContain('SGX not detected (needed for TDX quotes)');
  });

  it('reports SGX device plugin not installed for TDX node with SGX but no plugin', () => {
    const n = node('w9', {
      metadata: {
        labels: {
          'node-role.kubernetes.io/worker': '',
          'intel.feature.node.kubernetes.io/tdx': 'true',
          'intel.feature.node.kubernetes.io/sgx': 'true',
        },
      },
    });
    const kc = kataConfig({ kataNodes: { installed: ['w9'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.reasons).toContain('SGX device plugin not installed');
  });

  it('treats a node with no role labels as a worker', () => {
    const n: NodeKind = {
      metadata: { name: 'bare' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
    const r = computeNodeReadiness(n);
    expect(r.isWorker).toBe(true);
  });

  it('detects GPU-CC ready node as TEE-eligible', () => {
    const n = node('gpu-1', {
      metadata: {
        labels: {
          'node-role.kubernetes.io/worker': '',
          'nvidia.com/cc.mode.state': 'on',
          'nvidia.com/cc.ready.state': 'true',
        },
      },
    });
    const kc = kataConfig({ kataNodes: { installed: ['gpu-1'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.gpuCcReady).toBe(true);
    expect(r.eligible).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});
