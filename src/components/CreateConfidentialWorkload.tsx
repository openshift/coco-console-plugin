import {
  DocumentTitle,
  k8sCreate,
  ListPageHeader,
  useK8sWatchResource,
  type K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardTitle,
  Checkbox,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  ExpandableSection,
  Form,
  FormGroup,
  FormHelperText,
  FormSelect,
  FormSelectOption,
  Grid,
  GridItem,
  HelperText,
  HelperTextItem,
  MenuToggle,
  type MenuToggleElement,
  PageSection,
  Select,
  SelectList,
  SelectOption,
  TextArea,
  TextInput,
  Wizard,
  WizardStep,
} from '@patternfly/react-core';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';
import type { FC, Ref } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  CC_INIT_DATA_ANNOTATION,
  ConfigMapGVK,
  DeploymentModel,
  EVIDENCE_SIDECAR_IMAGE,
  NamespaceModel,
  PersistentVolumeClaimModel,
  PodModel,
  ProjectGVK,
  RoleBindingModel,
  RoleModel,
  ServiceAccountModel,
  SHARED_CONFIGMAP_SCHEMA_VERSION,
  SHARED_INITDATA_DATA_KEY,
  SHARED_INITDATA_KBS_URL_KEY,
  SHARED_INITDATA_LABEL,
  StorageClassGVK,
} from '../k8s/resources';
import type { ConfigMapKind, NamespaceKind, StorageClassKind } from '../k8s/types';
import { useCvmPeerPods, useRuntimeClasses } from '../k8s/hooks';
import { isConfidentialRuntimeClass } from '../utils/runtime';
import { isValidCdhResourcePath } from '../utils/cdhPath';
import { fnv1aHex } from '../utils/checksum';
import { inspectInitdata, isInClusterKbsHost, kbsHostFromUrl } from '../utils/topology';
import type { InitdataInspection } from '../utils/topology';
import { PermissionHint } from '../utils/rbac/PermissionHint';
import {
  useCanCreateWorkload,
  useCanCreateNamespace,
  useCanCreatePvc,
  useCanCreateEvidenceServiceAccount,
  useCanCreateEvidenceRole,
  useCanCreateEvidenceRoleBinding,
} from '../utils/rbac/useCocoPermissions';
import { NamespaceSelect } from './NamespaceSelect';
import './coco.css';

type Kind = 'Pod' | 'Deployment';

const IS_DEFAULT_SC_ANNOTATION = 'storageclass.kubernetes.io/is-default-class';
/** Placeholder shown when no LUKS helper image is supplied — must be replaced by the user. */
const LUKS_HELPER_PLACEHOLDER = '<luks-helper-image>';
/** Docs for building the LUKS helper image (linked from the blocking Create message). */
const LUKS_HELPER_DOCS_URL =
  'https://docs.redhat.com/en/documentation/openshift_sandboxed_containers/1.12/html/deploying_confidential_containers/index';

// --- Attestation evidence sidecar ---
/**
 * Sanitize an arbitrary string into the suffix of a ConfigMap / RBAC object name.
 * Kubernetes object names are RFC 1123 labels: lowercase alphanumerics and '-',
 * and the evidence ConfigMap name must be <= 253 chars total.
 */
const sanitizeName = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');

/** ConfigMap the Trustee plugin reads; one per pod, in the workload's namespace. */
const evidenceCmName = (podName: string): string =>
  `attestation-evidence-${sanitizeName(podName)}`.slice(0, 253).replace(/-+$/g, '');

/** ServiceAccount/Role/RoleBinding name for the sidecar (shared base name). */
const evidenceRbacName = (podName: string): string =>
  `${sanitizeName(podName)}-att-evidence`.slice(0, 253).replace(/-+$/g, '');

/**
 * Script run by the attestation-evidence sidecar. Tiny on purpose: it runs in a
 * ubi-minimal image (curl + bash + sed + coreutils) so it fits inside the
 * confidential kata-cc guest VM — the old coco-tools image (oc + python3) could
 * not unpack there ("No space left on device"). Built as single-quoted lines so
 * every bash `${VAR}` stays literal; all user-supplied values arrive via the
 * container env (POD_NAME, POD_NS, POD_UID, NODE_NAME, RUNTIME, HAS_INITDATA,
 * CDH_PATH, INTERVAL, CM_NAME, KBS_ENDPOINT, SCHEMA_VERSION), never via JS string
 * interpolation.
 * Each loop iteration:
 *   1. probes the Confidential Data Hub for a KBS resource (released only after a
 *      successful in-guest attestation) and maps the curl exit code to a verdict,
 *   2. renders the trustee.attestation.evidence/v1 document with printf, and
 *   3. PATCHes (server-side apply) the evidence ConfigMap the Trustee plugin
 *      reads straight to the Kubernetes API with curl — no oc, no python.
 */
const SIDECAR_SCRIPT = [
  'set -u',
  'API="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT}"',
  'TOKEN="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"',
  'CACERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  'while true; do',
  '  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  '  HTTP="$(curl -s -m 10 -o /tmp/resp -w \'%{http_code}\' "http://127.0.0.1:8006/cdh/resource/${CDH_PATH}" 2>/tmp/cerr)"; PRC=$?',
  '  if [ "$PRC" -ne 0 ]; then VERDICT=inconclusive; HTTP=000; elif [ "$HTTP" -ge 200 ] && [ "$HTTP" -lt 300 ]; then VERDICT=passed; else VERDICT=failed; fi',
  '  printf \'{"schema":"trustee.attestation.evidence/v1","source":"sidecar","timestamp":"%s","workload":{"namespace":"%s","name":"%s","uid":"%s","node":"%s","runtimeClassName":"%s","hasInitData":%s},"trustee":{"kbsEndpoint":"%s"},"probe":{"method":"in-guest sidecar CDH resource fetch","cdhPath":"%s","httpStatus":"%s","execExitCode":%s},"verdict":"%s"}\' "$TS" "$POD_NS" "$POD_NAME" "$POD_UID" "$NODE_NAME" "$RUNTIME" "$HAS_INITDATA" "$KBS_ENDPOINT" "$CDH_PATH" "$HTTP" "$PRC" "$VERDICT" > /tmp/ev.json',
  "  ESC=\"$(sed -e 's/\\\\/\\\\\\\\/g' -e 's/\"/\\\\\"/g' /tmp/ev.json | tr -d '\\n')\"",
  '  printf \'{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"%s","labels":{"trustee.attestation/evidence":"true","trustee.attestation/pod":"%s"}},"data":{"schema":"%s","evidence.json":"%s"}}\' "$CM_NAME" "$POD_NAME" "$SCHEMA_VERSION" "$ESC" > /tmp/cm.json',
  '  curl -sS --cacert "$CACERT" -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/apply-patch+yaml" -X PATCH "${API}/api/v1/namespaces/${POD_NS}/configmaps/${CM_NAME}?fieldManager=attestation-evidence-sidecar&force=true" --data-binary @/tmp/cm.json >/tmp/apply.out 2>/tmp/apply.err || true',
  '  sleep "${INTERVAL}"',
  'done',
].join('\n');

