/**
 * ConfigSidePanel — 420px side panel for Custom API (http-webhook) configuration.
 *
 * 4 tabs: Config, Auth & Headers, Behavior, Test.
 * No dimmed backdrop — canvas remains interactive.
 *
 * IMPORTANT: Field names MUST match the backend HttpWebhookConfig interface
 * (apps/search-ai/src/services/provider-registry/providers/http-webhook.provider.ts)
 * to ensure pipeline execution works correctly.
 */

'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { X, Plus, Trash2 } from 'lucide-react';
import { usePipelineStore } from '../../../../store/pipeline-store';
import { Tabs } from '../../../ui/Tabs';
import { Input } from '../../../ui/Input';
import { Select } from '../../../ui/Select';
import { Textarea } from '../../../ui/Textarea';
import { Button } from '../../../ui/Button';

// =============================================================================
// TYPES — aligned with backend HttpWebhookConfig
// =============================================================================

interface Header {
  key: string;
  value: string;
}

interface WebhookAuth {
  type: 'none' | 'bearer' | 'api-key' | 'basic';
  token?: string;
  headerName?: string;
  username?: string;
  password?: string;
}

interface WebhookConfig {
  url: string;
  method: string;
  mode: 'source' | 'replacement' | 'transformer';
  outputType: 'document' | 'text' | 'pages' | 'chunks' | 'enriched-chunks';
  entryPoint: 'before-extraction' | 'after-extraction' | 'after-chunking' | 'after-enrichment';
  auth: WebhookAuth;
  headers: Header[];
  timeout: number;
  retries: number;
  onError: string;
}

const DEFAULT_CONFIG: WebhookConfig = {
  url: '',
  method: 'POST',
  mode: 'replacement',
  outputType: 'text',
  entryPoint: 'after-extraction',
  auth: { type: 'none' },
  headers: [],
  timeout: 30000,
  retries: 3,
  onError: 'fail',
};

// =============================================================================
// HELPERS
// =============================================================================

function normalizeProviderConfig(
  raw: Record<string, unknown> | undefined,
  stageOnError?: string,
): WebhookConfig {
  if (!raw) {
    return { ...DEFAULT_CONFIG, onError: stageOnError ?? DEFAULT_CONFIG.onError };
  }

  const headersObj = raw.headers as Record<string, string> | Header[] | undefined;
  let headersList: Header[] = [];
  if (Array.isArray(headersObj)) {
    headersList = headersObj;
  } else if (headersObj && typeof headersObj === 'object') {
    headersList = Object.entries(headersObj).map(([key, value]) => ({ key, value }));
  }

  const authRaw = raw.auth as Partial<WebhookAuth> | undefined;
  const auth: WebhookAuth = authRaw ? { type: 'none', ...authRaw } : { type: 'none' };

  return {
    url: (raw.url as string) ?? DEFAULT_CONFIG.url,
    method: (raw.method as string) ?? DEFAULT_CONFIG.method,
    mode: (raw.mode as WebhookConfig['mode']) ?? DEFAULT_CONFIG.mode,
    outputType: (raw.outputType as WebhookConfig['outputType']) ?? DEFAULT_CONFIG.outputType,
    entryPoint: (raw.entryPoint as WebhookConfig['entryPoint']) ?? DEFAULT_CONFIG.entryPoint,
    auth,
    headers: headersList,
    timeout: (raw.timeout as number) ?? DEFAULT_CONFIG.timeout,
    retries: (raw.retries as number) ?? DEFAULT_CONFIG.retries,
    onError: stageOnError ?? DEFAULT_CONFIG.onError,
  };
}

// =============================================================================
// COMPONENT
// =============================================================================

