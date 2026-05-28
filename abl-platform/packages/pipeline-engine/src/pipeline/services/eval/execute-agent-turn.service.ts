/**
 * ExecuteAgentTurn — Restate activity for running one agent turn.
 *
 * Sends a user message to the agent-under-test via the Runtime HTTP API
 * (POST /api/v1/chat/agent) and collects the response, trace events,
 * and state information.
 *
 * Uses HTTP calls to the runtime rather than in-process execution to
 * maintain clean service boundaries. The runtime handles compilation,
 * tool resolution, guardrails, and trace collection.
 *
 * Config:
 *   projectId:     string — project containing the agent
 *   tenantId:      string — tenant isolation
 *   sessionId:     string — runtime session ID (null for first turn)
 *   message:       string — user message to send
 *   entryAgent:    string — agent name (used on first turn only)
 *   runtimeUrl:    string — runtime API base URL (optional)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import type { EvalKnownSource } from '@agent-platform/database';
import { withCircuitBreaker } from './eval-circuit-breakers.js';
import { createServiceToken } from './eval-auth.js';
import {
  buildEvalRuntimeAgentChatBody,
  isEvalRuntimeSessionEnded,
} from './eval-runtime-request.js';
import { extractCurrentAgentFromTraceEvents } from './eval-trace-utils.js';
import type { PipelineStepContext, StepOutput } from '../../types.js';
import type { TraceEvent } from './eval-types.js';
import { DEFAULT_RUNTIME_URL } from './eval-types.js';

const log = createLogger('eval-agent-turn');

/** Timeout for a single agent turn HTTP call. */
const AGENT_TURN_TIMEOUT_MS = 60_000;

// ── Runtime HTTP Client ─────────────────────────────────────────────

interface AgentTurnResult {
  sessionId: string;
  response: string;
  traceEvents: TraceEvent[];
  action?: string;
  toolCalls: TraceEvent[];
  currentAgent?: string;
  sessionEnded: boolean;
}

async function callRuntimeAgent(params: {
  runtimeUrl: string;
  projectId: string;
  tenantId: string;
  sessionId?: string;
  message: string;
  agentId?: string;
  idempotencyKey?: string;
  runId?: string;
  sessionVariables?: Record<string, unknown>;
  knownSource?: EvalKnownSource;
}): Promise<AgentTurnResult> {
  const { tenantId } = params;
  const callStart = Date.now();
  const isNewSession = !params.sessionId;

  log.debug('Agent turn HTTP request start', {
    projectId: params.projectId,
    sessionId: params.sessionId ?? 'new',
    agentId: params.agentId,
    isNewSession,
    endpoint: `${params.runtimeUrl}/api/internal/chat/agent`,
  });

  const body = buildEvalRuntimeAgentChatBody({
    projectId: params.projectId,
    message: params.message,
    sessionId: params.sessionId,
    entryAgent: params.agentId,
    sessionVariables: params.sessionVariables,
    knownSource: params.knownSource,
    runId: params.runId,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TURN_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${createServiceToken(tenantId, params.projectId)}`,
    };
    if (params.idempotencyKey) {
      headers['X-Idempotency-Key'] = params.idempotencyKey;
    }

    const response = await fetch(`${params.runtimeUrl}/api/internal/chat/agent`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.warn('Runtime API returned non-2xx', {
        projectId: params.projectId,
        sessionId: params.sessionId ?? 'new',
        status: response.status,
        errorText,
        durationMs: Date.now() - callStart,
      });
      throw new Error(`Runtime API error ${response.status}: ${errorText}`);
    }

    const envelope = (await response.json()) as {
      success: boolean;
      data?: Record<string, unknown>;
    };
    if (!envelope.data) {
      throw new Error(`Runtime API returned no data: success=${envelope.success}`);
    }
    const data = envelope.data;

    const traceEvents = (data.traceEvents ?? []) as TraceEvent[];
    const toolCalls = traceEvents.filter((e) => e.type === 'tool_call');

    const currentAgent = extractCurrentAgentFromTraceEvents(traceEvents);

    const sessionEnded = isEvalRuntimeSessionEnded(data);

    const returnedSessionId = String(data.sessionId ?? params.sessionId ?? '');
    log.debug('Agent turn HTTP request complete', {
      projectId: params.projectId,
      sessionId: returnedSessionId,
      isNewSession,
      traceEventCount: traceEvents.length,
      toolCallCount: toolCalls.length,
      currentAgent,
      action: data.action,
      sessionEnded,
      durationMs: Date.now() - callStart,
    });

    return {
      sessionId: returnedSessionId,
      response: String(data.response ?? ''),
      traceEvents,
      action: data.action as string | undefined,
      toolCalls,
      currentAgent,
      sessionEnded,
    };
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      log.error('Agent turn HTTP request timed out', {
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

export const executeAgentTurnService = restate.service({
  name: 'ExecuteAgentTurn',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const {
        projectId: configProjectId,
        tenantId: configTenantId,
        sessionId,
        message,
        entryAgent,
        runtimeUrl,
        sessionVariables,
        knownSource,
      } = input.config as {
        projectId?: string;
        tenantId?: string;
        sessionId?: string;
        message: string;
        entryAgent?: string;
        runtimeUrl?: string;
        sessionVariables?: Record<string, unknown>;
        knownSource?: EvalKnownSource;
      };

      const tenantId = configTenantId ?? input.tenantId;
      const projectId = configProjectId ?? input.projectId ?? '';
      const url = runtimeUrl ?? DEFAULT_RUNTIME_URL;

      if (!message) {
        log.warn('ExecuteAgentTurn invoked without message', { projectId, tenantId });
        return {
          status: 'fail',
          data: { error: 'ExecuteAgentTurn requires message in config' },
          durationMs: Date.now() - startTime,
        };
      }

      log.debug('ExecuteAgentTurn started', {
        projectId,
        tenantId,
        sessionId: sessionId ?? 'new',
        entryAgent,
        runtimeUrl: url,
      });

      try {
        const result = await ctx.run('agent-turn', async () => {
          const runId = (input.pipelineInput?.runId as string) ?? '';
          const idempotencyKey = `${runId}:${projectId}:${sessionId ?? 'new'}:agent-turn`;
          return withCircuitBreaker('eval-agent-executor', () =>
            callRuntimeAgent({
              runtimeUrl: url,
              projectId,
              tenantId,
              sessionId,
              message,
              agentId: entryAgent,
              idempotencyKey,
              runId: runId || undefined,
              sessionVariables,
              knownSource,
            }),
          );
        });

        const durationMs = Date.now() - startTime;

        log.debug('Agent turn completed', {
          projectId,
          sessionId: result.sessionId,
          responseLength: result.response.length,
          traceEventCount: result.traceEvents.length,
          toolCallCount: result.toolCalls.length,
          sessionEnded: result.sessionEnded,
          durationMs,
        });

        return {
          status: 'success',
          data: {
            sessionId: result.sessionId,
            response: result.response,
            traceEvents: result.traceEvents,
            toolCalls: result.toolCalls,
            currentAgent: result.currentAgent,
            sessionEnded: result.sessionEnded,
            action: result.action,
          },
          durationMs,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Agent turn failed', {
          projectId,
          tenantId,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ExecuteAgentTurnService = typeof executeAgentTurnService;
