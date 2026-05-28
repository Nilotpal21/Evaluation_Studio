/**
 * VercelLLMStreamClient — bridges the executor's LLMStreamClient interface with
 * Vercel AI SDK's streamText.
 *
 * buildInProjectToolDefs — builds ToolDefinition[], toolExecutors, and Vercel
 * tool objects for IN_PROJECT mode. Accepts buildInProjectToolsFn as a parameter
 * to avoid a circular dependency with the route module.
 */

import { streamText } from 'ai';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { isClientSideTool, normalizeContent } from '@agent-platform/arch-ai';
import type {
  LLMStreamClient,
  LLMStreamChunk,
  ToolDefinition,
  ArchSession,
  AuthContext,
  ToolExecuteWithAuthFn,
  ProviderContentBlock,
} from '@agent-platform/arch-ai';
import { ARCH_AI_LLM_DEFAULTS, ARCH_AI_TIMEOUTS } from '@/lib/arch-ai/constants';

const log = createLogger('lib:arch-ai:llm-client');

// ─── Vercel AI SDK → LLMStreamClient Adapter ──────────────────────────

export interface ArchVercelMessage {
  role: string;
  content: string | ProviderContentBlock[];
  toolCallId?: string;
  toolName?: string;
}

function serializeToolOutput(
  content: string | ProviderContentBlock[],
): { type: 'json'; value: unknown } | { type: 'text'; value: string } {
  const raw = typeof content === 'string' ? content : JSON.stringify(content);

  try {
    return {
      type: 'json',
      value: JSON.parse(raw),
    };
  } catch {
    return {
      type: 'text',
      value: raw,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toVercelMessages(messages: ArchVercelMessage[]): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vercelMessages: any[] = [];

  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) {
      vercelMessages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId,
            toolName: message.toolName || 'unknown',
            output: serializeToolOutput(message.content),
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCallId) {
      vercelMessages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: message.toolCallId,
            toolName: message.toolName || 'unknown',
            input: {},
          },
        ],
      });
      continue;
    }

    if (typeof message.content === 'string') {
      vercelMessages.push({ role: message.role, content: message.content });
      continue;
    }

    if (Array.isArray(message.content)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
        } else if (block.type === 'image' && block.source.type === 'base64') {
          parts.push({
            type: 'image',
            image: `data:${block.source.media_type};base64,${block.source.data}`,
          });
        } else if (block.type === 'image' && block.source.type === 'url') {
          parts.push({
            type: 'image',
            image: block.source.url,
          });
        } else if (block.type === 'image_url') {
          parts.push({
            type: 'image',
            image: block.image_url.url,
          });
        }
      }

      vercelMessages.push({ role: message.role, content: parts.length > 0 ? parts : '' });
      continue;
    }

    vercelMessages.push({
      role: message.role,
      content: normalizeContent(message.content as string | undefined),
    });
  }

  return vercelMessages;
}

/**
 * Adapter that bridges the executor's LLMStreamClient interface with
 * Vercel AI SDK's streamText. Receives pre-built Vercel tool objects
 * (with Zod schemas) at construction time and uses them for every
 * streamChat call, ignoring the ToolDefinition[] parameter from the
 * executor (which only carries JSON Schema — not Zod).
 */
