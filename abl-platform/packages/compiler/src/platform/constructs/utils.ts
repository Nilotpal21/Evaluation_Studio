/**
 * Flow Utility Functions — Pure Helpers
 *
 * Standalone pure functions for flow step execution: intent detection,
 * correction detection, gather completeness, prompt building, field
 * validation, and ON_INPUT branch evaluation.
 *
 * These have zero runtime dependencies — they operate on plain objects
 * and are shared between the compiler and runtime packages.
 */

import { evaluateConditionDetailedDual, evaluateConditionDual } from './dual-evaluator.js';
import { DEFAULT_CORRECTION_PATTERNS } from '../constants.js';
import type {
  ActionSetIR,
  RichContentIR,
  ToolInvocationIR,
  VoiceConfigIR,
  ValidationRule,
} from '../ir/schema.js';
import { extractPhoneFromText } from '../utils/phone-extraction.js';
import { extractDatesFromText } from '../utils/date-extraction.js';

// =============================================================================
// WORD-BOUNDARY MATCHING HELPERS
// =============================================================================

/** Escape special regex metacharacters in a string for safe use in RegExp. */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Test if `term` appears in `text` at a word boundary (not as a substring of another word). */
function matchesAtWordBoundary(text: string, term: string): boolean {
  const escaped = escapeRegExp(term);
  // \b only works at positions adjacent to word characters (\w).
  // If the term starts/ends with a non-word character (e.g. "+"),
  // use a lookaround that accepts start/end of string or whitespace instead.
  const startsWithWord = /^\w/.test(term);
  const endsWithWord = /\w$/.test(term);
  const prefix = startsWithWord ? '\\b' : '(?<=\\s|^)';
  const suffix = endsWithWord ? '\\b' : '(?=\\s|$)';
  return new RegExp(prefix + escaped + suffix, 'i').test(text);
}

/**
 * Legacy compatibility only: allow quoted phrases and simple single-word
 * intent strings to continue matching lexically when no KEYWORDS are provided.
 * Semantic ids such as help_request or cancel_workflow are intentionally excluded.
 */
function getLegacyIntentPattern(intent: string): string | null {
  const trimmedIntent = intent.trim().toLowerCase();
  if (!trimmedIntent) {
    return null;
  }

  if (trimmedIntent.startsWith('"') && trimmedIntent.endsWith('"')) {
    return trimmedIntent.slice(1, -1).trim() || null;
  }

  if (/[,\|\s]/.test(trimmedIntent) || trimmedIntent.includes('_')) {
    return null;
  }

  return trimmedIntent;
}

function getIntentLexicalPatterns(entry: { intent: string; keywords?: string[] }): string[] {
  const keywords = entry.keywords
    ?.map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);
  if (keywords && keywords.length > 0) {
    return keywords;
  }

  const legacyPattern = getLegacyIntentPattern(entry.intent);
  return legacyPattern ? [legacyPattern] : [];
}

function tokenizeLexicalText(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function normalizeLexicalToken(token: string): string {
  if (token.length <= 3) {
    return token;
  }

  if (token.endsWith('ies') && token.length > 4) {
    return token.slice(0, -3) + 'y';
  }

  if (/(ches|shes|xes|zes|sses)$/.test(token) && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith('ses') && token.length > 4) {
    return token.slice(0, -1);
  }

  if (token.endsWith('ing') && token.length > 5) {
    const stem = token.slice(0, -3);
    return /([b-df-hj-np-tv-z])\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }

  if (token.endsWith('ied') && token.length > 4) {
    return token.slice(0, -3) + 'y';
  }

  if (token.endsWith('ed') && token.length > 4) {
    const stem = token.slice(0, -2);
    return /([b-df-hj-np-tv-z])\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }

  if (token.endsWith('s') && token.length > 3 && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }

  return token;
}

function isNormalizedLexicalPatternEligible(keyword: string): boolean {
  return /^[a-z0-9 _-]+$/i.test(keyword.trim());
}

function matchesNormalizedLexicalPattern(
  normalizedMessageTokens: string[],
  keyword: string,
): boolean {
  if (!isNormalizedLexicalPatternEligible(keyword)) {
    return false;
  }

  const normalizedKeywordTokens = tokenizeLexicalText(keyword)
    .map((token) => normalizeLexicalToken(token))
    .filter((token) => token.length > 0);

  if (normalizedKeywordTokens.length === 0) {
    return false;
  }

  if (normalizedKeywordTokens.length === 1) {
    return normalizedMessageTokens.includes(normalizedKeywordTokens[0]);
  }

  for (
    let index = 0;
    index <= normalizedMessageTokens.length - normalizedKeywordTokens.length;
    index++
  ) {
    let allTokensMatch = true;
    for (let offset = 0; offset < normalizedKeywordTokens.length; offset++) {
      if (normalizedMessageTokens[index + offset] !== normalizedKeywordTokens[offset]) {
        allTokensMatch = false;
        break;
      }
    }
    if (allTokensMatch) {
      return true;
    }
  }

  return false;
}

export type IntentLexicalMatchType = 'exact' | 'normalized';

export interface DetectIntentLexicalOptions {
  allowNormalized?: boolean;
}

export interface DetectIntentLexicalMatch {
  intent: string;
  matched: string;
  matchType: IntentLexicalMatchType;
  candidateIndex: number;
}

// =============================================================================
// MINIMAL TEMPLATE INTERPOLATION
// =============================================================================

/**
 * Minimal template interpolation for {{variable}} substitution.
 * Handles simple `{{key}}` replacement from a data record.
 */
function interpolateTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(data[key] ?? ''));
}

