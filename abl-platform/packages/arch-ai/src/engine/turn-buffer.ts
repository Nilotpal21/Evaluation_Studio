/**
 * TurnBuffer — accumulates state changes during a turn; commits atomically.
 *
 * Source of truth: docs/superpowers/specs/2026-04-17-arch-ai-orchestration-redesign-design.md §5.3
 * Plan: docs/plans/2026-04-17-arch-ai-orchestration-redesign-impl-plan.md Phase 4.3
 *
 * Design (D-3 atomic commit + D-8 pendingMutation exception):
 *   - Internal tools enqueue project writes via enqueueProjectWrite().
 *   - Messages append via appendMessage().
 *   - Session patches via patchSession().
 *   - commit() wraps ALL of the above in a single withTransaction block,
 *     with explicit tenant/user/fencingToken scoping (no ALS reliance per
 *     CLAUDE.md Studio Route Handler Gotchas).
 *   - pendingMutation (IN_PROJECT only) is the ONLY allowlisted mid-turn
 *     write — written by propose_modification directly via sessionService,
 *     bypassing the buffer. See spec §5.8.
 *
 * Zombie-writer rejection (D-11): every updateOne filter includes
 *   `fencingToken: { $lte: this.fencingToken }`
 * so writes from a worker whose lock was taken over match zero documents
 * and fail silently.
 */

import type { Model, ClientSession } from 'mongoose';
import { uuidv7 } from '@agent-platform/database/mongo';

import { withTransaction } from '@agent-platform/shared/repos';

import type { ProjectWrite } from './turn-context.js';
import type { StoredMessageV2, StreamedPresentation } from '../types/session-v2.js';
import type { StoredToolCall } from '../types/session.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface TurnBufferOptions {
  /** Mongoose model for arch_sessions; required for the session updateOne. */
  ArchSessions: Model<unknown>;

  /** Session identity + scoping context. */
  sessionId: string;
  tenantId: string;
  userId: string;

  /** Issued at lock acquire; gates updateOne so zombie writes match zero docs. */
  fencingToken: number;

  /** Current turn ID — persisted to messages for replay/ordering. */
  turnId: string;

  /** Optional clock for deterministic tests. */
  now?: () => number;
}

export interface TurnCommitResult {
  committed: boolean;
  /** True if the `turn_commits` idempotency insert matched — false if already applied. */
  newCommit: boolean;
  /** For logs: number of session patches written / messages appended / project writes applied. */
  writes: {
    sessionPatched: boolean;
    messagesAppended: number;
    projectWritesApplied: number;
  };
}

export interface BufferedStoredMessage extends StoredMessageV2 {
  timestamp: string;
  specialist?: string;
  phase?: string;
  toolCalls?: StoredToolCall[];
}

// ─── Implementation ──────────────────────────────────────────────────────

export class TurnBuffer {
  private readonly opts: TurnBufferOptions;
  private readonly now: () => number;

  /**
   * Buffered session-level patches. Applied to the ArchSession doc on commit.
   * Tools SHOULD set specific fields (e.g., `phase`, `state`) rather than
   * constructing whole new sub-documents.
   */
  private sessionPatch: Record<string, unknown> = {};

  /** Buffered messages; pushed on commit. */
  private pendingMessages: BufferedStoredMessage[] = [];

  /** Buffered project-level writes (see spec §5.3). */
  private pendingProjectWrites: ProjectWrite[] = [];

  /** Optional suggestions to attach to the final turn_ended envelope. */
  suggestions: string[] = [];

  /** Optional completion metadata (usage, latency) captured by the engine. */
  completionMetadata: Record<string, unknown> | undefined;

  /** True once commit() has successfully applied state to the DB. */
  committed = false;

  /** True once rollback() has been invoked; any further operations no-op. */
  rolledBack = false;

