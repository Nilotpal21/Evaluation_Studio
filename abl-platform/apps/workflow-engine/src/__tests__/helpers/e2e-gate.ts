/**
 * E2E gate helper — probes externally-provisioned infrastructure + feature
 * flags and reports whether an E2E scenario should run or be skipped.
 *
 * Design (per ABLP-2 owner decision):
 *
 *  - ClickHouse, Kafka, Redis, and the services themselves are PROVISIONED
 *    BY THE OPERATOR (docker-compose or live staging). E2E tests probe the
 *    already-running stack via HTTP + TCP. Tests do NOT spin up containers.
 *
 *  - Each scenario declares its required feature-flag set + its required
 *    infrastructure surfaces. If any flag is off or any probe fails, the
 *    scenario is SKIPPED (never fails) with a clear log line identifying
 *    the specific gate that was not met.
 *
 *  - Auth is bring-your-own: the operator sets `E2E_AUTH_TOKEN` +
 *    `E2E_TENANT_ID` + `E2E_PROJECT_ID` + `E2E_WORKFLOW_ID`. The tests
 *    forward that token as `Authorization: Bearer <token>`. This mirrors
 *    the operator-driven nature of the suite — no JWT minting inside
 *    tests, no shared-key secrets checked in.
 *
 * Operators enable a scenario by:
 *   1. Starting the stack (`docker compose up`, `pnpm dev` for both apps).
 *   2. Flipping the required WORKFLOW_* flags to `true` on the services.
 *   3. Exporting the E2E_* auth/tenant/project/workflow variables.
 *   4. Running `pnpm --filter=@agent-platform/workflow-engine test:e2e`.
 *
 * On CI without the above, every E2E scenario skips cleanly — the E2E lane
 * reports success with zero executed tests, and the lane is non-blocking
 * for PR merges until the dockerized-CH harness PR (GAP-008) lands.
 */

import { createConnection, type Socket } from 'node:net';

const WORKFLOW_ENGINE_URL_ENV = 'E2E_WORKFLOW_ENGINE_URL';
const RUNTIME_URL_ENV = 'E2E_RUNTIME_URL';
const CH_URL_ENV = 'CLICKHOUSE_URL';
const CH_USER_ENV = 'CLICKHOUSE_USERNAME';
const CH_PASSWORD_ENV = 'CLICKHOUSE_PASSWORD';
const KAFKA_BROKERS_ENV = 'EVENT_KAFKA_BROKERS';
const AUTH_TOKEN_ENV = 'E2E_AUTH_TOKEN';
const TENANT_ENV = 'E2E_TENANT_ID';
const PROJECT_ENV = 'E2E_PROJECT_ID';
const USER_ENV = 'E2E_USER_ID';
const WORKFLOW_ENV = 'E2E_WORKFLOW_ID';

const DEFAULTS = {
  workflowEngineUrl: 'http://127.0.0.1:9080',
  runtimeUrl: 'http://127.0.0.1:3112',
  clickhouseUrl: 'http://127.0.0.1:8123',
  kafkaBrokers: ['127.0.0.1:9092'],
  tenantId: 't1',
  projectId: 'p1',
  userId: 'u1',
};

const PROBE_TIMEOUT_MS = 3_000;

/** Which services a scenario requires to be reachable before running. */
export interface E2EServiceRequirements {
  workflowEngine?: boolean;
  runtime?: boolean;
  clickhouse?: boolean;
  kafka?: boolean;
}

/** Which feature flags must be `true` on the running services. */
export interface E2EGateRequirement {
  flags: readonly string[];
  services: E2EServiceRequirements;
}

export interface E2EAuthContext {
  token: string;
  tenantId: string;
  projectId: string;
  userId: string;
  workflowId?: string;
}

export interface E2EGateResult {
  shouldRun: boolean;
  /** Non-empty when `shouldRun === false` — formatted for a vitest skip label. */
  skipReason?: string;
  urls: {
    workflowEngine: string;
    runtime: string;
    clickhouse: string;
    kafkaBrokers: string[];
  };
  /** `undefined` when the scenario is skipped or the operator didn't export auth. */
  auth?: E2EAuthContext;
}

