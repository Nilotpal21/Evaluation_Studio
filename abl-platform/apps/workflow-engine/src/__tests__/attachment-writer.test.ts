/**
 * Boundary tests for createFileWriterFactory (data-flow audit Round 2).
 *
 * F-1: S3 attachment expiry — upload must include tagging option so S3 lifecycle
 *      policies can delete temporary attachments after the retention window.
 *
 * F-2: PII in error message — the size-limit error must not contain the fileName
 *      (filenames can encode patient names, financial document labels, etc.).
 */

import { describe, it, expect, vi } from 'vitest';
import { createFileWriterFactory, ATTACHMENT_MAX_BYTES } from '../lib/attachment-writer.js';
import type { FileStorage, FileUploadOptions } from '../storage/storage-factory.js';

function makeStorageSpy(): {
  storage: FileStorage;
  uploadSpy: ReturnType<typeof vi.fn>;
} {
  const uploadSpy = vi.fn().mockResolvedValue({
    url: 'file:///tmp/test',
    key: 'attachments/t1/uuid.pdf',
    sizeBytes: 5,
  });
  const storage: FileStorage = {
    provider: 'local',
    basePath: '/tmp',
    upload: uploadSpy,
    download: vi.fn().mockResolvedValue(Buffer.from('data')),
  };
  return { storage, uploadSpy };
}

describe('createFileWriterFactory — F-1: upload tagging', () => {
  it('passes tagging=expiry-class=temporary-attachment on every upload', async () => {
    const { storage, uploadSpy } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'hmac-token', 'https://wf.example');
    const writer = factory('tenant-1');
    await writer('report.pdf', Buffer.from('pdf bytes'), 'application/pdf');

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    const opts = uploadSpy.mock.calls[0][2] as FileUploadOptions;
    expect(opts.tagging).toBe('expiry-class=temporary-attachment');
  });

  it('includes the correct contentType in upload options', async () => {
    const { storage, uploadSpy } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'hmac-token', 'https://wf.example');
    const writer = factory('tenant-1');
    await writer('image.png', Buffer.from('\x89PNG'), 'image/png');

    const opts = uploadSpy.mock.calls[0][2] as FileUploadOptions;
    expect(opts.contentType).toBe('image/png');
  });
});

describe('createFileWriterFactory — F-2: fileName not in size-limit error', () => {
  it('does not include fileName in the oversized-attachment error message', async () => {
    const { storage } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'tok', 'https://wf.example');
    const writer = factory('tenant-1');

    const oversized = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    const piiFileName = 'Patient_Smith_MRI_2024.pdf';
    await expect(writer(piiFileName, oversized, 'application/pdf')).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(piiFileName),
      }),
    );
  });

  it('error message reports the byte count and MB limit', async () => {
    const { storage } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'tok', 'https://wf.example');
    const writer = factory('tenant-1');

    const oversized = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    await expect(writer('file.bin', oversized, 'application/octet-stream')).rejects.toThrow(
      /exceeds the \d+ MB limit/,
    );
  });

  it('does not call upload when size limit is exceeded', async () => {
    const { storage, uploadSpy } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'tok', 'https://wf.example');
    const writer = factory('tenant-1');

    const oversized = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
    await expect(writer('big.bin', oversized, 'application/octet-stream')).rejects.toThrow();
    expect(uploadSpy).not.toHaveBeenCalled();
  });
});

describe('createFileWriterFactory — return value', () => {
  it('returns a URL containing the public host', async () => {
    const { storage } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'hmac-token', 'https://wf.example');
    const writer = factory('tenant-1');
    const url = await writer('doc.pdf', Buffer.from('bytes'), 'application/pdf');
    expect(url).toMatch(/^https:\/\/wf\.example\/attachments\//);
  });

  it('embeds token, f and m query params in the URL', async () => {
    const { storage } = makeStorageSpy();
    const factory = createFileWriterFactory(storage, () => 'the-token', 'https://wf.example');
    const writer = factory('tenant-1');
    const url = await writer('my-file.pdf', Buffer.from('bytes'), 'application/pdf');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('token')).toBe('the-token');
    expect(parsed.searchParams.get('f')).toBe('my-file.pdf');
    expect(parsed.searchParams.get('m')).toBe('application/pdf');
  });
});
