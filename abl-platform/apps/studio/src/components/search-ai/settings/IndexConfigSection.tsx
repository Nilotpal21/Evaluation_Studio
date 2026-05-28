/**
 * IndexConfigSection Component
 *
 * Displays index configuration with editable search defaults (topK, similarity threshold).
 * Embedding model, dimensions, vector store, and collection are read-only.
 */

'use client';

import React, { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { KnowledgeBaseDetail } from '../../../api/search-ai';
import { updateSearchDefaults } from '../../../api/search-ai';
import { Input } from '../../ui/Input';

interface IndexConfigSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  onUpdate?: () => void;
}

function ConfigRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </div>
  );
}

function EditableRow({
  label,
  value,
  min,
  max,
  step,
  onSave,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [saving, setSaving] = useState(false);

  const handleBlur = useCallback(async () => {
    const parsed = step && step < 1 ? parseFloat(draft) : parseInt(draft, 10);
    if (isNaN(parsed) || parsed < min || parsed > max || parsed === value) {
      setDraft(String(value));
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed);
    } catch {
      setDraft(String(value));
    } finally {
      setSaving(false);
    }
  }, [draft, value, min, max, step, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      if (e.key === 'Escape') {
        setDraft(String(value));
        (e.target as HTMLInputElement).blur();
      }
    },
    [value],
  );

  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-muted">{label}</span>
      <Input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        min={min}
        max={max}
        step={step}
        disabled={saving}
        className="w-20 text-right font-mono text-xs"
      />
    </div>
  );
}

export function IndexConfigSection({ knowledgeBase, onUpdate }: IndexConfigSectionProps) {
  const t = useTranslations('search_ai.settings_index');
  const index = knowledgeBase.index;

  if (!index) {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="text-sm text-muted">{t('no_index')}</p>
      </div>
    );
  }

  const handleTopKSave = useCallback(
    async (val: number) => {
      await updateSearchDefaults(index._id, {
        topK: val,
        similarityThreshold: index.searchDefaults.similarityThreshold,
        includeMetadata: index.searchDefaults.includeMetadata,
        includeContent: index.searchDefaults.includeContent,
      });
      onUpdate?.();
    },
    [index, onUpdate],
  );

  const handleThresholdSave = useCallback(
    async (val: number) => {
      await updateSearchDefaults(index._id, {
        topK: index.searchDefaults.topK,
        similarityThreshold: val,
        includeMetadata: index.searchDefaults.includeMetadata,
        includeContent: index.searchDefaults.includeContent,
      });
      onUpdate?.();
    },
    [index, onUpdate],
  );

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
      <div className="divide-y divide-default">
        <ConfigRow label={t('label_embedding_model')} value={index.embeddingModel} />
        <ConfigRow label={t('label_dimensions')} value={index.embeddingDimensions} />
        <ConfigRow label={t('label_vector_store')} value={index.vectorStore.provider} />
        <ConfigRow label={t('label_collection')} value={index.vectorStore.collectionName} />
        <EditableRow
          label={t('label_top_k')}
          value={index.searchDefaults.topK}
          min={1}
          max={100}
          onSave={handleTopKSave}
        />
        <EditableRow
          label={t('label_similarity_threshold')}
          value={index.searchDefaults.similarityThreshold}
          min={0}
          max={1}
          step={0.05}
          onSave={handleThresholdSave}
        />
      </div>
    </div>
  );
}
