/**
 * Search AI Runtime Benchmarks
 *
 * Tests SearchAI read-heavy operations that exercise the query path:
 *   1. doc_listing    — List documents with pagination and filtering
 *   2. chunk_reads    — Read document chunks (the data served to queries)
 *   3. kb_reads       — List KBs, get KB details, get index details
 *   4. concurrent     — Concurrent read operations under load
 *
 * Run:
 *   k6 run benchmarks/services/search-ai-runtime.ts \
 *     -e SEARCH_AI_URL=https://agents-dev.kore.ai/api/search-ai
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config, apiPath, runHealthCheck } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { Trend, Rate } from 'k6/metrics';
import { successRate, errorCount } from '../lib/metrics.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = config.searchAiUrl;
const PROJECT_ID = config.projectId;

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

const docListLatency = new Trend('searchai_rt_doc_list_latency_ms', true);
const chunkReadLatency = new Trend('searchai_rt_chunk_read_latency_ms', true);
const kbReadLatency = new Trend('searchai_rt_kb_read_latency_ms', true);
const indexReadLatency = new Trend('searchai_rt_index_read_latency_ms', true);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options = {
  scenarios: {
    doc_listing: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'docListing',
      tags: { scenario: 'doc_listing' },
    },
    chunk_reads: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'chunkReads',
      startTime: '2m30s',
      tags: { scenario: 'chunk_reads' },
    },
    kb_reads: {
      executor: 'constant-vus',
      vus: 3,
      duration: '2m',
      exec: 'kbReads',
      startTime: '5m',
      tags: { scenario: 'kb_reads' },
    },
    concurrent: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '1m', target: 30 },
        { duration: '1m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      startTime: '7m30s',
      exec: 'concurrentReads',
      tags: { scenario: 'concurrent' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:doc_listing}': ['p(95)<2000', 'p(99)<5000'],
    'http_req_duration{scenario:chunk_reads}': ['p(95)<1500', 'p(99)<3000'],
    'http_req_duration{scenario:kb_reads}': ['p(95)<1000', 'p(99)<2000'],
    'http_req_duration{scenario:concurrent}': ['p(95)<3000', 'p(99)<5000'],
    http_req_failed: ['rate<0.05'],
    abl_success_rate: ['rate>0.90'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'search-ai-runtime-per-service',
    tags: {
      service: 'search-ai-runtime',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
  indexId: string;
  kbId: string;
  sampleDocIds: string[];
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  runHealthCheck(BASE, 'search-ai-runtime', headers);

  let indexId = '';
  let kbId = '';
  const sampleDocIds: string[] = [];

  // Discover index and KB from project
  const kbRes = http.get(`${BASE}${apiPath('/knowledge-bases')}?projectId=${PROJECT_ID}`, {
    headers,
  });
  if (kbRes.status === 200) {
    const body = kbRes.json() as {
      knowledgeBases?: Array<{ _id: string; searchIndexId: string; name: string }>;
    };
    const kbs = body.knowledgeBases || [];
    const benchKb = kbs.find((kb) => kb.name === 'benchmark-kb') || kbs[0];
    if (benchKb) {
      kbId = benchKb._id;
      indexId = benchKb.searchIndexId;
      console.log(`[setup] KB: ${benchKb.name} (${kbId}), Index: ${indexId}`);
    }
  }

  // Get sample document IDs for chunk reads
  if (indexId) {
    const docRes = http.get(`${BASE}${apiPath(`/indexes/${indexId}/documents`)}?limit=5`, {
      headers,
    });
    if (docRes.status === 200) {
      const body = docRes.json() as { documents?: Array<{ _id: string }> };
      const docs = body.documents || [];
      for (const doc of docs) {
        sampleDocIds.push(doc._id);
      }
      console.log(`[setup] Found ${sampleDocIds.length} sample documents`);
    }
  }

  if (!indexId) {
    console.warn('[setup] No index found — some scenarios will skip');
  }

  return { token, refreshToken, headers, indexId, kbId, sampleDocIds };
}

// ---------------------------------------------------------------------------
// Scenario 1: Document Listing with pagination
// ---------------------------------------------------------------------------

export function docListing(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId) {
    sleep(1);
    return;
  }

  const pages = [1, 2, 3];
  const limit = 10;

  for (const page of pages) {
    const skip = (page - 1) * limit;
    const start = Date.now();
    const res = http.get(
      `${BASE}${apiPath(`/indexes/${data.indexId}/documents`)}?limit=${limit}&skip=${skip}`,
      { headers: freshHeaders(data), tags: { name: 'GET /indexes/:id/documents' } },
    );
    docListLatency.add(Date.now() - start);

    const ok = check(res, {
      'list documents 200': (r) => r.status === 200,
    });

    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[list_documents] status=${res.status}`);
      errorCount.add(1);
    }
  }

  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Scenario 2: Chunk Reads — get document detail + chunks
// ---------------------------------------------------------------------------

export function chunkReads(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId || data.sampleDocIds.length === 0) {
    sleep(1);
    return;
  }

  const docId = data.sampleDocIds[__ITER % data.sampleDocIds.length];

  // Get document detail
  const detailStart = Date.now();
  const detailRes = http.get(`${BASE}${apiPath(`/indexes/${data.indexId}/documents/${docId}`)}`, {
    headers: freshHeaders(data),
    tags: { name: 'GET /indexes/:id/documents/:docId' },
  });

  const detailOk = check(detailRes, {
    'get document 200': (r) => r.status === 200,
  });
  successRate.add(detailOk ? 1 : 0);
  if (!detailOk) {
    console.log(`[get_document] status=${detailRes.status}`);
    errorCount.add(1);
  }

  // Get document chunks
  const chunkStart = Date.now();
  const chunkRes = http.get(
    `${BASE}${apiPath(`/indexes/${data.indexId}/documents/${docId}/chunks`)}?limit=10`,
    { headers: freshHeaders(data), tags: { name: 'GET /indexes/:id/documents/:docId/chunks' } },
  );
  chunkReadLatency.add(Date.now() - chunkStart);

  const chunkOk = check(chunkRes, {
    'get chunks 200': (r) => r.status === 200,
  });
  successRate.add(chunkOk ? 1 : 0);
  if (!chunkOk) {
    console.log(`[get_chunks] status=${chunkRes.status}`);
    errorCount.add(1);
  }

  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Scenario 3: KB Reads — list KBs, get KB detail, get index detail
// ---------------------------------------------------------------------------

export function kbReads(data: SetupData): void {
  ensureFreshAuth(data);

  // List KBs
  const listStart = Date.now();
  const listRes = http.get(`${BASE}${apiPath('/knowledge-bases')}?projectId=${PROJECT_ID}`, {
    headers: freshHeaders(data),
    tags: { name: 'GET /knowledge-bases' },
  });
  kbReadLatency.add(Date.now() - listStart);

  const listOk = check(listRes, {
    'list KBs 200': (r) => r.status === 200,
  });
  successRate.add(listOk ? 1 : 0);
  if (!listOk) {
    console.log(`[list_kbs] status=${listRes.status}`);
    errorCount.add(1);
  }

  // Get KB detail
  if (data.kbId) {
    const kbStart = Date.now();
    const kbRes = http.get(`${BASE}${apiPath(`/knowledge-bases/${data.kbId}`)}`, {
      headers: freshHeaders(data),
      tags: { name: 'GET /knowledge-bases/:id' },
    });
    kbReadLatency.add(Date.now() - kbStart);

    const kbOk = check(kbRes, { 'get KB detail 200': (r) => r.status === 200 });
    if (!kbOk) console.log(`[get_kb_detail] status=${kbRes.status}`);
  }

  // Get index detail
  if (data.indexId) {
    const idxStart = Date.now();
    const idxRes = http.get(`${BASE}${apiPath(`/indexes/${data.indexId}`)}`, {
      headers: freshHeaders(data),
      tags: { name: 'GET /indexes/:id' },
    });
    indexReadLatency.add(Date.now() - idxStart);

    const idxOk = check(idxRes, { 'get index detail 200': (r) => r.status === 200 });
    if (!idxOk) console.log(`[get_index_detail] status=${idxRes.status}`);
  }

  sleep(1);
}

// ---------------------------------------------------------------------------
// Scenario 4: Concurrent reads under load
// ---------------------------------------------------------------------------

export function concurrentReads(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId) {
    sleep(1);
    return;
  }

  // Mix of read operations
  const ops = ['list-docs', 'list-kbs', 'get-index'];
  const op = ops[__ITER % ops.length];

  let res;
  if (op === 'list-docs') {
    res = http.get(`${BASE}${apiPath(`/indexes/${data.indexId}/documents`)}?limit=5`, {
      headers: freshHeaders(data),
      tags: { name: 'GET /indexes/:id/documents (concurrent)' },
    });
  } else if (op === 'list-kbs') {
    res = http.get(`${BASE}${apiPath('/knowledge-bases')}?projectId=${PROJECT_ID}`, {
      headers: freshHeaders(data),
      tags: { name: 'GET /knowledge-bases (concurrent)' },
    });
  } else {
    res = http.get(`${BASE}${apiPath(`/indexes/${data.indexId}`)}`, {
      headers: freshHeaders(data),
      tags: { name: 'GET /indexes/:id (concurrent)' },
    });
  }

  const ok = check(res, {
    'concurrent read 200': (r) => r.status === 200,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[concurrent_read] status=${res.status}`);
    errorCount.add(1);
  }

  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  docListing(data);
  chunkReads(data);
  kbReads(data);
  concurrentReads(data);
}
