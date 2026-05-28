/**
 * ASR Cascade Failure Detector
 *
 * Detects the cascade chain: bad network → bad audio → wrong ASR → wrong intent → wrong response
 *
 * Uses converging signals to identify when multiple quality issues compound:
 * 1. Network quality (root cause) - Poor network degrades audio quality
 * 2. ASR confidence - Low confidence indicates recognition issues
 * 3. User repetition - User repeating themselves suggests wrong transcription
 * 4. Short responses - Minimal user replies after long agent speech indicate confusion
 * 5. Clarification patterns - Agent asking "did you mean" or "could you repeat"
 *
 * Risk Scoring:
 * - Low (< 0.4): Normal variation, no cascade
 * - Medium (0.4-0.7): Potential cascade, emit trace event
 * - High (> 0.7): Clear cascade pattern, emit trace event + alert
 *
 * Key Innovation: Root cause attribution using network MOS data from Homer/RTCP.
 * Distinguishes "bad ASR model" from "bad caller network causing ASR to fail".
 */

export interface CascadeTurnData {
  transcript: string;
  confidence?: number;
  inboundNetworkMos?: number;
  wordCount: number;
  agentResponseLength: number;
  agentAskedForClarification: boolean;
}

export interface CascadeRiskResult {
  risk: 'low' | 'medium' | 'high';
  score: number;
  factors: string[];
  networkQuality: 'good' | 'degraded' | 'poor' | 'unknown';
  rootCause: 'network' | 'asr' | 'mixed' | 'unknown';
  recommendation: string;
}

export class ASRCascadeDetector {
  private transcriptHistory: string[] = []; // Keep last 5 substantive transcripts
  private consecutiveLowConfidenceTurns: number = 0;
  private consecutiveClarificationRequests: number = 0;
  private readonly MAX_HISTORY = 5; // Look back up to 5 turns

  /**
   * Detect cascade risk for a single turn
   */
  detectCascadeRisk(turn: CascadeTurnData): CascadeRiskResult {
    const factors: string[] = [];
    let riskScore = 0;

    // ── Signal 1: Network Quality (Root Cause) ──────────────────────────
    // Highest weight - this is the PRIMARY root cause indicator
    const networkQuality = this.assessNetworkQuality(turn.inboundNetworkMos);
    if (networkQuality === 'poor') {
      riskScore += 0.35;
      factors.push('poor_network');
    } else if (networkQuality === 'degraded') {
      riskScore += 0.2;
      factors.push('degraded_network');
    }

    // ── Signal 2: ASR Confidence ────────────────────────────────────────
    const confidence = turn.confidence ?? 1.0;
    if (confidence < 0.5) {
      riskScore += 0.35;
      factors.push('very_low_confidence');
      this.consecutiveLowConfidenceTurns++;
    } else if (confidence < 0.7) {
      riskScore += 0.2;
      factors.push('low_confidence');
      this.consecutiveLowConfidenceTurns++;
    } else {
      this.consecutiveLowConfidenceTurns = 0;
    }

    // Consecutive low confidence amplifies risk
    if (this.consecutiveLowConfidenceTurns >= 2) {
      riskScore += 0.15;
      factors.push('consecutive_low_confidence');
    }

    // ── Signal 3: User Repetition ───────────────────────────────────────
    // Check if current transcript matches any recent transcript (ignoring filler words like "what?", "yes")
    const isRepeat = this.detectRepetitionInHistory(turn.transcript);
    if (isRepeat) {
      riskScore += 0.25;
      factors.push('user_repetition');
    }

    // ── Signal 4: Short Response After Long Agent Speech ───────────────
    // User gave minimal reply (≤2 words) after agent spoke a lot (>50 words)
    // Suggests user couldn't understand or is confused
    if (turn.wordCount <= 2 && turn.agentResponseLength > 50) {
      riskScore += 0.15;
      factors.push('minimal_user_response');
    }

    // ── Signal 5: Agent Clarification Requests ──────────────────────────
    if (turn.agentAskedForClarification) {
      riskScore += 0.2;
      factors.push('agent_clarification_request');
      this.consecutiveClarificationRequests++;
    } else {
      this.consecutiveClarificationRequests = 0;
    }

    // Multiple consecutive clarifications indicate stuck conversation
    if (this.consecutiveClarificationRequests >= 2) {
      riskScore += 0.2;
      factors.push('conversation_stuck');
    }

    // Update state for next turn
    // Only add substantive transcripts to history (skip short filler words)
    if (turn.wordCount > 2) {
      this.addToHistory(turn.transcript);
    }

    // ── Determine Risk Level ────────────────────────────────────────────
    const risk: 'low' | 'medium' | 'high' =
      riskScore < 0.4 ? 'low' : riskScore < 0.7 ? 'medium' : 'high';

    // ── Root Cause Attribution ──────────────────────────────────────────
    const rootCause = this.determineRootCause(factors, networkQuality);
    const recommendation = this.generateRecommendation(rootCause, factors);

    return {
      risk,
      score: Math.round(riskScore * 100) / 100, // Round to 2 decimals
      factors,
      networkQuality,
      rootCause,
      recommendation,
    };
  }

