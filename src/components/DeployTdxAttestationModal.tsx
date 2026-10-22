import type { FC, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  k8sCreate,
  k8sDelete,
  ResourceLink,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  ClipboardCopy,
  ClipboardCopyVariant,
  Content,
  ExpandableSection,
  Flex,
  FlexItem,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  HelperText,
  HelperTextItem,
  List,
  ListItem,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ProgressStep,
  ProgressStepper,
  TextInput,
} from '@patternfly/react-core';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ExternalLinkAltIcon,
  InfoCircleIcon,
} from '@patternfly/react-icons';
import {
  ClusterRoleBindingModel,
  DaemonSetGVK,
  DeploymentGVK,
  INTEL_DCAP_NAMESPACE,
  INTEL_PCS_PORTAL_URL,
  JobGVK,
  JobModel,
  NamespaceModel,
  NodeGVK,
  OC_CLI_IMAGE,
  OSC_DCAP_HELPERS_TAG,
  oscDcapHelpersBase,
  SecretModel,
  ServiceAccountModel,
  UBI9_IMAGE,
} from '../k8s/resources';
import type { DaemonSetKind, DeploymentKind, JobKind, NodeKind } from '../k8s/types';
import { PermissionHint } from '../utils/rbac/PermissionHint';
import { useCanCreateJob } from '../utils/rbac/useCocoPermissions';
import { sgxCapable, sgxDevicePluginReady, TDX_LABEL } from '../utils/tee';
import { InstallSgxDevicePlugin } from './InstallSgxDevicePlugin';
import './coco.css';

const PREFIX = 'coco-openshift-console-plugin';
const NS = INTEL_DCAP_NAMESPACE;
/** Name shared by the setup Job, its ServiceAccount and its ClusterRoleBinding. */
const SETUP_NAME = 'coco-tdx-attest-setup';
/** Transient Secret that feeds the API key + tokens into the Job (mounted, not logged). */
const INPUT_SECRET = 'coco-tdx-attest-input';

const isNotFound = (e: unknown): boolean =>
  /not found|notfound|404/i.test(e instanceof Error ? e.message : String(e));
const isAlreadyExists = (e: unknown): boolean =>
  /already exists|alreadyexists|conflict|409/i.test(e instanceof Error ? e.message : String(e));

const isControlPlane = (n: NodeKind): boolean => {
  const labels = n.metadata?.labels ?? {};
  return (
    'node-role.kubernetes.io/control-plane' in labels || 'node-role.kubernetes.io/master' in labels
  );
};

type PrereqStatus = 'ok' | 'warn' | 'info';
const PrereqIcon: FC<{ status: PrereqStatus }> = ({ status }) => {
  if (status === 'ok')
    return <CheckCircleIcon color="var(--pf-t--global--icon--color--status--success--default)" />;
  if (status === 'info')
    return <InfoCircleIcon color="var(--pf-t--global--icon--color--status--info--default)" />;
  return (
    <ExclamationTriangleIcon color="var(--pf-t--global--icon--color--status--warning--default)" />
  );
};

/** One live prerequisite row: status icon, label, detail, and an optional action. */
const PrereqRow: FC<{
  status: PrereqStatus;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}> = ({ status, title, detail, action }) => (
  <Flex
    alignItems={{ default: 'alignItemsFlexStart' }}
    gap={{ default: 'gapSm' }}
    justifyContent={{ default: 'justifyContentSpaceBetween' }}
    className={`${PREFIX}__mb`}
  >
    <FlexItem grow={{ default: 'grow' }}>
      <Flex
        alignItems={{ default: 'alignItemsFlexStart' }}
        gap={{ default: 'gapSm' }}
        flexWrap={{ default: 'nowrap' }}
      >
        <FlexItem>
          <PrereqIcon status={status} />
        </FlexItem>
        <FlexItem>
          <strong>{title}</strong>
          {detail && <div className={`${PREFIX}__muted`}>{detail}</div>}
        </FlexItem>
      </Flex>
    </FlexItem>
    {action && <FlexItem>{action}</FlexItem>}
  </Flex>
);

/**
 * The in-cluster setup script — the OSC 1.12 "Deploying Intel TDX remote
 * attestation" procedure (§3.2), run by a cluster-admin Job. `oc` is provided by
 * an initContainer that copies it from the OpenShift CLI image into /shared; the
 * runner image (UBI9) supplies openssl/curl/base64/sha512sum/sed. The Intel PCS
 * API key and tokens are read from the mounted input Secret, never interpolated
 * into the command line. pccs.yaml.in is substituted with sed (no envsubst needed)
 * and applied; qgs.yaml is applied straight from the pinned operator-repo tag.
 */
