/**
 * NLU Shared Utilities
 *
 * Common helper functions used across the NLU module.
 * Extracted to avoid duplication in engine.ts, language.ts, and embeddings/.
 */

// =============================================================================
// JSON PARSING
// =============================================================================

/**
 * Safe JSON parse with markdown code block extraction and brace extraction.
 * Handles LLM responses that may wrap JSON in markdown or include extra text.
 */
export function parseJSON<T>(text: string): T | null {
  try {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const clean = (jsonMatch[1] || text).trim();
    // Find the first { and last } to extract JSON
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) return null;
    return JSON.parse(clean.substring(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// =============================================================================
// VECTOR SIMILARITY
// =============================================================================

/**
 * Compute cosine similarity between two vectors.
 * Returns 0 if vectors have different lengths or zero magnitude.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
