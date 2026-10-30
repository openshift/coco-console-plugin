import type { K8sGroupVersionKind, K8sModel } from '@openshift-console/dynamic-plugin-sdk';

// ---------------------------------------------------------------------------
// Confidential Containers (workload cluster) — shares the OSC/Kata data model.
// CoCo is OpenShift sandboxed containers + a TEE: the kata-cc runtime class plus
// per-pod initdata. We reuse the same KataConfig/RuntimeClass objects osc-openshift-console-plugin
// watches and narrow to the confidential runtimes.
// ---------------------------------------------------------------------------
export const RuntimeClassGVK: K8sGroupVersionKind = {
  group: 'node.k8s.io',
  version: 'v1',
  kind: 'RuntimeClass',
};

export const KataConfigGVK: K8sGroupVersionKind = {
  group: 'kataconfiguration.openshift.io',
  version: 'v1',
  kind: 'KataConfig',
};

/** Create-capable model for the cluster-scoped KataConfig singleton. */
export const KataConfigModel: K8sModel = {
  apiGroup: 'kataconfiguration.openshift.io',
  apiVersion: 'v1',
  kind: 'KataConfig',
  plural: 'kataconfigs',
  namespaced: false,
  abbr: 'KC',
  label: 'KataConfig',
  labelPlural: 'KataConfigs',
  crd: true,
};

/** nfd.openshift.io/v1alpha1 NodeFeatureRule — labels nodes with detected TEEs. */
export const NodeFeatureRuleGVK: K8sGroupVersionKind = {
  group: 'nfd.openshift.io',
  version: 'v1alpha1',
  kind: 'NodeFeatureRule',
};

/** nfd.openshift.io/v1 NodeFeatureDiscovery — the NFD operand that scans nodes. */
export const NodeFeatureDiscoveryGVK: K8sGroupVersionKind = {
  group: 'nfd.openshift.io',
  version: 'v1',
  kind: 'NodeFeatureDiscovery',
};

/** config.openshift.io/v1 ClusterVersion — used to derive the NFD operand image tag. */
export const ClusterVersionGVK: K8sGroupVersionKind = {
  group: 'config.openshift.io',
  version: 'v1',
  kind: 'ClusterVersion',
};

/** config.openshift.io/v1 Infrastructure — read status.infrastructureName for the cluster name. */
export const InfrastructureGVK: K8sGroupVersionKind = {
  group: 'config.openshift.io',
  version: 'v1',
  kind: 'Infrastructure',
};

/** machineconfiguration.openshift.io/v1 MachineConfig — sets host kernel arguments. */
export const MachineConfigGVK: K8sGroupVersionKind = {
  group: 'machineconfiguration.openshift.io',
  version: 'v1',
  kind: 'MachineConfig',
};

/**
 * machineconfiguration.openshift.io/v1 MachineConfigPool — watched to track the
 * rolling reboot a TDX-host MachineConfig triggers (Updating → Updated) instead of
 * declaring success the moment the CR is created.
 */
export const MachineConfigPoolGVK: K8sGroupVersionKind = {
  group: 'machineconfiguration.openshift.io',
  version: 'v1',
  kind: 'MachineConfigPool',
};

export const NodeFeatureRuleModel: K8sModel = {
  apiGroup: 'nfd.openshift.io',
  apiVersion: 'v1alpha1',
  kind: 'NodeFeatureRule',
  plural: 'nodefeaturerules',
  namespaced: true,
  abbr: 'NFR',
  label: 'NodeFeatureRule',
  labelPlural: 'NodeFeatureRules',
  crd: true,
};

export const NodeFeatureDiscoveryModel: K8sModel = {
  apiGroup: 'nfd.openshift.io',
  apiVersion: 'v1',
  kind: 'NodeFeatureDiscovery',
  plural: 'nodefeaturediscoveries',
  namespaced: true,
  abbr: 'NFD',
  label: 'NodeFeatureDiscovery',
  labelPlural: 'NodeFeatureDiscoveries',
  crd: true,
};