export function ConfigSidePanel() {
  const t = useTranslations('search_ai.pipeline');
  const activePanelType = usePipelineStore((s) => s.activePanelType);
  const activePanelNodeId = usePipelineStore((s) => s.activePanelNodeId);
  const closePanel = usePipelineStore((s) => s.closePanel);
  const updateStage = usePipelineStore((s) => s.updateStage);
  const draft = usePipelineStore((s) => s.draft);

  const isOpen = activePanelType === 'config';

  // Find the stage being configured
  const stageData = useMemo(() => {
    if (!draft || !activePanelNodeId) return null;
    for (const flow of draft.flows) {
      const stage = flow.stages.find((s) => s.id === activePanelNodeId);
      if (stage) return { flowId: flow.id, stage };
    }
    return null;
  }, [draft, activePanelNodeId]);

  const [activeTab, setActiveTab] = useState('config');
  const [cfg, setCfg] = useState<WebhookConfig>(DEFAULT_CONFIG);
  const [testPayload, setTestPayload] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const tabs = useMemo(
    () => [
      { id: 'config', label: t('v2_panel_config') },
      { id: 'auth', label: t('v2_panel_auth') },
      { id: 'behavior', label: t('v2_panel_behavior') },
      { id: 'test', label: t('v2_panel_test') },
    ],
    [t],
  );

  // Load stage config when panel opens
  useEffect(() => {
    if (isOpen && stageData?.stage) {
      const raw = stageData.stage.providerConfig as Record<string, unknown> | undefined;
      setCfg(normalizeProviderConfig(raw, stageData.stage.onError));
      setHasChanges(false);
    }
  }, [isOpen, stageData]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        closePanel();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, closePanel]);

  const updateCfg = useCallback(
    <K extends keyof WebhookConfig>(key: K, value: WebhookConfig[K]) => {
      setCfg((prev) => ({ ...prev, [key]: value }));
      setHasChanges(true);
    },
    [],
  );

  const handleSave = useCallback(() => {
    if (!stageData) return;

    const headersRecord: Record<string, string> = {};
    for (const h of cfg.headers) {
      if (h.key.trim()) {
        headersRecord[h.key.trim()] = h.value;
      }
    }

    const providerConfig: Record<string, unknown> = {
      url: cfg.url,
      method: cfg.method,
      mode: cfg.mode,
      outputType: cfg.outputType,
      entryPoint: cfg.entryPoint,
      timeout: cfg.timeout,
      retries: cfg.retries,
    };

    if (Object.keys(headersRecord).length > 0) {
      providerConfig.headers = headersRecord;
    }

    if (cfg.auth.type !== 'none') {
      if (cfg.auth.type === 'bearer') {
        providerConfig.auth = { type: 'bearer', token: cfg.auth.token ?? '' };
      } else if (cfg.auth.type === 'api-key') {
        providerConfig.auth = {
          type: 'api-key',
          token: cfg.auth.token ?? '',
          headerName: cfg.auth.headerName ?? 'X-API-Key',
        };
      } else if (cfg.auth.type === 'basic') {
        providerConfig.auth = {
          type: 'basic',
          token: btoa(`${cfg.auth.username ?? ''}:${cfg.auth.password ?? ''}`),
        };
      }
    }

    updateStage(stageData.flowId, stageData.stage.id, {
      name: 'Custom API',
      provider: 'http-webhook',
      providerConfig,
      onError: cfg.onError as 'fail' | 'continue',
    });
    setHasChanges(false);
    closePanel();
  }, [stageData, cfg, updateStage, closePanel]);

  const handleReset = useCallback(() => {
    if (stageData?.stage) {
      const raw = stageData.stage.providerConfig as Record<string, unknown> | undefined;
      setCfg(normalizeProviderConfig(raw, stageData.stage.onError));
      setHasChanges(false);
    }
  }, [stageData]);

  const addHeader = useCallback(() => {
    setCfg((prev) => ({ ...prev, headers: [...prev.headers, { key: '', value: '' }] }));
  }, []);

  const removeHeader = useCallback((idx: number) => {
    setCfg((prev) => ({
      ...prev,
      headers: prev.headers.filter((_, i) => i !== idx),
    }));
  }, []);

  const updateHeader = useCallback((idx: number, field: 'key' | 'value', val: string) => {
    setCfg((prev) => ({
      ...prev,
      headers: prev.headers.map((h, i) => (i === idx ? { ...h, [field]: val } : h)),
    }));
  }, []);

  const handleTestConnection = useCallback(async () => {
    if (!cfg.url.trim()) {
      setTestResult(t('v2_panel_test_no_url'));
      return;
    }

    try {
      new URL(cfg.url);
    } catch {
      setTestResult(t('v2_panel_test_invalid_url'));
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const { projectId, knowledgeBaseId } = usePipelineStore.getState();
      if (!projectId || !knowledgeBaseId) {
        setTestResult('Error: Pipeline context not available');
        setTesting(false);
        return;
      }

      const headersRecord: Record<string, string> = {};
      for (const h of cfg.headers) {
        if (h.key.trim()) headersRecord[h.key.trim()] = h.value;
      }

      let authPayload: Record<string, string> | undefined;
      if (cfg.auth.type === 'bearer' && cfg.auth.token) {
        authPayload = { type: 'bearer', token: cfg.auth.token };
      } else if (cfg.auth.type === 'api-key' && cfg.auth.token) {
        authPayload = {
          type: 'api-key',
          token: cfg.auth.token,
          headerName: cfg.auth.headerName ?? 'X-API-Key',
        };
      } else if (cfg.auth.type === 'basic' && cfg.auth.username) {
        authPayload = {
          type: 'basic',
          token: btoa(`${cfg.auth.username}:${cfg.auth.password ?? ''}`),
        };
      }

      const response = await fetch(
        `/api/search-ai/projects/${projectId}/knowledge-bases/${knowledgeBaseId}/pipelines/test-webhook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: cfg.url,
            method: cfg.method,
            headers: Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
            auth: authPayload,
            timeout: cfg.timeout,
            payload: testPayload.trim() || undefined,
          }),
        },
      );

      const data = await response.json();

      if (data.success) {
        const preview =
          (data.body ?? '').length > 500 ? (data.body as string).slice(0, 500) + '...' : data.body;
        setTestResult(`${data.status} ${data.statusText ?? 'OK'}\n${preview}`);
      } else {
        const errMsg = data.error?.message ?? data.statusText ?? 'Request failed';
        setTestResult(`${data.status ?? response.status} ${errMsg}\n${data.body ?? ''}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setTestResult(`Error: ${msg}`);
    } finally {
      setTesting(false);
    }
  }, [cfg, testPayload, t]);

  if (!isOpen) return null;

  return (
    <div
      className="absolute top-0 right-0 z-40 flex h-full w-[420px] flex-col border-l border-default bg-background-elevated shadow-xl transition-transform duration-300"
      role="complementary"
      aria-label={t('v2_panel_config')}
    >
      {/* Header */}
      <div className="flex flex-col border-b border-default">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">{t('v2_panel_config')}</h2>
          <button
            onClick={closePanel}
            className="rounded-lg p-1.5 text-muted transition-default hover:bg-background-muted hover:text-foreground"
            aria-label={t('v2_panel_close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* Provider selector — shows options based on stage type */}
        {stageData && (
          <div className="px-4 pb-3">
            <Select
              label={t('v2_provider_label')}
              value={stageData.stage.provider}
              onChange={(newProvider) => {
                updateStage(stageData.flowId, stageData.stage.id, {
                  provider: newProvider,
                  name:
                    newProvider === 'docling'
                      ? 'Docling'
                      : newProvider === 'llamaindex'
                        ? 'LlamaIndex'
                        : newProvider === 'llm-enrichment'
                          ? 'LLM Enrichment'
                          : newProvider === 'question-synthesis'
                            ? 'Question Synthesis'
                            : 'Custom API',
                });
                usePipelineStore.setState({
                  activePanelType: null,
                  activePanelNodeId: null,
                  detailPanelCollapsed: false,
                });
              }}
              options={
                stageData.stage.type === 'enrichment'
                  ? [
                      { value: 'llm-enrichment', label: 'LLM Enrichment' },
                      { value: 'question-synthesis', label: 'Question Synthesis' },
                      { value: 'http-webhook', label: 'Custom API' },
                    ]
                  : [
                      { value: 'docling', label: 'Docling' },
                      { value: 'llamaindex', label: 'LlamaIndex' },
                      { value: 'http-webhook', label: 'Custom API' },
                    ]
              }
            />
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        layoutId="config-panel-tabs"
        className="px-4"
      />

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'config' && (
          <div className="space-y-3">
            <Input
              label={t('v2_panel_endpoint_url')}
              value={cfg.url}
              onChange={(e) => updateCfg('url', e.target.value)}
              placeholder="https://api.example.com/extract"
            />
            <Select
              label={t('v2_panel_http_method')}
              value={cfg.method}
              onChange={(v) => updateCfg('method', v)}
              options={[
                { value: 'POST', label: 'POST' },
                { value: 'GET', label: 'GET' },
                { value: 'PUT', label: 'PUT' },
                { value: 'PATCH', label: 'PATCH' },
              ]}
            />
            <Select
              label={t('v2_panel_mode')}
              value={cfg.mode}
              onChange={(v) => updateCfg('mode', v as WebhookConfig['mode'])}
              options={[
                { value: 'replacement', label: t('v2_panel_mode_replacement') },
                { value: 'transformer', label: t('v2_panel_mode_transformer') },
                { value: 'source', label: t('v2_panel_mode_source') },
              ]}
            />
            <Select
              label={t('v2_panel_output_type')}
              value={cfg.outputType}
              onChange={(v) => updateCfg('outputType', v as WebhookConfig['outputType'])}
              options={[
                { value: 'text', label: t('v2_panel_output_text') },
                { value: 'pages', label: t('v2_panel_output_pages') },
                { value: 'chunks', label: t('v2_panel_output_chunks') },
                { value: 'document', label: t('v2_panel_output_document') },
                { value: 'enriched-chunks', label: t('v2_panel_output_enriched_chunks') },
              ]}
            />
            <Select
              label={t('v2_panel_entry_point')}
              value={cfg.entryPoint}
              onChange={(v) => updateCfg('entryPoint', v as WebhookConfig['entryPoint'])}
              options={[
                { value: 'after-extraction', label: t('v2_panel_entry_after_extraction') },
                { value: 'before-extraction', label: t('v2_panel_entry_before_extraction') },
                { value: 'after-chunking', label: t('v2_panel_entry_after_chunking') },
                { value: 'after-enrichment', label: t('v2_panel_entry_after_enrichment') },
              ]}
            />
            <p className="text-[11px] text-foreground-muted">
              {t('v2_panel_pipeline_routing_hint')}
            </p>
          </div>
        )}

        {activeTab === 'auth' && (
          <div className="space-y-3">
            <Select
              label={t('v2_panel_auth_type')}
              value={cfg.auth.type}
              onChange={(v) => {
                setCfg((prev) => ({
                  ...prev,
                  auth: { ...prev.auth, type: v as WebhookAuth['type'] },
                }));
                setHasChanges(true);
              }}
              options={[
                { value: 'none', label: t('v2_panel_auth_none') },
                { value: 'bearer', label: t('v2_panel_auth_bearer') },
                { value: 'api-key', label: t('v2_panel_auth_api_key') },
                { value: 'basic', label: t('v2_panel_auth_basic') },
              ]}
            />
            {cfg.auth.type === 'bearer' && (
              <Input
                label={t('v2_panel_auth_bearer')}
                type="password"
                value={cfg.auth.token ?? ''}
                onChange={(e) => {
                  setCfg((prev) => ({ ...prev, auth: { ...prev.auth, token: e.target.value } }));
                  setHasChanges(true);
                }}
              />
            )}
            {cfg.auth.type === 'api-key' && (
              <>
                <Input
                  label={t('v2_panel_auth_api_key')}
                  value={cfg.auth.headerName ?? ''}
                  onChange={(e) => {
                    setCfg((prev) => ({
                      ...prev,
                      auth: { ...prev.auth, headerName: e.target.value },
                    }));
                    setHasChanges(true);
                  }}
                  placeholder="X-API-Key"
                />
                <Input
                  label={t('v2_panel_auth_api_key') + ' Value'}
                  type="password"
                  value={cfg.auth.token ?? ''}
                  onChange={(e) => {
                    setCfg((prev) => ({ ...prev, auth: { ...prev.auth, token: e.target.value } }));
                    setHasChanges(true);
                  }}
                />
              </>
            )}
            {cfg.auth.type === 'basic' && (
              <>
                <Input
                  label={t('v2_panel_auth_basic') + ' Username'}
                  value={cfg.auth.username ?? ''}
                  onChange={(e) => {
                    setCfg((prev) => ({
                      ...prev,
                      auth: { ...prev.auth, username: e.target.value },
                    }));
                    setHasChanges(true);
                  }}
                  placeholder="username"
                />
                <Input
                  label={t('v2_panel_auth_basic') + ' Password'}
                  type="password"
                  value={cfg.auth.password ?? ''}
                  onChange={(e) => {
                    setCfg((prev) => ({
                      ...prev,
                      auth: { ...prev.auth, password: e.target.value },
                    }));
                    setHasChanges(true);
                  }}
                />
              </>
            )}

            {/* Custom Headers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{t('v2_panel_headers')}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={addHeader}
                  icon={<Plus className="h-3 w-3" />}
                >
                  {t('v2_panel_add_header')}
                </Button>
              </div>
              {cfg.headers.map((header, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={header.key}
                    onChange={(e) => updateHeader(idx, 'key', e.target.value)}
                    placeholder={t('v2_panel_header_name')}
                    className="flex-1"
                  />
                  <Input
                    value={header.value}
                    onChange={(e) => updateHeader(idx, 'value', e.target.value)}
                    placeholder={t('v2_panel_header_value')}
                    className="flex-1"
                  />
                  <button
                    onClick={() => removeHeader(idx)}
                    className="shrink-0 rounded p-1 text-muted hover:text-error"
                    aria-label={t('v2_panel_close')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'behavior' && (
          <div className="space-y-3">
            <Input
              label={t('v2_panel_timeout')}
              type="number"
              value={String(cfg.timeout)}
              onChange={(e) => updateCfg('timeout', Number(e.target.value))}
              min={1000}
              max={300000}
            />
            <Input
              label={t('v2_panel_retries')}
              type="number"
              value={String(cfg.retries)}
              onChange={(e) =>
                updateCfg('retries', Math.min(5, Math.max(0, Number(e.target.value))))
              }
              min={0}
              max={5}
            />
            <Select
              label={t('v2_config_on_error')}
              value={cfg.onError}
              onChange={(v) => updateCfg('onError', v)}
              options={[
                { value: 'fail', label: t('v2_config_on_error_fail') },
                { value: 'continue', label: t('v2_config_on_error_continue') },
              ]}
            />
          </div>
        )}

        {activeTab === 'test' && (
          <div className="space-y-3">
            <Textarea
              label={t('v2_panel_test_payload')}
              value={testPayload}
              onChange={(e) => setTestPayload(e.target.value)}
              rows={6}
              className="font-mono text-xs"
              placeholder='{"content": "sample document text"}'
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={handleTestConnection}
              loading={testing}
              disabled={testing}
            >
              {t('v2_panel_test_connection')}
            </Button>
            {testResult !== null && (
              <pre
                className={`whitespace-pre-wrap rounded-lg border p-3 text-xs ${
                  testResult.startsWith('2')
                    ? 'border-success bg-success-subtle text-success'
                    : 'border-error/30 bg-error/5 text-error'
                }`}
              >
                {testResult}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex gap-2 border-t border-default px-4 py-3">
        <Button size="sm" variant="primary" onClick={handleSave} disabled={!hasChanges}>
          {t('v2_config_apply')}
        </Button>
        <Button size="sm" variant="ghost" onClick={handleReset} disabled={!hasChanges}>
          {t('v2_detail_reset')}
        </Button>
      </div>
    </div>
  );
}
