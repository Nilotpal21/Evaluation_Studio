/**
 * TemplatePicker — modal that appears when creating a new custom pipeline.
 *
 * Shows available templates (including "Blank"). Selecting a template either
 * navigates to the editor (blank) or POSTs to clone the template into the
 * project, then navigates to the resulting pipeline.
 */

'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { clsx } from 'clsx';
import { SlidePanel } from '../ui/SlidePanel';
import { Button } from '../ui/Button';
import { apiFetch, handleResponse } from '../../lib/api-client';
import { swrFetcher } from '../../lib/swr-config';

interface TemplateEntry {
  id: string;
  label: string;
  description: string;
  category: string;
  trigger?: string;
  nodes?: string[];
}

interface TemplatesResponse {
  success: boolean;
  data: TemplateEntry[];
}

interface TemplatePicker {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onNavigate: (path: string) => void;
}

const CATEGORY_LABELS: Record<string, string> = {
  starter: 'Start from scratch',
  analytics: 'Analytics',
  guardrail: 'Guardrail',
};

export function TemplatePicker({ open, onClose, projectId, onNavigate }: TemplatePicker) {
  const [selected, setSelected] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data } = useSWR<TemplatesResponse>(open ? '/api/pipelines/templates' : null, swrFetcher);
  const templates = data?.data ?? [];

  const grouped = templates.reduce<Record<string, TemplateEntry[]>>((acc, t) => {
    const cat = t.category ?? 'other';
    (acc[cat] ??= []).push(t);
    return acc;
  }, {});

  const handleSelect = useCallback(
    async (templateId: string) => {
      if (templateId === 'blank') {
        onClose();
        onNavigate(`/projects/${projectId}/pipelines/new?template=blank`);
        return;
      }
      setSelected(templateId);
      setCloning(true);
      setError(null);
      try {
        const resp = await apiFetch(
          `/api/pipelines/templates/${encodeURIComponent(templateId)}/clone`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId }),
          },
        );
        const pipeline = await handleResponse<{ _id: string }>(resp);
        onClose();
        onNavigate(`/projects/${projectId}/pipelines/${pipeline._id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create pipeline from template');
        setSelected(null);
      } finally {
        setCloning(false);
      }
    },
    [projectId, onClose, onNavigate],
  );

  return (
    <SlidePanel open={open} onClose={onClose} title="New pipeline" width="md">
      <div className="space-y-6">
        {error && (
          <div className="text-xs text-error bg-error-subtle border border-error/20 rounded px-3 py-2">
            {error}
          </div>
        )}

        {Object.entries(grouped).map(([category, items]) => (
          <div key={category}>
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-2">
              {CATEGORY_LABELS[category] ?? category}
            </h3>
            <div className="space-y-2">
              {items.map((t) => {
                const isLoading = selected === t.id && cloning;
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => !cloning && handleSelect(t.id)}
                    disabled={cloning}
                    className={clsx(
                      'w-full text-left px-4 py-3 rounded-lg border transition-colors',
                      'hover:bg-background-muted hover:border-accent/30',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      'border-default bg-background',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{t.label}</span>
                      {isLoading && (
                        <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-foreground-muted mt-0.5 leading-relaxed">
                      {t.description}
                    </p>
                    {t.nodes && t.nodes.length > 0 && (
                      <p className="text-xs text-foreground-subtle mt-1">
                        {t.trigger && (
                          <span className="mr-1 font-mono bg-background-muted px-1 rounded">
                            {t.trigger}
                          </span>
                        )}
                        → {t.nodes.join(' → ')}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <div className="flex justify-end pt-2 border-t border-default">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={cloning}>
            Cancel
          </Button>
        </div>
      </div>
    </SlidePanel>
  );
}
