/**
 * Route Manifest Generator
 *
 * Statically analyzes route files across Studio (Next.js) and Runtime (Express)
 * to produce a JSON manifest of all API routes, their methods, auth levels,
 * path parameters, categories, and inter-route dependencies.
 *
 * Usage:
 *   tsx tools/agents/e2e-smoke/manifest-generator.ts > tools/agents/e2e-smoke/route-manifest.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────────────────

type AuthLevel = 'tenant' | 'project' | 'admin' | 'public' | 'unknown';

interface RouteEntry {
  path: string;
  methods: string[];
  auth: AuthLevel;
  pathParams: string[];
  queryParams?: string[];
  category: string;
  dependencies: string[];
  source: string;
}

interface RouteManifest {
  generatedAt: string;
  studioRoutes: RouteEntry[];
  runtimeRoutes: RouteEntry[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STUDIO_API_DIR = path.join(ROOT, 'apps', 'studio', 'src', 'app', 'api');
const RUNTIME_ROUTES_DIR = path.join(ROOT, 'apps', 'runtime', 'src', 'routes');
const RUNTIME_SERVER_FILE = path.join(ROOT, 'apps', 'runtime', 'src', 'server.ts');

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

/**
 * Dependency map: path param name to the POST route that creates the resource.
 * When a route contains a param like [agentId], it depends on the creator route.
 */
const PARAM_DEPENDENCY_MAP: Record<string, string> = {
  agentId: 'POST /api/projects/[id]/agents',
  agentName: 'POST /api/projects/[id]/agents',
  projectId: 'POST /api/projects',
  sessionId: 'POST /api/projects/[id]/sessions',
  indexId: 'POST /api/search-ai/indexes',
  sourceId: 'POST /api/search-ai/indexes/[id]/sources',
  channelId: 'POST /api/projects/[id]/sdk-channels',
  toolId: 'POST /api/projects/[id]/tools',
  workflowId: 'POST /api/projects/[id]/workflows',
  triggerId: 'POST /api/projects/[id]/workflows/triggers',
  serverId: 'POST /api/projects/[id]/mcp-servers',
};

/**
 * Category inference from path segments.
 * Order matters: first match wins.
 */
