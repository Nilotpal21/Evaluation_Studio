import { parseStructuredStageOutputResult } from '../pipeline/stage-output-parsers.js';
import { buildStageOutputInstructions } from '../pipeline/stage-output-schema.js';
import type { StageOutputSchemaConfig } from '../types.js';

export interface StructuredOutputMalformedCheck {
  malformed: boolean;
  errorMessage?: string;
  errorDetails: string[];
}

/**
 * Validate a candidate structured output string against its registered schema.
 * Returns `{ malformed: false }` when the output parses and validates, otherwise
 * returns structured error details suitable for feeding back to the model in a
 * repair turn.
 */
export function checkStructuredOutput(
  output: string,
  schema: StageOutputSchemaConfig,
): StructuredOutputMalformedCheck {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return {
      malformed: true,
      errorMessage: `${schema.id} output was empty`,
      errorDetails: [],
    };
  }

  const result = parseStructuredStageOutputResult(output, schema.id);
  if (result.error) {
    return {
      malformed: true,
      errorMessage: result.error.message,
      errorDetails: result.error.details,
    };
  }

  return { malformed: false, errorDetails: [] };
}

/**
 * Build a tightly-scoped repair prompt that surfaces the schema contract, the
 * rejected output, and the AJV/parse errors. The repair turn is intentionally
 * single-shot — no tool calls, no code reading — because the model already has
 * everything it needs to reformat the JSON.
 */
export function buildSchemaRepairPrompt(
  failedOutput: string,
  schema: StageOutputSchemaConfig,
  errorMessage: string | undefined,
  errorDetails: string[],
): string {
  const contract = buildStageOutputInstructions(schema);
  const trimmed = failedOutput.trim();
  const previewSource = trimmed.length > 0 ? trimmed : '(empty output)';
  const preview =
    previewSource.length > 4000 ? `${previewSource.slice(0, 4000)}\n…[truncated]` : previewSource;
  const errorLines: string[] = [];
  if (errorMessage) {
    errorLines.push(`- ${errorMessage}`);
  }
  for (const detail of errorDetails) {
    errorLines.push(`- ${detail}`);
  }
  if (errorLines.length === 0) {
    errorLines.push('- The previous output did not parse as valid JSON.');
  }

  return [
    'Your previous response did not match the required structured output contract.',
    'Return ONLY the corrected JSON object — no prose, no markdown fences, no commentary.',
    'Do NOT call any tools; the output is already in context.',
    '',
    '## Validation Errors',
    errorLines.join('\n'),
    '',
    '## Previous Output',
    '```',
    preview,
    '```',
    '',
    contract,
  ].join('\n');
}