const CreateConfidentialWorkload: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const navigate = useNavigate();

  const [kind, setKind] = useState<Kind>('Pod');
  const [name, setName] = useState('coco-workload');
  const [namespace, setNamespace] = useState('default');
  const [createNewNamespace, setCreateNewNamespace] = useState(false);
  const [image, setImage] = useState('registry.access.redhat.com/ubi9/ubi:latest');
  const [runtimeClass, setRuntimeClass] = useState<string>('kata-cc');
  const [replicas, setReplicas] = useState('1');

  // Runtime class options come from the cluster's actual RuntimeClasses, filtered to
  // the confidential ones — kata-cc / kata-cc-nvidia-gpu on bare-metal TEE clusters,
  // and kata-remote on cloud clusters where peer pods run as Confidential VMs. This is
  // the same isConfidentialRuntimeClass filter the workloads and runtime-class lists
  // use, so the three views agree and the wizard never offers a class the cluster can't
  // schedule (e.g. kata-cc on Azure, where only kata-remote exists). See coco #26.
  const [runtimeClasses] = useRuntimeClasses();
  const cvmPeerPods = useCvmPeerPods();
  const runtimeClassOptions = useMemo(() => {
    const order = ['kata-cc', 'kata-cc-nvidia-gpu', 'kata-remote'];
    const names = [
      ...new Set(
        runtimeClasses
          .filter((rc) => isConfidentialRuntimeClass(rc, cvmPeerPods))
          .map((rc) => rc.metadata?.name)
          .filter(Boolean) as string[],
      ),
    ];
    if (names.length) {
      return names.sort((a, b) => {
        const ia = order.indexOf(a);
        const ib = order.indexOf(b);
        return (
          (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b)
        );
      });
    }
    // Nothing enumerated yet (RuntimeClasses still loading, or CoCo not fully set up):
    // fall back to a topology-appropriate default so the wizard stays usable and never
    // shows the bare-metal kata-cc class on a Confidential-VM peer-pods cluster.
    return cvmPeerPods ? ['kata-remote'] : ['kata-cc', 'kata-cc-nvidia-gpu'];
  }, [runtimeClasses, cvmPeerPods]);

  // Keep the selection valid as options resolve: if the current pick isn't offered
  // (e.g. the kata-cc default on an Azure/peer-pods cluster), snap to the first
  // available class.
  useEffect(() => {
    if (runtimeClassOptions.length && !runtimeClassOptions.includes(runtimeClass)) {
      // Sync snap when the available RuntimeClass list changes (e.g. peer-pods topology).
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional option correction
      setRuntimeClass(runtimeClassOptions[0]);
    }
  }, [runtimeClassOptions, runtimeClass]);
  // Optional — left empty so the container runs the image's own entrypoint unless the
  // user deliberately overrides it. (Note: many base images, e.g. ubi9, exit immediately
  // without a long-running command such as `sleep infinity`.)
  const [command, setCommand] = useState('');
  const [initdata, setInitdata] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Project (project.openshift.io) is the RBAC-aware list of namespaces the user can see:
  // a non-admin can't list cluster-scoped Namespaces but can list their Projects; for an
  // admin it's every namespace. NamespaceSelect renders the picker; the parent keeps the
  // list to decide whether the chosen namespace must be created on submit.
  const [projects] = useK8sWatchResource<NamespaceKind[]>({
    groupVersionKind: ProjectGVK,
    isList: true,
  });
  const nsNames = useMemo(
    () =>
      [...new Set((projects ?? []).map((n) => n.metadata?.name).filter(Boolean) as string[])].sort(
        (a, b) => a.localeCompare(b),
      ),
    [projects],
  );
  const nsTrimmed = namespace.trim();
  const namespaceExists = nsNames.includes(nsTrimmed);

  const shouldCreateNamespace = !namespaceExists && createNewNamespace;

  // Dynamic permission check based on selected kind and namespace
  const [canCreateWorkload, canCreateWorkloadLoading] = useCanCreateWorkload(kind, nsTrimmed);

  const [canCreateNs, nsRbacLoading] = useCanCreateNamespace();

  const [canCreatePvc, pvcRbacLoading] = useCanCreatePvc(nsTrimmed);

  const [canCreateSa, saRbacLoading] = useCanCreateEvidenceServiceAccount(nsTrimmed);

  const [canCreateRole, roleRbacLoading] = useCanCreateEvidenceRole(nsTrimmed);

  const [canCreateRoleBinding, roleBindingRbacLoading] = useCanCreateEvidenceRoleBinding(nsTrimmed);

  // --- Encrypted block volume (LUKS) wizard ---
  const [enc, setEnc] = useState(false);
  const [pvcName, setPvcName] = useState('');
  const [pvcSize, setPvcSize] = useState('1Gi');
  const [storageClass, setStorageClass] = useState('');
  const [devicePath, setDevicePath] = useState('/dev/encblock');
  const [passphraseSource, setPassphraseSource] = useState('kbs:///default/luks/passphrase');
  const [helperImage, setHelperImage] = useState('');
  const [scOpen, setScOpen] = useState(false);
  // True once the user edits the PVC name, so we stop auto-deriving it from the workload name.
  const [pvcNameTouched, setPvcNameTouched] = useState(false);
  const [scTouched, setScTouched] = useState(false);

  // --- Attestation evidence sidecar (self-reporting, no exec) ---
  const [evidenceSidecar, setEvidenceSidecar] = useState(false);
  const [evidenceCdhPath, setEvidenceCdhPath] = useState('default/kbsres1/key1');
  const [evidenceInterval, setEvidenceInterval] = useState('60');

  const requiredPermissions = [
    {
      allowed: canCreateWorkload,
      loading: canCreateWorkloadLoading,
    },
    ...(shouldCreateNamespace ? [{ allowed: canCreateNs, loading: nsRbacLoading }] : []),
    ...(enc ? [{ allowed: canCreatePvc, loading: pvcRbacLoading }] : []),
    ...(evidenceSidecar
      ? [
          { allowed: canCreateSa, loading: saRbacLoading },
          { allowed: canCreateRole, loading: roleRbacLoading },
          {
            allowed: canCreateRoleBinding,
            loading: roleBindingRbacLoading,
          },
        ]
      : []),
  ];

  const permissionsLoading = requiredPermissions.some((permission) => permission.loading);

  const permissionsGranted = requiredPermissions.every((permission) => permission.allowed);

  // PodSecurity "restricted": the always-safe context fields are set unconditionally;
  // runAsNonRoot is opt-out because it blocks images that must run as root.
  const [runAsNonRoot, setRunAsNonRoot] = useState(true);

  const [storageClasses] = useK8sWatchResource<StorageClassKind[]>({
    groupVersionKind: StorageClassGVK,
    isList: true,
  });
  const scNames = useMemo(
    () =>
      ((storageClasses ?? []).map((s) => s.metadata?.name).filter(Boolean) as string[]).sort(
        (a, b) => a.localeCompare(b),
      ),
    [storageClasses],
  );
  const defaultSc = useMemo(() => {
    const flagged = (storageClasses ?? []).find(
      (s) => s.metadata?.annotations?.[IS_DEFAULT_SC_ANNOTATION] === 'true',
    );
    return flagged?.metadata?.name ?? scNames[0] ?? '';
  }, [storageClasses, scNames]);

  // Default-select the cluster's default StorageClass once the list loads (unless the user chose one).
  const effectiveSc = scTouched ? storageClass : storageClass || defaultSc;
  // Default the PVC name from the workload name until the user overrides it.
  const effectivePvcName = pvcNameTouched ? pvcName : pvcName || `${name.trim()}-enc`;

  // The sidecar records which KBS it attested against. The KBS endpoint is baked
  // into the initdata (which the user pastes below), so it is left empty here —
  // the probe still works via the CDH.
  const kbsEndpoint = '';

  // --- Same-cluster shared-initdata picker (optional convenience) ---
  // Trustee, when co-located on THIS cluster, labels a `<tc>-shared-initdata`
  // ConfigMap with `trustee.attestation/shared-initdata` and puts the ready-to-paste
  // cc_init_data value in its data. We watch those in the selected namespace and
  // offer them as a one-click fill. This is never required: the attestation service
  // is commonly on another cluster (hub-spoke) or not Trustee, so manual paste stays
  // the primary path.
  const [sharedInitdataCms] = useK8sWatchResource<ConfigMapKind[]>(
    nsTrimmed
      ? {
          groupVersionKind: ConfigMapGVK,
          namespace: nsTrimmed,
          isList: true,
          selector: { matchLabels: { [SHARED_INITDATA_LABEL]: 'true' } },
        }
      : null,
  );
  const sharedInitdataOptions = useMemo(
    () =>
      (sharedInitdataCms ?? [])
        .map((cm) => ({
          name: cm.metadata?.name ?? '',
          value: cm.data?.[SHARED_INITDATA_DATA_KEY] ?? '',
          kbsUrl: cm.data?.[SHARED_INITDATA_KBS_URL_KEY] ?? '',
        }))
        .filter((o) => o.name !== '' && o.value !== '')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [sharedInitdataCms],
  );
  const [sharedPickerOpen, setSharedPickerOpen] = useState(false);

  // --- Initdata reachability (warn-only): decode the pasted KBS host ---
  // Decoding gzip+base64 in the browser is async, so we cache the async result
  // *tagged with the exact input it was decoded from* and never call setState
  // synchronously in the effect. The displayed host is then DERIVED: it counts only
  // when the cached tag still matches the current paste, so an empty or changed
  // paste clears the warning without a synchronous state write.
  const trimmedInitdata = initdata.trim();
  const [decoded, setDecoded] = useState<{ input: string; insp: InitdataInspection | null }>({
    input: '',
    insp: null,
  });
  useEffect(() => {
    if (trimmedInitdata === '') return;
    let cancelled = false;
    void inspectInitdata(trimmedInitdata).then((insp) => {
      if (!cancelled) setDecoded({ input: trimmedInitdata, insp });
    });
    return () => {
      cancelled = true;
    };
  }, [trimmedInitdata]);
  // Derived: the inspection only applies to the current paste.
  const insp = trimmedInitdata !== '' && decoded.input === trimmedInitdata ? decoded.insp : null;
  const decodedKbsHost = insp?.kbsUrl ? kbsHostFromUrl(insp.kbsUrl) : null;
  const kbsUnreachableWarn = decodedKbsHost !== null && isInClusterKbsHost(decodedKbsHost);
  // Decoded but not a recognizable initdata.toml (corrupt or wrong value pasted).
  const initdataInvalidWarn = insp !== null && !insp.ok;
  // An https KBS with no cert pinned: the in-guest agent (rustls) cannot validate it.
  const httpsNoCertWarn = insp?.scheme === 'https' && !insp.hasCert;

  // --- Inline validation that gates Create ---
  // CDH resource path must be exactly <repository>/<name>/<key> (3 segments); a
  // 2-segment folder path silently 404s at runtime. Only enforced when the sidecar
  // is enabled.
  const cdhPathValid = isValidCdhResourcePath(evidenceCdhPath);
  // The LUKS helper image must be a real image — the placeholder/empty value would
  // "succeed" at Create then fail at container start. Only enforced when encryption
  // is enabled.
  const helperImageTrimmed = helperImage.trim();
  const luksHelperMissing =
    enc && (helperImageTrimmed === '' || helperImageTrimmed === LUKS_HELPER_PLACEHOLDER);

  const valid =
    name.trim() !== '' &&
    nsTrimmed !== '' &&
    image.trim() !== '' &&
    initdata.trim() !== '' &&
    (!enc || (effectivePvcName.trim() !== '' && pvcSize.trim() !== '')) &&
    !luksHelperMissing &&
    (!evidenceSidecar || cdhPathValid);

  // Light per-step Next gating, derived from the existing state above. These only
  // block forward navigation; the final Create stays gated by the combined `valid`.
  const generalStepValid =
    name.trim() !== '' && nsTrimmed !== '' && canCreateWorkload && !canCreateWorkloadLoading;
  const imageStepValid = image.trim() !== '';
  const initdataStepValid = initdata.trim() !== '';
  // Storage step: if encryption is on, require the PVC name/size and a real LUKS
  // helper image (same conditions `valid` enforces); otherwise freely navigable.
  const storageStepValid =
    !enc || (effectivePvcName.trim() !== '' && pvcSize.trim() !== '' && !luksHelperMissing);
  // Evidence step: if the sidecar is on, require a valid CDH resource path.
  const securityStepValid = !evidenceSidecar || cdhPathValid;

  const buildPvc = (): K8sResourceCommon =>
    ({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: effectivePvcName.trim(), namespace: nsTrimmed },
      spec: {
        accessModes: ['ReadWriteOnce'],
        volumeMode: 'Block',
        resources: { requests: { storage: pvcSize.trim() } },
        ...(effectiveSc.trim() ? { storageClassName: effectiveSc.trim() } : {}),
      },
    }) as K8sResourceCommon;

  // ServiceAccount + Role + RoleBinding the evidence sidecar runs as. Returned as
  // a list so create() can apply them and the manifest preview can render them.
  const buildEvidenceRbac = (): K8sResourceCommon[] => {
    const rbacName = evidenceRbacName(name.trim());
    return [
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name: rbacName, namespace: nsTrimmed },
      },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: { name: rbacName, namespace: nsTrimmed },
        rules: [
          {
            apiGroups: [''],
            resources: ['configmaps'],
            verbs: ['get', 'create', 'patch', 'update'],
          },
          { apiGroups: [''], resources: ['pods'], verbs: ['get'] },
        ],
      } as unknown as K8sResourceCommon,
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: rbacName, namespace: nsTrimmed },
        subjects: [{ kind: 'ServiceAccount', name: rbacName, namespace: nsTrimmed }],
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: rbacName },
      } as unknown as K8sResourceCommon,
    ];
  };

  const buildManifest = (initdataValue: string): K8sResourceCommon => {
    const cmd = command.trim() ? command.trim().split(/\s+/) : undefined;
    // When an encrypted volume is requested, the main container mounts it as a raw
    // block device and an init container opens (and on first use formats) the LUKS
    // device using the passphrase before the app container starts.
    const encVolumeDevices = enc
      ? [{ name: 'enc-vol', devicePath: devicePath.trim() || '/dev/encblock' }]
      : undefined;
    // Restricted PodSecurity context for the workload + evidence sidecar (not the
    // LUKS init container, which needs privileges to open the device). runAsNonRoot
    // is included only when the user kept it enabled — root images need it off.
    const securityContext = {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      seccompProfile: { type: 'RuntimeDefault' },
      ...(runAsNonRoot ? { runAsNonRoot: true } : {}),
    };
    const container = {
      name: name.trim(),
      image: image.trim(),
      ...(cmd ? { command: cmd } : {}),
      ...(encVolumeDevices ? { volumeDevices: encVolumeDevices } : {}),
      securityContext,
    };
    const annotations = initdataValue ? { [CC_INIT_DATA_ANNOTATION]: initdataValue } : undefined;

    // luks-setup must open/format the LUKS device on /dev/encblock using the
    // passphrase resolved from PASSPHRASE_SOURCE (a Trustee kbs:/// reference
    // delivered after attestation, or a mounted Kubernetes Secret).
    const initContainers = enc
      ? [
          {
            name: 'luks-setup',
            image: helperImage.trim() || LUKS_HELPER_PLACEHOLDER,
            volumeDevices: encVolumeDevices,
            env: [{ name: 'PASSPHRASE_SOURCE', value: passphraseSource.trim() }],
          },
        ]
      : undefined;
    const volumes = enc
      ? [{ name: 'enc-vol', persistentVolumeClaim: { claimName: effectivePvcName.trim() } }]
      : undefined;

    // The attestation evidence sidecar is a *declared* container (not `oc exec`,
    // which secure CoCo workloads forbid), so it runs inside the same TEE as the
    // workload and continuously proves attestation, publishing evidence to a
    // ConfigMap the Trustee plugin reads. All user values flow in via env so the
    // SIDECAR_SCRIPT can be a constant with literal bash `${VAR}` references.
    const podName = name.trim();
    const evidenceContainer = evidenceSidecar
      ? {
          name: 'attestation-evidence',
          image: EVIDENCE_SIDECAR_IMAGE,
          command: ['bash', '-c', SIDECAR_SCRIPT],
          securityContext,
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '50m', memory: '64Mi' },
          },
          env: [
            { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
            { name: 'POD_NS', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
            { name: 'POD_UID', valueFrom: { fieldRef: { fieldPath: 'metadata.uid' } } },
            { name: 'NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
            { name: 'RUNTIME', value: runtimeClass },
            { name: 'HAS_INITDATA', value: initdataValue ? 'true' : 'false' },
            { name: 'CDH_PATH', value: evidenceCdhPath.trim() || 'default/kbsres1/key1' },
            { name: 'INTERVAL', value: evidenceInterval.trim() || '60' },
            { name: 'CM_NAME', value: evidenceCmName(podName) },
            { name: 'KBS_ENDPOINT', value: kbsEndpoint },
            { name: 'SCHEMA_VERSION', value: SHARED_CONFIGMAP_SCHEMA_VERSION },
          ],
        }
      : undefined;

    const podSpec = {
      runtimeClassName: runtimeClass,
      ...(evidenceContainer ? { serviceAccountName: evidenceRbacName(podName) } : {}),
      containers: evidenceContainer ? [container, evidenceContainer] : [container],
      ...(initContainers ? { initContainers } : {}),
      ...(volumes ? { volumes } : {}),
    };

    if (kind === 'Pod') {
      return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          name: name.trim(),
          namespace: nsTrimmed,
          labels: { app: name.trim() },
          ...(annotations ? { annotations } : {}),
        },
        spec: podSpec,
      } as K8sResourceCommon;
    }
    return {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: name.trim(), namespace: nsTrimmed },
      spec: {
        replicas: Number(replicas) || 1,
        selector: { matchLabels: { app: name.trim() } },
        template: {
          metadata: { labels: { app: name.trim() }, ...(annotations ? { annotations } : {}) },
          spec: podSpec,
        },
      },
    } as K8sResourceCommon;
  };

  // Fingerprint of the pasted initdata so the user can verify a multi-KB paste
  // landed intact (FNV-1a; a copy-paste hint, not a security control).
  const initdataChecksum = trimmedInitdata ? fnv1aHex(trimmedInitdata) : '';
  const previewInitdata =
    trimmedInitdata.length > 80
      ? `${trimmedInitdata.slice(0, 80)}… (${trimmedInitdata.length} chars, fnv1a ${initdataChecksum})`
      : trimmedInitdata;
  const workloadPreview = JSON.stringify(buildManifest(previewInitdata), null, 2);
  // Show every additional object that gets created above the workload (PVC for the
  // LUKS volume, ServiceAccount/Role/RoleBinding for the evidence sidecar), so the
  // preview matches exactly what create() applies.
  const preview = [
    ...(enc ? [JSON.stringify(buildPvc(), null, 2)] : []),
    ...(evidenceSidecar ? buildEvidenceRbac().map((r) => JSON.stringify(r, null, 2)) : []),
    workloadPreview,
  ].join('\n---\n');

  const create = async () => {
    // Guard: check form validity and authorization
    if (busy || !valid || permissionsLoading || !permissionsGranted) {
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      // 1) Create the namespace first if the user opted in and it does not exist.
      if (shouldCreateNamespace) {
        await k8sCreate({
          model: NamespaceModel,
          data: {
            apiVersion: 'v1',
            kind: 'Namespace',
            metadata: { name: nsTrimmed },
          },
        });
      }
      // 2) Provision RBAC for the evidence sidecar before the workload that uses
      //    it: a dedicated ServiceAccount plus a tightly-scoped Role (write the
      //    evidence ConfigMap, read its own Pod) and a RoleBinding. Idempotent —
      //    re-creating a workload of the same name swallows AlreadyExists.
      if (evidenceSidecar) {
        const [sa, role, roleBinding] = buildEvidenceRbac();
        const createIdempotent = async (
          model: typeof ServiceAccountModel,
          data: K8sResourceCommon,
        ) => {
          try {
            await k8sCreate({ model, data });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/already exists/i.test(msg)) throw e;
          }
        };
        await createIdempotent(ServiceAccountModel, sa);
        await createIdempotent(RoleModel, role);
        await createIdempotent(RoleBindingModel, roleBinding);
      }
      // 3) Create the encrypted PVC before the workload that consumes it.
      if (enc) {
        await k8sCreate({ model: PersistentVolumeClaimModel, data: buildPvc() });
      }
      // 4) Create the workload.
      await k8sCreate({
        model: kind === 'Pod' ? PodModel : DeploymentModel,
        data: buildManifest(trimmedInitdata),
      });
      void navigate('/confidential-containers/workloads');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DocumentTitle>{t('Create confidential workload')}</DocumentTitle>
      <ListPageHeader title={t('Create confidential workload')} />
      <PageSection>
        <Wizard
          onClose={() => {
            void navigate('/confidential-containers/workloads');
          }}
          onSave={() => void create()}
        >
          <WizardStep
            name={t('General')}
            id="cw-step-general"
            footer={{ isNextDisabled: !generalStepValid }}
          >
            <Form>
              <FormGroup label={t('Kind')} fieldId="cw-kind">
                <FormSelect
                  id="cw-kind"
                  value={kind}
                  onChange={(_e, v) => {
                    setKind(v as Kind);
                  }}
                >
                  <FormSelectOption value="Pod" label="Pod" />
                  <FormSelectOption value="Deployment" label="Deployment" />
                </FormSelect>
              </FormGroup>
              <FormGroup label={t('Name')} isRequired fieldId="cw-name">
                <TextInput
                  id="cw-name"
                  value={name}
                  onChange={(_e, v) => {
                    setName(v);
                  }}
                />
              </FormGroup>
              <FormGroup label={t('Namespace')} isRequired fieldId="cw-namespace">
                <NamespaceSelect
                  id="cw-namespace"
                  value={namespace}
                  onChange={(nextNamespace) => {
                    if (nextNamespace !== namespace) {
                      setCreateNewNamespace(false);
                    }
                    setNamespace(nextNamespace);
                  }}
                  namespaces={nsNames}
                  creatable
                />
                {nsTrimmed !== '' && !namespaceExists && (
                  <>
                    <Checkbox
                      id="cw-create-namespace"
                      label={t('Create a new namespace')}
                      isChecked={createNewNamespace}
                      onChange={(_event, checked) => {
                        setCreateNewNamespace(checked);
                      }}
                    />

                    <HelperText>
                      <HelperTextItem variant="warning">
                        {createNewNamespace
                          ? t('A new namespace will be created before the workload.')
                          : t(
                              'This namespace is not in your visible projects. It will be treated as an existing namespace.',
                            )}
                      </HelperTextItem>
                    </HelperText>
                  </>
                )}
              </FormGroup>
              {kind === 'Deployment' && (
                <FormGroup label={t('Replicas')} fieldId="cw-replicas">
                  <TextInput
                    id="cw-replicas"
                    type="number"
                    value={replicas}
                    onChange={(_e, v) => {
                      setReplicas(v);
                    }}
                  />
                </FormGroup>
              )}
            </Form>
          </WizardStep>

          <WizardStep
            name={t('Image & command')}
            id="cw-step-image"
            footer={{ isNextDisabled: !imageStepValid }}
          >
            <Form>
              <FormGroup label={t('Image')} isRequired fieldId="cw-image">
                <TextInput
                  id="cw-image"
                  value={image}
                  onChange={(_e, v) => {
                    setImage(v);
                  }}
                />
              </FormGroup>
              <FormGroup label={t('Runtime class')} fieldId="cw-rc">
                <FormSelect
                  id="cw-rc"
                  value={runtimeClass}
                  onChange={(_e, v) => {
                    setRuntimeClass(v);
                  }}
                >
                  {runtimeClassOptions.map((rc) => (
                    <FormSelectOption key={rc} value={rc} label={rc} />
                  ))}
                </FormSelect>
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {runtimeClass === 'kata-remote'
                        ? t(
                            'kata-remote runs the workload in a Confidential VM peer pod on a separate cloud host — the runtime class for confidential containers on Azure and other cloud deployments.',
                          )
                        : t(
                            'kata-cc runs the workload in a hardware TEE (Intel TDX / AMD SEV-SNP) on a bare-metal confidential node.',
                          )}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
              {runtimeClass === 'kata-cc-nvidia-gpu' && (
                <Alert
                  variant="info"
                  isInline
                  title={t('Confidential GPU prerequisites (Tech Preview)')}
                  className="coco-openshift-console-plugin__mb"
                >
                  <p className="coco-openshift-console-plugin__mb">
                    {t(
                      'The kata-cc-nvidia-gpu runtime needs the GPU stack enabled on your TEE nodes first (NVIDIA H100, bare metal only):',
                    )}
                  </p>
                  <ul className="coco-openshift-console-plugin__mb">
                    <li>
                      {t('An IOMMU MachineConfig (intel_iommu=on / amd_iommu=on) — reboots nodes.')}
                    </li>
                    <li>
                      {t(
                        'The NVIDIA GPU Operator with a ClusterPolicy enabling ccManager (CC mode on), the kata sandbox device plugin, and vfio-manager.',
                      )}
                    </li>
                    <li>
                      {t(
                        'Nodes labeled nvidia.com/cc.mode.state=on, nvidia.com/cc.ready.state=true, and a TEE label.',
                      )}
                    </li>
                  </ul>
                  <a
                    href="https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/index.html"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('NVIDIA GPU Operator documentation')}
                  </a>
                </Alert>
              )}
              <FormGroup label={t('Command (optional)')} fieldId="cw-command">
                <TextInput
                  id="cw-command"
                  value={command}
                  placeholder={t('e.g. sleep infinity')}
                  onChange={(_e, v) => {
                    setCommand(v);
                  }}
                />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {t(
                        'Optional. Overrides the image’s entrypoint. Leave empty to use the image default — note some base images (e.g. ubi9) exit immediately without a long-running command like sleep infinity.',
                      )}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </FormGroup>
            </Form>
          </WizardStep>

          <WizardStep
            name={t('Initdata')}
            id="cw-step-initdata"
            footer={{ isNextDisabled: !initdataStepValid }}
          >
            <Form>
              <FormGroup
                label={t('Initdata (cc_init_data annotation)')}
                isRequired
                fieldId="cw-initdata"
              >
                {sharedInitdataOptions.length > 0 && (
                  <div className="coco-openshift-console-plugin__mb">
                    <Select
                      isOpen={sharedPickerOpen}
                      onSelect={(_e, value) => {
                        const picked = sharedInitdataOptions.find((o) => o.name === value);
                        if (picked) setInitdata(picked.value);
                        setSharedPickerOpen(false);
                      }}
                      onOpenChange={(isOpen) => {
                        setSharedPickerOpen(isOpen);
                      }}
                      toggle={(toggleRef: Ref<MenuToggleElement>) => (
                        <MenuToggle
                          id="cw-initdata-shared"
                          ref={toggleRef}
                          isExpanded={sharedPickerOpen}
                          onClick={() => {
                            setSharedPickerOpen(!sharedPickerOpen);
                          }}
                        >
                          {t('Use initdata from Trustee on this cluster')}
                        </MenuToggle>
                      )}
                    >
                      <SelectList>
                        {sharedInitdataOptions.map((o) => (
                          <SelectOption
                            key={o.name}
                            value={o.name}
                            description={
                              o.kbsUrl ? t('KBS: {{url}}', { url: o.kbsUrl }) : undefined
                            }
                          >
                            {o.name}
                          </SelectOption>
                        ))}
                      </SelectList>
                    </Select>
                    <HelperText>
                      <HelperTextItem>
                        {t(
                          'Optional: a Trustee co-located on this cluster shared these initdata ConfigMaps in this namespace. Picking one fills the field below; you can still edit or paste your own.',
                        )}
                      </HelperTextItem>
                    </HelperText>
                  </div>
                )}
                <TextArea
                  id="cw-initdata"
                  value={initdata}
                  onChange={(_e, v) => {
                    setInitdata(v);
                  }}
                  rows={4}
                  placeholder={t('Paste the gzip+base64 value.')}
                />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {t(
                        'Initdata comes from your attestation service (e.g. Trustee), generated against the KBS your workload will attest to. It can run on this cluster or a remote one (hub-and-spoke). Without it the workload cannot attest.',
                      )}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
                {kbsUnreachableWarn && (
                  <Alert
                    variant="warning"
                    isInline
                    title={t('This initdata points at an in-cluster KBS')}
                    className="coco-openshift-console-plugin__mt"
                  >
                    {t(
                      'The pasted initdata attests to {{host}}, an in-cluster Service name that only resolves on the cluster that hosts it. If this workload runs on a different (spoke or air-gapped) cluster it cannot reach that KBS and will fail to attest at runtime. Use the attestation service’s external Route URL for cross-cluster workloads. You can still create the workload.',
                      { host: decodedKbsHost ?? '' },
                    )}
                  </Alert>
                )}
                {initdataInvalidWarn && (
                  <Alert
                    variant="warning"
                    isInline
                    title={t('This doesn’t look like valid initdata')}
                    className="coco-openshift-console-plugin__mt"
                  >
                    {t(
                      'The pasted value didn’t decode to an initdata.toml — it should be the gzip+base64 cc_init_data your attestation service produced. Check that you copied the whole value. You can still create the workload, but it will not attest.',
                    )}
                  </Alert>
                )}
                {httpsNoCertWarn && (
                  <Alert
                    variant="warning"
                    isInline
                    title={t('HTTPS KBS with no certificate pinned')}
                    className="coco-openshift-console-plugin__mt"
                  >
                    {t(
                      'This initdata uses an https:// KBS URL but pins no certificate. The in-guest Confidential Data Hub validates the KBS against the certificate baked into initdata, so without one it cannot establish TLS and the workload fails to attest. Regenerate the initdata with the KBS certificate, or point it at the plain-http KBS endpoint. You can still create the workload.',
                    )}
                  </Alert>
                )}
                {trimmedInitdata !== '' && (
                  <ExpandableSection
                    toggleText={t('Verify pasted initdata ({{count}} chars, fnv1a {{sum}})', {
                      count: trimmedInitdata.length,
                      sum: initdataChecksum,
                    })}
                    className="coco-openshift-console-plugin__mt"
                  >
                    <CodeBlock>
                      <CodeBlockCode>{trimmedInitdata}</CodeBlockCode>
                    </CodeBlock>
                  </ExpandableSection>
                )}
              </FormGroup>
            </Form>
          </WizardStep>

          <WizardStep
            name={t('Storage')}
            id="cw-step-storage"
            footer={{ isNextDisabled: !storageStepValid }}
          >
            <Form>
              <FormGroup fieldId="cw-enc">
                <Checkbox
                  id="cw-enc"
                  label={t('Add an encrypted block volume (LUKS)')}
                  description={t(
                    'Attach a raw-block PVC that an init container opens with LUKS inside the TEE, using a passphrase Trustee delivers only after attestation.',
                  )}
                  isChecked={enc}
                  onChange={(_e, checked) => {
                    setEnc(checked);
                  }}
                />
              </FormGroup>
              {enc && (
                <>
                  <FormGroup label={t('PVC name')} isRequired fieldId="cw-pvc-name">
                    <TextInput
                      id="cw-pvc-name"
                      value={effectivePvcName}
                      onChange={(_e, v) => {
                        setPvcNameTouched(true);
                        setPvcName(v);
                      }}
                    />
                  </FormGroup>
                  <FormGroup label={t('Size')} isRequired fieldId="cw-pvc-size">
                    <TextInput
                      id="cw-pvc-size"
                      value={pvcSize}
                      onChange={(_e, v) => {
                        setPvcSize(v);
                      }}
                    />
                  </FormGroup>
                  <FormGroup label={t('Storage class')} fieldId="cw-pvc-sc">
                    <Select
                      isOpen={scOpen}
                      selected={effectiveSc}
                      onSelect={(_e, value) => {
                        setScTouched(true);
                        setStorageClass(typeof value === 'string' ? value : '');
                        setScOpen(false);
                      }}
                      onOpenChange={(isOpen) => {
                        setScOpen(isOpen);
                      }}
                      toggle={(toggleRef: Ref<MenuToggleElement>) => (
                        <MenuToggle
                          id="cw-pvc-sc"
                          ref={toggleRef}
                          isExpanded={scOpen}
                          isFullWidth
                          onClick={() => {
                            setScOpen(!scOpen);
                          }}
                        >
                          {effectiveSc || t('Use cluster default')}
                        </MenuToggle>
                      )}
                    >
                      <SelectList>
                        {scNames.length === 0 ? (
                          <SelectOption isDisabled value="__none__">
                            {t('No storage classes found')}
                          </SelectOption>
                        ) : (
                          scNames.map((sc) => (
                            <SelectOption key={sc} value={sc}>
                              {sc === defaultSc ? t('{{name}} (default)', { name: sc }) : sc}
                            </SelectOption>
                          ))
                        )}
                      </SelectList>
                    </Select>
                  </FormGroup>
                  <FormGroup label={t('Device path')} fieldId="cw-device-path">
                    <TextInput
                      id="cw-device-path"
                      value={devicePath}
                      onChange={(_e, v) => {
                        setDevicePath(v);
                      }}
                    />
                  </FormGroup>
                  <FormGroup label={t('Passphrase source')} fieldId="cw-passphrase">
                    <TextInput
                      id="cw-passphrase"
                      value={passphraseSource}
                      onChange={(_e, v) => {
                        setPassphraseSource(v);
                      }}
                    />
                    <HelperText>
                      <HelperTextItem>
                        {t(
                          'A Trustee-delivered passphrase reference like kbs:///default/luks/passphrase, or a Kubernetes Secret name.',
                        )}
                      </HelperTextItem>
                    </HelperText>
                  </FormGroup>
                  <FormGroup label={t('LUKS helper image')} isRequired fieldId="cw-helper-image">
                    <TextInput
                      id="cw-helper-image"
                      value={helperImage}
                      placeholder={LUKS_HELPER_PLACEHOLDER}
                      validated={luksHelperMissing ? 'error' : 'default'}
                      onChange={(_e, v) => {
                        setHelperImage(v);
                      }}
                    />
                    <HelperText>
                      <HelperTextItem variant={luksHelperMissing ? 'error' : 'default'}>
                        {luksHelperMissing
                          ? t(
                              'A real LUKS helper image is required — the placeholder is not a usable image, and leaving it would let Create succeed and then fail at container start. Build/supply an image whose init container opens the LUKS device with the passphrase on boot.',
                            )
                          : t(
                              'Image whose init container opens the LUKS device with the passphrase on boot.',
                            )}
                      </HelperTextItem>
                    </HelperText>
                    <Button
                      variant="link"
                      isInline
                      component="a"
                      href={LUKS_HELPER_DOCS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      icon={<ExternalLinkAltIcon />}
                      iconPosition="end"
                    >
                      {t('LUKS-in-TEE documentation')}
                    </Button>
                  </FormGroup>
                </>
              )}
            </Form>
          </WizardStep>

          <WizardStep
            name={t('Evidence & security')}
            id="cw-step-security"
            footer={{ isNextDisabled: !securityStepValid }}
          >
            <Form>
              <FormGroup fieldId="cw-evidence">
                <Checkbox
                  id="cw-evidence"
                  label={t('Add attestation evidence sidecar (self-reporting, no exec required)')}
                  description={t(
                    'Run a declared container inside the TEE that continuously fetches a KBS resource to prove attestation and publishes a timestamped evidence record the Trustee plugin reads.',
                  )}
                  isChecked={evidenceSidecar}
                  onChange={(_e, checked) => {
                    setEvidenceSidecar(checked);
                  }}
                />
              </FormGroup>
              {evidenceSidecar && (
                <>
                  <Alert
                    variant="info"
                    isInline
                    title={t('How the evidence sidecar works')}
                    className="coco-openshift-console-plugin__mb"
                  >
                    <p className="coco-openshift-console-plugin__mb">
                      {t(
                        'The sidecar runs inside the TEE as a declared container — not via oc exec, which secure confidential workloads forbid. It proves attestation by fetching a KBS resource through the Confidential Data Hub (the resource is only released after a successful attestation) and pushes a timestamped evidence record to a ConfigMap.',
                      )}
                    </p>
                    <p className="coco-openshift-console-plugin__mb">
                      {t(
                        'It uses a tiny ubi-minimal image and pushes the evidence to the Kubernetes API with curl (no oc, no python), so it fits inside the confidential guest VM.',
                      )}
                    </p>
                    <p>
                      {t(
                        'The sidecar publishes that record as a ConfigMap the Trustee plugin reads in its Attestation status view. It must be present at pod creation; it cannot be added to a running pod.',
                      )}
                    </p>
                  </Alert>
                  <FormGroup label={t('CDH resource path')} isRequired fieldId="cw-evidence-cdh">
                    <TextInput
                      id="cw-evidence-cdh"
                      value={evidenceCdhPath}
                      validated={cdhPathValid ? 'default' : 'error'}
                      onChange={(_e, v) => {
                        setEvidenceCdhPath(v);
                      }}
                    />
                    <HelperText>
                      <HelperTextItem variant={cdhPathValid ? 'default' : 'error'}>
                        {cdhPathValid
                          ? t(
                              'A KBS resource the guest fetches as proof it attested — released only after a successful attestation. Use the full path <repository>/<name>/<key>, e.g. default/kbsres1/key1.',
                            )
                          : t(
                              'Enter the full path <repository>/<name>/<key> (3 segments), e.g. default/kbsres1/key1. A two-segment path like default/kbsres1 is a folder, not a resource, and returns 404.',
                            )}
                      </HelperTextItem>
                    </HelperText>
                  </FormGroup>
                  <FormGroup label={t('Refresh interval seconds')} fieldId="cw-evidence-interval">
                    <TextInput
                      id="cw-evidence-interval"
                      type="number"
                      value={evidenceInterval}
                      onChange={(_e, v) => {
                        setEvidenceInterval(v);
                      }}
                    />
                  </FormGroup>
                </>
              )}

              <FormGroup fieldId="cw-nonroot">
                <Checkbox
                  id="cw-nonroot"
                  label={t('Run as non-root')}
                  description={t(
                    'Adds runAsNonRoot: true so the pod meets the restricted Pod Security Standard (allowPrivilegeEscalation: false, dropped capabilities, and the RuntimeDefault seccomp profile are always set). Untick only if your image must run as root.',
                  )}
                  isChecked={runAsNonRoot}
                  onChange={(_e, checked) => {
                    setRunAsNonRoot(checked);
                  }}
                />
              </FormGroup>
            </Form>
          </WizardStep>

          <WizardStep
            name={t('Review')}
            id="cw-step-review"
            footer={{
              nextButtonText: t('Create'),
              isNextDisabled: busy || !valid || permissionsLoading || !permissionsGranted,
            }}
          >
            <PermissionHint allowed={permissionsGranted} loading={permissionsLoading} />
            {error && (
              <Alert
                variant="danger"
                isInline
                title={t('Could not create workload')}
                className="coco-openshift-console-plugin__mb"
              >
                {error}
              </Alert>
            )}
            <Grid hasGutter>
              <GridItem md={6}>
                <Card isCompact>
                  <CardTitle>{t('Summary')}</CardTitle>
                  <CardBody>
                    <DescriptionList isHorizontal isCompact>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Kind')}</DescriptionListTerm>
                        <DescriptionListDescription>{kind}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Name')}</DescriptionListTerm>
                        <DescriptionListDescription>{name.trim()}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Namespace')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          {nsTrimmed}
                          {shouldCreateNamespace ? ` (${t('to be created')})` : ''}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                      {kind === 'Deployment' && (
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Replicas')}</DescriptionListTerm>
                          <DescriptionListDescription>
                            {Number(replicas) || 1}
                          </DescriptionListDescription>
                        </DescriptionListGroup>
                      )}
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Image')}</DescriptionListTerm>
                        <DescriptionListDescription>{image.trim()}</DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Runtime class')}</DescriptionListTerm>
                        <DescriptionListDescription>{runtimeClass}</DescriptionListDescription>
                      </DescriptionListGroup>
                      {command.trim() !== '' && (
                        <DescriptionListGroup>
                          <DescriptionListTerm>{t('Command')}</DescriptionListTerm>
                          <DescriptionListDescription>{command.trim()}</DescriptionListDescription>
                        </DescriptionListGroup>
                      )}
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Initdata')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          {trimmedInitdata !== ''
                            ? t('{{count}} chars, fnv1a {{sum}}', {
                                count: trimmedInitdata.length,
                                sum: initdataChecksum,
                              })
                            : t('Not set')}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Encrypted volume')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          {enc
                            ? t('{{name}} ({{size}})', {
                                name: effectivePvcName.trim(),
                                size: pvcSize.trim(),
                              })
                            : t('None')}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Evidence sidecar')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          {evidenceSidecar ? t('Enabled') : t('Disabled')}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                      <DescriptionListGroup>
                        <DescriptionListTerm>{t('Run as non-root')}</DescriptionListTerm>
                        <DescriptionListDescription>
                          {runAsNonRoot ? t('Yes') : t('No')}
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    </DescriptionList>
                  </CardBody>
                </Card>
              </GridItem>
              <GridItem md={6}>
                <Card isCompact>
                  <CardTitle>{t('Manifest preview')}</CardTitle>
                  <CardBody>
                    <CodeBlock>
                      <CodeBlockCode>{preview}</CodeBlockCode>
                    </CodeBlock>
                  </CardBody>
                </Card>
              </GridItem>
            </Grid>
          </WizardStep>
        </Wizard>
      </PageSection>
    </>
  );
};

export default CreateConfidentialWorkload;
