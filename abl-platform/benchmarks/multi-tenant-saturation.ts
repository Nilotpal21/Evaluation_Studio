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
 *   chat_turn_latency_ms                — request latency, tagged by turn=create|followup
 *   chat_turn_success_rate              — request success rate, tagged by turn=create|followup
 *   chat_turn_attempts_total            — total request attempts
 *   chat_turn_success_total             — successful requests
 *   chat_turn_failure_total             — failed requests
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
 *   -e INTER_MESSAGE_DELAY=1 Pause between messages in seconds (default: 1)
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
const MAX_HTTP_FAILURE_RATE = parseFloat(__ENV.MAX_HTTP_FAILURE_RATE || '0.02');
const MAX_TURN_P95_MS = parseInt(__ENV.MAX_TURN_P95_MS || '8000', 10);
const MAX_TURN_P99_MS = parseInt(__ENV.MAX_TURN_P99_MS || '12000', 10);

// ---------------------------------------------------------------------------
// Multi-Tenant Configuration
//
// Spread load across multiple ENTERPRISE tenants to bypass per-tenant rate limits.
// Each tenant has 5000 req/min → N tenants = N × 5000 req/min combined capacity.
//
// Set MULTI_TENANT=true and TENANT_IDS=id1,id2,id3 to enable.
// The dev-login user (DEV_LOGIN_EMAIL) must be OWNER of all target tenants.
// ---------------------------------------------------------------------------

