import { NextRequest } from 'next/server';
import type { SessionFileRecord } from '@agent-platform/arch-ai/session';
import { SessionFile as SessionFileModel } from '@agent-platform/database/models';
import { ArchSessionModel as ArchSessionModel } from '@agent-platform/arch-ai/models';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { errorJson, successJson } from '@/lib/api-response';
import { attachmentFileStoreService, legacyFileStoreService } from '@/lib/arch-ai/message-services';

export const dynamic = 'force-dynamic';

function serializeFileRecord(blobId: string, record: SessionFileRecord) {
  return {
    blobId,
    name: record.name,
    mediaType: record.mediaType,
    size: record.size,
    status: record.status,
    tokenCost: record.metadata.tokenEstimate,
    metadata: record.metadata,
    unavailableReason: record.unavailableReason ?? null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ blobId: string }> },
) {
  const { blobId } = await params;

  const auth = await requireTenantAuth(request);
  if (isAuthError(auth)) return auth;

  const ctx = { tenantId: auth.tenantId, userId: auth.id };

  const attachmentMapping = await attachmentFileStoreService.findBlobForUser(ctx, blobId);
  if (attachmentMapping) {
    const record = await attachmentFileStoreService.getByBlobId(
      ctx,
      attachmentMapping.sessionId,
      blobId,
    );
    return successJson('data', serializeFileRecord(blobId, record));
  }

  const legacyFile = await SessionFileModel.findOne({
    _id: blobId,
    tenantId: auth.tenantId,
    status: { $ne: 'deleted' },
  }).lean();

  if (!legacyFile) {
    return errorJson('File not found', 404, 'NOT_FOUND');
  }

  const session = await ArchSessionModel.findOne({
    _id: legacyFile.sessionId,
    tenantId: auth.tenantId,
  }).lean();

  if (!session || session.userId !== auth.id) {
    return errorJson('File not found', 404, 'NOT_FOUND');
  }

  const record = await legacyFileStoreService.getByBlobId(
    ctx,
    String(legacyFile.sessionId),
    blobId,
  );
  return successJson('data', serializeFileRecord(blobId, record));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ blobId: string }> },
) {
  const { blobId } = await params;

  const auth = await requireTenantAuth(request);
  if (isAuthError(auth)) return auth;

  const ctx = { tenantId: auth.tenantId, userId: auth.id };

  const attachmentMapping = await attachmentFileStoreService.findBlobForUser(ctx, blobId);
  if (attachmentMapping) {
    await attachmentFileStoreService.updateStatus(
      ctx,
      String(attachmentMapping.sessionId),
      blobId,
      'deleted',
    );
    return successJson('ok', true);
  }

  const legacyFile = await SessionFileModel.findOne({
    _id: blobId,
    tenantId: auth.tenantId,
    status: { $ne: 'deleted' },
  }).lean();

  if (!legacyFile) {
    return errorJson('File not found', 404, 'NOT_FOUND');
  }

  const session = await ArchSessionModel.findOne({
    _id: legacyFile.sessionId,
    tenantId: auth.tenantId,
  }).lean();

  if (!session || session.userId !== auth.id) {
    return errorJson('File not found', 404, 'NOT_FOUND');
  }

  await legacyFileStoreService.updateStatus(ctx, String(legacyFile.sessionId), blobId, 'deleted');
  return successJson('ok', true);
}
