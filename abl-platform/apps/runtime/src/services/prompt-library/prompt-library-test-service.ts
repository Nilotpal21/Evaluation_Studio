/**
 * Prompt Library Test Service
 *
 * Executes single-turn LLM tests against prompt versions.
 * Resolves TenantModel credentials and uses Vercel AI SDK `generateText`.
 *
 * Pure helper functions (extractVariables, sanitizeVariableValue, renderTemplate)
 * are exported for unit testing without DI.
 */

import { generateText, streamText, type LanguageModel } from 'ai';
import { resolveTenantPlaintextValue } from '@agent-platform/database';
import { createVercelProvider } from '@agent-platform/llm';
import { createLogger } from '@abl/compiler/platform';
import { AppError } from '@agent-platform/shared-kernel';
import { getPromptLibraryService } from './prompt-library-service.js';

const log = createLogger('prompt-library-test-service');

// =============================================================================
// CONSTANTS
// =============================================================================

const TIMEOUT_MS = parseInt(process.env.PROMPT_LIBRARY_TEST_TIMEOUT_MS ?? '60000', 10);
const MAX_PARALLEL = parseInt(process.env.PROMPT_LIBRARY_TEST_MAX_PARALLEL ?? '5', 10);

// =============================================================================
// PURE HELPERS (exported for unit testing)
// =============================================================================

/**
 * Extract variable names from a prompt template.
 * Variables are enclosed in double curly braces: {{variableName}}.
 */
export function extractVariables(template: string): string[] {
  const regex = /\{\{\s*(\w+)\s*\}\}/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}

/**
 * Sanitize a variable value to prevent template injection.
 * Strips all `{{` and `}}` substrings from the value.
 */
export function sanitizeVariableValue(val: string): string {
  return val.replace(/\{\{/g, '').replace(/\}\}/g, '');
}

/**
 * Render a prompt template by replacing {{varName}} placeholders.
 * All variable values are sanitized before substitution.
 */
export function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) => {
    const value = variables[name] ?? '';
    return sanitizeVariableValue(value);
  });
}

// =============================================================================
// INTERFACES
// =============================================================================

export interface TestPane {
  promptVersionId: string;
  tenantModelId: string;
  output: string;
  usage: { input: number; output: number; total: number };
  latencyMs: number;
  model: string;
  provider: string;
}

export interface FailedPane {
  promptVersionId?: string;
  tenantModelId?: string;
  error: { code: string; message: string };
}

export interface TestResult {
  panes: TestPane[];
  failedPanes: FailedPane[];
}

export interface TestExecutionParams {
  tenantId: string;
  projectId: string;
  panes: Array<{ promptVersionId: string; tenantModelId: string }>;
  variables?: Record<string, string>;
  userMessage?: string;
  abortSignal?: AbortSignal;
}

// =============================================================================
// STREAMING EVENT TYPES
// =============================================================================

export type TestStreamEvent =
  | { type: 'pane_start'; paneIndex: number; tenantModelId: string }
  | { type: 'pane_delta'; paneIndex: number; text: string }
  | {
      type: 'pane_done';
      paneIndex: number;
      tenantModelId: string;
      latencyMs: number;
      usage: { input: number; output: number; total: number };
      model: string;
      provider: string;
    }
  | {
      type: 'pane_error';
      paneIndex: number;
      tenantModelId: string;
      error: { code: string; message: string };
    }
  | { type: 'done' };

// =============================================================================
// MODEL RESOLUTION (follows model-resolver.ts pattern)
// =============================================================================

interface ResolvedModel {
  languageModel: LanguageModel;
  modelId: string;
  provider: string;
}

/**
 * Resolve a TenantModel to a Vercel AI LanguageModel.
 * Follows the exact pattern from apps/runtime/src/services/pipeline/model-resolver.ts:72-143.
 */
