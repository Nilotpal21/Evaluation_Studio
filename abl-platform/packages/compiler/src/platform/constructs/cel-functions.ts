/**
 * ABL Custom Function Library for CEL
 *
 * Registers 37 domain-specific functions under the `abl` namespace
 * so CEL expressions can use `abl.upper(x)`, `abl.mask(ssn, "last4")`, etc.
 *
 * Uses the Environment API from @marcbachmann/cel-js:
 * - A custom type `AblNamespace` is registered as the receiver for all functions.
 * - An `abl` constant of type `AblNamespace` is injected into the environment.
 * - Functions are registered with typed signatures and overloads for optional params.
 *
 * All functions are pure (no side effects, no I/O) except:
 * - abl.now() -- returns current timestamp
 * - abl.unique_id() -- generates random ID
 */

import { Environment } from '@marcbachmann/cel-js';
import { containsPII, detectPII, redactPII } from '../security/pii-detector.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';
import { isPIIBypassFixEnabled } from '../security/_pii-bypass-fix.js';

// ---------------------------------------------------------------------------
// Intl.NumberFormat cache for format_currency
// ---------------------------------------------------------------------------

const currencyFormatters = new Map<string, Intl.NumberFormat>();
const MAX_FORMATTER_CACHE = 64;

function getCurrencyFormatter(currency: string, locale?: string): Intl.NumberFormat {
  const key = `${currency}:${locale ?? 'default'}`;
  let fmt = currencyFormatters.get(key);
  if (!fmt) {
    if (currencyFormatters.size >= MAX_FORMATTER_CACHE) {
      const firstKey = currencyFormatters.keys().next().value;
      if (firstKey) currencyFormatters.delete(firstKey);
    }
    fmt = new Intl.NumberFormat(locale ?? 'en-US', { style: 'currency', currency });
    currencyFormatters.set(key, fmt);
  }
  return fmt;
}

// ---------------------------------------------------------------------------
// Helper: BigInt-safe equality for array_find / array_find_index
// CEL integer literals are BigInt while context values are plain numbers.
// ---------------------------------------------------------------------------

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'bigint' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'bigint') return a === Number(b);
  return a === b;
}

// ---------------------------------------------------------------------------
// Bounded string repeat
// ---------------------------------------------------------------------------

const MAX_STRING_LENGTH = 100_000;

// ---------------------------------------------------------------------------
// AblNamespace sentinel class (receiver for all abl.* functions)
// ---------------------------------------------------------------------------

class AblNamespace {}

export interface AblCelEnvironmentOptions {
  piiRecognizerRegistry?: PIIRecognizerRegistry;
}

const registryBoundEnvironmentCache = new WeakMap<
  PIIRecognizerRegistry,
  InstanceType<typeof Environment>
>();

// ---------------------------------------------------------------------------
// Environment factory
// ---------------------------------------------------------------------------

/**
 * Create a CEL Environment with all ABL custom functions registered.
 *
 * The returned environment has `unlistedVariablesAreDyn: true` so user context
 * variables do not need to be pre-declared.
 *
 * The environment is designed to be created once and reused across evaluations.
 */
