/**
 * Shared S3 Storage Service
 *
 * Reusable S3 upload/download utilities for the platform.
 * Used by: search-ai (document images/screenshots), studio (archives), etc.
 *
 * Features:
 * - Multipart upload for large files
 * - Server-side encryption (AES256 or KMS)
 * - Tenant-scoped paths
 * - Presigned URLs for downloads
 * - Automatic content type detection
 */

import crypto from 'crypto';

// AWS SDK types (dynamically imported for lazy loading)
type S3Client = any;
type PutObjectCommand = any;
type GetObjectCommand = any;
type HeadObjectCommand = any;
type DeleteObjectCommand = any;

export interface S3StorageConfig {
  bucket: string;
  region?: string;
  encryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  /** Custom endpoint URL for S3-compatible storage (e.g. MinIO). */
  endpoint?: string;
  /** Explicit AWS credentials (overrides default credential chain). */
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  encryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  /** URL-encoded S3 object tags (e.g. "key=value&key2=value2"). Used to attach
   * lifecycle classification tags (e.g. expiry-class=temporary-attachment). */
  tagging?: string;
}

export interface UploadResult {
  key: string;
  url: string;
  sizeBytes: number;
  etag: string;
}

/**
 * S3 Storage Service
 *
 * Provides S3 upload/download functionality with sensible defaults.
 * Lazy-loads AWS SDK for better startup performance.
 */
export class S3StorageService {
  private client: S3Client | null = null;
  private config: S3StorageConfig;

  constructor(config: S3StorageConfig) {
    this.config = config;
  }

