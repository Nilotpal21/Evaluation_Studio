/**
 * TurnContext — concrete turn-scoped context passed to tool.execute.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.3
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4.4
 *
 * Extends MinimalTurnContext (declared in tools/v2/registry.ts) with the
 * concrete `emit` signature and the TurnBuffer handle so internal tools can
 * enqueue project writes for atomic end-of-turn commit.
 *
 * The abstract MinimalTurnContext interface uses `emit: (event: unknown) => void`
 * to avoid a circular import; this concrete interface narrows `emit` to accept
 * an ArtifactUpdate (which the engine wraps in the full envelope before
 * publishing).
 */

import type { ActivityStep, ArtifactUpdate } from '../types/turn-events.js';
import type { MinimalTurnContext } from '../tools/v2/registry.js';
import type { TurnBuffer } from './turn-buffer.js';

/**
 * A queued project-level write — captured during internal tool execution,
 * applied inside the withTransaction block at `TurnBuffer.commit()`.
 *
 * The ClientSession parameter is injected by the buffer at commit time; tools
 * MUST pass it to their Mongoose ops via `{ session }` for transactional
 * consistency. When running on standalone Mongo (no replica set), `session`
 * will be `null` — Mongoose operations accept this as "no transaction".
 */
export interface ProjectWrite {
  /** Short description for logs / trace spans (e.g., "update_tool:create"). */
  label: string;
  /**
   * Apply function receiving the transaction session (or null). Tools
   * register this via `ctx.buffer.enqueueProjectWrite` during their execute.
   */
  execute: (session: unknown) => Promise<void>;
}

/**
 * Concrete turn context — extends the minimal shape for forward-compat with
 * Phase 3 tool definitions that type `ctx: MinimalTurnContext`.
 *
 * Note: MinimalTurnContext.emit is typed as `(event: unknown) => void` to
 * avoid a circular import with turn-events.ts. This concrete context
 * inherits that signature; callers pass `ArtifactUpdate` values which are
 * assignable to `unknown`. The engine narrows + wraps in an envelope before
 * publishing to the fan-out channel.
 */
export interface TurnContext extends MinimalTurnContext {
  /** Turn ID bound to this execution. Stable for the life of the turn. */
  turnId: string;

  /** Helper to emit a typed ArtifactUpdate — wraps the generic emit. */
  emitArtifact: (update: ArtifactUpdate) => void;

  /**
   * Ephemeral progress status. Delivered to live SSE subscribers immediately;
   * NEVER stored in the ring buffer, NEVER replayed on reconnect. Use for
   * UX progress hints (e.g., "generating topology...") that become irrelevant
   * after the turn commits.
   */
  emitStatus: (body: {
    label: string;
    progress?: { step: number; total: number };
    activity?: ActivityStep;
  }) => void;

  /**
   * The per-turn buffer. Tools enqueue project writes here rather than writing
   * directly to Mongo. Buffer.commit() applies them atomically at turn end.
   */
  buffer: TurnBuffer;

  /**
   * Phase at turn start. Tools MUST NOT mutate this directly — phase advance
   * happens through the buffer (proceed_to_next_phase tool enqueues a phase
   * patch; the engine reads committed phase from turn_committed event).
   */
  phase: string;

  /** Session mode. Rarely needed in tool code; exposed for completeness. */
  mode: 'onboarding' | 'in-project';

  /** Project ID if the session is bound to a project (IN_PROJECT; post-create onboarding). */
  projectId?: string;

  /**
   * Flow-scoped secrets submitted out-of-band by the user in response to a
   * collect_secret interactive tool. Tools that need a secret call
   * `consumeFlowSecrets(flowId)` and get back a { field: value } map —
   * secrets are cleared after consumption and NEVER persisted to message
   * history (spec R1-6).
   */
  consumeFlowSecrets: (flowId: string) => Record<string, string> | undefined;

  /**
   * Opaque service bag populated by the production TurnEngine factory
   * in apps/studio. Carries Mongoose models, service singletons, and
   * other external dependencies that internal tools need.
   *
   * Tools read services by key and cast to the expected shape:
   *   const ProjectAgent = ctx.services?.ProjectAgent as Model<IProjectAgent>;
   *
   * Tests inject a minimal bag with only the services the tool under
   * test actually touches — this keeps unit tests decoupled from the
   * full Mongoose/studio service graph.
   *
   * The original migration notes lived in the legacy Arch package.
   * The production factory must still provide the full service list
   * expected by internal tools.
   */
  services?: Record<string, unknown>;
}
