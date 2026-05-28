/**
 * Loop Detection — prevents infinite specialist invocation loops.
 * Contract: loop-detection.md
 *
 * Per-turn tracking. Cleared at the start of each POST /message processing.
 *
 * Two-level detection:
 *   1. Exact match: same specialist + same tool + same full-input hash.
 *      Threshold: 5 identical invocations.
 *   2. Semantic match (any tool with text-bearing inputs): same specialist +
 *      same tool + normalized text hash from common fields (question, prompt,
 *      description, content, rationale, instructions). Catches paraphrased
 *      loops like "Which channels?" vs "What channels do you support?".
 *      Threshold: 5 semantically-similar invocations.
 *
 * Bounded: history is capped at MAX_HISTORY entries (sliding FIFO eviction)
 * and reset() is called at the start of every turn. No unbounded growth.
 */

import { createHash } from 'node:crypto';

interface LoopEntry {
  specialist: string;
  toolName: string;
  inputHash: string;
  semanticHash: string | null;
}

const LOOP_THRESHOLD = 5;
// Max entries retained per turn. Effectively unreachable because turns end
// well below this cap (guarded by MAX_TOOL_REINVOCATIONS_PER_TURN = 10),
// but we bound defensively for the unbounded-collections lint.
const MAX_HISTORY = 200;

const FILLER_WORDS = new Set([
  // Articles and determiners
  'a',
  'an',
  'the',
  // Auxiliary verbs
  'do',
  'does',
  'did',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'will',
  'would',
  'should',
  'could',
  'can',
  'may',
  'might',
  'must',
  // Politeness + filler
  'please',
  'kindly',
  'tell',
  'just',
  'now',
  'also',
  // Pronouns
  'me',
  'you',
  'your',
  'yours',
  'we',
  'our',
  'ours',
  'i',
  'it',
  'they',
  'them',
  'their',
  // Question words — critical for paraphrase collision
  // "which channels?" and "what channels?" should normalize identically
  'which',
  'what',
  'how',
  'when',
  'where',
  'why',
  'who',
  'whose',
  'whom',
  // Prepositions
  'of',
  'for',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'about',
  'from',
]);

/**
 * Simple stemmer: strip common English inflections so "support", "supports",
 * and "supported" all collapse to the same root. Intentionally aggressive
 * rather than linguistically correct — false positives here just mean the
 * loop detector catches paraphrases slightly more eagerly.
 */
function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (word.endsWith('es') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && word.length > 3 && !word.endsWith('ss')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Normalize a question string for semantic comparison.
 * Strips punctuation, collapses whitespace, lowercases, removes common
 * filler/question words, stems content words, sorts alphabetically, and
 * keeps the first 80 chars. Two paraphrases of the same intent should
 * normalize to identical or near-identical strings.
 *
 * Sort-after-filter means word order doesn't matter:
 *   "which channels support" → "channel support"
 *   "support channels which"  → "channel support"
 */
function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w))
    .map(stem)
    .sort()
    .join(' ')
    .slice(0, 80);
}

/**
 * Common field names that carry text content across tool inputs.
 * Used for semantic hashing — if a tool is called with semantically
 * equivalent text in any of these fields, the loop detector catches it.
 */
const TEXT_FIELDS = ['question', 'prompt', 'description', 'content', 'rationale', 'instructions'];

/**
 * Extract text content from a tool input by checking common text-bearing fields.
 * Returns the concatenation of all found text fields for semantic comparison,
 * or null if no text fields are present.
 */
function extractTextContent(input: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const field of TEXT_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      parts.push(value.trim());
    }
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Stable JSON stringification — produces the same output regardless of
 * property insertion order. Prevents hash collisions when two logically
 * identical objects were constructed with different key orderings.
 */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  return (
    '{' +
    sorted
      .map((k) => JSON.stringify(k) + ':' + stableStringify((obj as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

export class LoopDetector {
  private history: LoopEntry[] = [];

  /**
   * Reset history at the start of each user turn.
   */
  reset(): void {
    this.history = [];
  }

  /**
   * Record a tool invocation and check for loops.
   * Returns true if a loop is detected (threshold reached on either
   * exact or semantic match). The 3rd identical call should NOT execute.
   */
  check(specialist: string, toolName: string, input: Record<string, unknown>): boolean {
    const inputHash = createHash('sha256').update(stableStringify(input)).digest('hex');

    // Semantic hash applies to ANY tool with text-bearing inputs — paraphrase detection.
    let semanticHash: string | null = null;
    const textContent = extractTextContent(input);
    if (textContent) {
      const normalized = normalizeQuestion(textContent);
      if (normalized.length > 0) {
        semanticHash = createHash('sha256').update(normalized).digest('hex');
      }
    }

    // Bounded push — drop the oldest entry if at cap (FIFO eviction).
    if (this.history.length >= MAX_HISTORY) {
      this.history.shift();
    }
    this.history.push({ specialist, toolName, inputHash, semanticHash });

    let exactMatchCount = 0;
    let semanticMatchCount = 0;
    for (const entry of this.history) {
      if (entry.specialist !== specialist || entry.toolName !== toolName) continue;
      if (entry.inputHash === inputHash) exactMatchCount++;
      if (semanticHash && entry.semanticHash === semanticHash) semanticMatchCount++;
    }

    return exactMatchCount >= LOOP_THRESHOLD || semanticMatchCount >= LOOP_THRESHOLD;
  }
}
