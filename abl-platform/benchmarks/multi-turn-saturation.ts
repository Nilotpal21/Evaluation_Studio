/**
 * Multi-Turn Chat Saturation Test — Messages/sec Limit Finder
 *
 * Hammers the runtime chat endpoint with multi-turn conversations to find the
 * maximum sustained message throughput (msg/s) the platform can handle.
 *
 * How to read the results:
 *   1. On k6 Cloud, filter `phase=hold` and group by the `step` tag.
 *   2. The saturation tip is where msg/s stops growing but p95 starts climbing.
 *   3. The teardown prints a concise run summary to the console.
 *
 * Each VU iteration = 1 multi-turn conversation:
 *   POST /v1/chat/agent — session-creating first message
 *   POST /v1/chat/agent — follow-up messages on the same session
 *
 * Metrics (request level):
 *   chat_turn_latency_ms                — success-only latency (thresholds gate on this)
 *   chat_turn_all_latency_ms            — all requests incl. failures (diagnostic only)
 *   chat_turn_error_latency_ms          — failed request latency (detect fast-fail vs timeout)
 *   chat_turn_success_rate              — request success rate, tagged by turn=create|followup
 *   chat_turn_attempts_total            — total request attempts
 *   chat_turn_success_total             — successful requests
 *   chat_turn_failure_total             — failed requests (tagged by failure_reason + error_category)
 *   chat_turn_conn_error_total          — connection-level errors (status 0: DNS, refused, reset)
 *   chat_turn_suppressed_total          — demand suppressed by per-VU breaker (requested but not sent)
 *
 * Mock LLM:
 *   The runtime mock provider uses a 1s fetch-and-abort to httpbin.org/delay/10.
 *   This keeps the delay completely off the Node.js event loop — measuring only
 *   platform overhead (auth, DB, middleware, stream processing).
 *
 * Self-contained: bootstraps its own project, agent, and mock LLM model.
 *
 * Run locally (quick smoke):
 *   k6 run benchmarks/multi-turn-saturation.ts -e MAX_VUS=5 -e DURATION_MINUTES=2
 *
 * Run against remote (full saturation):
 *   k6 run benchmarks/multi-turn-saturation.ts \
 *     -e STUDIO_URL=https://agents-dev.kore.ai \
 *     -e RUNTIME_URL=https://agents-dev.kore.ai/api \
 *     -e INGRESS_BASE=https://agents-dev.kore.ai \
 *     -e WS_URL=wss://agents-dev.kore.ai/ws \
 *     -e AUTH_TOKEN=<jwt> \
 *     -e REFRESH_TOKEN=<refresh-token>
 *
 * Options:
 *   -e MAX_VUS=50              Max virtual users (default: 50)
 *   -e DURATION_MINUTES=20     Total test duration in minutes (default: 20)
 *   -e TURNS=5                 Messages per session (default: 5)
 *   -e INTER_MESSAGE_DELAY=1   Pause between messages in seconds (default: 1)
 *   -e BREAKER_ERROR_THRESHOLD=0.30  Error rate to trigger per-VU back-off (default: 30%)
 *   -e BREAKER_WINDOW_SIZE=20  Rolling window size for breaker (default: 20)
 *   -e BREAKER_BACKOFF_SEC=5   Back-off sleep when breaker is open (default: 5s)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Options } from 'k6/options';
import { Trend, Counter, Rate } from 'k6/metrics';
import { config, studioApiPath, apiPath } from './lib/config.ts';
import { ensureFreshAuth, getAuthToken, getRefreshToken } from './lib/auth.ts';

const setupResponseCallback = http.expectedStatuses(200, 201, 204, 400, 404, 409, 500);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MAX_VUS = parseInt(__ENV.MAX_VUS || '50', 10);
const DURATION_MINUTES = parseInt(__ENV.DURATION_MINUTES || '20', 10);
const TURNS_PER_SESSION = parseInt(__ENV.TURNS || '5', 10);
const INTER_MESSAGE_DELAY_SEC = parseFloat(__ENV.INTER_MESSAGE_DELAY || '1');
const SINGLE_SESSION = (__ENV.SINGLE_SESSION || '').toLowerCase() === 'true';
const MIN_TURN_SUCCESS_RATE = parseFloat(__ENV.MIN_TURN_SUCCESS_RATE || '0.97');
const MAX_TURN_P95_MS = parseInt(__ENV.MAX_TURN_P95_MS || '8000', 10);
const MAX_TURN_P99_MS = parseInt(__ENV.MAX_TURN_P99_MS || '12000', 10);

// Dynamic early termination: if error rate within a rolling window exceeds this,
// VUs self-throttle by sleeping instead of sending more doomed requests.
const BREAKER_ERROR_THRESHOLD = parseFloat(__ENV.BREAKER_ERROR_THRESHOLD || '0.30');
const BREAKER_WINDOW_SIZE = parseInt(__ENV.BREAKER_WINDOW_SIZE || '20', 10);
const BREAKER_BACKOFF_SEC = parseFloat(__ENV.BREAKER_BACKOFF_SEC || '5');

// ---------------------------------------------------------------------------
// Stepped Load Configuration
//
// Parse STEPS env var or auto-generate from MAX_VUS.
// Each step holds for STEP_DURATION_MINUTES (or auto-calculated).
// ---------------------------------------------------------------------------

function parseSteps(): number[] {
  if (__ENV.STEPS) {
    const steps = __ENV.STEPS.split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (steps.length === 0) {
      throw new Error(`STEPS must contain at least one positive integer: ${__ENV.STEPS}`);
    }

    for (let i = 1; i < steps.length; i++) {
      if (steps[i] <= steps[i - 1]) {
        throw new Error(`STEPS must be strictly increasing: ${__ENV.STEPS}`);
      }
    }

    return steps;
  }
  // Auto-generate: ~6 steps from 10% to 100% of MAX_VUS
  const steps: number[] = [];
  const increments = [0.1, 0.2, 0.4, 0.6, 0.8, 1.0];
  for (const pct of increments) {
    const vu = Math.max(1, Math.round(MAX_VUS * pct));
    if (steps.length === 0 || vu > steps[steps.length - 1]) {
      steps.push(vu);
    }
  }
  return steps;
}

const VU_STEPS = parseSteps();
const STEP_RAMP_SEC = parseInt(__ENV.RAMP_SECONDS || '30', 10);
const STEP_COOLDOWN_SEC = 30;

interface StepPlan {
  vus: number;
  rampSec: number;
  holdSec: number;
}

function buildStepPlan(): StepPlan[] {
  if (__ENV.STEP_DURATION_MINUTES) {
    const duration = parseInt(__ENV.STEP_DURATION_MINUTES, 10);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        `STEP_DURATION_MINUTES must be a positive integer: ${__ENV.STEP_DURATION_MINUTES}`,
      );
    }

    const holdSec = duration * 60 - STEP_RAMP_SEC;
    if (holdSec <= 0) {
      throw new Error(
        `STEP_DURATION_MINUTES=${duration} is too short for a ${STEP_RAMP_SEC}s ramp`,
      );
    }

    return VU_STEPS.map((vus) => ({ vus, rampSec: STEP_RAMP_SEC, holdSec }));
  }

  const totalBudgetSec = DURATION_MINUTES * 60;
  const fixedOverheadSec = STEP_RAMP_SEC * (VU_STEPS.length + 1);
  const availableHoldSec = totalBudgetSec - fixedOverheadSec;
  if (availableHoldSec <= 0) {
    throw new Error(
      `DURATION_MINUTES=${DURATION_MINUTES} is too short for ${VU_STEPS.length} steps and ${STEP_RAMP_SEC}s ramps`,
    );
  }

  const baseHoldSec = Math.floor(availableHoldSec / VU_STEPS.length);
  let holdRemainder = availableHoldSec % VU_STEPS.length;

  return VU_STEPS.map((vus) => {
    const holdSec = baseHoldSec + (holdRemainder > 0 ? 1 : 0);
    if (holdRemainder > 0) {
      holdRemainder--;
    }
    return { vus, rampSec: STEP_RAMP_SEC, holdSec };
  });
}

const STEP_PLAN = buildStepPlan();

interface StepWindow {
  label: string;
  phase: 'ramp' | 'hold' | 'cooldown';
  startSec: number;
  endSec: number;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  if (secs === 0) {
    return `${mins}m`;
  }
  return `${mins}m${secs}s`;
}

function getHoldSummary(): string {
  const holdDurations = STEP_PLAN.map((step) => step.holdSec);
  const minHold = Math.min(...holdDurations);
  const maxHold = Math.max(...holdDurations);

  if (minHold === maxHold) {
    return `${formatDuration(minHold)} hold per step`;
  }

  return `${formatDuration(minHold)}-${formatDuration(maxHold)} hold per step`;
}

function buildStepWindows(): StepWindow[] {
  const windows: StepWindow[] = [];
  let cursorSec = 0;

  for (const step of STEP_PLAN) {
    windows.push({
      label: `ramp_to_${step.vus}vu`,
      phase: 'ramp',
      startSec: cursorSec,
      endSec: cursorSec + step.rampSec,
    });
    cursorSec += step.rampSec;
    windows.push({
      label: `step_${step.vus}vu`,
      phase: 'hold',
      startSec: cursorSec,
      endSec: cursorSec + step.holdSec,
    });
    cursorSec += step.holdSec;
  }

  windows.push({
    label: 'cooldown',
    phase: 'cooldown',
    startSec: cursorSec,
    endSec: cursorSec + STEP_COOLDOWN_SEC,
  });

  return windows;
}

const STEP_WINDOWS = buildStepWindows();

// Build k6 ramping-vus stages: step up to each level, hold, then cooldown
function buildSteppedStages(): Array<{ duration: string; target: number }> {
  const stages: Array<{ duration: string; target: number }> = [];
  for (const step of STEP_PLAN) {
    stages.push({ duration: `${step.rampSec}s`, target: step.vus });
    stages.push({ duration: `${step.holdSec}s`, target: step.vus });
  }
  stages.push({ duration: `${STEP_COOLDOWN_SEC}s`, target: 0 });
  return stages;
}

function getStepContext(elapsedSec: number): StepWindow {
  for (const window of STEP_WINDOWS) {
    if (elapsedSec >= window.startSec && elapsedSec < window.endSec) {
      return window;
    }
  }

  return STEP_WINDOWS[STEP_WINDOWS.length - 1];
}

function getCurrentStepContext(startedAtMs: number): StepWindow {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  return getStepContext(elapsedSec);
}

function formatStepProgress(startedAtMs: number): string {
  const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  const step = getStepContext(elapsedSec);
  return `${step.label} (${step.phase}, t=${elapsedSec}s)`;
}

// ---------------------------------------------------------------------------
// Custom Metrics
//
// Latency is split into three trends:
//   - chat_turn_latency_ms: SUCCESS-ONLY — thresholds gate on this.
//     Never polluted by fast 429s (which deflate p95) or 30s timeouts (which inflate it).
//   - chat_turn_all_latency_ms: every request — useful for comparing attempted vs. useful load.
//   - chat_turn_error_latency_ms: failures only — tells you if errors are fast-fail or timeout.
// ---------------------------------------------------------------------------

const chatTurnLatency = new Trend('chat_turn_latency_ms', true);
const chatTurnAllLatency = new Trend('chat_turn_all_latency_ms', true);
const chatTurnErrorLatency = new Trend('chat_turn_error_latency_ms', true);
const chatTurnSuccessRate = new Rate('chat_turn_success_rate');
const chatTurnAttempts = new Counter('chat_turn_attempts_total');
const chatTurnSuccesses = new Counter('chat_turn_success_total');
const chatTurnFailures = new Counter('chat_turn_failure_total');
const chatTurnConnErrors = new Counter('chat_turn_conn_error_total');
/** Demand suppressed by the per-VU breaker — requested but never sent. */
const chatTurnSuppressed = new Counter('chat_turn_suppressed_total');

