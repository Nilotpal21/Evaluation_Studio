/**
 * useAgentPerformance Hook Tests
 *
 * Tests the pure data-transformation and classification logic used by the
 * Agent Performance dashboard. Functions are duplicated from the hook source
 * for isolated unit testing (same pattern as useCrawlPreferences.test.ts).
 */

import { describe, test, expect } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { classifyAgentPerformanceMetric, useAgentPerformance } from '../useAgentPerformance';
import { useNavigationStore } from '../../store/navigation-store';

// ── Types (mirrored from hook) ────────────────────────────────────────────

type AgentStatus = 'healthy' | 'warning' | 'critical';

type PipelineType =
  | 'quality_evaluation'
  | 'hallucination_detection'
  | 'knowledge_gap'
  | 'guardrail_analysis'
  | 'context_preservation';

const METRIC_DIRECTIONS: Record<PipelineType, 'higher-better' | 'lower-better'> = {
  quality_evaluation: 'higher-better',
  hallucination_detection: 'lower-better',
  knowledge_gap: 'lower-better',
  guardrail_analysis: 'higher-better',
  context_preservation: 'higher-better',
};

const DEFAULT_THRESHOLDS: Record<PipelineType, number> = {
  quality_evaluation: 2.5,
  hallucination_detection: 0.5,
  knowledge_gap: 0.5,
  guardrail_analysis: 2.5,
  context_preservation: 2.5,
};

const WARNING_BUFFER = 1.2;

// ── Pure functions (duplicated from hook for isolation) ────────────────────

function extractObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;

  const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  const innerObj = inner as Record<string, unknown>;

  const payload =
    'success' in innerObj && innerObj.data && typeof innerObj.data === 'object'
      ? innerObj.data
      : innerObj;
  const payloadObj = payload as Record<string, unknown>;

  if ('meta' in payloadObj && Array.isArray(payloadObj.data)) {
    const rows = payloadObj.data as Record<string, unknown>[];
    return rows[0] ?? {};
  }

  return payloadObj;
}

function extractArray(raw: unknown): Record<string, unknown>[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;

  const inner = obj.data && typeof obj.data === 'object' ? obj.data : obj;
  const innerObj = inner as Record<string, unknown>;

  const payload = 'success' in innerObj ? innerObj.data : innerObj;

  if (Array.isArray(payload)) return payload as Record<string, unknown>[];

  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.data)) return p.data as Record<string, unknown>[];
  }

  return [];
}

function classifyMetric(
  value: number | null,
  pipelineType: PipelineType,
  threshold: number,
): AgentStatus {
  if (value === null || isNaN(value)) return 'healthy';
  const direction = METRIC_DIRECTIONS[pipelineType];
  const warningThreshold =
    direction === 'higher-better' ? threshold * WARNING_BUFFER : threshold / WARNING_BUFFER;

  if (direction === 'higher-better') {
    if (value <= threshold) return 'critical';
    if (value <= warningThreshold) return 'warning';
    return 'healthy';
  } else {
    if (value >= threshold) return 'critical';
    if (value >= warningThreshold) return 'warning';
    return 'healthy';
  }
}

function worstStatus(statuses: AgentStatus[]): AgentStatus {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'healthy';
}

function getThreshold(configData: unknown, pipelineType: PipelineType): number {
  const obj = extractObject(configData);
  const config = obj.config as Record<string, unknown> | undefined;
  const threshold = config?.flagThreshold;
  return typeof threshold === 'number' ? threshold : DEFAULT_THRESHOLDS[pipelineType];
}

function pipelineUrl(
  projectId: string,
  pipelineType: string,
  endpoint: string,
  extra?: Record<string, string>,
) {
  const params = new URLSearchParams({ projectId, pipelineType, endpoint, ...extra });
  return `/api/runtime/pipeline-analytics?${params.toString()}`;
}

