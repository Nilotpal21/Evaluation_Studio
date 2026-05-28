/**
 * TestToolDialog Component
 *
 * Modal dialog for testing tools with dynamic form generation.
 * Supports all tool types: HTTP, Code (Sandbox), MCP.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Play,
  Clock,
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Check,
} from 'lucide-react';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { ErrorAlert } from '../ui/ErrorAlert';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { DynamicToolInputForm } from './DynamicToolInputForm';
import { generateDummyDataFromSchema } from './tool-utils';
import { AuthProfileOAuthDialog } from '../auth-profiles/AuthProfileOAuthDialog';
import type { ToolTestResult, ToolWithVersion } from '../../store/tool-store';

interface TestToolDialogProps {
  open: boolean;
  onClose: () => void;
  tool: ToolWithVersion;
  inputSchema?: any;
  onTest: (input: Record<string, unknown>) => Promise<ToolTestResult>;
  onTestComplete?: (result: ToolTestResult) => void;
}

export function TestToolDialog({
  open,
  onClose,
  tool,
  inputSchema,
  onTest,
  onTestComplete,
}: TestToolDialogProps) {
  const t = useTranslations('tools.test_dialog');
  const tp = useTranslations('tools.test_panel');
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [inputJson, setInputJson] = useState('{}');
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [requestExpanded, setRequestExpanded] = useState(true);
  const [responseExpanded, setResponseExpanded] = useState(true);
  const [copied, setCopied] = useState(false);
  const [oauthReconnectContext, setOauthReconnectContext] = useState<NonNullable<
    ToolTestResult['oauthReauth']
  > | null>(null);
  const [oauthReconnectOpen, setOauthReconnectOpen] = useState(false);

  // Initialize form values and JSON from schema with realistic dummy data
  useEffect(() => {
    if (inputSchema?.properties) {
      const dummyData = generateDummyDataFromSchema(inputSchema);
      setFormValues(dummyData);
      setInputJson(JSON.stringify(dummyData, null, 2));
    } else {
      setFormValues({});
      setInputJson('{}');
    }
    // Reset result when tool changes
    setResult(null);
    setError(null);
    setOauthReconnectContext(null);
    setOauthReconnectOpen(false);
  }, [tool]);

  // Sync form values to JSON when switching to JSON mode
  useEffect(() => {
    if (inputMode === 'json') {
      setInputJson(JSON.stringify(formValues, null, 2));
    }
  }, [inputMode, formValues]);

  // Show form mode by default if schema is available
  const hasSchema =
    inputSchema && inputSchema.properties && Object.keys(inputSchema.properties).length > 0;

  const handleTest = async () => {
    setError(null);
    setResult(null);

    let parsed: Record<string, unknown>;

    if (inputMode === 'form') {
      // Use form values directly
      parsed = formValues;
    } else {
      // Parse JSON
      try {
        parsed = JSON.parse(inputJson);
      } catch {
        setError(tp('invalid_json_input'));
        return;
      }
    }

    setLoading(true);
    try {
      const res = await onTest(parsed);
      setResult(res);
      if (res.errorCode === 'OAUTH_REAUTH_REQUIRED' && res.oauthReauth) {
        setOauthReconnectContext(res.oauthReauth);
      } else {
        setOauthReconnectContext(null);
      }
      if (onTestComplete) {
        onTestComplete(res);
      }
    } catch (err) {
      setError(sanitizeErrors(err, 'Test failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCopySchema = () => {
    if (inputSchema) {
      navigator.clipboard.writeText(JSON.stringify(inputSchema, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleClose = () => {
    // Keep result if test was successful (will be passed to parent via onTestComplete)
    onClose();
  };

  const handleReconnectProfile = () => {
    if (!result?.oauthReauth) {
      return;
    }

    setOauthReconnectContext(result.oauthReauth);
    setOauthReconnectOpen(true);
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={handleClose}
        title={t('title', { name: tool.name })}
        description={t('description')}
        maxWidth="2xl"
      >
        <div className="space-y-4">
          {/* Input mode toggle — only shown when tool has parameters */}
          {hasSchema && (
            <>
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-foreground">
                  {tp('test_input_label')}
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setInputMode('form')}
                    className={`px-3 py-1.5 text-xs rounded transition-default ${
                      inputMode === 'form'
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-background-muted text-muted hover:text-foreground'
                    }`}
                  >
                    {tp('form_mode')}
                  </button>
                  <button
                    onClick={() => setInputMode('json')}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-default ${
                      inputMode === 'json'
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-background-muted text-muted hover:text-foreground'
                    }`}
                  >
                    <Code2 className="w-3 h-3" />
                    {tp('json_mode')}
                  </button>
                </div>
              </div>

              {/* Dynamic form or JSON editor */}
              <div className="max-h-[50vh] overflow-y-auto">
                {inputMode === 'form' ? (
                  <DynamicToolInputForm
                    schema={inputSchema}
                    values={formValues}
                    onChange={setFormValues}
                    onCopySchema={handleCopySchema}
                  />
                ) : (
                  <div>
                    <textarea
                      value={inputJson}
                      onChange={(e) => setInputJson(e.target.value)}
                      rows={8}
                      className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm font-mono p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y"
                      spellCheck={false}
                      placeholder='{\n  "param1": "example value",\n  "param2": 123,\n  "param3": true\n}'
                    />
                    <p className="text-xs text-muted mt-1.5">{tp('pre_populated_hint')}</p>
                  </div>
                )}
              </div>
            </>
          )}

          {/* Execute button */}
          <div className="flex items-center justify-between pt-2 border-t border-default">
            <Button
              variant="primary"
              icon={<Play className="w-4 h-4" />}
              onClick={handleTest}
              loading={loading}
            >
              {t('execute')}
            </Button>
            {result && (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Clock className="w-3 h-3" />
                {result.latencyMs}ms
              </span>
            )}
          </div>

          {/* Error display */}
          {error && <ErrorAlert error={error} onDismiss={() => setError(null)} />}

          {/* Result display */}
          {result && (
            <div className="space-y-3 pt-2 border-t border-default">
              <div className="flex items-center gap-3">
                {result.error ? (
                  <AlertCircle className="w-4 h-4 text-error" />
                ) : result.httpError ? (
                  <AlertTriangle className="w-4 h-4 text-warning" />
                ) : (
                  <CheckCircle className="w-4 h-4 text-success" />
                )}
                <span className="text-sm font-medium text-foreground">
                  {result.error
                    ? tp('execution_error')
                    : result.httpError
                      ? tp('http_error_response')
                      : tp('success')}
                </span>
              </div>

              {result.error && (
                <div className="p-3 rounded-lg bg-error-subtle border border-error/20">
                  {result.errorCode && (
                    <div className="flex items-center gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded text-xs font-mono font-semibold bg-error/10 text-error border border-error/20">
                        {result.errorCode}
                      </span>
                      {result.retryable && (
                        <span className="px-2 py-0.5 rounded text-xs font-medium bg-warning-subtle text-warning">
                          {t('retryable')}
                        </span>
                      )}
                      {result.errorCode === 'OAUTH_REAUTH_REQUIRED' && result.oauthReauth && (
                        <Button variant="secondary" size="xs" onClick={handleReconnectProfile}>
                          {tp('reconnect_profile')}
                        </Button>
                      )}
                    </div>
                  )}
                  <pre className="text-xs text-error whitespace-pre-wrap font-mono">
                    {result.error}
                  </pre>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  {tp('output_label')}
                </label>
                <pre className="p-3 rounded-lg bg-background-muted border border-default text-xs text-foreground whitespace-pre-wrap font-mono max-h-64 overflow-auto">
                  {typeof result.output === 'string'
                    ? result.output
                    : JSON.stringify(result.output, null, 2)}
                </pre>
              </div>

              {result.logs && result.logs.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    {tp('logs_label')}
                  </label>
                  <pre className="p-3 rounded-lg bg-background-muted border border-default text-xs text-muted whitespace-pre-wrap font-mono max-h-32 overflow-auto">
                    {result.logs.join('\n')}
                  </pre>
                </div>
              )}

              {/* Parameters (collapsible) */}
              {result.params && Object.keys(result.params).length > 0 && (
                <div className="border border-default rounded-lg overflow-hidden">
                  <button
                    onClick={() => setParamsExpanded(!paramsExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-background-elevated hover:bg-background-muted transition-default text-left"
                  >
                    {paramsExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-muted" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-muted" />
                    )}
                    <span className="text-xs font-semibold text-foreground">
                      {tp('params_label')}
                    </span>
                    <span className="text-xs text-muted ml-auto">
                      {Object.keys(result.params).length}
                    </span>
                  </button>
                  {paramsExpanded && (
                    <div className="p-3 border-t border-default">
                      <pre className="p-2 rounded bg-background-muted text-xs text-foreground font-mono max-h-40 overflow-auto">
                        {JSON.stringify(result.params, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* HTTP Request Inspector */}
              {result.request && (
                <div className="border border-default rounded-lg overflow-hidden">
                  <button
                    onClick={() => setRequestExpanded(!requestExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-background-elevated hover:bg-background-muted transition-default text-left"
                  >
                    {requestExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-muted" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-muted" />
                    )}
                    <span className="text-xs font-semibold text-foreground">
                      {tp('request_label')}
                    </span>
                    <span className="text-xs text-muted ml-auto">
                      {result.request.method} {result.request.url}
                    </span>
                  </button>
                  {requestExpanded && (
                    <div className="p-3 border-t border-default space-y-2">
                      <div>
                        <div className="text-xs font-medium text-muted mb-1">{tp('url_label')}</div>
                        <code className="text-xs text-foreground break-all">
                          {result.request.method} {result.request.url}
                        </code>
                      </div>
                      {result.request.headers && Object.keys(result.request.headers).length > 0 && (
                        <div>
                          <div className="text-xs font-medium text-muted mb-1">
                            {tp('headers_label')}
                          </div>
                          <pre className="p-2 rounded bg-background-muted text-xs text-foreground font-mono">
                            {Object.entries(result.request.headers)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join('\n')}
                          </pre>
                        </div>
                      )}
                      {result.request.body !== undefined && result.request.body !== null && (
                        <div>
                          <div className="text-xs font-medium text-muted mb-1">
                            {tp('body_label')}
                          </div>
                          <pre className="p-2 rounded bg-background-muted text-xs text-foreground font-mono max-h-40 overflow-auto">
                            {typeof result.request.body === 'string'
                              ? result.request.body
                              : JSON.stringify(result.request.body, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* HTTP Response Inspector */}
              {result.response && (
                <div className="border border-default rounded-lg overflow-hidden">
                  <button
                    onClick={() => setResponseExpanded(!responseExpanded)}
                    className="w-full flex items-center gap-2 px-3 py-2 bg-background-elevated hover:bg-background-muted transition-default text-left"
                  >
                    {responseExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-muted" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-muted" />
                    )}
                    <span className="text-xs font-semibold text-foreground">
                      {tp('response_label')}
                    </span>
                    <span
                      className={`text-xs ml-auto font-medium ${
                        result.response.status >= 200 && result.response.status < 300
                          ? 'text-success'
                          : result.response.status >= 400
                            ? 'text-error'
                            : 'text-warning'
                      }`}
                    >
                      {result.response.status} {result.response.statusText || ''}
                    </span>
                  </button>
                  {responseExpanded && (
                    <div className="p-3 border-t border-default space-y-2">
                      <div>
                        <div className="text-xs font-medium text-muted mb-1">
                          {tp('status_label')}
                        </div>
                        <code className="text-xs text-foreground">
                          {result.response.status} {result.response.statusText || ''}
                        </code>
                      </div>
                      {result.response.headers &&
                        Object.keys(result.response.headers).length > 0 && (
                          <div>
                            <div className="text-xs font-medium text-muted mb-1">
                              {tp('headers_label')}
                            </div>
                            <pre className="p-2 rounded bg-background-muted text-xs text-foreground font-mono max-h-32 overflow-auto">
                              {Object.entries(result.response.headers)
                                .map(([k, v]) => `${k}: ${v}`)
                                .join('\n')}
                            </pre>
                          </div>
                        )}
                      {result.response.body !== undefined && result.response.body !== null && (
                        <div>
                          <div className="text-xs font-medium text-muted mb-1">
                            {tp('body_label')}
                          </div>
                          <pre className="p-2 rounded bg-background-muted text-xs text-foreground font-mono max-h-40 overflow-auto">
                            {typeof result.response.body === 'string'
                              ? result.response.body
                              : JSON.stringify(result.response.body, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-default">
            <Button variant="ghost" onClick={handleClose}>
              {result ? t('done') : t('cancel')}
            </Button>
          </div>
        </div>
      </Dialog>

      {oauthReconnectContext && (
        <AuthProfileOAuthDialog
          open={oauthReconnectOpen}
          onClose={() => setOauthReconnectOpen(false)}
          projectId={tool.projectId}
          authProfileId={oauthReconnectContext.authProfileId}
          connectorName={oauthReconnectContext.connectorName}
          displayName={`${oauthReconnectContext.profileName} token`}
          onSuccess={() => {
            setOauthReconnectOpen(false);
          }}
        />
      )}
    </>
  );
}
