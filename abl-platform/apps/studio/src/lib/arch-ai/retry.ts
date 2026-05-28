import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('arch-ai:retry');

export interface RetryResult<T> {
  result: T | null;
  errors: string[];
}

/**
 * Retry an async function up to maxRetries times, collecting error messages.
 * Returns the first successful result or null with all errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  context: string,
): Promise<RetryResult<T>> {
  const errors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      return { result, errors };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${context} attempt ${attempt + 1}: ${msg}`);
      log.warn(`${context} attempt ${attempt + 1} failed`, { error: msg });
    }
  }

  return { result: null, errors };
}
