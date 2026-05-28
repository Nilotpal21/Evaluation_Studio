/**
 * NLU Sidecar Client
 *
 * HTTP client for the Python NLU sidecar service that handles ML-based entity
 * extraction and correction detection. Includes a self-contained circuit
 * breaker to fail-fast when the sidecar is unavailable.
 *
 * Circuit breaker states:
 *   CLOSED    -> Normal operation, requests pass through to the sidecar
 *   OPEN      -> Requests fail-fast (no HTTP attempt), returns `circuit_open`
 *   HALF_OPEN -> Probe: allow one request through to test recovery
 *
 * Every call returns a tagged `TaggedResult<T, SidecarError>`. Callers must
 * branch on `.ok` (never expect a bare `null`). On failure, `.error.kind`
 * distinguishes outage (`unavailable` / `timeout` / `circuit_open`) from
 * contract outcomes (`no_match` / `invalid_response` / `not_implemented` /
 * `bad_status`). Only outage kinds should trigger operator-visible
 * `lexical_fallback='when_unavailable'` reroutes.
 *
 * Tenancy contract (Finding 1c7efeb2):
 *   Every request carries `tenantId`, `projectId`, `sessionId` both as HTTP
 *   headers (`x-abl-tenant-id`, `x-abl-project-id`, `x-abl-session-id`) and
 *   as top-level echo fields in the JSON body. The sidecar validates and
 *   logs these values; runtime tests assert they are sent on every call.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  makeSidecarError,
  ok,
  err,
  type SidecarError,
  type TaggedResult,
} from '@agent-platform/shared-kernel';

const log = createLogger('nlu-sidecar-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SidecarConfig {
  /** Base URL of the NLU sidecar (e.g. http://localhost:8090) */
  url: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Number of consecutive failures before opening the circuit */
  circuitBreakerThreshold: number;
  /** Time in ms to wait before transitioning from open to half-open */
  circuitBreakerResetMs: number;
}

export interface ExtractionField {
  name: string;
  type: string;
  hints: string[];
}

/**
 * Per-call tenancy context propagated on every sidecar request.
 *
 * The sidecar validates these headers (Finding afaa28f6) — a request with
 * missing tenancy will be rejected with 400 by the sidecar.
 */
export interface SidecarCallContext {
  tenantId: string;
  projectId: string;
  sessionId: string;
}

export interface ExtractionRequest {
  text: string;
  fields: ExtractionField[];
  locale: string;
}

export interface ExtractionResult {
  entities: Record<string, unknown>;
  confidence: Record<string, number>;
}

export interface CorrectionRequest {
  text: string;
  context: Record<string, unknown>;
  locale: string;
}

export interface CorrectionResult {
  is_correction: boolean;
  field: string;
  new_value: unknown;
  confidence: number;
}

/** Re-export of the tagged envelope, scoped to `SidecarError`. */
export type SidecarResult<T> = TaggedResult<T, SidecarError>;
export type { SidecarError };

type CircuitState = 'closed' | 'open' | 'half-open';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_RESET_MS = 30_000;

// Header names — keep in sync with `apps/nlu-sidecar/app.py`.
export const SIDECAR_HEADER_TENANT_ID = 'x-abl-tenant-id';
export const SIDECAR_HEADER_PROJECT_ID = 'x-abl-project-id';
export const SIDECAR_HEADER_SESSION_ID = 'x-abl-session-id';

// ---------------------------------------------------------------------------
// NLU Sidecar Client
// ---------------------------------------------------------------------------

