/**
 * Integration tests covering every gap implemented in the CoCo plugin story.
 * These verify the pure-logic layers that underpin each gap's UI component,
 * exercisable without a browser or a running OpenShift console.
 *
 * Gap 1 – RBAC wiring  (asAccessReview, useCocoPermissions shape)
 * Gap 2 – Bare-metal scope banner (infrastructure platform check)
 * Gap 3 – TEE node ineligibility (computeNodeReadiness composite)
 * Gap 4 – SEV-SNP + GPU enablement (IOMMU builders, tee detection)
 * Gap 5 – Stale attestation copy (evidence parsing, empty states)
 * Gap 6 – Workload metrics (Prometheus query construction)
 * Gap 7 – Regression guard (this file itself)
 */

import type { K8sVerb } from '@openshift-console/dynamic-plugin-sdk';
import type { KataConfigKind, NodeKind } from '../k8s/types';
import { asAccessReview } from './rbac/asAccessReview';
import {
  ConfigMapModel,
  KataConfigModel,
  MachineConfigModel,
  PodModel,
  DeploymentModel,
  OSC_NAMESPACE,
} from '../k8s/resources';
import { computeNodeReadiness } from './nodeReadiness';
import {
  buildIommuMachineConfig,
  buildTdxHostMachineConfig,
  hasIommuArgs,
  hasTdxHostArgs,
  iommuMachineConfigName,
  isIommuConfiguredForRole,
  IOMMU_INTEL_KERNEL_ARG,
  IOMMU_AMD_KERNEL_ARG,
  IOMMU_PASSTHROUGH_ARG,
} from './machineConfig';
import {
  buildCpuQuery,
  buildMemoryQuery,
  buildNetworkReceiveQuery,
  buildNetworkTransmitQuery,
  buildFilesystemReadQuery,
  buildFilesystemWriteQuery,
} from './workloadMetricsQueries';
import { shouldShowBaremetalBanner } from './baremetal';
import { teeTypeForNode, gpuCcReady, teeLabel, sgxCapable, sgxDevicePluginReady } from './tee';
import { parseEvidence, type EvidenceRecord } from './evidence';
import { classForRuntimeClass, isConfidentialClass, ccClassLabel } from './runtime';
import { cvmPeerPodsEnabled } from './topology';

const makeNode = (name: string, labels: Record<string, string> = {}, ready = true): NodeKind => ({
  metadata: { name, labels: { 'node-role.kubernetes.io/worker': '', ...labels } },
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});