  /**
   * Upload a file to S3
   *
   * Supports both Buffer and Stream for flexibility.
   * Automatically uses multipart upload for large files (>5MB).
   *
   * @param key - S3 object key (path)
   * @param data - File data (Buffer or Stream)
   * @param options - Upload options (content type, metadata, encryption)
   * @returns Upload result with key, URL, size, and etag
   */
  async upload(
    key: string,
    data: Buffer | NodeJS.ReadableStream,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const client = await this.getClient();

    try {
      // For large files, use multipart upload
      const isLarge = Buffer.isBuffer(data) && data.length > 5 * 1024 * 1024;

      if (isLarge || !Buffer.isBuffer(data)) {
        return await this.multipartUpload(key, data, options);
      }

      // For small files, use simple put
      return await this.putObject(key, data, options);
    } catch (error) {
      console.error(`[S3Storage] Upload failed for ${key}:`, error);
      throw new Error(
        `S3 upload failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Upload using multipart for large files or streams
   */
  private async multipartUpload(
    key: string,
    data: Buffer | NodeJS.ReadableStream,
    options: UploadOptions,
  ): Promise<UploadResult> {
    const client = await this.getClient();
    const { Upload } = await import('@aws-sdk/lib-storage');

    const uploadParams: any = {
      Bucket: this.config.bucket,
      Key: key,
      Body: data,
      ContentType: options.contentType || this.detectContentType(key),
      Metadata: options.metadata || {},
    };

    // Add encryption
    const encryption = options.encryption || this.config.encryption || 'AES256';
    if (encryption === 'aws:kms') {
      uploadParams.ServerSideEncryption = 'aws:kms';
      uploadParams.SSEKMSKeyId = options.kmsKeyId || this.config.kmsKeyId;
    } else {
      uploadParams.ServerSideEncryption = 'AES256';
    }

    if (options.tagging) {
      uploadParams.Tagging = options.tagging;
    }

    const upload = new Upload({
      client,
      params: uploadParams,
      queueSize: 4,
      partSize: 5 * 1024 * 1024, // 5MB parts
    });

    const result = await upload.done();

    // Get object metadata
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    return {
      key,
      url: `s3://${this.config.bucket}/${key}`,
      sizeBytes: head.ContentLength || 0,
      etag: head.ETag?.replace(/"/g, '') || '',
    };
  }

  /**
   * Upload using simple PutObject (for small files)
   */
  private async putObject(
    key: string,
    data: Buffer,
    options: UploadOptions,
  ): Promise<UploadResult> {
    const client = await this.getClient();
    const { PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');

    const putParams: any = {
      Bucket: this.config.bucket,
      Key: key,
      Body: data,
      ContentType: options.contentType || this.detectContentType(key),
      Metadata: options.metadata || {},
    };

    // Add encryption
    const encryption = options.encryption || this.config.encryption || 'AES256';
    if (encryption === 'aws:kms') {
      putParams.ServerSideEncryption = 'aws:kms';
      putParams.SSEKMSKeyId = options.kmsKeyId || this.config.kmsKeyId;
    } else {
      putParams.ServerSideEncryption = 'AES256';
    }

    if (options.tagging) {
      putParams.Tagging = options.tagging;
    }

    const result = await client.send(new PutObjectCommand(putParams));

    // Get object metadata
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      }),
    );

    return {
      key,
      url: `s3://${this.config.bucket}/${key}`,
      sizeBytes: head.ContentLength || 0,
      etag: result.ETag?.replace(/"/g, '') || '',
    };
  }

  /**
   * Download a file from S3
   *
   * @param key - S3 object key
   * @returns File buffer
   */
  async download(key: string): Promise<Buffer> {
    const client = await this.getClient();

    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const result = await client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }),
      );

      // Convert stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of result.Body as any) {
        chunks.push(Buffer.from(chunk));
      }

      return Buffer.concat(chunks);
    } catch (error) {
      console.error(`[S3Storage] Download failed for ${key}:`, error);
      throw new Error(
        `S3 download failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Generate a presigned download URL
   *
   * @param key - S3 object key
   * @param expiresInSeconds - URL expiration time (default: 1 hour)
   * @returns Presigned URL
   */
  async getDownloadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const client = await this.getClient();

    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

      const command = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });

      return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    } catch (error) {
      console.error(`[S3Storage] Failed to generate presigned URL for ${key}:`, error);
      throw new Error(
        `Failed to generate download URL: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Tenant-validated download URL generation.
   * Verifies the S3 key belongs to the specified tenant before generating a presigned URL.
   */
  async getDownloadUrlForTenant(
    tenantId: string,
    key: string,
    expiresInSeconds = 3600,
  ): Promise<string> {
    this.assertTenantOwnsPath(tenantId, key);
    return this.getDownloadUrl(key, expiresInSeconds);
  }

  /**
   * Delete a file from S3
   *
   * @param key - S3 object key
   */
  async delete(key: string): Promise<void> {
    const client = await this.getClient();

    try {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      await client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }),
      );
    } catch (error) {
      console.error(`[S3Storage] Delete failed for ${key}:`, error);
      throw new Error(
        `S3 delete failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
    }
  }

  /**
   * Tenant-validated delete.
   * Verifies the S3 key belongs to the specified tenant before deleting.
   */
  async deleteForTenant(tenantId: string, key: string): Promise<void> {
    this.assertTenantOwnsPath(tenantId, key);
    return this.delete(key);
  }

  /**
   * Validates that an S3 key belongs to the specified tenant.
   * Expected key formats: `tenants/{tenantId}/...` or `{tenantId}/...`
   */
  private assertTenantOwnsPath(tenantId: string, key: string): void {
    const expectedPrefixes = [`tenants/${tenantId}/`, `${tenantId}/`];
    if (!expectedPrefixes.some((prefix) => key.startsWith(prefix))) {
      throw new Error(
        `Tenant path violation: key "${key}" does not belong to tenant "${tenantId}"`,
      );
    }
  }

  /**
   * Check if an object exists
   *
   * @param key - S3 object key
   * @returns True if object exists
   */
  async exists(key: string): Promise<boolean> {
    const client = await this.getClient();

    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      await client.send(
        new HeadObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }),
      );
      return true;
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Build a tenant-scoped S3 key
   *
   * @param tenantId - Tenant ID
   * @param category - Category (e.g., 'documents', 'images', 'screenshots')
   * @param filename - Filename
   * @returns S3 key with tenant prefix
   */
  static buildKey(tenantId: string, category: string, filename: string): string {
    // Generate unique ID for filename collisions
    const id = crypto.randomBytes(8).toString('hex');
    const timestamp = Date.now();

    return `${tenantId}/${category}/${timestamp}-${id}-${filename}`;
  }

  /**
   * Build a key for document page assets
   *
   * @param tenantId - Tenant ID
   * @param indexId - Index ID
   * @param documentId - Document ID
   * @param pageNumber - Page number
   * @param assetType - Asset type ('screenshot', 'image', etc.)
   * @param extension - File extension
   * @returns S3 key
   */
  static buildPageAssetKey(
    tenantId: string,
    indexId: string,
    documentId: string,
    pageNumber: number,
    assetType: string,
    extension: string,
  ): string {
    return `${tenantId}/search-ai/${indexId}/${documentId}/page-${pageNumber}-${assetType}.${extension}`;
  }

  /**
   * Lazy-load S3 client (for better startup performance)
   */
  private async getClient(): Promise<S3Client> {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const clientConfig: Record<string, unknown> = {
        region: this.config.region || 'us-east-1',
      };
      if (this.config.accessKeyId && this.config.secretAccessKey) {
        clientConfig.credentials = {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        };
      }
      if (this.config.endpoint) {
        clientConfig.endpoint = this.config.endpoint;
        clientConfig.forcePathStyle = true;
      }
      this.client = new S3Client(clientConfig);
    }
    return this.client;
  }

  /**
   * Detect content type from filename
   */
  private detectContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();

    const mimeTypes: Record<string, string> = {
      // Images
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',

      // Documents
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',

      // Text
      txt: 'text/plain',
      html: 'text/html',
      json: 'application/json',
      xml: 'application/xml',

      // Archives
      zip: 'application/zip',
      gz: 'application/gzip',
    };

    return mimeTypes[ext || ''] || 'application/octet-stream';
  }
}

/**
 * Helper: Upload base64 data to S3
 *
 * @param s3Service - S3 service instance
 * @param key - S3 key
 * @param base64Data - Base64 encoded data
 * @param options - Upload options
 * @returns Upload result
 */
export async function uploadBase64ToS3(
  s3Service: S3StorageService,
  key: string,
  base64Data: string,
  options: UploadOptions = {},
): Promise<UploadResult> {
  const buffer = Buffer.from(base64Data, 'base64');
  return await s3Service.upload(key, buffer, options);
}

/**
 * Helper: Download from S3 URL (s3://bucket/key format)
 *
 * @param s3Service - S3 service instance
 * @param s3Url - S3 URL (s3://bucket/key)
 * @returns File buffer
 */
export async function downloadFromS3Url(
  s3Service: S3StorageService,
  s3Url: string,
): Promise<Buffer> {
  // Parse s3://bucket/key
  const match = s3Url.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid S3 URL: ${s3Url}`);
  }

  const [, bucket, key] = match;

  // Validate bucket matches config
  if (bucket !== s3Service['config'].bucket) {
    throw new Error(`Bucket mismatch: expected ${s3Service['config'].bucket}, got ${bucket}`);
  }

  return await s3Service.download(key);
}
