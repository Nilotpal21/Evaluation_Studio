/**
 * API Interceptor — Capture XHR/Fetch requests during Playwright navigation
 *
 * Hooks into Playwright's `page.route()` to passively capture API calls
 * made by the page during browser exploration. Detects patterns in
 * intercepted URLs (pagination, search endpoints, data feeds) that
 * can be used for fan-out discovery.
 *
 * Pure interception — does not modify requests or responses.
 */

import type { Page, Route, Request } from 'playwright';

// ─── Types ──────────────────────────────────────────────────────────

/** A single intercepted API call */
export interface InterceptedApi {
  /** Full request URL */
  url: string;
  /** HTTP method */
  method: string;
  /** Content type of the response */
  contentType: string;
  /** Response status code */
  status: number;
  /** Response body size in bytes (approximate) */
  bodySize: number;
  /** Whether the response appears to contain structured data (JSON/XML) */
  isStructured: boolean;
  /** Timestamp of the request */
  timestamp: number;
  /** Request headers (selected useful ones only) */
  headers: Record<string, string>;
}

/** A detected API pattern from multiple intercepted calls */
export interface ApiPattern {
  /** URL template with variable segments replaced by {} */
  urlTemplate: string;
  /** Base path shared across matching calls */
  basePath: string;
  /** HTTP method */
  method: string;
  /** Number of calls matching this pattern */
  callCount: number;
  /** Whether this looks like a paginated endpoint */
  isPaginated: boolean;
  /** Query parameters that varied across calls (likely pagination/filter params) */
  variableParams: string[];
  /** Query parameters that stayed constant */
  fixedParams: Record<string, string>;
  /** Example URLs matching this pattern */
  examples: string[];
}

