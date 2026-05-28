import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { createLogger } from '@abl/compiler/platform/logger.js';
import type { Model } from 'mongoose';
import type { IAttachment, IArchSessionAttachment } from '@agent-platform/database';
import type { AttachmentConfig } from '@agent-platform/shared';
import {
  type ArchFileStore,
  type SessionContext,
  type SessionFileRecord,
  FileStoreService,
} from '@agent-platform/arch-ai/session';
import {
  FileNotFoundError,
  FileTooLargeError,
  SessionFileQuotaError,
} from '@agent-platform/arch-ai';
import type { IArchSessionRecord } from '@agent-platform/arch-ai/models';
import { resolveArchAttachmentConfig } from './attachment-config-resolver';
import { ArchMultimodalServiceClient } from './multimodal-service-client';
import { normalizeArchUploadMimeType } from './file-mime';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';

const log = createLogger('lib:arch-ai:file-store');

type FileStatus = SessionFileRecord['status'];
const MAX_SESSION_TOTAL_SIZE = 50 * 1024 * 1024;

interface FileMetadata {
  width?: number;
  height?: number;
  pageCount?: number;
  lineCount?: number;
  language?: string;
  endpointCount?: number;
  columns?: string[];
  rowCount?: number;
  tokenEstimate: number;
}

type ImageHydrationMode = 'metadata' | 'content';

interface UploadInput {
  name: string;
  type: string;
  size: number;
  content: string;
}

interface UploadResult {
  blobId: string;
  metadata: FileMetadata;
  tokenCost: number;
  collision: boolean;
  existingBlobId?: string;
}

const MAX_FILE_CONTENT_CHARS = 50_000;
const EXTRACTION_MIME_OVERRIDES: Record<string, string> = {
  'application/json': 'text/plain',
  'application/x-yaml': 'text/plain',
  'text/yaml': 'text/plain',
};

export class ArchAttachmentUploadError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ArchAttachmentUploadError';
  }
}

export class ArchAttachmentFileStore implements ArchFileStore {
  private readonly client: ArchMultimodalServiceClient;

  constructor(
    private readonly mappingModel: Model<IArchSessionAttachment>,
    client?: ArchMultimodalServiceClient,
  ) {
    this.client = client ?? new ArchMultimodalServiceClient();
  }

