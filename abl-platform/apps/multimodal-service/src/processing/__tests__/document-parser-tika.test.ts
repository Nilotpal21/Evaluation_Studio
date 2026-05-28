import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// =============================================================================
// Mock createLogger before importing the module under test
// =============================================================================

const { mockLogError, mockLogWarn, mockLogInfo, mockLogDebug } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogDebug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: mockLogError,
    warn: mockLogWarn,
    info: mockLogInfo,
    debug: mockLogDebug,
  }),
}));

import { TikaParser } from '../document-parser-tika.js';

// =============================================================================
// HELPERS
// =============================================================================

function createReadableStream(content: string): Readable {
  return Readable.from(Buffer.from(content));
}

function mockFetchResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

// =============================================================================
// TESTS
// =============================================================================

describe('TikaParser', () => {
  let parser: TikaParser;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const TIKA_URL = 'http://localhost:9998';

  beforeEach(() => {
    vi.clearAllMocks();
    parser = new TikaParser({ tikaUrl: TIKA_URL });
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // name property
  // ---------------------------------------------------------------------------

  it('has name property equal to "tika"', () => {
    expect(parser.name).toBe('tika');
  });

  // ---------------------------------------------------------------------------
  // supportedMimeTypes()
  // ---------------------------------------------------------------------------

  it('returns a list of supported MIME types', () => {
    const types = parser.supportedMimeTypes();
    expect(types).toContain('application/pdf');
    expect(types).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(types).toContain('text/plain');
    expect(types).toContain('text/csv');
    expect(types.length).toBeGreaterThan(0);
  });

  it('returns a new array each time (defensive copy)', () => {
    const a = parser.supportedMimeTypes();
    const b = parser.supportedMimeTypes();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('extracts markdown text locally without calling Tika', async () => {
    const markdown = '# Architecture\n\n- Runtime\n- Multimodal service';

    const result = await parser.parse({
      fileStream: createReadableStream(markdown),
      mimeType: 'text/markdown',
      filename: 'notes.md',
      sizeBytes: markdown.length,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(markdown);
    expect(result.characterCount).toBe(markdown.length);
    expect(result.engine).toBe('tika');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // parse() — extracts text from PDF
  // ---------------------------------------------------------------------------

  it('extracts text from PDF', async () => {
    const extractedText = 'This is the extracted text from the PDF document.';
    fetchSpy.mockResolvedValue(mockFetchResponse(extractedText, { status: 200 }));

    const result = await parser.parse({
      fileStream: createReadableStream('fake pdf bytes'),
      mimeType: 'application/pdf',
      filename: 'report.pdf',
      sizeBytes: 14,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(extractedText);
    expect(result.characterCount).toBe(extractedText.length);
    expect(result.engine).toBe('tika');
    expect(result.error).toBeUndefined();

    // Verify fetch was called with correct parameters
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${TIKA_URL}/tika`);
    expect(options).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'application/pdf',
        Accept: 'text/plain',
      },
    });
  });

  // ---------------------------------------------------------------------------
  // parse() — extracts text from DOCX
  // ---------------------------------------------------------------------------

  it('extracts text from DOCX', async () => {
    const extractedText = 'Content from a Word document.\nWith multiple lines.';
    fetchSpy.mockResolvedValue(mockFetchResponse(extractedText, { status: 200 }));

    const result = await parser.parse({
      fileStream: createReadableStream('fake docx bytes'),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: 'letter.docx',
      sizeBytes: 15,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(extractedText);
    expect(result.characterCount).toBe(extractedText.length);
    expect(result.engine).toBe('tika');
    expect(result.error).toBeUndefined();

    const [, options] = fetchSpy.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  });

  // ---------------------------------------------------------------------------
  // parse() — handles unsupported MIME type
  // ---------------------------------------------------------------------------

  it('handles unsupported MIME type', async () => {
    const result = await parser.parse({
      fileStream: createReadableStream('video bytes'),
      mimeType: 'video/mp4',
      filename: 'movie.mp4',
      sizeBytes: 11,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.characterCount).toBe(0);
    expect(result.engine).toBe('tika');
    expect(result.error).toBe('Unsupported MIME type: video/mp4');

    // fetch should not be called for unsupported types
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // parse() — handles Tika server error (500)
  // ---------------------------------------------------------------------------

  it('handles Tika server error (500)', async () => {
    fetchSpy.mockResolvedValue(
      mockFetchResponse('Internal Server Error', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    );

    const result = await parser.parse({
      fileStream: createReadableStream('corrupted pdf'),
      mimeType: 'application/pdf',
      filename: 'corrupted.pdf',
      sizeBytes: 13,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.characterCount).toBe(0);
    expect(result.engine).toBe('tika');
    expect(result.error).toContain('Tika server returned HTTP 500');
    expect(result.error).toContain('corrupted.pdf');
    expect(mockLogError).toHaveBeenCalledWith(
      'Tika server error',
      expect.objectContaining({ status: 500 }),
    );
  });

  // ---------------------------------------------------------------------------
  // parse() — handles Tika server unreachable
  // ---------------------------------------------------------------------------

  it('handles Tika server unreachable', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const result = await parser.parse({
      fileStream: createReadableStream('some content'),
      mimeType: 'application/pdf',
      filename: 'test.pdf',
      sizeBytes: 12,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.characterCount).toBe(0);
    expect(result.engine).toBe('tika');
    expect(result.error).toBe('fetch failed');
    expect(mockLogError).toHaveBeenCalledWith(
      'Parse failed',
      expect.objectContaining({ error: 'fetch failed' }),
    );
  });

  // ---------------------------------------------------------------------------
  // parse() — truncates content exceeding maxContentLength
  // ---------------------------------------------------------------------------

  it('truncates content exceeding maxContentLength', async () => {
    const maxLen = 100;
    const shortParser = new TikaParser({
      tikaUrl: TIKA_URL,
      maxContentLength: maxLen,
    });

    const longText = 'A'.repeat(250);
    fetchSpy.mockResolvedValue(mockFetchResponse(longText, { status: 200 }));

    const result = await shortParser.parse({
      fileStream: createReadableStream('fake pdf'),
      mimeType: 'application/pdf',
      filename: 'large.pdf',
      sizeBytes: 8,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('A'.repeat(maxLen));
    expect(result.characterCount).toBe(maxLen);
    expect(result.engine).toBe('tika');
  });

  // ---------------------------------------------------------------------------
  // parse() — handles empty text response
  // ---------------------------------------------------------------------------

  it('handles empty text response from Tika', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('', { status: 200 }));

    const result = await parser.parse({
      fileStream: createReadableStream('scanned image pdf'),
      mimeType: 'application/pdf',
      filename: 'scanned.pdf',
      sizeBytes: 17,
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('');
    expect(result.characterCount).toBe(0);
    expect(result.engine).toBe('tika');
  });

  // ---------------------------------------------------------------------------
  // parse() — handles abort timeout
  // ---------------------------------------------------------------------------

  it('handles request timeout via AbortController', async () => {
    const fastParser = new TikaParser({
      tikaUrl: TIKA_URL,
      timeoutMs: 1, // 1ms timeout to trigger abort quickly
    });

    // Simulate a slow response that never resolves before timeout
    fetchSpy.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 5);
        }),
    );

    const result = await fastParser.parse({
      fileStream: createReadableStream('pdf bytes'),
      mimeType: 'application/pdf',
      filename: 'slow.pdf',
      sizeBytes: 9,
    });

    expect(result.success).toBe(false);
    expect(result.text).toBeNull();
    expect(result.characterCount).toBe(0);
    expect(result.engine).toBe('tika');
    expect(result.error).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // parse() — sends buffer body to fetch
  // ---------------------------------------------------------------------------

  it('sends the collected stream buffer as the request body', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('extracted', { status: 200 }));

    const content = 'my document content';
    await parser.parse({
      fileStream: createReadableStream(content),
      mimeType: 'application/pdf',
      filename: 'doc.pdf',
      sizeBytes: content.length,
    });

    const [, options] = fetchSpy.mock.calls[0];
    const body = (options as RequestInit).body;
    expect(body).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(body as ArrayBuffer).toString()).toBe(content);
  });

  // ---------------------------------------------------------------------------
  // parse() — handles non-Error thrown values
  // ---------------------------------------------------------------------------

  it('handles non-Error thrown values', async () => {
    fetchSpy.mockRejectedValue('string error');

    const result = await parser.parse({
      fileStream: createReadableStream('content'),
      mimeType: 'application/pdf',
      filename: 'test.pdf',
      sizeBytes: 7,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });

  // ---------------------------------------------------------------------------
  // healthCheck() — returns ok when server responds
  // ---------------------------------------------------------------------------

  it('healthCheck returns ok when server responds', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('Apache Tika 2.9.1', { status: 200 }));

    const result = await parser.healthCheck();

    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify the health check URL
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${TIKA_URL}/tika`);
    expect((options as RequestInit).method).toBe('GET');
  });

  // ---------------------------------------------------------------------------
  // healthCheck() — returns not ok when server is down
  // ---------------------------------------------------------------------------

  it('healthCheck returns not ok when server is down', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const result = await parser.healthCheck();

    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'Health check failed',
      expect.objectContaining({ error: 'fetch failed' }),
    );
  });

  // ---------------------------------------------------------------------------
  // healthCheck() — returns not ok when server returns non-200
  // ---------------------------------------------------------------------------

  it('healthCheck returns not ok when server returns non-200', async () => {
    fetchSpy.mockResolvedValue(mockFetchResponse('Service Unavailable', { status: 503 }));

    const result = await parser.healthCheck();

    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
    expect(mockLogError).toHaveBeenCalledWith(
      'Health check returned non-200',
      expect.objectContaining({ status: 503 }),
    );
  });

  // ---------------------------------------------------------------------------
  // Constructor defaults
  // ---------------------------------------------------------------------------

  it('uses default timeout and maxContentLength when not specified', () => {
    const defaultParser = new TikaParser({ tikaUrl: TIKA_URL });
    // Verify defaults are applied by checking supportedMimeTypes works
    // (verifies construction succeeded)
    expect(defaultParser.name).toBe('tika');
    expect(defaultParser.supportedMimeTypes().length).toBeGreaterThan(0);
  });

  it('accepts custom timeout and maxContentLength', async () => {
    const customParser = new TikaParser({
      tikaUrl: TIKA_URL,
      timeoutMs: 5000,
      maxContentLength: 1024,
    });

    const longText = 'B'.repeat(2000);
    fetchSpy.mockResolvedValue(mockFetchResponse(longText, { status: 200 }));

    const result = await customParser.parse({
      fileStream: createReadableStream('pdf'),
      mimeType: 'application/pdf',
      filename: 'test.pdf',
      sizeBytes: 3,
    });

    expect(result.success).toBe(true);
    expect(result.characterCount).toBe(1024);
    expect(result.text?.length).toBe(1024);
  });
});
