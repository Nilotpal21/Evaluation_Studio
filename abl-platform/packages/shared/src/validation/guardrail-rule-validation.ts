/**
 * Guardrail Rule Validation — shared by Studio (form save) and Runtime (rule evaluation).
 *
 * Validates a Studio-form-shaped guardrail rule, returning field-presence errors
 * and a sanitized copy with HTML-stripped `actionMessage`.
 *
 * Sanitization concerns addressed:
 *  - R2-F3: actionMessage length / content validation
 *  - R7-F1: HTML tag stripping via sanitize-html (XSS prevention)
 *  - HLD §4 concern #4: input never reaches callers without sanitization
 */

import sanitize from 'sanitize-html';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical vocabulary for a Studio-form-shaped guardrail rule. */
export interface GuardrailRuleInput {
  name?: string;
  checkType?: 'provider' | 'cel' | 'llm' | string;
  kind?: 'input' | 'output' | string;
  threshold?: number;
  severityThreshold?: number;
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  action?: string;
  enabled?: boolean;
  entities?: string[];
  presetKey?: string;
  actionMessage?: string;
  message?: string;
}

/** The validated/sanitized copy of a rule. Identical shape but with cleaned values. */
export interface ValidatedRule {
  name?: string;
  checkType?: string;
  kind?: string;
  threshold?: number;
  severityThreshold?: number;
  provider?: string;
  category?: string;
  check?: string;
  llmCheck?: string;
  action?: string;
  enabled?: boolean;
  entities?: string[];
  presetKey?: string;
  actionMessage?: string;
  message?: string;
}

export interface ValidateRuleResult {
  valid: boolean;
  missingFields: string[];
  sanitized: ValidatedRule;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed length for actionMessage (R2-F3). */
const ACTION_MESSAGE_MAX_LENGTH = 500;

/** Maximum number of entity IDs allowed per rule (v1 cap). */
const MAX_ENTITIES = 37;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const NULL_BYTE_RE = /\x00/;

/**
 * Sanitize an actionMessage string: reject null bytes and over-length,
 * strip all HTML tags, return the cleaned text or undefined on rejection.
 */
function sanitizeActionMessage(
  msg: string | undefined,
  missingFields: string[],
  required: boolean,
): string | undefined {
  // Undefined / empty when required
  if (msg === undefined || msg === '') {
    if (required) {
      missingFields.push('actionMessage');
    }
    return undefined;
  }

  // Null-byte check (binary injection)
  if (NULL_BYTE_RE.test(msg)) {
    missingFields.push('actionMessage');
    return undefined;
  }

  // Length cap
  if (msg.length > ACTION_MESSAGE_MAX_LENGTH) {
    missingFields.push('actionMessage');
    return undefined;
  }

  // HTML strip — removes all tags, keeps text content (R7-F1)
  const stripped = sanitize(msg, { allowedTags: [], allowedAttributes: {} });

  return stripped;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a Studio-form-shaped guardrail rule.
 *
 * Returns field-presence errors and a sanitized copy. The function is pure
 * (no I/O, no side effects) and safe to call from both Studio and Runtime.
 */
export function validateRule(input: GuardrailRuleInput): ValidateRuleResult {
  const missingFields: string[] = [];

  // --- Cross-cutting (Group E) ---

  if (!input.name || input.name.trim() === '') {
    missingFields.push('name');
  }

  if (!input.kind || input.kind.trim() === '') {
    missingFields.push('kind');
  }

  if (input.threshold !== undefined && input.threshold !== null) {
    if (typeof input.threshold !== 'number' || input.threshold < 0 || input.threshold > 1) {
      missingFields.push('threshold');
    }
  }

  if (input.severityThreshold !== undefined && input.severityThreshold !== null) {
    if (
      typeof input.severityThreshold !== 'number' ||
      input.severityThreshold < 0 ||
      input.severityThreshold > 1
    ) {
      missingFields.push('severityThreshold');
    }
  }

  // --- Per-checkType validation (Groups A–D) ---

  if (!input.checkType || input.checkType.trim() === '') {
    missingFields.push('checkType');
  } else {
    switch (input.checkType) {
      case 'provider': {
        // Group A & B: provider field required regardless of category
        if (!input.provider || input.provider.trim() === '') {
          missingFields.push('provider');
        }
        break;
      }
      case 'cel': {
        // Group C: check (CEL expression) required
        if (!input.check || input.check.trim() === '') {
          missingFields.push('check');
        }
        break;
      }
      case 'llm': {
        // Group D: llmCheck required
        if (!input.llmCheck || input.llmCheck.trim() === '') {
          missingFields.push('llmCheck');
        }
        break;
      }
      default:
        // Unknown checkType — flag it
        missingFields.push('checkType');
        break;
    }
  }

  // --- Entities validation ---

  if (input.entities !== undefined) {
    if (!Array.isArray(input.entities)) {
      missingFields.push('entities');
    } else if (input.entities.length < 1 || input.entities.length > MAX_ENTITIES) {
      missingFields.push('entities');
    }
    // TODO: v1 skips entity-ID membership check against the catalog.
    // The runtime filter is the strict gate for entity validity.
  }

  // --- actionMessage sanitization (R2-F3, R7-F1) ---

  const actionMessageRequired =
    input.enabled !== false && input.presetKey === 'sensitive_data_block';

  const sanitizedActionMessage = sanitizeActionMessage(
    input.actionMessage,
    missingFields,
    actionMessageRequired,
  );

  // --- Build sanitized copy ---

  const sanitized: ValidatedRule = {
    name: input.name,
    checkType: input.checkType,
    kind: input.kind,
    threshold: input.threshold,
    severityThreshold: input.severityThreshold,
    provider: input.provider,
    category: input.category,
    check: input.check,
    llmCheck: input.llmCheck,
    action: input.action,
    enabled: input.enabled,
    entities: input.entities,
    presetKey: input.presetKey,
    message: input.message,
  };

  // Only include actionMessage in sanitized output when sanitization succeeded
  if (sanitizedActionMessage !== undefined) {
    sanitized.actionMessage = sanitizedActionMessage;
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
    sanitized,
  };
}