export const MachineConfigModel: K8sModel = {
  apiGroup: 'machineconfiguration.openshift.io',
  apiVersion: 'v1',
  kind: 'MachineConfig',
  plural: 'machineconfigs',
  namespaced: false,
  abbr: 'MC',
  label: 'MachineConfig',
  labelPlural: 'MachineConfigs',
  crd: true,
};

/** Create-capable model for a custom MachineConfigPool (TDX-host node subset). */
export const MachineConfigPoolModel: K8sModel = {
  apiGroup: 'machineconfiguration.openshift.io',
  apiVersion: 'v1',
  kind: 'MachineConfigPool',
  plural: 'machineconfigpools',
  namespaced: false,
  abbr: 'MCP',
  label: 'MachineConfigPool',
  labelPlural: 'MachineConfigPools',
  crd: true,
};

/** Patch-capable model for labeling nodes (move selected hosts into a custom pool). */
export const NodeModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Node',
  plural: 'nodes',
  namespaced: false,
  abbr: 'N',
  label: 'Node',
  labelPlural: 'Nodes',
};

// ---- Core ----
export const PodGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Pod' };
export const DeploymentGVK: K8sGroupVersionKind = {
  group: 'apps',
  version: 'v1',
  kind: 'Deployment',
};
export const DaemonSetGVK: K8sGroupVersionKind = {
  group: 'apps',
  version: 'v1',
  kind: 'DaemonSet',
};
export const ServiceGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Service' };
export const ConfigMapGVK: K8sGroupVersionKind = { version: 'v1', kind: 'ConfigMap' };
export const SecretGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Secret' };
export const EventGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Event' };
export const NodeGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Node' };
export const NamespaceGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Namespace' };
/** project.openshift.io/v1 Project — the RBAC-aware list of namespaces a user can see. */
export const ProjectGVK: K8sGroupVersionKind = {
  group: 'project.openshift.io',
  version: 'v1',
  kind: 'Project',
};
export const PersistentVolumeClaimGVK: K8sGroupVersionKind = {
  version: 'v1',
  kind: 'PersistentVolumeClaim',
};
export const StorageClassGVK: K8sGroupVersionKind = {
  group: 'storage.k8s.io',
  version: 'v1',
  kind: 'StorageClass',
};

/** Minimal K8sModels for create/delete via k8sCreate / k8sDelete. */
export const NamespaceModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Namespace',
  plural: 'namespaces',
  namespaced: false,
  abbr: 'NS',
  label: 'Namespace',
  labelPlural: 'Namespaces',
};

export const PersistentVolumeClaimModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  plural: 'persistentvolumeclaims',
  namespaced: true,
  abbr: 'PVC',
  label: 'PersistentVolumeClaim',
  labelPlural: 'PersistentVolumeClaims',
};

export const PodModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Pod',
  plural: 'pods',
  namespaced: true,
  abbr: 'P',
  label: 'Pod',
  labelPlural: 'Pods',
};

export const DeploymentModel: K8sModel = {
  apiVersion: 'v1',
  apiGroup: 'apps',
  kind: 'Deployment',
  plural: 'deployments',
  namespaced: true,
  abbr: 'D',
  label: 'Deployment',
  labelPlural: 'Deployments',
};

export const ConfigMapModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ConfigMap',
  plural: 'configmaps',
  namespaced: true,
  abbr: 'CM',
  label: 'ConfigMap',
  labelPlural: 'ConfigMaps',
};

export const SecretModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'Secret',
  plural: 'secrets',
  namespaced: true,
  abbr: 'S',
  label: 'Secret',
  labelPlural: 'Secrets',
};

// ---- RBAC for the attestation evidence sidecar ----
// The evidence sidecar runs as its own ServiceAccount and needs a small Role
// (write the evidence ConfigMap, read its own Pod) bound to that SA.
export const ServiceAccountModel: K8sModel = {
  apiVersion: 'v1',
  kind: 'ServiceAccount',
  plural: 'serviceaccounts',
  namespaced: true,
  abbr: 'SA',
  label: 'ServiceAccount',
  labelPlural: 'ServiceAccounts',
};

export const RoleModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'Role',
  plural: 'roles',
  namespaced: true,
  abbr: 'R',
  label: 'Role',
  labelPlural: 'Roles',
};

