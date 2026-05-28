/**
 * Tests for archive service and local archive store
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { LocalArchiveStore } from '../services/archive/local-archive-store';
import type { ArchiveManifest } from '../services/archive/archive-types';
import { expectRejectedMessage } from './helpers/expect-rejected-message';

describe('LocalArchiveStore', () => {
  let tempDir: string;
  let store: LocalArchiveStore;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
    store = new LocalArchiveStore(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('upload creates gzipped file', async () => {
    const data = Buffer.from('{"id":"1"}\n{"id":"2"}\n');
    const metadata = {
      recordCount: 2,
      checksum: 'abc123',
    };

    const result = await store.upload('tenant-1', 'sessions', data, metadata);

    expect(result.path).toMatch(/tenant-1\/archives\/sessions\/\d{4}\/\d{2}\/.+\.ndjson\.gz$/);
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Verify file exists and is gzipped
    const fullPath = path.join(tempDir, result.path);
    expect(fs.existsSync(fullPath)).toBe(true);

    // Decompress and verify content
    const gunzip = createGunzip();
    const input = fs.createReadStream(fullPath);
    const chunks: Buffer[] = [];

    await pipeline(input, gunzip, async function* (source) {
      for await (const chunk of source) {
        chunks.push(chunk);
      }
    });

    const decompressed = Buffer.concat(chunks).toString();
    expect(decompressed).toBe('{"id":"1"}\n{"id":"2"}\n');
  });

  test('upload creates sidecar manifest JSON', async () => {
    const data = Buffer.from('{"id":"1"}\n');
    const metadata = {
      recordCount: 1,
      checksum: 'def456',
    };

    const result = await store.upload('tenant-1', 'traces', data, metadata);

    // Check manifest file exists
    const manifestPath = path.join(tempDir, result.path.replace('.ndjson.gz', '.manifest.json'));
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Verify manifest content
    const manifestContent = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    expect(manifestContent).toMatchObject({
      tenantId: 'tenant-1',
      type: 'traces',
      recordCount: 1,
      checksum: 'def456',
      createdAt: expect.any(String),
    });
  });

  test('list returns archives', async () => {
    // Upload a couple of archives
    const data1 = Buffer.from('{"id":"1"}\n');
    const data2 = Buffer.from('{"id":"2"}\n');
    const metadata = { recordCount: 1, checksum: 'test' };

    await store.upload('tenant-1', 'sessions', data1, metadata);
    await store.upload('tenant-1', 'sessions', data2, metadata);

    const result = await store.list('tenant-1', { type: 'sessions' });

    expect(result.archives).toHaveLength(2);
    expect(result.archives[0]).toMatchObject({
      tenantId: 'tenant-1',
      type: 'sessions',
      recordCount: 1,
      format: 'ndjson.gz',
      checksum: 'test',
    });
  });

  test('getDownloadUrl returns absolute path', async () => {
    const data = Buffer.from('test');
    const metadata = { recordCount: 1, checksum: 'test' };

    const { path: archivePath } = await store.upload('tenant-1', 'sessions', data, metadata);

    const downloadUrl = await store.getDownloadUrl(archivePath);

    expect(path.isAbsolute(downloadUrl)).toBe(true);
    expect(downloadUrl).toContain(archivePath);
    expect(fs.existsSync(downloadUrl)).toBe(true);
  });

  test('getDownloadUrlForTenant rejects cross-tenant paths', async () => {
    await expectRejectedMessage(
      store.getDownloadUrlForTenant('tenant-2', 'tenant-1/archives/sessions/file.ndjson.gz'),
      'Tenant path violation',
    );
  });

  test('getDownloadUrlForTenant rejects traversal segments inside a matching tenant prefix', async () => {
    await expectRejectedMessage(
      store.getDownloadUrlForTenant('tenant-1', 'tenant-1/../../outside/file.ndjson.gz'),
      'Invalid archive path',
    );
  });

  test('getDownloadUrlForTenant accepts legacy archives/<tenantId> keys', async () => {
    const legacyPath = path.join('archives', 'tenant-1', 'sessions', 'legacy.ndjson.gz');
    const fullPath = path.join(tempDir, legacyPath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, 'legacy');

    const downloadUrl = await store.getDownloadUrlForTenant('tenant-1', legacyPath);

    expect(downloadUrl).toBe(path.resolve(tempDir, legacyPath));
  });

  test('delete removes file and manifest', async () => {
    const data = Buffer.from('{"id":"1"}\n');
    const metadata = { recordCount: 1, checksum: 'test' };

    const { path: archivePath } = await store.upload('tenant-1', 'sessions', data, metadata);

    const fullPath = path.join(tempDir, archivePath);
    const manifestPath = fullPath.replace('.ndjson.gz', '.manifest.json');

    // Verify files exist
    expect(fs.existsSync(fullPath)).toBe(true);
    expect(fs.existsSync(manifestPath)).toBe(true);

    // Delete
    await store.delete(archivePath);

    // Verify files are removed
    expect(fs.existsSync(fullPath)).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  test('deleteForTenant rejects cross-tenant paths', async () => {
    await expectRejectedMessage(
      store.deleteForTenant('tenant-2', 'tenant-1/archives/sessions/file.ndjson.gz'),
      'Tenant path violation',
    );
  });

  test('deleteForTenant rejects traversal segments inside a matching tenant prefix', async () => {
    await expectRejectedMessage(
      store.deleteForTenant('tenant-1', 'tenant-1/../../outside/file.ndjson.gz'),
      'Invalid archive path',
    );
  });

  test('delete propagates non-ENOENT storage failures', async () => {
    const data = Buffer.from('{"id":"1"}\n');
    const metadata = { recordCount: 1, checksum: 'test' };
    const { path: archivePath } = await store.upload('tenant-1', 'sessions', data, metadata);

    const unlinkSpy = vi
      .spyOn(fs.promises, 'unlink')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expectRejectedMessage(store.delete(archivePath), 'permission denied');
    expect(fs.existsSync(path.join(tempDir, archivePath))).toBe(true);
    unlinkSpy.mockRestore();
  });

  test('list returns empty for non-existent dir', async () => {
    const result = await store.list('non-existent-tenant');

    expect(result.archives).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  test('ArchiveManifest type check - create valid manifest object', () => {
    const manifest: ArchiveManifest = {
      id: 'archive-123',
      tenantId: 'tenant-1',
      type: 'audit_logs',
      recordCount: 100,
      sizeBytes: 1024,
      format: 'ndjson.gz',
      path: 'tenant-1/archives/audit_logs/2026/02/07-abc123.ndjson.gz',
      checksum: 'sha256hash',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000), // 1 day
      region: 'us-east-1',
    };

    // Type assertions
    expect(manifest.type).toBe('audit_logs');
    expect(manifest.format).toBe('ndjson.gz');
    expect(manifest.recordCount).toBe(100);
    expect(manifest.createdAt).toBeInstanceOf(Date);
  });

  test('upload with Buffer data works', async () => {
    const buffer = Buffer.from('{"record":"data"}\n{"record":"more"}\n');
    const metadata = {
      recordCount: 2,
      checksum: 'buffer123',
    };

    const result = await store.upload('tenant-2', 'traces', buffer, metadata);

    expect(result.path).toContain('tenant-2');
    expect(result.path).toContain('traces');
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Verify the file was created and can be read
    const fullPath = path.join(tempDir, result.path);
    expect(fs.existsSync(fullPath)).toBe(true);

    // Verify content
    const gunzip = createGunzip();
    const input = fs.createReadStream(fullPath);
    const chunks: Buffer[] = [];

    await pipeline(input, gunzip, async function* (source) {
      for await (const chunk of source) {
        chunks.push(chunk);
      }
    });

    const decompressed = Buffer.concat(chunks).toString();
    expect(decompressed).toBe('{"record":"data"}\n{"record":"more"}\n');
  });

  test('list supports pagination with cursor', async () => {
    // Upload multiple archives
    const metadata = { recordCount: 1, checksum: 'test' };
    for (let i = 0; i < 5; i++) {
      await store.upload('tenant-1', 'sessions', Buffer.from(`{"id":"${i}"}\n`), metadata);
    }

    // Get first page with limit
    const page1 = await store.list('tenant-1', { type: 'sessions', limit: 2 });
    expect(page1.archives).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    // Get second page
    const page2 = await store.list('tenant-1', {
      type: 'sessions',
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.archives).toHaveLength(2);
    expect(page2.nextCursor).toBeDefined();

    // Get last page
    const page3 = await store.list('tenant-1', {
      type: 'sessions',
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.archives).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
  });
});
