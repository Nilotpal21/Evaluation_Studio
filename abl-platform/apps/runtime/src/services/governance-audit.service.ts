import { createLogger } from '@abl/compiler/platform';
import {
  GovernancePolicy,
  GovernancePolicyVersion,
  GovernanceOverride,
} from '@agent-platform/database';
import type { IGovernancePolicyRule } from '@agent-platform/database';
import {
  PIPELINE_TABLES,
  PIPELINE_DATE_COLUMNS,
  periodToDays,
  parseClickHouseRows,
} from '../routes/pipeline-analytics-helpers.js';
import { Semaphore } from './llm/local-semaphore.js';

const log = createLogger('governance');

export interface AuditEvent {
  eventRef: string;
  timestamp: string;
  pipelineType: string;
  metric: string;
  agentName: string;
  agentVersion?: string;
  threshold: number;
  thresholdAtTime: number;
  actualValue: number;
  severity: 'critical' | 'warning' | 'info';
  eventType: 'breach' | 'recovery';
  overrideId?: string;
  reviewStatus?: 'pending' | 'approved' | 'rejected';
}

export interface AuditPage {
  events: AuditEvent[];
  total: number;
  page: number;
  limit: number;
}

export interface AuditFilters {
  pipelineTypes?: string[];
  agentNames?: string[];
  severities?: string[];
  eventTypes?: ('breach' | 'recovery')[];
}

/**
 * Build a ClickHouse breach detection query for a specific pipeline type.
 * Pure function — no I/O.
 */
export function buildBreachQuery(
  pipelineType: string,
  table: string,
  dateCol: string,
  rules: IGovernancePolicyRule[],
  period: string,
): string {
  const days = periodToDays(period);
  // Defense-in-depth: metric names must be safe SQL identifiers. Metrics are
  // validated against METRIC_REGISTRY at policy creation, but we sanitize here
  // in case of a validation bypass.
  const safeRules = rules.filter((r) => /^[a-z][a-z0-9_]*$/.test(r.metric));
  const ruleConditions = safeRules
    .map((r) => {
      switch (r.operator) {
        case 'gt':
          return `${r.metric} > ${r.threshold}`;
        case 'gte':
          return `${r.metric} >= ${r.threshold}`;
        case 'lt':
          return `${r.metric} < ${r.threshold}`;
        case 'lte':
          return `${r.metric} <= ${r.threshold}`;
        case 'eq':
          return `${r.metric} = ${r.threshold}`;
        default:
          return `${r.metric} > ${r.threshold}`;
      }
    })
    .join(' OR ');

  // Invert the condition: a "breach" is when the rule threshold is violated
  // The operator in a rule means "metric must be OP threshold to PASS"
  // So a breach is the negation of all rules
  const breachConditions = safeRules
    .map((r) => {
      switch (r.operator) {
        case 'gt':
          return `${r.metric} <= ${r.threshold}`;
        case 'gte':
          return `${r.metric} < ${r.threshold}`;
        case 'lt':
          return `${r.metric} >= ${r.threshold}`;
        case 'lte':
          return `${r.metric} > ${r.threshold}`;
        case 'eq':
          return `${r.metric} != ${r.threshold}`;
        default:
          return `${r.metric} <= ${r.threshold}`;
      }
    })
    .join(' OR ');

  const metricSelects = safeRules
    .map((r) => `${r.metric} as actual_value_${r.metric.replace(/[^a-z0-9_]/gi, '_')}`)
    .join(', ');

  return `
SELECT
  agent_name,
  agent_version,
  ${metricSelects},
  ${dateCol} as timestamp
FROM ${table}
WHERE
  tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND ${dateCol} >= now() - INTERVAL {days:UInt32} DAY
  AND (${breachConditions})
ORDER BY ${dateCol} DESC
SETTINGS max_execution_time = 15
`.trim();
}

