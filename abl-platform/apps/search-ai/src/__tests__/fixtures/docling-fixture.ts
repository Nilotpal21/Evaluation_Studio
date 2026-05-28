/**
 * Out-of-process Docling fixture (LLD Phase 1 Task 1.5).
 *
 * Spawns a real Express server on a random port that mimics the Docling
 * Python service's `/extract` endpoint. Shared between:
 *   - `apps/search-ai/src/__tests__/workflow-docling-extraction-worker.test.ts`
 *   - `apps/search-ai/src/__tests__/two-queue-isolation.test.ts`
 *   - `apps/studio/e2e/workflows/fixtures/docling-fixture.ts` (re-export)
 *
 * Knobs:
 *   - `?delay=Nms`     — sleep N ms before responding (deterministic saturation
 *                        for `two-queue-isolation.test.ts`).
 *   - `?fail=503`      — return a specific HTTP status (negative-path tests).
 *   - `?pages=N`       — generate N synthetic pages in the response payload.
 *
 * The fixture exposes a `callCount` getter so tests can assert that an engine
 * replay did NOT trigger a duplicate Docling invocation
 * (`workflow-docling-parking.test.ts`).
 */

import express, { type Request, type Response } from 'express';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import multer from 'multer';
import type { DoclingExtractionResultDto } from '../../workers/branches/streaming-url-to-docling.js';

export interface DoclingFixtureHandle {
  /** Base URL (e.g. `http://127.0.0.1:54123`). */
  readonly url: string;
  /** Number of `/extract` POSTs received since the fixture was created. */
  readonly callCount: number;
  /** Bytes received across all `/extract` calls (used for streaming-memory assertions). */
  readonly bytesReceived: number;
  /** Reset call-count + byte counter between tests. */
  reset(): void;
  /** Shut down the underlying HTTP server. */
  close(): Promise<void>;
}

export interface StartDoclingFixtureOptions {
  /** Optional fixed port. Default 0 (OS-assigned). */
  port?: number;
}

export async function startDoclingFixture(
  options: StartDoclingFixtureOptions = {},
): Promise<DoclingFixtureHandle> {
  const app = express();
  const upload = multer({ limits: { fileSize: 200 * 1024 * 1024 } });

  let callCount = 0;
  let bytesReceived = 0;

  app.post('/extract', upload.single('file'), async (req: Request, res: Response) => {
    callCount += 1;
    if (req.file) bytesReceived += req.file.size;

    const delayMs = parseInt(String(req.query.delay ?? '0'), 10);
    const failStatus = parseInt(String(req.query.fail ?? '0'), 10);
    const pageCount = Math.max(parseInt(String(req.query.pages ?? '1'), 10), 1);

    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (failStatus >= 400) {
      res.status(failStatus).json({ error: `Fixture-injected status ${failStatus}` });
      return;
    }

    res.status(200).json(buildSyntheticResult(pageCount));
  });

  app.get('/info', (_req: Request, res: Response) => {
    res.status(200).json({ service: 'docling-fixture', version: 'test' });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    get url() {
      return url;
    },
    get callCount() {
      return callCount;
    },
    get bytesReceived() {
      return bytesReceived;
    },
    reset(): void {
      callCount = 0;
      bytesReceived = 0;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function buildSyntheticResult(pageCount: number): DoclingExtractionResultDto {
  const pages = Array.from({ length: pageCount }, (_, i) => ({
    pageNumber: i + 1,
    text: `Synthetic page ${i + 1} text content.`,
    layout: {
      headings: [{ level: 1, text: `Heading for page ${i + 1}` }],
      structure: undefined,
    },
    tables: [],
    images: [],
    screenshot: null,
  }));
  return {
    pages,
    metadata: {
      pageCount,
      hasOCR: false,
      totalTables: 0,
      totalImages: 0,
      processingTime: 10,
      documentType: 'pdf',
      language: 'en',
      languageConfidence: 0.95,
    },
    structure: { outline: [], documentType: 'pdf' },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
