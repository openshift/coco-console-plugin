import {
  k8sCreate,
  k8sPatch,
  useK8sWatchResource,
  type K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  Checkbox,
  CodeBlock,
  CodeBlockAction,
  CodeBlockCode,
  ExpandableSection,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@patternfly/react-core';
import { CheckCircleIcon } from '@patternfly/react-icons';
import type { FC } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useKataConfig, useTeeNodes } from '../k8s/hooks';
import {
  ConfigMapGVK,
  ConfigMapModel,
  OSC_FEATURE_GATES_CM,
  OSC_NAMESPACE,
} from '../k8s/resources';
import type { TeeNode } from '../k8s/types';
import { buildOscFeatureGatesConfigMap } from '../utils/featureGates';
import { PermissionHint } from '../utils/rbac/PermissionHint';
import { useCanWriteFeatureGates } from '../utils/rbac/useCocoPermissions';
import { SNP_LABEL, TDX_LABEL, teeLabel } from '../utils/tee';
import './coco.css';

type ConfigMapKind = K8sResourceCommon & { data?: Record<string, string> };

/** NFD label that selects a node's CPU TEE, or null for a GPU-CC-only node. */
const teeNodeLabel = (n: TeeNode): string | null =>
  n.tee === 'tdx' ? TDX_LABEL : n.tee === 'snp' ? SNP_LABEL : null;

/**
 * Build a copy-pasteable pod/template spec fragment that schedules a confidential
 * workload onto the chosen TEE nodes. Confidential containers itself is enabled
 * cluster-wide; placement is per-workload via the runtime class + a node
 * selector. Uses a clean label nodeSelector when the selection is exactly all
 * nodes carrying one TEE label; otherwise pins the nodes explicitly by hostname.
 */
const buildSchedulingSnippet = (selected: TeeNode[], allTee: TeeNode[]): string => {
  const runtimeClass = selected.some((n) => n.gpuCcReady) ? 'kata-cc-nvidia-gpu' : 'kata-cc';

  if (selected.length === 0) {
    return `spec:\n  runtimeClassName: ${runtimeClass}\n  # select at least one node above`;
  }

  const labels = new Set(selected.map(teeNodeLabel));
  const onlyLabel = labels.size === 1 ? [...labels][0] : null;
  const selectedNames = new Set(selected.map((n) => n.name));
  const coversWholeLabel =
    !!onlyLabel &&
    allTee.filter((n) => teeNodeLabel(n) === onlyLabel).every((n) => selectedNames.has(n.name));

  let selectorYaml: string;
  if (onlyLabel && coversWholeLabel) {
    selectorYaml = `  nodeSelector:\n    ${onlyLabel}: "true"`;
  } else {
    const values = selected.map((n) => `            - ${n.name}`).join('\n');
    selectorYaml =
      '  affinity:\n' +
      '    nodeAffinity:\n' +
      '      requiredDuringSchedulingIgnoredDuringExecution:\n' +
      '        nodeSelectorTerms:\n' +
      '        - matchExpressions:\n' +
      '          - key: kubernetes.io/hostname\n' +
      '            operator: In\n' +
      '            values:\n' +
      values;
  }
  return `spec:\n  runtimeClassName: ${runtimeClass}\n${selectorYaml}`;
};

/**
 * One-click confidential-containers enablement: sets `confidential: "true"` on
 * the `osc-feature-gates` ConfigMap (creating it if absent), which makes the
 * OpenShift sandboxed containers operator install the `kata-cc` runtime. The
 * gate is cluster-wide; the node picker only generates a scheduling snippet for
 * placing confidential workloads on specific TEE-capable nodes.
 */
