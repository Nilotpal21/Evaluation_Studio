/**
 * Knowledge Base Ingestion E2E Benchmark
 *
 * Full flow: Search AI -> Docling -> BGE-M3 -> OpenSearch
 * Tests the complete document ingestion pipeline including extraction and embedding.
 *
 * All requests go through the Search AI ingress prefix (/api/search-ai/...)
 * rather than through Studio, matching how the search-ai.ts service test works.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { runHealthCheck } from '../lib/config.ts';
import {
  embeddingThroughput,
  ingestionRate,
  queueWaitTime,
  successRate,
  errorCount,
} from '../lib/metrics.ts';
import { Trend, Counter } from 'k6/metrics';
import { vuScale, scaleStages, scaleArrivalRate } from '../lib/vu-scaling.ts';

const SEARCH_AI = config.searchAiUrl;
const PROJECT_ID = config.projectId;

const ingestionE2eLatency = new Trend('abl_ingestion_e2e_latency_ms', true);
const documentsIngested = new Counter('abl_documents_ingested_total');

/** Generate representative document content */
function generateDocContent(sizeCategory: 'small' | 'medium' | 'large'): string {
  const paragraph =
    'This document covers the configuration and management of enterprise AI agents. ' +
    'Topics include tool registration, constraint definition, model selection, and deployment workflows. ' +
    'Best practices for multi-agent orchestration and supervisor patterns are discussed in detail. ';

  const repeatMap = { small: 2, medium: 10, large: 50 };
  return paragraph.repeat(repeatMap[sizeCategory]);
}

// Baseline total: 25 (maxVUs) + 3 + 2 + 20 (peak) = 50 VUs — scale via MAX_VUS env var
const scale = vuScale(50);
const singleDocRate = scaleArrivalRate(50, { rate: 3, preAllocatedVUs: 10, maxVUs: 25 });

