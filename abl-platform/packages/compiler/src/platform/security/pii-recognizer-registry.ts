/**
 * Pluggable PII Recognizer Registry
 *
 * Presidio-inspired recognizer interface for extensible PII detection.
 * Three tiers: regex (built-in, fast), ml (NER-based), custom (domain-specific).
 */

import { createLogger } from '../logger.js';
import {
  createSafePIIDetection,
  removeOverlaps,
  type PIIType,
  type PIIDetection,
} from './pii-detector.js';
import { applyContextBoost } from './context-enhancer.js';
import { withTimeout } from './_with-timeout.js';
import { register as registerCorePack } from './recognizer-packs/core.js';

const log = createLogger('pii-recognizer-registry');

const MAX_RECOGNIZERS = 100;
const DEFAULT_ASYNC_LATENCY_BUDGET_MS = 200;

export type RecognizerTier = 'regex' | 'ml' | 'custom';

export interface PIIRecognizer {
  name: string;
  supportedTypes: PIIType[];
  tier: RecognizerTier;
  detect(text: string): PIIDetection[];
  /** Optional async detection path for cloud / NER recognizers. */
  detectAsync?(text: string): Promise<PIIDetection[]>;
}

/**
 * Optional config bag for RegexPIIRecognizer enabling context-word boost.
 *
 * - `contextWords` — single tokens only; pack authors must enumerate
 *   inflected forms explicitly (we do not pull in an NLP runtime).
 * - `contextBoost` — confidence delta applied when any context word
 *   appears within `contextWindowTokens` of the match. Defaults to 0.35.
 * - `baseConfidence` — confidence assigned in the absence of context.
 *   Defaults to 1.0 (legacy parity).
 */
export interface RegexPIIRecognizerConfig {
  contextWords?: string[];
  contextBoost?: number;
  baseConfidence?: number;
  contextWindowTokens?: number;
}

export class PIIRecognizerRegistry {
  private readonly recognizers = new Map<string, PIIRecognizer>();
  private readonly permanent = new Set<string>();
  private readonly disabledTypes = new Set<string>();

  register(recognizer: PIIRecognizer, options?: { permanent?: boolean }): void {
    if (this.recognizers.size >= MAX_RECOGNIZERS && !this.recognizers.has(recognizer.name)) {
      // Evict oldest non-permanent
      for (const [name] of this.recognizers) {
        if (!this.permanent.has(name)) {
          this.recognizers.delete(name);
          log.info('pii-recognizer-evicted', { name });
          break;
        }
      }
    }
    this.recognizers.set(recognizer.name, recognizer);
    if (options?.permanent) this.permanent.add(recognizer.name);
    log.debug('pii-recognizer-registered', {
      name: recognizer.name,
      tier: recognizer.tier,
      types: recognizer.supportedTypes,
    });
  }

  unregister(name: string): boolean {
    if (this.permanent.has(name)) {
      log.warn('pii-recognizer-unregister-permanent', { name });
      return false;
    }
    return this.recognizers.delete(name);
  }

  get(name: string): PIIRecognizer | undefined {
    return this.recognizers.get(name);
  }

  detectAll(
    text: string,
    exemptTypes?: Set<PIIType>,
    opts?: { onDegraded?: (reason: 'recognizer_threw', name: string) => void },
  ): PIIDetection[] {
    // Empty / whitespace-only text — fast path. Avoids constructing N
    // RegExp instances and walking N recognizers for no detections.
    if (!text) return [];
    const allDetections: PIIDetection[] = [];
    for (const recognizer of this.getRecognizersInDetectionOrder()) {
      try {
        const detections = recognizer.detect(text);
        for (const d of detections) {
          if (!this.disabledTypes.has(d.type) && (!exemptTypes || !exemptTypes.has(d.type))) {
            allDetections.push(
              createSafePIIDetection(d.type, d.start, d.end, {
                confidence: d.confidence,
                recognizer: d.recognizer ?? recognizer.name,
              }),
            );
          }
        }
      } catch (err) {
        log.warn('pii-recognizer-error', {
          name: recognizer.name,
          error: err instanceof Error ? err.message : String(err),
        });
        // Telemetry parity with detectAllAsync's recognizer_threw signal —
        // sync recognizers can also fail and the runtime caller deserves
        // observability symmetry across the two paths.
        opts?.onDegraded?.('recognizer_threw', recognizer.name);
      }
    }
    return allDetections;
  }

