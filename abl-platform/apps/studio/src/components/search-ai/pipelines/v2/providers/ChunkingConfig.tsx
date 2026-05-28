/**
 * Chunking Config — shared form for Recursive Character + Fixed Size providers.
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Input } from '../../../../ui/Input';

interface ChunkingConfigProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}

export function ChunkingConfig({ config, onChange }: ChunkingConfigProps) {
  const t = useTranslations('search_ai.pipeline');

  const update = useCallback(
    (key: string, value: unknown) => {
      onChange({ ...config, [key]: value });
    },
    [config, onChange],
  );

  return (
    <div className="space-y-3">
      <Input
        label={t('v2_config_chunk_size')}
        type="number"
        value={String(config.chunkSize ?? 1000)}
        onChange={(e) => update('chunkSize', Number(e.target.value))}
        min={1}
      />
      <Input
        label={t('v2_config_chunk_overlap')}
        type="number"
        value={String(config.chunkOverlap ?? 200)}
        onChange={(e) => update('chunkOverlap', Number(e.target.value))}
        min={0}
      />
    </div>
  );
}
