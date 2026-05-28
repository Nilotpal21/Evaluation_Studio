'use client';

/**
 * HandoffsEditor
 *
 * Section editor for agent handoffs. Each handoff transfers control to
 * another agent with a condition, summary text, and an optional return flag.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronRight, Plus, Trash2, ArrowRight, Search } from 'lucide-react';
import clsx from 'clsx';
import { Toggle } from '../../ui/Toggle';
import type { SectionEditorProps, HandoffData } from '../types';
import { SectionHeader } from './SectionHeader';
import { AgentPickerDialog } from '../../abl/pickers/AgentPickerDialog';
import { useAgentPicker } from '../../abl/pickers/useAgentPicker';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Handoff badge color matching the canvas edge color */
const HANDOFF_BADGE_COLOR = 'bg-info/15 text-info';

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
// HANDOFF CARD
// =============================================================================

function HandoffCard({
  handoff,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
  onBrowse,
  browseLabel,
  readOnly,
}: {
  handoff: HandoffData;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: HandoffData) => void;
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

        <ArrowRight className="w-3.5 h-3.5 shrink-0 text-info" />

        <span
          className={clsx(
            'text-xs px-1.5 py-0.5 rounded font-medium shrink-0',
            HANDOFF_BADGE_COLOR,
          )}
        >
          HANDOFF
        </span>

        <span className="flex-1 min-w-0">
          <span className="text-xs font-medium text-foreground truncate block">
            {handoff.to || `Handoff ${index + 1}`}
          </span>
        </span>

        {handoff.returnable && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-success-subtle text-success shrink-0">
            returnable
          </span>
        )}

        {handoff.when && (
          <span className="text-xs text-foreground-muted truncate max-w-[160px]">
            {handoff.when}
          </span>
        )}
      </button>

      {/* Expanded edit form */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-default pt-2.5">
          <FieldGroup label="Target Agent">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={handoff.to}
                onChange={(e) => onChange({ ...handoff, to: e.target.value })}
                placeholder="e.g. billing_agent"
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

          <FieldGroup label="Condition (expression)">
            <textarea
              value={handoff.when}
              onChange={(e) => onChange({ ...handoff, when: e.target.value })}
              placeholder='e.g. input contains "lookup" or intent.category == "billing"'
              rows={2}
              readOnly={readOnly}
              className={clsx(INPUT_CLASSES, 'font-mono resize-y')}
            />
          </FieldGroup>

          <FieldGroup label="Summary">
            <input
              type="text"
              value={handoff.summary}
              onChange={(e) => onChange({ ...handoff, summary: e.target.value })}
              placeholder="Context passed to the target agent"
              readOnly={readOnly}
              className={INPUT_CLASSES}
            />
          </FieldGroup>

          <div className="flex items-center gap-2 px-1">
            <Toggle
              checked={handoff.returnable}
              onChange={(checked) => onChange({ ...handoff, returnable: checked })}
              disabled={readOnly}
              label="Returnable"
            />
            <span className="text-xs text-foreground-subtle">
              Allow the target agent to return control
            </span>
          </div>

          {!readOnly && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={onRemove}
                className={REMOVE_BUTTON_CLASSES}
                aria-label="Remove handoff"
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

export function HandoffsEditor({
  data,
  onChange,
  readOnly,
  onArchClick,
}: SectionEditorProps<'handoffs'>) {
  const tPicker = useTranslations('agents.agent_picker');
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const { agentPickerOpen, openAgentPicker, closeAgentPicker, selectAgent } = useAgentPicker();

  // Derive local agent list from existing handoff targets for picker display
  const localAgents = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ name: string }> = [];
    for (const h of data) {
      if (h.to && !seen.has(h.to)) {
        seen.add(h.to);
        result.push({ name: h.to });
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
    (index: number, updated: HandoffData) => {
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
    onChange([...data, { to: '', when: '', summary: '', returnable: false }]);
    setExpandedIndex(data.length);
  }, [data, onChange]);

  return (
    <>
      <div className="p-4 space-y-3 overflow-y-auto h-full">
        <SectionHeader onArchClick={onArchClick} />
        {/* Handoff list */}
        {data.length > 0 ? (
          <>
            {/* Count header */}
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
                {data.length} handoff{data.length !== 1 ? 's' : ''}
              </h3>
              {!readOnly && (
                <button type="button" onClick={handleAdd} className={ADD_BUTTON_CLASSES}>
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              )}
            </div>
            <div className="space-y-2 stagger-children">
              {data.map((handoff, index) => (
                <HandoffCard
                  key={index}
                  handoff={handoff}
                  index={index}
                  isExpanded={expandedIndex === index}
                  onToggle={() => handleToggle(index)}
                  onChange={(updated) => handleChange(index, updated)}
                  onRemove={() => handleRemove(index)}
                  onBrowse={() =>
                    openAgentPicker((name) => handleChange(index, { ...handoff, to: name }))
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
            <ArrowRight className="w-8 h-8 text-foreground-muted/40 mb-3" />
            <p className="text-sm font-medium text-foreground-muted">No handoffs defined</p>
            <p className="text-xs text-foreground-subtle mt-1">
              Handoffs transfer control to another agent
            </p>
            {!readOnly && (
              <button
                type="button"
                onClick={handleAdd}
                className="inline-flex items-center gap-1.5 mt-4 px-3 py-1.5 rounded-md text-xs font-medium text-accent border border-accent/30 hover:bg-accent-subtle transition-default"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Handoff
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
