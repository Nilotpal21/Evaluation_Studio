/**
 * S3StorageProvider — AWS S3 implementation of {@link StorageProvider}.
 *
 * - Uses `@aws-sdk/client-s3` v3 for all S3 operations.
 * - SSE-S3 (AES256) encryption by default; SSE-KMS when `encryption.keyId` provided.
 * - `getSignedUrl` clamps `expiresInSeconds` to 7 days (S3 maximum).
 * - `deleteMany` paginates `ListObjectsV2` by prefix, then batch-deletes.
 * - Content-Type and metadata stored as S3 object metadata.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type {
  S3ClientConfig,
  PutObjectCommandInput,
  GetObjectCommandInput,
  ListObjectsV2CommandInput,
  ServerSideEncryption,
} from '@aws-sdk/client-s3';
import { getSignedUrl as s3GetSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'stream';
import type { StorageProvider } from '@agent-platform/shared';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('s3-storage');

// =============================================================================
// CONSTANTS
// =============================================================================

/** S3 maximum presigned URL expiry: 7 days in seconds. */
const MAX_PRESIGNED_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 604800

/** S3 maximum objects per DeleteObjects request. */
const MAX_DELETE_BATCH_SIZE = 1000;

/** Default SSE algorithm when no custom encryption key is provided. */
const DEFAULT_SSE_ALGORITHM: ServerSideEncryption = 'AES256';

/** Default content type when S3 response omits ContentType. */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** Default size when S3 response omits ContentLength. */
const DEFAULT_SIZE_BYTES = 0;

/** S3 error names that indicate a missing object. */
const NOT_FOUND_ERROR_NAMES = new Set(['NotFound', 'NoSuchKey', '404']);

/** HTTP status code for "not found" responses. */
const HTTP_NOT_FOUND = 404;

// =============================================================================
// TYPES
// =============================================================================

export interface S3StorageProviderOptions {
  /** S3 bucket name. */
  bucket: string;

  /** AWS region (e.g. 'us-east-1'). */
  region: string;

  /** AWS access key ID — omit to use default credential chain. */
  accessKeyId?: string;

  /** AWS secret access key — omit to use default credential chain. */
  secretAccessKey?: string;