  async upload(
    ctx: SessionContext,
    session: Pick<IArchSessionRecord, '_id' | 'metadata'>,
    file: UploadInput,
  ): Promise<UploadResult> {
    const buffer = Buffer.from(file.content, 'base64');
    const projectId = resolveArchAttachmentProjectId(session._id, session.metadata.projectId ?? '');
    const attachmentConfig = await resolveArchAttachmentConfig(ctx.tenantId, projectId);
    const uploadConfig = buildUploadConfig(attachmentConfig);
    const contentHash = computeSHA256(buffer);
    const canonicalMimeType = normalizeArchUploadMimeType(file.name, file.type);
    const uploadMimeType = normalizeMimeTypeForExtraction(canonicalMimeType);

    if (!attachmentConfig.enabled) {
      throw new ArchAttachmentUploadError(
        'ATTACHMENTS_DISABLED',
        403,
        'Attachments are disabled for this session',
      );
    }

    if (buffer.length > attachmentConfig.maxFileSizeBytes) {
      throw new FileTooLargeError(file.name, buffer.length, attachmentConfig.maxFileSizeBytes);
    }

    const currentTotal = await this.getSessionTotalSize(ctx, session._id);
    if (currentTotal + buffer.length > MAX_SESSION_TOTAL_SIZE) {
      throw new SessionFileQuotaError(
        session._id,
        currentTotal + buffer.length,
        MAX_SESSION_TOTAL_SIZE,
      );
    }

    if (
      attachmentConfig.allowedMimeTypes.length > 0 &&
      !uploadConfig.allowedMimeTypes.includes(canonicalMimeType)
    ) {
      throw new ArchAttachmentUploadError(
        'UNSUPPORTED_MEDIA_TYPE',
        415,
        `File type is not allowed for this session: ${canonicalMimeType}`,
      );
    }

    const existingByHash = await this.mappingModel
      .findOne({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: session._id,
        contentHash,
      })
      .lean();

    if (existingByHash) {
      return {
        blobId: existingByHash._id,
        metadata: existingByHash.metadata as FileMetadata,
        tokenCost: existingByHash.metadata.tokenEstimate,
        collision: false,
      };
    }

    const existingByName = await this.mappingModel
      .findOne({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: session._id,
        name: file.name,
        status: { $ne: 'deleted' },
      })
      .lean();

    if (existingByName) {
      return {
        blobId: existingByName._id,
        metadata: existingByName.metadata as FileMetadata,
        tokenCost: existingByName.metadata.tokenEstimate,
        collision: true,
        existingBlobId: existingByName._id,
      };
    }

    const uploadResult = await this.client.upload({
      stream: Readable.from(buffer),
      filename: file.name,
      mimeType: uploadMimeType,
      sizeBytes: buffer.length,
      tenantId: ctx.tenantId,
      projectId,
      sessionId: session._id,
      config: uploadConfig,
    });

    if (!uploadResult.success) {
      throw new ArchAttachmentUploadError(uploadResult.error.code, 502, uploadResult.error.message);
    }

    const existing = await this.mappingModel
      .findOne({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: session._id,
        attachmentId: uploadResult.attachmentId,
      })
      .lean();

    if (existing) {
      return {
        blobId: existing._id,
        metadata: existing.metadata as FileMetadata,
        tokenCost: existing.metadata.tokenEstimate,
        collision: false,
      };
    }

    const metadata = buildMetadata(buffer, canonicalMimeType);
    const tokenEstimate = computeTokenEstimate(
      classifyFileType(canonicalMimeType),
      buffer,
      metadata,
    );
    const fullMetadata: FileMetadata = { ...metadata, tokenEstimate };
    const blobId = crypto.randomUUID();

    try {
      await this.mappingModel.create({
        _id: blobId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        sessionId: session._id,
        projectId,
        phase: session.metadata.phase,
        attachmentId: uploadResult.attachmentId,
        name: file.name,
        mediaType: canonicalMimeType,
        size: buffer.length,
        contentHash,
        metadata: fullMetadata,
        status: 'active',
      });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        const raceWinner = await this.mappingModel
          .findOne({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            sessionId: session._id,
            attachmentId: uploadResult.attachmentId,
          })
          .lean();
        if (raceWinner) {
          return {
            blobId: raceWinner._id,
            metadata: raceWinner.metadata as FileMetadata,
            tokenCost: raceWinner.metadata.tokenEstimate,
            collision: false,
          };
        }
      }
      throw error;
    }

