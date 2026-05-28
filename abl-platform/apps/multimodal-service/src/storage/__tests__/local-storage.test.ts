import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { StorageProvider } from '@agent-platform/shared';
import { LocalStorageProvider } from '../local-storage.js';

describe('LocalStorageProvider', () => {
  let provider: StorageProvider;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-test-'));
    provider = new LocalStorageProvider({ basePath: tmpDir });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uploads and downloads a file via streams', async () => {
    const content = 'hello world';
    const stream = Readable.from([Buffer.from(content)]);

    const result = await provider.upload({
      key: 'tenant-1/proj-1/sess-1/att-1/original',
      body: stream,
      contentType: 'text/plain',
      sizeBytes: Buffer.byteLength(content),
      metadata: {},
    });

    expect(result.storageKey).toBe('tenant-1/proj-1/sess-1/att-1/original');
    expect(result.etag).toBeDefined();

    const downloaded = await provider.download('tenant-1/proj-1/sess-1/att-1/original');
    expect(downloaded.contentType).toBe('text/plain');

    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.body) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it('deletes a file', async () => {
    const stream = Readable.from([Buffer.from('data')]);
    await provider.upload({
      key: 'test/file',
      body: stream,
      contentType: 'text/plain',
      sizeBytes: 4,
      metadata: {},
    });

    await provider.delete('test/file');
    expect(await provider.exists('test/file')).toBe(false);
  });

  it('checks existence', async () => {
    expect(await provider.exists('nonexistent')).toBe(false);

    const stream = Readable.from([Buffer.from('data')]);
    await provider.upload({
      key: 'exists-test',
      body: stream,
      contentType: 'text/plain',
      sizeBytes: 4,
      metadata: {},
    });

    expect(await provider.exists('exists-test')).toBe(true);
  });

  it('deletes many by prefix', async () => {
    for (const name of ['a/1', 'a/2', 'a/3', 'b/1']) {
      const s = Readable.from([Buffer.from('x')]);
      await provider.upload({
        key: name,
        body: s,
        contentType: 'text/plain',
        sizeBytes: 1,
        metadata: {},
      });
    }

    const result = await provider.deleteMany('a/');
    expect(result.deletedCount).toBe(3);
    expect(await provider.exists('b/1')).toBe(true);
  });

  it('reports health', async () => {
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('copies a file', async () => {
    const content = 'copy me';
    const stream = Readable.from([Buffer.from(content)]);
    await provider.upload({
      key: 'src/original',
      body: stream,
      contentType: 'image/png',
      sizeBytes: Buffer.byteLength(content),
      metadata: {},
    });

    await provider.copy('src/original', 'dest/copied');

    expect(await provider.exists('dest/copied')).toBe(true);

    const downloaded = await provider.download('dest/copied');
    expect(downloaded.contentType).toBe('image/png');

    const chunks: Buffer[] = [];
    for await (const chunk of downloaded.body) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString()).toBe(content);
  });

  it('generates a file:// signed URL', async () => {
    const stream = Readable.from([Buffer.from('url-test')]);
    await provider.upload({
      key: 'url/test-file',
      body: stream,
      contentType: 'text/plain',
      sizeBytes: 8,
      metadata: {},
    });

    const url = await provider.getSignedUrl('url/test-file', {
      expiresInSeconds: 3600,
    });
    expect(url).toMatch(/^file:\/\//);
  });

  it('returns correct sizeBytes on download', async () => {
    const content = 'size check data';
    const stream = Readable.from([Buffer.from(content)]);
    await provider.upload({
      key: 'size/check',
      body: stream,
      contentType: 'text/plain',
      sizeBytes: Buffer.byteLength(content),
      metadata: {},
    });

    const downloaded = await provider.download('size/check');
    expect(downloaded.sizeBytes).toBe(Buffer.byteLength(content));
  });

  it('throws on download of nonexistent key', async () => {
    await expect(provider.download('no/such/key')).rejects.toThrow();
  });

  it('rejects path traversal attempts', async () => {
    const stream = Readable.from([Buffer.from('malicious')]);
    await expect(
      provider.upload({
        key: '../../etc/passwd',
        body: stream,
        contentType: 'text/plain',
        sizeBytes: 9,
        metadata: {},
      }),
    ).rejects.toThrow('Path traversal detected');
  });
});
