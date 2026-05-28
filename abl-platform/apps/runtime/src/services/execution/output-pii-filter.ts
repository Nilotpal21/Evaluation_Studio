/**
 * Output PII Filter
 *
 * Redacts PII from agent responses before delivery to the user.
 * Runs after output guardrails, controlled by piiRedaction.redactOutput config.
 *
 * Uses detectPIISelective from pii-detector for consistency with input redaction.
 */

import {
  createLogger,
  detectPIISelective,
  getDefaultPIIRecognizerRegistry,
  type PIIType,
  type PIIRecognizerRegistry,
} from '@abl/compiler/platform';
import type { PIIVault, PIIPatternConfig, PIIConsumer } from '@abl/compiler/platform';
import type { TraceStoreInterface } from '../trace-store.js';
import { recordPIIDetectLatency } from '../../observability/pii-telemetry.js';

const log = createLogger('output-pii-filter');

interface PIIRedactionConfig {
  enabled: boolean;
  redactInput: boolean;
  redactOutput: boolean;
  /** Confidence floor — detections below are dropped. Optional; defaults applied upstream. */
  confidenceThreshold?: number;
  /** Detection tier label for telemetry dimensions. */
  tier?: string;
}

export interface OutputPIIFilterResult {
  text: string;
  filtered: boolean;
  redactedTypes: PIIType[];
}

export interface OutputPIIFilterOptions {
  patternConfigs?: PIIPatternConfig[];
  recognizerRegistry?: PIIRecognizerRegistry;
  vault?: PIIVault;
  consumer?: PIIConsumer | string;
  /** Trace channel + sessionId for `pii.detect.latency_ms` emission. */
  traceStore?: TraceStoreInterface;
  sessionId?: string;
}

/**
 * Filter PII from agent output text.
 *
 * Supports two modes:
 * 1. Legacy: uses detectPIISelective with simple [REDACTED_*] labels
 * 2. Vault-aware: uses PIIVault.renderForConsumer with configurable per-pattern rendering
 */
export function filterOutputPII(
  text: string,
  config: PIIRedactionConfig,
  exemptTypesOrOptions?: Set<PIIType> | OutputPIIFilterOptions,
): OutputPIIFilterResult {
  if (!config?.enabled || !config?.redactOutput) {
    return { text, filtered: false, redactedTypes: [] };
  }

  // Detect if using new options interface or legacy exemptTypes
  const isOptions = exemptTypesOrOptions !== undefined && !(exemptTypesOrOptions instanceof Set);

  if (isOptions) {
    const options = exemptTypesOrOptions as OutputPIIFilterOptions;
    if (options.vault && options.patternConfigs) {
      const tokenized = options.vault.tokenize(text, undefined, {
        confidenceThreshold: config.confidenceThreshold,
      });
      const rendered = options.vault.renderForConsumer(
        tokenized.text,
        options.consumer || 'user',
        options.patternConfigs,
      );
      const filtered = rendered !== text;
      if (filtered) {
        log.info('output-pii-filtered-vault', { consumer: options.consumer || 'user' });
      }
      return {
        text: rendered,
        filtered,
        redactedTypes: [...new Set(tokenized.tokens.map((token) => token.type))],
      };
    }
  }

  // Legacy path. confidence_threshold is honored inside detectPIISelective —
  // detections below the floor are NOT redacted in result.redacted (was a
  // CRITICAL bug pre-2026-05-09: threshold filtered detections post-hoc but
  // left the already-redacted text untouched, over-redacting low-confidence
  // matches). Legacy regex matches default to confidence=1.0 so they always pass.
  const options = isOptions ? (exemptTypesOrOptions as OutputPIIFilterOptions) : undefined;
  const exemptTypes = exemptTypesOrOptions instanceof Set ? exemptTypesOrOptions : undefined;
  const t0 = performance.now();
  const result = detectPIISelective(
    text,
    exemptTypes,
    options?.recognizerRegistry ?? getDefaultPIIRecognizerRegistry(),
    { confidenceThreshold: config.confidenceThreshold },
  );
  if (options?.traceStore && options?.sessionId) {
    recordPIIDetectLatency(options.traceStore, options.sessionId, {
      entry_point: 'output_filter',
      tier: config.tier ?? 'basic',
      ms: performance.now() - t0,
    });
  }

  if (!result.hasPII || result.redactedTypes.length === 0) {
    return { text, filtered: false, redactedTypes: [] };
  }

  log.info('output-pii-filtered', {
    redactedTypes: result.redactedTypes,
    exemptedTypes: result.exemptedTypes,
  });

  return {
    text: result.redacted,
    filtered: true,
    redactedTypes: result.redactedTypes,
  };
}
