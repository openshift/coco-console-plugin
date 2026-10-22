import type { FC } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Card,
  CardBody,
  CardTitle,
  Content,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Flex,
  FlexItem,
  Label,
} from '@patternfly/react-core';
import { CC_INIT_DATA_ANNOTATION, KBS_SERVICE_NAME } from '../k8s/resources';
import type { CcWorkload, DeploymentKind, PodKind } from '../k8s/types';
import { classifyKbsUrl, decodeInitdataKbsUrl } from '../utils/topology';
import { relativeTime, type EvidenceRecord } from '../utils/evidence';
import './coco.css';

const PREFIX = 'coco-openshift-console-plugin';

/** Read the cc_init_data annotation off a Pod or a Deployment's pod template. */
const initdataAnnotation = (w: CcWorkload): string | undefined =>
  w.kind === 'Pod'
    ? (w.obj as PodKind).metadata?.annotations?.[CC_INIT_DATA_ANNOTATION]
    : (w.obj as DeploymentKind).spec?.template?.metadata?.annotations?.[CC_INIT_DATA_ANNOTATION];

interface Decoded {
  done: boolean;
  url?: string;
  host?: string;
  target?: 'local' | 'remote';
}

const FLOW = [
  {
    n: 1,
    title: 'TEE evidence',
    desc: 'The CPU signs a measurement of this guest (firmware, kernel, initdata).',
  },
  {
    n: 2,
    title: 'Sent to Trustee / KBS',
    desc: 'The in-guest Confidential Data Hub forwards the evidence to the Key Broker Service.',
  },
  {
    n: 3,
    title: 'Verified vs. reference values',
    desc: 'Trustee checks the measurement and issues an attestation token (EAR).',
  },
  {
    n: 4,
    title: 'Secrets released',
    desc: 'Only a trusted guest gets its sealed secrets back.',
  },
];

/**
 * The attestation detail shown when a confidential workload row is expanded.
 * Reconstructs how the workload is attested from two browser-readable sources —
 * its initdata (decoded in-page for the KBS endpoint + topology) and the evidence
 * ConfigMap published by the in-guest self-reporting sidecar (the verdict / secret
 * release). No exec into the sealed guest.
 */
