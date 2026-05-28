/**
 * Runtime Micro-Benchmark
 *
 * Exercises the ABL Runtime service across four scenarios:
 *   1. single_turn  — POST /api/v1/chat/stream with a single user message (SSE)
 *   2. multi_turn   — WebSocket 5-message conversation
 *   3. tool_calling — Agent with 3 tool call round-trips
 *   4. concurrent   — Ramp 1→100 VUs over 5 minutes
 *
 * Run:
 *   k6 run benchmarks/services/runtime.ts \
 *     -e RUNTIME_URL=http://runtime:3112 \
 *     -e AUTH_TOKEN=... \
 *     -e TENANT_ID=... \
 *     -e PROJECT_ID=...
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import ws from 'k6/ws';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config, apiPath, getAuthHeaders, runHealthCheck, buildAgentPath } from '../lib/config.ts';
import { getAuthToken, makeAuthHeaders, getRefreshToken, getCurrentToken } from '../lib/auth.ts';
import { vuScale, scaleStages } from '../lib/vu-scaling.ts';
import {
  agentTurnLatency,
  toolCallLatency,
  ttft,
  successRate,
  errorCount,
} from '../lib/metrics.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default agent name for benchmarks — override with AGENT_NAME env var */
const AGENT_NAME = __ENV.AGENT_NAME || 'benchmark_agent';

/** Full agent path: {projectId}/default/{agentName} — override with AGENT_PATH env var */
const AGENT_PATH = __ENV.AGENT_PATH || buildAgentPath(AGENT_NAME);

/** Number of messages in the multi-turn conversation scenario */
const MULTI_TURN_MESSAGE_COUNT = 5;

/** Number of tool calls expected in the tool-calling scenario */
const TOOL_CALL_COUNT = 3;

/** Pause between messages within a single conversation (ms) */
const INTER_MESSAGE_DELAY_SEC = 1;

/** WebSocket connect timeout (ms) */
const WS_CONNECT_TIMEOUT_MS = 10_000;

/** WebSocket per-message response timeout (ms) */
const WS_RESPONSE_TIMEOUT_MS = 30_000;

/** Internal debug WebSocket auth subprotocol */
const WEB_DEBUG_WS_AUTH_PROTOCOL = 'web-debug-auth';

/** SSE response read timeout (ms) */
const SSE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

/** Time from HTTP POST to last SSE chunk (single-turn) */
const singleTurnLatency = new Trend('runtime_single_turn_latency_ms', true);

/** Time from WS send to final agent_response event (per turn) */
const multiTurnPerMessage = new Trend('runtime_multi_turn_per_message_ms', true);

/** Total elapsed time for a full multi-turn conversation */
const multiTurnTotalLatency = new Trend('runtime_multi_turn_total_ms', true);

/** Time for the full tool-calling round-trip (all 3 calls) */
const toolCallingTotalLatency = new Trend('runtime_tool_calling_total_ms', true);

/** WebSocket connection setup time */
const wsConnectLatency = new Trend('runtime_ws_connect_latency_ms', true);

/** Count of timed-out WebSocket responses */
const wsTimeouts = new Counter('runtime_ws_timeouts');

/** Success rate for SSE streaming responses */
const sseSuccessRate = new Rate('runtime_sse_success_rate');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// Baseline total: 10 + 5 + 5 + 100 (peak) = 120 VUs — scale via MAX_VUS env var
const scale = vuScale(120);

