/**
 * Agent Conversation E2E Benchmark
 *
 * Full flow: Runtime -> LLM -> MongoDB -> ClickHouse
 * Tests the complete agent conversation lifecycle including trace persistence.
 *
 * Sessions are created implicitly by the chat/stream endpoint — no separate
 * session creation call is needed. The SSE response includes a sessionId
 * in the metadata event.
 */
import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { postWithBackoff } from '../lib/http-utils.ts';
import { config, apiPath, buildAgentPath } from '../lib/config.ts';
import {
  getAuthToken,
  getRefreshToken,
  makeAuthHeaders,
  freshHeaders,
  ensureFreshAuth,
} from '../lib/auth.ts';
import { runHealthCheck } from '../lib/config.ts';
import { vuScale, scaleStages, scaleArrivalRate } from '../lib/vu-scaling.ts';
import {
  agentTurnLatency,
  llmLatency,
  ttft,
  dbWriteLatency,
  successRate,
  errorCount,
} from '../lib/metrics.ts';

const RUNTIME = config.runtimeUrl;
const PROJECT_ID = config.projectId;
const AGENT_PATH = buildAgentPath(config.agentName);

const CONVERSATION_TURNS = [
  'Hello, I need help configuring my agent.',
  'What tools are available for web search?',
  'Can you show me an example of a reasoning agent?',
  'How do I add constraints to prevent hallucination?',
  'Deploy this agent to production.',
];

// Baseline total: 40 (maxVUs) + 10 + 50 (peak) = 100 VUs — scale via MAX_VUS env var
const scale = vuScale(100);
const singleTurnRate = scaleArrivalRate(100, { rate: 10, preAllocatedVUs: 15, maxVUs: 40 });

