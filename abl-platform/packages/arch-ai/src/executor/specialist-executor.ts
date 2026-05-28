/**
 * SpecialistExecutor — runs a specialist LLM call and handles tool execution.
 *
 * Contract 13 (execution-model): Coordinator → SpecialistExecutor → LLM Client
 * Contract 8 (tool-registry): client-side tools end the stream
 * S1-F03: ask_user blocks the agentic loop
 *
 * Key behavior:
 * - When the LLM calls a CLIENT-SIDE tool (ask_user, collect_file),
 *   the executor emits tool_call + done and STOPS. No further tokens.
 * - When the LLM calls a SERVER-SIDE tool, the executor runs it and
 *   feeds the result back to the LLM.
 * - The coordinator calls resume() when the user answers a client-side tool.
 */

import type { ArchSSEEvent } from '../types/sse-events.js';
import type { ArchSession, SessionMetadata } from '../types/session.js';
import type { ProviderContentBlock } from '../types/content-blocks.js';
import type { ToolDefinition } from '../types/tools.js';
import type { AnySpecialistId } from '../types/constants.js';
import { isClientSideTool } from '../types/tools.js';
import type { ExecutionResult } from '../types/execution.js';
import type { AuthContext, ToolExecuteWithAuthFn } from '../types/auth-context.js';
import { ActivityEmitter } from '../streaming/activity-emitter.js';
import { createLogger } from '@agent-platform/shared-observability';

const log = createLogger('arch-ai:specialist-executor');

/**
 * Callback for emitting SSE events to the client.
 * The coordinator passes this in; the executor calls it for each event.
 */
export type SSEEmitter = (event: ArchSSEEvent) => void;

/**
 * Server-side tool execution function.
 * Each tool registers its own execute implementation.
 */
export type ToolExecuteFn = (
  input: Record<string, unknown>,
  session: ArchSession,
) => Promise<unknown>;

/**
 * LLM client abstraction. The executor doesn't know which LLM provider
 * is being used — it delegates to this interface.
 *
 * B03: content can be string (text-only) or ProviderContentBlock[] (multimodal).
 * The executor resolves ArchContentBlock references to provider-specific format
 * before calling streamChat.
 */
export interface LLMStreamClient {
  streamChat(params: {
    systemPrompt: string;
    messages: Array<{
      role: string;
      content: string | ProviderContentBlock[];
      toolCallId?: string;
      toolName?: string;
    }>;
    tools: ToolDefinition[];
  }): AsyncIterable<LLMStreamChunk>;
}

export type LLMStreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string }
  | { type: 'tool_call_args'; toolCallId: string; args: string }
  | { type: 'tool_call_end'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'response_end' };

export interface ExecutorParams {
  specialist: AnySpecialistId;
  tools: ToolDefinition[];
  toolExecutors: Record<string, ToolExecuteWithAuthFn>;
  systemPrompt: string;
  messages: Array<{
    role: string;
    content: string | ProviderContentBlock[];
    toolCallId?: string;
    toolName?: string;
  }>;
  session: ArchSession;
  authContext: AuthContext;
  onEvent: SSEEmitter;
  llmClient: LLMStreamClient;
  /** Max time for a single tool execution (ms). Default: 30000 */
  toolTimeoutMs?: number;
}

export interface ResumeParams {
  toolCallId: string;
  toolResult: unknown;
  onEvent: SSEEmitter;
}

/**
 * Run a specialist turn. Streams LLM output, handles tool calls.
 *
 * Returns ExecutionResult indicating whether:
 * - 'completed': turn finished normally (done event emitted)
 * - 'awaiting_tool_result': client-side tool called, waiting for user
 * - 'error': something went wrong
 */
