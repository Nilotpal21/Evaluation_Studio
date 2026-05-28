/**
 * Gvisor Sandbox Runner
 *
 * Implements SandboxRunner by calling gvisor-sandboxed Kubernetes pods directly.
 * Replaces the agenticai/backend tool service middleware — no intermediate HTTP hop.
 *
 * Absorbed from:
 * - agenticai/backend gvisor-execution.service.ts (JWT, $-prefix, routing)
 * - agenticai/backend gvisor.service.ts (HTTP client to pods)
 *
 * SECURITY:
 * - SSRF validation on pod URLs (internal host check)
 * - Bounded response (5MB max streaming guard)
 * - Error sanitization (no status codes/stack traces to LLM)
 */

import type { SandboxRunner } from './sandbox-tool-executor.js';
import { createLogger } from '../../logger.js';
import { ToolExecutionError } from '@agent-platform/shared';
const log = createLogger('gvisor-sandbox-runner');

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CODE_SIZE = 1024 * 1024; // 1MB max code content

export interface GvisorSandboxConfig {
  /** Python gvisor pod URL (e.g., http://kr-python-svc) */
  pythonPodUrl: string;
  /** JavaScript gvisor pod URL (e.g., http://kr-javascript-svc) */
  javascriptPodUrl: string;
  /** Pod endpoint path (default: /execute-script) */
  podPath: string;
  /** Default timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** Base URL for memory API callbacks (passed to sandbox pod as base_url) */
  memoryApiBaseUrl?: string;
}

export interface GvisorSessionContext {
  tenantId?: string;
  sessionId?: string;
  userId?: string;
  accountId?: string;
  /** App version ID — maps to agenticai `appvId` JWT claim */
  appvId?: string;
  projectId?: string;
  envId?: string;
}

/** JWT signer function — injected by runtime to keep compiler dependency-free */
export type JwtSigner = (claims: Record<string, unknown>) => Promise<string>;

/**
 * Validates a pod URL points to an internal host.
 * Logs a warning for non-internal hosts (doesn't block — operator may have valid reasons).
 */
function validatePodUrl(url: string, label: string): string {
  const parsed = new URL(url);
  const h = parsed.hostname;
  const isInternal =
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('-svc') ||
    /^10\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^192\.168\./.test(h);

  if (!isInternal) {
    log.warn('Pod URL points to non-internal host — ensure this is intentional', {
      label,
      hostname: h,
      url,
    });
  }
  return url;
}

/**
 * Gvisor pod response shape (from /execute-script endpoint).
 * Note: the result field is named `response`, NOT `result`.
 */
interface GvisorPodResponse {
  response: unknown;
  logs: string[];
  error?: string;
}

/**
 * Validate the shape of the gvisor pod response at runtime.
 */
function validateGvisorPodResponse(raw: unknown): GvisorPodResponse {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('Gvisor pod response is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!('response' in obj)) {
    throw new Error('Gvisor pod response missing "response" field');
  }
  let logs: string[] = [];
  if (Array.isArray(obj.logs)) {
    logs = obj.logs.filter((l): l is string => typeof l === 'string');
  }
  return {
    response: obj.response,
    logs,
    error: typeof obj.error === 'string' ? obj.error : undefined,
  };
}

/**
 * Preprocess tool params for gvisor pods.
 * JavaScript runtime: $-prefix all keys, filter system params (e.g., 'thought').
 * Python runtime: passthrough (no preprocessing).
 */
function preprocessParams(params: unknown, runtime: string): unknown {
  if (runtime !== 'javascript' || !params || typeof params !== 'object') {
    return params;
  }
  const input = params as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'thought') continue; // Filter system params
    result[`$${key}`] = value;
  }
  return result;
}

export class GvisorSandboxRunner implements SandboxRunner {
  private pythonUrl: string;
  private javascriptUrl: string;
  private podPath: string;
  private sessionContext?: GvisorSessionContext;
  private jwtSigner?: JwtSigner;
  private defaultTimeoutMs: number;

  constructor(
    private config: GvisorSandboxConfig,
    sessionContext?: GvisorSessionContext,
    jwtSigner?: JwtSigner,
  ) {
    this.sessionContext = sessionContext;
    this.jwtSigner = jwtSigner;
    this.defaultTimeoutMs = config.timeoutMs || 60000;

    // Validate pod URLs (SSRF check) — skip validation for empty/unconfigured URLs
    this.pythonUrl = config.pythonPodUrl ? validatePodUrl(config.pythonPodUrl, 'pythonPod') : '';
    this.javascriptUrl = config.javascriptPodUrl
      ? validatePodUrl(config.javascriptPodUrl, 'javascriptPod')
      : '';
    this.podPath = config.podPath;

    log.info('GvisorSandboxRunner initialized', {
      pythonUrl: this.pythonUrl || '(not configured)',
      javascriptUrl: this.javascriptUrl || '(not configured)',
      podPath: this.podPath,
      defaultTimeoutMs: this.defaultTimeoutMs,
      hasSessionContext: !!sessionContext,
      hasJwtSigner: !!jwtSigner,
      memoryApiBaseUrl: config.memoryApiBaseUrl || '(not configured)',
    });
  }

