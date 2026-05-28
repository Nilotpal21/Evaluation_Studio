/**
 * Session State Repository
 *
 * CRUD operations for the durable session_states collection (MongoDB cold store).
 * Used by TieredSessionStore for write-through persistence and cold restore
 * when Redis sessions expire.
 */

import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { createLogger } from '@abl/compiler/platform';
import { scrubSecrets } from '@abl/compiler';
import type { ConversationMessage, SessionData, AgentThreadData } from './types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const log = createLogger('session-state-repo');

// Lazy model import — avoids circular dependency with database package at module load time
let _SessionState: any = null;
async function getModel() {
  if (!_SessionState) {
    const { SessionState } = await import('@agent-platform/database/models');
    _SessionState = SessionState;
  }
  return _SessionState;
}

/** Compress a JSON-serializable value to a gzipped Buffer */
async function compressJson(value: unknown): Promise<Buffer> {
  return gzipAsync(Buffer.from(JSON.stringify(value)));
}

/** Decompress a gzipped Buffer back to a parsed JSON value.
 *  Also handles the case where the encryption plugin has decrypted the field
 *  to a JSON-serialized Buffer string (e.g. '{"type":"Buffer","data":[31,139,...]}').
 *
 *  The decrypted string can arrive as a raw string or, because Mongoose
 *  schema-casts string assignments on Buffer-typed paths to utf8-encoded
 *  Buffers, as a Buffer whose bytes are that same JSON text. Detect both.
 */
async function decompressJson<T>(input: Buffer | string): Promise<T> {
  let buf: Buffer;
  if (typeof input === 'string') {
    // Encryption plugin decrypted a Buffer field → JSON.stringify(Buffer) → '{"type":"Buffer","data":[...]}'
    const parsed = JSON.parse(input);
    buf = Buffer.from(parsed.data);
  } else if (input.length > 0 && input[0] === 0x7b /* '{' */) {
    // Mongoose schema-cast the decrypted JSON-stringified-Buffer back into a
    // utf8 Buffer. Detect via the leading '{' and rewrap via the same path.
    try {
      const parsed = JSON.parse(input.toString('utf8'));
      buf =
        parsed && parsed.type === 'Buffer' && Array.isArray(parsed.data)
          ? Buffer.from(parsed.data)
          : input;
    } catch {
      buf = input;
    }
  } else {
    buf = input;
  }
  const decompressed = await gunzipAsync(buf);
  return JSON.parse(decompressed.toString());
}

/**
 * Rebuild session-level conversationHistory by merging thread histories in
 * thread-stack order (parent threads first, active thread last).
 * This ensures cross-thread history is preserved on cold restore.
 */
function buildMergedConversationHistory(
  threads: AgentThreadData[],
  threadStack: number[],
  activeThreadIndex: number,
): ConversationMessage[] {
  // Invariant: every live thread index is either in threadStack or equals activeThreadIndex.
  // Threads that were fully completed and discarded are not tracked in the stack, so they
  // are intentionally excluded here (their history is already part of parent thread context).
  const orderedIndices = [...threadStack, activeThreadIndex];
  const seen = new Set<number>();
  const merged: ConversationMessage[] = [];

  for (const idx of orderedIndices) {
    if (seen.has(idx)) continue;
    seen.add(idx);
    const thread = threads[idx];
    if (thread?.conversationHistory) {
      merged.push(...thread.conversationHistory);
    }
  }

  return merged;
}

// =============================================================================
// REPOSITORY
// =============================================================================

export class SessionStateRepo {
  private coldTtlDays: number;

