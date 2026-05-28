/**
 * Hybrid Repetition Detector (Future Implementation)
 *
 * Combines normalized string similarity (fast) with semantic embeddings (accurate).
 * This is a stub implementation that will be completed when ML integration is added.
 *
 * Strategy:
 * 1. Use normalized detector for initial fast filtering
 * 2. Use semantic detector to verify true semantic repetition
 * 3. Combine scores with weighted average
 *
 * Benefits:
 * - Fast: Normalized filtering reduces candidates
 * - Accurate: Semantic verification catches paraphrases
 * - Balanced: Best of both worlds
 *
 * To enable:
 * 1. Complete SemanticRepetitionDetector implementation
 * 2. Implement score combination logic
 * 3. Set REPETITION_DETECTOR_TYPE=hybrid
 */

import type { IRepetitionDetector, RepetitionDetectionResult } from './repetition-detector.js';
import { NormalizedRepetitionDetector } from './normalized-repetition-detector.js';
// import { SemanticRepetitionDetector } from './semantic-repetition-detector.js';

export class HybridRepetitionDetector implements IRepetitionDetector {
  private readonly normalizedDetector: NormalizedRepetitionDetector;
  // private readonly semanticDetector: SemanticRepetitionDetector;
  private readonly normalizedWeight: number;
  private readonly semanticWeight: number;

  constructor(options?: { normalizedWeight?: number; semanticWeight?: number }) {
    this.normalizedDetector = new NormalizedRepetitionDetector({
      similarityThreshold: 0.6, // Lower threshold for initial filtering
    });
    // this.semanticDetector = new SemanticRepetitionDetector({
    //   similarityThreshold: 0.75,
    // });
    this.normalizedWeight = options?.normalizedWeight ?? 0.4;
    this.semanticWeight = options?.semanticWeight ?? 0.6;
  }

  getName(): string {
    return 'hybrid';
  }

  async detectRepetition(
    transcripts: string[],
    language?: string,
  ): Promise<RepetitionDetectionResult> {
    // TODO: Implement hybrid detection
    // For now, fall back to normalized detector only
    console.warn(
      'HybridRepetitionDetector is not yet implemented. Falling back to normalized detector.',
    );

    const result = await this.normalizedDetector.detectRepetition(transcripts, language);

    return {
      ...result,
      metadata: {
        ...result.metadata,
        method: 'hybrid',
      },
    };
  }

  // Future implementation outline:
  //
  // async detectRepetition(
  //   transcripts: string[],
  //   language?: string
  // ): Promise<RepetitionDetectionResult> {
  //   // Step 1: Fast filtering with normalized detector
  //   const normalizedResult = await this.normalizedDetector.detectRepetition(
  //     transcripts,
  //     language
  //   );
  //
  //   // Step 2: Semantic verification on candidate groups
  //   const semanticResult = await this.semanticDetector.detectRepetition(
  //     transcripts,
  //     language
  //   );
  //
  //   // Step 3: Combine results with weighted average
  //   const combinedScore =
  //     normalizedResult.score * this.normalizedWeight +
  //     semanticResult.score * this.semanticWeight;
  //
  //   // Step 4: Merge repeated phrases (union of both detectors)
  //   const mergedPhrases = this.mergePhrases(
  //     normalizedResult.repeatedPhrases,
  //     semanticResult.repeatedPhrases
  //   );
  //
  //   return {
  //     score: combinedScore,
  //     repeatedPhrases: mergedPhrases,
  //     metadata: {
  //       totalTurns: transcripts.length,
  //       totalTokens: transcripts.join(' ').split(/\s+/).length,
  //       method: 'hybrid',
  //       language,
  //     },
  //   };
  // }
  //
  // private mergePhrases(
  //   phrases1: Array<{ phrase: string; count: number; similarity: number }>,
  //   phrases2: Array<{ phrase: string; count: number; similarity: number }>
  // ): Array<{ phrase: string; count: number; similarity: number }> {
  //   // Merge logic: deduplicate and combine counts
  //   const phraseMap = new Map<string, { count: number; similarity: number }>();
  //
  //   for (const p of [...phrases1, ...phrases2]) {
  //     const existing = phraseMap.get(p.phrase);
  //     if (existing) {
  //       existing.count = Math.max(existing.count, p.count);
  //       existing.similarity = Math.max(existing.similarity, p.similarity);
  //     } else {
  //       phraseMap.set(p.phrase, { count: p.count, similarity: p.similarity });
  //     }
  //   }
  //
  //   return Array.from(phraseMap.entries()).map(([phrase, data]) => ({
  //     phrase,
  //     ...data,
  //   }));
  // }
}