export const options: Options = {
  scenarios: {
    single_turn: {
      executor: 'constant-vus',
      vus: scale(10),
      duration: '2m',
      exec: 'singleTurn',
      tags: { scenario: 'single_turn' },
    },
    multi_turn: {
      executor: 'constant-vus',
      vus: scale(5),
      duration: '3m',
      exec: 'multiTurn',
      startTime: '2m30s', // stagger after single_turn stabilises
      tags: { scenario: 'multi_turn' },
    },
    tool_calling: {
      executor: 'constant-vus',
      vus: scale(5),
      duration: '3m',
      exec: 'toolCalling',
      startTime: '2m30s',
      tags: { scenario: 'tool_calling' },
    },
    concurrent: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: scaleStages(
        [
          { duration: '1m', target: 10 },
          { duration: '1m30s', target: 50 },
          { duration: '1m30s', target: 100 },
          { duration: '1m', target: 0 },
        ],
        120,
      ),
      exec: 'concurrentRamp',
      startTime: '6m',
      tags: { scenario: 'concurrent' },
    },
  },
  thresholds: {
    // Primary SLA: p95 < 2000ms for single-turn
    'http_req_duration{scenario:single_turn}': ['p(95)<2000'],
    runtime_single_turn_latency_ms: ['p(95)<2000', 'p(99)<5000'],

    // Multi-turn: per-message p95 < 3s (includes LLM round-trip)
    runtime_multi_turn_per_message_ms: ['p(95)<3000'],

    // Tool calling: full round-trip p95 < 10s (LLM + 3 tool calls)
    runtime_tool_calling_total_ms: ['p(95)<10000'],

    // General error budget
    http_req_failed: ['rate<0.05'], // < 5% error rate
    runtime_sse_success_rate: ['rate>0.95'],

    // WebSocket should not time out more than 2% of attempts
    runtime_ws_timeouts: ['count<20'],
  },
};

// ---------------------------------------------------------------------------
// Setup — obtain auth token once per test run
// ---------------------------------------------------------------------------

interface SetupData {
  token: string;
  refreshToken: string;
  headers: Record<string, string>;
  wsUrl: string;
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  // Use config.wsUrl which correctly handles ingress vs direct mode
  const wsUrl = config.wsUrl;

  // Smoke-check: verify runtime is reachable (skipped if HEALTH_CHECK=false)
  runHealthCheck(config.runtimeUrl, 'runtime', headers);

  return { token, refreshToken, headers, wsUrl };
}

// ---------------------------------------------------------------------------
// Scenario 1: Single-Turn (SSE Streaming)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat/stream with a single user message.
 * The runtime responds with Server-Sent Events (SSE).
 * We measure total time from request to final SSE event.
 */
