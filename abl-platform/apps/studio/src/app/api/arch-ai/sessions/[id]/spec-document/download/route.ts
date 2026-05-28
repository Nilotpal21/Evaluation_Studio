/**
 * GET /api/arch-ai/sessions/:id/spec-document/download — Download spec as Markdown
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, handleApiError } from '@/lib/api-response';
import { ArchSpecDocument } from '@agent-platform/database/models';
import { SpecDocumentService, renderSpecMarkdown } from '@agent-platform/arch-ai';
import { ArchSessionModel } from '@agent-platform/arch-ai/models';
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

    const markdown = renderSpecMarkdown(specDoc);
    const projectName = specDoc.business.projectName || 'Untitled-Project';
    const safeFileName = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');

    return new NextResponse(markdown, {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeFileName}-spec.md"`,
      },
    });
  } catch (err: unknown) {
    return handleApiError(err, 'arch-ai:spec-document:download');
  }
}
