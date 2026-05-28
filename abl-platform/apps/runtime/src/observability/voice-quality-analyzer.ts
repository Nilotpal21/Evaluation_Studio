/**
 * Voice Quality Analyzer
 *
 * Multi-signal ASR quality scoring without ground truth transcripts.
 * Combines 5 signals to produce a WER proxy score:
 *
 * 1. Repetition: Repeated phrases indicate ASR confusion
 * 2. Hesitation: Filler words and pauses suggest poor recognition
 * 3. Correction: User corrections indicate ASR errors
 * 4. Clarity: Short/fragmented transcripts suggest poor audio/ASR
 * 5. Confidence: Low ASR confidence scores (if available)
 *
 * Score: 0-100 where 100 = perfect quality, 0 = unusable
 */

import { RepetitionDetectorFactory } from './repetition-detector-factory.js';
import type { IRepetitionDetector } from './repetition-detector.js';

export interface ASRQualitySignals {
  /** Repetition score [0-1], 0 = no repetition, 1 = severe */
  repetition: number;
  /** Hesitation score [0-1], 0 = no hesitation, 1 = severe */
  hesitation: number;
  /** Correction score [0-1], 0 = no corrections, 1 = frequent corrections */
  correction: number;
  /** Clarity score [0-1], 0 = clear, 1 = unclear/fragmented */
  clarity: number;
  /** Confidence score [0-1], 0 = low confidence, 1 = high confidence */
  confidence: number;
}

export interface ASRQualityResult {
  /** Overall ASR quality score [0-100], 100 = perfect */
  overallScore: number;
  /** Individual signal scores */
  signals: ASRQualitySignals;
  /** Detected issues */
  issues: Array<{
    type: 'repetition' | 'hesitation' | 'correction' | 'clarity' | 'confidence';
    severity: 'low' | 'medium' | 'high';
    description: string;
  }>;
  /** Metadata */
  metadata: {
    totalTurns: number;
    totalTranscripts: number;
    averageTranscriptLength: number;
    detectorType: string;
  };
}

export interface ASRTurnData {
  transcript: string;
  confidence?: number;
  intentMatched: boolean;
  slotsFilled: number;
  totalSlots: number;
}

export class VoiceQualityAnalyzer {
  private readonly repetitionDetector: IRepetitionDetector;

  // Hesitation patterns (language-agnostic fillers)
  private readonly hesitationPatterns = [
    // English
    /\b(um|uh|er|ah|hmm|like|you know|i mean)\b/gi,
    // Hindi/Indic
    /\b(अ+|उ+|ए+|ओ+|क्या|मतलब|यानी)\b/gi,
    // Spanish
    /\b(eh|este|pues|bueno)\b/gi,
    // French
    /\b(euh|ben|alors|quoi)\b/gi,
    // Arabic
    /\b(يعني|أه|إه)\b/gi,
  ];

  // Correction patterns (user trying to fix misunderstood input)
  private readonly correctionPatterns = [
    /\b(no|wait|i said|i mean|sorry|actually|correction)\b/gi,
    /\b(नहीं|रुको|मैंने कहा|माफ़ी)\b/gi,
    /\b(no|espera|dije|perdón)\b/gi,
  ];

  constructor() {
    this.repetitionDetector = RepetitionDetectorFactory.getDetector();
  }

  /**
   * Analyze ASR quality for a session
   * @param turns Array of turn data including transcripts and NLU results
   * @param language Optional language code
   */
  async analyzeQuality(turns: ASRTurnData[], language?: string): Promise<ASRQualityResult> {
    if (turns.length === 0) {
      return this.emptyResult();
    }

    const transcripts = turns.map((t) => t.transcript);

    // Calculate individual signal scores
    const signals: ASRQualitySignals = {
      repetition: await this.calculateRepetitionScore(transcripts, language),
      hesitation: this.calculateHesitationScore(transcripts),
      correction: this.calculateCorrectionScore(transcripts),
      clarity: this.calculateClarityScore(transcripts),
      confidence: this.calculateConfidenceScore(turns),
    };

    // Calculate overall score (weighted average)
    const overallScore = this.calculateOverallScore(signals);

    // Detect issues
    const issues = this.detectIssues(signals);

    // Metadata
    const metadata = {
      totalTurns: turns.length,
      totalTranscripts: transcripts.length,
      averageTranscriptLength:
        transcripts.reduce((sum, t) => sum + t.length, 0) / transcripts.length,
      detectorType: this.repetitionDetector.getName(),
    };

    return {
      overallScore,
      signals,
      issues,
      metadata,
    };
  }

  /**
   * Signal 1: Repetition score using pluggable detector
   */
  private async calculateRepetitionScore(
    transcripts: string[],
    language?: string,
  ): Promise<number> {
    const result = await this.repetitionDetector.detectRepetition(transcripts, language);
    return result.score; // Already normalized to [0-1]
  }

  /**
   * Signal 2: Hesitation score (filler words, pauses)
   */
  private calculateHesitationScore(transcripts: string[]): number {
    let totalHesitations = 0;
    let totalWords = 0;

    for (const transcript of transcripts) {
      const words = transcript.split(/\s+/).filter((w) => w.length > 0);
      totalWords += words.length;

      for (const pattern of this.hesitationPatterns) {
        const matches = transcript.match(pattern);
        if (matches) {
          totalHesitations += matches.length;
        }
      }
    }

    if (totalWords === 0) return 0;

    // Normalize: 0 hesitations = 0, >10% = 1
    const hesitationRatio = totalHesitations / totalWords;
    return Math.min(hesitationRatio / 0.1, 1.0);
  }