export async function executeSpecialistTurn(params: ExecutorParams): Promise<ExecutionResult> {
  const { specialist, tools, toolExecutors, systemPrompt, messages, session, onEvent, llmClient } =
    params;

  // B05: Activity emitter for real-time visibility
  const activity = new ActivityEmitter(onEvent);
  const turnId = activity.nextTurn();

  // Emit specialist badge — Contract 4: specialist event before any text_delta
  const display = getSpecialistDisplay(specialist);
  onEvent({
    type: 'specialist',
    name: display.name,
    icon: display.icon,
  });

  // B05: Signal LLM thinking start
  activity.start(turnId, 'Thinking...');

  const stream = llmClient.streamChat({ systemPrompt, messages, tools });

  let pendingToolCallId: string | undefined;
  const updatedMetadata: Partial<SessionMetadata> = {};

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text_delta':
        onEvent({ type: 'text_delta', delta: chunk.delta });
        break;

      case 'tool_call_end': {
        const { toolCallId, toolName, input } = chunk;

        if (isClientSideTool(toolName)) {
          // CLIENT-SIDE TOOL: emit tool_call, emit done, STOP.
          // Contract 13: "Stream ENDS. Executor returns control to coordinator."
          // S1-F03: "No further tokens or tool calls in the same response."
          activity.done(turnId, 'Waiting for your input');
          onEvent({ type: 'tool_call', toolCallId, toolName, input });
          onEvent({ type: 'done' });

          pendingToolCallId = toolCallId;

          return {
            status: 'awaiting_tool_result',
            toolCallId,
            toolInput: input,
            updatedMetadata,
          };
        }

        // SERVER-SIDE TOOL: execute and return result to multi-turn executor.
        // The multi-turn executor appends the result as a tool message and re-invokes the LLM.
        activity.done(turnId, 'Processing...');
        const toolActivityId = `tool-${toolName}-${Date.now()}`;
        activity.start(toolActivityId, `Running ${toolName}...`);

        // ─── Phase 2.3: Pre-execution input validation ──────────────────────
        // Validate tool input against the JSON Schema definition before executing.
        // Tool schemas are JSON Schema (not Zod), so we validate required fields
        // and basic type checks. Returns an error tool result so the LLM can
        // self-correct with better input.
        const toolDef = tools.find((t) => t.name === toolName);
        const validationError = validateToolInput(toolDef, input);
        if (validationError) {
          log.warn('arch_ai.tool_input_invalid', {
            sessionId: session.id,
            toolName,
            errors: validationError,
          });
          activity.error(toolActivityId, `${toolName} invalid input`);
          onEvent({
            type: 'tool_result',
            toolCallId,
            toolName,
            result: { error: `Invalid tool input: ${validationError}` },
            isError: true,
          });
          return {
            status: 'tool_executed',
            toolCallId,
            toolName,
            toolResult: { error: `Invalid tool input: ${validationError}` },
            updatedMetadata,
          };
        }

        const executor = toolExecutors[toolName];
        if (!executor) {
          activity.error(toolActivityId, `Unknown tool: ${toolName}`);
          onEvent({
            type: 'tool_result',
            toolCallId,
            toolName,
            result: { error: `Unknown tool: ${toolName}` },
            isError: true,
          });
          return {
            status: 'tool_executed',
            toolCallId,
            toolName,
            toolResult: { error: `Unknown tool: ${toolName}` },
            updatedMetadata,
          };
        }

        try {
          // Wrap tool execution with a timeout to prevent runaway tools
          const toolTimeoutMs = params.toolTimeoutMs ?? 30_000;
          const toolPromise = executor(input, session, params.authContext);
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () => reject(new Error(`Tool '${toolName}' timed out after ${toolTimeoutMs}ms`)),
              toolTimeoutMs,
            );
          });

          let result: unknown;
          try {
            result = await Promise.race([toolPromise, timeoutPromise]);
          } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }

          // Validate tool result is a serializable object (not undefined, not a function)
          if (result === undefined || result === null) {
            log.warn('Tool returned null/undefined result', { toolName, toolCallId });
            result = {
              success: false,
              error: { code: 'EMPTY_RESULT', message: 'Tool returned no result' },
            };
          }
          if (typeof result === 'function') {
            log.error('Tool returned a function instead of data', { toolName });
            result = {
              success: false,
              error: { code: 'INVALID_RESULT', message: 'Tool returned invalid result type' },
            };
          }

          activity.done(toolActivityId, `${toolName} complete`);
          onEvent({ type: 'tool_result', toolCallId, toolName, result });
          return {
            status: 'tool_executed',
            toolCallId,
            toolName,
            toolResult: result,
            updatedMetadata,
          };
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const isTimeout = errorMessage.includes('timed out after');
          if (isTimeout) {
            log.warn('arch_ai.tool_timeout', {
              sessionId: session.id,
              toolName,
              timeoutMs: params.toolTimeoutMs ?? 30_000,
            });
          }
          activity.error(toolActivityId, `${toolName} failed`);
          onEvent({
            type: 'tool_result',
            toolCallId,
            toolName,
            result: { error: errorMessage },
            isError: true,
          });
          return {
            status: 'tool_executed',
            toolCallId,
            toolName,
            toolResult: { error: errorMessage },
            updatedMetadata,
          };
        }
      }

      case 'response_end':
        // Normal completion — no pending tool
        activity.done(turnId, 'Response ready');
        onEvent({ type: 'done' });
        return {
          status: 'completed',
          updatedMetadata,
        };

      // tool_call_start and tool_call_args are intermediate streaming events.
      // We accumulate them until tool_call_end.
      case 'tool_call_start':
      case 'tool_call_args':
        break;
    }
  }

  // Stream ended without explicit response_end (edge case — treat as complete)
  if (!pendingToolCallId) {
    onEvent({ type: 'done' });
  }

  return {
    status: pendingToolCallId ? 'awaiting_tool_result' : 'completed',
    toolCallId: pendingToolCallId,
    updatedMetadata,
  };
}

