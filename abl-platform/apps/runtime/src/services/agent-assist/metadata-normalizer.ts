import { createLogger } from '@abl/compiler/platform';
import {
  AGENT_ASSIST_MAX_AA_HISTORY_MSGS,
  AGENT_ASSIST_RESERVED_METADATA_KEYS,
} from './constants.js';

const log = createLogger('agent-assist:metadata-normalizer');

export interface NormalizedMetadata {
  /** Kore.ai `aa_uamsgs` history, bounded and coerced into plain objects. */
  history: Array<Record<string, unknown>>;
  /** Everything else the caller sent, minus reserved keys. */
  forward: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundHistory(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const coerced: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (coerced.length >= AGENT_ASSIST_MAX_AA_HISTORY_MSGS) break;
    if (typeof entry === 'string') {
      // Kore.ai sends Redis list entries as JSON strings — parse best-effort.
      try {
        const parsed: unknown = JSON.parse(entry);
        if (isPlainObject(parsed)) {
          coerced.push(parsed);
          continue;
        }
      } catch {
        // Fallthrough: keep as wrapped text entry.
      }
      coerced.push({ content: entry });
    } else if (isPlainObject(entry)) {
      coerced.push(entry);
    }
  }
  return coerced;
}

/**
 * Normalize Kore.ai Agent Assist's V1 `metadata` envelope into the canonical shape
 * the compat facade forwards into execution:
 *
 *   - Reserved keys (see AGENT_ASSIST_RESERVED_METADATA_KEYS) are stripped.
 *     This prevents callers from pinning or spoofing server-derived fields like
 *     `sessionId`, `tenantId`, `bindingId`, or credential-shaped values.
 *   - `aa_uamsgs` is pulled out and returned separately as bounded, parsed history.
 *   - All other keys pass through to `forward`.
 *
 * No mutation of the input object — callers can freely pass `req.body.metadata`.
 */
export function normalizeV1Metadata(raw: unknown): NormalizedMetadata {
  const history = isPlainObject(raw) ? boundHistory(raw.aa_uamsgs) : [];
  if (!isPlainObject(raw)) {
    return { history, forward: {} };
  }

  const forward: Record<string, unknown> = {};
  let strippedCount = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'aa_uamsgs') continue;
    if (AGENT_ASSIST_RESERVED_METADATA_KEYS.has(key)) {
      strippedCount += 1;
      continue;
    }
    forward[key] = value;
  }

  if (strippedCount > 0) {
    log.warn('Stripped reserved metadata keys from V1 request', {
      strippedCount,
      reservedKeys: Array.from(AGENT_ASSIST_RESERVED_METADATA_KEYS),
    });
  }

  return { history, forward };
}
