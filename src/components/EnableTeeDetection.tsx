import {
  k8sCreate,
  useK8sWatchResource,
  type K8sResourceCommon,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Form,
  FormGroup,
  Label,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Spinner,
  TextInput,
} from '@patternfly/react-core';
import { CheckCircleIcon } from '@patternfly/react-icons';
import type { FC } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PermissionHint } from '../utils/rbac/PermissionHint';
import { useCanCreateNodeFeatureRule } from '../utils/rbac/useCocoPermissions';
import {
  ClusterVersionGVK,
  CustomResourceDefinitionGVK,
  NamespaceModel,
  NodeFeatureDiscoveryGVK,
  NodeFeatureDiscoveryModel,
  NodeFeatureRuleGVK,
  NodeFeatureRuleModel,
  OperatorGroupModel,
  SubscriptionModel,
} from '../k8s/resources';
import {
  buildNfdNamespace,
  buildNfdOperatorGroup,
  buildNfdSubscription,
  buildNodeFeatureDiscovery,
  buildTeeNodeFeatureRule,
  nfdOperandImage,
  NFD_CRD,
  NFD_NAMESPACE,
  TEE_NODE_FEATURE_RULE_NAME,
} from '../utils/nodeFeatureRule';
import './coco.css';

type ClusterVersionKind = K8sResourceCommon & { status?: { desired?: { version?: string } } };

const PREFIX = 'coco-openshift-console-plugin';
const isAlreadyExists = (e: unknown): boolean =>
  /already exists|alreadyexists|conflict|409/i.test(e instanceof Error ? e.message : String(e));

/**
 * One-click TEE detection. The NodeFeatureDiscovery / NodeFeatureRule CRDs only exist
 * once the Node Feature Discovery operator is installed, so this:
 *   1. installs the NFD operator (Namespace + OperatorGroup + Subscription) when its
 *      CRD is absent — the bug from issue #4, where detection failed outright if the
 *      operator was missing — then
 *   2. once the operator's CRD is established, creates the NFD operand (if missing)
 *      and a consolidated NodeFeatureRule that labels Intel TDX / AMD SEV-SNP nodes.
 */
