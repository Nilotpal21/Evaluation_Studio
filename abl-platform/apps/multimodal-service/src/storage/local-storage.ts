/**
 * LocalStorageProvider — Filesystem-based storage for dev/test environments.
 *
 * Implements {@link StorageProvider} using the local filesystem.
 * - All I/O uses `fs.promises` (async only — never sync).
 * - Nested directories are created on demand (`{ recursive: true }`).
 * - Metadata (contentType) stored in a `.meta.json` sidecar file.
 * - `getSignedUrl()` returns a `file://` URI (dev only — not for production).
 * - `etag` is the SHA-256 hex digest of the uploaded content.
 */

import { createHash } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { PassThrough, Readable } from 'stream';
import type { StorageProvider } from '@agent-platform/shared';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('local-storage');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Suffix appended to every storage key to form the metadata sidecar path. */
const META_SUFFIX = '.meta.json';

/** Hash algorithm used for etag computation. */
const ETAG_HASH_ALGORITHM = 'sha256';

/** Encoding used when writing/reading the etag hex digest. */
const ETAG_HASH_ENCODING = 'hex' as const;

/** Filename used by healthCheck to verify basePath is writable. */
const HEALTH_CHECK_FILENAME = '.health-check';

// =============================================================================
// TYPES
// =============================================================================

export interface LocalStorageProviderOptions {
  /** Root directory under which all files are stored. */
  basePath: string;
}

/** Shape of the JSON sidecar stored alongside each file. */
interface FileMeta {
  contentType: string;
  sizeBytes: number;
  metadata: Record<string, string>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;
  private readonly basePath: string;

  constructor(opts: LocalStorageProviderOptions) {
    this.basePath = opts.basePath;
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
    const filePath = this.resolvePath(params.key);
    const metaPath = filePath + META_SUFFIX;

    // Ensure parent directories exist.
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Stream content to disk while computing SHA-256 hash.
    const hash = createHash(ETAG_HASH_ALGORITHM);
    const passThrough = new PassThrough();

    passThrough.on('data', (chunk: Buffer) => {
      hash.update(chunk);
    });

    params.body.pipe(passThrough);

    const writeStream = createWriteStream(filePath);
    await pipeline(passThrough, writeStream);

    const etag = hash.digest(ETAG_HASH_ENCODING);

    // Write metadata sidecar.
    const meta: FileMeta = {
      contentType: params.contentType,
      sizeBytes: params.sizeBytes,
      metadata: params.metadata,
    };
    await fs.writeFile(metaPath, JSON.stringify(meta));

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
    const filePath = this.resolvePath(key);
    const metaPath = filePath + META_SUFFIX;

    // Read metadata sidecar (also validates existence).
    const metaRaw = await fs.readFile(metaPath, 'utf-8');
    const meta: FileMeta = JSON.parse(metaRaw);

    // Get actual file size from stat.
    const stat = await fs.stat(filePath);

    const body = createReadStream(filePath) as unknown as Readable;

    return {
      body,
      contentType: meta.contentType,
      sizeBytes: stat.size,
    };
  }

  // ---------------------------------------------------------------------------
  // getSignedUrl
  // ---------------------------------------------------------------------------

  async getSignedUrl(
    key: string,
    _opts: {
      expiresInSeconds: number;
      disposition?: 'inline' | 'attachment';
      filename?: string;
    },
  ): Promise<string> {
    const filePath = this.resolvePath(key);
    return `file://${filePath}`;
  }

  // ---------------------------------------------------------------------------
  // delete
  // ---------------------------------------------------------------------------

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    const metaPath = filePath + META_SUFFIX;

    await fs.rm(filePath, { force: true });
    await fs.rm(metaPath, { force: true });
  }

  // ---------------------------------------------------------------------------
  // deleteMany
  // ---------------------------------------------------------------------------

  async deleteMany(prefix: string): Promise<{ deletedCount: number }> {
    const prefixDir = this.resolvePath(prefix);
    let deletedCount = 0;

    // The prefix may point to a directory (e.g. "a/") or a partial filename.
    // Walk the resolved directory tree and delete files whose resolved key
    // starts with the prefix.
    const baseDirForWalk = prefix.endsWith('/') ? prefixDir : path.dirname(prefixDir);

    const files = await this.walkDir(baseDirForWalk);

    for (const absPath of files) {
      // Skip sidecar files — they are deleted alongside their data file.
      if (absPath.endsWith(META_SUFFIX)) {
        continue;
      }

      const relKey = path.relative(this.basePath, absPath);
      if (relKey.startsWith(prefix)) {
        await fs.rm(absPath, { force: true });
        await fs.rm(absPath + META_SUFFIX, { force: true });
        deletedCount++;
      }
    }

    return { deletedCount };
  }

  // ---------------------------------------------------------------------------
  // exists
  // ---------------------------------------------------------------------------

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolvePath(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // copy
  // ---------------------------------------------------------------------------

  async copy(sourceKey: string, destKey: string): Promise<void> {
    const srcPath = this.resolvePath(sourceKey);
    const destPath = this.resolvePath(destKey);
    const srcMetaPath = srcPath + META_SUFFIX;
    const destMetaPath = destPath + META_SUFFIX;

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(srcPath, destPath);
    await fs.copyFile(srcMetaPath, destMetaPath);
  }

  // ---------------------------------------------------------------------------
  // healthCheck
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = performance.now();
    try {
      await fs.mkdir(this.basePath, { recursive: true });
      const probePath = path.join(this.basePath, HEALTH_CHECK_FILENAME);
      await fs.writeFile(probePath, '');
      await fs.rm(probePath, { force: true });
      const latencyMs = performance.now() - start;
      return { ok: true, latencyMs };
    } catch (err: unknown) {
      const latencyMs = performance.now() - start;
      const error = err instanceof Error ? err.message : 'Unknown error';
      log.error('healthCheck failed', { error });
      return { ok: false, latencyMs };
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Resolve a storage key to an absolute filesystem path, with traversal guard. */
  private resolvePath(key: string): string {
    const resolved = path.resolve(this.basePath, key);
    const base = path.resolve(this.basePath);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error(`Path traversal detected: key "${key}" resolves outside base path`);
    }
    return resolved;
  }

  /** Recursively walk a directory and return all file paths. */
  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];

    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      // Directory does not exist — nothing to walk.
      return results;
    }

    for (const name of names) {
      const fullPath = path.join(dir, name);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        const nested = await this.walkDir(fullPath);
        results.push(...nested);
      } else {
        results.push(fullPath);
      }
    }

    return results;
  }
}
