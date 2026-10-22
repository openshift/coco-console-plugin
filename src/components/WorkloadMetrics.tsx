import { PrometheusEndpoint, usePrometheusPoll } from '@openshift-console/dynamic-plugin-sdk';
import { Alert, Card, CardBody, CardTitle, Flex, FlexItem, Skeleton } from '@patternfly/react-core';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildCpuQuery,
  buildMemoryQuery,
  buildNetworkReceiveQuery,
  buildNetworkTransmitQuery,
  buildFilesystemReadQuery,
  buildFilesystemWriteQuery,
} from '../utils/workloadMetricsQueries';
import './coco.css';

interface Props {
  namespace: string;
  podName: string;
}

const MetricChart: FC<{ title: string; query: string; unit?: string }> = ({
  title,
  query,
  unit,
}) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [result, loaded, error] = usePrometheusPoll({
    query,
    endpoint: PrometheusEndpoint.QUERY,
  });

  const value = (result as { data?: { result?: { value?: [number, string] }[] } })?.data
    ?.result?.[0]?.value?.[1];

  // Determine if the value is a valid finite number
  const numValue = value !== undefined ? parseFloat(value) : undefined;
  const isValidNumber = numValue !== undefined && Number.isFinite(numValue);

  return (
    <Card isCompact>
      <CardTitle>{title}</CardTitle>
      <CardBody>
        {error ? (
          <Alert
            variant="danger"
            isInline
            title={t('Error loading metric')}
            className="coco-openshift-console-plugin__mb"
          />
        ) : !loaded ? (
          <Skeleton width="5rem" height="2rem" />
        ) : isValidNumber ? (
          <span className="coco-openshift-console-plugin__stat-value">
            {numValue.toFixed(2)}
            {unit ? ` ${unit}` : ''}
          </span>
        ) : (
          <span className="coco-openshift-console-plugin__muted">{t('No data')}</span>
        )}
      </CardBody>
    </Card>
  );
};

export const WorkloadMetrics: FC<Props> = ({ namespace, podName }) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');

  const cpuQuery = buildCpuQuery(namespace, podName);
  const memQuery = buildMemoryQuery(namespace, podName);
  const netRxQuery = buildNetworkReceiveQuery(namespace, podName);
  const netTxQuery = buildNetworkTransmitQuery(namespace, podName);
  const fsReadQuery = buildFilesystemReadQuery(namespace, podName);
  const fsWriteQuery = buildFilesystemWriteQuery(namespace, podName);

  return (
    <div>
      <Alert
        variant="info"
        isInline
        title={t('Metrics for confidential workloads')}
        className="coco-openshift-console-plugin__mb"
      >
        {t(
          'Some metrics may be unavailable for kata-cc workloads because cadvisor cannot see inside the confidential guest VM. Network and filesystem metrics from the hypervisor layer may still report.',
        )}
      </Alert>
      <Flex gap={{ default: 'gapMd' }} flexWrap={{ default: 'wrap' }}>
        <FlexItem grow={{ default: 'grow' }}>
          <MetricChart title={t('CPU usage (cores)')} query={cpuQuery} unit={t('cores')} />
        </FlexItem>
        <FlexItem grow={{ default: 'grow' }}>
          <MetricChart title={t('Memory working set')} query={memQuery} unit="bytes" />
        </FlexItem>
        <FlexItem grow={{ default: 'grow' }}>
          <MetricChart title={t('Network receive')} query={netRxQuery} unit="B/s" />
        </FlexItem>
        <FlexItem grow={{ default: 'grow' }}>
          <MetricChart title={t('Network transmit')} query={netTxQuery} unit="B/s" />
        </FlexItem>
        <FlexItem grow={{ default: 'grow' }}>
          <MetricChart title={t('Filesystem reads')} query={fsReadQuery} unit="B/s" />
        </FlexItem>
        <FlexItem grow={{ default: 'grow' }}>
          <MetricChart title={t('Filesystem writes')} query={fsWriteQuery} unit="B/s" />
        </FlexItem>
      </Flex>
    </div>
  );
};

export default WorkloadMetrics;
