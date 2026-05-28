/**
 * Qdrant benchmark: point upsert, vector search, filtered search.
 *
 * Targets the Qdrant REST API for high-performance vector operations
 * used by the SearchAI embedding and retrieval pipeline.
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

const QDRANT_URL = config.qdrantUrl;
const COLLECTION = 'abl_knowledge_bench';
const VECTOR_DIM = 1024; // BGE-M3 dimension

function randomVector(dim: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    vec.push(Math.random() * 2 - 1);
  }
  return vec;
}

export const options = {
  scenarios: {
    pointUpsert: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'pointUpsert',
    },
    searchK5: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
      exec: 'searchK5',
    },
    searchK10: {
      executor: 'constant-vus',
      vus: 8,
      duration: '2m',
      exec: 'searchK10',
    },
    searchK50: {
      executor: 'constant-vus',
      vus: 5,
      duration: '2m',
      exec: 'searchK50',
    },
    filteredSearch: {
      executor: 'ramping-vus',
      startVUs: 3,
      stages: [
        { duration: '1m', target: 10 },
        { duration: '1m', target: 15 },
      ],
      exec: 'filteredSearch',
    },
  },
  thresholds: {
    abl_db_write_latency_ms: ['p(95)<300', 'p(99)<600'],
    abl_vector_search_latency_ms: ['p(95)<100', 'p(99)<300'],
    abl_success_rate: ['rate>0.99'],
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

/** Batch upsert points with vectors and metadata payloads. */
export function pointUpsert(data: SetupData): void {
  ensureFreshAuth(data);

  const batchSize = 50;
  const points = Array.from({ length: batchSize }, (_, i) => {
    const pointId = __VU * 100000 + __ITER * batchSize + i;
    return {
      id: pointId,
      vector: randomVector(VECTOR_DIM),
      payload: {
        tenant_id: config.tenantId,
        project_id: config.projectId,
        source_type: ['document', 'faq', 'conversation'][i % 3],
        chunk_index: i,
        content: `Benchmark chunk ${pointId} for vector search testing`,
        created_at: new Date().toISOString(),
      },
    };
  });

  const start = Date.now();
  const res = http.put(
    `${QDRANT_URL}/collections/${COLLECTION}/points`,
    JSON.stringify({ points }),
    { headers: data.headers },
  );
  dbWriteLatency.add(Date.now() - start);

  const ok = check(res, { 'upsert 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[point_upsert] status=${res.status}`);

  sleep(0.1);
}

/** Vector search with k=5 (high precision, low recall). */
export function searchK5(data: SetupData): void {
  ensureFreshAuth(data);

  vectorSearch(5, data);
}

/** Vector search with k=10 (balanced). */
export function searchK10(data: SetupData): void {
  ensureFreshAuth(data);

  vectorSearch(10, data);
}

/** Vector search with k=50 (high recall). */
export function searchK50(data: SetupData): void {
  ensureFreshAuth(data);

  vectorSearch(50, data);
}

function vectorSearch(k: number, data: SetupData): void {
  const payload = JSON.stringify({
    vector: randomVector(VECTOR_DIM),
    limit: k,
    with_payload: true,
    with_vector: false,
  });

  const start = Date.now();
  const res = http.post(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, payload, {
    headers: data.headers,
  });
  const elapsed = Date.now() - start;
  vectorSearchLatency.add(elapsed);
  dbQueryLatency.add(elapsed);

  const ok = check(res, { [`search k=${k} 2xx`]: (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[vector_search_k${k}] status=${res.status}`);

  sleep(0.05);
}

/** Filtered vector search with tenant/project/source_type constraints. */
export function filteredSearch(data: SetupData): void {
  ensureFreshAuth(data);

  const sourceTypes = ['document', 'faq', 'conversation'];
  const sourceType = sourceTypes[__ITER % sourceTypes.length];
  const kValues = [5, 10, 50];
  const k = kValues[__ITER % kValues.length];

  const payload = JSON.stringify({
    vector: randomVector(VECTOR_DIM),
    limit: k,
    with_payload: true,
    with_vector: false,
    filter: {
      must: [
        { key: 'tenant_id', match: { value: config.tenantId } },
        { key: 'project_id', match: { value: config.projectId } },
        { key: 'source_type', match: { value: sourceType } },
      ],
    },
  });

  const start = Date.now();
  const res = http.post(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, payload, {
    headers: data.headers,
  });
  const elapsed = Date.now() - start;
  vectorSearchLatency.add(elapsed);
  dbQueryLatency.add(elapsed);

  const ok = check(res, { 'filtered search 2xx': (r) => r.status >= 200 && r.status < 300 });
  successRate.add(ok ? 1 : 0);
  if (!ok) console.log(`[filtered_search] status=${res.status}`);

  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  pointUpsert(data);
}
