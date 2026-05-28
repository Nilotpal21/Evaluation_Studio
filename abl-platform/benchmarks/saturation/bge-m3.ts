/**
 * BGE-M3 Saturation Script
 *
 * Ramp-to-saturation test for the BGE-M3 embedding service.
 * Uses blended scenarios with weighted VU distribution to find
 * the service's saturation point under mixed workloads.
 *
 * Scenarios:
 *   1. single_embed     (30%) — Single document embedding
 *   2. batch_embed      (40%) — Batch of 10 documents
 *   3. concurrent_embed (30%) — High concurrency, minimal sleep
 *
 * Run:
 *   k6 run benchmarks/saturation/bge-m3.ts \
 *     -e BGE_M3_URL=http://bge-m3:8000 \
 *     -e MAX_VUS=100 \
 *     -e DURATION_MINUTES=15
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { Trend, Rate } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { config, runHealthCheck } from '../lib/config.ts';
import { getAuthToken, getRefreshToken, makeAuthHeaders, ensureFreshAuth } from '../lib/auth.ts';
import { embeddingThroughput, successRate, errorCount } from '../lib/metrics.ts';
import { buildBlendedScenarios, ScenarioExecMap } from '../lib/saturation-utils.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_VUS = parseInt(__ENV.MAX_VUS || '100', 10);
const DURATION_MINUTES = parseInt(__ENV.DURATION_MINUTES || '15', 10);

/** Override scenario weights via SCENARIO_WEIGHTS env var (JSON). */
const CUSTOM_WEIGHTS: Record<string, number> | undefined = __ENV.SCENARIO_WEIGHTS
  ? (JSON.parse(__ENV.SCENARIO_WEIGHTS) as Record<string, number>)
  : undefined;

/** HTTP request timeout (ms) */
const REQUEST_TIMEOUT_MS = 60_000;

/** Expected embedding dimension for BGE-M3 (1024-d) */
const EXPECTED_DIMENSION = 1024;

/** Batch size for batch_embed scenario */
const BATCH_SIZE = 10;

/** Batch size for concurrent_embed scenario */
const CONCURRENT_BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Scenario Exec Map
// ---------------------------------------------------------------------------

const SCENARIO_EXEC_MAP: ScenarioExecMap = {
  single_embed: 'singleEmbed',
  batch_embed: 'batchEmbed',
  concurrent_embed: 'concurrentEmbed',
};

// ---------------------------------------------------------------------------
// Sample Documents
// ---------------------------------------------------------------------------

