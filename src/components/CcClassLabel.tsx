import type { FC } from 'react';
import { Label } from '@patternfly/react-core';
import { LockIcon } from '@patternfly/react-icons';
import type { CcClass } from '../k8s/types';
import { ccClassLabel } from '../utils/runtime';

/** A neutral outlined Label for a confidential-computing class, with a lock for confidential ones. */
export const CcClassLabel: FC<{ ccClass: CcClass; isCompact?: boolean }> = ({
  ccClass,
  isCompact,
}) => {
  const confidential = ccClass === 'confidential' || ccClass === 'confidential-gpu';
  return (
    <Label variant="outline" isCompact={isCompact} icon={confidential ? <LockIcon /> : undefined}>
      {ccClassLabel(ccClass)}
    </Label>
  );
};
