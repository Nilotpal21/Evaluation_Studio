/**
 * Runtime Saturation Benchmark
 *
 * Ramp-to-saturation k6 script for the ABL Runtime service.
 * Uses blended workload scenarios with weighted VU distribution:
 *   1. single_turn  (50%) — POST /api/v1/chat with a single user message (SSE)
 *   2. multi_turn   (25%) — WebSocket 5-message conversation
 *   3. tool_calling  (15%) — Agent with 3 tool call round-trips
 *   4. concurrent   (10%) — WebSocket connect/hold/close ramp
 *
 * Run:
 *   k6 run benchmarks/saturation/runtime.ts \
 *     -e RUNTIME_URL=http://runtime:3112 \
 *     -e AUTH_TOKEN=... \
 *     -e TENANT_ID=... \
 *     -e PROJECT_ID=... \
 *     -e MAX_VUS=200 \
 *     -e DURATION_MINUTES=20
 *
 * Benchmark profiling:
 *   The LOAD_TEST_KEY env var is sent as the `X-Load-Test` header on every request.
 *   When this value matches the runtime's `BENCHMARK_SECRET` env var, the runtime
 *   activates benchmark mode — enabling [BENCH] timing logs and optionally bypassing
 *   the Vercel AI SDK / LLM layer based on the BENCHMARK_PROFILE env var:
 *
 *     BENCHMARK_PROFILE=skip-sdk  — resolve model (cached), skip Vercel AI SDK.
 *     BENCHMARK_PROFILE=skip-llm  — full SDK pipeline with mock provider (instant).
 *     BENCHMARK_PROFILE=           — (default) no bypass, full production path.
 *
 *   All profiles always run: auth → RBAC → cached permission/project lookups →
 *   cached model resolution. Only the SDK/LLM layer is optionally bypassed.
 *
 *   Example — measure pipeline without SDK overhead:
 *     LOAD_TEST_KEY=my-secret BENCHMARK_PROFILE=skip-sdk \
 *       k6 run benchmarks/saturation/runtime.ts -e INTER_MESSAGE_DELAY=0
 *
 *   Runtime .env must have: BENCHMARK_SECRET=my-secret
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import ws from 'k6/ws';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config, apiPath, runHealthCheck, buildAgentPath } from '../lib/config.ts';
import { getAuthToken, makeAuthHeaders, getRefreshToken, getCurrentToken } from '../lib/auth.ts';
import { buildBlendedScenarios, ScenarioExecMap } from '../lib/saturation-utils.ts';
import {
  agentTurnLatency,
  toolCallLatency,
  ttft,
  successRate,
  errorCount,
} from '../lib/metrics.ts';

// ---------------------------------------------------------------------------
// Environment-configurable parameters
// ---------------------------------------------------------------------------

const MAX_VUS = parseInt(__ENV.MAX_VUS || '200', 10);
const DURATION_MINUTES = parseInt(__ENV.DURATION_MINUTES || '20', 10);

/** Override scenario weights via SCENARIO_WEIGHTS env var (JSON). */
const CUSTOM_WEIGHTS: Record<string, number> | undefined = __ENV.SCENARIO_WEIGHTS
  ? (JSON.parse(__ENV.SCENARIO_WEIGHTS) as Record<string, number>)
  : undefined;

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

/** Pause between messages — override with INTER_MESSAGE_DELAY env var (seconds).
 *  Set to 0 for pure throughput/saturation testing. */
const INTER_MESSAGE_DELAY_SEC = parseFloat(__ENV.INTER_MESSAGE_DELAY || '0.3');

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

// LLM latency — server-reported latencyMs from SSE complete event
const llmLatency = new Trend('runtime_llm_latency_ms', true);

// Token usage counters
const llmInputTokens = new Counter('runtime_llm_input_tokens');
const llmOutputTokens = new Counter('runtime_llm_output_tokens');

// Per-scenario request counters (used for per-scenario stats in reports)
const singleTurnRequests = new Counter('runtime_single_turn_requests');
const multiTurnRequests = new Counter('runtime_multi_turn_requests');
const toolCallingRequests = new Counter('runtime_tool_calling_requests');
const concurrentRequests = new Counter('runtime_concurrent_requests');

// Per-scenario error counters
const singleTurnErrors = new Counter('runtime_single_turn_errors');
const multiTurnErrors = new Counter('runtime_multi_turn_errors');
const toolCallingErrors = new Counter('runtime_tool_calling_errors');
const concurrentErrors = new Counter('runtime_concurrent_errors');

// ---------------------------------------------------------------------------
// Scenario Exec Map
// ---------------------------------------------------------------------------

