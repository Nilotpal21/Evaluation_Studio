/**
 * Regex/Keyword Fallback Layer
 *
 * Provides pattern-based NLU when LLM layers are unavailable or return low confidence.
 * Extracted from existing flow-executor.ts and entity-extraction.ts patterns.
 */

import type {
  IntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
  LanguageResult,
  IntentCandidate,
  CategoryDefinition,
  EntityField,
  EntityDefinition,
} from './types.js';
import {
  extractEntitiesForFields,
  extractDates,
  extractNumbers,
} from '../utils/entity-extraction.js';
import {
  DEFAULT_CORRECTION_PATTERNS,
  CONFIDENCE_EXACT_MATCH,
  CONFIDENCE_PHRASE_MATCH,
  CONFIDENCE_KEYWORD_MATCH,
  CONFIDENCE_WEAK_MATCH,
  CONFIDENCE_FALLBACK,
} from '../constants.js';

// =============================================================================
// INTENT FALLBACK
// =============================================================================

/**
 * Keyword-based intent detection fallback.
 * Matches user message against intent patterns using substring matching.
 */
export function detectIntentFallback(
  userMessage: string,
  candidates: IntentCandidate[],
): IntentResult {
  const messageLower = userMessage.toLowerCase().trim();

  for (const candidate of candidates) {
    // Check patterns as keywords
    for (const pattern of candidate.patterns) {
      const patternLower = pattern.toLowerCase();

      // Exact phrase match (quoted)
      if (patternLower.startsWith('"') && patternLower.endsWith('"')) {
        const phrase = patternLower.slice(1, -1);
        if (messageLower.includes(phrase)) {
          return {
            intent: candidate.name,
            confidence: CONFIDENCE_PHRASE_MATCH,
            source: 'fallback',
          };
        }
        continue;
      }

      // Keyword match
      if (messageLower.includes(patternLower)) {
        return { intent: candidate.name, confidence: CONFIDENCE_KEYWORD_MATCH, source: 'fallback' };
      }
    }

    // Check examples as keywords (lower confidence)
    if (candidate.examples) {
      for (const example of candidate.examples) {
        if (messageLower === example.toLowerCase()) {
          return { intent: candidate.name, confidence: CONFIDENCE_EXACT_MATCH, source: 'fallback' };
        }
      }
    }
  }

  return { intent: null, confidence: 0, source: 'fallback' };
}

// =============================================================================
// CATEGORY FALLBACK
// =============================================================================

/**
 * Keyword-based category classification fallback
 */
export function classifyCategoryFallback(
  userMessage: string,
  categories: CategoryDefinition[],
): CategoryResult {
  const messageLower = userMessage.toLowerCase().trim();

  for (const category of categories) {
    for (const pattern of category.patterns) {
      if (messageLower.includes(pattern.toLowerCase())) {
        return {
          category: category.name,
          confidence: CONFIDENCE_KEYWORD_MATCH,
          source: 'fallback',
        };
      }
    }
  }

  return { category: null, confidence: 0, source: 'fallback' };
}

// =============================================================================
// ENTITY EXTRACTION FALLBACK
// =============================================================================

/**
 * Pattern-based entity extraction fallback.
 * Uses the existing entity-extraction.ts utilities.
 */
export function extractEntitiesFallback(
  userMessage: string,
  fields: EntityField[],
  entityDefs?: EntityDefinition[],
): EntityResult {
  const fieldNames = fields.map((f) => f.name);
  const fieldTypes: Record<string, string> = {};

  for (const field of fields) {
    if (field.type) {
      fieldTypes[field.name] = field.type;
    }
  }

  // Use existing extraction utility
  const extracted = extractEntitiesForFields(userMessage, fieldNames, undefined, fieldTypes);

  // Apply synonym normalization from entity definitions
  if (entityDefs) {
    for (const def of entityDefs) {
      if (def.synonyms && extracted[def.name] !== undefined) {
        const value = String(extracted[def.name]).toLowerCase();
        for (const [canonical, synonyms] of Object.entries(def.synonyms)) {
          if (synonyms.some((s) => s.toLowerCase() === value)) {
            extracted[def.name] = canonical;
            break;
          }
        }
      }
    }
  }

  // Build result
  const missing = fieldNames.filter((f) => extracted[f] === undefined);
  const confidence: Record<string, number> = {};
  for (const [key] of Object.entries(extracted)) {
    confidence[key] = CONFIDENCE_WEAK_MATCH; // Lower confidence for pattern-based extraction
  }

  return { values: extracted, missing, confidence, source: 'fallback' };
}