    return {
      blobId,
      metadata: fullMetadata,
      tokenCost: tokenEstimate,
      collision: false,
    };
  }

  async hasBlobId(ctx: SessionContext, sessionId: string, blobId: string): Promise<boolean> {
    const existing = await this.mappingModel.exists({
      _id: blobId,
      sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      status: { $ne: 'deleted' },
    });
    return existing !== null;
  }

  async findBlobForUser(
    ctx: SessionContext,
    blobId: string,
  ): Promise<IArchSessionAttachment | null> {
    return this.mappingModel
      .findOne({
        _id: blobId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: { $ne: 'deleted' },
      })
      .lean();
  }

  async getByBlobId(
    ctx: SessionContext,
    sessionId: string,
    blobId: string,
  ): Promise<SessionFileRecord> {
    const mapping = await this.mappingModel
      .findOne({
        _id: blobId,
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: { $ne: 'deleted' },
      })
      .lean();

    if (!mapping) {
      throw new FileNotFoundError(blobId);
    }

    const piiPolicy = await this.resolvePIIPolicy(mapping.tenantId, mapping.projectId);
    return this.hydrateRecord(mapping, piiPolicy, 'content');
  }

  async getActiveFiles(ctx: SessionContext, sessionId: string): Promise<SessionFileRecord[]> {
    const mappings = await this.mappingModel
      .find({
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: 'active',
      })
      .sort({ createdAt: 1 })
      .lean();

    const piiPolicyCache = new Map<string, Promise<'redact' | 'block' | 'allow'>>();
    const getPIIPolicy = (projectId: string): Promise<'redact' | 'block' | 'allow'> => {
      const cached = piiPolicyCache.get(projectId);
      if (cached) {
        return cached;
      }

      const pendingPolicy = this.resolvePIIPolicy(ctx.tenantId, projectId);
      piiPolicyCache.set(projectId, pendingPolicy);
      return pendingPolicy;
    };

    const records = await Promise.all(
      mappings.map(async (mapping) =>
        this.hydrateRecord(mapping, await getPIIPolicy(mapping.projectId), 'metadata'),
      ),
    );
    return records;
  }

  async updateStatus(
    ctx: SessionContext,
    sessionId: string,
    blobId: string,
    status: IArchSessionAttachment['status'],
  ): Promise<IArchSessionAttachment> {
    const doc = await this.mappingModel.findOneAndUpdate(
      {
        _id: blobId,
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: { $ne: 'deleted' },
      },
      { $set: { status } },
      { new: true },
    );

    if (!doc) {
      throw new FileNotFoundError(blobId);
    }

    log.info('Attachment status updated', { sessionId, blobId, status });
    return doc;
  }

  async markFailed(ctx: SessionContext, sessionId: string, blobId: string): Promise<void> {
    await this.mappingModel.findOneAndUpdate(
      {
        _id: blobId,
        sessionId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        status: { $ne: 'deleted' },
      },
      { $set: { status: 'failed' } },
      { new: true },
    );
  }

  async downloadBlobContent(
    ctx: SessionContext,
    blobId: string,
    opts?: { disposition?: 'inline' | 'attachment' },
  ): Promise<{
    attachment: IAttachment;
    mapping: IArchSessionAttachment;
    buffer: Buffer;
    contentType: string;
  } | null> {
    const mapping = await this.findBlobForUser(ctx, blobId);
    if (!mapping) {
      return null;
    }

    const attachment = await this.client.getAttachment(mapping.attachmentId, ctx.tenantId);
    if (!attachment) {
      return null;
    }

    if (attachment.scanStatus === 'infected') {
      return null;
    }

    const content = await this.client.downloadContent(mapping.attachmentId, ctx.tenantId, opts);
    if (!content) {
      return null;
    }

    return {
      attachment,
      mapping,
      buffer: content.buffer,
      contentType: content.contentType,
    };
  }

  private async hydrateRecord(
    mapping: IArchSessionAttachment,
    piiPolicy?: 'redact' | 'block' | 'allow',
    imageHydrationMode: ImageHydrationMode = 'metadata',
  ): Promise<SessionFileRecord> {
    const attachment = await this.client.getAttachment(mapping.attachmentId, mapping.tenantId);
    const resolvedPIIPolicy =
      piiPolicy ?? (await this.resolvePIIPolicy(mapping.tenantId, mapping.projectId));
    return mapAttachmentToSessionFileRecord(
      mapping,
      attachment,
      resolvedPIIPolicy,
      this.client,
      imageHydrationMode,
    );
  }

  private async resolvePIIPolicy(
    tenantId: string,
    projectId: string,
  ): Promise<'redact' | 'block' | 'allow'> {
    const config = await resolveArchAttachmentConfig(tenantId, projectId);
    return config.piiPolicy;
  }

  private async getSessionTotalSize(ctx: SessionContext, sessionId: string): Promise<number> {
    const result = await this.mappingModel.aggregate<{ total: number }>([
      {
        $match: {
          sessionId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          status: { $ne: 'deleted' },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$size' },
        },
      },
    ]);

    return result.length > 0 ? result[0].total : 0;
  }
}

export class HybridArchFileStore implements ArchFileStore {
  constructor(
    private readonly legacyStore: FileStoreService,
    private readonly attachmentStore: ArchAttachmentFileStore,
  ) {}

  async getByBlobId(
    ctx: SessionContext,
    sessionId: string,
    blobId: string,
  ): Promise<SessionFileRecord> {
    if (await this.attachmentStore.hasBlobId(ctx, sessionId, blobId)) {
      return this.attachmentStore.getByBlobId(ctx, sessionId, blobId);
    }
    return this.legacyStore.getByBlobId(ctx, sessionId, blobId);
  }

