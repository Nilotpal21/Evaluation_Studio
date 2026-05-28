/**
 * Tool registry for the v2 turn engine.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.2
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 3
 *
 * Binary classification (D-2): tools are either `internal` (silent, update the
 * artifact panel via ctx.emit) or `interactive` (pause the turn, surface a
 * chat widget). No third kind; no dynamic classification.
 *
 * Per-audit removals (plan D-15..D-20 era):
 *   - NO `widgetVariant` field: tools emit `artifact_updated` inline from
 *     execute when their result renders a widget. Keeps the contract honest.
 *   - NO `gatedBy` predicate: sub-phase / mode filtering happens in the
 *     phase-tools builder functions, not in the tool definition.
 *   - `readOnly: true` kept as an optional hint (future parallel-read
 *     optimization + documentation); no runtime enforcement.
 *
 * Runtime assertions (enforced by `register`):
 *   - Interactive tools MUST NOT have `execute` — Vercel AI SDK pauses on
 *     emission for client-side tools.
 *   - Internal tools MUST have `execute` — otherwise nothing happens.
 *   - Tool names must be unique within a registry instance.
 *
 * Collection bounds (CLAUDE.md "every in-memory Map needs max size, TTL,
 * and eviction"): the registry is BOOT-TIME-BOUNDED — populated once at
 * startup with a fixed set of ~30 tool definitions from internal/, interactive/,
 * and synthetic/. No runtime growth; no eviction needed. `MAX_TOOLS`
 * guard enforces the cap defensively.
 */

import type { ZodSchema } from 'zod';

/** Hard cap on registry size to catch accidental runtime growth. */
const MAX_TOOLS = 100;

// ─── Forward declaration of TurnContext ──────────────────────────────────
// The concrete TurnContext interface ships in Phase 4 (engine/turn-context.ts).
// We expose a minimal stub here so tool definitions can type their `ctx`
// parameter without a circular import. The Phase 4 module will re-export a
// richer version that consumers extend.

export interface MinimalTurnContext {
  sessionId: string;
  tenantId: string;
  userId: string;
  /** Session mode. IN_PROJECT tools require this to be 'in-project'. */
  mode?: 'onboarding' | 'in-project';
  /** Set in IN_PROJECT mode and after project creation in onboarding. */
  projectId?: string;
  /** Signals cooperative abort. Tools SHOULD forward this to HTTP / LLM / child processes. */
  signal: AbortSignal;
  /**
   * Emit a side-effect event to the client's fan-out channel. Only internal
   * tools should use this — interactive tools don't have an `execute` body.
   * The concrete shape is filled in by Phase 4's TurnContext.
   */
  emit: (event: unknown) => void;
  /**
   * Opaque service bag populated by the production factory; tools look up
   * dependencies by key and cast. Present on the concrete TurnContext;
   * optional here so the minimal shape stays lightweight for tests.
   * See `tools/v2/internal/README.md` for the service-bag contract.
   */
  services?: Record<string, unknown>;
}

// ─── Public types ────────────────────────────────────────────────────────

export type ToolKind = 'internal' | 'interactive';

export interface ToolDefinition<Args = unknown, Result = unknown> {
  /** Unique name. Must match the LLM-facing tool-call `name`. */
  name: string;

  kind: ToolKind;

  /**
   * Optional declarative hint. `readOnly: true` means the tool never writes
   * session or project state. Future use: parallel execution optimization.
   * Not enforced at runtime — convention + documentation.
   */
  readOnly?: boolean;

  /**
   * Short label shown in the `status` event's label field while the tool
   * executes. Internal tools only. Falls back to `Running <name>`.
   */
  statusLabel?: string;

  description: string;
  inputSchema: ZodSchema<Args>;

  /**
   * Present on internal tools; absent on interactive tools. Vercel AI SDK
   * pauses streaming when the model emits a tool call for a tool without an
   * `execute` function, which is exactly what the interactive / ask_user
   * flow needs.
   */
  execute?: (args: Args, ctx: MinimalTurnContext) => Promise<Result>;
}