export const EnableConfidentialContainers: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');

  // Watch the ConfigMap as a LIST, not by name. useK8sWatchResource never flips
  // `loaded` to true for a single *named* resource that does not exist yet, and
  // osc-feature-gates is absent until CoCo is first enabled — which left the
  // enable button (isDisabled={!loaded}) permanently greyed out. A namespaced
  // list loads correctly (empty array when the CM is absent), the same pattern
  // EnableTdxHost uses for MachineConfigs.
  const [cms, loaded, loadError] = useK8sWatchResource<ConfigMapKind[]>({
    groupVersionKind: ConfigMapGVK,
    namespace: OSC_NAMESPACE,
    isList: true,
  });
  const cm = loaded ? cms?.find((c) => c.metadata?.name === OSC_FEATURE_GATES_CM) : undefined;
  const enabled = !!cm && cm.data?.confidential === 'true';
  const cmExists = !!cm;
  const lookupReady = loaded && !loadError;

  // Check write permissions: create if absent, patch if present
  const [canWrite, canWriteLoading] = useCanWriteFeatureGates(cmExists);

  const { teeNodes, loaded: nodesLoaded } = useTeeNodes();
  const [kataConfig] = useKataConfig();
  // A peer-pods-only cloud cluster: the confidential runtime is kata-remote (the
  // pod VMs become Confidential VMs). The operator installs NOTHING on the worker
  // nodes and does NOT reboot them — on-node kata-cc + reboot only happen on
  // bare-metal TEE nodes. This holds regardless of DISABLECVM (non-CVM peer pods
  // still run kata-remote, no reboot). Matches Overview's onNodeTee / the
  // COCO_ONNODE_TEE flag in flags.ts.
  const cloudPeerPodsOnly = kataConfig?.spec?.enablePeerPods === true && teeNodes.length === 0;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // null = "nothing touched yet, default to all"; a Set once the user picks.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [copied, setCopied] = useState(false);

  const sel = selected ?? new Set(teeNodes.map((n) => n.name));
  const selectedNodes = teeNodes.filter((n) => sel.has(n.name));
  const snippet = buildSchedulingSnippet(selectedNodes, teeNodes);

  const toggleNode = (name: string) => {
    const next = new Set(sel);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };

  const copySnippet = () => {
    void navigator.clipboard?.writeText(snippet);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  const onEnable = async () => {
    if (busy || !lookupReady || canWriteLoading || !canWrite || enabled) {
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      if (cmExists) {
        // Patch existing ConfigMap: add or update the 'confidential' key at /data/confidential
        const patches: { op: string; path: string; value?: string | Record<string, string> }[] = [];
        if (cm?.data) {
          // ConfigMap has data: JSON Patch add at /data/confidential
          patches.push({ op: 'add', path: '/data/confidential', value: 'true' });
        } else {
          // ConfigMap has no data object: JSON Patch add at /data
          patches.push({
            op: 'add',
            path: '/data',
            value: { confidential: 'true' },
          });
        }

        await k8sPatch({
          model: ConfigMapModel,
          resource: cm,
          data: patches,
        });
      } else {
        // Create new ConfigMap
        await k8sCreate({ model: ConfigMapModel, data: buildOscFeatureGatesConfigMap() });
      }
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (enabled) {
    return (
      <Label color="green" icon={<CheckCircleIcon />}>
        {t('Confidential containers enabled')}
      </Label>
    );
  }

  return (
    <>
      <Button
        variant="primary"
        onClick={() => {
          setOpen(true);
        }}
        isDisabled={!lookupReady || cloudPeerPodsOnly}
      >
        {t('Enable confidential containers')}
      </Button>
      {loadError && (
        <Alert variant="danger" isInline title={t('Unable to read feature-gate ConfigMaps')}>
          {t('Configuration changes are disabled until the resource read succeeds.')}
        </Alert>
      )}
      <Modal
        isOpen={open}
        onClose={() => {
          setOpen(false);
        }}
        title={t('Enable confidential containers')}
        variant="large"
      >
        <ModalHeader />
        <ModalBody>
          {error && (
            <Alert
              variant="danger"
              isInline
              title={t('Error')}
              className="coco-openshift-console-plugin__mb"
            >
              {error}
            </Alert>
          )}
          {!loadError && <PermissionHint allowed={canWrite} loading={canWriteLoading || !loaded} />}

          {!cloudPeerPodsOnly && teeNodes.length > 0 && (
            <>
              <ExpandableSection
                toggleText={t('Scheduling confidential workloads (optional)')}
                className="coco-openshift-console-plugin__mb"
              >
                <p>
                  {t(
                    'Once confidential containers is enabled, select the bare-metal TEE nodes where confidential workloads can run. Copy the pod spec fragment below into your manifest.',
                  )}
                </p>
                {nodesLoaded ? (
                  <>
                    {teeNodes.map((n) => (
                      <Checkbox
                        key={n.name}
                        id={`coco-node-${n.name}`}
                        label={`${n.name} (${teeLabel(n.tee)})`}
                        isChecked={sel.has(n.name)}
                        onChange={(e) => {
                          if (
                            e.target instanceof HTMLInputElement &&
                            e.target.checked !== undefined
                          ) {
                            toggleNode(n.name);
                          }
                        }}
                      />
                    ))}

                    <CodeBlock actions={[<CodeBlockAction onClick={copySnippet} key="copy" />]}>
                      <CodeBlockCode>{snippet}</CodeBlockCode>
                    </CodeBlock>
                    {copied && <Alert variant="success" title={t('Copied to clipboard')} />}
                  </>
                ) : (
                  <p>{t('Loading TEE nodes...')}</p>
                )}
              </ExpandableSection>
            </>
          )}
        </ModalBody>
        <ModalFooter>
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            {t('Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              void onEnable();
            }}
            isLoading={busy}
            isDisabled={busy || !lookupReady || canWriteLoading || !canWrite}
          >
            {t('Enable')}
          </Button>
        </ModalFooter>
      </Modal>
    </>
  );
};

export default EnableConfidentialContainers;
