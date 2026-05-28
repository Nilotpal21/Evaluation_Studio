/**
 * Repetition Detection Interface
 *
 * Provides pluggable architecture for detecting repeated phrases in ASR transcripts.
 * Supports multiple implementations:
 * - Normalized: Fast string similarity (no ML required)
 * - Semantic: ML-based embeddings (future)
 * - Hybrid: Combines both approaches (future)
 */

export interface RepetitionDetectionResult {
  /** Overall repetition score [0-1], where 0 = no repetition, 1 = severe repetition */
  score: number;

  /** List of repeated phrase groups detected */
  repeatedPhrases: Array<{
    phrase: string;
    count: number;
    /** Similarity score for this phrase group [0-1] */
    similarity: number;
  }>;

  /** Metadata about the detection process */
  metadata: {
    /** Total number of turns analyzed */
    totalTurns: number;
    /** Total number of tokens/words analyzed */
    totalTokens: number;
    /** Detection method used */
    method: 'normalized' | 'semantic' | 'hybrid';
    /** Language detected (if applicable) */
    language?: string;
  };
}

export interface IRepetitionDetector {
  /**
   * Analyze a sequence of ASR transcripts for repetition patterns
   * @param transcripts Array of transcript texts in chronological order
   * @param language Optional language code (e.g., 'en', 'hi', 'zh', 'ar')
   * @returns Repetition detection result
   */
  detectRepetition(transcripts: string[], language?: string): Promise<RepetitionDetectionResult>;

  /**
   * Get the name/type of this detector
   */
  getName(): string;
}