// =============================================================================
// CORRECTION DETECTION FALLBACK
// =============================================================================

/**
 * Pattern-based correction detection fallback.
 * Uses configurable regex patterns.
 */
export function detectCorrectionFallback(
  userMessage: string,
  collectedData: Record<string, unknown>,
  customPatterns?: string[],
): CorrectionResult {
  const messageLower = userMessage.toLowerCase().trim();
  const patternStrings = customPatterns || DEFAULT_CORRECTION_PATTERNS;

  for (const patternStr of patternStrings) {
    const pattern = new RegExp(patternStr, 'i');
    const match = messageLower.match(pattern);

    if (match) {
      const newValue = match[1]?.trim();
      if (!newValue) continue;

      // Try to identify which field is being corrected
      for (const [fieldName, existingValue] of Object.entries(collectedData)) {
        if (fieldName.startsWith('_')) continue;

        const numMatch = newValue.match(/^(\d+)/);
        if (numMatch && typeof existingValue === 'number') {
          return {
            detected: true,
            field: fieldName,
            oldValue: existingValue,
            newValue: parseInt(numMatch[1], 10),
            confidence: CONFIDENCE_KEYWORD_MATCH,
            source: 'fallback',
          };
        }

        if (typeof existingValue === 'string' && !/^\d+$/.test(newValue)) {
          return {
            detected: true,
            field: fieldName,
            oldValue: existingValue,
            newValue,
            confidence: CONFIDENCE_WEAK_MATCH,
            source: 'fallback',
          };
        }
      }

      // Generic correction
      return {
        detected: true,
        field: undefined,
        newValue,
        confidence: CONFIDENCE_FALLBACK,
        source: 'fallback',
      };
    }
  }

  return { detected: false, confidence: 0, source: 'fallback' };
}

// =============================================================================
// LANGUAGE DETECTION FALLBACK
// =============================================================================

/** Common language indicators for regex-based detection */
const LANGUAGE_INDICATORS: Record<string, RegExp[]> = {
  es: [/\b(hola|gracias|por favor|quiero|necesito|reservar|buenos|buenas)\b/i],
  fr: [/\b(bonjour|merci|s'il vous plaît|je veux|réserver|bonsoir)\b/i],
  de: [/\b(hallo|danke|bitte|ich möchte|guten tag|reservieren)\b/i],
  pt: [/\b(olá|obrigado|por favor|eu quero|reservar|bom dia)\b/i],
  it: [/\b(ciao|grazie|per favore|voglio|prenotare|buongiorno)\b/i],
  ar: [/[\u0600-\u06FF]{2,}/],
  zh: [/[\u4e00-\u9fff]{2,}/],
  ja: [/[\u3040-\u309f\u30a0-\u30ff]{2,}/],
  ko: [/[\uac00-\ud7af]{2,}/],
};

/**
 * Regex-based language detection fallback.
 * Only detects common languages; defaults to 'en' if no match.
 */
export function detectLanguageFallback(message: string): LanguageResult {
  for (const [lang, patterns] of Object.entries(LANGUAGE_INDICATORS)) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        return {
          primary: lang,
          isCodeSwitched: false,
          confidence: CONFIDENCE_WEAK_MATCH,
        };
      }
    }
  }

  // Default to English
  return {
    primary: 'en',
    isCodeSwitched: false,
    confidence: CONFIDENCE_FALLBACK,
  };
}
