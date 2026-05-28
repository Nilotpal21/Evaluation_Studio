/**
 * Shared LLM Trace — JSONL day-wise logs with complete request/response payloads.
 *
 * Enabled via `LLM_TRACE=true` environment variable.
 * Writes to `llm-traces/` under `TRACE_DIR` (defaults to `process.cwd()`).
 *
 * Used by both SessionLLMClient (agent reasoning calls) and pipeline components
 * (classifier, tool filter, merge) to provide unified tracing of all LLM calls.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('llm-trace');

const TRACE_BASE = process.env.TRACE_DIR || process.cwd();
const LLM_TRACE_DIR = join(TRACE_BASE, 'llm-traces');

/**
 * Append a trace entry to the day-wise JSONL file.
 * No-op when `LLM_TRACE` env var is not `"true"`.
 */
export function dumpLlmTrace(
  phase: 'request' | 'response',
  agent: string,
  model: string,
  data: Record<string, unknown>,
): void {
  if (process.env.LLM_TRACE !== 'true') return;
  try {
    if (!existsSync(LLM_TRACE_DIR)) mkdirSync(LLM_TRACE_DIR, { recursive: true });
    const now = new Date();
    const day = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `${day}.jsonl`;
    const entry = {
      timestamp: now.toISOString(),
      phase,
      agent,
      model,
      ...data,
    };
    appendFileSync(join(LLM_TRACE_DIR, filename), JSON.stringify(entry) + '\n');
    log.info(`LLM_TRACE_${phase.toUpperCase()} appended`, { file: filename, agent, model });
  } catch (err) {
    log.warn('Failed to write LLM trace', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