async function resolveTenantModel(tenantModelId: string, tenantId: string): Promise<ResolvedModel> {
  const { TenantModel, LLMCredential } = await import('@agent-platform/database/models');

  const tenantModel = await TenantModel.findOne({
    _id: tenantModelId,
    tenantId,
    isActive: true,
  }).lean();

  if (!tenantModel) {
    throw new AppError(`TenantModel not found or inactive`, {
      code: 'PROMPT_LIBRARY_MODEL_NOT_FOUND',
      statusCode: 400,
    });
  }

  const connections = (tenantModel as Record<string, unknown>).connections as
    | Array<{ isPrimary?: boolean; isActive?: boolean; credentialId?: string }>
    | undefined;
  const connArr = connections ?? [];
  const connection =
    connArr.find((c) => c.isPrimary && c.isActive) ?? connArr.find((c) => c.isActive) ?? connArr[0];

  if (!connection?.credentialId) {
    throw new AppError('TenantModel has no active connection with a credential', {
      code: 'PROMPT_LIBRARY_CREDENTIAL_MISSING',
      statusCode: 400,
    });
  }

  // Do NOT use .lean() — LLMCredential has a post-find decryption hook
  const credential = await LLMCredential.findOne({
    _id: connection.credentialId,
    tenantId,
    isActive: true,
  });

  if (!credential || !(credential as Record<string, unknown>).encryptedApiKey) {
    throw new AppError('Credential not found or has no API key', {
      code: 'PROMPT_LIBRARY_CREDENTIAL_MISSING',
      statusCode: 400,
    });
  }

  const provider =
    ((tenantModel as Record<string, unknown>).provider as string | undefined) ?? 'openai';
  const modelId = (tenantModel as Record<string, unknown>).modelId as string;

  const apiKey = await resolveTenantPlaintextValue(
    (credential as { encryptedApiKey?: string | null }).encryptedApiKey ?? null,
    tenantId,
    {
      decryptionFailed: Boolean((credential as { _decryptionFailed?: boolean })._decryptionFailed),
    },
  );

  const baseUrl = await resolveTenantPlaintextValue(
    (credential as { encryptedEndpoint?: string | null }).encryptedEndpoint ?? null,
    tenantId,
  );

  if (!apiKey) {
    throw new AppError('Credential decryption failed', {
      code: 'PROMPT_LIBRARY_CREDENTIAL_DECRYPTION',
      statusCode: 400,
    });
  }

  const languageModel = createVercelProvider(provider, apiKey, baseUrl ?? undefined, modelId);
  return { languageModel, modelId: modelId ?? 'unknown', provider };
}

// =============================================================================
// SERVICE
// =============================================================================

