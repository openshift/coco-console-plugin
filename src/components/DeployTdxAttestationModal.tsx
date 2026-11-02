import type { FC, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  k8sCreate,
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
  DaemonSetGVK,
  DeploymentGVK,
  INTEL_DCAP_DOCS_URL,
  INTEL_DCAP_OPERATORHUB_SEARCH,
  INTEL_DCAP_OPERATOR_NAME,
  INTEL_DCAP_OPERATOR_NAMESPACE,
  INTEL_PCS_PORTAL_URL,
  NodeGVK,
  SecretGVK,
  SecretModel,
  TdxQuoteGenerationServiceGVK,
  TdxQuoteGenerationServiceModel,
  TQGS_CR_NAME,
  TQGS_PCS_API_KEY_SECRET_NAME,
} from '../k8s/resources';
import { useLegacyTdxAttestationInfra, useTdxQuoteGenerationService } from '../k8s/hooks';
import type { NodeKind, SecretKind } from '../k8s/types';
import { PermissionHint } from '../utils/rbac/PermissionHint';
import { useCanCreateDcapSecret, useCanCreateTqgs } from '../utils/rbac/useCocoPermissions';
import { sgxCapable, sgxDevicePluginReady, TDX_LABEL } from '../utils/tee';
import {
  buildPcsApiKeySecret,
  buildTdxQuoteGenerationService,
  buildTdxSetupManualScript,
  DEFAULT_TQGS_NODE_SELECTOR,
  nodesMatchingSelector,
  nodeSelectorValid,
  pcsApiKeySecretValid,
  summarizeTqgs,
} from '../utils/tdxQuoteGenerationService';
import { InstallSgxDevicePlugin } from './InstallSgxDevicePlugin';
import './coco.css';

const PREFIX = 'coco-openshift-console-plugin';

const isAlreadyExists = (e: unknown): boolean =>
  /already exists|alreadyexists|conflict|409/i.test(e instanceof Error ? e.message : String(e));

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

interface Props {
  onClose: () => void;
}

/**
 * Guided setup of the Intel TDX remote attestation infrastructure through the
 * Intel TDX DCAP Operator — the mechanism documented by OSC 1.13+ ("Deploying
 * confidential containers on bare-metal servers" §4.2), which replaces the OSC
 * 1.12 manual PCCS/QGS procedure. The plugin configures the documented inputs —
 * the Intel PCS API key Secret and the TdxQuoteGenerationService CR (Online
 * platform registration) — and reads reconciliation readiness from the CR status;
 * the operator owns the QGS DaemonSet and the registrar Deployment. The operator
 * itself is installed through OperatorHub (guided, never auto-subscribed), and a
 * detected OSC 1.12 deployment blocks the flow until it is migrated.
 */
