/**
 * Eval Alert Rules
 *
 * 8 pre-configured alert rules for eval monitoring. Registered automatically
 * when the first eval set is created for a project.
 *
 * Types are locally defined to avoid adding a direct dependency on
 * @agent-platform/eventstore. The shapes match AlertRule from eventstore/alerting.
 */

import { createLogger } from '@abl/compiler/platform';

const log = createLogger('eval-alerts');

// ── Local types matching eventstore AlertRule shape ──────────────────

type AlertSeverity = 'info' | 'warning' | 'critical';

interface AlertWindow {
  value: number;
  unit: 'minutes' | 'hours' | 'days';
}

interface AlertRule {
  id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
  enabled: boolean;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  window: AlertWindow;
  severity: AlertSeverity;
  cooldownSeconds: number;
  channels: Array<{ type: string; url: string }>;
  createdAt: Date;
  updatedAt: Date;
}

// ── Alert templates ─────────────────────────────────────────────────

interface EvalAlertTemplate {
  idSuffix: string;
  name: string;
  description: string;
  metric: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  threshold: number;
  window: AlertWindow;
  severity: AlertSeverity;
  cooldownSeconds: number;
}

const EVAL_ALERT_TEMPLATES: EvalAlertTemplate[] = [
  {
    idSuffix: 'eval-run-failed',
    name: 'Eval run failed',
    description: 'Fires when any eval run fails within a 5-minute window',
    metric: 'eval.run.failed',
    operator: 'gt',
    threshold: 0,
    window: { value: 5, unit: 'minutes' },
    severity: 'critical',
    cooldownSeconds: 300,
  },
  {
    idSuffix: 'eval-circuit-breaker-open',
    name: 'Eval circuit breaker opened',
    description: 'Fires when any eval circuit breaker opens',
    metric: 'eval.circuit_breaker.opened',
    operator: 'gt',
    threshold: 0,
    window: { value: 5, unit: 'minutes' },
    severity: 'critical',
    cooldownSeconds: 600,
  },
  {
    idSuffix: 'eval-cost-warning',
    name: 'Eval cost budget >80%',
    description: 'Monthly eval spend exceeds 80% of budget',
    metric: 'eval.monthly_cost',
    operator: 'gt',
    threshold: 0.8,
    window: { value: 1, unit: 'days' },
    severity: 'warning',
    cooldownSeconds: 3600,
  },
  {
    idSuffix: 'eval-cost-exceeded',
    name: 'Eval cost budget exceeded',
    description: 'Monthly eval spend exceeds 100% of budget',
    metric: 'eval.monthly_cost',
    operator: 'gt',
    threshold: 1.0,
    window: { value: 1, unit: 'days' },
    severity: 'critical',
    cooldownSeconds: 3600,
  },
  {
    idSuffix: 'eval-regression',
    name: 'Eval regression detected',
    description: 'A regression was detected in an eval run',
    metric: 'eval.regression.detected',
    operator: 'gt',
    threshold: 0,
    window: { value: 5, unit: 'minutes' },
    severity: 'warning',
    cooldownSeconds: 600,
  },
  {
    idSuffix: 'eval-run-duration',
    name: 'Eval run duration exceeded',
    description: 'An eval run took longer than 30 minutes',
    metric: 'eval.run.duration_ms',
    operator: 'gt',
    threshold: 1_800_000,
    window: { value: 1, unit: 'hours' },
    severity: 'warning',
    cooldownSeconds: 1800,
  },
  {
    idSuffix: 'eval-judge-latency',
    name: 'Eval judge latency spike',
    description: 'Judge call p95 latency exceeds 30 seconds over a 5-minute window',
    metric: 'eval.judge.duration_ms.p95',
    operator: 'gt',
    threshold: 30_000,
    window: { value: 5, unit: 'minutes' },
    severity: 'warning',
    cooldownSeconds: 300,
  },
  {
    idSuffix: 'eval-rate-limit-saturation',
    name: 'Eval rate limit saturation',
    description: 'Rate limit queue depth exceeds 10 for 10 minutes',
    metric: 'eval.rate_limit.queue_depth',
    operator: 'gt',
    threshold: 10,
    window: { value: 10, unit: 'minutes' },
    severity: 'info',
    cooldownSeconds: 600,
  },
];

/**
 * Build AlertRule objects for a tenant/project from templates.
 */
export function buildEvalAlertRules(tenantId: string, projectId: string): AlertRule[] {
  const now = new Date();
  return EVAL_ALERT_TEMPLATES.map((t) => ({
    id: `${projectId}-${t.idSuffix}`,
    tenantId,
    projectId,
    name: t.name,
    description: t.description,
    enabled: true,
    metric: t.metric,
    operator: t.operator,
    threshold: t.threshold,
    window: t.window,
    severity: t.severity,
    cooldownSeconds: t.cooldownSeconds,
    channels: [],
    createdAt: now,
    updatedAt: now,
  }));
}

/**
 * Register eval alert rules for a project.
 * Idempotent — skips rules that already exist.
 *
 * @param ruleStore - The alert rule store implementation (injected)
 * @param tenantId - Tenant scope
 * @param projectId - Project scope
 */
export async function registerEvalAlertRules(
  ruleStore: {
    getActiveRules: (t: string, p: string) => Promise<AlertRule[]>;
    createRule: (r: AlertRule) => Promise<void>;
  },
  tenantId: string,
  projectId: string,
): Promise<number> {
  const existing = await ruleStore.getActiveRules(tenantId, projectId);
  const existingIds = new Set(existing.map((r) => r.id));

  const rules = buildEvalAlertRules(tenantId, projectId);
  let created = 0;

  for (const rule of rules) {
    if (!existingIds.has(rule.id)) {
      await ruleStore.createRule(rule);
      created++;
    }
  }

  if (created > 0) {
    log.info('Registered eval alert rules', { tenantId, projectId, created });
  }

  return created;
}
