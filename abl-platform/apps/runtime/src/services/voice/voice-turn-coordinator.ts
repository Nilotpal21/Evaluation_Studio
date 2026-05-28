import {
  buildAuthRequiredOutcome,
  buildErrorOutcome,
  buildExecutionOutcome,
  runWithExecutionTimeout,
  type ChannelDiagnostic,
  type ChannelOutcome,
} from '../channel/outcome.js';
import { getChannelAdapterRegistry } from '../channel/channel-adapter.js';
import { createTokenLookups, evaluateAuthPreflightFromIR } from '../auth-profile/auth-preflight.js';
import type { ExecuteMessageOptions, ExecutionResult, RuntimeSession } from '../execution/types.js';
import type { RuntimeExecutor } from '../runtime-executor.js';
import { createLogger } from '@abl/compiler/platform';
import { extractLlmTraceMetrics } from '@agent-platform/shared-kernel';
import type { ClickHouseMetricsStore } from '../stores/clickhouse-metrics-store.js';
import { calculateCost, hasKnownPricing, getModelCapabilities } from '../llm/model-router.js';

const log = createLogger('voice-turn-coordinator');
const _chMetricsStores = new Map<string, ClickHouseMetricsStore>();

async function getClickHouseMetricsStore(tenantId: string): Promise<ClickHouseMetricsStore> {
  if (!_chMetricsStores.has(tenantId)) {
    if (_chMetricsStores.size >= 50) {
      const oldest = _chMetricsStores.keys().next().value;
      if (oldest !== undefined) _chMetricsStores.delete(oldest);
    }
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const client = getClickHouseClient();
    if (!client) throw new Error('ClickHouse client not available');
    const { ClickHouseMetricsStore: Store } = await import('../stores/clickhouse-metrics-store.js');
    _chMetricsStores.set(tenantId, new Store({ type: 'clickhouse' }, { client, tenantId }));
  }
  return _chMetricsStores.get(tenantId)!;
}

type VoiceTurnExecutor = Pick<
  RuntimeExecutor,
  'executeMessage' | 'getSession' | 'rehydrateSession'
>;

type VoiceTurnTraceEvent = { type: string; data: Record<string, unknown> };

export interface VoiceTurnCoordinatorParams {
  channelType: string;
  executor: VoiceTurnExecutor;
  sessionId: string;
  utterance: string;
  timeoutMs: number;
  promptProfile: 'pipeline' | 'realtime';
  onChunk?: (chunk: string) => void;
  onTraceEvent?: (event: VoiceTurnTraceEvent) => void;
  executeOptions?: Omit<ExecuteMessageOptions, 'signal'>;
}

export interface VoiceTurnCoordinatorResult {
  outcome: ChannelOutcome;
  runtimeSession?: RuntimeSession;
  executionResult?: ExecutionResult;
  diagnostics: ChannelDiagnostic[];
}

export interface RealtimeVoiceTurnToolPayload {
  response_text: string;
  status: ChannelOutcome['status'];
  used_fallback: boolean;
  action_type?: string;
  diagnostic_codes: string[];
  voice_config?: ChannelOutcome['voiceConfig'];
}

export interface RealtimeVoiceTurnToolPayloadOptions {
  channelType?: string;
  engine?: string;
}

function buildCoordinatorDiagnostics(
  promptProfile: VoiceTurnCoordinatorParams['promptProfile'],
): ChannelDiagnostic[] {
  return [
    {
      source: 'voice_turn_coordinator',
      category: 'voice_runtime',
      severity: 'info',
      code:
        promptProfile === 'pipeline'
          ? 'VOICE_PROMPT_PROFILE_PIPELINE'
          : 'VOICE_PROMPT_PROFILE_REALTIME',
      message: `Voice turn used the canonical ${promptProfile} prompt profile and coordinator.`,
    },
  ];
}

