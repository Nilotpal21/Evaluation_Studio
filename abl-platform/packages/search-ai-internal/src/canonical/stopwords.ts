/**
 * English Stopwords for Query Log Term Extraction
 *
 * Used by QueryLogAnalysisService to filter out non-domain terms.
 * Includes standard English stopwords plus common search-specific filler words.
 */

export const ENGLISH_STOPWORDS: ReadonlySet<string> = new Set([
  // Articles & determiners
  'a',
  'an',
  'the',
  'this',
  'that',
  'these',
  'those',
  // Pronouns
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'he',
  'she',
  'it',
  'they',
  'them',
  // Prepositions
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'about',
  // Conjunctions
  'and',
  'or',
  'but',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  // Verbs (common/auxiliary)
  'is',
  'am',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'can',
  'could',
  // Adverbs & misc
  'how',
  'what',
  'when',
  'where',
  'who',
  'which',
  'why',
  'all',
  'each',
  'every',
  'any',
  'few',
  'more',
  'most',
  'some',
  'such',
  'no',
  'only',
  'same',
  'than',
  'too',
  'very',
  'just',
  'also',
  'now',
  // Search-specific filler words
  'show',
  'find',
  'get',
  'list',
  'give',
  'tell',
  'search',
  'look',
  'looking',
  'want',
  'need',
  'please',
  'help',
  'me',
  'us',
]);

/**
 * Check if a token is a stopword.
 * Normalizes to lowercase before checking.
 */
export function isStopword(token: string): boolean {
  return ENGLISH_STOPWORDS.has(token.toLowerCase());
}

/**
 * Filter stopwords from an array of tokens.
 * Also removes tokens shorter than 2 characters and purely numeric tokens.
 */
export function filterStopwords(tokens: string[]): string[] {
  return tokens.filter((t) => {
    const lower = t.toLowerCase();
    if (lower.length < 2) return false;
    if (/^\d+$/.test(lower)) return false;
    return !ENGLISH_STOPWORDS.has(lower);
  });
}