  /**
   * Async detection — runs sync recognizers via detectAll then races each
   * registered async recognizer against the supplied latency budget.
   * Async recognizers that exceed the budget or throw fire `onDegraded`.
   * The budget timer is always cleared (see _with-timeout.ts).
   */
  async detectAllAsync(
    text: string,
    opts?: {
      latencyBudgetMs?: number;
      exemptTypes?: Set<PIIType>;
      onDegraded?: (reason: 'async_budget_exceeded' | 'recognizer_threw', name?: string) => void;
    },
  ): Promise<PIIDetection[]> {
    const exemptTypes = opts?.exemptTypes;
    const budgetMs = opts?.latencyBudgetMs ?? DEFAULT_ASYNC_LATENCY_BUDGET_MS;
    const onDegraded = opts?.onDegraded;

    const sync = this.detectAll(text, exemptTypes);

    const asyncTasks: Array<Promise<PIIDetection[]>> = [];
    for (const recognizer of this.getRecognizersInDetectionOrder()) {
      if (typeof recognizer.detectAsync !== 'function') continue;
      const name = recognizer.name;
      const task = withTimeout(recognizer.detectAsync(text), budgetMs, `pii.detect.async:${name}`)
        .then((detections) =>
          detections
            .filter(
              (d) => !this.disabledTypes.has(d.type) && (!exemptTypes || !exemptTypes.has(d.type)),
            )
            .map((d) =>
              createSafePIIDetection(d.type, d.start, d.end, {
                confidence: d.confidence,
                recognizer: d.recognizer ?? name,
              }),
            ),
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          const isTimeout = /timeout after/.test(message);
          log.warn('pii-recognizer-async-error', { name, error: message });
          onDegraded?.(isTimeout ? 'async_budget_exceeded' : 'recognizer_threw', name);
          return [] as PIIDetection[];
        });
      asyncTasks.push(task);
    }

    const asyncResults = (await Promise.all(asyncTasks)).flat();
    const merged = [...sync, ...asyncResults].sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
    );
    return removeOverlaps(merged);
  }

  listRecognizers(): Array<{ name: string; tier: RecognizerTier; types: PIIType[] }> {
    return Array.from(this.recognizers.values()).map((r) => ({
      name: r.name,
      tier: r.tier,
      types: r.supportedTypes,
    }));
  }

  getRecognizerCount(): number {
    return this.recognizers.size;
  }

  disableType(type: PIIType): void {
    this.disabledTypes.add(type);
  }

  enableType(type: PIIType): void {
    this.disabledTypes.delete(type);
  }

  isTypeDisabled(type: PIIType): boolean {
    return this.disabledTypes.has(type);
  }

  private getRecognizersInDetectionOrder(): PIIRecognizer[] {
    return Array.from(this.recognizers.values()).sort(
      (left, right) => getRecognizerPriority(left) - getRecognizerPriority(right),
    );
  }
}

// =============================================================================
// BUILT-IN REGEX RECOGNIZERS
// =============================================================================

/**
 * Creates a RegexPIIRecognizer for a single PII type using a regex pattern
 * and optional validation function.
 */
export class RegexPIIRecognizer implements PIIRecognizer {
  constructor(
    readonly name: string,
    readonly supportedTypes: PIIType[],
    private readonly regex: RegExp,
    private readonly piiType: PIIType,
    private readonly validate?: (match: string) => boolean,
    readonly tier: RecognizerTier = 'regex',
    private readonly config?: RegexPIIRecognizerConfig,
  ) {}

  detect(text: string): PIIDetection[] {
    const detections: PIIDetection[] = [];
    // Create a fresh regex to avoid shared lastIndex state
    const re = new RegExp(this.regex.source, this.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const value = match[0];
      if (this.validate && !this.validate(value)) {
        if (value.length === 0) {
          re.lastIndex++;
        }
        continue;
      }
      const matchStart = match.index;
      const matchEnd = matchStart + value.length;
      const confidence = applyContextBoost(text, matchStart, matchEnd, this.config);
      detections.push(
        createSafePIIDetection(this.piiType, matchStart, matchEnd, {
          confidence,
          recognizer: this.name,
        }),
      );
      if (value.length === 0) {
        re.lastIndex++;
      }
    }

    return detections;
  }
}

function getRecognizerPriority(recognizer: PIIRecognizer): number {
  if (recognizer.tier === 'custom' || recognizer.name.startsWith('custom-')) {
    return 0;
  }
  if (recognizer.tier === 'ml') {
    return 1;
  }
  return 2;
}

// =============================================================================
// LUHN CHECK (for credit card validation)
// =============================================================================

export function luhnCheck(num: string): boolean {
  if (num.length < 13 || num.length > 19) return false;
  if (!/^\d+$/.test(num)) return false;

  let sum = 0;
  let alternate = false;

  for (let i = num.length - 1; i >= 0; i--) {
    let digit = parseInt(num[i], 10);

    if (alternate) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

// =============================================================================
// BUILT-IN RECOGNIZER REGISTRATION
// =============================================================================

/**
 * Compatibility shim: kept exported so external `registerBuiltInRecognizers`
 * imports keep working. Delegates to the `core` recognizer pack — the
 * single source of truth for the canonical 5 built-in entity types
 * after Phase 1b. Recognizer names migrate `builtin-*` → `core-*`;
 * legacy audit-log entries keep their old names. (LLD §1.2 D-6.)
 */
export function registerBuiltInRecognizers(registry: PIIRecognizerRegistry): void {
  registerCorePack(registry);
}

// =============================================================================
// SINGLETON DEFAULT REGISTRY
// =============================================================================

let defaultRegistry: PIIRecognizerRegistry | undefined;

export function getDefaultPIIRecognizerRegistry(): PIIRecognizerRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new PIIRecognizerRegistry();
    registerBuiltInRecognizers(defaultRegistry);
  }
  return defaultRegistry;
}

/** For testing — resets the singleton */
export function resetDefaultRegistry(): void {
  defaultRegistry = undefined;
}