export class NLUSidecarClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerResetMs: number;

  // Circuit breaker state
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private probeInProgress = false;

  constructor(config: Partial<SidecarConfig> & { url: string }) {
    this.url = config.url.replace(/\/+$/, ''); // strip trailing slashes
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.circuitBreakerThreshold =
      config.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.circuitBreakerResetMs = config.circuitBreakerResetMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_MS;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Extract entities from user text using the NLU sidecar.
   *
   * Returns a tagged Result. On success, `value.entities` may be empty — an
   * empty entities map is STILL `ok` (the sidecar accepted the request and
   * produced a valid zero-match response). Only transport / parse / 501 /
   * circuit errors produce `err`.
   */
  async extract(
    req: ExtractionRequest,
    ctx: SidecarCallContext,
  ): Promise<SidecarResult<ExtractionResult>> {
    return this.post<ExtractionResult>('/extract', req, ctx, validateExtractionResult);
  }

  /**
   * Detect if the user's message is a correction to a previously gathered
   * field.
   *
   * Returns a tagged Result. `is_correction=false` is `ok` (contract success,
   * just no correction detected). `unavailable`/`timeout`/`circuit_open` are
   * transport outages.
   */
  async detectCorrection(
    req: CorrectionRequest,
    ctx: SidecarCallContext,
  ): Promise<SidecarResult<CorrectionResult>> {
    return this.post<CorrectionResult>('/detect-correction', req, ctx, validateCorrectionResult);
  }

  /**
   * Check the health of the NLU sidecar. Bypasses the circuit breaker so
   * operators can confirm recovery.
   */
  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(`${this.url}/health`, {
          method: 'GET',
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      log.debug('NLU sidecar health check failed', {
        url: this.url,
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Circuit breaker
  // -------------------------------------------------------------------------

  /**
   * Check if the circuit allows a request through.
   * Returns true if the request should proceed, false if short-circuited.
   */
  private shouldAllowRequest(): boolean {
    if (this.circuitState === 'closed') {
      return true;
    }

    if (this.circuitState === 'open') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.circuitBreakerResetMs) {
        // Transition to half-open: allow a single probe request
        this.circuitState = 'half-open';
        this.probeInProgress = true;
        log.info('NLU sidecar circuit breaker transitioning to half-open', {
          url: this.url,
          elapsedMs: elapsed,
        });
        return true;
      }
      return false;
    }

    // half-open: only allow one probe request through
    if (this.probeInProgress) {
      return false;
    }
    this.probeInProgress = true;
    return true;
  }

  private recordSuccess(): void {
    this.probeInProgress = false;
    if (this.circuitState === 'half-open' || this.circuitState === 'open') {
      log.info('NLU sidecar circuit breaker closing after successful probe', {
        url: this.url,
      });
    }
    this.consecutiveFailures = 0;
    this.circuitState = 'closed';
  }

  private recordFailure(): void {
    this.probeInProgress = false;
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.circuitState === 'half-open') {
      // Probe failed, go back to open
      this.circuitState = 'open';
      log.warn('NLU sidecar circuit breaker re-opening after probe failure', {
        url: this.url,
        consecutiveFailures: this.consecutiveFailures,
      });
      return;
    }

    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitState = 'open';
      log.warn('NLU sidecar circuit breaker opened', {
        url: this.url,
        consecutiveFailures: this.consecutiveFailures,
        threshold: this.circuitBreakerThreshold,
      });
    }
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private async post<T>(
    path: string,
    body: unknown,
    ctx: SidecarCallContext,
    validate: (raw: unknown) => T | null,
  ): Promise<SidecarResult<T>> {
    assertCallContext(ctx);

    if (!this.shouldAllowRequest()) {
      log.debug('NLU sidecar circuit breaker is open, skipping request', {
        url: this.url,
        path,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
      });
      return err(
        makeSidecarError('circuit_open', {
          message: `NLU sidecar circuit breaker is open for ${this.url}${path}`,
        }),
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    // Tenancy is carried both as HTTP headers AND echoed into the body so the
    // sidecar can log/validate without peeking at headers, and so downstream
    // ML plugins receive it via a single request-object surface.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [SIDECAR_HEADER_TENANT_ID]: ctx.tenantId,
      [SIDECAR_HEADER_PROJECT_ID]: ctx.projectId,
      [SIDECAR_HEADER_SESSION_ID]: ctx.sessionId,
    };
    const enrichedBody = {
      ...(body as Record<string, unknown>),
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      sessionId: ctx.sessionId,
    };

    try {
      const response = await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(enrichedBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        log.warn('NLU sidecar returned non-OK status', {
          url: this.url,
          path,
          status: response.status,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
        });
        // 501 Not Implemented is a contract outcome from the sidecar, not a
        // transport outage — it must NOT trip the circuit breaker. All other
        // non-OK statuses are treated as outages.
        if (response.status === 501) {
          this.recordSuccess();
          return err(
            makeSidecarError('not_implemented', {
              message: `NLU sidecar ${path} is not implemented on this deployment`,
              httpStatus: 501,
            }),
          );
        }
        this.recordFailure();
        return err(
          makeSidecarError('bad_status', {
            message: `NLU sidecar returned HTTP ${response.status} for ${path}`,
            httpStatus: response.status,
          }),
        );
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch (parseErr) {
        log.warn('NLU sidecar returned unparseable JSON', {
          url: this.url,
          path,
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        this.recordFailure();
        return err(
          makeSidecarError('invalid_response', {
            message: `NLU sidecar ${path} body could not be parsed as JSON`,
            cause: parseErr,
          }),
        );
      }

      const validated = validate(raw);
      if (!validated) {
        log.warn('NLU sidecar returned body that failed validation', {
          url: this.url,
          path,
        });
        this.recordFailure();
        return err(
          makeSidecarError('invalid_response', {
            message: `NLU sidecar ${path} returned a body that did not match the expected schema`,
          }),
        );
      }

      this.recordSuccess();
      return ok(validated);
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'AbortError';
      log.debug('NLU sidecar request failed', {
        url: this.url,
        path,
        timeout: isAbort,
        error: e instanceof Error ? e.message : String(e),
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
      });
      this.recordFailure();
      if (isAbort) {
        return err(
          makeSidecarError('timeout', {
            message: `NLU sidecar request to ${path} exceeded ${this.timeoutMs}ms`,
            cause: e,
          }),
        );
      }
      return err(
        makeSidecarError('unavailable', {
          message: `NLU sidecar request to ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Response validators
// ---------------------------------------------------------------------------

function validateExtractionResult(raw: unknown): ExtractionResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const entities = obj.entities;
  const confidence = obj.confidence;
  if (!entities || typeof entities !== 'object') return null;
  if (!confidence || typeof confidence !== 'object') return null;
  return {
    entities: entities as Record<string, unknown>,
    confidence: confidence as Record<string, number>,
  };
}

function validateCorrectionResult(raw: unknown): CorrectionResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.is_correction !== 'boolean') return null;
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : 0;
  // `field` and `new_value` are only required when is_correction is true.
  const field = typeof obj.field === 'string' ? obj.field : '';
  const newValue = 'new_value' in obj ? obj.new_value : undefined;
  if (obj.is_correction === true && (!field || newValue === undefined)) {
    return null;
  }
  return {
    is_correction: obj.is_correction,
    field,
    new_value: newValue,
    confidence,
  };
}

function assertCallContext(ctx: SidecarCallContext): void {
  if (!ctx || !ctx.tenantId || !ctx.projectId || !ctx.sessionId) {
    throw new Error(
      'NLUSidecarClient: SidecarCallContext.{tenantId,projectId,sessionId} are required — ' +
        'every sidecar call must carry tenancy for isolation and audit.',
    );
  }
}
