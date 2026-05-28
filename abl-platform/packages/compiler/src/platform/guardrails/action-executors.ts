import { redactPII } from '../security/pii-detector.js';
import { createLogger } from '../logger.js';
import type { PIIRecognizerRegistry } from '../security/pii-recognizer-registry.js';
import { isPIIBypassFixEnabled } from '../security/_pii-bypass-fix.js';

const log = createLogger('guardrail-action-executors');

/**
 * Redact content based on mode.
 *
 * - `pii`: delegates to the shared PII detector which replaces
 *   emails, SSNs, credit-card numbers, phones and IPs with
 *   `[REDACTED_TYPE]` markers.
 * - `pattern`: applies a caller-supplied regex and replaces
 *   every match with `[REDACTED]`.
 */
export function executeRedact(
  content: string,
  mode: 'pii' | 'pattern',
  pattern?: string,
  recognizerRegistry?: PIIRecognizerRegistry,
): string {
  if (mode === 'pii') {
    if (!isPIIBypassFixEnabled()) {
      return content;
    }
    return redactPII(content, recognizerRegistry);
  }
  if (mode === 'pattern' && pattern) {
    try {
      return content.replace(new RegExp(pattern, 'gi'), '[REDACTED]');
    } catch {
      return content;
    }
  }
  return content;
}

/**
 * Fix content using a named strategy.
 *
 * | Strategy     | Behaviour                                      |
 * |--------------|-------------------------------------------------|
 * | `truncate`   | Slice to `maxLength` characters                 |
 * | `strip_html` | Remove all HTML tags                            |
 * | `normalize`  | Unicode NFKC + collapse whitespace              |
 * | `redact_pii` | Delegate to the shared PII redactor             |
 */
export function executeFix(
  content: string,
  strategy: string,
  maxLength?: number,
  recognizerRegistry?: PIIRecognizerRegistry,
): string {
  switch (strategy) {
    case 'truncate':
      return maxLength ? content.slice(0, maxLength) : content;
    case 'strip_html':
      return content.replace(/<[^>]*>/g, '').trim();
    case 'normalize':
      return content.normalize('NFKC').replace(/\s+/g, ' ').trim();
    case 'redact_pii':
      if (!isPIIBypassFixEnabled()) {
        return content;
      }
      return redactPII(content, recognizerRegistry);
    case 'custom':
      log.warn('Custom fix strategy not yet implemented, returning content unchanged');
      return content;
    default:
      return content;
  }
}

/**
 * Filter content by removing sentences that contain any of the
 * given violation patterns (case-insensitive).
 *
 * Returns `null` when the surviving text is shorter than
 * `minLength` — the caller should treat this as a block.
 */
export function executeFilter(
  content: string,
  violationPatterns: string[],
  minLength: number,
): string | null {
  const sentences = content.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter(
    (sentence) => !violationPatterns.some((p) => sentence.toLowerCase().includes(p.toLowerCase())),
  );
  const result = filtered.join(' ').trim();
  return result.length >= minLength ? result : null;
}
