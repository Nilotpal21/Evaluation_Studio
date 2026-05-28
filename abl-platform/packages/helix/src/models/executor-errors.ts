/**
 * Named error classes for executor-level failure discrimination.
 *
 * These classes are NOT thrown from inside executor .execute() methods —
 * executors honor the error-as-data contract (ExecutorResult.error string).
 * The classes are instantiated by higher-level orchestrators (e.g., the
 * dueling-plan-generation executor) that inspect ExecutorResult.error and
 * wrap non-empty strings into typed classes for discriminated classification.
 *
 * Exception: BudgetExceededError may be raised inside OpenAiApiExecutor.execute()
 * but is caught there and converted to an ExecutorResult.error string before
 * returning — it is never visible to ModelRouter or pipeline callers.
 */

export class OpenAiApiError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  constructor(code: string, statusCode?: number, message?: string) {
    super(message ?? code);
    this.name = 'OpenAiApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class StructuredOutputParseError extends Error {
  readonly schemaId: string;
  readonly parseDetail?: unknown;
  constructor(schemaId: string, message: string, parseDetail?: unknown) {
    super(message);
    this.name = 'StructuredOutputParseError';
    this.schemaId = schemaId;
    this.parseDetail = parseDetail;
  }
}

export class BudgetExceededError extends Error {
  readonly budgetUsd: number;
  readonly actualUsd: number;
  constructor(budgetUsd: number, actualUsd: number) {
    super(`Budget exceeded: $${actualUsd.toFixed(2)} > $${budgetUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
    this.budgetUsd = budgetUsd;
    this.actualUsd = actualUsd;
  }
}

export class StallDetectedError extends Error {
  readonly stallMs: number;
  constructor(stallMs: number, message?: string) {
    super(message ?? `Stream stalled for ${stallMs}ms`);
    this.name = 'StallDetectedError';
    this.stallMs = stallMs;
  }
}

export class CodexCliError extends Error {
  readonly exitCode?: number;
  readonly code: string;
  constructor(code: string, exitCode?: number, message?: string) {
    super(message ?? code);
    this.name = 'CodexCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class ClaudeSdkError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'ClaudeSdkError';
    this.code = code;
  }
}
