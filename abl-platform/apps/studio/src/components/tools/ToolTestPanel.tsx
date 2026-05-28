/**
 * ToolTestPanel Component
 *
 * Execute tool with sample input, show result and latency.
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
  Shield,
  Server,
  Terminal,
} from 'lucide-react';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/ErrorAlert';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { DynamicToolInputForm } from './DynamicToolInputForm';
import { generateDummyDataFromSchema } from './tool-utils';
import { StructuredDataBlock } from './StructuredDataBlock';
import type { ToolTestResult } from '../../store/tool-store';

interface ToolTestPanelProps {
  onTest: (input: Record<string, unknown>) => Promise<ToolTestResult>;
  inputSchema?: any;
  toolType?: string;
}

export function ToolTestPanel({ onTest, inputSchema, toolType }: ToolTestPanelProps) {
  const t = useTranslations('tools.test_panel');
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [inputJson, setInputJson] = useState('{}');
  const [result, setResult] = useState<ToolTestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [paramsExpanded, setParamsExpanded] = useState(false);
  const [requestExpanded, setRequestExpanded] = useState(true);
  const [responseExpanded, setResponseExpanded] = useState(true);

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
  }, [inputSchema]);

  // Sync form values to JSON when switching to JSON mode (only if user hasn't modified JSON)
  useEffect(() => {
    if (inputMode === 'json') {
      setInputJson(JSON.stringify(formValues, null, 2));
    }
  }, [inputMode]);

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
        setError(t('invalid_json_input'));
        return;
      }
    }

    setLoading(true);
    try {
      const res = await onTest(parsed);
      setResult(res);
    } catch (err) {
      setError(sanitizeErrors(err, 'Test failed'));
    } finally {
      setLoading(false);
    }
  };

  const handleCopySchema = () => {
    if (inputSchema) {
      navigator.clipboard.writeText(JSON.stringify(inputSchema, null, 2));
    }
  };

  return (
    <div className="space-y-4">
      {/* Input mode toggle */}
      {hasSchema && (
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-foreground">
            {t('test_input_label')}
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
              {t('form_mode')}
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
              {t('json_mode')}
            </button>
          </div>
        </div>
      )}

      {/* Dynamic form or JSON editor */}
      {inputMode === 'form' && hasSchema ? (
        <DynamicToolInputForm
          schema={inputSchema}
          values={formValues}
          onChange={setFormValues}
          onCopySchema={handleCopySchema}
        />
      ) : (
        <div>
          {!hasSchema && (
            <label className="block text-sm font-medium text-foreground mb-1.5">
              {t('test_input_json_label')}
            </label>
          )}
          <textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            rows={6}
            className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm font-mono p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y"
            spellCheck={false}
            placeholder='{\n  "param1": "example value",\n  "param2": 123,\n  "param3": true\n}'
          />
          <p className="text-xs text-muted mt-1.5">{t('pre_populated_hint')}</p>
        </div>
      )}

      <Button
        variant="primary"
        icon={<Play className="w-4 h-4" />}
        onClick={handleTest}
        loading={loading}
      >
        {t('run_test')}
      </Button>

      {error && <ErrorAlert error={error} onDismiss={() => setError(null)} />}

      {result && (
        <div className="space-y-3">
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
                ? t('execution_error')
                : result.httpError
                  ? t('http_error_response')
                  : t('success')}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted">
              <Clock className="w-3 h-3" />
              {result.latencyMs}ms
            </span>
          </div>

          {result.error && (
            <div className="p-3 rounded-lg bg-error-subtle border border-error/20">
              <StructuredDataBlock value={result.error} language="error" maxHeight="12rem" />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-muted mb-1">{t('output_label')}</label>
            <StructuredDataBlock value={result.output} maxHeight="16rem" />
          </div>

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
                <span className="text-xs font-semibold text-foreground">{t('params_label')}</span>
                <span className="text-xs text-muted ml-auto">
                  {Object.keys(result.params).length}
                </span>
              </button>
              {paramsExpanded && (
                <div className="p-3 border-t border-default">
                  <StructuredDataBlock value={result.params} maxHeight="10rem" />
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
                <span className="text-xs font-semibold text-foreground">{t('request_label')}</span>
                <span className="text-xs text-muted ml-auto">
                  {result.request.method} {result.request.url?.split('?')[0]}
                </span>
              </button>
              {requestExpanded && (
                <div className="p-3 border-t border-default space-y-2">
                  <div>
                    <div className="text-xs font-medium text-muted mb-1">{t('url_label')}</div>
                    <code className="text-xs text-foreground break-all">
                      {result.request.method} {result.request.url?.split('?')[0]}
                    </code>
                  </div>
                  {/* Query Parameters — parsed from URL */}
                  {result.request.url?.includes('?') &&
                    (() => {
                      try {
                        const params = new URLSearchParams(result.request.url.split('?')[1]);
                        const entries = [...params.entries()];
                        if (entries.length === 0) return null;
                        return (
                          <div>
                            <div className="text-xs font-medium text-muted mb-1">
                              {t('query_params_label')}
                            </div>
                            <div className="p-2 rounded bg-background-muted space-y-0.5">
                              {entries.map(([k, v], i) => (
                                <div key={i} className="flex items-center gap-2 text-xs font-mono">
                                  <span className="text-foreground">{k}=</span>
                                  <span className="text-muted">{v}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      } catch {
                        return null;
                      }
                    })()}
                  {result.request.headers && Object.keys(result.request.headers).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted mb-1">
                        {t('headers_label')}
                      </div>
                      <StructuredDataBlock value={result.request.headers} maxHeight="8rem" />
                    </div>
                  )}
                  {/* Auth applied indicator */}
                  {result.request.headers &&
                    Object.keys(result.request.headers).some(
                      (k) =>
                        k.toLowerCase() === 'authorization' ||
                        result.request!.headers![k] === '***',
                    ) && (
                      <div className="flex items-center gap-1.5 text-xs text-muted">
                        <Shield className="w-3 h-3" />
                        <span>{t('auth_applied')}</span>
                      </div>
                    )}
                  {result.request.body !== undefined && result.request.body !== null && (
                    <div>
                      <div className="text-xs font-medium text-muted mb-1">{t('body_label')}</div>
                      <StructuredDataBlock value={result.request.body} maxHeight="10rem" />
                    </div>
                  )}
                  {result.renderedRequest && (
                    <div>
                      <div className="text-xs font-medium text-muted mb-1">
                        {t('soap_envelope_preview')}
                      </div>
                      <StructuredDataBlock
                        value={result.renderedRequest.body}
                        language="xml"
                        maxHeight="10rem"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Sandbox Inspector */}
          {result.sandbox && (
            <div className="border border-default rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Terminal className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-semibold text-foreground">{t('sandbox_label')}</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex gap-2">
                  <span className="text-muted">{t('runtime_label')}:</span>
                  <span className="font-mono text-foreground">{result.sandbox.runtime}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted">{t('timeout_label')}:</span>
                  <span className="font-mono text-foreground">{result.sandbox.timeoutMs}ms</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted">{t('memory_label')}:</span>
                  <span className="font-mono text-foreground">{result.sandbox.memoryMb} MB</span>
                </div>
              </div>
            </div>
          )}

          {/* MCP Inspector */}
          {result.mcp && (
            <div className="border border-default rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <Server className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-semibold text-foreground">{t('mcp_label')}</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex gap-2">
                  <span className="text-muted">{t('server_label')}:</span>
                  <span className="font-mono text-foreground">{result.mcp.server}</span>
                </div>
                <div className="flex gap-2">
                  <span className="text-muted">{t('tool_label')}:</span>
                  <span className="font-mono text-foreground">{result.mcp.tool}</span>
                </div>
                {result.mcp.transport && (
                  <div className="flex gap-2">
                    <span className="text-muted">{t('transport_label')}:</span>
                    <span className="font-mono text-foreground uppercase">
                      {result.mcp.transport}
                    </span>
                  </div>
                )}
              </div>
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
                <span className="text-xs font-semibold text-foreground">{t('response_label')}</span>
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
                    <div className="text-xs font-medium text-muted mb-1">{t('status_label')}</div>
                    <code className="text-xs text-foreground">
                      {result.response.status} {result.response.statusText || ''}
                    </code>
                  </div>
                  {result.response.headers && Object.keys(result.response.headers).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-muted mb-1">
                        {t('headers_label')}
                      </div>
                      <StructuredDataBlock value={result.response.headers} maxHeight="8rem" />
                    </div>
                  )}
                  {result.response.body !== undefined && result.response.body !== null && (
                    <div>
                      <div className="text-xs font-medium text-muted mb-1">{t('body_label')}</div>
                      <StructuredDataBlock value={result.response.body} maxHeight="10rem" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