const DeployTdxAttestationModal: FC<Props> = ({ onClose }) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [canCreateTqgs, tqgsRbacLoading] = useCanCreateTqgs();
  const [canCreateSecret, secretRbacLoading] = useCanCreateDcapSecret(
    INTEL_DCAP_OPERATOR_NAMESPACE,
  );

  const [apiKey, setApiKey] = useState('');
  const [nodeSelector, setNodeSelector] = useState(DEFAULT_TQGS_NODE_SELECTOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [started, setStarted] = useState(false);

  // Node capabilities, detected live from NFD labels + allocatable resources.
  const [nodes] = useK8sWatchResource<NodeKind[]>({ groupVersionKind: NodeGVK, isList: true });
  const tdxNodes = useMemo(
    () => (nodes ?? []).filter((n) => n.metadata?.labels?.[TDX_LABEL] === 'true'),
    [nodes],
  );
  const tdxNodeCount = tdxNodes.length;
  // TDX quotes are signed inside an SGX enclave, so the QGS needs SGX. These reflect
  // what the TDX node(s) actually report.
  const sgxCapableOk = tdxNodes.length > 0 && tdxNodes.every(sgxCapable);
  const sgxPluginReady = tdxNodes.length > 0 && tdxNodes.some(sgxDevicePluginReady);
  // Live feedback on the node selector the QGS DaemonSet will schedule onto.
  const selectorOk = nodeSelectorValid(nodeSelector);
  const selectorMatches = useMemo(
    () => nodesMatchingSelector(nodes ?? [], nodeSelector).length,
    [nodes, nodeSelector],
  );

  // Operator + CR state. The CRD watch doubles as the "operator installed" signal;
  // the CR is only watchable once the CRD exists. 404s read as "absent".
  const { cr, crdInstalled } = useTdxQuoteGenerationService();
  const summary = summarizeTqgs(cr, crdInstalled);
  const crExists = Boolean(cr?.metadata);

  // The Intel PCS API key Secret the operator's registrar reads. Only its shape
  // is inspected — the key value is never read back or displayed — and a Secret
  // that exists but lacks the api-key data key does not count as configured.
  const [pcsSecret] = useK8sWatchResource<SecretKind>(
    crdInstalled
      ? {
          groupVersionKind: SecretGVK,
          name: TQGS_PCS_API_KEY_SECRET_NAME,
          namespace: INTEL_DCAP_OPERATOR_NAMESPACE,
        }
      : null,
  ) as [SecretKind | undefined, boolean, unknown];
  const secretPresent = Boolean(pcsSecret?.metadata?.name);
  const secretValid = pcsApiKeySecretValid(pcsSecret);
  // With a present-but-malformed Secret, typing a new key cannot help (an
  // existing Secret is never overwritten from here), so it must be fixed first.
  const valid = secretPresent ? secretValid : apiKey.trim() !== '';

  // Obsolete OSC 1.12 infrastructure — blocks the new installation. 'unknown'
  // (e.g. no read access to the legacy intel-dcap namespace) blocks too: the
  // wizard must not deploy alongside a legacy stack it failed to rule out.
  const legacy = useLegacyTdxAttestationInfra();
  const prereqsMet = tdxNodeCount > 0 && sgxCapableOk && sgxPluginReady;

  const onDeploy = async () => {
    setBusy(true);
    setError('');
    try {
      // 1. The Intel PCS API key Secret (only when absent — an existing key is
      //    never overwritten from here). The key travels in the Secret payload
      //    only; it is not logged or echoed anywhere.
      if (!secretPresent) {
        try {
          await k8sCreate({
            model: SecretModel,
            data: buildPcsApiKeySecret(INTEL_DCAP_OPERATOR_NAMESPACE, apiKey.trim()),
          });
        } catch (e) {
          if (!isAlreadyExists(e)) throw e;
        }
      }
      // 2. The TdxQuoteGenerationService singleton (idempotent: an existing CR is
      //    left untouched — its status drives the progress below).
      try {
        await k8sCreate({
          model: TdxQuoteGenerationServiceModel,
          data: buildTdxQuoteGenerationService({ nodeSelector }),
        });
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
      setStarted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ProgressStepper variants for the rollout phases.
  const applyVariant = error ? 'danger' : crExists ? 'success' : started ? 'info' : 'pending';
  const secretVariant = secretValid
    ? 'success'
    : secretPresent
      ? 'warning'
      : started
        ? 'info'
        : 'pending';
  const qgsVariant =
    summary.phase === 'failed'
      ? 'danger'
      : summary.phase === 'ready'
        ? 'success'
        : summary.zeroNodes
          ? 'warning'
          : crExists
            ? 'info'
            : 'pending';
  const registrationVariant =
    summary.phase === 'ready' || summary.registrationReady === true ? 'success' : 'pending';

  const showProgress = started || crExists;
  // In-flight while the rollout is pending or reconciling — but not once the
  // operator reported a reconciliation failure (the button must offer Retry).
  const deploying =
    started && !error && (summary.phase === 'missing' || summary.phase === 'installing');

  return (
    <Modal isOpen variant="large" onClose={onClose} aria-label={t('Set up Intel TDX attestation')}>
      <ModalHeader title={t('Set up Intel TDX remote attestation')} />
      <ModalBody>
        {summary.phase === 'ready' && (
          <Alert
            variant="success"
            isInline
            title={t('Attestation infrastructure is deployed and running')}
            className={`${PREFIX}__mb`}
          >
            <p>
              {t(
                'The Intel TDX DCAP operator is running the quote generation service — the QGS is ready on {{ready}}/{{desired}} node(s). Intel TDX pods can now produce a signed quote.',
                { ready: summary.ready, desired: summary.desired },
              )}
            </p>
            <div className={`${PREFIX}__mt`}>
              <ResourceLink
                groupVersionKind={TdxQuoteGenerationServiceGVK}
                name={TQGS_CR_NAME}
                inline
              />{' '}
              <ResourceLink
                groupVersionKind={DaemonSetGVK}
                name={summary.daemonsetName ?? `${TQGS_CR_NAME}-qgs`}
                namespace={INTEL_DCAP_OPERATOR_NAMESPACE}
                inline
              />
              {summary.onlineMode && (
                <>
                  {' '}
                  <ResourceLink
                    groupVersionKind={DeploymentGVK}
                    name={summary.registrationDeploymentName ?? `${TQGS_CR_NAME}-registrar`}
                    namespace={INTEL_DCAP_OPERATOR_NAMESPACE}
                    inline
                  />
                </>
              )}
            </div>
          </Alert>
        )}
        <Alert variant="info" isInline title={t('What this sets up')} className={`${PREFIX}__mb`}>
          {t(
            'Intel TDX pods prove their identity with a signed TD quote. This configures the documented Intel TDX DCAP operator flow: the operator runs a per-node Quote Generation Service (QGS) that the guest reaches over vsock, and — with Online platform registration — registers your platforms with the Intel Provisioning Certification Service so PCK collateral is provisioned automatically. Without it, attestation fails with an empty quote and Trustee never releases a secret.',
          )}
        </Alert>

        {legacy.status === 'present' && (
          <Alert
            variant="danger"
            isInline
            title={t(
              'Obsolete attestation infrastructure detected (OpenShift sandboxed containers 1.12)',
            )}
            className={`${PREFIX}__mb`}
          >
            <p>
              {t(
                'This cluster still runs the PCCS Deployment and/or tdx-qgs DaemonSet that the OpenShift sandboxed containers 1.12 instructions deployed manually. That setup does not work on later versions and conflicts with the Intel TDX DCAP Operator. Follow the documented migration before continuing: remove the existing deployment, toggle Intel SGX Factory Reset in the BIOS, then install the Intel TDX DCAP Operator. This plugin never deletes those resources for you.',
              )}
            </p>
            <div className={`${PREFIX}__mt`}>
              <Button
                variant="link"
                isInline
                component="a"
                href={INTEL_DCAP_DOCS_URL}
                target="_blank"
                rel="noopener noreferrer"
                icon={<ExternalLinkAltIcon />}
                iconPosition="end"
              >
                {t('Migration procedure in the documentation')}
              </Button>
            </div>
          </Alert>
        )}
        {legacy.loaded && legacy.status === 'unknown' && (
          <Alert
            variant="warning"
            isInline
            title={t('Could not check for obsolete attestation infrastructure')}
            className={`${PREFIX}__mb`}
          >
            <p>
              {t(
                'The plugin cannot determine whether the OpenShift sandboxed containers 1.12 PCCS/QGS stack is still deployed — typically because this account is not allowed to read the intel-dcap namespace. Deploying is blocked until that is ruled out, because the two setups conflict. Verify manually (for example: oc get deployment pccs -n intel-dcap and oc get daemonset tdx-qgs -n intel-dcap), and grant read access to the namespace if you manage this account.',
              )}
            </p>
          </Alert>
        )}

        <Alert
          variant={prereqsMet && crdInstalled ? 'success' : 'warning'}
          isInline
          title={
            prereqsMet && crdInstalled
              ? t('Prerequisites met')
              : t('Prerequisites (detected from your cluster)')
          }
          className={`${PREFIX}__mb`}
        >
          <div className={`${PREFIX}__mt`}>
            <PrereqRow
              status={crdInstalled ? 'ok' : 'warn'}
              title={t('{{operator}} (operator)', { operator: INTEL_DCAP_OPERATOR_NAME })}
              detail={
                crdInstalled
                  ? t(
                      'Installed — its TdxQuoteGenerationService custom resource definition is established.',
                    )
                  : t(
                      'Not installed. Install it from OperatorHub into the {{namespace}} namespace (installation mode OwnNamespace). The guided setup cannot continue without it.',
                      { namespace: INTEL_DCAP_OPERATOR_NAMESPACE },
                    )
              }
              action={
                crdInstalled ? undefined : (
                  <Button
                    variant="secondary"
                    component="a"
                    href={INTEL_DCAP_OPERATORHUB_SEARCH}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('Open in OperatorHub')}
                  </Button>
                )
              }
            />
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
              'Note: the operator is installed through OperatorHub (this plugin does not subscribe to operators for you). The QGS needs the Intel SGX device plugin, and your Intel TDX MachineConfig must be applied.',
            )}
          </Content>
        </Alert>

        <Form>
          <FormGroup label={t('Intel PCS API key')} isRequired fieldId="pccs-api-key">
            {secretPresent ? (
              secretValid ? (
                <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
                  <FlexItem>
                    <CheckCircleIcon className={`${PREFIX}__icon-success`} />
                  </FlexItem>
                  <FlexItem>
                    {t('Configured — the operator reads the key from')}{' '}
                    <ResourceLink
                      groupVersionKind={SecretGVK}
                      name={TQGS_PCS_API_KEY_SECRET_NAME}
                      namespace={INTEL_DCAP_OPERATOR_NAMESPACE}
                      inline
                    />
                  </FlexItem>
                </Flex>
              ) : (
                <Alert
                  variant="warning"
                  isInline
                  title={t('The existing Secret is missing the api-key data key')}
                >
                  <p>
                    {t(
                      'The Secret exists but does not carry the api-key data key the operator reads, so platform registration would run without your Intel PCS API key. This wizard never overwrites an existing Secret — update it manually, for example: oc -n {{namespace}} create secret generic {{secret}} --from-literal=api-key="<API_KEY_VALUE>" --dry-run=client -o yaml | oc apply -f -',
                      {
                        namespace: INTEL_DCAP_OPERATOR_NAMESPACE,
                        secret: TQGS_PCS_API_KEY_SECRET_NAME,
                      },
                    )}
                  </p>
                </Alert>
              )
            ) : (
              <>
                <TextInput
                  id="pccs-api-key"
                  type="password"
                  value={apiKey}
                  isDisabled={started}
                  onChange={(_e, v) => {
                    setApiKey(v);
                  }}
                  placeholder={t('Paste your Provisioning Certification Service API key')}
                />
                <FormHelperText>
                  <HelperText>
                    <HelperTextItem>
                      {t(
                        'The one manual step. In the Intel Trusted Services API portal, sign in and subscribe to the Provisioning Certification Service; the API key is shown on the Manage Subscriptions page. It is stored in a Secret in {{namespace}} and never displayed or logged.',
                        { namespace: INTEL_DCAP_OPERATOR_NAMESPACE },
                      )}
                    </HelperTextItem>
                  </HelperText>
                </FormHelperText>
              </>
            )}
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

          <FormGroup label={t('QGS node selector')} fieldId="tqgs-node-selector" isRequired>
            <TextInput
              id="tqgs-node-selector"
              value={nodeSelector}
              isDisabled={started}
              validated={selectorOk || nodeSelector === '' ? 'default' : 'error'}
              onChange={(_e, v) => {
                setNodeSelector(v);
              }}
            />
            <FormHelperText>
              <HelperText>
                <HelperTextItem
                  variant={selectorOk && selectorMatches === 0 ? 'warning' : 'default'}
                >
                  {selectorOk
                    ? t(
                        'A key=value label the QGS DaemonSet selects on. {{count}} node(s) currently match.',
                        { count: selectorMatches },
                      )
                    : t('Must be a single key=value label, for example {{example}}', {
                        example: DEFAULT_TQGS_NODE_SELECTOR,
                      })}
                </HelperTextItem>
              </HelperText>
            </FormHelperText>
          </FormGroup>

          <ExpandableSection toggleText={t('What this creates')}>
            <List>
              <ListItem>
                {t('Secret {{secret}} (Intel PCS API key) in the {{namespace}} namespace', {
                  secret: TQGS_PCS_API_KEY_SECRET_NAME,
                  namespace: INTEL_DCAP_OPERATOR_NAMESPACE,
                })}
              </ListItem>
              <ListItem>
                {t(
                  'TdxQuoteGenerationService {{cr}} — cluster-scoped, Online platform registration',
                  { cr: TQGS_CR_NAME },
                )}
              </ListItem>
              <ListItem>
                {t(
                  'Operator-managed QGS DaemonSet and platform-registration Deployment in {{namespace}} (created by the operator, not this plugin)',
                  { namespace: INTEL_DCAP_OPERATOR_NAMESPACE },
                )}
              </ListItem>
            </List>
            <Content component="small" className={`${PREFIX}__muted`}>
              {t(
                'There is no in-cluster PCCS anymore — the operator provisions PCK collateral from the Intel PCS directly.',
              )}
            </Content>
          </ExpandableSection>

          <ExpandableSection
            toggleText={t('Prefer to run it yourself? Copy the equivalent commands')}
          >
            <Content component="small" className={`${PREFIX}__mb ${PREFIX}__muted`}>
              {t(
                'Run these from a workstation with oc logged in as cluster-admin. The API key placeholder must be replaced with your real key.',
              )}
            </Content>
            <ClipboardCopy
              isCode
              isReadOnly
              variant={ClipboardCopyVariant.expansion}
              hoverTip={t('Copy')}
              clickTip={t('Copied')}
            >
              {buildTdxSetupManualScript({ nodeSelector })}
            </ClipboardCopy>
          </ExpandableSection>

          {showProgress && (
            <ProgressStepper isVertical className={`${PREFIX}__mt`}>
              <ProgressStep
                variant={applyVariant}
                id="step-apply"
                titleId="step-apply-title"
                aria-label={t('Apply attestation configuration')}
                isCurrent={started && !crExists}
                description={
                  error
                    ? t('The API rejected the configuration — see the error below.')
                    : crExists
                      ? t('PCS API key Secret and TdxQuoteGenerationService applied.')
                      : t('Creating the PCS API key Secret and the custom resource…')
                }
              >
                {t('Apply attestation configuration')}
              </ProgressStep>
              <ProgressStep
                variant={secretVariant}
                id="step-secret"
                titleId="step-secret-title"
                aria-label={t('PCS API key Secret')}
                description={
                  secretValid
                    ? t('The operator can read the Intel PCS API key.')
                    : secretPresent
                      ? t(
                          'The existing Secret is missing the api-key data key — see the warning above.',
                        )
                      : t('Created together with the custom resource.')
                }
              >
                {t('PCS API key Secret')}
              </ProgressStep>
              <ProgressStep
                variant={qgsVariant}
                id="step-qgs"
                titleId="step-qgs-title"
                aria-label={t('QGS quote service running')}
                description={
                  summary.phase === 'ready'
                    ? t('The QGS DaemonSet is ready on {{ready}}/{{desired}} node(s).', {
                        ready: summary.ready,
                        desired: summary.desired,
                      })
                    : summary.zeroNodes
                      ? t(
                          'The operator reports zero scheduled QGS pods — no node matches the node selector.',
                        )
                      : !summary.statusObserved
                        ? t(
                            'Waiting for the Intel TDX DCAP operator to report status — if this persists, check the operator pod in {{namespace}}.',
                            { namespace: INTEL_DCAP_OPERATOR_NAMESPACE },
                          )
                        : summary.staleStatus
                          ? t(
                              'Configuration changed — the operator is re-reconciling the QGS DaemonSet.',
                            )
                          : crExists
                            ? t('Rolling out: {{ready}}/{{desired}} node(s) ready.', {
                                ready: summary.ready,
                                desired: summary.desired,
                              })
                            : t('Runs on each selected node once the custom resource is created.')
                }
              >
                {t('QGS quote service running')}
              </ProgressStep>
              {(summary.onlineMode || !crExists) && (
                <ProgressStep
                  variant={registrationVariant}
                  id="step-registration"
                  titleId="step-registration-title"
                  aria-label={t('Platform registration')}
                  description={
                    summary.phase === 'ready' || summary.registrationReady === true
                      ? t('The registrar registered your platforms with the Intel PCS.')
                      : t(
                          'Registers the platform(s) with the Intel Provisioning Certification Service.',
                        )
                  }
                >
                  {t('Platform registration')}
                </ProgressStep>
              )}
            </ProgressStepper>
          )}

          {summary.phase === 'failed' && (
            <Alert
              variant="danger"
              isInline
              title={t('The TdxQuoteGenerationService is not ready')}
              className={`${PREFIX}__mt`}
            >
              <p>{summary.message ?? t('Reconciliation failed — see the resource for details.')}</p>
              <div className={`${PREFIX}__mt`}>
                <ResourceLink
                  groupVersionKind={TdxQuoteGenerationServiceGVK}
                  name={TQGS_CR_NAME}
                  inline
                />
              </div>
            </Alert>
          )}
          {summary.phase === 'installing' && summary.zeroNodes && (
            <Alert
              variant="warning"
              isInline
              title={t('No nodes match the QGS node selector')}
              className={`${PREFIX}__mt`}
            >
              <p>
                {t(
                  'The operator reconciled the custom resource but scheduled the QGS on zero nodes. Check the node selector (the QGS also requires the SGX device plugin to advertise sgx.intel.com/enclave + /provision).',
                )}
              </p>
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
        <PermissionHint allowed={canCreateTqgs} loading={tqgsRbacLoading} />
        {!secretPresent && <PermissionHint allowed={canCreateSecret} loading={secretRbacLoading} />}
      </ModalBody>
      <ModalFooter>
        {summary.phase === 'ready' ? (
          <Button variant="primary" onClick={onClose}>
            {t('Done')}
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              onClick={() => void onDeploy()}
              isLoading={busy || deploying}
              isDisabled={
                !valid ||
                !selectorOk ||
                !crdInstalled ||
                legacy.status !== 'absent' ||
                busy ||
                deploying ||
                tqgsRbacLoading ||
                !canCreateTqgs ||
                (!secretPresent && (secretRbacLoading || !canCreateSecret))
              }
            >
              {error || summary.phase === 'failed'
                ? t('Retry')
                : t('Deploy attestation infrastructure')}
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
