/**
 * Typed errors for the Arch AI engine.
 */

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export class ExitCriteriaNotMetError extends Error {
  constructor(public readonly phase: string) {
    super(`Exit criteria not met for phase: ${phase}`);
    this.name = 'ExitCriteriaNotMetError';
  }
}

export class SessionBusyError extends Error {
  constructor() {
    super('A response is already streaming for this session. Please wait.');
    this.name = 'SessionBusyError';
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionArchivedError extends Error {
  constructor(sessionId: string) {
    super(`Session is archived: ${sessionId}`);
    this.name = 'SessionArchivedError';
  }
}

export class SessionAlreadyExistsError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly userId: string,
  ) {
    super('A non-terminal session already exists for this user. Archive it first.');
    this.name = 'SessionAlreadyExistsError';
  }
}

export class LoopDetectedError extends Error {
  constructor(
    public readonly specialist: string,
    public readonly toolName: string,
  ) {
    super(`Loop detected: ${specialist} called ${toolName} 5 times with identical input`);
    this.name = 'LoopDetectedError';
  }
}

// ─── File Store Errors (B03 Multimodality) ──────────────────────────────────

export class FileNotFoundError extends Error {
  constructor(public readonly blobId: string) {
    super(`File not found: ${blobId}`);
    this.name = 'FileNotFoundError';
  }
}

export class FileTooLargeError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly actualSize: number,
    public readonly maxSize: number,
  ) {
    super(`File "${fileName}" exceeds size limit: ${actualSize} bytes (max ${maxSize})`);
    this.name = 'FileTooLargeError';
  }
}

export class FileCorruptError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly reason: string,
  ) {
    super(`File "${fileName}" appears corrupt: ${reason}`);
    this.name = 'FileCorruptError';
  }
}

export class SessionFileQuotaError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly requestedTotal: number,
    public readonly quota: number,
  ) {
    super(`Session ${sessionId} file quota exceeded: ${requestedTotal} bytes (quota ${quota})`);
    this.name = 'SessionFileQuotaError';
  }
}

// ─── Error Classification (Phase 2.1) ─────────────────────────────────────────

export type ErrorCategory = 'retriable' | 'permanent' | 'rate_limited';

/**
 * Classify a tool execution error to determine retry strategy.
 *
 * - rate_limited: 429 / rate limit errors → wait longer, retry once
 * - retriable: transient infra errors (timeouts, connection resets, 5xx) → retry with backoff
 * - permanent: everything else → pass error to LLM as tool result
 */
export function classifyToolError(error: unknown): ErrorCategory {
  const msg = error instanceof Error ? error.message : String(error);

  // Rate limits
  if (/rate.limit|429|too many requests/i.test(msg)) return 'rate_limited';

  // Transient infrastructure errors
  if (/timeout|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|network|ETIMEDOUT/i.test(msg))
    return 'retriable';
  if (/503|502|500|internal server error/i.test(msg)) return 'retriable';

  // Everything else is permanent
  return 'permanent';
}
