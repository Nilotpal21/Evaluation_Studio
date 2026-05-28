/**
 * Secret Masking Service
 *
 * Intercepts and masks sensitive data before it reaches any sink:
 * traces, logs, events, API responses, error messages.
 *
 * Patterns detected:
 * - Environment secrets (from ENV with secret: true)
 * - Bearer tokens (Authorization headers)
 * - API keys (common key patterns)
 * - PII (email, phone, SSN, credit card)
 * - Connection credentials
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MaskingStrategy = 'redact' | 'hash' | 'partial';

export interface MaskingConfig {
  strategy: MaskingStrategy;
  /** Number of chars to show at start/end for partial masking */
  partialReveal: number;
  /** Patterns to detect */
  patterns: {
    bearerTokens: boolean;
    apiKeys: boolean;
    emails: boolean;
    phones: boolean;
    ssns: boolean;
    creditCards: boolean;
    customPatterns: Array<{ name: string; regex: RegExp }>;
  };
  /** Known secret keys (from ENV declarations) */
  knownSecretKeys: Set<string>;
}

export interface MaskingResult {
  masked: boolean;
  fieldsCount: number;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: MaskingConfig = {
  strategy: 'redact',
  partialReveal: 4,
  patterns: {
    bearerTokens: true,
    apiKeys: true,
    emails: true,
    phones: true,
    ssns: true,
    creditCards: true,
    customPatterns: [],
  },
  knownSecretKeys: new Set(),
};

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const PATTERNS = {
  bearerToken: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  apiKey:
    /(?:api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{20,})["']?/gi,
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b(?:\d[ -]*?){13,19}\b/g,
  // Common key prefixes
  keyPrefix:
    /\b(sk-[a-zA-Z0-9]{20,}|pk-[a-zA-Z0-9]{20,}|abl_[a-z]+_[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36})\b/g,
};

// ---------------------------------------------------------------------------
// Masking functions
// ---------------------------------------------------------------------------

function redact(_value: string): string {
  return '***REDACTED***';
}

function hashValue(value: string): string {
  const { createHash } = require('crypto') as typeof import('crypto');
  return `[HASH:${createHash('sha256').update(value).digest('hex').slice(0, 8)}]`;
}

function partialMask(value: string, reveal: number): string {
  if (value.length <= reveal * 2) return '***';
  return `${value.slice(0, reveal)}...${value.slice(-reveal)}`;
}

function applyMask(value: string, strategy: MaskingStrategy, reveal: number): string {
  switch (strategy) {
    case 'redact':
      return redact(value);
    case 'hash':
      return hashValue(value);
    case 'partial':
      return partialMask(value, reveal);
  }
}

// ---------------------------------------------------------------------------
// Luhn validation for credit cards
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
// Secret Masking Service
// ---------------------------------------------------------------------------

export class SecretMaskingService {
  private config: MaskingConfig;

  constructor(config?: Partial<MaskingConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      patterns: { ...DEFAULT_CONFIG.patterns, ...config?.patterns },
      knownSecretKeys: config?.knownSecretKeys ?? new Set(),
    };
  }

  /** Register a known secret key name (from ENV parsing) */
  addSecretKey(key: string): void {
    this.config.knownSecretKeys.add(key.toLowerCase());
  }

  /** Mask a single string value */
  maskString(value: string): string {
    let result = value;
    const { strategy, partialReveal, patterns } = this.config;

    if (patterns.bearerTokens) {
      result = result.replace(
        PATTERNS.bearerToken,
        (match) => `Bearer ${applyMask(match.replace('Bearer ', ''), strategy, partialReveal)}`,
      );
    }

    if (patterns.apiKeys) {
      result = result.replace(PATTERNS.apiKey, (match, key) =>
        match.replace(key, applyMask(key, strategy, partialReveal)),
      );
      result = result.replace(PATTERNS.keyPrefix, (match) =>
        applyMask(match, strategy, partialReveal),
      );
    }

    if (patterns.emails) {
      result = result.replace(PATTERNS.email, (match) => applyMask(match, strategy, partialReveal));
    }

    if (patterns.phones) {
      result = result.replace(PATTERNS.phone, (match) => applyMask(match, strategy, partialReveal));
    }

    if (patterns.ssns) {
      result = result.replace(PATTERNS.ssn, (match) => applyMask(match, strategy, partialReveal));
    }

    if (patterns.creditCards) {
      result = result.replace(PATTERNS.creditCard, (match) => {
        const digits = match.replace(/\D/g, '');
        if (isValidLuhn(digits)) {
          return applyMask(match, strategy, partialReveal);
        }
        return match; // Not a valid CC number, leave unchanged
      });
    }

    for (const custom of patterns.customPatterns) {
      result = result.replace(custom.regex, (match) => applyMask(match, strategy, partialReveal));
    }

    return result;
  }

  /** Mask all string values in an object (deep walk) */
  maskObject<T>(obj: T): T {
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      return this.maskString(obj) as unknown as T;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.maskObject(item)) as unknown as T;
    }

    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        // Check if key name suggests a secret
        if (this.isSecretKey(key) && typeof value === 'string') {
          result[key] = applyMask(value, this.config.strategy, this.config.partialReveal);
        } else {
          result[key] = this.maskObject(value);
        }
      }
      return result as T;
    }

    return obj;
  }

  /** Check if a key name suggests it contains a secret */
  private isSecretKey(key: string): boolean {
    const lower = key.toLowerCase();

    // Check known secrets
    if (this.config.knownSecretKeys.has(lower)) return true;

    // Check common secret key patterns
    const secretPatterns = [
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

    return secretPatterns.some((p) => lower.includes(p));
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SecretMaskingService | null = null;

export function getSecretMaskingService(config?: Partial<MaskingConfig>): SecretMaskingService {
  if (!instance) {
    instance = new SecretMaskingService(config);
  }
  return instance;
}
