/**
 * GET    /api/arch-ai/memories/learnings — List all Arch learnings (tenant-scoped + global)
 * PATCH  /api/arch-ai/memories/learnings — Update a learning by ID
 * DELETE /api/arch-ai/memories/learnings — Delete a learning by ID
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { successJson, errorJson, handleApiError, ErrorCode } from '@/lib/api-response';
import { ArchLearningMemory } from '@agent-platform/database/models';

const log = createLogger('api:arch-ai:memories:learnings');

// ─── GET — list learnings ────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    // Return tenant-scoped learnings + global (no tenantId) learnings
    const learnings = await ArchLearningMemory.find({
      $or: [{ tenantId: auth.tenantId }, { tenantId: { $exists: false } }, { tenantId: null }],
    })
      .sort({ confidence: -1 })
      .lean();

    return successJson('learnings', learnings);
  } catch (err: unknown) {
    log.error('Failed to list learnings', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:learnings');
  }
}

// ─── PATCH — update a learning ───────────────────────────────────────────

const updateSchema = z.object({
  learningId: z.string().min(1),
  updates: z.object({
    pattern: z.string().min(1).optional(),
    resolution: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
});

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { learningId, updates } = parsed.data;

    // Only allow updating learnings scoped to the caller's tenant. Global Arch
    // learnings are shared platform knowledge and require a separate admin path.
    const learning = await ArchLearningMemory.findOneAndUpdate(
      {
        _id: learningId,
        tenantId: auth.tenantId,
      },
      { $set: updates },
      { new: true },
    ).lean();

    if (!learning) {
      return errorJson('Learning not found', 404, ErrorCode.NOT_FOUND);
    }

    log.info('Learning updated', { learningId, userId: auth.id });
    return successJson('learning', learning);
  } catch (err: unknown) {
    log.error('Failed to update learning', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:learnings');
  }
}

// ─── DELETE — delete a learning ──────────────────────────────────────────

const deleteSchema = z.object({
  learningId: z.string().min(1),
});

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { learningId } = parsed.data;

    // Only allow deleting learnings scoped to the caller's tenant. Global Arch
    // learnings are shared platform knowledge and require a separate admin path.
    const result = await ArchLearningMemory.findOneAndDelete({
      _id: learningId,
      tenantId: auth.tenantId,
    });

    if (!result) {
      return errorJson('Learning not found', 404, ErrorCode.NOT_FOUND);
    }

    log.info('Learning deleted', { learningId, userId: auth.id });
    return successJson('deleted', true);
  } catch (err: unknown) {
    log.error('Failed to delete learning', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:learnings');
  }
}
