import type { AccessReviewResourceAttributes } from '@openshift-console/dynamic-plugin-sdk';
import { useAccessReview } from '@openshift-console/dynamic-plugin-sdk';
import {
  ConfigMapModel,
  KataConfigModel,
  MachineConfigModel,
  NodeFeatureRuleModel,
  JobModel,
  PodModel,
  DeploymentModel,
  NamespaceModel,
  PersistentVolumeClaimModel,
  ServiceAccountModel,
  RoleModel,
  RoleBindingModel,
  OSC_NAMESPACE,
  OSC_FEATURE_GATES_CM,
} from '../../k8s/resources';
import { asAccessReview } from './asAccessReview';

export const useCanCreateKataConfig = () =>
  useAccessReview({ ...asAccessReview(KataConfigModel, 'create') });

export const useCanCreateMachineConfig = () =>
  useAccessReview({ ...asAccessReview(MachineConfigModel, 'create') });

export const useCanCreateNodeFeatureRule = () =>
  useAccessReview({ ...asAccessReview(NodeFeatureRuleModel, 'create', 'openshift-nfd') });

export const useCanCreateJob = (namespace: string) =>
  useAccessReview({ ...asAccessReview(JobModel, 'create', namespace) });

/**
 * useCanCreateWorkload — check if the user can create a workload of a specific kind.
 * For 'Pod', uses PodModel; for 'Deployment', uses DeploymentModel.
 * Returns [allowed, loading].
 */
export const useCanCreateWorkload = (kind: 'Pod' | 'Deployment', namespace: string) => {
  const model = kind === 'Deployment' ? DeploymentModel : PodModel;
  return useAccessReview({ ...asAccessReview(model, 'create', namespace) });
};

/**
 * useCanDeleteWorkload — check if the user can delete a workload of a specific kind.
 * For 'Pod', uses PodModel; for 'Deployment', uses DeploymentModel.
 * Returns [allowed, loading].
 */
export const useCanDeleteWorkload = (
  kind: 'Pod' | 'Deployment',
  namespace: string,
  name: string,
) => {
  const model = kind === 'Deployment' ? DeploymentModel : PodModel;
  const resourceAttrs: AccessReviewResourceAttributes = {
    ...asAccessReview(model, 'delete', namespace),
    name,
  };
  return useAccessReview(resourceAttrs);
};

/**
 * useCanWriteFeatureGates — check if the user can create or patch the feature gates ConfigMap.
 * If the ConfigMap does not exist (exists=false), checks 'create' permission.
 * If the ConfigMap exists (exists=true), checks 'patch' permission with the named resource.
 * Returns [allowed, loading].
 */
export const useCanWriteFeatureGates = (exists: boolean) => {
  const verb = exists ? 'patch' : 'create';
  const resourceAttrs: AccessReviewResourceAttributes = {
    ...asAccessReview(ConfigMapModel, verb, OSC_NAMESPACE),
    ...(exists ? { name: OSC_FEATURE_GATES_CM } : {}),
  };
  return useAccessReview(resourceAttrs);
};

export const useCanCreateSubscription = (namespace: string) =>
  useAccessReview({
    group: 'operators.coreos.com',
    resource: 'subscriptions',
    namespace,
    verb: 'create',
  });

export const useCanCreateNamespace = () =>
  useAccessReview(asAccessReview(NamespaceModel, 'create'));

export const useCanCreatePvc = (namespace: string) =>
  useAccessReview(asAccessReview(PersistentVolumeClaimModel, 'create', namespace));

export const useCanCreateEvidenceServiceAccount = (namespace: string) =>
  useAccessReview(asAccessReview(ServiceAccountModel, 'create', namespace));

export const useCanCreateEvidenceRole = (namespace: string) =>
  useAccessReview(asAccessReview(RoleModel, 'create', namespace));

export const useCanCreateEvidenceRoleBinding = (namespace: string) =>
  useAccessReview(asAccessReview(RoleBindingModel, 'create', namespace));