// ---------------------------------------------------------------------------
// Per-VU Rolling Error Rate Breaker
//
// Each VU tracks its last N results. When the error ratio exceeds the threshold,
// the VU backs off instead of hammering a saturated system with doomed requests.
// This produces cleaner data: the saturation point is where success throughput
// plateaus, not where the system drowns in retries.
// ---------------------------------------------------------------------------

const recentResults: boolean[] = [];
let resultCursor = 0;
/** Timestamp (ms) when the breaker last opened. After BREAKER_BACKOFF_SEC,
 *  the next iteration sends a half-open probe request instead of suppressing. */
let breakerOpenedAtMs = 0;

function recordResult(success: boolean): void {
  if (recentResults.length < BREAKER_WINDOW_SIZE) {
    recentResults.push(success);
  } else {
    recentResults[resultCursor % BREAKER_WINDOW_SIZE] = success;
  }
  resultCursor++;
}

function isBreakerOpen(): boolean {
  if (recentResults.length < BREAKER_WINDOW_SIZE) return false;
  const failures = recentResults.filter((r) => !r).length;
  const overThreshold = failures / recentResults.length > BREAKER_ERROR_THRESHOLD;
  if (!overThreshold) {
    breakerOpenedAtMs = 0;
    return false;
  }
  // Half-open: after the backoff period, allow one probe request through.
  // If the probe succeeds, recordResult(true) shifts the window and the
  // breaker closes naturally. If it fails, the window stays bad and we
  // re-enter backoff on the next iteration.
  if (breakerOpenedAtMs > 0 && Date.now() - breakerOpenedAtMs >= BREAKER_BACKOFF_SEC * 1000) {
    breakerOpenedAtMs = 0; // reset — next call will re-evaluate after probe result
    return false; // allow one probe
  }
  if (breakerOpenedAtMs === 0) {
    breakerOpenedAtMs = Date.now();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Options — single scenario, all VUs on multi-turn chat
// ---------------------------------------------------------------------------

export const options: Options = {
  scenarios: {
    multi_turn_chat: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: buildSteppedStages(),
      exec: 'multiTurnChat',
      tags: { scenario: 'multi_turn_chat', service: 'runtime' },
    },
  },
  setupTimeout: SINGLE_SESSION ? '300s' : '120s',
  thresholds: {
    // Latency gates on SUCCESS-ONLY trend — never includes failed request timings
    'chat_turn_latency_ms{phase:hold,turn:create}': [
      `p(95)<${MAX_TURN_P95_MS}`,
      `p(99)<${MAX_TURN_P99_MS}`,
    ],
    'chat_turn_latency_ms{phase:hold,turn:followup}': [
      `p(95)<${MAX_TURN_P95_MS}`,
      `p(99)<${MAX_TURN_P99_MS}`,
    ],
    // Success rate gates on custom check (status 200 + valid body), not http_req_failed
    'chat_turn_success_rate{phase:hold,turn:create}': [`rate>${MIN_TURN_SUCCESS_RATE}`],
    'chat_turn_success_rate{phase:hold,turn:followup}': [`rate>${MIN_TURN_SUCCESS_RATE}`],
    // Error latency is diagnostic-only (abortOnFail: false) — just surface it in reports
    'chat_turn_error_latency_ms{phase:hold}': [{ threshold: 'p(50)<30000', abortOnFail: false }],
  },
  cloud: {
    projectID: __ENV.K6_CLOUD_PROJECT_ID || undefined,
    name: SINGLE_SESSION ? 'single-session-turn-latency' : 'multi-turn-chat-saturation',
    tags: {
      service: 'runtime',
      type: 'saturation',
      tier: __ENV.TIER || 'm',
      env: __ENV.ENV || 'staging',
    },
  },
} as Options;

// ---------------------------------------------------------------------------
// Setup — bootstrap project + agent + mock model
// ---------------------------------------------------------------------------

interface SetupData {
  baseToken: string;
  baseRefreshToken: string;
  token: string;
  projectId: string;
  agentName: string;
  tenantId: string;
  tenantModelId: string;
  credentialId: string;
  runId: string;
  startedAtMs: number;
  /** Single shared session (legacy, hits queue limits) */
  sessionId: string;
  /** Per-VU sessions: index by (__VU - 1) % length */
  vuSessions: string[];
}

interface BaseAuthData {
  token: string;
  refreshToken: string;
}

interface TenantTokenState {
  tenantId: string;
  baseToken: string;
  token: string;
}

let tenantTokenState: TenantTokenState | null = null;

function switchToTenant(baseToken: string, tenantId: string): string {
  const switchRes = http.post(
    `${config.studioUrl}/api/auth/tenants/switch`,
    JSON.stringify({ tenantId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${baseToken}`,
      },
      responseCallback: setupResponseCallback,
      tags: { name: 'setup: switch tenant' },
    },
  );
  if (switchRes.status !== 200) {
    throw new Error(`Tenant switch to ${tenantId} failed: ${switchRes.status} ${switchRes.body}`);
  }

  const switchData = switchRes.json() as { accessToken: string };
  return switchData.accessToken;
}

function buildTenantHeaders(token: string, tenantId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': tenantId,
    'X-Load-Test': config.loadTestKey,
  };

  if (config.benchmarkProfile) {
    headers['X-Benchmark-Profile'] = config.benchmarkProfile;
  }

  return headers;
}

function getTenantHeaders(
  baseAuth: BaseAuthData,
  tenantId: string,
  initialTenantToken: string,
): Record<string, string> {
  const currentBaseToken = ensureFreshAuth(baseAuth);
  if (
    tenantTokenState &&
    tenantTokenState.tenantId === tenantId &&
    tenantTokenState.baseToken === currentBaseToken
  ) {
    return buildTenantHeaders(tenantTokenState.token, tenantId);
  }

  const tenantToken =
    currentBaseToken === baseAuth.token && initialTenantToken
      ? initialTenantToken
      : switchToTenant(currentBaseToken, tenantId);

  tenantTokenState = {
    tenantId,
    baseToken: currentBaseToken,
    token: tenantToken,
  };

  return buildTenantHeaders(tenantToken, tenantId);
}

export function setup(): SetupData {
  const now = Date.now();
  const ts = `${now}`;
  const runId = `chat-sat-${ts}`;

  console.log(`\n========================================`);
  console.log(`  Stepped Saturation Test: ${runId}`);
  console.log(`  Steps: ${VU_STEPS.join(' → ')} VUs`);
  console.log(`  Hold: ${getHoldSummary()} | Turns: ${TURNS_PER_SESSION}/session`);
  console.log(`========================================\n`);

  const baseToken = getAuthToken();
  const baseRefreshToken = getRefreshToken();
  const tenantId = config.tenantId;
  const currentBaseToken = ensureFreshAuth({
    token: baseToken,
    refreshToken: baseRefreshToken,
  });

  // Bootstrap resources in the target tenant up front. During the hot path we
  // keep using this token until the base auth refreshes, then re-switch once.
  // --- Super Admin: Upgrade tenant plan to ENTERPRISE to lift rate limits ---
  try {
    const superAdminEmail = __ENV.SUPER_ADMIN_EMAIL || 'superadmin@platform.internal';
    console.log(`[setup] Logging in as super admin (${superAdminEmail}) to upgrade tenant plan...`);
    const saLoginRes = http.post(
      `${config.studioUrl}/api/auth/dev-login`,
      JSON.stringify({ email: superAdminEmail, name: 'Super Admin' }),
      {
        headers: { 'Content-Type': 'application/json' },
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: super admin login' },
      },
    );
    if (saLoginRes.status === 200) {
      const saData = saLoginRes.json() as { accessToken: string };
      const saToken = saData.accessToken;
      console.log(`[setup] Super admin authenticated successfully`);

      const upgradePatchRes = http.patch(
        `${config.studioUrl}/api/platform/admin/tenants/${tenantId}/subscription`,
        JSON.stringify({ planTier: 'ENTERPRISE' }),
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${saToken}`,
            Origin: config.studioUrl,
          },
          responseCallback: setupResponseCallback,
          tags: { name: 'setup: upgrade tenant plan' },
        },
      );
      if (upgradePatchRes.status === 200 || upgradePatchRes.status === 204) {
        console.log(
          `[setup] Tenant ${tenantId} upgraded to ENTERPRISE (status=${upgradePatchRes.status})`,
        );
      } else {
        console.warn(
          `[setup] Tenant plan upgrade failed: status=${upgradePatchRes.status} body=${((upgradePatchRes.body as string) || '').substring(0, 500)}`,
        );
      }
    } else {
      console.warn(
        `[setup] Super admin login failed: status=${saLoginRes.status} body=${((saLoginRes.body as string) || '').substring(0, 500)}`,
      );
    }
  } catch (e) {
    console.warn(
      `[setup] Super admin upgrade skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  console.log(`[setup] Switching to tenant: ${tenantId}`);
  const token = switchToTenant(currentBaseToken, tenantId);
  console.log(`[setup] Switched to tenant: ${tenantId}`);

  const headers = buildTenantHeaders(token, tenantId);

  console.log(`[setup] Authenticated. Tenant: ${tenantId}`);

  // --- Get or Create project (stable slug, reused across runs) ---
  // Slug pattern matches multi-tenant: bench-sat-${label}. No PROJECT_ID pinning —
  // both scripts must use identical project-selection semantics for comparison.
  const projectSlug = 'bench-sat-default';
  let projectId = '';

  const listProjectsRes = http.get(`${config.studioUrl}${studioApiPath('/projects')}`, {
    headers,
    responseCallback: setupResponseCallback,
    tags: { name: 'setup: list projects' },
  });

  console.log(`[setup] List projects response: status=${listProjectsRes.status}`);
  if (listProjectsRes.status === 200) {
    const body = listProjectsRes.json() as {
      projects?: Array<{ id: string; _id: string; slug?: string; name?: string }>;
    };
    const allProjects = body.projects || [];
    console.log(
      `[setup] Found ${allProjects.length} projects: [${allProjects.map((p) => p.slug || p.name || p.id || p._id).join(', ')}]`,
    );
    const existing = allProjects.find((p) => p.slug === projectSlug || p.name === projectSlug);
    if (existing) {
      projectId = existing.id || existing._id;
      console.log(`[setup] Reusing project: ${projectId} (${projectSlug})`);
    }
  } else {
    console.warn(
      `[setup] List projects failed: status=${listProjectsRes.status} body=${((listProjectsRes.body as string) || '').substring(0, 500)}`,
    );
  }

  if (!projectId) {
    const projectRes = http.post(
      `${config.studioUrl}${studioApiPath('/projects')}`,
      JSON.stringify({
        name: projectSlug,
        slug: projectSlug,
        description: `Multi-turn chat saturation project`,
      }),
      { headers, responseCallback: setupResponseCallback, tags: { name: 'setup: create project' } },
    );

    if (projectRes.status === 201) {
      const projectBody = projectRes.json() as { project: { id: string } };
      projectId = projectBody.project.id;
      console.log(`[setup] Created project: ${projectId} (${projectSlug})`);
    } else if (projectRes.status === 409) {
      // Slug conflict — project exists but wasn't in our listing (different owner).
      // Re-fetch all projects and find by slug.
      console.warn(`[setup] Project slug conflict, searching all projects...`);
      const retryListRes = http.get(`${config.studioUrl}${studioApiPath('/projects')}`, {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: retry list projects' },
      });
      if (retryListRes.status === 200) {
        const body = retryListRes.json() as {
          projects?: Array<{ id: string; _id: string; slug?: string; name?: string }>;
        };
        const found = (body.projects || []).find(
          (p) => p.slug === projectSlug || p.name === projectSlug,
        );
        if (found) {
          projectId = found.id || found._id;
          console.log(`[setup] Found existing project via retry: ${projectId} (${projectSlug})`);
        }
      }
      if (!projectId) {
        // Last resort: use a unique slug to avoid permanent conflict
        const fallbackSlug = `bench-sat-${Date.now()}`;
        console.warn(`[setup] Slug conflict unresolvable, creating with fallback: ${fallbackSlug}`);
        const fallbackRes = http.post(
          `${config.studioUrl}${studioApiPath('/projects')}`,
          JSON.stringify({
            name: fallbackSlug,
            slug: fallbackSlug,
            description: `Multi-turn chat saturation project (fallback)`,
          }),
          {
            headers,
            responseCallback: setupResponseCallback,
            tags: { name: 'setup: create project fallback' },
          },
        );
        if (fallbackRes.status === 201) {
          const fallbackBody = fallbackRes.json() as { project: { id: string } };
          projectId = fallbackBody.project.id;
          console.log(`[setup] Created fallback project: ${projectId} (${fallbackSlug})`);
        } else {
          console.error(
            `[setup] Fallback project creation failed: ${fallbackRes.status} ${fallbackRes.body}`,
          );
          throw new Error(`Project creation failed: ${fallbackRes.status}`);
        }
      }
    } else {
      console.error(`[setup] Project creation failed: ${projectRes.status} ${projectRes.body}`);
      throw new Error(`Project creation failed: ${projectRes.status}`);
    }
  }

  // --- Get or Create agent (stable name) ---
  const agentName = 'bench_sat_agent';
  let agentExists = false;

  const listAgentsRes = http.get(
    `${config.studioUrl}${studioApiPath(`/projects/${projectId}/agents`)}`,
    {
      headers,
      responseCallback: setupResponseCallback,
      tags: { name: 'setup: list agents' },
    },
  );

  console.log(`[setup] List agents response: status=${listAgentsRes.status}`);
  if (listAgentsRes.status === 200) {
    const agentsBody = listAgentsRes.json() as { agents?: Array<{ name: string }> };
    const allAgents = agentsBody.agents || [];
    console.log(
      `[setup] Found ${allAgents.length} agents: [${allAgents.map((a) => a.name).join(', ')}]`,
    );
    agentExists = allAgents.some((a) => a.name === agentName);
  } else {
    console.warn(
      `[setup] List agents failed: status=${listAgentsRes.status} body=${((listAgentsRes.body as string) || '').substring(0, 500)}`,
    );
  }

  const dslContent = [
    `AGENT: ${agentName}`,
    `MODEL: mock-model`,
    `GOAL: "respond to user questions concisely"`,
    `PERSONA: |`,
    `  You are a helpful assistant.`,
    `  CRITICAL: Keep each response to 1-2 sentences.`,
  ].join('\n');

  if (agentExists) {
    console.log(`[setup] Reusing agent: ${agentName}`);
  } else {
    const agentRes = http.post(
      `${config.studioUrl}${studioApiPath(`/projects/${projectId}/agents`)}`,
      JSON.stringify({
        name: agentName,
        agentPath: `${projectId}/default/${agentName}`,
        description: 'Load test saturation agent',
        instructions: 'Respond concisely to all questions.',
        model: 'mock-model',
        dslContent,
      }),
      { headers, responseCallback: setupResponseCallback, tags: { name: 'setup: create agent' } },
    );

    check(agentRes, { 'agent created': (r) => r.status === 200 || r.status === 201 });
    console.log(
      `[setup] Create agent response: status=${agentRes.status} body=${((agentRes.body as string) || '').substring(0, 300)}`,
    );
    if (agentRes.status !== 200 && agentRes.status !== 201) {
      throw new Error(`Agent creation failed: ${agentRes.status}`);
    }
    console.log(`[setup] Created agent: ${agentName}`);

    // Save DSL
    const dslRes = http.put(
      `${config.studioUrl}${studioApiPath(`/projects/${projectId}/agents/${encodeURIComponent(agentName)}/dsl`)}`,
      JSON.stringify({ dslContent }),
      { headers, responseCallback: setupResponseCallback, tags: { name: 'setup: save DSL' } },
    );
    console.log(`[setup] Save DSL response: status=${dslRes.status}`);
  }

  // --- Mock TenantModel ---
  const runtimeHeaders = { ...headers, 'X-Tenant-Id': tenantId };

  let tenantModelId = '';
  let credentialId = '';
  const listModelsRes = http.get(`${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models`)}`, {
    headers: runtimeHeaders,
    responseCallback: setupResponseCallback,
    tags: { name: 'setup: list models' },
  });

  console.log(`[setup] List models response: status=${listModelsRes.status}`);
  if (listModelsRes.status === 200) {
    const modelsBody = listModelsRes.json() as {
      models?: Array<{ id: string; _id: string; modelId: string }>;
    };
    const allModels = modelsBody.models || [];
    console.log(
      `[setup] Found ${allModels.length} models: [${allModels.map((m) => m.modelId || m.id || m._id).join(', ')}]`,
    );
    const existing = allModels.find((m) => m.modelId === 'mock-model');
    if (existing) {
      tenantModelId = existing.id || existing._id;
      console.log(`[setup] Reusing mock model: ${tenantModelId}`);
    }
  } else {
    console.warn(
      `[setup] List models failed: status=${listModelsRes.status} body=${((listModelsRes.body as string) || '').substring(0, 500)}`,
    );
  }

  if (!tenantModelId) {
    const modelRes = http.post(
      `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models`)}`,
      JSON.stringify({
        displayName: 'Mock LLM Bench',
        modelId: 'mock-model',
        provider: 'mock',
        integrationType: 'easy',
        isDefault: false,
        tier: 'balanced',
        supportsTools: true,
        supportsStreaming: true,
        capabilities: ['text', 'tools', 'streaming'],
      }),
      {
        headers: runtimeHeaders,
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: create model' },
      },
    );

    if (modelRes.status === 201) {
      const modelBody = modelRes.json() as { model?: { id: string; _id: string } };
      tenantModelId = modelBody.model?.id || modelBody.model?._id || '';
      console.log(`[setup] Mock model created: ${tenantModelId}`);
    } else {
      console.warn(`[setup] Mock model creation: ${modelRes.status} ${modelRes.body}`);
    }
  }

  if (tenantModelId) {
    // -----------------------------------------------------------------
    // Ensure TenantModel has a valid primary connection with a live
    // credential. Previous teardowns may have deleted the credential
    // while leaving the TenantModel and a dangling connection behind.
    // -----------------------------------------------------------------
    const credName = 'bench-mock-cred';

    // 1. Check existing connections — is there a valid primary?
    let needsNewConnection = true;
    const connListRes = http.get(
      `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models/${tenantModelId}/connections`)}`,
      {
        headers: runtimeHeaders,
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: list connections' },
      },
    );
    console.log(`[setup] List connections response: status=${connListRes.status}`);
    if (connListRes.status === 200) {
      const connBody = connListRes.json() as {
        connections?: Array<{ id: string; credentialId: string; isPrimary: boolean }>;
      };
      const allConns = connBody.connections || [];
      console.log(
        `[setup] Found ${allConns.length} connections. Primary: ${allConns.find((c) => c.isPrimary)?.id || 'none'}, credentialId: ${allConns.find((c) => c.isPrimary)?.credentialId || 'none'}`,
      );
      const primary = allConns.find((c) => c.isPrimary);
      if (primary) {
        // Verify the credential still exists
        const credCheckRes = http.get(
          `${config.studioUrl}/api/credentials/${primary.credentialId}`,
          {
            headers,
            responseCallback: setupResponseCallback,
            tags: { name: 'setup: verify credential' },
          },
        );
        if (credCheckRes.status === 200) {
          credentialId = primary.credentialId;
          needsNewConnection = false;
          console.log(`[setup] Primary connection valid, credential: ${credentialId}`);
        } else {
          console.warn(`[setup] Primary connection credential deleted, will recreate`);
        }
      }
    }

    // 2. Get or create credential
    if (!credentialId) {
      const listCredRes = http.get(`${config.studioUrl}/api/credentials`, {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: list credentials' },
      });
      console.log(`[setup] List credentials response: status=${listCredRes.status}`);
      if (listCredRes.status === 200) {
        const creds = listCredRes.json() as Array<{ id: string; name: string }>;
        const credArr = Array.isArray(creds) ? creds : [];
        console.log(
          `[setup] Found ${credArr.length} credentials: [${credArr.map((c) => c.name).join(', ')}]`,
        );
        const found = credArr.find((c) => c.name === credName);
        if (found) {
          credentialId = found.id;
          console.log(`[setup] Reusing credential: ${credentialId}`);
        }
      } else {
        console.warn(
          `[setup] List credentials failed: status=${listCredRes.status} body=${((listCredRes.body as string) || '').substring(0, 500)}`,
        );
      }
    }

    if (!credentialId) {
      const credRes = http.post(
        `${config.studioUrl}/api/credentials`,
        JSON.stringify({
          name: credName,
          provider: 'custom',
          apiKey: 'mock-key',
          authType: 'api_key',
        }),
        {
          headers,
          responseCallback: setupResponseCallback,
          tags: { name: 'setup: create credential' },
        },
      );

      console.log(
        `[setup] Create credential response: status=${credRes.status} body=${((credRes.body as string) || '').substring(0, 300)}`,
      );
      if (credRes.status === 201) {
        credentialId = (credRes.json() as { id?: string }).id || '';
        console.log(`[setup] Created credential: ${credentialId}`);
      } else if (credRes.status === 409) {
        // Name conflict — retry listing, then fallback to unique name
        console.warn(`[setup] Credential name conflict (409), retrying list...`);
        const retryCredRes = http.get(`${config.studioUrl}/api/credentials`, {
          headers,
          responseCallback: setupResponseCallback,
          tags: { name: 'setup: retry list credentials' },
        });
        if (retryCredRes.status === 200) {
          const retryCreds = retryCredRes.json() as Array<{ id: string; name: string }>;
          const retryArr = Array.isArray(retryCreds) ? retryCreds : [];
          const retryFound = retryArr.find((c) => c.name === credName);
          if (retryFound) {
            credentialId = retryFound.id;
            console.log(`[setup] Found credential via retry: ${credentialId}`);
          }
        }
        if (!credentialId) {
          const uniqueCredName = `${credName}-${Date.now()}`;
          console.log(`[setup] Creating credential with unique name: ${uniqueCredName}`);
          const uniqueCredRes = http.post(
            `${config.studioUrl}/api/credentials`,
            JSON.stringify({
              name: uniqueCredName,
              provider: 'custom',
              apiKey: 'mock-key',
              authType: 'api_key',
            }),
            {
              headers,
              responseCallback: setupResponseCallback,
              tags: { name: 'setup: create credential unique' },
            },
          );
          if (uniqueCredRes.status === 201) {
            credentialId = (uniqueCredRes.json() as { id?: string }).id || '';
            console.log(`[setup] Created credential (unique): ${credentialId}`);
          } else {
            console.error(
              `[setup] Unique credential creation also failed: ${uniqueCredRes.status} ${((uniqueCredRes.body as string) || '').substring(0, 300)}`,
            );
          }
        }
      } else {
        console.warn(`[setup] Credential creation failed: status=${credRes.status}`);
      }
    }

    // 3. Link credential as primary connection (only if needed)
    if (credentialId && needsNewConnection) {
      const linkRes = http.post(
        `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models/${tenantModelId}/connections`)}`,
        JSON.stringify({ credentialId, isPrimary: true, connectionType: 'http' }),
        {
          headers: runtimeHeaders,
          responseCallback: setupResponseCallback,
          tags: { name: 'setup: link credential' },
        },
      );
      if (linkRes.status === 201 || linkRes.status === 200) {
        console.log(`[setup] Credential linked as primary connection`);
      } else {
        console.warn(`[setup] Connection link: ${linkRes.status} ${linkRes.body}`);
      }
    }

    // Agent model config
    const agentModelConfigRes = http.put(
      `${config.runtimeUrl}${apiPath(`/projects/${projectId}/agents/${agentName}/model-config`)}`,
      JSON.stringify({ defaultModel: 'mock-model' }),
      {
        headers: runtimeHeaders,
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: agent model config' },
      },
    );
    console.log(
      `[setup] Agent model config PUT response: status=${agentModelConfigRes.status} body=${((agentModelConfigRes.body as string) || '').substring(0, 300)}`,
    );

    // Project ModelConfig (get-or-create)
    let projectModelExists = false;
    const listProjectModelsRes = http.get(
      `${config.studioUrl}${studioApiPath('/models')}?projectId=${projectId}`,
      {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: list project models' },
      },
    );
    console.log(`[setup] List project models response: status=${listProjectModelsRes.status}`);
    if (listProjectModelsRes.status === 200) {
      const modelsBody = listProjectModelsRes.json() as {
        models?: Array<{ modelId?: string; name?: string }>;
      };
      const models =
        modelsBody.models ||
        (Array.isArray(listProjectModelsRes.json())
          ? (listProjectModelsRes.json() as Array<{ modelId?: string; name?: string }>)
          : []);
      console.log(
        `[setup] Found ${models.length} project models: [${models.map((m) => m.modelId || m.name || 'unknown').join(', ')}]`,
      );
      projectModelExists = models.some(
        (m) => m.modelId === 'mock-model' || m.name === 'Mock LLM Bench',
      );
    } else {
      console.warn(
        `[setup] List project models failed: status=${listProjectModelsRes.status} body=${((listProjectModelsRes.body as string) || '').substring(0, 500)}`,
      );
    }

    if (projectModelExists) {
      console.log(`[setup] Reusing project ModelConfig`);
    } else {
      const modelConfigRes = http.post(
        `${config.studioUrl}${studioApiPath('/models')}`,
        JSON.stringify({
          projectId,
          name: 'Mock LLM Bench',
          modelId: 'mock-model',
          provider: 'mock',
          tenantModelId,
          temperature: 0.7,
          maxTokens: 4096,
          supportsTools: true,
          supportsVision: false,
          supportsStreaming: true,
          contextWindow: 128000,
          tier: 'balanced',
          isDefault: false,
          priority: 0,
        }),
        {
          headers,
          responseCallback: setupResponseCallback,
          tags: { name: 'setup: project model config' },
        },
      );
      console.log(
        `[setup] Project ModelConfig response: status=${modelConfigRes.status} body=${((modelConfigRes.body as string) || '').substring(0, 300)}`,
      );
      if (modelConfigRes.status === 200 || modelConfigRes.status === 201) {
        console.log(`[setup] Project ModelConfig created`);
      } else {
        console.log(`[setup] Project ModelConfig: ${modelConfigRes.status} (may already exist)`);
      }
    }
  }

  // Smoke check — also creates the shared session when SINGLE_SESSION is enabled
  console.log(`[setup] Smoke check...`);
  const smokeRes = http.post(
    `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
    JSON.stringify({ projectId, message: 'Smoke test.' }),
    {
      headers,
      timeout: '30s',
      responseCallback: setupResponseCallback,
      tags: { name: 'setup: smoke check' },
    },
  );

  let sessionId = '';
  if (smokeRes.status === 200) {
    const smokeBody = smokeRes.json() as { sessionId?: string; response?: string };
    sessionId = smokeBody.sessionId || '';
    console.log(
      `[setup] Smoke check passed. Session: ${sessionId}, response snippet: "${(smokeBody.response || '').substring(0, 200)}"`,
    );
  } else {
    console.error(
      `[setup] Smoke check FAILED: status=${smokeRes.status} content-type=${smokeRes.headers['Content-Type'] || 'unknown'}`,
    );
    console.error(
      `[setup] Smoke check response body: ${((smokeRes.body as string) || '').substring(0, 500)}`,
    );
    console.error(
      `[setup] Smoke check response headers: ${JSON.stringify(Object.fromEntries(Object.entries(smokeRes.headers).slice(0, 10)))}`,
    );
  }

  // Pre-create per-VU sessions so each VU only sends followup messages
  const vuSessions: string[] = [];
  if (SINGLE_SESSION) {
    if (!sessionId) {
      throw new Error('SINGLE_SESSION mode: smoke check failed to create a session');
    }
    vuSessions.push(sessionId);
    const sessionsNeeded = MAX_VUS - 1; // smoke check already created 1
    console.log(`[setup] Pre-creating ${sessionsNeeded} sessions for ${MAX_VUS} VUs...`);
    for (let i = 0; i < sessionsNeeded; i++) {
      const sRes = http.post(
        `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
        JSON.stringify({ projectId, message: `Session warmup ${i + 2}/${MAX_VUS}` }),
        {
          headers,
          timeout: '30s',
          responseCallback: setupResponseCallback,
          tags: { name: 'setup: pre-create session' },
        },
      );
      if (sRes.status === 200) {
        const sid = (sRes.json() as { sessionId?: string }).sessionId;
        if (sid) vuSessions.push(sid);
      } else {
        console.warn(`[setup] Session ${i + 2} failed: ${sRes.status}`);
      }
    }
    console.log(`[setup] Pre-created ${vuSessions.length}/${MAX_VUS} sessions`);
  }

  const mode = SINGLE_SESSION
    ? `SINGLE_SESSION (${vuSessions.length} pre-created sessions, 1 per VU)`
    : 'multi-session';
  console.log(`\n[setup] Ready. Mode: ${mode}`);
  console.log(`  Project: ${projectId} | Agent: ${agentName}`);
  console.log(`  Mock LLM: 1000-1500ms random delay`);
  console.log(`  Steps: ${VU_STEPS.join(' → ')} VUs (${getHoldSummary()})`);
  if (SINGLE_SESSION) {
    console.log(`  Shared session: ${sessionId}`);
  }
  console.log(
    `  Latency: chat_turn_latency_ms (success-only) | chat_turn_error_latency_ms (failures)`,
  );
  console.log(`  Throughput: rate(chat_turn_success_total) vs rate(chat_turn_attempts_total)`);
  console.log(
    `  Breaker: ${(BREAKER_ERROR_THRESHOLD * 100).toFixed(0)}% error rate over ${BREAKER_WINDOW_SIZE} requests → ${BREAKER_BACKOFF_SEC}s back-off`,
  );
  console.log(
    `  Tip: saturation tip = where success msg/s plateaus while p95(chat_turn_latency_ms) climbs\n`,
  );

  return {
    baseToken: currentBaseToken,
    baseRefreshToken,
    token,
    projectId,
    agentName,
    tenantId,
    tenantModelId,
    credentialId,
    runId,
    startedAtMs: Date.now(),
    sessionId,
    vuSessions,
  };
}

// ---------------------------------------------------------------------------
// Metrics Recording Helpers
//
// recordTurnMetrics() is the single place where all metrics are emitted.
// Latency split: success → chatTurnLatency, failure → chatTurnErrorLatency.
// Both → chatTurnAllLatency.
// ---------------------------------------------------------------------------

type ErrorCategory = 'CONN_ERROR' | 'RATE_LIMIT' | 'AUTH_ERROR' | 'SERVER_ERROR' | 'CLIENT_ERROR';

function categorizeError(status: number): ErrorCategory {
  if (status === 0) return 'CONN_ERROR';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status >= 500) return 'SERVER_ERROR';
  return 'CLIENT_ERROR';
}

interface TurnResult {
  ok: boolean;
  elapsedMs: number;
  status: number;
  tags: { step: string; phase: string; turn: 'create' | 'followup' };
}

function recordTurnMetrics(result: TurnResult): void {
  const { ok, elapsedMs, status, tags } = result;

  // All-requests latency (diagnostic)
  chatTurnAllLatency.add(elapsedMs, tags);
  chatTurnAttempts.add(1, tags);
  chatTurnSuccessRate.add(ok ? 1 : 0, tags);
  recordResult(ok);

  if (ok) {
    // Success-only latency — thresholds gate on this
    chatTurnLatency.add(elapsedMs, tags);
    chatTurnSuccesses.add(1, tags);
  } else {
    // Error-only latency — diagnostic (spot fast-fail vs timeout)
    chatTurnErrorLatency.add(elapsedMs, tags);
    const category = categorizeError(status);
    chatTurnFailures.add(1, {
      ...tags,
      failure_reason:
        status !== 200 && status !== 0
          ? 'http_status'
          : status === 0
            ? 'conn_error'
            : 'invalid_response',
      error_category: category,
    });
    if (status === 0) {
      chatTurnConnErrors.add(1, tags);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario: Multi-Turn Chat — 100% of VUs
//
// Each iteration: create session → send TURNS_PER_SESSION messages.
// Use rate(chat_turn_success_total) for useful throughput and
// rate(chat_turn_attempts_total) for attempted load.
// ---------------------------------------------------------------------------

export function multiTurnChat(data: SetupData): void {
  if (SINGLE_SESSION) {
    return singleSessionTurn(data);
  }

  // Breaker check: if this VU's recent error rate is too high, back off
  // instead of hammering a saturated system with doomed requests.
  if (isBreakerOpen()) {
    const step = getCurrentStepContext(data.startedAtMs);
    const suppressTags = { step: step.label, phase: step.phase, turn: 'create' as const };
    if (__ITER % 50 === 0) {
      console.warn(
        `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} BREAKER OPEN — backing off ${BREAKER_BACKOFF_SEC}s (>${(BREAKER_ERROR_THRESHOLD * 100).toFixed(0)}% errors in last ${BREAKER_WINDOW_SIZE} requests)`,
      );
    }
    // Count suppressed demand: attempt + suppressed + success_rate=0.
    // Not counted as chatTurnFailures — failures are real server errors;
    // suppressed is client-side demand shaping tracked separately.
    chatTurnAttempts.add(1, suppressTags);
    chatTurnSuppressed.add(1, suppressTags);
    chatTurnSuccessRate.add(0, suppressTags);
    sleep(BREAKER_BACKOFF_SEC);
    return;
  }

  const headers = getTenantHeaders(
    { token: data.baseToken, refreshToken: data.baseRefreshToken },
    data.tenantId,
    data.token,
  );
  const projectId = data.projectId;

  // ── First message — creates session ────────────────────────────────────
  const createStep = getCurrentStepContext(data.startedAtMs);
  const createTags = { step: createStep.label, phase: createStep.phase, turn: 'create' as const };
  const createStart = Date.now();
  const createRes = http.post(
    `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
    JSON.stringify({
      projectId,
      message: `Chat saturation: hello at ${Date.now()}`,
    }),
    {
      headers,
      timeout: '30s',
      tags: { name: 'POST /v1/chat/agent', step: createStep.label, turn: 'create' },
    },
  );
  const createElapsed = Date.now() - createStart;

  const createOk = check(createRes, {
    'create: status 200': (r) => r.status === 200,
    'create: has sessionId': (r) => {
      if (!r.body) return false;
      return !!(r.json() as { sessionId?: string }).sessionId;
    },
    'create: has mock response': (r) => {
      if (!r.body) return false;
      const resp = (r.json() as { response?: string }).response || '';
      return resp.includes('mock LLM response');
    },
  });

  recordTurnMetrics({
    ok: createOk,
    elapsedMs: createElapsed,
    status: createRes.status,
    tags: createTags,
  });

  if (!createOk) {
    const category = categorizeError(createRes.status);
    console.warn(
      `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} create FAILED [${category}] status=${createRes.status} content-type=${createRes.headers['Content-Type'] || 'unknown'} x-request-id=${createRes.headers['X-Request-Id'] || createRes.headers['x-request-id'] || 'none'}`,
    );
    // No sleep on failure — maintain attempted load pressure for accurate saturation measurement
    return;
  }

  // Periodic success logging (every 10th iteration)
  if (__ITER % 10 === 0) {
    console.log(
      `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} iter=${__ITER} create OK session=${(createRes.json() as { sessionId?: string }).sessionId} latency=${createElapsed}ms`,
    );
  }

  const sessionId = (createRes.json() as { sessionId: string }).sessionId;

  if (TURNS_PER_SESSION > 1) {
    sleep(INTER_MESSAGE_DELAY_SEC);
  }

  // ── Follow-up messages ─────────────────────────────────────────────────
  // Breaker is only checked before session creation (above), NOT between turns.
  // Once a session is created, we commit to the full turn sequence so that
  // follow-up metrics reflect the actual intended workload, not partial sessions.
  for (let turn = 2; turn <= TURNS_PER_SESSION; turn++) {
    const turnStep = getCurrentStepContext(data.startedAtMs);
    const turnStart = Date.now();
    const turnTags = { step: turnStep.label, phase: turnStep.phase, turn: 'followup' as const };
    const turnRes = http.post(
      `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
      JSON.stringify({
        projectId,
        sessionId,
        message: `Turn ${turn}/${TURNS_PER_SESSION} at ${Date.now()}`,
      }),
      {
        headers,
        timeout: '30s',
        tags: { name: 'POST /v1/chat/agent', step: turnStep.label, turn: 'followup' },
      },
    );
    const turnElapsed = Date.now() - turnStart;

    const turnOk = check(turnRes, {
      'turn: status 200': (r) => r.status === 200,
      'turn: has mock response': (r) => {
        if (!r.body) return false;
        const resp = (r.json() as { response?: string }).response || '';
        return resp.includes('mock LLM response');
      },
    });

    recordTurnMetrics({
      ok: turnOk,
      elapsedMs: turnElapsed,
      status: turnRes.status,
      tags: turnTags,
    });

    if (!turnOk) {
      const turnCategory = categorizeError(turnRes.status);
      console.warn(
        `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} turn ${turn} FAILED [${turnCategory}] status=${turnRes.status} session=${sessionId} x-request-id=${turnRes.headers['X-Request-Id'] || turnRes.headers['x-request-id'] || 'none'}`,
      );
      // No sleep on failure — return immediately to attempt next iteration
      return;
    }

    // Periodic success logging for followups (every 10th iteration, last turn)
    if (__ITER % 10 === 0 && turn === TURNS_PER_SESSION) {
      console.log(
        `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} iter=${__ITER} session=${sessionId} turns=${TURNS_PER_SESSION} lastTurnLatency=${turnElapsed}ms`,
      );
    }

    if (turn < TURNS_PER_SESSION) {
      sleep(INTER_MESSAGE_DELAY_SEC);
    }
  }
}

// ---------------------------------------------------------------------------
// Single-session mode — all VUs send messages on the shared session.
// Each iteration = 1 message turn. Pure message latency measurement.
// ---------------------------------------------------------------------------

function singleSessionTurn(data: SetupData): void {
  // Breaker check
  if (isBreakerOpen()) {
    const step = getCurrentStepContext(data.startedAtMs);
    const suppressTags = { step: step.label, phase: step.phase, turn: 'followup' as const };
    chatTurnAttempts.add(1, suppressTags);
    chatTurnSuppressed.add(1, suppressTags);
    chatTurnSuccessRate.add(0, suppressTags);
    sleep(BREAKER_BACKOFF_SEC);
    return;
  }

  const headers = getTenantHeaders(
    { token: data.baseToken, refreshToken: data.baseRefreshToken },
    data.tenantId,
    data.token,
  );
  const turnStep = getCurrentStepContext(data.startedAtMs);

  // Each VU gets its own pre-created session to avoid queue/rate limits
  const vuIndex = (__VU - 1) % data.vuSessions.length;
  const sessionId = data.vuSessions[vuIndex];

  const turnStart = Date.now();
  const turnRes = http.post(
    `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
    JSON.stringify({
      projectId: data.projectId,
      sessionId,
      message: `Turn at ${Date.now()} VU=${__VU}`,
    }),
    {
      headers,
      timeout: '30s',
      tags: { name: 'POST /v1/chat/agent', step: turnStep.label, turn: 'followup' },
    },
  );
  const turnElapsed = Date.now() - turnStart;

  const turnOk = check(turnRes, {
    'turn: status 200': (r) => r.status === 200,
    'turn: has mock response': (r) => {
      if (!r.body) return false;
      const resp = (r.json() as { response?: string }).response || '';
      return resp.includes('mock LLM response');
    },
  });

  const turnTags = { step: turnStep.label, phase: turnStep.phase, turn: 'followup' as const };
  recordTurnMetrics({ ok: turnOk, elapsedMs: turnElapsed, status: turnRes.status, tags: turnTags });

  if (!turnOk) {
    const category = categorizeError(turnRes.status);
    console.warn(
      `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} single-session FAILED [${category}] status=${turnRes.status} session=${sessionId} x-request-id=${turnRes.headers['X-Request-Id'] || turnRes.headers['x-request-id'] || 'none'}`,
    );
    // No sleep on failure — iterate immediately
    return;
  }

  // Periodic success logging (every 10th iteration)
  if (__ITER % 10 === 0) {
    console.log(
      `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} iter=${__ITER} single-session OK session=${sessionId} latency=${turnElapsed}ms`,
    );
  }

  sleep(INTER_MESSAGE_DELAY_SEC);
}

