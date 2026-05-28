import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockRequireTenantAuth = vi.fn();
const mockIsAuthError = vi.fn();
const mockRequireProjectAccess = vi.fn();
const mockIsAccessError = vi.fn();
const mockFindRunById = vi.fn();
const mockFindEvalCaseEntitySummaries = vi.fn();
const mockHandleApiError = vi.fn();
const mockClickHouseQuery = vi.fn();

vi.mock('@/lib/auth', () => ({
  requireTenantAuth: (...args: unknown[]) => mockRequireTenantAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/repos/eval-repo', () => ({
  findRunById: (...args: unknown[]) => mockFindRunById(...args),
  findEvalCaseEntitySummaries: (...args: unknown[]) => mockFindEvalCaseEntitySummaries(...args),
}));

vi.mock('@/lib/api-response', () => ({
  handleApiError: (...args: unknown[]) => mockHandleApiError(...args),
}));

vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({
    query: (...args: unknown[]) => mockClickHouseQuery(...args),
  }),
}));

import { GET } from '@/app/api/projects/[id]/evals/runs/[runId]/cases/route';

const authenticatedUser = {
  id: 'user-1',
  email: 'test@example.com',
  tenantId: 'tenant-1',
};

function makeRequest(query = '') {
  return new NextRequest(
    `http://localhost:3000/api/projects/proj-1/evals/runs/run-1/cases${query}`,
    {
      method: 'GET',
    },
  );
}

function routeParams() {
  return { params: Promise.resolve({ id: 'proj-1', runId: 'run-1' }) };
}

function clickHouseRows<T>(rows: T[]) {
  return {
    json: vi.fn(async () => rows),
  };
}

const conversationRow = {
  personaId: 'persona-1',
  scenarioId: 'scenario-1',
  variantIndex: 0,
  conversation: JSON.stringify([{ role: 'user', content: 'I need a refund' }]),
  traceEvents: JSON.stringify([{ type: 'flow_step', step: 'finalize', agent: 'SupportAgent' }]),
  toolCalls: JSON.stringify([]),
  turnCount: '1',
  durationMs: '100',
  tokenUsage: '42',
  estimatedCost: 0.01,
  customerVisibleCost: 0.01,
  costByModel: '{}',
  milestonesHit: ['refund_intent_detected'],
  actualAgentPath: ['SupportAgent'],
  toolCallCount: '0',
  hasError: 0,
  errorMessage: '',
  personaVersion: 1,
  scenarioVersion: 2,
  createdAt: '2026-05-18 12:00:00.000',
};

const unmatchedConversationRow = {
  ...conversationRow,
  personaId: 'persona-2',
  scenarioId: 'scenario-2',
  conversation: JSON.stringify([{ role: 'user', content: 'Can I change my address?' }]),
};

const passingConversationRow = {
  ...conversationRow,
  personaId: 'persona-0',
  scenarioId: 'scenario-0',
  milestonesHit: [],
  toolCallCount: '1',
  conversation: JSON.stringify([{ role: 'user', content: 'Hello' }]),
};

const scoreRow = {
  personaId: 'persona-1',
  scenarioId: 'scenario-1',
  variantIndex: 0,
  evaluatorId: 'evaluator-1',
  score: 2,
  passed: 0,
  reasoning: 'The agent did not check refund status.',
  evidence: 'No refund lookup tool call occurred.',
  confidence: 0.8,
  scoreOriginal: 2,
  scoreSwapped: 2,
  wasPositionSwapped: 0,
  milestoneCompletionRate: 0.5,
  handoffCorrectnessRate: 1,
  pathEfficiencyScore: 1,
  needsHumanReview: 0,
  humanScore: null,
  humanReviewedAt: null,
  judgeTokensUsed: '100',
  judgeCost: 0.001,
  judgeLatencyMs: '200',
  evaluatorVersion: 3,
  createdAt: '2026-05-18 12:00:01.000',
};

