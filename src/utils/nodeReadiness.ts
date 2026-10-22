import type { KataConfigKind, MachineConfigPoolKind, NodeKind } from '../k8s/types';
import { teeTypeForNode, gpuCcReady, sgxCapable, sgxDevicePluginReady } from './tee';
import { findPoolForRole, mcpRolloutState } from './machineConfigPool';

export interface NodeReadiness {
  name: string;
  isWorker: boolean;
  teeDetected: boolean;
  teeType: 'tdx' | 'snp' | 'none';
  gpuCcReady: boolean;
  sgxCapable: boolean;
  sgxPluginReady: boolean;
  nodeReady: boolean;
  kataInstalled: boolean;
  kataInstalling: boolean;
  kataFailed: boolean;
  mcpUpdated: boolean;
  mcpUpdating: boolean;
  eligible: boolean;
  reasons: string[];
  obj: NodeKind;
}

const NODE_ROLE_PREFIX = 'node-role.kubernetes.io/';

const isWorkerNode = (node: NodeKind): boolean => {
  const labels = node.metadata?.labels ?? {};
  const roles = Object.keys(labels)
    .filter((k) => k.startsWith(NODE_ROLE_PREFIX))
    .map((k) => k.slice(NODE_ROLE_PREFIX.length));
  return (
    roles.includes('worker') ||
    (!roles.includes('master') && !roles.includes('control-plane') && roles.length === 0)
  );
};

const isNodeReady = (node: NodeKind): boolean =>
  (node.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');

export const computeNodeReadiness = (
  node: NodeKind,
  kataConfig?: KataConfigKind,
  pools?: MachineConfigPoolKind[],
): NodeReadiness => {
  const name = node.metadata?.name ?? '';
  const teeType = teeTypeForNode(node);
  const teeDetected = teeType !== 'none';
  const gpu = gpuCcReady(node);
  const sgx = sgxCapable(node);
  const sgxPlugin = sgxDevicePluginReady(node);
  const nodeReady = isNodeReady(node);
  const worker = isWorkerNode(node);

  const kataNodes = kataConfig?.status?.kataNodes;
  const installed = (kataNodes?.installed ?? []).includes(name);
  const installing =
    (kataNodes?.installing ?? []).includes(name) ||
    (kataNodes?.waitingToInstall ?? []).includes(name);
  const failed = (kataNodes?.failedToInstall ?? []).includes(name);

  let mcpUpdated = true;
  let mcpUpdating = false;
  if (pools && pools.length > 0) {
    const labels = node.metadata?.labels ?? {};
    const nodeRoles = Object.keys(labels)
      .filter((k) => k.startsWith(NODE_ROLE_PREFIX))
      .map((k) => k.slice(NODE_ROLE_PREFIX.length))
      .filter(Boolean);
    for (const role of nodeRoles) {
      const pool = findPoolForRole(pools, role);
      if (pool) {
        const rollout = mcpRolloutState(pool);
        if (rollout.phase === 'updating') {
          mcpUpdating = true;
          mcpUpdated = false;
        }
        if (rollout.phase === 'degraded') {
          mcpUpdated = false;
        }
      }
    }
  }

  const reasons: string[] = [];
  if (!worker) reasons.push('Not a worker node');
  if (!teeDetected && !gpu) reasons.push('No TEE label (TDX/SNP) or GPU-CC detected');
  if (!nodeReady) reasons.push('Node is not Ready');
  if (failed) reasons.push('Kata installation failed');
  if (!installed && !installing && !failed && kataConfig)
    reasons.push('Kata runtime not installed');
  if (mcpUpdating) reasons.push('MachineConfigPool update in progress');
  if (!mcpUpdated && !mcpUpdating) reasons.push('MachineConfigPool not updated');
  if (teeType === 'tdx' && !sgx) reasons.push('SGX not detected (needed for TDX quotes)');
  if (teeType === 'tdx' && sgx && !sgxPlugin) reasons.push('SGX device plugin not installed');

  const eligible =
    worker && (teeDetected || gpu) && nodeReady && (installed || installing) && mcpUpdated;

  return {
    name,
    isWorker: worker,
    teeDetected,
    teeType,
    gpuCcReady: gpu,
    sgxCapable: sgx,
    sgxPluginReady: sgxPlugin,
    nodeReady,
    kataInstalled: installed,
    kataInstalling: installing,
    kataFailed: failed,
    mcpUpdated,
    mcpUpdating,
    eligible,
    reasons,
    obj: node,
  };
};
