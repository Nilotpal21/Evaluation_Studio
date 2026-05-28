/**
 * AttachmentService - Lifecycle Orchestrator
 *
 * Validates input, checks quotas, streams files to storage, creates the
 * Attachment record in MongoDB, and enqueues a scan job. Does NOT process
 * files — that is handled by the async pipeline.
 *
 * All queries are tenant-scoped: findOne({ _id, tenantId }), never findById().
 * Cross-tenant access returns null (404 at the API layer), never 403.
 */

import { Readable } from 'stream';
import crypto from 'crypto';
import { Attachment, type IAttachment } from '@agent-platform/database';
import type { AttachmentInput, AttachmentConfig, StorageProvider } from '@agent-platform/shared';
import { createLogger } from '@abl/compiler/platform';
import { mimeToCategory } from '../security/mime-validator.js';
import type { AttachmentSearchProducer } from './attachment-search-producer.js';

const log = createLogger('attachment-service');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default page size for list queries */
const DEFAULT_LIST_LIMIT = 50;

/** Maximum page size for list queries */
const MAX_LIST_LIMIT = 200;

/** Storage key segment for original uploads */
const ORIGINAL_SEGMENT = 'original';

// =============================================================================
// TYPES
// =============================================================================

export interface AttachmentServiceDeps {
  storageProvider: StorageProvider;
  scanQueue: { add(name: string, data: Record<string, unknown>): Promise<void> };
  storageBucket: string;
  searchProducer?: AttachmentSearchProducer;
}

export interface UploadResult {
  success: true;
  attachmentId: string;
  status: 'accepted';
}

export interface UploadError {
  success: false;
  error: { code: string; message: string };
}

export interface AttachmentDownloadResult {
  attachment: IAttachment;
  body: Readable;
  contentType: string;
  sizeBytes: number;
}

/** Processing mode for attachment pipeline control */
export type ProcessingMode = 'full' | 'scan-only' | 'store-raw';

/** Options for upload that control pipeline behavior */
export interface UploadOptions {
  processingMode?: ProcessingMode;
}

const VALID_PROCESSING_MODES = new Set<string>(['full', 'scan-only', 'store-raw']);

function mimeTypeAllowed(mimeType: string, allowedMimeTypes: string[]): boolean {
  if (allowedMimeTypes.length === 0) {
    return true;
  }

  return allowedMimeTypes.some((allowed) => {
    if (allowed === mimeType) {
      return true;
    }
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -1);
      return mimeType.startsWith(prefix);
    }
    return false;
  });
}

// =============================================================================
// SERVICE
// =============================================================================

export class AttachmentService {
  private readonly storageProvider: StorageProvider;
  private readonly scanQueue: AttachmentServiceDeps['scanQueue'];
  private readonly storageBucket: string;
  private searchProducer?: AttachmentSearchProducer;

  constructor(deps: AttachmentServiceDeps) {
    this.storageProvider = deps.storageProvider;
    this.scanQueue = deps.scanQueue;
    this.storageBucket = deps.storageBucket;
    this.searchProducer = deps.searchProducer;
  }

  // ---------------------------------------------------------------------------
  // upload
  // ---------------------------------------------------------------------------

  async upload(
    input: AttachmentInput,
    config: AttachmentConfig,
    options?: UploadOptions,
  ): Promise<UploadResult | UploadError> {
    // 0. Validate processingMode
    const processingMode: ProcessingMode = options?.processingMode ?? 'full';
    if (!VALID_PROCESSING_MODES.has(processingMode)) {
      return {
        success: false,
        error: {
          code: 'INVALID_PROCESSING_MODE',
          message: `Invalid processing mode '${processingMode}'. Must be one of: full, scan-only, store-raw`,
        },
      };
    }

    // 1. Feature gate
    if (!config.enabled) {
      return {
        success: false,
        error: { code: 'ATTACHMENTS_DISABLED', message: 'Attachment uploads are disabled' },
      };
    }

    // 2. Resolve source metadata
    const { filename, mimeType, sizeBytes, buffer } = await this.resolveSource(input.source);

    // 3. Validate file size
    if (sizeBytes > config.maxFileSizeBytes) {
      return {
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: `File size ${sizeBytes} exceeds maximum ${config.maxFileSizeBytes} bytes`,
        },
      };
    }

