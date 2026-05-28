/**
 * File Store Service — B03 Multimodality
 *
 * Stores, deduplicates, and manages file blobs attached to Arch AI sessions.
 * Files are session-scoped, tenant-isolated, and content-addressed (SHA-256).
 *
 * Contract: content-blocks.ts (ArchContentBlock image_ref / file_ref blobId)
 *
 * All queries include tenantId (never findById).
 * Dedup via SHA-256 hash within session scope.
 */

import crypto from 'node:crypto';
import type { Model } from 'mongoose';
import type { ISessionFile } from '@agent-platform/database/models';
import { createLogger } from '@agent-platform/shared-observability';
import {
  FileNotFoundError,
  FileTooLargeError,
  FileCorruptError,
  SessionFileQuotaError,
} from '../types/errors.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SessionContext {
  tenantId: string;
  userId: string;
}

export type FileRecordStatus =
  | 'active'
  | 'excluded'
  | 'evicted'
  | 'deleted'
  | 'failed'
  | 'processing'
  | 'blocked';

export interface ResolvedImageSource {
  type: 'base64' | 'url';
  mediaType: string;
  data?: string;
  url?: string;
}

export interface SessionFileRecord {
  _id: string;
  name: string;
  mediaType: string;
  size: number;
  content: Buffer;
  metadata: {
    width?: number;
    height?: number;
    tokenEstimate: number;
  };
  status: FileRecordStatus;
  createdAt: Date;
  resolvedText?: string | null;
  imageSource?: ResolvedImageSource | null;
  unavailableReason?: string | null;
}

export interface ArchFileStore {
  getByBlobId(ctx: SessionContext, sessionId: string, blobId: string): Promise<SessionFileRecord>;
  getActiveFiles(ctx: SessionContext, sessionId: string): Promise<SessionFileRecord[]>;
  markFailed(ctx: SessionContext, sessionId: string, blobId: string): Promise<void>;
}

interface StoreInput {
  name: string;
  type: string;
  size: number;
  /** Base64-encoded file content */
  content: string;
}

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

