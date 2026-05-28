/**
 * Governance Dashboard — Zod Contracts
 *
 * THE SINGLE SOURCE OF TRUTH for all governance request/response shapes.
 * Imported by:
 *   - governance.ts (route handlers for body validation)
 *   - Studio governance hooks (via re-export wrapper)
 *   - Contract tests (parse responses through these schemas)
 */

import { z } from 'zod';
import { VALID_PIPELINE_TYPES } from './pipeline-analytics-helpers.js';

// ─── Pipeline Type Enum ────────────────────────────────────────────────────────

/**
 * Spread of VALID_PIPELINE_TYPES Set produces string[], but z.enum() requires
 * [string, ...string[]] (non-empty tuple). The type assertion is safe because
 * the Set always has 11 members.
 */
const VALID_PIPELINE_TYPES_ARRAY = [...VALID_PIPELINE_TYPES] as [string, ...string[]];

// ─── Request Schemas ───────────────────────────────────────────────────────────

export const GovernanceRuleSchema = z.object({
  pipelineType: z.enum(VALID_PIPELINE_TYPES_ARRAY),
  metric: z.string().min(1),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  threshold: z.number().finite(),
  severity: z.enum(['critical', 'warning', 'info']),
});
export type GovernanceRule = z.infer<typeof GovernanceRuleSchema>;

export const CreatePolicyBodySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  rules: z.array(GovernanceRuleSchema).min(1).max(20),
  status: z.enum(['enabled', 'disabled']).default('enabled'),
});
export type CreatePolicyBody = z.infer<typeof CreatePolicyBodySchema>;

export const UpdatePolicyBodySchema = CreatePolicyBodySchema;
export type UpdatePolicyBody = z.infer<typeof UpdatePolicyBodySchema>;

export const CreateOverrideBodySchema = z.object({
  justification: z.string().min(1).max(500),
  originalSeverity: z.enum(['critical', 'warning', 'info']),
  policyVersion: z.number().int().positive().default(1),
});
export type CreateOverrideBody = z.infer<typeof CreateOverrideBodySchema>;

// ─── Response Schemas ──────────────────────────────────────────────────────────

export const GovernanceRuleStatusSchema = z.object({
  pipelineType: z.string(),
  metric: z.string(),
  status: z.enum(['PASS', 'WARN', 'FAIL', 'NOT_EVALUATED']),
  metricValue: z.number().nullable(),
  threshold: z.number(),
  severity: z.enum(['critical', 'warning', 'info']),
});

export const GovernanceAgentStatusSchema = z.object({
  agentName: z.string(),
  overallStatus: z.enum(['PASS', 'WARN', 'FAIL', 'NOT_EVALUATED']),
  rules: z.array(GovernanceRuleStatusSchema),
});

export const GovernanceStatusResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    period: z.string(),
    policies: z.array(z.object({ _id: z.string(), name: z.string(), status: z.string() })),
    agents: z.array(GovernanceAgentStatusSchema),
    summary: z.object({
      pass: z.number(),
      warn: z.number(),
      fail: z.number(),
      unavailable: z.number(),
    }),
  }),
});

export const GovernanceAuditEventSchema = z.object({
  eventRef: z.string(),
  timestamp: z.string(),
  pipelineType: z.string(),
  metric: z.string(),
  agentName: z.string(),
  agentVersion: z.string().optional(),
  threshold: z.number(),
  thresholdAtTime: z.number(),
  actualValue: z.number(),
  severity: z.enum(['critical', 'warning', 'info']),
  eventType: z.enum(['breach', 'recovery']),
  overrideId: z.string().optional(),
  reviewStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const GovernanceAuditResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    events: z.array(GovernanceAuditEventSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  }),
});

export const FrameworkControlSchema = z.object({
  controlId: z.string(),
  requirement: z.string(),
  status: z.enum(['PASS', 'FAIL', 'WARN', 'NOT_EVALUATED']),
  evidence: z.string(),
});

export const GovernanceFrameworksResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    frameworks: z.array(
      z.object({
        id: z.enum(['SOC2', 'GDPR', 'EU_AI_ACT']),
        label: z.string(),
        controls: z.array(FrameworkControlSchema),
      }),
    ),
  }),
});
