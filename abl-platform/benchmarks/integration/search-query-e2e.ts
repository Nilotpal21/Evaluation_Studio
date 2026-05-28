/**
 * Search Query E2E Benchmark
 *
 * Full flow: Search AI Runtime -> BGE-M3 -> OpenSearch
 * Tests the complete search query pipeline including vector search and reranking.
 *
 * Routes go through the Search AI ingress prefix (/api/search-ai-runtime/...)
 * using the actual API: POST /api/search/:indexId/query
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
import { vectorSearchLatency, agentTurnLatency, successRate, errorCount } from '../lib/metrics.ts';
import { vuScale, scaleStages, scaleArrivalRate } from '../lib/vu-scaling.ts';
import { Trend } from 'k6/metrics';

const SEARCH_AI = config.searchAiUrl;
const SEARCH_RT = config.searchAiRuntimeUrl;
const PROJECT_ID = config.projectId;

const embeddingLatency = new Trend('abl_embedding_latency_ms', true);
const rerankLatency = new Trend('abl_rerank_latency_ms', true);
const searchE2eLatency = new Trend('abl_search_e2e_latency_ms', true);

const SEARCH_QUERIES = [
  { query: 'How do I configure multi-agent delegation?', category: 'technical' },
  { query: 'What is the pricing for enterprise plans?', category: 'business' },
  { query: 'Troubleshoot agent timeout errors', category: 'support' },
  { query: 'Best practices for knowledge base organization', category: 'technical' },
  { query: 'How to set up SSO authentication', category: 'technical' },
  { query: 'Compare reasoning vs scripted agent types', category: 'technical' },
  { query: 'API rate limits and quotas', category: 'operational' },
  { query: 'Migrate from legacy intent-based platform', category: 'migration' },
];

// Baseline total: 50 (maxVUs) + 35 (maxVUs) + 5 + 60 (peak) = 150 VUs — scale via MAX_VUS env var
const scale = vuScale(150);
const directSearchRate = scaleArrivalRate(150, { rate: 20, preAllocatedVUs: 20, maxVUs: 50 });
const agentSearchRate = scaleArrivalRate(150, { rate: 10, preAllocatedVUs: 15, maxVUs: 35 });

export const options = {
  scenarios: {
    direct_search: {
      executor: 'constant-arrival-rate',
      rate: directSearchRate.rate,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: directSearchRate.preAllocatedVUs,
      maxVUs: directSearchRate.maxVUs,
      exec: 'directSearch',
    },
    agent_context_search: {
      executor: 'constant-arrival-rate',
      rate: agentSearchRate.rate,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: agentSearchRate.preAllocatedVUs,
      maxVUs: agentSearchRate.maxVUs,
      startTime: '3m',
      exec: 'agentContextSearch',
    },
    search_with_rerank: {
      executor: 'per-vu-iterations',
      vus: scale(5),
      iterations: 30,
      startTime: '6m',
      exec: 'searchWithRerank',
    },
    high_concurrency_search: {
      executor: 'ramping-vus',
      startVUs: scale(10),
      stages: scaleStages(
        [
          { duration: '1m', target: 30 },
          { duration: '3m', target: 60 },
          { duration: '1m', target: 60 },
          { duration: '1m', target: 0 },
        ],
        150,
      ),
      startTime: '10m',
      exec: 'highConcurrencySearch',
    },
  },
  thresholds: {
    'http_req_duration{scenario:direct_search}': ['p(95)<1000', 'p(99)<2000'],
    'http_req_duration{scenario:agent_context_search}': ['p(95)<2000', 'p(99)<5000'],
    'http_req_duration{scenario:search_with_rerank}': ['p(95)<3000', 'p(99)<6000'],
    'http_req_duration{scenario:high_concurrency_search}': ['p(95)<3000', 'p(99)<8000'],
    http_req_failed: ['rate<0.02'],
    abl_search_e2e_latency_ms: ['p(95)<2000', 'p(99)<5000'],
    abl_vector_search_latency_ms: ['p(95)<500'],
    abl_embedding_latency_ms: ['p(95)<200'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'search-query-integration',
    tags: {
      service: 'search-query',
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
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  runHealthCheck(SEARCH_RT, 'search-ai-runtime', headers);

  // Discover indexId from existing KBs
  let indexId = '';
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

  if (!indexId) {
    console.warn('[setup] No KB/index found — search scenarios will fail');
  }

  return { token, refreshToken, headers, indexId };
}

function pickSearchQuery(): { query: string; category: string } {
  return SEARCH_QUERIES[Math.floor(Math.random() * SEARCH_QUERIES.length)];
}

/** Direct search query to Search AI Runtime */
export function directSearch(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId) {
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  const { query } = pickSearchQuery();
  const payload = JSON.stringify({ query, topK: 5 });

  const start = Date.now();
  const res = http.post(`${SEARCH_RT}${apiPath(`/search/${data.indexId}/query`)}`, payload, {
    headers: freshHeaders(data),
    tags: { scenario: 'direct_search' },
  });

  const elapsed = Date.now() - start;
  searchE2eLatency.add(elapsed);
  vectorSearchLatency.add(elapsed);

  const ok = check(res, {
    'direct search 200': (r) => r.status === 200,
    'has results': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        return Array.isArray(body.results);
      } catch {
        return false;
      }
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[direct_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Search with different query parameters (simulating agent context) */
export function agentContextSearch(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId) {
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  const { query, category } = pickSearchQuery();

  group('agent-initiated search', () => {
    const payload = JSON.stringify({
      query,
      topK: 5,
      filters: { category },
    });

    const start = Date.now();
    const res = http.post(`${SEARCH_RT}${apiPath(`/search/${data.indexId}/query`)}`, payload, {
      headers: freshHeaders(data),
      tags: { scenario: 'agent_context_search' },
      timeout: '15s',
    });

    const elapsed = Date.now() - start;
    agentTurnLatency.add(elapsed);
    searchE2eLatency.add(elapsed);

    if (res.status === 200) {
      try {
        const body = res.json() as Record<string, unknown>;
        if (typeof body.embeddingLatencyMs === 'number')
          embeddingLatency.add(body.embeddingLatencyMs as number);
        if (typeof body.searchLatencyMs === 'number')
          vectorSearchLatency.add(body.searchLatencyMs as number);
      } catch {
        /* ignore */
      }
    }

    const ok = check(res, {
      'agent search 200': (r) => r.status === 200,
    });

    successRate.add(ok ? 1 : 0);
    if (!ok) {
      console.log(`[agent_context_search] status=${res.status}`);
      errorCount.add(1);
    }
  });

  sleep(0.1);
}

/** Search with re-ranking enabled (two-stage retrieval) */
export function searchWithRerank(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId) {
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  const { query } = pickSearchQuery();
  const payload = JSON.stringify({
    query,
    topK: 20,
    rerank: { enabled: true, model: 'cross-encoder', topN: 5 },
  });

  const start = Date.now();
  const res = http.post(`${SEARCH_RT}${apiPath(`/search/${data.indexId}/query`)}`, payload, {
    headers: freshHeaders(data),
    tags: { scenario: 'search_with_rerank' },
    timeout: '15s',
  });

  const elapsed = Date.now() - start;
  searchE2eLatency.add(elapsed);

  if (res.status === 200) {
    const body = res.json() as Record<string, unknown>;
    if (typeof body.embeddingLatencyMs === 'number')
      embeddingLatency.add(body.embeddingLatencyMs as number);
    if (typeof body.rerankLatencyMs === 'number') rerankLatency.add(body.rerankLatencyMs as number);
    if (typeof body.searchLatencyMs === 'number')
      vectorSearchLatency.add(body.searchLatencyMs as number);
  }

  const ok = check(res, {
    'reranked search 200': (r) => r.status === 200,
    'reranked results trimmed': (r) => {
      const body = r.json() as Record<string, unknown>;
      const results = body.results as unknown[];
      return !results || results.length <= 5;
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[search_with_rerank] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.2);
}

/** High concurrency search to measure pipeline under heavy load */
export function highConcurrencySearch(data: SetupData): void {
  ensureFreshAuth(data);

  if (!data.indexId) {
    successRate.add(0);
    errorCount.add(1);
    return;
  }

  const { query } = pickSearchQuery();
  const payload = JSON.stringify({ query, topK: 3 });

  const start = Date.now();
  const res = http.post(`${SEARCH_RT}${apiPath(`/search/${data.indexId}/query`)}`, payload, {
    headers: freshHeaders(data),
    tags: { scenario: 'high_concurrency_search' },
    timeout: '10s',
  });

  searchE2eLatency.add(Date.now() - start);

  const ok = check(res, {
    'concurrent search 200': (r) => r.status === 200,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[high_concurrency_search] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.02);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  directSearch(data);
  agentContextSearch(data);
  searchWithRerank(data);
  highConcurrencySearch(data);
}
