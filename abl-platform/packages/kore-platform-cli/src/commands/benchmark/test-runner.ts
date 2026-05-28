/**
 * Test Runner — Orchestrates k6 test execution (local or cloud)
 *
 * Three test types, each independently filterable by service:
 *   - service:     services/*.ts     (per-service benchmarks)
 *   - integration: integration/*.ts  (E2E multi-service flows)
 *   - saturation:  saturation/*.ts   (ramp-to-breaking-point)
 */

import { execFile as execFileCb } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export type TestType = 'service' | 'integration' | 'saturation';

export interface TestScript {
  path: string;
  label: string;
  serviceName: string;
  type: TestType;
  /** For integration scripts: the actual services exercised by this script. */
  services?: string[];
}

export interface TestRunResult {
  script: TestScript;
  passed: boolean;
  summaryPath: string | null;
  logPath: string;
  error?: string;
}

export interface TestSuiteResult {
  results: TestRunResult[];
  total: number;
  passed: number;
  failed: number;
  startTime: number;
  endTime: number;
  outputDir: string;
}

// ---------------------------------------------------------------------------
// Env vars to pass through as `-e` flags for k6 Cloud runs.
// k6 Cloud executes scripts on remote workers — process.env is NOT inherited.
// ---------------------------------------------------------------------------

const K6_CLOUD_ENV_PASSTHROUGH: readonly string[] = [
  // VU scaling
  'MAX_VUS',
  'DURATION_MINUTES',
  'SCENARIO_WEIGHTS',
  // Auth
  'AUTH_TOKEN',
  'REFRESH_TOKEN',
  'TENANT_ID',
  'PROJECT_ID',
  // Service URLs
  'RUNTIME_URL',
  'SEARCH_AI_URL',
  'SEARCH_AI_RUNTIME_URL',
  'STUDIO_URL',
  'ADMIN_URL',
  'BGE_M3_URL',
  'INGRESS_BASE',
  'WS_URL',
  // Test config
  'TIER',
  'ENV',
  'HEALTH_CHECK',
  'LOAD_TEST_KEY',
  'AGENT_NAME',
  'SUPERVISOR_NAME',
  'DEV_LOGIN_USER_ID',
  'DEV_LOGIN_EMAIL',
  'DEV_LOGIN_NAME',
  'DEPLOYMENT_PREFIX',
];

// ---------------------------------------------------------------------------
// Script registries — service name → k6 script path
// ---------------------------------------------------------------------------

/** Per-service benchmark scripts */
const SERVICE_SCRIPTS: Record<string, string> = {
  runtime: 'services/runtime.ts',
  studio: 'services/studio.ts',
  'search-ai': 'services/search-ai.ts',
  'search-ai-runtime': 'services/search-ai-runtime.ts',
  crawler: 'services/crawler.ts',
  'bge-m3': 'services/bge-m3.ts',
  docling: 'services/docling.ts',
  preprocessing: 'services/preprocessing.ts',
  mongodb: 'services/mongodb.ts',
  redis: 'services/redis.ts',
  clickhouse: 'services/clickhouse.ts',
  opensearch: 'services/opensearch.ts',
  qdrant: 'services/qdrant.ts',
  neo4j: 'services/neo4j.ts',
  restate: 'services/restate.ts',
  'workflow-engine': 'services/workflow-engine.ts',
};

/** Saturation (ramp-to-breaking) scripts */
const SATURATION_SCRIPTS: Record<string, string> = {
  runtime: 'saturation/runtime.ts',
  'search-ai': 'saturation/search-ai.ts',
  'bge-m3': 'saturation/bge-m3.ts',
};

/**
 * Integration E2E scripts.
 *
 * Each script is keyed by a short name and tagged with the services it
 * exercises, so `--services runtime` filters to integration scripts that
 * test the runtime.
 */
const INTEGRATION_SCRIPTS: Record<string, { path: string; services: string[] }> = {
  'agent-conversation-e2e': {
    path: 'integration/agent-conversation-e2e.ts',
    services: ['runtime'],
  },
  'multi-agent-orchestration': {
    path: 'integration/multi-agent-orchestration.ts',
    services: ['runtime'],
  },
  'kb-ingestion-e2e': {
    path: 'integration/kb-ingestion-e2e.ts',
    services: ['search-ai'],
  },
  'search-query-e2e': {
    path: 'integration/search-query-e2e.ts',
    services: ['search-ai'],
  },
  'channel-message-e2e': {
    path: 'integration/channel-message-e2e.ts',
    services: ['runtime', 'studio'],
  },
  'workflow-execution-e2e': {
    path: 'integration/workflow-execution-e2e.ts',
    services: ['workflow-engine'],
  },
};

// ---------------------------------------------------------------------------
// Script resolution
// ---------------------------------------------------------------------------

