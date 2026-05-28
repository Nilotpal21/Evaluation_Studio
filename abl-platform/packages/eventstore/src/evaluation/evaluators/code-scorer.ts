/**
 * Code Scorer Evaluator
 *
 * Programmatic evaluator that runs user-defined scoring functions.
 * Zero LLM cost, instant execution. Useful for:
 * - Turn count checks (efficiency)
 * - Tool call validation (correct tools used)
 * - Keyword/regex pattern detection
 * - Conversation structure analysis
 */

import type {
  IEvaluator,
  EvaluationInput,
  EvaluationOutput,
  EvaluationScore,
} from '../interfaces.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * A scoring function that takes evaluation input and returns a score.
 * Must not throw — return a default score on error.
 */
export type ScoringFunction = (input: EvaluationInput) => EvaluationScore | EvaluationScore[];

/** Configuration for the code scorer evaluator */
export interface CodeScorerConfig {
  scorers: ScoringFunction[];
}

// =============================================================================
// BUILT-IN SCORERS
// =============================================================================

/**
 * Scores conversation efficiency based on turn count.
 * Fewer turns for the same outcome = more efficient.
 */
export function turnEfficiencyScorer(input: EvaluationInput): EvaluationScore {
  const turns = input.sessionMetadata.totalTurns;

  let score: number;
  if (turns <= 3) score = 5;
  else if (turns <= 6) score = 4;
  else if (turns <= 10) score = 3;
  else if (turns <= 15) score = 2;
  else score = 1;

  return {
    name: 'turn_efficiency',
    value: score,
    reasoning: `${turns} turns used. ${turns <= 6 ? 'Efficient resolution.' : 'High turn count suggests inefficiency or complexity.'}`,
  };
}

/**
 * Checks for bot repetition — same message sent multiple times.
 */
export function repetitionScorer(input: EvaluationInput): EvaluationScore {
  const agentMessages = input.messages
    .filter((m) => m.role === 'agent')
    .map((m) => m.content.trim().toLowerCase());

  const uniqueMessages = new Set(agentMessages);
  const repetitionRate =
    agentMessages.length > 0 ? 1 - uniqueMessages.size / agentMessages.length : 0;

  return {
    name: 'repetition_rate',
    value: Math.round(repetitionRate * 100) / 100,
    reasoning: `${Math.round(repetitionRate * 100)}% of agent messages were repeated. ${repetitionRate < 0.05 ? 'Minimal repetition.' : 'Significant repetition detected.'}`,
  };
}

/**
 * Detects whether the conversation ended with an error.
 */
export function errorOutcomeScorer(input: EvaluationInput): EvaluationScore {
  const hasError = input.sessionMetadata.endReason === 'error';
  const errorEvents = input.traceEvents.filter((e) => e.has_error);

  return {
    name: 'error_free',
    value: hasError ? 'fail' : 'pass',
    reasoning: hasError
      ? `Session ended with error. ${errorEvents.length} error events found in trace.`
      : 'Session completed without errors.',
  };
}

/**
 * Scores tool usage efficiency — ratio of successful tool calls to total.
 */
export function toolSuccessScorer(input: EvaluationInput): EvaluationScore {
  const toolCalls = input.traceEvents.filter(
    (e) => e.event_type === 'tool.call.completed' || e.event_type === 'tool.call.failed',
  );

  if (toolCalls.length === 0) {
    return {
      name: 'tool_success_rate',
      value: 1.0,
      reasoning: 'No tool calls made.',
    };
  }

  const successful = toolCalls.filter((e) => !e.has_error).length;
  const rate = successful / toolCalls.length;

  return {
    name: 'tool_success_rate',
    value: Math.round(rate * 100) / 100,
    reasoning: `${successful}/${toolCalls.length} tool calls succeeded (${Math.round(rate * 100)}%).`,
  };
}

/**
 * Detects escalation — whether the conversation was handed off to a human.
 */
export function containmentScorer(input: EvaluationInput): EvaluationScore {
  const escalations = input.traceEvents.filter((e) => e.event_type === 'agent.escalated');
  const contained = escalations.length === 0 && input.sessionMetadata.endReason === 'completed';

  return {
    name: 'contained',
    value: contained,
    reasoning: contained
      ? 'Session resolved without escalation.'
      : `Session ${escalations.length > 0 ? 'escalated to human' : 'did not complete successfully'}.`,
  };
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class CodeScorerEvaluator implements IEvaluator {
  readonly name: string;
  readonly type = 'code_scorer' as const;
  private readonly scorers: ScoringFunction[];

  constructor(name: string, config: CodeScorerConfig) {
    this.name = name;
    this.scorers = config.scorers;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const start = Date.now();
    const scores: EvaluationScore[] = [];

    for (const scorer of this.scorers) {
      try {
        const result = scorer(input);
        if (Array.isArray(result)) {
          scores.push(...result);
        } else {
          scores.push(result);
        }
      } catch {
        // Individual scorer failed — skip, don't block others
      }
    }

    return {
      evaluatorName: this.name,
      evaluatorType: 'code_scorer',
      scores,
      latencyMs: Date.now() - start,
    };
  }
}

/** Built-in code scorers for quick setup */
export const BUILT_IN_SCORERS: ScoringFunction[] = [
  turnEfficiencyScorer,
  repetitionScorer,
  errorOutcomeScorer,
  toolSuccessScorer,
  containmentScorer,
];
