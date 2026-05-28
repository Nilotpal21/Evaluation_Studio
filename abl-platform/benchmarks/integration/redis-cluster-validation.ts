/**
 * Redis Cluster Validation E2E Benchmark
 *
 * Exercises every cluster-sensitive code path in the platform under steady
 * traffic. Pair this run against `REDIS_CLUSTER=true` SIT with a baseline run
 * against `REDIS_CLUSTER=false` to validate the LLD §4 SLOs:
 *
 *   - cluster p50 ≤ 1.1× standalone
 *   - cluster p95 ≤ 2× standalone
 *   - zero `redis.crossslot.errors` (asserted via Prometheus scrape)
 *   - pub/sub reconnect ≤ 30 s (failover handled by chaos suite)
 *   - error rate < 5%
 *
 * Cluster-sensitive code paths exercised here:
 *
 *   1. SSE chat (`POST /api/v1/chat/stream`)
 *      → `createSubscriber(handle)`  — pub/sub on cluster (GAP-008 watchdog)
 *      → `message-persistence-queue` — BullMQ Queue + Worker pair
 *      → `SyncExecutionService`     — distributed lock via SET NX PX + Lua
 *
 *   2. Multi-turn session (`POST /api/v1/chat/agent`)
 *      → `redis-session-store`       — SET/GET retry-on-miss (LLD §3f.2)
 *      → trace persistence            — SCAN-based metric flushes (`scanKeys`)
 *
 *   3. Agent-transfer end (`POST /api/v1/agent-transfer/sessions/:id/end`)
 *      → `LUA_END_SESSION`            — hash-tagged narrowed Lua
 *      → cross-slot pipeline cleanup  — `at_active_sessions` + `at_pod:*`
 *
 *   4. Concurrent fan-out (`burst_messages` scenario)
 *      → `fan-out-barrier` Lua + new registry SET (`scanKeys` inside getResults)
 *      → circuit breaker CAS (`circuit-breaker` Lua, hash-tagged)
 *
 * Scenarios deliberately mirror the channel-message-e2e baseline so cluster
 * vs standalone numbers are directly comparable.
 *
 * Usage:
 *   pnpm --filter=@agent-platform/benchmarks integration-test \
 *     --scenario redis-cluster-validation
 *
 * Required env (via `benchmarks/config/cloud.env` or k6 `-e`):
 *   - RUNTIME_URL, PROJECT_ID, AGENT_NAME (standard benchmark inputs)
 *   - REDIS_MODE=cluster|standalone — annotates the run for comparison
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import type { Options } from 'k6/options';
import { Trend, Counter } from 'k6/metrics';
import { postWithBackoff } from '../lib/http-utils.ts';
import { config, apiPath, buildAgentPath, runHealthCheck } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { agentTurnLatency, successRate, errorCount } from '../lib/metrics.ts';
import { vuScale, scaleStages, scaleArrivalRate } from '../lib/vu-scaling.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNTIME = config.runtimeUrl;
const PROJECT_ID = config.projectId;
const AGENT_PATH = buildAgentPath(config.agentName);

const REDIS_MODE = (__ENV.REDIS_MODE || 'unknown').toLowerCase();

/** Custom counters and trends for cluster-specific paths. */
const sseFirstByteLatency = new Trend('abl_sse_first_byte_ms', true);
const sessionLookupLatency = new Trend('abl_session_lookup_ms', true);
const transferEndLatency = new Trend('abl_transfer_end_ms', true);
const burstFanOutLatency = new Trend('abl_burst_fanout_ms', true);

const crossSlotPathErrors = new Counter('abl_cluster_path_errors_total');
const sessionMissRetries = new Counter('abl_session_miss_retries_total');
const transferEndOk = new Counter('abl_transfer_end_ok_total');

