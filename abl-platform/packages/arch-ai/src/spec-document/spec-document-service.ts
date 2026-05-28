/**
 * Spec Document Service — CRUD + field-level mutations for Arch AI spec documents.
 *
 * Every write returns the new version number via `findOneAndUpdate` with
 * `returnDocument: 'after'`. Business-field writes mirror to the session's
 * `metadata.specification` using a MongoDB transaction (with ordered-sequential
 * fallback for standalone dev).
 *
 * Scoping:
 *   - User-scoped queries include { tenantId, userId } (default).
 *   - Project-scoped queries include { tenantId, projectId } (no userId),
 *     requiring `unsafeProjectScope: true` to acknowledge access-check.
 */

import type { Model, Connection } from 'mongoose';
import type {
  IArchSpecDocumentRecord as IArchSpecDocumentDB,
  IArchSessionRecord as IArchSession,
} from '../models/index.js';
import { createLogger } from '@agent-platform/shared-observability';
import { validateEditablePath, SPEC_TO_SESSION_FIELD_MAP } from './field-map.js';

const log = createLogger('arch-ai:spec-document-service');

// ─── Context ────────────────────────────────────────────────────────────────

interface SpecDocumentContext {
  tenantId: string;
  userId: string;
}

// ─── Error ──────────────────────────────────────────────────────────────────

/**
 * Thrown when a caller requests a project-scoped query without acknowledging
 * the access-check requirement via `unsafeProjectScope: true`.
 */
