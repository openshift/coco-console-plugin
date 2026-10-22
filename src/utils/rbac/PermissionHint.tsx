import { Alert } from '@patternfly/react-core';
import type { FC } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  allowed: boolean;
  loading: boolean;
}

export const PermissionHint: FC<Props> = ({ allowed, loading }) => {
  const { t } = useTranslation('plugin__coco-openshift-console-plugin');
  if (loading || allowed) return null;
  return (
    <Alert
      variant="warning"
      isInline
      isPlain
      title={t(
        'You do not have permission to perform this action. Contact a cluster administrator.',
      )}
    />
  );
};
