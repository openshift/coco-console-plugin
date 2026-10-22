import { renderToStaticMarkup } from 'react-dom/server';
import { usePrometheusPoll } from '@openshift-console/dynamic-plugin-sdk';
import { WorkloadMetrics } from './WorkloadMetrics';
import {
  buildCpuQuery,
  buildMemoryQuery,
  buildNetworkReceiveQuery,
  buildNetworkTransmitQuery,
  buildFilesystemReadQuery,
  buildFilesystemWriteQuery,
} from '../utils/workloadMetricsQueries';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  PrometheusEndpoint: { QUERY: 'query' },
  usePrometheusPoll: jest.fn(),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (value: string) => value,
  }),
}));

jest.mock('@patternfly/react-core', () => {
  const React = jest.requireActual('react');

  const wrapper = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('div', null, children);

  return {
    Alert: ({ title }: { title: string }) => React.createElement('div', null, title),
    Card: wrapper,
    CardBody: wrapper,
    CardTitle: wrapper,
    Flex: wrapper,
    FlexItem: wrapper,
    Skeleton: () => React.createElement('div', { 'data-testid': 'metric-loading' }),
  };
});

const poll = usePrometheusPoll as jest.Mock;

const renderMetrics = () =>
  renderToStaticMarkup(<WorkloadMetrics namespace="team-a" podName="cc-pod" />);

beforeEach(() => poll.mockReset());

test('passes all production queries to Prometheus', () => {
  poll.mockReturnValue([undefined, false, undefined]);

  renderMetrics();

  expect(poll.mock.calls.map(([opts]) => opts.query)).toEqual([
    buildCpuQuery('team-a', 'cc-pod'),
    buildMemoryQuery('team-a', 'cc-pod'),
    buildNetworkReceiveQuery('team-a', 'cc-pod'),
    buildNetworkTransmitQuery('team-a', 'cc-pod'),
    buildFilesystemReadQuery('team-a', 'cc-pod'),
    buildFilesystemWriteQuery('team-a', 'cc-pod'),
  ]);
});

test('shows loading rather than No data', () => {
  poll.mockReturnValue([undefined, false, undefined]);
  const html = renderMetrics();

  expect(html).toContain('metric-loading');
  expect(html).not.toContain('No data');
});

test('renders finite metric values', () => {
  poll.mockReturnValue([{ data: { result: [{ value: [1, '2.375'] }] } }, true, undefined]);

  expect(renderMetrics()).toContain('2.38');
});

test('shows No data for empty metrics', () => {
  poll.mockReturnValue([{ data: { result: [] } }, true, undefined]);

  expect(renderMetrics()).toContain('No data');
});

test('rejects NaN and Infinity', () => {
  for (const value of ['NaN', 'Infinity']) {
    poll.mockReturnValue([{ data: { result: [{ value: [1, value] }] } }, true, undefined]);

    expect(renderMetrics()).toContain('No data');
  }
});

test('renders error instead of loading', () => {
  poll.mockReturnValue([undefined, false, new Error('Prometheus unavailable')]);

  const html = renderMetrics();

  expect(html).toContain('Error loading metric');
  expect(html).not.toContain('metric-loading');
});
