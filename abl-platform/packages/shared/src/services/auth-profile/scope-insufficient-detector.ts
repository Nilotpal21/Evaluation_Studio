/**
 * Scope Insufficient Detector
 *
 * Pure function that detects OAuth `insufficient_scope` errors from provider
 * HTTP responses. Parses granted vs. missing scopes from standard error
 * bodies and WWW-Authenticate headers.
 *
 * Used by both the runtime tool-execution path (FR-29 path B) and the Studio
 * OAuth callback (FR-29 path A).
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface ScopeInsufficientResult {
  granted: string[];
  missing: string[];
}

export interface ProviderResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function parseSpaceSeparatedScopes(value: string | undefined | null): string[] {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseScopesFromWwwAuthenticate(headerValue: string): {
  scopes: string[];
  found: boolean;
} {
  // WWW-Authenticate: Bearer realm="example", scope="read write", error="insufficient_scope"
  const scopeMatch = /scope="([^"]+)"/i.exec(headerValue);
  if (scopeMatch) {
    return {
      scopes: parseSpaceSeparatedScopes(scopeMatch[1]),
      found: true,
    };
  }

  // Some providers use unquoted scope=...
  const unquotedMatch = /scope=([^\s,]+)/i.exec(headerValue);
  if (unquotedMatch) {
    return {
      scopes: parseSpaceSeparatedScopes(unquotedMatch[1]),
      found: true,
    };
  }

  return { scopes: [], found: false };
}

function isInsufficientScopeError(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;

  const bodyRecord = body as Record<string, unknown>;

  // Standard OAuth2 error response: { "error": "insufficient_scope" }
  if (bodyRecord.error === 'insufficient_scope') return true;

  // Some providers nest: { "error": { "type": "insufficient_scope" } }
  if (
    typeof bodyRecord.error === 'object' &&
    bodyRecord.error !== null &&
    (bodyRecord.error as Record<string, unknown>).type === 'insufficient_scope'
  ) {
    return true;
  }

  return false;
}

function extractScopesFromBody(body: unknown): {
  granted: string[];
  missing: string[];
} {
  if (typeof body !== 'object' || body === null) {
    return { granted: [], missing: [] };
  }

  const bodyRecord = body as Record<string, unknown>;

  // Parse granted scopes from body.scope or body.granted_scopes
  let granted: string[] = [];
  if (typeof bodyRecord.scope === 'string') {
    granted = parseSpaceSeparatedScopes(bodyRecord.scope);
  } else if (Array.isArray(bodyRecord.scope)) {
    granted = bodyRecord.scope.filter((s): s is string => typeof s === 'string');
  } else if (typeof bodyRecord.granted_scopes === 'string') {
    granted = parseSpaceSeparatedScopes(bodyRecord.granted_scopes);
  } else if (Array.isArray(bodyRecord.granted_scopes)) {
    granted = bodyRecord.granted_scopes.filter((s): s is string => typeof s === 'string');
  }

  // Parse missing scopes from body.error_description or body.required_scopes
  let missing: string[] = [];
  if (typeof bodyRecord.error_description === 'string') {
    // Common pattern: "The access token does not have the required scope: read:org"
    const descScopeMatch = /scope[s]?:\s*(.+)/i.exec(bodyRecord.error_description);
    if (descScopeMatch) {
      missing = parseSpaceSeparatedScopes(descScopeMatch[1]);
    }
  }
  if (missing.length === 0 && typeof bodyRecord.required_scopes === 'string') {
    missing = parseSpaceSeparatedScopes(bodyRecord.required_scopes);
  }
  if (missing.length === 0 && Array.isArray(bodyRecord.required_scopes)) {
    missing = bodyRecord.required_scopes.filter((s): s is string => typeof s === 'string');
  }

  return { granted, missing };
}

function deduplicateStrings(arr: string[]): string[] {
  const seen: string[] = [];
  for (const item of arr) {
    if (!seen.includes(item)) {
      seen.push(item);
    }
  }
  return seen;
}

// ─── Detector ─────────────────────────────────────────────────────────

/**
 * Detect an OAuth `insufficient_scope` error from a provider HTTP response.
 *
 * Detection criteria:
 * - HTTP 401 or 403
 * - AND one of:
 *   - body.error === 'insufficient_scope'
 *   - WWW-Authenticate header includes `scope=...`
 *
 * @returns Parsed scope info if an insufficient_scope error is detected, null otherwise.
 */
export function detectInsufficientScope(
  response: ProviderResponse,
): ScopeInsufficientResult | null {
  // Only check 401/403 responses
  if (response.status !== 401 && response.status !== 403) {
    return null;
  }

  const bodyIsScope = isInsufficientScopeError(response.body);
  const wwwAuth = response.headers?.['www-authenticate'] ?? response.headers?.['WWW-Authenticate'];
  const wwwAuthResult = wwwAuth ? parseScopesFromWwwAuthenticate(wwwAuth) : null;

  // Must be a scope error from body or WWW-Authenticate
  const isWwwAuthScope =
    wwwAuthResult?.found === true || (wwwAuth !== undefined && /insufficient_scope/i.test(wwwAuth));

  if (!bodyIsScope && !isWwwAuthScope) {
    return null;
  }

  // Extract scope information
  const bodyScopes = extractScopesFromBody(response.body);

  // Merge with WWW-Authenticate scopes (deduplicate)
  const allMissing = [...bodyScopes.missing, ...(wwwAuthResult?.scopes ?? [])];

  return { granted: bodyScopes.granted, missing: deduplicateStrings(allMissing) };
}
