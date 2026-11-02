import type {
  DaemonSetKind,
  DeploymentKind,
  NodeKind,
  SecretKind,
  TdxQuoteGenerationServiceKind,
} from '../k8s/types';
import {
  INTEL_DCAP_OPERATOR_NAMESPACE,
  TQGS_CR_NAME,
  TQGS_PCS_API_KEY_SECRET_KEY,
  TQGS_PCS_API_KEY_SECRET_NAME,
} from '../k8s/resources';
import { httpStatusCode } from './error';
import { SGX_LABEL } from './tee';

/**
 * Pure logic for the Intel TDX DCAP operator flow (OSC 1.13+ "Deploy Intel TDX
 * remote attestation", §4.2). The operator replaces the OSC 1.12 manual PCCS/QGS
 * procedure: it reconciles the cluster-scoped `TdxQuoteGenerationService`
 * singleton (`intel-tdx-dcap`) and owns a per-node QGS DaemonSet plus — in Online
 * registration mode — a registrar Deployment that reads the Intel PCS API key
 * Secret. Everything here mirrors the operator's CRD and controller semantics
 * (intel/confidential-computing.tee.dcap.k8s.qgs) so the UI never invents fields.
 */

/**
 * Default node selector for the QGS DaemonSet — Intel's documented example
 * targets NFD's SGX label (TDX quotes are signed in an SGX enclave, so QGS pods
 * also request the sgx.intel.com/enclave + /provision resources).
 */
export const DEFAULT_TQGS_NODE_SELECTOR = `${SGX_LABEL}=true`;

/**
 * Mirrors the CRD's CEL rule for a single spec.nodeSelector entry: "key=value"
 * with a valid label key (optional DNS prefix) and a non-empty label value.
 */
