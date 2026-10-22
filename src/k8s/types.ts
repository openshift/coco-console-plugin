import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

/** A node.k8s.io/v1 RuntimeClass. */
export type RuntimeClassKind = K8sResourceCommon & {
  handler?: string;
  overhead?: {
    podFixed?: Record<string, string>;
  };
};

/** A v1 ConfigMap (we only read .data). */
export type ConfigMapKind = K8sResourceCommon & {
  data?: Record<string, string>;
};

/** A v1 Secret (we read .type / key names, never values). */
export type SecretKind = K8sResourceCommon & {
  data?: Record<string, string>;
  type?: string;
};

/** kataconfiguration.openshift.io/v1 KataConfig (cluster-scoped singleton). */
export type KataConfigKind = K8sResourceCommon & {
  spec?: {
    enablePeerPods?: boolean;
    logLevel?: string;
    checkNodeEligibility?: boolean;
    /**
     * Explicit node selector for which nodes get the kata runtime. When set, a node
     * is included by carrying these labels; when empty, kata installs on all workers
     * (or, with checkNodeEligibility, on NFD-labeled TEE nodes). The day-2 "add a
     * node" flow reads this to know which label to apply to a newly-joined node.
     */
    kataConfigPoolSelector?: {
      matchLabels?: Record<string, string>;
    };
  };
  status?: {
    conditions?: {
      type: string;
      status: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }[];
    kataNodes?: {
      nodeCount?: number;
      readyNodeCount?: number;
      installed?: string[];
      installing?: string[];
      waitingToInstall?: string[];
      failedToInstall?: string[];
    };
    runtimeClasses?: string[];
    waitingForMcoToStart?: boolean;
  };
};

/** A v1 Namespace — we only need name (metadata) for the namespace selector. */
export type NamespaceKind = K8sResourceCommon;

/** A storage.k8s.io/v1 StorageClass — we read the is-default-class annotation. */
export type StorageClassKind = K8sResourceCommon & {
  metadata?: K8sResourceCommon['metadata'] & { annotations?: Record<string, string> };
};

/** config.openshift.io/v1 Infrastructure — we read status.infrastructureName for the cluster name. */
export type InfrastructureKind = K8sResourceCommon & {
  status?: {
    infrastructureName?: string;
    platform?: string;
    platformStatus?: {
      type?: string;
    };
  };
};

/** A v1 Node — we read labels (TEE/GPU-CC), allocatable (device resources) and Ready. */
export type NodeKind = K8sResourceCommon & {
  status?: {
    conditions?: { type: string; status: string }[];
    allocatable?: Record<string, string>;
    capacity?: Record<string, string>;
  };
};

export interface ContainerStatusKind {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: { exitCode?: number; reason?: string; finishedAt?: string };
  };
  image?: string;
}

/** Minimal Pod shape we rely on. */
export type PodKind = K8sResourceCommon & {
  spec?: {
    runtimeClassName?: string;
    nodeName?: string;
    containers?: { name: string; image?: string }[];
  };
  status?: {
    phase?: string;
    podIP?: string;
    containerStatuses?: ContainerStatusKind[];
  };
};

/** Minimal Deployment shape we rely on. */
export type DeploymentKind = K8sResourceCommon & {
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: {
      metadata?: { annotations?: Record<string, string> };
      spec?: {
        runtimeClassName?: string;
        containers?: { name: string; image?: string }[];
      };
    };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
  };
};

export type DaemonSetKind = K8sResourceCommon & {
  status?: {
    desiredNumberScheduled?: number;
    numberReady?: number;
    numberAvailable?: number;
  };
};

/** A batch/v1 Job — we watch .status to drive automation progress. */
export type JobKind = K8sResourceCommon & {
  spec?: {
    backoffLimit?: number;
    template?: {
      metadata?: Record<string, unknown>;
      spec?: Record<string, unknown>;
    };
  };
  status?: {
    active?: number;
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
};

/**
 * machineconfiguration.openshift.io/v1 MachineConfigPool — we read the role label
 * (to match a pool to the TDX-host MachineConfig), the rollout conditions
 * (Updating/Updated), and the machine counts to show reboot progress.
 */
export type MachineConfigPoolKind = K8sResourceCommon & {
  metadata?: K8sResourceCommon['metadata'] & { labels?: Record<string, string> };
  spec?: {
    machineConfigSelector?: {
      matchLabels?: Record<string, string>;
      matchExpressions?: { key: string; operator: string; values?: string[] }[];
    };
    nodeSelector?: { matchLabels?: Record<string, string> };
  };
  status?: {
    machineCount?: number;
    updatedMachineCount?: number;
    readyMachineCount?: number;
    degradedMachineCount?: number;
    conditions?: {
      type: string;
      status: string;
      reason?: string;
      message?: string;
    }[];
  };
};

/** Confidential classification derived from a RuntimeClass (name + handler). */
export type CcClass = 'confidential' | 'confidential-gpu' | 'peerpod' | 'sandbox' | 'unknown';

/** TEE technology detected on a node from NFD labels. */
export type TeeType = 'tdx' | 'snp' | 'none';

/** A node that can host confidential workloads. */
export interface TeeNode {
  name: string;
  tee: TeeType;
  gpuCcReady: boolean;
  ready: boolean;
  /** Intel SGX detected by NFD (TDX quote generation runs in an SGX enclave). */
  sgxCapable: boolean;
  /** Intel SGX device plugin is advertising sgx.intel.com/enclave + /provision. */
  sgxDevicePlugin: boolean;
  obj: NodeKind;
}

/** A normalized row in the Confidential Workloads table (Pod or Deployment). */
export interface CcWorkload {
  uid: string;
  kind: 'Pod' | 'Deployment';
  name: string;
  namespace: string;
  runtimeClass: string;
  ccClass: CcClass;
  /** Whether the pod carries initdata (cc_init_data annotation). */
  hasInitData: boolean;
  node?: string;
  status: string;
  restarts?: number;
  ready?: string; // e.g. "2/3" for deployments
  creationTimestamp?: string;
  obj: PodKind | DeploymentKind;
}
