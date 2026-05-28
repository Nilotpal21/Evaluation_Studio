/**
 * Streaming inbound URL → outbound Docling multipart helper (LLD Task 1.6).
 *
 * Two-stage pipe that never buffers the full document into memory:
 *
 *   1. INBOUND  — `safeFetch(fileUrl)` (DNS-pinned, SSRF-validated, redirect
 *                  re-validated). Consume `response.body` as a Web
 *                  `ReadableStream` and convert to a Node `Readable` via
 *                  `Readable.fromWeb()`.
 *   2. OUTBOUND — Build a `form-data` `FormData`, append the Node `Readable`
 *                  as the `file` field, then POST via raw `node:http`
 *                  `request` to `${DOCLING_SERVICE_URL}/extract`. The internal
 *                  Docling URL does NOT need DNS pinning (intra-cluster), and
 *                  `safeFetch` cannot stream request bodies (see
 *                  `safe-fetch.ts:403` — `normalizeBody` rejects streams).
 *
 * Size-scaled timeout (Round 1 / Task 1.6 cap): floor 180_000 ms (3 min) plus
 * `(sizeBytes / 1MB) * 10_000`, capped at 1_800_000 ms (30 min). The floor was
 * raised from 60_000 because the byte-size scale underestimates the work for
 * dense or OCR-heavy documents (e.g. an HTML site rendered to 29 PDF pages
 * from a 142 KB source can run 90+ s; the 60 s floor was firing before
 * Docling could finish).
 */

import { Readable } from 'node:stream';
import * as http from 'node:http';
import * as https from 'node:https';
import FormData from 'form-data';
import { safeFetch, SSRFError } from '@agent-platform/shared-kernel/security/safe-fetch';

/**
 * Size-scaled timeout calculator. Exported for unit testing
 * (`extraction-timeout.test.ts` — LLD Phase 1 exit criterion).
 *
 * @param sizeBytes — Document size in bytes. Negative or NaN treated as 0.
 */
export function computeExtractionTimeoutMs(sizeBytes: number): number {
  const safeSize = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0;
  const sizeMb = safeSize / 1024 / 1024;
  return Math.min(180_000 + sizeMb * 10_000, 1_800_000);
}

export interface DoclingPageDto {
  pageNumber: number;
  text: string;
  layout: {
    headings: Array<{ level: number; text: string; bbox?: unknown }>;
    structure?: unknown;
  };
  tables: Array<{
    rows: string[][];
    headers: string[];
    html: string;
    markdown: string;
    bbox?: unknown;
    isComplete: boolean;
  }>;
  images: Array<{ data: string; format: string; bbox?: unknown }>;
  screenshot: string | null;
}

export interface DoclingExtractionResultDto {
  pages: DoclingPageDto[];
  metadata: {
    pageCount: number;
    hasOCR: boolean;
    totalTables: number;
    totalImages: number;
    processingTime: number;
    documentType?: string;
    language?: string;
    languageConfidence?: number;
    languageScript?: string;
    languageDetectionMethod?: string;
    secondaryLanguages?: Array<{ lang: string; confidence: number }>;
  };
  structure: {
    outline: unknown[];
    documentType?: string;
  };
}

export interface StreamToDoclingOptions {
  extractImages: boolean;
  extractTables: boolean;
  renderScreenshots: boolean;
  ocrEnabled: boolean;
}

export interface StreamToDoclingInput {
  fileUrl: string;
  options: StreamToDoclingOptions;
  /** Override the default `process.env.DOCLING_SERVICE_URL` (used by tests). */
  doclingServiceUrl?: string;
  /**
   * Pre-known size in bytes (from the workflow step's HEAD probe). When
   * omitted the helper falls back to the inbound response's `content-length`
   * header, then to a conservative 50 MB estimate.
   */
  expectedSizeBytes?: number;
}

export class DoclingExtractionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DoclingExtractionError';
    this.code = code;
  }
}

const CONSERVATIVE_SIZE_FALLBACK = 50 * 1024 * 1024;