const MULTI_TENANT = (__ENV.MULTI_TENANT || '').toLowerCase() === 'true';
const TENANT_IDS = (__ENV.TENANT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

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
// ---------------------------------------------------------------------------

const chatTurnLatency = new Trend('chat_turn_latency_ms', true);
const chatTurnSuccessRate = new Rate('chat_turn_success_rate');
const chatTurnAttempts = new Counter('chat_turn_attempts_total');
const chatTurnSuccesses = new Counter('chat_turn_success_total');
const chatTurnFailures = new Counter('chat_turn_failure_total');

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
    'chat_turn_latency_ms{phase:hold,turn:create}': [
      `p(95)<${MAX_TURN_P95_MS}`,
      `p(99)<${MAX_TURN_P99_MS}`,
    ],
    'chat_turn_latency_ms{phase:hold,turn:followup}': [
      `p(95)<${MAX_TURN_P95_MS}`,
      `p(99)<${MAX_TURN_P99_MS}`,
    ],
    'chat_turn_success_rate{phase:hold,turn:create}': [`rate>${MIN_TURN_SUCCESS_RATE}`],
    'chat_turn_success_rate{phase:hold,turn:followup}': [`rate>${MIN_TURN_SUCCESS_RATE}`],
    'http_req_failed{phase:hold,turn:create}': [`rate<${MAX_HTTP_FAILURE_RATE}`],
    'http_req_failed{phase:hold,turn:followup}': [`rate<${MAX_HTTP_FAILURE_RATE}`],
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

/** Per-tenant setup data for multi-tenant mode */
interface TenantSetup {
  tenantId: string;
  token: string;
  projectId: string;
  agentName: string;
  tenantModelId: string;
  credentialId: string;
}

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
  /** Multi-tenant: per-tenant setup data. VUs round-robin across tenants. */
  tenants: TenantSetup[];
  /** Whether multi-tenant mode is active */
  multiTenant: boolean;
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
// ---------------------------------------------------------------------------
// Tenant Bootstrap Helper
//
// Creates project + agent + mock model + credentials for a single tenant.
// Used by both single-tenant and multi-tenant setup paths.
// ---------------------------------------------------------------------------

function bootstrapTenant(
  tenantId: string,
  headers: Record<string, string>,
  ts: string,
  runId: string,
  tenantLabel: string,
): { projectId: string; agentName: string; tenantModelId: string; credentialId: string } {
  const runtimeHeaders = { ...headers, 'X-Tenant-Id': tenantId };

  // --- Get or Create project (stable name per tenant, reused across runs) ---
  const projectSlug = `bench-sat-${tenantLabel}`;
  let projectId = '';

  // Try to find existing project by listing and matching slug
  const listProjectsRes = http.get(`${config.studioUrl}${studioApiPath('/projects')}`, {
    headers,
    responseCallback: setupResponseCallback,
    tags: { name: `setup: list projects (${tenantLabel})` },
  });

  if (listProjectsRes.status === 200) {
    const body = listProjectsRes.json() as {
      projects?: Array<{ id: string; _id: string; slug?: string; name?: string }>;
    };
    const allProjects = body.projects || [];
    console.log(
      `[setup:${tenantLabel}] Listed ${allProjects.length} projects: ${allProjects.map((p) => p.slug || p.name || p.id || p._id).join(', ')}`,
    );
    const existing = allProjects.find((p) => p.slug === projectSlug || p.name === projectSlug);
    if (existing) {
      projectId = existing.id || existing._id;
      console.log(`[setup:${tenantLabel}] Reusing project: ${projectId} (${projectSlug})`);
    }
  } else {
    console.warn(
      `[setup:${tenantLabel}] List projects failed: ${listProjectsRes.status} ${((listProjectsRes.body as string) || '').substring(0, 300)}`,
    );
  }

  if (!projectId) {
    const projectRes = http.post(
      `${config.studioUrl}${studioApiPath('/projects')}`,
      JSON.stringify({
        name: projectSlug,
        slug: projectSlug,
        description: `Load test saturation project (${tenantLabel})`,
      }),
      {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: create project (${tenantLabel})` },
      },
    );

    if (projectRes.status === 201) {
      const projectBody = projectRes.json() as { project: { id: string } };
      projectId = projectBody.project.id;
      console.log(`[setup:${tenantLabel}] Created project: ${projectId} (${projectSlug})`);
    } else if (projectRes.status === 409) {
      // Slug conflict — project exists but wasn't in our listing (different owner).
      console.warn(`[setup:${tenantLabel}] Project slug conflict, searching all projects...`);
      const retryListRes = http.get(`${config.studioUrl}${studioApiPath('/projects')}`, {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: retry list projects (${tenantLabel})` },
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
          console.log(`[setup:${tenantLabel}] Found existing project via retry: ${projectId}`);
        }
      }
      if (!projectId) {
        const fallbackSlug = `bench-sat-${tenantLabel}-${Date.now()}`;
        console.warn(`[setup:${tenantLabel}] Using fallback slug: ${fallbackSlug}`);
        const fallbackRes = http.post(
          `${config.studioUrl}${studioApiPath('/projects')}`,
          JSON.stringify({
            name: fallbackSlug,
            slug: fallbackSlug,
            description: `Load test saturation project (${tenantLabel}, fallback)`,
          }),
          {
            headers,
            responseCallback: setupResponseCallback,
            tags: { name: `setup: create project fallback (${tenantLabel})` },
          },
        );
        if (fallbackRes.status === 201) {
          const fallbackBody = fallbackRes.json() as { project: { id: string } };
          projectId = fallbackBody.project.id;
          console.log(`[setup:${tenantLabel}] Created fallback project: ${projectId}`);
        } else {
          throw new Error(
            `Project creation failed for ${tenantLabel}: ${fallbackRes.status} ${fallbackRes.body}`,
          );
        }
      }
    } else {
      throw new Error(
        `Project creation failed for ${tenantLabel}: ${projectRes.status} ${projectRes.body}`,
      );
    }
  }

  // --- Get or Create agent (stable name per tenant) ---
  const agentName = `bench_sat_agent`;
  let agentExists = false;

  const listAgentsRes = http.get(
    `${config.studioUrl}${studioApiPath(`/projects/${projectId}/agents`)}`,
    {
      headers,
      responseCallback: setupResponseCallback,
      tags: { name: `setup: list agents (${tenantLabel})` },
    },
  );

  if (listAgentsRes.status === 200) {
    const agentsBody = listAgentsRes.json() as { agents?: Array<{ name: string }> };
    const allAgents = agentsBody.agents || [];
    console.log(
      `[setup:${tenantLabel}] Listed ${allAgents.length} agents: ${allAgents.map((a) => a.name).join(', ')}`,
    );
    agentExists = allAgents.some((a) => a.name === agentName);
  } else {
    console.warn(
      `[setup:${tenantLabel}] List agents failed: ${listAgentsRes.status} ${((listAgentsRes.body as string) || '').substring(0, 300)}`,
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
    console.log(`[setup:${tenantLabel}] Reusing agent: ${agentName}`);
  } else {
    const agentRes = http.post(
      `${config.studioUrl}${studioApiPath(`/projects/${projectId}/agents`)}`,
      JSON.stringify({
        name: agentName,
        agentPath: `${projectId}/default/${agentName}`,
        description: `Load test saturation agent (${tenantLabel})`,
        instructions: 'Respond concisely to all questions.',
        model: 'mock-model',
        dslContent,
      }),
      {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: create agent (${tenantLabel})` },
      },
    );

    check(agentRes, {
      [`agent created (${tenantLabel})`]: (r) => r.status === 200 || r.status === 201,
    });
    if (agentRes.status !== 200 && agentRes.status !== 201) {
      console.error(
        `[setup:${tenantLabel}] Agent creation failed: ${agentRes.status} ${((agentRes.body as string) || '').substring(0, 500)}`,
      );
      throw new Error(`Agent creation failed for ${tenantLabel}: ${agentRes.status}`);
    }
    console.log(`[setup:${tenantLabel}] Created agent: ${agentName}`);

    // Save DSL
    const dslRes = http.put(
      `${config.studioUrl}${studioApiPath(`/projects/${projectId}/agents/${encodeURIComponent(agentName)}/dsl`)}`,
      JSON.stringify({ dslContent }),
      {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: save DSL (${tenantLabel})` },
      },
    );
    console.log(`[setup:${tenantLabel}] Save DSL: ${dslRes.status}`);
  }

  // --- Mock TenantModel ---
  let tenantModelId = '';
  let credentialId = '';
  const listModelsRes = http.get(`${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models`)}`, {
    headers: runtimeHeaders,
    responseCallback: setupResponseCallback,
    tags: { name: `setup: list models (${tenantLabel})` },
  });

  if (listModelsRes.status === 200) {
    const modelsBody = listModelsRes.json() as {
      models?: Array<{ id: string; _id: string; modelId: string }>;
    };
    const allModels = modelsBody.models || [];
    console.log(
      `[setup:${tenantLabel}] Listed ${allModels.length} models: ${allModels.map((m) => m.modelId || m.id || m._id).join(', ')}`,
    );
    const existing = allModels.find((m) => m.modelId === 'mock-model');
    if (existing) {
      tenantModelId = existing.id || existing._id;
      console.log(`[setup:${tenantLabel}] Reusing mock model: ${tenantModelId}`);
    }
  } else {
    console.warn(
      `[setup:${tenantLabel}] List models failed: ${listModelsRes.status} ${((listModelsRes.body as string) || '').substring(0, 300)}`,
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
        tags: { name: `setup: create model (${tenantLabel})` },
      },
    );

    if (modelRes.status === 201) {
      const modelBody = modelRes.json() as { model?: { id: string; _id: string } };
      tenantModelId = modelBody.model?.id || modelBody.model?._id || '';
      console.log(`[setup:${tenantLabel}] Mock model created: ${tenantModelId}`);
    } else {
      console.warn(
        `[setup:${tenantLabel}] Mock model creation: ${modelRes.status} ${modelRes.body}`,
      );
    }
  }

  if (tenantModelId) {
    // -----------------------------------------------------------------
    // Ensure TenantModel has a valid primary connection with a live
    // credential. Previous teardowns may have deleted the credential
    // while leaving the TenantModel and a dangling connection behind.
    // -----------------------------------------------------------------
    const credName = `bench-mock-cred`;

    // 1. Check existing connections — is there a valid primary?
    let needsNewConnection = true;
    const connListRes = http.get(
      `${config.runtimeUrl}${apiPath(`/tenants/${tenantId}/models/${tenantModelId}/connections`)}`,
      {
        headers: runtimeHeaders,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: list connections (${tenantLabel})` },
      },
    );
    if (connListRes.status === 200) {
      const connBody = connListRes.json() as {
        connections?: Array<{ id: string; credentialId: string; isPrimary: boolean }>;
      };
      const allConns = connBody.connections || [];
      console.log(
        `[setup:${tenantLabel}] Listed ${allConns.length} connections: ${allConns.map((c) => `${c.id}(primary=${c.isPrimary})`).join(', ')}`,
      );
      const primary = allConns.find((c) => c.isPrimary);
      if (primary) {
        // Verify the credential still exists
        const credCheckRes = http.get(
          `${config.studioUrl}/api/credentials/${primary.credentialId}`,
          {
            headers,
            responseCallback: setupResponseCallback,
            tags: { name: `setup: verify credential (${tenantLabel})` },
          },
        );
        if (credCheckRes.status === 200) {
          credentialId = primary.credentialId;
          needsNewConnection = false;
          console.log(
            `[setup:${tenantLabel}] Primary connection valid, credential: ${credentialId}`,
          );
        } else {
          console.warn(
            `[setup:${tenantLabel}] Primary connection credential deleted, will recreate`,
          );
        }
      }
    }

    // 2. Get or create credential
    if (!credentialId) {
      const listCredRes = http.get(`${config.studioUrl}/api/credentials`, {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: list credentials (${tenantLabel})` },
      });
      if (listCredRes.status === 200) {
        const creds = listCredRes.json() as Array<{ id: string; name: string }>;
        const credsArr = Array.isArray(creds) ? creds : [];
        console.log(
          `[setup:${tenantLabel}] Listed ${credsArr.length} credentials: ${credsArr.map((c) => c.name).join(', ')}`,
        );
        const found = credsArr.find((c) => c.name === credName);
        if (found) {
          credentialId = found.id;
          console.log(`[setup:${tenantLabel}] Reusing credential: ${credentialId}`);
        }
      } else {
        console.warn(
          `[setup:${tenantLabel}] List credentials failed: ${listCredRes.status} ${((listCredRes.body as string) || '').substring(0, 300)}`,
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
          tags: { name: `setup: create credential (${tenantLabel})` },
        },
      );

      if (credRes.status === 201) {
        credentialId = (credRes.json() as { id?: string }).id || '';
        console.log(`[setup:${tenantLabel}] Created credential: ${credentialId}`);
      } else if (credRes.status === 409) {
        // Name conflict — credential exists but wasn't in our listing (different owner).
        // Retry listing to find it.
        console.warn(`[setup:${tenantLabel}] Credential name conflict (409), retrying list...`);
        const retryCredRes = http.get(`${config.studioUrl}/api/credentials`, {
          headers,
          responseCallback: setupResponseCallback,
          tags: { name: `setup: retry list credentials (${tenantLabel})` },
        });
        if (retryCredRes.status === 200) {
          const retryCreds = retryCredRes.json() as Array<{ id: string; name: string }>;
          const retryArr = Array.isArray(retryCreds) ? retryCreds : [];
          const retryFound = retryArr.find((c) => c.name === credName);
          if (retryFound) {
            credentialId = retryFound.id;
            console.log(`[setup:${tenantLabel}] Found credential via retry: ${credentialId}`);
          }
        }
        // Still not found — create with unique name
        if (!credentialId) {
          const uniqueCredName = `${credName}-${Date.now()}`;
          console.log(
            `[setup:${tenantLabel}] Creating credential with unique name: ${uniqueCredName}`,
          );
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
              tags: { name: `setup: create credential unique (${tenantLabel})` },
            },
          );
          if (uniqueCredRes.status === 201) {
            credentialId = (uniqueCredRes.json() as { id?: string }).id || '';
            console.log(`[setup:${tenantLabel}] Created credential (unique): ${credentialId}`);
          } else {
            console.error(
              `[setup:${tenantLabel}] Unique credential creation also failed: ${uniqueCredRes.status} ${((uniqueCredRes.body as string) || '').substring(0, 300)}`,
            );
          }
        }
      } else {
        console.warn(
          `[setup:${tenantLabel}] Credential creation failed: ${credRes.status} ${((credRes.body as string) || '').substring(0, 300)}`,
        );
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
          tags: { name: `setup: link credential (${tenantLabel})` },
        },
      );
      if (linkRes.status === 201 || linkRes.status === 200) {
        console.log(`[setup:${tenantLabel}] Credential linked as primary connection`);
      } else {
        console.warn(`[setup:${tenantLabel}] Connection link: ${linkRes.status} ${linkRes.body}`);
      }
    }

    // Agent model config
    const agentModelConfigRes = http.put(
      `${config.runtimeUrl}${apiPath(`/projects/${projectId}/agents/${agentName}/model-config`)}`,
      JSON.stringify({ defaultModel: 'mock-model' }),
      {
        headers: runtimeHeaders,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: agent model config (${tenantLabel})` },
      },
    );
    console.log(
      `[setup:${tenantLabel}] Agent model config PUT: ${agentModelConfigRes.status} ${((agentModelConfigRes.body as string) || '').substring(0, 200)}`,
    );

    // Project ModelConfig (get-or-create)
    let projectModelExists = false;
    const listProjectModelsRes = http.get(
      `${config.studioUrl}${studioApiPath('/models')}?projectId=${projectId}`,
      {
        headers,
        responseCallback: setupResponseCallback,
        tags: { name: `setup: list project models (${tenantLabel})` },
      },
    );
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
        `[setup:${tenantLabel}] Listed ${models.length} project models: ${models.map((m) => m.modelId || m.name || '?').join(', ')}`,
      );
      projectModelExists = models.some(
        (m) => m.modelId === 'mock-model' || m.name === 'Mock LLM Bench',
      );
    } else {
      console.warn(
        `[setup:${tenantLabel}] List project models failed: ${listProjectModelsRes.status} ${((listProjectModelsRes.body as string) || '').substring(0, 300)}`,
      );
    }

    if (projectModelExists) {
      console.log(`[setup:${tenantLabel}] Reusing project ModelConfig`);
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
          tags: { name: `setup: project model config (${tenantLabel})` },
        },
      );
      if (modelConfigRes.status === 200 || modelConfigRes.status === 201) {
        console.log(`[setup:${tenantLabel}] Project ModelConfig created`);
      } else {
        console.log(
          `[setup:${tenantLabel}] Project ModelConfig: ${modelConfigRes.status} (may already exist)`,
        );
      }
    }
  }

  // Smoke check
  console.log(`[setup:${tenantLabel}] Smoke check...`);
  const smokeRes = http.post(
    `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
    JSON.stringify({ projectId, message: 'Smoke test.' }),
    {
      headers: runtimeHeaders,
      timeout: '30s',
      responseCallback: setupResponseCallback,
      tags: { name: `setup: smoke check (${tenantLabel})` },
    },
  );

  if (smokeRes.status === 200) {
    const smokeBody = smokeRes.json() as { response?: string; sessionId?: string };
    console.log(
      `[setup:${tenantLabel}] Smoke check passed — sessionId=${smokeBody.sessionId || 'none'}, response="${(smokeBody.response || '').substring(0, 100)}"`,
    );
  } else {
    console.warn(
      `[setup:${tenantLabel}] Smoke check FAILED: status=${smokeRes.status}, body=${((smokeRes.body as string) || '').substring(0, 500)}`,
    );
  }

  return { projectId, agentName, tenantModelId, credentialId };
}

// ---------------------------------------------------------------------------
// Multi-Tenant Auth Helper
//
// Switches to a target tenant via POST /api/auth/tenants/switch.
// Returns a new JWT scoped to that tenant.
// ---------------------------------------------------------------------------

function switchToTenant(baseToken: string, targetTenantId: string): string {
  const res = http.post(
    `${config.studioUrl}/api/auth/tenants/switch`,
    JSON.stringify({ tenantId: targetTenantId }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${baseToken}`,
      },
      responseCallback: setupResponseCallback,
      tags: { name: 'setup: switch tenant' },
    },
  );

  if (res.status !== 200) {
    throw new Error(`Tenant switch to ${targetTenantId} failed: ${res.status} ${res.body}`);
  }

  const data = res.json() as { accessToken: string };
  return data.accessToken;
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

