/**
 * PII Token Vault
 *
 * Reversible tokenization for PII values. Replaces detected PII with
 * {{PII:<type>:<uuid>}} tokens and stores originals for authorized consumers.
 *
 * Token format: {{PII:<type>:<uuid>}}
 * Consumer views:
 *   - LLM: sees tokens ({{PII:PHONE:abc123}})
 *   - User: sees masked values (***-***-4567)
 *   - Logs: sees [REDACTED_*] always
 *   - Tools: sees redacted values by default
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';
import { detectPIISelective, getPIIRedactLabel, type PIIType } from './pii-detector.js';
import type { PIIRecognizerRegistry } from './pii-recognizer-registry.js';

const log = createLogger('pii-vault');

/** Max tokens before oldest-first eviction (CLAUDE.md: every in-memory Map needs max size) */
const MAX_VAULT_TOKENS = 10_000;
const MAX_RANDOM_CACHE = 50_000;
const DEFAULT_RANDOM_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function createTokenRegex(): RegExp {
  return /\{\{PII:([^:}]+):([a-f0-9-]+)\}\}/g;
}

/** Matches RFC 4122 UUID-format strings (lowercase hex, 8-4-4-4-12). */
const BARE_UUID_REGEX = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g;

function formatTokenType(type: PIIType): string {
  const normalized = String(type)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'custom';
}

function collectTokenRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const tokenRegex = createTokenRegex();
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  return ranges;
}

function overlapsExistingToken(
  detection: { start: number; end: number },
  tokenRanges: Array<{ start: number; end: number }>,
): boolean {
  return tokenRanges.some((range) => detection.start < range.end && detection.end > range.start);
}

interface RandomCacheEntry {
  value: string;
  expiresAt: number;
}

interface PIIVaultOptions {
  now?: () => number;
  recognizerRegistry?: PIIRecognizerRegistry;
  randomCacheTtlMs?: number;
  maxRandomCacheEntries?: number;
  randomReplacementGenerator?: (config: RandomRedactionConfig, matchLength: number) => string;
}

export type PIIConsumer = 'llm' | 'user' | 'logs' | 'tools' | 'admin' | 'system' | (string & {});

export interface PIIToken {
  id: string;
  type: PIIType;
  original: string;
  token: string;
  /** Detection confidence carried over from the source PIIDetection (0..1). */
  confidence?: number;
  /** Originating recognizer name (e.g. 'core-email', 'eu-iban'). */
  recognizer?: string;
}

export interface TokenizeResult {
  text: string;
  tokens: PIIToken[];
}

export class PIIVault {
  private readonly store = new Map<string, PIIToken>();
  private readonly randomCache = new Map<string, RandomCacheEntry>();
  private readonly now: () => number;
  private recognizerRegistry?: PIIRecognizerRegistry;
  private readonly randomCacheTtlMs: number;
  private readonly maxRandomCacheEntries: number;
  private readonly randomReplacementGenerator: (
    config: RandomRedactionConfig,
    matchLength: number,
  ) => string;

  constructor(options: PIIVaultOptions = {}) {
    this.now = options.now ?? Date.now;
    this.recognizerRegistry = options.recognizerRegistry;
    this.randomCacheTtlMs = options.randomCacheTtlMs ?? DEFAULT_RANDOM_CACHE_TTL_MS;
    this.maxRandomCacheEntries = options.maxRandomCacheEntries ?? MAX_RANDOM_CACHE;
    this.randomReplacementGenerator =
      options.randomReplacementGenerator ?? generateRandomReplacement;
  }

  setRecognizerRegistry(registry: PIIRecognizerRegistry | undefined): void {
    this.recognizerRegistry = registry;
  }