export const options = {
  scenarios: {
    single_turn: {
      executor: 'constant-arrival-rate',
      rate: singleTurnRate.rate,
      timeUnit: '1s',
      duration: '3m',
      preAllocatedVUs: singleTurnRate.preAllocatedVUs,
      maxVUs: singleTurnRate.maxVUs,
      exec: 'singleTurn',
    },
    multi_turn_conversation: {
      executor: 'per-vu-iterations',
      vus: scale(10),
      iterations: 10,
      startTime: '3m',
      exec: 'multiTurnConversation',
    },
    concurrent_conversations: {
      executor: 'ramping-vus',
      startVUs: scale(5),
      stages: scaleStages(
        [
          { duration: '2m', target: 25 },
          { duration: '3m', target: 50 },
          { duration: '2m', target: 50 },
          { duration: '1m', target: 0 },
        ],
        100,
      ),
      startTime: '8m',
      exec: 'concurrentConversations',
    },
  },
  thresholds: {
    'http_req_duration{scenario:single_turn}': ['p(95)<5000', 'p(99)<10000'],
    'http_req_duration{scenario:multi_turn_conversation}': ['p(95)<8000', 'p(99)<15000'],
    http_req_failed: ['rate<0.05'],
    abl_agent_turn_latency_ms: ['p(95)<5000', 'p(99)<10000'],
    abl_llm_latency_ms: ['p(95)<4000'],
    abl_success_rate: ['rate>0.90'],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: 'agent-conversation-integration',
    tags: {
      service: 'agent-conversation',
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
}

export function setup(): SetupData {
  const token = getAuthToken();
  const refreshToken = getRefreshToken();
  const headers = makeAuthHeaders(token, refreshToken);

  // Smoke-check: verify runtime is reachable (skipped if HEALTH_CHECK=false)
  runHealthCheck(RUNTIME, 'runtime', headers);

  return { token, refreshToken, headers };
}

/** Result from a chat call — includes the response text and optional sessionId */
interface ChatResult {
  ok: boolean;
  sessionId: string | null;
}

/**
 * Send a message via the SSE chat/stream endpoint and measure the full round-trip.
 *
 * The endpoint auto-creates a session when no sessionId is provided.
 * When a sessionId IS provided, the message is appended to that session.
 *
 * Returns the sessionId extracted from the SSE metadata event (if present).
 */
function sendMessage(
  data: SetupData,
  message: string,
  scenarioTag: string,
  sessionId?: string,
): ChatResult {
  const body: Record<string, unknown> = {
    projectId: PROJECT_ID,
    agentPath: AGENT_PATH,
    messages: [{ role: 'user', content: message }],
  };
  if (sessionId) {
    body.sessionId = sessionId;
  }

  const start = Date.now();

  const res = postWithBackoff(`${RUNTIME}${apiPath('/v1/chat/stream')}`, JSON.stringify(body), {
    headers: { ...freshHeaders(data), Accept: 'text/event-stream' },
    tags: { scenario: scenarioTag },
    timeout: '30s',
  });

  const elapsed = Date.now() - start;
  agentTurnLatency.add(elapsed);

  // Parse SSE body to extract metrics and sessionId
  const sseBody = res.body as string;
  let extractedSessionId: string | null = sessionId || null;

  if (res.status === 200 && sseBody) {
    // Extract sessionId from metadata event: data: {"sessionId":"...","modelId":"..."}
    const metadataMatch = sseBody.match(/event:\s*metadata\ndata:\s*(\{[^\n]+\})/);
    if (metadataMatch) {
      try {
        const metadata = JSON.parse(metadataMatch[1]) as Record<string, unknown>;
        if (typeof metadata.sessionId === 'string') {
          extractedSessionId = metadata.sessionId as string;
        }
      } catch {
        /* ignore parse errors */
      }
    }

    // Extract latency from complete event: data: {"latencyMs":...}
    const completeMatch = sseBody.match(/event:\s*complete\ndata:\s*(\{[^\n]+\})/);
    if (completeMatch) {
      try {
        const complete = JSON.parse(completeMatch[1]) as Record<string, unknown>;
        if (typeof complete.latencyMs === 'number') llmLatency.add(complete.latencyMs as number);
      } catch {
        /* ignore parse errors */
      }
    }

    // Extract TTFT from first text_delta event timing
    const hasTextDelta = sseBody.includes('event: text_delta');
    if (hasTextDelta) {
      ttft.add(elapsed); // approximate — actual TTFT requires streaming client
    }
  }

  const ok = check(res, {
    'chat response 200': (r) => r.status === 200,
    'has SSE data': (r) => (r.body as string).includes('data:'),
    'has text_delta': (r) => (r.body as string).includes('event: text_delta'),
  });

  if (!ok) {
    console.log(`[sendMessage] status=${res.status}`);
  }

  return { ok, sessionId: extractedSessionId };
}

/** Verify traces were persisted to ClickHouse */
function verifyTraces(data: SetupData, sessionId: string): boolean {
  const res = http.get(
    `${RUNTIME}${apiPath(`/projects/${PROJECT_ID}/sessions/${sessionId}/traces`)}`,
    { headers: freshHeaders(data) },
  );

  const start = Date.now();
  const ok = check(res, {
    'traces 200': (r) => r.status === 200,
    'has trace events': (r) => {
      const body = r.json() as Record<string, unknown>;
      return Array.isArray(body.events) && (body.events as unknown[]).length > 0;
    },
  });

  dbWriteLatency.add(Date.now() - start);
  return ok;
}

/** Single turn: send one message (auto-creates session), verify traces */
export function singleTurn(data: SetupData): void {
  ensureFreshAuth(data);

  const result = sendMessage(data, CONVERSATION_TURNS[0], 'single_turn');
  successRate.add(result.ok ? 1 : 0);
  if (!result.ok) errorCount.add(1);

  if (result.sessionId) {
    sleep(0.5);
    verifyTraces(data, result.sessionId);
  }
  sleep(0.1);
}

/** Multi-turn conversation: 5 turns with context maintained */
export function multiTurnConversation(data: SetupData): void {
  ensureFreshAuth(data);

  let allOk = true;
  let sessionId: string | null = null;

  for (const turn of CONVERSATION_TURNS) {
    group(`turn: ${turn.substring(0, 30)}`, () => {
      const result = sendMessage(data, turn, 'multi_turn_conversation', sessionId || undefined);
      if (!result.ok) allOk = false;
      // Capture sessionId from first turn, reuse for subsequent turns
      if (result.sessionId) sessionId = result.sessionId;
      sleep(1 + Math.random() * 2); // simulate user think time
    });
  }

  successRate.add(allOk ? 1 : 0);
  if (!allOk) errorCount.add(1);

  // Verify full trace chain
  if (sessionId) {
    sleep(2);
    verifyTraces(data, sessionId);
  }
}

/** Many concurrent single-turn conversations */
export function concurrentConversations(data: SetupData): void {
  ensureFreshAuth(data);

  const message = CONVERSATION_TURNS[Math.floor(Math.random() * CONVERSATION_TURNS.length)];
  const result = sendMessage(data, message, 'concurrent_conversations');

  successRate.add(result.ok ? 1 : 0);
  if (!result.ok) errorCount.add(1);
  sleep(0.5);
}

// ---------------------------------------------------------------------------
// Default export — allows `k6 run --vus 1 --iterations 1` quick smoke tests
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  singleTurn(data);
  multiTurnConversation(data);
  concurrentConversations(data);
}
