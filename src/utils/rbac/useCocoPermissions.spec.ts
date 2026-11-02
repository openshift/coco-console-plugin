/**
 * RBAC contract regression tests (RBAC-10). These pin the exact
 * resourceAttributes the Intel TDX DCAP flow submits to SelfSubjectAccessReview:
 * the TQGS create check must be cluster-scoped (no namespace) and the PCS
 * Secret create check must target the operator namespace. A regression to a
 * wrong group/plural/namespace silently breaks the fail-closed UI gating.
 */
jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  useAccessReview: jest.fn(() => [false, false]),
}));

import { useAccessReview } from '@openshift-console/dynamic-plugin-sdk';
import {
  INTEL_DCAP_OPERATOR_NAMESPACE,
  SecretModel,
  TdxQuoteGenerationServiceModel,
} from '../../k8s/resources';
import { useCanCreateDcapSecret, useCanCreateTqgs } from './useCocoPermissions';

const review = useAccessReview as jest.Mock;

beforeEach(() => review.mockClear());

describe('useCanCreateTqgs', () => {
  it('reviews create on the real TQGS model without a namespace (cluster-scoped)', () => {
    useCanCreateTqgs();
    expect(review).toHaveBeenCalledWith({
      group: TdxQuoteGenerationServiceModel.apiGroup,
      resource: TdxQuoteGenerationServiceModel.plural,
      verb: 'create',
    });
  });

  it('uses the trustedservices.intel.com group and tdxquotegenerationservices plural', () => {
    useCanCreateTqgs();
    expect(review).toHaveBeenCalledWith(
      expect.objectContaining({
        group: 'trustedservices.intel.com',
        resource: 'tdxquotegenerationservices',
      }),
    );
  });

  it('never sends a namespace — an empty/absent namespace means cluster scope in SSAR', () => {
    useCanCreateTqgs();
    expect(review.mock.calls[0][0]).not.toHaveProperty('namespace');
  });
});

describe('useCanCreateDcapSecret', () => {
  it('reviews create secrets in the Intel DCAP operator namespace', () => {
    useCanCreateDcapSecret(INTEL_DCAP_OPERATOR_NAMESPACE);
    expect(review).toHaveBeenCalledWith({
      group: SecretModel.apiGroup ?? '',
      resource: SecretModel.plural,
      verb: 'create',
      namespace: INTEL_DCAP_OPERATOR_NAMESPACE,
    });
  });

  it('uses the operator namespace, not the legacy intel-dcap namespace', () => {
    useCanCreateDcapSecret(INTEL_DCAP_OPERATOR_NAMESPACE);
    expect(review.mock.calls[0][0].namespace).toBe('intel-dcap-operator-system');
  });
});
