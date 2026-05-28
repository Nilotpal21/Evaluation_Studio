/**
 * LlamaIndex Provider Config — inline form for error handling and fallback.
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '../../../../ui/Select';

interface LlamaIndexConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function LlamaIndexConfig({ config, onChange }: LlamaIndexConfigProps) {
  const t = useTranslations('search_ai.pipeline');

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  return (
    <div className="space-y-3">
      <Select
        label={t('v2_config_on_error')}
        value={(config.onError as string) ?? 'fail'}
        onChange={(v) => update('onError', v)}
        options={[
          { value: 'fail', label: t('v2_config_on_error_fail') },
          { value: 'continue', label: t('v2_config_on_error_continue') },
        ]}
      />
      <Select
        label={t('v2_config_fallback_provider')}
        value={(config.fallbackProvider as string) ?? ''}
        onChange={(v) => update('fallbackProvider', v || null)}
        options={[
          { value: '', label: t('v2_config_fallback_none') },
          { value: 'docling', label: 'Docling' },
        ]}
      />
    </div>
  );
}