/**
 * Resolve service/script names to test scripts for a given test type.
 *
 * For service and saturation tests, `--services` filters by service name.
 * For integration tests, `--services` filters by the services each
 * integration script exercises, OR by integration script name directly.
 */
export function resolveTestScripts(serviceNames: string[], testType: TestType): TestScript[] {
  const scripts: TestScript[] = [];
  const isAll = serviceNames.length === 0 || serviceNames.includes('@all');

  if (testType === 'service') {
    const entries = isAll
      ? Object.entries(SERVICE_SCRIPTS)
      : serviceNames
          .filter((s) => !s.startsWith('@'))
          .map((s) => [s, SERVICE_SCRIPTS[s]] as const)
          .filter(([, path]) => path);

    for (const [name, path] of entries) {
      scripts.push({ path, label: `svc-${name}`, serviceName: name, type: 'service' });
    }
  } else if (testType === 'saturation') {
    const entries = isAll
      ? Object.entries(SATURATION_SCRIPTS)
      : serviceNames
          .filter((s) => !s.startsWith('@'))
          .map((s) => [s, SATURATION_SCRIPTS[s]] as const)
          .filter(([, path]) => path);

    for (const [name, path] of entries) {
      scripts.push({ path, label: `sat-${name}`, serviceName: name, type: 'saturation' });
    }
  } else {
    // Integration: filter by service name OR integration script name
    for (const [scriptName, entry] of Object.entries(INTEGRATION_SCRIPTS)) {
      const shouldInclude =
        isAll ||
        serviceNames.includes(scriptName) ||
        entry.services.some((s) => serviceNames.includes(s));

      if (shouldInclude) {
        scripts.push({
          path: entry.path,
          label: `int-${scriptName}`,
          serviceName: scriptName,
          type: 'integration',
          services: entry.services,
        });
      }
    }
  }

  return scripts;
}

/**
 * List available scripts for a test type (for error messages).
 */
export function listAvailableScripts(testType: TestType): string[] {
  if (testType === 'service') return Object.keys(SERVICE_SCRIPTS);
  if (testType === 'saturation') return Object.keys(SATURATION_SCRIPTS);
  return Object.keys(INTEGRATION_SCRIPTS);
}

// ---------------------------------------------------------------------------
// Pre-authentication — obtain tokens once, reuse across all k6 processes
// ---------------------------------------------------------------------------

/**
 * Authenticate once via dev-login → refresh flow before running the suite.
 * Sets AUTH_TOKEN and REFRESH_TOKEN in process.env so all spawned k6
 * processes inherit them, avoiding per-script dev-login rate limiting (429).
 *
 * Skipped if AUTH_TOKEN is already set (e.g., from cloud.env).
 */
