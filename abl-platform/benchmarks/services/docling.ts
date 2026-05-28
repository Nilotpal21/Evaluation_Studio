/**
 * Docling Service Benchmarks
 *
 * Tests: PDF processing, image OCR, table extraction.
 * Target: Docling service at port 8080.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.ts';
import { ensureFreshAuth } from '../lib/auth.ts';
import { successRate, errorCount } from '../lib/metrics.ts';
import { Trend } from 'k6/metrics';

const BASE = config.doclingUrl;

const pdfProcessingTime = new Trend('abl_pdf_processing_time_ms', true);
const ocrProcessingTime = new Trend('abl_ocr_processing_time_ms', true);
const tableExtractionTime = new Trend('abl_table_extraction_time_ms', true);

/** Generate a minimal valid PDF payload (base64) for testing */
function generatePdfPayload(pages: number): string {
  return JSON.stringify({
    source: `data:application/pdf;base64,JVBERi0x`, // minimal stub
    options: {
      extractTables: true,
      extractImages: false,
      maxPages: pages,
    },
  });
}

export const options = {
  scenarios: {
    pdf_small: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 10,
      maxVUs: 25,
      exec: 'pdfSmall',
    },
    pdf_large: {
      executor: 'per-vu-iterations',
      vus: 3,
      iterations: 10,
      startTime: '3m',
      exec: 'pdfLarge',
    },
    image_ocr: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 5,
      maxVUs: 15,
      startTime: '6m',
      exec: 'imageOcr',
    },
    table_extraction: {
      executor: 'per-vu-iterations',
      vus: 3,
      iterations: 15,
      startTime: '9m',
      exec: 'tableExtraction',
    },
  },
  thresholds: {
    'http_req_duration{scenario:pdf_small}': ['p(95)<5000', 'p(99)<10000'],
    'http_req_duration{scenario:pdf_large}': ['p(95)<30000', 'p(99)<60000'],
    'http_req_duration{scenario:image_ocr}': ['p(95)<8000', 'p(99)<15000'],
    'http_req_duration{scenario:table_extraction}': ['p(95)<10000', 'p(99)<20000'],
    http_req_failed: ['rate<0.05'],
    abl_pdf_processing_time_ms: ['p(95)<10000'],
    abl_ocr_processing_time_ms: ['p(95)<8000'],
  },
};

// ---------------------------------------------------------------------------
// Setup — direct service connection (no auth required)
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
}

export function setup(): SetupData {
  const headers = { 'Content-Type': 'application/json' };
  return { token: '', refreshToken: '', headers };
}

/** Process a small PDF (1-5 pages) */
export function pdfSmall(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = generatePdfPayload(3);
  const start = Date.now();

  const res = http.post(`${BASE}/api/v1/convert`, payload, {
    headers: data.headers,
    tags: { scenario: 'pdf_small' },
    timeout: '30s',
  });

  pdfProcessingTime.add(Date.now() - start);

  const ok = check(res, {
    'small PDF 200': (r) => r.status === 200,
    'has extracted text': (r) => {
      const body = r.json() as Record<string, unknown>;
      return typeof body.text === 'string' || Array.isArray(body.pages);
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[pdf_small] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.2);
}

/** Process a large PDF (50+ pages) */
export function pdfLarge(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = generatePdfPayload(50);
  const start = Date.now();

  const res = http.post(`${BASE}/api/v1/convert`, payload, {
    headers: data.headers,
    tags: { scenario: 'pdf_large' },
    timeout: '120s',
  });

  pdfProcessingTime.add(Date.now() - start);

  const ok = check(res, {
    'large PDF 200|202': (r) => r.status === 200 || r.status === 202,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[pdf_large] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(2);
}

/** OCR processing on image input */
export function imageOcr(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', // minimal stub
    options: { ocr: true, language: 'en' },
  });

  const start = Date.now();
  const res = http.post(`${BASE}/api/v1/convert`, payload, {
    headers: data.headers,
    tags: { scenario: 'image_ocr' },
    timeout: '30s',
  });

  ocrProcessingTime.add(Date.now() - start);

  const ok = check(res, {
    'OCR 200': (r) => r.status === 200,
    'has OCR text': (r) => {
      const body = r.json() as Record<string, unknown>;
      return typeof body.text === 'string';
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[image_ocr] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.5);
}

/** Extract tables from a PDF document */
export function tableExtraction(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    source: 'data:application/pdf;base64,JVBERi0x',
    options: {
      extractTables: true,
      tableFormat: 'markdown',
      maxPages: 10,
    },
  });

  const start = Date.now();
  const res = http.post(`${BASE}/api/v1/convert`, payload, {
    headers: data.headers,
    tags: { scenario: 'table_extraction' },
    timeout: '45s',
  });

  tableExtractionTime.add(Date.now() - start);

  const ok = check(res, {
    'table extraction 200': (r) => r.status === 200,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[table_extraction] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(1);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  pdfSmall(data);
}
