/**
 * GET    /api/arch-ai/memories/project?projectId=xxx — List project memories
 * POST   /api/arch-ai/memories/project — Add a manual memory entry
 * PATCH  /api/arch-ai/memories/project — Update a memory by ID
 * DELETE /api/arch-ai/memories/project — Delete a memory by ID
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { successJson, errorJson, handleApiError, ErrorCode } from '@/lib/api-response';
import { ArchProjectMemory } from '@agent-platform/database/models';

const log = createLogger('api:arch-ai:memories:project');

// ─── GET — list project memories ─────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const projectId = request.nextUrl.searchParams.get('projectId');
    if (!projectId) {
      return errorJson('projectId query parameter is required', 400, ErrorCode.VALIDATION_ERROR);
    }

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const doc = await ArchProjectMemory.findOne({
      tenantId: auth.tenantId,
      projectId,
    }).lean();

    return successJson('memories', doc?.memories ?? []);
  } catch (err: unknown) {
    log.error('Failed to list project memories', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:project');
  }
}

// ─── POST — add a manual memory entry ───────────────────────────────────

const addMemorySchema = z.object({
  projectId: z.string().min(1),
  content: z.string().min(1),
  type: z.enum(['decision', 'pattern', 'preference', 'constraint', 'learning']).default('decision'),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = addMemorySchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { projectId, content, type } = parsed.data;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const entry = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      content,
      source: 'user' as const,
      phase: 'manual',
      sessionId: 'manual',
      createdAt: new Date(),
      relevance: 0.7,
    };

    await ArchProjectMemory.findOneAndUpdate(
      { tenantId: auth.tenantId, projectId },
      { $push: { memories: entry }, $setOnInsert: { tenantId: auth.tenantId, projectId } },
      { upsert: true, new: true },
    );

    log.info('Project memory added', { projectId, memoryId: entry.id, userId: auth.id });
    return successJson('memory', entry, 201);
  } catch (err: unknown) {
    log.error('Failed to add project memory', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:project');
  }
}

// ─── PATCH — update a memory entry ───────────────────────────────────────

const updateMemorySchema = z.object({
  projectId: z.string().min(1),
  memoryId: z.string().min(1),
  updates: z.object({
    content: z.string().min(1).optional(),
    relevance: z.number().min(0).max(1).optional(),
  }),
});

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = updateMemorySchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { projectId, memoryId, updates } = parsed.data;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const setFields: Record<string, unknown> = {};
    if (updates.content !== undefined) setFields['memories.$.content'] = updates.content;
    if (updates.relevance !== undefined) setFields['memories.$.relevance'] = updates.relevance;

    const result = await ArchProjectMemory.findOneAndUpdate(
      { tenantId: auth.tenantId, projectId, 'memories.id': memoryId },
      { $set: setFields },
      { new: true },
    ).lean();

    if (!result) {
      return errorJson('Memory not found', 404, ErrorCode.NOT_FOUND);
    }

    log.info('Project memory updated', { projectId, memoryId, userId: auth.id });
    return successJson('success', true);
  } catch (err: unknown) {
    log.error('Failed to update project memory', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:project');
  }
}

// ─── DELETE — delete a memory entry ──────────────────────────────────────

const deleteMemorySchema = z.object({
  projectId: z.string().min(1),
  memoryId: z.string().min(1),
});

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;

    const body = await request.json();
    const parsed = deleteMemorySchema.safeParse(body);
    if (!parsed.success) {
      return errorJson('Invalid request body', 400, ErrorCode.VALIDATION_ERROR);
    }

    const { projectId, memoryId } = parsed.data;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const result = await ArchProjectMemory.findOneAndUpdate(
      { tenantId: auth.tenantId, projectId },
      { $pull: { memories: { id: memoryId } } },
      { new: true },
    ).lean();

    if (!result) {
      return errorJson('Project memory document not found', 404, ErrorCode.NOT_FOUND);
    }

    log.info('Project memory deleted', { projectId, memoryId, userId: auth.id });
    return successJson('deleted', true);
  } catch (err: unknown) {
    log.error('Failed to delete project memory', {
      error: err instanceof Error ? err.message : String(err),
    });
    return handleApiError(err, 'arch-ai:memories:project');
  }
}