export const WorkloadAttestationDetail: FC<{ w: CcWorkload; evidence?: EvidenceRecord }> = ({
  w,
  evidence,
}) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [decoded, setDecoded] = useState<Decoded>({ done: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const ann = initdataAnnotation(w);
      const url = ann ? await decodeInitdataKbsUrl(ann) : null;
      if (cancelled) return;
      if (url) {
        const info = classifyKbsUrl(url, KBS_SERVICE_NAME);
        setDecoded({ done: true, url, host: info.host, target: info.target });
      } else {
        setDecoded({ done: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [w]);

  const passed = evidence?.verdict === 'passed';
  const endpoint = decoded.url ?? evidence?.trustee?.kbsEndpoint;

  const topology = !decoded.done
    ? { color: 'grey' as const, text: t('decoding initdata…') }
    : decoded.target === 'local'
      ? { color: 'blue' as const, text: t('in-cluster Trustee') }
      : decoded.target === 'remote'
        ? { color: 'orange' as const, text: t('remote · hub-and-spoke Trustee') }
        : { color: 'grey' as const, text: t('unknown — no initdata') };

  const reach =
    evidence?.verdict === 'passed'
      ? { color: 'green' as const, text: t('reachable · evidence accepted') }
      : evidence?.verdict === 'failed'
        ? { color: 'red' as const, text: t('evidence rejected') }
        : evidence?.verdict === 'inconclusive'
          ? { color: 'orange' as const, text: t('unreachable') }
          : { color: 'grey' as const, text: t('no evidence sidecar') };

  // For an inconclusive self-report only the initdata-derived service is
  // meaningful (the sidecar could not get a conclusive probe) — hide the flow
  // and evidence cards.
  const onlyService = evidence?.verdict === 'inconclusive';

  return (
    <Flex
      direction={{ default: 'column' }}
      gap={{ default: 'gapMd' }}
      className={`${PREFIX}__att-detail`}
    >
      {/* Attestation service — derived from the workload's initdata */}
      <FlexItem>
        <Card isCompact>
          <CardTitle>{t('Attestation service')}</CardTitle>
          <CardBody>
            <DescriptionList isHorizontal isCompact>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Type')}</DescriptionListTerm>
                <DescriptionListDescription>
                  {t('Red Hat build of Trustee — KBS + Attestation Service')}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Endpoint')}</DescriptionListTerm>
                <DescriptionListDescription className={`${PREFIX}__mono`}>
                  {endpoint ?? (decoded.done ? t('no initdata') : t('decoding…'))}
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Topology')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Label color={topology.color} isCompact>
                    {topology.text}
                  </Label>
                </DescriptionListDescription>
              </DescriptionListGroup>
              <DescriptionListGroup>
                <DescriptionListTerm>{t('Reachability')}</DescriptionListTerm>
                <DescriptionListDescription>
                  <Label color={reach.color} isCompact>
                    {reach.text}
                  </Label>
                </DescriptionListDescription>
              </DescriptionListGroup>
            </DescriptionList>
          </CardBody>
        </Card>
      </FlexItem>

      {!onlyService && (
        <>
          {/* How this workload is attested — the RCAR flow, lit when proven */}
          <FlexItem>
            <Card isCompact>
              <CardTitle>{t('How this workload is attested')}</CardTitle>
              <CardBody>
                <div className={`${PREFIX}__flow`}>
                  {FLOW.map((s) => (
                    <div
                      key={s.n}
                      className={`${PREFIX}__flow-step${passed ? ` ${PREFIX}__flow-step--on` : ''}`}
                    >
                      <span className={`${PREFIX}__flow-n`}>{s.n}</span>
                      <div>
                        <strong>{t(s.title)}</strong>
                        <div className={`${PREFIX}__muted`}>{t(s.desc)}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <Content component="small" className={`${PREFIX}__muted ${PREFIX}__mt`}>
                  {passed
                    ? t(
                        'This guest presented valid TEE evidence, Trustee verified it against the reference values, and the KBS released the sealed secret. That release is cryptographic proof of attestation.',
                      )
                    : t(
                        'Attestation happens inside the sealed guest. Deploy the workload with the attestation evidence sidecar to publish a verifiable proof here — a successful secret release confirms the flow above completed.',
                      )}
                </Content>
              </CardBody>
            </Card>
          </FlexItem>

          {/* Attestation evidence — the sidecar's self-report (no exec) */}
          <FlexItem>
            <Card isCompact>
              <CardTitle>{t('Attestation evidence')}</CardTitle>
              <CardBody>
                {evidence ? (
                  <DescriptionList isHorizontal isCompact>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Verdict')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        <Label color={reach.color} isCompact>
                          {evidence.verdict}
                        </Label>{' '}
                        {evidence.source === 'sidecar' && (
                          <Label color="blue" isCompact>
                            {t('live · self-reported')}
                          </Label>
                        )}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Secret released')}</DescriptionListTerm>
                      <DescriptionListDescription className={`${PREFIX}__mono`}>
                        {evidence.probe?.cdhPath ?? '—'}
                        {evidence.probe?.httpStatus ? ` · HTTP ${evidence.probe.httpStatus}` : ''}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                      <DescriptionListTerm>{t('Reported')}</DescriptionListTerm>
                      <DescriptionListDescription>
                        {relativeTime(evidence.timestamp)}
                      </DescriptionListDescription>
                    </DescriptionListGroup>
                  </DescriptionList>
                ) : (
                  <Alert
                    variant="info"
                    isInline
                    isPlain
                    title={t('No attestation evidence sidecar on this workload')}
                  >
                    <Content component="p">
                      {t(
                        'A confidential guest is sealed — the console cannot exec into it. Add the self-reporting evidence sidecar so the workload publishes a verifiable attestation record (the released secret) the console can read.',
                      )}
                    </Content>
                    <Content component="p">
                      {t(
                        'Add the attestation evidence sidecar when creating the workload to see live trust status here.',
                      )}
                    </Content>
                    <Link to="/confidential-containers/workloads/~new">
                      {t('Create a workload with the evidence sidecar')}
                    </Link>
                  </Alert>
                )}
              </CardBody>
            </Card>
          </FlexItem>
        </>
      )}
    </Flex>
  );
};

export default WorkloadAttestationDetail;