const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/\/search-ai-runtime\//, 'search-ai-runtime'],
  [/\/search-ai\//, 'search-ai'],
  [/\/mcp-servers\//, 'mcp-servers'],
  [/\/agents\//, 'agents'],
  [/\/sessions\//, 'sessions'],
  [/\/connections\/|\/channel-connections\//, 'connections'],
  [/\/sdk-channels\/|\/sdk\//, 'sdk'],
  [/\/deployments\//, 'deployments'],
  [/\/workflows\//, 'workflows'],
  [/\/tools\//, 'tools'],
  [/\/auth\/|\/sso\/|\/mfa\//, 'auth'],
  [/\/invitations\//, 'invitations'],
  [/\/platform-admin\/|\/platform\/admin\//, 'platform-admin'],
  [/\/admin\//, 'admin'],
  [/\/tenant-models\/|\/tenant-credentials\/|\/tenant-usage\//, 'tenant'],
  [/\/model-catalog\/|\/model-capabilities\//, 'models'],
  [/\/analytics\/|\/pipeline-analytics\/|\/nl-analytics\//, 'analytics'],
  [/\/guardrail/, 'guardrails'],
  [/\/voice\/|\/voice-analytics\/|\/livekit\//, 'voice'],
  [/\/chat\//, 'chat'],
  [/\/channel-oauth\/|\/oauth\//, 'oauth'],
  [/\/channel-/, 'channels'],
  [/\/contacts\/|\/contact-merge\/|\/merge-suggestions\//, 'contacts'],
  [/\/environment-variables\/|\/env-vars\//, 'environment'],
  [/\/experiments\//, 'experiments'],
  [/\/tags\//, 'tags'],
  [/\/alerts\/|\/alert-config\//, 'alerts'],
  [/\/feedback\//, 'feedback'],
  [/\/audit\/|\/archives\//, 'audit'],
  [/\/roi\//, 'roi'],
  [/\/seed-data\//, 'seed-data'],
  [/\/diagnostics\//, 'diagnostics'],
  [/\/proxy-config/, 'proxy'],
  [/\/locks\//, 'locks'],
  [/\/runtime\//, 'runtime'],
  [/\/service-instances\//, 'service-instances'],
  [/\/variable-namespace/, 'variables'],
  [/\/lookup-tables\/|\/lookup-data\//, 'lookup-data'],
  [/\/pipeline-config\//, 'pipeline-config'],
  [/\/custom-events\/|\/external-events\//, 'events'],
  [/\/human-tasks\//, 'human-tasks'],
  [/\/memory/, 'memory'],
  [/\/crawler/, 'crawler'],
  [/\/tool-secrets/, 'tool-secrets'],
  [/\/project-io/, 'project-io'],
  [/\/identity/, 'identity'],
  [/\/callbacks/, 'callbacks'],
  [/\/agent-transfer/, 'agent-transfer'],
  [/\/kms/, 'kms'],
  [/\/workspace-billing/, 'billing'],
  [/\/pii-patterns/, 'pii'],
  [/\/device-auth/, 'device-auth'],
  [/\/kg-/, 'knowledge-graph'],
  [/\/vocabulary\//, 'vocabulary'],
  [/\/arch-conversation/, 'arch'],
  [/\/ownership\//, 'ownership'],
  [/\/diff\//, 'diff'],
  [/\/versions\//, 'versions'],
  [/\/llm-config\/|\/llm-policy\//, 'llm-config'],
  [/\/runtime-config\//, 'runtime-config'],
  [/\/project-settings\/|\/settings\//, 'settings'],
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Recursively find files matching a predicate */
function walkDir(dir: string, predicate: (filePath: string) => boolean): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...walkDir(fullPath, predicate));
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

/** Extract path params like [id], [agentId] from a URL path */
function extractPathParams(urlPath: string): string[] {
  const matches = urlPath.match(/\[([^\]]+)\]/g);
  if (!matches) return [];
  return matches.map((m) => m.slice(1, -1));
}

/** Normalize Express :param to Next.js [param] style for consistency */
function normalizePathParams(urlPath: string): string {
  return urlPath.replace(/:(\w+)/g, '[$1]');
}

/** Infer category from a URL path */
function inferCategory(urlPath: string): string {
  for (const [pattern, category] of CATEGORY_PATTERNS) {
    if (pattern.test(urlPath)) return category;
  }
  const segments = urlPath.split('/').filter(Boolean);
  const meaningful = segments.filter((s) => !s.startsWith('[') && !s.startsWith(':'));
  return meaningful[meaningful.length - 1] || 'unknown';
}

/** Detect auth level from file content and path */
function detectAuth(content: string, filePath?: string): AuthLevel {
  const hasPlatformAdmin =
    /requirePlatformAdmin\b/.test(content) || /requirePlatformAdminAccess\b/.test(content);
  const hasProjectAccess =
    /requireProjectAccess\b/.test(content) ||
    /requireProjectPermission\b/.test(content) ||
    /requireProjectScope\b/.test(content) ||
    /requireProject:\s*true/.test(content);
  const hasTenantAdmin = /requireAdminRole\b/.test(content);
  const hasWithRouteHandler = /withRouteHandler\b/.test(content);
  const hasRequireAuth =
    /requireAuth\b/.test(content) ||
    /requireTenantAuth\b/.test(content) ||
    /createUnifiedAuthMiddleware/.test(content) ||
    /withAuth\b/.test(content);
  const hasAuthMiddleware = /authMiddleware\b/.test(content);

  if (hasPlatformAdmin) return 'admin';
  if (hasProjectAccess) return 'project';
  if (hasRequireAuth || hasAuthMiddleware || hasTenantAdmin || hasWithRouteHandler) return 'tenant';

  // Runtime factory routers that check tenantContext in inline middleware
  if (/tenantContext\?\.tenantId/.test(content) || /req\)\.tenantContext/.test(content)) {
    return 'tenant';
  }

  // MFA routes using partial-auth tokens
  if (/requireAuthOrMFAPending\b/.test(content)) return 'tenant';

  // Service-to-service auth (e.g. x-service-secret header check, sandbox JWT)
  if (/x-service-secret/.test(content) || /jwt\.verify\b/.test(content)) return 'tenant';

  // SDK init and public endpoints
  if (/sdkInitMiddleware\b/.test(content)) return 'public';

  // Check for intentionally public routes
  if (
    /\/\*\*.*[Pp]ublic/.test(content) ||
    /[Nn]o auth/.test(content) ||
    /without.*auth/i.test(content)
  ) {
    return 'public';
  }

  // ─── Path-based heuristics (when code patterns don't match) ─────────

  const normalizedPath = filePath?.replace(/\\/g, '/') || '';

  // Studio auth flow routes are public (login, signup, callback, OAuth, password reset)
  if (/\/app\/api\/auth\//.test(normalizedPath)) return 'public';

  // SSO flow routes are public (init, exchange, callbacks)
  if (/\/app\/api\/sso\//.test(normalizedPath)) return 'public';

  // MFA routes that didn't match above are public entry points
  if (/\/app\/api\/mfa\//.test(normalizedPath)) return 'public';

  // OAuth redirect callbacks (connectors, channels) are public
  if (/\/connectors\/auth\/callback/.test(normalizedPath)) return 'public';

  // OpenAPI / Swagger UI routes are public
  if (/\/app\/api\/openapi\//.test(normalizedPath)) return 'public';

  // Webhook receiver routes use signature verification, not standard auth
  // (channel-webhooks, audiocodes, genesys, vxml, agent-transfer-webhooks, git webhooks)
  if (
    /webhook/.test(normalizedPath) ||
    /channel-audiocodes/.test(normalizedPath) ||
    /channel-genesys/.test(normalizedPath) ||
    /channel-vxml/.test(normalizedPath)
  ) {
    return 'public';
  }

  // Runtime SDK route (widget config) is public — keyed by API key in query
  if (/\/routes\/sdk\.ts$/.test(normalizedPath)) return 'public';

  // Runtime auth route (dev-login) is public
  if (/\/routes\/auth\.ts$/.test(normalizedPath)) return 'public';

  // Runtime transcripts route (local dev tool, no auth)
  if (/\/routes\/transcripts\.ts$/.test(normalizedPath)) return 'public';

  // Debug validate route uses service secret (handled above), but catch path too
  if (/\/debug\/validate/.test(normalizedPath)) return 'tenant';

  return 'unknown';
}

/** Infer dependencies from path params */
function inferDependencies(urlPath: string, pathParams: string[], _category: string): string[] {
  const deps = new Set<string>();

  for (const param of pathParams) {
    if (param === 'id') {
      const dep = resolveGenericIdDependency(urlPath);
      if (dep) deps.add(dep);
      continue;
    }

    // Skip params that are not created-resource references
    if (
      [
        'tenantId',
        'toolName',
        'orgId',
        'connId',
        'token',
        'jobId',
        'modelId',
        'domain',
        'name',
        'spanId',
        'connectorId',
      ].includes(param)
    ) {
      continue;
    }

    const dep = PARAM_DEPENDENCY_MAP[param];
    if (dep) deps.add(dep);
  }

  return [...deps];
}

/** Resolve the generic [id] param dependency based on URL context */
function resolveGenericIdDependency(urlPath: string): string {
  if (urlPath.includes('/projects/[id]/')) return 'POST /api/projects';
  if (urlPath.includes('/search-ai/indexes/[id]')) return 'POST /api/search-ai/indexes';
  if (urlPath.includes('/search-ai/knowledge-bases/[id]'))
    return 'POST /api/search-ai/knowledge-bases';
  if (urlPath.includes('/search-ai/mappings/[id]')) return 'POST /api/search-ai/mappings';
  if (urlPath.includes('/tenant-models/[id]')) return 'POST /api/tenant-models';
  if (urlPath.includes('/service-instances/[id]')) return 'POST /api/service-instances';
  return '';
}

// ─── Studio Route Scanner ───────────────────────────────────────────────────

/**
 * Scan Next.js App Router route.ts files.
 *
 * Path convention: apps/studio/src/app/api/.../route.ts
 * Methods identified by exported function names: GET, POST, PUT, DELETE, PATCH.
 * These can be direct exports or named const exports via withOpenAPI.
 */
function scanStudioRoutes(): RouteEntry[] {
  const routeFiles = walkDir(STUDIO_API_DIR, (fp) => fp.endsWith('/route.ts'));
  const entries: RouteEntry[] = [];

  for (const filePath of routeFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `Warning: skipping unreadable file ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    const relativePath = path.relative(ROOT, filePath);

    // Convert file path to URL path
    const apiIndex = filePath.indexOf('app/api/');
    if (apiIndex === -1) continue;
    const routeSegment = filePath.slice(apiIndex + 4); // keep "/api/"
    const urlPath = '/' + routeSegment.replace(/\/route\.ts$/, '');

    // Detect HTTP methods
    const methods: string[] = [];
    for (const method of HTTP_METHODS) {
      const directExport = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`);
      const constExport = new RegExp(`export\\s+const\\s+${method}\\b`);
      if (directExport.test(content) || constExport.test(content)) {
        methods.push(method);
      }
    }

    if (methods.length === 0) continue;

    const pathParams = extractPathParams(urlPath);
    const auth = detectAuth(content, filePath);
    const category = inferCategory(urlPath);
    const dependencies = inferDependencies(urlPath, pathParams, category);

    entries.push({
      path: urlPath,
      methods,
      auth,
      pathParams,
      category,
      dependencies,
      source: relativePath,
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}

// ─── Runtime Route Scanner ──────────────────────────────────────────────────

/**
 * Parse runtime server.ts to build a map of router variable name to mount path.
 * Matches patterns like: app.use('/api/v1/chat', chatRouter);
 */
function parseServerMountPaths(): Map<string, string> {
  const mountMap = new Map<string, string>();

  if (!fs.existsSync(RUNTIME_SERVER_FILE)) {
    process.stderr.write(`Warning: Runtime server file not found at ${RUNTIME_SERVER_FILE}\n`);
    return mountMap;
  }

  const content = fs.readFileSync(RUNTIME_SERVER_FILE, 'utf-8');

  // Step 1: Find where intermediate routers are mounted on app
  // e.g. app.use('/api/tenants/:tenantId', tenantRouter)
  const intermediateRouterMounts = new Map<string, string>();
  const appMountRegex = /app\.use\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = appMountRegex.exec(content)) !== null) {
    const mountPath = match[1];
    const varName = match[2];
    if (varName.endsWith('Router')) {
      // Direct router mount on app
      mountMap.set(varName, mountPath);
    }
    intermediateRouterMounts.set(varName, mountPath);
  }

  // Step 2: Find sub-router mounts (e.g. tenantRouter.use('/alerts', alertConfigRouter))
  const subMountRegex = /(\w+)\.use\(\s*'([^']+)'\s*,\s*(\w+Router)\s*\)/g;
  while ((match = subMountRegex.exec(content)) !== null) {
    const parentVar = match[1];
    const subPath = match[2];
    const childRouter = match[3];

    // If the parent is an intermediate router, resolve the full path
    const parentPath = intermediateRouterMounts.get(parentVar);
    if (parentPath) {
      mountMap.set(childRouter, parentPath + subPath);
    } else if (parentVar === 'app') {
      mountMap.set(childRouter, subPath);
    }
  }

  return mountMap;
}

/**
 * Scan Express runtime route files.
 *
 * Two patterns:
 * 1. openapi.route('get', '/path', ...) with basePath from createOpenAPIRouter
 * 2. router.get('/path', ...) with mount path from server.ts
 */
function scanRuntimeRoutes(): RouteEntry[] {
  const routeFiles = walkDir(RUNTIME_ROUTES_DIR, (fp) => {
    const basename = path.basename(fp);
    return (
      basename.endsWith('.ts') &&
      !basename.endsWith('.test.ts') &&
      !basename.endsWith('.spec.ts') &&
      basename !== 'index.ts'
    );
  });

  const serverMounts = parseServerMountPaths();
  const entries: RouteEntry[] = [];

  for (const filePath of routeFiles) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      process.stderr.write(
        `Warning: skipping unreadable file ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    const relativePath = path.relative(ROOT, filePath);
    const basename = path.basename(filePath, '.ts');

    const auth = detectAuth(content, filePath);

    // Extract basePath from createOpenAPIRouter
    const basePathMatch = content.match(/basePath:\s*['"]([^'"]+)['"]/);
    const basePath = basePathMatch ? basePathMatch[1] : null;

    // Find mount path from server.ts
    const mountPath = findMountPath(basename, serverMounts);

    // Collect sub-routes
    const subRoutes = extractSubRoutes(content);

    if (subRoutes.length === 0) {
      const routePath = basePath || mountPath;
      if (!routePath) continue;

      const detectedMethods = detectMethodsFromFile(content);
      if (detectedMethods.length === 0) continue; // skip files with no recognizable HTTP methods

      const normalizedPath = normalizePathParams(routePath);
      const pathParams = extractPathParams(normalizedPath);
      const category = inferCategory(normalizedPath);

      entries.push({
        path: normalizedPath,
        methods: detectedMethods,
        auth,
        pathParams,
        category,
        dependencies: inferDependencies(normalizedPath, pathParams, category),
        source: relativePath,
      });
      continue;
    }

    // Group sub-routes by full path to merge methods
    const routeMethodMap = new Map<string, Set<string>>();

    for (const sub of subRoutes) {
      const resolvedBase = basePath || mountPath || '';
      const fullPath = combinePaths(resolvedBase, sub.subPath);

      if (!routeMethodMap.has(fullPath)) {
        routeMethodMap.set(fullPath, new Set());
      }
      routeMethodMap.get(fullPath)!.add(sub.method.toUpperCase());
    }

    for (const [fullPath, methods] of routeMethodMap) {
      const normalizedPath = normalizePathParams(fullPath);
      const pathParams = extractPathParams(normalizedPath);
      const category = inferCategory(normalizedPath);

      entries.push({
        path: normalizedPath,
        methods: [...methods].sort(),
        auth,
        pathParams,
        category,
        dependencies: inferDependencies(normalizedPath, pathParams, category),
        source: relativePath,
      });
    }
  }

  // Filter out routes with empty paths (unmounted route files)
  const validEntries = entries.filter((e) => e.path.length > 0);
  validEntries.sort((a, b) => a.path.localeCompare(b.path));
  return validEntries;
}

/** Find mount path from server.ts for a route file */
function findMountPath(basename: string, serverMounts: Map<string, string>): string | null {
  const camelCase = basename.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const routerVarName = camelCase + 'Router';

  for (const [varName, mPath] of serverMounts) {
    if (varName === routerVarName) return mPath;
  }

  // Fuzzy match for router names that don't match filenames exactly
  for (const [varName, mPath] of serverMounts) {
    const normalized = varName.replace(/Router$/, '').toLowerCase();
    const fileNormalized = basename.replace(/-/g, '').toLowerCase();
    if (normalized === fileNormalized) return mPath;
  }

  return null;
}

interface SubRoute {
  method: string;
  subPath: string;
}

/** Extract sub-route definitions from route file content */
function extractSubRoutes(content: string): SubRoute[] {
  const routes: SubRoute[] = [];
  let match: RegExpExecArray | null;

  // Pattern 1: openapi.route('method', '/path', ...)
  const openapiRegex = /openapi\.route\(\s*['"](\w+)['"]\s*,\s*['"]([^'"]*)['"]/g;
  while ((match = openapiRegex.exec(content)) !== null) {
    routes.push({ method: match[1], subPath: match[2] });
  }

  // Pattern 2: router.get('/path', ...)
  const routerRegex = /router\.(get|post|put|delete|patch)\(\s*['"]([^'"]*)['"]/g;
  while ((match = routerRegex.exec(content)) !== null) {
    routes.push({ method: match[1], subPath: match[2] });
  }

  return routes;
}

/** Detect HTTP methods from file content when no sub-routes are found */
function detectMethodsFromFile(content: string): string[] {
  const methods: string[] = [];
  for (const method of HTTP_METHODS) {
    const lower = method.toLowerCase();
    if (
      new RegExp(`router\\.${lower}\\(`).test(content) ||
      new RegExp(`openapi\\.route\\(\\s*['"]${lower}['"]`).test(content)
    ) {
      methods.push(method);
    }
  }
  return methods;
}

/** Combine base path with sub-path, handling slashes */
function combinePaths(base: string, sub: string): string {
  if (!sub || sub === '/') return base;
  const cleanBase = base.replace(/\/$/, '');
  const cleanSub = sub.startsWith('/') ? sub : '/' + sub;
  return cleanBase + cleanSub;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const studioRoutes = scanStudioRoutes();
  const runtimeRoutes = scanRuntimeRoutes();

  const manifest: RouteManifest = {
    generatedAt: new Date().toISOString(),
    studioRoutes,
    runtimeRoutes,
  };

  process.stderr.write(
    `Manifest generated: ${studioRoutes.length} studio routes, ${runtimeRoutes.length} runtime routes\n`,
  );

  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
}

main();
