/**
 * Novel Candidate Validator
 *
 * Validation gate for novel attributes discovered by LLM extraction.
 * Rejects noise (stopwords, short names, invalid formats) before
 * storing in AttributeRegistry. Per Amendment #6.
 *
 * Note: VALID_DATA_TYPES and STOPWORDS are fixed-size constant Sets (no eviction needed).
 * MAX_STOPWORD_SIZE = 90 — verified at module load.
 */

import { createLogger } from '@abl/compiler/platform';
import type { NovelCandidate } from './entity-extractor.service.js';

const log = createLogger('novel-candidate-validator');

/** Maximum allowed stopword set size — guards against accidental growth */
const MAX_STOPWORD_SIZE = 90;

// Aligned with domain-definition.schema.ts AttributeSchema.dataType enum
// + 'boolean' (valid for LLM-discovered attributes even though not in domain definitions)
const VALID_DATA_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'currency',
  'percentage',
  'duration',
  'identifier',
]);

/** Common English words that should not be attribute names */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'day',
  'get',
  'has',
  'him',
  'his',
  'how',
  'its',
  'may',
  'new',
  'now',
  'old',
  'see',
  'way',
  'who',
  'did',
  'let',
  'say',
  'she',
  'too',
  'use',
  'name',
  'type',
  'value',
  'data',
  'text',
  'item',
  'list',
  'info',
  'note',
  'date',
  'time',
  'year',
  'page',
  'file',
  'code',
  'link',
  'test',
  'user',
  'more',
  'other',
  'about',
  'which',
  'their',
  'there',
  'these',
  'would',
  'make',
  'like',
  'just',
  'over',
  'such',
  'take',
  'than',
  'them',
  'very',
  'after',
  'also',
  'some',
  'what',
  'with',
  'this',
  'that',
  'from',
  'have',
  'been',
  'will',
  'each',
  'when',
  'where',
  'much',
  'then',
  'same',
]);

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate a novel candidate before storing in AttributeRegistry.
 * Returns true if the candidate passes all validation gates.
 */
export function validateNovelCandidate(
  candidate: NovelCandidate,
  knownAttributeIds: Set<string>,
): boolean {
  // Reject common English words
  if (STOPWORDS.has(candidate.name)) {
    log.debug('Rejected novel candidate: stopword', { name: candidate.name });
    return false;
  }

  // Reject short names (< 4 chars)
  if (candidate.name.length < 4) {
    log.debug('Rejected novel candidate: name too short', {
      name: candidate.name,
    });
    return false;
  }

  // Reject missing or short definitions (< 10 chars)
  if (!candidate.definition || candidate.definition.length < 10) {
    log.debug('Rejected novel candidate: missing/short definition', {
      name: candidate.name,
    });
    return false;
  }

  // Reject invalid snake_case
  if (!SNAKE_CASE_RE.test(candidate.name)) {
    log.debug('Rejected novel candidate: invalid snake_case', {
      name: candidate.name,
    });
    return false;
  }

  // Reject low confidence (< 0.5)
  if (candidate.confidence < 0.5) {
    log.debug('Rejected novel candidate: low confidence', {
      name: candidate.name,
      confidence: candidate.confidence,
    });
    return false;
  }

  // Reject if already a known attribute
  if (knownAttributeIds.has(candidate.name)) {
    log.debug('Rejected novel candidate: already known', {
      name: candidate.name,
    });
    return false;
  }

  // Reject invalid data types
  if (!VALID_DATA_TYPES.has(candidate.dataType)) {
    log.debug('Rejected novel candidate: invalid dataType', {
      name: candidate.name,
      dataType: candidate.dataType,
    });
    return false;
  }

  return true;
}