    // 4. Validate MIME type
    if (!mimeTypeAllowed(mimeType, config.allowedMimeTypes)) {
      return {
        success: false,
        error: {
          code: 'MIME_TYPE_NOT_ALLOWED',
          message: `MIME type '${mimeType}' is not allowed`,
        },
      };
    }

    // 5. Determine category
    const category = mimeToCategory(mimeType);
    if (!category) {
      return {
        success: false,
        error: {
          code: 'UNRECOGNIZED_CATEGORY',
          message: `Cannot determine category for MIME type '${mimeType}'`,
        },
      };
    }

    // 6. Validate category
    if (!config.allowedCategories.includes(category)) {
      return {
        success: false,
        error: {
          code: 'CATEGORY_NOT_ALLOWED',
          message: `Category '${category}' is not allowed`,
        },
      };
    }

    // 7. Compute content hash (SHA-256)
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');

    // 8. Dedup: reuse an existing attachment only when its backing object still exists.
    // This protects dev/local and recovery scenarios where metadata can outlive local storage.
    const existingCandidates = await Attachment.find({
      tenantId: input.tenantId,
      contentHash,
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    for (const existing of existingCandidates) {
      const exists = await this.storageProvider.exists(existing.storageKey);
      if (exists) {
        return {
          success: true,
          attachmentId: existing._id,
          status: 'accepted',
        };
      }

      log.warn('Skipping stale dedupe candidate with missing storage object', {
        tenantId: input.tenantId,
        attachmentId: existing._id,
        storageKey: existing.storageKey,
      });
    }

    // 9. Generate a server-side storage key (NEVER include user-supplied filename)
    const attachmentId = crypto.randomUUID();
    const storageKey = [
      input.tenantId,
      input.projectId,
      input.sessionId,
      attachmentId,
      ORIGINAL_SEGMENT,
    ].join('/');

    // 10. Upload to storage
    const uploadStream = Readable.from([buffer]);
    await this.storageProvider.upload({
      key: storageKey,
      body: uploadStream,
      contentType: mimeType,
      sizeBytes,
      metadata: {
        tenantId: input.tenantId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        channel: input.channel,
        originalFilename: filename,
      },
    });

    // 11. Compute retention expiry
    const PLATFORM_MAX_RETENTION_DAYS = 365;
    const days = Math.min(
      config.retentionDays[category] || PLATFORM_MAX_RETENTION_DAYS,
      PLATFORM_MAX_RETENTION_DAYS,
    );
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    // 12. Determine pipeline statuses based on processing mode
    const isStoreRaw = processingMode === 'store-raw';
    const initialScanStatus = isStoreRaw ? 'clean' : 'pending';
    const initialProcessingStatus = isStoreRaw ? 'skipped' : 'pending';
    const initialEmbeddingStatus = isStoreRaw ? 'skipped' : 'pending';

    // 13. Create Attachment record
    await Attachment.create({
      _id: attachmentId,
      tenantId: input.tenantId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      messageId: input.messageId ?? null,
      originalFilename: filename,
      mimeType,
      detectedMimeType: null,
      category,
      sizeBytes,
      contentHash,
      storageProvider: this.storageProvider.name,
      storageKey,
      storageBucket: this.storageBucket,
      encrypted: false,
      encryptionKeyVersion: 0,
      processingMode,
      scanStatus: initialScanStatus,
      scanEngine: null,
      scannedAt: null,
      hasPII: false,
      piiDetections: [],
      exifStripped: false,
      processingStatus: initialProcessingStatus,
      processedContent: null,
      processedContentHash: null,
      processingError: null,
      processingEngine: null,
      processedAt: null,
      resizedStorageKey: null,
      resizedSizeBytes: null,
      thumbnailStorageKey: null,
      imageDescription: null,
      imageDescriptionModel: null,
      searchIndexId: null,
      searchDocumentId: null,
      embeddingStatus: initialEmbeddingStatus,
      embeddedAt: null,
      expiresAt,
    });

    // 14. Enqueue scan job (skip for store-raw mode)
    if (!isStoreRaw) {
      await this.scanQueue.add('scan', {
        attachmentId,
        tenantId: input.tenantId,
      });
    }

    return { success: true, attachmentId, status: 'accepted' };
  }

  // ---------------------------------------------------------------------------
  // getAttachment
  // ---------------------------------------------------------------------------

  async getAttachment(id: string, tenantId: string): Promise<IAttachment | null> {
    return Attachment.findOne({ _id: id, tenantId }).lean();
  }

  // ---------------------------------------------------------------------------
  // downloadAttachmentContent
  // ---------------------------------------------------------------------------

  async downloadAttachmentContent(
    id: string,
    tenantId: string,
    opts?: { variant?: string },
  ): Promise<AttachmentDownloadResult | null> {
    const attachment = await this.getAttachment(id, tenantId);
    if (!attachment) {
      return null;
    }

    const effectiveKey =
      opts?.variant === 'resized' && attachment.resizedStorageKey
        ? attachment.resizedStorageKey
        : attachment.storageKey;

    const download = await this.storageProvider.download(effectiveKey);

    return {
      attachment,
      body: download.body,
      contentType: download.contentType,
      sizeBytes: download.sizeBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // downloadFrameContent
  // ---------------------------------------------------------------------------

  async downloadFrameContent(
    id: string,
    tenantId: string,
    frameIndex: number,
  ): Promise<AttachmentDownloadResult | null> {
    const attachment = await this.getAttachment(id, tenantId);
    if (!attachment) return null;
    if (attachment.category !== 'video') return null;

    const frameKeys = attachment.frameStorageKeys;
    if (!frameKeys || frameIndex < 0 || frameIndex >= frameKeys.length) return null;

    const download = await this.storageProvider.download(frameKeys[frameIndex]!);
    return {
      attachment,
      body: download.body,
      contentType: download.contentType ?? 'image/png',
      sizeBytes: download.sizeBytes,
    };
  }

  // ---------------------------------------------------------------------------
  // updateAttachment (for pipeline workers and test harnesses)
  // ---------------------------------------------------------------------------

  async updateAttachment(
    id: string,
    tenantId: string,
    updates: Partial<
      Pick<
        IAttachment,
        | 'processedContent'
        | 'processedContentHash'
        | 'processingStatus'
        | 'processingError'
        | 'processingEngine'
        | 'processedAt'
        | 'scanStatus'
        | 'scanEngine'
        | 'scannedAt'
        | 'hasPII'
        | 'piiDetections'
        | 'embeddingStatus'
        | 'embeddedAt'
        | 'imageDescription'
        | 'imageDescriptionModel'
      >
    >,
  ): Promise<IAttachment | null> {
    return Attachment.findOneAndUpdate(
      { _id: id, tenantId },
      { $set: updates },
      { new: true, lean: true },
    );
  }

  // ---------------------------------------------------------------------------
  // listBySession
  // ---------------------------------------------------------------------------

  async listBySession(
    sessionId: string,
    tenantId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<IAttachment[]> {
    const limit = Math.min(opts?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = opts?.offset ?? 0;

    return Attachment.find({ sessionId, tenantId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(offset)
      .lean();
  }

  // ---------------------------------------------------------------------------
  // deleteAttachment
  // ---------------------------------------------------------------------------

  async deleteAttachment(id: string, tenantId: string): Promise<void> {
    const attachment = await Attachment.findOne({ _id: id, tenantId }).lean();
    if (!attachment) {
      return;
    }

    // Delete the Attachment record first (authoritative source of truth).
    // If storage cleanup fails after this, we avoid dangling DB references.
    await Attachment.deleteOne({ _id: id, tenantId });

    // Best-effort storage cleanup (parallel)
    const storageKeys = [attachment.storageKey];
    if (attachment.resizedStorageKey) storageKeys.push(attachment.resizedStorageKey);
    if (attachment.thumbnailStorageKey) storageKeys.push(attachment.thumbnailStorageKey);
    if (attachment.frameStorageKeys?.length) {
      storageKeys.push(...attachment.frameStorageKeys);
    }

    const cleanupPromises: Promise<unknown>[] = storageKeys.map((key) =>
      this.storageProvider.delete(key).catch((err) => {
        log.warn('Storage cleanup failed during delete', {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );

    // Search index cleanup (best-effort)
    if (this.searchProducer && (attachment.searchIndexId || attachment.searchDocumentId)) {
      cleanupPromises.push(
        this.searchProducer.remove(attachment).catch((err) => {
          log.warn('Search cleanup failed during delete', {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    await Promise.allSettled(cleanupPromises);
  }

  // ---------------------------------------------------------------------------
  // deleteBySession
  // ---------------------------------------------------------------------------

  async deleteBySession(sessionId: string, tenantId: string): Promise<void> {
    // Find all attachments to determine storage prefix
    const attachments = await Attachment.find({ sessionId, tenantId }).lean();

    if (attachments.length === 0) {
      return;
    }

    // Search index cleanup (best-effort, parallel)
    if (this.searchProducer) {
      const searchCleanups = attachments
        .filter((a: IAttachment) => a.searchIndexId || a.searchDocumentId)
        .map((a: IAttachment) => this.searchProducer!.remove(a));
      if (searchCleanups.length > 0) {
        const results = await Promise.allSettled(searchCleanups);
        for (const result of results) {
          if (result.status === 'rejected') {
            log.warn('Search cleanup failed during session delete', {
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        }
      }
    }

    // All attachments in a session share the prefix {tenantId}/{projectId}/{sessionId}/
    const first = attachments[0]!;
    const prefix = `${first.tenantId}/${first.projectId}/${first.sessionId}/`;

    // Delete all storage files under the session prefix
    await this.storageProvider.deleteMany(prefix);

    // Delete all Attachment records
    await Attachment.deleteMany({ sessionId, tenantId });
  }

  // ---------------------------------------------------------------------------
  // getSignedUrl
  // ---------------------------------------------------------------------------

  async getSignedUrl(
    storageKey: string,
    opts: { expiresInSeconds: number; disposition?: 'inline' | 'attachment'; filename?: string },
  ): Promise<string> {
    return this.storageProvider.getSignedUrl(storageKey, opts);
  }

  // ---------------------------------------------------------------------------
  // retryProcessing
  // ---------------------------------------------------------------------------

  async retryProcessing(
    id: string,
    tenantId: string,
  ): Promise<
    | { success: true; retryCount: number }
    | { success: false; error: { code: string; message: string } }
  > {
    const attachment = await Attachment.findOne({ _id: id, tenantId }).lean();
    if (!attachment) {
      return {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Attachment not found' },
      };
    }

    if (attachment.processingStatus !== 'failed' && attachment.scanStatus !== 'error') {
      return {
        success: false,
        error: {
          code: 'NOT_FAILED',
          message: 'Attachment processing has not failed',
        },
      };
    }

    const maxRetries = 3;
    const currentRetryCount = (attachment as IAttachment & { retryCount?: number }).retryCount ?? 0;
    if (currentRetryCount >= maxRetries) {
      return {
        success: false,
        error: {
          code: 'MAX_RETRIES_EXCEEDED',
          message: 'Maximum retry attempts reached',
        },
      };
    }

    const newRetryCount = currentRetryCount + 1;

    // Determine which pipeline stage to re-enqueue at
    if (attachment.scanStatus === 'error') {
      // Re-enqueue at scan stage
      await Attachment.findOneAndUpdate(
        { _id: id, tenantId },
        {
          scanStatus: 'pending',
          processingStatus: 'pending',
          processingError: null,
          retryCount: newRetryCount,
        },
      );

      await this.scanQueue.add('scan', {
        attachmentId: id,
        tenantId,
      });
    } else {
      // Re-enqueue at processing stage (scan already passed)
      await Attachment.findOneAndUpdate(
        { _id: id, tenantId },
        {
          processingStatus: 'pending',
          processingError: null,
          retryCount: newRetryCount,
        },
      );

      await this.scanQueue.add('process', {
        attachmentId: id,
        tenantId,
      });
    }

    return { success: true, retryCount: newRetryCount };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async resolveSource(
    source: AttachmentInput['source'],
  ): Promise<{ filename: string; mimeType: string; sizeBytes: number; buffer: Buffer }> {
    switch (source.type) {
      case 'stream': {
        const chunks: Buffer[] = [];
        for await (const chunk of source.stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks);
        return {
          filename: source.filename,
          mimeType: source.mimeType,
          sizeBytes: buffer.length,
          buffer,
        };
      }

      case 'base64': {
        const buffer = Buffer.from(source.data, 'base64');
        return {
          filename: source.filename,
          mimeType: source.mimeType,
          sizeBytes: buffer.length,
          buffer,
        };
      }

      case 'url': {
        // URL source resolution is a stub — full implementation requires
        // SSRF validation and HTTP fetch which belong in a separate method.
        // For now, we reject URL sources until the fetch pipeline is built.
        throw new Error('URL source type is not yet implemented');
      }

      default: {
        const _exhaustive: never = source;
        throw new Error(`Unknown source type: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }
}
