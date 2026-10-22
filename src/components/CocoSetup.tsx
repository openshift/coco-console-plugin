import {
  DocumentTitle,
  ListPageHeader,
  ResourceLink,
  useK8sWatchResource,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  Button,
  Card,
  CardBody,
  CardTitle,
  Content,
  Flex,
  FlexItem,
  Label,
  PageSection,
} from '@patternfly/react-core';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  ExternalLinkAltIcon,
  InfoCircleIcon,
  PlusCircleIcon,
} from '@patternfly/react-icons';
import type { FC, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  useConfidentialEnabled,
  useCvmPeerPods,
  useKataConfig,
  useRuntimeClasses,
  useTeeNodes,
} from '../k8s/hooks';
import { DaemonSetGVK, DeploymentGVK, INTEL_DCAP_NAMESPACE, KataConfigGVK } from '../k8s/resources';
import type { DaemonSetKind, DeploymentKind } from '../k8s/types';
import { isConfidentialRuntimeClass } from '../utils/runtime';
import { kataInstallSummary } from '../utils/status';
import BaremetalBanner from './BaremetalBanner';
import { EnableConfidentialContainers } from './EnableConfidentialContainers';
import { EnableIommu } from './EnableIommu';
import { EnableKataConfig } from './EnableKataConfig';
import DeployTdxAttestationModal from './DeployTdxAttestationModal';
import './coco.css';

type Status = 'done' | 'todo' | 'warn' | 'info';

interface Step {
  title: string;
  status: Status;
  detail: ReactNode;
  action?: { label: string; href: string };
  /** Inline action element rendered in the step's action area (e.g. a one-click enable button). */
  node?: ReactNode;
}

const StatusIcon: FC<{ status: Status }> = ({ status }) => {
  if (status === 'done')
    return <CheckCircleIcon className="coco-openshift-console-plugin__icon-success" />;
  if (status === 'warn')
    return <ExclamationTriangleIcon className="coco-openshift-console-plugin__icon-warning" />;
  if (status === 'info')
    return <InfoCircleIcon className="coco-openshift-console-plugin__icon-info" />;
  return <PlusCircleIcon className="coco-openshift-console-plugin__muted" />;
};

