/**
 * Grounding Validator
 *
 * Structural runtime guard against LLM hallucination in entity extraction.
 * Validates that extracted values are actually grounded in the user's input,
 * with type-aware defaults and multilingual support.
 *
 * Key design decisions:
 * - String/boolean fields are NOT grounded by default (low hallucination risk)
 * - Date/number/email/phone fields ARE grounded by default (high hallucination risk)
 * - Date grounding is language-gated: only active for supported locales (en/es/fr/de/pt/it)
 * - Number/email/phone grounding is language-independent
 * - The `infer` keyword on a field overrides the default
 */

import { MONTH_MAP, LOCALE_MONTH_MAPS } from '../../utils/entity-extraction.js';
import { detectLanguageFallback } from '../../nlu/fallbacks.js';

// =============================================================================
// TYPES
// =============================================================================

export type ExtractionProvenance = 'explicit' | 'inferred' | 'default' | 'previously_collected';

export interface GroundingResult {
  grounded: boolean;
  evidence?: string;
}

export interface FieldGroundingConfig {
  name: string;
  type: string;
  infer?: boolean; // explicit override; undefined = use type default
}

export interface GroundingCheckResult {
  values: Record<string, unknown>;
  rejected: string[];
  provenance: Record<string, ExtractionProvenance>;
  confidence: Record<string, number>;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Supported locales for date grounding */
const DATE_GROUNDING_LOCALES = new Set(['en', 'es', 'fr', 'de', 'pt', 'it']);

/** Types where grounding is ON by default */
const GROUNDED_TYPES = new Set([
  'date',
  'datetime',
  'number',
  'integer',
  'int',
  'email',
  'phone',
  'tel',
]);

/** Language-independent types (always grounded regardless of locale) */
const LANGUAGE_INDEPENDENT_TYPES = new Set(['number', 'integer', 'int', 'email', 'phone', 'tel']);

// =============================================================================
// MULTILINGUAL DATE PATTERNS
// =============================================================================

/** Build a combined set of all month names from all supported locales */
function buildAllMonthNames(): string[] {
  const names = new Set<string>();
  // English months from MONTH_MAP
  for (const name of Object.keys(MONTH_MAP)) {
    names.add(name);
  }
  // All locale-specific months
  for (const localeMap of Object.values(LOCALE_MONTH_MAPS)) {
    for (const name of Object.keys(localeMap)) {
      names.add(name);
    }
  }
  return [...names];
}

const ALL_MONTH_NAMES = buildAllMonthNames();

/** Relative date words across supported languages */
const RELATIVE_DATE_WORDS = [
  // EN
  'today',
  'tomorrow',
  'yesterday',
  'tonight',
  // ES
  'hoy',
  'mañana',
  'ayer',
  // FR
  "aujourd'hui",
  'demain',
  'hier',
  // DE
  'heute',
  'morgen',
  'gestern',
  // PT
  'hoje',
  'amanhã',
  'ontem',
  // IT
  'oggi',
  'domani',
  'ieri',
];

/** Day names across supported languages */
const DAY_NAMES = [
  // EN
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  // ES
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
  'domingo',
  // FR
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
  // DE
  'montag',
  'dienstag',
  'mittwoch',
  'donnerstag',
  'freitag',
  'samstag',
  'sonntag',
  // PT
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
  'domingo',
  // IT
  'lunedì',
  'martedì',
  'mercoledì',
  'giovedì',
  'venerdì',
  'sabato',
  'domenica',
];

/** Temporal modifiers across supported languages */
const TEMPORAL_MODIFIERS = [
  // EN
  'next',
  'this',
  'last',
  // ES
  'próximo',
  'próxima',
  'este',
  'esta',
  'pasado',
  'pasada',
  // FR
  'prochain',
  'prochaine',
  'ce',
  'cette',
  'dernier',
  'dernière',
  // DE
  'nächste',
  'nächster',
  'nächstes',
  'diese',
  'dieser',
  'dieses',
  'letzte',
  'letzter',
  'letztes',
  // PT
  'próximo',
  'próxima',
  'este',
  'esta',
  'passado',
  'passada',
  // IT
  'prossimo',
  'prossima',
  'questo',
  'questa',
  'scorso',
  'scorsa',
];

/** Duration words across supported languages — NOT date evidence */
const DURATION_WORDS = [
  // EN
  'nights?',
  'days?',
  'weeks?',
  'months?',
  'years?',
  // ES
  'noches?',
  'días?',
  'semanas?',
  'mes(?:es)?',
  'años?',
  // FR
  'nuits?',
  'jours?',
  'semaines?',
  'mois',
  'ans?',
  'années?',
  // DE
  'nacht',
  'nächte',
  'tage?',
  'wochen?',
  'monate?',
  'jahre?',
  // PT
  'noites?',
  'dias?',
  'semanas?',
  'mês',
  'meses',
  'anos?',
  // IT
  'notti?',
  'notte',
  'giorni?',
  'giorno',
  'settimane?',
  'settimana',
  'mesi?',
  'mese',
  'anni?',
  'anno',
];

// Unicode-aware word boundary helpers
// \b doesn't work with accented characters (ã, ñ, é, etc.), so we use
// lookaround-based boundaries: (?<=\s|^) and (?=\s|$|[.,;:!?])
const WB_START = '(?<=\\s|^)';
const WB_END = '(?=\\s|$|[.,;:!?])';

// Build compiled regex patterns with Unicode-aware boundaries
const MONTH_REGEX = new RegExp(`${WB_START}(${ALL_MONTH_NAMES.join('|')})${WB_END}`, 'i');
const RELATIVE_DATE_REGEX = new RegExp(
  `${WB_START}(${RELATIVE_DATE_WORDS.join('|')})${WB_END}`,
  'i',
);
const DAY_NAME_REGEX = new RegExp(`${WB_START}(${DAY_NAMES.join('|')})${WB_END}`, 'i');
const TEMPORAL_MODIFIER_REGEX = new RegExp(
  `${WB_START}(${TEMPORAL_MODIFIERS.join('|')})${WB_END}`,
  'i',
);
const DURATION_REGEX = new RegExp(
  `(?<=\\s|^)\\d+\\s*(?:${DURATION_WORDS.join('|')})${WB_END}`,
  'i',
);

const DATE_TOKEN_PATTERNS = [
  /\d{4}-\d{2}-\d{2}/, // ISO dates
  /\d{1,2}[/\-.]\d{1,2}([/\-.]\d{2,4})?/, // Numeric dates (any separator)
  MONTH_REGEX, // Month names (all languages)
  /\b\d{1,2}(?:st|nd|rd|th)\b/i, // English ordinals (1st, 2nd, 3rd, 4th)
  RELATIVE_DATE_REGEX, // today/tomorrow/mañana/demain/etc
  DAY_NAME_REGEX, // monday-sunday in all languages
  TEMPORAL_MODIFIER_REGEX, // next/this/last + modifiers (all languages)
];

// =============================================================================
// GROUNDING FUNCTIONS
// =============================================================================

/**
 * Should grounding be applied for this field?
 * Respects explicit `infer` override, type defaults, and locale support.
 */
function shouldGround(config: FieldGroundingConfig, detectedLocale: string): boolean {
  // Explicit override
  if (config.infer === true) return false; // author says: allow inference
  if (config.infer === false) return true; // author says: require grounding

  const type = config.type.toLowerCase();

  // Type default is OFF for non-grounded types
  if (!GROUNDED_TYPES.has(type)) return false;

  // Language-independent types always ground
  if (LANGUAGE_INDEPENDENT_TYPES.has(type)) return true;

  // Language-dependent types (date) only ground for supported locales
  return DATE_GROUNDING_LOCALES.has(detectedLocale);
}

/**
 * Check if user input contains date evidence (not just duration)
 */
function hasDateEvidence(input: string): boolean {
  // Check if only duration is present (NOT date evidence)
  const hasDuration = DURATION_REGEX.test(input);

  // Check actual date token patterns
  const hasDateToken = DATE_TOKEN_PATTERNS.some((p) => p.test(input));

  if (hasDateToken) {
    // If we have a real date token, it's evidence even if duration is also present
    // But we need to check if the "date token" is actually part of the duration
    // e.g., "3 nights" has no date token (just a number + duration word)
    // But "March 3 for 2 nights" has "March" as a real date token
    return true;
  }

  // Duration alone is NOT date evidence
  return false;
}

/**
 * Check if a number value is grounded in the user's input
 */
function checkNumberGrounding(input: string, value: unknown): GroundingResult {
  const strValue = String(value);
  // Match exact number as a word boundary
  const pattern = new RegExp(`\\b${strValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  if (pattern.test(input)) {
    return { grounded: true, evidence: strValue };
  }
  return { grounded: false };
}

/**
 * Check if user input contains email evidence
 */
function checkEmailGrounding(input: string): GroundingResult {
  if (input.includes('@')) {
    return { grounded: true, evidence: '@' };
  }
  return { grounded: false };
}

/**
 * Check if user input contains phone evidence
 */
function checkPhoneGrounding(input: string): GroundingResult {
  const phonePattern = /[\d\s()+-]{7,}/;
  const match = input.match(phonePattern);
  if (match) {
    return { grounded: true, evidence: match[0].trim() };
  }
  return { grounded: false };
}

/**
 * Check grounding for a single field based on its type
 */
export function checkFieldGrounding(
  input: string,
  fieldName: string,
  fieldType: string,
  value: unknown,
): GroundingResult {
  const type = fieldType.toLowerCase();

  switch (type) {
    case 'date':
    case 'datetime':
      return hasDateEvidence(input)
        ? { grounded: true, evidence: 'date_token' }
        : { grounded: false };

    case 'number':
    case 'integer':
    case 'int':
      return checkNumberGrounding(input, value);

    case 'email':
      return checkEmailGrounding(input);

    case 'phone':
    case 'tel':
      return checkPhoneGrounding(input);

    default:
      // String, boolean, and other types — not grounded by default
      return { grounded: true, evidence: 'type_default' };
  }
}

// =============================================================================
// MAIN VALIDATION FUNCTION
// =============================================================================

/**
 * Validate all extracted values against user input for grounding.
 * Rejects LLM-hallucinated values that don't appear in the user's message.
 */
export function validateGrounding(
  userInput: string,
  extractedValues: Record<string, unknown>,
  fieldConfigs: FieldGroundingConfig[],
  previouslyCollected: Record<string, unknown>,
  locale?: string,
): GroundingCheckResult {
  // Auto-detect locale if not provided
  const detectedLocale = locale || detectLanguageFallback(userInput).primary;

  const values: Record<string, unknown> = {};
  const rejected: string[] = [];
  const provenance: Record<string, ExtractionProvenance> = {};
  const confidence: Record<string, number> = {};

  // Build a config lookup for quick access
  const configMap = new Map<string, FieldGroundingConfig>();
  for (const config of fieldConfigs) {
    configMap.set(config.name, config);
  }

  for (const [fieldName, value] of Object.entries(extractedValues)) {
    // Skip null/undefined values
    if (value === null || value === undefined) continue;

    // Skip empty string values
    if (typeof value === 'string' && value.trim() === '') {
      rejected.push(fieldName);
      continue;
    }

    // Check if previously collected
    if (previouslyCollected[fieldName] !== undefined && previouslyCollected[fieldName] !== null) {
      values[fieldName] = previouslyCollected[fieldName];
      provenance[fieldName] = 'previously_collected';
      confidence[fieldName] = 1.0;
      continue;
    }

    const config = configMap.get(fieldName);
    if (!config) {
      // No config for this field — accept as-is
      values[fieldName] = value;
      provenance[fieldName] = 'explicit';
      confidence[fieldName] = 0.9;
      continue;
    }

    // Check if grounding should be applied
    if (!shouldGround(config, detectedLocale)) {
      // Grounding not applied — accept value
      values[fieldName] = value;
      provenance[fieldName] = config.infer === true ? 'inferred' : 'explicit';
      confidence[fieldName] = config.infer === true ? 0.7 : 0.9;
      continue;
    }

    // Apply grounding check
    const result = checkFieldGrounding(userInput, fieldName, config.type, value);

    if (result.grounded) {
      values[fieldName] = value;
      provenance[fieldName] = 'explicit';
      confidence[fieldName] = 0.9;
    } else {
      // Rejected — hallucinated value
      rejected.push(fieldName);
    }
  }

  return { values, rejected, provenance, confidence };
}
