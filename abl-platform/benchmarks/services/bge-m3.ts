/**
 * BGE-M3 Embedding Service Micro-Benchmark
 *
 * Exercises the BGE-M3 embedding service across three scenarios:
 *   1. single_embed    — POST /v1/embeddings with a single document
 *   2. batch_embed     — POST /v1/embeddings with batch sizes 16/32/64/128
 *   3. concurrent_embed — Ramp 1→80 VUs with batch size 32 (cloud-safe)
 *
 * Both the OpenAI-compatible endpoint (/v1/embeddings) and the legacy
 * endpoint (/embed) are supported — the benchmark uses the OpenAI format
 * since that is the primary production interface.
 *
 * Run:
 *   k6 run benchmarks/services/bge-m3.ts \
 *     -e BGE_M3_URL=http://bge-m3:8000
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { Trend, Counter, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { config, runHealthCheck } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import { embeddingThroughput, successRate, errorCount } from '../lib/metrics.ts';
import { vuScale, scaleStages } from '../lib/vu-scaling.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Batch sizes to exercise in the batch_embed scenario */
const BATCH_SIZES = [16, 32, 64, 128];

/** Default batch size for the concurrent ramp scenario */
const CONCURRENT_BATCH_SIZE = 32;

/** HTTP request timeout (ms) — embedding large batches can be slow */
const REQUEST_TIMEOUT_MS = 60_000;

/** Expected embedding dimension for BGE-M3 (1024-d) */
const EXPECTED_DIMENSION = 1024;

/** Pause between iterations to avoid overwhelming the service */
const INTER_REQUEST_DELAY_SEC = 0.5;

// ---------------------------------------------------------------------------
// Sample Documents
// ---------------------------------------------------------------------------

/**
 * Pre-generated sample documents for consistent benchmarking.
 * Each document is a realistic snippet (~100-300 tokens) to exercise the
 * tokenizer and model at production-representative input sizes.
 */
const sampleDocuments = new SharedArray('benchmark_documents', function () {
  const docs: string[] = [];
  const topics = [
    'Customer onboarding workflow with identity verification, KYC checks, and account provisioning steps',
    'Troubleshooting guide for network connectivity issues in distributed microservices architecture',
    'Product return policy covering international shipments, defective items, and restocking procedures',
    'Employee benefits enrollment including health insurance, retirement plans, and stock options',
    'Incident response playbook for security breaches including containment, eradication, and recovery',
    'API rate limiting and throttling strategies for multi-tenant SaaS platforms',
    'Data migration procedures from legacy on-premise systems to cloud-native infrastructure',
    'Machine learning model deployment pipeline with A/B testing and canary release patterns',
    'Compliance documentation for SOC2 Type II audit covering access controls and encryption',
    'Real-time analytics pipeline using event sourcing, CQRS, and materialized views',
    'Customer support escalation matrix with SLA tiers, response times, and routing rules',
    'Database schema migration best practices including zero-downtime strategies and rollback plans',
    'Container orchestration patterns for GPU workloads including scheduling and resource quotas',
    'Multi-region disaster recovery with RPO and RTO targets for mission-critical financial systems',
    'Natural language understanding pipeline with entity extraction, intent classification, and slot filling',
    'Knowledge graph construction from unstructured documents using relation extraction and entity linking',
    'Conversational AI design patterns including fallback handling, disambiguation, and context management',
    'CI/CD pipeline optimization with parallel test execution, artifact caching, and deployment gates',
    'Observability stack configuration with distributed tracing, structured logging, and metric aggregation',
    'Webhook delivery system with retry policies, dead letter queues, and idempotency guarantees',
    'Role-based access control implementation with permission inheritance and dynamic policy evaluation',
    'Search relevance tuning with BM25, semantic reranking, and reciprocal rank fusion strategies',
    'Streaming data processing with exactly-once semantics, watermarking, and windowed aggregations',
    'API versioning strategies including URI versioning, header versioning, and content negotiation',
    'Load testing methodology for determining service scaling curves and saturation thresholds',
    'Document processing pipeline with OCR, table extraction, layout analysis, and semantic chunking',
    'Agent orchestration patterns including supervisor delegation, tool routing, and handoff protocols',
    'Vector database indexing strategies including HNSW, IVF-PQ, and scalar quantization trade-offs',
    'Multi-tenant data isolation patterns with row-level security, schema separation, and encryption',
    'Workflow engine design with durable execution, compensation, and saga pattern implementation',
    'Voice AI integration covering ASR, TTS, DTMF, and real-time media streaming protocols',
    'Feature flag management with gradual rollouts, user targeting, and experimentation frameworks',
  ];

  // Generate 128 documents (enough for the largest batch size)
  for (let i = 0; i < 128; i++) {
    const topicIdx = i % topics.length;
    const variation = Math.floor(i / topics.length);
    docs.push(
      `Document ${i + 1} (v${variation + 1}): ${topics[topicIdx]}. ` +
        `This document provides detailed guidance and step-by-step instructions ` +
        `for implementing enterprise-grade solutions. It covers common pitfalls, ` +
        `recommended approaches, and production-ready configurations that have been ` +
        `validated across multiple deployment environments and customer scenarios.`,
    );
  }

  return docs;
});

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

