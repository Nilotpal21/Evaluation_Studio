/**
 * Next.js Proxy (formerly Middleware)
 *
 * Runs on every request before route handlers.
 * - Proxies runtime API paths to the runtime service (dynamic URL at request time)
 * - Adds X-Request-Id header for tracing
 * - Guards MFA-required routes
 * - CSRF protection for state-mutating API requests
 *
 * Why runtime proxy lives here instead of next.config.mjs rewrites:
 * Next.js serializes rewrite destinations at build time in standalone Docker builds.
 * RUNTIME_URL is only available at runtime via the K8s configmap, so rewrites in
 * next.config.mjs bake the fallback (localhost:3112) into the image permanently.
 * Middleware runs at request time and reads process.env.RUNTIME_URL dynamically.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isBrowserSdkRoute } from '@agent-platform/shared';
import { getRuntimeUrl } from '@/config/runtime.server';

const PROTECTED_PATH_EXCLUSIONS = ['/auth/', '/invite/', '/oauth/', '/preview'];
const PUBLIC_STATIC_ASSET_RE =
  /\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|css|woff|woff2|ttf|eot|html|txt|xml|json|map|webmanifest|mp3|wav|ogg)$/;

// ── Execution Plane (proxied to Runtime /api/v1/*) ──
// End-user conversation traffic. In production, ingress routes these directly to Runtime.
const RUNTIME_EXECUTION_PREFIXES = [
  '/api/v1', // Catches all: /api/v1/chat, /api/v1/voice, /api/v1/channels, etc.
];

// ── Management routes that still live on Runtime ──
// These are control-plane routes hosted on Runtime because they need
// Runtime-internal data (session state, tenant config, etc.)
const RUNTIME_MANAGEMENT_PREFIXES = [
  '/api/sdk/config',
  '/api/tool-secrets',
  '/api/proxy-configs',
  '/api/tenants',
  '/api/platform/admin', // TODO: remove once Admin app connects to Runtime directly
  '/api/auth/device',
  // AI4W service-plane discovery/provisioning APIs. Runtime is not exposed
  // directly via ingress in NGINX mode (only /ws and /health are), so these
  // service-to-service calls from AI4W ride the Studio ingress and are
  // rewritten through to runtime here. Auth is X-Service-Token + Bearer JWT
  // (see apps/runtime/src/routes/internal-discovery.ts), so CSRF exemption
  // for Bearer requests applies.
  '/api/internal/v1',
];

// Public runtime ingress paths that must bypass Studio page auth and route
// straight to Runtime (for example inbound A2A calls from external agents).
const RUNTIME_PUBLIC_PREFIXES = ['/a2a'];

// Project sub-paths handled exclusively by the runtime (no studio API route).
// Studio has its own /api/projects/[id]/agents, /arch-conversation, /sessions etc.
const RUNTIME_PROJECT_SUBPATH_RE =
  /^\/api\/projects\/[^/]+\/(deployments|sdk-channels|channels|channel-connections|env-vars|voice-analytics|pipeline-config)(\/|$)/;
// Browser-hosted SDK clients hydrate persisted chat history through the runtime
// session messages route. Studio has no App Router handler for this path, so it
// must bypass Next.js and reach runtime directly to preserve SDK CORS behavior.
const RUNTIME_BROWSER_SDK_MESSAGE_SUBPATH_RE =
  /^\/api\/projects\/[^/]+\/sessions\/[^/]+\/messages(?:\/|$)/;
// Note: 'workflows' NOT included above — Studio route handlers translate PATCH→PUT and
// DELETE→POST /archive for workflow CRUD. Only deeply nested workflow sub-paths (depth 7+)
// are proxied below, since turbopack dev server fails to match them.
const RUNTIME_AGENT_SUBPATH_RE = /^\/api\/projects\/[^/]+\/agents\/[^/]+\/(versions)(\/|$)/;

// Turbopack workaround: deeply nested workflow routes (7+ path segments) aren't matched
// by turbopack's route resolver despite being compiled and in the manifest. These are all
// pure proxies to runtime, so middleware rewrite is equivalent.
// Matches: /workflows/:id/executions/:id, /workflows/:id/notifications/:id, etc.
const WORKFLOW_DEEP_SUBPATH_RE =
  /^\/api\/projects\/[^/]+\/workflows\/[^/]+\/(executions|notifications)\/[^/]+(\/|$)/;

// Turbopack workaround: /api/projects/{id}/tools/{toolId}/test (6 segments) hits the same
// Turbopack route-resolution bug. Rewrite to the flat Studio handler at
// /api/tool-test (2 segments) which Turbopack resolves correctly.
// The projectId and toolId are forwarded as query params.
const TOOL_TEST_PATH_RE = /^\/api\/projects\/([^/]+)\/tools\/([^/]+)\/test$/;

// `/api/runtime/*` paths that map 1:1 onto a runtime route and need no
// query→path translation. These get a pure passthrough rewrite — the
// `/runtime/` segment is stripped and the request is forwarded to runtime.
//
// Every OTHER `/api/runtime/*` path falls through to its Studio App Router
// handler under `apps/studio/src/app/api/runtime/<name>/…`, which performs
// auth and shape translation (e.g. `?projectId=X&endpoint=Y` → path-scoped
// runtime URL `/api/projects/X/.../Y`). Adding a new Studio handler requires
// no change here; adding a new flat-passthrough path means adding a prefix.
const RUNTIME_PASSTHROUGH_PREFIXES = [
  '/api/runtime/projects/', // path-scoped runtime routes (pipeline-observability, workflows, etc.)
  '/api/runtime/agents/', // flat agent lookup (/api/agents/:agentName on runtime)
];

function isRuntimePassthroughPath(pathname: string): boolean {
  for (const prefix of RUNTIME_PASSTHROUGH_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Check if a pathname should be proxied to the runtime service.
 * Returns true for paths that have no studio API route handler.
 */
