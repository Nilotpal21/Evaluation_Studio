/**
 * Crawler Service Benchmarks
 *
 * Tests: batch crawl submission, crawl status polling, concurrent crawls.
 * Target: Search AI crawl endpoints (POST /api/crawl/batch, GET /api/crawl/status).
 *
 * Requires bootstrap to have created a KB with an index and source.
 * Set INDEX_ID and SOURCE_ID env vars, or the test resolves them from the first KB.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { successRate, errorCount, rateLimitHits } from '../lib/metrics.ts';
import { Trend, Gauge, Counter } from 'k6/metrics';

const BASE = config.searchAiUrl;

const crawlSubmitLatency = new Trend('abl_crawl_submit_latency_ms', true);
const crawlStatusLatency = new Trend('abl_crawl_status_latency_ms', true);
const crawlJobsSubmitted = new Counter('abl_crawl_jobs_submitted');

const CRAWL_URLS = [
  'https://httpbin.org/',
  'https://httpbin.org/html',
  'https://httpbin.org/links/5',
];

export const options = {
  scenarios: {
    single_batch: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      exec: 'singleBatchCrawl',
    },
    crawl_status: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 3,
      startTime: '2m',
      exec: 'crawlStatusCheck',
    },
    concurrent_batches: {
      executor: 'constant-vus',
      vus: 3,
      duration: '2m',
      startTime: '4m',
      exec: 'concurrentBatchCrawl',
    },
  },
  thresholds: {
    'http_req_duration{scenario:single_batch}': ['p(95)<10000', 'p(99)<20000'],
    http_req_failed: ['rate<0.20'],
    abl_crawl_submit_latency_ms: ['p(95)<10000'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'crawler-service',
    tags: {
      service: 'crawler',
      type: 'service',
      tier: __ENV.TIER || 's',
      env: __ENV.ENV || 'staging',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup — resolve auth + index/source IDs
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

  // Resolve indexId and sourceId from env or from the first KB
  let indexId = __ENV.INDEX_ID || '';
  let sourceId = __ENV.SOURCE_ID || '';

  if (!indexId || !sourceId) {
    // List KBs to find a valid index and source
    const kbRes = http.get(`${BASE}/knowledge-bases?projectId=${config.projectId}`, { headers });
    if (kbRes.status === 200) {
      const body = kbRes.json() as {
        knowledgeBases?: Array<{
          indexId?: string;
          sources?: Array<{ _id?: string; id?: string }>;
        }>;
      };
      const kbs = body.knowledgeBases || [];
      for (const kb of kbs) {
        if (kb.indexId && kb.sources && kb.sources.length > 0) {
          indexId = kb.indexId;
          sourceId = kb.sources[0]._id || kb.sources[0].id || '';
          break;
        }
      }
    }
  }

  console.log(`[crawler-setup] indexId: ${indexId || '(none)'}`);
  console.log(`[crawler-setup] sourceId: ${sourceId || '(none)'}`);

  if (!indexId || !sourceId) {
    console.warn('[crawler-setup] No indexId/sourceId found — crawl tests will fail with 400');
  }

  return { token, refreshToken, headers, indexId, sourceId };
}

// ---------------------------------------------------------------------------
// Helper: submit a batch crawl
// ---------------------------------------------------------------------------

function submitBatchCrawl(
  data: SetupData,
  urls: string[],
  scenarioTag: string,
): { ok: boolean; jobId: string | null } {
  const payload = JSON.stringify({
    indexId: data.indexId,
    sourceId: data.sourceId,
    urls,
    strategy: 'static',
    limits: { maxPages: 10, maxDepth: 1, timeout: 15000 },
  });

  const start = Date.now();
  const res = http.post(`${BASE}${apiPath('/crawl/batch')}`, payload, {
    headers: freshHeaders(data),
    tags: { scenario: scenarioTag },
    timeout: '30s',
  });
  crawlSubmitLatency.add(Date.now() - start);

  if (res.status === 429) {
    rateLimitHits.add(1);
    successRate.add(0);
    return { ok: false, jobId: null };
  }

  const ok = check(res, {
    'batch crawl accepted': (r) => r.status === 200 || r.status === 202,
  });

  if (ok) {
    crawlJobsSubmitted.add(1);
    const body = res.json() as Record<string, unknown>;
    const jobId = (body.jobId as string) || '';
    successRate.add(1);
    return { ok: true, jobId };
  }

  errorCount.add(1);
  successRate.add(0);

  // Log the error for debugging
  const bodyStr = (res.body as string) || '';
  console.warn(`[crawler] Batch crawl returned ${res.status}: ${bodyStr.substring(0, 200)}`);

  return { ok: false, jobId: null };
}

// ---------------------------------------------------------------------------
// Scenario 1: Single batch crawl submission
// ---------------------------------------------------------------------------

export function singleBatchCrawl(data: SetupData): void {
  ensureFreshAuth(data);

  const result = submitBatchCrawl(data, [CRAWL_URLS[__ITER % CRAWL_URLS.length]], 'single_batch');

  // If job was accepted, poll status once
  if (result.jobId) {
    sleep(2);
    const statusRes = http.get(`${BASE}${apiPath('/crawl/status')}`, {
      headers: freshHeaders(data),
      tags: { scenario: 'single_batch' },
    });
    check(statusRes, {
      'crawl status 200': (r) => r.status === 200,
    });
  }

  sleep(1);
}

// ---------------------------------------------------------------------------
// Scenario 2: Crawl status endpoint
// ---------------------------------------------------------------------------

export function crawlStatusCheck(data: SetupData): void {
  ensureFreshAuth(data);

  const start = Date.now();
  const res = http.get(`${BASE}${apiPath('/crawl/status')}`, {
    headers: freshHeaders(data),
    tags: { scenario: 'crawl_status' },
  });
  crawlStatusLatency.add(Date.now() - start);

  check(res, {
    'status endpoint 200': (r) => r.status === 200,
  });

  successRate.add(res.status === 200 ? 1 : 0);
  if (res.status !== 200) {
    console.log(`[crawl_status] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(1);
}

// ---------------------------------------------------------------------------
// Scenario 3: Concurrent batch crawl submissions
// ---------------------------------------------------------------------------

export function concurrentBatchCrawl(data: SetupData): void {
  ensureFreshAuth(data);

  const url = CRAWL_URLS[__ITER % CRAWL_URLS.length];
  submitBatchCrawl(data, [url], 'concurrent_batches');
  sleep(2);
}

// ---------------------------------------------------------------------------
// Default export — smoke test
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleBatchCrawl(data);
  crawlStatusCheck(data);
  concurrentBatchCrawl(data);
}
