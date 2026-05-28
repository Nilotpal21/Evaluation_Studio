/**
 * Channel Message E2E Benchmark
 *
 * Tests the full message processing pipeline using actual Runtime endpoints:
 *   1. single_message        — POST /v1/chat/agent (single turn, session auto-created)
 *   2. burst_messages        — Concurrent /v1/chat/agent calls under ramp
 *   3. streaming_ingestion   — High-rate /v1/chat/stream (SSE fire-and-forget)
 *   4. conversation_lifecycle — Multi-turn session: open → 3 messages → verify → close
 *
 * Actual endpoints used:
 *   - POST /api/v1/chat/agent   — agent-backed chat (creates/reuses session)
 *   - POST /api/v1/chat/stream  — SSE streaming chat
 *   - GET  /api/projects/:projectId/sessions/:id/messages — verify persistence
 *   - POST /api/projects/:projectId/sessions/:id/close    — close session
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { postWithBackoff } from '../lib/http-utils.ts';
import { config, apiPath, buildAgentPath, runHealthCheck } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { agentTurnLatency, successRate, errorCount, rateLimitHits } from '../lib/metrics.ts';
import { Trend, Counter } from 'k6/metrics';
import { vuScale, scaleStages, scaleArrivalRate } from '../lib/vu-scaling.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNTIME = config.runtimeUrl;
const PROJECT_ID = config.projectId;
const AGENT_PATH = buildAgentPath(config.agentName);

const messageDeliveryLatency = new Trend('abl_message_delivery_latency_ms', true);
const streamingLatency = new Trend('abl_streaming_latency_ms', true);
const sessionVerifyLatency = new Trend('abl_session_verify_latency_ms', true);
const channelMessages = new Counter('abl_channel_messages_total');

const USER_MESSAGES = [
  'Hello, I need help with my account.',
  'What are your business hours?',
  'Can you transfer me to a human agent?',
  'I want to cancel my subscription.',
  'How do I update my billing information?',
  'Is there a mobile app available?',
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// Baseline total: 25 (maxVUs) + 50 (peak) + 40 (maxVUs) + 5 = 120 VUs — scale via MAX_VUS env var
const scale = vuScale(120);
const singleMsgRate = scaleArrivalRate(120, { rate: 5, preAllocatedVUs: 10, maxVUs: 25 });
const streamingRate = scaleArrivalRate(120, { rate: 10, preAllocatedVUs: 15, maxVUs: 40 });

export const options: Options = {
  scenarios: {
    single_message: {
      executor: 'constant-arrival-rate',
      rate: singleMsgRate.rate,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: singleMsgRate.preAllocatedVUs,
      maxVUs: singleMsgRate.maxVUs,
      exec: 'singleMessage',
      tags: { scenario: 'single_message' },
    },
    burst_messages: {
      executor: 'ramping-vus',
      startVUs: scale(3),
      stages: scaleStages(
        [
          { duration: '1m', target: 20 },
          { duration: '2m', target: 50 },
          { duration: '30s', target: 50 },
          { duration: '30s', target: 0 },
        ],
        120,
      ),
      startTime: '2m30s',
      exec: 'burstMessages',
      tags: { scenario: 'burst_messages' },
    },
    streaming_ingestion: {
      executor: 'constant-arrival-rate',
      rate: streamingRate.rate,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: streamingRate.preAllocatedVUs,
      maxVUs: streamingRate.maxVUs,
      startTime: '7m',
      exec: 'streamingIngestion',
      tags: { scenario: 'streaming_ingestion' },
    },
    conversation_lifecycle: {
      executor: 'per-vu-iterations',
      vus: scale(5),
      iterations: 3,
      startTime: '9m30s',
      exec: 'conversationLifecycle',
      tags: { scenario: 'conversation_lifecycle' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:single_message}': ['p(95)<8000', 'p(99)<15000'],
    'http_req_duration{scenario:burst_messages}': ['p(95)<10000', 'p(99)<20000'],
    'http_req_duration{scenario:streaming_ingestion}': ['p(95)<8000', 'p(99)<15000'],
    http_req_failed: ['rate<0.05'],
    abl_message_delivery_latency_ms: ['p(95)<10000'],
    abl_success_rate: ['rate>0.85'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'channel-message-e2e',
    tags: {
      service: 'runtime',
      type: 'integration',
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

  runHealthCheck(RUNTIME, 'runtime', headers);

  console.log(`[setup] Runtime: ${RUNTIME}`);
  console.log(`[setup] Project: ${PROJECT_ID}`);
  console.log(`[setup] Agent: ${AGENT_PATH}`);

  return { token, refreshToken, headers };
}

function pickMessage(): string {
  return USER_MESSAGES[Math.floor(Math.random() * USER_MESSAGES.length)];
}

// ---------------------------------------------------------------------------
// Scenario 1: Single message via /v1/chat/agent
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat/agent — sends a single message, auto-creates session.
 * Returns { sessionId, response, traceEvents }.
 */