  /**
   * Signal 3: Correction score (user trying to fix ASR errors)
   */
  private calculateCorrectionScore(transcripts: string[]): number {
    let correctionCount = 0;

    for (const transcript of transcripts) {
      for (const pattern of this.correctionPatterns) {
        if (pattern.test(transcript)) {
          correctionCount++;
          break; // Count once per transcript
        }
      }
    }

    if (transcripts.length === 0) return 0;

    // Normalize: 0 corrections = 0, >50% = 1
    const correctionRatio = correctionCount / transcripts.length;
    return Math.min(correctionRatio / 0.5, 1.0);
  }

  /**
   * Signal 4: Clarity score (transcript length and fragmentation)
   */
  private calculateClarityScore(transcripts: string[]): number {
    let shortTranscripts = 0;
    let fragmentedTranscripts = 0;

    for (const transcript of transcripts) {
      const words = transcript.split(/\s+/).filter((w) => w.length > 0);

      // Very short transcripts (1-2 words) suggest poor ASR
      if (words.length <= 2) {
        shortTranscripts++;
      }

      // Fragmented (lots of single-word chunks)
      if (words.length === 1 && transcript.trim().length > 0) {
        fragmentedTranscripts++;
      }
    }

    if (transcripts.length === 0) return 0;

    const shortRatio = shortTranscripts / transcripts.length;
    const fragmentedRatio = fragmentedTranscripts / transcripts.length;

    // Normalize: 0% short/fragmented = 0, >30% = 1
    return Math.min((shortRatio + fragmentedRatio) / 0.6, 1.0);
  }

  /**
   * Signal 5: ASR confidence score (if available from provider)
   */
  private calculateConfidenceScore(turns: ASRTurnData[]): number {
    const confidenceValues = turns
      .map((t) => t.confidence)
      .filter((c): c is number => c !== undefined && c > 0);

    if (confidenceValues.length === 0) {
      // No confidence data available - neutral score
      return 0.5;
    }

    const avgConfidence = confidenceValues.reduce((sum, c) => sum + c, 0) / confidenceValues.length;

    // Invert: high confidence = low score (good), low confidence = high score (bad)
    return 1 - avgConfidence;
  }

  /**
   * Calculate overall ASR quality score from signals
   * Weighted average: repetition (25%), hesitation (15%), correction (25%), clarity (20%), confidence (15%)
   */
  private calculateOverallScore(signals: ASRQualitySignals): number {
    const weights = {
      repetition: 0.25,
      hesitation: 0.15,
      correction: 0.25,
      clarity: 0.2,
      confidence: 0.15,
    };

    // Calculate weighted average of negative signals
    const negativeScore =
      signals.repetition * weights.repetition +
      signals.hesitation * weights.hesitation +
      signals.correction * weights.correction +
      signals.clarity * weights.clarity +
      signals.confidence * weights.confidence;

    // Convert to positive score [0-100], where 100 = perfect
    return Math.round((1 - negativeScore) * 100);
  }

  /**
   * Detect issues from signal scores
   */
  private detectIssues(signals: ASRQualitySignals): Array<{
    type: 'repetition' | 'hesitation' | 'correction' | 'clarity' | 'confidence';
    severity: 'low' | 'medium' | 'high';
    description: string;
  }> {
    const issues: Array<{
      type: 'repetition' | 'hesitation' | 'correction' | 'clarity' | 'confidence';
      severity: 'low' | 'medium' | 'high';
      description: string;
    }> = [];

    // Check each signal
    if (signals.repetition > 0.3) {
      issues.push({
        type: 'repetition',
        severity: signals.repetition > 0.6 ? 'high' : 'medium',
        description: 'Repeated phrases detected, indicating ASR confusion',
      });
    }

    if (signals.hesitation > 0.3) {
      issues.push({
        type: 'hesitation',
        severity: signals.hesitation > 0.6 ? 'high' : 'medium',
        description: 'Frequent filler words, suggesting poor recognition',
      });
    }

    if (signals.correction > 0.3) {
      issues.push({
        type: 'correction',
        severity: signals.correction > 0.6 ? 'high' : 'medium',
        description: 'User corrections detected',
      });
    }

    if (signals.clarity > 0.3) {
      issues.push({
        type: 'clarity',
        severity: signals.clarity > 0.6 ? 'high' : 'medium',
        description: 'Short/fragmented transcripts suggest poor audio or ASR',
      });
    }

    if (signals.confidence > 0.5) {
      issues.push({
        type: 'confidence',
        severity: signals.confidence > 0.7 ? 'high' : 'medium',
        description: 'Low ASR confidence scores detected',
      });
    }

    return issues;
  }

  /**
   * Return empty result for edge cases
   */
  private emptyResult(): ASRQualityResult {
    return {
      overallScore: 100, // Assume perfect if no data
      signals: {
        repetition: 0,
        hesitation: 0,
        correction: 0,
        clarity: 0,
        confidence: 0.5,
      },
      issues: [],
      metadata: {
        totalTurns: 0,
        totalTranscripts: 0,
        averageTranscriptLength: 0,
        detectorType: this.repetitionDetector.getName(),
      },
    };
  }
}
