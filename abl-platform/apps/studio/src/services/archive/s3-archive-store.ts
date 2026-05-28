/**
 * S3 Archive Store
 *
 * Production archive storage using AWS S3.
 * Features: multipart upload, SSE encryption, tenant-scoped paths,
 * regional bucket selection for data residency, presigned download URLs.
 */

import crypto from 'crypto';
import path from 'path';
import type { ArchiveManifest, ArchiveStore } from './archive-types';

// AWS SDK types (dynamically imported)
type S3Client = any;

export interface S3ArchiveConfig {
  defaultBucket: string;
  regionBuckets?: Record<string, string>; // region → bucket mapping
  encryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  region?: string;
}

export class S3ArchiveStore implements ArchiveStore {
  private client: S3Client | null = null;
  private config: S3ArchiveConfig;

  constructor(config: S3ArchiveConfig) {
    this.config = config;
  }

  async upload(
    tenantId: string,
    type: ArchiveManifest['type'],
    data: Buffer | NodeJS.ReadableStream,
    metadata: { recordCount: number; checksum: string },
  ): Promise<{ path: string; sizeBytes: number; region?: string }> {
    const client = await this.getClient();
    const now = new Date();
    const key = this.buildKey(tenantId, type, now);
    const bucket = this.getBucket(tenantId);

    try {
      const { Upload } = await import('@aws-sdk/lib-storage');

      const uploadParams: any = {
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'application/gzip',
        ContentEncoding: 'gzip',
        Metadata: {
          'x-tenant-id': tenantId,
          'x-archive-type': type,
          'x-record-count': String(metadata.recordCount),
          'x-checksum': metadata.checksum,
          'x-created-at': now.toISOString(),
        },
      };

      // Add encryption
      if (this.config.encryption === 'aws:kms' && this.config.kmsKeyId) {
        uploadParams.ServerSideEncryption = 'aws:kms';
        uploadParams.SSEKMSKeyId = this.config.kmsKeyId;
      } else {
        uploadParams.ServerSideEncryption = 'AES256';
      }

      const upload = new Upload({
        client,
        params: uploadParams,
        queueSize: 4,
        partSize: 5 * 1024 * 1024, // 5MB parts
      });

      const result = await upload.done();

      // Get object size
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));

      return {
        path: key,
        sizeBytes: head.ContentLength || 0,
        region: this.config.region,
      };
    } catch (error) {
      console.error(`[Archive] S3 upload failed for ${key}:`, error);
      throw error;
    }
  }

  async list(
    tenantId: string,
    options?: { type?: ArchiveManifest['type']; limit?: number; cursor?: string },
  ): Promise<{ archives: ArchiveManifest[]; nextCursor?: string }> {
    const client = await this.getClient();
    const bucket = this.getBucket(tenantId);
    const prefix = options?.type
      ? `${tenantId}/archives/${options.type}/`
      : `${tenantId}/archives/`;

    try {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: options?.limit || 50,
          ContinuationToken: options?.cursor,
        }),
      );

      const archives: ArchiveManifest[] = (result.Contents || []).map((obj: any) => ({
        id: crypto.createHash('sha256').update(obj.Key).digest('hex').slice(0, 16),
        tenantId,
        type: this.parseType(obj.Key),
        recordCount: 0, // Would need HEAD request for full metadata
        sizeBytes: obj.Size || 0,
        format: 'ndjson.gz' as const,
        path: obj.Key,
        region: this.config.region,
        checksum: obj.ETag?.replace(/"/g, '') || '',
        createdAt: obj.LastModified || new Date(),
      }));

      return {
        archives,
        nextCursor: result.NextContinuationToken,
      };
    } catch (error) {
      console.error(`[Archive] S3 list failed for ${prefix}:`, error);
      throw error;
    }
  }

  async getDownloadUrl(path: string, expiresInSeconds = 3600): Promise<string> {
    const client = await this.getClient();
    const bucket = this.config.defaultBucket;

    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const command = new GetObjectCommand({ Bucket: bucket, Key: path });
      return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    } catch (error) {
      console.error(`[Archive] Failed to generate presigned URL for ${path}:`, error);
      throw error;
    }
  }

  /**
   * Tenant-validated download URL generation.
   * Verifies the S3 path belongs to the specified tenant before generating a presigned URL.
   */
  async getDownloadUrlForTenant(
    tenantId: string,
    path: string,
    expiresInSeconds = 3600,
  ): Promise<string> {
    this.assertTenantOwnsPath(tenantId, path);
    return this.getDownloadUrl(path, expiresInSeconds);
  }

  async delete(path: string): Promise<void> {
    const client = await this.getClient();
    const bucket = this.config.defaultBucket;

    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
    } catch (error) {
      console.error(`[Archive] S3 delete failed for ${path}:`, error);
      throw error;
    }
  }

  /**
   * Tenant-validated delete.
   * Verifies the S3 path belongs to the specified tenant before deleting.
   */
  async deleteForTenant(tenantId: string, path: string): Promise<void> {
    this.assertTenantOwnsPath(tenantId, path);
    return this.delete(path);
  }

  /**
   * Validates that an S3 path belongs to the specified tenant.
   * Supports canonical `{tenantId}/...` paths plus legacy prefixes while
   * rejecting traversal-like segments in manifest-provided keys.
   */
  private assertTenantOwnsPath(tenantId: string, archivePath: string): void {
    const normalizedPath = path.posix.normalize(archivePath.replace(/\\/g, '/'));
    const expectedPrefixes = [`tenants/${tenantId}/`, `${tenantId}/`, `archives/${tenantId}/`];
    if (
      normalizedPath === '.' ||
      normalizedPath.startsWith('../') ||
      normalizedPath.includes('/../') ||
      normalizedPath.startsWith('/') ||
      !expectedPrefixes.some((prefix) => normalizedPath.startsWith(prefix))
    ) {
      throw new Error(
        `Tenant path violation: path "${archivePath}" does not belong to tenant "${tenantId}"`,
      );
    }
  }

  private async getClient(): Promise<S3Client> {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({ region: this.config.region || 'us-east-1' });
    }
    return this.client;
  }

  private getBucket(tenantId: string): string {
    // TODO: Look up tenant's data residency region and map to regional bucket
    return this.config.defaultBucket;
  }

  private buildKey(tenantId: string, type: string, date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const id = crypto.randomBytes(8).toString('hex');
    return `${tenantId}/archives/${type}/${year}/${month}/${day}-${id}.ndjson.gz`;
  }

  private parseType(key: string): ArchiveManifest['type'] {
    if (key.includes('/sessions/')) return 'sessions';
    if (key.includes('/traces/')) return 'traces';
    if (key.includes('/audit_logs/')) return 'audit_logs';
    return 'sessions';
  }
}
