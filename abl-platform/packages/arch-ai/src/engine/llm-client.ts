/**
 * LLM stream client abstraction for the v2 turn engine.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.3
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4.5
 *
 * The TurnEngine depends on an LLMStreamClient, not on a specific provider
 * SDK. The production implementation wraps Vercel AI SDK's streamText; tests
 * inject a FakeLLM (see test-utils/fake-llm.ts) that yields scripted chunks.
 *
 * This interface is deliberately minimal — just enough to let the engine
 * iterate chunks, read tool calls, and capture usage. Anything heavier
 * (caching, reasoning-thinking, model routing) lives in the production
 * wrapper, not here.
 */

import type { ZodSchema } from 'zod';
import type { ProviderContentBlock } from '../types/content-blocks.js';

// ─── Chunks the engine consumes ──────────────────────────────────────────

export type LLMStreamChunk =
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      toolName: string;
      /** Raw args as parsed from the LLM. Zod-validated by the ToolInvoker. */
      args: unknown;
    }
  | {
      type: 'finish';
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
      model: string;
      provider?: string;
      requestedModel?: string;
      responseId?: string;
      estimatedUsd?: number;
      latencyMs?: number;
    };

// ─── Tool descriptor shape passed to the LLM ─────────────────────────────

export interface LLMToolDescriptor {
  name: string;
  description: string;
  /**
   * Zod schema the LLM uses to shape its tool-call args. The engine wraps
   * this for the provider (Vercel AI SDK accepts Zod directly).
   */
  inputSchema: ZodSchema<unknown>;
}

// ─── The message shape the engine builds up ──────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ProviderContentBlock[];
  /** For assistant messages with tool calls — helps the provider reconstruct. */
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
  /** For tool messages — matches the prior assistant's tool call. */
  toolCallId?: string;
}

// ─── Request to the client ───────────────────────────────────────────────

export interface LLMStreamRequest {
  /** System prompt (usually composed from package prompts). */
  system: string;
  messages: LLMMessage[];
  tools: LLMToolDescriptor[];
  /** Propagated from the engine; all provider calls MUST respect this. */
  signal: AbortSignal;
  /** Provider-specific tuning knobs, passed through by the production wrapper. */
  options?: Record<string, unknown>;
}

// ─── The client interface ────────────────────────────────────────────────

export interface LLMStreamClient {
  /**
   * Stream a single round-trip to the LLM. Yields chunks in order. The
   * engine awaits completion (the `finish` chunk) before deciding whether
   * to loop back (more internal tool calls pending) or commit + pause.
   *
   * Errors thrown here are classified by the engine via classifyModelError —
   * implementations SHOULD attach `status` / `code` / `name` fields to their
   * errors so the classifier can map them to a retry policy.
   */
  stream(request: LLMStreamRequest): AsyncIterable<LLMStreamChunk>;
}