export function createAblCelEnvironment(
  options?: AblCelEnvironmentOptions,
): InstanceType<typeof Environment> {
  const env = new Environment({ unlistedVariablesAreDyn: true });
  const piiRecognizerRegistry = options?.piiRecognizerRegistry;

  // Register the namespace type and constant
  env.registerType('AblNamespace', { ctor: AblNamespace, fields: {} });
  env.registerConstant('abl', 'AblNamespace', new AblNamespace());

  // ----- String functions -----

  env.registerFunction('AblNamespace.upper(dyn): string', (_self: unknown, s: unknown) =>
    typeof s === 'string' ? s.toUpperCase() : String(s ?? '').toUpperCase(),
  );

  env.registerFunction('AblNamespace.lower(dyn): string', (_self: unknown, s: unknown) =>
    typeof s === 'string' ? s.toLowerCase() : String(s ?? '').toLowerCase(),
  );

  env.registerFunction('AblNamespace.trim(dyn): string', (_self: unknown, s: unknown) =>
    String(s ?? '').trim(),
  );

  // substring(s, start)
  env.registerFunction(
    'AblNamespace.substring(string, int): string',
    (_self: unknown, s: string, start: unknown) => s.substring(Number(start)),
  );
  // substring(s, start, end)
  env.registerFunction(
    'AblNamespace.substring(string, int, int): string',
    (_self: unknown, s: string, start: unknown, end: unknown) =>
      s.substring(Number(start), Number(end)),
  );

  env.registerFunction(
    'AblNamespace.replace(string, string, string): string',
    (_self: unknown, s: string, find: string, repl: string) => s.split(find).join(repl),
  );

  env.registerFunction(
    'AblNamespace.split(string, string): dyn',
    (_self: unknown, s: string, delim: string) => s.split(delim),
  );

  // join(arr, delim)
  env.registerFunction(
    'AblNamespace.join(dyn, string): string',
    (_self: unknown, arr: unknown, delim: string) =>
      Array.isArray(arr) ? arr.join(delim) : String(arr ?? ''),
  );
  // join(arr) -- default delimiter ","
  env.registerFunction('AblNamespace.join(dyn): string', (_self: unknown, arr: unknown) =>
    Array.isArray(arr) ? arr.join(',') : String(arr ?? ''),
  );

  // pad_start(s, len, ch)
  env.registerFunction(
    'AblNamespace.pad_start(string, int, string): string',
    (_self: unknown, s: string, len: unknown, ch: string) => s.padStart(Number(len), ch),
  );
  // pad_start(s, len) -- default pad char " "
  env.registerFunction(
    'AblNamespace.pad_start(string, int): string',
    (_self: unknown, s: string, len: unknown) => s.padStart(Number(len), ' '),
  );

  // pad_end(s, len, ch)
  env.registerFunction(
    'AblNamespace.pad_end(string, int, string): string',
    (_self: unknown, s: string, len: unknown, ch: string) => s.padEnd(Number(len), ch),
  );
  // pad_end(s, len) -- default pad char " "
  env.registerFunction(
    'AblNamespace.pad_end(string, int): string',
    (_self: unknown, s: string, len: unknown) => s.padEnd(Number(len), ' '),
  );

  env.registerFunction(
    'AblNamespace.repeat(string, int): string',
    (_self: unknown, s: string, count: unknown) => {
      const n = Math.min(
        Math.max(0, Math.floor(Number(count))),
        Math.floor(MAX_STRING_LENGTH / (s.length || 1)),
      );
      return s.repeat(n);
    },
  );

  // ----- Numeric functions -----

  // round(n) -- round to integer
  env.registerFunction('AblNamespace.round(double): double', (_self: unknown, n: number) =>
    Math.round(n),
  );
  // round(n, decimals)
  env.registerFunction(
    'AblNamespace.round(double, int): double',
    (_self: unknown, n: number, decimals: unknown) => {
      const d = Number(decimals);
      const factor = Math.pow(10, d);
      return Math.round(n * factor) / factor;
    },
  );

  env.registerFunction('AblNamespace.abs(double): double', (_self: unknown, n: number) =>
    Math.abs(n),
  );

  env.registerFunction(
    'AblNamespace.min(dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown) => {
      const na = Number(a);
      const nb = Number(b);
      return na < nb ? a : b;
    },
  );

  env.registerFunction(
    'AblNamespace.max(dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown) => {
      const na = Number(a);
      const nb = Number(b);
      return na > nb ? a : b;
    },
  );

  // ----- Formatting functions -----

  // mask(s, pattern)
  env.registerFunction(
    'AblNamespace.mask(string, string): string',
    (_self: unknown, s: string, pattern: string) => {
      const maskChar = '*';
      if (pattern === 'last4') return maskChar.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
      if (pattern === 'first4') return s.slice(0, 4) + maskChar.repeat(Math.max(0, s.length - 4));
      const match = pattern.match(/^(\d+)\*(\d+)$/);
      if (match) {
        const l = Number(match[1]);
        const r = Number(match[2]);
        return s.slice(0, l) + maskChar.repeat(Math.max(0, s.length - l - r)) + s.slice(-r);
      }
      return maskChar.repeat(s.length);
    },
  );
  // mask(s, pattern, ch) -- custom mask character
  env.registerFunction(
    'AblNamespace.mask(string, string, string): string',
    (_self: unknown, s: string, pattern: string, ch: string) => {
      if (pattern === 'last4') return ch.repeat(Math.max(0, s.length - 4)) + s.slice(-4);
      if (pattern === 'first4') return s.slice(0, 4) + ch.repeat(Math.max(0, s.length - 4));
      const match = pattern.match(/^(\d+)\*(\d+)$/);
      if (match) {
        const l = Number(match[1]);
        const r = Number(match[2]);
        return s.slice(0, l) + ch.repeat(Math.max(0, s.length - l - r)) + s.slice(-r);
      }
      return ch.repeat(s.length);
    },
  );

  // format_currency(n, currency)
  env.registerFunction(
    'AblNamespace.format_currency(double, string): string',
    (_self: unknown, n: number, currency: string) => getCurrencyFormatter(currency).format(n),
  );
  // format_currency(n, currency, locale)
  env.registerFunction(
    'AblNamespace.format_currency(double, string, string): string',
    (_self: unknown, n: number, currency: string, locale: string) =>
      getCurrencyFormatter(currency, locale).format(n),
  );

  // format_date(d, fmt)
  env.registerFunction(
    'AblNamespace.format_date(string, string): string',
    (_self: unknown, d: string, fmt: string) => {
      const date = new Date(d);
      if (isNaN(date.getTime())) return d;
      return fmt
        .replace('YYYY', String(date.getFullYear()))
        .replace('MM', String(date.getMonth() + 1).padStart(2, '0'))
        .replace('DD', String(date.getDate()).padStart(2, '0'))
        .replace('HH', String(date.getHours()).padStart(2, '0'))
        .replace('mm', String(date.getMinutes()).padStart(2, '0'))
        .replace('ss', String(date.getSeconds()).padStart(2, '0'));
    },
  );
  // format_date(d, fmt, tz) -- timezone-aware via Intl.DateTimeFormat
  env.registerFunction(
    'AblNamespace.format_date(string, string, string): string',
    (_self: unknown, d: string, fmt: string, tz: string) => {
      const date = new Date(d);
      if (isNaN(date.getTime())) return d;
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).formatToParts(date);
        const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
        return fmt
          .replace('YYYY', get('year'))
          .replace('MM', get('month'))
          .replace('DD', get('day'))
          .replace('HH', get('hour'))
          .replace('mm', get('minute'))
          .replace('ss', get('second'));
      } catch {
        // Invalid timezone — fall back to local
        return fmt
          .replace('YYYY', String(date.getFullYear()))
          .replace('MM', String(date.getMonth() + 1).padStart(2, '0'))
          .replace('DD', String(date.getDate()).padStart(2, '0'))
          .replace('HH', String(date.getHours()).padStart(2, '0'))
          .replace('mm', String(date.getMinutes()).padStart(2, '0'))
          .replace('ss', String(date.getSeconds()).padStart(2, '0'));
      }
    },
  );

  // Ordinal suffix logic: 11th, 12th, 13th are special cases (all "th").
  // For other numbers: 1st, 2nd, 3rd, then "th" for 4-20, repeating.
  // (v-20)%10 maps 21->1, 22->2, 23->3; negative indices yield undefined -> fallback to suffixes[0].
  env.registerFunction('AblNamespace.ordinal(int): string', (_self: unknown, n: unknown) => {
    const num = Number(n);
    const suffixes = ['th', 'st', 'nd', 'rd'];
    const v = num % 100;
    return num + (suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]);
  });

  // ----- Type checking functions -----

  env.registerFunction('AblNamespace.is_array(dyn): bool', (_self: unknown, x: unknown) =>
    Array.isArray(x),
  );

  env.registerFunction(
    'AblNamespace.is_number(dyn): bool',
    (_self: unknown, x: unknown) => (typeof x === 'number' && !isNaN(x)) || typeof x === 'bigint',
  );

  env.registerFunction(
    'AblNamespace.is_string(dyn): bool',
    (_self: unknown, x: unknown) => typeof x === 'string',
  );

  env.registerFunction('AblNamespace.to_number(dyn): dyn', (_self: unknown, x: unknown) => {
    const n = Number(x);
    return isNaN(n) ? null : n;
  });

  env.registerFunction('AblNamespace.to_string(dyn): string', (_self: unknown, x: unknown) =>
    String(x ?? ''),
  );

  // ----- Array functions -----

  env.registerFunction('AblNamespace.length(dyn): int', (_self: unknown, x: unknown) => {
    if (Array.isArray(x)) return BigInt(x.length);
    if (typeof x === 'string') return BigInt(x.length);
    return 0n;
  });

  env.registerFunction(
    'AblNamespace.array_find(dyn, string, dyn): dyn',
    (_self: unknown, arr: unknown, field: string, value: unknown) => {
      if (!Array.isArray(arr)) return null;
      return (
        arr.find(
          (item: unknown) =>
            item !== null &&
            typeof item === 'object' &&
            looseEquals((item as Record<string, unknown>)[field], value),
        ) ?? null
      );
    },
  );

  env.registerFunction(
    'AblNamespace.array_find_index(dyn, string, dyn): int',
    (_self: unknown, arr: unknown, field: string, value: unknown) => {
      if (!Array.isArray(arr)) return -1n;
      const idx = arr.findIndex(
        (item: unknown) =>
          item !== null &&
          typeof item === 'object' &&
          looseEquals((item as Record<string, unknown>)[field], value),
      );
      return BigInt(idx);
    },
  );

  // ----- Object functions -----

  env.registerFunction('AblNamespace.object_keys(dyn): dyn', (_self: unknown, obj: unknown) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : [],
  );

  env.registerFunction('AblNamespace.object_values(dyn): dyn', (_self: unknown, obj: unknown) =>
    obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.values(obj) : [],
  );

  // object_merge(a, b) -- shallow merge two objects
  env.registerFunction(
    'AblNamespace.object_merge(dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown) => {
      const base = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
      const overlay = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
      return { ...base, ...overlay };
    },
  );
  // object_merge(a, b, c) -- shallow merge three objects
  env.registerFunction(
    'AblNamespace.object_merge(dyn, dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown, c: unknown) => {
      const objs = [a, b, c].map((o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {}));
      return Object.assign({}, ...objs);
    },
  );

  // ----- Utility functions -----

  // coalesce(a, b)
  env.registerFunction(
    'AblNamespace.coalesce(dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown) => (a !== null && a !== undefined ? a : b),
  );
  // coalesce(a, b, c)
  env.registerFunction(
    'AblNamespace.coalesce(dyn, dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown, c: unknown) => {
      if (a !== null && a !== undefined) return a;
      if (b !== null && b !== undefined) return b;
      return c;
    },
  );
  // coalesce(a, b, c, d)
  env.registerFunction(
    'AblNamespace.coalesce(dyn, dyn, dyn, dyn): dyn',
    (_self: unknown, a: unknown, b: unknown, c: unknown, d: unknown) => {
      if (a !== null && a !== undefined) return a;
      if (b !== null && b !== undefined) return b;
      if (c !== null && c !== undefined) return c;
      return d;
    },
  );

  env.registerFunction('AblNamespace.now(): string', (_self: unknown) => new Date().toISOString());

  // unique_id() -- default length 6
  env.registerFunction('AblNamespace.unique_id(): string', (_self: unknown) => generateId(6));
  // unique_id(len)
  env.registerFunction('AblNamespace.unique_id(int): string', (_self: unknown, len: unknown) =>
    generateId(Number(len)),
  );

  // ----- Guardrail functions -----

  // contains_pii(text) -- check if text contains PII (email, SSN, phone, card, IP).
  // PII_BYPASS_FIX_ENABLED=false short-circuits to false (legacy bypass).
  env.registerFunction('AblNamespace.contains_pii(dyn): bool', (_self: unknown, text: unknown) =>
    isPIIBypassFixEnabled() ? containsPII(String(text ?? ''), piiRecognizerRegistry) : false,
  );

  // detect_pii(text) -- return detection result with hasPII, detections, redacted.
  env.registerFunction('AblNamespace.detect_pii(dyn): dyn', (_self: unknown, text: unknown) => {
    const raw = String(text ?? '');
    if (!isPIIBypassFixEnabled()) {
      return { hasPII: false, detections: [], redacted: raw };
    }
    const result = detectPII(raw, piiRecognizerRegistry);
    return {
      hasPII: result.hasPII,
      detections: result.detections.map((d) => ({
        type: d.type,
        start: d.start,
        end: d.end,
        value: d.value,
        confidence: d.confidence,
        ...(d.recognizer ? { recognizer: d.recognizer } : {}),
      })),
      redacted: result.redacted,
    };
  });

  // redact_pii(text) -- redact all PII from text.
  env.registerFunction('AblNamespace.redact_pii(dyn): string', (_self: unknown, text: unknown) => {
    const raw = String(text ?? '');
    return isPIIBypassFixEnabled() ? redactPII(raw, piiRecognizerRegistry) : raw;
  });

  // matches_pattern(text, pattern) -- check if text matches a regex pattern
  env.registerFunction(
    'AblNamespace.matches_pattern(dyn, dyn): bool',
    (_self: unknown, text: unknown, pattern: unknown) => {
      try {
        const re = new RegExp(String(pattern ?? ''));
        return re.test(String(text ?? ''));
      } catch {
        return false;
      }
    },
  );

  // not_matches_pattern(text, pattern) -- negation of matches_pattern
  env.registerFunction(
    'AblNamespace.not_matches_pattern(dyn, dyn): bool',
    (_self: unknown, text: unknown, pattern: unknown) => {
      try {
        const re = new RegExp(String(pattern ?? ''));
        return !re.test(String(text ?? ''));
      } catch {
        return true;
      }
    },
  );

  // word_count(text) -- count words in text
  env.registerFunction('AblNamespace.word_count(dyn): int', (_self: unknown, text: unknown) => {
    const s = String(text ?? '').trim();
    if (s.length === 0) return 0;
    return s.split(/\s+/).length;
  });

  // sentence_count(text) -- count sentences in text (splits on . ? !)
  env.registerFunction('AblNamespace.sentence_count(dyn): int', (_self: unknown, text: unknown) => {
    const s = String(text ?? '').trim();
    if (s.length === 0) return 0;
    const sentences = s.split(/[.!?]+/).filter((seg) => seg.trim().length > 0);
    return sentences.length;
  });

  // contains_url(text) -- check if text contains HTTP/HTTPS URLs
  env.registerFunction('AblNamespace.contains_url(dyn): bool', (_self: unknown, text: unknown) =>
    /https?:\/\/[^\s]+/.test(String(text ?? '')),
  );

  // contains_email(text) -- check if text contains email addresses
  env.registerFunction('AblNamespace.contains_email(dyn): bool', (_self: unknown, text: unknown) =>
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(String(text ?? '')),
  );

  // contains_code(text) -- check if text contains fenced code blocks (``` ... ```)
  env.registerFunction('AblNamespace.contains_code(dyn): bool', (_self: unknown, text: unknown) =>
    /```[\s\S]*?```/.test(String(text ?? '')),
  );

  return env;
}

export function getAblCelEnvironment(
  options?: AblCelEnvironmentOptions,
): InstanceType<typeof Environment> {
  const registry = options?.piiRecognizerRegistry;
  if (!registry) {
    return ablCelEnvironment;
  }

  const cached = registryBoundEnvironmentCache.get(registry);
  if (cached) {
    return cached;
  }

  const env = createAblCelEnvironment(options);
  registryBoundEnvironmentCache.set(registry, env);
  return env;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a pseudorandom alphanumeric ID using Math.random().
 * NOT cryptographically secure — do not use for session tokens, API keys, or secrets.
 * For security-grade IDs, use crypto.randomBytes() instead.
 */
function generateId(length: number): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
  }
  return result;
}

/**
 * The singleton CEL environment with all ABL functions registered.
 * Created once and reused for all evaluations.
 */
export const ablCelEnvironment = createAblCelEnvironment();
