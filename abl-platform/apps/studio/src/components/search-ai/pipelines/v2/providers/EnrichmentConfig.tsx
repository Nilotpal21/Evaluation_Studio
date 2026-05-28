/**
 * Enrichment Config — form for LLM Enrichment and Question Synthesis providers.
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '../../../../ui/Input';
import { Textarea } from '../../../../ui/Textarea';

interface EnrichmentConfigProps {
  provider: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function EnrichmentConfig({ provider, config, onChange }: EnrichmentConfigProps) {
  const t = useTranslations('search_ai.pipeline');

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  if (provider === 'question-synthesis') {
    return (
      <div className="space-y-3">
        <Input
          label={t('v2_config_questions_per_chunk')}
          type="number"
          value={String(config.questionsPerChunk ?? 3)}
          onChange={(e) => update('questionsPerChunk', Number(e.target.value))}
          min={1}
          max={20}
        />
        <Input
          label={t('v2_config_model')}
          type="text"
          value={(config.model as string) ?? ''}
          onChange={(e) => update('model', e.target.value)}
          placeholder="gpt-4o-mini"
        />
      </div>
    );
  }

  // Default: LLM Enrichment
  return (
    <div className="space-y-3">
      <Input
        label={t('v2_config_model')}
        type="text"
        value={(config.model as string) ?? ''}
        onChange={(e) => update('model', e.target.value)}
        placeholder="gpt-4o-mini"
      />
      <Textarea
        label={t('v2_config_prompt_template')}
        value={(config.promptTemplate as string) ?? ''}
        onChange={(e) => update('promptTemplate', e.target.value)}
        rows={4}
      />
    </div>
  );
}