interface StoreResult {
  blobId: string;
  metadata: FileMetadata;
  tokenCost: number;
  collision: boolean;
  existingBlobId?: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Per-type processing timeout in milliseconds */
const PROCESSING_TIMEOUTS: Record<string, number> = {
  image: 10_000,
  csv: 10_000,
  code: 5_000,
  docx: 15_000,
  openapi: 15_000,
  pdf: 30_000,
};

const DEFAULT_PROCESSING_TIMEOUT = 10_000;

/** Maximum file size: 10 MB */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum total session file size: 50 MB */
const MAX_SESSION_TOTAL_SIZE = 50 * 1024 * 1024;

/** Magic byte signatures for validation */
const MAGIC_BYTES: Record<string, string> = {
  'image/png': '89504e47',
  'image/jpeg': 'ffd8ff',
  'image/gif': '474946',
  'application/pdf': '25504446',
};

// ─── Logger ─────────────────────────────────────────────────────────────────

const log = createLogger('arch-ai:file-store');

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeSHA256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validateMagicBytes(buffer: Buffer, mediaType: string): boolean {
  const expected = MAGIC_BYTES[mediaType];
  if (!expected) return true; // No magic byte check for this type
  const headerHex = buffer.subarray(0, 4).toString('hex').toLowerCase();
  return headerHex.startsWith(expected);
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

function computeTokenEstimate(
  fileType: string,
  buffer: Buffer,
  metadata: Partial<FileMetadata>,
): number {
  switch (fileType) {
    case 'image': {
      const w = metadata.width ?? 800;
      const h = metadata.height ?? 600;
      return Math.ceil((w * h) / 750);
    }
    case 'pdf': {
      const pages = metadata.pageCount ?? 1;
      return pages * 1500;
    }
    default:
      // Text-based: ~4 characters per token
      return Math.ceil(buffer.length / 4);
  }
}

function extractImageDimensions(
  buffer: Buffer,
  mediaType: string,
): { width: number; height: number } {
  try {
    if (mediaType === 'image/png' && buffer.length >= 24) {
      // PNG: width at bytes 16-19, height at bytes 20-23 (big-endian)
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { width, height };
    }
    if (mediaType === 'image/gif' && buffer.length >= 10) {
      // GIF: width at bytes 6-7, height at bytes 8-9 (little-endian)
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { width, height };
    }
    if (mediaType === 'image/jpeg' && buffer.length >= 4) {
      // JPEG: scan for SOF0/SOF2 marker
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        // SOF0 (0xC0) or SOF2 (0xC2)
        if (marker === 0xc0 || marker === 0xc2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
        // Skip marker segment
        const segLen = buffer.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
  } catch {
    // Dimension extraction is best-effort
  }
  return { width: 0, height: 0 };
}

function countTextLines(buffer: Buffer): number {
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) count++;
  }
  return count > 0 ? count : 1;
}

function getProcessingTimeout(fileType: string): number {
  return PROCESSING_TIMEOUTS[fileType] ?? DEFAULT_PROCESSING_TIMEOUT;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Processing timeout (${label}: ${ms}ms)`)), ms),
    ),
  ]);
}

// ─── Service ────────────────────────────────────────────────────────────────

export class FileStoreService {
  constructor(private readonly model: Model<ISessionFile>) {}

  /**
   * Store a file in the session's file store.
   * Handles dedup (by hash), name collision detection, magic byte validation,
   * and metadata extraction.
   */
  async store(
    ctx: SessionContext,
    sessionId: string,
    file: StoreInput,
    phase: string,
  ): Promise<StoreResult> {
    const buffer = Buffer.from(file.content, 'base64');
    const actualSize = buffer.length;

    // Size check
    if (actualSize > MAX_FILE_SIZE) {
      throw new FileTooLargeError(file.name, actualSize, MAX_FILE_SIZE);
    }

    // Session quota check
    const currentTotal = await this.getSessionTotalSize(ctx, sessionId);
    if (currentTotal + actualSize > MAX_SESSION_TOTAL_SIZE) {
      throw new SessionFileQuotaError(sessionId, currentTotal + actualSize, MAX_SESSION_TOTAL_SIZE);
    }

    const hash = computeSHA256(buffer);
    const fileType = classifyFileType(file.type);
    const timeout = getProcessingTimeout(fileType);

    // SVG rejection — unsanitized SVGs can contain embedded scripts.
    // TODO(B03): Add DOMPurify (isomorphic-dompurify) to sanitize SVGs in a follow-up.
    if (file.type === 'image/svg+xml') {
      throw new FileCorruptError(file.name, 'SVG files require sanitization — support coming soon');
    }

    // Magic byte validation for known types
    if (MAGIC_BYTES[file.type] && !validateMagicBytes(buffer, file.type)) {
      throw new FileCorruptError(file.name, `Magic bytes do not match declared type ${file.type}`);
    }

    // Dedup: same hash in same session -> return existing
    const existingByHash = await this.model.findOne({
      sessionId,
      tenantId: ctx.tenantId,
      hash,
    });

    if (existingByHash) {
      log.info('File dedup hit', {
        sessionId,
        blobId: existingByHash._id,
        hash,
        name: file.name,
      });
      return {
        blobId: existingByHash._id,
        metadata: existingByHash.metadata as FileMetadata,
        tokenCost: existingByHash.metadata.tokenEstimate,
        collision: false,
      };
    }

    // Name collision: same name but different hash
    const existingByName = await this.model.findOne({
      sessionId,
      tenantId: ctx.tenantId,
      name: file.name,
      status: { $ne: 'deleted' },
    });

    if (existingByName) {
      return {
        blobId: existingByName._id,
        metadata: existingByName.metadata as FileMetadata,
        tokenCost: existingByName.metadata.tokenEstimate,
        collision: true,
        existingBlobId: existingByName._id,
      };
    }

    // Build metadata with timeout
    const metadata = await withTimeout(
      this.buildMetadata(buffer, file.type, fileType),
      timeout,
      fileType,
    );

    const tokenEstimate = computeTokenEstimate(fileType, buffer, metadata);
    const fullMetadata: FileMetadata = { ...metadata, tokenEstimate };

    const blobId = crypto.randomUUID();

    await this.model.create({
      _id: blobId,
      sessionId,
      tenantId: ctx.tenantId,
      name: file.name,
      mediaType: file.type,
      size: actualSize,
      hash,
      content: buffer,
      metadata: fullMetadata,
      phase,
      status: 'active',
    });

    log.info('File stored', {
      sessionId,
      blobId,
      name: file.name,
      mediaType: file.type,
      size: actualSize,
      tokenEstimate,
      phase,
    });

    return {
      blobId,
      metadata: fullMetadata,
      tokenCost: tokenEstimate,
      collision: false,
    };
  }

  /**
   * Retrieve a file by blobId, scoped to session + tenant.
   * Throws FileNotFoundError if not found.
   */
  async getByBlobId(ctx: SessionContext, sessionId: string, blobId: string): Promise<ISessionFile> {
    const doc = await this.model.findOne({
      _id: blobId,
      sessionId,
      tenantId: ctx.tenantId,
    });

    if (!doc) {
      throw new FileNotFoundError(blobId);
    }

    return doc;
  }

  /**
   * Get all active files for a session.
   */
  async getActiveFiles(ctx: SessionContext, sessionId: string): Promise<ISessionFile[]> {
    return this.model.find({
      sessionId,
      tenantId: ctx.tenantId,
      status: 'active',
    });
  }

  /**
   * Update the status of a file (active, excluded, evicted, deleted, failed).
   */
  async updateStatus(
    ctx: SessionContext,
    sessionId: string,
    blobId: string,
    status: ISessionFile['status'],
  ): Promise<ISessionFile> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: blobId,
        sessionId,
        tenantId: ctx.tenantId,
      },
      { $set: { status } },
      { new: true },
    );

    if (!doc) {
      throw new FileNotFoundError(blobId);
    }

    log.info('File status updated', { sessionId, blobId, status });
    return doc;
  }

  /**
   * Mark a file as failed. Used when image resolution fails so subsequent
   * resolves skip the file instead of retrying indefinitely.
   */
  async markFailed(ctx: SessionContext, sessionId: string, blobId: string): Promise<void> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: blobId,
        sessionId,
        tenantId: ctx.tenantId,
      },
      { $set: { status: 'failed' } },
      { new: true },
    );

    if (!doc) {
      log.warn('markFailed: file not found (may already be deleted)', {
        sessionId,
        blobId,
      });
      return;
    }

    log.info('File marked as failed', { sessionId, blobId, name: doc.name });
  }

  /**
   * Get total size of non-deleted files in a session.
   */
  async getSessionTotalSize(ctx: SessionContext, sessionId: string): Promise<number> {
    const result = await this.model.aggregate<{ total: number }>([
      {
        $match: {
          sessionId,
          tenantId: ctx.tenantId,
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

  // ─── Private helpers ────────────────────────────────────────────────────

  private async buildMetadata(
    buffer: Buffer,
    mediaType: string,
    fileType: string,
  ): Promise<Partial<FileMetadata>> {
    const metadata: Partial<FileMetadata> = {};

    switch (fileType) {
      case 'image': {
        const dims = extractImageDimensions(buffer, mediaType);
        metadata.width = dims.width;
        metadata.height = dims.height;
        break;
      }
      case 'pdf': {
        // Estimate page count from buffer — look for /Type /Page occurrences
        const text = buffer.toString('latin1');
        const pageMatches = text.match(/\/Type\s*\/Page(?!s)/g);
        metadata.pageCount = pageMatches ? pageMatches.length : 1;
        break;
      }
      case 'csv': {
        const text = buffer.toString('utf-8');
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        metadata.rowCount = Math.max(0, lines.length - 1); // exclude header
        if (lines.length > 0) {
          metadata.columns = lines[0].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        }
        metadata.lineCount = lines.length;
        break;
      }
      case 'code': {
        metadata.lineCount = countTextLines(buffer);
        // Attempt to detect language from common patterns
        const snippet = buffer.subarray(0, 500).toString('utf-8');
        if (snippet.includes('import ') || snippet.includes('export ')) {
          metadata.language = 'typescript';
        } else if (snippet.includes('def ') || snippet.includes('import ')) {
          metadata.language = 'python';
        }
        break;
      }
      case 'openapi': {
        // Count endpoint-like patterns
        const text = buffer.toString('utf-8');
        const pathMatches = text.match(/["']?\/([\w{}/.-]+)["']?\s*:/g);
        metadata.endpointCount = pathMatches ? pathMatches.length : 0;
        break;
      }
      default:
        // Text fallback
        if (mediaType.startsWith('text/')) {
          metadata.lineCount = countTextLines(buffer);
        }
        break;
    }

    return metadata;
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createFileStoreService(model: Model<ISessionFile>): FileStoreService {
  return new FileStoreService(model);
}