/** Latency for a single-document embedding request */
const singleEmbedLatency = new Trend('bge_m3_single_embed_latency_ms', true);

/** Latency for batch embedding requests, tagged by batch size */
const batchEmbedLatency = new Trend('bge_m3_batch_embed_latency_ms', true);

/** Documents processed per second (computed per request) */
const docsPerSecond = new Trend('bge_m3_docs_per_second', true);

/** Latency per document within a batch (total / batch_size) */
const perDocLatency = new Trend('bge_m3_per_doc_latency_ms', true);

/** Tracks embedding dimension correctness */
const dimensionCorrect = new Rate('bge_m3_dimension_correct');

/** Batch-size-specific latency trends */
const batchLatency16 = new Trend('bge_m3_batch_16_latency_ms', true);
const batchLatency32 = new Trend('bge_m3_batch_32_latency_ms', true);
const batchLatency64 = new Trend('bge_m3_batch_64_latency_ms', true);
const batchLatency128 = new Trend('bge_m3_batch_128_latency_ms', true);

/** Map batch size to its dedicated metric */
const batchLatencyMetrics: Record<number, Trend> = {
  16: batchLatency16,
  32: batchLatency32,
  64: batchLatency64,
  128: batchLatency128,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// Baseline total: 5 + 4 + 80 (peak) = 89 VUs — scale via MAX_VUS env var
const scale = vuScale(89);

export const options: Options = {
  scenarios: {
    single_embed: {
      executor: 'constant-vus',
      vus: scale(5),
      duration: '2m',
      exec: 'singleEmbed',
      tags: { scenario: 'single_embed' },
    },
    batch_embed: {
      executor: 'per-vu-iterations',
      vus: scale(4),
      iterations: 20,
      exec: 'batchEmbed',
      startTime: '2m30s',
      tags: { scenario: 'batch_embed' },
    },
    concurrent_embed: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: scaleStages(
        [
          { duration: '1m', target: 10 },
          { duration: '1m30s', target: 40 },
          { duration: '1m30s', target: 80 },
          { duration: '1m', target: 0 },
        ],
        89,
      ),
      exec: 'concurrentEmbed',
      startTime: '5m30s',
      tags: { scenario: 'concurrent_embed' },
    },
  },
  thresholds: {
    // Single embed: p95 < 500ms
    bge_m3_single_embed_latency_ms: ['p(95)<500', 'p(99)<1000'],

    // Batch p95 by size — allow proportional scaling
    bge_m3_batch_16_latency_ms: ['p(95)<2000'],
    bge_m3_batch_32_latency_ms: ['p(95)<4000'],
    bge_m3_batch_64_latency_ms: ['p(95)<8000'],
    bge_m3_batch_128_latency_ms: ['p(95)<16000'],

    // Per-doc latency should stay under 100ms even in batches
    bge_m3_per_doc_latency_ms: ['p(95)<100'],

    // Throughput floor: at least 10 docs/sec on average
    bge_m3_docs_per_second: ['avg>10'],

    // Dimension correctness: 100% of embeddings match expected dimension
    bge_m3_dimension_correct: ['rate>0.99'],

    // General error budget
    http_req_failed: ['rate<0.05'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'bge-m3-per-service',
    tags: {
      service: 'bge-m3',
      type: 'per-service',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
};

// ---------------------------------------------------------------------------
// Setup — verify BGE-M3 service is reachable
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  // Health check (skipped if HEALTH_CHECK=false)
  runHealthCheck(config.bgeM3Url, 'bge-m3', headers);

  return { token, refreshToken, headers };
}

// ---------------------------------------------------------------------------
// Scenario 1: Single Embed
// ---------------------------------------------------------------------------

/**
 * POST /v1/embeddings with a single document.
 * Measures baseline single-document embedding latency.
 */
export function singleEmbed(data: SetupData): void {
  ensureFreshAuth(data);

  // Rotate through sample documents for variety
  const docIndex = (__VU * 1000 + __ITER) % sampleDocuments.length;
  const payload = JSON.stringify({
    input: sampleDocuments[docIndex],
    model: 'bge-m3',
  });

  const startMs = Date.now();
  const response = http.post(`${config.bgeM3Url}/v1/embeddings`, payload, {
    headers: data.headers,
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { name: 'POST /v1/embeddings (single)' },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    'single_embed: status is 200': (r) => r.status === 200,
    'single_embed: has data array': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        return Array.isArray(body.data);
      } catch {
        return false;
      }
    },
  });

  // Validate embedding dimension
  let dimOk = false;
  if (ok) {
    try {
      const body = response.json() as Record<string, unknown>;
      const embeddings = body.data as Array<Record<string, unknown>>;
      if (embeddings.length > 0) {
        const embedding = embeddings[0].embedding as number[];
        dimOk = embedding.length === EXPECTED_DIMENSION;
      }
    } catch {
      dimOk = false;
    }
  }

  singleEmbedLatency.add(elapsed);
  docsPerSecond.add(elapsed > 0 ? 1000 / elapsed : 0);
  perDocLatency.add(elapsed);
  dimensionCorrect.add(dimOk ? 1 : 0);
  successRate.add(ok ? 1 : 0);
  embeddingThroughput.add(elapsed > 0 ? 1000 / elapsed : 0);

  if (!ok) {
    console.log(`[single_embed] status=${response.status}`);
    errorCount.add(1);
  }

  sleep(INTER_REQUEST_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Scenario 2: Batch Embed (16/32/64/128)
// ---------------------------------------------------------------------------

/**
 * POST /v1/embeddings with batch sizes 16, 32, 64, 128.
 * Each VU cycles through the batch sizes to ensure coverage.
 * Measures batch latency and per-document throughput.
 */
export function batchEmbed(data: SetupData): void {
  ensureFreshAuth(data);

  // Cycle through batch sizes: VU 0→16, VU 1→32, VU 2→64, VU 3→128
  const batchSizeIndex = (__VU - 1) % BATCH_SIZES.length;
  const batchSize = BATCH_SIZES[batchSizeIndex];

  // Slice sample documents for this batch
  const startIdx = (__ITER * batchSize) % (sampleDocuments.length - batchSize);
  const batchDocs: string[] = [];
  for (let i = 0; i < batchSize; i++) {
    batchDocs.push(sampleDocuments[startIdx + i]);
  }

  const payload = JSON.stringify({
    input: batchDocs,
    model: 'bge-m3',
  });

  const startMs = Date.now();
  const response = http.post(`${config.bgeM3Url}/v1/embeddings`, payload, {
    headers: data.headers,
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { name: `POST /v1/embeddings (batch_${batchSize})` },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    [`batch_${batchSize}: status is 200`]: (r) => r.status === 200,
    [`batch_${batchSize}: correct embedding count`]: (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        const embeddings = body.data as unknown[];
        return embeddings.length === batchSize;
      } catch {
        return false;
      }
    },
  });

  // Validate dimensions on first embedding in batch
  let dimOk = false;
  if (ok) {
    try {
      const body = response.json() as Record<string, unknown>;
      const embeddings = body.data as Array<Record<string, unknown>>;
      if (embeddings.length > 0) {
        const embedding = embeddings[0].embedding as number[];
        dimOk = embedding.length === EXPECTED_DIMENSION;
      }
    } catch {
      dimOk = false;
    }
  }

  // Record metrics
  batchEmbedLatency.add(elapsed);
  perDocLatency.add(elapsed / batchSize);
  docsPerSecond.add(elapsed > 0 ? (batchSize * 1000) / elapsed : 0);
  dimensionCorrect.add(dimOk ? 1 : 0);
  successRate.add(ok ? 1 : 0);
  embeddingThroughput.add(elapsed > 0 ? (batchSize * 1000) / elapsed : 0);

  // Record to batch-size-specific metric
  const batchMetric = batchLatencyMetrics[batchSize];
  if (batchMetric) {
    batchMetric.add(elapsed);
  }

  if (!ok) {
    console.log(`[batch_embed] status=${response.status}`);
    errorCount.add(1);
  }

  sleep(INTER_REQUEST_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Scenario 3: Concurrent Embed (Ramp 1→100 VUs, batch=32)
// ---------------------------------------------------------------------------

/**
 * Same workload as batch_embed with batch_size=32 but under ramping
 * concurrency from 1 to 100 VUs. Used to find the saturation point
 * and measure throughput degradation under load.
 */
export function concurrentEmbed(data: SetupData): void {
  ensureFreshAuth(data);

  const batchSize = CONCURRENT_BATCH_SIZE;

  // Rotate through document windows
  const startIdx = ((__VU * 100 + __ITER) * batchSize) % (sampleDocuments.length - batchSize);
  const batchDocs: string[] = [];
  for (let i = 0; i < batchSize; i++) {
    batchDocs.push(sampleDocuments[startIdx + i]);
  }

  const payload = JSON.stringify({
    input: batchDocs,
    model: 'bge-m3',
  });

  const startMs = Date.now();
  const response = http.post(`${config.bgeM3Url}/v1/embeddings`, payload, {
    headers: data.headers,
    timeout: `${REQUEST_TIMEOUT_MS}ms`,
    tags: { name: 'POST /v1/embeddings (concurrent_32)' },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    'concurrent_embed: status is 200': (r) => r.status === 200,
    'concurrent_embed: has embeddings': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        const embeddings = body.data as unknown[];
        return embeddings.length === batchSize;
      } catch {
        return false;
      }
    },
  });

  // Record metrics
  batchEmbedLatency.add(elapsed);
  batchLatency32.add(elapsed);
  perDocLatency.add(elapsed / batchSize);
  docsPerSecond.add(elapsed > 0 ? (batchSize * 1000) / elapsed : 0);
  successRate.add(ok ? 1 : 0);
  embeddingThroughput.add(elapsed > 0 ? (batchSize * 1000) / elapsed : 0);

  if (!ok) {
    console.log(`[concurrent_embed] status=${response.status}`);
    errorCount.add(1);
  }

  // Shorter sleep under concurrency to increase pressure
  sleep(0.3);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleEmbed(data);
}