  async getActiveFiles(ctx: SessionContext, sessionId: string): Promise<SessionFileRecord[]> {
    const [legacyFiles, attachmentFiles] = await Promise.all([
      this.legacyStore.getActiveFiles(ctx, sessionId),
      this.attachmentStore.getActiveFiles(ctx, sessionId),
    ]);

    return [...attachmentFiles, ...legacyFiles].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
  }

  async markFailed(ctx: SessionContext, sessionId: string, blobId: string): Promise<void> {
    if (await this.attachmentStore.hasBlobId(ctx, sessionId, blobId)) {
      await this.attachmentStore.markFailed(ctx, sessionId, blobId);
      return;
    }
    await this.legacyStore.markFailed(ctx, sessionId, blobId);
  }
}

export function createArchAttachmentFileStore(
  mappingModel: Model<IArchSessionAttachment>,
): ArchAttachmentFileStore {
  return new ArchAttachmentFileStore(mappingModel);
}

export function createHybridArchFileStore(
  legacyStore: FileStoreService,
  attachmentStore: ArchAttachmentFileStore,
): HybridArchFileStore {
  return new HybridArchFileStore(legacyStore, attachmentStore);
}

export function resolveArchAttachmentProjectId(sessionId: string, projectId: string): string {
  return projectId && projectId.trim().length > 0 ? projectId : `arch-session:${sessionId}`;
}

function mapAttachmentToSessionFileRecord(
  mapping: IArchSessionAttachment,
  attachment: IAttachment | null,
  piiPolicy: 'redact' | 'block' | 'allow',
  client: ArchMultimodalServiceClient,
  imageHydrationMode: ImageHydrationMode,
): Promise<SessionFileRecord> | SessionFileRecord {
  const baseRecord: SessionFileRecord = {
    _id: mapping._id,
    name: mapping.name,
    mediaType: mapping.mediaType,
    size: mapping.size,
    content: Buffer.alloc(0),
    metadata: {
      width: mapping.metadata.width,
      height: mapping.metadata.height,
      tokenEstimate: mapping.metadata.tokenEstimate,
    },
    status: normalizeStatus(mapping.status),
    createdAt: mapping.createdAt,
    resolvedText: null,
    imageSource: null,
    unavailableReason: null,
  };

  if (mapping.status === 'failed') {
    return {
      ...baseRecord,
      status: 'failed',
      unavailableReason: 'Attachment marked failed for this session',
    };
  }

  if (!attachment) {
    return {
      ...baseRecord,
      status: 'failed',
      unavailableReason: 'Attachment metadata is unavailable',
    };
  }

  if (attachment.category === 'image') {
    return hydrateImageRecord(baseRecord, attachment, mapping, client, imageHydrationMode);
  }

  return hydrateTextRecord(baseRecord, attachment, piiPolicy);
}

async function hydrateImageRecord(
  baseRecord: SessionFileRecord,
  attachment: IAttachment,
  mapping: IArchSessionAttachment,
  client: ArchMultimodalServiceClient,
  imageHydrationMode: ImageHydrationMode,
): Promise<SessionFileRecord> {
  if (attachment.scanStatus === 'infected') {
    return {
      ...baseRecord,
      status: 'blocked',
      unavailableReason: 'Security scan failed',
    };
  }

  if (attachment.scanStatus === 'pending' || attachment.scanStatus === 'error') {
    return {
      ...baseRecord,
      status: 'processing',
      unavailableReason: 'Security scan is still running',
    };
  }

  if (imageHydrationMode === 'metadata') {
    return {
      ...baseRecord,
      status: 'active',
    };
  }

  const content = await client.downloadContent(mapping.attachmentId, mapping.tenantId, {
    disposition: 'inline',
  });

  if (!content) {
    return {
      ...baseRecord,
      status: 'processing',
      unavailableReason: 'Image content is not available yet',
    };
  }

  return {
    ...baseRecord,
    status: 'active',
    content: content.buffer,
    imageSource: {
      type: 'base64',
      data: content.buffer.toString('base64'),
      mediaType: content.contentType || mapping.mediaType,
    },
  };
}

