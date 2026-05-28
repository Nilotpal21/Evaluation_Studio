/**
 * Arch AI v2 session shape.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §6.1.
 *
 * v1 sessions (`packages/database/src/models/arch-session.model.ts`) nest mode/projectId/
 * pendingMutation under `metadata.*`. v2 adds new TOP-LEVEL fields alongside — the Mongoose
 * schema update in Phase 2 is purely additive, so both shapes coexist during cutover.
 *
 * v1 session docs are identified by the ABSENCE of a `schemaVersion` field (or
 * explicit `schemaVersion: 1`). v2 docs always carry `schemaVersion: 2`.
 */

import type { ArchContentBlock } from './content-blocks.js';

// ─── StoredMessage (v2 — extends v1 with streamedPresentation) ───────────

/**
 * Streamed presentation captured at turn_committed for high-fidelity reconnect.
 * Everything a returning user should see reconstructed without event replay
 * (spec §8 stateless reconnect).
 *
 * Size-capped via ARCH_AI_TURN.MAX_STREAMED_PRESENTATION_BYTES — implementations
 * should truncate `thinking` and stringified `activityGroups` to fit.
 */
export interface StreamedPresentation {
  specialist?: string;
  /** Grouped status/activity breadcrumbs. Shape owned by consumers; opaque at the type level. */
  activityGroups?: unknown[];
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: unknown;
    result?: unknown;
    /** Populated when the engine injected a synthetic error for LLM self-correction (§5.7). */
    syntheticResult?: unknown;
  }>;
}

export interface StoredMessageV2 {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string | ArchContentBlock[];
  /** Unix ms epoch — note v1 uses string ISO; v2 uses number for consistency with TurnEvent.timestamp. */
  createdAt: number;
  streamedPresentation?: StreamedPresentation;
}

// ─── Session lock + queue state (top-level additions in v2) ──────────────

/**
 * Active-turn lock mirror. The authoritative lock lives in Redis (key
 * `arch:session:${id}:turn_lock`) — this DB field is a projection for the
 * reconciler to detect orphans when the Redis lock expires without renewal.
 */
export interface ActiveTurnLock {
  workerId: string;
  fencingToken: number;
  acquiredAt: number;
  renewedAt: number;
}

/**
 * Server-owned queued message (spec §7.1, decision D-5). Survives tab close;
 * replaced on overwrite; cleared on auto-flush at turn commit or explicit DELETE.
 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: Array<{ fileId: string }>;
  stagedAt: number;
  clientMessageId: string;
}

/**
 * Pending interactive widget awaiting user response. Persisted so reconnect can
 * re-render without waiting for a new SSE event (spec §8).
 */
export interface PendingInteractiveV2 {
  toolCallId: string;
  tool: string;
  kind: 'tool' | 'gate';
  payload: unknown;
  /** Matches TurnEvent envelope's schemaVersion; client validates before rendering. */
  schemaVersion: 2;
  stagedAt: number;
}

/**
 * IN_PROJECT-only cross-turn state (spec §5.8, decision D-8).
 * The ONLY mid-turn allowlisted write in the entire turn engine.
 */
export interface PendingMutationV2 {
  proposalId: string;
  targetAgent: string;
  isNew: boolean;
  before?: string;
  after: string;
  /** Turn that proposed this mutation — used for reconciliation on turn start. */
  turnId: string;
  /** Per-turn repair counter; cleared at turn start. */
  repairBudget: number;
}

/**
 * Build-progress snapshot persisted at each artifact_updated:build commit so
 * mid-BUILD reconnect restores BuildProgressCard without event replay (spec §5.5).
 */
export interface BuildProgressV2 {
  stage: 'initialized' | 'generating' | 'agents_complete' | 'complete';
  /** Keyed by agent name; value shape documented in turn-events.ts AgentBuildState. */
  agentStatuses: Record<string, unknown>;
}

// ─── ArchSession v2 ──────────────────────────────────────────────────────

/**
 * v2 session discriminator. v1 docs lack the `schemaVersion` field entirely.
 */
export const SCHEMA_VERSION_V2 = 2 as const;

/**
 * v2 state enum (LOWERCASE per spec §6.1).
 * v1 used UPPERCASE (IDLE/ACTIVE/GATE_PENDING/COMPLETE/ARCHIVED) — the cutover
 * migration does NOT convert existing v1 state values; it just archives them.
 */
export type SessionStateV2 = 'idle' | 'active' | 'archived';

export interface ArchSessionV2 {
  id: string;
  schemaVersion: typeof SCHEMA_VERSION_V2;
  tenantId: string;
  userId: string;
  mode: 'onboarding' | 'in-project';
  projectId?: string;

  /** Phase is session-local; always 'IN_PROJECT' for mode='in-project'. */
  phase: string;
  state: SessionStateV2;
  createdAt: number;
  lastActiveAt: number;

  // ─── Turn state (transient) ──────────────────────────────────────────
  activeTurnId?: string;
  activeTurnLock?: ActiveTurnLock;

  // ─── Message history (source of truth for reconnect) ─────────────────
  messages: StoredMessageV2[];

  // ─── Pending interaction state ───────────────────────────────────────
  pendingInteractive?: PendingInteractiveV2;
  /** IN_PROJECT only. Allowlisted mid-turn write per D-8. */
  pendingMutation?: PendingMutationV2;

  // ─── Queue (server-owned per D-5) ────────────────────────────────────
  queuedMessage?: QueuedMessage;

  // ─── Metadata (arbitrary session-local extras, kept small) ───────────
  metadata: {
    buildProgress?: BuildProgressV2;
    [key: string]: unknown;
  };

  // ─── Fencing token (monotonic per session) ───────────────────────────
  /**
   * Incremented on every lock acquisition via Redis INCR on
   * `arch:session:${id}:fencing_token`. Every turn.commit() write uses
   * `fencingToken: { $lte: this.fencingToken }` to reject zombie writers.
   */
  fencingToken: number;
}
