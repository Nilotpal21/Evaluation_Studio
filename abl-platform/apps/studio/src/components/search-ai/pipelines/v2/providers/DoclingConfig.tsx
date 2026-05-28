/**
 * Docling Provider Config — inline form for OCR, table/image extraction, error handling.
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Toggle } from '../../../../ui/Toggle';
import { Select } from '../../../../ui/Select';

interface DoclingConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function DoclingConfig({ config, onChange }: DoclingConfigProps) {
  const t = useTranslations('search_ai.pipeline');

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  return (
    <div className="space-y-3">
      <Toggle
        checked={config.ocrEnabled === true}
        onChange={(v) => update('ocrEnabled', v)}
        label={t('v2_config_ocr_enabled')}
      />
      <Toggle
        checked={config.extractTables === true}
        onChange={(v) => update('extractTables', v)}
        label={t('v2_config_extract_tables')}
      />
      <Toggle
        checked={config.extractImages === true}
        onChange={(v) => update('extractImages', v)}
        label={t('v2_config_extract_images')}
      />
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
          { value: 'llamaindex', label: 'LlamaIndex' },
        ]}
      />
    </div>
  );
}