export const EnableTeeDetection: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [canCreateRule, canCreateRuleLoading] = useCanCreateNodeFeatureRule();

  // The NFD operator is installed iff its CRD is established.
  const [crd] = useK8sWatchResource<K8sResourceCommon>({
    groupVersionKind: CustomResourceDefinitionGVK,
    name: NFD_CRD,
  });
  const nfdOperatorInstalled = Boolean(crd?.metadata?.name);

  // The NodeFeatureRule / NodeFeatureDiscovery CRDs only resolve once the operator is
  // installed, so only watch them then (avoids erroring on a missing CRD).
  const [rules] = useK8sWatchResource<K8sResourceCommon[]>(
    nfdOperatorInstalled ? { groupVersionKind: NodeFeatureRuleGVK, isList: true } : null,
  ) as [K8sResourceCommon[] | undefined, boolean, unknown];
  const [nfds] = useK8sWatchResource<K8sResourceCommon[]>(
    nfdOperatorInstalled ? { groupVersionKind: NodeFeatureDiscoveryGVK, isList: true } : null,
  ) as [K8sResourceCommon[] | undefined, boolean, unknown];
  const [cv] = useK8sWatchResource<ClusterVersionKind>({
    groupVersionKind: ClusterVersionGVK,
    name: 'version',
  });

  const ruleExists = (rules ?? []).some((r) => r.metadata?.name === TEE_NODE_FEATURE_RULE_NAME);
  const nfdExists = (nfds ?? []).length > 0;

  const [open, setOpen] = useState(false);
  const [namespace, setNamespace] = useState(NFD_NAMESPACE);
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // True once the operator install has been kicked off; the effect below finishes the
  // job (creates operand + rule) as soon as the operator's CRD is established.
  const [started, setStarted] = useState(false);
  const finishingRef = useRef(false);

  const effectiveImage = image || nfdOperandImage(cv?.status?.desired?.version);
  const toCreate = [
    ...(!nfdOperatorInstalled
      ? [
          buildNfdNamespace(namespace),
          buildNfdOperatorGroup(namespace),
          buildNfdSubscription(namespace),
        ]
      : []),
    ...(!nfdExists ? [buildNodeFeatureDiscovery(namespace, effectiveImage)] : []),
    buildTeeNodeFeatureRule(namespace),
  ];

  // Create the NFD operand (if missing) + the TEE NodeFeatureRule. Used both directly
  // (operator already installed) and from the effect (after we install the operator).
  const createDetection = async () => {
    if (!nfdExists) {
      await k8sCreate({
        model: NodeFeatureDiscoveryModel,
        data: buildNodeFeatureDiscovery(namespace, effectiveImage),
      });
    }
    if (!ruleExists) {
      await k8sCreate({ model: NodeFeatureRuleModel, data: buildTeeNodeFeatureRule(namespace) });
    }
    setOpen(false);
    setStarted(false);
  };

  // After the operator install is kicked off, finish the job the moment its CRD is
  // established. The ref guard is released on failure so a state change (or a Retry
  // click) re-attempts.
  useEffect(() => {
    if (!started || !nfdOperatorInstalled || ruleExists || finishingRef.current) return;
    finishingRef.current = true;
    void (async () => {
      try {
        await createDetection();
      } catch (e) {
        if (!isAlreadyExists(e)) {
          finishingRef.current = false;
          setError(e instanceof Error ? e.message : String(e));
        } else {
          setOpen(false);
          setStarted(false);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, nfdOperatorInstalled, ruleExists, nfdExists]);

  const onEnable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (!nfdOperatorInstalled) {
        // Install the NFD operator; the effect creates operand + rule once it is ready.
        for (const data of [
          { model: NamespaceModel, data: buildNfdNamespace(namespace) },
          { model: OperatorGroupModel, data: buildNfdOperatorGroup(namespace) },
          { model: SubscriptionModel, data: buildNfdSubscription(namespace) },
        ]) {
          try {
            await k8sCreate(data);
          } catch (e) {
            if (!isAlreadyExists(e)) throw e;
          }
        }
        finishingRef.current = false;
        setStarted(true);
      } else {
        await createDetection();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (ruleExists) {
    return (
      <Label color="green" icon={<CheckCircleIcon />}>
        {t('TEE detection enabled')}
      </Label>
    );
  }

  // Installing = operator install kicked off but its CRD isn't established yet.
  const installingOperator = started && !nfdOperatorInstalled;
  // Finishing = operator ready, creating operand + rule.
  const finishing = started && nfdOperatorInstalled && !ruleExists;
  const inFlight = busy || installingOperator || finishing;

  return (
    <>
      <PermissionHint allowed={canCreateRule} loading={canCreateRuleLoading} />
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
        isDisabled={canCreateRuleLoading || !canCreateRule}
      >
        {t('Enable TEE detection')}
      </Button>
      {open && (
        <Modal
          isOpen
          variant="medium"
          onClose={() => {
            setOpen(false);
          }}
        >
          <ModalHeader title={t('Enable TEE detection')} />
          <ModalBody>
            <p className="coco-openshift-console-plugin__mb">
              {t(
                'This labels nodes that have a Trusted Execution Environment (Intel TDX, AMD SEV-SNP) so confidential workloads can be scheduled on them. The Node Feature Discovery operator does the scanning.',
              )}
            </p>
            {!nfdOperatorInstalled ? (
              <Alert
                variant="info"
                isInline
                title={t('The Node Feature Discovery operator will be installed')}
                className="coco-openshift-console-plugin__mb"
              >
                {t(
                  'NFD is not installed on this cluster. Enabling will install the Node Feature Discovery operator (Namespace + OperatorGroup + Subscription) into “{{namespace}}”, then create the NFD instance and the TEE NodeFeatureRule once the operator is ready.',
                  { namespace },
                )}
              </Alert>
            ) : (
              !nfdExists && (
                <Alert
                  variant="info"
                  isInline
                  title={t('No NodeFeatureDiscovery instance found')}
                  className="coco-openshift-console-plugin__mb"
                >
                  {t('One will be created so NFD actually scans your nodes.')}
                </Alert>
              )
            )}
            <Form>
              <FormGroup label={t('NFD namespace')} fieldId="nfd-ns">
                <TextInput
                  id="nfd-ns"
                  value={namespace}
                  onChange={(_e, v) => {
                    setNamespace(v);
                  }}
                />
              </FormGroup>
              {!nfdExists && (
                <FormGroup label={t('NFD operand image')} fieldId="nfd-image">
                  <TextInput
                    id="nfd-image"
                    value={effectiveImage}
                    onChange={(_e, v) => {
                      setImage(v);
                    }}
                  />
                </FormGroup>
              )}
            </Form>
            <ExpandableSection
              toggleText={t('Resources to create ({{count}})', { count: toCreate.length })}
              className="coco-openshift-console-plugin__mt"
            >
              <CodeBlock>
                <CodeBlockCode>{JSON.stringify(toCreate, null, 2)}</CodeBlockCode>
              </CodeBlock>
            </ExpandableSection>
            {(installingOperator || finishing) && !error && (
              <div className={`${PREFIX}__mt ${PREFIX}__muted`}>
                <Spinner size="sm" />{' '}
                {installingOperator
                  ? t('Installing the Node Feature Discovery operator (this can take a minute)…')
                  : t('Operator ready — creating the NFD instance and TEE rule…')}
              </div>
            )}
            {error && (
              <Alert
                variant="danger"
                isInline
                title={t('Could not enable TEE detection')}
                className="coco-openshift-console-plugin__mt"
              >
                <p>{error}</p>
                <p className="coco-openshift-console-plugin__mt">
                  {t('You can also install the operator manually from OperatorHub.')}{' '}
                  <a href="/operatorhub/all-namespaces?keyword=Node+Feature+Discovery">
                    {t('Install the NFD operator')}
                  </a>
                </p>
              </Alert>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="primary"
              onClick={() => void onEnable()}
              isLoading={inFlight}
              isDisabled={inFlight || !namespace.trim() || canCreateRuleLoading || !canCreateRule}
            >
              {error
                ? t('Retry')
                : nfdOperatorInstalled
                  ? t('Enable')
                  : t('Install NFD operator and enable')}
            </Button>
            <Button
              variant="link"
              onClick={() => {
                setOpen(false);
              }}
            >
              {t('Cancel')}
            </Button>
          </ModalFooter>
        </Modal>
      )}
    </>
  );
};

export default EnableTeeDetection;
