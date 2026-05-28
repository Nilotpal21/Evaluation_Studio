import { createLogger } from '@abl/compiler/platform';
import { GovernancePolicy, METRIC_SUMMARY_ALIAS } from '@agent-platform/database';
import type { IGovernancePolicy, IGovernancePolicyRule } from '@agent-platform/database';
import { Semaphore } from './llm/local-semaphore.js';
import { executePipelineSummary } from './pipeline-analytics-summary.service.js';
import type { GovernanceCache } from './cache/governance-cache.js';
import { recordSyntheticTraceEvent } from './channel-trace-utils.js';

const log = createLogger('governance');

export interface RuleResult {
  pipelineType: string;
  metric: string;
  status: 'PASS' | 'FAIL' | 'NOT_EVALUATED';
  metricValue: number | null;
  threshold: number;
  severity: 'critical' | 'warning' | 'info';
}

export interface AgentStatus {
  agentName: string;
  overallStatus: 'PASS' | 'WARN' | 'FAIL' | 'NOT_EVALUATED';
  rules: RuleResult[];
}

export interface GovernanceStatusData {
  period: string;
  policies: Array<{ _id: string; name: string; status: string }>;
  agents: AgentStatus[];
  summary: { pass: number; warn: number; fail: number; unavailable: number };
}

export class GovernanceStatusService {
  constructor(private readonly cache: GovernanceCache) {}

  async getStatus(
    tenantId: string,
    projectId: string,
    period: string,
  ): Promise<GovernanceStatusData> {
    const startMs = Date.now();

    // Cache check
    const cached = await this.cache.get(tenantId, projectId, period);
    if (cached) {
      log.debug('governance.status.cache_hit', { tenantId, projectId, period });
      return cached as GovernanceStatusData;
    }

    // Fetch enabled policies
    const policies = await GovernancePolicy.find({ tenantId, projectId, status: 'enabled' }).lean();

    if (policies.length === 0) {
      const empty: GovernanceStatusData = {
        period,
        policies: [],
        agents: [],
        summary: { pass: 0, warn: 0, fail: 0, unavailable: 0 },
      };
      return empty;
    }

    // Collect unique pipeline types across all policies
    const pipelineTypeSet = new Set<string>();
    for (const policy of policies) {
      for (const rule of policy.rules) {
        pipelineTypeSet.add(rule.pipelineType);
      }
    }
    const pipelineTypes = Array.from(pipelineTypeSet);

    // Semaphore-limited ClickHouse fan-out (max 4 concurrent)
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const ch = getClickHouseClient();
    const sem = new Semaphore(4);

    const summaryResults = await Promise.allSettled(
      pipelineTypes.map(async (pt) => {
        await sem.acquire();
        try {
          const summary = await this.fetchWithTimeout(ch, tenantId, projectId, pt, period);
          return { pipelineType: pt, summary };
        } finally {
          sem.release();
        }
      }),
    );

    // Build summaryByType map
    const summaryByType: Record<string, Record<string, unknown>> = {};
    for (const result of summaryResults) {
      if (result.status === 'fulfilled') {
        summaryByType[result.value.pipelineType] = result.value.summary;
      }
    }

    // Evaluate all rules across all policies — aggregate at the project level
    const agentStatusMap: Record<string, RuleResult[]> = {};
    for (const policy of policies) {
      const agentKey = 'project'; // status is project-wide, not per-agent for now
      if (!agentStatusMap[agentKey]) agentStatusMap[agentKey] = [];

      for (const rule of policy.rules) {
        const summary = summaryByType[rule.pipelineType];
        let metricValue: number | null = null;
        let ruleStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED' = 'NOT_EVALUATED';

        if (summary) {
          const aliasMap = METRIC_SUMMARY_ALIAS[rule.pipelineType] ?? {};
          const summaryKey = aliasMap[rule.metric] ?? rule.metric;
          const rawValue = summary[summaryKey];
          if (typeof rawValue === 'number' || typeof rawValue === 'string') {
            metricValue = Number(rawValue);
            if (!isNaN(metricValue)) {
              ruleStatus = GovernanceStatusService.evaluateRule(
                metricValue,
                rule.operator,
                rule.threshold,
              );
            }
          }
        }

        agentStatusMap[agentKey].push({
          pipelineType: rule.pipelineType,
          metric: rule.metric,
          status: ruleStatus,
          metricValue,
          threshold: rule.threshold,
          severity: rule.severity,
        });
      }
    }

    const agents: AgentStatus[] = Object.entries(agentStatusMap).map(([agentName, rules]) => ({
      agentName,
      overallStatus: GovernanceStatusService.computeAgentStatus(rules),
      rules,
    }));

    const summary = {
      pass: agents.filter((a) => a.overallStatus === 'PASS').length,
      warn: agents.filter((a) => a.overallStatus === 'WARN').length,
      fail: agents.filter((a) => a.overallStatus === 'FAIL').length,
      unavailable: agents.filter((a) => a.overallStatus === 'NOT_EVALUATED').length,
    };

    const result: GovernanceStatusData = {
      period,
      policies: (policies as IGovernancePolicy[]).map((p) => ({
        _id: String(p._id),
        name: p.name,
        status: p.status,
      })),
      agents,
      summary,
    };

    // Cache with configurable TTL
    const ttl = parseInt(process.env.GOVERNANCE_STATUS_CACHE_TTL_SECONDS ?? '300', 10);
    await this.cache.set(tenantId, projectId, period, result, ttl);

    // Traceability — emit as synthetic trace event (no-op if no sessionId)
    const durationMs = Date.now() - startMs;
    recordSyntheticTraceEvent({
      tenantId,
      projectId,
      event: {
        type: 'governance.status.computed' as any,
        data: {
          policyCount: policies.length,
          agentCount: agents.length,
          passCount: summary.pass,
          warnCount: summary.warn,
          failCount: summary.fail,
          unavailableCount: summary.unavailable,
          durationMs,
          cacheHit: false,
        },
      },
    });

    return result;
  }