  tokenize(
    text: string,
    exemptTypes?: Set<PIIType>,
    options?: { confidenceThreshold?: number },
  ): TokenizeResult {
    const result = detectPIISelective(text, exemptTypes, this.recognizerRegistry, options);

    if (!result.hasPII || result.redactedTypes.length === 0) {
      return { text, tokens: [] };
    }

    const tokens: PIIToken[] = [];
    const existingTokenRanges = collectTokenRanges(text);
    const threshold = options?.confidenceThreshold;
    const meetsThreshold = (detection: { confidence?: number }): boolean =>
      typeof threshold !== 'number' || threshold <= 0
        ? true
        : (detection.confidence ?? 1.0) >= threshold;
    const toTokenize = result.detections.filter(
      (d) =>
        (!exemptTypes || !exemptTypes.has(d.type)) &&
        meetsThreshold(d) &&
        !overlapsExistingToken(d, existingTokenRanges),
    );

    if (toTokenize.length === 0) {
      return { text, tokens: [] };
    }

    let tokenized = text;
    for (let i = toTokenize.length - 1; i >= 0; i--) {
      const det = toTokenize[i];
      const id = randomUUID();
      const token = `{{PII:${formatTokenType(det.type)}:${id}}}`;

      const piiToken: PIIToken = {
        id,
        type: det.type,
        original: text.substring(det.start, det.end),
        token,
        confidence: det.confidence,
        ...(det.recognizer ? { recognizer: det.recognizer } : {}),
      };

      this.store.set(id, piiToken);
      this.evictIfNeeded();
      tokens.unshift(piiToken);
      tokenized = tokenized.substring(0, det.start) + token + tokenized.substring(det.end);
    }

    log.debug('tokenized', { count: tokens.length, types: tokens.map((t) => t.type) });
    return { text: tokenized, tokens };
  }

  private evictIfNeeded(): void {
    if (this.store.size <= MAX_VAULT_TOKENS) return;
    const oldest = this.store.keys().next().value;
    if (oldest) {
      this.store.delete(oldest);
      log.warn('pii-vault-eviction', { size: this.store.size });
    }
  }

  detokenize(text: string): string {
    return text.replace(createTokenRegex(), (match, _type, id) => {
      const token = this.store.get(id);
      return token ? token.original : match;
    });
  }

  renderForConsumer(
    text: string,
    consumer: PIIConsumer | string,
    patternConfigs?: PIIPatternConfig[],
  ): string {
    // Pass 1: regex-based {{PII:type:id}} replacement
    let result = text.replace(createTokenRegex(), (match, _type: string, id: string) => {
      const token = this.store.get(id);
      if (!token) return match;
      return this.renderToken(token, consumer, patternConfigs, match);
    });

    // Pass 2: bare-UUID restoration — handles LLM-stripped {{PII:...}} wrappers.
    // Only scan if the vault has tokens (otherwise no UUIDs to match).
    if (this.store.size > 0) {
      result = this.restoreBareUUIDs(result, consumer, patternConfigs);
    }

    return result;
  }

  /**
   * Render text for a consumer AND report which tokens were actually substituted.
   * Same rendering logic as `renderForConsumer` — delegates to `renderToken()` —
   * but tracks matched token IDs via a `Set<string>` and returns defensive copies
   * of the corresponding `PIIToken` objects.
   *
   * Used by the audit emitter to log only the tokens the tool actually saw,
   * not every token in the session's vault.
   */
  renderForConsumerWithTrace(
    text: string,
    consumer: PIIConsumer | string,
    patternConfigs?: PIIPatternConfig[],
  ): {
    text: string;
    renderedTokens: PIIToken[];
    suppressedPatterns: Array<{ patternName: string; actualMode: PIIRenderMode }>;
  } {
    const renderedIds = new Set<string>();
    const suppressedPatterns: Array<{ patternName: string; actualMode: PIIRenderMode }> = [];

    // Pass 1: regex-based {{PII:type:id}} replacement
    let result = text.replace(createTokenRegex(), (match, _type: string, id: string) => {
      const token = this.store.get(id);
      if (!token) return match;
      renderedIds.add(id);
      // F-11: detect pattern-level override that suppresses 'original' access
      if (consumer === 'original') {
        const actualMode = resolveRenderMode(consumer, token.type, patternConfigs);
        if (actualMode !== 'original') {
          suppressedPatterns.push({ patternName: token.type, actualMode });
        }
      }
      return this.renderToken(token, consumer, patternConfigs, match);
    });

    // Pass 2: bare-UUID restoration — handles LLM-stripped {{PII:...}} wrappers.
    if (this.store.size > 0) {
      result = this.restoreBareUUIDsWithTrace(
        result,
        consumer,
        patternConfigs,
        renderedIds,
        suppressedPatterns,
      );
    }

    // Build defensive copies of matched tokens (same pattern as listTokens())
    const renderedTokens: PIIToken[] = [];
    for (const id of renderedIds) {
      const token = this.store.get(id);
      if (token) {
        renderedTokens.push({ ...token });
      }
    }

    return { text: result, renderedTokens, suppressedPatterns };
  }

