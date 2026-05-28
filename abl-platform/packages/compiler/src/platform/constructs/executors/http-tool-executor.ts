/**
 * HTTP Tool Executor
 *
 * Executes HTTP-bound tools from agent IR with full resilience:
 * rate limiting, circuit breaker, retry, and auth resolution.
 *
 * SECURITY:
 * - SSRF protection: blocks private IPs, cloud metadata, non-HTTP schemes
 * - Secret resolution: properly resolves {{secrets.KEY}} placeholders
 * - Header sanitization: strips CRLF to prevent header injection
 * - OAuth HTTPS enforcement
 * - Error response truncation to prevent info leakage
 * - Bounded OAuth token cache
 */

import type { ToolDefinition, HttpBindingIR, ToolParameter } from '../../ir/schema.js';
import type { SecretsProvider } from './secrets-provider.js';
import type { ICircuitBreaker, IRateLimiter, ResilienceFactory } from './resilience-interfaces.js';
import { createDefaultResilienceFactory } from './resilience-interfaces.js';
import type { TokenCache } from './shared-token-cache.js';
import { InMemoryTokenCache } from './shared-token-cache.js';
import type { ProxyConfig, ProxyResolver } from './proxy-resolver.js';
import { signHttpToolRequest } from './http-tool-sigv4.js';
import { stringifyJsonTemplateValue } from './json-template-utils.js';
import { resolveSessionPlaceholders as resolveSessionPlaceholdersShared } from './session-placeholder-utils.js';
import {
  resolveHttpBindingRuntimeNumericFields,
  type ResolvedHttpBindingIR,
} from './runtime-numeric-values.js';
import { createLogger } from '../../logger.js';
import type { ToolExecutionOptions } from './tool-middleware.js';
import {
  type SoapHttpBindingIR,
  SOAP_CONTENT_TYPES,
  xmlEscape,
  renderSoapRequest,
  parseSoapResponse,
} from './soap-envelope.js';
import { ToolExecutionError, OAUTH_TOKEN_TIMEOUT_MS } from '@agent-platform/shared';
import {
  SSRFError,
  assertUrlSafeForFetch,
  safeFetch,
  type SafeFetchOptions,
} from '@agent-platform/shared-kernel/security/safe-fetch';
import { applyDigestAuth } from '@agent-platform/auth-enterprise';
import { normalizeAuthType } from '@agent-platform/shared/validation';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext, type SecureContextOptions } from 'node:tls';

const log = createLogger('http-tool-executor');

export interface AsyncHttpExecutionResult {
  __toolExecutionStatus: 'completed' | 'accepted';
  output: unknown;
  responseStatus: number;
}

// =============================================================================
// HTTP TRACE (file-based debug traces, gated by MCP_TRACE env var)
// =============================================================================

const HTTP_TRACE_DIR = join(process.cwd(), 'http-traces');

function dumpHttpTrace(entry: Record<string, unknown>): void {
  if (process.env.MCP_TRACE !== 'true') return;
  try {
    if (!existsSync(HTTP_TRACE_DIR)) mkdirSync(HTTP_TRACE_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const file = join(HTTP_TRACE_DIR, `${dateStr}.jsonl`);
    appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (err) {
    log.warn('Failed to write HTTP trace', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Keys whose values must be redacted in trace headers (case-insensitive match on header name). */
const TRACE_REDACT_HEADER_PATTERNS = ['authorization', 'secret', 'token', 'password'];
function shouldRedactHeader(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACE_REDACT_HEADER_PATTERNS.some((p) => lower === p || lower.includes(p));
}

/** Convert headers (Record or Headers) into a plain object for trace logging. */
function headersToRecord(
  headers: Record<string, string> | Headers | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (typeof headers === 'object' && !(headers instanceof Headers)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      out[k] = shouldRedactHeader(k) ? '[REDACTED]' : v;
    }
    return out;
  }
  const out: Record<string, string> = {};
  (headers as Headers).forEach((v: string, k: string) => {
    out[k] = shouldRedactHeader(k) ? '[REDACTED]' : v;
  });
  return out;
}

/** Strip top-level body fields whose keys contain "secret" — for trace safety. */
function redactSecretsFromTraceBody(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    result[k] = k.toLowerCase().includes('secret') ? '[REDACTED]' : v;
  }
  return result;
}

type HeadersLike =
  | Headers
  | Record<string, string>
  | {
      get?(name: string): string | null;
      forEach?(callback: (value: string, key: string) => void): void;
      entries?(): Iterable<[string, string]>;
    };

/** Convert a fetch Response's headers into a plain object for trace logging. */
function responseHeadersToRecord(headers: HeadersLike | undefined): Record<string, string> {
  const out: Record<string, string> = {};

  if (!headers) return out;

  if (typeof headers.forEach === 'function') {
    headers.forEach((v: string, k: string) => {
      out[k] = v;
    });
    return out;
  }

  if (typeof headers.entries === 'function') {
    for (const [k, v] of headers.entries()) {
      out[k] = v;
    }
    return out;
  }

  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k] = v;
  }

  return out;
}

function toHeadersObject(headers: RequestInit['headers'] | undefined): Headers {
  return new Headers(headers ?? {});
}

type AuthSignRequestFn = (assembled: {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
}) => Promise<Headers>;

interface DigestRetryCredentials {
  username: string;
  password: string;
  realm: string;
}

interface InternalAuthBinding extends HttpBindingIR {
  _authSignRequest?: AuthSignRequestFn;
  _digestCredentials?: DigestRetryCredentials;
}

// =============================================================================
// ENV-VAR-BACKED CONFIGURATION HELPERS
// =============================================================================

/** Parse an integer from an env var, returning the fallback on missing/NaN */
function safeParseInt(val: string | undefined, fallback: number): number {
  if (!val) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// =============================================================================
// SECURITY: SSRF Protection — delegated to @agent-platform/shared-kernel/security
// =============================================================================

/** Default maximum response body size (10 MB) */
const DEFAULT_MAX_RESPONSE_BYTES = safeParseInt(
  process.env.HTTP_TOOL_MAX_RESPONSE_BYTES,
  10 * 1024 * 1024,
);

/** Maximum error response body length to include in error messages */
const MAX_ERROR_BODY_LENGTH = safeParseInt(process.env.HTTP_TOOL_MAX_ERROR_BODY_LENGTH, 256);

/** Maximum retries to prevent unbounded loops from IR misconfiguration */
const MAX_RETRY_CAP = safeParseInt(process.env.HTTP_TOOL_MAX_RETRY_CAP, 10);

/** Max entries per resilience Map (evict oldest when exceeded) */
const MAX_RESILIENCE_MAP_ENTRIES = safeParseInt(
  process.env.HTTP_TOOL_MAX_RESILIENCE_MAP_ENTRIES,
  2_000,
);

const HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST = process.env.HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST === 'true';

const BODY_TYPE_CONTENT_TYPES: Record<NonNullable<HttpBindingIR['body_type']>, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
  xml: 'application/xml',
  text: 'text/plain',
};

/** Maximum number of redirect hops to follow manually */
const MAX_REDIRECT_HOPS = safeParseInt(process.env.HTTP_TOOL_MAX_REDIRECT_HOPS, 5);
const REDIRECT_STATUS_CODES = [301, 302, 303, 307, 308] as const;

/**
 * Sanitize a header value by stripping CRLF sequences to prevent header injection.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/** Result shape when a response exceeds the size limit and is gracefully truncated. */
interface TruncatedResponse {
  data: unknown;
  truncated: true;
  originalSize: number;
  warning: string;
}

/** Parse JSON without throwing — returns the string as-is on failure (for truncated payloads). */
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function collectErrorIndicators(error: unknown): string[] {
  const indicators: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      indicators.push(current.message);
      if ('code' in current && typeof (current as { code?: unknown }).code === 'string') {
        indicators.push((current as { code: string }).code);
      }
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (typeof record.message === 'string') {
        indicators.push(record.message);
      }
      if (typeof record.code === 'string') {
        indicators.push(record.code);
      }
      current = record.cause;
      continue;
    }

    break;
  }

  return indicators;
}

function isSSRFBlockedError(error: unknown): boolean {
  return (
    error instanceof SSRFError ||
    (error instanceof Error && error.name === 'SSRFError') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'SSRF_BLOCKED')
  );
}

function buildProxyAuthorizationHeader(proxyConfig: ProxyConfig): string | undefined {
  switch (proxyConfig.authType) {
    case 'basic':
      if (proxyConfig.username && proxyConfig.password) {
        const credentials = Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString(
          'base64',
        );
        return `Basic ${credentials}`;
      }
      return undefined;
    case 'bearer':
      return proxyConfig.token ? `Bearer ${proxyConfig.token}` : undefined;
    case 'api_key':
      return proxyConfig.token;
    case 'none':
    default:
      return undefined;
  }
}

function safeUrlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '[unknown endpoint]';
  }
}

/**
 * Redact WS-Security credential material before logging the SOAP request body.
 * The PasswordDigest is a SHA-1 over Nonce + Created + plaintext password — the
 * three together are sufficient to mount an offline brute-force attack on the
 * password. Strip `<wsse:Password>`, `<wsse:Nonce>`, and `<wsse:BinarySecurityToken>`
 * element bodies from any string before it reaches the trace store.
 */
export function redactWsSecurityForTrace(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  return body
    .replace(/(<wsse:Password\b[^>]*>)[^<]*(<\/wsse:Password>)/g, '$1[REDACTED]$2')
    .replace(/(<wsse:Nonce\b[^>]*>)[^<]*(<\/wsse:Nonce>)/g, '$1[REDACTED]$2')
    .replace(
      /(<wsse:BinarySecurityToken\b[^>]*>)[\s\S]*?(<\/wsse:BinarySecurityToken>)/g,
      '$1[REDACTED]$2',
    );
}

async function discardRedirectBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort: redirect bodies are not part of the caller-visible response.
  }
}

function serializeFormBody(payload: Record<string, unknown>): string {
  const form = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          form.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
        }
      }
      continue;
    }

    form.append(
      key,
      value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value),
    );
  }

  return form.toString();
}

function encodeFormTemplateValue(value: unknown): string {
  const form = new URLSearchParams();
  form.append(
    'value',
    value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value),
  );
  return form.toString().slice('value='.length);
}

