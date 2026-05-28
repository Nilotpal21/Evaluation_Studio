'use client';

/**
 * FlowEditor -- section editor for agent flow steps (deterministic and reasoning).
 *
 * Renders the entry point selector, a list of step cards with expand/collapse,
 * and handles the null-data case (no flow defined).
 * No accordion wrapper.
 */

import React, { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  GitBranch,
  ArrowRight,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Zap,
  Database,
  Workflow,
  Brain,
} from 'lucide-react';
import clsx from 'clsx';
import { Toggle } from '../../ui/Toggle';
import { Select } from '../../ui/Select';
import type { SectionEditorProps } from '../types';
import type { FlowStepData } from '@/store/agent-detail-store';
import { FlowMiniGraph } from '@/components/agent-detail/FlowMiniGraph';
import { SectionHeader } from './SectionHeader';

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
// STEP CARD
// =============================================================================

interface StepCardProps {
  step: FlowStepData;
  isEntry: boolean;
  onChange: (step: FlowStepData) => void;
  onRemove: () => void;
  onSetEntry: () => void;
  readOnly?: boolean;
}

function StepCard({ step, isEntry, onChange, onRemove, onSetEntry, readOnly }: StepCardProps) {
  const t = useTranslations('agent_editor.flow');
  const [expanded, setExpanded] = useState(false);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleFieldChange = useCallback(
    (field: keyof FlowStepData, value: string | boolean | number | string[] | undefined) => {
      onChange({ ...step, [field]: value });
    },
    [step, onChange],
  );

  return (
    <div
      className={clsx(
        'rounded-lg border overflow-hidden shadow-sm',
        isEntry ? 'border-accent/40' : 'border-default',
        step.reasoning ? 'ring-1 ring-accent/20' : '',
        'bg-background-muted',
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          onClick={handleToggle}
          className="shrink-0 text-foreground-muted hover:text-foreground transition-fast"
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>

        {/* Step name */}
        <span className="font-mono text-sm font-medium text-foreground truncate">{step.name}</span>

        {/* Entry badge */}
        {isEntry && (
          <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium shrink-0">
            {t('entry_badge')}
          </span>
        )}

        {/* Execution mode badge */}
        {step.reasoning ? (
          <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium shrink-0">
            <Brain className="w-3 h-3" />
            {t('reasoning_badge')}
          </span>
        ) : (
          <span className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-foreground-muted/10 text-foreground-muted font-medium shrink-0">
            {t('deterministic_badge')}
          </span>
        )}

        {/* Gather / branching badges */}
        {step.hasGather && (
          <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-info/10 text-info font-medium shrink-0">
            <Database className="w-3 h-3" />
            {t('gather_badge')}
          </span>
        )}
        {step.hasBranching && (
          <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium shrink-0">
            <GitBranch className="w-3 h-3" />
            {t('branch_badge')}
          </span>
        )}

        {/* Respond preview (collapsed) */}
        {!expanded && step.respond && (
          <span className="text-xs text-foreground-muted truncate ml-1 hidden sm:inline">
            {step.respond}
          </span>
        )}

        {/* Then arrow (collapsed) */}
        {!expanded && step.then && (
          <span className="ml-auto flex items-center gap-1 text-xs text-foreground-muted shrink-0">
            <ArrowRight className="w-3 h-3" />
            <span className="font-mono">{step.then}</span>
          </span>
        )}

        {/* Remove button */}
        {!readOnly && (
          <button
            type="button"
            onClick={onRemove}
            className={clsx(
              'p-0.5 rounded hover:bg-error/10 hover:text-error transition-fast shrink-0',
              !expanded && step.then ? '' : 'ml-auto',
            )}
            aria-label={`Remove step ${step.name}`}
          >
            <X className="w-3.5 h-3.5 text-foreground-muted hover:text-error" />
          </button>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-default pt-3">
          {/* Step name (editable) */}
          <FieldGroup label={t('step_name_label')}>
            {readOnly ? (
              <span className="font-mono text-sm text-foreground">{step.name}</span>
            ) : (
              <input
                type="text"
                value={step.name}
                onChange={(e) => handleFieldChange('name', e.target.value)}
                placeholder="step_name"
                className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none font-mono"
              />
            )}
          </FieldGroup>

          {/* Set as entry point */}
          {!isEntry && !readOnly && (
            <button
              type="button"
              onClick={onSetEntry}
              className="text-xs text-accent hover:text-accent/80 transition-fast font-medium"
            >
              {t('set_as_entry')}
            </button>
          )}

          {/* REASONING mode toggle */}
          <FieldGroup label={t('execution_mode_label')}>
            <div className="flex items-center gap-3">
              <Toggle
                checked={step.reasoning}
                onChange={(val) => handleFieldChange('reasoning', val)}
                disabled={readOnly}
              />
              <span className="text-xs font-medium text-foreground">
                {step.reasoning ? (
                  <span className="flex items-center gap-1 text-accent">
                    <Brain className="w-3 h-3" /> {t('reasoning_llm')}
                  </span>
                ) : (
                  t('deterministic_badge')
                )}
              </span>
            </div>
          </FieldGroup>

          {/* Reasoning-specific fields (visible only when reasoning: true) */}
          {step.reasoning && (
            <>
              {/* Step-level GOAL */}
              <FieldGroup label={t('step_goal_label')}>
                <textarea
                  value={step.goal ?? ''}
                  onChange={(e) => handleFieldChange('goal', e.target.value || undefined)}
                  placeholder={t('step_goal_placeholder')}
                  rows={2}
                  readOnly={readOnly}
                  className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none resize-y"
                />
              </FieldGroup>

              {/* EXIT_WHEN */}
              <FieldGroup label={t('exit_when_label')}>
                <input
                  type="text"
                  value={step.exitWhen ?? ''}
                  onChange={(e) => handleFieldChange('exitWhen', e.target.value || undefined)}
                  placeholder="e.g., selected_card != null"
                  readOnly={readOnly}
                  className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none font-mono"
                />
              </FieldGroup>

              {/* MAX_TURNS */}
              <FieldGroup label={t('max_turns_label')}>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={step.maxTurns ?? 10}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      handleFieldChange('maxTurns', Number.isNaN(v) ? undefined : v);
                    }}
                    readOnly={readOnly}
                    className="w-24 text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none font-mono"
                  />
                  <span className="text-xs text-foreground-subtle">{t('max_turns_default')}</span>
                </div>
              </FieldGroup>
            </>
          )}

          {/* Respond */}
          <FieldGroup label={t('respond_label')}>
            <div className="flex items-start gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-foreground-muted mt-0.5 shrink-0" />
              {readOnly ? (
                <p className="text-sm text-foreground whitespace-pre-wrap">
                  {step.respond || (
                    <span className="text-foreground-subtle italic">{t('none')}</span>
                  )}
                </p>
              ) : (
                <textarea
                  value={step.respond ?? ''}
                  onChange={(e) => handleFieldChange('respond', e.target.value)}
                  placeholder={t('respond_placeholder')}
                  rows={2}
                  className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none resize-y"
                />
              )}
            </div>
          </FieldGroup>

          {/* Call */}
          <FieldGroup label={t('call_label')}>
            <div className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
              {readOnly ? (
                <span className="font-mono text-sm text-foreground">
                  {step.call || <span className="text-foreground-subtle italic">{t('none')}</span>}
                </span>
              ) : (
                <input
                  type="text"
                  value={step.call ?? ''}
                  onChange={(e) => handleFieldChange('call', e.target.value)}
                  placeholder="tool_name"
                  className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none font-mono"
                />
              )}
            </div>
          </FieldGroup>

          {/* Then (next step) */}
          <FieldGroup label={t('then_label')}>
            <div className="flex items-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
              {readOnly ? (
                <span className="font-mono text-sm text-foreground">
                  {step.then || <span className="text-foreground-subtle italic">{t('none')}</span>}
                </span>
              ) : (
                <input
                  type="text"
                  value={step.then ?? ''}
                  onChange={(e) => handleFieldChange('then', e.target.value)}
                  placeholder="next_step"
                  className="w-full text-sm text-foreground bg-transparent placeholder:text-foreground-subtle focus:outline-none font-mono"
                />
              )}
            </div>
          </FieldGroup>

          {/* Gather / branching indicators */}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <Database className="w-3 h-3" />
              {t('gather_indicator', { value: step.hasGather ? 'Yes' : 'No' })}
            </label>
            <label className="flex items-center gap-1.5 text-xs text-foreground-muted">
              <GitBranch className="w-3 h-3" />
              {t('branching_indicator', { value: step.hasBranching ? 'Yes' : 'No' })}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function FlowEditor({ data, onChange, readOnly, onArchClick }: SectionEditorProps<'flow'>) {
  const t = useTranslations('agent_editor.flow');
  // ---------------------------------------------------------------------------
  // Null state (no flow defined)
  // ---------------------------------------------------------------------------

  if (data === null) {
    const handleEnableFlow = () => {
      onChange({
        steps: [{ name: 'start', hasGather: false, hasBranching: false, reasoning: false }],
        entryPoint: 'start',
      });
    };

    return (
      <div className="p-4 space-y-3 overflow-y-auto h-full">
        <SectionHeader onArchClick={onArchClick} />
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Workflow className="w-8 h-8 text-foreground-muted mb-2" />
          <p className="text-sm text-foreground-muted">{t('no_flow_defined')}</p>
          <p className="text-xs text-foreground-subtle mt-0.5 max-w-[280px]">{t('no_flow_hint')}</p>
          {!readOnly && (
            <button
              type="button"
              onClick={handleEnableFlow}
              className={clsx(
                'mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg',
                'bg-accent text-accent-foreground text-sm font-medium',
                'hover:opacity-90 transition-fast',
              )}
            >
              <Plus className="w-4 h-4" />
              {t('enable_flow')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleStepChange = (index: number, step: FlowStepData) => {
    const updated = [...data.steps];
    const oldName = data.steps[index].name;
    updated[index] = step;
    const newEntryPoint = data.entryPoint === oldName ? step.name : data.entryPoint;
    onChange({ steps: updated, entryPoint: newEntryPoint });
  };

  const handleRemoveStep = (index: number) => {
    const removedName = data.steps[index].name;
    const newSteps = data.steps.filter((_, i) => i !== index);
    let newEntryPoint = data.entryPoint;
    if (removedName === data.entryPoint) {
      newEntryPoint = newSteps[0]?.name ?? '';
    }
    onChange({ steps: newSteps, entryPoint: newEntryPoint });
  };

  const handleSetEntry = (stepName: string) => {
    onChange({ ...data, entryPoint: stepName });
  };

  const handleAddStep = () => {
    const name = `step_${data.steps.length + 1}`;
    const newStep: FlowStepData = { name, hasGather: false, hasBranching: false, reasoning: false };
    const newSteps = [...data.steps, newStep];
    onChange({
      steps: newSteps,
      entryPoint: data.entryPoint || name,
    });
  };

  const handleEntryPointChange = (value: string) => {
    onChange({ ...data, entryPoint: value });
  };

  const stepCount = data.steps.length;
  const reasoningCount = data.steps.filter((s) => s.reasoning).length;
  const deterministicCount = stepCount - reasoningCount;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="p-4 space-y-3 overflow-y-auto h-full">
      <SectionHeader onArchClick={onArchClick} />
      {/* Entry point selector */}
      {stepCount > 0 && (
        <FieldGroup label={t('entry_point_label')}>
          <Select
            options={data.steps.map((step) => ({ value: step.name, label: step.name }))}
            value={data.entryPoint}
            onChange={handleEntryPointChange}
            disabled={readOnly}
          />
        </FieldGroup>
      )}

      {/* Flow mini graph visualization */}
      {stepCount > 0 && (
        <div className="rounded-lg border border-default bg-background-muted p-3 shadow-sm">
          <FlowMiniGraph data={data} compact={true} />
        </div>
      )}

      {/* Step count header with reasoning summary */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-foreground-muted uppercase tracking-wider">
          {t('steps_count', { count: stepCount })}
        </h4>
        {stepCount > 0 && (
          <span className="text-xs text-foreground-subtle">
            {t('deterministic_count', { count: deterministicCount })}
            {reasoningCount > 0 ? ` ${t('reasoning_count', { count: reasoningCount })}` : ''}
          </span>
        )}
      </div>

      {/* Step list */}
      {stepCount > 0 ? (
        <div className="space-y-2 stagger-children">
          {data.steps.map((step, index) => (
            <StepCard
              key={index}
              step={step}
              isEntry={step.name === data.entryPoint}
              onChange={(updated) => handleStepChange(index, updated)}
              onRemove={() => handleRemoveStep(index)}
              onSetEntry={() => handleSetEntry(step.name)}
              readOnly={readOnly}
            />
          ))}
        </div>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Workflow className="w-8 h-8 text-foreground-muted mb-2" />
          <p className="text-sm text-foreground-muted">{t('no_steps_defined')}</p>
          <p className="text-xs text-foreground-subtle mt-0.5">{t('no_steps_hint')}</p>
        </div>
      )}

      {/* Add step button */}
      {!readOnly && (
        <button
          type="button"
          onClick={handleAddStep}
          className={clsx(
            'w-full flex items-center justify-center gap-2 py-2.5 rounded-lg',
            'border border-dashed border-default text-foreground-muted',
            'hover:border-accent hover:text-accent transition-fast',
            'text-sm font-medium',
          )}
        >
          <Plus className="w-4 h-4" />
          {t('add_step')}
        </button>
      )}
    </div>
  );
}