  /**
   * Render a single PII token according to the resolved mode for the consumer.
   * Shared by both the regex-based pass and the bare-UUID restoration pass.
   */
  private renderToken(
    token: PIIToken,
    consumer: PIIConsumer | string,
    patternConfigs: PIIPatternConfig[] | undefined,
    tokenText: string,
  ): string {
    const mode = resolveRenderMode(consumer, token.type, patternConfigs);
    const config = patternConfigs?.find((c) => c.patternName === token.type);

    switch (mode) {
      case 'original':
        return token.original;
      case 'masked': {
        if (config?.maskConfig) {
          return applyMask(token.original, config.maskConfig, token.type);
        }
        return maskValue(token.original, token.type);
      }
      case 'redacted':
        return config?.redactionLabel ?? getPIIRedactLabel(token.type);
      case 'tokenized':
        return tokenText;
      case 'random': {
        if (config?.randomConfig) {
          return this.getCachedRandomReplacement(token.id, token.original, config.randomConfig);
        }
        return getPIIRedactLabel(token.type);
      }
      default:
        return getPIIRedactLabel(token.type);
    }
  }

  /**
   * Scan text for bare UUIDs (no {{PII:...}} wrapper) that match entries
   * in this session's vault. LLMs sometimes strip the token wrapper when
   * emitting tool-call arguments; this pass restores those values.
   *
   * Non-matching UUIDs pass through unchanged — no cross-session lookup,
   * no false positives on legitimate document IDs.
   *
   * ## False-Positive / Collision Risk (F-9)
   *
   * UUIDs are 128-bit random identifiers. For a vault with N tokens and
   * a tool call containing M non-vault UUIDs, the collision probability
   * is approximately N*M / 2^128 (birthday paradox does not apply here
   * because vault IDs and document IDs are generated independently).
   *
   * Example: 100 vault tokens, 10 document-ID UUIDs in a tool call
   * → 1000 comparisons → P(collision) ≈ 2.9 × 10^{-36} (negligible).
   *
   * Mitigations:
   *  1. Vault is session-scoped (no cross-session matching).
   *  2. Vault tokens are in-memory only — cleared on session end.
   *  3. If a false positive did occur, the tool would receive a PII value
   *     instead of a document ID. This would be detectable in the
   *     pii_plaintext_dispensed audit log (entity hash wouldn't match
   *     any known PII pattern for that customer).
   *
   * Accepted risk: negligible probability, bounded blast radius, auditable.
   */
  private restoreBareUUIDs(
    text: string,
    consumer: PIIConsumer | string,
    patternConfigs?: PIIPatternConfig[],
  ): string {
    return text.replace(BARE_UUID_REGEX, (match) => {
      const token = this.store.get(match);
      if (!token) return match; // Not a vault token — pass through
      return this.renderToken(token, consumer, patternConfigs, match);
    });
  }

  /**
   * Same as `restoreBareUUIDs` but records matched token IDs into the
   * provided `renderedIds` set for audit-precision tracking. Also detects
   * F-11 pattern-override suppressions for bare-UUID tokens.
   */
  private restoreBareUUIDsWithTrace(
    text: string,
    consumer: PIIConsumer | string,
    patternConfigs: PIIPatternConfig[] | undefined,
    renderedIds: Set<string>,
    suppressedPatterns: Array<{ patternName: string; actualMode: PIIRenderMode }>,
  ): string {
    return text.replace(BARE_UUID_REGEX, (match) => {
      const token = this.store.get(match);
      if (!token) return match; // Not a vault token — pass through
      renderedIds.add(token.id);
      // F-11: detect pattern-level override that suppresses 'original' access
      if (consumer === 'original') {
        const actualMode = resolveRenderMode(consumer, token.type, patternConfigs);
        if (actualMode !== 'original') {
          suppressedPatterns.push({ patternName: token.type, actualMode });
        }
      }
      return this.renderToken(token, consumer, patternConfigs, match);
    });
  }