// ---------------------------------------------------------------------------
// Super Admin Plan Upgrade Helper
//
// Logs in as super admin once, then upgrades each tenant to ENTERPRISE
// so per-tenant rate limits are lifted during load testing.
// ---------------------------------------------------------------------------

let cachedSuperAdminToken: string | null = null;

function getSuperAdminToken(): string | null {
  if (cachedSuperAdminToken !== null) {
    return cachedSuperAdminToken;
  }
  const superAdminEmail = __ENV.SUPER_ADMIN_EMAIL || 'superadmin@platform.internal';
  try {
    console.log(`[setup:superadmin] Logging in as super admin: ${superAdminEmail}`);
    const loginRes = http.post(
      `${config.studioUrl}/api/auth/dev-login`,
      JSON.stringify({ email: superAdminEmail }),
      {
        headers: { 'Content-Type': 'application/json' },
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: super admin login' },
      },
    );
    if (loginRes.status === 200) {
      const loginBody = loginRes.json() as { accessToken?: string; token?: string };
      cachedSuperAdminToken = loginBody.accessToken || loginBody.token || '';
      if (cachedSuperAdminToken) {
        console.log(`[setup:superadmin] Super admin login succeeded`);
      } else {
        console.warn(`[setup:superadmin] Super admin login: 200 but no token in response`);
        cachedSuperAdminToken = '';
      }
    } else {
      console.warn(
        `[setup:superadmin] Super admin login failed: ${loginRes.status} ${((loginRes.body as string) || '').substring(0, 300)}`,
      );
      cachedSuperAdminToken = '';
    }
  } catch (e) {
    console.warn(`[setup:superadmin] Super admin login error: ${e}`);
    cachedSuperAdminToken = '';
  }
  return cachedSuperAdminToken || null;
}

