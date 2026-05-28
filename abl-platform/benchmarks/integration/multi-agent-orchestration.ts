/**
 * Multi-Agent Orchestration E2E Benchmark
 *
 * Tests the supervisor delegation pattern via both SSE and WebSocket channels.
 *
 * Scenarios:
 *   1. single_delegation      — SSE: single message routed to one child agent
 *   2. multi_delegation       — SSE: message requiring multiple child agents
 *   3. ws_multi_turn          — WebSocket: 10-turn conversation, each child agent gets 2+ turns
 *   4. concurrent             — SSE: concurrent supervisor requests under load
 *
 * Requires bootstrap with multi-agent setup (supervisor + child agents with dslContent).
 */
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { postWithBackoff } from '../lib/http-utils.ts';
import { config, apiPath, buildAgentPath, runHealthCheck } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  getCurrentToken,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { agentTurnLatency, ttft, successRate, errorCount } from '../lib/metrics.ts';
import { Trend, Counter, Rate } from 'k6/metrics';
import { vuScale, scaleStages } from '../lib/vu-scaling.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUNTIME = config.runtimeUrl;
const PROJECT_ID = config.projectId;
const SUPERVISOR_PATH = buildAgentPath(config.supervisorName);

/** Total turns in the WS multi-turn conversation */
const WS_TOTAL_TURNS = 10;

/** Pause between WS turns (seconds) */
const WS_INTER_TURN_DELAY = 1;

/** WS connect timeout (ms) */
const WS_CONNECT_TIMEOUT_MS = 10_000;

/** WS per-turn response timeout (ms) */
const WS_TURN_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------

const supervisorLatency = new Trend('abl_supervisor_latency_ms', true);
const wsPerTurnLatency = new Trend('abl_ws_multi_agent_per_turn_ms', true);
const wsTotalLatency = new Trend('abl_ws_multi_agent_total_ms', true);
const wsConnectLatency = new Trend('abl_ws_multi_agent_connect_ms', true);
const delegationCount = new Counter('abl_delegation_count_total');
const wsTimeouts = new Counter('abl_ws_multi_agent_timeouts');
const wsTurnSuccess = new Rate('abl_ws_multi_agent_turn_success');

// ---------------------------------------------------------------------------
// Conversation script — 10 turns cycling across 3 child agents (2+ each)
// ---------------------------------------------------------------------------

/**
 * 10-turn conversation script. Each message is designed to route
 * to a specific child agent via the supervisor's delegation logic.
 *
 * Distribution: search_agent (4), code_agent (3), analytics_agent (3)
 */
const MULTI_TURN_SCRIPT = [
  // Turn 1-2: search_agent
  {
    turn: 1,
    message: 'Find documentation about agent constraints and limitations',
    target: 'search_agent',
  },
  {
    turn: 2,
    message: 'Search for examples of multi-agent delegation patterns',
    target: 'search_agent',
  },
  // Turn 3-4: code_agent
  {
    turn: 3,
    message: 'Generate a DSL definition for a customer support agent',
    target: 'code_agent',
  },
  { turn: 4, message: 'Write a tool definition for an HTTP API lookup', target: 'code_agent' },
  // Turn 5-6: analytics_agent
  {
    turn: 5,
    message: 'Show me the conversation metrics for the last 7 days',
    target: 'analytics_agent',
  },
  {
    turn: 6,
    message: 'What is the average response latency by agent type?',
    target: 'analytics_agent',
  },
  // Turn 7: search_agent (3rd turn)
  {
    turn: 7,
    message: 'Find the API reference for the Runtime WebSocket protocol',
    target: 'search_agent',
  },
  // Turn 8: code_agent (3rd turn)
  {
    turn: 8,
    message: 'Refactor the previous DSL to add error handling constraints',
    target: 'code_agent',
  },
  // Turn 9: analytics_agent (3rd turn)
  {
    turn: 9,
    message: 'Compare this weeks metrics to last weeks performance',
    target: 'analytics_agent',
  },
  // Turn 10: search_agent (4th turn) — wraps up
  {
    turn: 10,
    message: 'Summarize all the documentation findings from this conversation',
    target: 'search_agent',
  },
];