  /**
   * Select the pod URL based on runtime.
   * python → pythonPodUrl, everything else → javascriptPodUrl
   */
  private selectPodUrl(runtime: string): string {
    const url = runtime === 'python' ? this.pythonUrl : this.javascriptUrl;
    if (!url) {
      throw new Error(
        `No gvisor pod URL configured for runtime "${runtime}". ` +
          `Set SANDBOX_${runtime === 'python' ? 'PYTHON' : 'JAVASCRIPT'}_POD_URL.`,
      );
    }
    return url;
  }

  /**
   * Build the full pod endpoint URL for the given runtime.
   */
  private buildPodEndpoint(runtime: string): string {
    const baseUrl = this.selectPodUrl(runtime);
    // Ensure clean URL join
    const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const path = this.podPath.startsWith('/') ? this.podPath : `/${this.podPath}`;
    return `${base}${path}`;
  }

  /**
   * Generate JWT token for gvisor pod memory access.
   * Claims match agenticai convention: { sessionId, accountId, userId, appvId, envId, projectId }
   */
  private async generateAuthToken(): Promise<string | undefined> {
    if (!this.jwtSigner || !this.sessionContext) return undefined;

    const claims: Record<string, unknown> = {};
    if (this.sessionContext.sessionId) claims.sessionId = this.sessionContext.sessionId;
    if (this.sessionContext.accountId) claims.accountId = this.sessionContext.accountId;
    if (this.sessionContext.userId) claims.userId = this.sessionContext.userId;
    if (this.sessionContext.appvId) claims.appvId = this.sessionContext.appvId;
    if (this.sessionContext.projectId) claims.projectId = this.sessionContext.projectId;
    if (this.sessionContext.envId) claims.envId = this.sessionContext.envId;

    try {
      return await this.jwtSigner(claims);
    } catch (err) {
      log.error('Failed to generate JWT for gvisor pod', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * Read the response body with a streaming byte-count guard.
   * Content-Length is checked as an early hint but not trusted.
   */
  private async readBoundedResponse(response: Response): Promise<unknown> {
    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const size = parseInt(contentLength, 10);
      if (!isNaN(size) && size > MAX_RESPONSE_SIZE) {
        throw new Error(`Gvisor pod response too large (${size} bytes, max ${MAX_RESPONSE_SIZE})`);
      }
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      if (!text || text.trim().length === 0) {
        throw new ToolExecutionError({
          code: 'TOOL_EXECUTION_ERROR',
          message: 'Sandbox pod returned empty response body',
          toolName: 'sandbox',
          toolType: 'sandbox',
        });
      }
      if (text.length > MAX_RESPONSE_SIZE) {
        throw new Error(
          `Gvisor pod response too large (${text.length} bytes, max ${MAX_RESPONSE_SIZE})`,
        );
      }
      return JSON.parse(text);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_SIZE) {
          reader.cancel();
          throw new Error(`Gvisor pod response too large (>${MAX_RESPONSE_SIZE} bytes)`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const decoder = new TextDecoder();
    const text = chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
    if (!text || text.trim().length === 0) {
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: 'Sandbox pod returned empty response body',
        toolName: 'sandbox',
        toolType: 'sandbox',
      });
    }
    return JSON.parse(text);
  }

  async run(runConfig: {
    functionName: string;
    runtime: 'javascript' | 'python';
    codeContent: string;
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
  }): Promise<unknown> {
    const { functionName, codeContent, runtime, params, limits } = runConfig;

    const code = codeContent || null;

    if (!code) {
      throw new ToolExecutionError({
        code: 'TOOL_NOT_FOUND',
        message: `Sandbox tool "${functionName}" has no code content`,
        toolName: functionName,
        toolType: 'sandbox',
      });
    }

    if (code.length > MAX_CODE_SIZE) {
      throw new ToolExecutionError({
        code: 'TOOL_EXECUTION_ERROR',
        message: `Sandbox tool "${functionName}" code exceeds size limit (${code.length} bytes, max ${MAX_CODE_SIZE})`,
        toolName: functionName,
        toolType: 'sandbox',
      });
    }

    // Preprocess params ($-prefix for JavaScript, passthrough for Python)
    const processedParams = preprocessParams(params, runtime);

    // Build gvisor pod request body (matches /execute-script contract)
    const body = {
      script: code,
      args: processedParams,
      envParams: JSON.stringify({}),
      executionMode: 'execute',
      mockMemoryData: {},
      codeType: runtime,
      base_url: this.config.memoryApiBaseUrl || '',
    };

    const timeoutMs = limits.timeoutMs || this.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const podEndpoint = this.buildPodEndpoint(runtime);

    try {
      log.info('Gvisor pod call starting', {
        url: podEndpoint,
        tool: functionName,
        runtime,
        codeSize: code.length,
        timeoutMs,
        pythonUrl: this.pythonUrl,
        javascriptUrl: this.javascriptUrl,
        podPath: this.podPath,
        hasSessionContext: !!this.sessionContext,
        hasJwtSigner: !!this.jwtSigner,
        tenantId: this.sessionContext?.tenantId,
        sessionId: this.sessionContext?.sessionId,
      });

      // Build headers
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (this.sessionContext?.tenantId) {
        headers['X-Tenant-Id'] = this.sessionContext.tenantId;
      }

      // JWT auth (no "Bearer" prefix — matches agenticai convention)
      const token = await this.generateAuthToken();
      if (token) {
        headers['Authorization'] = token;
      }

      log.debug('Sending fetch to gvisor pod', {
        url: podEndpoint,
        method: 'POST',
        headerKeys: Object.keys(headers),
        bodyKeys: Object.keys(body),
        scriptLength: body.script.length,
        codeType: body.codeType,
        hasAuth: !!token,
      });

      const fetchStart = Date.now();
      const response = await fetch(podEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const fetchLatencyMs = Date.now() - fetchStart;

      log.info('Gvisor pod response received', {
        tool: functionName,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        fetchLatencyMs,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '(could not read response body)');
        log.error('Gvisor pod returned error response', {
          tool: functionName,
          runtime,
          url: podEndpoint,
          status: response.status,
          statusText: response.statusText,
          fetchLatencyMs,
          responseBody: text.substring(0, 500),
        });
        if (response.status >= 500) {
          throw new ToolExecutionError({
            code: 'TOOL_SANDBOX_ERROR',
            message: `Code tool internal error for tool "${functionName}"`,
            toolName: functionName,
            toolType: 'sandbox',
            statusCode: response.status,
            retryable: true,
          });
        } else {
          throw new ToolExecutionError({
            code: 'TOOL_SANDBOX_ERROR',
            message: `Code tool rejected request for tool "${functionName}" — check tool configuration`,
            toolName: functionName,
            toolType: 'sandbox',
            statusCode: response.status,
          });
        }
      }

      // Parse with bounded read and validate
      let data: GvisorPodResponse;
      try {
        const raw = await this.readBoundedResponse(response);
        data = validateGvisorPodResponse(raw);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('Gvisor pod response too large')) {
          throw err;
        }
        throw new Error(
          `Gvisor pod returned invalid response for tool "${functionName}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Check for error field in pod response
      if (data.error) {
        throw new Error(data.error);
      }

      // Log pod execution logs if present
      if (data.logs.length) {
        log.debug('Gvisor pod execution logs', { tool: functionName, logCount: data.logs.length });
      }

      // Process result (field is `response`, not `result`)
      const result = data.response;

      if (typeof result === 'string') {
        // [Error] prefix indicates tool error (matches vm.utils.ts pattern)
        if (result.startsWith('[Error]')) {
          throw new Error(result);
        }
        // Try to parse JSON string result
        try {
          return JSON.parse(result);
        } catch {
          return result;
        }
      }

      return result;
    } catch (err) {
      // Node.js fetch (undici) throws TypeError("fetch failed") with the real
      // error (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, etc.) nested in err.cause.
      const cause = err instanceof Error ? (err as { cause?: Error }).cause : undefined;
      const nestedCause = cause ? (cause as { cause?: Error }).cause : undefined;
      log.error('Gvisor pod call failed', {
        tool: functionName,
        runtime,
        url: podEndpoint,
        timeoutMs,
        errorName: err instanceof Error ? err.name : 'unknown',
        errorMessage: err instanceof Error ? err.message : String(err),
        errorCode:
          err instanceof Error && (err as NodeJS.ErrnoException).code
            ? (err as NodeJS.ErrnoException).code
            : undefined,
        causeName: cause?.name,
        causeMessage: cause?.message,
        causeCode: (cause as NodeJS.ErrnoException | undefined)?.code,
        nestedCauseMessage: nestedCause?.message,
        nestedCauseCode: (nestedCause as NodeJS.ErrnoException | undefined)?.code,
        diagnosis:
          cause && (cause as NodeJS.ErrnoException).code === 'ENOTFOUND'
            ? 'DNS_RESOLUTION_FAILED: K8s Service does not exist or is not in this namespace'
            : cause && (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED'
              ? 'CONNECTION_REFUSED: Pod exists but is not listening (gVisor/uvicorn may have failed to start)'
              : cause && (cause as NodeJS.ErrnoException).code === 'ETIMEDOUT'
                ? 'CONNECTION_TIMED_OUT: NetworkPolicy may be blocking traffic or pod is unreachable'
                : err instanceof Error && err.name === 'AbortError'
                  ? `ABORT_TIMEOUT: Request exceeded ${timeoutMs}ms timeout`
                  : 'UNKNOWN: Check causeCode for details',
      });
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Sandbox tool "${functionName}" timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
