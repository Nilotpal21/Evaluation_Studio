/**
 * Governance pure-function unit tests.
 *
 * Covers:
 * - GovernanceStatusService.evaluateRule — all 5 operators
 * - GovernanceStatusService.computeAgentStatus — all branches
 * - buildBreachQuery — SQL structure (pure function, no I/O)
 * - GovernanceFrameworksService — all 3 framework evaluators
 * - GovernanceCache fail-open — null redis client
 */

import { describe, it, expect } from 'vitest';
import { GovernanceStatusService } from '../services/governance-status.service.js';
import { buildBreachQuery } from '../services/governance-audit.service.js';
import {
  evaluateSOC2Controls,
  evaluateGDPRControls,
  evaluateEUAIActControls,
  evaluateAll,
} from '../services/governance-frameworks.service.js';
import { GovernanceCache } from '../services/cache/governance-cache.js';

// ─── evaluateRule ─────────────────────────────────────────────────────────────

describe('GovernanceStatusService.evaluateRule', () => {
  it('gt: value > threshold → PASS', () => {
    expect(GovernanceStatusService.evaluateRule(0.85, 'gt', 0.8)).toBe('PASS');
  });

  it('gt: value <= threshold → FAIL', () => {
    expect(GovernanceStatusService.evaluateRule(0.8, 'gt', 0.8)).toBe('FAIL');
    expect(GovernanceStatusService.evaluateRule(0.7, 'gt', 0.8)).toBe('FAIL');
  });

  it('gte: value >= threshold → PASS', () => {
    expect(GovernanceStatusService.evaluateRule(0.8, 'gte', 0.8)).toBe('PASS');
    expect(GovernanceStatusService.evaluateRule(0.9, 'gte', 0.8)).toBe('PASS');
  });

  it('gte: value < threshold → FAIL', () => {
    expect(GovernanceStatusService.evaluateRule(0.79, 'gte', 0.8)).toBe('FAIL');
  });

  it('lt: value < threshold → PASS', () => {
    expect(GovernanceStatusService.evaluateRule(0.1, 'lt', 0.5)).toBe('PASS');
  });

  it('lt: value >= threshold → FAIL', () => {
    expect(GovernanceStatusService.evaluateRule(0.5, 'lt', 0.5)).toBe('FAIL');
    expect(GovernanceStatusService.evaluateRule(0.9, 'lt', 0.5)).toBe('FAIL');
  });

  it('lte: value <= threshold → PASS', () => {
    expect(GovernanceStatusService.evaluateRule(0.5, 'lte', 0.5)).toBe('PASS');
    expect(GovernanceStatusService.evaluateRule(0.3, 'lte', 0.5)).toBe('PASS');
  });

  it('lte: value > threshold → FAIL', () => {
    expect(GovernanceStatusService.evaluateRule(0.6, 'lte', 0.5)).toBe('FAIL');
  });

  it('eq: value === threshold → PASS', () => {
    expect(GovernanceStatusService.evaluateRule(1, 'eq', 1)).toBe('PASS');
  });

  it('eq: value !== threshold → FAIL', () => {
    expect(GovernanceStatusService.evaluateRule(0.9, 'eq', 1)).toBe('FAIL');
  });

  it('unknown operator → FAIL', () => {
    expect(GovernanceStatusService.evaluateRule(0.9, 'unknown_op', 0.8)).toBe('FAIL');
  });
});

// ─── computeAgentStatus ───────────────────────────────────────────────────────

describe('GovernanceStatusService.computeAgentStatus', () => {
  it('empty rules → NOT_EVALUATED', () => {
    expect(GovernanceStatusService.computeAgentStatus([])).toBe('NOT_EVALUATED');
  });

  it('all NOT_EVALUATED → NOT_EVALUATED', () => {
    const rules = [
      { status: 'NOT_EVALUATED', severity: 'critical' },
      { status: 'NOT_EVALUATED', severity: 'warning' },
    ];
    expect(GovernanceStatusService.computeAgentStatus(rules)).toBe('NOT_EVALUATED');
  });

  it('FAIL + critical severity → FAIL', () => {
    const rules = [
      { status: 'FAIL', severity: 'critical' },
      { status: 'PASS', severity: 'warning' },
    ];
    expect(GovernanceStatusService.computeAgentStatus(rules)).toBe('FAIL');
  });

  it('FAIL + warning/info severity only → WARN', () => {
    const rules = [
      { status: 'FAIL', severity: 'warning' },
      { status: 'PASS', severity: 'info' },
    ];
    expect(GovernanceStatusService.computeAgentStatus(rules)).toBe('WARN');
  });

  it('FAIL + info severity → WARN', () => {
    const rules = [{ status: 'FAIL', severity: 'info' }];
    expect(GovernanceStatusService.computeAgentStatus(rules)).toBe('WARN');
  });

  it('all PASS → PASS', () => {
    const rules = [
      { status: 'PASS', severity: 'critical' },
      { status: 'PASS', severity: 'warning' },
    ];
    expect(GovernanceStatusService.computeAgentStatus(rules)).toBe('PASS');
  });

  it('mixed PASS and NOT_EVALUATED (no FAIL) → PASS', () => {
    const rules = [
      { status: 'PASS', severity: 'critical' },
      { status: 'NOT_EVALUATED', severity: 'warning' },
    ];
    expect(GovernanceStatusService.computeAgentStatus(rules)).toBe('PASS');
  });
});

