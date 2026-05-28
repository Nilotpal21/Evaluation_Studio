/**
 * GET /api/arch-ai/files/:blobId/content — Serve file content for preview/download
 *
 * B03: Returns the raw file content with correct Content-Type for inline rendering
 * (image thumbnails, code preview, PDF viewing) and download.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { SessionFile as SessionFileModel } from '@agent-platform/database/models';
import { ArchSessionModel as ArchSessionModel } from '@agent-platform/arch-ai/models';
import { attachmentFileStoreService } from '@/lib/arch-ai/message-services';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ blobId: string }> },
) {
  const { blobId } = await params;

  // Auth
  const authResult = await requireTenantAuth(request);
  if (authResult instanceof NextResponse) return authResult;
  if (isAuthError(authResult)) {
    return NextResponse.json(
      { success: false, error: { code: 'unauthorized', message: 'Authentication required' } },
      { status: 401 },
    );
  }

  const auth = authResult;

  const ctx = { tenantId: auth.tenantId, userId: auth.id };

  const attachmentBlob = await attachmentFileStoreService.downloadBlobContent(ctx, blobId, {
    disposition: request.nextUrl.searchParams.get('download') === 'true' ? 'attachment' : 'inline',
  });

  if (attachmentBlob) {
    const safeName = attachmentBlob.mapping.name.replace(/["\\\n\r]/g, '_');
    const disposition =
      request.nextUrl.searchParams.get('download') === 'true'
        ? `attachment; filename="${safeName}"`
        : 'inline';

    return new NextResponse(new Uint8Array(attachmentBlob.buffer), {
      status: 200,
      headers: {
        'Content-Type': attachmentBlob.mapping.mediaType || attachmentBlob.contentType,
        'Content-Length': String(attachmentBlob.buffer.length),
        'Content-Disposition': disposition,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  }

  // Find the file — scoped by tenantId
  const file = await SessionFileModel.findOne({
    _id: blobId,
    tenantId: auth.tenantId,
    status: { $ne: 'deleted' },
  }).lean();

  if (!file) {
    return NextResponse.json(
      { success: false, error: { code: 'not_found', message: 'File not found' } },
      { status: 404 },
    );
  }

  // Verify user owns the session
  const session = await ArchSessionModel.findOne({
    _id: file.sessionId,
    tenantId: auth.tenantId,
  }).lean();

  if (!session || session.userId !== auth.id) {
    return NextResponse.json(
      { success: false, error: { code: 'not_found', message: 'File not found' } },
      { status: 404 },
    );
  }

  // Return raw content with correct Content-Type
  const contentBuffer = Buffer.isBuffer(file.content)
    ? file.content
    : Buffer.from(file.content as unknown as ArrayBuffer);

  // Determine if this should be inline (preview) or attachment (download)
  const safeName = file.name.replace(/["\\\n\r]/g, '_');
  const disposition =
    request.nextUrl.searchParams.get('download') === 'true'
      ? `attachment; filename="${safeName}"`
      : 'inline';

  return new NextResponse(contentBuffer, {
    status: 200,
    headers: {
      'Content-Type': file.mediaType,
      'Content-Length': String(contentBuffer.length),
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=3600', // 1 hour cache for same session
    },
  });
}
