/**
 * Fail-closed regression tests for the Intel TDX DCAP wizard (RBAC-10).
 *
 * These pin the safety behavior verified live with a restricted
 * ServiceAccount against a real cluster:
 *  - legacy state UNKNOWN (no read access to intel-dcap) must render the
 *    "could not check" warning and keep Deploy disabled — never ABSENT;
 *  - denied create permissions must surface both permission hints;
 *  - pending authorization reviews must keep Deploy disabled (no hints yet);
 *  - legacy PRESENT blocks Deploy even when every permission is granted.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { useAccessReview, useK8sWatchResource } from '@openshift-console/dynamic-plugin-sdk';
import { useLegacyTdxAttestationInfra, useTdxQuoteGenerationService } from '../k8s/hooks';
import DeployTdxAttestationModal from './DeployTdxAttestationModal';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: jest.fn(),
  ResourceLink: () => null,
  useK8sWatchResource: jest.fn(),
  useAccessReview: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string, opts?: Record<string, string | number>) =>
      opts ? value.replace(/\{\{(\w+)\}\}/g, (_, k) => String(opts[k] ?? '')) : value,
  }),
}));

jest.mock('../k8s/hooks', () => ({
  useLegacyTdxAttestationInfra: jest.fn(),
  useTdxQuoteGenerationService: jest.fn(),
}));

// PatternFly's Modal renders through a React portal, which SSR ignores — the
// static markup would be empty. Replace only the Modal shell with plain
// wrappers; every other PatternFly component renders for real.
jest.mock('@patternfly/react-core', () => {
  const actual = jest.requireActual('@patternfly/react-core');
  const React = jest.requireActual('react');
  const wrapper = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children);
  return {
    ...actual,
    Modal: wrapper,
    ModalHeader: wrapper,
    ModalBody: wrapper,
    ModalFooter: wrapper,
  };
});

const watch = useK8sWatchResource as jest.Mock;
const review = useAccessReview as jest.Mock;
const legacy = useLegacyTdxAttestationInfra as jest.Mock;
const tqgs = useTdxQuoteGenerationService as jest.Mock;

// Mirrors a real TDX node (as replayed in the live restricted-identity run):
// TDX+SGX labels and the SGX device plugin resources — so the wizard's
// SGX-plugin install CTA (and its extra permission hint) stays hidden, exactly
// like the live scenario.
const TDX_NODE = {
  metadata: {
    name: 'node-tdx',
    labels: {
      'intel.feature.node.kubernetes.io/tdx': 'true',
      'intel.feature.node.kubernetes.io/sgx': 'true',
    },
  },
  status: { allocatable: { 'sgx.intel.com/enclave': '110', 'sgx.intel.com/provision': '110' } },
};

const renderModal = () =>
  renderToStaticMarkup(<DeployTdxAttestationModal onClose={() => undefined} />);

const deployButton = (markup: string): { tag: string; disabled: boolean } => {
  const buttons = markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const btn = buttons.find((b) => b.includes('Deploy attestation infrastructure'));
  return { tag: btn ?? '<not found>', disabled: Boolean(btn?.includes('disabled')) };
};

const countOccurrences = (markup: string, text: string): number =>
  (markup.match(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;

beforeEach(() => {
  watch
    .mockReset()
    .mockImplementation((opts: { isList?: boolean }) =>
      opts?.isList ? [[TDX_NODE], true, undefined] : [undefined, true, undefined],
    );
  review.mockReset().mockReturnValue([false, false]);
  tqgs.mockReset().mockReturnValue({ cr: undefined, crdInstalled: false });
});

test('legacy UNKNOWN (unreadable intel-dcap) warns and keeps Deploy disabled', () => {
  legacy.mockReturnValue({ loaded: true, status: 'unknown' });
  const markup = renderModal();

  expect(markup).toContain('Could not check for obsolete attestation infrastructure');
  // 403 on the legacy Deployment/DaemonSet reads must NOT read as confirmed absence.
  expect(markup).not.toContain('Obsolete attestation infrastructure detected');
  expect(markup).toContain('Deploying is blocked until that is ruled out');
  expect(deployButton(markup).disabled).toBe(true);
});

test('denied creates surface both permission hints (TQGS + PCS Secret)', () => {
  legacy.mockReturnValue({ loaded: true, status: 'unknown' });
  const markup = renderModal();

  expect(countOccurrences(markup, 'You do not have permission to perform this action')).toBe(2);
  expect(deployButton(markup).disabled).toBe(true);
});

test('pending authorization reviews hide hints but keep Deploy disabled', () => {
  legacy.mockReturnValue({ loaded: true, status: 'unknown' });
  review.mockReturnValue([false, true]); // [allowed, loading]
  const markup = renderModal();

  expect(countOccurrences(markup, 'You do not have permission to perform this action')).toBe(0);
  expect(deployButton(markup).disabled).toBe(true);
});

test('legacy PRESENT blocks Deploy even with every permission granted', () => {
  legacy.mockReturnValue({ loaded: true, status: 'present' });
  review.mockReturnValue([true, false]);
  const markup = renderModal();

  expect(markup).toContain('Obsolete attestation infrastructure detected');
  expect(countOccurrences(markup, 'You do not have permission to perform this action')).toBe(0);
  expect(deployButton(markup).disabled).toBe(true);
});

test('granted permissions with legacy ABSENT and CRD absent still block Deploy', () => {
  legacy.mockReturnValue({ loaded: true, status: 'absent' });
  review.mockReturnValue([true, false]);
  const markup = renderModal();

  // No legacy/permission warnings — but the operator CRD is not installed, so
  // the wizard must not offer Deploy.
  expect(markup).not.toContain('Could not check for obsolete attestation infrastructure');
  expect(markup).not.toContain('Obsolete attestation infrastructure detected');
  expect(countOccurrences(markup, 'You do not have permission to perform this action')).toBe(0);
  expect(deployButton(markup).disabled).toBe(true);
});

// A reconciled TdxQuoteGenerationService exactly as the operator writes it:
// Ready=True (ServicesReady) against the current generation, Online mode,
// QGS DaemonSet 1/1. This is the "infrastructure already deployed" state the
// wizard must recognize without demanding anything from the user.
const READY_TQGS_CR = {
  apiVersion: 'trustedservices.intel.com/v1',
  kind: 'TdxQuoteGenerationService',
  metadata: { name: 'intel-tdx-dcap', generation: 1 },
  spec: {
    platformRegistration: { Online: {} },
    nodeSelector: ['intel.feature.node.kubernetes.io/sgx=true'],
  },
  status: {
    conditions: [{ type: 'Ready', status: 'True', reason: 'ServicesReady' }],
    daemonsetName: 'intel-tdx-dcap-qgs',
    registrationDeploymentName: 'intel-tdx-dcap-registrar',
    registrationDeploymentReady: true,
    desiredNumberScheduled: 1,
    currentNumberScheduled: 1,
    numberReady: 1,
    observedGeneration: 1,
  },
};

// The keyless PCS configuration already working on the cluster: the Secret
// carries the api-key data key with an EMPTY value. Only the key name is
// inspected, so this counts as configured.
const KEYLESS_PCS_SECRET = {
  metadata: { name: 'intel-pcs-api-key', namespace: 'intel-dcap-operator-system' },
  data: { 'api-key': '' },
};

test('existing ready TQGS with a keyless PCS Secret is recognized — no API key demanded', () => {
  legacy.mockReturnValue({ loaded: true, status: 'absent' });
  review.mockReturnValue([true, false]);
  tqgs.mockReturnValue({ cr: READY_TQGS_CR, crdInstalled: true });
  watch.mockImplementation((opts: { isList?: boolean }) =>
    opts?.isList ? [[TDX_NODE], true, undefined] : [KEYLESS_PCS_SECRET, true, undefined],
  );
  const markup = renderModal();

  // The deployed-and-running success state, with the live QGS counts.
  expect(markup).toContain('Attestation infrastructure is deployed and running');
  expect(markup).toContain('1/1');
  // The keyless Secret counts as configured — no API-key input is rendered.
  expect(markup).toContain('Configured — the operator reads the key from');
  expect(markup).not.toContain('Paste your Provisioning Certification Service API key');
  expect(markup).not.toContain('The existing Secret is missing the api-key data key');
  // Ready ⇒ the footer offers Done; there is no Deploy button to press.
  expect(deployButton(markup).tag).toBe('<not found>');
  expect(markup).toContain('Done');
});