  constructor(options?: { coldTtlDays?: number }) {
    this.coldTtlDays = options?.coldTtlDays ?? 7;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private resolveStoredChannel(session: SessionData): string | null {
    if (typeof session.callerContext?.channel === 'string' && session.callerContext.channel) {
      return session.callerContext.channel;
    }

    const sessionNamespace =
      session.dataValues?.session &&
      typeof session.dataValues.session === 'object' &&
      !Array.isArray(session.dataValues.session)
        ? (session.dataValues.session as Record<string, unknown>)
        : null;

    const channel = typeof sessionNamespace?.channel === 'string' ? sessionNamespace.channel : null;
    if (channel === 'debug_websocket') {
      return 'web_debug';
    }

    return channel;
  }

  private resolveStoredUserId(session: SessionData): string | null {
    return session.userId ?? session.callerContext?.initiatedById ?? null;
  }

  private buildScopedQuery(params: {
    sessionId: string;
    tenantId: string;
    projectId?: string;
  }): Record<string, string> {
    const query: Record<string, string> = {
      _id: params.sessionId,
      tenantId: params.tenantId,
    };

    if (params.projectId) {
      query.projectId = params.projectId;
    }

    return query;
  }

  /**
   * Upsert a session snapshot to cold storage.
   * Called fire-and-forget after each Redis write.
   */
  async upsert(session: SessionData): Promise<void> {
    if (!session.tenantId) {
      throw new Error(`tenantId is required for cold storage upsert (sessionId=${session.id})`);
    }
    const SessionState = await getModel();
    const tenantId = session.tenantId;
    const projectId = session.projectId || '';
    const userId = this.resolveStoredUserId(session);
    const channel = this.resolveStoredChannel(session);

    // Build per-thread snapshots
    const threads = await Promise.all(
      session.threads.map(async (t: AgentThreadData, i: number) => ({
        threadId: `thread-${i}`,
        agentName: t.agentName,
        status: t.status,
        irSourceHash: t.irSourceHash || '',
        handoffFrom: t.handoffFrom,
        dataValues: await compressJson(t.dataValues),
        gatheredKeys: t.dataGatheredKeys,
        state: await compressJson(t.state),
        conversationHistory: await compressJson(t.conversationHistory),
        threadMetadata: await compressJson({
          startedAt: t.startedAt,
          endedAt: t.endedAt,
          handoffContext: t.handoffContext,
          returnExpected: t.returnExpected,
          currentFlowStep: t.currentFlowStep,
          waitingForInput: t.waitingForInput,
          pendingResponse: t.pendingResponse,
          pendingRichContent: t.pendingRichContent,
          pendingVoiceConfig: t.pendingVoiceConfig,
          pendingActions: t.pendingActions,
          pendingAwaitAttachment: t.pendingAwaitAttachment,
        }),
      })),
    );

    // Build stateData — everything except conversation and per-thread data
    const stateData = await compressJson({
      dataValues: session.dataValues,
      dataGatheredKeys: session.dataGatheredKeys,
      executionTreeValues: session.executionTreeValues,
      state: session.state,
      handoffStack: session.handoffStack,
      delegateStack: session.delegateStack,
      handoffReturnInfo: session.handoffReturnInfo,
      isComplete: session.isComplete,
      isEscalated: session.isEscalated,
      transferInitiated: session.transferInitiated,
      escalationReason: session.escalationReason,
      recentTransferEndedAt: session.recentTransferEndedAt,
      currentFlowStep: session.currentFlowStep,
      waitingForInput: session.waitingForInput,
      pendingResponse: session.pendingResponse,
      pendingRichContent: session.pendingRichContent,
      pendingVoiceConfig: session.pendingVoiceConfig,
      pendingActions: session.pendingActions,
      permissions: session.permissions,
      initialized: session.initialized,
      callerContext: session.callerContext,
      executionScopeKind: session.executionScopeKind,
      environment: session.environment,
      agentVersions: session.agentVersions,
      deploymentId: session.deploymentId,
      maxAgeSeconds: session.maxAgeSeconds,
      idleSeconds: session.idleSeconds,
      customDimensions: session.customDimensions,
      backtrackCounts: session.backtrackCounts,
      constraintCollectState: session.constraintCollectState,
      // ── Cold-store parity fields ──────────────────────────────────────────
      piiVaultData: session.piiVaultData,
      piiRedactionConfig: session.piiRedactionConfig,
      gatherFieldsCollected: session.gatherFieldsCollected,
      agentRawVersions: session.agentRawVersions,
      moduleProvenance: session.moduleProvenance,
      compilationHash: session.compilationHash,
      // originalCreatedAt: preserve the true session start time (doc.createdAt is upsert time)
      originalCreatedAt: session.createdAt,
    });

    // Build resolution keys from caller context
    const resolutionKeys: Array<{
      channelId: string;
      artifactHash: string;
      ttlSeconds: number;
    }> = [];
    const ctx = session.callerContext;
    if (ctx?.channelArtifact && ctx?.channelId) {
      resolutionKeys.push({
        channelId: ctx.channelId,
        artifactHash: ctx.channelArtifact,
        ttlSeconds: this.coldTtlDays * 86400,
      });
    }

    const expiresAt = new Date(Date.now() + this.coldTtlDays * 86400 * 1000);

    // Use findOne + save() instead of updateOne() so Mongoose middleware fires
    // (the encryption plugin hooks pre('save') for field-level encryption).
    let doc = await SessionState.findOne({ _id: session.id, tenantId });
    const isNew = !doc;
    if (isNew) {
      doc = new SessionState({ _id: session.id, tenantId });
    }

    doc.projectId = projectId;
    doc.userId = userId;
    doc.channel = channel;
    doc.agentName = session.agentName;
    doc.version = session.version;
    doc.stateData = stateData;
    doc.threads = threads;
    doc.activeThreadId = `thread-${session.activeThreadIndex}`;
    doc.threadStack = session.threadStack.map((idx: number) => `thread-${idx}`);
    doc.headSeq = 0; // seq tracking deferred until message_log is added
    doc.lastCompactionSeq = -1;
    doc.pendingAsyncTasks = [];
    doc.resolutionKeys = resolutionKeys;
    doc.encryptedFields = [];
    doc.expiresAt = expiresAt;
    doc.lastActivityAt = new Date(session.lastActivityAt);

    log.debug('[MONGO] upsert session_states', {
      sessionId: session.id,
      agentName: session.agentName,
      tenantId,
      projectId,
      isNew,
      version: session.version,
      threadCount: threads.length,
      expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt),
    });

    await doc.save();
  }

