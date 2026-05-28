/**
 * Pipeline Editor Toolbar
 *
 * Top bar inside the graph editor page.
 * Shows: back button, pipeline name (editable), status badge,
 * validation indicator, and action buttons (validate, save, activate).
 */

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  Check,
  AlertTriangle,
  AlertCircle,
  Play,
  Pause,
  ShieldCheck,
  TestTube2,
  Loader2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { getBadgeIntentStyles, statusIntent } from '@agent-platform/design-tokens';
import { usePipelineEditorStore } from '../../store/pipeline-editor-store';
import { DropdownMenu } from '../ui/DropdownMenu';

// =============================================================================
// Types
// =============================================================================

export interface PipelineEditorToolbarProps {
  onBack: () => void;
  onSave: () => void;
  onTest: () => void;
  onValidate: () => void;
  onActivate: () => void;
  onDeactivate: () => void;
  testDisabled?: boolean;
  isToggling?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

function getStatusBadgeClasses(status: string): string {
  const intent = statusIntent(status);
  return getBadgeIntentStyles(intent).badge;
}

// =============================================================================
// Component
// =============================================================================

export function PipelineEditorToolbar({
  onBack,
  onSave,
  onTest,
  onValidate,
  onActivate,
  onDeactivate,
  testDisabled = false,
  isToggling = false,
}: PipelineEditorToolbarProps) {
  const t = useTranslations('pipelines');

  const pipelineName = usePipelineEditorStore((s) => s.pipelineName);
  const pipelineStatus = usePipelineEditorStore((s) => s.pipelineStatus);
  const isDirty = usePipelineEditorStore((s) => s.isDirty);
  const validationResult = usePipelineEditorStore((s) => s.validationResult);
  const setPipelineName = usePipelineEditorStore((s) => s.setPipelineName);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPipelineName(e.target.value);
    },
    [setPipelineName],
  );

  const errorCount = validationResult?.issues.filter((i) => i.severity === 'error').length ?? 0;
  const warningCount = validationResult?.issues.filter((i) => i.severity === 'warning').length ?? 0;
  const totalIssues = errorCount + warningCount;

  const statusLabel =
    pipelineStatus === 'draft'
      ? t('card_status_draft')
      : pipelineStatus === 'active'
        ? t('card_status_active')
        : t('card_status_archived');

  const isActive = pipelineStatus === 'active';

  return (
    <div className="h-14 border-b border-default bg-background flex items-center px-3 gap-3 shrink-0">
      {/* Back button */}
      <button
        type="button"
        className="p-1.5 text-muted hover:text-foreground rounded-md hover:bg-background-muted transition-colors"
        onClick={onBack}
        title={t('back_to_list')}
      >
        <ArrowLeft className="w-4 h-4" />
      </button>

      {/* Pipeline name */}
      <div className="w-56">
        <input
          type="text"
          value={pipelineName}
          onChange={handleNameChange}
          className="w-full bg-transparent text-sm font-semibold text-foreground border-0 border-b border-transparent hover:border-default focus:border-border-focus focus:outline-none py-1 px-0 transition-colors"
          placeholder="Pipeline name"
        />
      </div>

      {/* Status badge */}
      <span
        className={clsx(
          'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border',
          getStatusBadgeClasses(pipelineStatus),
        )}
      >
        {statusLabel}
      </span>

      {/* Validation indicator */}
      {validationResult && (
        <div className="flex items-center gap-1.5">
          {validationResult.valid ? (
            <div className="flex items-center gap-1 text-xs text-success">
              <Check className="w-3.5 h-3.5" />
              <span>{t('editor_validation_passed')}</span>
            </div>
          ) : (
            <DropdownMenu
              align="start"
              side="bottom"
              sideOffset={6}
              trigger={
                <button
                  type="button"
                  className="flex items-center gap-1 text-xs text-warning hover:text-warning/80 transition-colors"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>{t('editor_validation_failed', { count: totalIssues })}</span>
                </button>
              }
            >
              <div className="min-w-[280px] max-w-[400px] p-1">
                {validationResult.issues.map((issue, i) => (
                  <div key={i} className="flex items-start gap-2 px-2 py-1.5 rounded text-xs">
                    {issue.severity === 'error' ? (
                      <AlertCircle className="w-3.5 h-3.5 text-error shrink-0 mt-0.5" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
                    )}
                    <span className={issue.severity === 'error' ? 'text-error' : 'text-warning'}>
                      {issue.message}
                    </span>
                  </div>
                ))}
              </div>
            </DropdownMenu>
          )}
        </div>
      )}

      {/* Dirty indicator */}
      {isDirty && (
        <div className="w-2 h-2 rounded-full bg-warning" title={t('editor_unsaved_changes')} />
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Action buttons */}
      <button
        type="button"
        className={clsx(
          'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
          testDisabled
            ? 'border-default text-muted cursor-not-allowed'
            : 'border-default text-foreground-muted hover:text-foreground hover:bg-background-muted',
        )}
        onClick={onTest}
        disabled={testDisabled}
      >
        <TestTube2 className="w-3.5 h-3.5" />
        {t('test.test_button')}
      </button>

      <button
        type="button"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground-muted hover:text-foreground border border-default rounded-md hover:bg-background-muted transition-colors"
        onClick={onValidate}
      >
        <ShieldCheck className="w-3.5 h-3.5" />
        {t('editor_toolbar_validate')}
      </button>

      <button
        type="button"
        className={clsx(
          'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
          isDirty
            ? 'bg-accent text-accent-foreground hover:bg-accent/90'
            : 'bg-background-muted text-muted cursor-not-allowed',
        )}
        onClick={onSave}
        disabled={!isDirty}
      >
        <Check className="w-3.5 h-3.5" />
        {t('editor_toolbar_save')}
      </button>

      <button
        type="button"
        className={clsx(
          'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
          isToggling
            ? 'border-default text-muted cursor-not-allowed opacity-60'
            : isActive
              ? 'border-warning text-warning hover:bg-warning-subtle'
              : 'border-success text-success hover:bg-success-subtle',
        )}
        onClick={isToggling ? undefined : isActive ? onDeactivate : onActivate}
        disabled={isToggling}
      >
        {isToggling ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : isActive ? (
          <Pause className="w-3.5 h-3.5" />
        ) : (
          <Play className="w-3.5 h-3.5" />
        )}
        {isToggling
          ? isActive
            ? 'Deactivating…'
            : 'Activating…'
          : isActive
            ? 'Deactivate'
            : 'Activate'}
      </button>
    </div>
  );
}
