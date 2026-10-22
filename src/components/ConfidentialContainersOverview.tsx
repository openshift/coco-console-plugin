import { DocumentTitle, ListPageHeader, ResourceLink } from '@openshift-console/dynamic-plugin-sdk';
import {
  Button,
  Card,
  CardBody,
  CardTitle,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateFooter,
  Flex,
  FlexItem,
  Grid,
  GridItem,
  Label,
  PageSection,
  Skeleton,
} from '@patternfly/react-core';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from '@patternfly/react-icons';
import type { FC } from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  useConfidentialEnabled,
  useConfidentialWorkloads,
  useCvmPeerPods,
  useKataConfig,
  useRuntimeClasses,
  useTeeNodes,
} from '../k8s/hooks';
import { NodeGVK, RuntimeClassGVK } from '../k8s/resources';
import { ccClassLabel, classForRuntimeClass, isConfidentialRuntimeClass } from '../utils/runtime';
import { kataInstallSummary, statusCategory } from '../utils/status';
import { teeLabel } from '../utils/tee';
import BaremetalBanner from './BaremetalBanner';
import { EnableConfidentialContainers } from './EnableConfidentialContainers';
import './coco.css';

const StatTile: FC<{
  value: number | string;
  label: string;
  loading?: boolean;
  href?: string;
}> = ({ value, label, loading, href }) => {
  const card = (
    <Card
      isCompact
      className={`coco-openshift-console-plugin__stat${
        href ? ' coco-openshift-console-plugin__stat--clickable' : ''
      }`}
    >
      <CardBody>
        <div className="coco-openshift-console-plugin__stat-value">
          {loading ? <Skeleton width="3rem" height="1.5rem" /> : value}
        </div>
        <div className="coco-openshift-console-plugin__stat-label">{label}</div>
      </CardBody>
    </Card>
  );
  return href ? <Link to={href}>{card}</Link> : card;
};

const HealthBar: FC<{ healthy: number; warning: number; error: number }> = ({
  healthy,
  warning,
  error,
}) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const total = healthy + warning + error;
  if (total === 0) return null;
  const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
  return (
    <>
      <div className="coco-openshift-console-plugin__health-bar">
        {healthy > 0 && (
          <div
            className="coco-openshift-console-plugin__health-segment--healthy"
            style={{ width: pct(healthy) }}
          />
        )}
        {warning > 0 && (
          <div
            className="coco-openshift-console-plugin__health-segment--warning"
            style={{ width: pct(warning) }}
          />
        )}
        {error > 0 && (
          <div
            className="coco-openshift-console-plugin__health-segment--error"
            style={{ width: pct(error) }}
          />
        )}
      </div>
      <Flex gap={{ default: 'gapMd' }} className="coco-openshift-console-plugin__mt">
        <Label color="green" icon={<CheckCircleIcon />} isCompact>
          {t('Healthy')}: {healthy}
        </Label>
        <Label color="orange" icon={<ExclamationTriangleIcon />} isCompact>
          {t('Pending')}: {warning}
        </Label>
        <Label color="red" icon={<ExclamationCircleIcon />} isCompact>
          {t('Error')}: {error}
        </Label>
      </Flex>
    </>
  );
};

const GettingStarted: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  return (
    <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
      <FlexItem>
        {t(
          'Confidential containers run your workload inside a hardware Trusted Execution Environment (Intel TDX or AMD SEV-SNP), so data stays encrypted in use — even from the host. To get started:',
        )}
      </FlexItem>
      <FlexItem className="coco-openshift-console-plugin__muted">
        {t('1. Label TEE-capable nodes with the Node Feature Discovery operator.')}
      </FlexItem>
      <FlexItem className="coco-openshift-console-plugin__muted">
        {t(
          '2. Enable confidential containers and create a KataConfig to install the kata-cc runtime.',
        )}
      </FlexItem>
      <FlexItem className="coco-openshift-console-plugin__muted">
        {t(
          '3. Build initdata and deploy a pod with runtimeClassName: kata-cc and the attestation evidence sidecar to verify its trust status from the Workloads list.',
        )}
      </FlexItem>
      <FlexItem className="coco-openshift-console-plugin__mt">
        <Link to="/confidential-containers/setup">
          <Button variant="primary" icon={<ArrowRightIcon />} iconPosition="end">
            {t('Open the setup checklist')}
          </Button>
        </Link>
      </FlexItem>
    </Flex>
  );
};

