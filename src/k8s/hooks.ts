import { useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { useMemo } from 'react';
import {
  CC_INIT_DATA_ANNOTATION,
  ConfigMapGVK,
  CustomResourceDefinitionGVK,
  DaemonSetGVK,
  DeploymentGVK,
  InfrastructureGVK,
  KataConfigGVK,
  NodeGVK,
  OSC_FEATURE_GATES_CM,
  OSC_NAMESPACE,
  PEER_PODS_CM,
  PodGVK,
  RuntimeClassGVK,
  LEGACY_INTEL_DCAP_NAMESPACE,
  LEGACY_PCCS_DEPLOYMENT_NAME,
  LEGACY_QGS_DAEMONSET_NAME,
  TQGS_CRD_NAME,
  TQGS_CR_NAME,
  TdxQuoteGenerationServiceGVK,
} from './resources';
import type {
  CcClass,
  CcWorkload,
  ConfigMapKind,
  DaemonSetKind,
  DeploymentKind,
  InfrastructureKind,
  KataConfigKind,
  NodeKind,
  PodKind,
  RuntimeClassKind,
  TeeNode,
  TdxQuoteGenerationServiceKind,
} from './types';
import { classForRuntimeClass, isConfidentialClass } from '../utils/runtime';
import { cvmPeerPodsEnabled } from '../utils/topology';
import { teeNode } from '../utils/tee';
import { podDisplayStatus, podRestartCount } from '../utils/status';
import { httpStatusCode } from '../utils/error';
import { summarizeLegacyTdxInfra } from '../utils/tdxQuoteGenerationService';
import type { LegacyTdxInfraStatus } from '../utils/tdxQuoteGenerationService';

export const useRuntimeClasses = (): [RuntimeClassKind[], boolean] => {
  const [data, loaded] = useK8sWatchResource<RuntimeClassKind[]>({
    groupVersionKind: RuntimeClassGVK,
    isList: true,
  });
  return [data ?? [], loaded];
};

/** KataConfig is a cluster-scoped singleton; return the first (and only) one. */
export const useKataConfig = (): [KataConfigKind | undefined, boolean] => {
  const [data, loaded] = useK8sWatchResource<KataConfigKind[]>({
    groupVersionKind: KataConfigGVK,
    isList: true,
  });
  return [data?.[0], loaded];
};

/**
 * Is confidential containers enabled? True when the osc-feature-gates ConfigMap
 * has confidential: "true" (kata-cc), OR when peer-pods on this cluster run as
 * Confidential VMs (peer-pods-cm has CLOUD_PROVIDER and DISABLECVM !== "true").
 */
export const useConfidentialEnabled = (): [boolean | undefined, boolean] => {
  const [cm, loaded, loadError] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    name: OSC_FEATURE_GATES_CM,
  });
  const [ppCm, ppLoaded, ppError] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    name: PEER_PODS_CM,
  });
  // A named resource that doesn't exist yet 404s: loadError is set but `loaded`
  // never flips true. Treat each watch as settled once it is loaded OR errored, so
  // consumers that gate on the loaded flag don't show a spinner forever when the
  // ConfigMap is absent (it just reads as "not enabled").
  const settled = (loaded || Boolean(loadError)) && (ppLoaded || Boolean(ppError));
  const hasKataCc = cm?.data?.confidential === 'true';
  const hasCvmPeerPods = cvmPeerPodsEnabled(ppCm?.data);
  return [settled ? hasKataCc || hasCvmPeerPods : undefined, settled];
};

/**
 * True when peer-pods on this cluster run as Confidential VMs (see
 * {@link cvmPeerPodsEnabled}). Components use this to treat kata-remote as a
 * confidential runtime, keeping cloud/peer-pods views consistent with the
 * kata-cc bare-metal views. A cluster may have both — cloud CVM peer pods and
 * attached bare-metal TEE nodes — so this is additive, not either/or.
 */
export const useCvmPeerPods = (): boolean => {
  const [peerPodsCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    name: PEER_PODS_CM,
  });
  return cvmPeerPodsEnabled(peerPodsCm?.data);
};

export const useCvmPeerPodsStatus = (): [boolean, boolean] => {
  const [cm, loaded, error] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    name: PEER_PODS_CM,
  });

  const ready = (loaded && !error) || httpStatusCode(error) === 404;

  return [cvmPeerPodsEnabled(cm?.data), ready];
};

export const useInfrastructurePlatform = (): [string | undefined, boolean] => {
  const [infra, loaded] = useK8sWatchResource<InfrastructureKind>({
    groupVersionKind: InfrastructureGVK,
    name: 'cluster',
  });
  return [infra?.status?.platformStatus?.type ?? infra?.status?.platform, loaded];
};

/**
 * The Intel TDX DCAP operator's TdxQuoteGenerationService singleton, plus whether
 * the operator is installed at all. The CRD is watched first: watching the CR
 * before its CRD exists only produces 404 noise, and `crdInstalled` is itself the
 * "operator installed" signal for the setup checklist. Named-resource watches 404
 * silently when the CR is absent; we only read status.
 */