export function singleTurn(data: SetupData): void {
  // Get fresh headers with auto-refresh (tokens expire in 15 min)
  const headers = makeAuthHeaders(data.token, data.refreshToken);

  const payload = JSON.stringify({
    projectId: config.projectId,
    messages: [
      {
        role: 'user',
        content: `Benchmark single-turn message ${Date.now()}`,
      },
    ],
  });

  const startMs = Date.now();
  const response = http.post(`${config.runtimeUrl}${apiPath('/v1/chat/stream')}`, payload, {
    headers: {
      ...headers,
      Accept: 'text/event-stream',
    },
    timeout: `${SSE_TIMEOUT_MS}ms`,
    tags: { name: 'POST /api/v1/chat/stream (single_turn)' },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    'single_turn: status is 200': (r) => r.status === 200,
    'single_turn: body is not empty': (r) => !!r.body && (r.body as string).length > 0,
    'single_turn: contains SSE data': (r) => !!r.body && (r.body as string).includes('data:'),
  });

  singleTurnLatency.add(elapsed);
  agentTurnLatency.add(elapsed);
  successRate.add(ok ? 1 : 0);
  sseSuccessRate.add(ok ? 1 : 0);

  if (!ok) {
    errorCount.add(1);
  }

  sleep(INTER_MESSAGE_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Scenario 2: Multi-Turn (WebSocket, 5 messages)
// ---------------------------------------------------------------------------

/**
 * Opens a WebSocket connection, loads an agent, then sends 5 sequential
 * user messages — measuring per-message and total conversation latency.
 */
export function multiTurn(data: SetupData): void {
  // Get fresh token with auto-refresh (tokens expire in 15 min)
  const freshToken = getCurrentToken(data);
  const conversationStart = Date.now();

  const response = ws.connect(
    data.wsUrl,
    {
      headers: {
        'Sec-WebSocket-Protocol': `${WEB_DEBUG_WS_AUTH_PROTOCOL}, ${freshToken}`,
      },
    },
    function (socket) {
      const connectStart = Date.now();
      let sessionId = '';
      let pendingMessages = MULTI_TURN_MESSAGE_COUNT;
      let currentMessageStart = 0;
      let awaitingFirstChunk = false;

      socket.setTimeout(
        function () {
          wsTimeouts.add(1);
          socket.close();
        },
        WS_CONNECT_TIMEOUT_MS + WS_RESPONSE_TIMEOUT_MS * MULTI_TURN_MESSAGE_COUNT,
      );

      socket.on('open', function () {
        wsConnectLatency.add(Date.now() - connectStart);

        // Step 1: Load the benchmark agent
        socket.send(
          JSON.stringify({
            type: 'load_agent',
            agentPath: AGENT_PATH,
            projectId: config.projectId,
          }),
        );
      });

      socket.on('message', function (msg: string) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg) as Record<string, unknown>;
        } catch {
          return;
        }

        const eventType = parsed.type as string;

        // Agent loaded — capture session ID and start sending messages
        if (eventType === 'agent_loaded' || eventType === 'session_created') {
          sessionId = (parsed.sessionId as string) || sessionId;
          if (sessionId && pendingMessages === MULTI_TURN_MESSAGE_COUNT) {
            currentMessageStart = Date.now();
            awaitingFirstChunk = true;
            sendNextMessage(socket, sessionId, pendingMessages);
          }
          return;
        }

        // Agent finished responding — record latency and send next message
        if (eventType === 'response_end') {
          if (currentMessageStart > 0) {
            const turnLatency = Date.now() - currentMessageStart;
            multiTurnPerMessage.add(turnLatency);
            agentTurnLatency.add(turnLatency);
            successRate.add(1);
          }

          pendingMessages--;
          if (pendingMessages > 0 && sessionId) {
            sleep(INTER_MESSAGE_DELAY_SEC);
            currentMessageStart = Date.now();
            awaitingFirstChunk = true;
            sendNextMessage(socket, sessionId, pendingMessages);
          } else {
            // Conversation complete
            multiTurnTotalLatency.add(Date.now() - conversationStart);
            socket.close();
          }
          return;
        }

        // TTFT: first token from streaming
        if (eventType === 'response_chunk') {
          if (awaitingFirstChunk && currentMessageStart > 0) {
            ttft.add(Date.now() - currentMessageStart);
            awaitingFirstChunk = false;
          }
        }

        // Error handling
        if (eventType === 'error') {
          errorCount.add(1);
          successRate.add(0);
        }
      });

      socket.on('error', function () {
        errorCount.add(1);
        successRate.add(0);
      });

      socket.on('close', function () {
        // If messages remain unsent, record as timeouts
        if (pendingMessages > 0) {
          wsTimeouts.add(pendingMessages);
        }
      });
    },
  );

  check(response, {
    'multi_turn: WebSocket connected': (r) => r && r.status === 101,
  });
}

/**
 * Send a numbered user message over the WebSocket.
 */
