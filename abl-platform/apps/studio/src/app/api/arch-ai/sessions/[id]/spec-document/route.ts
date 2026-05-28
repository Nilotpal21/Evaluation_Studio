/**
 * GET /api/arch-ai/sessions/:id/spec-document — Get spec document by session
 * PUT /api/arch-ai/sessions/:id/spec-document — Bulk-update editable business fields
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { successJson, errorJson, handleApiError } from '@/lib/api-response';
import { ArchSpecDocument } from '@agent-platform/database/models';
import { SpecDocumentService, validateEditablePath } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
import { projectExistsByName } from '@/services/project-service';
import mongoose from 'mongoose';

const log = createLogger('arch-ai:spec-document-api');

const specDocumentService = new SpecDocumentService(
  ArchSpecDocument,
  ArchSessionModel,
  mongoose.connection,
);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id: sessionId } = await params;

    // Verify session exists and belongs to this user
    const session = await ArchSessionModel.findOne({
      _id: sessionId,
      tenantId: auth.tenantId,
      userId: auth.id,
    }).lean();

    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const specDoc = await specDocumentService.getBySession(
      { tenantId: auth.tenantId, userId: auth.id },
      sessionId,
    );

    if (!specDoc) {
      return errorJson('Spec document not found', 404, 'SPEC_DOCUMENT_NOT_FOUND');
    }

    return successJson('data', specDoc);
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai:spec-document');
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireTenantAuth(request);
    if (isAuthError(auth)) return auth;
    const { id: sessionId } = await params;

    // Verify session exists and belongs to this user
    const session = await ArchSessionModel.findOne({
      _id: sessionId,
      tenantId: auth.tenantId,
      userId: auth.id,
    }).lean();

    if (!session) {
      return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
    }

    const body = (await request.json()) as { updates?: Array<{ path: string; value: unknown }> };

    if (!body.updates || !Array.isArray(body.updates) || body.updates.length === 0) {
      return errorJson('updates must be a non-empty array', 400, 'VALIDATION_ERROR');
    }

    // Validate all paths before any writes
    for (const { path } of body.updates) {
      validateEditablePath(path);
    }

    // Check project name uniqueness if being updated
    const projectNameUpdate = body.updates.find((u) => u.path === 'business.projectName');
    if (projectNameUpdate) {
      const name =
        typeof projectNameUpdate.value === 'string' ? projectNameUpdate.value.trim() : '';
      if (!name || name.length < 2) {
        return errorJson('Project name must be at least 2 characters.', 400, 'VALIDATION_ERROR');
      }
      if (name.length > 100) {
        return errorJson('Project name must be 100 characters or fewer.', 400, 'VALIDATION_ERROR');
      }
      if (await projectExistsByName(name, auth.tenantId)) {
        return errorJson(
          `A project named "${name}" already exists. Please choose a different name.`,
          409,
          'NAME_CONFLICT',
        );
      }
    }

    // Get spec doc to find its _id
    const ctx = { tenantId: auth.tenantId, userId: auth.id };
    const spec = await specDocumentService.getBySession(ctx, sessionId);

    if (!spec) {
      return errorJson('Spec document not found', 404, 'SPEC_DOCUMENT_NOT_FOUND');
    }

    const updatedDoc = await specDocumentService.bulkUpdateBusiness(
      ctx,
      String(spec._id),
      sessionId,
      body.updates,
    );

    return successJson('data', updatedDoc);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ValidationError') {
      return errorJson(err.message, 400, 'VALIDATION_ERROR');
    }
    return handleApiError(err, 'arch-ai:spec-document');
  }
}
