import { createLogger } from '@abl/compiler/platform/logger.js';
import {
  buildRedactedToolInputPayload,
  redactAuditPayloadContent,
  shouldCaptureToolInputPayload,
  type ArchSSEEvent,
  type AuditLogEntry,
} from '@agent-platform/arch-ai';

const log = createLogger('api:arch-ai:stream');

const TEXT_PREVIEW_LENGTH = 120;

type AuditErrorCode =
  | 'llm_timeout'
  | 'compile_error'
  | 'rate_limit'
  | 'context_exceeded'
  | 'session_busy'
  | 'invalid_transition'
  | 'tool_error'
  | 'network_error'
  | 'unknown';

type AuditErrorSource = 'llm' | 'compiler' | 'tool' | 'session' | 'system';

interface AuditSink {
  emit: (entry: AuditLogEntry) => void;
  emitPayload?: (payload: {
    eventId: string;
    payloadType: 'prompt' | 'response' | 'tool_input' | 'tool_output';
    content: string;
    toolName?: string;
  }) => void;
  flush: () => Promise<void>;
  destroy: () => void;
}

interface CreateObservedArchStreamArgs {
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId?: string;
  phase?: string | null;
  mode?: string | null;
  requestId?: string;
  startedAtMs?: number;
  turnId?: string;
  emit: (event: ArchSSEEvent) => void;
  close: () => void;
  auditSink?: AuditSink | null;
}

interface CompletionUsageMetadata {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface CompletionAuditMetadata {
  model: string;
  finishReason: string;
  stepCount: number;
  latencyMs: number;
  usage: CompletionUsageMetadata;
}

function truncate(value: string, max = TEXT_PREVIEW_LENGTH): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function isCompletionAuditMetadata(value: unknown): value is CompletionAuditMetadata {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const completion = value as Record<string, unknown>;
  const usage = completion.usage;
  if (!usage || typeof usage !== 'object') {
    return false;
  }

  const tokenUsage = usage as Record<string, unknown>;
  return (
    typeof completion.model === 'string' &&
    typeof completion.finishReason === 'string' &&
    typeof completion.stepCount === 'number' &&
    typeof completion.latencyMs === 'number' &&
    typeof tokenUsage.inputTokens === 'number' &&
    typeof tokenUsage.outputTokens === 'number' &&
    typeof tokenUsage.totalTokens === 'number'
  );
}

function summarizeEvent(event: ArchSSEEvent): Record<string, unknown> {
  switch (event.type) {
    case 'text_delta':
      return {
        preview: truncate(event.delta),
        length: event.delta.length,
      };
    case 'tool_call':
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        inputKeys: Object.keys(event.input),
      };
    case 'tool_result':
      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName ?? null,
        isError: event.isError ?? false,
      };
    case 'specialist':
      return {
        specialist: event.name,
        icon: event.icon,
      };
    case 'phase_transition':
      return {
        from: event.from,
        to: event.to,
      };
    case 'progress':
      return {
        step: event.step,
        total: event.total,
        label: event.label,
      };
    case 'gate_request':
      return {
        gateType: event.gateType,
        keys: Object.keys(event.data),
      };
    case 'error': {
      const errorPayload =
        'error' in event &&
        event.error &&
        typeof event.error === 'object' &&
        !Array.isArray(event.error)
          ? event.error
          : event;
      return {
        code:
          typeof (errorPayload as { code?: unknown }).code === 'string'
            ? (errorPayload as { code: string }).code
            : 'STREAM_ERROR',
        retryable:
          typeof (errorPayload as { retryable?: unknown }).retryable === 'boolean'
            ? (errorPayload as { retryable: boolean }).retryable
            : true,
      };
    }
    case 'build_agent_start':
      return {
        agent: event.agent,
        mode: event.mode,
        role: event.role,
      };
    case 'build_agent_stage':
      return {
        agent: event.agent,
        stage: event.stage,
        detail: event.detail ?? null,
      };
    case 'build_agent_compiled':
      return {
        agent: event.agent,
        elapsed: event.elapsed,
        toolCount: event.toolCount,
        handoffCount: event.handoffCount,
      };
    case 'build_agent_validated':
      return {
        agent: event.agent,
        toolCount: event.toolCount,
        handoffCount: event.handoffCount,
        warningCount: event.warnings.length,
      };
    case 'build_agent_error':
      return {
        agent: event.agent,
        stage: event.stage,
        error: truncate(event.error),
      };
    case 'build_reconciled':
      return event.summary;
    case 'build_retry_start':
      return {
        agentCount: event.agents.length,
      };
    case 'build_agent_diagnostics':
      return {
        agent: event.agent,
        severity: event.overallSeverity,
        findingCount: event.summary.total,
      };
    case 'file_changed':
      return {
        path: event.path,
        action: event.action,
      };
    case 'compile_result':
      return {
        agent: event.agent,
        status: event.status,
        warningCount: event.warnings?.length ?? 0,
        errorCount: event.errors?.length ?? 0,
      };
    case 'journal_entry':
      return {
        entryType: event.entryType,
        summary: truncate(event.summary),
      };
    case 'file_content_delta':
      return {
        agentName: event.agentName,
        length: event.delta.length,
      };
    case 'spec_document_update':
      return {
        path: event.path,
        version: event.version,
      };
    case 'done':
      return {
        suggestionCount: event.suggestions?.length ?? 0,
        hasCompletion: Boolean(event.completion),
      };
    default:
      return {};
  }
}

