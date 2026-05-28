/**
 * POST /api/arch-ai/files — Upload a file for an Arch AI session
 *
 * B03: Upload-then-reference architecture. Each file uploaded separately with
 * progress, returns a blobId. The blobId is then referenced in message requests.
 *
 * Auth: Studio Next.js App Router pattern (requireTenantAuth from @/lib/auth)
 * Response: { success: true, data: { blobId, metadata, tokenCost } }
 * Errors: { success: false, errors: [{ msg, code }] }
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';
import { errorJson, successJson, ErrorCode } from '@/lib/api-response';
import { ArchSessionModel as ArchSessionModel } from '@agent-platform/arch-ai/models';
import { attachmentFileStoreService } from '@/lib/arch-ai/message-services';
import { ArchAttachmentUploadError } from '@/lib/arch-ai/file-store';
import { resolveAcceptedArchUploadMimeType } from '@/lib/arch-ai/file-mime';

export const dynamic = 'force-dynamic';

const log = createLogger('api:arch-ai:files');

// ─── Request Validation ──────────────────────────────────────────────────

const UploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  file: z.object({
    name: z.string().min(1),
    type: z.string().default(''),
    size: z.number().positive().max(ARCH_AI_FILES.MAX_FILE_SIZE_BYTES),
    content: z.string().min(1), // base64
  }),
});

const SIZE_MISMATCH_TOLERANCE_BYTES = 4;

function decodeBase64Content(content: string): Buffer | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length % 4 !== 0) {
    return null;
  }

  for (let i = 0; i < trimmed.length; i++) {
    const charCode = trimmed.charCodeAt(i);
    const isUpper = charCode >= 65 && charCode <= 90;
    const isLower = charCode >= 97 && charCode <= 122;
    const isDigit = charCode >= 48 && charCode <= 57;
    const isSymbol = charCode === 43 || charCode === 47 || charCode === 61;
    if (!isUpper && !isLower && !isDigit && !isSymbol) {
      return null;
    }
  }

  const buffer = Buffer.from(trimmed, 'base64');
  if (buffer.length === 0) {
    return null;
  }

  const canonicalInput = trimmed.replace(/=+$/, '');
  const canonicalDecoded = buffer.toString('base64').replace(/=+$/, '');
  if (canonicalInput !== canonicalDecoded) {
    return null;
  }

  return buffer;
}

// ─── POST Handler ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Auth
  const auth = await requireTenantAuth(request);
  if (isAuthError(auth)) return auth;

  // Parse + validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson('Invalid JSON body', 400, 'INVALID_JSON');
  }

  const parseResult = UploadRequestSchema.safeParse(body);
  if (!parseResult.success) {
    const firstError = parseResult.error.issues[0];
    return errorJson(
      firstError ? `${firstError.path.join('.')}: ${firstError.message}` : 'Invalid request',
      400,
      ErrorCode.VALIDATION_ERROR,
    );
  }

  const { sessionId, file } = parseResult.data;
  const normalizedMimeType = resolveAcceptedArchUploadMimeType(file.name, file.type);
  if (!normalizedMimeType) {
    return errorJson(
      `Unsupported file type for ${file.name}. Allowed: ${ARCH_AI_FILES.ACCEPTED_UPLOAD_EXTENSIONS.join(', ')}`,
      400,
      'UNSUPPORTED_FILE_TYPE',
    );
  }

  const decodedContent = decodeBase64Content(file.content);
  if (!decodedContent) {
    return errorJson(`Invalid file content for ${file.name}`, 400, 'INVALID_FILE_CONTENT');
  }

  const actualSize = decodedContent.length;
  if (actualSize > ARCH_AI_FILES.MAX_FILE_SIZE_BYTES) {
    return errorJson(
      `File ${file.name} exceeds ${ARCH_AI_FILES.MAX_FILE_SIZE_BYTES / 1024 / 1024}MB limit`,
      413,
      'FILE_TOO_LARGE',
    );
  }

  if (Math.abs(actualSize - file.size) > SIZE_MISMATCH_TOLERANCE_BYTES) {
    log.warn('file upload size mismatch', {
      sessionId,
      fileName: file.name,
      declaredSize: file.size,
      actualSize,
    });
  }

  const normalizedFile = {
    name: file.name,
    type: normalizedMimeType,
    size: actualSize,
    content: decodedContent.toString('base64'),
  };
  const ctx = { tenantId: auth.tenantId, userId: auth.id };

  // Session ownership check — findOne with tenantId, verify userId, return 404 on failure
  const session = await ArchSessionModel.findOne({
    _id: sessionId,
    tenantId: auth.tenantId,
  }).lean();

  if (!session) {
    return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
  }

  if (session.userId !== auth.id) {
    // Return 404 (not 403) to avoid leaking existence — platform invariant
    return errorJson('Session not found', 404, 'SESSION_NOT_FOUND');
  }

  if (session.state === 'ARCHIVED') {
    return errorJson('Cannot operate on an archived session', 409, 'SESSION_ARCHIVED');
  }

  try {
    const result = await attachmentFileStoreService.upload(ctx, session, normalizedFile);
    const record = await attachmentFileStoreService.getByBlobId(ctx, sessionId, result.blobId);

    log.info('file uploaded', {
      blobId: result.blobId,
      sessionId,
      tenantId: auth.tenantId,
      name: normalizedFile.name,
      size: normalizedFile.size,
      type: normalizedFile.type,
      collision: result.collision,
    });

    return successJson('data', {
      blobId: result.blobId,
      metadata: result.metadata,
      tokenCost: result.tokenCost,
      collision: result.collision,
      existingBlobId: result.existingBlobId,
      status: record.status,
      unavailableReason: record.unavailableReason ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'UnknownError';

    log.error('file upload failed', {
      sessionId,
      tenantId: auth.tenantId,
      fileName: file.name,
      error: message,
      errorType: name,
    });

    // Map error types to HTTP status codes
    if (name === 'FileTooLargeError') {
      return errorJson(message, 413, 'FILE_TOO_LARGE');
    }
    if (err instanceof ArchAttachmentUploadError) {
      return errorJson(message, err.status, err.code);
    }
    if (name === 'SessionFileQuotaError') {
      return errorJson(message, 413, 'SESSION_FILE_QUOTA_EXCEEDED');
    }
    if (name === 'FileCorruptError') {
      return errorJson(message, 422, 'FILE_CORRUPT');
    }

    return errorJson(message, 500, 'UPLOAD_FAILED');
  }
}
