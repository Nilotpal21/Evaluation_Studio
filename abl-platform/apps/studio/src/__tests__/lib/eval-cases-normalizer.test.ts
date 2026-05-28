// @vitest-environment node

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decodeEvalCaseJsonField,
  decodeEvalCaseStringField,
  normalizeEvalCases,
  type EvalCaseConversationRow,
  type EvalCaseScoreRow,
} from '../../lib/eval-cases-normalizer';

function gz(value: unknown): string {
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  return `gz:${gzipSync(source).toString('base64')}`;
}

const conversationRow: EvalCaseConversationRow = {
  personaId: 'persona-1',
  scenarioId: 'scenario-1',
  variantIndex: 0,
  conversation: JSON.stringify([
    { role: 'user', content: 'I need a refund', timestamp: '2026-05-18T12:00:00.000Z' },
    {
      role: 'agent',
      content: 'I can help.',
      timestamp: '2026-05-18T12:00:01.000Z',
      agentName: 'SupportAgent',
    },
  ]),
  traceEvents: JSON.stringify([
    { type: 'flow_step', step: 'finalize', agent: 'SupportAgent' },
    { type: 'complete', state: 'COMPLETE', agent: 'SupportAgent' },
  ]),
  toolCalls: JSON.stringify([]),
  turnCount: '1',
  durationMs: '1200',
  tokenUsage: '42',
  estimatedCost: 0.01,
  customerVisibleCost: 0.01,
  costByModel: '{}',
  milestonesHit: ['refund_intent_detected'],
  actualAgentPath: ['SupportAgent'],
  toolCallCount: '0',
  hasError: 0,
  errorMessage: '',
  personaVersion: 3,
  scenarioVersion: 2,
  createdAt: '2026-05-18 12:00:01.000',
};

const scoreRow: EvalCaseScoreRow = {
  personaId: 'persona-1',
  scenarioId: 'scenario-1',
  variantIndex: 0,
  evaluatorId: 'evaluator-1',
  score: 2,
  passed: 0,
  reasoning: 'The agent did not check refund status.',
  evidence: 'No refund lookup tool call occurred.',
  confidence: 0.82,
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
  judgeLatencyMs: '2000',
  evaluatorVersion: 1,
  createdAt: '2026-05-18 12:00:02.000',
};

