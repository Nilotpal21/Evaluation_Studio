'use client';

/**
 * CoordinationSection -- collapsible section for handoffs, delegation, and escalation.
 *
 * Collapsed: shows total coordination count badge and summary text with handoff/delegate counts.
 * Expanded: three sub-sections -- Handoffs (target agent, when condition, summary, returnable),
 * Delegates (target agent, when, purpose), and Escalation (configured indicator) --
 * each with relevant "Add" buttons. All fields are fully editable inline.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowRightLeft,
  Users,
  AlertTriangle,
  Plus,
  Check,
  X,
  Lock,
  Package,
  Search,
} from 'lucide-react';
import clsx from 'clsx';
import { SectionCard } from './SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import type {
  CoordinationSectionData,
  HandoffData,
  DelegateData,
  SaveStatus,
} from '@/store/agent-detail-store';
import { INLINE_INPUT_CLASSES } from './inline-input-classes';
import { useImportedSymbols, type ImportedAgent } from '@/hooks/useImportedSymbols';
import { AgentPickerDialog } from '../abl/pickers/AgentPickerDialog';
import { useAgentPicker } from '../abl/pickers/useAgentPicker';

// =============================================================================
// PROPS
// =============================================================================

export interface CoordinationSectionProps {
  data: CoordinationSectionData;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: CoordinationSectionData) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Single handoff card with editable fields for target agent, when condition, summary, and returnable toggle */
