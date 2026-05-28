/**
 * Pipeline LLM Call Utility — wraps model creation + text generation with
 * input/output logging for validation and debugging.
 *
 * All pipeline services use this instead of calling createVercelProvider +
 * generateText directly, so input/output logging is centralized.
 */
import { createVercelProvider, generateText } from '@agent-platform/llm';
import { createLogger } from '@abl/compiler/platform';
import type { ResolvedPipelineLLM } from './llm-client-factory.js';
import { renderPipelineLLMValue, renderPipelineReadValue } from './pii-boundary.js';

const log = createLogger('pipeline-llm-call');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineGenerateParams {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface PipelineGenerateResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface PipelineLLMContext {
  service: string;
  tenantId: string;
  projectId?: string;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Create a Vercel AI provider, log input, call generateText, log output.
 *
 * Returns the same shape that all pipeline services expect:
 * `{ content, inputTokens, outputTokens, model }`.
 */
export async function pipelineGenerateText(
  resolved: ResolvedPipelineLLM,
  params: PipelineGenerateParams,
  context: PipelineLLMContext,
): Promise<PipelineGenerateResult> {
  const { provider, apiKey, baseUrl, modelId, authConfig } = resolved;
  const model = createVercelProvider(provider, apiKey, baseUrl, modelId, undefined, authConfig);
  const safeParams = await renderPipelineLLMValue(params, {
    tenantId: context.tenantId,
    projectId: context.projectId,
    role: 'user',
  });

  log.info('LLM call — input', {
    service: context.service,
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    model: modelId,
    provider,
    source: resolved.source,
    systemPromptLen: safeParams.system?.length ?? 0,
    userPromptLen: safeParams.messages[0]?.content?.length ?? 0,
    systemPrompt: safeParams.system?.substring(0, 300),
    userPrompt: safeParams.messages[0]?.content?.substring(0, 500),
  });

  const result = await generateText({
    model,
    system: safeParams.system,
    messages: safeParams.messages,
    maxOutputTokens: safeParams.maxOutputTokens ?? 1024,
    temperature: safeParams.temperature ?? 0,
  });
  const safeResponse = await renderPipelineReadValue(result.text, {
    tenantId: context.tenantId,
    projectId: context.projectId,
    role: 'assistant',
  });

  log.info('LLM call — output', {
    service: context.service,
    tenantId: context.tenantId,
    sessionId: context.sessionId,
    model: modelId,
    responseLen: safeResponse?.length ?? 0,
    response: safeResponse?.substring(0, 1000),
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
  });

  return {
    content: safeResponse,
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    model: modelId,
  };
}