export const useTdxQuoteGenerationService = (): {
  cr: TdxQuoteGenerationServiceKind | undefined;
  crdInstalled: boolean;
  loaded: boolean;
} => {
  const [crd, crdLoaded, crdError] = useK8sWatchResource<K8sResourceCommon>({
    groupVersionKind: CustomResourceDefinitionGVK,
    name: TQGS_CRD_NAME,
  });
  const crdInstalled = Boolean(crd?.metadata?.name);
  const [cr, crLoaded, crError] = useK8sWatchResource<TdxQuoteGenerationServiceKind>(
    crdInstalled ? { groupVersionKind: TdxQuoteGenerationServiceGVK, name: TQGS_CR_NAME } : null,
  );
  // A named watch that 404s (CR absent — the normal pre-setup state) or is denied
  // never flips `loaded`; settle once loaded OR errored so consumers don't spin.
  const settled =
    (crdLoaded || Boolean(crdError)) && (!crdInstalled || crLoaded || Boolean(crError));
  return { cr: crdInstalled ? cr : undefined, crdInstalled, loaded: settled };
};

/**
 * Detect the obsolete OSC 1.12 manually deployed PCCS/QGS infrastructure. Those
 * deployments do not work on OSC 1.13+ and conflict with the Intel TDX DCAP
 * Operator, so a confirmed presence must warn (and block new installs) — this is
 * detection only; nothing is ever deleted automatically.
 *
 * The result is a tri-state, because a watch the account is not allowed to make
 * (403 on the intel-dcap namespace) or one that has not settled yet must not read
 * as "the legacy infrastructure is absent" — that would un-block a conflicting
 * install. Only a 404 (namespace/resources confirmed gone) counts as 'absent';
 * consumers fail closed on 'unknown'. `loaded` distinguishes "still checking"
 * from "checked, but could not determine".
 */
export const useLegacyTdxAttestationInfra = (): {
  status: LegacyTdxInfraStatus;
  loaded: boolean;
} => {
  const [pccs, pLoaded, pError] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name: LEGACY_PCCS_DEPLOYMENT_NAME,
    namespace: LEGACY_INTEL_DCAP_NAMESPACE,
  });
  const [qgs, qLoaded, qError] = useK8sWatchResource<DaemonSetKind>({
    groupVersionKind: DaemonSetGVK,
    name: LEGACY_QGS_DAEMONSET_NAME,
    namespace: LEGACY_INTEL_DCAP_NAMESPACE,
  });
  const loaded = (pLoaded || Boolean(pError)) && (qLoaded || Boolean(qError));
  // Before the watches settle this reports 'unknown' (fail closed); the UI shows
  // nothing until `loaded` so the caution doesn't flash on every open.
  return { status: summarizeLegacyTdxInfra(pccs, pError, qgs, qError), loaded };
};

export const useNodes = (): [NodeKind[], boolean] => {
  const [data, loaded] = useK8sWatchResource<NodeKind[]>({
    groupVersionKind: NodeGVK,
    isList: true,
  });
  return [data ?? [], loaded];
};

/** Nodes that can host confidential workloads (have a TEE label or CC-ready GPU). */
export const useTeeNodes = (): { teeNodes: TeeNode[]; loaded: boolean } => {
  const [nodes, loaded] = useNodes();
  return useMemo(() => {
    const teeNodes = nodes.map(teeNode).filter((n) => n.tee !== 'none' || n.gpuCcReady);
    return { teeNodes, loaded };
  }, [nodes, loaded]);
};

/**
 * Watch Pods cluster-wide and reduce them to normalized CcWorkload rows, keeping
 * only those on a confidential (kata-cc) RuntimeClass. A confidential workload is
 * the actual TEE guest — the Pod; Deployments are just controllers and are not
 * listed as workloads (a Deployment's guest is its replica Pod, shown here).
 */
export const useConfidentialWorkloads = (): { workloads: CcWorkload[]; loaded: boolean } => {
  const [runtimeClasses, rcLoaded] = useRuntimeClasses();
  const [pods, podsLoaded] = useK8sWatchResource<PodKind[]>({
    groupVersionKind: PodGVK,
    isList: true,
  });
  const [peerPodsCm] = useK8sWatchResource<ConfigMapKind>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    name: PEER_PODS_CM,
  });
  const cvmPeerPods = cvmPeerPodsEnabled(peerPodsCm?.data);

  const confidentialRC = useMemo(() => {
    const map: Record<string, CcClass> = {};
    runtimeClasses.forEach((rc) => {
      const cc = classForRuntimeClass(rc);
      const name = rc.metadata?.name;
      if (name && (isConfidentialClass(cc) || (cvmPeerPods && cc === 'peerpod'))) map[name] = cc;
    });
    return map;
  }, [runtimeClasses, cvmPeerPods]);

  const workloads = useMemo<CcWorkload[]>(() => {
    if (!rcLoaded) return [];
    const rows: CcWorkload[] = [];

    (pods ?? []).forEach((p) => {
      const rc = p.spec?.runtimeClassName;
      if (!rc || !(rc in confidentialRC)) return;
      rows.push({
        uid: p.metadata?.uid ?? `${p.metadata?.namespace}/${p.metadata?.name}`,
        kind: 'Pod',
        name: p.metadata?.name ?? '',
        namespace: p.metadata?.namespace ?? '',
        runtimeClass: rc,
        ccClass: confidentialRC[rc],
        hasInitData: Boolean(p.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION]),
        node: p.spec?.nodeName,
        status: podDisplayStatus(p),
        restarts: podRestartCount(p),
        creationTimestamp: p.metadata?.creationTimestamp,
        obj: p,
      });
    });

    return rows.sort((a, b) =>
      (b.creationTimestamp ?? '').localeCompare(a.creationTimestamp ?? ''),
    );
  }, [pods, confidentialRC, rcLoaded]);

  return { workloads, loaded: rcLoaded && podsLoaded };
};