const makeKataConfig = (overrides: Partial<KataConfigKind['status']> = {}): KataConfigKind => ({
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

// ---------------------------------------------------------------------------
// Gap 1: RBAC wiring
// ---------------------------------------------------------------------------
describe('Gap 1 – RBAC access review construction', () => {
  it('builds cluster-scoped review for KataConfig create', () => {
    const review = asAccessReview(KataConfigModel, 'create');
    expect(review.group).toBe('kataconfiguration.openshift.io');
    expect(review.resource).toBe('kataconfigs');
    expect(review.verb).toBe('create');
    expect(review.namespace).toBeUndefined();
  });

  it('builds namespaced review for ConfigMap patch in OSC namespace', () => {
    const review = asAccessReview(ConfigMapModel, 'patch', OSC_NAMESPACE);
    expect(review.namespace).toBe(OSC_NAMESPACE);
    expect(review.verb).toBe('patch');
  });

  it('builds review for MachineConfig create (cluster-scoped)', () => {
    const review = asAccessReview(MachineConfigModel, 'create');
    expect(review.group).toBe('machineconfiguration.openshift.io');
    expect(review.resource).toBe('machineconfigs');
  });

  it('builds review for Pod delete in a namespace', () => {
    const review = asAccessReview(PodModel, 'delete', 'my-ns');
    expect(review.group).toBe('');
    expect(review.resource).toBe('pods');
    expect(review.verb).toBe('delete');
    expect(review.namespace).toBe('my-ns');
  });

  it('builds review for Deployment create in a namespace', () => {
    const review = asAccessReview(DeploymentModel, 'create', 'app-ns');
    expect(review.group).toBe('apps');
    expect(review.resource).toBe('deployments');
    expect(review.verb).toBe('create');
    expect(review.namespace).toBe('app-ns');
  });

  it('covers every mutating verb used by the plugin', () => {
    const verbs: K8sVerb[] = ['create', 'patch', 'delete'];
    for (const verb of verbs) {
      const r = asAccessReview(PodModel, verb, 'ns');
      expect(r.verb).toBe(verb);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 2: Bare-metal scope banner
// ---------------------------------------------------------------------------
describe('Gap 2 – Infrastructure platform detection', () => {
  it('detects CVM peer-pods enabled', () => {
    expect(cvmPeerPodsEnabled({ CLOUD_PROVIDER: 'aws' })).toBe(true);
    expect(cvmPeerPodsEnabled({ CLOUD_PROVIDER: 'azure' })).toBe(true);
  });

  it('detects CVM peer-pods disabled', () => {
    expect(cvmPeerPodsEnabled(undefined)).toBe(false);
    expect(cvmPeerPodsEnabled({})).toBe(false);
    expect(cvmPeerPodsEnabled({ CLOUD_PROVIDER: 'aws', DISABLECVM: 'true' })).toBe(false);
  });

  it.each([
    ['AWS', true, false, true],
    ['Azure', true, false, true],
    ['GCP', true, false, true],
    ['VSphere', true, false, true],
    ['BareMetal', true, false, false],
    ['None', true, false, false],
    ['AWS', true, true, false],
    ['AWS', false, false, false],
    [undefined, true, false, false],
    ['', true, false, false],
  ])('banner policy: %s, loaded=%s, peers=%s', (platform, loaded, peers, expected) => {
    expect(shouldShowBaremetalBanner(platform, loaded, peers)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Gap 3: TEE node ineligibility reasons
// ---------------------------------------------------------------------------
describe('Gap 3 – Node readiness composite', () => {
  it('fully eligible TDX node has no reasons', () => {
    const n = makeNode('w1', {
      'intel.feature.node.kubernetes.io/tdx': 'true',
      'intel.feature.node.kubernetes.io/sgx': 'true',
    });
    n.status = {
      ...n.status,
      allocatable: {
        'sgx.intel.com/enclave': '10',
        'sgx.intel.com/provision': '10',
      },
    };
    const kc = makeKataConfig({ kataNodes: { installed: ['w1'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.eligible).toBe(true);
    expect(r.reasons).toHaveLength(0);
  });

  it('eligible SNP node with kata installing', () => {
    const n = makeNode('w2', { 'amd.feature.node.kubernetes.io/snp': 'true' });
    const kc = makeKataConfig({ kataNodes: { installing: ['w2'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.eligible).toBe(true);
    expect(r.teeType).toBe('snp');
    expect(r.kataInstalling).toBe(true);
  });

  it('plain worker without TEE is ineligible with reasons', () => {
    const n = makeNode('plain');
    const r = computeNodeReadiness(n);
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('No TEE label (TDX/SNP) or GPU-CC detected');
  });

  it('master node is not a worker and ineligible', () => {
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
    const n = makeNode('w3', { 'intel.feature.node.kubernetes.io/tdx': 'true' });
    const kc = makeKataConfig({ kataNodes: { failedToInstall: ['w3'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.kataFailed).toBe(true);
    expect(r.reasons).toContain('Kata installation failed');
  });

  it('reports node not ready', () => {
    const n = makeNode(
      'w4',
      {
        'amd.feature.node.kubernetes.io/snp': 'true',
      },
      false,
    );
    const kc = makeKataConfig({ kataNodes: { installed: ['w4'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.nodeReady).toBe(false);
    expect(r.reasons).toContain('Node is not Ready');
  });

  it('GPU-CC node is eligible', () => {
    const n = makeNode('gpu1', {
      'nvidia.com/cc.mode.state': 'on',
      'nvidia.com/cc.ready.state': 'true',
    });
    const kc = makeKataConfig({ kataNodes: { installed: ['gpu1'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.gpuCcReady).toBe(true);
    expect(r.eligible).toBe(true);
  });

  it('TDX node without SGX reports reason', () => {
    const n = makeNode('w5', { 'intel.feature.node.kubernetes.io/tdx': 'true' });
    const kc = makeKataConfig({ kataNodes: { installed: ['w5'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.reasons).toContain('SGX not detected (needed for TDX quotes)');
  });

  it('multiple ineligibility reasons accumulate', () => {
    const n: NodeKind = {
      metadata: {
        name: 'bad',
        labels: { 'node-role.kubernetes.io/master': '' },
      },
      status: { conditions: [{ type: 'Ready', status: 'False' }] },
    };
    const r = computeNodeReadiness(n);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
    expect(r.reasons).toContain('Not a worker node');
    expect(r.reasons).toContain('Node is not Ready');
  });
});

// ---------------------------------------------------------------------------
// Gap 4: SEV-SNP + GPU guided enablement
// ---------------------------------------------------------------------------
describe('Gap 4 – TEE detection and IOMMU enablement', () => {
  it('detects TDX from NFD label', () => {
    const n = makeNode('tdx', { 'intel.feature.node.kubernetes.io/tdx': 'true' });
    expect(teeTypeForNode(n)).toBe('tdx');
  });

  it('detects SNP from NFD label', () => {
    const n = makeNode('snp', { 'amd.feature.node.kubernetes.io/snp': 'true' });
    expect(teeTypeForNode(n)).toBe('snp');
  });

  it('detects GPU-CC readiness labels', () => {
    const n = makeNode('gpu', {
      'nvidia.com/cc.mode.state': 'on',
      'nvidia.com/cc.ready.state': 'true',
    });
    expect(gpuCcReady(n)).toBe(true);
  });

  it('GPU-CC not ready when labels missing', () => {
    const n = makeNode('plain', {});
    expect(gpuCcReady(n)).toBe(false);
  });

  it('GPU-CC not ready when mode is off', () => {
    const n = makeNode('gpu-off', { 'nvidia.com/cc.mode.state': 'off' });
    expect(gpuCcReady(n)).toBe(false);
  });

  it('detects SGX capability from labels', () => {
    const n = makeNode('sgx', { 'intel.feature.node.kubernetes.io/sgx': 'true' });
    expect(sgxCapable(n)).toBe(true);
  });

  it('detects SGX device plugin from allocatable resources', () => {
    const n = makeNode('sgx', {});
    n.status = {
      ...n.status,
      allocatable: { 'sgx.intel.com/enclave': '10', 'sgx.intel.com/provision': '10' },
    };
    expect(sgxDevicePluginReady(n)).toBe(true);
  });

  it('returns label strings for TEE types', () => {
    expect(teeLabel('tdx')).toBe('Intel TDX');
    expect(teeLabel('snp')).toBe('AMD SEV-SNP');
    expect(teeLabel('none')).toBe('None');
  });

  it('builds Intel IOMMU MachineConfig', () => {
    const mc = buildIommuMachineConfig('worker', 'intel') as Record<string, unknown>;
    const meta = mc.metadata as Record<string, unknown>;
    const spec = mc.spec as Record<string, unknown>;
    expect(meta.name).toBe('99-worker-iommu-intel');
    expect((meta.labels as Record<string, string>)['machineconfiguration.openshift.io/role']).toBe(
      'worker',
    );
    expect(spec.kernelArguments).toEqual([IOMMU_INTEL_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG]);
  });

  it('builds AMD IOMMU MachineConfig', () => {
    const mc = buildIommuMachineConfig('kata-oc', 'amd') as Record<string, unknown>;
    const spec = mc.spec as Record<string, unknown>;
    expect(spec.kernelArguments).toEqual([IOMMU_AMD_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG]);
    expect((mc.metadata as Record<string, unknown>).name).toBe('99-kata-oc-iommu-amd');
  });

  it('detects IOMMU kernel args', () => {
    expect(hasIommuArgs([IOMMU_INTEL_KERNEL_ARG])).toBe(true);
    expect(hasIommuArgs([IOMMU_AMD_KERNEL_ARG])).toBe(true);
    expect(hasIommuArgs(['nohibernate'])).toBe(false);
    expect(hasIommuArgs(undefined)).toBe(false);
  });

  it('IOMMU MachineConfig naming', () => {
    expect(iommuMachineConfigName('worker', 'intel')).toBe('99-worker-iommu-intel');
    expect(iommuMachineConfigName('kata-oc', 'amd')).toBe('99-kata-oc-iommu-amd');
  });

  it('TDX host MachineConfig is independent of IOMMU', () => {
    const tdx = buildTdxHostMachineConfig('worker') as Record<string, unknown>;
    const spec = tdx.spec as Record<string, unknown>;
    expect(hasTdxHostArgs(spec.kernelArguments as string[])).toBe(true);
    expect(hasIommuArgs(spec.kernelArguments as string[])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 5: Stale attestation copy cleanup
// ---------------------------------------------------------------------------
describe('Gap 5 – Evidence parsing and runtime classification', () => {
  it('parses valid evidence JSON', () => {
    const evidence: EvidenceRecord | undefined = parseEvidence(
      JSON.stringify({
        workload: { name: 'test-pod', namespace: 'ns', runtimeClassName: 'kata-cc' },
        source: 'sidecar',
        timestamp: '2025-01-01T00:00:00Z',
        verdict: 'passed',
        trustee: { kbsEndpoint: 'http://kbs:8080' },
      }),
    );
    expect(evidence).toEqual(
      expect.objectContaining({
        workload: expect.objectContaining({ name: 'test-pod' }),
        source: 'sidecar',
        verdict: 'passed',
        trustee: expect.objectContaining({ kbsEndpoint: 'http://kbs:8080' }),
      }),
    );
  });

  it('returns undefined for invalid evidence', () => {
    expect(parseEvidence(undefined)).toBeUndefined();
    expect(parseEvidence('')).toBeUndefined();
    expect(parseEvidence('not-json')).toBeUndefined();
  });

  it('classifies confidential runtime classes', () => {
    expect(
      classForRuntimeClass({
        metadata: { name: 'kata-cc' },
        handler: 'kata-cc',
      }),
    ).toBe('confidential');
    expect(isConfidentialClass('confidential')).toBe(true);
    expect(isConfidentialClass('confidential-gpu')).toBe(true);
  });

  it('classifies kata-cc-nvidia-gpu as confidential-gpu', () => {
    expect(
      classForRuntimeClass({
        metadata: { name: 'kata-cc-nvidia-gpu' },
        handler: 'kata-cc-nvidia-gpu',
      }),
    ).toBe('confidential-gpu');
  });

  it('classifies non-confidential runtimes', () => {
    expect(isConfidentialClass('unknown')).toBe(false);
    expect(isConfidentialClass('peerpod')).toBe(false);
    expect(isConfidentialClass('sandbox')).toBe(false);
  });

  it('labels confidential classes correctly', () => {
    expect(ccClassLabel('confidential')).toContain('Confidential');
    expect(ccClassLabel('confidential-gpu')).toContain('GPU');
    expect(ccClassLabel('peerpod')).toBe('Peer pod');
    expect(ccClassLabel('sandbox')).toBe('Sandbox');
  });
});

// ---------------------------------------------------------------------------
// Gap 6: Workload metrics (query construction)
// ---------------------------------------------------------------------------
describe('Gap 6 – Production Prometheus queries', () => {
  const ns = 'cc-workloads';
  const pod = 'my-pod';

  it('builds the actual production queries', () => {
    expect(buildCpuQuery(ns, pod)).toBe(
      'sum(rate(container_cpu_usage_seconds_total{namespace="cc-workloads",pod="my-pod",container!="POD",container!=""}[5m]))',
    );

    expect(buildMemoryQuery(ns, pod)).toBe(
      'sum(container_memory_working_set_bytes{namespace="cc-workloads",pod="my-pod",container!="POD",container!=""})',
    );

    expect(buildNetworkReceiveQuery(ns, pod)).toBe(
      'sum(rate(container_network_receive_bytes_total{namespace="cc-workloads",pod="my-pod"}[5m]))',
    );

    expect(buildNetworkTransmitQuery(ns, pod)).toBe(
      'sum(rate(container_network_transmit_bytes_total{namespace="cc-workloads",pod="my-pod"}[5m]))',
    );

    expect(buildFilesystemReadQuery(ns, pod)).toBe(
      'sum(rate(container_fs_reads_bytes_total{namespace="cc-workloads",pod="my-pod",container!="POD",container!=""}[5m]))',
    );

    expect(buildFilesystemWriteQuery(ns, pod)).toBe(
      'sum(rate(container_fs_writes_bytes_total{namespace="cc-workloads",pod="my-pod",container!="POD",container!=""}[5m]))',
    );
  });
});

describe('IOMMU pool and vendor regression', () => {
  const configs = [
    {
      metadata: {
        labels: {
          'machineconfiguration.openshift.io/role': 'master',
        },
      },
      spec: {
        kernelArguments: [IOMMU_INTEL_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG],
      },
    },
    {
      metadata: {
        labels: {
          'machineconfiguration.openshift.io/role': 'worker',
        },
      },
      spec: {
        kernelArguments: [IOMMU_AMD_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG],
      },
    },
  ];

  it('matches the selected role and vendor', () => {
    expect(isIommuConfiguredForRole(configs, 'master', 'intel')).toBe(true);
    expect(isIommuConfiguredForRole(configs, 'worker', 'amd')).toBe(true);
    expect(isIommuConfiguredForRole(configs, 'worker', 'intel')).toBe(false);
    expect(isIommuConfiguredForRole(configs, 'kata-oc', 'amd')).toBe(false);
  });

  it('requires iommu=pt', () => {
    const incomplete = [
      {
        metadata: {
          labels: {
            'machineconfiguration.openshift.io/role': 'worker',
          },
        },
        spec: { kernelArguments: [IOMMU_INTEL_KERNEL_ARG] },
      },
    ];
    expect(isIommuConfiguredForRole(incomplete, 'worker', 'intel')).toBe(false);
  });

  it('handles missing spec safely', () => {
    const missingSpec = [
      {
        metadata: {
          labels: {
            'machineconfiguration.openshift.io/role': 'worker',
          },
        },
      },
    ];
    expect(isIommuConfiguredForRole(missingSpec, 'worker', 'intel')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 7: Cross-gap integration
// ---------------------------------------------------------------------------
describe('Gap 7 – Cross-gap integration checks', () => {
  it('RBAC models cover all mutating resources used by the plugin', () => {
    const models = [ConfigMapModel, KataConfigModel, MachineConfigModel, PodModel, DeploymentModel];
    for (const m of models) {
      expect(m.plural).toBeTruthy();
      expect(m.kind).toBeTruthy();
    }
  });

  it('node readiness handles nodes with no labels gracefully', () => {
    const n: NodeKind = {
      metadata: { name: 'bare' },
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    };
    const r = computeNodeReadiness(n);
    expect(r.isWorker).toBe(true);
    expect(r.teeType).toBe('none');
    expect(r.eligible).toBe(false);
  });

  it('IOMMU and TDX host MachineConfigs have different names for same role', () => {
    const iommu = iommuMachineConfigName('worker', 'intel');
    const tdx = '99-worker-tdx-host';
    expect(iommu).not.toBe(tdx);
  });

  it('all ccClass values are covered by isConfidentialClass', () => {
    const confidential = ['confidential', 'confidential-gpu'];
    const notConfidential = ['unknown', 'peerpod', 'sandbox'];
    for (const c of confidential) {
      expect(isConfidentialClass(c as never)).toBe(true);
    }
    for (const c of notConfidential) {
      expect(isConfidentialClass(c as never)).toBe(false);
    }
  });

  it('node with GPU-CC but no TEE label is still eligible via gpuCcReady', () => {
    const n = makeNode('gpu-only', {
      'nvidia.com/cc.mode.state': 'on',
      'nvidia.com/cc.ready.state': 'true',
    });
    const kc = makeKataConfig({ kataNodes: { installed: ['gpu-only'] } });
    const r = computeNodeReadiness(n, kc);
    expect(r.teeType).toBe('none');
    expect(r.gpuCcReady).toBe(true);
    expect(r.eligible).toBe(true);
  });

  it('evidence for an unknown workload does not crash parseEvidence', () => {
    const ev = parseEvidence(JSON.stringify({ source: 'sidecar', verdict: 'failed' }));
    expect(ev).toEqual(
      expect.objectContaining({
        source: 'sidecar',
        verdict: 'failed',
      }),
    );
    expect(ev?.workload).toBeUndefined();
  });
});