  async findLatestOwnedSessionSummaries(params: {
    tenantId: string;
    projectId: string;
    userId: string;
    channel?: string;
    agentName?: string;
    limit?: number;
  }): Promise<
    Array<{
      id: string;
      tenantId: string;
      projectId: string;
      userId: string | null;
      channel: string | null;
      agentName: string;
      lastActivityAt: Date;
      createdAt: Date;
    }>
  > {
    const SessionState = await getModel();
    const limit = Math.max(1, Math.min(params.limit ?? 5, 20));

    const filter: Record<string, unknown> = {
      tenantId: params.tenantId,
      projectId: params.projectId,
      userId: params.userId,
    };

    if (params.channel) {
      // Include legacy documents where channel was not denormalized yet.
      filter.channel = { $in: [params.channel, null] };
    }

    if (params.agentName) {
      filter.agentName = {
        $regex: this.escapeRegex(params.agentName),
        $options: 'i',
      };
    }

    const docs = (await SessionState.find(filter, {
      _id: 1,
      tenantId: 1,
      projectId: 1,
      userId: 1,
      channel: 1,
      agentName: 1,
      lastActivityAt: 1,
      createdAt: 1,
    })
      .sort({ lastActivityAt: -1 })
      .limit(limit)
      .lean()) as Array<{
      _id?: string;
      tenantId?: string;
      projectId?: string;
      userId?: string | null;
      channel?: string | null;
      agentName?: string;
      lastActivityAt?: Date;
      createdAt?: Date;
    }>;

    const summaries: Array<{
      id: string;
      tenantId: string;
      projectId: string;
      userId: string | null;
      channel: string | null;
      agentName: string;
      lastActivityAt: Date;
      createdAt: Date;
    }> = [];

    for (const doc of docs) {
      if (
        typeof doc._id !== 'string' ||
        typeof doc.tenantId !== 'string' ||
        typeof doc.projectId !== 'string' ||
        typeof doc.agentName !== 'string' ||
        !(doc.lastActivityAt instanceof Date) ||
        !(doc.createdAt instanceof Date)
      ) {
        continue;
      }

      summaries.push({
        id: doc._id,
        tenantId: doc.tenantId,
        projectId: doc.projectId,
        userId: doc.userId ?? null,
        channel: doc.channel ?? null,
        agentName: doc.agentName,
        lastActivityAt: doc.lastActivityAt,
        createdAt: doc.createdAt,
      });
    }

    return summaries;
  }