  /** Custom endpoint URL for S3-compatible storage (e.g. MinIO). */
  endpoint?: string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;

  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StorageProviderOptions) {
    this.bucket = opts.bucket;

    const clientConfig: S3ClientConfig = {
      region: opts.region,
    };

    if (opts.endpoint) {
      clientConfig.endpoint = opts.endpoint;
      clientConfig.forcePathStyle = true;
    }

    if (opts.accessKeyId && opts.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
      };
    }

    this.client = new S3Client(clientConfig);
  }

  // ---------------------------------------------------------------------------
  // upload
  // ---------------------------------------------------------------------------

  async upload(params: {
    key: string;
    body: Readable;
    contentType: string;
    sizeBytes: number;
    metadata: Record<string, string>;
    encryption?: { algorithm: string; keyId: string };
  }): Promise<{ storageKey: string; etag: string }> {
    const commandInput: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.sizeBytes,
      Metadata: params.metadata,
    };

    // Encryption: SSE-KMS when keyId is provided, SSE-S3 (AES256) otherwise.
    if (params.encryption?.keyId) {
      commandInput.ServerSideEncryption = params.encryption.algorithm as ServerSideEncryption;
      commandInput.SSEKMSKeyId = params.encryption.keyId;
    } else {
      commandInput.ServerSideEncryption = DEFAULT_SSE_ALGORITHM;
    }

    const response = await this.client.send(new PutObjectCommand(commandInput));

    // S3 returns ETag wrapped in double quotes — strip them.
    const rawEtag = response.ETag ?? '';
    const etag = rawEtag.replace(/^"|"$/g, '');

    return { storageKey: params.key, etag };
  }

  // ---------------------------------------------------------------------------
  // download
  // ---------------------------------------------------------------------------

  async download(key: string): Promise<{
    body: Readable;
    contentType: string;
    sizeBytes: number;
  }> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );

    return {
      body: response.Body as Readable,
      contentType: response.ContentType ?? DEFAULT_CONTENT_TYPE,
      sizeBytes: response.ContentLength ?? DEFAULT_SIZE_BYTES,
    };
  }

  // ---------------------------------------------------------------------------
  // getSignedUrl
  // ---------------------------------------------------------------------------

  async getSignedUrl(
    key: string,
    opts: {
      expiresInSeconds: number;
      disposition?: 'inline' | 'attachment';
      filename?: string;
    },
  ): Promise<string> {
    const expiresIn = Math.min(opts.expiresInSeconds, MAX_PRESIGNED_URL_EXPIRY_SECONDS);

    const commandInput: GetObjectCommandInput = {
      Bucket: this.bucket,
      Key: key,
    };

    // Set content-disposition header for the presigned URL.
    if (opts.disposition) {
      let disposition: string = opts.disposition;
      if (opts.disposition === 'attachment' && opts.filename) {
        const safeName = opts.filename.replace(/["\\]/g, '_');
        disposition = `attachment; filename="${safeName}"`;
      }
      commandInput.ResponseContentDisposition = disposition;
    }

    const command = new GetObjectCommand(commandInput);

    return s3GetSignedUrl(this.client, command, { expiresIn });
  }

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // deleteMany
  // ---------------------------------------------------------------------------

  async deleteMany(prefix: string): Promise<{ deletedCount: number }> {
    const keysToDelete: Array<{ Key: string }> = [];
    let continuationToken: string | undefined;

    // Paginate through all objects matching the prefix.
    do {
      const listInput: ListObjectsV2CommandInput = {
        Bucket: this.bucket,
        Prefix: prefix,
      };
      if (continuationToken) {
        listInput.ContinuationToken = continuationToken;
      }

      const listResponse = await this.client.send(new ListObjectsV2Command(listInput));

      if (listResponse.Contents) {
        for (const obj of listResponse.Contents) {
          if (obj.Key) {
            keysToDelete.push({ Key: obj.Key });
          }
        }
      }

      continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
    } while (continuationToken);

    if (keysToDelete.length === 0) {
      return { deletedCount: 0 };
    }

    // Batch delete in chunks of 1000 (S3 API limit).
    for (let i = 0; i < keysToDelete.length; i += MAX_DELETE_BATCH_SIZE) {
      const batch = keysToDelete.slice(i, i + MAX_DELETE_BATCH_SIZE);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch,
            Quiet: true,
          },
        }),
      );
    }

    return { deletedCount: keysToDelete.length };
  }

  // ---------------------------------------------------------------------------
  // exists
  // ---------------------------------------------------------------------------

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (err: unknown) {
      if (isNotFoundError(err)) {
        return false;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // copy
  // ---------------------------------------------------------------------------

  async copy(sourceKey: string, destKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
        Key: destKey,
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // healthCheck
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      const latencyMs = performance.now() - start;
      return { ok: true, latencyMs };
    } catch (err: unknown) {
      const latencyMs = performance.now() - start;
      const error = err instanceof Error ? err.message : 'Unknown error';
      log.error('healthCheck failed', { error });
      return { ok: false, latencyMs };
    }
  }
}

// =============================================================================
// Private helpers
// =============================================================================

/** Shape of S3 service exception $metadata. */
interface S3ErrorMetadata {
  httpStatusCode?: number;
}

/**
 * Determine whether an error represents an S3 "not found" condition.
 * S3 SDK v3 can throw errors with name 'NotFound', 'NoSuchKey', or
 * with $metadata.httpStatusCode === 404.
 */
function isNotFoundError(err: unknown): boolean {
  if (err instanceof Error) {
    if (NOT_FOUND_ERROR_NAMES.has(err.name)) {
      return true;
    }
    // Check for $metadata.httpStatusCode on S3 service exceptions.
    const errWithMeta = err as Error & { $metadata?: S3ErrorMetadata };
    if (errWithMeta.$metadata?.httpStatusCode === HTTP_NOT_FOUND) {
      return true;
    }
  }
  return false;
}
