import {
  DocumentTitle,
  ListPageHeader,
  ResourceEventStream,
  ResourceLink,
  ResourceYAMLEditor,
  Timestamp,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Breadcrumb,
  BreadcrumbItem,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Label,
  PageSection,
  Tab,
  Tabs,
  TabTitleText,
} from '@patternfly/react-core';
import type { FC } from 'react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useCvmPeerPods, useRuntimeClasses } from '../k8s/hooks';
import {
  CC_INIT_DATA_ANNOTATION,
  ConfigMapGVK,
  NamespaceGVK,
  NodeGVK,
  PodGVK,
} from '../k8s/resources';
import type { CcClass, CcWorkload, ConfigMapKind, PodKind } from '../k8s/types';
import { classForRuntimeClass, isConfidentialClass } from '../utils/runtime';
import { podDisplayStatus, podRestartCount, statusColor } from '../utils/status';
import { EVIDENCE_LABEL, parseEvidence, type EvidenceRecord } from '../utils/evidence';
import { CcClassLabel } from './CcClassLabel';
import { WorkloadAttestationDetail } from './WorkloadAttestationDetail';
import { WorkloadMetrics } from './WorkloadMetrics';
import './coco.css';

const YAMLFallback: FC<{ obj: unknown }> = ({ obj }) => (
  <CodeBlock>
    <CodeBlockCode>{JSON.stringify(obj, null, 2)}</CodeBlockCode>
  </CodeBlock>
);

/**
 * Detail page for a single confidential workload (a Pod). Reached by clicking a
 * workload in the list. Mirrors the osc SandboxWorkloadDetail pattern: a
 * breadcrumb back to the list, a ListPageHeader, and in-page <Tabs>. The
 * Attestation tab (default) hosts the same WorkloadAttestationDetail content the
 * list used to render in an expandable row — reconstructed here from the watched
 * Pod plus its self-reported evidence ConfigMap.
 */
