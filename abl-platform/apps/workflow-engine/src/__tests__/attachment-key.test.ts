/**
 * Boundary tests for buildAttachmentKey: confirms that the key components
 * are sanitized so a malformed tenantId or fileName cannot produce a key
 * with path-traversal characters. The FS-layer traversal guard in
 * LocalFileStorage.upload() is the last line of defense; this test makes
 * sure the first line (key construction) also holds.
 */

import { describe, it, expect } from 'vitest';
import { buildAttachmentKey } from '../storage/storage-factory.js';

describe('buildAttachmentKey sanitization', () => {
  it('produces a clean key for well-formed inputs', () => {
    const key = buildAttachmentKey('tenant-abc', 'aaaa-bbbb-cccc-dddd', 'invoice.pdf');
    expect(key).toBe('attachments/tenant-abc/aaaa-bbbb-cccc-dddd.pdf');
  });

  it('strips path-traversal characters from tenantId', () => {
    const key = buildAttachmentKey('../etc', 'abc123', 'doc.pdf');
    // Dots and slashes get stripped — "../etc" becomes "etc".
    // We assert the dangerous sequence is gone, not the literal "etc"
    // substring (which happens to be in "attachments/etc/...").
    expect(key).not.toContain('..');
    expect(key).not.toContain('../');
    expect(key).toBe('attachments/etc/abc123.pdf');
  });

  it('strips path-traversal characters from attachmentId', () => {
    const key = buildAttachmentKey('tenant-1', '../../escape', 'doc.pdf');
    expect(key).not.toContain('..');
    expect(key).toBe('attachments/tenant-1/escape.pdf');
  });

  it('caps and sanitizes file extension', () => {
    const key = buildAttachmentKey('t', 'id', 'file.../../../etc/passwd');
    expect(key).not.toContain('..');
    expect(key).not.toContain('../');
    // ext after sanitize: only [A-Za-z0-9], capped at 10 chars
    expect(key).toMatch(/^attachments\/t\/id\.[A-Za-z0-9]{0,10}$/);
  });

  it('falls back to .bin when filename has no extension', () => {
    const key = buildAttachmentKey('t', 'id', 'no-extension-here');
    expect(key).toBe('attachments/t/id.bin');
  });

  it('falls back to .bin when extension is unsanitizable', () => {
    const key = buildAttachmentKey('t', 'id', 'name.!!!@@@###');
    expect(key).toBe('attachments/t/id.bin');
  });

  it('preserves underscores and hyphens in tenantId (UUID-shaped)', () => {
    const key = buildAttachmentKey('tenant_abc-123', 'aid', 'f.png');
    expect(key).toBe('attachments/tenant_abc-123/aid.png');
  });
});