const sampleDocuments = new SharedArray('saturation_bge_m3_documents', function () {
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

const singleEmbedLatency = new Trend('bge_m3_sat_single_embed_latency_ms', true);
const batchEmbedLatency = new Trend('bge_m3_sat_batch_embed_latency_ms', true);
const concurrentEmbedLatency = new Trend('bge_m3_sat_concurrent_embed_latency_ms', true);
const docsPerSecond = new Trend('bge_m3_sat_docs_per_second', true);
const perDocLatency = new Trend('bge_m3_sat_per_doc_latency_ms', true);
const dimensionCorrect = new Rate('bge_m3_sat_dimension_correct');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options: Options = {
  scenarios: buildBlendedScenarios(
    'bge-m3',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
    CUSTOM_WEIGHTS,
  ),
  thresholds: {
    // Single embed: p95 < 1s under saturation load
    bge_m3_sat_single_embed_latency_ms: ['p(95)<1000'],

    // Batch embed: p95 < 5s under saturation load
    bge_m3_sat_batch_embed_latency_ms: ['p(95)<5000'],

    // Per-doc latency should stay under 200ms even under saturation
    bge_m3_sat_per_doc_latency_ms: ['p(95)<200'],

    // Throughput floor: at least 5 docs/sec under saturation
    bge_m3_sat_docs_per_second: ['avg>5'],

    // Dimension correctness
    bge_m3_sat_dimension_correct: ['rate>0.99'],

    // General error budget — saturation tests tolerate slightly higher error rate
    http_req_failed: ['rate<0.10'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'bge-m3-saturation',
    tags: {
      service: 'bge-m3',
      type: 'saturation',
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
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  // Smoke-check: verify BGE-M3 is reachable (skipped if HEALTH_CHECK=false)
  runHealthCheck(config.bgeM3Url, 'bge-m3', headers);

  return { token, refreshToken, headers };
}

// ---------------------------------------------------------------------------
// Scenario 1: Single Embed (30% of VUs)
// ---------------------------------------------------------------------------

/**
 * POST /v1/embeddings with a single document.
 * Shorter sleep than the per-service benchmark to increase pressure.
 */
export function singleEmbed(data: SetupData): void {
  ensureFreshAuth(data);

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
    errorCount.add(1);
  }

  // Shorter sleep for saturation pressure
  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Scenario 2: Batch Embed (40% of VUs)
// ---------------------------------------------------------------------------

/**
 * POST /v1/embeddings with a batch of 10 documents.
 * Measures batch throughput under saturation load.
 */
export function batchEmbed(data: SetupData): void {
  ensureFreshAuth(data);

  const startIdx = ((__VU * 100 + __ITER) * BATCH_SIZE) % (sampleDocuments.length - BATCH_SIZE);
  const batchDocs: string[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
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
    tags: { name: `POST /v1/embeddings (batch_${BATCH_SIZE})` },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    [`batch_${BATCH_SIZE}: status is 200`]: (r) => r.status === 200,
    [`batch_${BATCH_SIZE}: correct embedding count`]: (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        const embeddings = body.data as unknown[];
        return embeddings.length === BATCH_SIZE;
      } catch {
        return false;
      }
    },
  });

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

  batchEmbedLatency.add(elapsed);
  perDocLatency.add(elapsed / BATCH_SIZE);
  docsPerSecond.add(elapsed > 0 ? (BATCH_SIZE * 1000) / elapsed : 0);
  dimensionCorrect.add(dimOk ? 1 : 0);
  successRate.add(ok ? 1 : 0);
  embeddingThroughput.add(elapsed > 0 ? (BATCH_SIZE * 1000) / elapsed : 0);

  if (!ok) {
    errorCount.add(1);
  }

  // Shorter sleep for saturation pressure
  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Scenario 3: Concurrent Embed (30% of VUs)
// ---------------------------------------------------------------------------

/**
 * POST /v1/embeddings with batch of 10 documents under high concurrency.
 * Minimal sleep to maximize pressure and find saturation point.
 */
export function concurrentEmbed(data: SetupData): void {
  ensureFreshAuth(data);

  const startIdx =
    ((__VU * 100 + __ITER) * CONCURRENT_BATCH_SIZE) %
    (sampleDocuments.length - CONCURRENT_BATCH_SIZE);
  const batchDocs: string[] = [];
  for (let i = 0; i < CONCURRENT_BATCH_SIZE; i++) {
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
    tags: { name: 'POST /v1/embeddings (concurrent)' },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    'concurrent_embed: status is 200': (r) => r.status === 200,
    'concurrent_embed: has embeddings': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        const embeddings = body.data as unknown[];
        return embeddings.length === CONCURRENT_BATCH_SIZE;
      } catch {
        return false;
      }
    },
  });

  concurrentEmbedLatency.add(elapsed);
  perDocLatency.add(elapsed / CONCURRENT_BATCH_SIZE);
  docsPerSecond.add(elapsed > 0 ? (CONCURRENT_BATCH_SIZE * 1000) / elapsed : 0);
  successRate.add(ok ? 1 : 0);
  embeddingThroughput.add(elapsed > 0 ? (CONCURRENT_BATCH_SIZE * 1000) / elapsed : 0);

  if (!ok) {
    errorCount.add(1);
  }

  // Minimal sleep for maximum concurrency pressure
  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleEmbed(data);
}
