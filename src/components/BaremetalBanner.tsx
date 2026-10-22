import { Alert } from '@patternfly/react-core';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { useCvmPeerPodsStatus, useInfrastructurePlatform } from '../k8s/hooks';
import { shouldShowBaremetalBanner } from '../utils/baremetal';

const BaremetalBanner: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [platform, loaded] = useInfrastructurePlatform();
  const [cvmPeerPods, peerPodsReady] = useCvmPeerPodsStatus();

  if (!shouldShowBaremetalBanner(platform, loaded && peerPodsReady, cvmPeerPods)) {
    return null;
  }

  return (
    <Alert
      variant="warning"
      isInline
      title={t('Unsupported infrastructure')}
      className="coco-openshift-console-plugin__mb"
    >
      {t(
        'Confidential containers with on-node TEE require bare-metal infrastructure. This cluster reports platform "{{platform}}". The setup steps below apply to bare-metal only; on this infrastructure consider using peer pods with Confidential VMs (kata-remote) instead.',
        { platform },
      )}
    </Alert>
  );
};

export default BaremetalBanner;