function configUrl(projectId: string, pipelineType: string) {
  return `/api/projects/${projectId}/pipeline-config/${pipelineType}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('extractObject', () => {
  test('returns empty object for null/undefined', () => {
    expect(extractObject(null)).toEqual({});
    expect(extractObject(undefined)).toEqual({});
  });

  test('returns empty object for non-object primitives', () => {
    expect(extractObject(42)).toEqual({});
    expect(extractObject('str')).toEqual({});
  });

  test('unwraps { data: { ...payload } }', () => {
    const raw = { data: { avg_overall_score: 3.2, total_conversations: 100 } };
    const result = extractObject(raw);
    expect(result).toEqual({ avg_overall_score: 3.2, total_conversations: 100 });
  });

  test('unwraps { success: true, data: { ...payload } }', () => {
    const raw = { success: true, data: { avg_overall_score: 3.2 } };
    const result = extractObject(raw);
    expect(result).toEqual({ avg_overall_score: 3.2 });
  });

  test('unwraps nested { data: { success: true, data: { ...payload } } }', () => {
    const raw = { data: { success: true, data: { flagged_rate_pct: 5.2 } } };
    const result = extractObject(raw);
    expect(result).toEqual({ flagged_rate_pct: 5.2 });
  });

  test('extracts first row from SWR-wrapped ClickHouse format { data: { meta, data: [...] } }', () => {
    // SWR wraps the HTTP response in `data`, so the ClickHouse format
    // arrives as { data: { meta: [...], data: [...] } }. The function
    // unwraps through data, finds meta + data array, and returns rows[0].
    const raw = {
      data: {
        meta: [{ name: 'avg_score', type: 'Float64' }],
        data: [{ avg_score: 3.8 }, { avg_score: 2.1 }],
      },
    };
    const result = extractObject(raw);
    expect(result).toEqual({ avg_score: 3.8 });
  });

  test('returns empty object for SWR-wrapped ClickHouse format with empty data array', () => {
    const raw = { data: { meta: [], data: [] } };
    expect(extractObject(raw)).toEqual({});
  });

  test('returns flat object as-is when no wrapping', () => {
    const raw = { avg_overall_score: 4.1 };
    expect(extractObject(raw)).toEqual({ avg_overall_score: 4.1 });
  });
});

describe('extractArray', () => {
  test('returns empty array for null/undefined', () => {
    expect(extractArray(null)).toEqual([]);
    expect(extractArray(undefined)).toEqual([]);
  });

  test('returns empty array for non-object primitives', () => {
    expect(extractArray(42)).toEqual([]);
    expect(extractArray('str')).toEqual([]);
  });

  test('unwraps { data: [...] }', () => {
    const rows = [{ agent_name: 'A' }, { agent_name: 'B' }];
    expect(extractArray({ data: rows })).toEqual(rows);
  });

  test('unwraps { success: true, data: [...] }', () => {
    const rows = [{ agent_name: 'A' }];
    expect(extractArray({ success: true, data: rows })).toEqual(rows);
  });

  test('unwraps nested { data: { success: true, data: [...] } }', () => {
    const rows = [{ agent_name: 'X', avg_overall_score: 3.5 }];
    const raw = { data: { success: true, data: rows } };
    expect(extractArray(raw)).toEqual(rows);
  });

  test('unwraps double-nested data when inner has data array', () => {
    const rows = [{ agent_name: 'A' }];
    const raw = { data: { data: rows } };
    expect(extractArray(raw)).toEqual(rows);
  });

  test('returns empty array when no array found', () => {
    expect(extractArray({ data: { nested: 'object' } })).toEqual([]);
  });

  test('handles SWR response wrapping { data: { success, data: [...] } }', () => {
    const rows = [
      { agent_name: 'Agent1', conversation_count: 50, avg_overall_score: 4.0 },
      { agent_name: 'Agent2', conversation_count: 30, avg_overall_score: 2.1 },
    ];
    const swrPayload = { data: { success: true, data: rows } };
    expect(extractArray(swrPayload)).toEqual(rows);
  });
});

describe('classifyMetric', () => {
  describe('higher-better metrics (quality_evaluation)', () => {
    const threshold = DEFAULT_THRESHOLDS.quality_evaluation; // 2.5

    test('returns critical when value is at or below threshold', () => {
      expect(classifyMetric(2.5, 'quality_evaluation', threshold)).toBe('critical');
      expect(classifyMetric(1.0, 'quality_evaluation', threshold)).toBe('critical');
      expect(classifyMetric(0, 'quality_evaluation', threshold)).toBe('critical');
    });

    test('returns warning in the buffer zone', () => {
      // warningThreshold = 2.5 * 1.2 = 3.0
      expect(classifyMetric(2.8, 'quality_evaluation', threshold)).toBe('warning');
      expect(classifyMetric(3.0, 'quality_evaluation', threshold)).toBe('warning');
    });

    test('returns healthy above warning threshold', () => {
      expect(classifyMetric(3.1, 'quality_evaluation', threshold)).toBe('healthy');
      expect(classifyMetric(5.0, 'quality_evaluation', threshold)).toBe('healthy');
    });

    test('returns healthy for null value', () => {
      expect(classifyMetric(null, 'quality_evaluation', threshold)).toBe('healthy');
    });

    test('returns healthy for NaN', () => {
      expect(classifyMetric(NaN, 'quality_evaluation', threshold)).toBe('healthy');
    });
  });

  describe('lower-better metrics (hallucination_detection)', () => {
    const threshold = DEFAULT_THRESHOLDS.hallucination_detection; // 0.5

    test('returns critical when value is at or above threshold', () => {
      expect(classifyMetric(0.5, 'hallucination_detection', threshold)).toBe('critical');
      expect(classifyMetric(1.0, 'hallucination_detection', threshold)).toBe('critical');
    });

    test('returns warning in the buffer zone', () => {
      // warningThreshold = 0.5 / 1.2 ≈ 0.417
      expect(classifyMetric(0.45, 'hallucination_detection', threshold)).toBe('warning');
    });

    test('returns healthy below warning threshold', () => {
      expect(classifyMetric(0.3, 'hallucination_detection', threshold)).toBe('healthy');
      expect(classifyMetric(0, 'hallucination_detection', threshold)).toBe('healthy');
    });
  });

  describe('with custom thresholds', () => {
    test('uses provided threshold instead of default', () => {
      // Custom threshold: 4.0 for quality
      // warningThreshold = 4.0 * 1.2 = 4.8
      expect(classifyMetric(3.9, 'quality_evaluation', 4.0)).toBe('critical');
      expect(classifyMetric(4.5, 'quality_evaluation', 4.0)).toBe('warning');
      expect(classifyMetric(5.0, 'quality_evaluation', 4.0)).toBe('healthy');
    });
  });

  describe('all pipeline types direction', () => {
    test('higher-better: context_preservation', () => {
      expect(classifyMetric(1.0, 'context_preservation', 2.5)).toBe('critical');
      expect(classifyMetric(4.0, 'context_preservation', 2.5)).toBe('healthy');
    });

    test('higher-better: guardrail_analysis', () => {
      expect(classifyMetric(1.0, 'guardrail_analysis', 2.5)).toBe('critical');
      expect(classifyMetric(4.0, 'guardrail_analysis', 2.5)).toBe('healthy');
    });

    test('lower-better: knowledge_gap', () => {
      expect(classifyMetric(1.0, 'knowledge_gap', 0.5)).toBe('critical');
      expect(classifyMetric(0.1, 'knowledge_gap', 0.5)).toBe('healthy');
    });
  });
});

describe('worstStatus', () => {
  test('returns critical if any status is critical', () => {
    expect(worstStatus(['healthy', 'critical', 'warning'])).toBe('critical');
    expect(worstStatus(['critical'])).toBe('critical');
  });

  test('returns warning if worst is warning', () => {
    expect(worstStatus(['healthy', 'warning', 'healthy'])).toBe('warning');
    expect(worstStatus(['warning', 'warning'])).toBe('warning');
  });

  test('returns healthy when all healthy', () => {
    expect(worstStatus(['healthy', 'healthy', 'healthy'])).toBe('healthy');
  });

  test('returns healthy for empty array', () => {
    expect(worstStatus([])).toBe('healthy');
  });
});

describe('getThreshold', () => {
  test('extracts threshold from config object', () => {
    const config = { config: { flagThreshold: 3.0 } };
    expect(getThreshold(config, 'quality_evaluation')).toBe(3.0);
  });

  test('extracts threshold from wrapped response', () => {
    const config = { data: { config: { flagThreshold: 0.8 } } };
    expect(getThreshold(config, 'hallucination_detection')).toBe(0.8);
  });

  test('returns default threshold when config is null', () => {
    expect(getThreshold(null, 'quality_evaluation')).toBe(2.5);
    expect(getThreshold(null, 'hallucination_detection')).toBe(0.5);
  });

  test('returns default threshold when flagThreshold is missing', () => {
    expect(getThreshold({ config: {} }, 'knowledge_gap')).toBe(0.5);
  });

  test('returns default threshold when flagThreshold is not a number', () => {
    expect(getThreshold({ config: { flagThreshold: 'high' } }, 'quality_evaluation')).toBe(2.5);
  });

  test('returns correct default for each pipeline type', () => {
    expect(getThreshold(null, 'quality_evaluation')).toBe(2.5);
    expect(getThreshold(null, 'hallucination_detection')).toBe(0.5);
    expect(getThreshold(null, 'knowledge_gap')).toBe(0.5);
    expect(getThreshold(null, 'guardrail_analysis')).toBe(2.5);
    expect(getThreshold(null, 'context_preservation')).toBe(2.5);
  });
});

describe('pipelineUrl', () => {
  test('builds URL with required params', () => {
    const url = pipelineUrl('proj-1', 'quality_evaluation', 'summary');
    expect(url).toBe(
      '/api/runtime/pipeline-analytics?projectId=proj-1&pipelineType=quality_evaluation&endpoint=summary',
    );
  });

  test('includes extra params', () => {
    const url = pipelineUrl('proj-1', 'quality_evaluation', 'breakdown', {
      period: '30d',
      dimension: 'agent_name',
    });
    expect(url).toContain('period=30d');
    expect(url).toContain('dimension=agent_name');
  });

  test('encodes special characters in projectId', () => {
    const url = pipelineUrl('proj with spaces', 'quality_evaluation', 'summary');
    expect(url).toContain('projectId=proj+with+spaces');
  });
});

describe('configUrl', () => {
  test('builds config URL', () => {
    expect(configUrl('proj-1', 'quality_evaluation')).toBe(
      '/api/projects/proj-1/pipeline-config/quality_evaluation',
    );
  });
});

describe('useAgentPerformance API wiring', () => {
  test('fetches every current-window Agent Performance API and merges UI rows', async () => {
    useNavigationStore.setState({
      area: 'project',
      projectId: 'proj-1',
      page: 'agent-performance',
      subPage: null,
      tab: null,
      subSection: null,
    });

    const fetched: string[] = [];
    const responses = new Map<string, unknown>([
      [
        pipelineUrl('proj-1', 'quality_evaluation', 'summary', { period: '7d' }),
        { success: true, data: { total_conversations: 85, avg_overall_score: 2.6 } },
      ],
      [
        pipelineUrl('proj-1', 'hallucination_detection', 'summary', { period: '7d' }),
        { success: true, data: { total_evaluations: 85, flagged_rate_pct: 15.3 } },
      ],
      [
        pipelineUrl('proj-1', 'knowledge_gap', 'summary', { period: '7d' }),
        { success: true, data: { total_evaluations: 85, gap_count: 76, flagged_count: 90 } },
      ],
      [
        pipelineUrl('proj-1', 'guardrail_analysis', 'summary', { period: '7d' }),
        { success: true, data: { total_evaluations: 85, flagged_count: 0, flagged_rate_pct: 0 } },
      ],
      [
        pipelineUrl('proj-1', 'context_preservation', 'summary', { period: '7d' }),
        { success: true, data: {} },
      ],
      [
        pipelineUrl('proj-1', 'quality_evaluation', 'breakdown', {
          period: '7d',
          dimension: 'agent_name',
        }),
        {
          success: true,
          data: [
            { agent_name: 'Account_Info_Agent', conversation_count: 56, avg_overall_score: 2.2 },
            { agent_name: '', conversation_count: 27, avg_overall_score: 3.4 },
          ],
        },
      ],
      [
        pipelineUrl('proj-1', 'hallucination_detection', 'breakdown', {
          period: '7d',
          dimension: 'agent_name',
        }),
        {
          success: true,
          data: [
            { agent_name: 'Account_Info_Agent', conversation_count: 55, flagged_count: 12 },
            { agent_name: '', conversation_count: 27, flagged_count: 0 },
          ],
        },
      ],
      [
        pipelineUrl('proj-1', 'knowledge_gap', 'breakdown', {
          period: '7d',
          dimension: 'agent_name',
        }),
        {
          success: true,
          data: [
            {
              agent_name: 'Account_Info_Agent',
              conversation_count: 56,
              gap_count: 50,
              flagged_count: 99,
            },
            { agent_name: '', conversation_count: 27, gap_count: 23, flagged_count: 42 },
          ],
        },
      ],
      [
        pipelineUrl('proj-1', 'guardrail_analysis', 'breakdown', {
          period: '7d',
          dimension: 'agent_name',
        }),
        {
          success: true,
          data: [
            { agent_name: 'Account_Info_Agent', conversation_count: 56, flagged_count: 6 },
            { agent_name: '', conversation_count: 27, flagged_count: 7 },
          ],
        },
      ],
      [
        pipelineUrl('proj-1', 'context_preservation', 'breakdown', {
          period: '7d',
          dimension: 'agent_name',
        }),
        { success: true, data: [] },
      ],
      [
        pipelineUrl('proj-1', 'quality_evaluation', 'timeseries', { period: '7d' }),
        {
          success: true,
          data: [{ day: '2026-05-09', avg_overall_score: 2.6, flagged_count: 36 }],
        },
      ],
    ]);

    for (const pipelineType of [
      'quality_evaluation',
      'hallucination_detection',
      'knowledge_gap',
      'guardrail_analysis',
      'context_preservation',
    ]) {
      responses.set(configUrl('proj-1', pipelineType), {
        success: true,
        data: { config: { flagThreshold: pipelineType === 'context_preservation' ? 0.5 : 2.5 } },
      });
    }

    const fetcher = async (url: string) => {
      fetched.push(url);
      return responses.get(url) ?? { success: true, data: {} };
    };

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        { value: { provider: () => new Map(), fetcher, dedupingInterval: 0 } },
        children,
      );

    const { result } = renderHook(() => useAgentPerformance('7d', false), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(new Set(fetched)).toEqual(new Set(responses.keys()));
    expect(result.current.healthSummary).toEqual({
      healthy: 0,
      warning: 0,
      critical: 1,
      totalAgents: 1,
      totalConversations: 85,
      conversationsDelta: null,
    });
    expect(result.current.kpis.safety.value).toBe(100);
    expect(result.current.kpis.context.value).toBeNull();
    expect(result.current.kpis.knowledgeGaps.value).toBe(76);
    expect(result.current.dailyTrend).toEqual([
      { day: '2026-05-09', avgQuality: 2.6, flaggedCount: 36 },
    ]);

    const accountAgent = result.current.agents.find(
      (agent) => agent.agentName === 'Account Info Agent',
    );
    expect(accountAgent).toMatchObject({
      conversations: 56,
      knowledgeGaps: 50,
      safetyScore: expect.closeTo(89.29, 2),
      hallucinationRate: expect.closeTo(21.82, 2),
      status: 'critical',
    });

    // Blank agent_name rows are filtered at the breakdown route level (PR #1010)
    // and therefore no 'Unknown' agent row is produced — the blank row is dropped
    // before the hook merges breakdown data.
    const unknownAgent = result.current.agents.find((agent) => agent.agentName === 'Unknown');
    expect(unknownAgent).toBeUndefined();
  });
});

describe('classifyAgentPerformanceMetric (display thresholds)', () => {
  describe('quality metric', () => {
    test('healthy above the warning buffer', () => {
      expect(classifyAgentPerformanceMetric(3.1, 'quality')).toBe('healthy');
      expect(classifyAgentPerformanceMetric(5.0, 'quality')).toBe('healthy');
    });

    test('warning between critical threshold and warning buffer', () => {
      expect(classifyAgentPerformanceMetric(2.6, 'quality')).toBe('warning');
      expect(classifyAgentPerformanceMetric(3.0, 'quality')).toBe('warning');
    });

    test('critical at or below the score threshold', () => {
      expect(classifyAgentPerformanceMetric(2.5, 'quality')).toBe('critical');
      expect(classifyAgentPerformanceMetric(0, 'quality')).toBe('critical');
    });
  });

  describe('hallucination metric', () => {
    test('healthy below 5%', () => {
      expect(classifyAgentPerformanceMetric(0, 'hallucinationRate')).toBe('healthy');
      expect(classifyAgentPerformanceMetric(4.9, 'hallucinationRate')).toBe('healthy');
    });

    test('warning from 5% up to less than 10%', () => {
      expect(classifyAgentPerformanceMetric(5, 'hallucinationRate')).toBe('warning');
      expect(classifyAgentPerformanceMetric(9.9, 'hallucinationRate')).toBe('warning');
    });

    test('critical at 10% and above', () => {
      expect(classifyAgentPerformanceMetric(10, 'hallucinationRate')).toBe('critical');
      expect(classifyAgentPerformanceMetric(50, 'hallucinationRate')).toBe('critical');
      expect(classifyAgentPerformanceMetric(0.6, 'hallucinationRate')).toBe('healthy');
    });
  });

  describe('knowledge gaps metric', () => {
    test('healthy at 3 or below', () => {
      expect(classifyAgentPerformanceMetric(0, 'knowledgeGaps')).toBe('healthy');
      expect(classifyAgentPerformanceMetric(3, 'knowledgeGaps')).toBe('healthy');
    });

    test('warning above 3 through 7', () => {
      expect(classifyAgentPerformanceMetric(4, 'knowledgeGaps')).toBe('warning');
      expect(classifyAgentPerformanceMetric(7, 'knowledgeGaps')).toBe('warning');
    });

    test('critical above 7', () => {
      expect(classifyAgentPerformanceMetric(8, 'knowledgeGaps')).toBe('critical');
    });
  });

  describe('safety metric', () => {
    test('healthy at 90% or above', () => {
      expect(classifyAgentPerformanceMetric(90, 'safetyScore')).toBe('healthy');
      expect(classifyAgentPerformanceMetric(100, 'safetyScore')).toBe('healthy');
    });

    test('warning between 75% and 90%', () => {
      expect(classifyAgentPerformanceMetric(75, 'safetyScore')).toBe('warning');
      expect(classifyAgentPerformanceMetric(89, 'safetyScore')).toBe('warning');
    });

    test('critical below 75%', () => {
      expect(classifyAgentPerformanceMetric(74, 'safetyScore')).toBe('critical');
      expect(classifyAgentPerformanceMetric(0, 'safetyScore')).toBe('critical');
    });
  });

  describe('context metric', () => {
    test('healthy above the warning buffer', () => {
      expect(classifyAgentPerformanceMetric(3.1, 'contextScore')).toBe('healthy');
    });

    test('warning between threshold and warning buffer', () => {
      expect(classifyAgentPerformanceMetric(3.0, 'contextScore')).toBe('warning');
    });

    test('critical at or below the threshold', () => {
      expect(classifyAgentPerformanceMetric(2.5, 'contextScore')).toBe('critical');
      expect(classifyAgentPerformanceMetric(2.0, 'contextScore')).toBe('critical');
    });
  });

  describe('missing values', () => {
    test('returns healthy for unavailable metric values', () => {
      expect(classifyAgentPerformanceMetric(null, 'contextScore')).toBe('healthy');
      expect(classifyAgentPerformanceMetric(NaN, 'safetyScore')).toBe('healthy');
    });
  });
});

describe('agent row merging logic', () => {
  // Simulates the merging logic from the hook that combines breakdown data
  // from 5 pipeline types into a single AgentRow per agent.

  interface AgentRow {
    agentName: string;
    status: AgentStatus;
    conversations: number;
    quality: number | null;
    hallucinationRate: number | null;
    knowledgeGaps: number | null;
    safetyScore: number | null;
    contextScore: number | null;
  }

  function mergeAgentRows(breakdowns: {
    quality: Record<string, unknown>[];
    hallucination: Record<string, unknown>[];
    knowledgeGap: Record<string, unknown>[];
    guardrail: Record<string, unknown>[];
    context: Record<string, unknown>[];
  }): AgentRow[] {
    const agentMap = new Map<string, AgentRow>();

    function ensureAgent(name: string): AgentRow {
      if (!agentMap.has(name)) {
        agentMap.set(name, {
          agentName: name,
          status: 'healthy',
          conversations: 0,
          quality: null,
          hallucinationRate: null,
          knowledgeGaps: null,
          safetyScore: null,
          contextScore: null,
        });
      }
      return agentMap.get(name)!;
    }

    for (const r of breakdowns.quality) {
      const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
      agent.quality = Number(r.avg_overall_score ?? 0);
      agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
    }
    for (const r of breakdowns.hallucination) {
      const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
      const count = Number(r.conversation_count ?? 0);
      const flagged = Number(r.flagged_count ?? 0);
      agent.hallucinationRate = count > 0 ? (flagged / count) * 100 : 0;
      agent.conversations = Math.max(agent.conversations, count);
    }
    for (const r of breakdowns.knowledgeGap) {
      const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
      agent.knowledgeGaps = Number(r.gap_count ?? r.flagged_count ?? 0);
      agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
    }
    for (const r of breakdowns.guardrail) {
      const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
      const count = Number(r.conversation_count ?? 0);
      const flagged = Number(r.flagged_count ?? 0);
      agent.safetyScore = count > 0 ? ((count - flagged) / count) * 100 : null;
      agent.conversations = Math.max(agent.conversations, count);
    }
    for (const r of breakdowns.context) {
      const agent = ensureAgent(String(r.agent_name ?? 'Unknown'));
      agent.contextScore = Math.min(Math.max(Number(r.avg_overall_score ?? 0), 0), 1) * 5;
      agent.conversations = Math.max(agent.conversations, Number(r.conversation_count ?? 0));
    }

    return Array.from(agentMap.values());
  }

  test('merges data from all 5 pipeline types into a single row per agent', () => {
    const agents = mergeAgentRows({
      quality: [{ agent_name: 'Bot1', avg_overall_score: 4.2, conversation_count: 100 }],
      hallucination: [{ agent_name: 'Bot1', conversation_count: 100, flagged_count: 5 }],
      knowledgeGap: [
        { agent_name: 'Bot1', conversation_count: 100, gap_count: 3, flagged_count: 99 },
      ],
      guardrail: [{ agent_name: 'Bot1', conversation_count: 100, flagged_count: 2 }],
      context: [{ agent_name: 'Bot1', avg_overall_score: 0.76, conversation_count: 100 }],
    });

    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual({
      agentName: 'Bot1',
      status: 'healthy',
      conversations: 100,
      quality: 4.2,
      hallucinationRate: 5,
      knowledgeGaps: 3,
      safetyScore: 98,
      contextScore: 3.8, // 0.76 * 5 = 3.8
    });
  });

  test('handles agents appearing in different pipeline subsets', () => {
    const agents = mergeAgentRows({
      quality: [
        { agent_name: 'Bot1', avg_overall_score: 4.0, conversation_count: 50 },
        { agent_name: 'Bot2', avg_overall_score: 2.0, conversation_count: 30 },
      ],
      hallucination: [{ agent_name: 'Bot1', conversation_count: 50, flagged_count: 1 }],
      knowledgeGap: [],
      guardrail: [{ agent_name: 'Bot2', conversation_count: 30, flagged_count: 10 }],
      context: [],
    });

    expect(agents).toHaveLength(2);
    const bot1 = agents.find((a) => a.agentName === 'Bot1')!;
    const bot2 = agents.find((a) => a.agentName === 'Bot2')!;

    expect(bot1.quality).toBe(4.0);
    expect(bot1.hallucinationRate).toBe(2); // 1/50 * 100
    expect(bot1.knowledgeGaps).toBeNull();
    expect(bot1.safetyScore).toBeNull();
    expect(bot1.contextScore).toBeNull();

    expect(bot2.quality).toBe(2.0);
    expect(bot2.hallucinationRate).toBeNull();
    expect(bot2.safetyScore).toBeCloseTo(66.67, 1); // (30-10)/30 * 100
  });

  test('uses max conversation count across pipelines', () => {
    const agents = mergeAgentRows({
      quality: [{ agent_name: 'Bot1', conversation_count: 80 }],
      hallucination: [{ agent_name: 'Bot1', conversation_count: 100 }],
      knowledgeGap: [{ agent_name: 'Bot1', conversation_count: 90 }],
      guardrail: [],
      context: [],
    });

    expect(agents[0].conversations).toBe(100);
  });

  test('defaults agent_name to Unknown when missing', () => {
    const agents = mergeAgentRows({
      quality: [{ avg_overall_score: 3.0 }],
      hallucination: [],
      knowledgeGap: [],
      guardrail: [],
      context: [],
    });

    expect(agents[0].agentName).toBe('Unknown');
  });

  test('hallucination rate is 0 when conversation_count is 0', () => {
    const agents = mergeAgentRows({
      quality: [],
      hallucination: [{ agent_name: 'Bot1', conversation_count: 0, flagged_count: 0 }],
      knowledgeGap: [],
      guardrail: [],
      context: [],
    });

    expect(agents[0].hallucinationRate).toBe(0);
  });

  test('safety score is unavailable when conversation_count is 0', () => {
    const agents = mergeAgentRows({
      quality: [],
      hallucination: [],
      knowledgeGap: [],
      guardrail: [{ agent_name: 'Bot1', conversation_count: 0, flagged_count: 0 }],
      context: [],
    });

    expect(agents[0].safetyScore).toBeNull();
  });

  test('handles empty breakdowns gracefully', () => {
    const agents = mergeAgentRows({
      quality: [],
      hallucination: [],
      knowledgeGap: [],
      guardrail: [],
      context: [],
    });

    expect(agents).toHaveLength(0);
  });

  test('prefers gap_count over flagged_count for knowledge gap display', () => {
    const agents = mergeAgentRows({
      quality: [],
      hallucination: [],
      knowledgeGap: [
        { agent_name: 'Bot1', conversation_count: 10, gap_count: 2, flagged_count: 9 },
      ],
      guardrail: [],
      context: [],
    });

    expect(agents[0].knowledgeGaps).toBe(2);
  });
});

describe('health summary computation', () => {
  function computeHealthSummary(agents: { status: AgentStatus }[]) {
    return {
      healthy: agents.filter((a) => a.status === 'healthy').length,
      warning: agents.filter((a) => a.status === 'warning').length,
      critical: agents.filter((a) => a.status === 'critical').length,
      totalAgents: agents.length,
    };
  }

  test('counts by status correctly', () => {
    const agents = [
      { status: 'healthy' as const },
      { status: 'healthy' as const },
      { status: 'warning' as const },
      { status: 'critical' as const },
    ];
    const summary = computeHealthSummary(agents);
    expect(summary).toEqual({ healthy: 2, warning: 1, critical: 1, totalAgents: 4 });
  });

  test('handles empty agent list', () => {
    const summary = computeHealthSummary([]);
    expect(summary).toEqual({ healthy: 0, warning: 0, critical: 0, totalAgents: 0 });
  });

  test('handles all-healthy', () => {
    const agents = [{ status: 'healthy' as const }, { status: 'healthy' as const }];
    expect(computeHealthSummary(agents).critical).toBe(0);
    expect(computeHealthSummary(agents).warning).toBe(0);
  });
});

describe('delta computation', () => {
  const CONTEXT_SCORE_SCALE = 5;
  function normalizeContextScore(raw: number): number {
    return Math.min(Math.max(raw, 0), 1) * CONTEXT_SCORE_SCALE;
  }

  function computeDelta(
    current: number,
    prevObj: Record<string, unknown> | null,
    key: string,
    compareEnabled: boolean,
    scale = 1,
  ): number | null {
    if (!prevObj || !compareEnabled) return null;
    const raw = Number(prevObj[key] ?? 0);
    const prev = scale !== 1 ? normalizeContextScore(raw) : raw;
    return current - prev;
  }

  test('returns null when comparison is disabled', () => {
    expect(computeDelta(3.5, { avg_overall_score: 3.0 }, 'avg_overall_score', false)).toBeNull();
  });

  test('returns null when prevObj is null', () => {
    expect(computeDelta(3.5, null, 'avg_overall_score', true)).toBeNull();
  });

  test('computes positive delta', () => {
    expect(computeDelta(3.5, { avg_overall_score: 3.0 }, 'avg_overall_score', true)).toBe(0.5);
  });

  test('computes negative delta', () => {
    expect(computeDelta(2.0, { avg_overall_score: 3.0 }, 'avg_overall_score', true)).toBe(-1.0);
  });

  test('treats missing key in prev as 0', () => {
    expect(computeDelta(5.0, {}, 'avg_overall_score', true)).toBe(5.0);
  });

  test('computes zero delta when values match', () => {
    expect(computeDelta(3.0, { avg_overall_score: 3.0 }, 'avg_overall_score', true)).toBe(0);
  });

  test('scales previous value when scale factor is provided (context)', () => {
    // current = 3.5 (already scaled), prev raw = 0.6 → scaled = 3.0
    expect(
      computeDelta(3.5, { avg_score: 0.6 }, 'avg_score', true, CONTEXT_SCORE_SCALE),
    ).toBeCloseTo(0.5);
  });

  test('clamps prev to [0,1] before scaling', () => {
    // prev raw = 1.5 → clamped to 1.0 → scaled = 5.0
    expect(
      computeDelta(5.0, { avg_score: 1.5 }, 'avg_score', true, CONTEXT_SCORE_SCALE),
    ).toBeCloseTo(0);
  });
});

describe('comparison window mapping', () => {
  function getPreviousWindowParams(
    dateRange: '7d' | '30d' | '90d',
    compareEnabled: boolean,
  ): { period: string; offsetDays: string } | null {
    if (!compareEnabled) return null;
    const offsetDays = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
    return { period: dateRange, offsetDays: String(offsetDays) };
  }

  test('returns null when compare disabled', () => {
    expect(getPreviousWindowParams('7d', false)).toBeNull();
  });

  test('7d maps to previous 7d window', () => {
    expect(getPreviousWindowParams('7d', true)).toEqual({ period: '7d', offsetDays: '7' });
  });

  test('30d maps to previous 30d window', () => {
    expect(getPreviousWindowParams('30d', true)).toEqual({ period: '30d', offsetDays: '30' });
  });

  test('90d maps to previous 90d window', () => {
    expect(getPreviousWindowParams('90d', true)).toEqual({ period: '90d', offsetDays: '90' });
  });
});

describe('context score normalization', () => {
  const CONTEXT_SCORE_SCALE = 5;
  function normalizeContextScore(raw: number): number {
    return Math.min(Math.max(raw, 0), 1) * CONTEXT_SCORE_SCALE;
  }

  test('scales 0-1 API value to 0-5 display range', () => {
    expect(normalizeContextScore(0.8)).toBeCloseTo(4.0);
    expect(normalizeContextScore(0.5)).toBeCloseTo(2.5);
    expect(normalizeContextScore(1.0)).toBeCloseTo(5.0);
    expect(normalizeContextScore(0)).toBe(0);
  });

  test('clamps values above 1 to max 5', () => {
    expect(normalizeContextScore(1.5)).toBe(5);
    expect(normalizeContextScore(3.0)).toBe(5);
  });

  test('clamps negative values to 0', () => {
    expect(normalizeContextScore(-0.5)).toBe(0);
    expect(normalizeContextScore(-1)).toBe(0);
  });

  test('handles typical API avg_score values', () => {
    // API returns avg(overall_score) which is 0-1 for context_preservation
    expect(normalizeContextScore(0.72)).toBeCloseTo(3.6);
    expect(normalizeContextScore(0.35)).toBeCloseTo(1.75);
  });
});

describe('timeseries row extraction', () => {
  test('maps timeseries rows to trend format', () => {
    const tsRows = [
      { day: '2024-01-01', avg_overall_score: 3.8, flagged_count: 2 },
      { day: '2024-01-02', avg_overall_score: 4.1, flagged_count: 1 },
    ];
    const trend = tsRows.map((r) => ({
      day: String(r.day ?? ''),
      avgQuality: Number(r.avg_overall_score ?? 0),
      flaggedCount: Number(r.flagged_count ?? 0),
    }));

    expect(trend).toEqual([
      { day: '2024-01-01', avgQuality: 3.8, flaggedCount: 2 },
      { day: '2024-01-02', avgQuality: 4.1, flaggedCount: 1 },
    ]);
  });

  test('handles missing fields with defaults', () => {
    const tsRows = [{}];
    const trend = tsRows.map((r: Record<string, unknown>) => ({
      day: String(r.day ?? ''),
      avgQuality: Number(r.avg_overall_score ?? 0),
      flaggedCount: Number(r.flagged_count ?? 0),
    }));

    expect(trend[0]).toEqual({ day: '', avgQuality: 0, flaggedCount: 0 });
  });
});
