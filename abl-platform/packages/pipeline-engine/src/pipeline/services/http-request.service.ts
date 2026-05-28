/**
 * HttpRequest — Restate activity service for making external HTTP calls.
 *
 * Supports template substitution ({{variable}}) in URL, headers, and body
 * using the shared template engine. Variables are resolved from pipeline input
 * and previous step outputs.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { substituteTemplates } from '../template-engine.js';
import { renderPipelineActionValue } from './pii-boundary.js';

export const httpRequestService = restate.service({
  name: 'HttpRequestService',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { config, previousSteps, pipelineInput } = input;

      // Build template context from previous steps and pipeline input
      const templateContext = await renderPipelineActionValue(
        {
          input: pipelineInput,
          steps: {} as Record<string, any>,
        },
        { tenantId: input.tenantId, projectId: input.projectId },
      );
      for (const [stepId, output] of Object.entries(previousSteps)) {
        templateContext.steps[stepId] = { output: output.data };
      }
      const safeTemplateContext = await renderPipelineActionValue(templateContext, {
        tenantId: input.tenantId,
        projectId: input.projectId,
      });

      const url = substituteTemplates(config.url ?? '', safeTemplateContext);
      const method = (config.method ?? 'GET').toUpperCase();
      const timeoutMs = config.timeoutMs ?? 30_000;

      // Substitute templates in headers
      const headers: Record<string, string> = {};
      if (config.headers) {
        for (const [key, value] of Object.entries(config.headers)) {
          headers[key] = substituteTemplates(String(value), safeTemplateContext);
        }
      }

      // Substitute templates in body
      let body: string | undefined;
      if (config.body) {
        body = substituteTemplates(
          typeof config.body === 'string' ? config.body : JSON.stringify(config.body),
          safeTemplateContext,
        );
      }

      // Inject idempotency key for non-safe HTTP methods (Restate replay safety)
      if (method !== 'GET' && method !== 'HEAD') {
        const runId = (pipelineInput?.runId as string) ?? '';
        if (!headers['Idempotency-Key'] && !headers['X-Idempotency-Key']) {
          headers['X-Idempotency-Key'] = `${runId}:http-request:${url}`;
        }
      }

      return ctx.run('http-request', async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(url, {
            method,
            headers,
            body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
            signal: controller.signal,
          });

          clearTimeout(timer);

          const responseText = await response.text();
          let responseBody: any;
          try {
            responseBody = JSON.parse(responseText);
          } catch {
            responseBody = responseText;
          }

          if (!response.ok) {
            return {
              status: 'fail' as const,
              data: {
                error: `HTTP ${response.status}: ${response.statusText}`,
                statusCode: response.status,
                body: responseBody,
              },
            };
          }

          return {
            status: 'success' as const,
            data: {
              statusCode: response.status,
              body: responseBody,
              headers: Object.fromEntries(response.headers.entries()),
            },
          };
        } catch (error) {
          clearTimeout(timer);
          const msg = error instanceof Error ? error.message : String(error);
          return {
            status: 'fail' as const,
            data: { error: msg },
          };
        }
      });
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type HttpRequestService = typeof httpRequestService;
