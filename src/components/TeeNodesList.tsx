import {
  DocumentTitle,
  ListPageHeader,
  ResourceLink,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Card,
  CardBody,
  CardTitle,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Label,
  List,
  ListItem,
  PageSection,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
} from '@patternfly/react-core';
import { CheckCircleIcon, ExclamationTriangleIcon, InfoCircleIcon } from '@patternfly/react-icons';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import type { FC } from 'react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useKataConfig, useNodes } from '../k8s/hooks';
import { MachineConfigPoolGVK, NodeGVK } from '../k8s/resources';
import type { MachineConfigPoolKind } from '../k8s/types';
import { computeNodeReadiness, type NodeReadiness } from '../utils/nodeReadiness';
import { teeLabel } from '../utils/tee';
import { EnableTdxHost } from './EnableTdxHost';
import { EnableTeeDetection } from './EnableTeeDetection';
import { KataNodesPanel } from './KataNodesPanel';
import './coco.css';

type FilterMode = 'all' | 'tee';

const TeeNodesList: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [nodes, nodesLoaded] = useNodes();
  const [kataConfig] = useKataConfig();
  const [pools] = useK8sWatchResource<MachineConfigPoolKind[]>({
    groupVersionKind: MachineConfigPoolGVK,
    isList: true,
  });
  const [filter, setFilter] = useState<FilterMode>('all');

  const readiness: NodeReadiness[] = useMemo(
    () => nodes.map((n) => computeNodeReadiness(n, kataConfig, pools ?? [])),
    [nodes, kataConfig, pools],
  );

  const displayed = useMemo(() => {
    const workers = readiness.filter((r) => r.isWorker);
    if (filter === 'tee') return workers.filter((r) => r.teeDetected || r.gpuCcReady);
    return workers;
  }, [readiness, filter]);

  return (
    <>
      <DocumentTitle>{t('TEE-capable nodes')}</DocumentTitle>
      <ListPageHeader title={t('TEE-capable nodes')}>
        <Flex gap={{ default: 'gapSm' }}>
          <FlexItem>
            <EnableTeeDetection />
          </FlexItem>
          <FlexItem>
            <EnableTdxHost />
          </FlexItem>
        </Flex>
      </ListPageHeader>
      <PageSection>
        <Flex
          gap={{ default: 'gapMd' }}
          alignItems={{ default: 'alignItemsCenter' }}
          className="coco-openshift-console-plugin__mb"
        >
          <FlexItem>
            <ToggleGroup aria-label={t('Node filter')}>
              <ToggleGroupItem
                text={t('All workers')}
                isSelected={filter === 'all'}
                onChange={() => {
                  setFilter('all');
                }}
              />
              <ToggleGroupItem
                text={t('TEE-capable only')}
                isSelected={filter === 'tee'}
                onChange={() => {
                  setFilter('tee');
                }}
              />
            </ToggleGroup>
          </FlexItem>
        </Flex>

        {!nodesLoaded ? (
          <Skeleton width="100%" height="8rem" />
        ) : displayed.length === 0 ? (
          <EmptyState headingLevel="h4" titleText={t('No worker nodes found')}>
            <EmptyStateBody>
              {filter === 'tee'
                ? t(
                    'No nodes are labeled with a Trusted Execution Environment yet. Use Enable TEE detection to set up Node Feature Discovery and label Intel TDX or AMD SEV-SNP nodes.',
                  )
                : t('No worker nodes found')}
            </EmptyStateBody>
            <Flex
              gap={{ default: 'gapSm' }}
              justifyContent={{ default: 'justifyContentCenter' }}
              className="coco-openshift-console-plugin__mt"
            >
              <FlexItem>
                <EnableTeeDetection />
              </FlexItem>
              <FlexItem>
                <EnableTdxHost />
              </FlexItem>
            </Flex>
          </EmptyState>
        ) : (
          <Table aria-label={t('TEE-capable nodes')} variant="compact">
            <Thead>
              <Tr>
                <Th>{t('Node')}</Th>
                <Th>{t('TEE')}</Th>
                <Th>{t('GPU CC')}</Th>
                <Th>{t('Kata')}</Th>
                <Th>{t('MCP')}</Th>
                <Th>{t('Ready')}</Th>
                <Th>{t('Eligible')}</Th>
                <Th>{t('Reasons')}</Th>
              </Tr>
            </Thead>
            <Tbody>
              {displayed.map((r) => (
                <Tr key={r.name}>
                  <Td dataLabel={t('Node')}>
                    <ResourceLink groupVersionKind={NodeGVK} name={r.name} />
                  </Td>
                  <Td dataLabel={t('TEE')}>
                    {r.teeType !== 'none' ? (
                      <Label color="blue" isCompact>
                        {teeLabel(r.teeType)}
                      </Label>
                    ) : (
                      <span className="coco-openshift-console-plugin__muted">—</span>
                    )}
                  </Td>
                  <Td dataLabel={t('GPU CC')}>
                    {r.gpuCcReady ? (
                      <Label color="purple" isCompact>
                        {t('Ready')}
                      </Label>
                    ) : (
                      <span className="coco-openshift-console-plugin__muted">—</span>
                    )}
                  </Td>
                  <Td dataLabel={t('Kata')}>
                    {r.kataInstalled ? (
                      <Label color="green" icon={<CheckCircleIcon />} isCompact>
                        {t('Installed')}
                      </Label>
                    ) : r.kataInstalling ? (
                      <Label color="blue" icon={<InfoCircleIcon />} isCompact>
                        {t('Installing')}
                      </Label>
                    ) : r.kataFailed ? (
                      <Label color="red" icon={<ExclamationTriangleIcon />} isCompact>
                        {t('Failed')}
                      </Label>
                    ) : (
                      <span className="coco-openshift-console-plugin__muted">
                        {t('Not installed')}
                      </span>
                    )}
                  </Td>
                  <Td dataLabel={t('MCP')}>
                    {r.mcpUpdating ? (
                      <Label color="blue" isCompact>
                        {t('Updating')}
                      </Label>
                    ) : r.mcpUpdated ? (
                      <Label color="green" isCompact>
                        {t('Updated')}
                      </Label>
                    ) : (
                      <Label color="orange" isCompact>
                        {t('Not updated')}
                      </Label>
                    )}
                  </Td>
                  <Td dataLabel={t('Ready')}>
                    {r.nodeReady ? (
                      <Label color="green" icon={<CheckCircleIcon />} isCompact>
                        {t('Ready')}
                      </Label>
                    ) : (
                      <Label color="orange" icon={<ExclamationTriangleIcon />} isCompact>
                        {t('Not ready')}
                      </Label>
                    )}
                  </Td>
                  <Td dataLabel={t('Eligible')}>
                    {r.eligible ? (
                      <Label color="green" icon={<CheckCircleIcon />} isCompact>
                        {t('Eligible')}
                      </Label>
                    ) : (
                      <Label color="orange" icon={<ExclamationTriangleIcon />} isCompact>
                        {t('Not eligible')}
                      </Label>
                    )}
                  </Td>
                  <Td dataLabel={t('Reasons')}>
                    {r.reasons.length > 0 ? (
                      <List isPlain>
                        {r.reasons.map((reason) => (
                          <ListItem key={reason}>
                            <span className="coco-openshift-console-plugin__muted">{reason}</span>
                          </ListItem>
                        ))}
                      </List>
                    ) : (
                      <span className="coco-openshift-console-plugin__muted">—</span>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}

        <KataNodesPanel />

        <Card className="coco-openshift-console-plugin__mt">
          <CardTitle>{t('About TEE detection')}</CardTitle>
          <CardBody className="coco-openshift-console-plugin__muted">
            {t(
              'Nodes are labeled by the Node Feature Discovery operator via a NodeFeatureRule: intel.feature.node.kubernetes.io/tdx and amd.feature.node.kubernetes.io/snp mark TEE hardware; nvidia.com/cc.mode.state and nvidia.com/cc.ready.state mark confidential-computing GPUs.',
            )}
          </CardBody>
        </Card>
      </PageSection>
    </>
  );
};

export default TeeNodesList;
