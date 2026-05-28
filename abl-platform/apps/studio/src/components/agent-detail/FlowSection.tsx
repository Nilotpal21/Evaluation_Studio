'use client';

/**
 * FlowSection -- collapsible section for scripted agent flow steps.
 *
 * Collapsed: shows step count badge and a compact FlowMiniGraph.
 * Expanded: full-size FlowMiniGraph at top + step editor cards below.
 * Each step card is fully editable: name, respond, call, then,
 * with indicator badges for gather / branching.
 *
 * This section is only visible for scripted mode agents (flow data is
 * null for reasoning agents).
 */

import React, { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { GitBranch, ArrowRight, Plus, Database, MessageSquare, Zap, X } from 'lucide-react';
import clsx from 'clsx';
import { SectionCard } from './SectionCard';
import { FlowMiniGraph } from './FlowMiniGraph';
import { Badge } from '@/components/ui/Badge';
import type { FlowSectionData, FlowStepData, SaveStatus } from '@/store/agent-detail-store';

import { INLINE_INPUT_CLASSES } from './inline-input-classes';

// =============================================================================
// PROPS
// =============================================================================

export interface FlowSectionProps {
  data: FlowSectionData;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: FlowSectionData) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Single step editor card (fully editable) */
function StepCard({
  step,
  isEntry,
  onChange,
  onRemove,
  onSetEntry,
}: {
  step: FlowStepData;
  isEntry: boolean;
  onChange: (step: FlowStepData) => void;
  onRemove: () => void;
  onSetEntry: () => void;
}) {
  const t = useTranslations('agents.flow');
  const handleFieldChange = useCallback(
    (field: keyof FlowStepData, value: string) => {
      onChange({ ...step, [field]: value });
    },
    [step, onChange],
  );

  return (
    <div
      className={clsx(
        'rounded-lg border bg-background-subtle p-4 space-y-3',
        isEntry ? 'border-accent/40' : 'border-default',
        'transition-fast hover:border-accent/30',
      )}
    >
      {/* Header: name input + entry badge + set entry button + remove */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={step.name}
          onChange={(e) => handleFieldChange('name', e.target.value)}
          placeholder={t('step_name_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
        />
        {isEntry && (
          <Badge variant="accent" className="text-xs shrink-0">
            {t('entry_badge')}
          </Badge>
        )}
        {!isEntry && (
          <button
            type="button"
            onClick={onSetEntry}
            className="text-xs text-muted hover:text-accent transition-fast whitespace-nowrap"
          >
            {t('set_entry')}
          </button>
        )}
        <div className="flex items-center gap-1.5 shrink-0">
          {step.hasGather && (
            <Badge variant="info" className="text-xs">
              <Database className="w-3 h-3 mr-0.5" />
              {t('gather_badge')}
            </Badge>
          )}
          {step.hasBranching && (
            <Badge variant="warning" className="text-xs">
              <GitBranch className="w-3 h-3 mr-0.5" />
              {t('branching_badge')}
            </Badge>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-muted hover:text-error transition-fast shrink-0"
          aria-label="Remove step"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Respond textarea */}
      <div className="space-y-1">
        <label className="text-xs text-muted flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" />
          {t('respond_label')}
        </label>
        <textarea
          value={step.respond ?? ''}
          onChange={(e) => handleFieldChange('respond', e.target.value)}
          placeholder={t('respond_placeholder')}
          rows={2}
          className={INLINE_INPUT_CLASSES}
        />
      </div>

      {/* Call + Then row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            {t('call_label')}
          </label>
          <input
            type="text"
            value={step.call ?? ''}
            onChange={(e) => handleFieldChange('call', e.target.value)}
            placeholder={t('call_placeholder')}
            className={clsx(INLINE_INPUT_CLASSES, 'font-mono')}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted flex items-center gap-1.5">
            <ArrowRight className="w-3.5 h-3.5" />
            {t('then_label')}
          </label>
          <input
            type="text"
            value={step.then ?? ''}
            onChange={(e) => handleFieldChange('then', e.target.value)}
            placeholder={t('then_placeholder')}
            className={clsx(INLINE_INPUT_CLASSES, 'font-mono')}
          />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function FlowSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
}: FlowSectionProps) {
  const t = useTranslations('agents.flow');
  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleStepChange = useCallback(
    (index: number, step: FlowStepData) => {
      const updated = [...data.steps];
      // If this step was the entry point and name changed, update entryPoint
      const oldName = data.steps[index].name;
      updated[index] = step;
      const newEntryPoint = data.entryPoint === oldName ? step.name : data.entryPoint;
      onChange({ steps: updated, entryPoint: newEntryPoint });
    },
    [data, onChange],
  );

  const handleRemoveStep = useCallback(
    (index: number) => {
      const removedName = data.steps[index].name;
      const newSteps = data.steps.filter((_, i) => i !== index);
      let newEntryPoint = data.entryPoint;
      if (removedName === data.entryPoint) {
        newEntryPoint = newSteps[0]?.name ?? '';
      }
      onChange({ steps: newSteps, entryPoint: newEntryPoint });
    },
    [data, onChange],
  );

  const handleSetEntry = useCallback(
    (stepName: string) => {
      onChange({ ...data, entryPoint: stepName });
    },
    [data, onChange],
  );

  const handleAddStep = useCallback(() => {
    const name = `step_${data.steps.length + 1}`;
    const newStep: FlowStepData = { name, hasGather: false, hasBranching: false, reasoning: false };
    const newSteps = [...data.steps, newStep];
    onChange({
      steps: newSteps,
      entryPoint: data.entryPoint || name,
    });
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Collapsed summary: compact mini flow graph
  // ---------------------------------------------------------------------------

  const summaryContent =
    data.steps.length > 0 ? <FlowMiniGraph data={data} compact={true} /> : undefined;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SectionCard
      title={t('title')}
      sectionId="FLOW"
      count={data.steps.length}
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      summary={summaryContent}
      saveStatus={saveStatus}
      isEmpty={data.steps.length === 0}
    >
      <div className="space-y-4">
        {/* Full flow graph at top */}
        {data.steps.length > 0 && (
          <div className="rounded-lg border border-default bg-background-muted p-3">
            <FlowMiniGraph data={data} compact={false} />
          </div>
        )}

        {/* Step editor list */}
        {data.steps.length > 0 ? (
          <div className="space-y-3">
            {data.steps.map((step, index) => (
              <StepCard
                key={`step-${index}`}
                step={step}
                isEntry={step.name === data.entryPoint}
                onChange={(updated) => handleStepChange(index, updated)}
                onRemove={() => handleRemoveStep(index)}
                onSetEntry={() => handleSetEntry(step.name)}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted italic py-2">{t('empty_steps')}</p>
        )}

        {/* Add Step button */}
        <button
          type="button"
          aria-label="Add Step"
          onClick={handleAddStep}
          className={clsx(
            'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg',
            'border border-dashed border-default text-muted',
            'hover:border-accent hover:text-accent transition-fast',
            'text-sm font-medium btn-press',
          )}
        >
          <Plus className="w-4 h-4" />
          {t('add_step')}
        </button>
      </div>
    </SectionCard>
  );
}
