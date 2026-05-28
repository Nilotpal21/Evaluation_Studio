/**
 * Preprocessing Service Benchmarks
 *
 * Tests: query preprocessing, entity extraction, batch processing.
 * Target: Preprocessing service at port 8003.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { config } from '../lib/config.ts';
import { ensureFreshAuth } from '../lib/auth.ts';
import { successRate, errorCount } from '../lib/metrics.ts';
import { Trend } from 'k6/metrics';

const BASE = config.preprocessingUrl;

const preprocessLatency = new Trend('abl_preprocess_latency_ms', true);
const entityExtractionLatency = new Trend('abl_entity_extraction_latency_ms', true);
const batchPreprocessLatency = new Trend('abl_batch_preprocess_latency_ms', true);

const SAMPLE_QUERIES = [
  'Book a flight from New York to London on March 15th for 2 adults',
  'What is the refund policy for orders over $500?',
  'Schedule a meeting with John Smith tomorrow at 3pm',
  'Transfer $1,000 from checking to savings account',
  'I need to cancel my subscription ending on December 31st',
  'Find restaurants near 123 Main Street, San Francisco, CA 94102',
  'How do I reset my password for account user@example.com?',
  'Show me all transactions from last week above $50',
];

const LONG_DOCUMENTS = [
  'The quarterly financial report shows revenue growth of 15% year-over-year. ' +
    'Key metrics include customer acquisition cost of $42, lifetime value of $380, ' +
    'and monthly active users reaching 2.3 million. The engineering team completed ' +
    'migration to the new infrastructure, reducing latency by 40%.',
];

export const options = {
  scenarios: {
    query_preprocess: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 30,
      maxVUs: 80,
      exec: 'queryPreprocess',
    },
    entity_extraction: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 15,
      maxVUs: 40,
      startTime: '3m',
      exec: 'entityExtraction',
    },
    batch_preprocess: {
      executor: 'per-vu-iterations',
      vus: 5,
      iterations: 20,
      startTime: '6m',
      exec: 'batchPreprocess',
    },
    sustained_load: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '3m', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 0 },
      ],
      startTime: '9m',
      exec: 'sustainedPreprocess',
    },
  },
  thresholds: {
    'http_req_duration{scenario:query_preprocess}': ['p(95)<200', 'p(99)<500'],
    'http_req_duration{scenario:entity_extraction}': ['p(95)<500', 'p(99)<1000'],
    'http_req_duration{scenario:batch_preprocess}': ['p(95)<3000', 'p(99)<5000'],
    'http_req_duration{scenario:sustained_load}': ['p(95)<300', 'p(99)<800'],
    http_req_failed: ['rate<0.01'],
    abl_preprocess_latency_ms: ['p(95)<200', 'p(99)<500'],
    abl_entity_extraction_latency_ms: ['p(95)<500'],
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

function pickQuery(): string {
  return SAMPLE_QUERIES[Math.floor(Math.random() * SAMPLE_QUERIES.length)];
}

/** Preprocess a single user query (normalization, spell-check, intent hints) */
export function queryPreprocess(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    text: pickQuery(),
    options: { normalize: true, spellCheck: true, detectLanguage: true },
  });

  const start = Date.now();
  const res = http.post(`${BASE}/api/preprocess`, payload, {
    headers: data.headers,
    tags: { scenario: 'query_preprocess' },
  });

  preprocessLatency.add(Date.now() - start);

  const ok = check(res, {
    'preprocess 200': (r) => r.status === 200,
    'has processed text': (r) => {
      const body = r.json() as Record<string, unknown>;
      return typeof body.processedText === 'string' || typeof body.text === 'string';
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[query_preprocess] status=${res.status}`);
    errorCount.add(1);
  }
}

/** Extract named entities from a query */
export function entityExtraction(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    text: pickQuery(),
    options: {
      extractEntities: true,
      entityTypes: ['person', 'date', 'money', 'location', 'email', 'phone'],
    },
  });

  const start = Date.now();
  const res = http.post(`${BASE}/api/entities`, payload, {
    headers: data.headers,
    tags: { scenario: 'entity_extraction' },
  });

  entityExtractionLatency.add(Date.now() - start);

  const ok = check(res, {
    'entity extraction 200': (r) => r.status === 200,
    'has entities array': (r) => {
      const body = r.json() as Record<string, unknown>;
      return Array.isArray(body.entities);
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[entity_extraction] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

/** Batch preprocess multiple queries in one request */
export function batchPreprocess(data: SetupData): void {
  ensureFreshAuth(data);

  const batchSize = 20;
  const texts = Array.from({ length: batchSize }, () => pickQuery());

  const payload = JSON.stringify({
    texts,
    options: { normalize: true, spellCheck: true, extractEntities: true },
  });

  const start = Date.now();
  const res = http.post(`${BASE}/api/preprocess/batch`, payload, {
    headers: data.headers,
    tags: { scenario: 'batch_preprocess' },
    timeout: '15s',
  });

  batchPreprocessLatency.add(Date.now() - start);

  const ok = check(res, {
    'batch preprocess 200': (r) => r.status === 200,
    'all items processed': (r) => {
      const body = r.json() as Record<string, unknown>;
      return Array.isArray(body.results) && (body.results as unknown[]).length === batchSize;
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[batch_preprocess] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.5);
}

/** Sustained load of mixed preprocessing operations */
export function sustainedPreprocess(data: SetupData): void {
  ensureFreshAuth(data);

  const isEntity = Math.random() > 0.6;
  const text = Math.random() > 0.8 ? LONG_DOCUMENTS[0] : pickQuery();

  const endpoint = isEntity ? '/api/entities' : '/api/preprocess';
  const payload = JSON.stringify({
    text,
    options: isEntity
      ? { extractEntities: true, entityTypes: ['person', 'date', 'money', 'location'] }
      : { normalize: true, spellCheck: true },
  });

  const start = Date.now();
  const res = http.post(`${BASE}${endpoint}`, payload, {
    headers: data.headers,
    tags: { scenario: 'sustained_load' },
  });

  preprocessLatency.add(Date.now() - start);

  const ok = check(res, { 'sustained 200': (r) => r.status === 200 });
  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[sustained_load] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.02);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  queryPreprocess(data);
}
