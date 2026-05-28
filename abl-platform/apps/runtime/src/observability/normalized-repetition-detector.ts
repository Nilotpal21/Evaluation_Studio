/**
 * Normalized Repetition Detector
 *
 * Fast string similarity-based repetition detection without ML dependencies.
 * Uses Jaccard similarity on normalized token sets with language-specific handling.
 *
 * Supports:
 * - Latin scripts (English, Spanish, French, etc.)
 * - CJK (Chinese, Japanese, Korean) - character-level tokenization
 * - RTL (Arabic, Hebrew, Urdu) - special normalization
 * - Indic scripts (Hindi, Telugu, Tamil, etc.)
 */

import type { IRepetitionDetector, RepetitionDetectionResult } from './repetition-detector.js';

interface NormalizedTranscript {
  original: string;
  normalized: string;
  tokens: Set<string>;
}

export class NormalizedRepetitionDetector implements IRepetitionDetector {
  private readonly similarityThreshold: number;
  private readonly minTokens: number;

  constructor(options?: { similarityThreshold?: number; minTokens?: number }) {
    // Threshold for considering two transcripts as repetitions (default: 0.7)
    this.similarityThreshold = options?.similarityThreshold ?? 0.7;
    // Minimum tokens required for analysis (default: 3)
    this.minTokens = options?.minTokens ?? 3;
  }

  getName(): string {
    return 'normalized';
  }

  async detectRepetition(
    transcripts: string[],
    language?: string,
  ): Promise<RepetitionDetectionResult> {
    if (transcripts.length === 0) {
      return this.emptyResult(language);
    }

    // Normalize all transcripts with language-specific handling
    const normalized = transcripts
      .filter((t) => t.trim().length > 0)
      .map((text) => this.normalizeTranscript(text, language));

    if (normalized.length === 0) {
      return this.emptyResult(language);
    }

    // Find repeated phrase groups using pairwise similarity
    const repeatedGroups = this.findRepeatedGroups(normalized);

    // Calculate overall repetition score
    const totalTokens = normalized.reduce((sum, n) => sum + n.tokens.size, 0);
    const repetitionScore = this.calculateRepetitionScore(repeatedGroups, normalized.length);

    return {
      score: repetitionScore,
      repeatedPhrases: repeatedGroups.map((group) => ({
        phrase: group.representative,
        count: group.members.length,
        similarity: group.avgSimilarity,
      })),
      metadata: {
        totalTurns: normalized.length,
        totalTokens,
        method: 'normalized',
        language,
      },
    };
  }

  /**
   * Normalize transcript text with language-specific handling
   */
  private normalizeTranscript(text: string, language?: string): NormalizedTranscript {
    const original = text;

    // Apply language-specific normalization
    let normalized: string;
    let tokens: Set<string>;

    if (this.isCJK(text, language)) {
      // CJK: Character-level tokenization (no spaces)
      normalized = this.normalizeCJK(text);
      tokens = new Set(normalized.split(''));
    } else if (this.isRTL(language)) {
      // RTL: Special handling for Arabic, Hebrew, Urdu
      normalized = this.normalizeRTL(text);
      tokens = new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
    } else if (this.isIndic(language)) {
      // Indic: Handle combining characters and complex scripts
      normalized = this.normalizeIndic(text);
      tokens = new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
    } else {
      // Latin scripts: Word-level tokenization
      normalized = this.normalizeLatin(text);
      tokens = new Set(normalized.split(/\s+/).filter((t) => t.length > 0));
    }

    return { original, normalized, tokens };
  }

  /**
   * Check if text is CJK (Chinese, Japanese, Korean)
   */
  private isCJK(text: string, language?: string): boolean {
    if (language && ['zh', 'ja', 'ko'].includes(language.toLowerCase())) {
      return true;
    }
    // Check for CJK Unicode ranges
    const cjkPattern = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
    return cjkPattern.test(text);
  }

  /**
   * Check if language is RTL (Right-to-Left)
   */
  private isRTL(language?: string): boolean {
    if (!language) return false;
    return ['ar', 'he', 'ur', 'fa', 'ps'].includes(language.toLowerCase());
  }

  /**
   * Check if language is Indic script
   */
  private isIndic(language?: string): boolean {
    if (!language) return false;
    return ['hi', 'bn', 'te', 'ta', 'mr', 'gu', 'kn', 'ml', 'pa'].includes(language.toLowerCase());
  }

