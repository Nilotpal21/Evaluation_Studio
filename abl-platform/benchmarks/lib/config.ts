/**
 * Shared k6 benchmark configuration.
 *
 * Provides base URLs, auth tokens, and threshold presets for all benchmarks.
 * Configure via environment variables when running k6.
 *
 * Loads defaults from `benchmarks/config/cloud.env` — CLI `-e` flags override.
 */
import http from 'k6/http';
import { check } from 'k6';

// ---------------------------------------------------------------------------
// Load cloud.env defaults (k6 `open()` reads files at init time)
// ---------------------------------------------------------------------------

/**
 * Parse a dotenv-style file into a key-value map.
 * Skips comments (#) and blank lines. Does not expand variables.
 */
function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** Defaults loaded from cloud.env. CLI `-e` flags take precedence. */
let envDefaults: Record<string, string> = {};
try {
  const raw = open('../config/cloud.env');
  envDefaults = parseEnvFile(raw);
} catch {
  // File not found or unreadable — fall back to hardcoded defaults
}

/** Read an env var: CLI `-e` flag → cloud.env → fallback */
function env(key: string, fallback: string = ''): string {
  return __ENV[key] || envDefaults[key] || fallback;
}

/**
 * When services are behind a public ingress with path-prefix routing,
 * the ingress maps e.g. /api/runtime/* → Runtime's /api/*.
 * Scripts use paths like `${runtimeUrl}/api/v1/chat`.
 *
 * In direct mode (k6 Operator / local): runtimeUrl = http://runtime:3112
 *   → full path: http://runtime:3112/api/v1/chat ✓
 *
 * In ingress mode: INGRESS_BASE = https://staging.example.com
 *   → runtimeUrl = https://staging.example.com/api/runtime
 *   → script path /api/v1/chat becomes /api/runtime/api/v1/chat ✗ (double /api)
 *
 * Fix: when INGRESS_BASE is set, serviceUrl() replaces /api with the ingress prefix.
 * Scripts should use serviceUrl('runtime', '/api/v1/chat') or use the config URLs
 * which already have the correct base.
 *
 * For ingress mode, set service URLs WITHOUT the /api suffix — the scripts append it.
 * The ingress prefix IS the /api replacement:
 *   RUNTIME_URL = https://staging.example.com/api/runtime
 *   Script: ${runtimeUrl}/v1/chat → /api/runtime/v1/chat ✓
 *
 * So scripts must NOT hardcode /api/ in their paths when using ingress URLs.
 * To support both modes, use apiPath() which conditionally includes /api/.
 */
const ingressBase = env('INGRESS_BASE');

/**
 * Build an API path that works in both direct and ingress modes.
 * In direct mode: returns '/api' + path  (e.g., '/api/v1/chat')
 * In ingress mode: returns just path     (e.g., '/v1/chat')
 *   because the ingress prefix already includes the /api mapping.
 */
/**
 * For services behind ingress prefixes (Runtime, Search AI, etc.).
 * In direct mode: returns '/api' + path  (e.g., '/api/v1/chat')
 * In ingress mode: returns just path     (e.g., '/v1/chat')
 */
export function apiPath(path: string): string {
  if (ingressBase) {
    return path;
  }
  return `/api${path}`;
}

/**
 * For Studio routes (default ingress backend — no prefix rewriting).
 * Always returns '/api' + path in both modes, because Studio is the
 * default backend and its routes are always at /api/*.
 */
export function studioApiPath(path: string): string {
  return `/api${path}`;
}

/**
 * Config uses getters so __ENV is read lazily at access time (VU runtime),
 * not at module load time. k6's -e flags may not be available in __ENV
 * during module initialization with native TypeScript imports.
 */