  private async fetchWithTimeout(
    ch: any,
    tenantId: string,
    projectId: string,
    pipelineType: string,
    period: string,
  ): Promise<Record<string, unknown>> {
    return Promise.race([
      executePipelineSummary(ch, tenantId, projectId, pipelineType, period),
      new Promise<Record<string, unknown>>((_, reject) =>
        setTimeout(() => reject(new Error(`ClickHouse timeout: ${pipelineType}`)), 5000),
      ),
    ]);
  }

  static evaluateRule(metricValue: number, operator: string, threshold: number): 'PASS' | 'FAIL' {
    switch (operator) {
      case 'gt':
        return metricValue > threshold ? 'PASS' : 'FAIL';
      case 'gte':
        return metricValue >= threshold ? 'PASS' : 'FAIL';
      case 'lt':
        return metricValue < threshold ? 'PASS' : 'FAIL';
      case 'lte':
        return metricValue <= threshold ? 'PASS' : 'FAIL';
      case 'eq':
        return metricValue === threshold ? 'PASS' : 'FAIL';
      default:
        return 'FAIL';
    }
  }

  static computeAgentStatus(
    ruleResults: Array<{ status: string; severity: string }>,
  ): 'PASS' | 'WARN' | 'FAIL' | 'NOT_EVALUATED' {
    if (ruleResults.length === 0) return 'NOT_EVALUATED';
    if (ruleResults.every((r) => r.status === 'NOT_EVALUATED')) return 'NOT_EVALUATED';

    // FAIL with critical → FAIL; FAIL with warning/info → WARN; all PASS → PASS
    let hasWarn = false;
    for (const r of ruleResults) {
      if (r.status === 'FAIL') {
        if (r.severity === 'critical') return 'FAIL';
        hasWarn = true;
      }
    }
    return hasWarn ? 'WARN' : 'PASS';
  }
}