  clear(): void {
    this.store.clear();
    this.randomCache.clear();
  }

  getTokenCount(): number {
    return this.store.size;
  }

  /**
   * Return a defensive snapshot of tokens currently held in memory.
   * Callers that persist or audit tokens must not receive references to the
   * internal map entries because terminal cleanup still owns the vault.
   */
  listTokens(): PIIToken[] {
    return Array.from(this.store.values(), (token) => ({ ...token }));
  }

  /**
   * Serialize vault contents to a JSON string for storage.
   * Does NOT include encryption — caller is responsible for encrypting.
   */
  serialize(): string {
    const entries = Array.from(this.store.entries());
    return JSON.stringify(entries);
  }

  /**
   * Restore vault from serialized JSON string.
   * Clears existing contents before restoring.
   */
  static deserialize(json: string, options: PIIVaultOptions = {}): PIIVault {
    const vault = new PIIVault(options);
    const entries: Array<[string, PIIToken]> = JSON.parse(json);
    for (const [id, token] of entries) {
      vault.store.set(id, token);
    }
    return vault;
  }

  /** Check if vault has any stored tokens */
  isEmpty(): boolean {
    return this.store.size === 0;
  }

  private getCachedRandomReplacement(
    tokenId: string,
    original: string,
    config: RandomRedactionConfig,
  ): string {
    const now = this.now();
    this.pruneExpiredRandomCache(now);

    const cached = this.randomCache.get(tokenId);
    if (cached && cached.expiresAt > now) {
      this.randomCache.delete(tokenId);
      this.randomCache.set(tokenId, {
        value: cached.value,
        expiresAt: now + this.randomCacheTtlMs,
      });
      return cached.value;
    }

    const replacement = this.randomReplacementGenerator(config, original.length);
    this.randomCache.set(tokenId, {
      value: replacement,
      expiresAt: now + this.randomCacheTtlMs,
    });
    this.evictRandomCacheIfNeeded();
    return replacement;
  }

  private pruneExpiredRandomCache(now: number): void {
    for (const [tokenId, entry] of this.randomCache.entries()) {
      if (entry.expiresAt <= now) {
        this.randomCache.delete(tokenId);
      }
    }
  }

  private evictRandomCacheIfNeeded(): void {
    while (this.randomCache.size > this.maxRandomCacheEntries) {
      const oldest = this.randomCache.keys().next().value;
      if (!oldest) {
        return;
      }
      this.randomCache.delete(oldest);
      log.warn('pii-random-cache-eviction', { size: this.randomCache.size });
    }
  }
}

export function maskValue(value: string, type: PIIType): string {
  switch (type) {
    case 'phone': {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : '***';
    }
    case 'email': {
      const [local, domain] = value.split('@');
      if (!local || !domain) return '***@***';
      return local.length > 1 ? `${local[0]}***@${domain}` : `***@${domain}`;
    }
    case 'credit_card': {
      const digits = value.replace(/\D/g, '');
      return digits.length >= 4 ? `****-****-****-${digits.slice(-4)}` : '****';
    }
    case 'ssn':
      return '***-**-****';
    case 'ip_address':
      return '***.***.***.***';
    default:
      return '***';
  }
}

// ─── Configurable Masking ──────────────────────────────────────────────────

export interface MaskConfig {
  showFirst: number;
  showLast: number;
  maskChar: string;
}

export const DEFAULT_MASK_CONFIGS: Record<string, MaskConfig> = {
  phone: { showFirst: 0, showLast: 4, maskChar: '*' },
  email: { showFirst: 1, showLast: 0, maskChar: '*' },
  ssn: { showFirst: 0, showLast: 0, maskChar: '*' },
  credit_card: { showFirst: 0, showLast: 4, maskChar: '*' },
  ip_address: { showFirst: 0, showLast: 0, maskChar: '*' },
};

/**
 * Apply a mask config to a value. Email-aware: preserves @domain.
 */