export const RoleBindingModel: K8sModel = {
  apiGroup: 'rbac.authorization.k8s.io',
  apiVersion: 'v1',
  kind: 'RoleBinding',
  plural: 'rolebindings',
  namespaced: true,
  abbr: 'RB',
  label: 'RoleBinding',
  labelPlural: 'RoleBindings',
};

// ---- Well-known names / locations ----
/** Where the OpenShift sandboxed containers operator and its config live. */
export const OSC_NAMESPACE = 'openshift-sandboxed-containers-operator';
/**
 * Configuration ConfigMap that enables confidential containers (data.confidential: "true"),
 * which makes the OSC operator install the kata-cc runtime. The ConfigMap keeps the name
 * "osc-feature-gates" for historical reasons; OSC now calls these "configuration options",
 * not "feature gates" — confidential containers is a supported (GA) option.
 */
export const OSC_FEATURE_GATES_CM = 'osc-feature-gates';
export const PEER_PODS_CM = 'peer-pods-cm';
export const KATACONFIG_NAME = 'example-kataconfig';
/** Pod annotation carrying the gzip+base64 initdata for a confidential pod. */
export const CC_INIT_DATA_ANNOTATION = 'io.katacontainers.config.hypervisor.cc_init_data';

/**
 * The Trustee Key Broker Service in-cluster Service name + port. The attestation
 * topology decodes each workload's initdata KBS URL and compares its host against
 * `kbs-service.<ns>` to tell an in-cluster (co-located) Trustee from a remote one
 * (hub-and-spoke). CoCo itself never deploys Trustee — this is only for classification.
 */
export const KBS_SERVICE_NAME = 'kbs-service';
export const KBS_SERVICE_PORT = 8080;

// ---- Cross-plugin ConfigMap contracts (CoCo ⇄ Trustee) ----
// CoCo and Trustee ship in two independently-versioned operators but exchange data
// through two label-selected ConfigMap conventions. To guard against operator skew,
// each plugin stamps a `schema` data field with this shared version and tolerates a
// missing/older value when reading. Bump only on a breaking shape change.
/** Shared schema/version stamped on the cross-plugin ConfigMaps. */
export const SHARED_CONFIGMAP_SCHEMA_VERSION = '1';
/** Data key carrying the schema/version on a cross-plugin ConfigMap. */
export const SHARED_CONFIGMAP_SCHEMA_KEY = 'schema';

/**
 * Initdata-sharing contract (Trustee writes, CoCo optionally reads on the SAME
 * cluster). Trustee labels a `<tc>-shared-initdata` ConfigMap with this label and
 * puts the ready-to-paste `cc_init_data` value (plus the KBS URL and PCR8) in its
 * data. CoCo's create form offers these as an optional initdata source when one is
 * present in the selected namespace — never required, because the attestation
 * service is commonly on another cluster (hub-spoke) or not Trustee at all.
 */
export const SHARED_INITDATA_LABEL = 'trustee.attestation/shared-initdata';
/** Data key on a shared-initdata ConfigMap holding the gzip+base64 cc_init_data value. */
export const SHARED_INITDATA_DATA_KEY = 'cc_init_data';
/** Data key on a shared-initdata ConfigMap holding the KBS URL (for display only). */
export const SHARED_INITDATA_KBS_URL_KEY = 'kbs-url';

/**
 * Evidence contract (CoCo's in-guest sidecar writes, Trustee reads). The sidecar
 * server-side-applies an `attestation-evidence-*` ConfigMap labeled with this label;
 * Trustee reads it by selector in its Attestation status view. Defined here so the
 * GVK/label live next to the initdata contract; the sidecar script and the
 * evidence-reader (`utils/evidence.ts`) use the same literal.
 */
export const EVIDENCE_LABEL = 'trustee.attestation/evidence';

/**
 * coco-tools image — ships bash, oc, curl, and python3. Kept for tooling that
 * needs the full client set; NOT used by the attestation evidence sidecar (it is
 * too large to unpack inside a confidential kata-cc guest VM — see
 * EVIDENCE_SIDECAR_IMAGE).
 */
export const COCO_TOOLS_IMAGE = 'quay.io/openshift_sandboxed_containers/coco-tools:1.12';

