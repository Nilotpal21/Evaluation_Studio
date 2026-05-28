/**
 * Storage Provider Factory — mirrors apps/search-ai/src/storage/storage-factory.ts.
 *
 * Currently supports:
 * - `'local'`  — Filesystem-based storage (dev/test, NFS-backed in cluster).
 * - `'s3'`     — AWS S3.
 * - `'minio'`  — MinIO (S3-compatible, uses S3StorageService).
 *
 * Same interface, same env-var contract, same key-prefix convention as search-ai.
 * Workflow-engine reads/writes connector attachments through this layer.
 */

import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { S3StorageService } from '@agent-platform/shared';
import type { WorkflowEngineStorageConfig } from '../config/storage.js';

const DEFAULT_S3_REGION = 'us-east-1';
const DEFAULT_LOCAL_BASE_PATH = './uploads';

export interface FileUploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  encryption?: 'AES256' | 'aws:kms';
  /** URL-encoded S3 object tags forwarded to S3FileStorage. Ignored by LocalFileStorage. */
  tagging?: string;
}

export interface FileUploadResult {
  url: string;
  key: string;
  sizeBytes: number;
}

/**
 * Unified file storage interface. Buffer-in, URL-out.
 * Caller is responsible for constructing the tenant-prefixed key.
 */
export interface FileStorage {
  readonly provider: string;
  readonly basePath: string;
  upload(key: string, data: Buffer, options?: FileUploadOptions): Promise<FileUploadResult>;
  /** Read a previously-uploaded file by its storage key. */
  download(key: string): Promise<Buffer>;
}

class S3FileStorage implements FileStorage {
  readonly provider = 's3' as const;
  readonly basePath = '';
  private readonly s3: S3StorageService;

  constructor(config: WorkflowEngineStorageConfig) {
    if (!config.bucket) {
      throw new Error('STORAGE_BUCKET is required when STORAGE_PROVIDER is s3 or minio');
    }
    this.s3 = new S3StorageService({
      bucket: config.bucket,
      region: config.region ?? DEFAULT_S3_REGION,
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
      tagging: options?.tagging,
    });
    return { url: result.url, key: result.key, sizeBytes: data.length };
  }

  async download(key: string): Promise<Buffer> {
    return this.s3.download(key);
  }
}

class LocalFileStorage implements FileStorage {
  readonly provider = 'local' as const;
  readonly basePath: string;

  constructor(config: WorkflowEngineStorageConfig) {
    this.basePath = path.resolve(config.basePath ?? DEFAULT_LOCAL_BASE_PATH);
  }

  async upload(key: string, data: Buffer, _options?: FileUploadOptions): Promise<FileUploadResult> {
    const filePath = path.resolve(this.basePath, key);
    if (!filePath.startsWith(this.basePath + path.sep) && filePath !== this.basePath) {
      throw new Error(`Path traversal detected: key "${key}" resolves outside base path`);
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, data);
    const relativePath = path.relative(this.basePath, filePath);
    return { url: `/uploads/${relativePath}`, key: relativePath, sizeBytes: data.length };
  }

  async download(key: string): Promise<Buffer> {
    const filePath = path.resolve(this.basePath, key);
    if (!filePath.startsWith(this.basePath + path.sep) && filePath !== this.basePath) {
      throw new Error(`Path traversal detected: ${key}`);
    }
    return fs.readFile(filePath);
  }
}

export function createFileStorage(config: WorkflowEngineStorageConfig): FileStorage {
  switch (config.provider) {
    case 'local':
      return new LocalFileStorage(config);
    case 's3':
    case 'minio':
      return new S3FileStorage(config);
    default:
      throw new Error(
        `Unsupported storage provider: ${(config as { provider: string }).provider}. Supported: local, s3, minio`,
      );
  }
}

/**
 * Build a tenant-scoped attachment key matching the search-ai convention.
 *
 * All three components are sanitized so a malformed input (programmer error
 * or future schema drift) can never produce a key with `..` or path separators.
 * The traversal guard in upload()/download() catches attacks at the FS layer,
 * but sanitizing here keeps the key itself well-formed.
 */
export function buildAttachmentKey(
  tenantId: string,
  attachmentId: string,
  fileName: string,
): string {
  const safeTenant = tenantId.replace(/[^A-Za-z0-9_-]/g, '');
  const safeId = attachmentId.replace(/[^A-Za-z0-9_-]/g, '');
  const rawExt = fileName.includes('.') ? (fileName.split('.').pop() ?? 'bin') : 'bin';
  const safeExt = rawExt.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'bin';
  return `attachments/${safeTenant}/${safeId}.${safeExt}`;
}

export function randomAttachmentId(): string {
  return crypto.randomUUID();
}
