/**
 * RunEvalConversation — Restate activity for executing a full multi-turn
 * persona↔agent eval conversation.
 *
 * Orchestrates the conversation loop:
 * 1. Generate persona message (initial or LLM-generated)
 * 2. Send to agent via Runtime HTTP API
 * 3. Collect traces, check milestones, track agent path
 * 4. Repeat until maxTurns, natural end, or persona signals __END__
 * 5. Write conversation record to ClickHouse via buffered writer
 *
 * Each conversation gets a fresh runtime session (no state leakage between
 * cells in the evaluation matrix).
 *
 * Config:
 *   persona:            PersonaConfig
 *   scenario:           ScenarioConfig
 *   variantIndex:       number
 *   tenantId:           string
 *   projectId:          string
 *   runId:              string
 *   personaModel:       string — LLM model for persona simulation
 *   personaTemperature: number — default 0.7
 *   personaMaxTokens:   number — default 512
 *   runtimeUrl:         string — runtime API base URL
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { rollupAgentTokenCost } from '@agent-platform/shared-kernel';
import { resolvePipelineLLM } from '../llm-client-factory.js';
import { pipelineGenerateText } from '../pipeline-llm-call.js';
import { withCircuitBreaker } from './eval-circuit-breakers.js';
import {
  checkLLMRateLimit,
  acquireConversationSlot,
  releaseConversationSlot,
} from './eval-rate-limiter.js';
import { evalMetrics } from './eval-metrics.js';
import { compressField } from './eval-compression.js';
import { getConversationWriter } from './eval-clickhouse-writers.js';
import { extractMilestonesFromTraces, extractAgentPathFromTraces } from './trajectory-scorers.js';
import { extractCurrentAgentFromTraceEvents } from './eval-trace-utils.js';
import { createServiceToken } from './eval-auth.js';
import {
  buildEvalRuntimeAgentChatBody,
  isEvalRuntimeSessionEnded,
} from './eval-runtime-request.js';
import type { PipelineStepContext, StepOutput } from '../../types.js';
import type {
  PersonaConfig,
  ScenarioConfig,
  ConversationTurn,
  TraceEvent,
  EvalConversationRow,
} from './eval-types.js';
import { PERSONA_END_SIGNAL, DEFAULT_RUNTIME_URL, toCHDateTime } from './eval-types.js';
import { CH_EVAL_DATA_TTL_DAYS } from '@agent-platform/database/constants/eval-limits';
import type { EvalKnownSource } from '@agent-platform/database';
import { buildPersonaSystemPrompt } from '../../prompts/index.js';

const log = createLogger('eval-conversation');

function formatConversationForPersona(conversation: ConversationTurn[]): string {
  if (conversation.length === 0) return '';
  return conversation
    .map((t) => `${t.role === 'user' ? 'User' : 'Agent'}: ${t.content}`)
    .join('\n');
}

// ── Agent Turn via Runtime HTTP API ─────────────────────────────────

const AGENT_TURN_TIMEOUT_MS = 60_000;

interface AgentTurnResult {
  sessionId: string;
  response: string;
  traceEvents: TraceEvent[];
  currentAgent?: string;
  sessionEnded: boolean;
}

async function executeAgentTurn(params: {
  runtimeUrl: string;
  projectId: string;
  tenantId: string;
  sessionId?: string;
  message: string;
  entryAgent?: string;
  idempotencyKey?: string;
  sessionVariables?: Record<string, unknown>;
  runId?: string;
  knownSource?: EvalKnownSource;
}): Promise<AgentTurnResult> {
  const callStart = Date.now();
  const isNewSession = !params.sessionId;

  log.debug('Conversation agent turn start', {
    projectId: params.projectId,
    sessionId: params.sessionId ?? 'new',
    isNewSession,
    hasSessionVariables:
      !!params.sessionVariables && Object.keys(params.sessionVariables).length > 0,
  });

  const body = buildEvalRuntimeAgentChatBody({
    projectId: params.projectId,
    message: params.message,
    sessionId: params.sessionId,
    entryAgent: params.entryAgent,
    sessionVariables: params.sessionVariables,
    knownSource: params.knownSource,
    runId: params.runId,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TURN_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createServiceToken(params.tenantId, params.projectId)}`,
    };
    if (params.idempotencyKey) {
      headers['X-Idempotency-Key'] = params.idempotencyKey;
    }

    const res = await fetch(`${params.runtimeUrl}/api/internal/chat/agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown');
      log.warn('Runtime API returned non-2xx for conversation turn', {
        projectId: params.projectId,
        sessionId: params.sessionId ?? 'new',
        status: res.status,
        errorText: errText,
        durationMs: Date.now() - callStart,
      });
      throw new Error(`Runtime API ${res.status}: ${errText}`);
    }

    const envelope = (await res.json()) as {
      success: boolean;
      data?: Record<string, unknown>;
    };
    if (!envelope.data) {
      throw new Error(`Runtime API returned no data: success=${envelope.success}`);
    }
    const data = envelope.data;
    const traceEvents = (data.traceEvents ?? []) as TraceEvent[];
    const sessionEnded = isEvalRuntimeSessionEnded(data);
    const returnedSessionId = String(data.sessionId ?? params.sessionId ?? '');

    log.debug('Conversation agent turn complete', {
      projectId: params.projectId,
      sessionId: returnedSessionId,
      isNewSession,
      traceEventCount: traceEvents.length,
      action: data.action,
      sessionEnded,
      durationMs: Date.now() - callStart,
    });

    return {
      sessionId: returnedSessionId,
      response: String(data.response ?? ''),
      traceEvents,
      ...optionalCurrentAgent(traceEvents),
      sessionEnded,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      log.error('Conversation agent turn timed out', {
        projectId: params.projectId,
        sessionId: params.sessionId ?? 'new',
        timeoutMs: AGENT_TURN_TIMEOUT_MS,
        durationMs: Date.now() - callStart,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Service Definition ──────────────────────────────────────────────

export const runEvalConversationService = restate.service({
  name: 'RunEvalConversation',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const {
        persona,
        scenario,
        variantIndex = 0,
        tenantId: configTenantId,
        projectId: configProjectId,
        runId,
        knownSource = 'eval',
        evalConversationTtlDays = CH_EVAL_DATA_TTL_DAYS,
        personaModel,
        personaTemperature = 0.7,
        personaMaxTokens = 512,
        runtimeUrl,
      } = input.config as {
        persona: PersonaConfig;
        scenario: ScenarioConfig;
        variantIndex: number;
        tenantId?: string;
        projectId?: string;
        runId: string;
        knownSource?: EvalKnownSource;
        evalConversationTtlDays?: number;
        personaModel?: string;
        personaTemperature?: number;
        personaMaxTokens?: number;
        runtimeUrl?: string;
      };

      const tenantId = configTenantId ?? input.tenantId;
      const projectId = configProjectId ?? input.projectId ?? '';
      const url = runtimeUrl ?? DEFAULT_RUNTIME_URL;
      const attrs = { tenant_id: tenantId, project_id: projectId };

      // Acquire conversation slot (inside ctx.run for Restate determinism)
      const slotAcquired = await ctx.run('acquire-conversation-slot', () => {
        return acquireConversationSlot(tenantId);
      });
      if (!slotAcquired) {
        return {
          status: 'fail',
          data: { error: 'Conversation rate limit exceeded for tenant' },
          durationMs: Date.now() - startTime,
        };
      }

      evalMetrics.conversationsStarted.add(1, attrs);
      evalMetrics.activeConversations.add(1, attrs);

      let evalSessionId: string | undefined;
      const conversation: ConversationTurn[] = [];
      const allTraceEvents: TraceEvent[] = [];
      let totalTokenUsage = 0;
      let totalEstimatedCost = 0;
      let hasError = false;
      let errorMessage = '';

      try {
        const personaSystemPrompt = buildPersonaSystemPrompt(persona, scenario);

        // Generate or use initial message
        let personaMessage: string;
        if (scenario.initialMessage) {
          personaMessage = scenario.initialMessage;
        } else {
          // Generate first message via LLM
          const firstMsg = await ctx.run('first-persona-message', async () => {
            if (!checkLLMRateLimit(tenantId)) {
              throw new Error('LLM rate limit exceeded');
            }
            const resolved = await resolvePipelineLLM(tenantId, projectId, personaModel);
            return withCircuitBreaker('eval-persona-llm', async () => {
              return pipelineGenerateText(
                resolved,
                {
                  system: personaSystemPrompt,
                  messages: [
                    {
                      role: 'user' as const,
                      content: 'Generate your first message to start the conversation.',
                    },
                  ],
                  maxOutputTokens: personaMaxTokens,
                  temperature: personaTemperature,
                },
                { service: 'eval-run-conversation', tenantId, sessionId: evalSessionId },
              );
            });
          });
          personaMessage = firstMsg.content.trim();
          totalTokenUsage += firstMsg.inputTokens + firstMsg.outputTokens;
        }

        // Multi-turn conversation loop
        for (let turn = 0; turn < scenario.maxTurns; turn++) {
          if (personaMessage === PERSONA_END_SIGNAL) break;

          // Execute agent turn
          const agentResult = await ctx.run(`agent-turn-${turn}`, async () => {
            const idempotencyKey = `${runId}:${persona._id}:${scenario._id}:v${variantIndex}:turn-${turn}`;
            return withCircuitBreaker('eval-agent-executor', () =>
              executeAgentTurn({
                runtimeUrl: url,
                projectId,
                tenantId,
                sessionId: evalSessionId,
                message: personaMessage,
                entryAgent: scenario.entryAgent,
                idempotencyKey,
                sessionVariables: persona.sessionVariables,
                runId,
                knownSource,
              }),
            );
          });

          evalSessionId = agentResult.sessionId;
          const now = new Date().toISOString();

          conversation.push(
            { role: 'user', content: personaMessage, timestamp: now },
            {
              role: 'agent',
              content: agentResult.response,
              timestamp: now,
              ...(agentResult.currentAgent ? { agentName: agentResult.currentAgent } : {}),
            },
          );
          allTraceEvents.push(...agentResult.traceEvents);

          // Check if conversation naturally ended
          if (agentResult.sessionEnded) break;

          // Don't generate another persona message if we've hit maxTurns
          if (turn + 1 >= scenario.maxTurns) break;

          // Generate next persona message
          const nextMsg = await ctx.run(`persona-msg-${turn + 1}`, async () => {
            if (!checkLLMRateLimit(tenantId)) {
              throw new Error('LLM rate limit exceeded');
            }
            const resolved = await resolvePipelineLLM(tenantId, projectId, personaModel);
            const conversationContext = formatConversationForPersona(conversation);
            return withCircuitBreaker('eval-persona-llm', async () => {
              return pipelineGenerateText(
                resolved,
                {
                  system: personaSystemPrompt,
                  messages: [
                    {
                      role: 'user' as const,
                      content: `Conversation so far:\n${conversationContext}\n\nGenerate your next message.`,
                    },
                  ],
                  maxOutputTokens: personaMaxTokens,
                  temperature: personaTemperature,
                },
                { service: 'eval-run-conversation', tenantId, sessionId: evalSessionId },
              );
            });
          });

          personaMessage = nextMsg.content.trim();
          totalTokenUsage += nextMsg.inputTokens + nextMsg.outputTokens;
        }
      } catch (error) {
        hasError = true;
        errorMessage = error instanceof Error ? error.message : String(error);
        log.warn('Eval conversation error', {
          sessionId: input.sessionId,
          runId,
          personaId: persona._id,
          scenarioId: scenario._id,
          variantIndex,
          error: errorMessage,
          turnReached: conversation.length / 2,
        });
        evalMetrics.conversationsFailed.add(1, attrs);
      } finally {
        releaseConversationSlot(tenantId);
        evalMetrics.activeConversations.add(-1, attrs);
      }

      const durationMs = Date.now() - startTime;
      const turnCount = Math.floor(conversation.length / 2);
      const milestonesHit = extractMilestonesFromTraces(
        allTraceEvents,
        scenario.expectedMilestones,
      );
      const actualAgentPath = extractAgentPathFromTraces(allTraceEvents);
      const toolCallCount = allTraceEvents.filter((e) => e.type === 'tool_call').length;

      // Roll up agent-under-test token costs from trace events
      const costRollup = rollupAgentTokenCost(allTraceEvents);
      totalEstimatedCost = costRollup.totalCost;

      // Write to ClickHouse via buffered writer
      const chRow: EvalConversationRow = {
        tenant_id: tenantId,
        project_id: projectId,
        run_id: runId,
        persona_id: persona._id,
        scenario_id: scenario._id,
        variant_index: variantIndex,
        conversation: await compressField(conversation),
        trace_events: await compressField(allTraceEvents),
        tool_calls: await compressField(allTraceEvents.filter((e) => e.type === 'tool_call')),
        turn_count: turnCount,
        duration_ms: durationMs,
        token_usage: totalTokenUsage,
        estimated_cost: totalEstimatedCost,
        customer_visible_cost: costRollup.customerVisibleCost,
        cost_by_model: JSON.stringify(costRollup.costByModel),
        milestones_hit: milestonesHit,
        actual_agent_path: actualAgentPath,
        tool_call_count: toolCallCount,
        known_source: knownSource,
        ttl_override_days: evalConversationTtlDays,
        has_error: hasError ? 1 : 0,
        error_message: errorMessage,
        persona_version: persona.version,
        scenario_version: scenario.version,
        created_at: toCHDateTime(),
      };

      await ctx.run('write-conversation-ch', () => {
        getConversationWriter().insert(chRow);
      });

      if (!hasError) {
        evalMetrics.conversationsCompleted.add(1, attrs);
        evalMetrics.conversationDuration.record(durationMs, attrs);
        evalMetrics.conversationTurns.record(turnCount, attrs);
      }

      log.debug('Eval conversation completed', {
        sessionId: input.sessionId,
        runId,
        personaId: persona._id,
        scenarioId: scenario._id,
        variantIndex,
        turnCount,
        milestonesHit: milestonesHit.length,
        toolCallCount,
        hasError,
        durationMs,
      });

      return {
        status: hasError ? 'fail' : 'success',
        data: {
          conversation,
          traceEvents: allTraceEvents,
          milestonesHit,
          actualAgentPath,
          turnCount,
          toolCallCount,
          durationMs,
          tokenUsage: totalTokenUsage,
          estimatedCost: totalEstimatedCost,
          customerVisibleCost: costRollup.customerVisibleCost,
          costByModel: costRollup.costByModel,
          hasError,
          errorMessage,
          personaId: persona._id,
          scenarioId: scenario._id,
          variantIndex,
        },
        durationMs,
      };
    },
  },
});

export type RunEvalConversationService = typeof runEvalConversationService;

function optionalCurrentAgent(
  traceEvents: TraceEvent[],
): Pick<AgentTurnResult, 'currentAgent'> | {} {
  const currentAgent = extractCurrentAgentFromTraceEvents(traceEvents);
  return currentAgent ? { currentAgent } : {};
}