interface AuditHierarchyContext {
  phase?: string | null;
  projectId?: string;
  turnId?: string | null;
  activeLlmEventId?: string | null;
}

function mapEventToAuditEntry(
  event: ArchSSEEvent,
  context: AuditHierarchyContext,
): AuditLogEntry | null {
  const base = {
    phase: context.phase ?? undefined,
    projectId: context.projectId,
    turnId: context.turnId ?? undefined,
  };

  switch (event.type) {
    case 'phase_transition':
      return {
        ...base,
        category: 'phase_transition',
        severity: 'info',
        summary: `Phase: ${event.from} → ${event.to}`,
        detail: { from: event.from, to: event.to, trigger: 'auto' },
        phase: event.to,
        spanKind: 'phase',
        nestingDepth: 0,
        phaseLabel: event.to,
      };
    case 'tool_call':
      return {
        ...base,
        category: 'tool_execution',
        severity: 'info',
        summary: `${event.toolName} called`,
        detail: {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          inputKeys: Object.keys(event.input),
        },
        parentEventId: context.activeLlmEventId ?? undefined,
        spanKind: 'tool_call',
        nestingDepth: 3,
        phaseLabel: context.phase ?? undefined,
      };
    case 'tool_result':
      return {
        ...base,
        category: 'tool_execution',
        severity: event.isError ? 'error' : 'info',
        summary: `${event.toolName ?? 'tool'} ${event.isError ? 'failed' : 'completed'}`,
        detail: {
          toolCallId: event.toolCallId,
          toolName: event.toolName ?? 'unknown',
          resultStatus: event.isError ? 'error' : 'success',
        },
        parentEventId: context.activeLlmEventId ?? undefined,
        spanKind: 'tool_call',
        nestingDepth: 3,
        phaseLabel: context.phase ?? undefined,
      };
    case 'done':
      if (isCompletionAuditMetadata(event.completion)) {
        const completion = event.completion;
        return {
          ...base,
          category: 'llm_call',
          severity: 'info',
          summary: `LLM completed (${completion.model})`,
          detail: {
            model: completion.model,
            finishReason: completion.finishReason,
            stepCount: completion.stepCount,
            latencyMs: completion.latencyMs,
          },
          spanKind: 'llm_call',
          nestingDepth: 2,
          phaseLabel: context.phase ?? undefined,
          durationMs: completion.latencyMs,
          tokens: {
            input: completion.usage.inputTokens,
            output: completion.usage.outputTokens,
            total: completion.usage.totalTokens,
            estimatedCost: 0,
          },
        };
      }
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: 'Stream ended',
        detail: { suggestionCount: event.suggestions?.length ?? 0 },
      };
    case 'specialist':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `Specialist: ${event.name}`,
        detail: { specialist: event.name, icon: event.icon },
        nestingDepth: 1,
        phaseLabel: context.phase ?? undefined,
      };
    case 'gate_request':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `Gate: ${event.gateType}`,
        detail: { gateType: event.gateType, keys: Object.keys(event.data) },
      };
    case 'progress':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: event.label ?? `Step ${event.step}/${event.total}`,
        detail: { step: event.step, total: event.total, label: event.label },
      };
    case 'activity':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `Activity: ${event.label}`,
        detail: {
          activityId: event.id,
          status: event.status,
          label: event.label,
          group: event.group,
        },
      };
    case 'journal_entry':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `Journal: ${event.summary}`,
        detail: { entryType: event.entryType, journalSummary: event.summary },
      };
    case 'file_changed':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `File ${event.action}: ${event.path}`,
        detail: { path: event.path, action: event.action },
      };
    case 'file_content_delta':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `File write: ${event.agentName}`,
        detail: { agentName: event.agentName, deltaLength: event.delta.length },
      };
    case 'compile_result':
      return {
        ...base,
        category: 'build_event',
        severity: (event.errors?.length ?? 0) > 0 ? 'error' : 'info',
        summary: `Compile: ${event.agent} ${event.status}`,
        detail: {
          agentName: event.agent,
          status: event.status,
          warningCount: event.warnings?.length ?? 0,
          errorCount: event.errors?.length ?? 0,
        },
      };
    case 'spec_document_update':
      return {
        ...base,
        category: 'system_event',
        severity: 'info',
        summary: `Spec updated: ${event.path}`,
        detail: { path: event.path, version: event.version },
      };
    case 'build_agent_start':
      return {
        ...base,
        category: 'build_event',
        severity: 'info',
        summary: `Build: generating ${event.agent}`,
        detail: { agentName: event.agent, mode: event.mode, role: event.role },
      };
    case 'build_agent_stage':
      return {
        ...base,
        category: 'build_event',
        severity: 'info',
        summary: `Build: ${event.agent} → ${event.stage}`,
        detail: { agentName: event.agent, stage: event.stage, stageDetail: event.detail ?? null },
      };
    case 'build_agent_compiled':
      return {
        ...base,
        category: 'build_event',
        severity: event.warnings.length > 0 ? 'warning' : 'info',
        summary: `Build: ${event.agent} compiled (${event.toolCount} tools, ${event.handoffCount} handoffs)`,
        detail: {
          agentName: event.agent,
          toolCount: event.toolCount,
          handoffCount: event.handoffCount,
          elapsed: event.elapsed,
          warnings: event.warnings,
        },
      };
    case 'build_agent_validated':
      return {
        ...base,
        category: 'build_event',
        severity: event.warnings.length > 0 ? 'warning' : 'info',
        summary: `Build: ${event.agent} validated`,
        detail: {
          agentName: event.agent,
          toolCount: event.toolCount,
          handoffCount: event.handoffCount,
          warnings: event.warnings,
        },
      };
    case 'build_agent_error':
      return {
        ...base,
        category: 'build_event',
        severity: 'error',
        summary: `Build: ${event.agent} failed at ${event.stage}`,
        detail: { agentName: event.agent, stage: event.stage, error: event.error },
      };
    case 'build_reconciled':
      return {
        ...base,
        category: 'build_event',
        severity: event.summary.errors > 0 ? 'warning' : 'info',
        summary: `Build complete: ${event.summary.compiled}/${event.summary.total} agents`,
        detail: { ...event.summary },
      };
    case 'build_retry_start':
      return {
        ...base,
        category: 'build_event',
        severity: 'warning',
        summary: `Build retry: ${event.agents.length} agents`,
        detail: { agents: event.agents },
      };
    case 'build_agent_diagnostics':
      return {
        ...base,
        category: 'build_event',
        severity:
          event.overallSeverity === 'error'
            ? 'error'
            : event.overallSeverity === 'warning'
              ? 'warning'
              : 'info',
        summary: `Diagnostics: ${event.agent} (${event.summary.total} findings)`,
        detail: {
          agentName: event.agent,
          severity: event.overallSeverity,
          findings: event.summary,
        },
      };
    case 'error': {
      const errorPayload =
        'error' in event &&
        event.error &&
        typeof event.error === 'object' &&
        !Array.isArray(event.error)
          ? event.error
          : event;
      const code =
        typeof (errorPayload as { code?: unknown }).code === 'string'
          ? (errorPayload as { code: string }).code
          : 'STREAM_ERROR';
      const message =
        typeof (errorPayload as { message?: unknown }).message === 'string'
          ? (errorPayload as { message: string }).message
          : 'An unexpected error occurred.';
      const retryable =
        typeof (errorPayload as { retryable?: unknown }).retryable === 'boolean'
          ? (errorPayload as { retryable: boolean }).retryable
          : true;
      return {
        ...base,
        category: 'error',
        severity: retryable ? 'error' : 'critical',
        summary: message,
        detail: {
          errorCode: normalizeErrorCode(code),
          message,
          source: inferErrorSource(code),
          recoveryAction: retryable ? 'user_notified' : 'aborted',
        },
      };
    }
    default:
      return null;
  }
}