export class PromptLibraryTestService {
  /**
   * Execute a multi-pane test against prompt versions with different models.
   * Returns HTTP 200 even with partial pane failures.
   */
  async executeTest(params: TestExecutionParams): Promise<TestResult> {
    const { tenantId, projectId, panes, variables, userMessage } = params;

    if (panes.length > MAX_PARALLEL) {
      throw new AppError(`Maximum ${MAX_PARALLEL} panes allowed per test`, {
        code: 'PROMPT_LIBRARY_TOO_MANY_PANES',
        statusCode: 400,
      });
    }

    const service = getPromptLibraryService();
    const results: TestPane[] = [];
    const failedPanes: FailedPane[] = [];

    const tasks = panes.map(async (pane) => {
      const { promptVersionId, tenantModelId } = pane;
      try {
        // Fetch the prompt version
        // We need to find the version without knowing its promptId upfront,
        // so query by _id + tenant scope
        const version = await (async () => {
          const { PromptLibraryVersion: PLV } = await import('@agent-platform/database/models');
          return (await PLV.findOne({
            _id: promptVersionId,
            tenantId,
            projectId,
          }).lean()) as import('@agent-platform/database/models').IPromptLibraryVersion | null;
        })();

        if (!version) {
          failedPanes.push({
            promptVersionId,
            tenantModelId,
            error: {
              code: 'PROMPT_LIBRARY_VERSION_NOT_FOUND',
              message: 'Prompt version not found',
            },
          });
          return;
        }

        if (version.status === 'archived') {
          failedPanes.push({
            promptVersionId,
            tenantModelId,
            error: {
              code: 'PROMPT_LIBRARY_VERSION_ARCHIVED',
              message: 'Prompt version is archived',
            },
          });
          return;
        }

        // Render template with provided variables
        const renderedPrompt = renderTemplate(version.template, variables ?? {});

        // Resolve the model
        const resolved = await resolveTenantModel(tenantModelId, tenantId);

        // Execute LLM call with timeout
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const startTime = Date.now();

        try {
          const genResult = await generateText({
            model: resolved.languageModel,
            ...(userMessage
              ? {
                  system: renderedPrompt,
                  messages: [{ role: 'user' as const, content: userMessage }],
                }
              : { prompt: renderedPrompt }),
            abortSignal: controller.signal,
          });

          const latencyMs = Date.now() - startTime;

          results.push({
            promptVersionId,
            tenantModelId,
            output: genResult.text,
            usage: {
              input: genResult.usage?.inputTokens ?? 0,
              output: genResult.usage?.outputTokens ?? 0,
              total: genResult.usage?.totalTokens ?? 0,
            },
            latencyMs,
            model: resolved.modelId,
            provider: resolved.provider,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const code = err instanceof AppError ? err.code : 'PROMPT_LIBRARY_TEST_EXECUTION_ERROR';
        // Only surface AppError messages (codebase-authored, safe). Raw provider
        // errors can contain API keys, endpoint URLs, and credential hints.
        const clientMessage =
          err instanceof AppError ? err.message : 'Model execution failed. Please try again.';

        log.error('Pane test execution failed', {
          promptVersionId,
          tenantModelId,
          error: rawMessage,
        });

        failedPanes.push({
          promptVersionId,
          tenantModelId,
          error: { code, message: clientMessage },
        });
      }
    });

    await Promise.all(tasks);

    return { panes: results, failedPanes };
  }

  /**
   * Stream a multi-pane test, yielding SSE events as tokens arrive.
   * Runs all panes concurrently, interleaving events through a queue.
   */
  async *streamTest(params: TestExecutionParams): AsyncGenerator<TestStreamEvent> {
    const { tenantId, projectId, panes, variables, userMessage, abortSignal } = params;

    if (panes.length > MAX_PARALLEL) {
      throw new AppError(`Maximum ${MAX_PARALLEL} panes allowed per test`, {
        code: 'PROMPT_LIBRARY_TOO_MANY_PANES',
        statusCode: 400,
      });
    }

    // Simple channel pattern — push events from concurrent pane tasks, yield from generator
    const pending: Array<TestStreamEvent | null> = [];
    let waiter: (() => void) | null = null;

    const push = (item: TestStreamEvent | null) => {
      pending.push(item);
      waiter?.();
      waiter = null;
    };

    const next = (): Promise<TestStreamEvent | null> => {
      if (pending.length > 0) return Promise.resolve(pending.shift()!);
      return new Promise<TestStreamEvent | null>((resolve) => {
        waiter = () => resolve(pending.shift()!);
      });
    };

    let completedPanes = 0;
    const totalPanes = panes.length;

    const tasks = panes.map(async (pane, i) => {
      const { promptVersionId, tenantModelId } = pane;
      try {
        push({ type: 'pane_start', paneIndex: i, tenantModelId });

        // Fetch the prompt version
        const version = await (async () => {
          const { PromptLibraryVersion: PLV } = await import('@agent-platform/database/models');
          return (await PLV.findOne({
            _id: promptVersionId,
            tenantId,
            projectId,
          }).lean()) as import('@agent-platform/database/models').IPromptLibraryVersion | null;
        })();

        if (!version) {
          push({
            type: 'pane_error',
            paneIndex: i,
            tenantModelId,
            error: {
              code: 'PROMPT_LIBRARY_VERSION_NOT_FOUND',
              message: 'Prompt version not found',
            },
          });
          return;
        }

        if (version.status === 'archived') {
          push({
            type: 'pane_error',
            paneIndex: i,
            tenantModelId,
            error: {
              code: 'PROMPT_LIBRARY_VERSION_ARCHIVED',
              message: 'Prompt version is archived',
            },
          });
          return;
        }

        // Render template with provided variables
        const renderedPrompt = renderTemplate(version.template, variables ?? {});

        // Resolve the model
        const resolved = await resolveTenantModel(tenantModelId, tenantId);

        // Create abort controller with timeout and external signal
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        if (abortSignal) {
          if (abortSignal.aborted) {
            controller.abort();
          } else {
            abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
          }
        }

        const startTime = Date.now();

        try {
          const result = streamText({
            model: resolved.languageModel,
            ...(userMessage
              ? {
                  system: renderedPrompt,
                  messages: [{ role: 'user' as const, content: userMessage }],
                }
              : { prompt: renderedPrompt }),
            abortSignal: controller.signal,
          });

          for await (const chunk of result.textStream) {
            push({ type: 'pane_delta', paneIndex: i, text: chunk });
          }

          const usageData = await result.usage;
          const latencyMs = Date.now() - startTime;

          push({
            type: 'pane_done',
            paneIndex: i,
            tenantModelId,
            latencyMs,
            usage: {
              input: usageData?.inputTokens ?? 0,
              output: usageData?.outputTokens ?? 0,
              total: usageData?.totalTokens ?? 0,
            },
            model: resolved.modelId,
            provider: resolved.provider,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const code = err instanceof AppError ? err.code : 'PROMPT_LIBRARY_TEST_EXECUTION_ERROR';
        const clientMessage =
          err instanceof AppError ? err.message : 'Model execution failed. Please try again.';

        log.error('Pane stream execution failed', {
          paneIndex: i,
          promptVersionId,
          tenantModelId,
          error: rawMessage,
        });

        push({
          type: 'pane_error',
          paneIndex: i,
          tenantModelId,
          error: { code, message: clientMessage },
        });
      } finally {
        completedPanes++;
        if (completedPanes === totalPanes) {
          push({ type: 'done' });
          push(null); // end sentinel
        }
      }
    });

    // Start all pane tasks (fire-and-forget — generator drains the queue below)
    void Promise.all(tasks).catch((err: unknown) => {
      log.error('Stream test task orchestration failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Yield events as they arrive
    while (true) {
      const item = await next();
      if (item === null) break;
      yield item;
    }
  }
}

// =============================================================================
// SINGLETON FACTORY
// =============================================================================

let instance: PromptLibraryTestService | null = null;

export function getPromptLibraryTestService(): PromptLibraryTestService {
  if (!instance) {
    instance = new PromptLibraryTestService();
  }
  return instance;
}

export function resetPromptLibraryTestService(): void {
  instance = null;
}
