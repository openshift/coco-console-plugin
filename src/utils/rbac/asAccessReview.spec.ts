import type { K8sModel, K8sVerb } from '@openshift-console/dynamic-plugin-sdk';
import { asAccessReview } from './asAccessReview';

const model: K8sModel = {
  apiGroup: 'katacontainers.io',
  apiVersion: 'v1',
  kind: 'KataConfig',
  label: 'KataConfig',
  labelPlural: 'KataConfigs',
  plural: 'kataconfigs',
  abbr: 'KC',
};

const clusterModel: K8sModel = {
  apiGroup: '',
  apiVersion: 'v1',
  kind: 'ConfigMap',
  label: 'ConfigMap',
  labelPlural: 'ConfigMaps',
  plural: 'configmaps',
  abbr: 'CM',
};

describe('asAccessReview', () => {
  it('builds cluster-scoped review without namespace', () => {
    const review = asAccessReview(model, 'create');
    expect(review).toEqual({
      group: 'katacontainers.io',
      resource: 'kataconfigs',
      verb: 'create',
    });
  });

  it('builds namespaced review with namespace', () => {
    const review = asAccessReview(clusterModel, 'patch', 'openshift-sandboxed-containers');
    expect(review).toEqual({
      group: '',
      resource: 'configmaps',
      verb: 'patch',
      namespace: 'openshift-sandboxed-containers',
    });
  });

  it('handles all standard verbs', () => {
    const verbs: K8sVerb[] = ['create', 'get', 'list', 'update', 'patch', 'delete', 'watch'];
    for (const verb of verbs) {
      const review = asAccessReview(model, verb);
      expect(review.verb).toBe(verb);
    }
  });

  it('handles model with undefined apiGroup', () => {
    const noGroup = { ...model, apiGroup: undefined } as unknown as K8sModel;
    const review = asAccessReview(noGroup, 'get');
    expect(review.group).toBe('');
  });
});
