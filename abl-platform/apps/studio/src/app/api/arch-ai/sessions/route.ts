/**
 * POST /api/arch-ai/sessions — Create new session
 * Contract 1 (api-index): Request { projectId?: string }, Response { sessionId }
 */

import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { actionJson, errorJson, handleApiError } from '@/lib/api-response';
import { ARCH_AI_SESSION_RECOVERY } from '@/lib/arch-ai/constants';
import { ArchJournal, ArchSpecDocument } from '@agent-platform/database/models';
import mongoose from 'mongoose';
import {
  SessionService,
  SessionAlreadyExistsError,
  JournalService,
  AuditLogEmitter,
  SpecDocumentService,
} from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
import { getStudioArchAuditPipelineWriter } from '@/lib/arch-audit-pipeline-writer';

const log = createLogger('api:arch-ai:sessions');

const createSessionSchema = z.object({
  projectId: z.string().min(1).optional(),
  surface: z.enum(['project', 'agent-editor']).optional(),
  agentName: z.string().min(1).optional(),
  forceNew: z.boolean().optional(),
  threadId: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

const sessionService = new SessionService(ArchSessionModel, new JournalService(ArchJournal));

export async function POST(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body', 400, 'INVALID_INPUT');
    }
    const forceCreate = parsed.data.force === true || parsed.data.forceNew === true;
    const threadId = forceCreate ? (parsed.data.threadId ?? randomUUID()) : parsed.data.threadId;
    const scopeOptions =
      parsed.data.projectId || threadId
        ? {
            surface: parsed.data.surface,
            agentName: parsed.data.agentName,
            threadId,
          }
        : undefined;
    if (parsed.data.surface === 'agent-editor' && !parsed.data.agentName) {
      return errorJson('agentName is required for agent-editor sessions', 400, 'INVALID_INPUT');
    }
    if (parsed.data.surface !== 'agent-editor' && parsed.data.agentName) {
      return errorJson('agentName is only valid for agent-editor sessions', 400, 'INVALID_INPUT');
    }

    // Verify caller has access to the target project before binding it to a session
    if (parsed.data.projectId) {
      const access = await requireProjectAccess(parsed.data.projectId, auth);
      if (isAccessError(access)) return access;
    }

    const ctx = { tenantId: auth.tenantId, userId: auth.id };

    const scopedFreshStartArchivedCount =
      forceCreate && parsed.data.threadId
        ? await sessionService.forceArchiveScopedFreshStart(
            ctx,
            parsed.data.projectId,
            scopeOptions,
          )
        : 0;
    if (scopedFreshStartArchivedCount > 0) {
      log.warn('Force-archived scoped Arch AI session before fresh create', {
        recoveredCount: scopedFreshStartArchivedCount,
        userId: auth.id,
        projectId: parsed.data.projectId ?? null,
      });
    }

    const recoveredCount = forceCreate
      ? 0
      : await sessionService.forceArchiveStuck(
          ctx,
          parsed.data.projectId,
          ARCH_AI_SESSION_RECOVERY.STUCK_SESSION_THRESHOLD_MS,
          scopeOptions,
        );

    if (recoveredCount > 0) {
      log.warn(
        forceCreate
          ? 'Force-archived Arch AI sessions before fresh create'
          : 'Recovered stuck Arch AI sessions before create',
        { recoveredCount, userId: auth.id, projectId: parsed.data.projectId ?? null },
      );
    }

    if (!forceCreate) {
      const existing = await sessionService.getCurrent(
        ctx,
        parsed.data.projectId ? 'IN_PROJECT' : 'ONBOARDING',
        parsed.data.projectId,
        scopeOptions,
      );
      if (existing) {
        return actionJson({ sessionId: existing.id, session: existing });
      }
    }

    let session;
    try {
      session = await sessionService.create(ctx, parsed.data.projectId, scopeOptions);
    } catch (err: unknown) {
      if (!forceCreate || !(err instanceof SessionAlreadyExistsError)) {
        throw err;
      }

      const legacyRecoveredCount = await sessionService.forceArchiveForFreshStart(
        ctx,
        parsed.data.projectId,
      );
      log.warn('Force-archived Arch AI sessions after legacy index collision', {
        recoveredCount: legacyRecoveredCount,
        userId: auth.id,
        projectId: parsed.data.projectId ?? null,
      });
      session = await sessionService.create(ctx, parsed.data.projectId, scopeOptions);
    }

    log.info('Session created', { sessionId: session.id, userId: auth.id });

    // Create spec document alongside session (idempotent)
    try {
      const specDocSvc = new SpecDocumentService(
        ArchSpecDocument,
        ArchSessionModel,
        mongoose.connection,
      );
      await specDocSvc.create({ tenantId: auth.tenantId, userId: auth.id }, session.id);
    } catch (err: unknown) {
      // Non-blocking — session creation is more important
      log.warn('Failed to create spec document', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Audit: emit session_created event
    if (process.env.ARCH_AUDIT_LOG_ENABLED !== 'false') {
      const auditEmitter = new AuditLogEmitter(
        { tenantId: auth.tenantId, userId: auth.id, sessionId: session.id },
        getStudioArchAuditPipelineWriter(),
      );
      auditEmitter.emit({
        category: 'system_event',
        severity: 'info',
        summary: `Session created (${parsed.data.projectId ? 'IN_PROJECT' : 'ONBOARDING'})`,
        detail: {
          event: 'session_created',
          detail: parsed.data.projectId
            ? `In-project session for ${parsed.data.projectId}`
            : 'Onboarding session',
        },
        projectId: parsed.data.projectId ?? undefined,
      });
      await auditEmitter.flush();
      auditEmitter.destroy();
    }

    return actionJson({ sessionId: session.id, session }, 201);
  } catch (err: unknown) {
    if (err instanceof SessionAlreadyExistsError) {
      return errorJson(
        'A non-terminal session already exists. Archive it first.',
        409,
        'SESSION_EXISTS',
      );
    }
    return handleApiError(err, 'arch-ai');
  }
}