function isRuntimeProxyPath(pathname: string): boolean {
  for (const prefix of RUNTIME_EXECUTION_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
  }
  for (const prefix of RUNTIME_MANAGEMENT_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
  }
  return (
    RUNTIME_PROJECT_SUBPATH_RE.test(pathname) ||
    RUNTIME_BROWSER_SDK_MESSAGE_SUBPATH_RE.test(pathname) ||
    RUNTIME_AGENT_SUBPATH_RE.test(pathname) ||
    WORKFLOW_DEEP_SUBPATH_RE.test(pathname)
  );
}

function isRuntimePublicProxyPath(pathname: string): boolean {
  for (const prefix of RUNTIME_PUBLIC_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return true;
  }
  return false;
}

function isProtectedPage(pathname: string): boolean {
  if (pathname.startsWith('/api/')) return false;
  if (isRuntimePublicProxyPath(pathname)) return false;
  if (pathname.startsWith('/_next/')) return false;
  for (const exclusion of PROTECTED_PATH_EXCLUSIONS) {
    if (pathname.startsWith(exclusion)) return false;
  }
  if (PUBLIC_STATIC_ASSET_RE.test(pathname)) return false;
  return true;
}

function isPublicStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith('/api/')) {
    return false;
  }

  return PUBLIC_STATIC_ASSET_RE.test(pathname);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isApi = pathname.startsWith('/api/');
  const isAuth = pathname.startsWith('/auth/');
  const isInvite = pathname.startsWith('/invite/');
  const isOAuth = pathname.startsWith('/oauth/');
  const isOnboarding = pathname.startsWith('/onboarding');
  const isNextInternal = pathname.startsWith('/_next/');
  const isPreview = pathname.startsWith('/preview');
  const isSoftphoneAutomation = pathname.startsWith('/softphone-automation');
  const isHealth = pathname.startsWith('/health');
  const isAgentAnatomy = pathname.startsWith('/agent-anatomy');
  const isDocs = pathname.startsWith('/docs');
  const isAcademy = pathname.startsWith('/academy');
  const isMarketplace = pathname.startsWith('/marketplace');
  const isBrowsePreview = pathname.includes('/browse-preview');
  const isSourcePage = pathname.includes('/sources/');
  const isPublicStaticAsset = isPublicStaticAssetPath(pathname);

  // H6: Server-side route guards for protected pages
  if (isProtectedPage(pathname) && !isHealth && !isAgentAnatomy) {
    const refreshToken = request.cookies.get('refresh_token');
    if (!refreshToken) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/auth/login';
      return NextResponse.redirect(loginUrl);
    }
  }

  // H3: CSRF protection for state-mutating requests to API paths
  const isMutating =
    request.method === 'POST' ||
    request.method === 'PUT' ||
    request.method === 'DELETE' ||
    request.method === 'PATCH';

  if (isMutating && isApi) {
    const authHeader = request.headers.get('authorization');
    const hasBearerToken = authHeader?.startsWith('Bearer ');
    const hasApiKey = !!request.headers.get('x-api-key');
    const isAuthEndpoint = pathname.startsWith('/api/auth/');
    const isBrowserSdkPath = isBrowserSdkRoute(pathname);

    // Exempt from CSRF:
    // 1. Bearer token requests — programmatic clients (browsers can't attach Bearer cross-origin)
    // 2. API key requests — server-to-server callers (webhooks, automation) authenticate via
    //    x-api-key header; not vulnerable to CSRF (browsers can't attach custom headers cross-origin)
    // 3. Auth endpoints — they validate their own tokens (refresh token, device code, etc.)
    // 4. SSO code exchange — one-time auth code redemption is used by both browser callbacks and
    //    Admin's server-to-server handoff, so it cannot rely on browser Origin/Referer headers
    // 5. Channel webhooks — external platforms (Slack, WhatsApp, etc.) POST without browser
    //    origin headers; they authenticate via per-connection signature verification on the runtime
    // 6. Agent-transfer webhooks — SmartAssist and other contact centers POST without browser headers
    // 7. Voice webhooks — KoreVG feature-server POSTs from a different origin; authenticates via token
    // 8. Browser SDK routes — hosted widgets run on customer domains and authenticate via
    //    SDK public keys, bootstrap artifacts, or SDK session tokens instead of Studio cookies
    const isChannelWebhook = pathname.startsWith('/api/v1/channels/');
    const isAgentTransferWebhook = pathname.startsWith('/api/v1/agent-transfer/webhooks/');
    const isVoiceWebhook = pathname.startsWith('/api/v1/voice/');
    const isSsoExchange = pathname === '/api/sso/exchange';
    if (
      !hasBearerToken &&
      !hasApiKey &&
      !isAuthEndpoint &&
      !isSsoExchange &&
      !isBrowserSdkPath &&
      !isChannelWebhook &&
      !isAgentTransferWebhook &&
      !isVoiceWebhook
    ) {
      const origin = request.headers.get('origin');
      const host = request.headers.get('host');

      if (origin) {
        try {
          const originHost = new URL(origin).host;
          if (originHost !== host) {
            return NextResponse.json({ error: 'CSRF origin mismatch' }, { status: 403 });
          }
        } catch {
          return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
        }
      } else {
        const referer = request.headers.get('referer');
        if (referer) {
          try {
            const refererHost = new URL(referer).host;
            if (refererHost !== host) {
              return NextResponse.json({ error: 'CSRF referer mismatch' }, { status: 403 });
            }
          } catch {
            return NextResponse.json({ error: 'Invalid referer' }, { status: 403 });
          }
        } else {
          return NextResponse.json({ error: 'Missing origin header' }, { status: 403 });
        }
      }
    }
  }

  // ─── Runtime API proxy ──────────────────────────────────────────────────
  // Proxy runtime-bound API paths to RUNTIME_URL (read at request time).
  // This replaces the baked next.config.mjs rewrites that break in Docker standalone.
  if (isApi && isRuntimeProxyPath(pathname)) {
    const runtimeUrl = getRuntimeUrl();
    const target = new URL(pathname + request.nextUrl.search, runtimeUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  if (isRuntimePublicProxyPath(pathname)) {
    const runtimeUrl = getRuntimeUrl();
    const target = new URL(pathname + request.nextUrl.search, runtimeUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  // ─── SearchAI service proxy (local dev + fallback) ──────────────────────
  // In PRODUCTION: NGINX ingress routes /api/indexes, /api/search, etc.
  // directly to SearchAI Engine/Runtime services. The browser uses relative
  // URLs (e.g. /api/indexes/...) which ingress matches before Studio's
  // catch-all /api rule. These rewrites are NOT hit in production.
  //
  // In LOCAL DEV: api-client.ts rewrites /api/search-ai/* to absolute
  // localhost URLs when NEXT_PUBLIC_SEARCH_AI_URL is set. These proxy
  // rewrites serve as fallback for stray fetch() calls that bypass apiFetch().
  //
  // In both cases, the /api/search-ai/ and /api/search-ai-runtime/ prefixes
  // are Studio-internal conventions — they don't exist on the actual services.
  if (isApi && pathname.startsWith('/api/search-ai/')) {
    const searchAIUrl =
      process.env.SEARCH_AI_URL || process.env.SEARCH_AI_ENGINE_URL || 'http://localhost:3005';
    const targetPath = '/api/' + pathname.slice('/api/search-ai/'.length);
    const target = new URL(targetPath + request.nextUrl.search, searchAIUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  if (isApi && pathname.startsWith('/api/search-ai-runtime/')) {
    const searchAIRuntimeUrl = process.env.SEARCH_AI_RUNTIME_URL || 'http://localhost:3004';
    const targetPath = '/api/' + pathname.slice('/api/search-ai-runtime/'.length);
    const target = new URL(targetPath + request.nextUrl.search, searchAIRuntimeUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  // Runtime service proxy — same pattern as search-ai above.
  // Local dev: rewrites the `/api/runtime/*` prefixes listed in
  // RUNTIME_PASSTHROUGH_PREFIXES to the runtime server at RUNTIME_URL.
  // Production: NGINX ingress is expected to handle /api/runtime/* → runtime.
  //
  // Allowlist (not denylist): middleware runs BEFORE App Router handlers, so
  // any path we rewrite here becomes unreachable for its Studio handler.
  // Studio-owned runtime handlers (analytics, insights, pipeline-analytics,
  // sessions, sdk-channels) do auth + query→path translation and must run in
  // App Router — they do NOT match any passthrough prefix, so they fall
  // through to their route handlers below.
  if (isApi && isRuntimePassthroughPath(pathname)) {
    const runtimeUrl = getRuntimeUrl();
    const targetPath = '/api/' + pathname.slice('/api/runtime/'.length);
    const target = new URL(targetPath + request.nextUrl.search, runtimeUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  // Crawl progress — HTTP fallback only (REST endpoints under this path).
  // WebSocket upgrades CANNOT be proxied via NextResponse.rewrite().
  // In K8s, the search-ai ingress rewrites /api/search-ai/* → /api/* and
  // forwards to the search-ai service (bypassing Studio for WS upgrades).
  // This rewrite only applies in local dev for non-WebSocket requests.
  // Supports both prefixed (/api/search-ai/admin/progress/) and legacy
  // unprefixed (/api/admin/progress/) paths for backward compatibility.
  if (
    isApi &&
    (pathname.startsWith('/api/search-ai/admin/progress/') ||
      pathname.startsWith('/api/admin/progress/'))
  ) {
    const searchAIUrl =
      process.env.SEARCH_AI_URL || process.env.SEARCH_AI_ENGINE_URL || 'http://localhost:3005';
    // Strip /api/search-ai prefix when proxying to backend (backend serves /api/* natively)
    const backendPath = pathname.startsWith('/api/search-ai/')
      ? `/api/${pathname.slice('/api/search-ai/'.length)}`
      : pathname;
    const target = new URL(backendPath + request.nextUrl.search, searchAIUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  // ─── Template Store service proxy ──────────────────────────────────────
  // Proxy template-store API paths to the Template Store service.
  // Strips the /api/template-store/ prefix and prepends /api/v1/.
  if (isApi && pathname.startsWith('/api/template-store/')) {
    const templateStoreUrl = process.env.TEMPLATE_STORE_URL || 'http://localhost:3115';
    const targetPath = '/api/v1/' + pathname.slice('/api/template-store/'.length);
    const target = new URL(targetPath + request.nextUrl.search, templateStoreUrl);
    const response = NextResponse.rewrite(target);
    addSecurityHeaders(response);
    return response;
  }

  // Turbopack workaround: rewrite /api/projects/{id}/tools/{toolId}/test to the
  // 4-segment handler /api/tool-test/{projectId}/{toolId} which Turbopack resolves.
  // withRouteHandler reads params.projectId as the project ID (falls back from params.id).
  const toolTestMatch = isApi && TOOL_TEST_PATH_RE.exec(pathname);
  if (toolTestMatch) {
    const [, projectId, toolId] = toolTestMatch;
    const url = request.nextUrl.clone();
    url.pathname = `/api/tool-test/${projectId}/${toolId}`;
    const response = NextResponse.rewrite(url);
    addSecurityHeaders(response);
    return response;
  }

  // SPA catch-all: rewrite non-API/auth/special paths to / for client-side routing
  // Preview, softphone automation, onboarding, and browse-preview pages are standalone App Router pages — don't rewrite them to the SPA shell
  if (
    !isApi &&
    !isAuth &&
    !isInvite &&
    !isOAuth &&
    !isOnboarding &&
    !isPreview &&
    !isSoftphoneAutomation &&
    !isBrowsePreview &&
    !isSourcePage &&
    !isHealth &&
    !isAgentAnatomy &&
    !isDocs &&
    !isAcademy &&
    !isMarketplace &&
    !isNextInternal &&
    !isPublicStaticAsset &&
    pathname !== '/'
  ) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    const response = NextResponse.rewrite(url);
    addSecurityHeaders(response);
    return response;
  }

  const response = NextResponse.next();
  addSecurityHeaders(response);
  return response;
}

function addSecurityHeaders(response: NextResponse): void {
  // L4: Always generate request ID server-side
  const requestId = crypto.randomUUID();
  response.headers.set('x-request-id', requestId);

  // Security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // M7: HSTS with preload
  response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // M7: Permissions-Policy — allow microphone for LiveKit voice preview
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=(), payment=()',
  );

  // C1: CSP - conditional unsafe-eval for development only
  const isDev = process.env.NODE_ENV === 'development';
  // Monaco Editor loads from cdn.jsdelivr.net (used by @monaco-editor/react)
  // Swagger UI loads from unpkg.com (used by OpenAPI docs)
  // Next.js production builds require 'unsafe-inline' for inline scripts
  const scriptSrc = isDev
    ? "'self' 'unsafe-eval' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com"
    : "'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com";

  // Derive runtime connect-src from env (supports any deployment URL).
  // Prefer the public Runtime base when configured; fall back to the server-side
  // Runtime URL only when that's the only available value.
  const runtimeUrl =
    process.env.RUNTIME_PUBLIC_BASE_URL ??
    process.env.NEXT_PUBLIC_RUNTIME_URL ??
    process.env.RUNTIME_URL ??
    '';
  const runtimeWsUrl = process.env.RUNTIME_WS_URL ?? process.env.NEXT_PUBLIC_RUNTIME_WS_URL ?? '';
  const livekitUrl = process.env.LIVEKIT_URL ?? process.env.NEXT_PUBLIC_LIVEKIT_URL ?? '';
  const connectSources = ["'self'", 'https://accounts.google.com'];
  if (runtimeUrl) {
    connectSources.push(runtimeUrl);
    connectSources.push(runtimeUrl.replace(/^http/, 'ws'));
  }
  if (runtimeWsUrl) {
    connectSources.push(runtimeWsUrl);
    connectSources.push(runtimeWsUrl.replace(/^ws/, 'http'));
  }
  // LiveKit WebRTC needs wss:// and https:// to the LiveKit server
  if (livekitUrl) {
    connectSources.push(livekitUrl);
    connectSources.push(livekitUrl.replace(/^wss?:/, 'https:'));
    connectSources.push(livekitUrl.replace(/^https?:/, 'wss:'));
  }

  // Softphone WebRTC needs wss:// to the Jambonz SBC for SIP over WebSocket
  const sbcWsAddress = process.env.JAMBONZ_SBC_WS_ADDRESS ?? '';
  if (sbcWsAddress) {
    const sbcWsPort = process.env.JAMBONZ_SBC_WS_PORT ?? '8443';
    for (const addr of sbcWsAddress.split(',')) {
      const host = addr.trim().split(':')[0];
      if (host) connectSources.push(`wss://${host}:${sbcWsPort}`);
    }
  }

  // Dev-mode fallback: ensure runtime localhost is always reachable
  if (isDev && !runtimeUrl && !runtimeWsUrl) {
    connectSources.push('http://localhost:3112', 'ws://localhost:3112');
  }

  // SearchAI direct-call origins (local dev: api-client.ts calls services directly)
  const searchAiUrl = process.env.NEXT_PUBLIC_SEARCH_AI_URL ?? '';
  const searchAiRuntimeUrl = process.env.NEXT_PUBLIC_SEARCH_AI_RUNTIME_URL ?? '';
  if (searchAiUrl) connectSources.push(searchAiUrl);
  if (searchAiRuntimeUrl) connectSources.push(searchAiRuntimeUrl);

  // Monaco Editor CDN needs to be in connect-src for worker/resource loading
  connectSources.push('https://cdn.jsdelivr.net');

  // VAD (Voice Activity Detection) loads ONNX WASM models from unpkg via fetch()
  connectSources.push('https://unpkg.com');

  // M8: Restricted img-src; media-src blob: required for LiveKit WebRTC audio
  // worker-src blob: required for Monaco Editor web workers
  response.headers.set(
    'Content-Security-Policy',
    `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com; img-src 'self' data: blob: https://*.googleusercontent.com https://*.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; media-src 'self' blob:; worker-src 'self' blob:; connect-src ${connectSources.join(' ')}; frame-ancestors 'none';`,
  );
}

export const config = {
  matcher: [
    // Match API routes and pages. Public static assets with file extensions are
    // allowed through inside proxy() so test hosts and other public files are
    // not redirected or rewritten to the SPA shell.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
