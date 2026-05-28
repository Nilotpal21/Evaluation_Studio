/**
 * Archive Types
 *
 * Shared types for the archival pipeline.
 * Supports S3 (production) and local filesystem (development).
 */

export interface ArchiveManifest {
  id: string;
  tenantId: string;
  type: 'sessions' | 'traces' | 'audit_logs';
  recordCount: number;
  sizeBytes: number;
  format: 'ndjson.gz';
  path: string; // S3 key or local path
  region?: string; // S3 region for data residency
  checksum: string; // SHA-256 of compressed file
  createdAt: Date;
  expiresAt?: Date; // When archive can be deleted
}

export interface ArchiveStore {
  /** Upload an archive file and return the storage path */
  upload(
    tenantId: string,
    type: ArchiveManifest['type'],
    data: Buffer | NodeJS.ReadableStream,
    metadata: { recordCount: number; checksum: string },
  ): Promise<{ path: string; sizeBytes: number; region?: string }>;

  /** List archives for a tenant */
  list(
    tenantId: string,
    options?: { type?: ArchiveManifest['type']; limit?: number; cursor?: string },
  ): Promise<{ archives: ArchiveManifest[]; nextCursor?: string }>;

  /** Get a download URL (presigned for S3, direct path for local) */
  getDownloadUrl(path: string, expiresInSeconds?: number): Promise<string>;

  /** Get a tenant-validated download URL */
  getDownloadUrlForTenant(
    tenantId: string,
    path: string,
    expiresInSeconds?: number,
  ): Promise<string>;

  /** Delete an archive */
  delete(path: string): Promise<void>;

  /** Delete an archive after verifying tenant ownership */
  deleteForTenant(tenantId: string, path: string): Promise<void>;
}

export interface ArchiveOptions {
  tenantId: string;
  type: ArchiveManifest['type'];
  olderThan?: Date;
  batchSize?: number;
}