function HandoffCard({
  handoff,
  onChange,
  onRemove,
  onBrowse,
}: {
  handoff: HandoffData;
  onChange: (handoff: HandoffData) => void;
  onRemove: () => void;
  onBrowse: () => void;
}) {
  const t = useTranslations('agents.coordination');
  return (
    <div className="rounded-lg border border-default bg-background-subtle p-3 space-y-3">
      {/* Header: to input + browse + returnable toggle + remove */}
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="w-4 h-4 text-accent shrink-0" />
        <input
          type="text"
          value={handoff.to}
          onChange={(e) => onChange({ ...handoff, to: e.target.value })}
          placeholder={t('target_agent_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
        />
        <button
          type="button"
          onClick={onBrowse}
          className="text-muted hover:text-accent transition-fast shrink-0 flex items-center gap-1 text-xs"
          aria-label={t('browse_agents')}
        >
          <Search className="w-3.5 h-3.5" />
          {t('browse_agents')}
        </button>
        <Toggle
          checked={handoff.returnable}
          onChange={(checked) => onChange({ ...handoff, returnable: checked })}
          label={t('returnable_label')}
          className="shrink-0"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove handoff"
          className="text-muted hover:text-error transition-fast shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* When condition */}
      <div>
        <label className="text-xs text-muted">{t('when_label')}</label>
        <textarea
          value={handoff.when}
          onChange={(e) => onChange({ ...handoff, when: e.target.value })}
          rows={2}
          placeholder={t('handoff_when_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'font-mono resize-y')}
        />
      </div>

      {/* Summary */}
      <div>
        <label className="text-xs text-muted">{t('summary_label')}</label>
        <input
          type="text"
          value={handoff.summary}
          onChange={(e) => onChange({ ...handoff, summary: e.target.value })}
          placeholder={t('summary_placeholder')}
          className={INLINE_INPUT_CLASSES}
        />
      </div>
    </div>
  );
}

/** Single delegate card with editable fields for agent name, when condition, and purpose */
function DelegateCard({
  delegate,
  onChange,
  onRemove,
  onBrowse,
}: {
  delegate: DelegateData;
  onChange: (delegate: DelegateData) => void;
  onRemove: () => void;
  onBrowse: () => void;
}) {
  const t = useTranslations('agents.coordination');
  return (
    <div className="rounded-lg border border-default bg-background-subtle p-3 space-y-3">
      {/* Header: agent name input + browse + remove */}
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-accent shrink-0" />
        <input
          type="text"
          value={delegate.agent}
          onChange={(e) => onChange({ ...delegate, agent: e.target.value })}
          placeholder={t('agent_name_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
        />
        <button
          type="button"
          onClick={onBrowse}
          className="text-muted hover:text-accent transition-fast shrink-0 flex items-center gap-1 text-xs"
          aria-label={t('browse_agents')}
        >
          <Search className="w-3.5 h-3.5" />
          {t('browse_agents')}
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove delegate"
          className="text-muted hover:text-error transition-fast shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* When condition */}
      <div>
        <label className="text-xs text-muted">{t('when_label')}</label>
        <textarea
          value={delegate.when}
          onChange={(e) => onChange({ ...delegate, when: e.target.value })}
          rows={2}
          placeholder={t('delegate_when_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'font-mono resize-y')}
        />
      </div>

      {/* Purpose */}
      <div>
        <label className="text-xs text-muted">{t('purpose_label')}</label>
        <input
          type="text"
          value={delegate.purpose}
          onChange={(e) => onChange({ ...delegate, purpose: e.target.value })}
          placeholder={t('purpose_placeholder')}
          className={INLINE_INPUT_CLASSES}
        />
      </div>
    </div>
  );
}

/** Read-only card showing an imported agent as a potential handoff/delegate target */
function ImportedAgentCard({ agent }: { agent: ImportedAgent }) {
  const tm = useTranslations('modules.badges');
  return (
    <div className="rounded-lg border border-default bg-background-subtle/50 p-3 opacity-80">
      <div className="flex items-center gap-2">
        <Package className="w-4 h-4 text-accent shrink-0" />
        <span className="flex-1 font-mono text-sm text-muted">
          {agent.alias}.{agent.name}
        </span>
        <Badge variant="purple" className="text-xs shrink-0">
          {tm('imported')}
        </Badge>
        <Lock className="w-3 h-3 text-subtle shrink-0" />
      </div>
      <p className="text-xs text-subtle mt-1 pl-6">{tm('fromModule', { alias: agent.alias })}</p>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function CoordinationSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
}: CoordinationSectionProps) {
  const t = useTranslations('agents.coordination');
  const { agents: importedAgents } = useImportedSymbols();
  const handoffCount = data.handoffs.length;
  const delegateCount = data.delegates.length;
  const importedCount = importedAgents.length;
  const totalCount = handoffCount + delegateCount + importedCount;

  const { agentPickerOpen, openAgentPicker, closeAgentPicker, selectAgent } = useAgentPicker();

  // Derive local agent list from handoffs/delegates for picker display
  const localAgents = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ name: string; description?: string }> = [];
    for (const h of data.handoffs) {
      if (h.to && !seen.has(h.to)) {
        seen.add(h.to);
        result.push({ name: h.to });
      }
    }
    for (const d of data.delegates) {
      if (d.agent && !seen.has(d.agent)) {
        seen.add(d.agent);
        result.push({ name: d.agent });
      }
    }
    return result;
  }, [data.handoffs, data.delegates]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleHandoffChange = useCallback(
    (index: number, handoff: HandoffData) => {
      const updated = [...data.handoffs];
      updated[index] = handoff;
      onChange({ ...data, handoffs: updated });
    },
    [data, onChange],
  );

  const handleRemoveHandoff = useCallback(
    (index: number) => {
      onChange({ ...data, handoffs: data.handoffs.filter((_, i) => i !== index) });
    },
    [data, onChange],
  );

  const handleAddHandoff = useCallback(() => {
    onChange({
      ...data,
      handoffs: [...data.handoffs, { to: '', when: '', summary: '', returnable: false }],
    });
  }, [data, onChange]);

  const handleDelegateChange = useCallback(
    (index: number, delegate: DelegateData) => {
      const updated = [...data.delegates];
      updated[index] = delegate;
      onChange({ ...data, delegates: updated });
    },
    [data, onChange],
  );

  const handleRemoveDelegate = useCallback(
    (index: number) => {
      onChange({ ...data, delegates: data.delegates.filter((_, i) => i !== index) });
    },
    [data, onChange],
  );

  const handleAddDelegate = useCallback(() => {
    onChange({ ...data, delegates: [...data.delegates, { agent: '', when: '', purpose: '' }] });
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Collapsed summary: handoff count + delegate count text
  // ---------------------------------------------------------------------------

  const summaryParts: string[] = [];
  if (handoffCount > 0) {
    summaryParts.push(t('handoffs_summary', { count: handoffCount }));
  }
  if (delegateCount > 0) {
    summaryParts.push(t('delegates_summary', { count: delegateCount }));
  }

  const summaryContent =
    summaryParts.length > 0 ? (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <ArrowRightLeft className="w-3 h-3" />
        {summaryParts.join(', ')}
      </span>
    ) : undefined;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <>
      <SectionCard
        title={t('title')}
        sectionId="COORDINATION"
        count={totalCount}
        isExpanded={isExpanded}
        onToggle={onToggle}
        onArchClick={onArchClick}
        summary={summaryContent}
        saveStatus={saveStatus}
        isEmpty={totalCount === 0 && data.escalation.triggers.length === 0}
      >
        <div className="space-y-6">
          {/* Handoffs sub-section */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-accent" />
              <h4 className="text-sm font-semibold text-foreground">{t('handoffs_title')}</h4>
              {handoffCount > 0 && <span className="text-xs text-muted">({handoffCount})</span>}
            </div>

            {handoffCount > 0 ? (
              <div className="space-y-2">
                {data.handoffs.map((handoff, index) => (
                  <HandoffCard
                    key={`handoff-${index}`}
                    handoff={handoff}
                    onChange={(updated) => handleHandoffChange(index, updated)}
                    onRemove={() => handleRemoveHandoff(index)}
                    onBrowse={() =>
                      openAgentPicker((name) =>
                        handleHandoffChange(index, { ...handoff, to: name }),
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted italic pl-6">{t('no_handoffs')}</p>
            )}

            {/* Add Handoff button */}
            <button
              type="button"
              aria-label="Add Handoff"
              onClick={handleAddHandoff}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-2 rounded-lg',
                'border border-dashed border-default text-muted',
                'hover:border-accent hover:text-accent transition-fast',
                'text-sm font-medium btn-press',
              )}
            >
              <Plus className="w-4 h-4" />
              {t('add_handoff')}
            </button>
          </div>

          {/* Delegates sub-section */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-accent" />
              <h4 className="text-sm font-semibold text-foreground">{t('delegates_title')}</h4>
              {delegateCount > 0 && <span className="text-xs text-muted">({delegateCount})</span>}
            </div>

            {delegateCount > 0 ? (
              <div className="space-y-2">
                {data.delegates.map((delegate, index) => (
                  <DelegateCard
                    key={`delegate-${index}`}
                    delegate={delegate}
                    onChange={(updated) => handleDelegateChange(index, updated)}
                    onRemove={() => handleRemoveDelegate(index)}
                    onBrowse={() =>
                      openAgentPicker((name) =>
                        handleDelegateChange(index, { ...delegate, agent: name }),
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted italic pl-6">{t('no_delegates')}</p>
            )}

            {/* Add Delegate button */}
            <button
              type="button"
              aria-label="Add Delegate"
              onClick={handleAddDelegate}
              className={clsx(
                'w-full flex items-center justify-center gap-2 py-2 rounded-lg',
                'border border-dashed border-default text-muted',
                'hover:border-accent hover:text-accent transition-fast',
                'text-sm font-medium btn-press',
              )}
            >
              <Plus className="w-4 h-4" />
              {t('add_delegate')}
            </button>
          </div>

          {/* Imported agents sub-section (read-only targets from modules) */}
          {importedAgents.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Package className="w-4 h-4 text-accent" />
                <h4 className="text-sm font-semibold text-foreground">
                  {t('imported_agents_title')}
                </h4>
                <span className="text-xs text-muted">({importedAgents.length})</span>
                <Lock className="w-3 h-3 text-subtle ml-auto" />
              </div>
              <div className="space-y-2">
                {importedAgents.map((agent) => (
                  <ImportedAgentCard
                    key={`imported-${agent.dependencyId}-${agent.name}`}
                    agent={agent}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Escalation sub-section */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-warning" />
              <h4 className="text-sm font-semibold text-foreground">{t('escalation_title')}</h4>
            </div>

            {data.escalation.triggers.length > 0 ? (
              <div className="pl-6">
                <Badge variant="warning" dot>
                  {t('escalation_configured')}
                </Badge>
              </div>
            ) : (
              <p className="text-xs text-muted italic pl-6">{t('no_escalation')}</p>
            )}
          </div>
        </div>
      </SectionCard>

      <AgentPickerDialog
        open={agentPickerOpen}
        onClose={closeAgentPicker}
        onSelect={selectAgent}
        localAgents={localAgents}
      />
    </>
  );
}