export class GovernanceAuditService {
  async getAuditEvents(
    tenantId: string,
    projectId: string,
    period: string,
    page: number,
    limit: number,
    filters?: AuditFilters,
  ): Promise<AuditPage> {
    const policies = await GovernancePolicy.find({ tenantId, projectId, status: 'enabled' }).lean();

    if (policies.length === 0) {
      return { events: [], total: 0, page, limit };
    }

    // Group rules by pipelineType; apply filters if provided
    const rulesByType: Record<string, IGovernancePolicyRule[]> = {};
    for (const policy of policies) {
      for (const rule of policy.rules) {
        if (filters?.pipelineTypes && !filters.pipelineTypes.includes(rule.pipelineType)) continue;
        if (filters?.severities && !filters.severities.includes(rule.severity)) continue;
        if (!rulesByType[rule.pipelineType]) rulesByType[rule.pipelineType] = [];
        rulesByType[rule.pipelineType].push(rule);
      }
    }

    const pipelineTypes = Object.keys(rulesByType);
    if (pipelineTypes.length === 0) {
      return { events: [], total: 0, page, limit };
    }

    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const ch = getClickHouseClient();
    const sem = new Semaphore(4);

    const queryResults = await Promise.allSettled(
      pipelineTypes.map(async (pt) => {
        await sem.acquire();
        try {
          const table = PIPELINE_TABLES[pt];
          const dateCol = PIPELINE_DATE_COLUMNS[pt] ?? 'session_started_at';
          const query = buildBreachQuery(pt, table, dateCol, rulesByType[pt], period);
          const result = await Promise.race([
            ch.query({ query, query_params: { tenantId, projectId, days: periodToDays(period) } }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`ClickHouse timeout: ${pt}`)), 5000),
            ),
          ]);
          const rows = parseClickHouseRows(await result.json());
          return { pipelineType: pt, rows, rules: rulesByType[pt] };
        } finally {
          sem.release();
        }
      }),
    );

    // Build audit events from ClickHouse rows
    const allEvents: AuditEvent[] = [];
    for (const result of queryResults) {
      if (result.status !== 'fulfilled') {
        log.warn('Breach query failed', {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        continue;
      }
      const { pipelineType, rows, rules } = result.value;
      for (const row of rows) {
        for (const rule of rules) {
          const metricKey = `actual_value_${rule.metric.replace(/[^a-z0-9_]/gi, '_')}`;
          const actualValue = typeof row[metricKey] === 'number' ? (row[metricKey] as number) : 0;
          const agentName = typeof row.agent_name === 'string' ? row.agent_name : 'unknown';
          const timestamp =
            row.timestamp instanceof Date
              ? row.timestamp.toISOString()
              : String(row.timestamp ?? new Date().toISOString());
          const eventRef = `${pipelineType}:${agentName}:${rule.metric}:${timestamp}`;

          if (filters?.agentNames && !filters.agentNames.includes(agentName)) continue;

          allEvents.push({
            eventRef,
            timestamp,
            pipelineType,
            metric: rule.metric,
            agentName,
            agentVersion: typeof row.agent_version === 'string' ? row.agent_version : undefined,
            threshold: rule.threshold,
            thresholdAtTime: rule.threshold, // resolved below
            actualValue,
            severity: rule.severity,
            eventType: 'breach',
          });
        }
      }
    }

    // Sort by timestamp DESC
    allEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Resolve thresholdAtTime from policy versions
    const policyIds = policies.map((p) => String(p._id));
    for (const event of allEvents) {
      try {
        const policyVersion = await GovernancePolicyVersion.findOne({
          tenantId,
          projectId,
          policyId: { $in: policyIds },
          createdAt: { $lte: new Date(event.timestamp) },
        })
          .sort({ createdAt: -1 })
          .lean();
        if (policyVersion) {
          const matchingRule = policyVersion.rules.find((r) => r.metric === event.metric);
          if (matchingRule) {
            event.thresholdAtTime = matchingRule.threshold;
          }
        }
      } catch (err) {
        log.warn('Failed to resolve thresholdAtTime for audit event', {
          eventRef: event.eventRef,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Merge override records
    const eventRefs = allEvents.map((e) => e.eventRef);
    if (eventRefs.length > 0) {
      const overrides = await GovernanceOverride.find({
        tenantId,
        projectId,
        eventRef: { $in: eventRefs },
      }).lean();
      const overrideMap = new Map(overrides.map((o) => [o.eventRef, o]));
      for (const event of allEvents) {
        const override = overrideMap.get(event.eventRef);
        if (override) {
          event.overrideId = String(override._id);
          event.reviewStatus = 'pending';
        }
      }
    }

    // Apply eventType filter
    const filtered = filters?.eventTypes
      ? allEvents.filter((e) => filters.eventTypes!.includes(e.eventType))
      : allEvents;

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const paginatedEvents = filtered.slice(offset, offset + limit);

    return { events: paginatedEvents, total, page, limit };
  }
}
