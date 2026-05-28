/**
 * SendSlack — Restate activity service for sending Slack messages.
 *
 * Supports template substitution in channel and message fields.
 * Uses either a configured webhook URL or the tenant's Slack integration.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { substituteTemplates } from '../template-engine.js';
import { renderPipelineActionValue } from './pii-boundary.js';

export const sendSlackService = restate.service({
  name: 'SendSlackService',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { config, previousSteps, pipelineInput } = input;

      const templateContext = await renderPipelineActionValue(
        {
          input: pipelineInput,
          nodeOutputs: previousSteps,
        },
        { tenantId: input.tenantId, projectId: input.projectId },
      );

      const channel = substituteTemplates(config.channel ?? '', templateContext);
      const message = substituteTemplates(config.message ?? '', templateContext);
      const webhookUrl = config.webhookUrl
        ? substituteTemplates(config.webhookUrl as string, templateContext)
        : undefined;

      if (!channel || !message) {
        return {
          status: 'fail',
          data: { error: "send-slack requires 'channel' and 'message' in config" },
        };
      }

      return ctx.run('send-slack', async () => {
        try {
          if (webhookUrl) {
            // Direct webhook call
            const response = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ channel, text: message }),
            });

            if (!response.ok) {
              return {
                status: 'fail' as const,
                data: {
                  error: `Slack webhook returned ${response.status}: ${response.statusText}`,
                  channel,
                },
              };
            }

            return {
              status: 'success' as const,
              data: { channel, sent: true, via: 'webhook' },
            };
          }

          // Try tenant Slack integration
          // Dynamic import — package may not be installed in all deployments
          const modulePath = '@agent-platform/notifications/slack';
          const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ modulePath);
          const client = await mod.getSlackClient(pipelineInput.tenantId);
          await client.postMessage({ channel, text: message });

          return {
            status: 'success' as const,
            data: { channel, sent: true, via: 'integration' },
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
            return {
              status: 'fail' as const,
              data: {
                error:
                  'Slack integration not available. Provide a webhookUrl in config or install @agent-platform/notifications.',
                channel,
              },
            };
          }
          return {
            status: 'fail' as const,
            data: { error: `Failed to send Slack message: ${msg}`, channel },
          };
        }
      });
    },
  },
});

export type SendSlackService = typeof sendSlackService;