function upgradeTenantToEnterprise(tenantId: string, tenantLabel: string): void {
  try {
    const adminToken = getSuperAdminToken();
    if (!adminToken) {
      console.warn(
        `[setup:${tenantLabel}] Skipping ENTERPRISE upgrade — no super admin token available`,
      );
      return;
    }
    console.log(`[setup:${tenantLabel}] Upgrading tenant ${tenantId} to ENTERPRISE plan...`);
    const upgradeRes = http.patch(
      `${config.studioUrl}/api/platform/admin/tenants/${tenantId}/subscription`,
      JSON.stringify({ planTier: 'ENTERPRISE' }),
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        responseCallback: setupResponseCallback,
        tags: { name: `setup: upgrade tenant (${tenantLabel})` },
      },
    );
    if (upgradeRes.status === 200 || upgradeRes.status === 204) {
      console.log(
        `[setup:${tenantLabel}] Tenant ${tenantId} upgraded to ENTERPRISE (${upgradeRes.status})`,
      );
    } else {
      console.warn(
        `[setup:${tenantLabel}] ENTERPRISE upgrade failed: ${upgradeRes.status} ${((upgradeRes.body as string) || '').substring(0, 300)}`,
      );
    }
  } catch (e) {
    console.warn(`[setup:${tenantLabel}] ENTERPRISE upgrade error: ${e}`);
  }
}