const buildSetupScript = (base: string): string =>
  [
    'set -eu',
    'export HOME=/tmp',
    'export PATH="/shared:$PATH"',
    'NS=intel-dcap',
    `BASE="${base}"`,
    'echo "### Reading inputs"',
    'PCCS_API_KEY="$(cat /input/PCCS_API_KEY)"',
    'PCCS_USER_TOKEN="$(cat /input/PCCS_USER_TOKEN 2>/dev/null || echo mytoken)"',
    'PCCS_ADMIN_TOKEN="$(cat /input/PCCS_ADMIN_TOKEN 2>/dev/null || echo mytoken)"',
    'PCCS_NODE="$(cat /input/PCCS_NODE 2>/dev/null || true)"',
    'echo "### 1/7 Namespace + service accounts"',
    'oc get ns "$NS" >/dev/null 2>&1 || oc create namespace "$NS"',
    'oc -n "$NS" get sa pccs-sa >/dev/null 2>&1 || oc -n "$NS" create serviceaccount pccs-sa',
    'oc -n "$NS" get sa qgs-sa >/dev/null 2>&1 || oc -n "$NS" create serviceaccount qgs-sa',
    'echo "### 2/7 Grant the privileged SCC"',
    'oc adm policy add-scc-to-user privileged -z pccs-sa -n "$NS"',
    'oc adm policy add-scc-to-user privileged -z qgs-sa -n "$NS"',
    'echo "### 3/7 Resolve PCCS node + cluster proxy"',
    'if [ -z "$PCCS_NODE" ]; then PCCS_NODE="$(oc get nodes -l node-role.kubernetes.io/control-plane= -o jsonpath=\'{.items[0].metadata.name}\')"; fi',
    'echo "PCCS node: $PCCS_NODE"',
    'CLUSTER_HTTPS_PROXY="$(oc get proxy/cluster -o jsonpath=\'{.spec.httpsProxy}\' 2>/dev/null || true)"',
    'echo "### 4/7 Create the pccs-secrets secret"',
    'PCCS_USER_TOKEN_HASH="$(printf \'%s\' "$PCCS_USER_TOKEN" | sha512sum | tr -d \'[:space:]-\')"',
    'PCCS_ADMIN_TOKEN_HASH="$(printf \'%s\' "$PCCS_ADMIN_TOKEN" | sha512sum | tr -d \'[:space:]-\')"',
    'oc -n "$NS" delete secret pccs-secrets --ignore-not-found >/dev/null 2>&1 || true',
    'oc -n "$NS" create secret generic pccs-secrets --from-literal=PCCS_API_KEY="$PCCS_API_KEY" --from-literal=PCCS_USER_TOKEN_HASH="$PCCS_USER_TOKEN_HASH" --from-literal=USER_TOKEN="$PCCS_USER_TOKEN" --from-literal=PCCS_ADMIN_TOKEN_HASH="$PCCS_ADMIN_TOKEN_HASH"',
    'echo "### 5/7 Generate the PCCS TLS cert + deploy PCCS"',
    'CERTDIR="$(mktemp -d)"',
    'openssl req -x509 -sha256 -nodes -days 365 -newkey rsa:2048 -keyout "$CERTDIR/private.pem" -out "$CERTDIR/certificate.pem" -subj "/C=US/ST=Denial/L=Springfield/O=Dis/CN=www.example.com" 2>/dev/null',
    'PCCS_PEM="$(base64 -w0 < "$CERTDIR/private.pem")"',
    'PCCS_CERT="$(base64 -w0 < "$CERTDIR/certificate.pem")"',
    'curl -sSfL "$BASE/pccs.yaml.in" -o /tmp/pccs.yaml.in',
    'sed -e "s|\\${PCCS_PEM}|${PCCS_PEM}|g" -e "s|\\${PCCS_CERT}|${PCCS_CERT}|g" -e "s|\\${PCCS_NODE}|${PCCS_NODE}|g" -e "s|\\${CLUSTER_HTTPS_PROXY}|${CLUSTER_HTTPS_PROXY}|g" /tmp/pccs.yaml.in | oc apply -f -',
    'oc -n "$NS" set serviceaccount deployment/pccs pccs-sa',
    'echo "### 6/7 Deploy the QGS DaemonSet"',
    'oc apply -f "$BASE/qgs.yaml"',
    'oc -n "$NS" set serviceaccount daemonset/tdx-qgs qgs-sa',
    'echo "### 7/7 Load vsock_loopback on the TDX node(s)"',
    '# qemu forwards the guest GetQuote to the QGS over HOST vsock (cid 2:4050). Without the',
    '# vsock_loopback module the host has no loopback transport, qemu cannot reach the QGS,',
    '# and the in-guest agent returns an empty TD quote. This loads it now + on every boot.',
    "oc apply -f - <<'YAML'",
    'apiVersion: apps/v1',
    'kind: DaemonSet',
    'metadata: { name: vsock-loopback-loader, namespace: intel-dcap }',
    'spec:',
    '  selector: { matchLabels: { app: vsock-loopback-loader } }',
    '  template:',
    '    metadata: { labels: { app: vsock-loopback-loader } }',
    '    spec:',
    '      serviceAccountName: qgs-sa',
    '      nodeSelector: { intel.feature.node.kubernetes.io/tdx: "true" }',
    '      hostPID: true',
    '      tolerations: [{ operator: Exists }]',
    '      containers:',
    '      - name: loader',
    '        image: registry.access.redhat.com/ubi9/ubi:latest',
    '        securityContext: { privileged: true, runAsUser: 0 }',
    '        command: ["/bin/bash", "-c"]',
    '        args: ["nsenter -t 1 -m -- modprobe vsock_loopback && echo loaded; exec sleep infinity"]',
    '        resources: { requests: { cpu: 10m, memory: 20Mi }, limits: { memory: 64Mi } }',
    'YAML',
    'echo "### DONE: Intel TDX remote attestation infrastructure applied."',
  ].join('\n');

