/**
 * Shared timeout parsing for coordination config.
 *
 * Mirrors runtime timeout semantics:
 * - bare numbers are milliseconds
 * - supported suffixes are ms, s, and m
 */

const TIMEOUT_PATTERN = /^(\d+)(ms|s|m)?$/;

function normalizeTimeoutLiteral(timeout: string | undefined): string | undefined {
  if (typeof timeout !== 'string') {
    return undefined;
  }

  const trimmed = timeout.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function parseTimeoutString(timeout?: string): number | undefined {
  const normalized = normalizeTimeoutLiteral(timeout);
  if (!normalized) {
    return undefined;
  }

  const match = normalized.match(TIMEOUT_PATTERN);
  if (!match) {
    return undefined;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2] || 'ms';

  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    default:
      return value;
  }
}

export function isValidTimeoutString(timeout: string | undefined): boolean {
  const normalized = normalizeTimeoutLiteral(timeout);
  return typeof normalized === 'string' && TIMEOUT_PATTERN.test(normalized);
}