const ConfidentialWorkloadDetail: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const { ns, name } = useParams();

  const [runtimeClasses] = useRuntimeClasses();
  const cvmPeerPods = useCvmPeerPods();
  const [pod] = useK8sWatchResource<PodKind>({
    groupVersionKind: PodGVK,
    name,
    namespace: ns,
  });

  // Self-reported attestation evidence: ConfigMaps the in-guest sidecar publishes
  // (no exec). Watched the same way the list does, then matched to this workload.
  const [evidenceCms] = useK8sWatchResource<ConfigMapKind[]>({
    groupVersionKind: ConfigMapGVK,
    isList: true,
    selector: { matchLabels: { [EVIDENCE_LABEL]: 'true' } },
  });
  const evidenceList = useMemo(() => {
    const out: EvidenceRecord[] = [];
    for (const cm of evidenceCms ?? []) {
      const rec = parseEvidence(cm.data?.['evidence.json']);
      if (rec) out.push(rec);
    }
    return out;
  }, [evidenceCms]);

  // Reconstruct the normalized CcWorkload row from the watched Pod so we can reuse
  // WorkloadAttestationDetail unchanged. The list derives the same shape via
  // useConfidentialWorkloads; here we have a single named Pod.
  const ccClass: CcClass = useMemo(() => {
    const rcName = pod?.spec?.runtimeClassName;
    const rc = runtimeClasses.find((r) => r.metadata?.name === rcName);
    const cc = rc ? classForRuntimeClass(rc) : 'unknown';
    // kata-remote (peerpod) is confidential only on CVM peer-pods clusters — same
    // gate as the list/overview so a cloud workload detail isn't shown as "unknown".
    return isConfidentialClass(cc) || (cvmPeerPods && cc === 'peerpod') ? cc : 'unknown';
  }, [pod, runtimeClasses, cvmPeerPods]);

  const workload: CcWorkload | undefined = useMemo(() => {
    if (!pod) return undefined;
    return {
      uid: pod.metadata?.uid ?? `${ns}/${name}`,
      kind: 'Pod',
      name: pod.metadata?.name ?? name ?? '',
      namespace: pod.metadata?.namespace ?? ns ?? '',
      runtimeClass: pod.spec?.runtimeClassName ?? '',
      ccClass,
      hasInitData: Boolean(pod.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION]),
      node: pod.spec?.nodeName,
      status: podDisplayStatus(pod),
      restarts: podRestartCount(pod),
      creationTimestamp: pod.metadata?.creationTimestamp,
      obj: pod,
    };
  }, [pod, ns, name, ccClass]);

  // The sidecar names its ConfigMap by the reporting Pod, so match on the in-guest
  // identity it records (exact Pod name); the newest report wins.
  const evidence: EvidenceRecord | undefined = useMemo(() => {
    if (!workload) return undefined;
    return evidenceList
      .filter(
        (e) =>
          e.workload?.namespace === workload.namespace &&
          (e.workload?.name === workload.name ||
            (e.workload?.name ?? '').startsWith(`${workload.name}-`)),
      )
      .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))[0];
  }, [evidenceList, workload]);

  const [activeTab, setActiveTab] = useState<string | number>('attestation');

  const status = pod ? podDisplayStatus(pod) : '—';

  return (
    <>
      <DocumentTitle>{name ?? ''}</DocumentTitle>
      <PageSection className="coco-openshift-console-plugin__breadcrumb-section">
        <Breadcrumb>
          <BreadcrumbItem>
            <Link to="/confidential-containers">{t('Confidential Containers')}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <Link to="/confidential-containers/workloads">{t('Workloads')}</Link>
          </BreadcrumbItem>
          <BreadcrumbItem isActive>{name}</BreadcrumbItem>
        </Breadcrumb>
      </PageSection>
      <ListPageHeader
        title={name ?? ''}
        badge={workload ? <CcClassLabel ccClass={workload.ccClass} /> : null}
      />

      <PageSection>
        <Tabs
          activeKey={activeTab}
          onSelect={(_e, k) => {
            setActiveTab(k);
          }}
          mountOnEnter
          unmountOnExit
        >
          <Tab eventKey="attestation" title={<TabTitleText>{t('Attestation')}</TabTitleText>}>
            <div className="coco-openshift-console-plugin__detail-tabs">
              {workload ? (
                <WorkloadAttestationDetail w={workload} evidence={evidence} />
              ) : (
                <span className="coco-openshift-console-plugin__muted">{t('Loading…')}</span>
              )}
            </div>
          </Tab>

          <Tab eventKey="metrics" title={<TabTitleText>{t('Metrics')}</TabTitleText>}>
            <div className="coco-openshift-console-plugin__detail-tabs">
              {pod ? (
                <WorkloadMetrics namespace={ns ?? ''} podName={name ?? ''} />
              ) : (
                <span className="coco-openshift-console-plugin__muted">{t('Loading…')}</span>
              )}
            </div>
          </Tab>

          <Tab eventKey="details" title={<TabTitleText>{t('Details')}</TabTitleText>}>
            <div className="coco-openshift-console-plugin__detail-tabs">
              <DescriptionList isHorizontal>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Name')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <ResourceLink groupVersionKind={PodGVK} name={name} namespace={ns} linkTo />
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Namespace')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <ResourceLink groupVersionKind={NamespaceGVK} name={ns} linkTo />
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Node')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {pod?.spec?.nodeName ? (
                      <ResourceLink groupVersionKind={NodeGVK} name={pod.spec.nodeName} linkTo />
                    ) : (
                      <span className="coco-openshift-console-plugin__muted">—</span>
                    )}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Runtime class')}</DescriptionListTerm>
                  <DescriptionListDescription className="coco-openshift-console-plugin__mono">
                    {pod?.spec?.runtimeClassName ?? '—'}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Confidentiality')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {workload ? <CcClassLabel ccClass={workload.ccClass} isCompact /> : '—'}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Initdata')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {pod?.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION] ? (
                      <Label color="green" isCompact>
                        {t('Yes')}
                      </Label>
                    ) : (
                      <Label color="grey" isCompact>
                        {t('No')}
                      </Label>
                    )}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Status')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    {pod ? (
                      <Label color={statusColor(status)} isCompact>
                        {status}
                      </Label>
                    ) : (
                      '—'
                    )}
                  </DescriptionListDescription>
                </DescriptionListGroup>
                {pod && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Restarts')}</DescriptionListTerm>
                    <DescriptionListDescription>{podRestartCount(pod)}</DescriptionListDescription>
                  </DescriptionListGroup>
                )}
                {pod?.status?.podIP && (
                  <DescriptionListGroup>
                    <DescriptionListTerm>{t('Pod IP')}</DescriptionListTerm>
                    <DescriptionListDescription className="coco-openshift-console-plugin__mono">
                      {pod.status.podIP}
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                )}
                <DescriptionListGroup>
                  <DescriptionListTerm>{t('Created')}</DescriptionListTerm>
                  <DescriptionListDescription>
                    <Timestamp timestamp={pod?.metadata?.creationTimestamp} />
                  </DescriptionListDescription>
                </DescriptionListGroup>
              </DescriptionList>
            </div>
          </Tab>

          <Tab eventKey="events" title={<TabTitleText>{t('Events')}</TabTitleText>}>
            <div className="coco-openshift-console-plugin__detail-tabs">
              {pod ? (
                <ResourceEventStream resource={pod} />
              ) : (
                <span className="coco-openshift-console-plugin__muted">{t('Loading…')}</span>
              )}
            </div>
          </Tab>

          <Tab eventKey="yaml" title={<TabTitleText>{t('YAML')}</TabTitleText>}>
            <div className="coco-openshift-console-plugin__detail-tabs coco-openshift-console-plugin__yaml">
              {pod ? (
                <ResourceYAMLEditor initialResource={pod} readOnly />
              ) : (
                <YAMLFallback obj={pod} />
              )}
            </div>
          </Tab>
        </Tabs>
      </PageSection>
    </>
  );
};

export default ConfidentialWorkloadDetail;
