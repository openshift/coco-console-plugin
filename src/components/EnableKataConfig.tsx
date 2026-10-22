import { k8sCreate } from '@openshift-console/dynamic-plugin-sdk';
import {
  Alert,
  Button,
  CodeBlock,
  CodeBlockCode,
  ExpandableSection,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
} from '@patternfly/react-core';
import type { FC } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KataConfigModel } from '../k8s/resources';
import { buildKataConfig } from '../utils/kataConfig';
import { PermissionHint } from '../utils/rbac/PermissionHint';
import { useCanCreateKataConfig } from '../utils/rbac/useCocoPermissions';
import './coco.css';

/**
 * One-click KataConfig create — installs the kata-cc runtime on the cluster's
 * TEE-capable nodes. Applying it reboots the kata-oc pool, one node at a time.
 */
export const EnableKataConfig: FC = () => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  const [canCreate, canCreateLoading] = useCanCreateKataConfig();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const onCreate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await k8sCreate({ model: KataConfigModel, data: buildKataConfig() });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PermissionHint allowed={canCreate} loading={canCreateLoading} />
      <Button
        variant="secondary"
        onClick={() => {
          setOpen(true);
        }}
        isDisabled={canCreateLoading || !canCreate}
      >
        {t('Create KataConfig')}
      </Button>
      {open && (
        <Modal
          isOpen
          variant="medium"
          onClose={() => {
            setOpen(false);
          }}
        >
          <ModalHeader title={t('Create KataConfig')} />
          <ModalBody>
            <p className="coco-openshift-console-plugin__mb">
              {t(
                'This creates a KataConfig that installs the kata-cc runtime on your TEE-capable nodes. Enable confidential containers first — the operator builds the kata-cc runtime from that.',
              )}
            </p>
            <Alert
              variant="warning"
              isInline
              title={t('Nodes will reboot')}
              className="coco-openshift-console-plugin__mb"
            >
              {t(
                'Installing the runtime reconfigures and reboots the eligible nodes, one at a time. checkNodeEligibility limits installation to nodes labeled TEE-capable.',
              )}
            </Alert>
            <ExpandableSection toggleText={t('Resource to create')}>
              <CodeBlock>
                <CodeBlockCode>{JSON.stringify(buildKataConfig(), null, 2)}</CodeBlockCode>
              </CodeBlock>
            </ExpandableSection>
            {error && (
              <Alert
                variant="danger"
                isInline
                title={t('Could not create KataConfig')}
                className="coco-openshift-console-plugin__mt"
              >
                {error}
              </Alert>
            )}
          </ModalBody>
          <ModalFooter>
            <Button
              variant="primary"
              onClick={() => void onCreate()}
              isLoading={busy}
              isDisabled={busy || canCreateLoading || !canCreate}
            >
              {t('Create and reboot')}
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

export default EnableKataConfig;
