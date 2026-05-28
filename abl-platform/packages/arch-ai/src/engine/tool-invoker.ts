/**
 * ToolInvoker — executes internal tools with self-correcting retry + timeout.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.7
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4.2
 *
 * Behavior:
 *   - Validates args via the tool's Zod schema (throws ARGS_INVALID on fail).
 *   - Races execute() against an AbortSignal with TOOL_INVOCATION_TIMEOUT_MS.
 *   - On any failure, returns a classified synthetic result that gets fed
 *     back to the LLM as the tool_call output — the LLM can then self-correct.
 *   - Tracks a per-(name + arg-hash) signature count; on 3+ retries of the
 *     same signature, injects REPEAT_CALL_DETECTED without executing.
 *
 * Map lifecycle (CLAUDE.md "every Map needs max size, TTL, eviction"):
 *   This `signatureCounts` Map is TURN-SCOPED — a ToolInvoker is created per
 *   turn, discarded at turn end. Max entries bounded naturally by
 *   ARCH_AI_TURN.MAX_TOOL_CALLS_PER_TURN (25). No eviction logic needed.
 */

import type { ZodSchema } from 'zod';
import { ZodError } from 'zod';

import { ARCH_AI_TURN } from './hard-limits.js';
import {
  TimeoutError,
  ZodValidationError,
  classifyToolError,
  ToolErrorCode,
  type ToolExecutionError,
} from './error-classifier.js';
import type { MinimalTurnContext, ToolDefinition } from '../tools/v2/registry.js';

// ─── Public types ────────────────────────────────────────────────────────

export interface InvocationRequest {
  /** Stable ID for this specific tool call from the LLM. */
  toolCallId: string;
  /** Tool name the LLM emitted. */
  toolName: string;
  /** Raw args as parsed from the LLM stream. Will be Zod-validated. */
  rawArgs: unknown;
}

export type InvocationResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ToolExecutionError };

export interface ToolInvokerOptions {
  /** Turn-scoped context passed to each tool.execute. */
  ctx: MinimalTurnContext;
  /** Override for testing / tuning. */
  timeoutMs?: number;
  /** Override for testing / tuning. */
  maxRetries?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────

export class ToolInvoker {
  private readonly signatureCounts = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: ToolInvokerOptions) {
    this.timeoutMs = opts.timeoutMs ?? ARCH_AI_TURN.TOOL_INVOCATION_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? ARCH_AI_TURN.TOOL_SELF_CORRECT_RETRIES;
  }

  /**
   * Execute a tool call with validation, timeout, and self-correction dedup.
   *
   * Returns:
   *   { ok: true, value }     — tool ran successfully
   *   { ok: false, error }    — synthetic error to feed back to the LLM
   *
   * The caller (TurnEngine) decides whether to push this result back into
   * the LLM conversation or to terminate the turn.
   */
  async invoke<Args, Result>(
    tool: ToolDefinition<Args, Result> | undefined,
    request: InvocationRequest,
  ): Promise<InvocationResult> {
    if (!tool) {
      return {
        ok: false,
        error: {
          category: 'tool',
          code: ToolErrorCode.UNKNOWN_TOOL,
          message: `No tool registered for name '${request.toolName}'`,
        },
      };
    }

    if (tool.kind !== 'internal') {
      return {
        ok: false,
        error: {
          category: 'tool',
          code: ToolErrorCode.TOOL_EXECUTION_FAILED,
          message:
            `Tool '${request.toolName}' is interactive — ` +
            `engine must pause the turn rather than invoking execute.`,
        },
      };
    }

    // Signature-based dedup: (name + stable-hash(args)). We hash the raw
    // pre-validation args because a retry MUST match the prior call shape.
    const signature = stableSignature(request.toolName, request.rawArgs);
    const priorCount = this.signatureCounts.get(signature) ?? 0;

    if (priorCount >= this.maxRetries) {
      // Hard stop — the LLM keeps hallucinating the same failing call.
      this.signatureCounts.set(signature, priorCount + 1);
      return {
        ok: false,
        error: {
          category: 'tool',
          code: ToolErrorCode.REPEAT_CALL_DETECTED,
          message:
            `Repeated call to '${request.toolName}' with identical args ` +
            `(${priorCount} prior attempts). Try different arguments or finalize.`,
        },
      };
    }
    this.signatureCounts.set(signature, priorCount + 1);

    // Zod validation
    let args: Args;
    try {
      args = parseOrThrow(tool.inputSchema, request.rawArgs);
    } catch (err) {
      return { ok: false, error: classifyToolError(err) };
    }

    // Execute with timeout
    try {
      const execute = tool.execute!;
      const value = await raceTimeout(
        execute(args, this.opts.ctx),
        this.timeoutMs,
        `tool '${request.toolName}'`,
      );
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: classifyToolError(err, request.toolName) };
    }
  }

  /** Visible for tests; returns the count of attempts for a signature. */
  getSignatureCount(toolName: string, args: unknown): number {
    return this.signatureCounts.get(stableSignature(toolName, args)) ?? 0;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseOrThrow<T>(schema: ZodSchema<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ZodValidationError(result.error.issues);
  }
  return result.data;
}

/**
 * Race a promise against a timeout. Throws TimeoutError on timeout.
 * The underlying tool is responsible for honoring the AbortSignal in ctx
 * to stop its own work on abort.
 */
async function raceTimeout<T>(p: Promise<T>, ms: number, context: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${context} exceeded ${ms}ms`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Stable string signature for (toolName, args). We serialize args with
 * sorted keys so the same logical call produces the same signature even
 * if the LLM reorders object keys.
 */
function stableSignature(toolName: string, args: unknown): string {
  return `${toolName}::${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Keep ZodError importable for callers that want to narrow external errors.
export { ZodError };
