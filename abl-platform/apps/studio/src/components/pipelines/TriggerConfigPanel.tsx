/**
 * TriggerConfigPanel
 *
 * Popover panel for selecting pipeline triggers.
 * Fetches available triggers from the registry API and groups them by category.
 * Each trigger is a checkbox; schedule triggers show a cron input when selected.
 *
 * Data-driven: adding new triggers only requires a JSON entry in trigger-definitions.json.
 */

'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { Zap, Clock, Play, Radio } from 'lucide-react';
import { clsx } from 'clsx';
import { swrFetcher } from '../../lib/swr-config';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { Input } from '../ui/Input';
import { Checkbox } from '../ui/Checkbox';

// =============================================================================
// Types
// =============================================================================

interface TriggerDefinition {
  id: string;
  type: 'kafka' | 'schedule' | 'manual';
  kafkaTopic?: string;
  category: string;
  label: string;
  description: string;
}

interface TriggersResponse {
  success: boolean;
  data: TriggerDefinition[];
}

// =============================================================================
// Category config
// =============================================================================

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode }> = {
  session: { label: 'Session Events', icon: <Radio className="w-3.5 h-3.5" /> },
  message: { label: 'Message Events', icon: <Zap className="w-3.5 h-3.5" /> },
  other: { label: 'Other', icon: <Clock className="w-3.5 h-3.5" /> },
};

function getCategoryMeta(category: string) {
  return CATEGORY_META[category] ?? { label: category, icon: <Play className="w-3.5 h-3.5" /> };
}

// =============================================================================
// Component
// =============================================================================

export function TriggerConfigPanel() {
  const selectedTriggers = usePipelineEditorStore((s) => s.selectedTriggers);
  const toggleTrigger = usePipelineEditorStore((s) => s.toggleTrigger);
  const updateTriggerSchedule = usePipelineEditorStore((s) => s.updateTriggerSchedule);

  // Fetch available triggers from registry
  const { data, isLoading } = useSWR<TriggersResponse>('/api/pipelines/triggers', swrFetcher);
  const triggers = data?.data ?? [];

  // Group by category, preserving order
  const grouped = useMemo(() => {
    const map = new Map<string, TriggerDefinition[]>();
    for (const t of triggers) {
      const group = map.get(t.category) ?? [];
      group.push(t);
      map.set(t.category, group);
    }
    return map;
  }, [triggers]);

  const selectedIds = useMemo(
    () => new Set(selectedTriggers.map((t) => t.triggerId)),
    [selectedTriggers],
  );

  if (isLoading) {
    return (
      <div className="p-4">
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-10 bg-background-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (triggers.length === 0) {
    return <div className="p-4 text-sm text-foreground-muted">No triggers available</div>;
  }

  return (
    <div className="p-4 space-y-5">
      {[...grouped.entries()].map(([category, items]) => {
        const meta = getCategoryMeta(category);
        return (
          <div key={category}>
            {/* Category header */}
            <div className="flex items-center gap-2 mb-2.5">
              <span className="text-foreground-muted">{meta.icon}</span>
              <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
                {meta.label}
              </h4>
            </div>

            {/* Trigger items */}
            <div className="space-y-1.5">
              {items.map((trigger) => {
                const isSelected = selectedIds.has(trigger.id);
                const selectedEntry = selectedTriggers.find((t) => t.triggerId === trigger.id);

                return (
                  <div key={trigger.id}>
                    <div
                      className={clsx(
                        'p-2.5 rounded-lg border cursor-pointer transition-colors',
                        isSelected
                          ? 'border-accent/40 bg-accent/5'
                          : 'border-transparent hover:bg-background-muted',
                      )}
                    >
                      <Checkbox
                        checked={isSelected}
                        onChange={() => toggleTrigger(trigger.id)}
                        label={trigger.label}
                        description={trigger.description}
                      />
                    </div>

                    {/* Schedule cron input */}
                    {isSelected && trigger.type === 'schedule' && (
                      <div className="ml-8 mt-1.5 mb-1">
                        <Input
                          type="text"
                          label="Cron Expression"
                          value={selectedEntry?.schedule ?? ''}
                          onChange={(e) => updateTriggerSchedule(trigger.id, e.target.value)}
                          placeholder="0 */6 * * *"
                          className="!text-xs"
                        />
                        <p className="text-xs text-foreground-muted mt-1">
                          e.g. &quot;0 */6 * * *&quot; for every 6 hours
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Summary */}
      {selectedTriggers.length > 0 && (
        <div className="pt-3 border-t border-default">
          <p className="text-xs text-foreground-muted">
            {selectedTriggers.length} trigger{selectedTriggers.length !== 1 ? 's' : ''} selected
          </p>
        </div>
      )}
    </div>
  );
}