const ConfidentialContainersOverview: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [kataConfig, kcLoaded] = useKataConfig();
  const [runtimeClasses] = useRuntimeClasses();
  const { workloads, loaded } = useConfidentialWorkloads();
  const [ccEnabled, ccEnabledLoaded] = useConfidentialEnabled();
  const { teeNodes } = useTeeNodes();
  const cvmPeerPods = useCvmPeerPods();

  const kata = kataInstallSummary(kataConfig);
  const confidentialRCs = useMemo(
    () => runtimeClasses.filter((rc) => isConfidentialRuntimeClass(rc, cvmPeerPods)),
    [runtimeClasses, cvmPeerPods],
  );
  // On-node TEE surfaces (TEE-capable nodes / Kata nodes ready) are meaningless on a
  // peer-pods-only cloud cluster, where the TEE is a cloud Confidential VM (#20). Hide
  // them there; keep them on bare-metal and mixed clusters. Matches CocoSetup's onNodeTee
  // and the COCO_ONNODE_TEE nav flag.
  const onNodeTee = teeNodes.length > 0 || kataConfig?.spec?.enablePeerPods !== true;

  const healthCounts = useMemo(() => {
    let healthy = 0,
      warning = 0,
      error = 0;
    workloads.forEach((w) => {
      const cat = statusCategory(w.status);
      if (cat === 'Healthy') healthy++;
      else if (cat === 'Pending') warning++;
      else error++;
    });
    return { healthy, warning, error };
  }, [workloads]);

  const wlLoading = !loaded;

  return (
    <>
      <DocumentTitle>{t('Confidential Containers')}</DocumentTitle>
      <ListPageHeader title={t('Confidential containers overview')} />

      <PageSection>
        <BaremetalBanner />
        {/* Feature-gate empty-state: the Confidential Containers menu is gated on
            KataConfig, so it can appear before confidential containers is turned on
            (osc-feature-gates confidential!=true). When the gate is off, surface the
            one-click enable action up front. This is purely the OSC feature gate — no
            attestation-service/Trustee detection, by design. */}
        {ccEnabledLoaded && ccEnabled === false && (
          <Card className="coco-openshift-console-plugin__mb">
            <CardBody>
              <EmptyState
                headingLevel="h4"
                icon={ExclamationTriangleIcon}
                titleText={t('Confidential containers are not enabled yet')}
              >
                <EmptyStateBody>
                  {!onNodeTee
                    ? t(
                        'The Confidential Containers menu is available because sandboxed containers (KataConfig) is installed, but the confidential feature is still off. Enabling it sets confidential: "true" on the osc-feature-gates ConfigMap. On this cluster peer pods run in the cloud, so this makes your peer-pod VMs Confidential VMs using the kata-remote runtime — nothing is installed on your worker nodes and they are not rebooted. To make peer pods confidential you also set DISABLECVM to "false" and a confidential instance type in the peer pods config map.',
                      )
                    : t(
                        'The Confidential Containers menu is available because sandboxed containers (KataConfig) is installed, but the confidential feature is still off. Enabling it sets confidential: "true" on the osc-feature-gates ConfigMap, so the OpenShift sandboxed containers operator installs the kata-cc runtime on your TEE nodes. This reboots the sandboxed-containers nodes, one at a time.',
                      )}
                </EmptyStateBody>
                <EmptyStateFooter>
                  <EmptyStateActions>
                    <EnableConfidentialContainers />
                    <Link to="/confidential-containers/setup">
                      <Button variant="link" icon={<ArrowRightIcon />} iconPosition="end">
                        {t('Open the setup checklist')}
                      </Button>
                    </Link>
                  </EmptyStateActions>
                </EmptyStateFooter>
              </EmptyState>
            </CardBody>
          </Card>
        )}
        <Grid hasGutter>
          <GridItem span={3}>
            <StatTile
              value={workloads.length}
              label={t('Confidential workloads')}
              loading={wlLoading}
              href="/confidential-containers/workloads"
            />
          </GridItem>
          {onNodeTee && (
            <GridItem span={2}>
              <StatTile
                value={teeNodes.length}
                label={t('TEE-capable nodes')}
                loading={!kcLoaded}
                href="/confidential-containers/tee-nodes"
              />
            </GridItem>
          )}
          <GridItem span={3}>
            <StatTile
              value={confidentialRCs.length}
              label={t('Confidential runtime classes')}
              href="/confidential-containers/runtime-classes"
            />
          </GridItem>
          {onNodeTee && (
            <GridItem span={2}>
              <StatTile
                value={kata.ready}
                label={t('Kata nodes ready')}
                loading={!kcLoaded}
                href="/confidential-containers/tee-nodes"
              />
            </GridItem>
          )}
          <GridItem span={6}>
            <Card>
              <CardTitle>{t('Confidential computing status')}</CardTitle>
              <CardBody>
                {!kcLoaded || !ccEnabledLoaded ? (
                  <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
                    <Skeleton width="60%" />
                    <Skeleton width="80%" />
                    <Skeleton width="50%" />
                  </Flex>
                ) : (
                  <DescriptionList isHorizontal>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Confidential containers')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {ccEnabled ? (
                          <Label color="green" icon={<CheckCircleIcon />}>
                            {t('Enabled')}
                          </Label>
                        ) : (
                          <Label color="orange" icon={<ExclamationTriangleIcon />}>
                            {t('Not enabled')}
                          </Label>
                        )}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('KataConfig')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {kata.state === 'installed' ? (
                          <Label color="green" icon={<CheckCircleIcon />}>
                            {t('Installed')}
                          </Label>
                        ) : kata.state === 'inProgress' ? (
                          <Label color="orange">
                            {t('In progress')}
                            {kata.reason ? ` (${kata.reason})` : ''}
                          </Label>
                        ) : kata.state === 'failed' ? (
                          <Label color="red" icon={<ExclamationCircleIcon />}>
                            {t('Failed')}: {kata.failed.join(', ')}
                          </Label>
                        ) : (
                          <Label color="red" icon={<ExclamationTriangleIcon />}>
                            {t('Not installed')}
                          </Label>
                        )}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Kata nodes ready')}</DescriptionListTerm>
                      <DescriptionListDescription>{kata.ready}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('kata-cc runtime')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {confidentialRCs.length > 0
                          ? confidentialRCs.map((rc) => rc.metadata?.name).join(', ')
                          : t('Not present')}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  </DescriptionList>
                )}
              </CardBody>
            </Card>
          </GridItem>

          {onNodeTee && (
            <GridItem span={6}>
              <Card>
                <CardTitle>{t('TEE-capable nodes')}</CardTitle>
                <CardBody>
                  {teeNodes.length === 0 ? (
                    <span className="coco-openshift-console-plugin__muted">
                      {t(
                        'No TEE-capable nodes detected. Install the Node Feature Discovery operator and a NodeFeatureRule to label TDX / SEV-SNP nodes.',
                      )}
                    </span>
                  ) : (
                    <Flex direction={{ default: 'column' }} gap={{ default: 'gapSm' }}>
                      {teeNodes.map((n) => (
                        <FlexItem key={n.name}>
                          <Flex
                            justifyContent={{ default: 'justifyContentSpaceBetween' }}
                            alignItems={{ default: 'alignItemsCenter' }}
                          >
                            <FlexItem>
                              <ResourceLink groupVersionKind={NodeGVK} name={n.name} />
                            </FlexItem>
                            <FlexItem>
                              {n.tee !== 'none' && (
                                <Label color="blue" isCompact>
                                  {teeLabel(n.tee)}
                                </Label>
                              )}{' '}
                              {n.gpuCcReady && (
                                <Label color="purple" isCompact>
                                  {t('GPU CC')}
                                </Label>
                              )}
                            </FlexItem>
                          </Flex>
                        </FlexItem>
                      ))}
                    </Flex>
                  )}
                </CardBody>
              </Card>
            </GridItem>
          )}

          <GridItem span={12}>
            <Card>
              <CardTitle>
                {!wlLoading && workloads.length === 0
                  ? t('Get started with confidential containers')
                  : t('Workload health')}
              </CardTitle>
              <CardBody>
                {wlLoading ? (
                  <Skeleton width="100%" height="0.5rem" />
                ) : workloads.length === 0 ? (
                  <GettingStarted />
                ) : (
                  <HealthBar {...healthCounts} />
                )}
              </CardBody>
            </Card>
          </GridItem>

          <GridItem span={6}>
            <Card>
              <CardTitle>{t('Confidential runtime classes')}</CardTitle>
              <CardBody>
                {confidentialRCs.length === 0 ? (
                  <span className="coco-openshift-console-plugin__muted">
                    {t('No confidential (kata-cc) runtime classes found.')}
                  </span>
                ) : (
                  <Flex direction={{ default: 'column' }}>
                    {confidentialRCs.map((rc) => (
                      <FlexItem key={rc.metadata?.name}>
                        <Flex
                          justifyContent={{ default: 'justifyContentSpaceBetween' }}
                          alignItems={{ default: 'alignItemsCenter' }}
                        >
                          <FlexItem>
                            <ResourceLink
                              groupVersionKind={RuntimeClassGVK}
                              name={rc.metadata?.name}
                            />
                          </FlexItem>
                          <FlexItem>
                            <Label color="blue" isCompact>
                              {ccClassLabel(classForRuntimeClass(rc))}
                            </Label>
                          </FlexItem>
                        </Flex>
                      </FlexItem>
                    ))}
                  </Flex>
                )}
              </CardBody>
            </Card>
          </GridItem>
        </Grid>
      </PageSection>
    </>
  );
};

export default ConfidentialContainersOverview;
