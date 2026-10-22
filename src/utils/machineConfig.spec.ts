import type { MachineConfigPoolKind, NodeKind } from '../k8s/types';
import {
  buildIommuMachineConfig,
  buildTdxHostMachineConfig,
  hasIommuArgs,
  hasTdxHostArgs,
  iommuMachineConfigName,
  IOMMU_AMD_KERNEL_ARG,
  IOMMU_INTEL_KERNEL_ARG,
  IOMMU_PASSTHROUGH_ARG,
  poolRoleForNode,
  rolesForNodes,
  TDX_HOST_KERNEL_ARGS,
  tdxHostMachineConfigName,
} from './machineConfig';

interface McShape {
  metadata: { name: string; labels?: Record<string, string> };
  spec: { kernelArguments?: string[] };
}

const node = (name: string, labels: Record<string, string> = {}): NodeKind => ({
  metadata: { name, labels },
});
const workerPool: MachineConfigPoolKind = {
  metadata: { name: 'worker' },
  spec: { nodeSelector: { matchLabels: { 'node-role.kubernetes.io/worker': '' } } },
};
const kataPool: MachineConfigPoolKind = {
  metadata: { name: 'kata-oc' },
  spec: { nodeSelector: { matchLabels: { 'node-role.kubernetes.io/kata-oc': '' } } },
};

describe('tdxHostMachineConfigName', () => {
  it('names the MachineConfig after the pool role', () => {
    expect(tdxHostMachineConfigName('worker')).toBe('99-worker-tdx-host');
    expect(tdxHostMachineConfigName('kata-oc')).toBe('99-kata-oc-tdx-host');
  });
});

describe('hasTdxHostArgs', () => {
  it('detects the TDX kvm arg', () => {
    expect(hasTdxHostArgs(['nohibernate', 'kvm_intel.tdx=1'])).toBe(true);
    expect(hasTdxHostArgs(['nohibernate'])).toBe(false);
    expect(hasTdxHostArgs(undefined)).toBe(false);
  });
});

describe('buildTdxHostMachineConfig', () => {
  it('carries both kernel args and the role label', () => {
    const mc = buildTdxHostMachineConfig('kata-oc') as unknown as McShape;
    expect(mc.metadata.name).toBe('99-kata-oc-tdx-host');
    expect(mc.metadata.labels?.['machineconfiguration.openshift.io/role']).toBe('kata-oc');
    expect(mc.spec.kernelArguments).toEqual(TDX_HOST_KERNEL_ARGS);
  });
});

describe('poolRoleForNode', () => {
  it('returns the custom pool a node belongs to (kata-oc), not worker', () => {
    const n = node('metal', {
      'node-role.kubernetes.io/worker': '',
      'node-role.kubernetes.io/kata-oc': '',
    });
    expect(poolRoleForNode(n, [workerPool, kataPool])).toBe('kata-oc');
  });

  it('falls back to worker when no custom pool matches', () => {
    const n = node('w', { 'node-role.kubernetes.io/worker': '' });
    expect(poolRoleForNode(n, [workerPool, kataPool])).toBe('worker');
  });
});

describe('rolesForNodes', () => {
  it('returns the distinct sorted pool roles', () => {
    const metal = node('metal', {
      'node-role.kubernetes.io/worker': '',
      'node-role.kubernetes.io/kata-oc': '',
    });
    const plain = node('w', { 'node-role.kubernetes.io/worker': '' });
    expect(rolesForNodes([metal, plain], [workerPool, kataPool])).toEqual(['kata-oc', 'worker']);
  });
});

describe('iommuMachineConfigName', () => {
  it('names the MachineConfig after the pool role and vendor', () => {
    expect(iommuMachineConfigName('worker', 'intel')).toBe('99-worker-iommu-intel');
    expect(iommuMachineConfigName('kata-oc', 'amd')).toBe('99-kata-oc-iommu-amd');
  });
});

describe('hasIommuArgs', () => {
  it('detects Intel IOMMU args', () => {
    expect(hasIommuArgs([IOMMU_INTEL_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG])).toBe(true);
  });
  it('detects AMD IOMMU args', () => {
    expect(hasIommuArgs([IOMMU_AMD_KERNEL_ARG])).toBe(true);
  });
  it('returns false when absent', () => {
    expect(hasIommuArgs(['nohibernate'])).toBe(false);
    expect(hasIommuArgs(undefined)).toBe(false);
  });
});

describe('buildIommuMachineConfig', () => {
  it('builds Intel IOMMU MachineConfig', () => {
    const mc = buildIommuMachineConfig('worker', 'intel') as unknown as McShape;
    expect(mc.metadata.name).toBe('99-worker-iommu-intel');
    expect(mc.metadata.labels?.['machineconfiguration.openshift.io/role']).toBe('worker');
    expect(mc.spec.kernelArguments).toEqual([IOMMU_INTEL_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG]);
  });
  it('builds AMD IOMMU MachineConfig', () => {
    const mc = buildIommuMachineConfig('kata-oc', 'amd') as unknown as McShape;
    expect(mc.metadata.name).toBe('99-kata-oc-iommu-amd');
    expect(mc.spec.kernelArguments).toEqual([IOMMU_AMD_KERNEL_ARG, IOMMU_PASSTHROUGH_ARG]);
  });
});
