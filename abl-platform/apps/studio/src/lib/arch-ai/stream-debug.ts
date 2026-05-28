import type { ArchSSEEvent } from '@agent-platform/arch-ai/types';
import {
  useArchStreamDebugStore,
  type ArchStreamLogLevel,
} from '@/lib/arch-ai/store/arch-stream-debug-store';

const TEXT_PREVIEW_LENGTH = 120;
const DEFAULT_STREAM_ERROR_MESSAGE = 'An unexpected error occurred.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function truncate(value: string, max = TEXT_PREVIEW_LENGTH): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function summarizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return truncate(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  }
  if (value && typeof value === 'object') {
    return '{…}';
  }
  return String(value);
}

function summarizeErrorPayload(event: unknown): Record<string, unknown> {
  const eventRecord = isRecord(event) ? event : {};
  const nested = isRecord(eventRecord.error) ? eventRecord.error : eventRecord;
  const message =
    typeof nested.message === 'string' ? nested.message : DEFAULT_STREAM_ERROR_MESSAGE;
  return {
    code: typeof nested.code === 'string' ? nested.code : 'STREAM_ERROR',
    message: truncate(message),
    retryable: typeof nested.retryable === 'boolean' ? nested.retryable : true,
  };
}

export function summarizeArchStreamEvent(event: ArchSSEEvent): Record<string, unknown> {
  switch (event.type) {
    case 'text_delta':
      return { preview: truncate(event.delta), length: event.delta.length };
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
      return { specialist: event.name, icon: event.icon };
    case 'phase_transition':
      return { from: event.from, to: event.to };
    case 'gate_request':
      return { gateType: event.gateType, keys: Object.keys(event.data) };
    case 'progress':
      return { step: event.step, total: event.total, label: event.label };
    case 'error':
      return summarizeErrorPayload(event);
    case 'file_changed':
      return { path: event.path, action: event.action };
    case 'compile_result':
      return {
        agent: event.agent,
        status: event.status,
        warningCount: event.warnings?.length ?? 0,
        errorCount: event.errors?.length ?? 0,
      };
    case 'build_agent_start':
      return { agent: event.agent, mode: event.mode, role: event.role };
    case 'build_agent_stage':
      return { agent: event.agent, stage: event.stage, detail: event.detail ?? null };
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
      return { agent: event.agent, stage: event.stage, error: truncate(event.error) };
    case 'build_reconciled':
      return event.summary;
    case 'build_retry_start':
      return { agentCount: event.agents.length };
    case 'build_agent_diagnostics':
      return {
        agent: event.agent,
        severity: event.overallSeverity,
        findingCount: event.summary.total,
      };
    case 'file_processed':
      return {
        blobId: event.blobId,
        name: event.name,
        mediaType: event.mediaType,
        tokenCost: event.tokenCost,
      };
    case 'file_error':
      return {
        fileName: event.fileName,
        code: event.error.code,
        message: truncate(event.error.message),
      };
    case 'file_context_change':
      return {
        blobId: event.blobId,
        change: event.change,
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
        value: summarizeValue(event.value),
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

export function recordArchStreamLog(args: {
  requestId: string;
  sessionId: string | null;
  direction: 'client' | 'server';
  type: string;
  level: ArchStreamLogLevel;
  data?: Record<string, unknown>;
}): void {
  const store = useArchStreamDebugStore.getState();
  const data = args.data ?? {};

  store.record({
    requestId: args.requestId,
    sessionId: args.sessionId,
    direction: args.direction,
    type: args.type,
    level: args.level,
    data,
  });

  if (!store.enabled) {
    return;
  }

  const method =
    args.level === 'error'
      ? 'error'
      : args.level === 'warn'
        ? 'warn'
        : args.level === 'info'
          ? 'info'
          : 'debug';
  console[method](`[arch-stream] ${args.direction}:${args.type}`, {
    requestId: args.requestId,
    sessionId: args.sessionId,
    ...data,
  });
}
