/**
 * PreferenceDetector — LLM-driven extraction of preference signals from user utterances.
 *
 * Detects symmetric preference/avoidance patterns:
 * - "I prefer..." → desire
 * - "I don't want..." / "I avoid..." → avoid
 * - "I'm allergic to..." / "absolutely not..." → refuse
 * - "that works" / "I'd like..." → accept
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('preference-detector');

export type PreferenceCategory = 'accept' | 'desire' | 'avoid' | 'refuse';

export interface DetectedPreference {
  category: PreferenceCategory;
  value: string;
  confidence: number;
  source: string; // The utterance fragment that triggered detection
}

/**
 * Pattern-based preference detection (no LLM required).
 * Used as a fast first pass before optional LLM-based extraction.
 */
export function detectPreferencesFromText(utterance: string): DetectedPreference[] {
  const preferences: DetectedPreference[] = [];

  // Refuse patterns (strongest signal)
  const refusePatterns = [
    /(?:i'm|i am)\s+allergic\s+to\s+(.+?)(?:\.|,|$)/i,
    /absolutely\s+(?:no|not)\s+(.+?)(?:\.|,|$)/i,
    /(?:never|no)\s+(.+?)\s+(?:ever|please|at all)/i,
    /i\s+(?:refuse|can't have|cannot have)\s+(.+?)(?:\.|,|$)/i,
  ];

  for (const pattern of refusePatterns) {
    const match = utterance.match(pattern);
    if (match) {
      preferences.push({
        category: 'refuse',
        value: match[1].trim(),
        confidence: 0.9,
        source: match[0],
      });
    }
  }

  // Avoid patterns
  const avoidPatterns = [
    /i\s+(?:don't|do not)\s+(?:want|like|prefer)\s+(.+?)(?:\.|,|$)/i,
    /i(?:'d|\s+would)\s+(?:rather\s+)?(?:avoid|skip)\s+(.+?)(?:\.|,|$)/i,
    /(?:stay\s+away\s+from|no)\s+(.+?)(?:\s+(?:please|if possible))?(?:\.|,|$)/i,
  ];

  for (const pattern of avoidPatterns) {
    const match = utterance.match(pattern);
    if (match) {
      // Don't add if already detected as refuse (stronger signal)
      const value = match[1].trim();
      if (!preferences.some((p) => p.value === value)) {
        preferences.push({
          category: 'avoid',
          value,
          confidence: 0.8,
          source: match[0],
        });
      }
    }
  }

  // Desire patterns
  const desirePatterns = [
    /i\s+(?:prefer|love|really\s+want)\s+(.+?)(?:\.|,|$)/i,
    /i(?:'d|\s+would)\s+(?:really\s+)?(?:love|prefer)\s+(.+?)(?:\.|,|$)/i,
    /(?:my\s+favorite|my\s+preferred)\s+(?:is|would\s+be)\s+(.+?)(?:\.|,|$)/i,
  ];

  for (const pattern of desirePatterns) {
    const match = utterance.match(pattern);
    if (match) {
      preferences.push({
        category: 'desire',
        value: match[1].trim(),
        confidence: 0.8,
        source: match[0],
      });
    }
  }

  // Accept patterns (weakest signal)
  const acceptPatterns = [
    /(?:that\s+(?:works|sounds\s+(?:good|fine|great)))/i,
    /i(?:'d|\s+would)\s+like\s+(.+?)(?:\.|,|$)/i,
    /(?:i'll\s+(?:take|go\s+with)|let's\s+do)\s+(.+?)(?:\.|,|$)/i,
  ];

  for (const pattern of acceptPatterns) {
    const match = utterance.match(pattern);
    if (match) {
      const value = match[1]?.trim() ?? 'current_suggestion';
      preferences.push({
        category: 'accept',
        value,
        confidence: 0.6,
        source: match[0],
      });
    }
  }

  log.debug('Detected preferences', {
    count: preferences.length,
    utterance: utterance.slice(0, 80),
  });

  return preferences;
}

/**
 * Merge new preferences with existing preferences.
 * Handles deduplication and category escalation (avoid → refuse).
 */
export function mergePreferences(
  existing: DetectedPreference[],
  incoming: DetectedPreference[],
): DetectedPreference[] {
  const merged = [...existing];
  const categoryPriority: Record<PreferenceCategory, number> = {
    accept: 1,
    desire: 2,
    avoid: 3,
    refuse: 4,
  };

  for (const pref of incoming) {
    const existingIndex = merged.findIndex(
      (e) => e.value.toLowerCase() === pref.value.toLowerCase(),
    );
    if (existingIndex >= 0) {
      // Escalate category if new preference is stronger
      const existingPriority = categoryPriority[merged[existingIndex].category];
      const newPriority = categoryPriority[pref.category];
      if (newPriority > existingPriority) {
        merged[existingIndex] = pref;
      }
    } else {
      merged.push(pref);
    }
  }

  return merged;
}
