/**
 * Agent Transfer Sessions Routes
 *
 * GET  /api/v1/agent-transfer/sessions          — List active transfer sessions
 * POST /api/v1/agent-transfer/sessions/:id/end  — End a transfer session
 *
 * Called by Studio proxy routes. Uses authenticated tenant context for tenant
 * scoping and X-Project-Id for project scoping.
 */

import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { createLogger } from '@abl/compiler/platform';
import { z } from 'zod';
import {
  getTransferSessionStore,
  isAgentTransferInitialized,
} from '../services/agent-transfer/index.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireProjectPermission } from '../middleware/rbac.js';
import { tenantRateLimit } from '../middleware/rate-limiter.js';
import { SessionDispositionService } from '../services/session-lifecycle/disposition-service.js';
import { cleanupClosedSessionArtifacts } from '../services/session-lifecycle/artifact-cleanup.js';
import {
  buildTransferEndMetadata,
  SessionTerminalizationService,
} from '../services/session-lifecycle/terminalization-service.js';
import type { CanonicalSessionDisposition } from '@abl/compiler/platform/core/types';
import {
  findSessionById,
  updateSession as updateConversationSession,
} from '../repos/session-repo.js';

const router: RouterType = Router();
const log = createLogger('agent-transfer-sessions');
const dispositionService = new SessionDispositionService();
const terminalizationService = new SessionTerminalizationService();

router.use(authMiddleware);
router.use(tenantRateLimit('request'));

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const TRANSFER_END_SOURCE = 'api';
const DEFAULT_PARENT_DISPOSITION: CanonicalSessionDisposition = 'completed';

interface TransferEndSessionRecord {
  projectId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
  postAgentConfig?: { action?: string };
}

const endTransferSessionBodySchema = z
  .object({
    reason: z.string().min(1).max(120).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    dispositionCode: z.string().min(1).max(200).optional(),
    wrapUpNotes: z.string().min(1).max(4000).optional(),
  })
  .strict();

type EndTransferSessionBody = z.infer<typeof endTransferSessionBodySchema>;

function resolveProjectScope(req: Request): string | undefined {
  const headerProjectId = req.headers['x-project-id'] as string | undefined;
  if (headerProjectId) {
    return headerProjectId;
  }

  if (req.tenantContext?.authType === 'sdk_session') {
    return req.tenantContext.projectId;
  }

  return undefined;
}

function buildTransferEndUpdate(
  session: TransferEndSessionRecord,
  body: EndTransferSessionBody,
): {
  metadata: Record<string, unknown>;
  dispositionCode?: string;
  wrapUpNotes?: string;
} | null {
  const hasStructuredUpdate =
    body.reason !== undefined ||
    body.metadata !== undefined ||
    body.dispositionCode !== undefined ||
    body.wrapUpNotes !== undefined;

  if (!hasStructuredUpdate) {
    return null;
  }

  const nextMetadata: Record<string, unknown> = {
    ...(session.metadata ?? {}),
    endSource: TRANSFER_END_SOURCE,
    endRequestedAt: Date.now(),
    ...(body.reason !== undefined ? { endReason: body.reason } : {}),
    ...(body.metadata !== undefined ? { endMetadata: body.metadata } : {}),
  };

  return {
    metadata: nextMetadata,
    ...(body.dispositionCode !== undefined ? { dispositionCode: body.dispositionCode } : {}),
    ...(body.wrapUpNotes !== undefined ? { wrapUpNotes: body.wrapUpNotes } : {}),
  };
}

function resolveParentConversationSessionId(session: TransferEndSessionRecord): string | undefined {
  const candidate = session.metadata?.conversationSessionId;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}

function resolvePostAgentAction(session: TransferEndSessionRecord): 'return' | 'end' {
  const structuredAction = session.postAgentConfig?.action;
  if (structuredAction === 'return' || structuredAction === 'end') {
    return structuredAction;
  }

  const metadataAction = session.metadata?.postAgentAction;
  return metadataAction === 'return' ? 'return' : 'end';
}

function resolveParentDisposition(reason?: string): CanonicalSessionDisposition {
  return dispositionService.normalize(reason)?.disposition ?? DEFAULT_PARENT_DISPOSITION;
}

function buildTransferMetadata(body: EndTransferSessionBody): {
  reason?: string;
  metadata?: Record<string, unknown>;
  dispositionCode?: string;
  wrapUpNotes?: string;
} {
  return {
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    ...(body.dispositionCode !== undefined ? { dispositionCode: body.dispositionCode } : {}),
    ...(body.wrapUpNotes !== undefined ? { wrapUpNotes: body.wrapUpNotes } : {}),
  };
}