/** Narrowed type for internal tools — execute is required. */
export type InternalToolDefinition<Args = unknown, Result = unknown> = ToolDefinition<
  Args,
  Result
> & {
  kind: 'internal';
  execute: (args: Args, ctx: MinimalTurnContext) => Promise<Result>;
};

/** Narrowed type for interactive tools — execute is absent. */
export type InteractiveToolDefinition<Args = unknown> = Omit<
  ToolDefinition<Args, never>,
  'execute'
> & {
  kind: 'interactive';
  execute?: never;
};

// ─── ToolRegistry ────────────────────────────────────────────────────────

export class ToolRegistry {
  // Boot-time-bounded registry. See module header: max ~30 tools in practice;
  // MAX_TOOLS=100 guards against accidental runtime growth. No TTL / eviction
  // because entries never age out — the registry lives for the pod's lifetime.
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  /**
   * Register a tool. Enforces binary classification invariants:
   *   - internal MUST have execute
   *   - interactive MUST NOT have execute
   *   - names unique within this registry
   */
  register<Args, Result>(tool: ToolDefinition<Args, Result>): void {
    if (tool.kind !== 'internal' && tool.kind !== 'interactive') {
      throw new Error(
        `ToolRegistry: tool '${tool.name}' has invalid kind '${String(tool.kind)}' ` +
          `(expected 'internal' or 'interactive')`,
      );
    }

    if (tool.kind === 'interactive' && typeof tool.execute === 'function') {
      throw new Error(
        `ToolRegistry: interactive tool '${tool.name}' MUST NOT have an execute function — ` +
          `Vercel AI SDK pauses on emission for client-side tools (spec §5.2).`,
      );
    }

    if (tool.kind === 'internal' && typeof tool.execute !== 'function') {
      throw new Error(
        `ToolRegistry: internal tool '${tool.name}' MUST have an execute function — ` +
          `otherwise the engine has no way to handle the tool call.`,
      );
    }

    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: duplicate tool registration for '${tool.name}'`);
    }

    if (this.tools.size >= MAX_TOOLS) {
      throw new Error(
        `ToolRegistry: size limit (${MAX_TOOLS}) reached — this is a safeguard against ` +
          `accidental runtime growth. Registry is meant to be boot-time-populated.`,
      );
    }

    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  /** Register many tools at once. */
  registerAll(tools: ToolDefinition<unknown, unknown>[]): void {
    for (const t of tools) this.register(t);
  }

  /** Lookup by name; returns undefined if not registered. */
  get(name: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  /** Return all tools in registration order. */
  list(): ReadonlyArray<ToolDefinition<unknown, unknown>> {
    return Array.from(this.tools.values());
  }

  /** Return tools of a specific kind. */
  listByKind(kind: ToolKind): ReadonlyArray<ToolDefinition<unknown, unknown>> {
    return this.list().filter((t) => t.kind === kind);
  }

  /** Return tools matching a name filter (used by phase-tools builders). */
  listByNames(names: ReadonlyArray<string>): ReadonlyArray<ToolDefinition<unknown, unknown>> {
    const set = new Set(names);
    return this.list().filter((t) => set.has(t.name));
  }

  /** Total registered count. Useful for asserting no accidental missing tools. */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Returns a fresh ToolRegistry containing only the named tools. Useful for
   * phase-scoped filtering at turn start: one global registry, filtered
   * per-session-mode-and-phase at invocation.
   */
  subset(names: ReadonlyArray<string>): ToolRegistry {
    const sub = new ToolRegistry();
    for (const t of this.listByNames(names)) {
      sub.register(t);
    }
    return sub;
  }
}

// ─── Helpers for callers (Phase 3 + 4 tooling builders) ──────────────────

/** Type guard: is this an internal tool? (Narrows the type for callers.) */
export function isInternalTool<A, R>(t: ToolDefinition<A, R>): t is InternalToolDefinition<A, R> {
  return t.kind === 'internal';
}

/** Type guard: is this an interactive tool? */
export function isInteractiveTool<A>(
  t: ToolDefinition<A, unknown>,
): t is InteractiveToolDefinition<A> {
  return t.kind === 'interactive';
}
