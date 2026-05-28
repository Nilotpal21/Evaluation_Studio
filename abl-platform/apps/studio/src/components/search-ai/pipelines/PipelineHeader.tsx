/**
 * Pipeline Header
 *
 * Shows pipeline name, status badge, and action buttons (save draft, publish).
 */

import { useTranslations } from 'next-intl';
import { statusIntent, getBadgeIntentStyles } from '@agent-platform/design-tokens';
import { usePipelineStore } from '../../../store/pipeline-store';

interface PipelineHeaderProps {
  knowledgeBaseName?: string;
}

export function PipelineHeader({ knowledgeBaseName }: PipelineHeaderProps) {
  const t = useTranslations('search_ai.pipeline');
  const { draft, isDirty, saveStatus, error, saveDraft, publish, validate, validationErrors } =
    usePipelineStore();

  if (!draft) return null;

  const statusLabel =
    draft.status === 'active' ? t('header_status_published') : t('header_status_draft');
  const statusColor = getBadgeIntentStyles(statusIntent(draft.status)).badge;

  // Show validation errors from publish failure or explicit validate
  const criticalErrors = validationErrors.filter((e) => e.severity === 'error');
  const warnings = validationErrors.filter((e) => e.severity === 'warning');
  const showErrorBanner = saveStatus === 'error' && (criticalErrors.length > 0 || error);

  return (
    <div>
      <div className="flex items-center justify-between px-6 py-4 border-b border-default">
        <div className="flex items-center gap-3">
          <div>
            {knowledgeBaseName && <p className="text-xs text-muted mb-0.5">{knowledgeBaseName}</p>}
            <h2 className="text-lg font-semibold text-foreground">{draft.name}</h2>
          </div>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColor}`}>
            {statusLabel}
          </span>
          {isDirty && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-warning-subtle text-warning">
              {t('header_unsaved_changes')}
            </span>
          )}
          <span className="text-xs text-muted">v{draft.version}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1.5 text-sm text-muted hover:text-foreground"
            onClick={() => validate()}
          >
            {t('header_validate')}
          </button>
          <button
            className="px-3 py-1.5 text-sm border border-default rounded-md hover:bg-background-muted disabled:opacity-50"
            onClick={() => saveDraft()}
            disabled={!isDirty || saveStatus === 'saving'}
          >
            {saveStatus === 'saving' ? t('header_saving') : t('header_save_draft')}
          </button>
          <button
            className="px-3 py-1.5 text-sm bg-foreground text-background rounded-md hover:opacity-90 disabled:opacity-50"
            onClick={() => publish()}
            disabled={isDirty || saveStatus === 'saving'}
            title={isDirty ? t('header_save_before_publish') : t('header_publish_tooltip')}
          >
            {t('header_publish')}
          </button>
        </div>
      </div>

      {/* Validation error banner — shown after failed publish or validate */}
      {showErrorBanner && (
        <div className="px-6 py-3 bg-error-subtle border-b border-error">
          <div className="flex items-start gap-2">
            <span className="text-error mt-0.5 shrink-0">✕</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-error">
                {criticalErrors.length > 0
                  ? 'Pipeline cannot be published — fix the following errors:'
                  : error}
              </p>
              {criticalErrors.length > 0 && (
                <ul className="mt-1 space-y-1">
                  {criticalErrors.map((e, i) => (
                    <li key={i} className="text-xs text-error/80 flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5">•</span>
                      <span>{e.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {warnings.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {warnings.map((e, i) => (
                    <li key={i} className="text-xs text-warning flex items-start gap-1.5">
                      <span className="shrink-0 mt-0.5">⚠</span>
                      <span>{e.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
