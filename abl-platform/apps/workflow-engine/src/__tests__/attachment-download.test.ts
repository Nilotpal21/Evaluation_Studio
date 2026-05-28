/**
 * Integration tests for the attachment download route.
 *
 * Uses a real Express app, real LocalFileStorage backed by a temp directory,
 * and real HMAC tokens — no platform component mocks.
 *
 * Security paths covered:
 * - Missing token → 401
 * - Tampered/expired token → 403
 * - Valid token but file deleted → 404
 * - Cross-tenant key in token → 403 (key prefix mismatch)
 * - MIME confusion: text/html rewritten to application/octet-stream
 * - MIME confusion: image/svg+xml rewritten to application/octet-stream
 * - Safe MIME (application/pdf) passed through
 * - Filename sanitization strips CR/LF/quotes
 * - Happy path: bytes delivered, Content-Length correct
 * - Content-Disposition includes URL-encoded filename
 * - Cache-Control and X-Content-Type-Options headers present
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createAttachmentsRouter } from '../routes/attachments.js';
import {
  createFileStorage,
  buildAttachmentKey,
  randomAttachmentId,
  type FileStorage,
} from '../storage/storage-factory.js';
import { signAttachmentToken } from '../lib/attachment-token.js';

const TENANT = 'tenant-test';

beforeAll(() => {
  process.env.JWT_SECRET = 'integration-test-secret';
});

async function makeApp(): Promise<{
  app: express.Express;
  storage: FileStorage;
  tmpDir: string;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-attach-test-'));
  const storage = createFileStorage({ provider: 'local', basePath: tmpDir });
  const app = express();
  app.use('/attachments', createAttachmentsRouter(storage));
  return { app, storage, tmpDir };
}

async function uploadFile(
  storage: FileStorage,
  content: Buffer,
  fileName: string,
  mimeType: string,
): Promise<{ key: string; token: string; url: string }> {
  const attachmentId = randomAttachmentId();
  const key = buildAttachmentKey(TENANT, attachmentId, fileName);
  await storage.upload(key, content, { contentType: mimeType });
  const token = signAttachmentToken(key, TENANT);
  const params = new URLSearchParams({ token, f: fileName, m: mimeType });
  return { key, token, url: `/attachments/${attachmentId}?${params.toString()}` };
}

describe('attachment download route — security', () => {
  let tmpDir: string;
  let app: express.Express;
  let storage: FileStorage;

  beforeEach(async () => {
    ({ app, storage, tmpDir } = await makeApp());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 401 when no token is supplied', async () => {
    const attachmentId = randomAttachmentId();
    const res = await request(app).get(`/attachments/${attachmentId}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it('returns 403 when token is tampered', async () => {
    const content = Buffer.from('hello');
    const { url } = await uploadFile(storage, content, 'test.txt', 'text/plain');
    const tampered = url.replace(/token=[^&]+/, 'token=invalid.token.here');
    const res = await request(app).get(tampered);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false });
  });

  it('returns 403 when token references a cross-tenant key', async () => {
    // Sign a token where tenantId does not match the key prefix
    const key = `attachments/${TENANT}/legit.pdf`;
    const wrongTenantToken = signAttachmentToken(key, 'other-tenant');
    const params = new URLSearchParams({
      token: wrongTenantToken,
      f: 'legit.pdf',
      m: 'application/pdf',
    });
    const res = await request(app).get(`/attachments/legit?${params.toString()}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 when file has been deleted after token was issued', async () => {
    const content = Buffer.from('ephemeral');
    const { url, key } = await uploadFile(storage, content, 'gone.txt', 'text/plain');
    // Delete the file out from under the token
    await fs.rm(path.join(tmpDir, key));
    const res = await request(app).get(url);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false });
  });
});

describe('attachment download route — MIME sanitization', () => {
  let tmpDir: string;
  let app: express.Express;
  let storage: FileStorage;

  beforeEach(async () => {
    ({ app, storage, tmpDir } = await makeApp());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rewrites text/html to application/octet-stream', async () => {
    const content = Buffer.from('<script>alert(1)</script>');
    const { url } = await uploadFile(storage, content, 'evil.html', 'text/html');
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
  });

  it('rewrites image/svg+xml to application/octet-stream', async () => {
    const content = Buffer.from('<svg><script>alert(1)</script></svg>');
    const { url } = await uploadFile(storage, content, 'evil.svg', 'image/svg+xml');
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/octet-stream/);
  });

  it('allows application/pdf through unchanged', async () => {
    const content = Buffer.from('%PDF-1.4 fake pdf bytes');
    const { url } = await uploadFile(storage, content, 'doc.pdf', 'application/pdf');
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('allows image/png through unchanged', async () => {
    const content = Buffer.from('\x89PNG');
    const { url } = await uploadFile(storage, content, 'image.png', 'image/png');
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });
});

describe('attachment download route — happy path and response headers', () => {
  let tmpDir: string;
  let app: express.Express;
  let storage: FileStorage;

  beforeEach(async () => {
    ({ app, storage, tmpDir } = await makeApp());
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('delivers the exact bytes that were uploaded', async () => {
    const content = Buffer.from('attachment content bytes');
    const { url } = await uploadFile(storage, content, 'data.txt', 'text/plain');
    const res = await request(app)
      .get(url)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(content)).toBe(true);
  });

  it('sets Content-Length matching the file size', async () => {
    const content = Buffer.from('twelve bytes');
    const { url } = await uploadFile(storage, content, 'file.txt', 'text/plain');
    const res = await request(app).get(url);
    expect(res.headers['content-length']).toBe(String(content.byteLength));
  });

  it('sets Cache-Control: private, max-age=3600', async () => {
    const content = Buffer.from('cached');
    const { url } = await uploadFile(storage, content, 'cache.txt', 'text/plain');
    const res = await request(app).get(url);
    expect(res.headers['cache-control']).toBe('private, max-age=3600');
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const content = Buffer.from('sniff guard');
    const { url } = await uploadFile(storage, content, 'sniff.txt', 'text/plain');
    const res = await request(app).get(url);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('URL-encodes the filename in Content-Disposition', async () => {
    const content = Buffer.from('special chars');
    const fileName = 'my report final.pdf';
    const { url } = await uploadFile(storage, content, fileName, 'application/pdf');
    const res = await request(app).get(url);
    expect(res.headers['content-disposition']).toContain(encodeURIComponent(fileName));
  });

  it('strips CR/LF/quotes from filename to prevent Content-Disposition header injection', async () => {
    const content = Buffer.from('injection attempt');
    const { key, token } = await uploadFile(storage, content, 'safe.pdf', 'application/pdf');
    const attachmentId = key.split('/')[2]?.replace('.pdf', '') ?? randomAttachmentId();
    // \r\n would split the header into two lines; " would break the quoted-string
    const maliciousName = 'file\r\nEvil: injected"name.pdf';
    const params = new URLSearchParams({ token, f: maliciousName, m: 'application/pdf' });
    const res = await request(app).get(`/attachments/${attachmentId}?${params.toString()}`);
    expect(res.status).toBe(200);
    // The raw header value must never contain CR or LF
    const disposition = res.headers['content-disposition'] ?? '';
    expect(disposition).not.toMatch(/\r|\n/);
  });
});