/** The same procedure as copy-paste commands for an admin workstation (oc logged in). */
const buildManualScript = (base: string, node: string): string =>
  [
    '# 1. Remote attestation project + service accounts',
    'oc create namespace intel-dcap',
    'oc create serviceaccount pccs-sa -n intel-dcap',
    'oc create serviceaccount qgs-sa -n intel-dcap',
    'oc adm policy add-scc-to-user privileged -z pccs-sa -n intel-dcap',
    'oc adm policy add-scc-to-user privileged -z qgs-sa -n intel-dcap',
    '',
    '# 2. Variables — paste your Intel PCS API key',
    'export PCCS_API_KEY="<API_KEY_VALUE>"',
    'export PCCS_USER_TOKEN="${PCCS_USER_TOKEN:-mytoken}"',
    'export PCCS_ADMIN_TOKEN="${PCCS_ADMIN_TOKEN:-mytoken}"',
    `export PCCS_NODE="${node || '<control-plane-node>'}"`,
    'export CLUSTER_HTTPS_PROXY="$(oc get proxy/cluster -o jsonpath={.spec.httpsProxy})"',
    '',
    '# 3. PCCS secrets (token hashes + self-signed PCCS cert)',
    'export PCCS_USER_TOKEN_HASH=$(echo -n "$PCCS_USER_TOKEN" | sha512sum | tr -d \'[:space:]-\')',
    'export PCCS_ADMIN_TOKEN_HASH=$(echo -n "$PCCS_ADMIN_TOKEN" | sha512sum | tr -d \'[:space:]-\')',
    'export PCCS_PEM_CERT_PATH=$(mktemp -d)',
    'openssl req -x509 -sha256 -nodes -days 365 -newkey rsa:2048 \\',
    '  -keyout $PCCS_PEM_CERT_PATH/private.pem \\',
    '  -out $PCCS_PEM_CERT_PATH/certificate.pem \\',
    '  -subj "/C=US/ST=Denial/L=Springfield/O=Dis/CN=www.example.com"',
    'export PCCS_PEM=$(cat "$PCCS_PEM_CERT_PATH"/private.pem | base64 | tr -d \'\\n\')',
    'export PCCS_CERT=$(cat "$PCCS_PEM_CERT_PATH"/certificate.pem | base64 | tr -d \'\\n\')',
    'oc create secret generic pccs-secrets \\',
    '  --namespace intel-dcap \\',
    '  --from-literal=PCCS_API_KEY="$PCCS_API_KEY" \\',
    '  --from-literal=PCCS_USER_TOKEN_HASH="$PCCS_USER_TOKEN_HASH" \\',
    '  --from-literal=USER_TOKEN="$PCCS_USER_TOKEN" \\',
    '  --from-literal=PCCS_ADMIN_TOKEN_HASH="$PCCS_ADMIN_TOKEN_HASH"',
    '',
    `# 4. Deploy PCCS + QGS (pinned ${OSC_DCAP_HELPERS_TAG} manifests)`,
    `oc apply -f <(curl -sSf ${base}/pccs.yaml.in | envsubst)`,
    'oc set serviceaccount deployment/pccs pccs-sa -n intel-dcap',
    `oc apply -f ${base}/qgs.yaml`,
    'oc set serviceaccount daemonset/tdx-qgs qgs-sa -n intel-dcap',
    '',
    '# 5. Load vsock_loopback on the TDX node(s). qemu forwards the guest GetQuote to the QGS',
    '#    over HOST vsock (cid 2:4050); without this module qemu cannot reach it and the guest',
    '#    agent returns an empty TD quote. This DaemonSet loads it now + on every boot.',
    "oc apply -f - <<'YAML'",
    'apiVersion: apps/v1',
    'kind: DaemonSet',
    'metadata: { name: vsock-loopback-loader, namespace: intel-dcap }',
    'spec:',
    '  selector: { matchLabels: { app: vsock-loopback-loader } }',
    '  template:',
    '    metadata: { labels: { app: vsock-loopback-loader } }',
    '    spec:',
    '      serviceAccountName: qgs-sa',
    '      nodeSelector: { intel.feature.node.kubernetes.io/tdx: "true" }',
    '      hostPID: true',
    '      tolerations: [{ operator: Exists }]',
    '      containers:',
    '      - name: loader',
    '        image: registry.access.redhat.com/ubi9/ubi:latest',
    '        securityContext: { privileged: true, runAsUser: 0 }',
    '        command: ["/bin/bash", "-c"]',
    '        args: ["nsenter -t 1 -m -- modprobe vsock_loopback && echo loaded; exec sleep infinity"]',
    'YAML',
  ].join('\n');