export class ProjectScopeAccessRequiredError extends Error {
  constructor(context: string) {
    super(
      `SpecDocumentService.${context}: project-scoped access requires unsafeProjectScope=true ` +
        `(caller must verify project access via requireProjectAccess first)`,
    );
    this.name = 'ProjectScopeAccessRequiredError';
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class SpecDocumentService {
  constructor(
    private readonly model: Model<IArchSpecDocumentDB>,
    private readonly sessionModel: Model<IArchSession>,
    private readonly connection: Connection,
  ) {}

  // ── Create ──────────────────────────────────────────────────────────────

  /**
   * Create a spec document for the given session.
   * Idempotent via `findOneAndUpdate` + `upsert: true` keyed on { tenantId, sessionId }.
   * Returns the new version number.
   */
  async create(ctx: SpecDocumentContext, sessionId: string): Promise<number> {
    const doc = await this.model.findOneAndUpdate(
      { tenantId: ctx.tenantId, sessionId },
      {
        $setOnInsert: {
          userId: ctx.userId,
          projectId: null,
          version: 1,
          business: {
            projectName: '',
            objective: null,
            channels: [],
            language: 'English',
            compliance: [],
            constraints: [],
            personas: [],
            slas: [],
            edgeCases: [],
            notes: [],
          },
          architecture: {
            pattern: null,
            entryPoint: null,
            agentCount: 0,
            agents: [],
            edges: [],
            rationale: null,
          },
          implementation: {
            tools: [],
            guardrails: [],
            buildStatus: null,
          },
          decisions: [],
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    return doc!.version;
  }

  // ── Field-level updates ─────────────────────────────────────────────────

  /**
   * Atomic `$set` on a single dot-path + version bump.
   * Returns the new version number.
   */
  async updateField(
    ctx: SpecDocumentContext,
    specId: string,
    path: string,
    value: unknown,
  ): Promise<number> {
    const doc = await this.model.findOneAndUpdate(
      { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId },
      { $set: { [path]: value }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );

    if (!doc) {
      throw new Error(`Spec document not found: ${specId}`);
    }
    return doc.version;
  }

  /**
   * Write a business field to the spec doc AND mirror to `session.metadata.specification`.
   * Uses a MongoDB transaction (falls back to ordered sequential writes for standalone dev).
   * Returns the new version number.
   */
  async updateBusinessField(
    ctx: SpecDocumentContext,
    specId: string,
    sessionId: string,
    path: string,
    value: unknown,
    sessionFieldName: string,
  ): Promise<number> {
    const specFilter = { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId };
    const specUpdate = { $set: { [path]: value }, $inc: { version: 1 } };
    const sessionFilter = { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId };
    const sessionUpdate = { $set: { [`metadata.specification.${sessionFieldName}`]: value } };

    try {
      return await this.withTransaction(async (session) => {
        const doc = await this.model.findOneAndUpdate(specFilter, specUpdate, {
          returnDocument: 'after',
          session,
        });
        if (!doc) {
          throw new Error(`Spec document not found: ${specId}`);
        }
        await this.sessionModel.updateOne(sessionFilter, sessionUpdate, { session });
        return doc.version;
      });
    } catch (txErr) {
      const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
      if (this.isTransactionUnsupported(txMsg)) {
        log.warn('Transaction not supported, falling back to sequential writes', {
          specId,
          sessionId,
          path,
        });
        const doc = await this.model.findOneAndUpdate(specFilter, specUpdate, {
          returnDocument: 'after',
        });
        if (!doc) {
          throw new Error(`Spec document not found: ${specId}`);
        }
        await this.sessionModel.updateOne(sessionFilter, sessionUpdate);
        return doc.version;
      }
      throw txErr;
    }
  }

  // ── Array operations ────────────────────────────────────────────────────

  /**
   * Atomic `$push` to an array path + version bump.
   * Returns the new version number.
   */
  async addEntry(
    ctx: SpecDocumentContext,
    specId: string,
    path: string,
    entry: unknown,
  ): Promise<number> {
    const doc = await this.model.findOneAndUpdate(
      { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId },
      { $push: { [path]: entry }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );

    if (!doc) {
      throw new Error(`Spec document not found: ${specId}`);
    }
    return doc.version;
  }

  /**
   * Upsert an agent summary in `architecture.agents`.
   * Uses `arrayFilters` to update existing agent by name; falls back to `$push`
   * if the agent does not exist.
   * Returns the new version number.
   */
  async upsertAgentSummary(
    ctx: SpecDocumentContext,
    specId: string,
    agentName: string,
    patch: Record<string, unknown>,
  ): Promise<number> {
    // Build $set paths targeting the matched array element
    const setFields: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(patch)) {
      setFields[`architecture.agents.$[elem].${key}`] = val;
    }

    const result = await this.model.updateOne(
      { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId },
      { $set: setFields, $inc: { version: 1 } },
      { arrayFilters: [{ 'elem.name': agentName }] },
    );

    if (result.modifiedCount > 0) {
      const doc = await this.model.findOne({
        _id: specId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      });
      return doc!.version;
    }

    // Agent does not exist — push new entry
    const newAgent = { name: agentName, ...patch };
    const doc = await this.model.findOneAndUpdate(
      { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId },
      { $push: { 'architecture.agents': newAgent }, $inc: { version: 1 } },
      { returnDocument: 'after' },
    );

    if (!doc) {
      throw new Error(`Spec document not found: ${specId}`);
    }
    return doc.version;
  }

  /**
   * Replace all tools and guardrails for a specific agent.
   * Pull existing entries for the agent, then push the new set.
   * Single version bump.
   * Returns the new version number.
   */
  async syncAgentDerivedData(
    ctx: SpecDocumentContext,
    specId: string,
    agentName: string,
    data: {
      tools?: Array<Record<string, unknown>>;
      guardrails?: Array<Record<string, unknown>>;
    },
  ): Promise<number> {
    const filter = { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId };

    // Step 1: Pull existing entries for this agent
    const pullOps: Record<string, unknown> = {};
    if (data.tools) {
      pullOps['implementation.tools'] = { agent: agentName };
    }
    if (data.guardrails) {
      pullOps['implementation.guardrails'] = { agent: agentName };
    }
    if (Object.keys(pullOps).length > 0) {
      await this.model.updateOne(filter, { $pull: pullOps });
    }

    // Step 2: Push new entries + version bump
    const pushOps: Record<string, unknown> = {};
    if (data.tools && data.tools.length > 0) {
      pushOps['implementation.tools'] = { $each: data.tools };
    }
    if (data.guardrails && data.guardrails.length > 0) {
      pushOps['implementation.guardrails'] = { $each: data.guardrails };
    }

    const update: Record<string, unknown> = { $inc: { version: 1 } };
    if (Object.keys(pushOps).length > 0) {
      update.$push = pushOps;
    }

    const doc = await this.model.findOneAndUpdate(filter, update, {
      returnDocument: 'after',
    });

    if (!doc) {
      throw new Error(`Spec document not found: ${specId}`);
    }
    return doc.version;
  }

  // ── Decision convenience ────────────────────────────────────────────────

  /**
   * Add a decision entry. Delegates to `addEntry('decisions', decision)`.
   */
  async addDecision(
    ctx: SpecDocumentContext,
    specId: string,
    decision: Record<string, unknown>,
  ): Promise<number> {
    return this.addEntry(ctx, specId, 'decisions', decision);
  }

  // ── Bulk business update ────────────────────────────────────────────────

  /**
   * Validate all paths, build `$set` for both spec doc and session metadata,
   * and apply in a transaction (with sequential fallback).
   * Returns the full updated `IArchSpecDocumentDB` for authoritative reconciliation.
   */
  async bulkUpdateBusiness(
    ctx: SpecDocumentContext,
    specId: string,
    sessionId: string,
    updates: Array<{ path: string; value: unknown }>,
  ): Promise<IArchSpecDocumentDB> {
    // Validate all paths first — fail fast before any writes
    for (const { path } of updates) {
      validateEditablePath(path);
    }

    const specSet: Record<string, unknown> = {};
    const sessionSet: Record<string, unknown> = {};

    for (const { path, value } of updates) {
      specSet[path] = value;
      const sessionField = SPEC_TO_SESSION_FIELD_MAP[path];
      if (sessionField) {
        sessionSet[`metadata.specification.${sessionField}`] = value;
      }
    }

    const specFilter = { _id: specId, tenantId: ctx.tenantId, userId: ctx.userId };
    const specUpdate = { $set: specSet, $inc: { version: 1 } };
    const sessionFilter = { _id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId };

    const hasSessionUpdates = Object.keys(sessionSet).length > 0;

    try {
      return await this.withTransaction(async (session) => {
        const doc = await this.model.findOneAndUpdate(specFilter, specUpdate, {
          returnDocument: 'after',
          session,
        });
        if (!doc) {
          throw new Error(`Spec document not found: ${specId}`);
        }
        if (hasSessionUpdates) {
          await this.sessionModel.updateOne(sessionFilter, { $set: sessionSet }, { session });
        }
        return doc;
      });
    } catch (txErr) {
      const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
      if (this.isTransactionUnsupported(txMsg)) {
        log.warn('Transaction not supported, falling back to sequential writes (bulk)', {
          specId,
          sessionId,
          updateCount: updates.length,
        });
        const doc = await this.model.findOneAndUpdate(specFilter, specUpdate, {
          returnDocument: 'after',
        });
        if (!doc) {
          throw new Error(`Spec document not found: ${specId}`);
        }
        if (hasSessionUpdates) {
          await this.sessionModel.updateOne(sessionFilter, { $set: sessionSet });
        }
        return doc;
      }
      throw txErr;
    }
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  /**
   * Find the spec document for a given session. User-scoped.
   * Returns `null` if not found.
   */
  async getBySession(
    ctx: SpecDocumentContext,
    sessionId: string,
  ): Promise<IArchSpecDocumentDB | null> {
    return this.model
      .findOne({
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
      })
      .lean();
  }

  /**
   * Find the spec document for a given project. Project-scoped (no userId filter).
   * Requires `unsafeProjectScope: true` — caller must have verified project access.
   * Returns `null` if not found.
   */
  async getByProject(
    ctx: SpecDocumentContext,
    projectId: string,
    options: { unsafeProjectScope: true },
  ): Promise<IArchSpecDocumentDB | null> {
    if (!options?.unsafeProjectScope) {
      throw new ProjectScopeAccessRequiredError('getByProject');
    }
    return this.model
      .findOne({
        projectId,
        tenantId: ctx.tenantId,
      })
      .lean();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Link a spec document to a project. Idempotent.
   * Returns the new version number.
   */
  async linkToProject(
    ctx: SpecDocumentContext,
    sessionId: string,
    projectId: string,
  ): Promise<number> {
    const doc = await this.model.findOneAndUpdate(
      { sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      { $set: { projectId } },
      { returnDocument: 'after' },
    );

    if (!doc) {
      throw new Error(`Spec document not found for session: ${sessionId}`);
    }
    return doc.version;
  }

  /**
   * Delete a spec document only if it is NOT linked to a project.
   * Returns `true` if a document was deleted, `false` otherwise.
   */
  async deleteBySessionIfUnlinked(ctx: SpecDocumentContext, sessionId: string): Promise<boolean> {
    const result = await this.model.deleteOne({
      sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      projectId: null,
    });
    return result.deletedCount > 0;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Execute a callback within a MongoDB transaction.
   * The caller is responsible for catching transaction-unsupported errors
   * and falling back to sequential writes.
   */
  private async withTransaction<T>(
    fn: (session: import('mongoose').ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Check if an error message indicates that transactions are not supported
   * (standalone MongoDB without replica set — common in dev environments).
   */
  private isTransactionUnsupported(message: string): boolean {
    return (
      message.includes('Transaction numbers') ||
      message.includes('transaction') ||
      message.includes('replica set')
    );
  }
}