// ---------------------------------------------------------------------------
// Default — quick smoke with `k6 run --vus 1 --iterations 1`
// ---------------------------------------------------------------------------

export default function (data: SetupData): void {
  multiTurnChat(data);
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function deleteResource(url: string, headers: Record<string, string>, label: string): void {
  const res = http.del(url, null, { headers, timeout: '30s' });
  if (res.status !== 200 && res.status !== 204) {
    console.warn(
      `[teardown] ${label}: ${res.status} ${((res.body as string) || '').substring(0, 200)}`,
    );
  }
}

export function teardown(data: SetupData): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
    Origin: config.studioUrl,
    'X-Tenant-Id': data.tenantId,
    'X-Load-Test': config.loadTestKey,
  };

  const totalElapsedSec = Math.floor((Date.now() - data.startedAtMs) / 1000);
  const totalElapsedMin = (totalElapsedSec / 60).toFixed(1);
  console.log(`\n========================================`);
  console.log(`  Multi-Turn Chat Saturation Complete: ${data.runId}`);
  console.log(`  Total elapsed: ${totalElapsedSec}s (${totalElapsedMin}m)`);
  console.log(`  Project: ${data.projectId} | Agent: ${data.agentName}`);
  console.log(`  Steps tested: ${VU_STEPS.join(' → ')} VUs`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  To find the saturation tip:`);
  console.log(`  1. Open the k6 Cloud run`);
  console.log(`  2. Filter samples where phase=hold, then group by step`);
  console.log(`  3. rate(chat_turn_success_total) = useful msg/s`);
  console.log(`  4. rate(chat_turn_attempts_total) = attempted load`);
  console.log(`  5. p95(chat_turn_latency_ms{turn=followup}) = success-only latency (the knee)`);
  console.log(`  6. p50(chat_turn_error_latency_ms) = are errors fast-fail or timeout?`);
  console.log(`  7. rate(chat_turn_failure_total) by error_category = root cause`);
  console.log(`  8. chat_turn_conn_error_total = connection-level failures`);
  console.log(`  9. chat_turn_suppressed_total = demand suppressed by breaker (not sent)`);
  console.log(`  ──────────────────────────────────────`);
  console.log(
    `  Breaker: ${(BREAKER_ERROR_THRESHOLD * 100).toFixed(0)}% error rate over ${BREAKER_WINDOW_SIZE} requests triggers ${BREAKER_BACKOFF_SEC}s back-off`,
  );
  console.log(`========================================\n`);

  // Keep stable resources (project, agent, model, credential) for future runs
  console.log(`[teardown] Keeping stable project for future runs`);
}