function classifyMutualTlsError(error: unknown, toolName: string): ToolExecutionError | null {
  const indicators = collectErrorIndicators(error).join(' | ');
  if (!indicators) {
    return null;
  }

  if (/certificate has expired|cert_has_expired/i.test(indicators)) {
    return new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message: 'mTLS client certificate has expired. Renew the auth profile certificate and retry.',
      toolName,
      toolType: 'http',
      retryable: false,
      cause: error,
    });
  }

  if (
    /pem routines|no start line|bad base64 decode|asn1|unsupported certificate purpose|x509_check_private_key|key values mismatch/i.test(
      indicators,
    )
  ) {
    return new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        'mTLS client certificate or private key is invalid. Fix the auth profile certificate bundle and retry.',
      toolName,
      toolType: 'http',
      retryable: false,
      cause: error,
    });
  }

  if (
    /alert certificate required|certificate required|unknown ca|handshake failure/i.test(indicators)
  ) {
    return new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        'mTLS authentication failed during the TLS handshake. Verify the client certificate, key, and CA chain for this auth profile.',
      toolName,
      toolType: 'http',
      retryable: false,
      cause: error,
    });
  }

  return null;
}

interface ParsedDigestChallenge {
  realm?: string;
  nonce?: string;
  qop?: 'auth' | 'auth-int';
  algorithm?: 'md5' | 'sha-256';
  opaque?: string;
}

function parseDigestChallenge(headerValue: string): ParsedDigestChallenge | null {
  if (!/^\\s*digest\\s+/i.test(headerValue)) {
    return null;
  }

  const result: ParsedDigestChallenge = {};
  const value = headerValue.replace(/^\\s*digest\\s+/i, '');
  const regex = /([a-zA-Z][\\w-]*)\\s*=\\s*(\"([^\"]*)\"|([^,\\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const rawKey = match[1].toLowerCase();
    const rawValue = (match[3] ?? match[4] ?? '').trim();
    switch (rawKey) {
      case 'realm':
        result.realm = rawValue;
        break;
      case 'nonce':
        result.nonce = rawValue;
        break;
      case 'opaque':
        result.opaque = rawValue;
        break;
      case 'qop':
        if (rawValue.split(',').some((entry) => entry.trim() === 'auth-int')) {
          result.qop = 'auth-int';
        } else if (rawValue.split(',').some((entry) => entry.trim() === 'auth')) {
          result.qop = 'auth';
        }
        break;
      case 'algorithm': {
        const lowered = rawValue.toLowerCase();
        if (lowered === 'sha-256' || lowered === 'sha256') {
          result.algorithm = 'sha-256';
        } else if (lowered === 'md5') {
          result.algorithm = 'md5';
        }
        break;
      }
      default:
        break;
    }
  }

  return result.nonce ? result : null;
}

function buildDigestRetryAuthorization(
  request: { url: string; init: RequestInit },
  creds: DigestRetryCredentials,
  challengeHeader: string,
): string | null {
  const parsed = parseDigestChallenge(challengeHeader);
  if (!parsed?.nonce) {
    return null;
  }

  const method = String(request.init.method ?? 'GET').toUpperCase();
  const { headers } = applyDigestAuth(
    {
      realm: parsed.realm ?? creds.realm,
    },
    {
      username: creds.username,
      password: creds.password,
    },
    request.url,
    method,
    {
      nonce: parsed.nonce,
      ...(parsed.algorithm ? { algorithm: parsed.algorithm } : {}),
      ...(parsed.qop ? { qop: parsed.qop } : {}),
      ...(parsed.opaque ? { opaque: parsed.opaque } : {}),
    },
  );

  return headers.Authorization ?? null;
}

function assertMutualTlsUsesHttps(url: string, toolName: string): void {
  if (new URL(url).protocol === 'https:') {
    return;
  }

  throw new ToolExecutionError({
    code: 'TOOL_AUTH_FAILED',
    message:
      'mTLS auth requires an https:// endpoint on the HTTP tool path. The request was blocked before dispatch.',
    toolName,
    toolType: 'http',
    retryable: false,
  });
}

// =============================================================================
// HTTP TOOL EXECUTOR
// =============================================================================

export class HttpToolExecutor {
  private httpTools: Map<string, ToolDefinition>;
  private rateLimiters = new Map<string, IRateLimiter>();
  private circuitBreakers = new Map<string, ICircuitBreaker>();
  private tokenCache: TokenCache;
  private resilienceFactory: ResilienceFactory;
  private secrets: SecretsProvider;
  private defaultTimeoutMs: number;
  private allowLocalhost: boolean;
  private maxResponseBytes: number;
  /** @internal Mutable — set via `setProxyResolver()` when config resolves asynchronously */
  proxyResolver?: ProxyResolver;
  /** Tenant ID for tenant-scoped breakers, limiters, and OAuth cache */
  private tenantId?: string;

  constructor(config: {
    tools: ToolDefinition[];
    secrets: SecretsProvider;
    defaultTimeoutMs?: number;
    resilienceFactory?: ResilienceFactory;
    /** Allow localhost/127.0.0.1 targets (for development only) */
    allowLocalhost?: boolean;
    tokenCache?: TokenCache;
    maxResponseBytes?: number;
    /** Organization-level proxy resolver for routing outbound requests through a gateway */
    proxyResolver?: ProxyResolver;
    /** Tenant ID for tenant-scoped circuit breakers, rate limiters, and OAuth token cache */
    tenantId?: string;
  }) {
    this.secrets = config.secrets;
    this.defaultTimeoutMs =
      config.defaultTimeoutMs ?? safeParseInt(process.env.HTTP_TOOL_DEFAULT_TIMEOUT_MS, 30_000);
    this.allowLocalhost = config.allowLocalhost ?? false;
    this.resilienceFactory = config.resilienceFactory ?? createDefaultResilienceFactory();
    this.tokenCache = config.tokenCache ?? new InMemoryTokenCache();
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.proxyResolver = config.proxyResolver;
    this.tenantId = config.tenantId;
    this.httpTools = new Map();
    for (const tool of config.tools) {
      if (tool.tool_type === 'http' && tool.http_binding) {
        this.httpTools.set(tool.name, tool);
      }
    }
  }

  async execute(
    toolName: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
    overrideTool?: ToolDefinition,
    executionOptions?: ToolExecutionOptions,
  ): Promise<unknown> {
    const tool = overrideTool ?? this.httpTools.get(toolName);
    if (!tool?.http_binding) {
      throw new ToolExecutionError({
        code: 'TOOL_NOT_FOUND',
        message: `HTTP tool not found: ${toolName}`,
        toolName,
        toolType: 'http',
      });
    }

    const binding = await resolveHttpBindingRuntimeNumericFields(
      toolName,
      tool.http_binding,
      this.secrets,
    );
    const effectiveTimeout = timeoutMs ?? binding.timeout_ms ?? this.defaultTimeoutMs;

    // Rate limiting
    if (binding.rate_limit_per_minute) {
      log.debug('HTTP tool acquiring rate limit slot', {
        tool: toolName,
        limit: binding.rate_limit_per_minute,
      });
      const limiter = this.getOrCreateRateLimiter(toolName, binding.rate_limit_per_minute);
      await limiter.acquire();
    }

    // Circuit breaker check
    const breaker = this.getOrCreateCircuitBreaker(toolName, binding);
    if (await breaker.isOpen()) {
      log.warn('HTTP tool circuit breaker open', { tool: toolName });
      throw new ToolExecutionError({
        code: 'TOOL_CIRCUIT_OPEN',
        message: `HTTP tool ${toolName} is temporarily unavailable (circuit breaker open)`,
        toolName,
        toolType: 'http',
        retryable: true,
      });
    }

    // Build request (includes SSRF validation and secret resolution)
    const request = await this.buildRequest(
      binding,
      params,
      toolName,
      tool.parameters,
      executionOptions,
    );
    log.debug(`Built HTTP request for tool execution ${toolName}: ${request.url}`);
    // Execute with retry (capped to prevent unbounded loops)
    const retries = Math.min(binding.retry?.count ?? 0, MAX_RETRY_CAP);
    const retryDelay = binding.retry?.delay_ms ?? 1000;

    log.debug('HTTP tool request', {
      tool: toolName,
      method: binding.method,
      endpoint: binding.endpoint,
      authType: binding.auth?.type,
      retries,
      timeoutMs: effectiveTimeout,
      // FR-10: include protocol fields for SOAP observability
      ...(binding.protocol ? { protocol: binding.protocol } : {}),
      ...(binding.soap_version ? { soap_version: binding.soap_version } : {}),
      ...(binding.soap_action ? { soap_action: binding.soap_action } : {}),
      // Never log header values — may contain Authorization tokens
    });

    const { result, responseStatus } = await this.executeWithRetry(
      toolName,
      request,
      retries,
      retryDelay,
      effectiveTimeout,
      breaker,
      binding,
      params,
    );
    if (executionOptions?.executionMode === 'async_wait') {
      return this.classifyAsyncExecutionResult(responseStatus, result, executionOptions);
    }

    return result;
  }

  private async buildRequest(
    binding: HttpBindingIR,
    params: Record<string, unknown>,
    toolName?: string,
    toolParameters?: ToolParameter[],
    executionOptions?: ToolExecutionOptions,
  ): Promise<{ url: string; init: RequestInit }> {
    // Extract injected context vars (from CONTEXT_ACCESS) and session metadata before request building
    const { _context, _session, ...regularParams } = params;
    const contextVars =
      typeof _context === 'object' && _context !== null
        ? (_context as Record<string, unknown>)
        : undefined;
    const sessionVars =
      typeof _session === 'object' && _session !== null
        ? (_session as Record<string, unknown>)
        : undefined;

    const bodyType = binding.body_type ?? 'json';
    const callback = executionOptions?.callback;
    const callbackConfig = executionOptions?.callbackConfig;
    const asyncCallbackEntries =
      executionOptions?.executionMode === 'async_wait' &&
      callback &&
      callbackConfig &&
      callbackConfig.enabled !== false
        ? {
            [callbackConfig.callbackUrlKey]: callback.url,
            [callbackConfig.callbackSecretKey]: callback.secret,
          }
        : undefined;
    const headers: Record<string, string> = {
      'Content-Type': BODY_TYPE_CONTENT_TYPES[bodyType],
    };
    const paramsCopy = {
      ...regularParams,
      ...(executionOptions?.callbackConfig?.location === 'body' && asyncCallbackEntries
        ? asyncCallbackEntries
        : {}),
    };
    const consumedKeys = new Set<string>();

    // Apply static headers (resolve secrets + env vars + input + context placeholders and sanitize)
    if (binding.headers) {
      for (const [key, value] of Object.entries(binding.headers)) {
        let resolvedKey = await this.resolvePlaceholders(key, paramsCopy, { toolName });
        resolvedKey = this.resolveContextPlaceholders(resolvedKey, contextVars);
        resolvedKey = this.resolveSessionPlaceholders(resolvedKey, sessionVars);
        let resolvedValue = await this.resolvePlaceholders(value, paramsCopy, {
          consumedKeys,
          toolName,
        });
        resolvedValue = this.resolveContextPlaceholders(resolvedValue, contextVars);
        resolvedValue = this.resolveSessionPlaceholders(resolvedValue, sessionVars);
        headers[sanitizeHeaderValue(resolvedKey)] = sanitizeHeaderValue(resolvedValue);
      }
    }

    if (callbackConfig?.location === 'header' && asyncCallbackEntries && callback) {
      headers[sanitizeHeaderValue(callbackConfig.callbackUrlKey)] = sanitizeHeaderValue(
        callback.url,
      );
      headers[sanitizeHeaderValue(callbackConfig.callbackSecretKey)] = sanitizeHeaderValue(
        callback.secret,
      );
    }

    // Apply auth (pass params for template resolution in auth config)
    await this.applyAuth(headers, binding, toolName, paramsCopy);

    // Resolve {{secrets.X}}, {{env.KEY}}, {{input.X}}, {{_context.X}}, and {{session.X}} placeholders in the endpoint URL
    let endpoint = await this.resolvePlaceholders(binding.endpoint, paramsCopy, {
      consumedKeys,
      toolName,
    });
    endpoint = this.resolveContextPlaceholders(endpoint, contextVars);
    endpoint = this.resolveSessionPlaceholders(endpoint, sessionVars);

    // Build URL with path parameter substitution
    // Supports both {param} and {{param}} template syntax
    let url = endpoint.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (_, doubleKey, singleKey) => {
      const key = doubleKey || singleKey;
      const value = paramsCopy[key];
      if (value === undefined || value === null) {
        throw new ToolExecutionError({
          code: 'TOOL_EXECUTION_ERROR',
          message: `Missing required path parameter '${key}' for HTTP tool${toolName ? ` ${toolName}` : ''}`,
          toolName: toolName ?? 'unknown',
          toolType: 'http',
        });
      }
      delete paramsCopy[key];
      return encodeURIComponent(String(value));
    });

