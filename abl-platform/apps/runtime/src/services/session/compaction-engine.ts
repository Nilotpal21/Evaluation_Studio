/**
 * Compaction Engine
 *
 * Automatically compacts a thread's conversation history when context usage
 * approaches the model's limit. Summarizes older messages into a compact
 * summary, preserving recent messages in the active window.
 *
 * Triggered before each LLM call when the token estimate exceeds the
 * configured threshold (default 80% of context window).
 */

import { createLogger } from '@abl/compiler/platform';
import { getModelRegistryEntry } from '@abl/compiler/platform/llm/model-capabilities.js';
import type { RuntimeSession, AgentThread } from '../execution/types.js';
import type { SessionConfig } from './types.js';
import { DEFAULT_SESSION_CONFIG } from './types.js';
import { isConfigLoaded, getConfig } from '../../config/index.js';

const log = createLogger('compaction-engine');

/** Fallback context window when model is unknown or not in registry */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/** Rough token estimate: ~4 chars per token (conservative for English text) */
const CHARS_PER_TOKEN = 4;

/** Minimum messages to keep in active window after compaction */
const MIN_ACTIVE_WINDOW = 10;

/** System message role for compaction summaries */
const COMPACTION_SUMMARY_ROLE = 'system';
const COMPACTION_SUMMARY_PREFIX = '[Conversation Summary]\n';

export interface CompactionResult {
  compacted: boolean;
  threadIndex: number;
  messagesCompacted: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
}

/**
 * Estimate token count for a conversation history.
 * Uses a simple character-based heuristic (4 chars ≈ 1 token).
 */
function estimateTokens(messages: Array<{ role: string; content: unknown }>): number {
  let totalChars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'text' in block) {
          totalChars += (block as { text: string }).text.length;
        }
      }
    }
    // Role overhead
    totalChars += 10;
  }
  return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Get the model's context window size via the model registry.
 *
 * Resolution order:
 *   1. session.resolvedModelId (DB-resolved: Agent DB → Tenant Model)
 *   2. Active thread's agentIR.execution.model (DSL-declared)
 *   3. Session-level agentIR.execution.model (DSL-declared)
 *   4. Fallback: 128K (conservative default for modern models)
 *
 * Uses getModelRegistryEntry() which supports prefix matching for
 * versioned/provider-prefixed model IDs (e.g. "anthropic.claude-sonnet-4-20250514-v1:0").
 */