function hydrateTextRecord(
  baseRecord: SessionFileRecord,
  attachment: IAttachment,
  piiPolicy: 'redact' | 'block' | 'allow',
): SessionFileRecord {
  const resolvedText = renderAttachmentText(attachment, piiPolicy, baseRecord.name);
  return {
    ...baseRecord,
    status: deriveAttachmentRecordStatus(attachment),
    content: Buffer.from(resolvedText, 'utf-8'),
    resolvedText,
    unavailableReason: resolvedText.startsWith('[') ? resolvedText : null,
  };
}

function renderAttachmentText(
  attachment: IAttachment,
  piiPolicy: 'redact' | 'block' | 'allow',
  fileName: string,
): string {
  const safeName = sanitizeFilename(fileName);

  if (attachment.scanStatus === 'infected') {
    return `[File blocked: ${safeName} — security scan failed]`;
  }
  if (attachment.scanStatus === 'pending' || attachment.scanStatus === 'error') {
    return `[File unavailable: ${safeName} — security scan incomplete]`;
  }

  if (attachment.processingStatus === 'processing' || attachment.processingStatus === 'pending') {
    return `[File still processing: ${safeName}]`;
  }

  if (attachment.processingStatus === 'failed') {
    const detail = attachment.processingError ?? 'Unknown error';
    return `[Failed to process: ${safeName} — ${detail}]`;
  }

  if (attachment.processingStatus === 'skipped') {
    return `[Unsupported file: ${safeName}]`;
  }

  const content = applyPIIPolicy(attachment, piiPolicy, safeName);
  if (!content) {
    return `[File unavailable: ${safeName}]`;
  }

  return content;
}

function applyPIIPolicy(
  attachment: IAttachment,
  policy: 'redact' | 'block' | 'allow',
  safeName: string,
): string | null {
  const content = truncateContent(attachment.processedContent);
  if (!content) {
    return null;
  }

  if (!attachment.hasPII) {
    return content;
  }

  switch (policy) {
    case 'allow':
      return content;
    case 'block':
      return '[File contains PII and cannot be processed]';
    case 'redact': {
      const detections = attachment.piiDetections ?? [];
      if (detections.length === 0) {
        log.info('attachment marked PII without detections; returning raw truncated content', {
          attachmentId: attachment._id,
          filename: safeName,
        });
        return content;
      }

      let redacted = content;
      const sorted = [...detections].sort((left, right) => right.start - left.start);
      for (const detection of sorted) {
        if (
          detection.start < 0 ||
          detection.end > redacted.length ||
          detection.start >= detection.end
        ) {
          continue;
        }

        const actualValue = redacted.substring(detection.start, detection.end);
        if (actualValue === detection.value || detection.value.startsWith('[REDACTED')) {
          redacted =
            redacted.substring(0, detection.start) +
            `[REDACTED:${detection.type}]` +
            redacted.substring(detection.end);
        }
      }
      return redacted;
    }
    default:
      return content;
  }
}

function truncateContent(content: string | null): string | null {
  if (!content) {
    return null;
  }
  if (content.length <= MAX_FILE_CONTENT_CHARS) {
    return content;
  }
  return `${content.slice(0, MAX_FILE_CONTENT_CHARS)}\n[... truncated]`;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n\t]/g, ' ').trim();
}

function deriveAttachmentRecordStatus(attachment: IAttachment): FileStatus {
  if (attachment.scanStatus === 'infected') {
    return 'blocked';
  }
  if (attachment.scanStatus === 'pending' || attachment.scanStatus === 'error') {
    return 'processing';
  }
  if (attachment.processingStatus === 'failed') {
    return 'failed';
  }
  if (attachment.processingStatus === 'pending' || attachment.processingStatus === 'processing') {
    return 'processing';
  }
  return 'active';
}

function normalizeStatus(status: string): FileStatus {
  if (
    status === 'active' ||
    status === 'excluded' ||
    status === 'evicted' ||
    status === 'deleted'
  ) {
    return status;
  }
  return 'failed';
}

function computeSHA256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeMimeTypeForExtraction(mimeType: string): string {
  return EXTRACTION_MIME_OVERRIDES[mimeType] ?? mimeType;
}