export async function preAuthenticate(): Promise<void> {
  if (process.env.AUTH_TOKEN) {
    console.log('  Auth: using existing AUTH_TOKEN from env');
    return;
  }

  const studioUrl = process.env.STUDIO_URL || process.env.INGRESS_BASE || 'http://localhost:5173';

  // Priority 1: REFRESH_TOKEN from env — not rate-limited, no dev-login needed
  if (process.env.REFRESH_TOKEN) {
    console.log('  Auth: refreshing via REFRESH_TOKEN from env...');
    const ok = await doRefresh(studioUrl, process.env.REFRESH_TOKEN);
    if (ok) return;
    console.warn('  Auth: refresh failed, falling back to dev-login...');
  }

  // Priority 2: dev-login → refresh (rate-limited, retry with backoff)
  const email = process.env.DEV_LOGIN_EMAIL || 'dev@example.com';
  const name = process.env.DEV_LOGIN_NAME || 'Developer';

  console.log(`  Auth: pre-authenticating via dev-login at ${studioUrl}...`);

  const MAX_RETRIES = 5;
  const BACKOFF_SEC = [5, 15, 30, 60, 60];

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const loginRes = await fetch(`${studioUrl}/api/auth/dev-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
        redirect: 'manual',
      });

      if (loginRes.status === 429) {
        const waitSec = BACKOFF_SEC[attempt] ?? 60;
        console.warn(
          `  Auth: rate limited (429), waiting ${waitSec}s before retry (${attempt + 1}/${MAX_RETRIES})...`,
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (!loginRes.ok && loginRes.status !== 302) {
        console.warn(
          `  Auth: dev-login returned ${loginRes.status}, scripts will auth individually`,
        );
        return;
      }

      const setCookie = loginRes.headers.get('set-cookie') ?? '';
      const refreshMatch = setCookie.match(/refresh_token=([^;]+)/);
      if (!refreshMatch) {
        console.warn('  Auth: no refresh_token in Set-Cookie, scripts will auth individually');
        return;
      }

      const ok = await doRefresh(studioUrl, refreshMatch[1]);
      if (ok) return;

      console.warn('  Auth: refresh after dev-login failed, scripts will auth individually');
      return;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES - 1) {
        const waitSec = BACKOFF_SEC[attempt] ?? 60;
        console.warn(
          `  Auth: attempt ${attempt + 1} failed (${message}), retrying in ${waitSec}s...`,
        );
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      } else {
        console.warn(`  Auth: all ${MAX_RETRIES} attempts failed, scripts will auth individually`);
      }
    }
  }
}

/**
 * Exchange a refresh token for an access token via /api/auth/refresh.
 * This endpoint is NOT rate-limited like dev-login.
 * Sets AUTH_TOKEN + REFRESH_TOKEN in process.env on success.
 */
async function doRefresh(studioUrl: string, refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${studioUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `refresh_token=${refreshToken}`,
      },
      body: '{}',
    });

    if (!res.ok) return false;

    const data = (await res.json()) as { accessToken?: string };
    if (!data.accessToken) return false;

    // Pick up rotated refresh token if server issued one
    const setCookie = res.headers.get('set-cookie') ?? '';
    const rotatedMatch = setCookie.match(/refresh_token=([^;]+)/);
    const newRefreshToken = rotatedMatch ? rotatedMatch[1] : refreshToken;

    process.env.AUTH_TOKEN = data.accessToken;
    process.env.REFRESH_TOKEN = newRefreshToken;
    console.log('  Auth: OK — tokens acquired, all scripts will reuse them');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// k6 execution
// ---------------------------------------------------------------------------

export interface K6RunOptions {
  benchmarksDir: string;
  outputDir: string;
  cloud: boolean;
  healthCheck: boolean;
  /** Smoke mode: --vus 1 --iterations 1 --no-thresholds (quick sanity check) */
  smoke?: boolean;
}

/**
 * Run a single k6 test script (local or cloud).
 */
async function runSingleScript(
  script: TestScript,
  opts: K6RunOptions,
  index: number,
  total: number,
): Promise<TestRunResult> {
  const scriptFullPath = join(opts.benchmarksDir, script.path);
  const summaryPath = join(opts.outputDir, `${script.label}.json`);
  const logPath = join(opts.outputDir, `${script.label}.log`);

  console.log(`\n[${index}/${total}] Running: ${script.path}`);

  const k6Bin = process.env.K6_BIN || 'k6';
  const args: string[] = [];

  if (opts.cloud) {
    args.push('cloud', scriptFullPath);
    // k6 Cloud runs scripts on remote servers — env vars must be passed via -e flags
    // so that __ENV.KEY is available inside the k6 script on the cloud worker.
    for (const key of K6_CLOUD_ENV_PASSTHROUGH) {
      const val = process.env[key];
      if (val) {
        args.push('-e', `${key}=${val}`);
      }
    }
  } else {
    args.push('run', scriptFullPath);
    if (opts.smoke) {
      args.push('--vus', '1', '--iterations', '1', '--no-thresholds');
    }
    args.push('--summary-export', summaryPath);
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HEALTH_CHECK: opts.healthCheck ? 'true' : 'false',
  };

  try {
    const { stdout, stderr } = await execFile(k6Bin, args, {
      env,
      timeout: 30 * 60 * 1000, // 30 minutes max per script
      maxBuffer: 50 * 1024 * 1024,
      cwd: opts.benchmarksDir,
    });

    await writeFile(logPath, stdout + '\n' + stderr);

    console.log(`[${index}/${total}] PASSED: ${script.path}`);
    return { script, passed: true, summaryPath: opts.cloud ? null : summaryPath, logPath };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    await writeFile(logPath, message);

    console.error(`[${index}/${total}] FAILED: ${script.path}`);
    console.error(`         ${message.split('\n').slice(-3).join('\n         ')}`);
    return { script, passed: false, summaryPath: null, logPath, error: message };
  }
}

/**
 * Run the full test suite sequentially.
 */
export async function runTestSuite(
  scripts: TestScript[],
  opts: K6RunOptions,
): Promise<TestSuiteResult> {
  await mkdir(opts.outputDir, { recursive: true });

  const startTime = Date.now();
  const results: TestRunResult[] = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < scripts.length; i++) {
    const result = await runSingleScript(scripts[i], opts, i + 1, scripts.length);
    results.push(result);
    if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  }

  const endTime = Date.now();

  console.log('\n=== Suite Complete ===');
  console.log(`  Total:    ${scripts.length}`);
  console.log(`  Passed:   ${passed}`);
  console.log(`  Failed:   ${failed}`);

  return {
    results,
    total: scripts.length,
    passed,
    failed,
    startTime,
    endTime,
    outputDir: opts.outputDir,
  };
}