    // Append binding-level query_params to URL (all HTTP methods)
    if (binding.query_params) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(binding.query_params)) {
        let resolvedKey = await this.resolvePlaceholders(k, paramsCopy, { toolName });
        resolvedKey = this.resolveContextPlaceholders(resolvedKey, contextVars);
        resolvedKey = this.resolveSessionPlaceholders(resolvedKey, sessionVars);
        let resolvedValue = await this.resolvePlaceholders(v, paramsCopy, {
          consumedKeys,
          toolName,
        });
        resolvedValue = this.resolveContextPlaceholders(resolvedValue, contextVars);
        resolvedValue = this.resolveSessionPlaceholders(resolvedValue, sessionVars);
        searchParams.append(resolvedKey, resolvedValue);
      }
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${searchParams.toString()}`;
    }
    if (callbackConfig?.location === 'query' && asyncCallbackEntries) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(asyncCallbackEntries)) {
        searchParams.append(key, value);
      }
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${searchParams.toString()}`;
    }

    // Remove consumed {{input.X}} keys from paramsCopy so they don't appear in auto-body
    for (const key of consumedKeys) {
      delete paramsCopy[key];
    }

    // For GET without body_template, add remaining params as query string
    if (binding.method === 'GET' && !binding.body_template && Object.keys(paramsCopy).length > 0) {
      const searchParams = new URLSearchParams();
      for (const [k, v] of Object.entries(paramsCopy)) {
        searchParams.append(k, String(v));
      }
      const separator = url.includes('?') ? '&' : '?';
      url = `${url}${separator}${searchParams.toString()}`;
    }

    // SSRF validation on the final URL (after parameter substitution)
    try {
      await assertUrlSafeForFetch(url, { allowLocalhost: this.allowLocalhost });
    } catch (error) {
      if (isSSRFBlockedError(error)) {
        throw new ToolExecutionError({
          code: 'TOOL_SSRF_BLOCKED',
          message: 'HTTP tool target blocked by SSRF protection.',
          toolName: toolName ?? 'unknown',
          toolType: 'http',
          retryable: false,
          cause: error,
        });
      }
      throw error;
    }

    // Final pass: sanitize ALL header values to prevent CRLF injection
    // from parameter-derived or auth-derived values
    for (const [key, value] of Object.entries(headers)) {
      headers[key] = sanitizeHeaderValue(value);
    }

    const init: RequestInit = {
      method: binding.method,
      headers,
    };

    // FR-11: WS-Security auth bound to REST tool — warn, skip injection
    if ((binding as SoapHttpBindingIR)._wsSecurityCredentials && binding.protocol !== 'soap') {
      log.warn('WS_SECURITY_BOUND_TO_REST_TOOL', {
        tool: toolName,
        message:
          'ws_security auth profile referenced on a non-SOAP tool; WS-Security header will not be injected',
      });
    }

    if (binding.method !== 'GET') {
      if (binding.body_template) {
        const isSoap = binding.protocol === 'soap';
        // SOAP tools use XML escaping; JSON/form escaping does not apply to SOAP body templates
        const escapeForJsonBodyTemplate = !isSoap && bodyType === 'json';
        const encodeForFormBodyTemplate = !isSoap && bodyType === 'form';
        const escapeForXmlBodyTemplate = isSoap;
        // Resolve all placeholders in body template (use original params, not paramsCopy)
        let bodyResolved = await this.resolvePlaceholders(binding.body_template, regularParams, {
          toolName,
          escapeForJsonBodyTemplate,
          encodeForFormBodyTemplate,
          escapeForXmlBodyTemplate,
        });
        bodyResolved = this.resolveContextPlaceholders(
          bodyResolved,
          contextVars,
          escapeForJsonBodyTemplate,
          encodeForFormBodyTemplate,
          escapeForXmlBodyTemplate,
        );
        bodyResolved = this.resolveSessionPlaceholders(
          bodyResolved,
          sessionVars,
          escapeForJsonBodyTemplate,
          encodeForFormBodyTemplate,
          escapeForXmlBodyTemplate,
        );

        if (binding.protocol === 'soap') {
          // Resolve all placeholder namespaces in soap_action (same set as regular headers)
          let resolvedSoapAction = binding.soap_action;
          if (resolvedSoapAction) {
            resolvedSoapAction = await this.resolvePlaceholders(resolvedSoapAction, regularParams, {
              toolName,
            });
            resolvedSoapAction = this.resolveContextPlaceholders(resolvedSoapAction, contextVars);
            resolvedSoapAction = this.resolveSessionPlaceholders(resolvedSoapAction, sessionVars);
            resolvedSoapAction = sanitizeHeaderValue(resolvedSoapAction);
          }
          const soapRequest = renderSoapRequest({
            binding: binding as SoapHttpBindingIR,
            resolvedBody: bodyResolved,
            resolvedSoapAction,
          });
          init.body = soapRequest.body;
          headers['Content-Type'] = soapRequest.contentType;
          if (soapRequest.soapActionHeader) {
            headers['SOAPAction'] = soapRequest.soapActionHeader;
          }
          if (HTTP_TOOL_SOAP_DEBUG_RAW_REQUEST) {
            log.debug('SOAP request envelope (debug mode)', {
              tool: toolName,
              body: soapRequest.body,
            });
          }
        } else {
          init.body = bodyResolved;
        }
      } else {
        const bodyPayload =
          contextVars && this.shouldIncludeContextInAutoBody(toolParameters)
            ? { ...paramsCopy, context: contextVars }
            : paramsCopy;
        init.body =
          bodyType === 'form' ? serializeFormBody(bodyPayload) : JSON.stringify(bodyPayload);
      }
    }

    return { url, init };
  }

  private async applyAuth(
    headers: Record<string, string>,
    binding: HttpBindingIR,
    toolName?: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    if (!binding.auth) return;
    const authType = normalizeAuthType(binding.auth.type);
    const config = binding.auth.config;

    switch (authType) {
      case 'api_key': {
        const headerName = config?.headerName
          ? await this.resolvePlaceholders(config.headerName, params, { toolName })
          : 'X-API-Key';
        // Priority: inline apiKey from auth_config → header template → tool-scoped secret
        let key: string | undefined;
        if (config?.apiKey) {
          key = await this.resolvePlaceholders(config.apiKey, params, { toolName });
        }
        if (!key) {
          key = await this.resolveHeaderSecret(headers, headerName, binding, toolName);
        }
        if (key) {
          headers[sanitizeHeaderValue(headerName)] = sanitizeHeaderValue(key);
        } else {
          throw new ToolExecutionError({
            code: 'TOOL_AUTH_FAILED',
            message: `API key secret not found for header "${headerName}" — configure via secrets provider`,
            toolName: binding.endpoint,
            toolType: 'http',
          });
        }
        break;
      }
      case 'bearer': {
        // Priority: inline token from auth_config → header template → tool-scoped secret
        let token: string | undefined;
        if (config?.token) {
          token = await this.resolvePlaceholders(config.token, params, { toolName });
        }
        if (!token) {
          token = await this.resolveHeaderSecret(headers, 'Authorization', binding, toolName);
        }
        if (token) {
          const value = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
          headers['Authorization'] = sanitizeHeaderValue(value);
        } else {
          throw new ToolExecutionError({
            code: 'TOOL_AUTH_FAILED',
            message: 'Bearer token secret not found — configure via secrets provider',
            toolName: binding.endpoint,
            toolType: 'http',
          });
        }
        break;
      }
      case 'oauth2_client':
      case 'oauth2_client_credentials': {
        if (!config?.oauth) {
          throw new ToolExecutionError({
            code: 'TOOL_AUTH_FAILED',
            message: 'OAuth2 client config missing — oauth.tokenUrl, oauth.clientId required',
            toolName: binding.endpoint,
            toolType: 'http',
          });
        }
        const token = await this.getOAuthToken(config.oauth, config.clientSecret, toolName);
        headers['Authorization'] = `Bearer ${sanitizeHeaderValue(token)}`;
        break;
      }
      case 'oauth2_user':
      case 'oauth2_token': {
        const rawProvider = config?.provider || binding.auth.config?.provider || 'default';
        const provider = await this.resolvePlaceholders(rawProvider, params, { toolName });
        const token = await this.secrets.getUserOAuthToken?.('current', provider);
        if (token) {
          headers['Authorization'] = `Bearer ${sanitizeHeaderValue(token)}`;
        } else {
          throw new ToolExecutionError({
            code: 'TOOL_AUTH_FAILED',
            message: `User OAuth token not found for provider "${provider}" — user must authorize first`,
            toolName: binding.endpoint,
            toolType: 'http',
          });
        }
        break;
      }
      case 'custom':
      case 'custom_header': {
        if (config?.customHeaders) {
          for (const [key, value] of Object.entries(config.customHeaders)) {
            const resolved = await this.resolvePlaceholders(value, params, { toolName });
            headers[sanitizeHeaderValue(key)] = sanitizeHeaderValue(resolved);
          }
        }
        break;
      }
      case 'searchai': {
        const token = await this.getSearchAIToken(binding, toolName);
        const headerName = config?.searchai?.headerName || config?.headerName || 'Auth';
        headers[sanitizeHeaderValue(headerName)] = sanitizeHeaderValue(token);
        break;
      }
      case 'none':
      default:
        break;
    }
  }

  private async resolveHeaderSecret(
    headers: Record<string, string>,
    headerName: string,
    binding: HttpBindingIR,
    toolName?: string,
  ): Promise<string | undefined> {
    // Check if the specific header has a template placeholder in the binding headers
    // Supports {{secrets.X}}, {{env.X}}, and mixed templates
    if (binding.headers) {
      // Exact match first
      const headerValue = binding.headers[headerName];
      if (headerValue) {
        const hasTemplate = /\{\{(secrets|env|config)\.\w+\}\}/.test(headerValue);
        if (hasTemplate) {
          return this.resolvePlaceholders(headerValue, undefined, { toolName });
        }
      }
      // Case-insensitive fallback
      for (const [key, value] of Object.entries(binding.headers)) {
        if (key.toLowerCase() === headerName.toLowerCase()) {
          const hasTemplate = /\{\{(secrets|env|config)\.\w+\}\}/.test(value);
          if (hasTemplate) {
            return this.resolvePlaceholders(value, undefined, { toolName });
          }
        }
      }
    }
    // Resolution order: tool-scoped key → generic auth-type key
    // Tool-scoped keys prevent collision when multiple tools use the same auth type
    if (toolName) {
      const toolScoped = await this.secrets.getSecret(`${binding.auth.type}_token_${toolName}`, {
        toolName,
      });
      if (toolScoped) return toolScoped;
    }
    return this.secrets.getSecret(
      `${binding.auth.type}_token`,
      toolName ? { toolName } : undefined,
    );
  }

  /**
   * Resolve {{_context.key}} placeholders from injected context vars.
   * Returns the value as-is if no context vars are available.
   */
  private resolveContextPlaceholders(
    value: string,
    contextVars: Record<string, unknown> | undefined,
    escapeForJsonBodyTemplate = false,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): string {
    if (!contextVars) return value;
    return value.replace(/\{\{_context\.(\w+)\}\}/g, (_, ctxKey) => {
      const ctxValue = contextVars[ctxKey];
      return ctxValue !== undefined
        ? this.formatPlaceholderValue(
            ctxValue,
            escapeForJsonBodyTemplate,
            encodeForFormBodyTemplate,
            escapeForXmlBodyTemplate,
          )
        : '';
    });
  }

  /**
   * Resolve {{session.key}} placeholders from injected session metadata.
   * Delegates to shared resolver with per-placeholder formatting callback.
   */
  private resolveSessionPlaceholders(
    value: string,
    sessionVars: Record<string, unknown> | undefined,
    escapeForJsonBodyTemplate = false,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): string {
    return resolveSessionPlaceholdersShared(value, sessionVars, (v) =>
      this.formatPlaceholderValue(
        v,
        escapeForJsonBodyTemplate,
        encodeForFormBodyTemplate,
        escapeForXmlBodyTemplate,
      ),
    );
  }

  /**
   * Resolve all {{secrets.KEY}} placeholders in a string.
   * Collects all secret references, batch-resolves them, then replaces.
   */
  private async resolveSecrets(
    value: string,
    toolName?: string,
    escapeForJsonBodyTemplate = false,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): Promise<string> {
    // Find all secret references
    const secretRefs: Array<{ placeholder: string; key: string }> = [];
    const pattern = /\{\{secrets\.(\w+)\}\}/g;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      secretRefs.push({ placeholder: match[0], key: match[1] });
    }

    if (secretRefs.length === 0) return value;

    // Resolve all secrets in parallel
    const resolved = await Promise.all(
      secretRefs.map(async (ref) => ({
        ...ref,
        value: await this.secrets.getSecret(ref.key, toolName ? { toolName } : undefined),
      })),
    );

    // Replace all occurrences of each placeholder with resolved values
    let result = value;
    for (const { placeholder, value: secretValue } of resolved) {
      if (secretValue === undefined) {
        log.warn('Secret not found, removing placeholder', { key: placeholder });
        result = result.split(placeholder).join('');
      } else {
        result = result
          .split(placeholder)
          .join(
            this.formatPlaceholderValue(
              secretValue,
              escapeForJsonBodyTemplate,
              encodeForFormBodyTemplate,
              escapeForXmlBodyTemplate,
            ),
          );
      }
    }

    return result;
  }

  /**
   * Resolve all {{env.KEY}} placeholders in a string.
   * Uses the SecretsProvider.getEnvVar method for DB-backed resolution.
   */
  private async resolveEnvVars(
    value: string,
    escapeForJsonBodyTemplate = false,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): Promise<string> {
    const envRefs: Array<{ placeholder: string; key: string }> = [];
    const pattern = /\{\{env\.(\w+)\}\}/g;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      envRefs.push({ placeholder: match[0], key: match[1] });
    }

    if (envRefs.length === 0) return value;

    const resolved = await Promise.all(
      envRefs.map(async (ref) => ({
        ...ref,
        value: await this.secrets.getEnvVar?.(ref.key),
      })),
    );

    let result = value;
    for (const { placeholder, value: envValue } of resolved) {
      if (envValue === undefined) {
        log.warn('Environment variable not found, removing placeholder', { key: placeholder });
        result = result.split(placeholder).join('');
      } else {
        result = result
          .split(placeholder)
          .join(
            this.formatPlaceholderValue(
              envValue,
              escapeForJsonBodyTemplate,
              encodeForFormBodyTemplate,
              escapeForXmlBodyTemplate,
            ),
          );
      }
    }

    return result;
  }

  /**
   * Resolve all {{config.KEY}} placeholders in a string.
   * Uses the SecretsProvider.getConfigVar method for namespace-scoped DB-backed resolution.
   */
  private async resolveConfigVars(
    value: string,
    escapeForJsonBodyTemplate = false,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): Promise<string> {
    const configRefs: Array<{ placeholder: string; key: string }> = [];
    const pattern = /\{\{config\.(\w+)\}\}/g;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      configRefs.push({ placeholder: match[0], key: match[1] });
    }

    if (configRefs.length === 0) return value;

    const resolved = await Promise.all(
      configRefs.map(async (ref) => ({
        ...ref,
        value: await this.secrets.getConfigVar?.(ref.key),
      })),
    );

    let result = value;
    for (const { placeholder, value: configValue } of resolved) {
      if (configValue === undefined) {
        log.warn('Config variable not found, removing placeholder', { key: placeholder });
        result = result.split(placeholder).join('');
      } else {
        result = result
          .split(placeholder)
          .join(
            this.formatPlaceholderValue(
              configValue,
              escapeForJsonBodyTemplate,
              encodeForFormBodyTemplate,
              escapeForXmlBodyTemplate,
            ),
          );
      }
    }

    return result;
  }

  /**
   * Resolve all placeholders in a string — secrets, env vars, config vars, and optionally input params.
   */
  private async resolvePlaceholders(
    value: string,
    params?: Record<string, unknown>,
    options?: {
      consumedKeys?: Set<string>;
      toolName?: string;
      escapeForJsonBodyTemplate?: boolean;
      encodeForFormBodyTemplate?: boolean;
      escapeForXmlBodyTemplate?: boolean;
    },
  ): Promise<string> {
    const escapeForJsonBodyTemplate = options?.escapeForJsonBodyTemplate ?? false;
    const encodeForFormBodyTemplate = options?.encodeForFormBodyTemplate ?? false;
    const escapeForXmlBodyTemplate = options?.escapeForXmlBodyTemplate ?? false;
    let result = await this.resolveSecrets(
      value,
      options?.toolName,
      escapeForJsonBodyTemplate,
      encodeForFormBodyTemplate,
      escapeForXmlBodyTemplate,
    );
    result = await this.resolveEnvVars(
      result,
      escapeForJsonBodyTemplate,
      encodeForFormBodyTemplate,
      escapeForXmlBodyTemplate,
    );
    result = await this.resolveConfigVars(
      result,
      escapeForJsonBodyTemplate,
      encodeForFormBodyTemplate,
      escapeForXmlBodyTemplate,
    );
    if (params) {
      result = this.resolveInputPlaceholders(
        result,
        params,
        options?.consumedKeys,
        escapeForJsonBodyTemplate,
        encodeForFormBodyTemplate,
        escapeForXmlBodyTemplate,
      );
    }
    return result;
  }

  /**
   * Resolve {{input.X}} placeholders from tool call arguments.
   * Optionally tracks consumed keys to prevent double-inclusion in the body.
   */
  private resolveInputPlaceholders(
    value: string,
    params: Record<string, unknown>,
    consumedKeys?: Set<string>,
    escapeForJsonBodyTemplate = false,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): string {
    return value.replace(/\{\{input\.(\w+)\}\}/g, (_match, key) => {
      const val = params[key];
      if (val === undefined || val === null) return '';
      if (consumedKeys) consumedKeys.add(key);
      return this.formatPlaceholderValue(
        val,
        escapeForJsonBodyTemplate,
        encodeForFormBodyTemplate,
        escapeForXmlBodyTemplate,
      );
    });
  }

  private formatPlaceholderValue(
    value: unknown,
    escapeForJsonBodyTemplate: boolean,
    encodeForFormBodyTemplate = false,
    escapeForXmlBodyTemplate = false,
  ): string {
    if (value === undefined || value === null) {
      return '';
    }

    if (escapeForJsonBodyTemplate) {
      return stringifyJsonTemplateValue(value);
    }

    if (encodeForFormBodyTemplate) {
      return encodeFormTemplateValue(value);
    }

    if (escapeForXmlBodyTemplate) {
      return xmlEscape(value);
    }

    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  private shouldIncludeContextInAutoBody(toolParameters: ToolParameter[] | undefined): boolean {
    return toolParameters?.some((parameter) => parameter.name === 'context') ?? false;
  }

  private async getOAuthToken(
    config: NonNullable<HttpBindingIR['auth']['config']>['oauth'],
    inlineClientSecret?: string,
    toolName?: string,
  ): Promise<string> {
    if (!config) throw new Error('OAuth config required');

    // Resolve {{secrets.X}} and {{env.X}} placeholders in OAuth config fields (parallel)
    const [resolvedTokenUrl, resolvedClientId, resolvedScopes] = await Promise.all([
      this.resolvePlaceholders(config.tokenUrl, undefined, { toolName }),
      this.resolvePlaceholders(config.clientId, undefined, { toolName }),
      config.scopes
        ? Promise.all(
            config.scopes.map((s) => this.resolvePlaceholders(s, undefined, { toolName })),
          )
        : [],
    ]);

    // Enforce HTTPS for token endpoint and validate for SSRF
    try {
      const tokenUrl = new URL(resolvedTokenUrl);
      if (
        tokenUrl.protocol !== 'https:' &&
        tokenUrl.hostname !== 'localhost' &&
        tokenUrl.hostname !== '127.0.0.1'
      ) {
        throw new Error(`OAuth token URL must use HTTPS: ${resolvedTokenUrl}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('HTTPS') || error.message.includes('Blocked'))
      )
        throw error;
      throw new Error(`Invalid OAuth token URL: ${resolvedTokenUrl}`, { cause: error });
    }

    // Tenant isolation: require tenantId for OAuth to prevent cross-tenant token sharing
    if (!this.tenantId) {
      log.warn('OAuth tool executed without tenantId — tokens will not be cached');
    }
    const cacheKey = this.tenantId
      ? `${this.tenantId}:${resolvedTokenUrl}:${resolvedClientId}`
      : `_no_tenant_:${resolvedTokenUrl}:${resolvedClientId}`;
    const cached = await this.tokenCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now() + 60000) {
      return cached.token;
    }

    const clientId =
      (await this.secrets.getSecret('oauth_client_id', toolName ? { toolName } : undefined)) ??
      resolvedClientId;
    // Priority: inline client_secret from auth_config → secrets provider
    let clientSecret: string | undefined;
    if (inlineClientSecret) {
      clientSecret = await this.resolvePlaceholders(inlineClientSecret, undefined, { toolName });
    }
    if (!clientSecret) {
      clientSecret = await this.secrets.getSecret(
        'oauth_client_secret',
        toolName ? { toolName } : undefined,
      );
    }

    if (!clientSecret) {
      throw new Error(
        'OAuth client secret not available — configure via secrets provider or auth_config',
      );
    }

    // Enforce timeout on OAuth token fetch to prevent resource exhaustion from hanging providers
    const oauthController = new AbortController();
    const oauthTimer = setTimeout(() => oauthController.abort(), OAUTH_TOKEN_TIMEOUT_MS);

    let response: Response;
    try {
      const tokenUrl = new URL(resolvedTokenUrl);
      response = await safeFetch(
        resolvedTokenUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: resolvedScopes.join(' '),
          }),
          signal: oauthController.signal,
        },
        {
          allowLocalhost: tokenUrl.hostname === 'localhost' || tokenUrl.hostname === '127.0.0.1',
        },
      );
    } catch (error) {
      if (isSSRFBlockedError(error)) {
        throw new Error('OAuth token URL blocked by SSRF protection', { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(oauthTimer);
    }

    if (!response.ok) {
      throw new Error(`OAuth token request failed: ${response.status}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in?: number };

    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    await this.tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt,
    });

    return data.access_token;
  }

  /**
   * Obtain a SearchAI JWT token, using cache when valid.
   *
   * Two modes:
   * 1. Full lifecycle (searchai config with tokenUrl): fetches JWT from the
   *    token generation endpoint using clientId/clientSecret, caches with TTL.
   * 2. Env-backed fallback: reads token from env vars / secrets via the
   *    binding's headers (e.g. {{env.AFG_SEARCHAI_TOKEN}}).
   *
   * In both modes, tokens are cached. On 401 errors the caller (executeWithRetry)
   * invalidates the cache and retries once.
   */
  private async getSearchAIToken(binding: HttpBindingIR, toolName?: string): Promise<string> {
    const searchaiConfig = binding.auth.config?.searchai;
    const cacheKeyBase = toolName || binding.endpoint;
    const cacheKey = this.tenantId
      ? `searchai:${this.tenantId}:${cacheKeyBase}`
      : `searchai:_no_tenant_:${cacheKeyBase}`;

    // Check cache first (with 60s safety margin before expiry)
    const cached = await this.tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }

    // Mode 1: Full token lifecycle via token endpoint
    if (searchaiConfig?.tokenUrl) {
      return this.fetchSearchAIToken(searchaiConfig, cacheKey, toolName);
    }

    // Mode 2: Env-backed — resolve token from headers or secrets
    let token: string | undefined;

    // Try resolving from the binding's headers (e.g. Auth: {{env.AFG_SEARCHAI_TOKEN}})
    const headerName = binding.auth.config?.headerName || 'Auth';
    token = await this.resolveHeaderSecret({}, headerName, binding, toolName);

    // Fallback: try tool-scoped and generic secret keys
    if (!token) {
      if (toolName) {
        token = await this.secrets.getSecret(`searchai_token_${toolName}`, { toolName });
      }
      if (!token) {
        token = await this.secrets.getSecret('searchai_token', toolName ? { toolName } : undefined);
      }
    }

    // Last fallback: try env vars directly
    if (!token) {
      token = await this.secrets.getEnvVar?.('SEARCHAI_TOKEN');
    }

    if (!token) {
      throw new ToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message:
          `SearchAI token not found for tool "${toolName || binding.endpoint}". ` +
          `Configure via AUTH_CONFIG with tokenUrl/clientId/clientSecret, ` +
          `or set SEARCHAI_TOKEN / AFG_SEARCHAI_TOKEN env var.`,
        toolName: toolName || binding.endpoint,
        toolType: 'http',
      });
    }

    // Cache env-backed tokens with a short TTL (5 min) — they might be rotated externally
    const envTokenTtlMs = safeParseInt(process.env.SEARCHAI_ENV_TOKEN_TTL_MS, 5 * 60 * 1000);
    await this.tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + envTokenTtlMs,
    });

    return token;
  }

  /**
   * Fetch a JWT from the SearchAI token generation endpoint.
   * Caches the token based on the response's expiry or a default TTL.
   */
  private async fetchSearchAIToken(
    config: NonNullable<NonNullable<HttpBindingIR['auth']['config']>['searchai']>,
    cacheKey: string,
    toolName?: string,
  ): Promise<string> {
    const [resolvedTokenUrl, resolvedClientId] = await Promise.all([
      this.resolvePlaceholders(config.tokenUrl, undefined, { toolName }),
      this.resolvePlaceholders(config.clientId, undefined, { toolName }),
    ]);

    let resolvedClientSecret: string | undefined;
    if (config.clientSecret) {
      resolvedClientSecret = await this.resolvePlaceholders(config.clientSecret, undefined, {
        toolName,
      });
    }
    if (!resolvedClientSecret) {
      resolvedClientSecret = await this.secrets.getSecret(
        'searchai_client_secret',
        toolName ? { toolName } : undefined,
      );
    }

    if (!resolvedClientSecret) {
      throw new ToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message:
          'SearchAI client secret not found — configure via auth_config.clientSecret or secrets provider',
        toolName: 'searchai',
        toolType: 'http',
      });
    }

    // Enforce HTTPS (except localhost for dev)
    try {
      const tokenUrl = new URL(resolvedTokenUrl);
      if (
        tokenUrl.protocol !== 'https:' &&
        tokenUrl.hostname !== 'localhost' &&
        tokenUrl.hostname !== '127.0.0.1'
      ) {
        throw new Error(`SearchAI token URL must use HTTPS: ${resolvedTokenUrl}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('HTTPS') || error.message.includes('Blocked'))
      ) {
        throw error;
      }
      throw new Error(`Invalid SearchAI token URL: ${resolvedTokenUrl}`, { cause: error });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_TOKEN_TIMEOUT_MS);

    let response: Response;
    try {
      const tokenUrl = new URL(resolvedTokenUrl);
      response = await safeFetch(
        resolvedTokenUrl,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientId: resolvedClientId,
            clientSecret: resolvedClientSecret,
            ...(config.botId ? { botId: config.botId } : {}),
          }),
          signal: controller.signal,
        },
        {
          allowLocalhost: tokenUrl.hostname === 'localhost' || tokenUrl.hostname === '127.0.0.1',
        },
      );
    } catch (error) {
      if (isSSRFBlockedError(error)) {
        throw new ToolExecutionError({
          code: 'TOOL_SSRF_BLOCKED',
          message: 'SearchAI token URL blocked by SSRF protection.',
          toolName: 'searchai',
          toolType: 'http',
          retryable: false,
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message: `SearchAI token request failed: HTTP ${response.status}`,
        toolName: 'searchai',
        toolType: 'http',
      });
    }

    const data = (await response.json()) as {
      jwt?: string;
      token?: string;
      access_token?: string;
      expires_in?: number;
      expiresIn?: number;
    };

    const token = data.jwt || data.token || data.access_token;
    if (!token) {
      throw new ToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message: 'SearchAI token response missing jwt/token/access_token field',
        toolName: 'searchai',
        toolType: 'http',
      });
    }

    const expiresInSec = data.expires_in || data.expiresIn || 3600;
    const expiresAt = Date.now() + expiresInSec * 1000;
    await this.tokenCache.set(cacheKey, { token, expiresAt });

    return token;
  }

  /**
   * Invalidate a cached SearchAI token (called on 401 before retry).
   */
  async invalidateSearchAIToken(toolName: string): Promise<void> {
    const cacheKey = this.tenantId
      ? `searchai:${this.tenantId}:${toolName}`
      : `searchai:_no_tenant_:${toolName}`;
    await this.tokenCache.delete(cacheKey);
  }

  /**
   * S6: Safely import undici without using Function() eval.
   * Uses a variable-based dynamic import to bypass TypeScript static resolution.
   * Some hosts (for example transpiled Next.js route outputs) may not expose undici,
   * so callers must gracefully handle a null module in undici-dependent flows.
   * Cached after first successful import.
   */
  private static _undiciModule: any = undefined;

  // ── Keep-alive connection pool ──────────────────────────────────────
  private static _defaultAgent: any = null;

  /** Return the shared keep-alive agent (null if not yet initialised). */
  static getDefaultAgent(): any {
    return HttpToolExecutor._defaultAgent;
  }

  /** Lazily create a shared undici Agent with keep-alive for connection reuse. */
  private static async ensureDefaultAgent(): Promise<any> {
    if (HttpToolExecutor._defaultAgent) return HttpToolExecutor._defaultAgent;
    const undici = await HttpToolExecutor.importUndici();
    if (undici?.Agent) {
      const poolParsed = parseInt(process.env.HTTP_TOOL_POOL_SIZE || '50', 10);
      const poolSize = Number.isNaN(poolParsed) ? 50 : poolParsed;
      HttpToolExecutor._defaultAgent = new undici.Agent({
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
        connections: poolSize,
      });
    }
    return HttpToolExecutor._defaultAgent;
  }

  /** Destroy the shared keep-alive agent (e.g. for graceful shutdown or tests). */
  static async destroyDefaultAgent(): Promise<void> {
    if (HttpToolExecutor._defaultAgent) {
      try {
        await HttpToolExecutor._defaultAgent.close();
      } catch {
        /* best-effort */
      }
      HttpToolExecutor._defaultAgent = null;
    }
  }

  private static async importUndici(): Promise<any> {
    if (HttpToolExecutor._undiciModule !== undefined) return HttpToolExecutor._undiciModule;
    try {
      // Variable-based import prevents TypeScript from resolving the module at compile time.
      // webpackIgnore suppresses the "critical dependency" warning in Next.js bundling.
      const mod = 'undici';
      HttpToolExecutor._undiciModule = await import(
        /* webpackIgnore: true */ /* @vite-ignore */ mod
      );
      return HttpToolExecutor._undiciModule;
    } catch (error) {
      log.warn('Failed to import undici module', {
        error: error instanceof Error ? error.message : String(error),
      });
      HttpToolExecutor._undiciModule = null;
      return null;
    }
  }

  private async createProxyDispatcher(
    proxyConfig: ProxyConfig,
    bindingTlsOptions: HttpBindingIR['tls_options'] | undefined,
    toolName: string,
  ): Promise<any> {
    const undici = await HttpToolExecutor.importUndici();
    if (!undici?.ProxyAgent) {
      throw new ToolExecutionError({
        code: 'TOOL_AUTH_FAILED',
        message:
          'HTTP proxy support is unavailable because the proxy transport could not be loaded.',
        toolName,
        toolType: 'http',
        retryable: false,
      });
    }

    const proxyTls: Record<string, unknown> = {};
    if (proxyConfig.caCertificate) proxyTls.ca = proxyConfig.caCertificate;
    if (proxyConfig.clientCert) proxyTls.cert = proxyConfig.clientCert;
    if (proxyConfig.clientKey) proxyTls.key = proxyConfig.clientKey;

    const requestTls: Record<string, unknown> = {};
    if (bindingTlsOptions?.ca) requestTls.ca = bindingTlsOptions.ca;
    if (bindingTlsOptions?.cert) requestTls.cert = bindingTlsOptions.cert;
    if (bindingTlsOptions?.key) requestTls.key = bindingTlsOptions.key;
    if (bindingTlsOptions?.rejectUnauthorized !== undefined) {
      requestTls.rejectUnauthorized = bindingTlsOptions.rejectUnauthorized;
    }

    const proxyOptions: Record<string, unknown> = {
      uri: proxyConfig.proxyUrl,
    };
    const token = buildProxyAuthorizationHeader(proxyConfig);
    if (token) proxyOptions.token = token;
    if (Object.keys(proxyTls).length > 0) proxyOptions.proxyTls = proxyTls;
    if (Object.keys(requestTls).length > 0) proxyOptions.requestTls = requestTls;

    return new undici.ProxyAgent(proxyOptions);
  }

  private validateBindingTlsOptions(
    bindingTlsOptions: NonNullable<HttpBindingIR['tls_options']>,
  ): void {
    const secureContextOptions: SecureContextOptions = {};
    if (bindingTlsOptions.ca) secureContextOptions.ca = bindingTlsOptions.ca;
    if (bindingTlsOptions.cert) secureContextOptions.cert = bindingTlsOptions.cert;
    if (bindingTlsOptions.key) secureContextOptions.key = bindingTlsOptions.key;

    // Parse TLS material eagerly so invalid PEM/key pairs fail before execution.
    createSecureContext(secureContextOptions);
  }

  private async fetchThroughProxyWithValidatedRedirects(
    url: string,
    init: RequestInit,
    options: SafeFetchOptions,
  ): Promise<Response> {
    const maxRedirects = options.maxRedirects ?? MAX_REDIRECT_HOPS;
    const redirectMode = init.redirect ?? 'follow';
    let currentUrl = url;
    let currentInit = { ...init, redirect: 'manual' as RequestInit['redirect'] };

    for (let hop = 0; ; hop++) {
      await assertUrlSafeForFetch(currentUrl, options);
      const response = await fetch(currentUrl, currentInit);

      if (
        !REDIRECT_STATUS_CODES.includes(response.status as (typeof REDIRECT_STATUS_CODES)[number])
      ) {
        return response;
      }

      if (redirectMode === 'manual') {
        return response;
      }

      if (redirectMode === 'error') {
        await discardRedirectBody(response);
        throw new SSRFError('Redirect blocked by HTTP tool redirect policy', { url: currentUrl });
      }

      if (hop >= maxRedirects) {
        await discardRedirectBody(response);
        throw new SSRFError(`Too many redirects (max ${maxRedirects})`, { url: currentUrl });
      }

      const location = response.headers.get('location');
      if (!location) {
        await discardRedirectBody(response);
        throw new SSRFError(`HTTP ${response.status} redirect missing Location header`, {
          url: currentUrl,
        });
      }

      const previousUrl = new URL(currentUrl);
      const nextUrl = new URL(location, previousUrl);
      const headers = new Headers(currentInit.headers);
      const method = (currentInit.method ?? 'GET').toUpperCase();

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        currentInit = { ...currentInit, method: 'GET' };
        delete currentInit.body;
        headers.delete('content-length');
        headers.delete('content-type');
      }

      if (previousUrl.origin !== nextUrl.origin) {
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete('proxy-authorization');
      }

      currentInit.headers = headers;
      currentUrl = nextUrl.toString();
      await discardRedirectBody(response);
    }
  }

  private async executeWithRetry(
    toolName: string,
    request: { url: string; init: RequestInit },
    retries: number,
    delayMs: number,
    timeoutMs: number,
    breaker: ICircuitBreaker,
    binding?: HttpBindingIR,
    params?: Record<string, unknown>,
  ): Promise<{ result: unknown; responseStatus: number }> {
    let lastError: Error | null = null;
    let searchaiTokenRetried = false;
    let digestChallengeRetried = false;
    const internalBinding = binding as InternalAuthBinding | undefined;
    const authSignRequest = internalBinding?._authSignRequest;
    const digestCredentials = internalBinding?._digestCredentials;

    // S7: Resolve proxy configuration ONCE before retry loop (not per-attempt)
    const proxyConfig = this.proxyResolver?.resolve(request.url) ?? null;
    const bindingTlsOptions = binding?.tls_options;
    const bindingSigV4 = binding?.sigv4_auth;
    let dispatcher: any = undefined;

    if (bindingTlsOptions) {
      assertMutualTlsUsesHttps(request.url, toolName);
    }

    const unsignedRequestHeaders = {
      ...((request.init.headers ?? {}) as Record<string, string>),
    };

    if (bindingSigV4) {
      request.init.headers = signSigV4RequestHeaders(
        { url: request.url, init: { ...request.init, headers: unsignedRequestHeaders } },
        bindingSigV4,
        toolName,
      );
    } else {
      request.init.headers = { ...unsignedRequestHeaders };
    }

    if (proxyConfig) {
      log.debug('Routing through proxy', {
        proxyUrl: proxyConfig.proxyUrl,
        authType: proxyConfig.authType,
      });
      try {
        dispatcher = await this.createProxyDispatcher(proxyConfig, bindingTlsOptions, toolName);
      } catch (err) {
        if (err instanceof ToolExecutionError) {
          throw err;
        }

        const classifiedTlsError = bindingTlsOptions ? classifyMutualTlsError(err, toolName) : null;
        if (classifiedTlsError) {
          throw classifiedTlsError;
        }

        if (bindingTlsOptions) {
          throw new ToolExecutionError({
            code: 'TOOL_AUTH_FAILED',
            message:
              'mTLS client certificate or private key is invalid, or the configuration could not be applied. Verify the auth profile certificate bundle and retry.',
            toolName,
            toolType: 'http',
            retryable: false,
            cause: err,
          });
        }

        log.warn('Failed to create custom TLS agent — mTLS/CA cert not applied', {
          error: err instanceof Error ? err.message : 'undici import failed',
        });
      }
    } else if (bindingTlsOptions) {
      try {
        this.validateBindingTlsOptions(bindingTlsOptions);
      } catch (err) {
        if (err instanceof ToolExecutionError) {
          throw err;
        }

        const classifiedTlsError = classifyMutualTlsError(err, toolName);
        if (classifiedTlsError) {
          throw classifiedTlsError;
        }

        throw new ToolExecutionError({
          code: 'TOOL_AUTH_FAILED',
          message:
            'mTLS client certificate or private key is invalid, or the configuration could not be applied. Verify the auth profile certificate bundle and retry.',
          toolName,
          toolType: 'http',
          retryable: false,
          cause: err,
        });
      }
    }

    const safeFetchOptions: SafeFetchOptions = {
      allowLocalhost: this.allowLocalhost,
      // Credential-bearing transport auth (AWS SigV4 or mTLS) must not follow
      // redirects: re-presenting a SigV4 signature or a client certificate to a
      // host the tenant did not configure leaks credentials.
      maxRedirects: bindingSigV4 || bindingTlsOptions ? 0 : MAX_REDIRECT_HOPS,
    };
    const tlsOptions: NonNullable<SafeFetchOptions['tls']> = {};
    if (proxyConfig?.caCertificate) tlsOptions.ca = proxyConfig.caCertificate;
    if (proxyConfig?.clientCert) tlsOptions.cert = proxyConfig.clientCert;
    if (proxyConfig?.clientKey) tlsOptions.key = proxyConfig.clientKey;
    if (bindingTlsOptions?.ca) tlsOptions.ca = bindingTlsOptions.ca;
    if (bindingTlsOptions?.cert) tlsOptions.cert = bindingTlsOptions.cert;
    if (bindingTlsOptions?.key) tlsOptions.key = bindingTlsOptions.key;
    if (bindingTlsOptions?.rejectUnauthorized !== undefined) {
      tlsOptions.rejectUnauthorized = bindingTlsOptions.rejectUnauthorized;
    }
    if (Object.keys(tlsOptions).length > 0) {
      safeFetchOptions.tls = tlsOptions;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      const attemptStart = Date.now();

      if (attempt > 0) {
        log.debug('HTTP tool retry', { tool: toolName, attempt, maxRetries: retries });
      }

      // Re-check circuit breaker before each retry attempt
      if (attempt > 0 && (await breaker.isOpen())) {
        throw new ToolExecutionError({
          code: 'TOOL_CIRCUIT_OPEN',
          message: `HTTP tool ${toolName} is temporarily unavailable (circuit breaker opened during retries)`,
          toolName,
          toolType: 'http',
          retryable: true,
        });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        if (typeof authSignRequest === 'function') {
          const signedHeaders = await authSignRequest({
            method: String(request.init.method ?? 'GET'),
            url: request.url,
            headers: toHeadersObject(request.init.headers),
            body: typeof request.init.body === 'string' ? request.init.body : undefined,
          });
          request.init.headers = Object.fromEntries(signedHeaders.entries());
        }

        if (request.init.headers) {
          const sanitized = toHeadersObject(request.init.headers);
          for (const [key, value] of sanitized.entries()) {
            sanitized.set(key, sanitizeHeaderValue(value));
          }
          request.init.headers = Object.fromEntries(sanitized.entries());
        }

        const fetchInit: Record<string, unknown> = { ...request.init };
        if (dispatcher) {
          fetchInit.dispatcher = dispatcher;
        }

        // --- HTTP TRACE: request ---
        const tracedBody = request.init.body
          ? redactWsSecurityForTrace(request.init.body as string)
          : undefined;
        dumpHttpTrace({
          timestamp: new Date().toISOString(),
          phase: 'request',
          tool: toolName,
          attempt,
          method: (request.init.method as string) || 'GET',
          url: request.url,
          headers: headersToRecord(
            request.init.headers as Record<string, string> | Headers | undefined,
          ),
          body: redactSecretsFromTraceBody(
            typeof tracedBody === 'string' ? safeParseJson(tracedBody) : tracedBody,
          ),
        });

        const response = proxyConfig
          ? await this.fetchThroughProxyWithValidatedRedirects(
              request.url,
              {
                ...fetchInit,
                signal: controller.signal,
              } as RequestInit,
              safeFetchOptions,
            )
          : await safeFetch(
              request.url,
              {
                ...fetchInit,
                signal: controller.signal,
              } as RequestInit,
              safeFetchOptions,
            );

        if (!response.ok) {
          if (!digestChallengeRetried && response.status === 401 && digestCredentials) {
            const digestChallenge = response.headers.get('www-authenticate');
            if (digestChallenge && /digest/i.test(digestChallenge)) {
              const digestHeader = buildDigestRetryAuthorization(
                request,
                digestCredentials,
                digestChallenge,
              );
              if (digestHeader) {
                digestChallengeRetried = true;
                const retryHeaders = toHeadersObject(request.init.headers);
                retryHeaders.set('Authorization', sanitizeHeaderValue(digestHeader));
                request.init.headers = Object.fromEntries(retryHeaders.entries());
                await discardRedirectBody(response);
                log.info('HTTP digest challenge received — retrying with Authorization header', {
                  tool: toolName,
                  attempt,
                });
                retries = Math.max(retries, attempt + 1);
                continue;
              }
            }
          }

          const errorText = await response.text();
          // --- HTTP TRACE: error response ---
          dumpHttpTrace({
            timestamp: new Date().toISOString(),
            phase: 'response',
            tool: toolName,
            attempt,
            status: response.status,
            headers: responseHeadersToRecord(response.headers),
            body: safeParseJson(errorText),
            latencyMs: Date.now() - attemptStart,
            error: true,
          });

          // SOAP servers commonly return HTTP 4xx/5xx with a fault envelope (per SOAP 1.1
          // spec §6.1.1 and SOAP 1.2 conventions). When the protocol is soap and the error
          // body is XML, attempt fault detection before classifying as a transport error so
          // on_soap_fault='data' delivers the parsed fault and on_soap_fault='error' surfaces
          // a typed TOOL_SOAP_FAULT instead of a truncated TOOL_HTTP_ERROR.
          const errorContentType = response.headers.get('content-type') || '';
          const errorIsXml =
            errorContentType.includes('text/xml') ||
            errorContentType.includes('application/xml') ||
            errorContentType.includes('application/soap+xml');
          if (binding?.protocol === 'soap' && errorIsXml) {
            try {
              const parsed = parseSoapResponse({
                text: errorText,
                soapVersion: binding.soap_version ?? '1.1',
              });
              if (parsed.isFault) {
                const onFault = binding.on_soap_fault ?? 'error';
                log.debug('SOAP fault detected on HTTP error response', {
                  tool: toolName,
                  status: response.status,
                  code: parsed.fault?.code,
                  reason: parsed.fault?.reason,
                  onFault,
                });
                if (onFault === 'data') {
                  return {
                    result: { ...(parsed.payload as object), soap_fault: true },
                    responseStatus: response.status,
                  };
                }
                const rawReason = parsed.fault?.reason ?? 'SOAP fault';
                const sanitizedReason =
                  rawReason.length > MAX_ERROR_BODY_LENGTH
                    ? rawReason.substring(0, MAX_ERROR_BODY_LENGTH) + '...[truncated]'
                    : rawReason.replace(/[\r\n]/g, ' ').trim();
                throw new ToolExecutionError({
                  code: 'TOOL_SOAP_FAULT',
                  message: sanitizedReason,
                  toolName,
                  toolType: 'http',
                  statusCode: response.status,
                  retryable: false,
                  durationMs: Date.now() - attemptStart,
                });
              }
            } catch (parseErr) {
              if (parseErr instanceof ToolExecutionError) throw parseErr;
              // Parse failed — fall through to the generic transport-error path below.
            }
          }

          // Default: return the full parsed response body as a tool result so the agent
          // can inspect structured error payloads (e.g. 404 with { "error": { ... } }).
          // on_http_error === 'error' opts a specific tool back into the old throw behaviour.
          //
          // Exclusions from data-return path:
          // - 3xx responses (redirects/caching, e.g. 304 Not Modified) — not API errors
          // - SearchAI 401 — must throw so the catch block can handle token-refresh retry
          //   and eventual exhaustion (both first attempt and post-retry failure)
          // - 429 / 5xx with retries remaining — throw so the retry loop can fire; on
          //   the final attempt the data path is used so the agent gets the body
          const isSearchAI401 =
            response.status === 401 && binding?.auth?.type === 'searchai' && params !== undefined;
          const isRetryableStatus = response.status === 429 || response.status >= 500;
          if (binding?.on_http_error !== 'error' && response.status >= 400 && !isSearchAI401) {
            if (isRetryableStatus && attempt < retries) {
              // Retries remain — throw to let the retry loop handle backoff.
              // The catch block will call breaker.recordFailure() and schedule the next attempt.
              const truncatedForRetry =
                errorText.length > MAX_ERROR_BODY_LENGTH
                  ? errorText.substring(0, MAX_ERROR_BODY_LENGTH) + '...[truncated]'
                  : errorText;
              const methodForRetry = (request.init.method as string) || 'GET';
              throw new ToolExecutionError({
                code: response.status === 429 ? 'TOOL_RATE_LIMITED' : 'TOOL_HTTP_ERROR',
                message: `${methodForRetry} ${safeUrlOrigin(request.url)}: HTTP ${response.status} — ${truncatedForRetry}`,
                toolName,
                toolType: 'http',
                statusCode: response.status,
                retryable: true,
                durationMs: Date.now() - attemptStart,
              });
            }

            // Final attempt (or non-retryable 4xx): return structured body.
            // Apply the same maxResponseBytes cap as the success path to prevent
            // adversarial APIs from returning unbounded error payloads.
            const cappedErrorText =
              Buffer.byteLength(errorText, 'utf8') > this.maxResponseBytes
                ? errorText.substring(0, this.maxResponseBytes) + '...[truncated]'
                : errorText;
            try {
              await breaker.recordFailure();
            } catch (breakerErr) {
              log.warn('Circuit breaker recordFailure failed', {
                tool: toolName,
                error: breakerErr instanceof Error ? breakerErr.message : String(breakerErr),
              });
            }
            return {
              result: {
                statusCode: response.status,
                body: safeParseJson(cappedErrorText),
                is_error: true,
              },
              responseStatus: response.status,
            };
          }

          // on_http_error === 'error': legacy throw behaviour (opt-in per tool)
          const truncated =
            errorText.length > MAX_ERROR_BODY_LENGTH
              ? errorText.substring(0, MAX_ERROR_BODY_LENGTH) + '...[truncated]'
              : errorText;
          const method = (request.init.method as string) || 'GET';
          throw new ToolExecutionError({
            code: response.status === 429 ? 'TOOL_RATE_LIMITED' : 'TOOL_HTTP_ERROR',
            message: `${method} ${safeUrlOrigin(request.url)}: HTTP ${response.status} — ${truncated}`,
            toolName,
            toolType: 'http',
            statusCode: response.status,
            retryable: response.status === 429 || response.status >= 500,
            durationMs: Date.now() - attemptStart,
          });
        }

        try {
          await breaker.recordSuccess();
        } catch (breakerErr) {
          log.warn('Circuit breaker recordSuccess failed', {
            tool: toolName,
            error: breakerErr instanceof Error ? breakerErr.message : String(breakerErr),
          });
        }

        const contentType = response.headers.get('content-type') || '';
        const responseContentLength = response.headers.get('content-length');
        const responseSizeHint = responseContentLength
          ? parseInt(responseContentLength, 10)
          : undefined;
        log.debug('HTTP tool response', {
          tool: toolName,
          status: response.status,
          contentType: contentType.split(';')[0],
          latencyMs: Date.now() - attemptStart,
          ...(responseSizeHint && responseSizeHint > 1_000_000
            ? { responseBytes: responseSizeHint }
            : {}),
        });

        const result = await this.readBoundedResponse(response, contentType);

        // --- HTTP TRACE: success response ---
        dumpHttpTrace({
          timestamp: new Date().toISOString(),
          phase: 'response',
          tool: toolName,
          attempt,
          status: response.status,
          headers: responseHeadersToRecord(response.headers),
          body: result,
          latencyMs: Date.now() - attemptStart,
        });

        // SOAP response handling — only parse when response content type is XML-like
        const isXmlResponse =
          contentType.includes('text/xml') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/soap+xml');
        if (binding?.protocol === 'soap' && isXmlResponse) {
          const rawText = typeof result === 'string' ? result : JSON.stringify(result);
          let parsed: import('./soap-envelope.js').ParsedSoapResponse;
          try {
            parsed = parseSoapResponse({
              text: rawText,
              soapVersion: binding.soap_version ?? '1.1',
            });
          } catch (parseErr) {
            throw new ToolExecutionError({
              code: 'TOOL_RESPONSE_PARSE_FAILED',
              message: 'SOAP response XML could not be parsed',
              toolName,
              toolType: 'http',
              retryable: false,
            });
          }
          if (parsed.isFault) {
            const onFault = binding.on_soap_fault ?? 'error';
            log.debug('SOAP fault detected', {
              tool: toolName,
              code: parsed.fault?.code,
              reason: parsed.fault?.reason,
              onFault,
            });
            if (onFault === 'error') {
              const rawReason = parsed.fault?.reason ?? 'SOAP fault';
              const sanitizedReason =
                rawReason.length > MAX_ERROR_BODY_LENGTH
                  ? rawReason.substring(0, MAX_ERROR_BODY_LENGTH) + '...[truncated]'
                  : rawReason.replace(/[\r\n]/g, ' ').trim();
              throw new ToolExecutionError({
                code: 'TOOL_SOAP_FAULT',
                message: sanitizedReason,
                toolName,
                toolType: 'http',
                retryable: false,
              });
            }
            // onFault === 'data': return parsed fault payload
            return {
              result: { ...(parsed.payload as object), soap_fault: true },
              responseStatus: response.status,
            };
          }
          return { result: parsed.payload, responseStatus: response.status };
        }

        return { result, responseStatus: response.status };
      } catch (error) {
        lastError = error as Error;
        try {
          await breaker.recordFailure();
        } catch (breakerErr) {
          log.warn('Circuit breaker recordFailure failed', {
            tool: toolName,
            error: breakerErr instanceof Error ? breakerErr.message : String(breakerErr),
          });
        }

        if (binding?.tls_options) {
          const classifiedTlsError = classifyMutualTlsError(error, toolName);
          if (classifiedTlsError) {
            throw classifiedTlsError;
          }
        }

        if (isSSRFBlockedError(error)) {
          throw new ToolExecutionError({
            code: 'TOOL_SSRF_BLOCKED',
            message: 'HTTP tool target blocked by SSRF protection.',
            toolName,
            toolType: 'http',
            retryable: false,
            cause: error,
          });
        }

        // SearchAI 401 token refresh: invalidate cached token, rebuild request, retry once
        if (
          !searchaiTokenRetried &&
          binding?.auth?.type === 'searchai' &&
          error instanceof ToolExecutionError &&
          (error as ToolExecutionError).statusCode === 401 &&
          params
        ) {
          searchaiTokenRetried = true;
          log.info('SearchAI 401 — invalidating token and retrying', { tool: toolName });
          await this.invalidateSearchAIToken(toolName);
          // Rebuild request with fresh token
          const freshRequest = await this.buildRequest(binding, { ...params }, toolName);
          request.init = freshRequest.init;
          // Grant one extra attempt for the token refresh retry
          retries = Math.max(retries, attempt + 1);
          continue;
        }

        // Don't retry on client errors (4xx) except timeout and rate limit
        if (error instanceof ToolExecutionError && !(error as ToolExecutionError).retryable) {
          throw error;
        }

        // Don't retry on non-retryable errors (SSRF, auth, etc.)
        if (
          error instanceof Error &&
          error.name !== 'AbortError' &&
          !(error instanceof ToolExecutionError) &&
          error.message.match(/^HTTP 4/)
        ) {
          throw error;
        }

        // Don't retry on SSRF blocks or redirect limit errors
        if (
          error instanceof Error &&
          (error.message.includes('Blocked') || error.message.includes('Too many redirects'))
        ) {
          throw error;
        }

        if (attempt < retries) {
          const jitter = 0.5 + Math.random() * 0.5;
          await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, attempt) * jitter));
        }
      } finally {
        clearTimeout(timer);
      }
    }

    log.error('HTTP tool exhausted retries', {
      tool: toolName,
      retries,
      error: lastError?.message,
    });
    // Preserve ToolExecutionError if already classified
    if (lastError instanceof ToolExecutionError) throw lastError;
    const isTimeout = lastError?.name === 'AbortError';
    const origin = safeUrlOrigin(request.url);
    throw new ToolExecutionError({
      code: isTimeout ? 'TOOL_TIMEOUT' : 'TOOL_NETWORK_ERROR',
      message: isTimeout
        ? `Tool '${toolName}' timed out after ${timeoutMs}ms — ${origin} did not respond in time`
        : `Tool '${toolName}' network error reaching ${origin}: ${lastError?.message ?? 'connection failed'}`,
      toolName,
      toolType: 'http',
      retryable: true,
      cause: lastError,
    });
  }

  private classifyAsyncExecutionResult(
    responseStatus: number,
    result: unknown,
    executionOptions: ToolExecutionOptions,
  ): AsyncHttpExecutionResult {
    const successConfig = executionOptions.asyncHttpSuccess;
    const statusMatches =
      successConfig?.acceptedStatusCodes && successConfig.acceptedStatusCodes.length > 0
        ? successConfig.acceptedStatusCodes.includes(responseStatus)
        : responseStatus >= 200 && responseStatus < 300;
    const bodyMatches = this.matchesAcceptedBody(result, successConfig);

    if (statusMatches && bodyMatches) {
      return {
        __toolExecutionStatus: 'accepted',
        output: result,
        responseStatus,
      };
    }

    return {
      __toolExecutionStatus: 'completed',
      output: result,
      responseStatus,
    };
  }

  private matchesAcceptedBody(
    result: unknown,
    successConfig: ToolExecutionOptions['asyncHttpSuccess'],
  ): boolean {
    if (!successConfig?.acceptedBodyPath) {
      return true;
    }
    const actualValue = this.readAcceptedBodyPath(result, successConfig.acceptedBodyPath);
    if (successConfig.acceptedBodyEquals === undefined) {
      return Boolean(actualValue);
    }
    return String(actualValue) === successConfig.acceptedBodyEquals;
  }

  private static readonly DANGEROUS_PATH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

  private readAcceptedBodyPath(result: unknown, path: string): unknown {
    if (!path.startsWith('$.')) {
      return undefined;
    }
    let current: unknown = result;
    for (const part of path.slice(2).split('.')) {
      if (!part) return undefined;
      if (HttpToolExecutor.DANGEROUS_PATH_KEYS.has(part)) return undefined;
      if (typeof current !== 'object' || current === null || !(part in current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * Read response body with size limit.
   * Checks Content-Length for early warning, then streams body with byte counter.
   * Returns truncated data with a flag instead of throwing on oversized responses,
   * so the tool call returns a partial result rather than failing entirely.
   */
  private async readBoundedResponse(
    response: Response,
    contentType: string,
  ): Promise<unknown | TruncatedResponse> {
    // Early warning via Content-Length (don't reject — we'll truncate gracefully)
    const contentLength = response.headers.get('content-length');
    const declaredSize = contentLength ? parseInt(contentLength, 10) : undefined;

    // Stream body with byte counter
    const reader = response.body?.getReader();
    if (!reader) {
      // Fallback for environments without streaming support
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (text.length > this.maxResponseBytes) {
          log.warn('Response truncated (non-streaming)', {
            originalSize: text.length,
            limit: this.maxResponseBytes,
          });
          const truncated = text.substring(0, this.maxResponseBytes);
          const result: TruncatedResponse = {
            data: contentType.includes('application/json') ? safeParseJson(truncated) : truncated,
            truncated: true,
            originalSize: text.length,
            warning: `Response truncated: ${text.length} bytes exceeded ${this.maxResponseBytes} byte limit`,
          };
          return result;
        }
        if (contentType.includes('application/json')) {
          try {
            return JSON.parse(text);
          } catch {
            throw new Error('Invalid JSON response from HTTP tool');
          }
        }
        return text;
      }
      // Last resort: use json() directly (e.g. minimal Response implementations)
      if (
        contentType.includes('application/json') &&
        typeof (response as any).json === 'function'
      ) {
        return await (response as any).json();
      }
      throw new Error('Response has no readable body');
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let wasTruncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > this.maxResponseBytes) {
        // Graceful truncation: keep what we have, cancel the rest
        wasTruncated = true;
        reader.cancel();
        break;
      }
      chunks.push(value);
    }

    const decoder = new TextDecoder();
    const text = chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();

    if (wasTruncated) {
      const approxOriginalSize = declaredSize && !isNaN(declaredSize) ? declaredSize : totalBytes;
      log.warn('Response truncated (streaming)', {
        originalSize: approxOriginalSize,
        truncatedTo: text.length,
        limit: this.maxResponseBytes,
      });
      const truncResult: TruncatedResponse = {
        data: contentType.includes('application/json') ? safeParseJson(text) : text,
        truncated: true,
        originalSize: approxOriginalSize,
        warning: `Response truncated: ~${approxOriginalSize} bytes exceeded ${this.maxResponseBytes} byte limit`,
      };
      return truncResult;
    }

    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error('Invalid JSON response from HTTP tool');
      }
    }
    return text;
  }

  private cacheKey(toolName: string): string {
    return this.tenantId ? `${this.tenantId}:${toolName}` : toolName;
  }

  private evictIfOverLimit<T>(map: Map<string, T>, limit: number): void {
    if (map.size > limit) {
      const first = map.keys().next().value;
      if (first) map.delete(first);
    }
  }

  private getOrCreateRateLimiter(toolName: string, rpm: number): IRateLimiter {
    const key = this.cacheKey(toolName);
    let limiter = this.rateLimiters.get(key);
    if (!limiter) {
      limiter = this.resilienceFactory.createRateLimiter(toolName, rpm);
      this.rateLimiters.set(key, limiter);
      this.evictIfOverLimit(this.rateLimiters, MAX_RESILIENCE_MAP_ENTRIES);
    }
    return limiter;
  }

  private getOrCreateCircuitBreaker(
    toolName: string,
    binding: ResolvedHttpBindingIR,
  ): ICircuitBreaker {
    const key = this.cacheKey(toolName);
    let breaker = this.circuitBreakers.get(key);
    if (!breaker) {
      breaker = this.resilienceFactory.createCircuitBreaker(toolName, {
        threshold: binding.circuit_breaker?.threshold ?? 5,
        resetMs: binding.circuit_breaker?.reset_ms ?? 30000,
      });
      this.circuitBreakers.set(key, breaker);
      this.evictIfOverLimit(this.circuitBreakers, MAX_RESILIENCE_MAP_ENTRIES);
    }
    return breaker;
  }

  getCircuitBreakerState(
    toolName: string,
  ): ('closed' | 'open' | 'half-open') | Promise<'closed' | 'open' | 'half-open'> | undefined {
    return this.circuitBreakers.get(this.cacheKey(toolName))?.getState();
  }
}

/**
 * Exported for testing — shared session placeholder resolution (without HTTP-specific escaping).
 */
export const _resolveSessionPlaceholdersForTest = (
  value: string,
  sessionVars: Record<string, unknown> | undefined,
) => resolveSessionPlaceholdersShared(value, sessionVars);

function signSigV4RequestHeaders(
  request: { url: string; init: RequestInit },
  auth: NonNullable<HttpBindingIR['sigv4_auth']>,
  toolName: string,
): Record<string, string> {
  const headers = { ...((request.init.headers ?? {}) as Record<string, string>) };
  const method = request.init.method ?? 'GET';
  const body = typeof request.init.body === 'string' ? request.init.body : undefined;

  if (!auth.region || !auth.service) {
    throw new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        'AWS IAM auth requires both region and service before a request can be signed. Update the auth profile configuration and retry.',
      toolName,
      toolType: 'http',
      retryable: false,
    });
  }

  try {
    return signHttpToolRequest({
      url: request.url,
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      auth,
    });
  } catch (error) {
    throw new ToolExecutionError({
      code: 'TOOL_AUTH_FAILED',
      message:
        'AWS IAM request signing failed before dispatch. Verify the auth profile configuration and retry.',
      toolName,
      toolType: 'http',
      retryable: false,
      cause: error,
    });
  }
}