describe('GET /api/projects/:id/evals/runs/:runId/cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockRequireTenantAuth.mockResolvedValue(authenticatedUser);
    mockIsAuthError.mockReturnValue(false);
    mockRequireProjectAccess.mockResolvedValue({ project: { id: 'proj-1', tenantId: 'tenant-1' } });
    mockIsAccessError.mockReturnValue(false);
    mockFindRunById.mockResolvedValue({
      id: 'run-1',
      _id: 'run-1',
      name: 'Regression run',
      status: 'completed',
    });
    mockFindEvalCaseEntitySummaries.mockResolvedValue({
      personasById: new Map([['persona-1', { name: 'Busy Buyer' }]]),
      scenariosById: new Map([
        [
          'scenario-1',
          {
            name: 'Refund request',
            expectedMilestones: ['refund_intent_detected', 'refund_status_checked'],
            agentPath: ['SupportAgent'],
          },
        ],
      ]),
      evaluatorsById: new Map([['evaluator-1', { name: 'Task completion' }]]),
    });
    mockHandleApiError.mockImplementation((error: unknown) =>
      NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      ),
    );
    mockClickHouseQuery
      .mockResolvedValueOnce(clickHouseRows([conversationRow, unmatchedConversationRow]))
      .mockResolvedValueOnce(clickHouseRows([scoreRow]));
  });

  test('returns compact diagnostic cases with scores and trace-derived steps', async () => {
    const response = await GET(
      makeRequest('?view=diagnostic&failedOnly=true&evaluatorId=evaluator-1&minScore=2'),
      routeParams(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.run).toMatchObject({ id: 'run-1', status: 'completed' });
    expect(body.cases).toEqual([
      expect.objectContaining({
        caseId: 'persona-1:scenario-1:v0',
        diagnosticTranscript: expect.objectContaining({
          source: 'eval_run_case',
          steps: [expect.objectContaining({ step: 'finalize' })],
          scores: [
            expect.objectContaining({
              reasoning: 'The agent did not check refund status.',
              confidence: 0.8,
            }),
          ],
        }),
        failureLabels: expect.arrayContaining(['low_score', 'missed_milestone']),
      }),
    ]);
    expect(body.cases).toHaveLength(1);
    expect(body.cases[0]).not.toHaveProperty('conversation');
    expect(body.pagination).toMatchObject({ limit: 20, hasMore: false });

    expect(mockFindRunById).toHaveBeenCalledWith('run-1', 'tenant-1', 'proj-1');
    expect(mockFindEvalCaseEntitySummaries).toHaveBeenCalledWith('tenant-1', 'proj-1', {
      personaIds: ['persona-1'],
      scenarioIds: ['scenario-1'],
      evaluatorIds: ['evaluator-1'],
    });
    expect(mockClickHouseQuery).toHaveBeenCalledTimes(2);
    expect(mockClickHouseQuery.mock.calls[0]?.[0].query_params).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      runId: 'run-1',
    });
    expect(mockClickHouseQuery.mock.calls[1]?.[0].query_params).toMatchObject({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      runId: 'run-1',
      evaluatorId: 'evaluator-1',
      minScore: '2',
    });
  });

  test('returns 404 when the eval run is outside the project scope', async () => {
    mockFindRunById.mockResolvedValueOnce(null);

    const response = await GET(makeRequest(), routeParams());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ success: false, error: 'Not found' });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('rejects variant indexes outside the ClickHouse UInt8 range', async () => {
    const response = await GET(makeRequest('?variantIndex=256'), routeParams());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ success: false, error: 'Invalid request' });
    expect(mockClickHouseQuery).not.toHaveBeenCalled();
  });

  test('overfetches when failedOnly would otherwise hide later failing cases', async () => {
    mockClickHouseQuery.mockReset();
    mockClickHouseQuery
      .mockResolvedValueOnce(clickHouseRows([passingConversationRow, conversationRow]))
      .mockResolvedValueOnce(clickHouseRows([scoreRow]));

    const response = await GET(makeRequest('?failedOnly=true&limit=1'), routeParams());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cases).toEqual([
      expect.objectContaining({
        caseId: 'persona-1:scenario-1:v0',
        failureLabels: expect.arrayContaining(['low_score']),
      }),
    ]);
    expect(mockClickHouseQuery.mock.calls[0]?.[0].query_params).toMatchObject({
      limit: '6',
    });
  });
});
