import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  assertSafeUrl,
  contentTypeFromUrl,
  buildAnthropicMediaBlock,
} from '../../piece-claude/src/security.js';
import {
  assertSafeUrl as assertSafeUrlOAI,
  buildOpenAIImageContent,
} from '../../piece-openai/src/security.js';
import { assertSafeFileUrl, MAX_FILE_BYTES } from '../security.js';

afterEach(() => vi.restoreAllMocks());

// ── assertSafeUrl (piece-claude + piece-openai, identical logic) ──────────────

describe('assertSafeUrl', () => {
  it('accepts a clean HTTPS URL', () => {
    expect(() => assertSafeUrl('https://example.com/image.png')).not.toThrow();
    expect(() => assertSafeUrlOAI('https://cdn.example.com/photo.jpg')).not.toThrow();
  });

  it('rejects HTTP', () => {
    expect(() => assertSafeUrl('http://example.com/image.png')).toThrow('Only HTTPS');
  });

  it('rejects invalid URL', () => {
    expect(() => assertSafeUrl('not-a-url')).toThrow('Invalid URL');
  });

  it('rejects localhost', () => {
    expect(() => assertSafeUrl('https://localhost/secret')).toThrow('private/reserved');
  });

  it('rejects 0.0.0.0', () => {
    expect(() => assertSafeUrl('https://0.0.0.0/admin')).toThrow('private/reserved');
  });

  it('rejects RFC-1918 10.x addresses', () => {
    expect(() => assertSafeUrl('https://10.0.0.1/internal')).toThrow('private/reserved');
  });

  it('rejects RFC-1918 172.16–31 addresses', () => {
    expect(() => assertSafeUrl('https://172.16.0.1/internal')).toThrow('private/reserved');
    expect(() => assertSafeUrl('https://172.31.255.255/internal')).toThrow('private/reserved');
  });

  it('rejects RFC-1918 192.168 addresses', () => {
    expect(() => assertSafeUrl('https://192.168.1.1/internal')).toThrow('private/reserved');
  });

  it('rejects link-local 169.254 addresses', () => {
    expect(() => assertSafeUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      'private/reserved',
    );
  });
});

// ── contentTypeFromUrl ────────────────────────────────────────────────────────

describe('contentTypeFromUrl', () => {
  it('returns document for .pdf URLs', () => {
    expect(contentTypeFromUrl('https://example.com/report.pdf')).toBe('document');
    expect(contentTypeFromUrl('https://example.com/REPORT.PDF')).toBe('document');
  });

  it('returns document for pdf URLs with query string', () => {
    expect(contentTypeFromUrl('https://s3.amazonaws.com/bucket/file.pdf?X-Amz-Expires=900')).toBe(
      'document',
    );
  });

  it('returns image for non-pdf URLs', () => {
    expect(contentTypeFromUrl('https://example.com/photo.jpg')).toBe('image');
    expect(contentTypeFromUrl('https://example.com/image.png')).toBe('image');
    expect(contentTypeFromUrl('https://example.com/animation.gif')).toBe('image');
  });
});

// ── buildAnthropicMediaBlock ──────────────────────────────────────────────────

describe('buildAnthropicMediaBlock', () => {
  it('returns URL-native block for clean URL (no query params)', async () => {
    const block = await buildAnthropicMediaBlock('https://example.com/photo.jpg');
    expect(block).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/photo.jpg' },
    });
  });

  it('returns URL-native document block for .pdf URL (no query params)', async () => {
    const block = await buildAnthropicMediaBlock('https://example.com/doc.pdf');
    expect(block).toEqual({
      type: 'document',
      source: { type: 'url', url: 'https://example.com/doc.pdf' },
    });
  });

  it('fetches locally and returns base64 block when URL has query params (presigned URL)', async () => {
    const fakeBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    const expectedBase64 = Buffer.from(fakeBytes).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (h: string) => (h === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => fakeBytes.buffer,
      }),
    );

    const block = await buildAnthropicMediaBlock(
      'https://s3.amazonaws.com/bucket/photo.jpg?X-Amz-Signature=abc&X-Amz-Expires=900',
    );

    expect(block.type).toBe('image');
    const src = block.source as Record<string, unknown>;
    expect(src.type).toBe('base64');
    expect(src.media_type).toBe('image/jpeg');
    expect(src.data).toBe(expectedBase64);
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0][0]).toContain('X-Amz-Signature');
  });

  it('throws when fetch fails for presigned URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      buildAnthropicMediaBlock('https://s3.amazonaws.com/bucket/photo.jpg?sig=abc'),
    ).rejects.toThrow('Failed to fetch');
  });
});

// ── buildOpenAIImageContent ───────────────────────────────────────────────────

describe('buildOpenAIImageContent', () => {
  it('returns URL-native block for clean URL (no query params)', async () => {
    const block = await buildOpenAIImageContent('https://example.com/photo.jpg');
    expect(block).toEqual({
      type: 'image_url',
      image_url: { url: 'https://example.com/photo.jpg', detail: 'auto' },
    });
  });

  it('respects explicit detail parameter', async () => {
    const block = await buildOpenAIImageContent('https://example.com/photo.jpg', 'high');
    expect((block.image_url as Record<string, unknown>).detail).toBe('high');
  });

  it('fetches locally and returns data-URL when URL has query params', async () => {
    const fakeBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const expectedBase64 = Buffer.from(fakeBytes).toString('base64');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: (h: string) => (h === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => fakeBytes.buffer,
      }),
    );

    const block = await buildOpenAIImageContent(
      'https://s3.amazonaws.com/bucket/photo.png?X-Amz-Signature=xyz',
    );

    const imgUrl = block.image_url as Record<string, unknown>;
    expect(imgUrl.url).toMatch(/^data:image\/png;base64,/);
    expect(imgUrl.url).toContain(expectedBase64);
    expect(imgUrl.detail).toBe('auto');
  });

  it('throws when fetch fails for presigned URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(
      buildOpenAIImageContent('https://s3.amazonaws.com/bucket/photo.jpg?sig=abc'),
    ).rejects.toThrow('Failed to fetch');
  });
});

// ── assertSafeFileUrl + MAX_FILE_BYTES (connectors/src/security) ──────────────

describe('assertSafeFileUrl', () => {
  it('accepts a clean HTTPS URL', () => {
    expect(() => assertSafeFileUrl('https://example.com/file.pdf')).not.toThrow();
  });

  it('rejects non-HTTPS', () => {
    expect(() => assertSafeFileUrl('http://example.com/file.pdf')).toThrow('Only HTTPS');
  });

  it('rejects private addresses', () => {
    expect(() => assertSafeFileUrl('https://10.0.0.1/file.pdf')).toThrow('private/reserved');
    expect(() => assertSafeFileUrl('https://169.254.169.254/latest/meta-data')).toThrow(
      'private/reserved',
    );
  });

  it('rejects localhost', () => {
    expect(() => assertSafeFileUrl('https://localhost/file.pdf')).toThrow('private/reserved');
  });

  it('MAX_FILE_BYTES is 25 MB', () => {
    expect(MAX_FILE_BYTES).toBe(25 * 1024 * 1024);
  });
});