function getContextWindowSize(session: RuntimeSession): number {
  const thread = session.threads[session.activeThreadIndex];
  const modelId =
    session.resolvedModelId ||
    thread?.agentIR?.execution?.model ||
    session.agentIR?.execution?.model;

  if (modelId) {
    const entry = getModelRegistryEntry(modelId);
    if (entry?.contextWindow) {
      return entry.contextWindow;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

export class CompactionEngine {
  private configOverride?: Partial<SessionConfig>;

  constructor(config?: Partial<SessionConfig>) {
    this.configOverride = config;
  }

  /** Resolve effective config: explicit override → runtime config → defaults */
  private getConfig(): SessionConfig {
    const base = { ...DEFAULT_SESSION_CONFIG };
    // Pick up runtime config if loaded (env vars like SESSION_COMPACTION_ENABLED)
    if (isConfigLoaded()) {
      const rtCfg = getConfig().session;
      Object.assign(base, rtCfg);
    }
    if (this.configOverride) {
      Object.assign(base, this.configOverride);
    }
    return base;
  }

  /**
   * Check if auto-compaction should trigger for the active thread.
   * Called before each LLM call. Returns a CompactionResult if compaction
   * occurred, null if not needed.
   */
  async autoCompact(
    session: RuntimeSession,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<CompactionResult | null> {
    if (!this.getConfig().compactionEnabled) return null;

    const thread = session.threads[session.activeThreadIndex];
    if (!thread) return null;

    const contextWindow = getContextWindowSize(session);
    const currentTokens = estimateTokens(thread.conversationHistory);
    const effectiveThreshold =
      session.resolvedCompactionThreshold ?? this.getConfig().autoCompactThreshold;
    const threshold = contextWindow * effectiveThreshold;

    if (currentTokens < threshold) return null;

    log.info('auto-compact triggered', {
      sessionId: session.id,
      threadIndex: session.activeThreadIndex,
      agentName: thread.agentName,
      currentTokens,
      threshold,
      contextWindow,
    });

    return this.compactThread(session, session.activeThreadIndex, onTraceEvent);
  }

  /**
   * Compact a specific thread's conversation history.
   * Keeps the most recent messages in the active window and summarizes
   * older messages using an LLM call.
   */
  async compactThread(
    session: RuntimeSession,
    threadIndex: number,
    onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
  ): Promise<CompactionResult> {
    const thread = session.threads[threadIndex];
    const history = thread.conversationHistory;

    if (history.length <= MIN_ACTIVE_WINDOW) {
      return {
        compacted: false,
        threadIndex,
        messagesCompacted: 0,
        tokensBefore: estimateTokens(history),
        tokensAfter: estimateTokens(history),
      };
    }

    const tokensBefore = estimateTokens(history);

    // Split: compact first half, keep second half
    const splitPoint = Math.max(MIN_ACTIVE_WINDOW, Math.floor(history.length / 2));
    const toCompact = history.slice(0, history.length - splitPoint);
    const toKeep = history.slice(history.length - splitPoint);

    // Generate summary
    const summary = await this.generateSummary(toCompact, thread, session);

    // Rebuild conversation: summary message + active window
    const summaryMessage = {
      role: COMPACTION_SUMMARY_ROLE,
      content: COMPACTION_SUMMARY_PREFIX + summary,
    };

    thread.conversationHistory = [summaryMessage, ...toKeep] as typeof thread.conversationHistory;

    const tokensAfter = estimateTokens(thread.conversationHistory);

    const result: CompactionResult = {
      compacted: true,
      threadIndex,
      messagesCompacted: toCompact.length,
      tokensBefore,
      tokensAfter,
      summary,
    };

    log.info('compaction completed', {
      sessionId: session.id,
      agentName: thread.agentName,
      messagesCompacted: toCompact.length,
      tokensBefore,
      tokensAfter,
      compressionRatio: (tokensAfter / tokensBefore).toFixed(2),
    });

    if (onTraceEvent) {
      onTraceEvent({
        type: 'auto_compact',
        data: {
          threadIndex,
          agentName: thread.agentName,
          messagesCompacted: toCompact.length,
          tokensBefore,
          tokensAfter,
          summaryLength: summary.length,
        },
      });
    }

    return result;
  }

  /**
   * Generate a summary of compacted messages.
   * Uses the session's LLM client with a compact summarization prompt.
   * Falls back to a simple extraction if LLM is unavailable.
   */
  private async generateSummary(
    messages: Array<{ role: string; content: unknown }>,
    thread: AgentThread,
    session: RuntimeSession,
  ): Promise<string> {
    // Build a text representation of messages to summarize
    const transcript = messages
      .map((m) => {
        const content =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .filter(
                    (b: unknown): b is { type: string; text: string } =>
                      b != null && typeof b === 'object' && 'text' in b,
                  )
                  .map((b: { text: string }) => b.text)
                  .join(' ')
              : String(m.content);
        return `${m.role}: ${content}`;
      })
      .join('\n');

    // Try LLM summarization using the session's LLM client.
    // TODO: Use config.compactionModel to create a separate cheap LLM client
    // for summarization instead of reusing the session's primary LLM client.
    const llmClient = thread.llmClient || session.llmClient;
    if (llmClient) {
      try {
        const systemPrompt =
          'You are a conversation summarizer. Summarize concisely, focusing on: key decisions, collected data (names, dates, IDs), conversation state, and pending actions. Output 2-4 sentences.';

        const result = await llmClient.chatWithToolUse(
          systemPrompt,
          [{ role: 'user', content: `Summarize this conversation:\n${transcript}` }],
          [], // No tools — pure text generation
          'response_gen',
        );

        if (result.text) {
          return result.text;
        }
      } catch (err) {
        log.warn('LLM summarization failed, falling back to extraction', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Fallback: extract key information without LLM
    return this.extractiveSummary(messages, thread);
  }

  /**
   * Fallback extractive summary when LLM is unavailable.
   * Extracts key user messages and assistant decisions.
   */
  private extractiveSummary(
    messages: Array<{ role: string; content: unknown }>,
    thread: AgentThread,
  ): string {
    const keyPoints: string[] = [];
    keyPoints.push(`Agent: ${thread.agentName}`);

    // Extract first and last user messages for context
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length > 0) {
      const first = typeof userMessages[0].content === 'string' ? userMessages[0].content : '';
      keyPoints.push(`Initial request: ${first.slice(0, 200)}`);
    }
    if (userMessages.length > 1) {
      const last =
        typeof userMessages[userMessages.length - 1].content === 'string'
          ? (userMessages[userMessages.length - 1].content as string)
          : '';
      keyPoints.push(`Last input: ${last.slice(0, 200)}`);
    }

    // Include gathered data summary
    const gathered = Object.entries(thread.data.values);
    if (gathered.length > 0) {
      const summary = gathered
        .slice(0, 10)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      keyPoints.push(`Collected data: ${summary}`);
    }

    keyPoints.push(`Messages compacted: ${messages.length}`);

    return keyPoints.join('\n');
  }
}
