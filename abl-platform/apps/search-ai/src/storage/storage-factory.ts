/**
 * Storage Provider Factory — returns the correct storage implementation
 * based on configuration.
 *
 * Currently supports:
 * - `'local'`  — Filesystem-based storage (dev/test/NFS).
 * - `'s3'`     — AWS S3.
 * - `'minio'`  — MinIO (S3-compatible, uses S3StorageService).
 *
 * Mirrors the pattern in apps/multimodal-service/src/storage/storage-factory.ts.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { S3StorageService } from '@agent-platform/shared';
import type { SearchAIConfig } from '../config/index.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default AWS region when none is configured for S3/MinIO. */
const DEFAULT_S3_REGION = 'us-east-1';

/** Default local base path when none is configured. */
const DEFAULT_LOCAL_BASE_PATH = './uploads';

// =============================================================================
// TYPES
// =============================================================================

export interface FileUploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  encryption?: 'AES256' | 'aws:kms';
}

export interface FileUploadResult {
  url: string;
  key: string;
  sizeBytes: number;
}

/**
 * Unified file storage interface for SearchAI.
 *
 * Consumers call `upload()` with a Buffer — the implementation handles
 * S3 vs local filesystem transparently.
 */
export interface FileStorage {
  readonly provider: string;

  upload(key: string, data: Buffer, options?: FileUploadOptions): Promise<FileUploadResult>;

  /** Resolved base path (local provider only — used for container path mapping). */
  readonly basePath: string;
}

// =============================================================================
// S3 IMPLEMENTATION
// =============================================================================

class S3FileStorage implements FileStorage {
  readonly provider = 's3' as const;
  readonly basePath = '';
  private readonly s3: S3StorageService;
  private readonly bucket: string;
  private readonly region: string;

  constructor(config: SearchAIConfig['storage']) {
    this.bucket = config.bucket;
    this.region = config.region ?? DEFAULT_S3_REGION;
    this.s3 = new S3StorageService({
      bucket: this.bucket,
      region: this.region,
      endpoint: config.endpoint,
      encryption: 'AES256',
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
  }

  async upload(key: string, data: Buffer, options?: FileUploadOptions): Promise<FileUploadResult> {
    const result = await this.s3.upload(key, data, {
      contentType: options?.contentType,
      metadata: options?.metadata,
    });

    return {
      url: result.url,
      key: result.key,
      sizeBytes: data.length,
    };
  }
}

// =============================================================================
// LOCAL IMPLEMENTATION
// =============================================================================

class LocalFileStorage implements FileStorage {
  readonly provider = 'local' as const;
  readonly basePath: string;

  constructor(config: SearchAIConfig['storage']) {
    this.basePath = path.resolve(config.basePath ?? DEFAULT_LOCAL_BASE_PATH);
  }

  async upload(key: string, data: Buffer, _options?: FileUploadOptions): Promise<FileUploadResult> {
    const filePath = path.resolve(this.basePath, key);

    // Path traversal guard
    if (!filePath.startsWith(this.basePath + path.sep) && filePath !== this.basePath) {
      throw new Error(`Path traversal detected: key "${key}" resolves outside base path`);
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);

    // Return container-relative path for Docker volume mount
    // Docling service expects files at /uploads/...
    const relativePath = path.relative(this.basePath, filePath);
    const url = `/uploads/${relativePath}`;

    return {
      url,
      key: relativePath,
      sizeBytes: data.length,
    };
  }
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a {@link FileStorage} instance from SearchAI config.
 *
 * @throws {Error} If the configured `provider` is not supported.
 */
export function createFileStorage(config: SearchAIConfig['storage']): FileStorage {
  switch (config.provider) {
    case 'local':
      return new LocalFileStorage(config);

    case 's3':
    case 'minio':
      return new S3FileStorage(config);

    default:
      throw new Error(
        `Unsupported storage provider: ${config.provider}. Supported: local, s3, minio`,
      );
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/** Generate a unique filename with timestamp and random suffix. */
export function generateStorageKey(prefix: string, originalName: string): string {
  const ext = originalName.split('.').pop() || 'bin';
  const randomSuffix = crypto.randomBytes(8).toString('hex');
  return `${prefix}/${Date.now()}-${randomSuffix}.${ext}`;
}

/**
 * Read a file from storage (S3, local filesystem, or HTTP URL)
 *
 * @param url - The URL returned from upload() or an absolute path
 * @returns Buffer containing file contents
 */
export async function readFileFromStorage(url: string): Promise<Buffer> {
  const { getConfig } = await import('../config/index.js');
  const config = getConfig();

  // S3 URL (s3://bucket/key format)
  if (url.startsWith('s3://')) {
    const withoutProtocol = url.substring('s3://'.length);
    const slashIdx = withoutProtocol.indexOf('/');
    const bucket = withoutProtocol.substring(0, slashIdx);
    const key = withoutProtocol.substring(slashIdx + 1);

    const s3 = new S3StorageService({
      bucket,
      region: config.storage.region || DEFAULT_S3_REGION,
      endpoint: config.storage.endpoint,
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    });

    return s3.download(key);
  }

  // HTTP/HTTPS URL
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const axios = (await import('axios')).default;
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }

  // Local filesystem path (relative to uploads directory)
  // Format: /uploads/documents/tenant/index/file.ext
  if (url.startsWith('/uploads/') || url.startsWith('uploads/')) {
    const cleanPath = url.startsWith('/') ? url.substring(1) : url;
    const basePath = path.resolve(config.storage.basePath ?? DEFAULT_LOCAL_BASE_PATH);
    const fullPath = path.resolve(basePath, cleanPath.replace('uploads/', ''));

    // Path traversal guard
    if (!fullPath.startsWith(basePath + path.sep) && fullPath !== basePath) {
      throw new Error(`Path traversal detected: ${url}`);
    }

    try {
      return await fs.readFile(fullPath);
    } catch (error) {
      throw new Error(
        `Failed to read file from local storage: ${fullPath} - ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  throw new Error(`Unsupported storage URL format: ${url}`);
}