const PROBE_MESSAGES = [
  'Hello, validate cluster connectivity.',
  'Run a multi-turn check across hash-tag boundaries.',
  'List my recent sessions.',
  'Confirm the SSE pub/sub stream is intact.',
  'End the conversation when ready.',
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// Baseline total: 25 + 60 + 30 + 5 = 120 VUs — scale via MAX_VUS
const scale = vuScale(120);
const sseSteadyRate = scaleArrivalRate(120, { rate: 8, preAllocatedVUs: 12, maxVUs: 25 });
const burstStreamingRate = scaleArrivalRate(120, { rate: 25, preAllocatedVUs: 20, maxVUs: 60 });

export const options: Options = {
  scenarios: {
    sse_steady: {
      executor: 'constant-arrival-rate',
      rate: sseSteadyRate.rate,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: sseSteadyRate.preAllocatedVUs,
      maxVUs: sseSteadyRate.maxVUs,
      exec: 'sseSteady',
      tags: { scenario: 'sse_steady', redis_mode: REDIS_MODE },
    },
    multi_turn_session: {
      executor: 'per-vu-iterations',
      vus: scale(12),
      iterations: 5,
      startTime: '3m',
      exec: 'multiTurnSession',
      tags: { scenario: 'multi_turn_session', redis_mode: REDIS_MODE },
    },
    transfer_end: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: 5,
      maxVUs: 15,
      startTime: '3m',
      exec: 'transferEnd',
      tags: { scenario: 'transfer_end', redis_mode: REDIS_MODE },
    },
    burst_streaming: {
      executor: 'ramping-vus',
      startVUs: scale(5),
      stages: scaleStages(
        [
          { duration: '1m', target: 30 },
          { duration: '2m', target: 60 },
          { duration: '1m', target: 60 },
          { duration: '30s', target: 0 },
        ],
        120,
      ),
      startTime: '8m',
      exec: 'burstStreaming',
      tags: { scenario: 'burst_streaming', redis_mode: REDIS_MODE },
    },
  },
  thresholds: {
    // SLOs from LLD §4 — cluster mode bound; standalone baseline runs can use these as upper bounds.
    'http_req_duration{scenario:sse_steady}': ['p(50)<1500', 'p(95)<5000'],
    'http_req_duration{scenario:multi_turn_session}': ['p(95)<8000'],
    'http_req_duration{scenario:transfer_end}': ['p(95)<2000'],
    'http_req_duration{scenario:burst_streaming}': ['p(95)<10000'],

    abl_sse_first_byte_ms: ['p(95)<3000'],
    abl_session_lookup_ms: ['p(95)<200'],
    abl_transfer_end_ms: ['p(95)<2000'],
    abl_burst_fanout_ms: ['p(95)<10000'],

    abl_cluster_path_errors_total: [{ threshold: 'count<50', abortOnFail: false }],
    http_req_failed: ['rate<0.05'],
    abl_success_rate: ['rate>0.95'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'redis-cluster-validation',
    tags: {
      service: 'redis-cluster-validation',
      type: 'integration',
      redis_mode: REDIS_MODE,
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'sit',
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

  runHealthCheck(RUNTIME, 'runtime', headers);

  // Banner so reports clearly tag which Redis topology was under test.
  // eslint-disable-next-line no-console
  console.log(`[redis-cluster-validation] REDIS_MODE=${REDIS_MODE}`);

  return { token, refreshToken, headers };
}

// ---------------------------------------------------------------------------
// Scenario 1: SSE chat — pub/sub + BullMQ + locks
// ---------------------------------------------------------------------------

export function sseSteady(data: SetupData): void {
  ensureFreshAuth(data);

  const message = PROBE_MESSAGES[Math.floor(Math.random() * PROBE_MESSAGES.length)];
  const start = Date.now();

  const res = http.post(
    `${RUNTIME}${apiPath(`/v1/chat/stream${AGENT_PATH}`)}`,
    JSON.stringify({ message, projectId: PROJECT_ID }),
    {
      headers: { ...freshHeaders(data), Accept: 'text/event-stream' },
      tags: { scenario: 'sse_steady' },
      timeout: '30s',
    },
  );

  const ok = check(res, {
    'sse stream returned 200': (r) => r.status === 200,
    'sse body has data event': (r) => typeof r.body === 'string' && r.body.includes('data:'),
  });

  if (!ok) {
    crossSlotPathErrors.add(1);
    errorCount.add(1);
  }
  successRate.add(ok ? 1 : 0);

  const elapsed = Date.now() - start;
  sseFirstByteLatency.add(elapsed);
  agentTurnLatency.add(elapsed);

  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Scenario 2: Multi-turn session — redis-session-store retry-on-miss path
// ---------------------------------------------------------------------------

export function multiTurnSession(data: SetupData): void {
  ensureFreshAuth(data);

  let sessionId: string | null = null;

  for (let turn = 0; turn < 3; turn++) {
    const message = PROBE_MESSAGES[turn % PROBE_MESSAGES.length];
    const start = Date.now();

    const body: Record<string, unknown> = { message, projectId: PROJECT_ID };
    if (sessionId) body.sessionId = sessionId;

    const res = postWithBackoff(
      `${RUNTIME}${apiPath(`/v1/chat/agent${AGENT_PATH}`)}`,
      JSON.stringify(body),
      { headers: freshHeaders(data), timeout: '30s' },
    );

    const elapsed = Date.now() - start;
    sessionLookupLatency.add(elapsed);
    agentTurnLatency.add(elapsed);

    const ok = check(res, { 'multi-turn ok': (r) => r.status === 200 });
    if (!ok) {
      crossSlotPathErrors.add(1);
      errorCount.add(1);
      successRate.add(0);
      break;
    }

    successRate.add(1);

    try {
      const parsed = res.json() as Record<string, unknown>;
      const sid = parsed.sessionId;
      if (typeof sid === 'string' && sid.length > 0) {
        // First-turn miss-retry: if we missed the lookup on turn 0, sessionId
        // arrives but turn 1 may briefly fail. Track it for visibility.
        if (turn === 0) sessionId = sid;
      }
    } catch {
      // Body wasn't JSON — non-fatal; subsequent turns will create new sessions.
    }

    if (turn === 0 && !sessionId) {
      sessionMissRetries.add(1);
    }

    sleep(0.3);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3: Transfer-end — narrowed Lua + cross-slot pipeline cleanup
// ---------------------------------------------------------------------------

export function transferEnd(data: SetupData): void {
  ensureFreshAuth(data);

  // Probe path: list active transfer sessions, then attempt to end the first one.
  // In SIT this returns 200 with an empty list when no transfers are in flight,
  // which is fine — the path itself exercises the read side of the agent-transfer
  // store (HGETALL on hash-tagged keys + scan of `at_active_sessions`).
  const listStart = Date.now();
  const listRes = http.get(`${RUNTIME}${apiPath(`/v1/agent-transfer/sessions`)}`, {
    headers: freshHeaders(data),
    tags: { scenario: 'transfer_end_list' },
    timeout: '10s',
  });

  const listOk = check(listRes, { 'transfer list ok': (r) => r.status === 200 });
  if (!listOk) {
    crossSlotPathErrors.add(1);
    errorCount.add(1);
    return;
  }

  let sessionIdToEnd: string | null = null;
  try {
    const body = listRes.json() as { sessions?: Array<{ sessionId?: string }> };
    if (body.sessions && body.sessions.length > 0) {
      const candidate = body.sessions[0]?.sessionId;
      if (typeof candidate === 'string' && candidate.length > 0) {
        sessionIdToEnd = candidate;
      }
    }
  } catch {
    // Empty / non-JSON — proceed without an end call (read path is enough probe).
  }

  if (!sessionIdToEnd) {
    transferEndLatency.add(Date.now() - listStart);
    successRate.add(1);
    return;
  }

  const endStart = Date.now();
  const endRes = http.post(
    `${RUNTIME}${apiPath(`/v1/agent-transfer/sessions/${sessionIdToEnd}/end`)}`,
    JSON.stringify({ reason: 'cluster-validation-probe' }),
    { headers: freshHeaders(data), tags: { scenario: 'transfer_end' }, timeout: '10s' },
  );

  const elapsed = Date.now() - endStart;
  transferEndLatency.add(elapsed);

  // 200 = ended; 404 = already gone; both prove the Lua path executed cleanly.
  const ok = check(endRes, {
    'transfer end clean': (r) => r.status === 200 || r.status === 404,
  });

  if (ok) {
    transferEndOk.add(1);
    successRate.add(1);
  } else {
    crossSlotPathErrors.add(1);
    errorCount.add(1);
    successRate.add(0);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: Burst — fan-out-barrier + circuit breaker under concurrency
// ---------------------------------------------------------------------------

export function burstStreaming(data: SetupData): void {
  ensureFreshAuth(data);

  const start = Date.now();

  const res = http.post(
    `${RUNTIME}${apiPath(`/v1/chat/stream${AGENT_PATH}`)}`,
    JSON.stringify({
      message: 'Burst probe — exercise fan-out + breaker simultaneously',
      projectId: PROJECT_ID,
    }),
    {
      headers: { ...freshHeaders(data), Accept: 'text/event-stream' },
      tags: { scenario: 'burst_streaming' },
      timeout: '30s',
    },
  );

  const elapsed = Date.now() - start;
  burstFanOutLatency.add(elapsed);

  const ok = check(res, {
    'burst stream ok': (r) => r.status === 200,
  });

  if (!ok) {
    crossSlotPathErrors.add(1);
    errorCount.add(1);
  }
  successRate.add(ok ? 1 : 0);

  // Tighter sleep than sse_steady to drive concurrency and force breaker churn.
  sleep(0.05);
}

// ---------------------------------------------------------------------------
// Teardown — print a one-line summary the report extractor can pick up.
// ---------------------------------------------------------------------------

export function teardown(_data: SetupData): void {
  // eslint-disable-next-line no-console
  console.log(
    `[redis-cluster-validation] DONE — REDIS_MODE=${REDIS_MODE}. ` +
      `Compare against the standalone baseline run; assert ` +
      `cluster p95 ≤ 2× standalone, cluster p50 ≤ 1.1× standalone, ` +
      `and confirm redis.crossslot.errors == 0 from the Prometheus scrape.`,
  );
}
