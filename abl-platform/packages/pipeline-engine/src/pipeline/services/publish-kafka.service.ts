/**
 * PublishKafka — Restate activity service for publishing events to Kafka topics.
 *
 * Supports template substitution in key field.
 * Requires Kafka producer to be configured.
 */
import * as restate from '@restatedev/restate-sdk';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { substituteTemplates } from '../template-engine.js';
import { renderPipelineActionValue } from './pii-boundary.js';

export const publishKafkaService = restate.service({
  name: 'PublishKafkaService',
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

      const topic = config.topic as string;
      const key = config.key
        ? substituteTemplates(config.key as string, templateContext)
        : undefined;
      const payload = await renderPipelineActionValue(config.payload, {
        tenantId: input.tenantId,
        projectId: input.projectId,
      });

      if (!topic || payload === undefined) {
        return {
          status: 'fail',
          data: { error: "publish-kafka requires 'topic' and 'payload' in config" },
        };
      }

      return ctx.run('publish-kafka', async () => {
        try {
          // Dynamic import — package may not be installed in all deployments.
          const modulePath = '@agent-platform/messaging/kafka';
          const mod = await import(/* webpackIgnore: true */ modulePath);
          const producer = await mod.getKafkaProducer();
          await producer.send({
            topic,
            messages: [
              {
                key: key ?? undefined,
                value: JSON.stringify(payload),
              },
            ],
          });

          return {
            status: 'success' as const,
            data: { topic, key, published: true },
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
            return {
              status: 'fail' as const,
              data: {
                error:
                  'Kafka producer not available. Install @agent-platform/messaging to enable publish-kafka nodes.',
                topic,
              },
            };
          }
          return {
            status: 'fail' as const,
            data: { error: `Failed to publish to Kafka: ${msg}`, topic },
          };
        }
      });
    },
  },
});

export type PublishKafkaService = typeof publishKafkaService;