// ─── Phase 2.3: JSON Schema input validation ────────────────────────────────

/**
 * Validate tool input against its JSON Schema definition.
 * Returns an error description string if validation fails, undefined if valid.
 *
 * Currently checks:
 * - Required fields are present and non-undefined
 * - Top-level type constraints (string, number, boolean, array, object)
 *
 * TODO: Full JSON Schema validation (nested objects, enum, pattern, min/max)
 * would require a library like ajv. This covers the most common LLM mistakes
 * (missing required fields, wrong primitive type) without adding a dependency.
 */
function validateToolInput(
  toolDef: ToolDefinition | undefined,
  input: Record<string, unknown>,
): string | undefined {
  if (!toolDef) return undefined; // No definition found — skip validation

  const schema = toolDef.inputSchema;
  if (!schema || typeof schema !== 'object') return undefined;

  const errors: string[] = [];

  // Check required fields
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const field of required) {
      if (typeof field === 'string' && (!(field in input) || input[field] === undefined)) {
        errors.push(`${field}: required field is missing`);
      }
    }
  }

  // Check top-level property types
  const properties = schema.properties;
  if (properties && typeof properties === 'object') {
    const props = properties as Record<string, Record<string, unknown>>;
    for (const [key, propSchema] of Object.entries(props)) {
      if (!(key in input) || input[key] === undefined) continue; // Not provided — only required check catches this
      const expectedType = propSchema?.type;
      if (typeof expectedType !== 'string') continue;

      const value = input[key];
      const actualType = Array.isArray(value) ? 'array' : typeof value;

      // Map JSON Schema types to JS typeof results
      const typeMap: Record<string, string[]> = {
        string: ['string'],
        number: ['number'],
        integer: ['number'],
        boolean: ['boolean'],
        array: ['array'],
        object: ['object'],
      };

      const allowed = typeMap[expectedType];
      if (allowed && !allowed.includes(actualType)) {
        errors.push(`${key}: expected ${expectedType}, got ${actualType}`);
      }
    }
  }

  return errors.length > 0 ? errors.join('; ') : undefined;
}

/**
 * Specialist display metadata for SSE specialist events.
 * Contract 4: specialist event has { name: string, icon: string }
 * where name is human-readable (e.g., "Onboarding Specialist").
 * Icon names are not in any contract — implementation choice.
 */
interface SpecialistDisplay {
  name: string;
  icon: string;
}

const SPECIALIST_DISPLAY: Partial<Record<AnySpecialistId, SpecialistDisplay>> = {
  onboarding: { name: 'Onboarding Specialist', icon: 'clipboard' },
  'multi-agent-architect': { name: 'Multi-Agent Architect', icon: 'network' },
  'abl-construct-expert': { name: 'ABL Construct Expert', icon: 'code' },
  'channel-voice': { name: 'Channel & Voice Expert', icon: 'phone' },
  'entity-collection': { name: 'Entity Collection Expert', icon: 'database' },
  'integration-methodologist': { name: 'Integration Methodologist', icon: 'plug' },
  'testing-eval': { name: 'Testing & Eval Expert', icon: 'flask' },
  'in-project-architect': { name: 'In-Project Architect', icon: 'network' },
  diagnostician: { name: 'Diagnostician', icon: 'stethoscope' },
  analyst: { name: 'Performance Analyst', icon: 'bar_chart' },
  observer: { name: 'Observer', icon: 'telescope' },
};

function getSpecialistDisplay(specialist: AnySpecialistId): SpecialistDisplay {
  return SPECIALIST_DISPLAY[specialist] ?? { name: specialist, icon: 'bot' };
}