  /**
   * Normalize Latin script text
   */
  private normalizeLatin(text: string): string {
    return (
      text
        .toLowerCase()
        // Remove punctuation
        .replace(/[^\w\s]/g, ' ')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * Normalize CJK text (character-level)
   */
  private normalizeCJK(text: string): string {
    return (
      text
        // Remove punctuation
        .replace(/[\u3000-\u303f\uff00-\uffef]/g, '')
        // Remove Latin characters and numbers
        .replace(/[a-zA-Z0-9]/g, '')
        .trim()
    );
  }

  /**
   * Normalize RTL text (Arabic, Hebrew, Urdu)
   */
  private normalizeRTL(text: string): string {
    return (
      text
        .toLowerCase()
        // Remove diacritics (Arabic: harakat, Hebrew: niqqud)
        .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06dc\u06df-\u06e8\u06ea-\u06ed]/g, '')
        .replace(/[\u0591-\u05c7]/g, '')
        // Remove punctuation
        .replace(/[^\w\s\u0600-\u06ff\u0590-\u05ff]/g, ' ')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * Normalize Indic script text
   */
  private normalizeIndic(text: string): string {
    return (
      text
        .toLowerCase()
        // NFD normalization to separate combining characters
        .normalize('NFD')
        // Remove punctuation
        .replace(
          /[^\w\s\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0a80-\u0aff\u0b00-\u0b7f\u0b80-\u0bff\u0c00-\u0c7f\u0c80-\u0cff\u0d00-\u0d7f]/g,
          ' ',
        )
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  /**
   * Find groups of similar transcripts using Jaccard similarity
   */
  private findRepeatedGroups(transcripts: NormalizedTranscript[]): Array<{
    representative: string;
    members: string[];
    avgSimilarity: number;
  }> {
    const groups: Array<{
      representative: string;
      members: string[];
      similarities: number[];
    }> = [];

    for (let i = 0; i < transcripts.length; i++) {
      const current = transcripts[i];

      // Skip very short transcripts
      if (current.tokens.size < this.minTokens) {
        continue;
      }

      // Check if this transcript belongs to an existing group
      let addedToGroup = false;
      for (const group of groups) {
        // Compare with first member (representative) of the group
        const representative = transcripts.find((t) => t.original === group.representative);
        if (!representative) continue;

        const similarity = this.jaccardSimilarity(current.tokens, representative.tokens);

        if (similarity >= this.similarityThreshold) {
          group.members.push(current.original);
          group.similarities.push(similarity);
          addedToGroup = true;
          break;
        }
      }

      // Create new group if not added to existing one
      if (!addedToGroup) {
        // Check if there are future similar transcripts
        let hasSimilar = false;
        for (let j = i + 1; j < transcripts.length; j++) {
          const similarity = this.jaccardSimilarity(current.tokens, transcripts[j].tokens);
          if (similarity >= this.similarityThreshold) {
            hasSimilar = true;
            break;
          }
        }

        if (hasSimilar) {
          groups.push({
            representative: current.original,
            members: [current.original],
            similarities: [1.0],
          });
        }
      }
    }

    // Filter out groups with only 1 member and calculate average similarity
    return groups
      .filter((g) => g.members.length > 1)
      .map((g) => ({
        representative: g.representative,
        members: g.members,
        avgSimilarity: g.similarities.reduce((sum, s) => sum + s, 0) / g.similarities.length,
      }));
  }

  /**
   * Calculate Jaccard similarity between two token sets
   * Returns value between 0 (no overlap) and 1 (identical)
   */
  private jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
    const intersection = new Set([...set1].filter((x) => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    if (union.size === 0) return 0;
    return intersection.size / union.size;
  }

  /**
   * Calculate overall repetition score from repeated groups
   * Score ranges from 0 (no repetition) to 1 (severe repetition)
   */
  private calculateRepetitionScore(
    groups: Array<{ members: string[]; avgSimilarity: number }>,
    totalTranscripts: number,
  ): number {
    if (groups.length === 0 || totalTranscripts === 0) {
      return 0;
    }

    // Count how many transcripts are part of repeated groups
    const repeatedCount = groups.reduce((sum, group) => sum + group.members.length, 0);

    // Base score: proportion of repeated transcripts
    const repetitionRatio = repeatedCount / totalTranscripts;

    // Weight by average similarity of groups
    const avgGroupSimilarity = groups.reduce((sum, g) => sum + g.avgSimilarity, 0) / groups.length;

    // Weight by repetition frequency (more repeats = worse)
    const avgGroupSize = groups.reduce((sum, g) => sum + g.members.length, 0) / groups.length;
    const frequencyWeight = Math.min(avgGroupSize / 5, 1); // Cap at 5 repeats

    // Combine factors
    return Math.min(repetitionRatio * 0.5 + avgGroupSimilarity * 0.3 + frequencyWeight * 0.2, 1.0);
  }

  /**
   * Return empty result for edge cases
   */
  private emptyResult(language?: string): RepetitionDetectionResult {
    return {
      score: 0,
      repeatedPhrases: [],
      metadata: {
        totalTurns: 0,
        totalTokens: 0,
        method: 'normalized',
        language,
      },
    };
  }
}