export async function streamUrlToDocling(
  input: StreamToDoclingInput,
): Promise<DoclingExtractionResultDto> {
  let inboundResponse: Response;
  try {
    inboundResponse = await safeFetch(input.fileUrl);
  } catch (err) {
    if (err instanceof SSRFError) {
      throw new DoclingExtractionError('SSRF_BLOCKED', err.message);
    }
    throw err;
  }

  if (!inboundResponse.ok) {
    throw new DoclingExtractionError(
      'EXTRACTION_FAILED',
      `Inbound fetch failed: HTTP ${inboundResponse.status} ${inboundResponse.statusText}`,
    );
  }

  if (!inboundResponse.body) {
    throw new DoclingExtractionError(
      'EXTRACTION_FAILED',
      'Inbound fetch returned no body to stream',
    );
  }

  const contentLengthHeader = inboundResponse.headers.get('content-length');
  const parsedContentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  const sizeBytes =
    input.expectedSizeBytes ??
    (Number.isFinite(parsedContentLength) ? parsedContentLength : CONSERVATIVE_SIZE_FALLBACK);
  const timeoutMs = computeExtractionTimeoutMs(sizeBytes);
  const contentType = inboundResponse.headers.get('content-type') ?? 'application/octet-stream';
  const filename = deriveFilenameFromUrl(input.fileUrl, contentType);

  // The Web ReadableStream type returned by `safeFetch` (and `globalThis.fetch`)
  // differs structurally from Node's `node:stream/web` ReadableStream in the
  // TypeScript declarations even though they are runtime-compatible. The
  // double-cast bridges the type-level gap; `Readable.fromWeb` accepts both at
  // runtime.
  const nodeReadable = Readable.fromWeb(
    inboundResponse.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
  );

  const form = new FormData();
  const fileAppendOptions: FormData.AppendOptions = { filename, contentType };
  // form-data uses knownLength to set Content-Length on the outbound request.
  // Omit it when the inbound stream is chunked (no content-length) so form-data
  // falls back to chunked encoding rather than mis-advertising a length.
  if (Number.isFinite(parsedContentLength) && parsedContentLength > 0) {
    fileAppendOptions.knownLength = parsedContentLength;
  }
  form.append('file', nodeReadable, fileAppendOptions);
  form.append('options', JSON.stringify(input.options));

  const doclingUrl = new URL(
    '/extract',
    input.doclingServiceUrl ?? process.env.DOCLING_SERVICE_URL ?? 'http://localhost:8080',
  );

  try {
    return await postFormToDocling(doclingUrl, form, timeoutMs);
  } catch (err) {
    if (!nodeReadable.destroyed) nodeReadable.destroy();
    throw err;
  }
}

function deriveFilenameFromUrl(fileUrl: string, contentType: string): string {
  try {
    const { pathname } = new URL(fileUrl);
    const last = pathname.split('/').pop();
    if (last && last.includes('.')) return last;
  } catch {
    // fall through
  }
  return `document${extensionFromContentType(contentType)}`;
}

function extensionFromContentType(contentType: string): string {
  const ct = (contentType.toLowerCase().split(';')[0] ?? '').trim();
  switch (ct) {
    case 'application/pdf':
      return '.pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return '.pptx';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return '.xlsx';
    case 'text/html':
      return '.html';
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return '';
  }
}

function postFormToDocling(
  doclingUrl: URL,
  form: FormData,
  timeoutMs: number,
): Promise<DoclingExtractionResultDto> {
  return new Promise((resolve, reject) => {
    const transport = doclingUrl.protocol === 'https:' ? https : http;
    const requestOptions: http.RequestOptions = {
      method: 'POST',
      hostname: doclingUrl.hostname,
      port: doclingUrl.port || (doclingUrl.protocol === 'https:' ? 443 : 80),
      path: `${doclingUrl.pathname}${doclingUrl.search}`,
      headers: form.getHeaders(),
    };

    const req = transport.request(requestOptions);

    const timer = setTimeout(() => {
      req.destroy(
        new DoclingExtractionError('EXTRACTION_TIMEOUT', `Docling timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    req.on('error', (err: unknown) => {
      clearTimeout(timer);
      if (err instanceof DoclingExtractionError) {
        reject(err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      reject(new DoclingExtractionError('EXTRACTION_FAILED', `Docling request failed: ${message}`));
    });

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(
            new DoclingExtractionError(
              'EXTRACTION_FAILED',
              `Docling returned HTTP ${status}: ${bodyText.slice(0, 200)}`,
            ),
          );
          return;
        }
        try {
          const parsed = JSON.parse(bodyText) as DoclingExtractionResultDto;
          resolve(parsed);
        } catch (parseErr) {
          reject(
            new DoclingExtractionError(
              'EXTRACTION_FAILED',
              `Docling response was not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            ),
          );
        }
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(
          new DoclingExtractionError(
            'EXTRACTION_FAILED',
            `Docling response stream errored: ${err.message}`,
          ),
        );
      });
    });

    // Pipe the multipart body; form-data emits proper boundary chunks.
    form.pipe(req);
  });
}
