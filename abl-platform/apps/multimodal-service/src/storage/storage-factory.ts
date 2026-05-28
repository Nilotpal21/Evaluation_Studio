/**
 * Storage Provider Factory — returns the correct {@link StorageProvider}
 * implementation based on configuration.
 *
 * Currently supports:
 * - `'local'`  — Filesystem-based storage (dev/test).
 * - `'s3'`     — AWS S3.
 * - `'minio'`  — MinIO (S3-compatible, uses {@link S3StorageProvider}).
 *
 * Additional providers (`gcs`, `azure_blob`, `gridfs`) will be added in
 * later tasks.
 */

import type { StorageProvider } from '@agent-platform/shared';
import { LocalStorageProvider } from './local-storage.js';
import { S3StorageProvider } from './s3-storage.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default basePath for the local storage provider when none is configured. */
const DEFAULT_LOCAL_BASE_PATH = './attachments';

/** Default AWS region when none is configured for S3/MinIO. */
const DEFAULT_S3_REGION = 'us-east-1';

// =============================================================================
// TYPES
// =============================================================================

export interface StorageProviderConfig {
  /** Which storage backend to use. */
  provider: 's3' | 'gcs' | 'azure_blob' | 'minio' | 'gridfs' | 'local';

  /** Bucket / container name (required for cloud providers). */
  bucket: string;

  /** AWS region (S3/MinIO). Defaults to 'us-east-1'. */
  region?: string;

  /** Custom endpoint URL for S3-compatible storage (e.g. MinIO). */
  endpoint?: string;

  /** AWS access key ID. */
  accessKeyId?: string;

  /** AWS secret access key. */
  secretAccessKey?: string;

  /** Connection string (for future providers like GridFS). */
  connectionString?: string;

  /** Base filesystem path for local provider. Defaults to './attachments'. */
  basePath?: string;
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create a {@link StorageProvider} instance from a config object.
 *
 * @throws {Error} If the configured `provider` is not yet supported.
 */
export function createStorageProvider(config: StorageProviderConfig): StorageProvider {
  switch (config.provider) {
    case 'local':
      return new LocalStorageProvider({
        basePath: config.basePath ?? DEFAULT_LOCAL_BASE_PATH,
      });

    case 's3':
    case 'minio':
      return new S3StorageProvider({
        bucket: config.bucket,
        region: config.region ?? DEFAULT_S3_REGION,
        endpoint: config.endpoint,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      });

    default:
      throw new Error(
        `Unsupported storage provider: ${config.provider}. Supported: local, s3, minio`,
      );
  }
}
