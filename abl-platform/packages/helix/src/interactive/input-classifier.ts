import type { ModelSpec } from '../types.js';
import type { ModelRouter } from '../models/model-router.js';
import type { ClassifiedInput, InteractiveIntent } from './types.js';

/**
 * Classifies natural language input from the interactive REPL into
 * structured intents. Uses a fast pattern-matching classifier with
 * fallback to an LLM classifier when available.
 *
 * Pattern matching handles the common cases with high confidence;
 * the LLM path handles ambiguous natural language like
 * "maybe we should focus on the auth stuff first".
 */
export class InputClassifier {
  private readonly llmClassify: LlmClassifyFn | null;

  constructor(options?: InputClassifierOptions) {
    this.llmClassify = options?.llmClassify ?? null;
  }

  /**
   * Classify user input into an intent with extracted parameters.
   */
  async classify(rawInput: string): Promise<ClassifiedInput> {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return { intent: 'unknown', confidence: 0, rawInput, params: {} };
    }

    // Try fast pattern matching first
    const patternResult = classifyByPattern(trimmed);
    if (patternResult.confidence >= 0.8) {
      return patternResult;
    }

    // If we have an LLM classifier and pattern confidence is low, use it
    if (this.llmClassify && patternResult.confidence < 0.5) {
      try {
        const llmResult = await this.llmClassify(trimmed);
        if (llmResult.confidence > patternResult.confidence) {
          return llmResult;
        }
      } catch {
        // Fall through to pattern result on LLM failure
      }
    }

    return patternResult;
  }
}

export interface InputClassifierOptions {
  /** Optional LLM-based classifier for ambiguous inputs */
  llmClassify?: LlmClassifyFn;
}

export type LlmClassifyFn = (input: string) => Promise<ClassifiedInput>;

const CLASSIFIER_TIMEOUT_MS = 15_000;
const VALID_INTENTS: InteractiveIntent[] = [
  'inject-context',
  'skip-stage',
  'pause',
  'resume',
  'abort',
  'status',
  'prioritize',
  'help',
  'unknown',
];

/**
 * Build an LLM classifier backed by the HELIX model router.
 *
 * This path is intentionally lightweight: low effort, one turn, no tools,
 * and a short timeout because it only runs when the pattern matcher is unsure.
 */
export function createLlmInputClassifier(
  router: ModelRouter,
  baseModel: ModelSpec,
  timeoutMs: number = CLASSIFIER_TIMEOUT_MS,
): LlmClassifyFn {
  return async (input: string): Promise<ClassifiedInput> => {
    const result = await router.execute(
      buildLlmClassifierPrompt(input),
      {
        primary: {
          ...baseModel,
          effort: 'low',
          maxTurns: 1,
          systemPrompt: buildClassifierSystemPrompt(),
        },
      },
      undefined,
      undefined,
      undefined,
      timeoutMs,
    );

    if (result.error) {
      throw new Error(result.error);
    }

    return parseLlmClassificationOutput(result.output, input);
  };
}

// ─── Pattern-Based Classification ───────────────────────────────

interface PatternRule {
  pattern: RegExp;
  intent: InteractiveIntent;
  confidence: number;
  extractParams?: (match: RegExpMatchArray, raw: string) => Record<string, string>;
}

