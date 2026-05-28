/**
 * TestResultCard Component
 *
 * Displays test result inline below config form.
 * Collapsible card with status, duration, and result preview.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle, AlertCircle, Clock, ChevronDown, ChevronRight, X } from 'lucide-react';
import { StructuredDataBlock } from './StructuredDataBlock';
import type { ToolTestResult } from '../../store/tool-store';

interface TestResultCardProps {
  result: ToolTestResult | null;
  onRerun?: () => void;
  onClear: () => void;
  onReconnectProfile?: (reauth: NonNullable<ToolTestResult['oauthReauth']>) => void;
}

export function TestResultCard({
  result,
  onRerun,
  onClear,
  onReconnectProfile,
}: TestResultCardProps) {
  const t = useTranslations('tools.test_result');
  const [expanded, setExpanded] = useState(true);

  if (!result) return null;

  const isSuccess = !result.error;
  const reconnectPayload = result.oauthReauth;
  const canReconnectProfile =
    result.errorCode === 'OAUTH_REAUTH_REQUIRED' && reconnectPayload !== undefined;

  return (
    <div
      className={`rounded-lg border overflow-hidden ${
        isSuccess ? 'border-success/50 bg-success-subtle/10' : 'border-error/50 bg-error-subtle/10'
      }`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-background-muted/50 transition-default"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted" />
          )}
          {isSuccess ? (
            <CheckCircle className="w-4 h-4 text-success" />
          ) : (
            <AlertCircle className="w-4 h-4 text-error" />
          )}
          <span className={`text-sm font-medium ${isSuccess ? 'text-success' : 'text-error'}`}>
            {isSuccess ? t('test_successful') : t('test_failed')}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-muted">
            <Clock className="w-3 h-3" />
            {result.latencyMs}ms
          </span>
          {onRerun && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRerun();
              }}
              className="text-xs text-info hover:text-info/80 transition-default"
            >
              {t('rerun')}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
            title={t('clear_result')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="p-3 border-t border-default space-y-2">
          {/* Error message */}
          {result.error && (
            <div className="p-2 rounded bg-error-subtle/20">
              {canReconnectProfile && onReconnectProfile && (
                <button
                  onClick={() => {
                    if (!onReconnectProfile || !reconnectPayload) {
                      return;
                    }
                    onReconnectProfile(reconnectPayload);
                  }}
                  className="mb-2 px-2 py-1 rounded text-xs font-medium bg-background-muted text-foreground border border-default hover:bg-background-elevated transition-default"
                >
                  {t('reconnect_profile')}
                </button>
              )}
              <pre className="text-xs text-error whitespace-pre-wrap font-mono">{result.error}</pre>
            </div>
          )}

          {/* Output */}
          {result.output !== undefined && result.output !== null && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1">
                {t('output_label')}
              </label>
              <StructuredDataBlock value={result.output} maxHeight="12rem" />
            </div>
          )}

          {/* Logs */}
          {result.logs && result.logs.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-muted mb-1">{t('logs_label')}</label>
              <StructuredDataBlock
                value={result.logs.join('\n')}
                language="logs"
                maxHeight="8rem"
              />
            </div>
          )}

          {/* HTTP Request summary (if available) */}
          {result.request && (
            <div className="text-xs text-muted">
              <span className="font-medium">{t('request_label')}</span>{' '}
              <code className="text-foreground">
                {result.request.method} {result.request.url}
              </code>
            </div>
          )}

          {/* HTTP Response summary (if available) */}
          {result.response && (
            <div className="text-xs text-muted">
              <span className="font-medium">{t('response_label')}</span>{' '}
              <code
                className={`font-medium ${
                  result.response.status >= 200 && result.response.status < 300
                    ? 'text-success'
                    : result.response.status >= 400
                      ? 'text-error'
                      : 'text-warning'
                }`}
              >
                {result.response.status} {result.response.statusText || ''}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