/**
 * Tiny image for the in-guest attestation evidence sidecar. ubi-minimal ships
 * curl + bash + sed + coreutils (~40MB), which fits inside the confidential
 * kata-cc guest VM; the heavier COCO_TOOLS_IMAGE (oc + python3) cannot unpack
 * there and fails with "No space left on device". The sidecar pushes the
 * evidence ConfigMap straight to the Kubernetes API with curl — no oc, no python.
 */
export const EVIDENCE_SIDECAR_IMAGE = 'registry.access.redhat.com/ubi9/ubi-minimal:latest';

// ---- Intel TDX remote attestation (Intel TDX DCAP Operator) ----
// Mirrors "Deploying confidential containers on bare-metal servers" §4.2,
// "Deploy Intel TDX remote attestation" (OSC 1.13+): the Intel TDX DCAP Operator
// replaces the OSC 1.12 manual PCCS/QGS procedure. The operator reconciles a
// single cluster-scoped TdxQuoteGenerationService CR and owns the QGS DaemonSet
// and the platform-registration Deployment — there is no in-cluster PCCS anymore.
// CRD shape verified against intel/confidential-computing.tee.dcap.k8s.qgs.
/**
 * Namespace the Intel TDX DCAP Operator is installed in (per the OSC docs; the
 * operator manages its DaemonSet/Deployment and reads the PCS API key Secret here).
 */
export const INTEL_DCAP_OPERATOR_NAMESPACE = 'intel-dcap-operator-system';
/** The operator's display name in the web console catalog / OperatorHub. */
export const INTEL_DCAP_OPERATOR_NAME = 'Intel TDX DCAP Operator';
/** CRD providing trustedservices.intel.com/v1 TdxQuoteGenerationService. */
export const TQGS_CRD_NAME = 'tdxquotegenerationservices.trustedservices.intel.com';
/**
 * The only allowed TdxQuoteGenerationService name — the CRD enforces the
 * singleton with a CEL rule (metadata.name must be 'intel-tdx-dcap').
 */
export const TQGS_CR_NAME = 'intel-tdx-dcap';
/** Default Secret the operator's registrar reads the Intel PCS API key from. */
export const TQGS_PCS_API_KEY_SECRET_NAME = 'intel-pcs-api-key';
/** Data key holding the API key inside the PCS API key Secret. */
export const TQGS_PCS_API_KEY_SECRET_KEY = 'api-key';
/**
 * Namespace that held the OSC 1.12 (obsolete, manually deployed) PCCS/QGS stack.
 * Watched only to detect the legacy infrastructure and warn about it — those
 * deployments do not work on OSC 1.13+ and must be removed (plus an SGX Factory
 * Reset in the BIOS) before the Intel TDX DCAP Operator is installed.
 */
export const LEGACY_INTEL_DCAP_NAMESPACE = 'intel-dcap';
/** Legacy OSC 1.12 PCCS Deployment (in the legacy intel-dcap namespace). */
export const LEGACY_PCCS_DEPLOYMENT_NAME = 'pccs';
/** Legacy OSC 1.12 QGS DaemonSet (in the legacy intel-dcap namespace). */
export const LEGACY_QGS_DAEMONSET_NAME = 'tdx-qgs';
/** Intel Trusted Services API portal — where the operator subscribes for the PCS API key. */
export const INTEL_PCS_PORTAL_URL = 'https://api.portal.trustedservices.intel.com';
/** OSC bare-metal CoCo docs — §4.2 covers the Intel TDX DCAP operator and the 1.12 migration note. */
export const INTEL_DCAP_DOCS_URL =
  'https://docs.redhat.com/en/documentation/openshift_sandboxed_containers/1.13/html/deploying_confidential_containers_on_bare-metal_servers/configure-cc-overview_metal-cc';
/** OperatorHub keyword search for the Intel TDX DCAP Operator. */
export const INTEL_DCAP_OPERATORHUB_SEARCH = '/operatorhub/all-namespaces?keyword=Intel+TDX+DCAP';

/** trustedservices.intel.com/v1 TdxQuoteGenerationService (cluster-scoped singleton). */
export const TdxQuoteGenerationServiceGVK: K8sGroupVersionKind = {
  group: 'trustedservices.intel.com',
  version: 'v1',
  kind: 'TdxQuoteGenerationService',
};