  /**
   * Detect if current transcript is a repetition of previous
   * Uses simple normalized similarity check
   */
  private isRepetition(current: string, previous: string): boolean {
    const normalize = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .trim();

    const currentNorm = normalize(current);
    const previousNorm = normalize(previous);

    if (!currentNorm || !previousNorm) return false;

    // Exact match
    if (currentNorm === previousNorm) return true;

    // High similarity (>80% of words in common)
    const currentWords = new Set(currentNorm.split(/\s+/));
    const previousWords = new Set(previousNorm.split(/\s+/));
    const intersection = new Set([...currentWords].filter((w) => previousWords.has(w)));
    const union = new Set([...currentWords, ...previousWords]);

    if (union.size === 0) return false;

    const similarity = intersection.size / union.size;
    return similarity > 0.8;
  }

  /**
   * Check if current transcript repeats any recent transcript in history
   * Looks back up to 5 turns to catch patterns like:
   * User: "book a hotel" → Agent: "..." → User: "what?" → User: "book a hotel" (repeat)
   */
  private detectRepetitionInHistory(currentTranscript: string): boolean {
    if (this.transcriptHistory.length === 0) return false;

    // Check if current matches any recent transcript
    for (const historicalTranscript of this.transcriptHistory) {
      if (this.isRepetition(currentTranscript, historicalTranscript)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add transcript to history, maintaining max size
   */
  private addToHistory(transcript: string): void {
    this.transcriptHistory.push(transcript);

    // Keep only last N transcripts
    if (this.transcriptHistory.length > this.MAX_HISTORY) {
      this.transcriptHistory.shift(); // Remove oldest
    }
  }

  /**
   * Assess network quality from MOS score
   */
  private assessNetworkQuality(mos?: number): 'good' | 'degraded' | 'poor' | 'unknown' {
    if (mos === undefined || mos === null) return 'unknown';
    if (mos >= 3.5) return 'good';
    if (mos >= 2.5) return 'degraded';
    return 'poor';
  }

  /**
   * Determine root cause based on contributing factors
   */
  private determineRootCause(
    factors: string[],
    networkQuality: string,
  ): 'network' | 'asr' | 'mixed' | 'unknown' {
    const hasNetworkIssues = factors.some((f) => ['poor_network', 'degraded_network'].includes(f));
    const hasASRIssues = factors.some((f) =>
      [
        'low_confidence',
        'very_low_confidence',
        'consecutive_low_confidence',
        'user_repetition',
      ].includes(f),
    );

    if (hasNetworkIssues && hasASRIssues) {
      // Network is the PRIMARY root cause if it's poor
      if (networkQuality === 'poor') return 'network';
      return 'mixed';
    }

    if (hasNetworkIssues) return 'network';
    if (hasASRIssues) return 'asr';

    return 'unknown';
  }

  /**
   * Generate actionable recommendation based on root cause
   */
  private generateRecommendation(rootCause: string, factors: string[]): string {
    switch (rootCause) {
      case 'network':
        return 'Poor caller network quality is causing ASR failures. Issue is network-related, not ASR model weakness.';

      case 'asr':
        if (factors.includes('user_repetition')) {
          return 'ASR transcription errors detected. Consider: (1) improving acoustic model, (2) adding domain-specific vocabulary, (3) using dual-ASR validation.';
        }
        return 'ASR confidence is low but network quality is good. Consider evaluating alternative ASR providers or custom model training.';

      case 'mixed':
        return 'Both network degradation and ASR issues detected. Address network quality first as it amplifies ASR problems.';

      default:
        return 'Quality issues detected. Review conversation transcript to identify specific failure points.';
    }
  }

  /**
   * Reset state (call at session end or between sessions)
   */
  reset(): void {
    this.transcriptHistory = [];
    this.consecutiveLowConfidenceTurns = 0;
    this.consecutiveClarificationRequests = 0;
  }
}