export class VercelLLMStreamClient implements LLMStreamClient {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private model: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private vercelTools: Record<string, any>,
    private readonly abortSignal?: AbortSignal,
  ) {}

  async *streamChat(params: {
    systemPrompt: string;
    messages: Array<{
      role: string;
      content: string | ProviderContentBlock[];
      toolCallId?: string;
      toolName?: string;
    }>;
    tools: ToolDefinition[];
  }): AsyncIterable<LLMStreamChunk> {
    const vercelMessages = toVercelMessages(params.messages);

    // Log full tool messages for debugging
    const toolMsgs = vercelMessages.filter(
      (m: Record<string, unknown>) =>
        m.role === 'tool' || (m.role === 'assistant' && typeof m.content !== 'string'),
    );
    if (toolMsgs.length > 0) {
      log.info('VercelLLMStreamClient: tool messages detail', {
        toolMessages: JSON.stringify(toolMsgs).substring(0, 500),
      });
    }

    const result = streamText({
      model: this.model,
      system: params.systemPrompt,
      messages: vercelMessages,
      tools: this.vercelTools,
      maxRetries: ARCH_AI_LLM_DEFAULTS.MAX_RETRIES,
      timeout: {
        totalMs: ARCH_AI_TIMEOUTS.LLM_CALL_MS,
        stepMs: ARCH_AI_TIMEOUTS.LLM_CALL_MS,
        chunkMs: ARCH_AI_TIMEOUTS.LLM_STREAM_CHUNK_MS,
      },
      maxOutputTokens: ARCH_AI_LLM_DEFAULTS.MAX_OUTPUT_TOKENS,
      temperature: ARCH_AI_LLM_DEFAULTS.TEMPERATURE,
      abortSignal: this.abortSignal,
    });

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          yield { type: 'text_delta', delta: part.text } as LLMStreamChunk;
          break;
        case 'tool-call': {
          const input = (part.input ?? {}) as Record<string, unknown>;
          yield {
            type: 'tool_call_start',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
          } as LLMStreamChunk;
          yield {
            type: 'tool_call_end',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input,
          } as LLMStreamChunk;
          break;
        }
        case 'error': {
          const partError = part.error;
          const errMsg =
            partError instanceof Error
              ? partError.message
              : typeof partError === 'object' && partError !== null
                ? JSON.stringify(partError)
                : String(partError);
          log.error('Vercel stream error in adapter', {
            error: errMsg,
            errorType: partError instanceof Error ? partError.constructor.name : typeof partError,
          });
          throw partError instanceof Error ? partError : new Error(errMsg);
        }
        default:
          break;
      }
    }

    yield { type: 'response_end' } as LLMStreamChunk;
  }
}

/**
 * Build ToolDefinition[], toolExecutors, and Vercel tool objects for IN_PROJECT mode.
 * Accepts buildInProjectToolsFn as a parameter to avoid a circular dependency
 * with the route module where buildInProjectTools is defined.
 * Extracts execute functions from the Vercel tool objects to create the
 * separate toolExecutors map that the specialist executor expects.
 */
export function buildInProjectToolDefs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildInProjectToolsFn: (
    ctx: { tenantId: string; userId: string; permissions?: string[] },
    sessionId: string,
    projectId: string,
    authToken?: string,
    onCardEmit?: (event: Record<string, unknown>) => void,
  ) => Record<string, unknown>,
  ctx: { tenantId: string; userId: string; permissions?: string[] },
  sessionId: string,
  projectId: string,
  authToken?: string,
  onCardEmit?: (event: Record<string, unknown>) => void,
): {
  toolDefs: ToolDefinition[];
  executors: Record<string, ToolExecuteWithAuthFn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vercelTools: Record<string, any>;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vercelTools = buildInProjectToolsFn(
    ctx,
    sessionId,
    projectId,
    authToken,
    onCardEmit,
  ) as Record<string, any>;
  const toolDefs: ToolDefinition[] = [];
  const executors: Record<string, ToolExecuteWithAuthFn> = {};

  for (const [name, toolObj] of Object.entries(vercelTools)) {
    const isClient = isClientSideTool(name);

    toolDefs.push({
      name: name as ToolDefinition['name'],
      type: isClient ? 'client-side' : 'server-side',
      description: (toolObj as { description?: string }).description ?? name,
      inputSchema: {}, // Not used — adapter uses pre-built Vercel tools with Zod schemas
    });

    if (!isClient) {
      const executeRaw = (
        toolObj as { execute?: (input: Record<string, unknown>) => Promise<unknown> }
      ).execute;
      if (executeRaw) {
        executors[name] = async (
          input: Record<string, unknown>,
          _session: ArchSession,
          _auth: AuthContext,
        ) => {
          return executeRaw(input);
        };
      }
    }
  }

  return { toolDefs, executors, vercelTools };
}
