/**
 * OverviewTab
 *
 * Two modes:
 * - No selection: Session summary (agent name, session ID, counts, timestamps, models, tokens)
 * - Node selected: Detail sub-tabs (Preview / Request / Response / Metadata)
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Hash,
  MessageSquare,
  Activity,
  Calendar,
  Cpu,
  Coins,
  Copy,
  Check,
  Wifi,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useObservatoryStore } from '../../store/observatory-store';
import { useProjectStore } from '../../store/project-store';
import { useSessionStore } from '../../store/session-store';
import { apiFetch } from '../../lib/api-client';
import {
  formatDurationFromSeconds,
  type StudioSessionTimeoutDiagnostics,
} from '../../lib/session-timeout-config';
import { JsonViewer } from '../ui/JsonViewer';
import type { TreeNode } from '../../hooks/useSessionDetail';
import type { TraceEvent } from '../../types';
import { VoicePreview, isVoiceNode } from './VoiceMetricsTab';
import { ModelResolutionInspector } from '../observatory/ModelResolutionInspector';
import { useOptionalWebSocketContext } from '../../contexts/WebSocketContext';
import { StatusDot } from '../ui/StatusDot';
import { SessionIdDisplay } from './SessionIdDisplay';
import { TraceCausalChips } from '../trace/TraceCausality';
import { getTraceCausalFields, hasTraceCausality } from '../../utils/trace-causality';

// ── Types ───────────────────────────────────────────────────────────────────

interface OverviewTabProps {
  traceEvents?: TraceEvent[];
  tree?: TreeNode[];
  sessionId?: string;
  agentName?: string;
  messageCount?: number;
  createdAt?: string;
  finishedAt?: string;
}

type DetailSubTab = 'preview' | 'request' | 'response' | 'metrics' | 'metadata';

interface LLMData {
  model?: string;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  tools?: unknown;
}

// ── Main Component ──────────────────────────────────────────────────────────

export function OverviewTab({
  traceEvents: propTraceEvents,
  tree: propTree,
  sessionId: propSessionId,
  agentName: propAgentName,
  messageCount: propMessageCount,
  createdAt: propCreatedAt,
  finishedAt: propFinishedAt,
}: OverviewTabProps) {
  const selectedExecutionNodeId = useObservatoryStore((s) => s.selection.executionNodeId);
  const t = useTranslations('sessions.summary');
  const [detailSubTab, setDetailSubTab] = useState<DetailSubTab>('preview');

  // Fall back to observatory/session store for live chat mode (no props passed)
  const storeEvents = useObservatoryStore((s) => s.events);
  const storeAgent = useSessionStore((s) => s.agent);
  const storeMessages = useSessionStore((s) => s.messages);

  const storeSessionId = useSessionStore((s) => s.sessionId);

  const traceEvents = propTraceEvents ?? (storeEvents as TraceEvent[]) ?? [];
  const tree = propTree ?? [];
  const sessionId = propSessionId ?? storeSessionId ?? undefined;
  const agentName = propAgentName ?? storeAgent?.name;
  const messageCount = propMessageCount ?? storeMessages.length;
  const createdAt = propCreatedAt;
  const finishedAt = propFinishedAt;

  const selectedNode = useMemo(() => {
    if (!selectedExecutionNodeId) return null;
    return findNodeById(tree, selectedExecutionNodeId);
  }, [tree, selectedExecutionNodeId]);

  const selectedEvent = useMemo(() => {
    if (!selectedExecutionNodeId) return null;
    return (
      traceEvents.find(
        (event) =>
          event.id === selectedExecutionNodeId ||
          event.spanId === selectedNode?.spanId ||
          event.id === selectedNode?.spanId,
      ) || null
    );
  }, [traceEvents, selectedExecutionNodeId, selectedNode]);

  const llmData = useMemo(() => {
    if (!selectedEvent && !selectedNode) return null;
    const data = selectedEvent?.data || selectedNode?.data || {};
    return extractLLMData(data);
  }, [selectedEvent, selectedNode]);

  const subTabs = useMemo((): { value: DetailSubTab; label: string }[] => {
    if (!selectedNode) {
      return [
        { value: 'preview', label: t('tab_preview') },
        { value: 'metadata', label: t('tab_metadata') },
      ];
    }

    if (selectedNode.type === 'user_input' || selectedNode.type === 'agent_response') {
      return [
        { value: 'preview', label: 'Message' },
        { value: 'metadata', label: t('tab_metadata') },
      ];
    }

    if (selectedNode.type === 'llm_call') {
      return [
        { value: 'preview', label: 'Overview' },
        { value: 'request', label: t('tab_request') },
        { value: 'response', label: t('tab_response') },
        { value: 'metrics', label: 'Metrics' },
        { value: 'metadata', label: t('tab_metadata') },
      ];
    }

    if (selectedNode.type === 'tool_call') {
      return [
        { value: 'preview', label: 'Overview' },
        { value: 'request', label: 'Input' },
        { value: 'response', label: 'Output' },
        { value: 'metrics', label: 'Metrics' },
        { value: 'metadata', label: t('tab_metadata') },
      ];
    }

    return [
      { value: 'preview', label: 'Overview' },
      { value: 'metrics', label: 'Performance' },
      { value: 'metadata', label: t('tab_metadata') },
    ];
  }, [selectedNode, t]);

  useEffect(() => {
    if (!subTabs.some((tab) => tab.value === detailSubTab)) {
      setDetailSubTab(subTabs[0]?.value ?? 'preview');
    }
  }, [detailSubTab, subTabs]);

  // No selection — show session summary
  if (!selectedExecutionNodeId) {
    return (
      <SessionSummaryView
        traceEvents={traceEvents}
        sessionId={sessionId}
        agentName={agentName}
        messageCount={messageCount}
        createdAt={createdAt}
        finishedAt={finishedAt}
      />
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Node header */}
      {selectedNode && (
        <div className="px-4 py-3 border-b border-default">
          <div className="flex items-center gap-3 text-sm">
            <span className="font-medium text-foreground truncate max-w-[240px]">
              {selectedNode.label}
            </span>
            <span className="text-xs text-muted">{selectedNode.type}</span>
            {selectedNode.latencyMs != null && selectedNode.latencyMs > 0 && (
              <span className="text-xs text-muted ml-auto tabular-nums">
                {selectedNode.latencyMs < 1000
                  ? `${selectedNode.latencyMs}ms`
                  : `${(selectedNode.latencyMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Sub-tab bar */}
      <div className="flex border-b border-default px-4">
        {subTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setDetailSubTab(tab.value)}
            className={`px-3 py-2 text-xs font-medium transition-colors border-b-2 ${
              detailSubTab === tab.value
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      <div className="flex-1 overflow-auto p-4">
        {detailSubTab === 'preview' && <PreviewTab llmData={llmData} selectedNode={selectedNode} />}
        {detailSubTab === 'request' && (
          <RequestTab llmData={llmData} selectedEvent={selectedEvent} />
        )}
        {detailSubTab === 'response' && (
          <ResponseTab llmData={llmData} selectedEvent={selectedEvent} />
        )}
        {detailSubTab === 'metrics' && (
          <MetricsDetailTab selectedNode={selectedNode} selectedEvent={selectedEvent} />
        )}
        {detailSubTab === 'metadata' && (
          <MetadataTab llmData={llmData} selectedEvent={selectedEvent} />
        )}
      </div>
    </div>
  );
}

// ── Session Summary View (no selection) ─────────────────────────────────────

function SessionSummaryView({
  traceEvents,
  sessionId,
  agentName,
  messageCount,
  createdAt,
  finishedAt,
}: {
  traceEvents: TraceEvent[];
  sessionId?: string;
  agentName?: string;
  messageCount?: number;
  createdAt?: string;
  finishedAt?: string;
}) {
  const t = useTranslations('sessions.summary');
  const tSessions = useTranslations('sessions');
  const wsContext = useOptionalWebSocketContext();
  const isConnected = wsContext?.isConnected ?? false;
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? s.currentProjectId);

  const stats = useMemo(() => {
    const models = new Set<string>();
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCost = 0;
    let llmCalls = 0;

    for (const event of traceEvents) {
      const data = event.data || {};
      if (event.type === 'llm_call') {
        llmCalls++;
        const model = data.model as string | undefined;
        if (model) models.add(model);
        const tokensIn =
          (data.tokensIn as number) || (data.tokenUsage as Record<string, number>)?.input || 0;
        const tokensOut =
          (data.tokensOut as number) || (data.tokenUsage as Record<string, number>)?.output || 0;
        totalTokensIn += tokensIn;
        totalTokensOut += tokensOut;
        if (typeof data.cost === 'number') totalCost += data.cost;
      }
    }

    return {
      models: Array.from(models),
      totalTokensIn,
      totalTokensOut,
      totalTokens: totalTokensIn + totalTokensOut,
      totalCost,
      llmCalls,
    };
  }, [traceEvents]);

  return (
    <div className="p-4 space-y-6">
      {/* Identity */}
      <section>
        <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
          {t('title')}
        </h3>
        <div className="space-y-2">
          <SummaryRow
            icon={<Bot className="w-3.5 h-3.5" />}
            label={t('agent_label') || 'Agent'}
            value={agentName || '--'}
          />
          <SummaryRow
            icon={<Hash className="w-3.5 h-3.5" />}
            label={t('session_id_label') || 'Session'}
            value={
              <SessionIdDisplay
                sessionId={sessionId}
                copyValue={sessionId}
                copyLabel={tSessions('copy_id')}
                copiedLabel={t('copied')}
                valueClassName="text-xs text-foreground"
              />
            }
          />
          <SummaryRow
            icon={<MessageSquare className="w-3.5 h-3.5" />}
            label={t('messages_label') || 'Messages'}
            value={String(messageCount ?? 0)}
          />
          <SummaryRow
            icon={<Activity className="w-3.5 h-3.5" />}
            label={t('trace_events_label') || 'Trace Events'}
            value={String(traceEvents.length)}
          />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">
              <Wifi className="w-3.5 h-3.5" />
            </span>
            <span className="text-muted">{t('connection_label') || 'Connection'}:</span>
            <StatusDot
              color={isConnected ? 'green' : 'red'}
              pulse={isConnected}
              size="sm"
              label={
                isConnected ? t('connected') || 'Connected' : t('disconnected') || 'Disconnected'
              }
            />
          </div>
        </div>
      </section>

      {/* Timestamps */}
      {(createdAt || finishedAt) && (
        <section>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            {t('timestamps_label') || 'Timestamps'}
          </h3>
          <div className="space-y-2">
            {createdAt && (
              <SummaryRow
                icon={<Calendar className="w-3.5 h-3.5" />}
                label={t('started_label') || 'Started'}
                value={formatTimestamp(new Date(createdAt))}
              />
            )}
            {finishedAt && (
              <SummaryRow
                icon={<Calendar className="w-3.5 h-3.5" />}
                label={t('finished')}
                value={formatTimestamp(new Date(finishedAt))}
              />
            )}
          </div>
        </section>
      )}

      {/* Models Used */}
      {stats.models.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            {t('models_used_label') || 'Models Used'}
          </h3>
          <div className="flex flex-wrap gap-2">
            {stats.models.map((model) => (
              <span
                key={model}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-background-muted text-xs font-mono text-foreground"
              >
                <Cpu className="w-3 h-3 text-muted" />
                {model}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Token Breakdown */}
      {stats.totalTokens > 0 && (
        <section>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            {t('token_breakdown_label') || 'Token Breakdown'}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label={t('tokens_in') || 'Input'}
              value={stats.totalTokensIn.toLocaleString()}
            />
            <StatCard
              label={t('tokens_out') || 'Output'}
              value={stats.totalTokensOut.toLocaleString()}
            />
            <StatCard label={t('total_tokens')} value={stats.totalTokens.toLocaleString()} />
            <StatCard label={t('llm_calls_label') || 'LLM Calls'} value={String(stats.llmCalls)} />
          </div>
          {stats.totalCost > 0 && (
            <div className="mt-3 flex items-center gap-1.5 text-sm">
              <Coins className="w-3.5 h-3.5 text-muted" />
              <span className="text-muted">{t('cost')}:</span>
              <span className="font-medium text-foreground">${stats.totalCost.toFixed(6)}</span>
            </div>
          )}
        </section>
      )}

      <TimeoutDiagnosticsSection projectId={currentProjectId} agentName={agentName} />

      {/* Model Resolution Chain */}
      <section>
        <ModelResolutionInspector />
      </section>
    </div>
  );
}

function TimeoutDiagnosticsSection({
  projectId,
  agentName,
}: {
  projectId: string | null;
  agentName?: string;
}) {
  const t = useTranslations('sessions.summary');
  const [diagnostics, setDiagnostics] = useState<StudioSessionTimeoutDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!projectId) {
      setDiagnostics(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    const searchParams = new URLSearchParams();
    if (agentName) {
      searchParams.set('agentName', agentName);
    }

    setIsLoading(true);
    setError(null);

    void apiFetch(
      `/api/projects/${encodeURIComponent(projectId)}/session-timeout-diagnostics${
        searchParams.toString() ? `?${searchParams.toString()}` : ''
      }`,
      {
        cache: 'no-store',
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          success?: boolean;
          data?: StudioSessionTimeoutDiagnostics;
          error?: { message?: string };
        } | null;

        if (!response.ok || !payload?.success || !payload.data) {
          throw new Error(payload?.error?.message || t('timeout_diagnostics_load_failed'));
        }

        setDiagnostics(payload.data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') {
          return;
        }

        setDiagnostics(null);
        setError(err instanceof Error ? err.message : t('timeout_diagnostics_load_failed'));
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [agentName, projectId, t]);

  if (!projectId) {
    return null;
  }

  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
        {t('timeout_diagnostics_label')}
      </h3>

      {error && (
        <div className="px-3 py-2 bg-background-muted rounded-lg text-sm text-muted">{error}</div>
      )}

      {!error && (
        <div className="grid grid-cols-2 gap-3">
          <TimeoutDiagnosticCard
            label={t('timeout_browser_idle')}
            value={
              diagnostics ? formatDurationFromSeconds(diagnostics.browserIdle.valueSeconds) : '--'
            }
            source={diagnostics?.browserIdle.source}
            isLoading={isLoading}
            t={t}
          />
          <TimeoutDiagnosticCard
            label={t('timeout_access_token_ttl')}
            value={
              diagnostics ? formatDurationFromSeconds(diagnostics.authToken.accessTtlSeconds) : '--'
            }
            source={diagnostics?.authToken.source}
            isLoading={isLoading}
            t={t}
          />
          <TimeoutDiagnosticCard
            label={t('timeout_runtime_idle')}
            value={formatDurationFromSeconds(diagnostics?.runtime.idleSeconds.value)}
            source={diagnostics?.runtime.idleSeconds.source}
            isLoading={isLoading}
            t={t}
          />
          <TimeoutDiagnosticCard
            label={t('timeout_runtime_max_age')}
            value={formatDurationFromSeconds(diagnostics?.runtime.maxAgeSeconds.value)}
            source={diagnostics?.runtime.maxAgeSeconds.source}
            isLoading={isLoading}
            t={t}
          />
        </div>
      )}
    </section>
  );
}

// ── Preview Tab ─────────────────────────────────────────────────────────────

function PreviewTab({
  llmData,
  selectedNode,
}: {
  llmData: LLMData | null;
  selectedNode: TreeNode | null;
}) {
  const t = useTranslations('sessions.summary');

  if (!llmData && !selectedNode) {
    return <EmptyTabMessage message={t('select_node_preview')} />;
  }

  const rawData = selectedNode?.data || {};
  const tokensIn =
    (rawData.tokensIn as number) || (rawData.tokenUsage as Record<string, number>)?.input || 0;
  const tokensOut =
    (rawData.tokensOut as number) || (rawData.tokenUsage as Record<string, number>)?.output || 0;
  const messagesIn = rawData.messagesIn as number | undefined;
  const cost = rawData.cost as number | undefined;
  const latencyMs = (rawData.latencyMs as number) || (rawData.durationMs as number) || 0;
  const purpose = rawData.purpose as string | undefined;

  return (
    <div className="space-y-6">
      {llmData && (
        <div>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            {t('model_parameters')}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <ParamRow label={t('model')} value={llmData.model || '--'} />
            <ParamRow label={t('temperature')} value={llmData.temperature?.toString() || '--'} />
            <ParamRow label={t('top_p')} value={llmData.topP?.toString() || '--'} />
            <ParamRow
              label={t('frequency_penalty')}
              value={llmData.frequencyPenalty?.toString() || '0'}
            />
            <ParamRow
              label={t('presence_penalty')}
              value={llmData.presencePenalty?.toString() || '0'}
            />
          </div>
        </div>
      )}

      {(tokensIn > 0 || tokensOut > 0 || latencyMs > 0) &&
        !(selectedNode && isVoiceNode(selectedNode.type)) && (
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              {t('execution_metrics')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label={t('tokens_in')} value={tokensIn.toLocaleString()} />
              <ParamRow label={t('tokens_out')} value={tokensOut.toLocaleString()} />
              {messagesIn != null && (
                <ParamRow label={t('messages_in')} value={messagesIn.toString()} />
              )}
              <ParamRow
                label={t('latency_label')}
                value={latencyMs < 1000 ? `${latencyMs}ms` : `${(latencyMs / 1000).toFixed(1)}s`}
              />
              {cost != null && <ParamRow label={t('cost_label')} value={`$${cost.toFixed(6)}`} />}
              {purpose && <ParamRow label={t('purpose')} value={purpose} />}
            </div>
          </div>
        )}

      {llmData?.systemPrompt && (
        <div>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
            {t('input')}
          </h3>
          <div className="bg-background-muted rounded-lg p-4">
            <h4 className="text-xs font-medium text-muted mb-2">{t('system')}</h4>
            <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
              {llmData.systemPrompt}
            </pre>
          </div>
        </div>
      )}

      {!llmData && selectedNode && isVoiceNode(selectedNode.type) && (
        <VoicePreview node={selectedNode} />
      )}

      {!llmData &&
        selectedNode?.type === 'tool_call' &&
        selectedNode.data &&
        (() => {
          const toolData = selectedNode.data as Record<string, unknown>;
          const toolName = typeof toolData.toolName === 'string' ? toolData.toolName : undefined;
          const toolSuccess = typeof toolData.success === 'boolean' ? toolData.success : undefined;
          const toolOutput = toolData.output;
          const toolError = typeof toolData.error === 'string' ? toolData.error : undefined;

          return (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                  {t('tool_details') || 'Tool Details'}
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {toolName && <ParamRow label={t('tool_name') || 'Tool'} value={toolName} />}
                  {toolSuccess !== undefined && (
                    <ParamRow
                      label={t('status') || 'Status'}
                      value={toolSuccess ? 'Success' : 'Failed'}
                    />
                  )}
                  {selectedNode.latencyMs != null && selectedNode.latencyMs > 0 && (
                    <ParamRow
                      label={t('latency_label')}
                      value={
                        selectedNode.latencyMs < 1000
                          ? `${selectedNode.latencyMs}ms`
                          : `${(selectedNode.latencyMs / 1000).toFixed(1)}s`
                      }
                    />
                  )}
                </div>
              </div>
              {toolOutput !== undefined && (
                <div>
                  <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                    {t('output') || 'Output'}
                  </h3>
                  <div className="bg-background-muted rounded-lg p-4">
                    {typeof toolOutput === 'string' ? (
                      <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
                        {toolOutput}
                      </pre>
                    ) : (
                      <JsonViewer data={toolOutput} maxDepth={8} copyable />
                    )}
                  </div>
                </div>
              )}
              {toolError && (
                <div>
                  <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                    {t('error') || 'Error'}
                  </h3>
                  <div className="bg-background-muted rounded-lg p-4">
                    <pre className="text-sm text-error whitespace-pre-wrap font-mono leading-relaxed">
                      {toolError}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          );
        })()}

      {!llmData &&
        selectedNode?.data &&
        selectedNode.type !== 'tool_call' &&
        !isVoiceNode(selectedNode.type) && (
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              {t('node_data')}
            </h3>
            <JsonViewer data={selectedNode.data} maxDepth={6} copyable />
          </div>
        )}
    </div>
  );
}

// ── Request Tab ─────────────────────────────────────────────────────────────

function RequestTab({
  llmData,
  selectedEvent,
}: {
  llmData: LLMData | null;
  selectedEvent: TraceEvent | null;
}) {
  const t = useTranslations('sessions.summary');
  const requestData =
    llmData?.request ||
    (selectedEvent?.data as Record<string, unknown>)?.messages ||
    (selectedEvent?.data as Record<string, unknown>)?.input ||
    (selectedEvent?.data as Record<string, unknown>)?.args ||
    null;

  if (!requestData) {
    if (!selectedEvent) {
      return <EmptyTabMessage message={t('select_node_request')} />;
    }
    return <EmptyTabMessage message={t('no_request_data')} />;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted uppercase tracking-wide">
          {llmData?.request
            ? t('llm_request')
            : selectedEvent?.type === 'tool_call'
              ? t('tool_input')
              : t('input_label')}
        </h3>
        <CopyButton data={requestData} />
      </div>
      <div className="bg-background-muted rounded-lg p-4">
        <JsonViewer data={requestData} maxDepth={8} copyable />
      </div>
    </div>
  );
}

// ── Response Tab ────────────────────────────────────────────────────────────

function ResponseTab({
  llmData,
  selectedEvent,
}: {
  llmData: LLMData | null;
  selectedEvent: TraceEvent | null;
}) {
  const t = useTranslations('sessions.summary');
  const responseData =
    llmData?.response ||
    (selectedEvent?.data as Record<string, unknown>)?.response ||
    (selectedEvent?.data as Record<string, unknown>)?.result ||
    (selectedEvent?.data as Record<string, unknown>)?.output ||
    null;

  if (!responseData) {
    if (!selectedEvent) {
      return <EmptyTabMessage message={t('select_node_response')} />;
    }
    return <EmptyTabMessage message={t('no_response_data')} />;
  }

  // String responses (e.g. from logLLMCall or wrapped { content: "..." })
  const isStringContent =
    typeof responseData === 'object' &&
    responseData !== null &&
    'content' in responseData &&
    typeof (responseData as Record<string, unknown>).content === 'string' &&
    Object.keys(responseData as object).length === 1;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-medium text-muted uppercase tracking-wide">
          {llmData?.response ? t('llm_response') : t('output')}
        </h3>
        <CopyButton data={responseData} />
      </div>
      <div className="bg-background-muted rounded-lg p-4">
        {isStringContent ? (
          <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
            {(responseData as Record<string, string>).content}
          </pre>
        ) : typeof responseData === 'string' ? (
          <pre className="text-sm text-foreground whitespace-pre-wrap font-mono leading-relaxed">
            {responseData}
          </pre>
        ) : (
          <JsonViewer data={responseData} maxDepth={8} copyable />
        )}
      </div>
    </div>
  );
}

// ── Metrics Tab ─────────────────────────────────────────────────────────────

function MetricsDetailTab({
  selectedNode,
  selectedEvent,
}: {
  selectedNode: TreeNode | null;
  selectedEvent: TraceEvent | null;
}) {
  const data = (selectedEvent?.data ?? selectedNode?.data ?? {}) as Record<string, unknown>;
  const rows = [
    selectedNode?.latencyMs != null
      ? ['Latency', formatMilliseconds(selectedNode.latencyMs)]
      : undefined,
    typeof selectedEvent?.durationMs === 'number'
      ? ['Latency', formatMilliseconds(selectedEvent.durationMs)]
      : undefined,
    selectedNode?.tokens
      ? ['Input Tokens', selectedNode.tokens.input.toLocaleString()]
      : readMetric(data, ['tokensIn', 'inputTokens', 'promptTokens'], 'Input Tokens'),
    selectedNode?.tokens
      ? ['Output Tokens', selectedNode.tokens.output.toLocaleString()]
      : readMetric(data, ['tokensOut', 'outputTokens', 'completionTokens'], 'Output Tokens'),
    readMetric(data, ['cost', 'estimatedCost'], 'Cost', (value) => `$${value.toFixed(6)}`),
  ].filter(Boolean) as Array<[string, string]>;

  if (rows.length === 0) {
    return <EmptyTabMessage message="No span-level metrics are available for this selection." />;
  }

  return (
    <div className="space-y-2">
      {dedupeMetricRows(rows).map(([label, value]) => (
        <ParamRow key={label} label={label} value={value} />
      ))}
    </div>
  );
}

// ── Metadata Tab ────────────────────────────────────────────────────────────

function MetadataTab({
  llmData,
  selectedEvent,
}: {
  llmData: LLMData | null;
  selectedEvent: TraceEvent | null;
}) {
  const t = useTranslations('sessions.summary');

  if (!selectedEvent) {
    return <EmptyTabMessage message={t('select_node_metadata')} />;
  }

  const tools = llmData?.tools || (selectedEvent.data as Record<string, unknown>)?.tools || null;

  const eventData = selectedEvent.data || {};
  const eventRecord = selectedEvent as unknown as Record<string, unknown>;
  const hasCausalMetadata = hasTraceCausality(getTraceCausalFields(selectedEvent));
  const metadata: Record<string, unknown> = {};
  const metadataKeys = [
    'agentName',
    'agent',
    'model',
    'mode',
    'type',
    'purpose',
    'sessionId',
    'traceId',
    'spanId',
    'parentSpanId',
    'turnId',
    'executionId',
    'parentExecutionId',
    'agentRunId',
    'decisionId',
    'parentDecisionId',
    'causeEventId',
    'reasonCode',
    'stepName',
    'stepType',
    'toolName',
    'tool',
    'success',
    'error',
    'fromAgent',
    'toAgent',
    'targetAgent',
    'from',
    'to',
    'decisionKind',
    'decision',
    'reasoning',
    'condition',
    'fromStep',
    'toStep',
    'phase',
    'constraint',
    'passed',
  ];
  for (const key of metadataKeys) {
    const value =
      key in eventRecord && eventRecord[key] !== undefined
        ? eventRecord[key]
        : (eventData as Record<string, unknown>)[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }

  if (selectedEvent.type) metadata._eventType = selectedEvent.type;
  if (selectedEvent.durationMs) metadata._durationMs = selectedEvent.durationMs;

  return (
    <div className="space-y-4">
      {tools && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('tool_definitions')}
            </h3>
            <CopyButton data={tools} />
          </div>
          <div className="bg-background-muted rounded-lg p-4">
            <JsonViewer data={tools} maxDepth={8} copyable />
          </div>
        </div>
      )}

      {Object.keys(metadata).length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide">
              {t('event_metadata')}
            </h3>
            <CopyButton data={metadata} />
          </div>
          <div className="bg-background-muted rounded-lg p-4">
            <JsonViewer data={metadata} maxDepth={6} copyable />
          </div>
        </div>
      )}

      <TraceCausalChips event={selectedEvent} />

      {Object.keys(metadata).length === 0 && !tools && !hasCausalMetadata && (
        <EmptyTabMessage message={t('no_metadata')} />
      )}
    </div>
  );
}

// ── Shared components ───────────────────────────────────────────────────────

function EmptyTabMessage({ message }: { message: string }) {
  return <div className="flex items-center justify-center h-32 text-sm text-muted">{message}</div>;
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-background-muted rounded-lg text-sm">
      <span className="text-muted font-medium">{label}:</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function formatMilliseconds(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function readMetric(
  data: Record<string, unknown>,
  keys: string[],
  label: string,
  formatter: (value: number) => string = (value) => value.toLocaleString(),
): [string, string] | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return [label, formatter(value)];
    }
  }
  return undefined;
}

function dedupeMetricRows(rows: Array<[string, string]>): Array<[string, string]> {
  const seen = new Set<string>();
  return rows.filter(([label]) => {
    if (seen.has(label)) return false;
    seen.add(label);
    return true;
  });
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted">{icon}</span>
      <span className="text-muted">{label}:</span>
      <span className="min-w-0 truncate text-foreground">{value}</span>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2 bg-background-muted rounded-lg">
      <div className="text-xs text-muted mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function TimeoutDiagnosticCard({
  label,
  value,
  source,
  isLoading,
  t,
}: {
  label: string;
  value: string;
  source?: string;
  isLoading?: boolean;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
  return (
    <div className="px-3 py-2 bg-background-muted rounded-lg">
      <div className="text-xs text-muted mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-foreground tabular-nums">
        {isLoading ? t('timeout_loading') : value}
      </div>
      <div className="text-[11px] text-subtle mt-1">
        {t('timeout_source', { source: formatTimeoutSource(source) })}
      </div>
    </div>
  );
}

function CopyButton({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const t = useTranslations('sessions.summary');

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 px-2 py-1 rounded text-xs text-muted hover:text-foreground hover:bg-background-muted transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
      {copied ? t('copied') : t('copy')}
    </button>
  );
}

// ── Data extraction helpers ─────────────────────────────────────────────────

function formatTimeoutSource(source?: string): string {
  if (!source) {
    return '--';
  }

  return source
    .split('_')
    .map((part) => (part.length > 0 ? `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}` : part))
    .join(' ');
}

function extractLLMData(data: Record<string, unknown>): LLMData | null {
  const request = (data.request as Record<string, unknown>) || undefined;
  // When logLLMCall stores flat data (model, messages, response at top level),
  // synthesize a request object for the UI
  const synthesizedRequest =
    !request && data.messages ? { model: data.model, messages: data.messages } : undefined;
  const effectiveRequest = request || synthesizedRequest;

  const rawResponse = data.response;
  // response may be a string (from logLLMCall) or an object
  const response =
    typeof rawResponse === 'string'
      ? { content: rawResponse }
      : (rawResponse as Record<string, unknown>) || undefined;

  const tokenUsage = data.tokenUsage as Record<string, number> | undefined;
  const model = (data.model as string) || (effectiveRequest?.model as string);
  if (!model && !data.tokensIn && !tokenUsage && !effectiveRequest && !response) return null;

  // Extract system prompt from messages — check both request.messages and top-level data.messages
  let systemPrompt: string | undefined;
  const messages = (effectiveRequest?.messages as Array<Record<string, unknown>>) || [];
  const systemMsg = messages.find((m) => m.role === 'system');
  if (systemMsg) {
    systemPrompt =
      typeof systemMsg.content === 'string'
        ? systemMsg.content
        : JSON.stringify(systemMsg.content, null, 2);
  }

  return {
    model: model || undefined,
    temperature:
      (effectiveRequest?.temperature as number) ?? (data.temperature as number) ?? undefined,
    topP: (effectiveRequest?.top_p as number) ?? (data.top_p as number) ?? undefined,
    frequencyPenalty: (effectiveRequest?.frequency_penalty as number) ?? undefined,
    presencePenalty: (effectiveRequest?.presence_penalty as number) ?? undefined,
    systemPrompt,
    request: (effectiveRequest as Record<string, unknown>) || undefined,
    response: response || undefined,
    tools: effectiveRequest?.tools || data.tools || undefined,
  };
}

function findNodeById(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

function formatTimestamp(date: Date): string {
  return (
    date.toLocaleDateString('en-US', {
      month: 'short',
      day: '2-digit',
      year: 'numeric',
    }) +
    ', ' +
    date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
  );
}