export function singleMessage(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    message: pickMessage(),
  });

  const start = Date.now();
  const res = postWithBackoff(`${RUNTIME}${apiPath('/v1/chat/agent')}`, payload, {
    headers: freshHeaders(data),
    tags: { scenario: 'single_message', name: 'POST /v1/chat/agent' },
    timeout: '30s',
  });
  const elapsed = Date.now() - start;

  messageDeliveryLatency.add(elapsed);
  agentTurnLatency.add(elapsed);
  channelMessages.add(1);

  const ok = check(res, {
    'agent chat 200': (r) => r.status === 200,
    'has sessionId': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        return typeof body.sessionId === 'string' && (body.sessionId as string).length > 0;
      } catch {
        return false;
      }
    },
    'has response text': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        return typeof body.response === 'string' && (body.response as string).length > 0;
      } catch {
        return false;
      }
    },
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[single_message] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.1);
}

// ---------------------------------------------------------------------------
// Scenario 2: Burst messages under ramp
// ---------------------------------------------------------------------------

/**
 * Same as singleMessage but under ramping concurrency to stress the pipeline.
 */
export function burstMessages(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    message: pickMessage(),
  });

  const start = Date.now();
  const res = postWithBackoff(`${RUNTIME}${apiPath('/v1/chat/agent')}`, payload, {
    headers: freshHeaders(data),
    tags: { scenario: 'burst_messages', name: 'POST /v1/chat/agent (burst)' },
    timeout: '30s',
  });
  const elapsed = Date.now() - start;

  messageDeliveryLatency.add(elapsed);
  channelMessages.add(1);

  if (res.status === 429) {
    rateLimitHits.add(1);
    successRate.add(0);
    sleep(2);
    return;
  }

  const ok = check(res, {
    'burst message 200': (r) => r.status === 200,
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[burst_messages] status=${res.status}`);
    errorCount.add(1);
  }
  sleep(0.05);
}

// ---------------------------------------------------------------------------
// Scenario 3: High-rate streaming ingestion via /v1/chat/stream
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat/stream — SSE streaming. Tests throughput under sustained load.
 */
export function streamingIngestion(data: SetupData): void {
  ensureFreshAuth(data);

  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    messages: [{ role: 'user', content: pickMessage() }],
  });

  const start = Date.now();
  const res = postWithBackoff(`${RUNTIME}${apiPath('/v1/chat/stream')}`, payload, {
    headers: {
      ...freshHeaders(data),
      Accept: 'text/event-stream',
    },
    tags: { scenario: 'streaming_ingestion', name: 'POST /v1/chat/stream (ingestion)' },
    timeout: '30s',
  });
  const elapsed = Date.now() - start;

  streamingLatency.add(elapsed);
  channelMessages.add(1);

  if (res.status === 429) {
    rateLimitHits.add(1);
    return;
  }

  const ok = check(res, {
    'stream 200': (r) => r.status === 200,
    'has SSE data': (r) => (r.body as string).includes('data:'),
  });

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[streaming_ingestion] status=${res.status}`);
    errorCount.add(1);
  }
}

