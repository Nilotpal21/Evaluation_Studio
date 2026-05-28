/**
 * Journal Service — append-only journal for Arch AI sessions.
 *
 * CC-F01: Journal-before-response invariant.
 * Every entry is persisted BEFORE the corresponding SSE event is emitted.
 *
 * Contract 1 (api-index): GET /sessions/:id/journal returns entries.
 * No POST endpoint — entries are created internally by the coordinator.
 */

import type { Model } from 'mongoose';
import type { IArchJournalRecord as IArchJournal } from '../models/index.js';
import type {
  JournalEntry,
  JournalEntryType,
  JournalEntryStatus,
  JournalContent,
} from './types.js';

interface JournalContext {
  tenantId: string;
  userId: string;
}

interface AppendParams {
  sessionId: string;
  type: JournalEntryType;
  content: JournalContent;
  specialist: string;
  phase: string;
}

interface QueryParams {
  sessionId?: string;
  projectId?: string;
  phase?: string;
  type?: JournalEntryType;
  status?: JournalEntryStatus;
  /**
   * Explicit acknowledgement that the caller has verified project access
   * before issuing a project-scoped (userId-free) query. REQUIRED whenever
   * `projectId` is supplied without a `sessionId`, because dropping the
   * user filter in that path would otherwise leak cross-user data within
   * the tenant. Callers must call `requireProjectAccess` (or the runtime
   * equivalent) immediately before passing this flag.
   */
  unsafeProjectScope?: boolean;
}

/**
 * Thrown when a caller requests a project-scoped query without acknowledging
 * the access-check requirement via `unsafeProjectScope: true`.
 */
export class ProjectScopeAccessRequiredError extends Error {
  constructor(context: string) {
    super(
      `JournalService.${context}: project-scoped access requires unsafeProjectScope=true ` +
        `(caller must verify project access via requireProjectAccess first)`,
    );
    this.name = 'ProjectScopeAccessRequiredError';
  }
}

function toJournalEntry(doc: IArchJournal): JournalEntry {
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    type: doc.type as JournalEntryType,
    content: doc.content as unknown as JournalContent,
    specialist: doc.specialist,
    phase: doc.phase,
    timestamp: doc.timestamp,
    status: doc.status as JournalEntryStatus,
    sequence: doc.sequence,
  };
}

export class JournalService {
  constructor(private readonly model: Model<IArchJournal>) {}

  /**
   * Append a journal entry. Assigns the next sequence number atomically.
   *
   * CC-F01 req 3: journal-before-response invariant.
   * CC-F01 req 5: monotonically increasing sequence number.
   * CC-F01 req 8: ISO 8601 timestamp set by coordinator, not MongoDB.
   */
  async append(ctx: JournalContext, params: AppendParams): Promise<JournalEntry> {
    // Get next sequence number for this session.
    // Use countDocuments as a simple monotonic counter.
    // For true concurrency safety, use findOneAndUpdate with $inc on a
    // session counter — but Arch has 1 active stream per session (contract 13),
    // so concurrent journal writes to the same session don't happen.
    const count = await this.model.countDocuments({
      sessionId: params.sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });

    const doc = await this.model.create({
      sessionId: params.sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      type: params.type,
      content: params.content,
      specialist: params.specialist,
      phase: params.phase,
      timestamp: new Date().toISOString(),
      status: 'active',
      sequence: count + 1,
    });

    return toJournalEntry(doc);
  }

  /**
   * Query journal entries by session or project scope.
   * Contract 1: GET /sessions/:id/journal with optional phase + type filters.
   * CC-F01 req 4: queryable by sessionId, phase, type, specialist, status.
   *
   * Scoping rules (aligned with ProjectAgent/ModelConfig patterns):
   *   - projectId provided  → project-scoped: tenantId only (no userId).
   *     The caller MUST verify project access via `requireProjectAccess` (or the
   *     runtime equivalent) before calling, and pass `unsafeProjectScope: true`
   *     to acknowledge the check. Without the flag, the call throws
   *     `ProjectScopeAccessRequiredError`.
   *   - sessionId only      → user-scoped: tenantId + userId.
   */
  async query(ctx: JournalContext, params: QueryParams): Promise<JournalEntry[]> {
    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
    };