async function persistTransferMetadataToParentConversation(params: {
  tenantId: string;
  projectId: string;
  parentConversationSessionId: string;
  disposition: CanonicalSessionDisposition;
  transferMetadata: ReturnType<typeof buildTransferMetadata>;
}): Promise<boolean> {
  const parentSession = await findSessionById(params.parentConversationSessionId, params.tenantId);
  if (!parentSession || parentSession.projectId !== params.projectId) {
    return false;
  }

  const endedAt = new Date();
  const updatePayload: Record<string, unknown> = {
    'metadata.transferEnd': buildTransferEndMetadata({
      disposition: params.disposition,
      endedAt,
      source: 'transfer_end',
      transferMetadata: params.transferMetadata,
    }),
  };

  if (typeof params.transferMetadata.dispositionCode === 'string') {
    updatePayload.dispositionCode = params.transferMetadata.dispositionCode;
  }

  const updated = await updateConversationSession(
    params.parentConversationSessionId,
    updatePayload,
    params.tenantId,
  );
  return Boolean(updated);
}

/**
 * GET /api/v1/agent-transfer/sessions
 *
 * List active transfer sessions with optional filters and pagination.
 * Requires authenticated tenant context plus project scope from X-Project-Id
 * or the SDK token.
 */
router.get('/', async (req: Request, res: Response) => {
  const projectId = resolveProjectScope(req);
  if (!(await requireProjectPermission(req, res, 'connection:read', projectId))) return;

  if (!isAgentTransferInitialized()) {
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_INITIALIZED', message: 'Agent transfer subsystem not initialized' },
    });
  }

  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    return res.status(403).json({
      success: false,
      error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
    });
  }

  const providerFilter = req.query.provider as string | undefined;
  const stateFilter = req.query.state as string | undefined;
  const channelFilter = req.query.channel as string | undefined;
  const cursor = req.query.cursor as string | undefined;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(req.query.limit as string, 10) || DEFAULT_PAGE_SIZE),
  );

  const sessionStore = getTransferSessionStore();
  if (!sessionStore) {
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_INITIALIZED', message: 'Session store not available' },
    });
  }

  try {
    // Cursor-based pagination: use SSCAN to page through the active set
    // and pipeline HGETALL to batch-load sessions (eliminates N+1).
    if (cursor !== undefined) {
      const scanResult = await sessionStore.getActiveSessionsPaginated(tenantId, {
        cursor: cursor || '0',
        count: limit,
      });
      const sessionData = await sessionStore.getMany(scanResult.keys);

      const sessions = [];
      for (let i = 0; i < scanResult.keys.length; i++) {
        const session = sessionData[i];
        if (!session) continue;

        // Defense-in-depth tenant isolation
        if (session.tenantId !== tenantId) continue;

        // Project filter
        if (projectId && session.projectId !== projectId) continue;

        // Optional filters
        if (providerFilter && session.provider !== providerFilter) continue;
        if (stateFilter && session.state !== stateFilter) continue;
        if (channelFilter && session.channel !== channelFilter) continue;

        sessions.push({
          id: scanResult.keys[i],
          contactId: session.contactId,
          agentId: session.agentId ?? '',
          provider: session.provider,
          state: session.state,
          channel: session.channel,
          queue: session.queue,
          skills: session.skills,
          priority: session.priority,
          metadata: session.metadata,
          providerSessionId: session.providerSessionId,
          providerData: session.providerData,
          createdAt: new Date(session.createdAt).toISOString(),
          updatedAt: new Date(session.updatedAt).toISOString(),
        });
      }

      sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      const nextCursor = scanResult.nextCursor === '0' ? null : scanResult.nextCursor;

      return res.status(200).json({
        success: true,
        data: sessions,
        pagination: { cursor: nextCursor, limit, hasMore: nextCursor !== null },
      });
    }

    // Legacy page-based pagination: load all keys, batch-fetch, filter, then slice
    const activeKeys = await sessionStore.getActiveSessions(tenantId);
    const sessionData = await sessionStore.getMany(activeKeys);

    const sessions = [];
    for (let i = 0; i < activeKeys.length; i++) {
      const session = sessionData[i];
      if (!session) continue;

      // Double-check tenant isolation (defense in depth)
      if (session.tenantId !== tenantId) continue;

      // Project filter
      if (projectId && session.projectId !== projectId) continue;

      // Optional filters
      if (providerFilter && session.provider !== providerFilter) continue;
      if (stateFilter && session.state !== stateFilter) continue;
      if (channelFilter && session.channel !== channelFilter) continue;

      sessions.push({
        id: activeKeys[i],
        contactId: session.contactId,
        agentId: session.agentId ?? '',
        provider: session.provider,
        state: session.state,
        channel: session.channel,
        queue: session.queue,
        skills: session.skills,
        priority: session.priority,
        metadata: session.metadata,
        providerSessionId: session.providerSessionId,
        providerData: session.providerData,
        createdAt: new Date(session.createdAt).toISOString(),
        updatedAt: new Date(session.updatedAt).toISOString(),
      });
    }

    // Sort newest first, then paginate
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = sessions.length;
    const startIndex = (page - 1) * limit;
    const paginated = sessions.slice(startIndex, startIndex + limit);

    return res.status(200).json({
      success: true,
      data: paginated,
      pagination: { page, limit, total },
    });
  } catch (err) {
    log.error('Failed to list transfer sessions', {
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list transfer sessions' },
    });
  }
});