describe('eval case normalization', () => {
  it('decodes plain JSON and gzipped JSON fields', async () => {
    await expect(decodeEvalCaseJsonField('[{"ok":true}]')).resolves.toEqual([{ ok: true }]);
    await expect(decodeEvalCaseJsonField(gz([{ ok: true }]))).resolves.toEqual([{ ok: true }]);
  });

  it('decodes plain and gzipped string fields', async () => {
    await expect(decodeEvalCaseStringField('plain rationale')).resolves.toBe('plain rationale');
    await expect(decodeEvalCaseStringField(gz('compressed rationale'))).resolves.toBe(
      'compressed rationale',
    );
  });

  it('groups score rows under cases and emits diagnostic transcript shape', async () => {
    const result = await normalizeEvalCases({
      conversationRows: [conversationRow],
      scoreRows: [scoreRow],
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
      includeTraceEvents: false,
      includeToolCalls: true,
      includeScores: true,
      failedOnly: false,
    });

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      caseId: 'persona-1:scenario-1:v0',
      persona: { id: 'persona-1', name: 'Busy Buyer', version: 3 },
      scenario: { id: 'scenario-1', name: 'Refund request', version: 2 },
      diagnosticTranscriptAvailable: true,
      failureLabels: ['low_score', 'missed_milestone', 'missing_tool_call'],
    });
    expect(result.cases[0]?.diagnosticTranscript).toMatchObject({
      source: 'eval_run_case',
      events: expect.arrayContaining([expect.objectContaining({ step: 'finalize' })]),
      steps: expect.arrayContaining([expect.objectContaining({ step: 'finalize' })]),
    });
    expect(result.cases[0]?.scores[0]).toMatchObject({
      evaluator: { id: 'evaluator-1', name: 'Task completion', version: 1 },
      score: 2,
      passed: false,
      reasoning: 'The agent did not check refund status.',
    });
    expect(result.cases[0]?.traceEvents).toBeNull();
  });

  it('returns compact diagnostic view without bulky evidence', async () => {
    const result = await normalizeEvalCases({
      conversationRows: [conversationRow],
      scoreRows: [scoreRow],
      personasById: new Map(),
      scenariosById: new Map(),
      evaluatorsById: new Map(),
      includeTraceEvents: true,
      includeToolCalls: true,
      includeScores: true,
      failedOnly: true,
      view: 'diagnostic',
    });

    expect(result.cases).toEqual([
      expect.objectContaining({
        caseId: 'persona-1:scenario-1:v0',
        diagnosticTranscript: expect.any(Object),
        failureLabels: expect.arrayContaining(['low_score']),
      }),
    ]);
    expect(result.cases[0]).not.toHaveProperty('conversation');
    expect(result.cases[0]).not.toHaveProperty('traceEvents');
    expect(result.cases[0]).not.toHaveProperty('toolCalls');
  });

  it('uses score rows for failure labels even when score output is excluded', async () => {
    const result = await normalizeEvalCases({
      conversationRows: [conversationRow],
      scoreRows: [scoreRow],
      personasById: new Map(),
      scenariosById: new Map(),
      evaluatorsById: new Map(),
      includeTraceEvents: false,
      includeToolCalls: false,
      includeScores: false,
      failedOnly: true,
    });

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      failureLabels: expect.arrayContaining(['low_score']),
      scores: [],
    });
  });

  it('extracts diagnostic steps from runtime trace event data payloads', async () => {
    const result = await normalizeEvalCases({
      conversationRows: [
        {
          ...conversationRow,
          traceEvents: JSON.stringify([
            { type: 'agent_enter', data: { agentName: 'SupportAgent' } },
            {
              type: 'flow_step_enter',
              data: { stepName: 'finalize', agentName: 'SupportAgent' },
            },
          ]),
        },
      ],
      scoreRows: [],
      personasById: new Map(),
      scenariosById: new Map(),
      evaluatorsById: new Map(),
      includeTraceEvents: false,
      includeToolCalls: false,
      includeScores: false,
      failedOnly: false,
    });

    expect(result.cases[0]?.diagnosticTranscript).toMatchObject({
      steps: [expect.objectContaining({ type: 'flow_step_enter', step: 'finalize' })],
    });
  });

  it('derives score failure labels from decompressed evidence', async () => {
    const result = await normalizeEvalCases({
      conversationRows: [conversationRow],
      scoreRows: [
        {
          ...scoreRow,
          evidence: gz('The required lookup tool was not called before final response.'),
        },
      ],
      personasById: new Map(),
      scenariosById: new Map(),
      evaluatorsById: new Map(),
      includeTraceEvents: false,
      includeToolCalls: false,
      includeScores: true,
      failedOnly: false,
    });

    expect(result.cases[0]?.scores[0]).toMatchObject({
      evidence: 'The required lookup tool was not called before final response.',
      failureLabels: expect.arrayContaining(['missing_tool_call']),
    });
  });

  it('does not infer missing tool calls from zero tool count alone', async () => {
    const result = await normalizeEvalCases({
      conversationRows: [
        {
          ...conversationRow,
          toolCallCount: '0',
        },
      ],
      scoreRows: [],
      personasById: new Map(),
      scenariosById: new Map([
        [
          'scenario-1',
          {
            expectedMilestones: [],
          },
        ],
      ]),
      evaluatorsById: new Map(),
      includeTraceEvents: false,
      includeToolCalls: false,
      includeScores: false,
      failedOnly: false,
    });

    expect(result.cases[0]?.failureLabels).not.toContain('missing_tool_call');
  });
});
