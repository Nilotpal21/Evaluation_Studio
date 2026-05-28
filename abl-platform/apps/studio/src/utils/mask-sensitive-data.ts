/**
 * Browser-safe sensitive data masking for display in Studio UI.
 *
 * Reuses the same regex patterns and Luhn validation as SecretMaskingService
 * but avoids the `require('crypto')` dependency so it can run client-side
 * without bundler issues.
 *
 * Strategy: always redact (replace with '***REDACTED***').
 */

// ---------------------------------------------------------------------------
// Regex patterns (mirrored from services/security/secret-masking.ts)
// ---------------------------------------------------------------------------

const PATTERNS = {
  bearerToken: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  apiKey:
    /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{20,})["']?/gi,
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(?<!\d)(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}(?!\d)/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b\d(?:[ -]*\d){12,18}\b/g,
  keyPrefix:
    /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|abl_[a-z]+_[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36})\b/g,
};

const REDACTED = '***REDACTED***';

const SAFE_DSL_KEYS = new Set([
  'auth',
  'auth_config',
  'auth_jit',
  'auth_profile',
  'client_id',
  'connection',
  'consent',
  'header_name',
  'provider',
  'scopes',
  'token_url',
]);

const EXACT_SECRET_DSL_KEYS = new Set([
  'access_key',
  'access_token',
  'api_key',
  'apikey',
  'auth_token',
  'authorization',
  'bearer_token',
  'client_secret',
  'clientsecret',
  'cookie',
  'id_token',
  'password',
  'private_key',
  'proxy_authorization',
  'refresh_token',
  'secret_key',
  'set_cookie',
  'token',
]);

const SECRET_KEY_PATTERNS = [
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'api-key',
  'auth',
  'credential',
  'private_key',
  'privatekey',
  'access_key',
  'accesskey',
  'client_secret',
  'clientsecret',
];

// ---------------------------------------------------------------------------
// Luhn validation (mirrored from services/security/secret-masking.ts)
// ---------------------------------------------------------------------------

function isValidLuhn(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Key name check
// ---------------------------------------------------------------------------

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p));
}

function normalizeDslKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[.:-]+/g, '_')
    .replace(/_+/g, '_');
}

function isSensitiveDslKey(key: string): boolean {
  const normalized = normalizeDslKey(key);
  if (SAFE_DSL_KEYS.has(normalized)) return false;
  if (EXACT_SECRET_DSL_KEYS.has(normalized)) return true;

  return [
    /(^|_)api_?key($|_)/,
    /(^|_)auth($|_)/,
    /(^|_)credential($|_)/,
    /(^|_)password($|_)/,
    /(^|_)private_?key($|_)/,
    /(^|_)secret($|_)/,
    /(^|_)token($|_)/,
    /(^|_)access_?key($|_)/,
    /(^|_)access_?token($|_)/,
    /(^|_)refresh_?token($|_)/,
  ].some((pattern) => pattern.test(normalized));
}

function maskDslValue(rawValue: string): { value: string; startsBlock: boolean } {
  const trimmed = rawValue.trimStart();
  const leading = rawValue.slice(0, rawValue.length - trimmed.length);
  const startsBlock = /^[|>]/.test(trimmed);

  if (startsBlock) {
    return { value: `${leading}"${REDACTED}"`, startsBlock: true };
  }

  const firstChar = trimmed[0];
  if (firstChar === '"' || firstChar === "'") {
    const commentMatch = trimmed.match(new RegExp(`\\${firstChar}\\s*(#.*)$`));
    return {
      value: `${leading}${firstChar}${REDACTED}${firstChar}${commentMatch?.[1] ? ` ${commentMatch[1]}` : ''}`,
      startsBlock: false,
    };
  }

  const commentIndex = trimmed.indexOf(' #');
  const comment = commentIndex >= 0 ? trimmed.slice(commentIndex) : '';
  return { value: `${leading}${REDACTED}${comment}`, startsBlock: false };
}

function maskSecretDslLine(line: string): { line: string; startsBlock: boolean; indent: number } {
  const match = line.match(/^(\s*)(\{\{[\w.]+\}\}|[\w.:-]+)(\s*:\s*)(.*)$/);
  if (!match) {
    return { line, startsBlock: false, indent: 0 };
  }

  const [, indent, key, separator, rawValue] = match;
  const lineIndent = indent.length;
  if (!rawValue.trim() || !isSensitiveDslKey(key)) {
    return { line, startsBlock: false, indent: lineIndent };
  }

  const masked = maskDslValue(rawValue);
  return {
    line: `${indent}${key}${separator}${masked.value}`,
    startsBlock: masked.startsBlock,
    indent: lineIndent,
  };
}

// ---------------------------------------------------------------------------
// String masking
// ---------------------------------------------------------------------------

function maskString(value: string): string {
  let result = value;

  result = result.replace(PATTERNS.bearerToken, () => `Bearer ${REDACTED}`);

  result = result.replace(PATTERNS.apiKey, (match, key) => match.replace(key, REDACTED));
  result = result.replace(PATTERNS.keyPrefix, () => REDACTED);

  result = result.replace(PATTERNS.email, () => REDACTED);
  result = result.replace(PATTERNS.ssn, () => REDACTED);

  // Credit card BEFORE phone — phone regex can match digit subsets of CC numbers
  result = result.replace(PATTERNS.creditCard, (match) => {
    const digits = match.replace(/\D/g, '');
    if (isValidLuhn(digits)) {
      return REDACTED;
    }
    return match;
  });

  result = result.replace(PATTERNS.phone, () => REDACTED);

  return result;
}

/**
 * Mask secret-bearing values in raw tool DSL before rendering read-only previews.
 * This is display-only; callers must keep using the original DSL for parsing and saves.
 */
export function maskRawDslForDisplay(dslContent: string): string {
  let redactingBlockIndent: number | null = null;

  return dslContent
    .split('\n')
    .flatMap((line) => {
      if (redactingBlockIndent !== null) {
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;

        if (!trimmed || indent > redactingBlockIndent) {
          return [];
        }

        redactingBlockIndent = null;
      }

      const masked = maskSecretDslLine(maskString(line));
      if (masked.startsBlock) {
        redactingBlockIndent = masked.indent;
      }
      return [masked.line];
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Deep object masking
// ---------------------------------------------------------------------------

/** Recursively mask all sensitive string values in an object for display. */
export function maskForDisplay<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return maskString(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => maskForDisplay(item)) as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSecretKey(key) && typeof value === 'string') {
        result[key] = REDACTED;
      } else {
        result[key] = maskForDisplay(value);
      }
    }
    return result as T;
  }

  return obj;
}
