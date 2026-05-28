import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/index.js', () => ({
  getLazyModel: () => ({
    findOne: vi.fn(),
  }),
}));

vi.mock('../../services/ingestion/download-document.js', () => ({
  downloadDocumentContent: vi.fn(),
}));

vi.mock('../../config/index.js', () => ({
  getConfig: () => ({ jwt: { secret: 'test-secret' } }),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  isValidDownloadTokenPayload,
  safeAttachmentFileName,
  safeContentType,
} from '../../routes/document-download.js';

describe('document download hardening helpers', () => {
  it('rejects malformed signed-token payloads', () => {
    expect(
      isValidDownloadTokenPayload({
        documentId: 'doc-1',
        tenantId: 'tenant-1',
        exp: Date.now() + 1000,
      }),
    ).toBe(true);

    expect(isValidDownloadTokenPayload({ documentId: 'doc-1', tenantId: 'tenant-1' })).toBe(false);
    expect(isValidDownloadTokenPayload({ documentId: '', tenantId: 'tenant-1', exp: 1 })).toBe(
      false,
    );
    expect(
      isValidDownloadTokenPayload({ documentId: 'doc-1', tenantId: 'tenant-1', exp: 'soon' }),
    ).toBe(false);
  });

  it('sanitizes response header values derived from documents', () => {
    expect(safeContentType('text/plain')).toBe('text/plain');
    expect(safeContentType('text/plain\r\nX-Injected: yes')).toBe('application/octet-stream');
    expect(safeContentType('plain-text')).toBe('application/octet-stream');

    expect(safeAttachmentFileName('report\r\nX-Bad: yes"/2026.pdf', 'fallback.pdf')).toBe(
      'report__X-Bad: yes__2026.pdf',
    );
    expect(safeAttachmentFileName('   ', 'fallback.pdf')).toBe('fallback.pdf');
  });
});