const PATTERN_RULES: PatternRule[] = [
  // Help
  {
    pattern: /^(?:help|\?|commands)$/i,
    intent: 'help',
    confidence: 1.0,
  },

  // Status
  {
    pattern:
      /^(?:status|what(?:'s| is) (?:happening|the status|going on)|progress|where are we)[\s?]*$/i,
    intent: 'status',
    confidence: 0.95,
  },

  // Pause
  {
    pattern: /^(?:pause|wait|hold)$/i,
    intent: 'pause',
    confidence: 1.0,
  },

  // Resume
  {
    pattern: /^(?:resume|continue|go|proceed)$/i,
    intent: 'resume',
    confidence: 1.0,
  },

  // Abort
  {
    pattern: /^(?:abort|stop|quit|cancel|kill)$/i,
    intent: 'abort',
    confidence: 1.0,
  },

  // Skip stage (explicit)
  {
    pattern: /^skip\s+(?:stage\s+)?(.+)$/i,
    intent: 'skip-stage',
    confidence: 0.95,
    extractParams: (match) => ({ stageName: match[1].trim() }),
  },

  // Prioritize finding (explicit)
  {
    pattern: /^(?:prioritize|bump|escalate)\s+(?:finding\s+)?([A-Za-z0-9-]+)$/i,
    intent: 'prioritize',
    confidence: 0.95,
    extractParams: (match) => ({ findingId: match[1].trim() }),
  },

  // Context injection — "focus on X", "note that X", "remember X", "consider X"
  {
    pattern:
      /^(?:focus on|note(?::| that)|remember|consider|look at|pay attention to|guidance:)\s+(.+)$/i,
    intent: 'inject-context',
    confidence: 0.85,
    extractParams: (match) => ({ content: match[1].trim() }),
  },

  // Context injection — quoted or prefixed
  {
    pattern: /^(?:context|inject|add context):\s*(.+)$/i,
    intent: 'inject-context',
    confidence: 0.95,
    extractParams: (match) => ({ content: match[1].trim() }),
  },
];

/**
 * Classify input using regex pattern rules.
 * Falls through to inject-context for unrecognized multi-word input
 * (heuristic: if it looks like guidance, treat it as context).
 */
function classifyByPattern(input: string): ClassifiedInput {
  for (const rule of PATTERN_RULES) {
    const match = input.match(rule.pattern);
    if (match) {
      return {
        intent: rule.intent,
        confidence: rule.confidence,
        rawInput: input,
        params: rule.extractParams ? rule.extractParams(match, input) : {},
      };
    }
  }

  // Heuristic: multi-word input that doesn't match any command is likely context injection
  const wordCount = input.split(/\s+/).length;
  if (wordCount >= 3) {
    return {
      intent: 'inject-context',
      confidence: 0.4,
      rawInput: input,
      params: { content: input },
    };
  }

  return {
    intent: 'unknown',
    confidence: 0,
    rawInput: input,
    params: {},
  };
}

function buildLlmClassifierPrompt(input: string): string {
  return [
    'Classify the following HELIX REPL input.',
    'Return only a single JSON object with `intent`, `confidence`, and `params`.',
    `Input: ${JSON.stringify(input)}`,
  ].join('\n');
}

function parseLlmClassificationOutput(output: string, rawInput: string): ClassifiedInput {
  const parsed = parseJsonCandidate(output);
  if (!isObjectRecord(parsed)) {
    throw new Error('Classifier did not return a JSON object');
  }

  const paramsValue = parsed['params'];
  const params = isObjectRecord(paramsValue)
    ? Object.fromEntries(
        Object.entries(paramsValue).filter((entry): entry is [string, string] => {
          return typeof entry[0] === 'string' && typeof entry[1] === 'string';
        }),
      )
    : {};

  return {
    intent: normalizeIntent(parsed['intent']),
    confidence: normalizeConfidence(parsed['confidence']),
    rawInput,
    params,
  };
}

function parseJsonCandidate(output: string): unknown {
  for (const candidate of collectJsonCandidates(output)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function collectJsonCandidates(output: string): string[] {
  const candidates: string[] = [];
  const trimmed = output.trim();
  if (trimmed) {
    candidates.push(trimmed);
  }

  const fencedMatches = output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fencedMatches) {
    const candidate = match[1]?.trim();
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate);
    }
  }

  const balancedObject = extractBalancedJsonObject(output);
  if (balancedObject && !candidates.includes(balancedObject)) {
    candidates.push(balancedObject);
  }

  return candidates;
}

function extractBalancedJsonObject(output: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === '\\') {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return output.slice(start, index + 1).trim();
      }
    }
  }

  return null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeIntent(value: unknown): InteractiveIntent {
  if (typeof value !== 'string') {
    return 'unknown';
  }

  const normalized = value.trim().toLowerCase();
  return VALID_INTENTS.includes(normalized as InteractiveIntent)
    ? (normalized as InteractiveIntent)
    : 'unknown';
}

function normalizeConfidence(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.min(1, numeric));
}

/**
 * Build the system prompt for LLM-based classification.
 * Exported for testing.
 */
export function buildClassifierSystemPrompt(): string {
  return `You are an intent classifier for a CLI tool called HELIX. Classify the user's input into exactly one of these intents:

- inject-context: User wants to give guidance or context to the running pipeline (e.g., "focus on auth middleware", "the bug is in the token refresh flow")
- skip-stage: User wants to skip a pipeline stage (e.g., "skip regression", "skip the review stage")
- pause: User wants to pause the pipeline
- resume: User wants to resume a paused pipeline
- abort: User wants to stop/cancel the pipeline
- status: User wants to know the current pipeline status
- prioritize: User wants to bump a specific finding's priority (e.g., "prioritize F-3")
- help: User wants to see available commands
- unknown: Cannot determine the intent

Respond in JSON format:
{"intent": "<intent>", "confidence": <0-1>, "params": {"key": "value"}}

For inject-context, set params.content to the extracted guidance.
For skip-stage, set params.stageName to the stage name.
For prioritize, set params.findingId to the finding ID.`;
}