function classifyFileType(mediaType: string): string {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType === 'application/pdf') return 'pdf';
  if (mediaType === 'text/csv' || mediaType === 'application/csv') return 'csv';
  if (
    mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mediaType === 'application/msword'
  )
    return 'docx';
  if (
    mediaType === 'application/json' ||
    mediaType === 'application/x-yaml' ||
    mediaType === 'text/yaml'
  )
    return 'openapi';
  if (
    mediaType.startsWith('text/') ||
    mediaType === 'application/javascript' ||
    mediaType === 'application/typescript'
  )
    return 'code';
  return 'unknown';
}

function buildMetadata(buffer: Buffer, mediaType: string): Omit<FileMetadata, 'tokenEstimate'> {
  const metadata: Omit<FileMetadata, 'tokenEstimate'> = {};
  const fileType = classifyFileType(mediaType);

  switch (fileType) {
    case 'image': {
      const dims = extractImageDimensions(buffer, mediaType);
      metadata.width = dims.width;
      metadata.height = dims.height;
      break;
    }
    case 'pdf': {
      const text = buffer.toString('latin1');
      const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g);
      metadata.pageCount = pageMatches ? pageMatches.length : 1;
      break;
    }
    case 'csv': {
      const text = buffer.toString('utf-8');
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      metadata.rowCount = Math.max(0, lines.length - 1);
      if (lines.length > 0) {
        metadata.columns = lines[0].split(',').map((column) => column.trim().replace(/^"|"$/g, ''));
      }
      metadata.lineCount = lines.length;
      break;
    }
    case 'code': {
      metadata.lineCount = countTextLines(buffer);
      const snippet = buffer.subarray(0, 500).toString('utf-8');
      if (snippet.includes('import ') || snippet.includes('export ')) {
        metadata.language = 'typescript';
      } else if (snippet.includes('def ') || snippet.includes('import ')) {
        metadata.language = 'python';
      }
      break;
    }
    case 'openapi': {
      const text = buffer.toString('utf-8');
      const pathMatches = text.match(/["']?\/([\w{}/.-]+)["']?\s*:/g);
      metadata.endpointCount = pathMatches ? pathMatches.length : 0;
      break;
    }
    default:
      if (mediaType.startsWith('text/')) {
        metadata.lineCount = countTextLines(buffer);
      }
      break;
  }

  return metadata;
}

function computeTokenEstimate(
  fileType: string,
  buffer: Buffer,
  metadata: Omit<FileMetadata, 'tokenEstimate'>,
): number {
  switch (fileType) {
    case 'image': {
      const width = metadata.width ?? 800;
      const height = metadata.height ?? 600;
      return Math.ceil((width * height) / 750);
    }
    case 'pdf': {
      const pages = metadata.pageCount ?? 1;
      return pages * 1500;
    }
    default:
      return Math.ceil(buffer.length / 4);
  }
}

function extractImageDimensions(
  buffer: Buffer,
  mediaType: string,
): { width: number; height: number } {
  try {
    if (mediaType === 'image/png' && buffer.length >= 24) {
      return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
      };
    }
    if (mediaType === 'image/gif' && buffer.length >= 10) {
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8),
      };
    }
    if (mediaType === 'image/jpeg' && buffer.length >= 4) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        const segmentLength = buffer.readUInt16BE(offset + 2);
        offset += 2 + segmentLength;
      }
    }
  } catch {
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

function countTextLines(buffer: Buffer): number {
  let count = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] === 0x0a) {
      count++;
    }
  }
  return count > 0 ? count : 1;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function buildUploadConfig(
  config: Awaited<ReturnType<typeof resolveArchAttachmentConfig>>,
): AttachmentConfig {
  const allowedMimeTypes = Array.from(
    new Set([...config.allowedMimeTypes, ...ARCH_AI_FILES.ACCEPTED_UPLOAD_MIME_TYPES]),
  );

  return {
    enabled: config.enabled,
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxAttachmentsPerMessage: ARCH_AI_FILES.MAX_FILES,
    maxAttachmentsPerSession: config.maxFilesPerSession,
    maxTotalStorageBytesPerTenant: 1024 * 1024 * 1024,
    allowedCategories: ['image', 'document', 'audio', 'video'],
    retentionDays: {
      image: 90,
      document: 90,
      audio: 90,
      video: 90,
    },
    allowedMimeTypes,
    quotas: {
      maxUploadsPerMinute: 60,
      maxConcurrentProcessingJobs: 10,
    },
  };
}
