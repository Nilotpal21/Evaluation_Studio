/**
 * Tree Builder Provider Config — strategy selection and token settings.
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '../../../../ui/Select';
import { Input } from '../../../../ui/Input';

interface TreeBuilderConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function TreeBuilderConfig({ config, onChange }: TreeBuilderConfigProps) {
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
        label={t('v2_config_strategy')}
        value={(config.strategy as string) ?? 'sentence-window'}
        onChange={(v) => update('strategy', v)}
        options={[
          { value: 'sentence-window', label: t('v2_config_sentence_window') },
          { value: 'hierarchical', label: t('v2_config_hierarchical') },
        ]}
      />
      <Input
        label={t('v2_config_max_tokens')}
        type="number"
        value={String(config.maxTokens ?? 512)}
        onChange={(e) => update('maxTokens', Number(e.target.value))}
        min={1}
      />
      <Input
        label={t('v2_config_overlap')}
        type="number"
        value={String(config.overlap ?? 50)}
        onChange={(e) => update('overlap', Number(e.target.value))}
        min={0}
      />
    </div>
  );
}