  constructor(opts: TurnBufferOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  // ─── Session-level writes ──────────────────────────────────────────────

  /**
   * Merge the given fields into the pending session patch. Called by the
   * engine and by tools that advance phase / toggle state.
   *
   * Top-level fields only. Nested paths (e.g., 'metadata.phase') should be
   * quoted strings if needed, but we prefer top-level v2 fields.
   */
  patchSession(patch: Record<string, unknown>): void {
    if (this.committed || this.rolledBack) return;
    Object.assign(this.sessionPatch, patch);
  }

  /** Inspect pending session patch (for tests and debugging). */
  get sessionPatchSnapshot(): Readonly<Record<string, unknown>> {
    return { ...this.sessionPatch };
  }

  // ─── Message append ────────────────────────────────────────────────────

  /**
   * Append a message to the buffered messages array. Called by the engine
   * on text_delta accumulation, tool-result commits, and turn boundaries.
   */
  appendMessage(
    role: StoredMessageV2['role'],
    content: StoredMessageV2['content'],
    options?: {
      streamedPresentation?: StreamedPresentation;
      specialist?: string;
      phase?: string;
      timestamp?: string;
      toolCalls?: StoredToolCall[];
    },
  ): BufferedStoredMessage {
    const createdAt = this.now();
    const msg: BufferedStoredMessage = {
      id: uuidv7(),
      turnId: this.opts.turnId,
      role,
      content,
      createdAt,
      timestamp: options?.timestamp ?? new Date(createdAt).toISOString(),
      streamedPresentation: options?.streamedPresentation,
      specialist: options?.specialist,
      phase: options?.phase,
      toolCalls: options?.toolCalls,
    };
    this.pendingMessages.push(msg);
    return msg;
  }

  get pendingMessagesSnapshot(): ReadonlyArray<BufferedStoredMessage> {
    return [...this.pendingMessages];
  }

  // ─── Project writes (D-9 action-discriminated tools) ──────────────────

  /**
   * Enqueue a project-level write (ProjectAgent update, tools config, etc.)
   * to be applied inside the commit transaction. Tools MUST NOT write to
   * Mongo directly — they enqueue and let the buffer commit atomically.
   */
  enqueueProjectWrite(write: ProjectWrite): void {
    if (this.committed || this.rolledBack) {
      throw new Error('TurnBuffer.enqueueProjectWrite: buffer already committed or rolled back');
    }
    this.pendingProjectWrites.push(write);
  }

  get pendingProjectWritesSnapshot(): ReadonlyArray<ProjectWrite> {
    return [...this.pendingProjectWrites];
  }

  // ─── Commit ────────────────────────────────────────────────────────────

  /**
   * Apply all buffered state inside a single MongoDB transaction. Safe to
   * call at most once; subsequent calls throw. Zombie writers match zero
   * documents via the fencingToken filter.
   *
   * Uses the platform-standard withTransaction helper at
   * packages/shared/src/repos/mongo-tx.ts (auto-retries on
   * TransientTransactionError + falls back to no-tx on standalone Mongo).
   */
  async commit(): Promise<TurnCommitResult> {
    if (this.committed) throw new Error('TurnBuffer.commit: already committed');
    if (this.rolledBack) throw new Error('TurnBuffer.commit: buffer has been rolled back');

    const { ArchSessions, sessionId, tenantId, userId, fencingToken, turnId } = this.opts;
    const TurnCommits = ArchSessions.db.collection('turn_commits');

    let newCommit = true;
    let sessionPatched = false;
    let messagesAppended = 0;
    let projectWritesApplied = 0;

    await withTransaction(async (session: ClientSession | null) => {
      // Idempotency: record this turn commit. Duplicate turnIds fail silently
      // and mark newCommit=false so caller knows it was already applied.
      try {
        // Native driver insertOne; cast `_id` to unknown so the ObjectId
        // default-type signature accepts our ULID string (the collection is
        // untyped at the Mongoose level).
        await TurnCommits.insertOne(
          {
            _id: turnId as unknown as never,
            sessionId,
            tenantId,
            userId,
            committedAt: this.now(),
          },
          session ? { session } : {},
        );
      } catch (err) {
        // Duplicate key = already committed; treat as no-op success.
        if (isDuplicateKeyError(err)) {
          newCommit = false;
          return;
        }
        throw err;
      }

      // Apply session patch + message push in ONE updateOne with the
      // fencing-token filter. Zombie workers match zero docs → silent reject.
      // Note: lastActiveAt is now patched at turn start by the engine (gap I10),
      // so it arrives via this.sessionPatch instead of being hardcoded here.
      // Sessions created before fencingToken existed must still commit successfully.
      // The first compatible commit backfills the field to the current token.
      const setFields = { fencingToken, ...this.sessionPatch };
      const hasSetFields = Object.keys(setFields).length > 0;
      const hasMessages = this.pendingMessages.length > 0;

      if (hasSetFields || hasMessages) {
        const update: Record<string, unknown> = {};
        if (hasSetFields) update.$set = setFields;
        if (hasMessages)
          update.$push = { 'metadata.messages': { $each: this.pendingMessages, $slice: -200 } };

        const result = await ArchSessions.updateOne(
          {
            _id: sessionId,
            tenantId,
            userId,
            $or: [{ fencingToken: { $exists: false } }, { fencingToken: { $lte: fencingToken } }],
          },
          update,
          session ? { session } : {},
        );
        // updateOne returns { matchedCount, modifiedCount } in Mongoose 8.
        sessionPatched = result.matchedCount > 0 && hasSetFields;
        messagesAppended = result.matchedCount > 0 ? this.pendingMessages.length : 0;
      }

      // Apply project-level writes inside the same transaction. Callers pass
      // `session` (or null) through to their Mongoose ops.
      for (const pw of this.pendingProjectWrites) {
        await pw.execute(session);
        projectWritesApplied += 1;
      }
    });

    this.committed = true;
    return {
      committed: true,
      newCommit,
      writes: {
        sessionPatched,
        messagesAppended,
        projectWritesApplied,
      },
    };
  }

  /**
   * Discard all buffered state without touching the DB. Safe to call at any
   * point before commit(); marks the buffer as rolled back so subsequent
   * writes throw.
   */
  rollback(): void {
    if (this.committed) {
      throw new Error('TurnBuffer.rollback: already committed');
    }
    this.sessionPatch = {};
    this.pendingMessages = [];
    this.pendingProjectWrites = [];
    this.suggestions = [];
    this.completionMetadata = undefined;
    this.rolledBack = true;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; codeName?: string };
  return e.code === 11000 || e.codeName === 'DuplicateKey';
}
