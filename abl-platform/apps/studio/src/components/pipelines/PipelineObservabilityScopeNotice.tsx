'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type {
  PipelineObservabilityContract,
  PipelineObservabilityDeferredCapability,
} from '@agent-platform/shared';
import { Alert } from '../ui/Alert';

interface PipelineObservabilityScopeNoticeProps {
  contract?: PipelineObservabilityContract | null;
  surface: 'runs' | 'data';
}

function capabilityToTranslationKey(
  capability: PipelineObservabilityDeferredCapability,
): `scope_notice.capabilities.${PipelineObservabilityDeferredCapability}` {
  return `scope_notice.capabilities.${capability}`;
}

export function PipelineObservabilityScopeNotice({
  contract,
  surface,
}: PipelineObservabilityScopeNoticeProps) {
  const t = useTranslations('pipelines');

  const deferredLabels = useMemo(() => {
    if (!contract) {
      return [] as string[];
    }

    return contract.deferredCapabilities.map((capability) =>
      t(capabilityToTranslationKey(capability)),
    );
  }, [contract, t]);

  if (!contract) {
    return null;
  }

  return (
    <Alert variant="warning" title={t('scope_notice.title')}>
      <p>
        {surface === 'runs'
          ? t('scope_notice.runs_description')
          : t('scope_notice.data_description')}
      </p>
      <p className="mt-2">
        {t('scope_notice.contract_summary', {
          supportLevel: contract.supportLevel.toUpperCase(),
          metricOwnership: t(`scope_notice.metric_ownership.${contract.metricOwnership}`),
        })}
      </p>
      {deferredLabels.length > 0 && (
        <p className="mt-2">
          {t('scope_notice.deferred_summary', {
            capabilities: deferredLabels.join(', '),
          })}
        </p>
      )}
    </Alert>
  );
}