interface Props {
  onClose: () => void;
}

/**
 * Guided, automated setup of the Intel TDX remote attestation infrastructure
 * (PCCS + per-node QGS). Automates every deployable step from the bare-metal CoCo
 * docs and prompts only for the one purely-manual input: the Intel PCS API key.
 * Prerequisites are detected live from the actual node capabilities (TDX, SGX, the
 * SGX device plugin) so each shows a real, current status.
 */
const DeployTdxAttestationModal: FC<Props> = ({ onClose }) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [canCreateJob, canCreateJobLoading] = useCanCreateJob(NS);

  const base = useMemo(() => oscDcapHelpersBase(), []);

  const [apiKey, setApiKey] = useState('');
  const [userToken, setUserToken] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [pccsNode, setPccsNode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);
  const cleanedUpRef = useRef(false);

  // Node capabilities, detected live from NFD labels + allocatable resources.
  const [nodes] = useK8sWatchResource<NodeKind[]>({ groupVersionKind: NodeGVK, isList: true });
  const controlPlane = useMemo(
    () =>
      (nodes ?? [])
        .filter(isControlPlane)
        .map((n) => n.metadata?.name ?? '')
        .filter(Boolean),
    [nodes],
  );
  const tdxNodes = useMemo(
    () => (nodes ?? []).filter((n) => n.metadata?.labels?.[TDX_LABEL] === 'true'),
    [nodes],
  );
  const tdxNodeCount = tdxNodes.length;
  // TDX quotes are signed inside an SGX enclave, so the QGS needs SGX. These reflect
  // what the TDX node(s) actually report.
  const sgxCapableOk = tdxNodes.length > 0 && tdxNodes.every(sgxCapable);
  const sgxPluginReady = tdxNodes.length > 0 && tdxNodes.some(sgxDevicePluginReady);
  // Effective PCCS node: the user's pick, else the first control-plane node. (The
  // Job also auto-detects when this is left blank.)
  const effectivePccsNode = pccsNode || controlPlane[0] || '';

  // Watch the Job only once we've launched; watch the two workloads always, so the
  // wizard reflects already-deployed infrastructure when reopened.
  const [job] = useK8sWatchResource<JobKind>(
    started ? { groupVersionKind: JobGVK, name: SETUP_NAME, namespace: NS } : null,
  ) as [JobKind | undefined, boolean, unknown];
  const [pccs] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name: 'pccs',
    namespace: NS,
  }) as [DeploymentKind | undefined, boolean, unknown];
  const [qgs] = useK8sWatchResource<DaemonSetKind>({
    groupVersionKind: DaemonSetGVK,
    name: 'tdx-qgs',
    namespace: NS,
  }) as [DaemonSetKind | undefined, boolean, unknown];

  const jobActive = (job?.status?.active ?? 0) > 0;
  const jobSucceeded = (job?.status?.succeeded ?? 0) > 0;
  const jobFailed =
    (job?.status?.failed ?? 0) > 0 ||
    (job?.status?.conditions ?? []).some((c) => c.type === 'Failed' && c.status === 'True');

  const pccsReady = (pccs?.status?.availableReplicas ?? 0) > 0;
  const qgsDesired = qgs?.status?.desiredNumberScheduled ?? 0;
  const qgsReady = qgs?.status?.numberReady ?? 0;
  const qgsUp = qgsDesired > 0 && qgsReady >= qgsDesired;
  // The infrastructure is fully up (independent of whether we launched it this session).
  const infraReady = pccsReady && qgsUp;
  const prereqsMet = tdxNodeCount > 0 && sgxCapableOk && sgxPluginReady;

  const valid = apiKey.trim() !== '';

  // Once the Job succeeds the infrastructure is applied. Drop the cluster-admin
  // binding and the API-key input Secret immediately — they're only needed while
  // the Job runs. The Job (and its logs) and the SA are left for inspection.
  useEffect(() => {
    if (!jobSucceeded || cleanedUpRef.current) return;
    cleanedUpRef.current = true;
    void (async () => {
      for (const [model, resource] of [
        [
          SecretModel,
          { apiVersion: 'v1', kind: 'Secret', metadata: { name: INPUT_SECRET, namespace: NS } },
        ],
        [
          ClusterRoleBindingModel,
          {
            apiVersion: 'rbac.authorization.k8s.io/v1',
            kind: 'ClusterRoleBinding',
            metadata: { name: SETUP_NAME },
          },
        ],
      ] as const) {
        try {
          await k8sDelete({ model, resource });
        } catch {
          /* best effort */
        }
      }
    })();
  }, [jobSucceeded]);

  const onDeploy = async () => {
    setBusy(true);
    setError('');
    try {
      // Namespace first (the Job's SA/Secret live in it). Idempotent.
      try {
        await k8sCreate({
          model: NamespaceModel,
          data: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: NS } },
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }

      const sa = {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: SETUP_NAME, namespace: NS },
      };
      const crb = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: { name: SETUP_NAME },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',
          name: 'cluster-admin',
        },
        subjects: [{ kind: 'ServiceAccount', name: SETUP_NAME, namespace: NS }],
      };
      const inputSecret = {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: INPUT_SECRET, namespace: NS },
        type: 'Opaque',
        stringData: {
          PCCS_API_KEY: apiKey.trim(),
          PCCS_USER_TOKEN: userToken.trim() || 'mytoken',
          PCCS_ADMIN_TOKEN: adminToken.trim() || 'mytoken',
          PCCS_NODE: effectivePccsNode,
        },
      };
      // Recreate SA + ClusterRoleBinding + input Secret so reruns start clean.
      for (const [model, resource] of [
        [ServiceAccountModel, sa],
        [ClusterRoleBindingModel, crb],
        [SecretModel, inputSecret],
      ] as const) {
        try {
          await k8sDelete({ model, resource });
        } catch (e) {
          if (!isNotFound(e)) throw e;
        }
        await k8sCreate({ model, data: resource });
      }

      const script = buildSetupScript(base);
      const jobResource: JobKind & Record<string, unknown> = {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: { name: SETUP_NAME, namespace: NS },
        spec: {
          backoffLimit: 2,
          template: {
            metadata: { name: SETUP_NAME },
            spec: {
              serviceAccountName: SETUP_NAME,
              restartPolicy: 'Never',
              securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
              volumes: [
                { name: 'shared', emptyDir: {} },
                { name: 'input', secret: { secretName: INPUT_SECRET } },
              ],
              initContainers: [
                {
                  name: 'copy-oc',
                  image: OC_CLI_IMAGE,
                  command: ['sh', '-c', 'cp /usr/bin/oc /shared/oc'],
                  volumeMounts: [{ name: 'shared', mountPath: '/shared' }],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                  },
                },
              ],
              containers: [
                {
                  name: 'setup',
                  image: UBI9_IMAGE,
                  command: ['bash', '-c'],
                  args: [script],
                  env: [{ name: 'HOME', value: '/tmp' }],
                  volumeMounts: [
                    { name: 'shared', mountPath: '/shared' },
                    { name: 'input', mountPath: '/input', readOnly: true },
                  ],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    capabilities: { drop: ['ALL'] },
                  },
                },
              ],
            },
          },
        },
      };
      try {
        await k8sDelete({ model: JobModel, resource: jobResource });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      await k8sCreate({ model: JobModel, data: jobResource });
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ProgressStepper variants for the three phases.
  const applyVariant = jobFailed
    ? 'danger'
    : jobSucceeded
      ? 'success'
      : jobActive
        ? 'info'
        : 'pending';
  const pccsVariant = pccsReady ? 'success' : jobSucceeded ? 'info' : 'pending';
  const qgsVariant = qgsUp
    ? 'success'
    : jobSucceeded && qgsDesired > 0
      ? 'warning'
      : jobSucceeded
        ? 'info'
        : 'pending';

  return (
    <Modal isOpen variant="large" onClose={onClose} aria-label={t('Set up Intel TDX attestation')}>
      <ModalHeader title={t('Set up Intel TDX remote attestation')} />
      <ModalBody>
        {infraReady && (
          <Alert
            variant="success"
            isInline
            title={t('Attestation infrastructure is deployed and running')}
            className={`${PREFIX}__mb`}
          >
            <p>
              {t(
                'PCCS is available and the QGS is ready on {{ready}}/{{desired}} node(s). Intel TDX pods can now produce a signed quote.',
                { ready: qgsReady, desired: qgsDesired },
              )}
            </p>
            <div className={`${PREFIX}__mt`}>
              <ResourceLink groupVersionKind={DeploymentGVK} name="pccs" namespace={NS} inline />{' '}
              <ResourceLink groupVersionKind={DaemonSetGVK} name="tdx-qgs" namespace={NS} inline />
            </div>
          </Alert>
        )}
        <Alert variant="info" isInline title={t('What this sets up')} className={`${PREFIX}__mb`}>
          {t(
            'Intel TDX pods prove their identity with a signed TD quote. This deploys the host-side stack that produces and backs those quotes: an in-cluster Provisioning Certificate Caching Service (PCCS) that caches PCK certificates from Intel, automatic per-node platform registration, and a per-node Quote Generation Service (QGS) the guest reaches over vsock. Without it, attestation fails with an empty quote and Trustee never releases a secret.',
          )}
        </Alert>

        <Alert
          variant={prereqsMet ? 'success' : 'warning'}
          isInline
          title={
            prereqsMet ? t('Prerequisites met') : t('Prerequisites (detected from your nodes)')
          }
          className={`${PREFIX}__mb`}
        >
          <div className={`${PREFIX}__mt`}>
            <PrereqRow
              status={tdxNodeCount > 0 ? 'ok' : 'warn'}
              title={t('Intel TDX nodes')}
              detail={
                tdxNodeCount > 0
                  ? t('{{num}} node(s) labeled for TDX — the QGS DaemonSet schedules onto them.', {
                      num: tdxNodeCount,
                    })
                  : t(
                      'None detected. Label your TDX nodes first (Detect TEE nodes), or the QGS has nowhere to run.',
                    )
              }
            />
            <PrereqRow
              status={sgxCapableOk ? 'ok' : tdxNodeCount > 0 ? 'warn' : 'info'}
              title={t('SGX quoting capability')}
              detail={
                sgxCapableOk
                  ? t(
                      'TDX quotes are signed by an SGX enclave on the host, and your TDX node(s) report SGX capability (NFD).',
                    )
                  : t(
                      'TDX quote generation runs in an SGX enclave. The TDX node(s) do not report SGX yet — check firmware and NFD.',
                    )
              }
            />
            <PrereqRow
              status={sgxPluginReady ? 'ok' : 'warn'}
              title={t('Intel SGX device plugin')}
              detail={
                sgxPluginReady
                  ? t(
                      'The node advertises sgx.intel.com/enclave + /provision, so the QGS can schedule.',
                    )
                  : t(
                      'Not installed — the QGS stays Pending until sgx.intel.com/enclave + /provision are advertised:',
                    )
              }
              action={sgxPluginReady ? undefined : <InstallSgxDevicePlugin ready={false} />}
            />
          </div>
          <Content component="small" className={`${PREFIX}__muted ${PREFIX}__mt`}>
            {t(
              'Note: this runs as a temporary cluster-admin Job (namespace, privileged SCC, privileged DaemonSet). The PCCS control-plane node needs outbound access to the Intel PCS, and your Intel TDX MachineConfig must be applied.',
            )}
          </Content>
        </Alert>

        <Form>
          <FormGroup label={t('Intel PCS API key')} isRequired fieldId="pccs-api-key">
            <TextInput
              id="pccs-api-key"
              type="password"
              value={apiKey}
              isDisabled={started}
              validated={valid || apiKey === '' ? 'default' : 'error'}
              onChange={(_e, v) => {
                setApiKey(v);
              }}
              placeholder={t('Paste your Provisioning Certification Service API key')}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t(
                    'The one manual step. In the Intel Trusted Services API portal, sign in and subscribe to the Provisioning Certification Service; the API key is shown on the Manage Subscriptions page.',
                  )}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
            <Button
              variant="link"
              isInline
              component="a"
              href={INTEL_PCS_PORTAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              icon={<ExternalLinkAltIcon />}
              iconPosition="end"
              className={`${PREFIX}__mt`}
            >
              {t('Open the Intel Trusted Services API portal')}
            </Button>
          </FormGroup>

          <ExpandableSection toggleText={t('Advanced options')}>
            <FormGroup label={t('PCCS node (control plane)')} fieldId="pccs-node">
              {controlPlane.length > 0 ? (
                <FormSelect
                  id="pccs-node"
                  value={effectivePccsNode}
                  isDisabled={started}
                  onChange={(_e, v) => {
                    setPccsNode(v);
                  }}
                >
                  {controlPlane.map((n) => (
                    <FormSelectOption key={n} value={n} label={n} />
                  ))}
                </FormSelect>
              ) : (
                <TextInput
                  id="pccs-node"
                  value={effectivePccsNode}
                  isDisabled={started}
                  onChange={(_e, v) => {
                    setPccsNode(v);
                  }}
                  placeholder={t('Leave blank to auto-select the first control-plane node')}
                />
              )}
            </FormGroup>
            <FormGroup label={t('PCCS user token')} fieldId="pccs-user-token">
              <TextInput
                id="pccs-user-token"
                value={userToken}
                isDisabled={started}
                onChange={(_e, v) => {
                  setUserToken(v);
                }}
                placeholder="mytoken"
              />
            </FormGroup>
            <FormGroup label={t('PCCS admin token')} fieldId="pccs-admin-token">
              <TextInput
                id="pccs-admin-token"
                value={adminToken}
                isDisabled={started}
                onChange={(_e, v) => {
                  setAdminToken(v);
                }}
                placeholder="mytoken"
              />
            </FormGroup>
            <FormHelperText>
              <HelperText>
                <HelperTextItem>
                  {t('Tokens default to "mytoken" if left blank, matching the documented example.')}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </ExpandableSection>

          <ExpandableSection toggleText={t('What this creates in the intel-dcap namespace')}>
            <List>
              <ListItem>
                {t('Namespace intel-dcap and service accounts pccs-sa / qgs-sa (privileged SCC)')}
              </ListItem>
              <ListItem>
                {t('Secret pccs-secrets (API key + token hashes) and a self-signed PCCS TLS cert')}
              </ListItem>
              <ListItem>
                {t('Deployment pccs + Service pccs-service (PCK certificate cache)')}
              </ListItem>
              <ListItem>
                {t('DaemonSet tdx-qgs (per-node quote generation + platform registration)')}
              </ListItem>
            </List>
            <Content component="small" className={`${PREFIX}__muted`}>
              {t(
                'PCCS and QGS images come from the pinned sandboxed-containers-operator {{tag}} manifests.',
                {
                  tag: OSC_DCAP_HELPERS_TAG,
                },
              )}
            </Content>
          </ExpandableSection>

          <ExpandableSection
            toggleText={t('Prefer to run it yourself? Copy the equivalent commands')}
          >
            <Content component="small" className={`${PREFIX}__mb ${PREFIX}__muted`}>
              {t(
                'Run these from a workstation with oc logged in as cluster-admin (needs openssl and envsubst).',
              )}
            </Content>
            <ClipboardCopy
              isCode
              isReadOnly
              variant={ClipboardCopyVariant.expansion}
              hoverTip={t('Copy')}
              clickTip={t('Copied')}
            >
              {buildManualScript(base, effectivePccsNode)}
            </ClipboardCopy>
          </ExpandableSection>

          {started && (
            <ProgressStepper isVertical className={`${PREFIX}__mt`}>
              <ProgressStep
                variant={applyVariant}
                id="step-apply"
                titleId="step-apply-title"
                aria-label={t('Apply attestation infrastructure')}
                isCurrent={jobActive}
                description={
                  jobFailed
                    ? t('The setup Job failed — open it below to read the logs.')
                    : jobSucceeded
                      ? t('Namespace, secrets, PCCS and QGS applied.')
                      : jobActive
                        ? t('Running the documented setup procedure…')
                        : t('Waiting for the Job to start.')
                }
              >
                {t('Apply attestation infrastructure')}
              </ProgressStep>
              <ProgressStep
                variant={pccsVariant}
                id="step-pccs"
                titleId="step-pccs-title"
                aria-label={t('PCCS certificate cache running')}
                description={
                  pccsReady
                    ? t('pccs Deployment is available.')
                    : t('Pulls the PCCS image and starts on the control-plane node.')
                }
              >
                {t('PCCS certificate cache running')}
              </ProgressStep>
              <ProgressStep
                variant={qgsVariant}
                id="step-qgs"
                titleId="step-qgs-title"
                aria-label={t('QGS quote service running')}
                description={
                  qgsUp
                    ? t('tdx-qgs is ready on {{ready}}/{{desired}} node(s).', {
                        ready: qgsReady,
                        desired: qgsDesired,
                      })
                    : jobSucceeded && qgsDesired > 0
                      ? t(
                          '{{ready}}/{{desired}} ready — pods Pending usually means the SGX device plugin is missing.',
                          {
                            ready: qgsReady,
                            desired: qgsDesired,
                          },
                        )
                      : t('Runs on each Intel TDX node once applied.')
                }
              >
                {t('QGS quote service running')}
              </ProgressStep>
            </ProgressStepper>
          )}

          {jobSucceeded && (
            <Alert
              variant="success"
              isInline
              title={t('Attestation infrastructure deployed')}
              className={`${PREFIX}__mt`}
            >
              <p>
                {t(
                  'The PCCS and per-node QGS are applied. New Intel TDX pods can now produce a signed quote; existing pods that failed to attest must be restarted.',
                )}
              </p>
              <div className={`${PREFIX}__mt`}>
                <ResourceLink groupVersionKind={DeploymentGVK} name="pccs" namespace={NS} inline />{' '}
                <ResourceLink
                  groupVersionKind={DaemonSetGVK}
                  name="tdx-qgs"
                  namespace={NS}
                  inline
                />{' '}
                <ResourceLink groupVersionKind={JobGVK} name={SETUP_NAME} namespace={NS} inline />
              </div>
            </Alert>
          )}
          {jobFailed && (
            <Alert
              variant="danger"
              isInline
              title={t('The setup Job failed')}
              className={`${PREFIX}__mt`}
            >
              <p>{t('Open the Job and read its pod logs to see which step failed.')}</p>
              <div className={`${PREFIX}__mt`}>
                <ResourceLink groupVersionKind={JobGVK} name={SETUP_NAME} namespace={NS} inline />
              </div>
            </Alert>
          )}
          {error && (
            <Alert
              variant="danger"
              isInline
              title={t('Could not start the setup')}
              className={`${PREFIX}__mt`}
            >
              {error}
            </Alert>
          )}
        </Form>
        <PermissionHint allowed={canCreateJob} loading={canCreateJobLoading} />
      </ModalBody>
      <ModalFooter>
        {jobSucceeded ? (
          <Button variant="primary" onClick={onClose}>
            {t('Done')}
          </Button>
        ) : infraReady && !started ? (
          <>
            <Button variant="primary" onClick={onClose}>
              {t('Done')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void onDeploy()}
              isDisabled={!valid || busy || canCreateJobLoading || !canCreateJob}
            >
              {t('Re-deploy')}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              onClick={() => void onDeploy()}
              isLoading={busy || (started && !jobFailed)}
              isDisabled={
                !valid || busy || (started && !jobFailed) || canCreateJobLoading || !canCreateJob
              }
            >
              {started && jobFailed ? t('Retry') : t('Deploy attestation infrastructure')}
            </Button>
            <Button variant="link" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  );
};

export default DeployTdxAttestationModal;