function sendNextMessage(
  socket: { send: (data: string) => void },
  sessionId: string,
  remaining: number,
): void {
  const messageNumber = MULTI_TURN_MESSAGE_COUNT - remaining + 1;
  socket.send(
    JSON.stringify({
      type: 'send_message',
      sessionId,
      text: `Benchmark multi-turn message ${messageNumber} of ${MULTI_TURN_MESSAGE_COUNT} [${Date.now()}]`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 3: Tool Calling (Agent with 3 tool calls)
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat/stream with a user message that triggers an agent equipped with
 * tools. The agent is expected to make 3 tool call round-trips.
 *
 * We use the SSE endpoint. The response will include tool_call events
 * interspersed with assistant responses.
 */
export function toolCalling(data: SetupData): void {
  // Get fresh headers with auto-refresh (tokens expire in 15 min)
  const headers = makeAuthHeaders(data.token, data.refreshToken);

  const payload = JSON.stringify({
    projectId: config.projectId,
    messages: [
      {
        role: 'user',
        content: `Benchmark: Look up the account status, check the order history, and verify the shipping address for customer C-${Date.now()}`,
      },
    ],
    tools: [
      {
        name: 'lookup_account',
        description: 'Look up customer account status by customer ID',
        parameters: {
          type: 'object',
          properties: {
            customer_id: { type: 'string', description: 'The customer ID' },
          },
          required: ['customer_id'],
        },
      },
      {
        name: 'get_order_history',
        description: 'Retrieve order history for a customer',
        parameters: {
          type: 'object',
          properties: {
            customer_id: { type: 'string', description: 'The customer ID' },
            limit: { type: 'number', description: 'Max orders to return' },
          },
          required: ['customer_id'],
        },
      },
      {
        name: 'verify_shipping_address',
        description: 'Verify and validate a shipping address',
        parameters: {
          type: 'object',
          properties: {
            customer_id: { type: 'string', description: 'The customer ID' },
          },
          required: ['customer_id'],
        },
      },
    ],
  });

  const startMs = Date.now();
  const response = http.post(`${config.runtimeUrl}${apiPath('/v1/chat/stream')}`, payload, {
    headers: {
      ...headers,
      Accept: 'text/event-stream',
    },
    timeout: `${SSE_TIMEOUT_MS}ms`,
    tags: { name: 'POST /api/v1/chat/stream (tool_calling)' },
  });
  const totalElapsed = Date.now() - startMs;

  // Parse SSE body to count tool_call events
  const body = (response.body as string) || '';
  const toolCallMatches = body.match(/event:\s*tool_call/g) || [];
  const toolCallCount = toolCallMatches.length;

  const ok = check(response, {
    'tool_calling: status is 200': (r) => r.status === 200,
    'tool_calling: response body not empty': (r) => !!r.body && (r.body as string).length > 0,
  });

  toolCallingTotalLatency.add(totalElapsed);
  successRate.add(ok ? 1 : 0);
  sseSuccessRate.add(ok ? 1 : 0);

  // Record per-tool-call latency estimate (total / calls observed, or total / expected)
  const observedCalls = toolCallCount > 0 ? toolCallCount : TOOL_CALL_COUNT;
  const perToolEstimate = totalElapsed / observedCalls;
  for (let i = 0; i < observedCalls; i++) {
    toolCallLatency.add(perToolEstimate);
  }

  if (!ok) {
    errorCount.add(1);
  }

  sleep(INTER_MESSAGE_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Scenario 4: Concurrent Ramp (1→100 VUs)
// ---------------------------------------------------------------------------

/**
 * Same workload as single_turn but under ramping concurrency.
 * Used to find the saturation point and measure behaviour under load.
 */
export function concurrentRamp(data: SetupData): void {
  // Get fresh headers with auto-refresh (tokens expire in 15 min)
  const headers = makeAuthHeaders(data.token, data.refreshToken);

  const payload = JSON.stringify({
    projectId: config.projectId,
    messages: [
      {
        role: 'user',
        content: `Benchmark concurrent message VU=${__VU} iter=${__ITER} ts=${Date.now()}`,
      },
    ],
  });

  const startMs = Date.now();
  const response = http.post(`${config.runtimeUrl}${apiPath('/v1/chat/stream')}`, payload, {
    headers: {
      ...headers,
      Accept: 'text/event-stream',
    },
    timeout: `${SSE_TIMEOUT_MS}ms`,
    tags: { name: 'POST /api/v1/chat/stream (concurrent)' },
  });
  const elapsed = Date.now() - startMs;

  const ok = check(response, {
    'concurrent: status is 200': (r) => r.status === 200,
    'concurrent: body is not empty': (r) => !!r.body && (r.body as string).length > 0,
  });

  singleTurnLatency.add(elapsed);
  agentTurnLatency.add(elapsed);
  successRate.add(ok ? 1 : 0);
  sseSuccessRate.add(ok ? 1 : 0);

  if (!ok) {
    errorCount.add(1);
  }

  // Shorter sleep under concurrency to increase pressure
  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleTurn(data);
}