function normalizeErrorCode(code: string | undefined): AuditErrorCode {
  switch (code) {
    case 'LLM_TIMEOUT':
      return 'llm_timeout';
    case 'LLM_RATE_LIMITED':
      return 'rate_limit';
    case 'LLM_CONTEXT_EXCEEDED':
      return 'context_exceeded';
    case 'SESSION_BUSY':
    case 'SESSION_STATE_CONFLICT':
      return 'session_busy';
    case 'INVALID_TRANSITION':
      return 'invalid_transition';
    case 'TOOL_ERROR':
      return 'tool_error';
    case 'NETWORK_ERROR':
      return 'network_error';
    case 'STREAM_ERROR':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function inferErrorSource(code: string | undefined): AuditErrorSource {
  if (typeof code !== 'string' || code.length === 0) {
    return 'system';
  }
  if (code.startsWith('LLM_')) {
    return 'llm';
  }
  if (code.startsWith('SESSION_')) {
    return 'session';
  }
  if (code.startsWith('TOOL_')) {
    return 'tool';
  }
  if (code.startsWith('COMPILE_')) {
    return 'compiler';
  }
  return 'system';
}

export function createObservedArchStream(args: CreateObservedArchStreamArgs): {
  requestId: string;
  emit: (event: ArchSSEEvent) => void;
  close: () => void;
  flush: () => Promise<void>;
  setTurnId: (id: string) => void;
} {
  let sequence = 0;
  let closed = false;
  let currentPhase = args.phase ?? null;
  let auditSink = args.auditSink ?? null;
  const requestId = args.requestId?.trim() ? args.requestId.trim() : crypto.randomUUID();
  const startedAtMs = args.startedAtMs ?? Date.now();
  let lastEventAtMs = startedAtMs;
  let turnId: string | null = args.turnId ?? null;
  let activeLlmEventId: string | null = null;
  let responseTextBuffer = '';

  const flush = async () => {
    const sink = auditSink;
    auditSink = null;
    if (!sink) {
      return;
    }
    try {
      await sink.flush();
    } finally {
      sink.destroy();
    }
  };

  return {
    requestId,
    emit: (event) => {
      if (closed) {
        return;
      }

      sequence += 1;
      const now = Date.now();
      const phaseForEvent = event.type === 'phase_transition' ? event.to : currentPhase;
      const eventSummary = summarizeEvent(event);
      const elapsedMs = now - startedAtMs;
      const sinceLastEventMs = now - lastEventAtMs;
      lastEventAtMs = now;

      log.debug('arch_ai.stream_emit', {
        requestId,
        sequence,
        tenantId: args.tenantId,
        userId: args.userId,
        sessionId: args.sessionId,
        projectId: args.projectId ?? null,
        phase: phaseForEvent,
        mode: args.mode ?? null,
        eventType: event.type,
        elapsedMs,
        sinceLastEventMs,
        ...eventSummary,
      });

      // Auto-extract turnId from TurnEvent-shaped objects passing through
      const eventAny = event as unknown as Record<string, unknown>;
      if (!turnId && typeof eventAny.turnId === 'string' && eventAny.turnId.length > 0) {
        turnId = eventAny.turnId;
      }

      // Capture TurnEvent types that pass through as opaque objects
      if (auditSink && typeof eventAny.type === 'string') {
        const turnBase = {
          phase: phaseForEvent ?? undefined,
          projectId: args.projectId,
          turnId: turnId ?? undefined,
        };
        switch (eventAny.type) {
          case 'turn_started':
            auditSink.emit({
              ...turnBase,
              category: 'system_event',
              severity: 'info',
              summary: 'Turn started',
              detail: {
                specialist: typeof eventAny.specialist === 'string' ? eventAny.specialist : '',
              },
              spanKind: 'turn',
              nestingDepth: 1,
              phaseLabel: phaseForEvent ?? undefined,
            });
            activeLlmEventId = null;
            break;
          case 'turn_ended':
            auditSink.emit({
              ...turnBase,
              category: 'system_event',
              severity: 'info',
              summary: `Turn ended: ${typeof eventAny.reason === 'string' ? eventAny.reason : 'natural'}`,
              detail: { reason: eventAny.reason ?? 'natural', hasError: eventAny.error != null },
            });
            break;
          case 'turn_committed':
            auditSink.emit({
              ...turnBase,
              category: 'system_event',
              severity: 'info',
              summary: 'Turn committed',
              detail: { phase: eventAny.phase ?? null },
            });
            break;
          case 'interactive_tool':
            auditSink.emit({
              ...turnBase,
              category: 'tool_execution',
              severity: 'info',
              summary: `Interactive: ${typeof eventAny.tool === 'string' ? eventAny.tool : 'unknown'}`,
              detail: {
                toolName: eventAny.tool ?? 'unknown',
                toolCallId: eventAny.toolCallId ?? '',
                kind: eventAny.kind ?? 'tool',
              },
              spanKind: 'tool_call',
              nestingDepth: 3,
            });
            break;
          case 'status':
            if (typeof eventAny.label === 'string') {
              auditSink.emit({
                ...turnBase,
                category: 'system_event',
                severity: 'info',
                summary: `Status: ${eventAny.label}`,
                detail: { label: eventAny.label, progress: eventAny.progress ?? null },
              });
            }
            break;
          default:
            break;
        }
      }

      const auditEntry = mapEventToAuditEntry(event, {
        phase: phaseForEvent,
        projectId: args.projectId,
        turnId,
        activeLlmEventId,
      });
      if (auditEntry) {
        auditSink?.emit(auditEntry);
        if (auditEntry.spanKind === 'llm_call') {
          activeLlmEventId = requestId + '_llm_' + sequence;
        }
      }

      // Emit payloads for tool I/O — keyed by toolCallId for correlation
      if (auditSink?.emitPayload && event.type === 'tool_call') {
        const rawInputContent = JSON.stringify(event.input);
        auditSink.emitPayload({
          eventId: event.toolCallId,
          payloadType: 'tool_input',
          toolName: event.toolName,
          content: shouldCaptureToolInputPayload(event.toolName)
            ? redactAuditPayloadContent(rawInputContent, {
                payloadType: 'tool_input',
                toolName: event.toolName,
              })
            : buildRedactedToolInputPayload(event.toolName, event.input),
        });
      }
      if (auditSink?.emitPayload && event.type === 'tool_result') {
        const resultContent =
          typeof (event as { result?: unknown }).result === 'string'
            ? (event as { result: string }).result
            : JSON.stringify((event as { result?: unknown }).result ?? '');
        auditSink.emitPayload({
          eventId: event.toolCallId,
          payloadType: 'tool_output',
          toolName: event.toolName,
          content: redactAuditPayloadContent(resultContent, {
            payloadType: 'tool_output',
            toolName: event.toolName,
          }),
        });
      }

      // Accumulate LLM response text for payload capture
      if (event.type === 'text_delta') {
        responseTextBuffer += event.delta;
      }
      // Flush accumulated response as payload on LLM completion
      if (
        event.type === 'done' &&
        event.completion &&
        responseTextBuffer.length > 0 &&
        auditSink?.emitPayload
      ) {
        const llmPayloadId = activeLlmEventId ?? requestId + '_resp_' + sequence;
        auditSink.emitPayload({
          eventId: llmPayloadId,
          payloadType: 'response',
          content: redactAuditPayloadContent(responseTextBuffer, { payloadType: 'response' }),
        });
        responseTextBuffer = '';
      }

      if (event.type === 'phase_transition') {
        currentPhase = event.to;
      }

      args.emit(event);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      const now = Date.now();
      log.debug('arch_ai.stream_close', {
        requestId,
        sequence,
        sessionId: args.sessionId,
        elapsedMs: now - startedAtMs,
        sinceLastEventMs: now - lastEventAtMs,
      });
      args.close();
    },
    flush,
    setTurnId: (id: string) => {
      turnId = id;
    },
  };
}