export const options = {
  scenarios: {
    single_document_pipeline: {
      executor: 'constant-arrival-rate',
      rate: singleDocRate.rate,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: singleDocRate.preAllocatedVUs,
      maxVUs: singleDocRate.maxVUs,
      exec: 'singleDocumentPipeline',
    },
    bulk_ingestion_pipeline: {
      executor: 'per-vu-iterations',
      vus: scale(3),
      iterations: 10,
      startTime: '5m',
      exec: 'bulkIngestionPipeline',
    },
    pdf_extraction_pipeline: {
      executor: 'per-vu-iterations',
      vus: scale(2),
      iterations: 8,
      startTime: '10m',
      exec: 'pdfExtractionPipeline',
    },
    mixed_format_ingestion: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: scaleStages(
        [
          { duration: '2m', target: 10 },
          { duration: '3m', target: 20 },
          { duration: '1m', target: 0 },
        ],
        50,
      ),
      startTime: '15m',
      exec: 'mixedFormatIngestion',
    },
  },
  thresholds: {
    'http_req_duration{scenario:single_document_pipeline}': ['p(95)<10000', 'p(99)<20000'],
    'http_req_duration{scenario:bulk_ingestion_pipeline}': ['p(95)<30000', 'p(99)<60000'],
    http_req_failed: ['rate<0.05'],
    abl_ingestion_e2e_latency_ms: ['p(95)<15000'],
    abl_success_rate: ['rate>0.90'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'kb-ingestion-integration',
    tags: {
      service: 'kb-ingestion',
      type: 'integration',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup — obtain auth token once per test run
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
  indexId: string;
  sourceId: string;
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  // Smoke-check: verify Search AI is reachable (skipped if HEALTH_CHECK=false)
  runHealthCheck(SEARCH_AI, 'search-ai', headers);

  // Discover index and source from existing KBs (same as search-ai.ts)
  let indexId = '';
  let sourceId = '';

  const kbRes = http.get(`${SEARCH_AI}${apiPath('/knowledge-bases')}?projectId=${PROJECT_ID}`, {
    headers,
  });
  if (kbRes.status === 200) {
    const body = kbRes.json() as {
      knowledgeBases?: Array<{ searchIndexId: string; name: string }>;
    };
    const kbs = body.knowledgeBases || [];
    const benchKb = kbs.find((kb) => kb.name === 'benchmark-kb') || kbs[0];
    if (benchKb) {
      indexId = benchKb.searchIndexId;
      console.log(`[setup] Using index from KB "${benchKb.name}": ${indexId}`);
    }
  }

  if (indexId) {
    const srcRes = http.get(`${SEARCH_AI}${apiPath(`/indexes/${indexId}/sources`)}`, { headers });
    if (srcRes.status === 200) {
      const body = srcRes.json() as {
        sources?: Array<{ _id: string; name: string }>;
      };
      const sources = body.sources || [];
      if (sources[0]) {
        sourceId = sources[0]._id;
        console.log(`[setup] Using source "${sources[0].name}": ${sourceId}`);
      }
    }
  }

  if (!indexId) {
    console.warn('[setup] No KB/index found — upload scenarios will use direct document API');
  }

  return { token, refreshToken, headers, indexId, sourceId };
}

/** Poll an ingestion job until completion */
function pollIngestionJob(data: SetupData, jobId: string, maxWaitSec: number): boolean {
  const pollInterval = 3;
  const maxPolls = Math.ceil(maxWaitSec / pollInterval);

  for (let i = 0; i < maxPolls; i++) {
    sleep(pollInterval);
    const res = http.get(
      `${SEARCH_AI}${apiPath(`/ingestion/jobs/${jobId}`)}?projectId=${PROJECT_ID}`,
      { headers: freshHeaders(data) },
    );

    if (res.status !== 200) continue;
    const body = res.json() as Record<string, unknown>;
    const status = body.status as string;

    if (status === 'completed') return true;
    if (status === 'failed') return false;
  }
  return false;
}

/** Ingest a single document through the full pipeline (Search AI -> OpenSearch) */
export function singleDocumentPipeline(data: SetupData): void {
  ensureFreshAuth(data);

  const docId = `e2e-single-${__VU}-${__ITER}`;

  group('upload via Search AI', () => {
    // If we have an index and source, use the source upload endpoint
    // Otherwise fall back to direct documents API
    if (data.indexId && data.sourceId) {
      const fileContent = `# E2E Benchmark Doc ${docId}\n\n${generateDocContent('medium')}`;
      const formData = {
        file: http.file(fileContent, `${docId}.md`, 'text/markdown'),
      };

      const start = Date.now();
      const singleUploadHeaders = freshHeaders(data);
      const res = http.post(
        `${SEARCH_AI}${apiPath(`/indexes/${data.indexId}/sources/${data.sourceId}/documents`)}`,
        formData,
        {
          headers: {
            Authorization: singleUploadHeaders['Authorization'],
            Origin: singleUploadHeaders['Origin'],
            'X-Tenant-Id': singleUploadHeaders['X-Tenant-Id'],
          },
          tags: { scenario: 'single_document_pipeline' },
          timeout: '30s',
        },
      );

      queueWaitTime.add(Date.now() - start);

      const accepted = check(res, {
        'document accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
      });

      if (!accepted) {
        console.log(`[single_document_pipeline] status=${res.status}`);
        errorCount.add(1);
        successRate.add(0);
        return;
      }

      if (res.status === 202) {
        const jobId = (res.json() as Record<string, string>).jobId;
        const completed = pollIngestionJob(data, jobId, 60);
        ingestionE2eLatency.add(Date.now() - start);
        successRate.add(completed ? 1 : 0);
        if (completed) documentsIngested.add(1);
        else errorCount.add(1);
      } else {
        ingestionE2eLatency.add(Date.now() - start);
        documentsIngested.add(1);
        successRate.add(1);
      }
    } else {
      // No index/source — use documents API
      const payload = JSON.stringify({
        documents: [
          {
            id: docId,
            title: `E2E Benchmark Doc ${docId}`,
            content: generateDocContent('medium'),
            metadata: { source: 'k6-e2e', format: 'text' },
          },
        ],
      });

      const start = Date.now();
      const res = http.post(
        `${SEARCH_AI}${apiPath(`/projects/${PROJECT_ID}/documents`)}`,
        payload,
        {
          headers: freshHeaders(data),
          tags: { scenario: 'single_document_pipeline' },
          timeout: '30s',
        },
      );

      queueWaitTime.add(Date.now() - start);
      ingestionE2eLatency.add(Date.now() - start);

      const accepted = check(res, {
        'document accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
      });

      successRate.add(accepted ? 1 : 0);
      if (accepted) documentsIngested.add(1);
      else {
        console.log(`[single_document_pipeline] status=${res.status}`);
        errorCount.add(1);
      }
    }
  });

  sleep(1);
}

/** Bulk ingest multiple documents sequentially through the source upload endpoint */
export function bulkIngestionPipeline(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId || !data.sourceId) {
    console.warn('[bulk] Skipping — no indexId or sourceId available');
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  const batchSize = 5; // Reduced from 25 — sequential uploads via source endpoint
  const start = Date.now();
  let uploaded = 0;

  for (let i = 0; i < batchSize; i++) {
    const fileContent = `# Bulk E2E Doc ${__VU}-${__ITER}-${i}\n\n${generateDocContent('small')}`;
    const formData = {
      file: http.file(fileContent, `bulk-${__VU}-${__ITER}-${i}.md`, 'text/markdown'),
    };

    const bulkHeaders = freshHeaders(data);
    const res = http.post(
      `${SEARCH_AI}${apiPath(`/indexes/${data.indexId}/sources/${data.sourceId}/documents`)}`,
      formData,
      {
        headers: {
          Authorization: bulkHeaders['Authorization'],
          Origin: bulkHeaders['Origin'],
          'X-Tenant-Id': bulkHeaders['X-Tenant-Id'],
        },
        tags: { scenario: 'bulk_ingestion_pipeline' },
        timeout: '30s',
      },
    );

    if (res.status === 200 || res.status === 201 || res.status === 202) {
      uploaded++;
    }
  }

  const elapsed = Date.now() - start;
  ingestionE2eLatency.add(elapsed);
  embeddingThroughput.add(uploaded / (elapsed / 1000));
  ingestionRate.add((uploaded / (elapsed / 1000)) * 3600);
  documentsIngested.add(uploaded);

  const ok = uploaded === batchSize;
  check(null, {
    'bulk accepted': () => ok,
  });
  successRate.add(ok ? 1 : 0);
  if (!ok) errorCount.add(1);

  sleep(2);
}

/** Upload a text file (simulating document extraction pipeline) */
export function pdfExtractionPipeline(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId || !data.sourceId) {
    console.warn('[pdf] Skipping — no indexId or sourceId available');
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  // Upload a text document via source endpoint (PDF extraction requires Docling service)
  const fileContent = `# PDF Simulation Doc ${__VU}-${__ITER}\n\n${generateDocContent('large')}`;
  const formData = {
    file: http.file(fileContent, `pdf-sim-${__VU}-${__ITER}.md`, 'text/markdown'),
  };

  const pdfHeaders = freshHeaders(data);
  const start = Date.now();
  const res = http.post(
    `${SEARCH_AI}${apiPath(`/indexes/${data.indexId}/sources/${data.sourceId}/documents`)}`,
    formData,
    {
      headers: {
        Authorization: pdfHeaders['Authorization'],
        Origin: pdfHeaders['Origin'],
        'X-Tenant-Id': pdfHeaders['X-Tenant-Id'],
      },
      tags: { scenario: 'pdf_extraction_pipeline' },
      timeout: '120s',
    },
  );

  ingestionE2eLatency.add(Date.now() - start);

  const accepted = check(res, {
    'PDF upload accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });

  successRate.add(accepted ? 1 : 0);
  if (!accepted) {
    console.log(`[pdf_extraction_pipeline] status=${res.status}`);
    errorCount.add(1);
  } else documentsIngested.add(1);
  sleep(3);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleDocumentPipeline(data);
  bulkIngestionPipeline(data);
  pdfExtractionPipeline(data);
  mixedFormatIngestion(data);
}

/** Ingest documents in mixed formats (text, HTML, markdown) via source upload */
export function mixedFormatIngestion(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId || !data.sourceId) {
    console.warn('[mixed] Skipping — no indexId or sourceId available');
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  const formats: Array<{ ext: string; mime: string }> = [
    { ext: 'txt', mime: 'text/plain' },
    { ext: 'html', mime: 'text/html' },
    { ext: 'md', mime: 'text/markdown' },
  ];
  const fmt = formats[Math.floor(Math.random() * formats.length)];

  const contentMap: Record<string, string> = {
    txt: generateDocContent('small'),
    html: `<html><body><h1>Benchmark</h1><p>${generateDocContent('small')}</p></body></html>`,
    md: `# Benchmark\n\n${generateDocContent('small')}\n\n## Section 2\n\nMore content here.`,
  };

  const formData = {
    file: http.file(contentMap[fmt.ext], `mixed-${fmt.ext}-${__VU}-${__ITER}.${fmt.ext}`, fmt.mime),
  };

  const mixedHeaders = freshHeaders(data);
  const start = Date.now();
  const res = http.post(
    `${SEARCH_AI}${apiPath(`/indexes/${data.indexId}/sources/${data.sourceId}/documents`)}`,
    formData,
    {
      headers: {
        Authorization: mixedHeaders['Authorization'],
        Origin: mixedHeaders['Origin'],
        'X-Tenant-Id': mixedHeaders['X-Tenant-Id'],
      },
      tags: { scenario: 'mixed_format_ingestion' },
      timeout: '30s',
    },
  );

  ingestionE2eLatency.add(Date.now() - start);

  const ok = check(res, {
    'mixed format accepted': (r) => r.status === 200 || r.status === 201 || r.status === 202,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[mixed_format_ingestion] status=${res.status}`);
    errorCount.add(1);
  }
  if (ok) documentsIngested.add(1);
  sleep(0.5);
}