export function setup(): SetupData {
  const now = Date.now();
  const ts = `${now}`;
  const runId = `chat-sat-${ts}`;
  const isMultiTenant = MULTI_TENANT && TENANT_IDS.length > 0;

  console.log(`\n========================================`);
  console.log(`  Stepped Saturation Test: ${runId}`);
  console.log(`  Steps: ${VU_STEPS.join(' → ')} VUs`);
  console.log(`  Hold: ${getHoldSummary()} | Turns: ${TURNS_PER_SESSION}/session`);
  if (isMultiTenant) {
    console.log(
      `  Multi-tenant: ${TENANT_IDS.length} tenants (${TENANT_IDS.length * 5000} req/min combined)`,
    );
  }
  console.log(`========================================\n`);

  let baseToken = getAuthToken();
  const baseRefreshToken = getRefreshToken();
  const tenantId = config.tenantId;

  console.log(`[setup] Authenticated. Base tenant: ${tenantId}`);

  // ── Multi-tenant setup ─────────────────────────────────────────────────
  const tenants: TenantSetup[] = [];

  if (isMultiTenant) {
    console.log(`[setup] Multi-tenant mode: bootstrapping ${TENANT_IDS.length} tenants...`);

    for (let i = 0; i < TENANT_IDS.length; i++) {
      const tid = TENANT_IDS[i];
      const label = `t${i + 1}`;
      console.log(`\n[setup] ── Tenant ${i + 1}/${TENANT_IDS.length}: ${tid} ──`);

      // Keep the base login fresh during long bootstraps, then switch once.
      baseToken = ensureFreshAuth({ token: baseToken, refreshToken: baseRefreshToken });
      const tenantToken = switchToTenant(baseToken, tid);
      const tenantHeaders = buildTenantHeaders(tenantToken, tid);

      const result = bootstrapTenant(tid, tenantHeaders, ts, runId, label);

      // Upgrade tenant to ENTERPRISE to lift rate limits for load testing
      upgradeTenantToEnterprise(tid, label);

      tenants.push({
        tenantId: tid,
        token: tenantToken,
        projectId: result.projectId,
        agentName: result.agentName,
        tenantModelId: result.tenantModelId,
        credentialId: result.credentialId,
      });
    }

    console.log(`\n[setup] All ${tenants.length} tenants bootstrapped.`);
    console.log(`  Combined rate limit: ${tenants.length * 5000} req/min`);
    for (const t of tenants) {
      console.log(`    ${t.tenantId} → project:${t.projectId}`);
    }
  }

  // ── Single-tenant setup ─────────────────────────────────────────────────
  // Always tenant-switch so the auth flow matches multi-tenant exactly.
  // VUs reuse this token until the base auth refreshes, then re-switch once.
  let singleTenantToken = baseToken;
  let projectId = '';
  let agentName = '';
  let tenantModelId = '';
  let credentialId = '';

  if (!isMultiTenant) {
    // Switch to the target tenant (same as multi-tenant does per-tenant).
    console.log(`[setup] Switching to tenant: ${tenantId}`);
    baseToken = ensureFreshAuth({ token: baseToken, refreshToken: baseRefreshToken });
    singleTenantToken = switchToTenant(baseToken, tenantId);
    console.log(`[setup] Switched to tenant: ${tenantId}`);

    const switchedHeaders = buildTenantHeaders(singleTenantToken, tenantId);

    const result = bootstrapTenant(tenantId, switchedHeaders, ts, runId, 'default');
    projectId = result.projectId;
    agentName = result.agentName;
    tenantModelId = result.tenantModelId;
    credentialId = result.credentialId;

    // Upgrade tenant to ENTERPRISE to lift rate limits for load testing
    upgradeTenantToEnterprise(tenantId, 'default');
  } else {
    // In multi-tenant mode, use first tenant's data as the "primary"
    projectId = tenants[0].projectId;
    agentName = tenants[0].agentName;
    tenantModelId = tenants[0].tenantModelId;
    credentialId = tenants[0].credentialId;
  }

  // Pre-create per-VU sessions (SINGLE_SESSION mode only, single-tenant)
  let sessionId = '';
  const vuSessions: string[] = [];
  if (SINGLE_SESSION && !isMultiTenant) {
    const sessionHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${singleTenantToken}`,
      Origin: config.studioUrl,
      'X-Tenant-Id': tenantId,
      'X-Load-Test': config.loadTestKey,
    };
    const smokeRes = http.post(
      `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
      JSON.stringify({ projectId, message: 'Smoke test.' }),
      {
        headers: sessionHeaders,
        timeout: '30s',
        responseCallback: setupResponseCallback,
        tags: { name: 'setup: smoke check' },
      },
    );
    if (smokeRes.status === 200) {
      sessionId = (smokeRes.json() as { sessionId?: string }).sessionId || '';
    }
    if (!sessionId) {
      throw new Error('SINGLE_SESSION mode: smoke check failed to create a session');
    }
    vuSessions.push(sessionId);
    const sessionsNeeded = MAX_VUS - 1;
    console.log(`[setup] Pre-creating ${sessionsNeeded} sessions for ${MAX_VUS} VUs...`);
    for (let i = 0; i < sessionsNeeded; i++) {
      const sRes = http.post(
        `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
        JSON.stringify({ projectId, message: `Session warmup ${i + 2}/${MAX_VUS}` }),
        {
          headers: sessionHeaders,
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

  const mode = isMultiTenant
    ? `MULTI_TENANT (${tenants.length} tenants, round-robin)`
    : SINGLE_SESSION
      ? `SINGLE_SESSION (${vuSessions.length} pre-created sessions, 1 per VU)`
      : 'multi-session';
  console.log(`\n[setup] Ready. Mode: ${mode}`);
  if (!isMultiTenant) {
    console.log(`  Project: ${projectId} | Agent: ${agentName}`);
  }
  console.log(`  Mock LLM: 1000-1500ms random delay`);
  console.log(`  Steps: ${VU_STEPS.join(' → ')} VUs (${getHoldSummary()})`);
  console.log(`  Metrics: chat_turn_latency_ms, chat_turn_success_total, chat_turn_failure_total`);
  console.log(
    `  Tip: compare rate(chat_turn_success_total), rate(chat_turn_attempts_total), and p95(chat_turn_latency_ms{turn=followup})\n`,
  );

  return {
    baseToken,
    baseRefreshToken,
    // For single-tenant: pass the tenant-switched token so VUs use the correct tenant.
    // VUs keep using it until the refreshed base auth needs a new tenant switch.
    token: isMultiTenant ? baseToken : singleTenantToken,
    projectId,
    agentName,
    tenantId,
    tenantModelId,
    credentialId,
    runId,
    startedAtMs: Date.now(),
    sessionId,
    vuSessions,
    tenants,
    multiTenant: isMultiTenant,
  };
}

// ---------------------------------------------------------------------------
// Scenario: Multi-Turn Chat — 100% of VUs
//
// Each iteration: create session → send TURNS_PER_SESSION messages.
// Use rate(chat_turn_success_total) for useful throughput and
// rate(chat_turn_attempts_total) for attempted load.
// ---------------------------------------------------------------------------

/**
 * Resolve per-VU tenant context for multi-tenant mode.
 * Round-robins VUs across tenants so load is spread evenly.
 */
function getVuTenant(data: SetupData): {
  headers: Record<string, string>;
  projectId: string;
  tenantId: string;
} {
  const baseAuth = { token: data.baseToken, refreshToken: data.baseRefreshToken };
  if (!data.multiTenant || data.tenants.length === 0) {
    const headers = getTenantHeaders(baseAuth, data.tenantId, data.token);
    return {
      headers,
      projectId: data.projectId,
      tenantId: data.tenantId,
    };
  }

  const tenantIndex = (__VU - 1) % data.tenants.length;
  const tenant = data.tenants[tenantIndex];

  const headers = getTenantHeaders(baseAuth, tenant.tenantId, tenant.token);

  return {
    headers,
    projectId: tenant.projectId,
    tenantId: tenant.tenantId,
  };
}

export function multiTurnChat(data: SetupData): void {
  if (SINGLE_SESSION) {
    return singleSessionTurn(data);
  }

  const vu = getVuTenant(data);
  const headers = vu.headers;
  const projectId = vu.projectId;

  // ── First message — creates session ────────────────────────────────────
  const createStep = getCurrentStepContext(data.startedAtMs);
  const createTags = { step: createStep.label, phase: createStep.phase, turn: 'create' as const };
  const createStart = Date.now();
  const createRes = http.post(
    `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
    JSON.stringify({
      projectId,
      message: `message 1`,
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

  chatTurnLatency.add(createElapsed, createTags);
  chatTurnSuccessRate.add(createOk ? 1 : 0, createTags);
  chatTurnAttempts.add(1, createTags);
  if (createOk) {
    chatTurnSuccesses.add(1, createTags);
  } else {
    chatTurnFailures.add(1, {
      ...createTags,
      failure_reason: createRes.status !== 200 ? 'http_status' : 'invalid_response',
    });
  }

  if (!createOk) {
    if (createRes.status !== 200) {
      const statusCategory =
        createRes.status === 429
          ? 'RATE_LIMITED'
          : createRes.status === 401 || createRes.status === 403
            ? 'AUTH_ERROR'
            : createRes.status >= 500
              ? 'SERVER_ERROR'
              : 'CLIENT_ERROR';
      console.warn(
        `[${formatStepProgress(data.startedAtMs)}] create ${statusCategory} ${createRes.status} (VU=${__VU}): ${((createRes.body as string) || '').substring(0, 500)}`,
      );
    } else {
      // Status 200 but mock response check failed — log response + trace events
      const parsed = createRes.json() as {
        response?: string;
        traceEvents?: Array<{ type: string; data?: Record<string, unknown> }>;
      };
      const resp = parsed.response || '';
      const errorEvents = (parsed.traceEvents || [])
        .filter((e) => e.type === 'agent_error_handled' || e.type === 'error')
        .map((e) => JSON.stringify(e.data || {}))
        .join(' | ');
      console.warn(
        `[${formatStepProgress(data.startedAtMs)}] create: no mock. resp="${resp.substring(0, 100)}" errors=[${errorEvents.substring(0, 400)}]`,
      );
    }
    sleep(INTER_MESSAGE_DELAY_SEC);
    return;
  }

  const sessionId = (createRes.json() as { sessionId: string }).sessionId;

  if (__ITER % 10 === 0) {
    console.log(
      `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} iter=${__ITER} session=${sessionId} create_latency=${createElapsed}ms turns=${TURNS_PER_SESSION}`,
    );
  }

  if (TURNS_PER_SESSION > 1) {
    sleep(INTER_MESSAGE_DELAY_SEC);
  }

  // ── Follow-up messages ─────────────────────────────────────────────────
  for (let turn = 2; turn <= TURNS_PER_SESSION; turn++) {
    const turnStep = getCurrentStepContext(data.startedAtMs);
    const turnStart = Date.now();
    const turnTags = { step: turnStep.label, phase: turnStep.phase, turn: 'followup' as const };
    const turnRes = http.post(
      `${config.runtimeUrl}${apiPath('/v1/chat/agent')}`,
      JSON.stringify({
        projectId,
        sessionId,
        message: `message ${turn}`,
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

    chatTurnLatency.add(turnElapsed, turnTags);
    chatTurnSuccessRate.add(turnOk ? 1 : 0, turnTags);
    chatTurnAttempts.add(1, turnTags);
    if (turnOk) {
      chatTurnSuccesses.add(1, turnTags);
    } else {
      chatTurnFailures.add(1, {
        ...turnTags,
        failure_reason: turnRes.status !== 200 ? 'http_status' : 'invalid_response',
      });
    }

    if (!turnOk) {
      if (turnRes.status !== 200) {
        const statusCategory =
          turnRes.status === 429
            ? 'RATE_LIMITED'
            : turnRes.status === 401 || turnRes.status === 403
              ? 'AUTH_ERROR'
              : turnRes.status >= 500
                ? 'SERVER_ERROR'
                : 'CLIENT_ERROR';
        console.warn(
          `[${formatStepProgress(data.startedAtMs)}] turn ${turn} ${statusCategory} ${turnRes.status} (VU=${__VU}, session=${sessionId}): ${((turnRes.body as string) || '').substring(0, 500)}`,
        );
      } else {
        const parsed = turnRes.json() as { response?: string };
        console.warn(
          `[${formatStepProgress(data.startedAtMs)}] turn ${turn} no mock response (VU=${__VU}, session=${sessionId}): resp="${(parsed.response || '').substring(0, 200)}"`,
        );
      }
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
  const vu = getVuTenant(data);
  const headers = vu.headers;
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
  chatTurnLatency.add(turnElapsed, turnTags);
  chatTurnSuccessRate.add(turnOk ? 1 : 0, turnTags);
  chatTurnAttempts.add(1, turnTags);
  if (turnOk) {
    chatTurnSuccesses.add(1, turnTags);
  } else {
    chatTurnFailures.add(1, {
      ...turnTags,
      failure_reason: turnRes.status !== 200 ? 'http_status' : 'invalid_response',
    });
  }

  if (!turnOk) {
    if (turnRes.status !== 200) {
      const statusCategory =
        turnRes.status === 429
          ? 'RATE_LIMITED'
          : turnRes.status === 401 || turnRes.status === 403
            ? 'AUTH_ERROR'
            : turnRes.status >= 500
              ? 'SERVER_ERROR'
              : 'CLIENT_ERROR';
      console.warn(
        `[${formatStepProgress(data.startedAtMs)}] single-session ${statusCategory} ${turnRes.status} (VU=${__VU}, session=${sessionId}): ${((turnRes.body as string) || '').substring(0, 500)}`,
      );
    } else {
      const parsed = turnRes.json() as { response?: string };
      console.warn(
        `[${formatStepProgress(data.startedAtMs)}] single-session no mock response (VU=${__VU}, session=${sessionId}): resp="${(parsed.response || '').substring(0, 200)}"`,
      );
    }
  } else if (__ITER % 10 === 0) {
    console.log(
      `[${formatStepProgress(data.startedAtMs)}] VU=${__VU} iter=${__ITER} session=${sessionId} latency=${turnElapsed}ms (single-session)`,
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

export function teardown(data: SetupData): void {
  const totalElapsedSec = Math.round((Date.now() - data.startedAtMs) / 1000);
  const elapsedMin = Math.floor(totalElapsedSec / 60);
  const elapsedSec = totalElapsedSec % 60;
  console.log(`\n========================================`);
  console.log(`  Multi-Turn Chat Saturation Complete: ${data.runId}`);
  console.log(`  Total elapsed: ${elapsedMin}m ${elapsedSec}s`);
  if (data.multiTenant) {
    console.log(`  Tenants: ${data.tenants.length} ENTERPRISE tenants`);
  } else {
    console.log(`  Project: ${data.projectId} | Agent: ${data.agentName}`);
  }
  console.log(`  Steps tested: ${VU_STEPS.join(' → ')} VUs`);
  console.log(`  ──────────────────────────────────────`);
  console.log(`  To find the saturation tip:`);
  console.log(`  1. Open the k6 Cloud run`);
  console.log(`  2. Filter samples where phase=hold, then group by step`);
  console.log(`  3. Use rate(chat_turn_success_total) for useful msg/s`);
  console.log(`  4. Use rate(chat_turn_attempts_total) for attempted load`);
  console.log(`  5. Watch p95(chat_turn_latency_ms{turn=followup}) for the knee`);
  console.log(`  6. Use rate(chat_turn_failure_total) to quantify wasted load`);
  console.log(`========================================\n`);

  console.log(`[teardown] Keeping benchmark entities for future runs`);
}