/** Result of API interception during a navigation session */
export interface ApiInterceptionResult {
  /** All intercepted API calls */
  calls: InterceptedApi[];
  /** Detected API patterns */
  patterns: ApiPattern[];
  /** Total number of requests intercepted */
  totalIntercepted: number;
  /** Number of structured (JSON/XML) responses */
  structuredCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────

/** Content types that indicate structured data */
const STRUCTURED_CONTENT_TYPES = [
  'application/json',
  'application/xml',
  'text/xml',
  'application/ld+json',
  'application/graphql',
];

/** URL patterns to skip (static assets, tracking, etc.) */
const SKIP_PATTERNS = [
  /\.(js|css|woff2?|ttf|eot|svg|png|jpe?g|gif|ico|webp|avif)(\?|$)/i,
  /google-analytics\.com/,
  /googletagmanager\.com/,
  /facebook\.com\/tr/,
  /analytics\./,
  /doubleclick\.net/,
  /hotjar\.com/,
  /sentry\.io/,
  /cdn\./,
  /fonts\.googleapis\.com/,
  /cloudflare/,
];

/** Headers worth capturing from requests */
const CAPTURED_HEADERS = [
  'accept',
  'content-type',
  'authorization',
  'x-api-key',
  'x-requested-with',
];

/** Max API calls to store (prevent memory blow-up on chatty pages) */
const MAX_INTERCEPTED_CALLS = 500;

/** Pagination-related query parameter names */
const PAGINATION_PARAMS = new Set([
  'page',
  'p',
  'offset',
  'start',
  'skip',
  'cursor',
  'after',
  'before',
  'limit',
  'per_page',
  'pagesize',
  'page_size',
  'pagenum',
  'pagenumber',
]);

// ─── Interceptor Setup ──────────────────────────────────────────────

/**
 * Attach API interception to a Playwright page.
 *
 * Returns a handle with:
 * - `getResult()` to retrieve intercepted calls and detected patterns
 * - `detach()` to remove the interception hooks
 *
 * Must be called BEFORE page.goto() or exploreNavigation() so that
 * initial page load requests are also captured.
 */
export async function attachApiInterceptor(
  page: Page,
  domain: string,
): Promise<ApiInterceptorHandle> {
  const calls: InterceptedApi[] = [];
  let totalIntercepted = 0;

  // Route handler — passively observes requests then forwards them
  const routeHandler = async (route: Route, request: Request) => {
    // Fetch the real response so we can inspect it
    const response = await route.fetch().catch((_fetchErr: unknown) => null);

    try {
      if (response) {
        await route.fulfill({ response });
      } else {
        // Fetch failed (network error, aborted, etc.) — let the browser handle it
        await route.continue();
        return;
      }
    } catch {
      // Route already handled (e.g., by navigation or another handler) — skip
      return;
    }

    totalIntercepted++;

    const url = request.url();

    // Skip static assets and tracking
    if (SKIP_PATTERNS.some((p) => p.test(url))) return;

    // Only capture same-domain or API-like requests
    let requestUrl: URL;
    try {
      requestUrl = new URL(url);
    } catch (_parseErr: unknown) {
      return;
    }

    const isSameDomain =
      requestUrl.hostname === domain || requestUrl.hostname.endsWith('.' + domain);
    const isApiLike =
      requestUrl.pathname.includes('/api/') ||
      requestUrl.pathname.includes('/v1/') ||
      requestUrl.pathname.includes('/v2/');

    if (!isSameDomain && !isApiLike) return;

    // Skip non-XHR requests (navigations, etc.)
    const resourceType = request.resourceType();
    if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

    if (calls.length >= MAX_INTERCEPTED_CALLS) return;

    const contentType = response.headers()['content-type'] ?? '';
    const isStructured = STRUCTURED_CONTENT_TYPES.some((ct) => contentType.includes(ct));

    // Capture selected headers
    const requestHeaders = request.headers();
    const headers: Record<string, string> = {};
    for (const h of CAPTURED_HEADERS) {
      if (requestHeaders[h]) {
        // Redact auth values
        if (h === 'authorization' || h === 'x-api-key') {
          headers[h] = '[REDACTED]';
        } else {
          headers[h] = requestHeaders[h];
        }
      }
    }

    const bodyBuffer = await response.body().catch((_bodyErr: unknown) => null);

    calls.push({
      url,
      method: request.method(),
      contentType,
      status: response.status(),
      bodySize: bodyBuffer?.length ?? 0,
      isStructured,
      timestamp: Date.now(),
      headers,
    });
  };

  // Attach the route handler to intercept all requests
  await page.route('**/*', routeHandler);

  return {
    getResult(): ApiInterceptionResult {
      const patterns = detectApiPatterns(calls);
      return {
        calls: [...calls],
        patterns,
        totalIntercepted,
        structuredCount: calls.filter((c) => c.isStructured).length,
      };
    },

    async detach(): Promise<void> {
      await page.unroute('**/*', routeHandler).catch((_detachErr: unknown) => {
        // Page may already be closed — safe to ignore
      });
    },
  };
}

/** Handle returned by attachApiInterceptor */
export interface ApiInterceptorHandle {
  /** Get the current interception results */
  getResult(): ApiInterceptionResult;
  /** Remove the interception hooks */
  detach(): Promise<void>;
}

// ─── Pattern Detection ──────────────────────────────────────────────

/**
 * Detect API patterns from intercepted calls.
 *
 * Groups calls by their path structure (ignoring variable segments like IDs),
 * then identifies pagination patterns and variable query params.
 */
function detectApiPatterns(calls: InterceptedApi[]): ApiPattern[] {
  // Only analyze structured (JSON/XML) responses with success status
  const structured = calls.filter((c) => c.isStructured && c.status >= 200 && c.status < 300);
  if (structured.length === 0) return [];

  // Group by method + path template
  const groups = new Map<string, InterceptedApi[]>();

  for (const call of structured) {
    const parsed = parseApiUrl(call.url);
    if (!parsed) continue;

    const key = `${call.method}:${parsed.template}`;
    const existing = groups.get(key) ?? [];
    existing.push(call);
    groups.set(key, existing);
  }

  const patterns: ApiPattern[] = [];

  for (const [key, groupCalls] of groups) {
    const [method, template] = key.split(':', 2);

    // Analyze query parameter variation across calls
    const paramValues = new Map<string, Set<string>>();
    for (const call of groupCalls) {
      const url = new URL(call.url);
      for (const [param, value] of url.searchParams) {
        const values = paramValues.get(param) ?? new Set();
        values.add(value);
        paramValues.set(param, values);
      }
    }

    const variableParams: string[] = [];
    const fixedParams: Record<string, string> = {};
    let isPaginated = false;

    for (const [param, values] of paramValues) {
      if (values.size > 1) {
        variableParams.push(param);
        if (PAGINATION_PARAMS.has(param.toLowerCase())) {
          isPaginated = true;
        }
      } else {
        const [value] = values;
        fixedParams[param] = value;
      }
    }

    // Extract base path from the template
    const templatePath = template.split('?')[0];

    patterns.push({
      urlTemplate: template,
      basePath: templatePath,
      method,
      callCount: groupCalls.length,
      isPaginated,
      variableParams,
      fixedParams,
      examples: groupCalls.slice(0, 3).map((c) => c.url),
    });
  }

  // Sort by call count (most frequent first)
  patterns.sort((a, b) => b.callCount - a.callCount);

  return patterns;
}

/**
 * Parse an API URL into a template by replacing variable path segments.
 *
 * Variable segments: UUIDs, numeric IDs, long hex strings, slugs with digits.
 */
function parseApiUrl(raw: string): { template: string } | null {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split('/').filter(Boolean);

    const templateSegments = segments.map((seg) => {
      // UUID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{}';
      // Pure numeric (3+ digits)
      if (/^\d{3,}$/.test(seg)) return '{}';
      // Long hex
      if (/^[0-9a-f]{8,}$/i.test(seg) && !/[g-zG-Z]/.test(seg)) return '{}';
      // Very long segment
      if (seg.length > 30) return '{}';
      return seg;
    });

    const template = '/' + templateSegments.join('/');
    return { template };
  } catch (_parseErr: unknown) {
    return null;
  }
}
