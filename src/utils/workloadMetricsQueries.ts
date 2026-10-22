/**
 * Pure utility functions to build PromQL queries for workload metrics.
 * These queries are designed to display workload totals via sum() aggregation
 * across containers, with a 5-minute rate window.
 */

const DURATION = '[5m]';

/**
 * CPU usage query: aggregates CPU seconds across all containers in the pod.
 * Returns the rate of CPU seconds used per second (cores).
 */
export const buildCpuQuery = (namespace: string, podName: string): string =>
  `sum(rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod="${podName}",container!="POD",container!=""}${DURATION}))`;

/**
 * Memory working set query: aggregates memory working set bytes across containers.
 * Returns the sum in bytes.
 */
export const buildMemoryQuery = (namespace: string, podName: string): string =>
  `sum(container_memory_working_set_bytes{namespace="${namespace}",pod="${podName}",container!="POD",container!=""})`;

/**
 * Network receive query: aggregates network bytes received from the pod.
 * Returns the rate in bytes per second.
 */
export const buildNetworkReceiveQuery = (namespace: string, podName: string): string =>
  `sum(rate(container_network_receive_bytes_total{namespace="${namespace}",pod="${podName}"}${DURATION}))`;

/**
 * Network transmit query: aggregates network bytes transmitted from the pod.
 * Returns the rate in bytes per second.
 */
export const buildNetworkTransmitQuery = (namespace: string, podName: string): string =>
  `sum(rate(container_network_transmit_bytes_total{namespace="${namespace}",pod="${podName}"}${DURATION}))`;

/**
 * Filesystem reads query: aggregates filesystem bytes read across containers.
 * Returns the rate in bytes per second.
 */
export const buildFilesystemReadQuery = (namespace: string, podName: string): string =>
  `sum(rate(container_fs_reads_bytes_total{namespace="${namespace}",pod="${podName}",container!="POD",container!=""}${DURATION}))`;

/**
 * Filesystem writes query: aggregates filesystem bytes written across containers.
 * Returns the rate in bytes per second.
 */
export const buildFilesystemWriteQuery = (namespace: string, podName: string): string =>
  `sum(rate(container_fs_writes_bytes_total{namespace="${namespace}",pod="${podName}",container!="POD",container!=""}${DURATION}))`;
