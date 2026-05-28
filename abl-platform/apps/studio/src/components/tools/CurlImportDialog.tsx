/**
 * CurlImportDialog Component
 *
 * Dialog for importing HTTP tool configuration from a curl command.
 * Parses the curl command and populates the HTTP config form.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, FileCode, AlertCircle, CheckCircle2, AlertTriangle, Sparkles } from 'lucide-react';
import { Button } from '../ui/Button';
import {
  parseCurlCommand,
  buildCurlImportPreview,
  validateCurlParse,
  type CurlImportPreview,
} from '../../lib/curl-parser';
import type { HttpConfig } from './HttpConfigForm';

interface CurlImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fired when the user confirms the import. Receives the imported config plus
   * warnings + detected `{{input.X}}` refs so the parent can surface them.
   */
  onImport: (preview: { config: Partial<HttpConfig>; detectedInputs: string[] }) => void;
}

const EXAMPLE_CURL = `curl -X POST https://api.example.com/v1/users \\
  -H "Authorization: Bearer sk-123456" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "John Doe", "email": "john@example.com"}'`;

export function CurlImportDialog({ isOpen, onClose, onImport }: CurlImportDialogProps) {
  const t = useTranslations('tools.curl_import');
  const [curlCommand, setCurlCommand] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CurlImportPreview | null>(null);

  if (!isOpen) return null;

  const handleParse = () => {
    setError(null);
    setPreview(null);

    if (!curlCommand.trim()) {
      setError(t('enter_curl_error'));
      return;
    }

    const parsed = parseCurlCommand(curlCommand);
    const validationError = validateCurlParse(parsed);

    if (validationError) {
      setError(validationError);
      return;
    }

    if (parsed) {
      setPreview(buildCurlImportPreview(parsed));
    }
  };

  const resetState = () => {
    setCurlCommand('');
    setPreview(null);
    setError(null);
  };

  const handleImport = () => {
    if (preview) {
      onImport({ config: preview.config, detectedInputs: preview.detectedInputs });
      onClose();
      resetState();
    }
  };

  const handleClose = () => {
    onClose();
    // Reset state after animation
    setTimeout(resetState, 200);
  };

  const handleLoadExample = () => {
    setCurlCommand(EXAMPLE_CURL);
    setError(null);
    setPreview(null);
  };

  const config = preview?.config;

  return (
    <div
      data-testid="curl-import-dialog-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        data-testid="curl-import-dialog"
        className="bg-background-elevated border border-default rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col animate-in zoom-in-95 duration-200"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-default">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-accent" />
            <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-background-muted rounded transition-default"
            aria-label={t('cancel')}
          >
            <X className="w-5 h-5 text-muted" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Instructions */}
          <div className="bg-background-muted border border-default rounded-lg p-3">
            <p className="text-sm text-foreground mb-2">
              {t.rich('instructions', {
                code: (chunks) => (
                  <code className="font-mono text-xs bg-background-subtle px-1 py-0.5 rounded">
                    {chunks}
                  </code>
                ),
              })}
            </p>
            <ul className="text-xs text-muted space-y-1 ml-4 list-disc">
              <li>{t('extract_method')}</li>
              <li>{t('extract_headers')}</li>
              <li>{t('extract_body')}</li>
              <li>{t('extract_params')}</li>
            </ul>
          </div>

          {/* cURL Input */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-foreground">
                {t('curl_command_label')}
              </label>
              <Button variant="ghost" size="sm" onClick={handleLoadExample}>
                {t('load_example')}
              </Button>
            </div>
            <textarea
              data-testid="curl-import-textarea"
              value={curlCommand}
              onChange={(e) => {
                setCurlCommand(e.target.value);
                setError(null);
                setPreview(null);
              }}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter parses for convenience.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && curlCommand.trim()) {
                  e.preventDefault();
                  handleParse();
                }
              }}
              placeholder="curl -X POST https://api.example.com/v1/resource -H 'Content-Type: application/json' -d '{...}'"
              rows={6}
              className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm font-mono p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y"
              spellCheck={false}
            />
          </div>

          {/* Parse Button */}
          <Button onClick={handleParse} disabled={!curlCommand.trim()} className="w-full">
            {t('parse_button')}
          </Button>

          {/* Error */}
          {error && (
            <div
              data-testid="curl-import-error"
              className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/30"
            >
              <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
              <div className="text-sm text-error">{error}</div>
            </div>
          )}

          {/* Preview */}
          {preview && config && (
            <div data-testid="curl-import-preview" className="space-y-3">
              <div
                data-testid="curl-import-success"
                className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/30"
              >
                <CheckCircle2 className="w-4 h-4 text-success" />
                <span className="text-sm text-success font-medium">{t('success_message')}</span>
              </div>

              {/* Warnings */}
              {preview.warnings.length > 0 && (
                <div className="p-3 rounded-lg bg-warning/10 border border-warning/30 space-y-1">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                    <span className="text-sm text-warning font-medium">
                      {preview.warnings.length === 1
                        ? '1 thing to review'
                        : `${preview.warnings.length} things to review`}
                    </span>
                  </div>
                  <ul className="ml-6 text-xs text-foreground/90 space-y-1 list-disc">
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Detected input parameters */}
              {preview.detectedInputs.length > 0 && (
                <div className="p-3 rounded-lg bg-accent/10 border border-accent/30">
                  <div className="flex items-center gap-2 mb-1">
                    <Sparkles className="w-4 h-4 text-accent shrink-0" />
                    <span className="text-sm text-accent font-medium">
                      {preview.detectedInputs.length === 1
                        ? '1 input parameter will be created'
                        : `${preview.detectedInputs.length} input parameters will be created`}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 ml-6">
                    {preview.detectedInputs.map((name) => (
                      <code
                        key={name}
                        className="font-mono text-xs bg-background-subtle px-1.5 py-0.5 rounded border border-default"
                      >
                        {`{{input.${name}}}`}
                      </code>
                    ))}
                  </div>
                </div>
              )}

              <div className="bg-background-muted rounded-lg p-4 space-y-3">
                <h3 className="text-sm font-semibold text-foreground mb-2">
                  {t('config_preview_title')}
                </h3>

                <div className="space-y-2 text-sm">
                  <div
                    data-testid="curl-import-preview-endpoint"
                    className="flex items-start gap-2"
                  >
                    <span className="text-muted w-28 shrink-0">{t('endpoint_label')}</span>
                    <span className="font-mono text-foreground break-all">{config.endpoint}</span>
                  </div>

                  <div data-testid="curl-import-preview-method" className="flex items-start gap-2">
                    <span className="text-muted w-28 shrink-0">{t('method_label')}</span>
                    <span className="font-medium text-foreground">{config.method}</span>
                  </div>

                  <div data-testid="curl-import-preview-auth" className="flex items-start gap-2">
                    <span className="text-muted w-28 shrink-0">{t('auth_type_label')}</span>
                    <span className="font-medium text-foreground capitalize">
                      {config.authType}
                    </span>
                  </div>

                  {config.headers && config.headers.length > 0 && (
                    <div
                      data-testid="curl-import-preview-headers"
                      className="flex items-start gap-2"
                    >
                      <span className="text-muted w-28 shrink-0">{t('headers_label')}</span>
                      <div className="flex-1 space-y-1">
                        {config.headers.map((h, i) => (
                          <div key={i} className="font-mono text-xs text-foreground break-all">
                            <span className="text-muted">{h.key}:</span> {h.value}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {config.queryParams && config.queryParams.length > 0 && (
                    <div
                      data-testid="curl-import-preview-query-params"
                      className="flex items-start gap-2"
                    >
                      <span className="text-muted w-28 shrink-0">{t('query_params_label')}</span>
                      <div className="flex-1 space-y-1">
                        {config.queryParams.map((q, i) => (
                          <div key={i} className="font-mono text-xs text-foreground break-all">
                            <span className="text-muted">{q.key}=</span>
                            {q.value}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {config.body && (
                    <div
                      data-testid="curl-import-preview-body-type"
                      className="flex items-start gap-2"
                    >
                      <span className="text-muted w-28 shrink-0">{t('body_type_label')}</span>
                      <span className="font-medium text-foreground uppercase">
                        {config.bodyType}
                      </span>
                    </div>
                  )}

                  {config.body && (
                    <div data-testid="curl-import-preview-body" className="flex items-start gap-2">
                      <span className="text-muted w-28 shrink-0">{t('body_content_label')}</span>
                      <pre
                        data-testid="curl-import-preview-body-content"
                        className="flex-1 text-xs font-mono text-foreground bg-background-subtle p-2 rounded border border-default overflow-x-auto max-h-32"
                      >
                        {config.body}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-default bg-background-muted">
          <Button variant="ghost" onClick={handleClose}>
            {t('cancel')}
          </Button>
          <Button onClick={handleImport} disabled={!preview}>
            {t('import_button')}
          </Button>
        </div>
      </div>
    </div>
  );
}
