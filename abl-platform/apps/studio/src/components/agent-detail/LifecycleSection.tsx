'use client';

/**
 * LifecycleSection -- collapsible section for ON_START, Error Handlers,
 * Completion, Memory, and Hooks configuration.
 *
 * Collapsed: shows total lifecycle item count badge and summary text with
 * hook count and completion preview.
 * Expanded: five sub-sections -- ON_START (respond + call action),
 * Error Handlers (type, respond, then), Completion (when, respond),
 * Memory (session vars, persistent paths, remember/recall counts),
 * and Hooks (configured hook names). ON_START, Error Handlers, and
 * Completion are fully editable inline. Memory and Hooks remain read-only.
 */

import React, { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Play, AlertCircle, CheckCircle, Brain, Webhook, Plus, X } from 'lucide-react';
import clsx from 'clsx';
import { SectionCard } from './SectionCard';
import { Badge } from '@/components/ui/Badge';
import { Toggle } from '@/components/ui/Toggle';
import type {
  LifecycleSectionData,
  ErrorHandlerData,
  CompletionConditionData,
  MemoryConfigData,
  SaveStatus,
} from '@/store/agent-detail-store';

import { INLINE_INPUT_CLASSES, INLINE_SELECT_CLASSES } from './inline-input-classes';

// =============================================================================
// PROPS
// =============================================================================

