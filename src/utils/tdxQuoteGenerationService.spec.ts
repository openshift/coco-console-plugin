/**
 * Unit tests for the Intel TDX DCAP operator flow (OSC 1.13+ "Deploy Intel TDX
 * remote attestation", §4.2) — the flow that replaced the OSC 1.12 manual
 * PCCS/QGS procedure. Covers operator/CRD detection, the PCS API key Secret,
 * TdxQuoteGenerationService creation (validated against the CRD's CEL rules),
 * readiness state mapping (reconciling / ready / failed / zero eligible nodes),
 * RBAC review shapes for the new resources, legacy-infrastructure detection and
 * the AMD SEV-SNP non-interference guard.
 */
import type {
  DaemonSetKind,
  DeploymentKind,
  NodeKind,
  SecretKind,
  TdxQuoteGenerationServiceKind,
} from '../k8s/types';
import {
  INTEL_DCAP_OPERATOR_NAMESPACE,
  SecretModel,
  TQGS_CR_NAME,
  TQGS_PCS_API_KEY_SECRET_KEY,
  TQGS_PCS_API_KEY_SECRET_NAME,
  TdxQuoteGenerationServiceModel,
} from '../k8s/resources';
import { asAccessReview } from './rbac/asAccessReview';
import { teeTypeForNode, SNP_LABEL, SGX_LABEL, TDX_LABEL } from './tee';
import {
  buildPcsApiKeySecret,
  buildTdxQuoteGenerationService,
  buildTdxSetupManualScript,
  DEFAULT_TQGS_NODE_SELECTOR,
  NODE_SELECTOR_RE,
  nodesMatchingSelector,
  nodeSelectorValid,
  parseNodeSelector,
  pcsApiKeySecretValid,
  summarizeLegacyTdxInfra,
  summarizeTqgs,
  TQGS_MAX_NODE_SELECTORS,
} from './tdxQuoteGenerationService';

// ---- fixtures ----

const tqgs = (
  overrides: Partial<TdxQuoteGenerationServiceKind> = {},
): TdxQuoteGenerationServiceKind => ({
  apiVersion: 'trustedservices.intel.com/v1',
  kind: 'TdxQuoteGenerationService',
  metadata: { name: TQGS_CR_NAME },
  spec: {
    platformRegistration: { Online: {} },
    nodeSelector: [DEFAULT_TQGS_NODE_SELECTOR],
  },
  ...overrides,
});

const condition = (type: string, status: string, extra: Record<string, string> = {}) => ({
  type,
  status,
  ...extra,
});

const legacyDeployment = (name: string): DeploymentKind => ({
  metadata: { name, namespace: 'intel-dcap' },
});

const legacyDaemonSet = (name: string): DaemonSetKind => ({
  metadata: { name, namespace: 'intel-dcap' },
});

const labeledNode = (labels: Record<string, string>): NodeKind => ({
  metadata: { name: 'node-1', labels },
  status: {},
});

/**
 * Mini-validator mirroring the CRD's CEL rules
 * (intel/confidential-computing.tee.dcap.k8s.qgs,
 * tdxquotegenerationservice-crd.yaml) so every generated manifest is checked
 * against the real constraints: singleton name, exactly one
 * platformRegistration mode, valid unique nodeSelector entries.
 */
const validateAgainstCrd = (cr: TdxQuoteGenerationServiceKind): void => {
  expect(cr.apiVersion).toBe('trustedservices.intel.com/v1');
  expect(cr.kind).toBe('TdxQuoteGenerationService');
  expect(cr.metadata?.name).toBe('intel-tdx-dcap'); // CEL-enforced singleton name
  const pr = cr.spec?.platformRegistration;
  const modes = (['Online', 'Offline', 'External'] as const).filter((m) => pr?.[m] !== undefined);
  expect(modes).toEqual(['Online']); // exactly one registration mode
  const selectors = cr.spec?.nodeSelector ?? [];
  expect(selectors.length).toBeGreaterThan(0);
  expect(selectors.length).toBeLessThanOrEqual(TQGS_MAX_NODE_SELECTORS);
  selectors.forEach((s) => {
    expect(s).toMatch(NODE_SELECTOR_RE);
  });
  const keys = selectors.map((s) => s.split('=')[0]);
  expect(new Set(keys).size).toBe(keys.length); // unique keys
};

// ---- 1/2. operator + CRD detection, CR presence ----