/**
 * POST /api/v1/agent-transfer/sessions/:id/end
 *
 * End a specific transfer session.
 * The :id param is the full session key.
 * Runtime must verify session.projectId matches the resolved project scope.
 */
router.post('/:id/end', async (req: Request, res: Response) => {
  const projectId = resolveProjectScope(req);
  if (!(await requireProjectPermission(req, res, 'connection:write', projectId))) return;

  if (!isAgentTransferInitialized()) {
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_INITIALIZED', message: 'Agent transfer subsystem not initialized' },
    });
  }

  const tenantId = req.tenantContext?.tenantId;
  if (!tenantId) {
    return res.status(403).json({
      success: false,
      error: { code: 'TENANT_CONTEXT_REQUIRED', message: 'Tenant context is required' },
    });
  }

  const sessionKey = decodeURIComponent(req.params.id);

  const sessionStore = getTransferSessionStore();
  if (!sessionStore) {
    return res.status(503).json({
      success: false,
      error: { code: 'NOT_INITIALIZED', message: 'Session store not available' },
    });
  }

  try {
    const parsedBody = endTransferSessionBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: 'Request body must be a valid JSON object' },
      });
    }

    const session = await sessionStore.get(sessionKey);
    if (!session || session.tenantId !== tenantId) {
      return res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'No active transfer session found' },
      });
    }

    // Fail closed when a scoped caller targets a session outside that project,
    // including legacy session records that are missing projectId entirely.
    if (projectId && session.projectId !== projectId) {
      return res.status(404).json({
        success: false,
        error: { code: 'SESSION_NOT_FOUND', message: 'No active transfer session found' },
      });
    }

    const endUpdate = buildTransferEndUpdate(session, parsedBody.data);
    if (endUpdate) {
      const updated = await sessionStore.update(sessionKey, endUpdate);
      if (!updated) {
        return res.status(500).json({
          success: false,
          error: { code: 'UPDATE_FAILED', message: 'Failed to persist transfer end metadata' },
        });
      }
    }

    const transferMetadata = buildTransferMetadata(parsedBody.data);
    const parentConversationSessionId = resolveParentConversationSessionId(session);
    const parentConversationProjectId =
      typeof session.projectId === 'string' && session.projectId.length > 0
        ? session.projectId
        : undefined;
    const parentDisposition = resolveParentDisposition(parsedBody.data.reason);
    const shouldTerminalizeParent =
      resolvePostAgentAction(session) === 'end' &&
      parentConversationProjectId !== undefined &&
      parentConversationSessionId !== undefined;
    const shouldPersistParentTransferMetadata =
      endUpdate !== null &&
      parentConversationProjectId !== undefined &&
      parentConversationSessionId !== undefined;
    let parentConversationTerminalized = false;
    let parentConversationMetadataPersisted = false;
    let terminalizationArtifactSessionIds: string[] = [];

    if (shouldTerminalizeParent) {
      const result = await terminalizationService.terminateConversationSession({
        tenantId,
        projectId: parentConversationProjectId!,
        sessionId: parentConversationSessionId!,
        ...(typeof session.agentId === 'string' && session.agentId.length > 0
          ? { agentName: session.agentId }
          : {}),
        disposition: parentDisposition,
        source: 'transfer_end',
        transferMetadata,
      });

      if (!result) {
        return res.status(500).json({
          success: false,
          error: {
            code: 'PARENT_TERMINALIZATION_FAILED',
            message: 'Failed to end the parent conversation session',
          },
        });
      }

      parentConversationTerminalized = true;
      parentConversationMetadataPersisted = true;
      terminalizationArtifactSessionIds = result.artifactSessionIds;
    } else if (shouldPersistParentTransferMetadata) {
      const persisted = await persistTransferMetadataToParentConversation({
        tenantId,
        projectId: parentConversationProjectId!,
        parentConversationSessionId: parentConversationSessionId!,
        disposition: parentDisposition,
        transferMetadata,
      });

      if (!persisted) {
        return res.status(500).json({
          success: false,
          error: {
            code: 'PARENT_METADATA_PERSIST_FAILED',
            message: 'Failed to persist transfer end metadata to the parent conversation session',
          },
        });
      }

      parentConversationMetadataPersisted = true;
    }

    const ended = await sessionStore.end(sessionKey);
    if (!ended) {
      return res.status(500).json({
        success: false,
        error: { code: 'END_FAILED', message: 'Failed to end transfer session' },
      });
    }

    if (terminalizationArtifactSessionIds.length > 0) {
      await cleanupClosedSessionArtifacts(terminalizationArtifactSessionIds);
    }

    log.info('Transfer session ended via API', {
      sessionKey,
      tenantId,
      hasStructuredUpdate: !!endUpdate,
      endReason: parsedBody.data.reason,
      parentConversationSessionId,
      parentConversationTerminalized,
      parentConversationMetadataPersisted,
    });
    return res.status(200).json({ success: true, data: null });
  } catch (err) {
    log.error('Failed to end transfer session', {
      sessionKey,
      tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to end transfer session' },
    });
  }
});

export default router;
