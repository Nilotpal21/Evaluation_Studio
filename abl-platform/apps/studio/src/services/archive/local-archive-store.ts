/**
 * Local Archive Store
 *
 * Development/testing archive storage using the local filesystem.
 * Stores gzipped NDJSON files with JSON sidecar manifests.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { ArchiveManifest, ArchiveStore } from './archive-types';

const ARCHIVE_SUFFIX = '.ndjson.gz';
const MANIFEST_SUFFIX = '.manifest.json';
const ENOENT_ERROR_CODE = 'ENOENT';

function getErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }

  return undefined;
}

export class LocalArchiveStore implements ArchiveStore {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
  }

  async upload(
    tenantId: string,
    type: ArchiveManifest['type'],
    data: Buffer | NodeJS.ReadableStream,
    metadata: { recordCount: number; checksum: string },
  ): Promise<{ path: string; sizeBytes: number }> {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const id = crypto.randomBytes(8).toString('hex');
    const relativePath = path.join(
      tenantId,
      'archives',
      type,
      String(year),
      month,
      `${now.getDate()}-${id}${ARCHIVE_SUFFIX}`,
    );
    const fullPath = path.join(this.baseDir, relativePath);

    // Ensure directory exists
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

    // Write gzipped data
    const gzip = createGzip({ level: 6 });
    const output = fs.createWriteStream(fullPath);

    if (Buffer.isBuffer(data)) {
      const readable = Readable.from(data);
      await pipeline(readable, gzip, output);
    } else {
      await pipeline(data as NodeJS.ReadableStream, gzip, output);
    }

    // Get file size
    const stats = await fs.promises.stat(fullPath);

    // Write sidecar manifest
    const manifest = {
      tenantId,
      type,
      recordCount: metadata.recordCount,
      checksum: metadata.checksum,
      createdAt: now.toISOString(),
    };
    await fs.promises.writeFile(
      fullPath.replace(ARCHIVE_SUFFIX, MANIFEST_SUFFIX),
      JSON.stringify(manifest, null, 2),
    );

    return { path: relativePath, sizeBytes: stats.size };
  }

  async list(
    tenantId: string,
    options?: { type?: ArchiveManifest['type']; limit?: number; cursor?: string },
  ): Promise<{ archives: ArchiveManifest[]; nextCursor?: string }> {
    const searchDir = options?.type
      ? path.join(this.baseDir, tenantId, 'archives', options.type)
      : path.join(this.baseDir, tenantId, 'archives');

    const archives: ArchiveManifest[] = [];

    try {
      const files = await this.findFiles(searchDir, '.ndjson.gz');
      const limit = options?.limit || 50;
      const offset = options?.cursor ? parseInt(options.cursor, 10) : 0;
      const sliced = files.slice(offset, offset + limit);

      for (const filePath of sliced) {
        const stats = await fs.promises.stat(filePath);
        const relativePath = path.relative(this.baseDir, filePath);

        // Try to load sidecar manifest
        let manifest: any = {};
        try {
          const manifestPath = filePath.replace(ARCHIVE_SUFFIX, MANIFEST_SUFFIX);
          manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
        } catch {
          // No manifest
        }

        archives.push({
          id: crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 16),
          tenantId,
          type: manifest.type || this.parseType(relativePath),
          recordCount: manifest.recordCount || 0,
          sizeBytes: stats.size,
          format: 'ndjson.gz',
          path: relativePath,
          checksum: manifest.checksum || '',
          createdAt: stats.mtime,
        });
      }

      const nextOffset = offset + limit;
      return {
        archives,
        nextCursor: nextOffset < files.length ? String(nextOffset) : undefined,
      };
    } catch {
      return { archives: [] };
    }
  }

  async getDownloadUrl(archivePath: string, _expiresInSeconds?: number): Promise<string> {
    return this.resolveArchivePath(archivePath);
  }

  async getDownloadUrlForTenant(
    tenantId: string,
    archivePath: string,
    _expiresInSeconds?: number,
  ): Promise<string> {
    this.assertTenantOwnsPath(tenantId, archivePath);
    return this.getDownloadUrl(archivePath);
  }

  async delete(archivePath: string): Promise<void> {
    const fullPath = this.resolveArchivePath(archivePath);
    await this.unlinkIfExists(fullPath);
    await this.unlinkIfExists(fullPath.replace(ARCHIVE_SUFFIX, MANIFEST_SUFFIX));
  }

  async deleteForTenant(tenantId: string, archivePath: string): Promise<void> {
    this.assertTenantOwnsPath(tenantId, archivePath);
    await this.delete(archivePath);
  }

  private assertTenantOwnsPath(tenantId: string, archivePath: string): void {
    const normalizedPath = this.normalizeArchivePath(archivePath);
    const tenantRoots = [
      path.posix.join('tenants', tenantId),
      tenantId,
      path.posix.join('archives', tenantId),
    ];
    const matchingRoot = tenantRoots.find(
      (tenantRoot) => normalizedPath === tenantRoot || normalizedPath.startsWith(`${tenantRoot}/`),
    );

    if (!matchingRoot) {
      throw new Error(
        `Tenant path violation: path "${archivePath}" does not belong to tenant "${tenantId}"`,
      );
    }

    const tenantRootPath = path.resolve(this.baseDir, matchingRoot);
    const fullPath = this.resolveArchivePath(normalizedPath);
    const relativeToTenantRoot = path.relative(tenantRootPath, fullPath);

    if (
      relativeToTenantRoot === '' ||
      relativeToTenantRoot === '.' ||
      relativeToTenantRoot.startsWith('..') ||
      path.isAbsolute(relativeToTenantRoot)
    ) {
      throw new Error(
        `Tenant path violation: path "${archivePath}" does not belong to tenant "${tenantId}"`,
      );
    }
  }

  private normalizeArchivePath(archivePath: string): string {
    const normalizedPath = path.posix.normalize(archivePath.replace(/\\/g, '/'));
    if (
      normalizedPath === '.' ||
      normalizedPath.startsWith('../') ||
      normalizedPath.includes('/../') ||
      normalizedPath.startsWith('/')
    ) {
      throw new Error(`Invalid archive path: "${archivePath}"`);
    }

    return normalizedPath;
  }

  private resolveArchivePath(archivePath: string): string {
    const normalizedPath = this.normalizeArchivePath(archivePath);
    const fullPath = path.resolve(this.baseDir, normalizedPath);
    const relativeToBase = path.relative(this.baseDir, fullPath);

    if (
      relativeToBase === '' ||
      relativeToBase === '.' ||
      relativeToBase.startsWith('..') ||
      path.isAbsolute(relativeToBase)
    ) {
      throw new Error(`Invalid archive path: "${archivePath}"`);
    }

    return fullPath;
  }

  private async unlinkIfExists(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (getErrorCode(error) === ENOENT_ERROR_CODE) {
        return;
      }

      throw error;
    }
  }

  private async findFiles(dir: string, ext: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await this.findFiles(fullPath, ext)));
        } else if (entry.name.endsWith(ext)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Directory doesn't exist
    }
    return results.sort().reverse(); // Newest first
  }

  private parseType(filePath: string): ArchiveManifest['type'] {
    if (filePath.includes('/sessions/')) return 'sessions';
    if (filePath.includes('/traces/')) return 'traces';
    if (filePath.includes('/audit_logs/')) return 'audit_logs';
    return 'sessions';
  }
}
