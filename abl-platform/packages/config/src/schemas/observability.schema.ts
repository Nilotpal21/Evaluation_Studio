import { z } from 'zod';

/**
 * Observability configuration — reconciled from PlatformConfig.ObservabilityConfig
 */
export const ObservabilityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  traceSamplingRate: z.coerce.number().min(0).max(1).default(1.0),
  metricsEnabled: z.boolean().default(false),
  loggingLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  otlpEndpoint: z.string().optional(),
  serviceName: z.string().default('agent-platform'),
  serviceVersion: z.string().default('1.0.0'),
  debug: z.boolean().default(false),
  alerting: z
    .object({
      enabled: z.boolean().default(false),
      webhookUrl: z.string().url().optional(),
    })
    .default({}),

  // Feature flags — Phase 1 Production Observability rollout
  traceCanonicalRead: z.boolean().default(false),
  strictReadinessGates: z.boolean().default(false),
  metricLabelGuardrails: z.boolean().default(false),
  eventbusTraceHeaders: z.boolean().default(false),
});

export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