const CocoSetup: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [kataConfig] = useKataConfig();
  const [ccEnabled] = useConfidentialEnabled();
  const { teeNodes } = useTeeNodes();
  const [runtimeClasses] = useRuntimeClasses();
  const cvmPeerPods = useCvmPeerPods();

  const kata = kataInstallSummary(kataConfig);
  const confidentialRCs = useMemo(
    () => runtimeClasses.filter((rc) => isConfidentialRuntimeClass(rc, cvmPeerPods)),
    [runtimeClasses, cvmPeerPods],
  );
  const ccRuntimeReady = confidentialRCs.length > 0;
  // Deployment topology. A cluster may be bare-metal (on-node kata-cc TEE nodes),
  // cloud peer-pods (kata-remote in a cloud Confidential VM), or a mix of both —
  // e.g. a cloud cluster with attached bare-metal TEE nodes. Peer-pods is signalled
  // by KataConfig.spec.enablePeerPods. On-node TEE steps (node labeling, host
  // quote-generation infrastructure) are only relevant when the cluster actually has
  // — or could have — bare-metal TEE nodes, so we key them on the presence of TEE
  // nodes rather than on "is this cloud", which keeps them visible on mixed clusters.
  const peerPodsMode = kataConfig?.spec?.enablePeerPods === true;
  const onNodeTee = teeNodes.length > 0 || !peerPodsMode;
  // Name the confidential runtime the platform will use, for step copy.
  const confidentialRcNames = confidentialRCs.map((rc) => rc.metadata?.name).filter(Boolean);
  const runtimeExample = confidentialRcNames.includes('kata-remote')
    ? 'kata-remote'
    : (confidentialRcNames[0] ?? (peerPodsMode ? 'kata-remote' : 'kata-cc'));
  // Which TEEs are present, so the attestation-infrastructure step is chip-aware.
  const teeKinds = {
    tdx: teeNodes.some((n) => n.tee === 'tdx'),
    snp: teeNodes.some((n) => n.tee === 'snp'),
    gpu: teeNodes.some((n) => n.gpuCcReady),
  };
  // Is the Intel SGX device plugin advertising enclave/provision on the TDX node(s)?
  // TDX quotes are signed by an SGX enclave, so the QGS needs it to schedule.
  const sgxPluginReady = teeNodes.some((n) => n.tee === 'tdx' && n.sgxDevicePlugin);

  // Live status of the Intel TDX remote-attestation infrastructure (PCCS + QGS).
  // Named-resource watches 404 silently when absent; we only read readiness.
  const [pccsDep] = useK8sWatchResource<DeploymentKind>({
    groupVersionKind: DeploymentGVK,
    name: 'pccs',
    namespace: INTEL_DCAP_NAMESPACE,
  });
  const [qgsDs] = useK8sWatchResource<DaemonSetKind>({
    groupVersionKind: DaemonSetGVK,
    name: 'tdx-qgs',
    namespace: INTEL_DCAP_NAMESPACE,
  });
  const qgsDesired = qgsDs?.status?.desiredNumberScheduled ?? 0;
  const qgsReady = qgsDs?.status?.numberReady ?? 0;
  const attestPresent = Boolean(pccsDep?.metadata) || Boolean(qgsDs?.metadata);
  const attestReady =
    (pccsDep?.status?.availableReplicas ?? 0) > 0 && qgsDesired > 0 && qgsReady >= qgsDesired;
  // QGS deployed but not running, and the SGX device plugin isn't advertising — the
  // classic "QGS Pending" cause.
  const qgsBlockedOnSgx = attestPresent && qgsReady < Math.max(qgsDesired, 1) && !sgxPluginReady;

  const [tdxSetupOpen, setTdxSetupOpen] = useState(false);

  const steps: Step[] = [];

  // On-node TEE nodes (bare-metal). Hidden on a peer-pods-only cluster where no node
  // is — or can be — a TEE host; there the workload's TEE is a cloud Confidential VM.
  // Kept visible on mixed clusters (peer pods + attached bare-metal TEE nodes).
  if (onNodeTee) {
    steps.push({
      title: t('TEE-capable nodes'),
      status: teeNodes.length > 0 ? 'done' : 'todo',
      detail:
        teeNodes.length > 0
          ? t('{{count}} node(s) are labeled as TEE-capable.', { count: teeNodes.length })
          : t(
              'Detect and label your Intel TDX or AMD SEV-SNP nodes with Node Feature Discovery. If a node has TDX enabled in firmware but is not detected, activate the TDX host kernel arguments first. Confidential workloads only schedule onto these nodes.',
            ),
      action: {
        label: teeNodes.length > 0 ? t('View TEE nodes') : t('Detect TEE nodes'),
        href: '/confidential-containers/tee-nodes',
      },
    });
  }

  // Cloud Confidential VMs (peer pods). Shown when peer pods are enabled — the cloud
  // provider owns the TEE, so there is no node labeling or host quote-generation.
  if (peerPodsMode) {
    steps.push({
      title: t('Confidential peer pods (Confidential VMs)'),
      status: cvmPeerPods ? 'done' : 'warn',
      detail: cvmPeerPods
        ? t(
            'Peer pods on this cluster run as Confidential VMs (peer-pods-cm has CLOUD_PROVIDER and DISABLECVM is not "true"), so kata-remote workloads run inside a cloud hardware TEE. The cloud provider owns the TEE — there is no TEE-capable node or host quote-generation to configure here.',
          )
        : t(
            'Peer pods are enabled but not as Confidential VMs. In peer-pods-cm set DISABLECVM to "false" and a confidential instance type (for example AZURE_INSTANCE_SIZE Standard_DC*as_v5 for AMD SEV-SNP or Standard_EC*eds_v5 for Intel TDX). Until then kata-remote pods run in a normal VM and are not confidential.',
          ),
    });
  }

  steps.push({
    title: t('Confidential containers enabled'),
    status: ccEnabled ? 'done' : 'info',
    detail: ccEnabled
      ? peerPodsMode
        ? t(
            'Confidential containers are enabled, so the operator provides the kata-remote runtime.',
          )
        : t('Confidential containers are enabled, so the operator installs the kata-cc runtime.')
      : t(
          'Enable confidential containers in the OpenShift sandboxed containers operator — a supported configuration option. The operator then provides the confidential runtime (kata-cc on TEE nodes, kata-remote for cloud Confidential VMs).',
        ),
    node: ccEnabled ? undefined : <EnableConfidentialContainers />,
  });

  steps.push({
    title: t('Confidential runtime installed'),
    status:
      ccRuntimeReady && (peerPodsMode || kata.state === 'installed')
        ? 'done'
        : kata.state === 'inProgress' || kata.state === 'failed'
          ? 'warn'
          : 'todo',
    detail: ccRuntimeReady ? (
      <span className="coco-openshift-console-plugin__mono">
        {confidentialRCs.map((rc) => rc.metadata?.name).join(', ')}
      </span>
    ) : kataConfig ? (
      <Flex
        alignItems={{ default: 'alignItemsCenter' }}
        gap={{ default: 'gapSm' }}
        flexWrap={{ default: 'wrap' }}
      >
        <FlexItem>
          <ResourceLink groupVersionKind={KataConfigGVK} name={kataConfig.metadata?.name} inline />
        </FlexItem>
        <FlexItem>
          <Label
            isCompact
            color={
              kata.state === 'installed' ? 'green' : kata.state === 'failed' ? 'red' : 'orange'
            }
          >
            {t('{{state}} ({{ready}} nodes)', { state: kata.label, ready: kata.ready })}
          </Label>
        </FlexItem>
      </Flex>
    ) : peerPodsMode ? (
      t(
        'Create a KataConfig with enablePeerPods and confidential containers enabled to provide the kata-remote runtime for cloud Confidential VMs.',
      )
    ) : (
      t(
        'Create a KataConfig with confidential containers enabled to install the kata-cc runtime on your TEE nodes. This reboots the selected nodes.',
      )
    ),
    node: !ccRuntimeReady && !kataConfig ? <EnableKataConfig /> : undefined,
  });

  // Host quote-generation infrastructure (Intel DCAP: PCCS + QGS). Only bare-metal
  // TEE nodes need this — a cloud Confidential VM produces its own evidence and
  // Trustee verifies it remotely against the cloud provider / Intel PCS, so this
  // step is skipped on peer-pods-only clusters (#18).
  if (onNodeTee) {
    steps.push({
      title: t('Attestation infrastructure (TEE quote generation)'),
      // For Intel TDX this is now live (PCCS + QGS watched in intel-dcap). It is the
      // most commonly-missed prerequisite — without it every attestation fails with
      // an empty quote — so when it is absent we flag it as a warning.
      status: attestReady ? 'done' : attestPresent ? 'info' : 'warn',
      detail: attestReady ? (
        <>
          {t(
            'Intel TDX quote generation is running — PCCS (PCK certificate cache) and the per-node QGS are up in the intel-dcap namespace, so TDX pods can produce signed quotes.',
          )}
          <Flex
            alignItems={{ default: 'alignItemsCenter' }}
            gap={{ default: 'gapSm' }}
            className="coco-openshift-console-plugin__mt"
          >
            <FlexItem>
              <ResourceLink
                groupVersionKind={DeploymentGVK}
                name="pccs"
                namespace={INTEL_DCAP_NAMESPACE}
                inline
              />
            </FlexItem>
            <FlexItem>
              <ResourceLink
                groupVersionKind={DaemonSetGVK}
                name="tdx-qgs"
                namespace={INTEL_DCAP_NAMESPACE}
                inline
              />
            </FlexItem>
          </Flex>
        </>
      ) : (
        <>
          {attestPresent
            ? qgsBlockedOnSgx
              ? t(
                  'PCCS is up, but the QGS DaemonSet is Pending: the Intel SGX device plugin is not advertising sgx.intel.com/enclave + /provision yet. Open the setup to install it (TDX quotes are signed by an SGX enclave).',
                )
              : t(
                  'The Intel TDX attestation infrastructure is deploying in intel-dcap. It is ready once PCCS is available and the QGS DaemonSet is running on your TDX nodes.',
                )
            : t(
                'Attestation needs the host quote-generation stack for your TEE. Without it the guest sends an empty quote and Trustee rejects it — pods still run, but no secret is ever released. Confirm it is deployed for your hardware:',
              )}
          <ul className="coco-openshift-console-plugin__mt">
            {teeKinds.tdx && (
              <li>
                {t(
                  'Intel TDX — deploy a Quote Generation Service (QGS) and a PCCS for PCK collateral (Intel DCAP). The guest reaches the QGS over vsock. Use the guided setup on the right.',
                )}
              </li>
            )}
            {teeKinds.snp && (
              <li>
                {t(
                  'AMD SEV-SNP — the attestation report is generated in-guest; ensure the Trustee SNP verifier can fetch VCEK collateral from the AMD KDS.',
                )}
              </li>
            )}
            {teeKinds.gpu && (
              <li>
                {t(
                  'NVIDIA GPU — confidential GPU attestation uses NVIDIA NRAS; ensure the Trustee NVIDIA GPU verifier is configured.',
                )}
              </li>
            )}
            {!teeKinds.tdx && !teeKinds.snp && !teeKinds.gpu && (
              <li>
                {t(
                  'Match the quote-generation stack to your TEE — Intel TDX: QGS + PCCS; AMD SEV-SNP: AMD KDS; NVIDIA GPU: NRAS.',
                )}
              </li>
            )}
          </ul>
        </>
      ),
      node: (
        <Flex
          direction={{ default: 'column' }}
          gap={{ default: 'gapSm' }}
          alignItems={{ default: 'alignItemsFlexEnd' }}
        >
          {teeKinds.tdx && (
            <FlexItem>
              <Button
                variant={attestReady ? 'secondary' : 'primary'}
                onClick={() => {
                  setTdxSetupOpen(true);
                }}
              >
                {attestReady ? t('Reconfigure TDX attestation') : t('Set up Intel TDX attestation')}
              </Button>
            </FlexItem>
          )}
          <FlexItem>
            <Button
              variant="link"
              component="a"
              href="https://github.com/confidential-devhub/veritas"
              target="_blank"
              rel="noopener noreferrer"
              icon={<ExternalLinkAltIcon />}
              iconPosition="end"
            >
              {t('Bare-metal attestation reference values (veritas)')}
            </Button>
          </FlexItem>
        </Flex>
      ),
    });
  }

  if (onNodeTee && (teeKinds.gpu || teeKinds.tdx || teeKinds.snp)) {
    steps.push({
      title: t('Confidential GPU prerequisites (Tech Preview)'),
      status: teeKinds.gpu ? 'done' : 'info',
      detail: teeKinds.gpu
        ? t(
            'GPU-CC nodes detected — NVIDIA confidential GPU labels are present. The kata-cc-nvidia-gpu runtime class is available for workloads.',
          )
        : t(
            'Confidential GPU workloads (NVIDIA H100, bare metal only) need additional setup: an IOMMU MachineConfig (intel_iommu=on or amd_iommu=on, reboots nodes), the NVIDIA GPU Operator with a ClusterPolicy enabling ccManager, kata sandbox device plugin, and vfio-manager, and nodes labeled nvidia.com/cc.mode.state=on and nvidia.com/cc.ready.state=true.',
          ),
      node: !teeKinds.gpu ? (
        <Flex
          direction={{ default: 'column' }}
          gap={{ default: 'gapSm' }}
          alignItems={{ default: 'alignItemsFlexEnd' }}
        >
          <FlexItem>
            <EnableIommu />
          </FlexItem>
          <FlexItem>
            <Button
              variant="link"
              component="a"
              href="https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/index.html"
              target="_blank"
              rel="noopener noreferrer"
              icon={<ExternalLinkAltIcon />}
              iconPosition="end"
            >
              {t('NVIDIA GPU Operator documentation')}
            </Button>
          </FlexItem>
        </Flex>
      ) : undefined,
    });
  }

  if (onNodeTee && teeKinds.snp) {
    steps.push({
      title: t('AMD SEV-SNP host readiness'),
      status: 'done',
      detail: t(
        'AMD SEV-SNP nodes are detected and labeled. SEV-SNP is enabled in firmware and the kernel auto-detects it — no additional host kernel arguments are required. Ensure the Trustee SNP verifier can fetch VCEK collateral from the AMD Key Distribution Service (KDS).',
      ),
    });
  }

  steps.push({
    title: t('Run a confidential workload'),
    status: ccRuntimeReady ? 'info' : 'todo',
    detail: ccRuntimeReady
      ? t(
          'Deploy a workload with runtimeClassName: {{runtimeClass}} and add the attestation evidence sidecar to verify its trust status from the Workloads list.',
          { runtimeClass: runtimeExample },
        )
      : peerPodsMode
        ? t('Available once the kata-remote runtime is installed for cloud Confidential VMs.')
        : t('Available once the kata-cc runtime is installed on your TEE nodes.'),
    action: ccRuntimeReady
      ? { label: t('Create workload'), href: '/confidential-containers/workloads/~new' }
      : undefined,
  });

  return (
    <>
      <DocumentTitle>{t('Confidential containers setup')}</DocumentTitle>
      <ListPageHeader title={t('Confidential containers setup')} />
      <PageSection>
        <Card className="coco-openshift-console-plugin__mb">
          <CardBody>
            <Content component="p">
              {t(
                'Confidential containers run your workload inside a hardware Trusted Execution Environment (Intel TDX or AMD SEV-SNP), so data stays encrypted in use — even from the cluster host. Work through the checklist below to go from a fresh cluster to an attested confidential workload.',
              )}
            </Content>
          </CardBody>
        </Card>

        <BaremetalBanner />

        <Card>
          <CardTitle>{t('Setup checklist')}</CardTitle>
          <CardBody>
            <Flex direction={{ default: 'column' }} gap={{ default: 'gapLg' }}>
              {steps.map((step) => (
                <FlexItem key={step.title}>
                  <Flex
                    alignItems={{ default: 'alignItemsCenter' }}
                    justifyContent={{ default: 'justifyContentSpaceBetween' }}
                  >
                    <FlexItem grow={{ default: 'grow' }}>
                      <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
                        <FlexItem>
                          <StatusIcon status={step.status} />
                        </FlexItem>
                        <FlexItem>
                          <strong>{step.title}</strong>
                          <div className="coco-openshift-console-plugin__muted">{step.detail}</div>
                        </FlexItem>
                      </Flex>
                    </FlexItem>
                    {step.action && (
                      <FlexItem>
                        <Link to={step.action.href}>
                          <Button
                            variant={step.status === 'done' ? 'secondary' : 'primary'}
                            icon={<ArrowRightIcon />}
                            iconPosition="end"
                          >
                            {step.action.label}
                          </Button>
                        </Link>
                      </FlexItem>
                    )}
                    {step.node && <FlexItem>{step.node}</FlexItem>}
                  </Flex>
                </FlexItem>
              ))}
            </Flex>
          </CardBody>
        </Card>
      </PageSection>
      {tdxSetupOpen && (
        <DeployTdxAttestationModal
          onClose={() => {
            setTdxSetupOpen(false);
          }}
        />
      )}
    </>
  );
};

export default CocoSetup;
