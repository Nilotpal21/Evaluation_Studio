/**
 * CitationSection Component
 *
 * Settings section for configuring citation behavior in search-powered answers.
 * Controls enable/disable, link mode, TTL, and max clicks.
 */

'use client';

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { KnowledgeBaseDetail, SearchAIIndex } from '../../../api/search-ai';
import { updateCitationConfig } from '../../../api/search-ai';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { Toggle } from '../../ui/Toggle';
import { Select } from '../../ui/Select';

interface CitationSectionProps {
  knowledgeBase: KnowledgeBaseDetail;
  onUpdate?: () => void;
}

type CitationConfig = NonNullable<SearchAIIndex['citationConfig']>;
type LinkMode = CitationConfig['linkMode'];

const DEFAULT_CONFIG: CitationConfig = {
  enabled: true,
  linkMode: 'direct',
  linkTtlSeconds: 3600,
  maxClicks: 5,
};

export function CitationSection({ knowledgeBase, onUpdate }: CitationSectionProps) {
  const t = useTranslations('search_ai.settings_citations');
  const index = knowledgeBase.index;

  if (!index) return null;

  return <CitationSectionInner index={index} onUpdate={onUpdate} t={t} />;
}

/**
 * Inner component that renders once we know index is non-null.
 * Separated to keep hooks unconditional.
 */
function CitationSectionInner({
  index,
  onUpdate,
  t,
}: {
  index: SearchAIIndex;
  onUpdate?: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [config, setConfig] = useState<CitationConfig>(index.citationConfig ?? DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);

  const linkModeOptions = useMemo(
    () => [
      { value: 'direct', label: t('link_mode_direct') },
      { value: 'time_limited', label: t('link_mode_time_limited') },
      { value: 'click_limited', label: t('link_mode_click_limited') },
      { value: 'disabled', label: t('link_mode_disabled') },
    ],
    [t],
  );

  const handleSave = useCallback(
    async (updates: Partial<CitationConfig>) => {
      const previous = config;
      const newConfig = { ...config, ...updates };
      setConfig(newConfig);
      setSaving(true);
      try {
        await updateCitationConfig(index._id, newConfig);
        onUpdate?.();
      } catch (err) {
        setConfig(previous);
        toast.error(sanitizeError(err, t('error_save_failed')));
      } finally {
        setSaving(false);
      }
    },
    [config, index._id, onUpdate],
  );

  const handleToggle = useCallback(
    (checked: boolean) => {
      handleSave({ enabled: checked });
    },
    [handleSave],
  );

  const handleLinkModeChange = useCallback(
    (value: string) => {
      handleSave({ linkMode: value as LinkMode });
    },
    [handleSave],
  );

  const showTtl = config.linkMode === 'time_limited' || config.linkMode === 'click_limited';
  const showMaxClicks = config.linkMode === 'click_limited';

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted mt-0.5">{t('description')}</p>
      </div>

      <div className="space-y-4">
        <Toggle
          checked={config.enabled}
          onChange={handleToggle}
          label={t('enabled')}
          description={t('enabled_description')}
          disabled={saving}
        />

        {config.enabled && (
          <>
            <Select
              label={t('link_mode')}
              options={linkModeOptions}
              value={config.linkMode}
              onChange={handleLinkModeChange}
              disabled={saving}
            />

            {showTtl && (
              <TtlInput
                value={config.linkTtlSeconds}
                onSave={(val) => handleSave({ linkTtlSeconds: val })}
                label={t('link_ttl')}
                description={t('link_ttl_description')}
                hoursLabel={t('hours')}
                saving={saving}
              />
            )}

            {showMaxClicks && (
              <MaxClicksInput
                value={config.maxClicks}
                onSave={(val) => handleSave({ maxClicks: val })}
                label={t('max_clicks')}
                description={t('max_clicks_description')}
                saving={saving}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Numeric input for TTL — displays in hours, stores as seconds.
 */
function TtlInput({
  value,
  onSave,
  label,
  description,
  hoursLabel,
  saving,
}: {
  value: number;
  onSave: (seconds: number) => void;
  label: string;
  description: string;
  hoursLabel: string;
  saving: boolean;
}) {
  const hoursValue = Math.round(value / 3600);
  const [draft, setDraft] = useState(String(hoursValue));

  const handleBlur = useCallback(() => {
    const parsed = parseInt(draft, 10);
    // min 1 hour (3600s), max 168 hours (604800s)
    if (isNaN(parsed) || parsed < 1 || parsed > 168 || parsed === hoursValue) {
      setDraft(String(hoursValue));
      return;
    }
    onSave(parsed * 3600);
  }, [draft, hoursValue, onSave]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      if (e.key === 'Escape') {
        setDraft(String(hoursValue));
        (e.target as HTMLInputElement).blur();
      }
    },
    [hoursValue],
  );

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium text-foreground">{label}</label>
      <p className="text-xs text-muted">{description}</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          min={1}
          max={168}
          disabled={saving}
          className="w-20 rounded border border-default bg-background px-2 py-1 text-right font-mono text-xs text-foreground focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <span className="text-xs text-muted">{hoursLabel}</span>
      </div>
    </div>
  );
}

/**
 * Numeric input for max clicks.
 */
function MaxClicksInput({
  value,
  onSave,
  label,
  description,
  saving,
}: {
  value: number;
  onSave: (clicks: number) => void;
  label: string;
  description: string;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  const handleBlur = useCallback(() => {
    const parsed = parseInt(draft, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 100 || parsed === value) {
      setDraft(String(value));
      return;
    }
    onSave(parsed);
  }, [draft, value, onSave]);

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
    <div className="space-y-1">
      <label className="text-sm font-medium text-foreground">{label}</label>
      <p className="text-xs text-muted">{description}</p>
      <input
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        min={1}
        max={100}
        disabled={saving}
        className="w-20 rounded border border-default bg-background px-2 py-1 text-right font-mono text-xs text-foreground focus:border-accent focus:outline-none disabled:opacity-50"
      />
    </div>
  );
}
