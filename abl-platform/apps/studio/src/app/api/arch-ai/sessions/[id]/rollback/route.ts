/**
 * POST /api/arch-ai/sessions/:id/rollback — Rollback session to a checkpoint
 * Body: { checkpointId: string }
 * Returns the updated session with restored state.
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { actionJson, errorJson, handleApiError } from '@/lib/api-response';
import { ArchJournal } from '@agent-platform/database/models';
import {
  SessionService,
  JournalService,
  SessionNotFoundError,
  rollbackFromCheckpoint,
  buildResumeSnapshot,
} from '@agent-platform/arch-ai';
import type { SessionCheckpoint } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';

const log = createLogger('api:arch-ai:sessions:[id]:rollback');

const sessionService = new SessionService(ArchSessionModel);
const journalService = new JournalService(ArchJournal);

const RollbackBodySchema = z.object({
  checkpointId: z.string().min(1),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id } = await params;

    const ctx = { tenantId: auth.tenantId, userId: auth.id };

    // Parse and validate request body
    const body = await request.json();
    const parsed = RollbackBodySchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body: checkpointId is required', 400, 'VALIDATION_ERROR');
    }
    const { checkpointId } = parsed.data;

    // Load the session
    const session = await sessionService.getById(ctx, id);
    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    // Find the checkpoint
    const checkpoints: SessionCheckpoint[] = session.metadata.checkpoints ?? [];
    const checkpoint = checkpoints.find((cp) => cp.checkpointId === checkpointId);
    if (!checkpoint) {
      return errorJson('Checkpoint not found', 404, 'CHECKPOINT_NOT_FOUND');
    }

    // Build the rollback patch
    const patch = rollbackFromCheckpoint(checkpoint);

    const $set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        $set[`metadata.${key}`] = value;
      }
    }

    // Also unset fields that should be cleared (undefined in patch)
    const $unset: Record<string, ''> = {};
    if (patch.pendingMutation === undefined) {
      $unset['metadata.pendingMutation'] = '';
    }
    if (patch.activeSpecialist === undefined) {
      $unset['metadata.activeSpecialist'] = '';
    }

    const updateOp: Record<string, unknown> = {};
    if (Object.keys($set).length > 0) updateOp.$set = $set;
    if (Object.keys($unset).length > 0) updateOp.$unset = $unset;

    if (Object.keys(updateOp).length > 0) {
      await ArchSessionModel.updateOne(
        { _id: id, tenantId: ctx.tenantId, userId: ctx.userId },
        updateOp,
      );
    }

    // Emit a journal entry recording the rollback
    await journalService.append(ctx, {
      sessionId: id,
      type: 'decision',
      content: {
        type: 'decision',
        summary: `Rollback to checkpoint: ${checkpoint.phase} phase (${checkpoint.trigger})`,
        rationale: `User rolled back to checkpoint ${checkpointId} created at ${checkpoint.timestamp}`,
        specialist: 'coordinator',
        source: 'user_input' as const,
      },
      specialist: 'coordinator',
      phase: checkpoint.phase,
    });

    log.info('Session rolled back to checkpoint', {
      sessionId: id,
      checkpointId,
      phase: checkpoint.phase,
      trigger: checkpoint.trigger,
      userId: auth.id,
    });

    // Re-read session to return the updated state
    const updated = await sessionService.getById(ctx, id);
    if (!updated) {
      return errorJson('Session not found after rollback', 500, 'ROLLBACK_FAILED');
    }

    return actionJson({
      session: updated,
      resume: buildResumeSnapshot(updated),
    });
  } catch (err: unknown) {
    if (err instanceof SessionNotFoundError) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    return handleApiError(err, 'arch-ai');
  }
}
