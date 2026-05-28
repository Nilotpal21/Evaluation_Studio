/**
 * Pipeline Tool Filter
 *
 * Single LLM call to select the most relevant tools for the next agent step.
 * Falls back to the full tool set on parse failure or insufficient matches.
 */

import { generateText, type LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform';
import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import type { PipelineConfig, ToolFilterResult, OnTraceEvent } from './types.js';
import { dumpLlmTrace } from '../llm/llm-trace.js';

const log = createLogger('pipeline-tool-filter');

/** Timeout for tool filter LLM call (ms) */
const TOOL_FILTER_TIMEOUT_MS = 10_000;

/** Minimum tools to accept from filter (below this = fallback to full set) */
const MIN_FILTERED_TOOLS = 2;

/**
 * Build the tool filter prompt.
 */
function buildToolFilterPrompt(userMessage: string, toolNames: string[], maxTools: number): string {
  return `Select ${MIN_FILTERED_TOOLS}-${maxTools} most relevant tools for handling this user message.
If no tools are needed (e.g. farewell, thanks), return {"tools": []}.
Return ONLY valid JSON: {"tools": ["name1", "name2"]}

Available tools: ${toolNames.join(', ')}

User message: "${userMessage}"`;
}

/**
 * Parse tool filter JSON response, with fallback.
 */
export function parseToolFilterResponse(text: string, validToolNames: Set<string>): string[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.tools)) return [];

    // Filter to only valid tool names
    return parsed.tools.filter((t: unknown) => typeof t === 'string' && validToolNames.has(t));
  } catch {
    log.warn('tool filter response parse failed', { text: text.slice(0, 200) });
    return [];
  }
}

/**
 * Run tool filtering on the user message.
 * Returns filtered tool names, or falls back to full set on failure.
 */
export async function filterTools(
  model: LanguageModel,
  userMessage: string,
  tools: ToolDefinition[],
  config: PipelineConfig,
  onTraceEvent?: OnTraceEvent,
): Promise<ToolFilterResult> {
  if (!config.toolFilter.enabled) {
    return { selectedTools: tools.map((t) => t.name), fellBack: false };
  }

  // Exclude system/routing tools from filter prompt — they are always re-added
  const toolNames = tools
    .filter(
      (t) =>
        !t.name.startsWith('__') &&
        !t.name.startsWith('handoff_to_') &&
        !t.name.startsWith('delegate_to_'),
    )
    .map((t) => t.name);

  // No domain tools to filter (e.g. supervisor with only handoff tools) — skip LLM call
  if (toolNames.length === 0) {
    return { selectedTools: [], fellBack: false };
  }

  const validNames = new Set(toolNames);
  const start = Date.now();

  const modelId = typeof model === 'string' ? model : model.modelId;

  try {
    const prompt = buildToolFilterPrompt(userMessage, toolNames, config.toolFilter.maxTools);

    dumpLlmTrace('request', 'pipeline:tool-filter', modelId, {
      pipelinePhase: 'tool_filter',
      prompt,
      maxOutputTokens: 200,
      temperature: 0,
      availableTools: toolNames,
    });

    const result = await generateText({
      model,
      prompt,
      maxOutputTokens: 200,
      temperature: 0,
      abortSignal: AbortSignal.timeout(TOOL_FILTER_TIMEOUT_MS),
    });

    const selected = parseToolFilterResponse(result.text, validNames);
    const latencyMs = Date.now() - start;

    dumpLlmTrace('response', 'pipeline:tool-filter', modelId, {
      pipelinePhase: 'tool_filter',
      latencyMs,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      finishReason: result.finishReason,
      rawText: result.text,
      selectedTools: selected,
      fellBack: selected.length > 0 && selected.length < MIN_FILTERED_TOOLS,
    });

    // Fallback: if LLM selected too few tools (but >0), return full set as safety net.
    // Empty selection means "no domain tools needed" — propagate as empty array.
    const fellBack = selected.length > 0 && selected.length < MIN_FILTERED_TOOLS;
    const finalTools = fellBack ? toolNames : selected;

    if (onTraceEvent) {
      onTraceEvent({
        type: 'pipeline_filter',
        data: {
          originalToolCount: tools.length,
          filteredTools: finalTools,
          model: typeof model === 'string' ? model : model.modelId,
          latencyMs,
        },
      });
    }

    return {
      selectedTools: finalTools,
      fellBack,
    };
  } catch (err) {
    log.warn('tool filter LLM call failed, using full tool set', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { selectedTools: toolNames, fellBack: true };
  }
}
