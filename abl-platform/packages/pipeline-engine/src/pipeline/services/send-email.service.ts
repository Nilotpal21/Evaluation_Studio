/**
 * SendEmail — Restate activity service for sending emails.
 *
 * Supports template substitution in to, subject, body fields.
 * Requires platform email integration to be configured for the tenant.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { substituteTemplates } from '../template-engine.js';
import { renderPipelineActionValue } from './pii-boundary.js';

export const sendEmailService = restate.service({
  name: 'SendEmailService',
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

      const to = substituteTemplates(config.to ?? '', templateContext);
      const subject = substituteTemplates(config.subject ?? '', templateContext);
      const body = substituteTemplates(config.body ?? '', templateContext);
      const cc = config.cc ? substituteTemplates(config.cc as string, templateContext) : undefined;

      if (!to || !subject || !body) {
        return {
          status: 'fail',
          data: { error: "send-email requires 'to', 'subject', and 'body' in config" },
        };
      }

      return ctx.run('send-email', async () => {
        try {
          // Dynamic import to avoid hard dependency on notification infrastructure
          // Dynamic import — package may not be installed in all deployments
          const modulePath = '@agent-platform/notifications/email';
          const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ modulePath);
          const transport = await mod.getEmailTransport(pipelineInput.tenantId);
          await transport.send({ to, subject, body, cc });

          return {
            status: 'success' as const,
            data: { to, subject, sent: true },
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          // If the notifications package isn't available, return a clear error
          if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
            return {
              status: 'fail' as const,
              data: {
                error:
                  'Email integration not available. Install @agent-platform/notifications to enable send-email nodes.',
                to,
                subject,
              },
            };
          }
          return {
            status: 'fail' as const,
            data: { error: `Failed to send email: ${msg}`, to, subject },
          };
        }
      });
    },
  },
});

export type SendEmailService = typeof sendEmailService;