export const NODE_SELECTOR_RE =
  /^([a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?([.][a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?=[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** Max nodeSelector entries the CRD allows. */
export const TQGS_MAX_NODE_SELECTORS = 16;

/** Is a single "key=value" node selector entry acceptable to the CRD? */
export const nodeSelectorValid = (selector: string): boolean =>
  NODE_SELECTOR_RE.test(selector.trim());

/** Parse a "key=value" selector into its parts (undefined when malformed). */
export const parseNodeSelector = (selector: string): { key: string; value: string } | undefined => {
  const s = selector.trim();
  const idx = s.indexOf('=');
  if (idx <= 0 || idx === s.length - 1) return undefined;
  return { key: s.slice(0, idx), value: s.slice(idx + 1) };
};

/** Nodes carrying the selector's label (for live match-count feedback in the UI). */
export const nodesMatchingSelector = (nodes: NodeKind[], selector: string): NodeKind[] => {
  const parsed = parseNodeSelector(selector);
  if (!parsed) return [];
  return nodes.filter((n) => n.metadata?.labels?.[parsed.key] === parsed.value);
};

// ---- readiness (mirrors the operator's controller semantics) ----

/**
 * Lifecycle of the Intel TDX attestation infrastructure, derived from the CRD's
 * presence, the CR's existence, and its Ready condition. The operator sets
 * Ready=True (reason ServicesReady) only when the QGS DaemonSet has
 * desired>0 && numberReady==desired AND — in Online mode — the registrar
 * Deployment is available; reconcile errors are reported as Ready=False with
 * reason ReconcileFailed and the API error in the condition message.
 */
export type TqgsPhase =
  | 'crdMissing' /** Intel TDX DCAP Operator / CRD not installed */
  | 'missing' /** Operator installed, TdxQuoteGenerationService CR absent */
  | 'installing' /** CR present, reconciliation still in progress */
  | 'ready' /** Ready=True — QGS (and registrar) healthy */
  | 'failed'; /** Ready=False/ReconcileFailed — reconciliation error */

export interface TqgsSummary {
  phase: TqgsPhase;
  /** DaemonSet pods that should run (0 until first reconciliation). */
  desired: number;
  /** DaemonSet pods scheduled on matching nodes. */
  current: number;
  /** DaemonSet pods running and ready. */
  ready: number;
  /** Name of the operator-managed QGS DaemonSet (once reconciled). */
  daemonsetName?: string;
  /** Name of the registrar Deployment (Online mode only). */
  registrationDeploymentName?: string;
  /** Whether the registrar Deployment is available (Online mode only). */
  registrationReady?: boolean;
  /** The CR uses Online platform registration. */
  onlineMode: boolean;
  /** True once the operator reconciled and found zero nodes matching the selector. */
  zeroNodes: boolean;
  /** The operator has written a status at all (false = it has never reported). */
  statusObserved: boolean;
  /**
   * The status was written against an older spec generation (e.g. the node
   * selector was just edited) — its Ready condition no longer describes the
   * current desired state, so readiness must not be reported from it.
   */
  staleStatus: boolean;
  /** Human-readable message from the Ready condition (when present). */
  message?: string;
  /** Reason from the Ready condition (ServicesReady / ServicesNotReady / ReconcileFailed). */
  reason?: string;
}

const emptySummary = (): TqgsSummary => ({
  phase: 'crdMissing',
  desired: 0,
  current: 0,
  ready: 0,
  onlineMode: false,
  zeroNodes: false,
  statusObserved: false,
  staleStatus: false,
});

/**
 * Reduce a (possibly absent) TdxQuoteGenerationService to a UI state. Distinguishes
 * a missing operator (CRD), a missing CR, in-progress reconciliation, readiness
 * and reconciliation failure — never reporting ready on CR existence alone, and
 * never from a status the operator wrote against an older spec generation.
 */
export const summarizeTqgs = (
  cr?: TdxQuoteGenerationServiceKind,
  crdInstalled = true,
): TqgsSummary => {
  if (!crdInstalled) return emptySummary();
  if (!cr?.metadata) return { ...emptySummary(), phase: 'missing' };

  const status = cr.status;
  const desired = status?.desiredNumberScheduled ?? 0;
  const ready = status?.numberReady ?? 0;
  // The operator stamps status.observedGeneration with metadata.generation on
  // every status patch (controller.rs). A lower value means the status predates
  // the current spec — usually a just-edited node selector — so its Ready
  // condition may no longer hold. An absent observedGeneration (older operator)
  // is tolerated: the condition is trusted as before.
  const generation = cr.metadata.generation ?? 1;
  const observed = status?.observedGeneration;
  const staleStatus = observed !== undefined && generation > observed;
  const base: TqgsSummary = {
    phase: 'installing',
    desired,
    current: status?.currentNumberScheduled ?? 0,
    ready,
    daemonsetName: status?.daemonsetName,
    registrationDeploymentName: status?.registrationDeploymentName,
    registrationReady: status?.registrationDeploymentReady ?? undefined,
    onlineMode: Boolean(cr.spec?.platformRegistration?.Online),
    // A reconciled CR that scheduled zero daemon pods means no node matches the
    // node selector (or none is eligible) — never a false "ready".
    zeroNodes: status !== undefined && desired === 0,
    statusObserved: status !== undefined,
    staleStatus,
  };
  if (staleStatus) return base; // re-reconcile in flight — old verdicts don't apply

  const cond = (status?.conditions ?? []).find((c) => c.type === 'Ready');
  if (!cond) return base;
  if (cond.status === 'True')
    return { ...base, phase: 'ready', message: cond.message, reason: cond.reason };
  if (cond.reason === 'ReconcileFailed')
    return { ...base, phase: 'failed', message: cond.message, reason: cond.reason };
  return { ...base, phase: 'installing', message: cond.message, reason: cond.reason };
};

// ---- legacy (OSC 1.12) infrastructure detection ----

/**
 * Outcome of checking for the OSC 1.12-era manually deployed PCCS/QGS resources.
 * 'unknown' is deliberately distinct from 'absent': a watch the account is not
 * allowed to make (403) or that failed for any other reason must never read as
 * "the legacy infrastructure is not there" — that would un-block a conflicting
 * install. Consumers fail closed on anything but a confirmed 'absent'.
 */
export type LegacyTdxInfraStatus = 'present' | 'absent' | 'unknown';

/** Classify one legacy-resource watch (object wins; 404 = confirmed absent). */
const legacyWatchStatus = (
  obj: DeploymentKind | DaemonSetKind | undefined,
  error: unknown,
): LegacyTdxInfraStatus => {
  if (obj?.metadata?.name) return 'present';
  if (error === undefined) return 'unknown'; // still loading — fail closed
  return httpStatusCode(error) === 404 ? 'absent' : 'unknown';
};

/**
 * Tri-state detection of the obsolete OSC 1.12 PCCS/QGS stack. Those deployments
 * do not work on OSC 1.13+ and must be removed (plus an SGX Factory Reset in the
 * BIOS) before the Intel TDX DCAP Operator is installed — so the UI warns and
 * blocks conflicting installs, but never deletes anything itself. A permission
 * failure or an in-flight watch yields 'unknown', never a false 'absent'.
 */
export const summarizeLegacyTdxInfra = (
  pccs?: DeploymentKind,
  pccsError?: unknown,
  qgs?: DaemonSetKind,
  qgsError?: unknown,
): LegacyTdxInfraStatus => {
  const pccsStatus = legacyWatchStatus(pccs, pccsError);
  const qgsStatus = legacyWatchStatus(qgs, qgsError);
  if (pccsStatus === 'present' || qgsStatus === 'present') return 'present';
  if (pccsStatus === 'unknown' || qgsStatus === 'unknown') return 'unknown';
  return 'absent';
};

// ---- PCS API key Secret ----

/**
 * Does an existing PCS API key Secret carry the data key the operator's registrar
 * reads? Existence alone is not enough — a Secret missing the `api-key` key makes
 * the registrar run without a key and platform registration fail. Only key
 * *names* are inspected; the value is never read, decoded or displayed.
 */
export const pcsApiKeySecretValid = (secret?: SecretKind): boolean =>
  Boolean(secret?.metadata?.name && secret.data && TQGS_PCS_API_KEY_SECRET_KEY in secret.data);

// ---- manifest builders ----

/**
 * The Intel PCS API key Secret the operator's registrar reads (default name
 * `intel-pcs-api-key`, data key `api-key`, in the operator's namespace). The key
 * is placed in stringData — never logged, never echoed back by this module.
 */
export const buildPcsApiKeySecret = (
  namespace: string = INTEL_DCAP_OPERATOR_NAMESPACE,
  apiKey: string,
): {
  apiVersion: 'v1';
  kind: 'Secret';
  metadata: { name: string; namespace: string };
  type: 'Opaque';
  stringData: Record<string, string>;
} => {
  if (apiKey.trim() === '') throw new Error('Intel PCS API key must not be empty');
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: TQGS_PCS_API_KEY_SECRET_NAME, namespace },
    type: 'Opaque',
    stringData: { [TQGS_PCS_API_KEY_SECRET_KEY]: apiKey },
  };
};

/**
 * The documented Online-mode TdxQuoteGenerationService singleton. The name is
 * CEL-enforced by the CRD; nodeSelector entries must be valid "key=value" strings
 * (unique keys, at most 16); platformRegistration carries exactly one mode.
 */
export const buildTdxQuoteGenerationService = (opts: {
  nodeSelector: string;
  /** Custom PCS API key Secret name (defaults to the operator's intel-pcs-api-key). */
  apiKeySecretName?: string;
}): TdxQuoteGenerationServiceKind => {
  const selectors = [opts.nodeSelector.trim()];
  if (selectors.some((s) => !nodeSelectorValid(s)))
    throw new Error(`Invalid node selector '${opts.nodeSelector}' — expected key=value`);
  const keys = selectors.map((s) => parseNodeSelector(s)?.key);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate node selector key');
  if (selectors.length > TQGS_MAX_NODE_SELECTORS)
    throw new Error(`At most ${TQGS_MAX_NODE_SELECTORS} node selector entries allowed`);
  return {
    apiVersion: 'trustedservices.intel.com/v1',
    kind: 'TdxQuoteGenerationService',
    metadata: { name: TQGS_CR_NAME },
    spec: {
      platformRegistration: {
        Online: opts.apiKeySecretName ? { apiKeySecretName: opts.apiKeySecretName } : {},
      },
      nodeSelector: selectors,
    },
  };
};

/**
 * The same setup as copy-paste commands for an admin workstation (oc logged in).
 * The PCS API key is a placeholder — the real key is never embedded here.
 */
export const buildTdxSetupManualScript = (opts: { nodeSelector?: string }): string =>
  [
    '# 1. Install the Intel TDX DCAP Operator from OperatorHub',
    '#    (web console: OperatorHub -> search "Intel TDX DCAP Operator" -> Install,',
    '#     installation mode OwnNamespace, namespace intel-dcap-operator-system)',
    '',
    '# 2. Intel PCS API key Secret (in the operator namespace)',
    'oc -n intel-dcap-operator-system create secret generic intel-pcs-api-key \\',
    '  --from-literal=api-key="<API_KEY_VALUE>"',
    '',
    '# 3. TdxQuoteGenerationService (Online platform registration)',
    "oc apply -f - <<'YAML'",
    'apiVersion: trustedservices.intel.com/v1',
    'kind: TdxQuoteGenerationService',
    'metadata:',
    '  name: intel-tdx-dcap',
    'spec:',
    '  platformRegistration:',
    '    Online: {}',
    '  nodeSelector:',
    `    - "${opts.nodeSelector ?? DEFAULT_TQGS_NODE_SELECTOR}"`,
    'YAML',
    '',
    '# 4. Verify (Ready must become True; desired/ready counts must match)',
    'oc get tdxquotegenerationservices intel-tdx-dcap -o wide',
    'oc get pods -n intel-dcap-operator-system',
  ].join('\n');
