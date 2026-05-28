/**
 * Pipeline Merge — Qwen-based synthesis of fan-out results
 *
 * After multi-intent short-circuit dispatches specialists in parallel,
 * this module uses the pipeline model (Qwen) to merge their responses
 * into a single coherent reply. Much faster than a full GPT-4.1 synthesis.
 */

import { generateText, streamText, type LanguageModel } from 'ai';
import { createLogger } from '@abl/compiler/platform';
import type { OnTraceEvent } from './types.js';
import { dumpLlmTrace } from '../llm/llm-trace.js';

const log = createLogger('pipeline-merge');

/** Timeout for merge LLM call (ms) */
const MERGE_TIMEOUT_MS = 15_000;

interface FanOutAgentResult {
  target: string;
  intent: string;
  response: string;
  status: 'completed' | 'failed';
  error?: string;
}

/**
 * Merge multiple specialist agent responses into a single coherent reply.
 * Uses the pipeline model (Qwen) for fast, lightweight synthesis.
 */
export async function mergeResponses(
  model: LanguageModel,
  userMessage: string,
  agentResults: FanOutAgentResult[],
  onChunk?: (chunk: string) => void,
  onTraceEvent?: OnTraceEvent,
): Promise<string> {
  const start = Date.now();
  const modelId = typeof model === 'string' ? model : model.modelId;

  // Build structured context from agent results
  const resultSections = agentResults
    .map((r) => {
      if (r.status === 'completed') {
        return `[${r.target}] (intent: ${r.intent})\n${r.response}`;
      }
      return `[${r.target}] FAILED: ${r.error || 'unknown error'}`;
    })
    .join('\n\n');

  const prompt = `You are a response synthesizer. The user asked a multi-part question and multiple specialist agents have answered. Combine their responses into one natural, coherent reply.

User message: "${userMessage}"

Agent responses:
${resultSections}

Rules:
- Combine all information into a single, well-structured response
- Do NOT add information that wasn't in the agent responses
- If an agent failed, mention that part could not be answered
- Keep the tone conversational and helpful
- Be concise — do not repeat yourself`;

  try {
    dumpLlmTrace('request', 'pipeline:merge', modelId, {
      pipelinePhase: 'merge',
      prompt,
      maxOutputTokens: 500,
      temperature: 0,
      agentCount: agentResults.length,
      agents: agentResults.map((r) => ({ target: r.target, intent: r.intent, status: r.status })),
    });

    if (onChunk) {
      // Streaming merge
      const result = streamText({
        model,
        prompt,
        maxOutputTokens: 500,
        temperature: 0,
        abortSignal: AbortSignal.timeout(MERGE_TIMEOUT_MS),
      });

      let fullText = '';
      for await (const chunk of result.textStream) {
        fullText += chunk;
        onChunk(chunk);
      }

      const latencyMs = Date.now() - start;

      dumpLlmTrace('response', 'pipeline:merge', modelId, {
        pipelinePhase: 'merge',
        latencyMs,
        responseLength: fullText.length,
        text: fullText,
        streaming: true,
      });

      if (onTraceEvent) {
        onTraceEvent({
          type: 'pipeline_merge',
          data: {
            latencyMs,
            agentCount: agentResults.length,
            responseLength: fullText.length,
          },
        });
      }

      return fullText;
    } else {
      // Non-streaming merge
      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: 500,
        temperature: 0,
        abortSignal: AbortSignal.timeout(MERGE_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - start;

      dumpLlmTrace('response', 'pipeline:merge', modelId, {
        pipelinePhase: 'merge',
        latencyMs,
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        finishReason: result.finishReason,
        text: result.text,
        streaming: false,
      });

      if (onTraceEvent) {
        onTraceEvent({
          type: 'pipeline_merge',
          data: {
            latencyMs,
            agentCount: agentResults.length,
            responseLength: result.text.length,
          },
        });
      }

      return result.text;
    }
  } catch (err) {
    log.warn('merge LLM call failed, falling back to concatenation', {
      error: err instanceof Error ? err.message : String(err),
    });

    // Fallback: concatenate responses with headers
    return agentResults
      .filter((r) => r.status === 'completed')
      .map((r) => r.response)
      .join('\n\n');
  }
}
