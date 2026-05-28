'use client';

/**
 * DelegatesEditor
 *
 * Section editor for agent delegates. Each delegate dispatches a
 * sub-task to another agent with a condition and purpose description.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Plus, Trash2, RefreshCw, Search } from 'lucide-react';
import clsx from 'clsx';
import type { SectionEditorProps, DelegateData } from '../types';
import { SectionHeader } from './SectionHeader';
import { AgentPickerDialog } from '../../abl/pickers/AgentPickerDialog';
import { useAgentPicker } from '../../abl/pickers/useAgentPicker';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Delegate badge color matching the canvas edge color */
const DELEGATE_BADGE_COLOR = 'bg-warning/15 text-warning';

// =============================================================================
// STYLE CONSTANTS
// =============================================================================

const INPUT_CLASSES = clsx(
  'w-full px-2 py-1.5 text-xs rounded-md bg-background border border-default',
  'text-foreground placeholder:text-foreground-subtle',
  'focus:outline-none focus:ring-2 focus:ring-border-focus/40 focus:border-border-focus',
  'transition-default',
);

const CARD_CLASSES =
  'rounded-lg border border-default bg-background-muted overflow-hidden shadow-sm';

const ADD_BUTTON_CLASSES = clsx(
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium',
  'text-accent hover:bg-accent-subtle border border-accent/30 transition-default',
);

const REMOVE_BUTTON_CLASSES = clsx(
  'p-1 rounded hover:bg-error-subtle text-foreground-muted hover:text-error transition-default',
);

// =============================================================================
// FIELD GROUP
// =============================================================================

function FieldGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-3 border-b border-default/50">
      <dt className="text-xs font-semibold text-foreground-muted uppercase tracking-wider mb-1.5">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

// =============================================================================
// DELEGATE CARD
// =============================================================================

function DelegateCard({
  delegate,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  onBrowse,
  browseLabel,
  readOnly,
}: {
  delegate: DelegateData;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: DelegateData) => void;
  onRemove: () => void;
  onBrowse: () => void;
  browseLabel: string;
  readOnly?: boolean;
}) {
  return (
    <div className={CARD_CLASSES}>
      {/* Collapsed header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-background-subtle/50 transition-default"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
        )}

        <RefreshCw className="w-3.5 h-3.5 shrink-0 text-warning" />

        <span
          className={clsx(
            'text-xs px-1.5 py-0.5 rounded font-medium shrink-0',
            DELEGATE_BADGE_COLOR,
          )}
        >
          DELEGATE
        </span>

        <span className="flex-1 min-w-0">
          <span className="text-xs font-medium text-foreground truncate block">
            {delegate.agent || `Delegate ${index + 1}`}
          </span>
        </span>

        {delegate.when && (
          <span className="text-xs text-foreground-muted truncate max-w-[160px]">
            {delegate.when}
          </span>
        )}
      </button>

      {/* Expanded edit form */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-default pt-2.5">
          <FieldGroup label="Agent Name">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={delegate.agent}
                onChange={(e) => onChange({ ...delegate, agent: e.target.value })}
                placeholder="e.g. research_agent"
                readOnly={readOnly}
                className={clsx(INPUT_CLASSES, 'font-mono flex-1')}
              />
              {!readOnly && (
                <button
                  type="button"
                  onClick={onBrowse}
                  className="text-foreground-muted hover:text-accent transition-default shrink-0 flex items-center gap-1 text-xs"
                  aria-label={browseLabel}
                >
                  <Search className="w-3.5 h-3.5" />
                  {browseLabel}
                </button>
              )}
            </div>
          </FieldGroup>

          <FieldGroup label="When">
            <textarea
              value={delegate.when}
              onChange={(e) => onChange({ ...delegate, when: e.target.value })}
              placeholder="Condition that triggers delegation"
              rows={2}
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono resize-y')}
            />
          </FieldGroup>

          <FieldGroup label="Purpose">
            <input
              type="text"
              value={delegate.purpose}
              onChange={(e) => onChange({ ...delegate, purpose: e.target.value })}
              placeholder="What the delegate agent should accomplish"
              readOnly={readOnly}
              className={INPUT_CLASSES}
            />
          </FieldGroup>

          {!readOnly && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onRemove}
                className={REMOVE_BUTTON_CLASSES}
                aria-label="Remove delegate"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function DelegatesEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'delegates'>) {
  const tPicker = useTranslations('agents.agent_picker');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const { agentPickerOpen, openAgentPicker, closeAgentPicker, selectAgent } = useAgentPicker();

  // Derive local agent list from existing delegate agents for picker display
  const localAgents = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ name: string }> = [];
    for (const d of data) {
      if (d.agent && !seen.has(d.agent)) {
        seen.add(d.agent);
        result.push({ name: d.agent });
      }
    }
    return result;
  }, [data]);

  const handleToggle = useCallback(
    (index: number) => {
      setExpandedIndex(expandedIndex === index ? null : index);
    },
    [expandedIndex],
  );

  const handleChange = useCallback(
    (index: number, updated: DelegateData) => {
      const next = [...data];
      next[index] = updated;
      onChange(next);
    },
    [data, onChange],
  );

  const handleRemove = useCallback(
    (index: number) => {
      onChange(data.filter((_, i) => i !== index));
      if (expandedIndex === index) {
        setExpandedIndex(null);
      }
    },
    [data, onChange, expandedIndex],
  );

  const handleAdd = useCallback(() => {
    onChange([...data, { agent: '', when: '', purpose: '' }]);
    setExpandedIndex(data.length);
  }, [data, onChange]);

  return (
    <>
      <div className="p-4 space-y-3 overflow-y-auto h-full">
        <SectionHeader onArchClick={onArchClick} />
        {/* Delegate list */}
        {data.length > 0 ? (
          <>
            {/* Count header */}
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
                {data.length} delegate{data.length !== 1 ? 's' : ''}
              </h3>
              {!readOnly && (
                <button type="button" onClick={handleAdd} className={ADD_BUTTON_CLASSES}>
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>
            <div className="space-y-2 stagger-children">
              {data.map((delegate, index) => (
                <DelegateCard
                  key={index}
                  delegate={delegate}
                  index={index}
                  isExpanded={expandedIndex === index}
                  onToggle={() => handleToggle(index)}
                  onChange={(updated) => handleChange(index, updated)}
                  onRemove={() => handleRemove(index)}
                  onBrowse={() =>
                    openAgentPicker((name) => handleChange(index, { ...delegate, agent: name }))
                  }
                  browseLabel={tPicker('browse')}
                  readOnly={readOnly}
                />
              ))}
            </div>
          </>
        ) : (
          /* Empty state */
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <RefreshCw className="w-8 h-8 text-foreground-muted/40 mb-3" />
            <p className="text-sm font-medium text-foreground-muted">No delegates defined</p>
            <p className="text-xs text-foreground-subtle mt-1">
              Delegates dispatch sub-tasks to other agents and await results
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={handleAdd}
                className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Delegate
              </button>
            )}
          </div>
        )}
      </div>

      <AgentPickerDialog
        open={agentPickerOpen}
        onClose={closeAgentPicker}
        onSelect={selectAgent}
        localAgents={localAgents}
      />
    </>
  );
}