export const config = {
  get runtimeUrl() {
    return env('RUNTIME_URL', 'http://localhost:3112');
  },
  get searchAiUrl() {
    return env('SEARCH_AI_URL', 'http://localhost:3113');
  },
  get searchAiRuntimeUrl() {
    return env('SEARCH_AI_RUNTIME_URL', 'http://localhost:3114');
  },
  get studioUrl() {
    return env('STUDIO_URL', 'http://localhost:5173');
  },
  get adminUrl() {
    return env('ADMIN_URL', 'http://localhost:3003');
  },
  get bgeM3Url() {
    return env('BGE_M3_URL', 'http://localhost:8000');
  },
  get doclingUrl() {
    return env('DOCLING_URL', 'http://localhost:8080');
  },
  get preprocessingUrl() {
    return env('PREPROCESSING_URL', 'http://localhost:8003');
  },
  get isIngress() {
    return !!ingressBase;
  },
  get mongoUrl() {
    return env('MONGO_URL', 'mongodb://localhost:27017');
  },
  get redisUrl() {
    return env('REDIS_URL', 'redis://localhost:6379');
  },
  get clickhouseUrl() {
    return env('CLICKHOUSE_URL', 'http://localhost:8123');
  },
  get opensearchUrl() {
    return env('OPENSEARCH_URL', 'https://localhost:9200');
  },
  get neo4jUrl() {
    return env('NEO4J_URL', 'bolt://localhost:7687');
  },
  get qdrantUrl() {
    return env('QDRANT_URL', 'http://localhost:6333');
  },
  get restateUrl() {
    return env('RESTATE_URL', 'http://localhost:9070');
  },
  /**
   * WebSocket URL for runtime connections.
   *
   * Priority: WS_URL env → derive from INGRESS_BASE → derive from RUNTIME_URL.
   *
   * In ingress mode, the WS path is at the ingress root (/ws), NOT under /api.
   * So we must use INGRESS_BASE (without /api suffix), not RUNTIME_URL.
   *
   * Examples:
   *   Direct:  RUNTIME_URL=http://runtime:3112 → ws://runtime:3112/ws
   *   Ingress: INGRESS_BASE=https://agents-dev.kore.ai → wss://agents-dev.kore.ai/ws
   *            (NOT wss://agents-dev.kore.ai/api/ws which returns 504)
   */
  get wsUrl() {
    const explicit = env('WS_URL');
    if (explicit) return explicit;
    const base = ingressBase || env('RUNTIME_URL', 'http://localhost:3112');
    return base.replace(/\/api\/?$/, '').replace(/^http/, 'ws') + '/ws';
  },
  get authToken() {
    return env('AUTH_TOKEN');
  },
  get refreshToken() {
    return env('REFRESH_TOKEN');
  },
  get tenantId() {
    return env('TENANT_ID', 'benchmark-tenant');
  },
  get projectId() {
    return env('PROJECT_ID', 'benchmark-project');
  },
  get devLoginUserId() {
    return env('DEV_LOGIN_USER_ID', 'user-dev-001');
  },
  get devLoginEmail() {
    return env('DEV_LOGIN_EMAIL', 'dev@kore.ai');
  },
  get devLoginName() {
    return env('DEV_LOGIN_NAME', 'Developer');
  },
  get loadTestKey() {
    return env('LOAD_TEST_KEY', 'benchmark-bypass');
  },
  /**
   * Benchmark profile — controls which runtime layers are bypassed during load tests.
   * Sent as the `X-Benchmark-Profile` header. The runtime only activates it when the
   * `X-Load-Test` header matches its `BENCHMARK_SECRET` env var.
   *
   *   "skip-sdk" — resolve model from DB (cached), skip Vercel AI SDK if provider is 'mock'.
   *               Measures: auth, RBAC, cached lookups, model resolution.
   *   "skip-llm" — full SDK pipeline, but mock provider returns simulated response (500-1000ms).
   *               Measures: + Vercel AI SDK stream plumbing + simulated LLM latency.
   *   ""         — (default) no bypass. Full production path, only enables timing logs.
   *
   * To use mock LLM, create a TenantModel with provider "mock" and assign it to the
   * benchmark project. Use `k6 run benchmarks/setup/bootstrap.ts -e MOCK_LLM=true`.
   */
  get benchmarkProfile() {
    return env('BENCHMARK_PROFILE', '');
  },
  get healthCheck() {
    return env('HEALTH_CHECK', 'true') === 'true';
  },
  get agentName() {
    return env('AGENT_NAME', 'benchmark_agent');
  },
  get supervisorName() {
    return env('SUPERVISOR_NAME', 'benchmark_supervisor');
  },
};

/** Build the full agent path: {projectId}/default/{agentName} */
export function buildAgentPath(agentName: string): string {
  return `${config.projectId}/default/${agentName}`;
}

/** Standard threshold presets */
export const thresholds = {
  /** Latency thresholds (ms) */
  fast: {
    'http_req_duration{scenario:fast}': ['p(95)<500', 'p(99)<1000'],
  },
  standard: {
    'http_req_duration{scenario:standard}': ['p(95)<2000', 'p(99)<5000'],
  },
  slow: {
    'http_req_duration{scenario:slow}': ['p(95)<10000', 'p(99)<30000'],
  },
  /** Error rate threshold */
  errorRate: {
    http_req_failed: ['rate<0.01'], // <1% error rate
  },
};

/** Standard ramp-up scenarios */
export const scenarios = {
  /** Constant low load */
  smoke: {
    executor: 'constant-vus' as const,
    vus: 1,
    duration: '1m',
  },
  /** Gradual ramp up */
  rampUp: {
    executor: 'ramping-vus' as const,
    startVUs: 1,
    stages: [
      { duration: '2m', target: 10 },
      { duration: '3m', target: 50 },
      { duration: '5m', target: 100 },
      { duration: '2m', target: 0 },
    ],
  },
  /** Spike test */
  spike: {
    executor: 'ramping-vus' as const,
    startVUs: 1,
    stages: [
      { duration: '1m', target: 10 },
      { duration: '30s', target: 100 },
      { duration: '2m', target: 100 },
      { duration: '30s', target: 10 },
      { duration: '1m', target: 0 },
    ],
  },
  /** Soak test */
  soak: {
    executor: 'constant-vus' as const,
    vus: 50,
    duration: '4h',
  },
};

/** Get authorization headers */
/** Get authorization headers including Origin for CORS. */
export function getAuthHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Origin: config.studioUrl,
    ...(config.authToken ? { Authorization: `Bearer ${config.authToken}` } : {}),
  };
}

/**
 * Run a health check against a service URL.
 * Skipped if config.healthCheck is false.
 * Throws on failure to prevent benchmarks from running against unhealthy services.
 */
export function runHealthCheck(
  serviceUrl: string,
  serviceName: string,
  headers?: Record<string, string>,
): void {
  if (!config.healthCheck) {
    console.log(`[health] Skipping health check for ${serviceName} (HEALTH_CHECK=false)`);
    return;
  }

  const res = http.get(`${serviceUrl}/health`, {
    ...(headers ? { headers } : {}),
  });

  const ok = check(res, {
    [`${serviceName} /health returns 200`]: (r) => r.status === 200,
  });

  if (!ok) {
    throw new Error(`${serviceName} health check failed: ${res.status} ${res.body}`);
  }

  console.log(`[health] ${serviceName} OK`);
}
