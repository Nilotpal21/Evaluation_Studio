'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Play, Upload, X } from 'lucide-react';
import { useProjectStore } from '../../store/project-store';
import { useNavigationStore } from '../../store/navigation-store';
import {
  streamTestPrompt,
  fetchVersions,
  type PromptLibraryVersion,
  type TestPaneResult,
} from '../../api/prompt-library';
import { PromptComparePanel } from './PromptComparePanel';
import { Select } from '../ui/Select';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { formatModelOptionLabel } from '../../lib/model-display';
import { extractVariables } from './PromptEditor';

interface TenantModelItem {
  id: string;
  displayName?: string;
  provider?: string | null;
  modelId?: string | null;
  isActive: boolean;
}

interface ContextFile {
  name: string;
  content: string;
}

function modelLabel(m: TenantModelItem): string {
  return formatModelOptionLabel(m);
}

function versionLabel(v: PromptLibraryVersion): string {
  return `v${v.versionNumber} — ${v.status}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

interface PromptLibraryComparePageProps {
  promptId: string;
}

export function PromptLibraryComparePage({ promptId }: PromptLibraryComparePageProps) {
  const t = useTranslations('prompt_library.compare');
  const currentProject = useProjectStore((s) => s.currentProject);
  const navigate = useNavigationStore((s) => s.navigate);

  // All API calls are session-scoped; tenantId is resolved server-side via NextAuth
  const projectId = currentProject?.id;

  const [tenantModels, setTenantModels] = useState<TenantModelItem[]>([]);
  const [versions, setVersions] = useState<PromptLibraryVersion[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(true);

  const [selectedVersionId, setSelectedVersionId] = useState('');
  const [leftModelId, setLeftModelId] = useState('');
  const [rightModelId, setRightModelId] = useState('');

  const [variables, setVariables] = useState<Record<string, string>>({});
  const [contextFile, setContextFile] = useState<ContextFile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [userMessage, setUserMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<TestPaneResult[]>([]);
  const [headers, setHeaders] = useState<{ label: string; sublabel?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    setLoadingConfig(true);
    // Load tenant models (tenantId scoped server-side) and available prompt versions
    void Promise.all([
      apiFetch('/api/tenant-models').then(
        (r) => r.json() as Promise<{ models: TenantModelItem[] }>,
      ),
      fetchVersions(projectId, promptId),
    ])
      .then(([modelsData, versionsData]) => {
        const active = (modelsData.models ?? []).filter((m) => m.isActive);
        setTenantModels(active);
        if (active.length >= 1) setLeftModelId(active[0].id);
        if (active.length >= 2) setRightModelId(active[1].id);

        const vlist = versionsData.items ?? [];
        setVersions(vlist);
        const first = vlist.find((v) => v.status === 'active') ?? vlist[0];
        if (first) setSelectedVersionId(first._id);
      })
      .catch(() => {
        // leave empty state — user sees no_versions / no_models option text
      })
      .finally(() => setLoadingConfig(false));
  }, [projectId, promptId]);

  const selectedVersion = versions.find((v) => v._id === selectedVersionId);
  const variableKeys = selectedVersion ? extractVariables(selectedVersion.template) : [];

  const handleFileChange = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setContextFile({ name: file.name, content });
    };
    reader.readAsText(file);
    evt.target.value = '';
  }, []);

  const abortRef = useRef<AbortController | null>(null);

  // Abort streaming on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const canRun = Boolean(
    projectId && selectedVersionId && leftModelId && rightModelId && userMessage.trim(),
  );

  const handleRun = useCallback(async () => {
    if (!canRun || !projectId) return;

    // Abort any in-flight stream
    abortRef.current?.abort();

    const abortCtrl = new AbortController();
    abortRef.current = abortCtrl;

    const paneOrder = [leftModelId, rightModelId];

    // Initialize immediately — show the panel with streaming cursors
    setResults(
      paneOrder.map((modelId) => ({
        promptVersionId: selectedVersionId,
        tenantModelId: modelId,
        streaming: true,
      })),
    );
    setRunning(true);
    setError(null);

    const leftItem = tenantModels.find((m) => m.id === leftModelId);
    const rightItem = tenantModels.find((m) => m.id === rightModelId);
    setHeaders([
      { label: leftItem ? modelLabel(leftItem) : leftModelId },
      { label: rightItem ? modelLabel(rightItem) : rightModelId },
    ]);

    const allVars = { ...variables };
    if (contextFile) allVars['file_context'] = contextFile.content;

    // Accumulated text per pane index (local to this run — avoids state races)
    const acc: Record<number, string> = {};

    try {
      const stream = streamTestPrompt(
        projectId,
        {
          variables: Object.keys(allVars).length > 0 ? allVars : undefined,
          userMessage: userMessage.trim() || undefined,
          panes: paneOrder.map((id) => ({
            promptVersionId: selectedVersionId,
            tenantModelId: id,
          })),
        },
        abortCtrl.signal,
      );

      for await (const event of stream) {
        if (event.type === 'pane_delta') {
          acc[event.paneIndex] = (acc[event.paneIndex] ?? '') + event.text;
          const text = acc[event.paneIndex];
          setResults((prev) => {
            const next = [...prev];
            if (next[event.paneIndex]) {
              next[event.paneIndex] = { ...next[event.paneIndex], output: text };
            }
            return next;
          });
        } else if (event.type === 'pane_done') {
          setResults((prev) => {
            const next = [...prev];
            if (next[event.paneIndex]) {
              next[event.paneIndex] = {
                ...next[event.paneIndex],
                streaming: false,
                inputTokens: event.usage.input,
                outputTokens: event.usage.output,
                latencyMs: event.latencyMs,
                model: event.model,
                provider: event.provider,
              };
            }
            return next;
          });
        } else if (event.type === 'pane_error') {
          setResults((prev) => {
            const next = [...prev];
            if (next[event.paneIndex]) {
              next[event.paneIndex] = {
                ...next[event.paneIndex],
                streaming: false,
                error: event.error,
              };
            }
            return next;
          });
        }
        // 'done' and 'pane_start' need no state update
      }
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        setError(sanitizeError(err, 'Test run failed'));
        // Mark all still-streaming panes as not streaming
        setResults((prev) => prev.map((p) => (p.streaming ? { ...p, streaming: false } : p)));
      }
    } finally {
      setRunning(false);
    }
  }, [
    canRun,
    projectId,
    variables,
    contextFile,
    tenantModels,
    leftModelId,
    rightModelId,
    selectedVersionId,
    userMessage,
  ]);

  if (!projectId) return null;

  const versionOptions = versions.map((v) => ({ value: v._id, label: versionLabel(v) }));
  const modelOptions = tenantModels.map((m) => ({ value: m.id, label: modelLabel(m) }));

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-default shrink-0">
        <button
          type="button"
          onClick={() => navigate(`/projects/${projectId}/prompt-library/${promptId}`)}
          className="flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground mb-2 transition-colors"
        >
          <ArrowLeft className="h-3 w-3" />
          {t('back_to_prompt')}
        </button>
        <h1 className="text-lg font-semibold text-foreground">{t('title')}</h1>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: config */}
        <div className="w-80 shrink-0 flex flex-col border-r border-default overflow-y-auto">
          {loadingConfig ? (
            <div className="p-4 text-sm text-foreground-muted">{t('loading')}</div>
          ) : (
            <div className="p-4 space-y-5">
              {/* Version selector */}
              <div>
                <p className="text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wide">
                  {t('version_label')}
                </p>
                <Select
                  options={versionOptions}
                  value={selectedVersionId}
                  onChange={setSelectedVersionId}
                  placeholder={t('no_versions')}
                  disabled={loadingConfig}
                />
              </div>

              {/* Model A */}
              <div>
                <p className="text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wide">
                  {t('model_a_label')}
                </p>
                <Select
                  options={modelOptions}
                  value={leftModelId}
                  onChange={setLeftModelId}
                  placeholder={t('no_models')}
                  disabled={loadingConfig}
                />
              </div>

              {/* Model B */}
              <div>
                <p className="text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wide">
                  {t('model_b_label')}
                </p>
                <Select
                  options={modelOptions}
                  value={rightModelId}
                  onChange={setRightModelId}
                  placeholder={t('no_models')}
                  disabled={loadingConfig}
                />
              </div>

              {/* Context values — auto-derived from template variables */}
              {variableKeys.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wide">
                    {t('variables_section')}
                  </p>
                  <div className="space-y-3">
                    {variableKeys.map((key) => (
                      <div key={key}>
                        <label className="block text-xs text-foreground-muted mb-1">
                          {`{{${key}}}`}
                        </label>
                        <textarea
                          value={variables[key] ?? ''}
                          onChange={(e) =>
                            setVariables((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder={t('variable_placeholder')}
                          rows={2}
                          className="w-full rounded-lg border border-default bg-background-subtle px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-y"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Context file upload — injects as {{file_context}} */}
              <div>
                <p className="text-xs font-medium text-foreground-muted mb-1 uppercase tracking-wide">
                  {t('context_file_label')}
                </p>
                <p className="text-xs text-foreground-muted mb-2">{t('context_file_hint')}</p>
                {contextFile ? (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-default bg-background-muted text-sm">
                    <span className="flex-1 truncate text-foreground">{contextFile.name}</span>
                    <button
                      type="button"
                      onClick={() => setContextFile(null)}
                      className="text-foreground-muted hover:text-status-error transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-2 w-full rounded-lg border border-dashed border-default px-3 py-2 text-sm text-foreground-muted hover:border-accent hover:text-foreground transition-colors"
                  >
                    <Upload className="h-4 w-4" />
                    {t('context_file_upload')}
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.csv,.json,.xml,.html"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>

              {/* User message */}
              <div>
                <p className="text-xs font-medium text-foreground-muted mb-2 uppercase tracking-wide">
                  {t('user_message_label')}
                </p>
                <textarea
                  value={userMessage}
                  onChange={(e) => setUserMessage(e.target.value)}
                  placeholder={t('user_message_placeholder')}
                  rows={4}
                  className="w-full rounded-lg border border-default bg-background-subtle px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-accent/50 focus:border-accent resize-y"
                />
              </div>

              {/* Run */}
              <button
                type="button"
                disabled={running || !canRun}
                onClick={() => void handleRun()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {running ? (
                  t('running')
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    {t('run_test')}
                  </>
                )}
              </button>

              {error && <p className="text-xs text-status-error">{error}</p>}
            </div>
          )}
        </div>

        {/* Right panel: results */}
        <div className="flex-1 overflow-y-auto p-6">
          {results.length > 0 || running ? (
            <PromptComparePanel
              results={results}
              headers={headers}
              isLoading={running && results.length === 0}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-foreground-muted max-w-xs text-center">
                Select a version and two models, add context values, then click &ldquo;
                {t('run_test')}&rdquo; to compare side-by-side.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
