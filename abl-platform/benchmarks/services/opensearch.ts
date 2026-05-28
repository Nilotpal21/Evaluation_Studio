/**
 * OpenSearch benchmark: document indexing, vector search, hybrid search.
 *
 * Targets the OpenSearch REST API for full-text indexing,
 * k-NN vector search with varying k values, and hybrid queries
 * combining BM25 with vector similarity.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.ts';
import { ensureFreshAuth } from '../lib/auth.ts';
import {
  dbQueryLatency,
  dbWriteLatency,
  successRate,
  vectorSearchLatency,
} from '../lib/metrics.ts';

const OS_URL = config.opensearchUrl;
const INDEX = 'abl-knowledge-bench';
const VECTOR_DIM = 1024; // BGE-M3 embedding dimension

function randomVector(dim: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    vec.push(Math.random() * 2 - 1);
  }
  return vec;
}

export const options = {
  scenarios: {
    documentIndex: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'documentIndex',
    },
    vectorSearchK5: {
      executor: 'constant-vus',
      vus: 8,
      duration: '2m',
      exec: 'vectorSearchK5',
    },
    vectorSearchK50: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'vectorSearchK50',
    },
    hybridSearch: {
      executor: 'ramping-vus',
      startVUs: 2,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '1m', target: 15 },
      ],
      exec: 'hybridSearch',
    },
  },
  thresholds: {
    abl_db_write_latency_ms: ['p(95)<500', 'p(99)<1000'],
    abl_vector_search_latency_ms: ['p(95)<200', 'p(99)<500'],
    abl_db_query_latency_ms: ['p(95)<300', 'p(99)<800'],
    abl_success_rate: ['rate>0.99'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'opensearch-per-service',
    tags: {
      service: 'opensearch',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
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

/** Index documents with text content and embedding vectors. */
export function documentIndex(data: SetupData): void {
  ensureFreshAuth(data);

  const docId = `bench-doc-${__VU}-${__ITER}`;
  const payload = JSON.stringify({
    title: `Benchmark Document ${__VU}-${__ITER}`,
    content:
      `This is a benchmark document for load testing OpenSearch indexing. ` +
      `VU ${__VU}, iteration ${__ITER}. It contains enough text to simulate ` +
      `a realistic knowledge base article with multiple paragraphs of content ` +
      `that would typically be chunked and embedded for semantic search.`,
    embedding: randomVector(VECTOR_DIM),
    tenantId: config.tenantId,
    projectId: config.projectId,
    sourceType: 'benchmark',
    createdAt: new Date().toISOString(),
  });

  const start = Date.now();
  const res = http.put(`${OS_URL}/${INDEX}/_doc/${docId}`, payload, { headers: data.headers });
  dbWriteLatency.add(Date.now() - start);

  const ok = check(res, { 'index 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[document_index] status=${res.status}`);

  sleep(0.05);
}

/** Vector-only k-NN search with k=5. */
export function vectorSearchK5(data: SetupData): void {
  ensureFreshAuth(data);

  vectorSearch(5, data);
}

/** Vector-only k-NN search with k=50. */
export function vectorSearchK50(data: SetupData): void {
  ensureFreshAuth(data);

  vectorSearch(50, data);
}

function vectorSearch(k: number, data: SetupData): void {
  const payload = JSON.stringify({
    size: k,
    query: {
      knn: {
        embedding: {
          vector: randomVector(VECTOR_DIM),
          k,
        },
      },
    },
    _source: ['title', 'content', 'tenantId'],
  });

  const start = Date.now();
  const res = http.post(`${OS_URL}/${INDEX}/_search`, payload, { headers: data.headers });
  const elapsed = Date.now() - start;
  vectorSearchLatency.add(elapsed);
  dbQueryLatency.add(elapsed);

  const ok = check(res, {
    [`knn k=${k} 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[vector_search_k${k}] status=${res.status}`);

  sleep(0.1);
}

/** Hybrid search combining BM25 full-text with vector similarity. */
export function hybridSearch(data: SetupData): void {
  ensureFreshAuth(data);

  const searchTerms = [
    'agent configuration deployment',
    'workflow execution error handling',
    'knowledge base ingestion pipeline',
    'multi-tenant session management',
    'guardrail constraint validation',
  ];
  const term = searchTerms[__ITER % searchTerms.length];
  const k = [5, 10, 50][__ITER % 3];

  const payload = JSON.stringify({
    size: k,
    query: {
      hybrid: {
        queries: [
          {
            match: {
              content: { query: term, boost: 0.3 },
            },
          },
          {
            knn: {
              embedding: { vector: randomVector(VECTOR_DIM), k },
            },
          },
        ],
      },
    },
    _source: ['title', 'content', 'tenantId'],
  });

  const start = Date.now();
  const res = http.post(`${OS_URL}/${INDEX}/_search`, payload, { headers: data.headers });
  const elapsed = Date.now() - start;
  vectorSearchLatency.add(elapsed);
  dbQueryLatency.add(elapsed);

  const ok = check(res, { 'hybrid 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[hybrid_search] status=${res.status}`);

  sleep(0.15);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  documentIndex(data);
}
