/**
 * Tool Result Compressor
 *
 * Compresses large tool results before they enter conversation history.
 * Reads configuration from CompactionPolicy — no hardcoded domain knowledge.
 *
 * Strategies:
 *  - 'none': pass through unchanged
 *  - 'truncate': character-cap only (no structural understanding)
 *  - 'structured': strip non-essential fields, truncate descriptions, then char-cap
 *  - 'summarize': LLM-powered summary with structural compression fallback
 */

import type { CompactionPolicy } from '@abl/compiler/platform/ir/schema.js';
import { DEFAULT_COMPACTION_POLICY } from './compaction-policy.js';

// Tool result compaction thresholds moved to CompactionPolicy (compaction-policy.ts).
// See DEFAULT_COMPACTION_POLICY for platform defaults.

/**
 * Compress a serialized tool result string.
 *
 * @param serialized - Raw JSON string from tool execution
 * @param toolName - Name of the tool that produced this result (for per-tool field config)
 * @param policy - CompactionPolicy to use (defaults to platform defaults for backward compat)
 */
export function compressToolResult(
  serialized: string,
  toolName?: string,
  policy?: CompactionPolicy,
): string {
  const p = policy ?? DEFAULT_COMPACTION_POLICY;
  const { strategy, structured_threshold, max_description_length } = p.tool_results;

  // Strategy: none — pass through unchanged
  if (strategy === 'none') return serialized;

  // Under threshold — no compression needed
  if (serialized.length <= structured_threshold) return serialized;

  // Strategy: truncate — char-cap only, no structural understanding
  if (strategy === 'truncate') {
    return JSON.stringify({
      _truncated: true,
      _originalSize: serialized.length,
      _preview: serialized.slice(0, 500),
    });
  }

  // Strategy: structured (or summarize fallback) — strip fields, then char-cap
  try {
    const parsed = JSON.parse(serialized);
    if (typeof parsed === 'object' && parsed !== null) {
      const essentialFields = resolveEssentialFields(toolName, p);
      const maxDescLen = max_description_length ?? 200;
      const compressed = compressStructured(parsed, essentialFields, maxDescLen);
      let result = JSON.stringify(compressed);
      if (result.length <= structured_threshold) {
        return result;
      }
      result = trimItemsToFit(compressed, structured_threshold);
      if (result.length <= structured_threshold) {
        return result;
      }
    }
  } catch {
    // Not valid JSON — fall through to truncation summary
  }

  return JSON.stringify({
    _truncated: true,
    _originalSize: serialized.length,
    _preview: serialized.slice(0, 500),
  });
}

/**
 * Resolve essential fields for a tool.
 * Returns a Set if the tool has configured fields, or undefined if no filtering.
 */
function resolveEssentialFields(
  toolName: string | undefined,
  policy: CompactionPolicy,
): Set<string> | undefined {
  if (!toolName || !policy.tool_results.essential_fields) return undefined;
  const fields = policy.tool_results.essential_fields[toolName];
  if (!fields || fields.length === 0) return undefined;
  return new Set(fields);
}

function compressStructured(
  obj: Record<string, unknown>,
  essentialFields: Set<string> | undefined,
  maxDescLen: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
      result[key] = compressItemArray(value, essentialFields, maxDescLen);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function compressItemArray(
  items: unknown[],
  essentialFields: Set<string> | undefined,
  maxDescLen: number,
): unknown[] {
  return items.map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const entries = Object.entries(item as Record<string, unknown>);

    // No essential fields configured — keep all fields, just truncate descriptions
    if (!essentialFields) {
      const compressed: Record<string, unknown> = {};
      for (const [key, value] of entries) {
        if (key === 'description' && typeof value === 'string' && value.length > maxDescLen) {
          compressed[key] = value.slice(0, maxDescLen) + '...';
        } else {
          compressed[key] = value;
        }
      }
      return compressed;
    }

    // Filter to essential fields only
    const compressed: Record<string, unknown> = {};
    for (const [key, value] of entries) {
      if (!essentialFields.has(key)) continue;
      if (key === 'description' && typeof value === 'string' && value.length > maxDescLen) {
        compressed[key] = value.slice(0, maxDescLen) + '...';
      } else {
        compressed[key] = value;
      }
    }
    return compressed;
  });
}

/** Progressively remove trailing items from array fields until result fits within maxChars. */
function trimItemsToFit(obj: Record<string, unknown>, maxChars: number): string {
  const clone = { ...obj };
  for (const [key, value] of Object.entries(clone)) {
    if (!Array.isArray(value)) continue;
    const arr = [...value];
    clone[key] = arr;
    while (arr.length > 1) {
      arr.pop();
      const candidate = JSON.stringify(clone);
      if (candidate.length <= maxChars) {
        return candidate;
      }
    }
  }
  return JSON.stringify(clone);
}

// ─── LLM Summarization ──────────────────────────────────────────────────

/** Callback type for LLM-powered summarization. */
export type SummarizeLLMFn = (systemPrompt: string, userContent: string) => Promise<string>;

/** Default system prompt for tool result summarization. */
export const DEFAULT_SUMMARIZE_PROMPT =
  'You summarize tool results into a concise answer. ' +
  'ALWAYS preserve: document titles, filenames, source names, source types, IDs, scores, and total count. ' +
  'For each result item, keep at minimum: title/source, score, and a one-line content summary. ' +
  'Focus on key facts, dates, names, numbers, and actionable information. ' +
  'Preserve all data the agent needs to answer the user. ' +
  'Return ONLY the summary text, nothing else.';

/**
 * Summarize a large tool result using an LLM.
 *
 * Returns a JSON string with `_summarized: true` and the summary text,
 * or null if summarization produced no output (caller should fall back).
 *
 * @param serialized - Raw JSON string from tool execution
 * @param toolName - Name of the tool (included in LLM prompt for context)
 * @param llmFn - Async function that calls the LLM
 * @param customPrompt - Optional custom system prompt (from DSL `summarize_prompt`)
 */
export async function summarizeToolResult(
  serialized: string,
  toolName: string,
  llmFn: SummarizeLLMFn,
  customPrompt?: string,
): Promise<string | null> {
  const systemPrompt = customPrompt ?? DEFAULT_SUMMARIZE_PROMPT;

  const summary = await llmFn(systemPrompt, `Tool "${toolName}" returned:\n${serialized}`);

  const trimmed = summary?.trim();
  if (!trimmed) return null;

  return JSON.stringify({
    _summarized: true,
    _toolName: toolName,
    _originalSize: serialized.length,
    summary: trimmed,
  });
}