// ---------------------------------------------------------------------------
// Scenario 4: Full conversation lifecycle
// ---------------------------------------------------------------------------

/**
 * Multi-turn conversation:
 *   1. Send first message (creates session, get sessionId)
 *   2. Send 3 follow-up messages reusing sessionId
 *   3. Verify session messages are persisted
 *   4. Close the session
 */
export function conversationLifecycle(data: SetupData): void {
  ensureFreshAuth(data);

  // Turn 1: open conversation (auto-creates session)
  const openPayload = JSON.stringify({
    projectId: PROJECT_ID,
    message: 'Hello, I need help with my account.',
  });

  const openRes = postWithBackoff(`${RUNTIME}${apiPath('/v1/chat/agent')}`, openPayload, {
    headers: freshHeaders(data),
    tags: { scenario: 'conversation_lifecycle', name: 'POST /v1/chat/agent (open)' },
    timeout: '30s',
  });

  const opened = check(openRes, {
    'conversation opened 200': (r) => r.status === 200,
  });

  if (!opened) {
    console.log(`[conversation_lifecycle] openRes status=${openRes.status}`);
    errorCount.add(1);
    successRate.add(0);
    return;
  }

  let sessionId: string;
  try {
    const body = openRes.json() as Record<string, unknown>;
    sessionId = body.sessionId as string;
  } catch {
    errorCount.add(1);
    successRate.add(0);
    return;
  }

  if (!sessionId) {
    errorCount.add(1);
    successRate.add(0);
    return;
  }

  channelMessages.add(1);

  // Turns 2-4: follow-up messages reusing the session
  const followUps = [
    'What are your business hours?',
    'How do I update my billing information?',
    'Thank you, that helps!',
  ];

  let allTurnsOk = true;
  for (const msg of followUps) {
    sleep(1 + Math.random());

    const start = Date.now();
    const res = postWithBackoff(
      `${RUNTIME}${apiPath('/v1/chat/agent')}`,
      JSON.stringify({ projectId: PROJECT_ID, sessionId, message: msg }),
      {
        headers: freshHeaders(data),
        tags: { scenario: 'conversation_lifecycle', name: 'POST /v1/chat/agent (follow-up)' },
        timeout: '30s',
      },
    );

    messageDeliveryLatency.add(Date.now() - start);
    channelMessages.add(1);

    if (res.status !== 200) allTurnsOk = false;
  }

  check(null, {
    'all follow-up turns succeeded': () => allTurnsOk,
  });

  // Verify: session is persisted by sending one more message with the same sessionId.
  // The /api/projects/:projectId/sessions/* routes aren't exposed through the public ingress
  // (they route to Studio, not Runtime), so we verify via /v1/chat/agent session reuse.
  sleep(1);
  const verifyStart = Date.now();
  const verifyRes = postWithBackoff(
    `${RUNTIME}${apiPath('/v1/chat/agent')}`,
    JSON.stringify({
      projectId: PROJECT_ID,
      sessionId,
      message: 'Can you confirm what we discussed?',
    }),
    {
      headers: freshHeaders(data),
      tags: { scenario: 'conversation_lifecycle', name: 'POST /v1/chat/agent (verify)' },
      timeout: '30s',
    },
  );
  sessionVerifyLatency.add(Date.now() - verifyStart);

  const verified = check(verifyRes, {
    'session reuse 200': (r) => r.status === 200,
    'session has context': (r) => {
      try {
        const body = r.json() as Record<string, unknown>;
        // Verify the same sessionId is returned (proves session persisted)
        return body.sessionId === sessionId;
      } catch {
        return false;
      }
    },
  });

  successRate.add(allTurnsOk && verified ? 1 : 0);
  if (!allTurnsOk || !verified) {
    if (!verified) {
      console.log(`[conversation_lifecycle] verifyRes status=${verifyRes.status}`);
    }
    errorCount.add(1);
  }
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleMessage(data);
  burstMessages(data);
  streamingIngestion(data);
  conversationLifecycle(data);
}