export function applyMask(value: string, config: MaskConfig, piiType?: string): string {
  if (piiType === 'email' && value.includes('@')) {
    return maskEmail(value, config);
  }

  const { showFirst, showLast, maskChar } = config;
  if (showFirst + showLast >= value.length) return value;

  const prefix = value.slice(0, showFirst);
  const suffix = showLast > 0 ? value.slice(-showLast) : '';
  const maskedLength = value.length - showFirst - showLast;
  return prefix + maskChar.repeat(maskedLength) + suffix;
}

function maskEmail(value: string, config: MaskConfig): string {
  const atIdx = value.indexOf('@');
  if (atIdx < 0) return applyMask(value, config);

  const local = value.slice(0, atIdx);
  const domain = value.slice(atIdx);

  const { showFirst, showLast, maskChar } = config;
  const effectiveFirst = Math.min(showFirst, local.length);
  const effectiveLast = Math.min(showLast, local.length - effectiveFirst);

  const prefix = local.slice(0, effectiveFirst);
  const suffix = effectiveLast > 0 ? local.slice(-effectiveLast) : '';
  const maskedLength = local.length - effectiveFirst - effectiveLast;

  return prefix + maskChar.repeat(Math.max(maskedLength, 0)) + suffix + domain;
}

// ─── Random Redaction ──────────────────────────────────────────────────────

export type RedactionType = 'predefined' | 'masked' | 'random' | 'tokenized';

export interface RandomRedactionConfig {
  charset: 'alphanumeric' | 'alphabetic' | 'numeric' | 'custom';
  customChars?: string;
  length?: number;
}

export const CHARSETS: Record<string, string> = {
  alphanumeric: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  numeric: '0123456789',
};

export function generateRandomReplacement(
  config: RandomRedactionConfig,
  matchLength: number,
): string {
  const charset =
    config.charset === 'custom' && config.customChars
      ? config.customChars
      : (CHARSETS[config.charset] ?? CHARSETS.alphanumeric);

  const length = config.length ?? matchLength;
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
}

/**
 * Backward-compatible stateless helper.
 * PIIVault now owns any per-session cache state.
 */
export function getRandomReplacement(original: string, config: RandomRedactionConfig): string {
  return generateRandomReplacement(config, original.length);
}

export function clearRandomCache(): void {
  // Random redaction cache is instance-scoped on PIIVault.
}

// ─── Consumer Access Control ───────────────────────────────────────────────

export type PIIConsumerBuiltin = 'llm' | 'user' | 'logs' | 'tools' | 'admin' | 'system';
export type PIIRenderMode = 'original' | 'masked' | 'redacted' | 'tokenized' | 'random';

export interface PIIConsumerAccessRule {
  consumer: string;
  renderMode: PIIRenderMode;
}

export interface PIIPatternConfig {
  patternName: string;
  defaultRenderMode: PIIRenderMode;
  consumerAccess: PIIConsumerAccessRule[];
  maskConfig?: MaskConfig;
  randomConfig?: RandomRedactionConfig;
  redactionLabel?: string;
}

/**
 * Resolve the render mode for a consumer given pattern configs.
 *
 * Resolution order:
 * 1. Pattern-level per-consumer override (if patternConfigs provided)
 * 2. Pattern-level defaultRenderMode
 * 3. Builtin default for the consumer type
 */
export function resolveRenderMode(
  consumer: PIIConsumer | string,
  patternName: string,
  patternConfigs?: PIIPatternConfig[],
): PIIRenderMode {
  if (patternConfigs) {
    const config = patternConfigs.find((c) => c.patternName === patternName);
    if (config) {
      const consumerRule = config.consumerAccess.find((ca) => ca.consumer === consumer);
      if (consumerRule) return consumerRule.renderMode;
      return config.defaultRenderMode;
    }
  }

  // Builtin defaults
  switch (consumer) {
    case 'original':
      return 'original';
    case 'tools':
      return 'redacted';
    case 'user':
      return 'masked';
    case 'logs':
      return 'redacted';
    case 'admin':
      return 'redacted';
    case 'system':
      return 'redacted';
    case 'llm':
      return 'tokenized';
    default:
      return 'redacted';
  }
}