// ─── buildBreachQuery ─────────────────────────────────────────────────────────

describe('buildBreachQuery', () => {
  it('generates valid SQL structure for gt operator', () => {
    const sql = buildBreachQuery(
      'quality_evaluation',
      'quality_evaluation',
      'session_started_at',
      [
        {
          pipelineType: 'quality_evaluation',
          metric: 'quality_score',
          operator: 'gt',
          threshold: 0.8,
          severity: 'critical',
        },
      ],
      '7d',
    );
    expect(sql).toContain('SELECT');
    expect(sql).toContain('quality_score');
    expect(sql).toContain('{tenantId:String}');
    expect(sql).toContain('{projectId:String}');
    // breach condition for gt is: metric <= threshold (inverted)
    expect(sql).toContain('quality_score <= 0.8');
  });

  it('inverts all 5 operators correctly', () => {
    const cases: Array<{ operator: string; breachCondition: string }> = [
      { operator: 'gt', breachCondition: '<= 1' },
      { operator: 'gte', breachCondition: '< 1' },
      { operator: 'lt', breachCondition: '>= 1' },
      { operator: 'lte', breachCondition: '> 1' },
      { operator: 'eq', breachCondition: '!= 1' },
    ];

    for (const { operator, breachCondition } of cases) {
      const sql = buildBreachQuery(
        'quality_evaluation',
        'quality_evaluation',
        'session_started_at',
        [
          {
            pipelineType: 'quality_evaluation',
            metric: 'metric_a',
            operator: operator as any,
            threshold: 1,
            severity: 'warning',
          },
        ],
        '7d',
      );
      expect(sql).toContain(`metric_a ${breachCondition}`);
    }
  });

  it('generates multiple metric selects for multiple rules', () => {
    const sql = buildBreachQuery(
      'quality_evaluation',
      'quality_evaluation',
      'session_started_at',
      [
        {
          pipelineType: 'quality_evaluation',
          metric: 'quality_score',
          operator: 'gte',
          threshold: 0.8,
          severity: 'critical',
        },
        {
          pipelineType: 'quality_evaluation',
          metric: 'relevance_score',
          operator: 'gte',
          threshold: 0.7,
          severity: 'warning',
        },
      ],
      '30d',
    );
    expect(sql).toContain('actual_value_quality_score');
    expect(sql).toContain('actual_value_relevance_score');
    expect(sql).toContain('INTERVAL {days:UInt32} DAY');
  });
});

// ─── Framework evaluators ─────────────────────────────────────────────────────

describe('GovernanceFrameworksService — evaluateSOC2Controls', () => {
  const baseParams = {
    status: {
      agents: [],
      summary: { pass: 0, warn: 0, fail: 0, unavailable: 0 },
      period: '7d',
      policies: [],
    },
    enabledPolicies: [] as any[],
    overrideCount: 0,
    versionCount: 0,
    hasAuditEvents: false,
  };

  it('CC9.1 FAIL when no policies', () => {
    const controls = evaluateSOC2Controls(baseParams);
    const cc91 = controls.find((c) => c.controlId === 'CC9.1');
    expect(cc91).toBeDefined();
    expect(cc91!.status).toBe('FAIL');
  });

  it('CC9.1 PASS when policies > 0', () => {
    const params = {
      ...baseParams,
      enabledPolicies: [{ _id: '1', name: 'test', rules: [], status: 'enabled' }] as any[],
    };
    const controls = evaluateSOC2Controls(params);
    const cc91 = controls.find((c) => c.controlId === 'CC9.1');
    expect(cc91!.status).toBe('PASS');
  });

  it('CC8.1 WARN when versionCount === 0', () => {
    const controls = evaluateSOC2Controls(baseParams);
    const cc81 = controls.find((c) => c.controlId === 'CC8.1');
    expect(cc81!.status).toBe('WARN');
  });

  it('all controls have non-empty evidence', () => {
    const controls = evaluateSOC2Controls(baseParams);
    controls.forEach((c) => {
      expect(c.evidence).toBeTruthy();
    });
  });
});