/** Messages for SSE single-delegation */
const SINGLE_DELEGATION_MESSAGES = [
  'Find documentation about agent constraints',
  'Generate a DSL definition for a customer support agent',
  'Show me the conversation metrics for last week',
];

/** Messages for SSE multi-delegation */
const MULTI_DELEGATION_MESSAGES = [
  'Search for pricing docs and generate a summary report',
  'Look up the API spec, test the endpoints, and generate a report',
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// Baseline total: 3 + 3 + 2 + 30 (peak) = 38 VUs — scale via MAX_VUS env var
const scale = vuScale(38);

export const options: Options = {
  scenarios: {
    single_delegation: {
      executor: 'constant-vus',
      vus: scale(3),
      duration: '2m',
      exec: 'singleDelegation',
      tags: { scenario: 'single_delegation' },
    },
    multi_delegation: {
      executor: 'constant-vus',
      vus: scale(3),
      duration: '2m',
      exec: 'multiDelegation',
      startTime: '2m30s',
      tags: { scenario: 'multi_delegation' },
    },
    ws_multi_turn: {
      executor: 'per-vu-iterations',
      vus: scale(2),
      iterations: 3,
      exec: 'wsMultiTurn',
      startTime: '5m',
      tags: { scenario: 'ws_multi_turn' },
    },
    concurrent: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: scaleStages(
        [
          { duration: '1m', target: 10 },
          { duration: '2m', target: 30 },
          { duration: '1m', target: 0 },
        ],
        38,
      ),
      startTime: '8m',
      exec: 'concurrentOrchestration',
      tags: { scenario: 'concurrent' },
    },
  },
  thresholds: {
    'http_req_duration{scenario:single_delegation}': ['p(95)<10000', 'p(99)<20000'],
    'http_req_duration{scenario:multi_delegation}': ['p(95)<20000', 'p(99)<40000'],
    http_req_failed: ['rate<0.10'],
    abl_supervisor_latency_ms: ['p(95)<15000'],
    abl_ws_multi_agent_per_turn_ms: ['p(95)<30000'],
    abl_ws_multi_agent_turn_success: ['rate>0.70'],
    abl_success_rate: ['rate>0.80'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'multi-agent-orchestration',
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
  wsUrl: string;
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  runHealthCheck(RUNTIME, 'runtime', headers);

  // Use config.wsUrl which correctly handles ingress vs direct mode
  const wsUrl = config.wsUrl;

  console.log(`[setup] Supervisor path: ${SUPERVISOR_PATH}`);
  console.log(`[setup] WS URL: ${wsUrl}`);
  console.log(`[setup] Project: ${PROJECT_ID}`);
  console.log(`[setup] Multi-turn script: ${WS_TOTAL_TURNS} turns across 3 agents`);

  return { token, refreshToken, headers, wsUrl };
}

// ---------------------------------------------------------------------------
// Helper: send a chat message via SSE endpoint
// ---------------------------------------------------------------------------

function sendChatMessage(data: SetupData, message: string, scenarioTag: string): boolean {
  const payload = JSON.stringify({
    projectId: PROJECT_ID,
    agentPath: SUPERVISOR_PATH,
    messages: [{ role: 'user', content: message }],
  });

  const start = Date.now();
  const res = postWithBackoff(`${RUNTIME}${apiPath('/v1/chat/stream')}`, payload, {
    headers: {
      ...freshHeaders(data),
      Accept: 'text/event-stream',
    },
    timeout: '60s',
    tags: { scenario: scenarioTag },
  });
  const elapsed = Date.now() - start;

  supervisorLatency.add(elapsed);
  agentTurnLatency.add(elapsed);

  const ok = check(res, {
    'supervisor response 200': (r) => r.status === 200,
    'has SSE data': (r) => (r.body as string).length > 0 && (r.body as string).includes('data:'),
  });

  const body = res.body as string;
  const delegations = (body.match(/delegate|handoff|routing/gi) || []).length;
  if (delegations > 0) delegationCount.add(delegations);

  successRate.add(ok ? 1 : 0);
  if (!ok) {
    console.log(`[sendChatMessage] status=${res.status}`);
    errorCount.add(1);
  }

  return ok;
}

// ---------------------------------------------------------------------------
// Scenario 1: Single delegation (SSE)
// ---------------------------------------------------------------------------

export function singleDelegation(data: SetupData): void {
  ensureFreshAuth(data);

  const msg = SINGLE_DELEGATION_MESSAGES[__ITER % SINGLE_DELEGATION_MESSAGES.length];
  sendChatMessage(data, msg, 'single_delegation');
  sleep(1);
}

// ---------------------------------------------------------------------------
// Scenario 2: Multi-delegation (SSE)
// ---------------------------------------------------------------------------

export function multiDelegation(data: SetupData): void {
  ensureFreshAuth(data);

  const msg = MULTI_DELEGATION_MESSAGES[__ITER % MULTI_DELEGATION_MESSAGES.length];
  sendChatMessage(data, msg, 'multi_delegation');
  sleep(2);
}

// ---------------------------------------------------------------------------
// Scenario 3: WebSocket 10-turn multi-agent conversation
// ---------------------------------------------------------------------------

/**
 * Opens a WebSocket to the supervisor, then sends 10 messages that cycle
 * across search_agent (4 turns), code_agent (3 turns), analytics_agent (3 turns).
 *
 * Measures per-turn latency and total conversation time.
 */
export function wsMultiTurn(data: SetupData): void {
  // Get a fresh token before each connection — pass setup data to hydrate
  // VU-local refresh state (refresh token is lost across k6 setup→VU boundary)
  const token = getCurrentToken(data);
  const wsUrlWithAuth = `${data.wsUrl}?token=${token}&tenantId=${config.tenantId}`;
  const conversationStart = Date.now();
  let completedTurns = 0;

  const response = ws.connect(wsUrlWithAuth, {}, function (socket) {
    const connectStart = Date.now();
    let sessionId = '';
    let turnIndex = 0;
    let currentTurnStart = 0;
    let firstChunkRecorded = false;

    // Global timeout for the entire conversation
    socket.setTimeout(
      function () {
        const remaining = WS_TOTAL_TURNS - completedTurns;
        if (remaining > 0) wsTimeouts.add(remaining);
        console.warn(`[ws_multi_turn] Timed out after ${completedTurns}/${WS_TOTAL_TURNS} turns`);
        socket.close();
      },
      WS_CONNECT_TIMEOUT_MS + WS_TURN_TIMEOUT_MS * WS_TOTAL_TURNS,
    );

    socket.on('open', function () {
      wsConnectLatency.add(Date.now() - connectStart);

      // Load the supervisor agent
      socket.send(
        JSON.stringify({
          type: 'load_agent',
          agentPath: SUPERVISOR_PATH,
          projectId: PROJECT_ID,
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

      // Error logging
      if (eventType === 'agent_load_error' || eventType === 'error') {
        const errMsg = (parsed.error as string) || (parsed.message as string) || '';
        console.warn(`[ws_multi_turn] ${eventType}: ${errMsg.substring(0, 200)}`);
        errorCount.add(1);
        wsTurnSuccess.add(0);
        socket.close();
        return;
      }

      // Agent loaded — start the conversation
      if (eventType === 'agent_loaded') {
        sessionId = (parsed.sessionId as string) || '';
        console.log(`[ws_multi_turn] Supervisor loaded, sessionId: ${sessionId}`);
        if (sessionId) {
          sendTurn(socket, sessionId, turnIndex);
          currentTurnStart = Date.now();
          firstChunkRecorded = false;
        }
        return;
      }

      // First streaming chunk — record TTFT
      if (eventType === 'response_chunk' || eventType === 'response_start') {
        if (!firstChunkRecorded && currentTurnStart > 0) {
          ttft.add(Date.now() - currentTurnStart);
          firstChunkRecorded = true;
        }
        return;
      }

      // Turn complete — record latency and send next
      if (eventType === 'response_end') {
        if (currentTurnStart > 0) {
          const turnLatency = Date.now() - currentTurnStart;
          wsPerTurnLatency.add(turnLatency);
          agentTurnLatency.add(turnLatency);
          wsTurnSuccess.add(1);
          completedTurns++;

          const script = MULTI_TURN_SCRIPT[turnIndex];
          console.log(
            `[ws_multi_turn] Turn ${script.turn}/${WS_TOTAL_TURNS} → ${script.target} (${turnLatency}ms)`,
          );
        }

        turnIndex++;
        if (turnIndex < WS_TOTAL_TURNS && sessionId) {
          sleep(WS_INTER_TURN_DELAY);
          sendTurn(socket, sessionId, turnIndex);
          currentTurnStart = Date.now();
          firstChunkRecorded = false;
        } else {
          // All 10 turns complete
          wsTotalLatency.add(Date.now() - conversationStart);
          console.log(
            `[ws_multi_turn] Conversation complete: ${completedTurns}/${WS_TOTAL_TURNS} turns`,
          );
          socket.close();
        }
        return;
      }
    });

    socket.on('error', function () {
      errorCount.add(1);
      wsTurnSuccess.add(0);
    });

    socket.on('close', function () {
      const remaining = WS_TOTAL_TURNS - completedTurns;
      if (remaining > 0) {
        wsTimeouts.add(remaining);
      }
    });
  });

  const wsOk = check(response, {
    'ws_multi_turn: WebSocket connected': (r) => r && r.status === 101,
  });

  if (!wsOk) {
    console.log(`[ws_multi_turn] status=${response && response.status}`);

    // Retry once on auth failure — token may have expired right as we connected
    if (response && (response.status === 401 || response.status === 403)) {
      console.warn(`[ws_multi_turn] WS auth failed (${response.status}), refreshing and retrying`);
      const retryToken = getCurrentToken(data);
      if (retryToken !== token) {
        const retryUrl = `${data.wsUrl}?token=${retryToken}&tenantId=${config.tenantId}`;
        const retryRes = ws.connect(retryUrl, {}, function (socket) {
          // Simplified retry — just verify connection, don't re-run full conversation
          socket.on('open', function () {
            socket.close();
          });
        });
        check(retryRes, {
          'ws_multi_turn: WebSocket connected (retry)': (r) => r && r.status === 101,
        });
      }
    }
  }

  // Record success rate for the overall conversation
  const turnSuccessRatio = completedTurns / WS_TOTAL_TURNS;
  successRate.add(turnSuccessRatio >= 0.8 ? 1 : 0);
}

/**
 * Send a turn from the conversation script over WebSocket.
 */
function sendTurn(
  socket: { send: (data: string) => void },
  sessionId: string,
  turnIndex: number,
): void {
  const script = MULTI_TURN_SCRIPT[turnIndex];
  socket.send(
    JSON.stringify({
      type: 'send_message',
      sessionId,
      text: script.message,
    }),
  );
}

// ---------------------------------------------------------------------------
// Scenario 4: Concurrent orchestration (SSE)
// ---------------------------------------------------------------------------

export function concurrentOrchestration(data: SetupData): void {
  ensureFreshAuth(data);

  const allMessages = [...SINGLE_DELEGATION_MESSAGES, ...MULTI_DELEGATION_MESSAGES];
  const msg = allMessages[__ITER % allMessages.length];
  sendChatMessage(data, msg, 'concurrent');
  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleDelegation(data);
  multiDelegation(data);
  wsMultiTurn(data);
  concurrentOrchestration(data);
}
