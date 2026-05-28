/**
 * Pure validator + type coercer for canvas-declared start-node input variables.
 *
 * Lives in a standalone module (no workflow-engine imports beyond the
 * shared `StartInputVariable` type) so it can be called from:
 *   - the workflow-handler at workflow start (canonical check, covers every
 *     fire path: studio, webhook, cron, polling, agent);
 *   - the POST /execute route preflight (fast 4xx for interactive callers).
 *
 * Coercion rules (LLD D-4, per RunDialog parity + broadened booleans):
 *   string  : pass-through; non-string → TYPE_MISMATCH
 *   number  : native number passes; string → Number(); NaN → TYPE_MISMATCH
 *   boolean : native boolean passes;
 *             /^(true|1|yes)$/i  → true
 *             /^(false|0|no)$/i  → false
 *             else → TYPE_MISMATCH
 *   json    : string → JSON.parse (throw → JSON_PARSE_ERROR);
 *             object/array pass-through
 *
 * Extra payload fields (not declared) pass through unchanged.
 *
 * `defaultValue` is NOT applied (LLD D-13): declared+required+missing produces
 * a REQUIRED error even if the canvas-side schema carries a `defaultValue`.
 * Applying defaults would broaden this feature's scope beyond what the HLD
 * locked in; the engine's root context variables have never filled defaults, and changing
 * that is a separate ticket.
 */

import type { StartInputVariable } from '../handlers/canvas-to-steps.js';

export type FieldErrorReason = 'REQUIRED' | 'TYPE_MISMATCH' | 'JSON_PARSE_ERROR';

export interface FieldError {
  name: string;
  reason: FieldErrorReason;
  expected?: string;
  got?: string;
}

export type ValidationResult =
  | { ok: true; coerced: Record<string, unknown> }
  | { ok: false; errors: FieldError[] };

const BOOLEAN_TRUE_RE = /^(true|1|yes)$/i;
const BOOLEAN_FALSE_RE = /^(false|0|no)$/i;

/**
 * Validate a trigger payload against declared `startInputVariables` and coerce
 * values to their declared type. Pure function: no side effects, no mutation
 * of inputs.
 *
 * - Empty or missing `startInputVariables` → pass-through: returns the raw
 *   triggerPayload (or `{}` if absent) as `coerced` with no errors.
 * - All errors are accumulated (not short-circuited) so callers can report
 *   every issue at once.
 */
export function validateAndCoerceInput(
  startInputVariables: StartInputVariable[] | undefined,
  triggerPayload: Record<string, unknown> | undefined,
): ValidationResult {
  const payload = triggerPayload ?? {};

  // Pass-through when no declarations: the engine worked this way before the
  // feature landed and we preserve that for workflows with no declared inputs.
  if (!startInputVariables || startInputVariables.length === 0) {
    return { ok: true, coerced: { ...payload } };
  }

  const errors: FieldError[] = [];
  const coerced: Record<string, unknown> = { ...payload };

  for (const declared of startInputVariables) {
    const value = payload[declared.name];
    const isMissing = value === undefined || value === null;

    if (isMissing) {
      if (declared.required) {
        errors.push({ name: declared.name, reason: 'REQUIRED' });
      }
      // Not required + missing → leave absent in `coerced` (no default applied, D-13).
      delete coerced[declared.name];
      continue;
    }

    switch (declared.type) {
      case 'string': {
        if (typeof value === 'string') {
          coerced[declared.name] = value;
        } else {
          errors.push({
            name: declared.name,
            reason: 'TYPE_MISMATCH',
            expected: 'string',
            got: typeof value,
          });
        }
        break;
      }
      case 'number': {
        if (typeof value === 'number' && !Number.isNaN(value)) {
          coerced[declared.name] = value;
        } else if (typeof value === 'string') {
          // `Number("")` returns 0 (not NaN), which would silently turn an
          // empty-string payload field into a valid number. Reject empty /
          // whitespace-only strings explicitly so required-but-blank webhook
          // fields produce a TYPE_MISMATCH instead of 0.
          const trimmed = value.trim();
          const n = trimmed.length === 0 ? NaN : Number(trimmed);
          if (Number.isNaN(n)) {
            errors.push({
              name: declared.name,
              reason: 'TYPE_MISMATCH',
              expected: 'number',
              got: 'string',
            });
          } else {
            coerced[declared.name] = n;
          }
        } else {
          errors.push({
            name: declared.name,
            reason: 'TYPE_MISMATCH',
            expected: 'number',
            got: typeof value,
          });
        }
        break;
      }
      case 'boolean': {
        if (typeof value === 'boolean') {
          coerced[declared.name] = value;
        } else if (typeof value === 'string') {
          if (BOOLEAN_TRUE_RE.test(value)) {
            coerced[declared.name] = true;
          } else if (BOOLEAN_FALSE_RE.test(value)) {
            coerced[declared.name] = false;
          } else {
            errors.push({
              name: declared.name,
              reason: 'TYPE_MISMATCH',
              expected: 'boolean',
              got: 'string',
            });
          }
        } else {
          errors.push({
            name: declared.name,
            reason: 'TYPE_MISMATCH',
            expected: 'boolean',
            got: typeof value,
          });
        }
        break;
      }
      case 'json': {
        if (typeof value === 'object') {
          // Arrays, plain objects, null (already handled above as isMissing).
          coerced[declared.name] = value;
        } else if (typeof value === 'string') {
          try {
            coerced[declared.name] = JSON.parse(value);
          } catch (err) {
            errors.push({
              name: declared.name,
              reason: 'JSON_PARSE_ERROR',
              expected: 'json',
              got: err instanceof Error ? err.message : String(err),
            });
          }
        } else {
          errors.push({
            name: declared.name,
            reason: 'TYPE_MISMATCH',
            expected: 'json',
            got: typeof value,
          });
        }
        break;
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, coerced };
}