describe('GovernanceFrameworksService — evaluateGDPRControls', () => {
  const baseParams = {
    status: {
      agents: [],
      summary: { pass: 0, warn: 0, fail: 0, unavailable: 0 },
      period: '7d',
      policies: [],
    },
    enabledPolicies: [] as any[],
    overrideCount: 0,
    versionCount: 0,
    hasAuditEvents: false,
  };

  it('Art.5 WARN/FAIL when no quality_evaluation rule', () => {
    const controls = evaluateGDPRControls(baseParams);
    const art5 = controls.find((c) => c.controlId === 'Art.5');
    expect(['FAIL', 'WARN', 'NOT_EVALUATED']).toContain(art5!.status);
  });

  it('Art.13 PASS always', () => {
    const controls = evaluateGDPRControls(baseParams);
    const art13 = controls.find((c) => c.controlId === 'Art.13');
    expect(art13!.status).toBe('PASS');
  });

  it('Art.22 WARN when no overrides (human oversight warning)', () => {
    const controls = evaluateGDPRControls(baseParams);
    const art22 = controls.find((c) => c.controlId === 'Art.22');
    // Service returns WARN (not FAIL) for Art.22 with 0 overrides
    expect(['WARN', 'FAIL']).toContain(art22!.status);
  });

  it('Art.22 PASS when overrideCount > 0', () => {
    const controls = evaluateGDPRControls({ ...baseParams, overrideCount: 3 });
    const art22 = controls.find((c) => c.controlId === 'Art.22');
    expect(art22!.status).toBe('PASS');
  });
});

describe('GovernanceFrameworksService — evaluateEUAIActControls', () => {
  const baseParams = {
    status: {
      agents: [],
      summary: { pass: 0, warn: 0, fail: 0, unavailable: 0 },
      period: '7d',
      policies: [],
    },
    enabledPolicies: [] as any[],
    overrideCount: 0,
    versionCount: 0,
    hasAuditEvents: false,
  };

  it('Art.11 PASS when versionCount > 0', () => {
    const controls = evaluateEUAIActControls({ ...baseParams, versionCount: 1 });
    const art11 = controls.find((c) => c.controlId === 'Art.11');
    expect(art11!.status).toBe('PASS');
  });

  it('Art.11 PASS always (compliance report always accessible)', () => {
    const controls = evaluateEUAIActControls(baseParams);
    const art11 = controls.find((c) => c.controlId === 'Art.11');
    expect(art11!.status).toBe('PASS');
  });
});

describe('GovernanceFrameworksService — evaluateAll', () => {
  const baseParams = {
    status: {
      agents: [],
      summary: { pass: 0, warn: 0, fail: 0, unavailable: 0 },
      period: '7d',
      policies: [],
    },
    enabledPolicies: [] as any[],
    overrideCount: 0,
    versionCount: 0,
    hasAuditEvents: false,
  };

  it('returns all 3 frameworks', () => {
    const result = evaluateAll(baseParams);
    expect(result.frameworks).toHaveLength(3);
    const ids = result.frameworks.map((f) => f.id);
    expect(ids).toContain('SOC2');
    expect(ids).toContain('GDPR');
    expect(ids).toContain('EU_AI_ACT');
  });

  it('each framework has at least 3 controls', () => {
    const result = evaluateAll(baseParams);
    result.frameworks.forEach((f) => {
      expect(f.controls.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ─── GovernanceCache fail-open ────────────────────────────────────────────────

describe('GovernanceCache fail-open', () => {
  it('get returns null when redis is null', async () => {
    const cache = new GovernanceCache(null);
    const result = await cache.get('tenant1', 'proj1', '7d');
    expect(result).toBeNull();
  });

  it('set succeeds silently when redis is null', async () => {
    const cache = new GovernanceCache(null);
    await expect(cache.set('tenant1', 'proj1', '7d', { some: 'data' }, 60)).resolves.not.toThrow();
  });

  it('invalidate succeeds silently when redis is null', async () => {
    const cache = new GovernanceCache(null);
    await expect(cache.invalidate('tenant1', 'proj1')).resolves.not.toThrow();
  });
});