/** Create-capable model for the cluster-scoped TdxQuoteGenerationService singleton. */
export const TdxQuoteGenerationServiceModel: K8sModel = {
  apiGroup: 'trustedservices.intel.com',
  apiVersion: 'v1',
  kind: 'TdxQuoteGenerationService',
  plural: 'tdxquotegenerationservices',
  namespaced: false,
  abbr: 'TQGS',
  label: 'TdxQuoteGenerationService',
  labelPlural: 'TdxQuoteGenerationServices',
  crd: true,
};

// ---- Intel SGX device plugin (prereq for TDX quote generation) ----
// TDX quotes are signed by an SGX quoting enclave, so the QGS requests
// sgx.intel.com/enclave + /provision — advertised by the Intel SGX device plugin.
export const SgxDevicePluginGVK: K8sGroupVersionKind = {
  group: 'deviceplugin.intel.com',
  version: 'v1',
  kind: 'SgxDevicePlugin',
};
/** Cluster-scoped SgxDevicePlugin CR — deploys the SGX device-plugin DaemonSet. */
export const SgxDevicePluginModel: K8sModel = {
  apiGroup: 'deviceplugin.intel.com',
  apiVersion: 'v1',
  kind: 'SgxDevicePlugin',
  plural: 'sgxdeviceplugins',
  namespaced: false,
  abbr: 'SGX',
  label: 'SgxDevicePlugin',
  labelPlural: 'SgxDevicePlugins',
  crd: true,
};
export const SubscriptionModel: K8sModel = {
  apiGroup: 'operators.coreos.com',
  apiVersion: 'v1alpha1',
  kind: 'Subscription',
  plural: 'subscriptions',
  namespaced: true,
  abbr: 'SUB',
  label: 'Subscription',
  labelPlural: 'Subscriptions',
  crd: true,
};
/** OperatorGroup — required alongside a Subscription for an OwnNamespace operator (NFD). */
export const OperatorGroupModel: K8sModel = {
  apiGroup: 'operators.coreos.com',
  apiVersion: 'v1',
  kind: 'OperatorGroup',
  plural: 'operatorgroups',
  namespaced: true,
  abbr: 'OG',
  label: 'OperatorGroup',
  labelPlural: 'OperatorGroups',
  crd: true,
};
/** apiextensions.k8s.io/v1 CustomResourceDefinition — watched to know when the operator is ready. */
export const CustomResourceDefinitionGVK: K8sGroupVersionKind = {
  group: 'apiextensions.k8s.io',
  version: 'v1',
  kind: 'CustomResourceDefinition',
};

export const INTEL_DEVICE_PLUGINS_OPERATOR = 'intel-device-plugins-operator';
export const INTEL_DEVICE_PLUGINS_CHANNEL = 'stable';
export const INTEL_DEVICE_PLUGINS_SOURCE = 'certified-operators';
export const INTEL_DEVICE_PLUGINS_SOURCE_NS = 'openshift-marketplace';
/** AllNamespaces operator — installs into the global operators namespace. */
export const INTEL_DEVICE_PLUGINS_INSTALL_NS = 'openshift-operators';
export const SGX_DEVICEPLUGIN_CRD = 'sgxdeviceplugins.deviceplugin.intel.com';
export const SGX_DEVICEPLUGIN_CR_NAME = 'sgxdeviceplugin';
/** NFD label the SGX device plugin selects on (TDX nodes carry it too). */
export const SGX_NODE_SELECTOR_LABEL = 'intel.feature.node.kubernetes.io/sgx';
/** Endpoints — watched to know when the operator's admission webhook is serving. */
export const EndpointsGVK: K8sGroupVersionKind = { version: 'v1', kind: 'Endpoints' };
/** The operator's webhook service; its endpoints must be populated before the CR applies. */
export const INTEL_DEVICE_PLUGINS_WEBHOOK_SVC = 'intel-deviceplugins-controller-manager-service';

// `kind~group~version` reference string for action/flag extensions.
export const KataConfigModelRef = 'kataconfiguration.openshift.io~v1~KataConfig';