// =============================================================================
// INTENT DETECTION
// =============================================================================

/**
 * Detect if user input matches a digression or sub-intent pattern.
 * Uses keyword-based matching against a list of intents with optional conditions.
 */
export function detectIntent(
  userMessage: string,
  intents: Array<{ intent: string; keywords?: string[]; condition?: string }>,
  context: Record<string, unknown>,
): { intent: string; matched: string } | null {
  const lexicalMatch = detectIntentLexically(userMessage, intents, context);
  return lexicalMatch
    ? {
        intent: lexicalMatch.intent,
        matched: lexicalMatch.matched,
      }
    : null;
}

/**
 * Deterministic lexical intent detection with optional normalization support.
 * Exact word-boundary matching remains the default. Normalized matching is
 * opt-in for surfaces such as gather interrupts that need lightweight
 * inflection handling without invoking NLU/LLM layers.
 */
export function detectIntentLexically(
  userMessage: string,
  intents: Array<{ intent: string; keywords?: string[]; condition?: string }>,
  context: Record<string, unknown>,
  options: DetectIntentLexicalOptions = {},
): DetectIntentLexicalMatch | null {
  const messageLower = userMessage.toLowerCase().trim();
  if (!messageLower) {
    return null;
  }

  for (const [candidateIndex, entry] of intents.entries()) {
    const lexicalPatterns = getIntentLexicalPatterns(entry);
    const matchedKeyword = lexicalPatterns.find((keyword) =>
      matchesAtWordBoundary(messageLower, keyword),
    );
    if (!matchedKeyword) {
      continue;
    }

    // Evaluate conditions only after a lexical candidate matched.
    if (entry.condition) {
      try {
        const conditionMet = evaluateConditionDual(entry.condition, {
          ...context,
          input: messageLower,
        });
        if (!conditionMet) {
          continue;
        }
      } catch (err) {
        console.warn(
          `[Runtime] Digression condition "${entry.condition}" evaluation failed:`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
    }

    return {
      intent: entry.intent,
      matched: matchedKeyword,
      matchType: 'exact',
      candidateIndex,
    };
  }

  if (!options.allowNormalized) {
    return null;
  }

  const normalizedMessageTokens = tokenizeLexicalText(messageLower).map((token) =>
    normalizeLexicalToken(token),
  );
  if (normalizedMessageTokens.length === 0) {
    return null;
  }

  for (const [candidateIndex, entry] of intents.entries()) {
    const lexicalPatterns = getIntentLexicalPatterns(entry);
    if (lexicalPatterns.length === 0) {
      continue;
    }

    const matchedKeyword = lexicalPatterns.find((keyword) =>
      matchesNormalizedLexicalPattern(normalizedMessageTokens, keyword),
    );
    if (!matchedKeyword) {
      continue;
    }

    if (entry.condition) {
      try {
        const conditionMet = evaluateConditionDual(entry.condition, {
          ...context,
          input: messageLower,
        });
        if (!conditionMet) {
          continue;
        }
      } catch (err) {
        console.warn(
          `[Runtime] Digression condition "${entry.condition}" evaluation failed:`,
          err instanceof Error ? err.message : String(err),
        );
        continue;
      }
    }

    return {
      intent: entry.intent,
      matched: matchedKeyword,
      matchType: 'normalized',
      candidateIndex,
    };
  }

  return null;
}

// =============================================================================
// CORRECTION DETECTION
// =============================================================================

/** Sentinel field name returned by detectCorrection when the target field cannot be identified. */
export const CORRECTION_FIELD_UNKNOWN = '_correction';

/**
 * Detect if user is making a correction like "actually X" or "no, Y".
 * Uses regex-based correction detection on collected fields.
 */
export function detectCorrection(
  userMessage: string,
  collectedData: Record<string, unknown>,
  customPatterns?: string[],
): { field: string; newValue: string } | null {
  const messageLower = userMessage.toLowerCase().trim();

  // Use custom patterns from IR if available, otherwise use defaults
  const correctionPatterns = customPatterns
    ? customPatterns.map((p: string) => new RegExp(p, 'i'))
    : DEFAULT_CORRECTION_PATTERNS.map((p: string) => new RegExp(p, 'i'));

  for (const pattern of correctionPatterns) {
    const match = messageLower.match(pattern);
    if (match) {
      const newValue = match[1].trim();

      // Try to identify which field is being corrected
      // Check if newValue matches a field type
      for (const [fieldName, existingValue] of Object.entries(collectedData)) {
        if (fieldName.startsWith('_')) continue; // Skip internal fields

        // Number correction
        const numMatch = newValue.match(/^(\d+)/);
        if (numMatch && typeof existingValue === 'number') {
          return { field: fieldName, newValue: numMatch[1] };
        }

        // String/destination correction
        if (typeof existingValue === 'string' && !newValue.match(/^\d+$/)) {
          // Last collected string field
          return { field: fieldName, newValue };
        }
      }

      // If we can't identify the field, return generic correction
      return { field: CORRECTION_FIELD_UNKNOWN, newValue };
    }
  }

  return null;
}

// =============================================================================
// GATHER COMPLETENESS
// =============================================================================

/**
 * Check if all required GATHER fields are collected.
 * Supports activation modes: 'optional', 'progressive', and data-driven ({ when: "..." }).
 */
export function checkGatherComplete(
  gather: {
    fields: Array<{
      name: string;
      required?: boolean;
      default?: unknown;
      activation?: unknown;
      depends_on?: string[];
    }>;
  },
  collectedData: Record<string, unknown>,
  completeWhen?: string,
): { complete: boolean; missing: string[] } {
  // If there's a custom complete_when condition, evaluate it
  if (completeWhen) {
    try {
      const complete = evaluateConditionDual(completeWhen, collectedData);
      if (complete) {
        return { complete: true, missing: [] };
      }
    } catch (err) {
      console.warn(
        `[Runtime] complete_when evaluation failed for "${completeWhen}":`,
        err instanceof Error ? err.message : String(err),
      );
      // Fall through to field checking
    }
  }

  const missing: string[] = [];

  for (const field of gather.fields) {
    const isRequired = field.required !== false; // Default to required
    if (!isRequired) continue;

    // Check activation mode
    if (field.activation) {
      // Optional: never count as missing regardless of required flag
      if (field.activation === 'optional') {
        continue;
      }

      // Progressive: only required when all depends_on fields are collected
      if (field.activation === 'progressive') {
        if (field.depends_on && field.depends_on.length > 0) {
          const allDepsMet = field.depends_on.every((dep) => {
            const val = collectedData[dep];
            return val !== undefined && val !== null && val !== '';
          });
          if (!allDepsMet) {
            // Dependencies not met — skip this field
            continue;
          }
        }
      }

      // Data-driven: { when: "expression" }
      if (
        typeof field.activation === 'object' &&
        field.activation !== null &&
        'when' in field.activation
      ) {
        const condition = (field.activation as { when: string }).when;
        const conditionMet = evaluateSimpleActivationCondition(condition, collectedData);
        if (!conditionMet) {
          // Condition not met — skip this field
          continue;
        }
      }
    }

    const hasValue =
      collectedData[field.name] !== undefined &&
      collectedData[field.name] !== null &&
      collectedData[field.name] !== '';
    if (!hasValue && field.default === undefined) {
      missing.push(field.name);
    }
  }

  return { complete: missing.length === 0, missing };
}

/**
 * Evaluate a simple activation condition expression against collected data.
 * Supports: variable > number, variable < number, variable >= number,
 * variable <= number, variable == value, variable != value
 */
function evaluateSimpleActivationCondition(
  condition: string,
  collected: Record<string, unknown>,
): boolean {
  const trimmed = condition.trim();

  // Match patterns: varName operator value
  const match = trimmed.match(/^(\w+)\s*(>=|<=|!=|==|>|<)\s*(.+)$/);
  if (!match) {
    // If we can't parse it, try the general evaluateCondition
    try {
      return evaluateConditionDual(trimmed, collected);
    } catch {
      return false;
    }
  }

  const [, varName, operator, rawValue] = match;
  const leftValue = collected[varName];

  // If the variable isn't in collected data, condition can't be met
  if (leftValue === undefined || leftValue === null) {
    return false;
  }

  // Try numeric comparison
  const rightNum = parseFloat(rawValue.trim());
  const leftNum = typeof leftValue === 'number' ? leftValue : parseFloat(String(leftValue));

  if (!isNaN(rightNum) && !isNaN(leftNum)) {
    switch (operator) {
      case '>':
        return leftNum > rightNum;
      case '<':
        return leftNum < rightNum;
      case '>=':
        return leftNum >= rightNum;
      case '<=':
        return leftNum <= rightNum;
      case '==':
        return leftNum === rightNum;
      case '!=':
        return leftNum !== rightNum;
    }
  }

  // Fall back to string comparison for == and !=
  const rightStr = rawValue.trim().replace(/^['"]|['"]$/g, '');
  const leftStr = String(leftValue);

  switch (operator) {
    case '==':
      return leftStr === rightStr;
    case '!=':
      return leftStr !== rightStr;
    default:
      return false;
  }
}

// =============================================================================
// GATHER PROMPT BUILDING
// =============================================================================

/**
 * Build prompt for GATHER fields that haven't been collected yet.
 */
export function buildGatherPrompt(
  gather: { fields: Array<{ name: string; prompt?: string; required?: boolean }>; prompt?: string },
  missingFields: string[],
  collectedData: Record<string, unknown>,
): string {
  // Nothing to prompt for when all fields are gathered
  if (missingFields.length === 0) {
    return '';
  }

  // Use custom prompt template if provided
  if (gather.prompt) {
    return interpolateTemplate(gather.prompt, {
      ...collectedData,
      _missing: missingFields,
      _missingList: missingFields.join(', '),
    });
  }

  // Build prompt from individual field prompts
  const prompts: string[] = [];
  for (const fieldName of missingFields) {
    const field = gather.fields.find((f) => f.name === fieldName);
    if (field?.prompt) {
      prompts.push(field.prompt);
    }
  }

  if (prompts.length > 0) {
    return prompts.join('\n');
  }

  // Default prompt
  return `Please provide: ${missingFields.join(', ')}`;
}

// =============================================================================
// FIELD VALIDATION
// =============================================================================

const BOOLEAN_STRINGS: readonly string[] = [
  'true',
  'false',
  'yes',
  'no',
  'y',
  'n',
  '1',
  '0',
  'on',
  'off',
] as const;

const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Validate a single field value against its ValidationRule.
 * Returns error message string if invalid, or null if valid.
 */
export function validateField(value: unknown, validation: ValidationRule): string | null {
  switch (validation.type) {
    case 'pattern':
      if (typeof value !== 'string') {
        return validation.error_message;
      }
      try {
        const regex = new RegExp(validation.rule);
        if (!regex.test(value)) {
          return validation.error_message;
        }
      } catch {
        return 'Invalid validation pattern';
      }
      break;

    case 'range': {
      const num = typeof value === 'number' ? value : parseFloat(String(value));
      if (isNaN(num)) {
        return validation.error_message;
      }
      const [min, max] = validation.rule.split('-').map(Number);
      if (num < min || num > max) {
        return validation.error_message;
      }
      break;
    }

    case 'enum': {
      const allowed = validation.rule.split('|');
      if (!allowed.includes(String(value))) {
        return validation.error_message;
      }
      break;
    }

    case 'custom':
      // Custom validation uses condition expression evaluation
      break;

    case 'intrinsic': {
      // System type validation — validation.rule contains the field type
      const str = typeof value === 'string' ? value : String(value);
      switch (validation.rule) {
        case 'phone': {
          if (/^\+\d{7,15}$/.test(str)) break;
          try {
            const phone = extractPhoneFromText(str);
            if (!phone) return validation.error_message;
          } catch {
            return validation.error_message;
          }
          break;
        }
        case 'email': {
          if (!EMAIL_PATTERN.test(str)) return validation.error_message;
          break;
        }
        case 'date':
        case 'datetime': {
          if (/^\d{4}-\d{2}-\d{2}/.test(str)) break;
          try {
            const dates = extractDatesFromText(str);
            if (dates.length === 0 && isNaN(Date.parse(str))) {
              return validation.error_message;
            }
          } catch {
            return validation.error_message;
          }
          break;
        }
        case 'number':
        case 'integer':
        case 'float': {
          const num = typeof value === 'number' ? value : Number(value);
          if (isNaN(num)) return validation.error_message;
          break;
        }
        case 'currency': {
          if (typeof value === 'number' && !isNaN(value)) break;
          // Structured {value, currency} from Tier 1 extraction
          if (typeof value === 'object' && value !== null && 'value' in value) {
            const inner = (value as Record<string, unknown>).value;
            if (typeof inner === 'number' && !isNaN(inner)) break;
          }
          if (typeof value === 'string') {
            // Symbol-prefixed: $49, €120, £75, ¥5000, ₹250, ₣80, ₩5000, R$150, US$49
            if (/([€£¥₹₣₩]|R\$|(?:US)?\$)\s*[\d,]+(?:\.\d{1,2})?/.test(value)) break;
            // Code-suffixed: 250 USD, 100 EUR, etc.
            if (/[\d,]+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|BRL|KRW)\b/i.test(value))
              break;
            // Plain numeric with commas: 3,500
            if (!isNaN(Number(value.replace(/,/g, '')))) break;
          }
          return validation.error_message;
        }
        case 'boolean': {
          const lower = str.toLowerCase().trim();
          if (typeof value !== 'boolean' && !BOOLEAN_STRINGS.includes(lower)) {
            return validation.error_message;
          }
          break;
        }
        default:
          break;
      }
      break;
    }
  }

  return null;
}

// =============================================================================
// ON_INPUT EVALUATION
// =============================================================================

/**
 * Evaluate ON_INPUT conditional branches against user input.
 * Returns the matching branch or null if none match.
 */
export function evaluateOnInput(
  branches: Array<{
    condition?: string;
    respond?: string;
    message_key?: string;
    voice_config?: VoiceConfigIR;
    rich_content?: RichContentIR;
    actions?: ActionSetIR;
    set?: Record<string, string>;
    call?: string;
    call_spec?: ToolInvocationIR;
    then: string;
  }>,
  userMessage: string,
  context: Record<string, unknown>,
  _onChunk?: (chunk: string) => void,
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
): {
  respond?: string;
  message_key?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  actions?: ActionSetIR;
  set?: Record<string, string>;
  call?: string;
  call_spec?: ToolInvocationIR;
  then: string;
} | null {
  const input = userMessage.trim().toLowerCase();

  const evaluations: Array<{
    condition: string | null;
    matched: boolean;
    then: string;
    details?: {
      conditionType: string;
      leftValue: unknown;
      operator: string;
      rightValue: unknown;
      explanation: string;
    };
  }> = [];

  for (const branch of branches) {
    // ELSE branch (no condition) - always matches as fallback
    if (!branch.condition) {
      evaluations.push({
        condition: null,
        matched: true,
        then: branch.then,
        details: {
          conditionType: 'else',
          leftValue: input,
          operator: 'fallback',
          rightValue: null,
          explanation: 'ELSE branch - always matches when no other condition matches',
        },
      });

      if (onTraceEvent) {
        onTraceEvent({
          type: 'dsl_on_input',
          data: {
            userInput: input,
            evaluations: evaluations,
            result: 'ELSE_MATCHED',
            matchedBranch: 'ELSE',
            targetStep: branch.then,
            actions: {
              set: branch.set,
              respond: branch.respond,
              call: branch.call,
            },
          },
        });
      }
      return branch;
    }

    // CEL-aware evaluation for both boolean and trace detail struct
    const evalDetails = evaluateConditionDetailedDual(branch.condition, input, context);
    evaluations.push({
      condition: branch.condition,
      matched: evalDetails.matched,
      then: branch.then,
      details: evalDetails,
    });

    if (evalDetails.matched) {
      if (onTraceEvent) {
        onTraceEvent({
          type: 'dsl_on_input',
          data: {
            userInput: input,
            evaluations: evaluations,
            result: 'CONDITION_MATCHED',
            matchedCondition: branch.condition,
            matchDetails: evalDetails,
            targetStep: branch.then,
            actions: {
              set: branch.set,
              respond: branch.respond,
              call: branch.call,
            },
          },
        });
      }
      return branch;
    }
  }

  // No branch matched
  if (onTraceEvent && evaluations.length > 0) {
    onTraceEvent({
      type: 'dsl_on_input',
      data: {
        userInput: input,
        evaluations: evaluations,
        result: 'NO_MATCH',
        note: 'No ON_INPUT condition matched - will use step default THEN',
      },
    });
  }

  return null;
}