export async function executeVoiceTurn(
  params: VoiceTurnCoordinatorParams,
): Promise<VoiceTurnCoordinatorResult> {
  const coordinatorDiagnostics = buildCoordinatorDiagnostics(params.promptProfile);
  const runtimeSession =
    params.executor.getSession(params.sessionId) ??
    (await params.executor.rehydrateSession(
      params.sessionId,
      params.executeOptions?.sessionLocator
        ? { locator: params.executeOptions.sessionLocator }
        : undefined,
    )) ??
    undefined;
  const environment = runtimeSession?.versionInfo?.environment;

  if (runtimeSession?.compilationOutput) {
    try {
      const preflight = await evaluateAuthPreflightFromIR(
        runtimeSession.compilationOutput,
        {
          userId: runtimeSession.userId,
          tenantId: runtimeSession.tenantId,
          projectId: runtimeSession.projectId,
          environment,
        },
        createTokenLookups(runtimeSession.tenantId, runtimeSession.projectId, environment),
        runtimeSession.agentName ? { agentNames: [runtimeSession.agentName] } : undefined,
      );

      if (preflight) {
        return {
          outcome: buildAuthRequiredOutcome({
            channelType: params.channelType,
            pending: preflight.pending,
            satisfied: preflight.satisfied,
            session: runtimeSession,
            additionalDiagnostics: coordinatorDiagnostics,
          }),
          runtimeSession,
          executionResult: undefined,
          diagnostics: coordinatorDiagnostics,
        };
      }
    } catch (error) {
      return {
        outcome: buildErrorOutcome({
          channelType: params.channelType,
          error,
          session: runtimeSession,
          additionalDiagnostics: coordinatorDiagnostics,
        }),
        runtimeSession,
        executionResult: undefined,
        diagnostics: coordinatorDiagnostics,
      };
    }
  }

  try {
    const streamedChunks: string[] = [];

    // Write one llm_metrics row per LLM call. STT/TTS are outside executeMessage scope.
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    let turnCost = 0;
    let turnToolCallCount = 0;
    let lastModelId = '';
    let lastProvider = '';
    const wrappedOnTraceEvent = (event: VoiceTurnTraceEvent) => {
      if (event.type === 'llm_call' && event.data) {
        const metrics = extractLlmTraceMetrics(event.data);
        turnTokensIn += metrics.tokensIn;
        turnTokensOut += metrics.tokensOut;
        if (metrics.model && metrics.model !== 'unknown') lastModelId = metrics.model;
        if (metrics.provider) lastProvider = metrics.provider;
        if ((metrics.tokensIn > 0 || metrics.tokensOut > 0) && runtimeSession?.tenantId) {
          const callModelId = metrics.model && metrics.model !== 'unknown' ? metrics.model : '';
          const callDurationMs =
            typeof event.data.durationMs === 'number' ? event.data.durationMs : 0;
          const callToolCount =
            typeof event.data.toolCallCount === 'number' ? event.data.toolCallCount : 0;
          let callCost: number | null = metrics.cost || null;
          if (!callCost && callModelId && hasKnownPricing(callModelId)) {
            try {
              const caps = getModelCapabilities(callModelId);
              callCost = calculateCost(
                caps.inputCostPer1k,
                caps.outputCostPer1k,
                metrics.tokensIn,
                metrics.tokensOut,
              );
            } catch {
              /* non-fatal */
            }
          }
          // Gap 2: accumulate resolved callCost (incl. fallback) for turn aggregate
          turnCost += callCost || 0;
          getClickHouseMetricsStore(runtimeSession.tenantId)
            .then(async (store) => {
              await store.record({
                sessionId: params.sessionId,
                projectId: runtimeSession.projectId ?? '',
                userId: runtimeSession.userId || undefined,
                modelId: callModelId,
                provider: metrics.provider || '',
                inputTokens: metrics.tokensIn,
                outputTokens: metrics.tokensOut,
                totalTokens: metrics.tokensIn + metrics.tokensOut,
                estimatedCost: callCost,
                latencyMs: callDurationMs,
                streamingUsed: event.data.streaming === true,
                toolCallCount: callToolCount,
                // Gap 1: field_validation uses 'purpose', not 'operationType'
                operationType: String(
                  event.data.operationType || event.data.purpose || 'response_gen',
                ),
                agentName: String(event.data.agent || ''),
                knownSource: runtimeSession?.knownSource ?? 'production',
              });
            })
            .catch((err) => {
              log.error('Failed to persist voice llm call metrics to ClickHouse', {
                error: err instanceof Error ? err.message : String(err),
                sessionId: params.sessionId,
              });
            });
        }
      }
      params.onTraceEvent?.(event);
    };

    const turnStartTime = Date.now();
    const result = await runWithExecutionTimeout<ExecutionResult>(
      (signal) =>
        params.executor.executeMessage(
          params.sessionId,
          params.utterance,
          (chunk) => {
            streamedChunks.push(chunk);
            params.onChunk?.(chunk);
          },
          wrappedOnTraceEvent,
          {
            ...params.executeOptions,
            signal,
          },
        ),
      params.timeoutMs,
    );
    const turnLatencyMs = Date.now() - turnStartTime;

    const resolvedSession = params.executor.getSession(params.sessionId) ?? runtimeSession;

    // Turn aggregate row — e2e latency and total tokens across all LLM calls in this turn
    if ((turnTokensIn > 0 || turnTokensOut > 0) && runtimeSession?.tenantId) {
      let turnCostFinal: number | null = turnCost || null;
      if (!turnCostFinal && lastModelId && hasKnownPricing(lastModelId)) {
        try {
          const caps = getModelCapabilities(lastModelId);
          turnCostFinal = calculateCost(
            caps.inputCostPer1k,
            caps.outputCostPer1k,
            turnTokensIn,
            turnTokensOut,
          );
        } catch {
          /* non-fatal */
        }
      }
      getClickHouseMetricsStore(runtimeSession.tenantId)
        .then(async (store) => {
          await store.record({
            sessionId: params.sessionId,
            projectId: runtimeSession.projectId ?? '',
            userId: runtimeSession.userId || undefined,
            modelId: lastModelId,
            provider: lastProvider,
            inputTokens: turnTokensIn,
            outputTokens: turnTokensOut,
            totalTokens: turnTokensIn + turnTokensOut,
            estimatedCost: turnCostFinal,
            latencyMs: turnLatencyMs,
            streamingUsed: false,
            toolCallCount: turnToolCallCount,
            operationType: 'turn_aggregate',
            knownSource: runtimeSession?.knownSource ?? 'production',
          });
        })
        .catch((err) => {
          log.error('Failed to persist voice turn aggregate metrics to ClickHouse', {
            error: err instanceof Error ? err.message : String(err),
            sessionId: params.sessionId,
          });
        });
    }

    return {
      outcome: buildExecutionOutcome({
        channelType: params.channelType,
        result,
        streamedText: streamedChunks.length > 0 ? streamedChunks.join('') : undefined,
        session: resolvedSession,
        additionalDiagnostics: coordinatorDiagnostics,
      }),
      runtimeSession: resolvedSession,
      executionResult: result,
      diagnostics: coordinatorDiagnostics,
    };
  } catch (error) {
    const resolvedSession = params.executor.getSession(params.sessionId) ?? runtimeSession;
    return {
      outcome: buildErrorOutcome({
        channelType: params.channelType,
        error,
        session: resolvedSession,
        additionalDiagnostics: coordinatorDiagnostics,
      }),
      runtimeSession: resolvedSession,
      executionResult: undefined,
      diagnostics: coordinatorDiagnostics,
    };
  }
}

export function serializeRealtimeVoiceTurnToolPayload(
  outcome: ChannelOutcome,
  options: RealtimeVoiceTurnToolPayloadOptions = {},
): string {
  const adapterContext = options.channelType
    ? {
        channelType: options.channelType,
        ...(options.engine ? { engine: options.engine } : {}),
      }
    : options.engine
      ? { channelType: 'voice_realtime', engine: options.engine }
      : { channelType: 'voice_realtime' };
  const responseText = getChannelAdapterRegistry().resolve(
    { text: outcome.responseText, voiceConfig: outcome.voiceConfig },
    adapterContext,
  );
  const payload: RealtimeVoiceTurnToolPayload = {
    response_text: responseText,
    status: outcome.status,
    used_fallback: outcome.usedFallback,
    diagnostic_codes: outcome.diagnostics.map((diagnostic) => diagnostic.code),
    ...(outcome.action?.type ? { action_type: outcome.action.type } : {}),
    ...(outcome.voiceConfig ? { voice_config: outcome.voiceConfig } : {}),
  };

  return JSON.stringify(payload);
}