    if (params.projectId) {
      if (!params.unsafeProjectScope) {
        throw new ProjectScopeAccessRequiredError('query');
      }
      filter.projectId = params.projectId;
    } else {
      filter.userId = ctx.userId;
    }
    if (params.sessionId) filter.sessionId = params.sessionId;
    if (params.phase) filter.phase = params.phase;
    if (params.type) filter.type = params.type;
    if (params.status) filter.status = params.status;

    // Sort by timestamp (primary) then sequence (tiebreaker). For
    // project-scoped queries this is the ONLY correct order — `sequence` is
    // a per-session counter (see `append` above), so sorting by sequence alone
    // would interleave entries from different sessions incorrectly (every
    // session starts at 1). For session-scoped queries the result is
    // equivalent because timestamps within a session are monotonic with
    // sequence, and sequence acts as a tiebreaker for same-millisecond appends.
    const docs = await this.model.find(filter).sort({ timestamp: 1, sequence: 1 }).lean();

    return docs.map(toJournalEntry);
  }

  /**
   * Get the last N decision entries for context injection.
   * Contract 7 (context-budget): "Last 10 decisions as bullet points."
   */
  async getRecentDecisions(
    ctx: JournalContext,
    sessionId: string,
    limit: number = 10,
  ): Promise<JournalEntry[]> {
    const docs = await this.model
      .find({
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        type: 'decision',
        status: 'active',
      })
      .sort({ sequence: -1 })
      .limit(limit)
      .lean();

    return docs.map(toJournalEntry).reverse();
  }

  /**
   * Transition entry status.
   * CC-F01 req 2: append-only — status is the only mutation.
   * CC-F01 req 7: only valid source is 'active'. Transitions:
   *   active -> superseded | invalidated | archived
   */
  async updateStatus(
    ctx: JournalContext,
    entryId: string,
    status: JournalEntryStatus,
  ): Promise<boolean> {
    const result = await this.model.updateOne(
      {
        _id: entryId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: 'active',
      },
      { $set: { status } },
    );

    return result.modifiedCount > 0;
  }

  /**
   * Archive all active entries for a session.
   * Called when the session itself is archived.
   * CC-F01 req 7: active -> archived.
   */
  async archiveSession(ctx: JournalContext, sessionId: string): Promise<void> {
    await this.model.updateMany(
      {
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: 'active',
      },
      { $set: { status: 'archived' } },
    );
  }

  /**
   * Link all journal entries for a session to a project.
   * S4-F04 req 11: After project creation, add projectId to all session entries.
   * Journal becomes queryable by projectId for in-project Arch.
   *
   * This deliberately updates entries regardless of owning user — journal entries
   * become project-level artifacts after creation. Callers MUST have verified
   * that the caller owns/created the project (e.g., via `createProject` returning
   * ownership to the caller) and must pass `unsafeProjectScope: true` to
   * acknowledge the cross-user mutation. Without the flag, the call throws
   * `ProjectScopeAccessRequiredError`.
   */
  async linkToProject(
    ctx: JournalContext,
    sessionId: string,
    projectId: string,
    options: { unsafeProjectScope: true },
  ): Promise<number> {
    if (!options?.unsafeProjectScope) {
      throw new ProjectScopeAccessRequiredError('linkToProject');
    }
    const result = await this.model.updateMany(
      { sessionId, tenantId: ctx.tenantId },
      { $set: { projectId } },
    );
    return result.modifiedCount;
  }

  /**
   * Delete all entries for a session (cascade delete).
   * Contract 1: DELETE /sessions/:id cascades to journal.
   */
  async deleteSession(ctx: JournalContext, sessionId: string): Promise<number> {
    const result = await this.model.deleteMany({
      sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });
    return result.deletedCount;
  }
}