describe('summarizeTqgs: operator / CRD detection', () => {
  it('reports crdMissing when the Intel TDX DCAP operator CRD is not installed', () => {
    expect(summarizeTqgs(undefined, false).phase).toBe('crdMissing');
    // Even a stray CR-like object must not read as installed without the CRD.
    expect(summarizeTqgs(tqgs(), false).phase).toBe('crdMissing');
  });

  it('reports missing when the CRD is installed but the CR does not exist', () => {
    const summary = summarizeTqgs(undefined, true);
    expect(summary.phase).toBe('missing');
    expect(summary.desired).toBe(0);
    expect(summary.ready).toBe(0);
    expect(summary.zeroNodes).toBe(false); // never reconciled ≠ zero nodes
  });

  it('reports missing for a CR without metadata', () => {
    expect(summarizeTqgs({}, true).phase).toBe('missing');
  });
});

// ---- 6/7/8/9. readiness state mapping ----

describe('summarizeTqgs: reconciliation status', () => {
  it('treats a CR with no status yet as installing (not ready)', () => {
    const summary = summarizeTqgs(tqgs());
    expect(summary.phase).toBe('installing');
    expect(summary.zeroNodes).toBe(false);
  });

  it('treats Ready=False reason=ServicesNotReady as installing, carrying the counts', () => {
    const cr = tqgs({
      status: {
        conditions: [
          condition('Ready', 'False', {
            reason: 'ServicesNotReady',
            message: 'DaemonSet is not yet ready on all nodes',
          }),
        ],
        daemonsetName: 'intel-tdx-dcap-qgs',
        desiredNumberScheduled: 2,
        currentNumberScheduled: 2,
        numberReady: 1,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('installing');
    expect(summary.desired).toBe(2);
    expect(summary.ready).toBe(1);
    expect(summary.daemonsetName).toBe('intel-tdx-dcap-qgs');
    expect(summary.message).toBe('DaemonSet is not yet ready on all nodes');
  });

  it('reports ready on Ready=True with healthy managed workloads', () => {
    const cr = tqgs({
      status: {
        conditions: [
          condition('Ready', 'True', {
            reason: 'ServicesReady',
            message: 'DaemonSet and registration Deployment are ready',
          }),
        ],
        daemonsetName: 'intel-tdx-dcap-qgs',
        desiredNumberScheduled: 2,
        currentNumberScheduled: 2,
        numberReady: 2,
        registrationDeploymentName: 'intel-tdx-dcap-registrar',
        registrationDeploymentReady: true,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('ready');
    expect(summary.ready).toBe(2);
    expect(summary.desired).toBe(2);
    expect(summary.registrationDeploymentName).toBe('intel-tdx-dcap-registrar');
    expect(summary.registrationReady).toBe(true);
    expect(summary.onlineMode).toBe(true);
  });

  it('reports failed on Ready=False reason=ReconcileFailed with the reconciliation error', () => {
    const cr = tqgs({
      status: {
        conditions: [
          condition('Ready', 'False', {
            reason: 'ReconcileFailed',
            message:
              'Kubernetes API error (403 Forbidden): tdxquotegenerationservices is forbidden',
          }),
        ],
        desiredNumberScheduled: 0,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('failed');
    expect(summary.reason).toBe('ReconcileFailed');
    expect(summary.message).toContain('403');
  });

  it('flags zero eligible nodes when the operator reconciled but scheduled no daemon pods', () => {
    const cr = tqgs({
      status: {
        conditions: [condition('Ready', 'False', { reason: 'ServicesNotReady' })],
        daemonsetName: 'intel-tdx-dcap-qgs',
        desiredNumberScheduled: 0,
        currentNumberScheduled: 0,
        numberReady: 0,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('installing');
    expect(summary.zeroNodes).toBe(true);
    expect(summary.phase).not.toBe('ready'); // never a false positive
  });

  it('does not flag zeroNodes before the operator has written a status', () => {
    expect(summarizeTqgs(tqgs()).zeroNodes).toBe(false);
  });

  it('detects Offline mode (no registrar)', () => {
    const cr: TdxQuoteGenerationServiceKind = {
      metadata: { name: TQGS_CR_NAME },
      spec: { platformRegistration: { Offline: {} } },
      status: {
        conditions: [condition('Ready', 'True', { reason: 'ServicesReady' })],
        desiredNumberScheduled: 1,
        numberReady: 1,
      },
    };
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('ready');
    expect(summary.onlineMode).toBe(false);
    expect(summary.registrationDeploymentName).toBeUndefined();
  });

  it('exposes whether the operator has written a status at all', () => {
    expect(summarizeTqgs(tqgs()).statusObserved).toBe(false);
    expect(
      summarizeTqgs(
        tqgs({
          status: { conditions: [condition('Ready', 'False', { reason: 'ServicesNotReady' })] },
        }),
      ).statusObserved,
    ).toBe(true);
  });

  it('never reports ready from a status written against an older spec generation', () => {
    // The node selector was just edited (generation bumped to 2); the operator
    // stamps status.observedGeneration on every patch, so 1 < 2 means the Ready
    // condition describes the OLD selector — the summary must say "installing".
    const cr = tqgs({
      metadata: { name: TQGS_CR_NAME, generation: 2 },
      status: {
        conditions: [condition('Ready', 'True', { reason: 'ServicesReady' })],
        daemonsetName: 'intel-tdx-dcap-qgs',
        desiredNumberScheduled: 2,
        currentNumberScheduled: 2,
        numberReady: 2,
        observedGeneration: 1,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('installing');
    expect(summary.staleStatus).toBe(true);
    expect(summary.phase).not.toBe('ready'); // stale verdict, not a live one
  });

  it('also defers a stale ReconcileFailed to the re-reconcile in flight', () => {
    const cr = tqgs({
      metadata: { name: TQGS_CR_NAME, generation: 2 },
      status: {
        conditions: [
          condition('Ready', 'False', { reason: 'ReconcileFailed', message: 'old error' }),
        ],
        observedGeneration: 1,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('installing');
    expect(summary.staleStatus).toBe(true);
  });

  it('reports ready when the status matches the current generation', () => {
    const cr = tqgs({
      metadata: { name: TQGS_CR_NAME, generation: 2 },
      status: {
        conditions: [condition('Ready', 'True', { reason: 'ServicesReady' })],
        desiredNumberScheduled: 1,
        numberReady: 1,
        observedGeneration: 2,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('ready');
    expect(summary.staleStatus).toBe(false);
  });

  it('tolerates a missing observedGeneration (older operator) and trusts the condition', () => {
    const cr = tqgs({
      status: {
        conditions: [condition('Ready', 'True', { reason: 'ServicesReady' })],
        desiredNumberScheduled: 1,
        numberReady: 1,
      },
    });
    const summary = summarizeTqgs(cr);
    expect(summary.phase).toBe('ready');
    expect(summary.staleStatus).toBe(false);
  });
});

// ---- 3. PCS API key Secret ----

describe('buildPcsApiKeySecret', () => {
  it('builds the documented Secret: intel-pcs-api-key, data key api-key, operator namespace', () => {
    const secret = buildPcsApiKeySecret(INTEL_DCAP_OPERATOR_NAMESPACE, 'SECRET_VALUE');
    expect(secret.apiVersion).toBe('v1');
    expect(secret.kind).toBe('Secret');
    expect(secret.type).toBe('Opaque');
    expect(secret.metadata.name).toBe(TQGS_PCS_API_KEY_SECRET_NAME);
    expect(secret.metadata.namespace).toBe(INTEL_DCAP_OPERATOR_NAMESPACE);
    expect(Object.keys(secret.stringData)).toEqual([TQGS_PCS_API_KEY_SECRET_KEY]);
    expect(secret.stringData[TQGS_PCS_API_KEY_SECRET_KEY]).toBe('SECRET_VALUE');
  });

  it('defaults to the operator namespace', () => {
    expect(buildPcsApiKeySecret(undefined, 'k').metadata.namespace).toBe(
      INTEL_DCAP_OPERATOR_NAMESPACE,
    );
  });

  it('rejects an empty API key', () => {
    expect(() => buildPcsApiKeySecret(INTEL_DCAP_OPERATOR_NAMESPACE, '  ')).toThrow();
  });
});

// ---- 4/5. TdxQuoteGenerationService creation + CR validation ----

describe('buildTdxQuoteGenerationService', () => {
  it('builds a valid Online-mode singleton that passes the CRD rules', () => {
    const cr = buildTdxQuoteGenerationService({ nodeSelector: DEFAULT_TQGS_NODE_SELECTOR });
    validateAgainstCrd(cr);
    expect(cr.spec?.platformRegistration?.Online).toEqual({});
    expect(cr.spec?.nodeSelector).toEqual([DEFAULT_TQGS_NODE_SELECTOR]);
  });

  it('sets apiKeySecretName only when a custom secret name is given', () => {
    const cr = buildTdxQuoteGenerationService({
      nodeSelector: DEFAULT_TQGS_NODE_SELECTOR,
      apiKeySecretName: 'my-pcs-key',
    });
    validateAgainstCrd(cr);
    expect(cr.spec?.platformRegistration?.Online).toEqual({ apiKeySecretName: 'my-pcs-key' });
  });

  it('rejects node selectors that fail the CRD format rule', () => {
    for (const bad of ['no-equals', '=value', 'key=', 'key=two=equals', '']) {
      expect(() => buildTdxQuoteGenerationService({ nodeSelector: bad })).toThrow(/node selector/i);
    }
  });

  it('validates selector format the way the CRD CEL rule does', () => {
    expect(nodeSelectorValid(DEFAULT_TQGS_NODE_SELECTOR)).toBe(true);
    expect(nodeSelectorValid('kubernetes.io/os=linux')).toBe(true);
    expect(nodeSelectorValid('Key=value')).toBe(true);
    expect(nodeSelectorValid('key=Value')).toBe(true);
    expect(nodeSelectorValid('key=')).toBe(false);
    expect(nodeSelectorValid('=value')).toBe(false);
    expect(nodeSelectorValid('key')).toBe(false);
    expect(nodeSelectorValid('key=a=b')).toBe(false);
  });

  it('parses key=value selectors', () => {
    expect(parseNodeSelector('a/b=c')).toEqual({ key: 'a/b', value: 'c' });
    expect(parseNodeSelector('noequals')).toBeUndefined();
    expect(parseNodeSelector('key=')).toBeUndefined();
    expect(parseNodeSelector('=value')).toBeUndefined();
  });
});

// ---- node selector matching (live UI feedback) ----

describe('nodesMatchingSelector', () => {
  it('counts nodes carrying the selector label', () => {
    const nodes = [
      labeledNode({ [SGX_LABEL]: 'true', [TDX_LABEL]: 'true' }),
      labeledNode({ [SGX_LABEL]: 'true' }),
      labeledNode({ [SNP_LABEL]: 'true' }),
      labeledNode({}),
    ];
    expect(nodesMatchingSelector(nodes, DEFAULT_TQGS_NODE_SELECTOR)).toHaveLength(2);
    expect(nodesMatchingSelector(nodes, `${SNP_LABEL}=true`)).toHaveLength(1);
  });

  it('returns nothing for a malformed selector', () => {
    expect(nodesMatchingSelector([labeledNode({})], 'not-a-selector')).toEqual([]);
  });
});

// ---- 10. RBAC review shapes for the new resources ----

describe('RBAC access reviews for the DCAP operator flow', () => {
  it('reviews TdxQuoteGenerationService create as cluster-scoped (no namespace)', () => {
    const review = asAccessReview(TdxQuoteGenerationServiceModel, 'create');
    expect(review).toEqual({
      group: 'trustedservices.intel.com',
      resource: 'tdxquotegenerationservices',
      verb: 'create',
    });
    expect(review.namespace).toBeUndefined();
  });

  it('reviews the PCS API key Secret create in the operator namespace', () => {
    const review = asAccessReview(SecretModel, 'create', INTEL_DCAP_OPERATOR_NAMESPACE);
    expect(review).toEqual({
      group: '',
      resource: 'secrets',
      verb: 'create',
      namespace: INTEL_DCAP_OPERATOR_NAMESPACE,
    });
  });

  it('names the model after the CRD plural so reviews match the served API', () => {
    expect(TdxQuoteGenerationServiceModel.plural).toBe('tdxquotegenerationservices');
    expect(TdxQuoteGenerationServiceModel.namespaced).toBe(false);
  });
});

// ---- 11. legacy (OSC 1.12) infrastructure detection (tri-state, fail closed) ----

describe('summarizeLegacyTdxInfra', () => {
  it('reports absent only when both watches returned a confirmed 404', () => {
    expect(
      summarizeLegacyTdxInfra(undefined, { code: 404 }, undefined, { response: { status: 404 } }),
    ).toBe('absent');
  });

  it('detects the legacy PCCS Deployment regardless of the other watch', () => {
    expect(summarizeLegacyTdxInfra(legacyDeployment('pccs'), undefined, undefined, undefined)).toBe(
      'present',
    );
    expect(
      summarizeLegacyTdxInfra(legacyDeployment('pccs'), undefined, undefined, { code: 404 }),
    ).toBe('present');
  });

  it('detects the legacy tdx-qgs DaemonSet regardless of the other watch', () => {
    expect(
      summarizeLegacyTdxInfra(undefined, { code: 404 }, legacyDaemonSet('tdx-qgs'), undefined),
    ).toBe('present');
  });

  it('never reads a permission failure (403) as absence', () => {
    expect(summarizeLegacyTdxInfra(undefined, { code: 403 }, undefined, { code: 404 })).toBe(
      'unknown',
    );
    expect(summarizeLegacyTdxInfra(undefined, { code: 404 }, undefined, { code: 403 })).toBe(
      'unknown',
    );
  });

  it('never reads an unparseable or server error as absence', () => {
    expect(summarizeLegacyTdxInfra(undefined, new Error('network'), undefined, { code: 404 })).toBe(
      'unknown',
    );
    expect(summarizeLegacyTdxInfra(undefined, { code: 500 }, undefined, { code: 404 })).toBe(
      'unknown',
    );
  });

  it('treats an unsettled watch (no object, no error) as unknown, not absent', () => {
    expect(summarizeLegacyTdxInfra(undefined, undefined, undefined, undefined)).toBe('unknown');
    expect(summarizeLegacyTdxInfra(undefined, { code: 404 }, undefined, undefined)).toBe('unknown');
  });
});

// ---- existing PCS API key Secret shape (existence alone is not configuration) ----

describe('pcsApiKeySecretValid', () => {
  const secret = (data?: Record<string, string>): SecretKind => ({
    metadata: { name: TQGS_PCS_API_KEY_SECRET_NAME, namespace: INTEL_DCAP_OPERATOR_NAMESPACE },
    data,
  });

  it('accepts a Secret carrying the api-key data key', () => {
    expect(pcsApiKeySecretValid(secret({ 'api-key': 'bm90LXRoZS1yZWFsLWtleQ==' }))).toBe(true);
  });

  it('rejects a Secret that exists but lacks the api-key data key', () => {
    expect(pcsApiKeySecretValid(secret({ 'other-key': 'eA==' }))).toBe(false);
    expect(pcsApiKeySecretValid(secret({}))).toBe(false);
  });

  it('rejects an absent Secret', () => {
    expect(pcsApiKeySecretValid(undefined)).toBe(false);
    expect(pcsApiKeySecretValid(secret(undefined))).toBe(false);
  });
});

// ---- 12. AMD SEV-SNP non-interference ----

describe('AMD SEV-SNP is unaffected by the DCAP flow', () => {
  it('still classifies SNP nodes as SNP', () => {
    expect(teeTypeForNode(labeledNode({ [SNP_LABEL]: 'true' }))).toBe('snp');
    expect(teeTypeForNode(labeledNode({ [TDX_LABEL]: 'true' }))).toBe('tdx');
    expect(teeTypeForNode(labeledNode({}))).toBe('none');
  });

  it('does not match SNP-only nodes with the default QGS selector', () => {
    const snpOnly = [labeledNode({ [SNP_LABEL]: 'true' })];
    expect(nodesMatchingSelector(snpOnly, DEFAULT_TQGS_NODE_SELECTOR)).toEqual([]);
  });
});

// ---- manual command generation never embeds the real key ----

describe('buildTdxSetupManualScript', () => {
  it('uses a placeholder for the API key, never a real value', () => {
    const script = buildTdxSetupManualScript({});
    expect(script).toContain('<API_KEY_VALUE>');
    expect(script).not.toContain('SECRET_VALUE');
    expect(script).toContain('trustedservices.intel.com/v1');
    expect(script).toContain('name: intel-tdx-dcap');
    expect(script).toContain(DEFAULT_TQGS_NODE_SELECTOR);
  });

  it('carries the chosen node selector into the CR yaml', () => {
    const script = buildTdxSetupManualScript({ nodeSelector: `${TDX_LABEL}=true` });
    expect(script).toContain(`- "${TDX_LABEL}=true"`);
  });
});

// ---- a full CR from a real-shaped status must survive the CRD validator ----

describe('CRD conformance of a reconciled CR', () => {
  it('passes a reconciled Online-mode CR through the CEL-rule validator', () => {
    const cr = tqgs({
      status: {
        conditions: [condition('Ready', 'True', { reason: 'ServicesReady' })],
        daemonsetName: 'intel-tdx-dcap-qgs',
        desiredNumberScheduled: 1,
        currentNumberScheduled: 1,
        numberReady: 1,
        registrationDeploymentName: 'intel-tdx-dcap-registrar',
        registrationDeploymentReady: true,
        observedGeneration: 1,
      },
    });
    validateAgainstCrd(cr);
    expect(cr.metadata?.name).toBe(TQGS_CR_NAME);
  });
});