const SCENARIO_EXEC_MAP: ScenarioExecMap = {
  single_turn: 'singleTurn',
  multi_turn: 'multiTurn',
  tool_calling: 'toolCalling',
  concurrent: 'wsConnectionRamp',
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const options: Options = {
  scenarios: buildBlendedScenarios(
    'runtime',
    MAX_VUS,
    SCENARIO_EXEC_MAP,
    DURATION_MINUTES,
    CUSTOM_WEIGHTS,
  ),
  thresholds: {
    runtime_single_turn_latency_ms: ['p(95)<2000', 'p(99)<5000'],
    runtime_multi_turn_per_message_ms: ['p(95)<3000'],
    runtime_tool_calling_total_ms: ['p(95)<10000'],
    http_req_failed: ['rate<0.05'],
    runtime_sse_success_rate: ['rate>0.95'],
    runtime_ws_timeouts: ['count<20'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'runtime-saturation',
    tags: {
      service: 'runtime',
      type: 'saturation',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
} as Options;

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
// SSE Helpers — extract LLM metrics from SSE response body
// ---------------------------------------------------------------------------

interface SSEMetrics {
  modelId?: string;
  provider?: string;
  source?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Parse SSE metadata and complete events from the response body.
 * Records LLM latency and token usage metrics.
 */
function extractAndRecordSSEMetrics(body: string): SSEMetrics {
  const result: SSEMetrics = {};

  // Parse metadata event: event: metadata\ndata: {"modelId":"...","provider":"...","source":"..."}
  const metaMatch = body.match(/event:\s*metadata\ndata:\s*(\{[^\n]+\})/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]) as Record<string, string>;
      result.modelId = meta.modelId;
      result.provider = meta.provider;
      result.source = meta.source;
    } catch (_) {
      /* ignore parse errors */
    }
  }

  // Parse complete event: event: complete\ndata: {"inputTokens":N,"outputTokens":N,...,"latencyMs":N}
  const completeMatch = body.match(/event:\s*complete\ndata:\s*(\{[^\n]+\})/);
  if (completeMatch) {
    try {
      const complete = JSON.parse(completeMatch[1]) as Record<string, number | null>;
      if (typeof complete.latencyMs === 'number') {
        result.latencyMs = complete.latencyMs;
        llmLatency.add(complete.latencyMs);
      }
      if (typeof complete.inputTokens === 'number') {
        result.inputTokens = complete.inputTokens;
        llmInputTokens.add(complete.inputTokens);
      }
      if (typeof complete.outputTokens === 'number') {
        result.outputTokens = complete.outputTokens;
        llmOutputTokens.add(complete.outputTokens);
      }
    } catch (_) {
      /* ignore parse errors */
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scenario 1: Single-Turn (SSE Streaming) — 50% weight
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat with a single user message.
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

  // Extract and record LLM metrics from SSE response
  if (ok && response.body) {
    extractAndRecordSSEMetrics(response.body as string);
  }

  singleTurnLatency.add(elapsed);
  agentTurnLatency.add(elapsed);
  successRate.add(ok ? 1 : 0);
  sseSuccessRate.add(ok ? 1 : 0);
  singleTurnRequests.add(1);

  if (!ok) {
    errorCount.add(1);
    singleTurnErrors.add(1);
    // Log first few errors to diagnose
    if (singleTurnErrors.name) {
      console.warn(
        `[single_turn] FAIL status=${response.status} body=${((response.body as string) || '').substring(0, 200)}`,
      );
    }
  }

  sleep(INTER_MESSAGE_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Scenario 2: Multi-Turn (WebSocket, 5 messages) — 25% weight
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

  const wsOk = check(response, {
    'multi_turn: WebSocket connected': (r) => r && r.status === 101,
  });
  multiTurnRequests.add(1);
  if (!wsOk) {
    multiTurnErrors.add(1);
  }
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
// Scenario 3: Tool Calling (Agent with 3 tool calls) — 15% weight
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/chat with a user message that triggers an agent equipped with
 * tools. The agent is expected to make 3 tool call round-trips.
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

  // Extract and record LLM metrics from SSE response
  if (ok && body) {
    extractAndRecordSSEMetrics(body);
  }

  toolCallingTotalLatency.add(totalElapsed);
  successRate.add(ok ? 1 : 0);
  sseSuccessRate.add(ok ? 1 : 0);
  toolCallingRequests.add(1);

  // Record per-tool-call latency estimate (total / calls observed, or total / expected)
  const observedCalls = toolCallCount > 0 ? toolCallCount : TOOL_CALL_COUNT;
  const perToolEstimate = totalElapsed / observedCalls;
  for (let i = 0; i < observedCalls; i++) {
    toolCallLatency.add(perToolEstimate);
  }

  if (!ok) {
    errorCount.add(1);
    toolCallingErrors.add(1);
  }

  sleep(INTER_MESSAGE_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Scenario 4: WebSocket Connection Ramp — 10% weight
// ---------------------------------------------------------------------------

/**
 * Opens a WebSocket connection, measures connect latency, briefly holds
 * the connection open, then closes. Used to stress-test WebSocket
 * connection handling under saturation load.
 */
export function wsConnectionRamp(data: SetupData): void {
  // Get fresh token with auto-refresh (tokens expire in 15 min)
  const freshToken = getCurrentToken(data);
  const connectStart = Date.now();

  const response = ws.connect(
    data.wsUrl,
    {
      headers: {
        'Sec-WebSocket-Protocol': `${WEB_DEBUG_WS_AUTH_PROTOCOL}, ${freshToken}`,
      },
    },
    function (socket) {
      socket.setTimeout(function () {
        wsTimeouts.add(1);
        socket.close();
      }, WS_CONNECT_TIMEOUT_MS);

      socket.on('open', function () {
        const connectElapsed = Date.now() - connectStart;
        wsConnectLatency.add(connectElapsed);
        successRate.add(1);

        // Briefly hold the connection open to simulate a real client
        sleep(0.5);
        socket.close();
      });

      socket.on('error', function () {
        errorCount.add(1);
        successRate.add(0);
      });
    },
  );

  const wsOk = check(response, {
    'ws_connection_ramp: WebSocket connected': (r) => r && r.status === 101,
  });
  concurrentRequests.add(1);
  if (!wsOk) {
    concurrentErrors.add(1);
  }

  sleep(0.2);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleTurn(data);
}