  /**
   * Load a session snapshot from cold storage.
   * tenantId is required for tenant isolation (never uses findById without scoping).
   */
  async load(sessionId: string, tenantId: string, projectId?: string): Promise<SessionData | null> {
    if (!tenantId) {
      throw new Error(`tenantId is required for cold storage load (sessionId=${sessionId})`);
    }
    const SessionState = await getModel();
    // Do NOT use .lean() — the encryption plugin's post('findOne') hook must fire
    // to decrypt stateData/irData/compilationData before we decompress them.
    const doc = await SessionState.findOne(
      this.buildScopedQuery({ sessionId, tenantId, projectId }),
    );
    if (!doc) {
      const query = this.buildScopedQuery({ sessionId, tenantId, projectId });
      log.debug('[COLD-LOAD] doc not found in session_states', {
        sessionId,
        tenantId,
        projectId: projectId ?? null,
        queryKeys: JSON.stringify(Object.keys(query)),
      });
      return null;
    }

    log.debug('[COLD-LOAD] doc found, decrypting+decompressing', {
      sessionId,
      version: doc.version,
      expiresAt:
        doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : String(doc.expiresAt),
    });
    try {
      return await this.docToSessionData(doc);
    } catch (err) {
      log.error('failed to decompress cold session', {
        sessionId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Lightweight version read for stale detection.
   * Uses a projection query (no full document load).
   */
  async getVersion(
    sessionId: string,
    tenantId: string,
    projectId?: string,
  ): Promise<number | null> {
    if (!tenantId) {
      throw new Error(`tenantId is required for cold storage getVersion (sessionId=${sessionId})`);
    }
    const SessionState = await getModel();
    const doc = await SessionState.findOne(
      this.buildScopedQuery({ sessionId, tenantId, projectId }),
      { version: 1 },
    ).lean();
    return doc ? (doc.version ?? null) : null;
  }

  /**
   * Delete a session state from cold storage.
   * tenantId is required for tenant isolation.
   */
  async delete(sessionId: string, tenantId: string, projectId?: string): Promise<void> {
    if (!tenantId) {
      throw new Error(`tenantId is required for cold storage delete (sessionId=${sessionId})`);
    }
    const SessionState = await getModel();
    await SessionState.deleteOne(this.buildScopedQuery({ sessionId, tenantId, projectId }));
  }

  /**
   * Touch — refresh the expiresAt to extend cold TTL.
   * tenantId is required for tenant isolation.
   */
  async touch(
    sessionId: string,
    tenantId: string,
    projectId?: string,
    lastActivityAt?: Date,
  ): Promise<void> {
    if (!tenantId) {
      throw new Error(`tenantId is required for cold storage touch (sessionId=${sessionId})`);
    }
    const SessionState = await getModel();
    const expiresAt = new Date(Date.now() + this.coldTtlDays * 86400 * 1000);
    await SessionState.updateOne(this.buildScopedQuery({ sessionId, tenantId, projectId }), {
      $set: { expiresAt, lastActivityAt: lastActivityAt ?? new Date() },
    });
  }

  /**
   * Resolve a session ID by channel artifact hash (for session resumption).
   */
  async resolveByArtifact(tenantId: string, artifactHash: string): Promise<string | null> {
    const SessionState = await getModel();
    const doc = await SessionState.findOne(
      {
        tenantId,
        'resolutionKeys.artifactHash': artifactHash,
      },
      { _id: 1 },
    ).lean();
    return doc ? doc._id : null;
  }

  // =========================================================================
  // INTERNAL — unscoped methods for system-level operations only
  // =========================================================================

  /**
   * Internal unscoped cold storage load — used ONLY by TieredSessionStore for cold
   * fallback when the Redis reverse-lookup key has expired and tenantId is unavailable.
   * The returned SessionData always contains tenantId for downstream isolation checks.
   * NEVER call from request-scoped code paths.
   */
  async loadInternal(sessionId: string): Promise<SessionData | null> {
    const SessionState = await getModel();
    const doc = await SessionState.findOne({ _id: sessionId });
    if (!doc) {
      log.debug('[COLD-LOAD] loadInternal: not in session_states', { sessionId });
      return null;
    }
    log.debug('[COLD-LOAD] loadInternal: doc found', {
      sessionId,
      version: doc.version,
      expiresAt:
        doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : String(doc.expiresAt),
    });
    try {
      return await this.docToSessionData(doc);
    } catch (err) {
      log.error('failed to decompress cold session (internal)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Internal unscoped version read — used ONLY by TieredSessionStore.
   * NEVER call from request-scoped code paths.
   */
  async getVersionInternal(sessionId: string): Promise<number | null> {
    const SessionState = await getModel();
    const doc = await SessionState.findOne({ _id: sessionId }, { version: 1 }).lean();
    return doc ? (doc.version ?? null) : null;
  }

  /**
   * Internal unscoped delete — used ONLY by TieredSessionStore.
   * NEVER call from request-scoped code paths.
   */
  async deleteInternal(sessionId: string): Promise<void> {
    const SessionState = await getModel();
    await SessionState.deleteOne({ _id: sessionId });
  }

  /**
   * Internal unscoped touch — used ONLY by TieredSessionStore.
   * NEVER call from request-scoped code paths.
   */
  async touchInternal(sessionId: string, lastActivityAt?: Date): Promise<void> {
    const SessionState = await getModel();
    const expiresAt = new Date(Date.now() + this.coldTtlDays * 86400 * 1000);
    await SessionState.updateOne(
      { _id: sessionId },
      { $set: { expiresAt, lastActivityAt: lastActivityAt ?? new Date() } },
    );
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async docToSessionData(doc: any): Promise<SessionData> {
    // Decompress stateData
    const stateObj = await decompressJson<Record<string, unknown>>(doc.stateData);

    // Decompress per-thread data
    const threads: AgentThreadData[] = await Promise.all(
      (doc.threads || []).map(async (t: any) => {
        const threadMetadata =
          t.threadMetadata !== undefined
            ? await decompressJson<Record<string, unknown>>(t.threadMetadata)
            : {};

        return {
          agentName: t.agentName,
          irSourceHash: t.irSourceHash,
          conversationHistory: await decompressJson<ConversationMessage[]>(t.conversationHistory),
          state: await decompressJson<any>(t.state),
          dataValues: await decompressJson<Record<string, unknown>>(t.dataValues),
          dataGatheredKeys: t.gatheredKeys || [],
          startedAt:
            typeof threadMetadata.startedAt === 'number' ? threadMetadata.startedAt : Date.now(),
          endedAt: typeof threadMetadata.endedAt === 'number' ? threadMetadata.endedAt : undefined,
          handoffFrom: t.handoffFrom,
          handoffContext:
            threadMetadata.handoffContext &&
            typeof threadMetadata.handoffContext === 'object' &&
            !Array.isArray(threadMetadata.handoffContext)
              ? (threadMetadata.handoffContext as Record<string, unknown>)
              : undefined,
          returnExpected: threadMetadata.returnExpected === true,
          currentFlowStep:
            typeof threadMetadata.currentFlowStep === 'string'
              ? threadMetadata.currentFlowStep
              : undefined,
          waitingForInput: Array.isArray(threadMetadata.waitingForInput)
            ? (threadMetadata.waitingForInput as string[])
            : undefined,
          pendingResponse:
            typeof threadMetadata.pendingResponse === 'string'
              ? threadMetadata.pendingResponse
              : undefined,
          pendingRichContent:
            threadMetadata.pendingRichContent as AgentThreadData['pendingRichContent'],
          pendingVoiceConfig:
            threadMetadata.pendingVoiceConfig as AgentThreadData['pendingVoiceConfig'],
          pendingActions: threadMetadata.pendingActions as AgentThreadData['pendingActions'],
          pendingAwaitAttachment:
            threadMetadata.pendingAwaitAttachment &&
            typeof threadMetadata.pendingAwaitAttachment === 'object' &&
            !Array.isArray(threadMetadata.pendingAwaitAttachment)
              ? (threadMetadata.pendingAwaitAttachment as AgentThreadData['pendingAwaitAttachment'])
              : undefined,
          status: t.status,
        };
      }),
    );

    // Map threadStack from string IDs back to indices
    const threadIdToIndex = new Map<string, number>();
    (doc.threads || []).forEach((t: any, i: number) => {
      threadIdToIndex.set(t.threadId, i);
    });
    const threadStack = (doc.threadStack || []).map((id: string) => threadIdToIndex.get(id) ?? 0);

    const activeThreadIndex = threadIdToIndex.get(doc.activeThreadId) ?? 0;

    return {
      id: doc._id,
      agentName: doc.agentName,
      irSourceHash: threads[activeThreadIndex]?.irSourceHash || '',
      compilationHash: (stateObj.compilationHash as string | null) ?? null,
      conversationHistory: buildMergedConversationHistory(threads, threadStack, activeThreadIndex),
      state: (stateObj.state as any) || {
        gatherProgress: {},
        conversationPhase: 'start',
        context: {},
      },
      version: doc.version || 0,
      isComplete: (stateObj.isComplete as boolean) || false,
      isEscalated: (stateObj.isEscalated as boolean) || false,
      transferInitiated: (stateObj.transferInitiated as boolean) || false,
      escalationReason: stateObj.escalationReason as string | undefined,
      recentTransferEndedAt: stateObj.recentTransferEndedAt as number | undefined,
      handoffStack: (stateObj.handoffStack as string[]) || [],
      delegateStack: (stateObj.delegateStack as string[]) || [],
      handoffReturnInfo: stateObj.handoffReturnInfo as Record<string, boolean> | undefined,
      dataValues: (stateObj.dataValues as Record<string, unknown>) || {},
      dataGatheredKeys: (stateObj.dataGatheredKeys as string[]) || [],
      executionTreeValues: stateObj.executionTreeValues as Record<string, unknown> | undefined,
      currentFlowStep: stateObj.currentFlowStep as string | undefined,
      waitingForInput: stateObj.waitingForInput as string[] | undefined,
      pendingResponse: stateObj.pendingResponse as string | undefined,
      pendingRichContent: stateObj.pendingRichContent as SessionData['pendingRichContent'],
      pendingVoiceConfig: stateObj.pendingVoiceConfig as SessionData['pendingVoiceConfig'],
      pendingActions: stateObj.pendingActions as SessionData['pendingActions'],
      tenantId: doc.tenantId,
      projectId: doc.projectId,
      permissions: stateObj.permissions as string[] | undefined,
      initialized: (stateObj.initialized as boolean) || false,
      callerContext: stateObj.callerContext as any,
      executionScopeKind: stateObj.executionScopeKind as SessionData['executionScopeKind'],
      environment: stateObj.environment as string | undefined,
      agentVersions: stateObj.agentVersions as Record<string, number> | undefined,
      deploymentId: stateObj.deploymentId as string | undefined,
      maxAgeSeconds: stateObj.maxAgeSeconds as number | undefined,
      idleSeconds: stateObj.idleSeconds as number | undefined,
      customDimensions: stateObj.customDimensions as Record<string, string> | undefined,
      backtrackCounts: stateObj.backtrackCounts as Record<string, number> | undefined,
      constraintCollectState: stateObj.constraintCollectState as any,
      // ── Cold-store parity fields ──────────────────────────────────────────
      userId: (doc.userId as string | undefined) || undefined,
      piiVaultData: stateObj.piiVaultData as string | undefined,
      piiRedactionConfig: stateObj.piiRedactionConfig as SessionData['piiRedactionConfig'],
      gatherFieldsCollected: stateObj.gatherFieldsCollected as string[] | undefined,
      agentRawVersions: stateObj.agentRawVersions as Record<string, string> | undefined,
      moduleProvenance: stateObj.moduleProvenance as SessionData['moduleProvenance'],
      // authToken is intentionally not persisted to cold store (short-lived token, minimize blast radius)
      // Callers must handle authToken === undefined after cold restore
      authToken: undefined,
      createdAt:
        (stateObj.originalCreatedAt as number | undefined) ?? new Date(doc.createdAt).getTime(),
      lastActivityAt: new Date(doc.lastActivityAt).getTime(),
      threads,
      activeThreadIndex,
      threadStack,
    };
  }
}