function envOrDefault(name: string, fallback: string): string {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

function parseKafkaBrokers(raw: string | undefined): string[] {
  if (!raw) return DEFAULTS.kafkaBrokers;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function probeHttp(url: string, path: string): Promise<{ ok: boolean; reason: string }> {
  const target = `${url.replace(/\/$/, '')}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: ctrl.signal });
    if (res.status >= 200 && res.status < 500) {
      return { ok: true, reason: `${target} → ${res.status}` };
    }
    return { ok: false, reason: `${target} → HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      reason: `${target} unreachable (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeClickhouse(url: string): Promise<{ ok: boolean; reason: string }> {
  const target = `${url.replace(/\/$/, '')}/?query=SELECT%201`;
  // Basic auth: CH HTTP interface accepts `Authorization: Basic <b64(user:pass)>`
  // OR `?user=...&password=...` query params. We use the header form since it
  // does not leak creds into the URL (telemetry / proxy logs).
  const user = process.env[CH_USER_ENV];
  const password = process.env[CH_PASSWORD_ENV];
  const headers: Record<string, string> = {};
  if (user) {
    const token = Buffer.from(`${user}:${password ?? ''}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: ctrl.signal, headers });
    if (!res.ok) {
      const hint =
        res.status === 403 && !user
          ? ' (set CLICKHOUSE_USERNAME + CLICKHOUSE_PASSWORD)'
          : res.status === 401
            ? ' (CLICKHOUSE_USERNAME/PASSWORD rejected)'
            : '';
      return { ok: false, reason: `CH ${target} → HTTP ${res.status}${hint}` };
    }
    const body = (await res.text()).trim();
    if (body !== '1') {
      return { ok: false, reason: `CH SELECT 1 returned ${JSON.stringify(body)}` };
    }
    return { ok: true, reason: `CH ${url} reachable` };
  } catch (err) {
    return {
      ok: false,
      reason: `CH ${url} unreachable (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function probeTcp(hostPort: string): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const [host, portRaw] = hostPort.split(':');
    const port = Number(portRaw);
    if (!host || !Number.isFinite(port)) {
      resolve({ ok: false, reason: `Kafka broker '${hostPort}' malformed` });
      return;
    }
    let settled = false;
    let socket: Socket | undefined;
    const finish = (ok: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // ignore — already closed
      }
      resolve({ ok, reason });
    };
    const timer = setTimeout(
      () => finish(false, `Kafka ${hostPort} TCP connect timeout`),
      PROBE_TIMEOUT_MS,
    );
    try {
      socket = createConnection({ host, port });
      socket.once('connect', () => {
        clearTimeout(timer);
        finish(true, `Kafka ${hostPort} TCP reachable`);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        finish(false, `Kafka ${hostPort} TCP error: ${err.message}`);
      });
    } catch (err) {
      clearTimeout(timer);
      finish(
        false,
        `Kafka ${hostPort} TCP exception: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Evaluate the gate for a scenario. Runs probes in parallel so a full gate
 * evaluation costs ~PROBE_TIMEOUT_MS in the worst case.
 */
export async function evaluateE2EGate(req: E2EGateRequirement): Promise<E2EGateResult> {
  const urls = {
    workflowEngine: envOrDefault(WORKFLOW_ENGINE_URL_ENV, DEFAULTS.workflowEngineUrl),
    runtime: envOrDefault(RUNTIME_URL_ENV, DEFAULTS.runtimeUrl),
    clickhouse: envOrDefault(CH_URL_ENV, DEFAULTS.clickhouseUrl),
    kafkaBrokers: parseKafkaBrokers(process.env[KAFKA_BROKERS_ENV]),
  };

  const failures: string[] = [];

  // 1. Feature flags must all be 'true' (case-sensitive — matches how the
  //    services read them).
  for (const flag of req.flags) {
    if (process.env[flag] !== 'true') {
      failures.push(`flag ${flag}=${process.env[flag] ?? '<unset>'}`);
    }
  }

  // 2. Infrastructure probes (parallel).
  const probeTasks: Array<Promise<{ ok: boolean; reason: string }>> = [];
  if (req.services.workflowEngine) probeTasks.push(probeHttp(urls.workflowEngine, '/health'));
  if (req.services.runtime) probeTasks.push(probeHttp(urls.runtime, '/health'));
  if (req.services.clickhouse) probeTasks.push(probeClickhouse(urls.clickhouse));
  if (req.services.kafka) {
    for (const broker of urls.kafkaBrokers) probeTasks.push(probeTcp(broker));
  }
  const probeResults = await Promise.all(probeTasks);
  for (const r of probeResults) {
    if (!r.ok) failures.push(r.reason);
  }

  if (failures.length > 0) {
    return {
      shouldRun: false,
      skipReason: failures.join(' | '),
      urls,
    };
  }

  // 3. Auth context — only enforced when tests will actually run. The
  //    operator MUST supply a token + tenant/project ids. If missing, skip
  //    (explicit reason) rather than fail silently.
  const token = process.env[AUTH_TOKEN_ENV];
  if (!token || token.length === 0) {
    return {
      shouldRun: false,
      skipReason: `${AUTH_TOKEN_ENV} not exported`,
      urls,
    };
  }

  return {
    shouldRun: true,
    urls,
    auth: {
      token,
      tenantId: envOrDefault(TENANT_ENV, DEFAULTS.tenantId),
      projectId: envOrDefault(PROJECT_ENV, DEFAULTS.projectId),
      userId: envOrDefault(USER_ENV, DEFAULTS.userId),
      workflowId: process.env[WORKFLOW_ENV],
    },
  };
}

/** Emit a single-line structured log when a scenario skips. Called by each
 *  E2E file so the reason surfaces in the test output instead of disappearing
 *  into a vitest `(skipped)` silence. */
export function logSkip(scenarioId: string, reason: string): void {
  // eslint-disable-next-line no-console -- E2E lane only; intentional operator-facing output
  console.info(`[e2e:${scenarioId}] skipped — ${reason}`);
}