export interface LifecycleSectionProps {
  data: LifecycleSectionData;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (data: LifecycleSectionData) => void;
  onArchClick?: () => void;
  saveStatus?: SaveStatus;
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/** Single error handler card with editable type, respond text, and then action */
function ErrorHandlerCard({
  handler,
  onChange,
  onRemove,
}: {
  handler: ErrorHandlerData;
  onChange: (handler: ErrorHandlerData) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('agents.lifecycle_section');
  return (
    <div className="rounded-lg border border-default bg-background-subtle p-3 space-y-2">
      {/* Header: type input + remove */}
      <div className="flex items-center gap-2">
        <AlertCircle className="w-4 h-4 text-error shrink-0" />
        <input
          type="text"
          value={handler.type}
          onChange={(e) => onChange({ ...handler, type: e.target.value })}
          placeholder={t('error_type_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono')}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove error handler"
          className="text-muted hover:text-error transition-fast shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Respond textarea */}
      <textarea
        value={handler.respond || ''}
        onChange={(e) => onChange({ ...handler, respond: e.target.value || undefined })}
        rows={2}
        placeholder={t('error_respond_placeholder')}
        className={clsx(INLINE_INPUT_CLASSES, 'resize-y')}
      />

      {/* Then select */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">{t('then_label')}</span>
        <select
          value={handler.then}
          onChange={(e) => onChange({ ...handler, then: e.target.value })}
          className={INLINE_SELECT_CLASSES}
        >
          <option value="continue">continue</option>
          <option value="stop">stop</option>
          <option value="retry">retry</option>
          <option value="escalate">escalate</option>
        </select>
      </div>
    </div>
  );
}

/** Single completion condition card with editable when expression and respond text */
function CompletionCard({
  condition,
  onChange,
  onRemove,
}: {
  condition: CompletionConditionData;
  onChange: (condition: CompletionConditionData) => void;
  onRemove: () => void;
}) {
  const t = useTranslations('agents.lifecycle_section');
  return (
    <div className="rounded-lg border border-default bg-background-subtle p-3 space-y-2">
      {/* Header: when textarea + remove */}
      <div className="flex items-start gap-2">
        <CheckCircle className="w-4 h-4 text-success shrink-0 mt-1" />
        <textarea
          value={condition.when}
          onChange={(e) => onChange({ ...condition, when: e.target.value })}
          rows={2}
          placeholder={t('completion_when_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'flex-1 font-mono resize-y')}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove completion condition"
          className="text-muted hover:text-error transition-fast shrink-0 mt-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Respond textarea */}
      <div className="pl-6">
        <label className="text-xs text-muted">{t('completion_respond_label')}</label>
        <textarea
          value={condition.respond || ''}
          onChange={(e) => onChange({ ...condition, respond: e.target.value || undefined })}
          rows={2}
          placeholder={t('completion_respond_placeholder')}
          className={clsx(INLINE_INPUT_CLASSES, 'resize-y')}
        />
      </div>
    </div>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function LifecycleSection({
  data,
  isExpanded,
  onToggle,
  onChange,
  onArchClick,
  saveStatus,
}: LifecycleSectionProps) {
  const t = useTranslations('agents.lifecycle_section');
  const hookCount = data.hooks.length;
  const errorCount = data.errorHandlers.length;
  const completionCount = data.completionConditions.length;

  // Total count for badge: ON_START counts as 1 if present + errors + completions + hooks
  const totalCount = (data.hasOnStart ? 1 : 0) + errorCount + completionCount + hookCount;

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleToggleOnStart = useCallback(() => {
    onChange({ ...data, hasOnStart: !data.hasOnStart });
  }, [data, onChange]);

  const handleOnStartRespondChange = useCallback(
    (value: string) => {
      onChange({ ...data, onStartRespond: value });
    },
    [data, onChange],
  );

  const handleOnStartCallChange = useCallback(
    (value: string) => {
      onChange({ ...data, onStartCall: value });
    },
    [data, onChange],
  );

  const handleErrorChange = useCallback(
    (index: number, handler: ErrorHandlerData) => {
      const updated = [...data.errorHandlers];
      updated[index] = handler;
      onChange({ ...data, errorHandlers: updated });
    },
    [data, onChange],
  );

  const handleRemoveError = useCallback(
    (index: number) => {
      onChange({ ...data, errorHandlers: data.errorHandlers.filter((_, i) => i !== index) });
    },
    [data, onChange],
  );

  const handleAddError = useCallback(() => {
    onChange({ ...data, errorHandlers: [...data.errorHandlers, { type: '', then: 'continue' }] });
  }, [data, onChange]);

  const handleCompletionChange = useCallback(
    (index: number, condition: CompletionConditionData) => {
      const updated = [...data.completionConditions];
      updated[index] = condition;
      onChange({ ...data, completionConditions: updated });
    },
    [data, onChange],
  );

  const handleRemoveCompletion = useCallback(
    (index: number) => {
      onChange({
        ...data,
        completionConditions: data.completionConditions.filter((_, i) => i !== index),
      });
    },
    [data, onChange],
  );

  const handleAddCompletion = useCallback(() => {
    onChange({ ...data, completionConditions: [...data.completionConditions, { when: '' }] });
  }, [data, onChange]);

  // ---------------------------------------------------------------------------
  // Collapsed summary
  // ---------------------------------------------------------------------------

  const summaryParts: string[] = [];
  if (hookCount > 0) {
    summaryParts.push(t('hooks_summary', { count: hookCount }));
  }
  if (completionCount > 0) {
    summaryParts.push(t('completions_summary', { count: completionCount }));
  }
  if (errorCount > 0) {
    summaryParts.push(t('error_handlers_summary', { count: errorCount }));
  }
  if (data.hasOnStart) {
    summaryParts.push(t('on_start_summary'));
  }

  const summaryContent =
    summaryParts.length > 0 ? (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <Play className="w-3 h-3" />
        {summaryParts.join(', ')}
      </span>
    ) : undefined;

  const isEmpty =
    !data.hasOnStart &&
    !data.hasHooks &&
    errorCount === 0 &&
    completionCount === 0 &&
    data.memoryConfig.sessionVars.length === 0 &&
    data.memoryConfig.persistentPaths.length === 0 &&
    data.memoryConfig.rememberTriggers === 0 &&
    data.memoryConfig.recallInstructions === 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <SectionCard
      title={t('title')}
      sectionId="LIFECYCLE"
      count={totalCount > 0 ? totalCount : undefined}
      isExpanded={isExpanded}
      onToggle={onToggle}
      onArchClick={onArchClick}
      summary={summaryContent}
      saveStatus={saveStatus}
      isEmpty={isEmpty}
    >
      <div className="space-y-6">
        {/* ON_START sub-section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Play className="w-4 h-4 text-accent" />
            <h4 className="text-sm font-semibold text-foreground">{t('on_start_title')}</h4>
            <Toggle
              checked={data.hasOnStart}
              onChange={(checked) => onChange({ ...data, hasOnStart: checked })}
              label={t('enable_label')}
              className="ml-auto"
            />
          </div>

          {data.hasOnStart && (
            <div className="space-y-3 pl-6">
              <div>
                <label className="text-xs text-muted">{t('respond_label')}</label>
                <textarea
                  value={data.onStartRespond || ''}
                  onChange={(e) => handleOnStartRespondChange(e.target.value)}
                  rows={2}
                  placeholder={t('respond_placeholder')}
                  className={clsx(INLINE_INPUT_CLASSES, 'resize-y')}
                />
              </div>
              <div>
                <label className="text-xs text-muted">{t('call_label')}</label>
                <input
                  type="text"
                  value={data.onStartCall || ''}
                  onChange={(e) => handleOnStartCallChange(e.target.value)}
                  placeholder={t('call_placeholder')}
                  className={clsx(INLINE_INPUT_CLASSES, 'font-mono')}
                />
              </div>
            </div>
          )}
        </div>

        {/* Error Handlers sub-section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-error" />
            <h4 className="text-sm font-semibold text-foreground">{t('error_handlers_title')}</h4>
            {errorCount > 0 && <span className="text-xs text-muted">({errorCount})</span>}
          </div>

          {errorCount > 0 ? (
            <div className="space-y-2">
              {data.errorHandlers.map((handler, index) => (
                <ErrorHandlerCard
                  key={`error-${index}`}
                  handler={handler}
                  onChange={(updated) => handleErrorChange(index, updated)}
                  onRemove={() => handleRemoveError(index)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted italic pl-6">{t('no_error_handlers')}</p>
          )}

          {/* Add Error Handler button */}
          <button
            type="button"
            aria-label="Add Error Handler"
            onClick={handleAddError}
            className={clsx(
              'w-full flex items-center justify-center gap-2 py-2 rounded-lg',
              'border border-dashed border-default text-muted',
              'hover:border-error hover:text-error transition-fast',
              'text-sm font-medium btn-press',
            )}
          >
            <Plus className="w-4 h-4" />
            {t('add_error_handler')}
          </button>
        </div>

        {/* Completion sub-section */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-success" />
            <h4 className="text-sm font-semibold text-foreground">{t('completion_title')}</h4>
            {completionCount > 0 && <span className="text-xs text-muted">({completionCount})</span>}
          </div>

          {completionCount > 0 ? (
            <div className="space-y-2">
              {data.completionConditions.map((condition, index) => (
                <CompletionCard
                  key={`completion-${index}`}
                  condition={condition}
                  onChange={(updated) => handleCompletionChange(index, updated)}
                  onRemove={() => handleRemoveCompletion(index)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted italic pl-6">{t('no_completion_conditions')}</p>
          )}

          {/* Add Completion Condition button */}
          <button
            type="button"
            aria-label="Add Completion Condition"
            onClick={handleAddCompletion}
            className={clsx(
              'w-full flex items-center justify-center gap-2 py-2 rounded-lg',
              'border border-dashed border-default text-muted',
              'hover:border-success hover:text-success transition-fast',
              'text-sm font-medium btn-press',
            )}
          >
            <Plus className="w-4 h-4" />
            {t('add_completion_condition')}
          </button>
        </div>

        {/* Memory sub-section (read-only display) */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-info" />
            <h4 className="text-sm font-semibold text-foreground">{t('memory_title')}</h4>
          </div>

          <div className="space-y-3 pl-6">
            {/* Session variables */}
            {data.memoryConfig.sessionVars.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-xs text-muted font-medium">
                  {t('session_variables_label')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {data.memoryConfig.sessionVars.map((v) => (
                    <Badge key={v} variant="info" className="font-mono text-xs">
                      {v}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Persistent paths */}
            {data.memoryConfig.persistentPaths.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-xs text-muted font-medium">
                  {t('persistent_paths_label')}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {data.memoryConfig.persistentPaths.map((p) => (
                    <Badge key={p} variant="info" className="font-mono text-xs">
                      {p}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Remember / Recall counts */}
            {(data.memoryConfig.rememberTriggers > 0 ||
              data.memoryConfig.recallInstructions > 0) && (
              <div className="flex items-center gap-3">
                {data.memoryConfig.rememberTriggers > 0 && (
                  <span className="text-xs text-info">
                    {t('remember_triggers', { count: data.memoryConfig.rememberTriggers })}
                  </span>
                )}
                {data.memoryConfig.recallInstructions > 0 && (
                  <span className="text-xs text-info">
                    {t('recall_instructions', { count: data.memoryConfig.recallInstructions })}
                  </span>
                )}
              </div>
            )}

            {/* Empty memory state */}
            {data.memoryConfig.sessionVars.length === 0 &&
              data.memoryConfig.persistentPaths.length === 0 &&
              data.memoryConfig.rememberTriggers === 0 &&
              data.memoryConfig.recallInstructions === 0 && (
                <p className="text-xs text-muted italic">{t('no_memory')}</p>
              )}
          </div>
        </div>

        {/* Hooks sub-section (read-only display) */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-accent" />
            <h4 className="text-sm font-semibold text-foreground">{t('hooks_title')}</h4>
            {hookCount > 0 && <span className="text-xs text-muted">({hookCount})</span>}
          </div>

          {hookCount > 0 ? (
            <div className="flex flex-wrap gap-1.5 pl-6">
              {data.hooks.map((hook) => (
                <Badge key={hook} variant="accent" className="font-mono text-xs">
                  {hook}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted italic pl-6">{t('no_hooks')}</p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
