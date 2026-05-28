import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { encodeEvalCasesCursor } from './eval-cases-query';

const gunzipAsync = promisify(gunzip);
const GZIP_PREFIX = 'gz:';
const LOW_SCORE_THRESHOLD = 3;
const FAILURE_LABEL_ORDER = [
  'conversation_error',
  'low_score',
  'missed_milestone',
  'wrong_handoff_path',
  'missing_tool_call',
  'needs_human_review',
  'judge_error',
];

export interface EvalCaseConversationRow {
  personaId: string;
  scenarioId: string;
  variantIndex: string | number;
  conversation: string;
  traceEvents: string;
  toolCalls: string;
  turnCount: string | number;
  durationMs: string | number;
  tokenUsage: string | number;
  estimatedCost: string | number;
  customerVisibleCost: string | number;
  costByModel: string;
  milestonesHit: string[];
  actualAgentPath: string[];
  toolCallCount: string | number;
  hasError: string | number;
  errorMessage: string;
  personaVersion: string | number;
  scenarioVersion: string | number;
  createdAt: string;
}

export interface EvalCaseScoreRow {
  personaId: string;
  scenarioId: string;
  variantIndex: string | number;
  evaluatorId: string;
  score: string | number;
  passed: string | number;
  reasoning: string;
  evidence: string;
  confidence: string | number;
  scoreOriginal: string | number;
  scoreSwapped: string | number;
  wasPositionSwapped: string | number;
  milestoneCompletionRate: string | number;
  handoffCorrectnessRate: string | number;
  pathEfficiencyScore: string | number;
  needsHumanReview: string | number;
  humanScore: string | number | null;
  humanReviewedAt: string | null;
  judgeTokensUsed: string | number;
  judgeCost: string | number;
  judgeLatencyMs: string | number;
  evaluatorVersion: string | number;
  createdAt: string;
}

export interface EvalCaseEntitySummary {
  name?: string;
  expectedMilestones?: string[];
  agentPath?: string[];
}

export interface NormalizeEvalCasesInput {
  conversationRows: EvalCaseConversationRow[];
  scoreRows: EvalCaseScoreRow[];
  personasById: Map<string, EvalCaseEntitySummary>;
  scenariosById: Map<string, EvalCaseEntitySummary>;
  evaluatorsById: Map<string, EvalCaseEntitySummary>;
  includeTraceEvents: boolean;
  includeToolCalls: boolean;
  includeScores: boolean;
  failedOnly: boolean;
  view?: 'full' | 'diagnostic';
  limit?: number;
  paginationHasMore?: boolean;
  paginationCursorFallback?: {
    personaId: string;
    scenarioId: string;
    variantIndex: number;
  } | null;
}

export interface NormalizeEvalCasesResult {
  cases: Array<Record<string, unknown>>;
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

type CaseAccumulator = {
  key: string;
  personaId: string;
  scenarioId: string;
  variantIndex: number;
  conversationRow?: EvalCaseConversationRow;
  scoreRows: EvalCaseScoreRow[];
};

export async function decodeEvalCaseJsonField<T = unknown>(stored: string): Promise<T> {
  const text = await decodeEvalCaseStringField(stored);
  return JSON.parse(text) as T;
}

export async function decodeEvalCaseStringField(stored: string): Promise<string> {
  if (stored.startsWith(GZIP_PREFIX)) {
    const compressed = Buffer.from(stored.slice(GZIP_PREFIX.length), 'base64');
    return (await gunzipAsync(compressed)).toString('utf8');
  }
  return stored;
}

export async function normalizeEvalCases(
  input: NormalizeEvalCasesInput,
): Promise<NormalizeEvalCasesResult> {
  const limit = input.limit ?? input.conversationRows.length;
  const accumulators = collectCaseAccumulators(input.conversationRows, input.scoreRows);
  const cases: Array<Record<string, unknown>> = [];

  for (const accumulator of accumulators) {
    const normalized = await normalizeCase(accumulator, input);
    if (!normalized) continue;
    if (input.failedOnly && !isFailedCase(normalized)) continue;
    cases.push(input.view === 'diagnostic' ? compactDiagnosticCase(normalized) : normalized);
  }

  const hasMore = input.paginationHasMore ?? input.conversationRows.length > limit;
  const visibleCases = cases.slice(0, limit);
  const lastCase = visibleCases[visibleCases.length - 1];
  const nextCursor = hasMore
    ? buildNextCursor(lastCase, input.paginationCursorFallback ?? null)
    : null;

  return {
    cases: visibleCases,
    pagination: {
      limit,
      nextCursor,
      hasMore,
    },
  };
}

function collectCaseAccumulators(
  conversationRows: EvalCaseConversationRow[],
  scoreRows: EvalCaseScoreRow[],
): CaseAccumulator[] {
  const byKey = new Map<string, CaseAccumulator>();

  for (const row of conversationRows) {
    const variantIndex = toNumber(row.variantIndex);
    const key = caseKey(row.personaId, row.scenarioId, variantIndex);
    byKey.set(key, {
      key,
      personaId: row.personaId,
      scenarioId: row.scenarioId,
      variantIndex,
      conversationRow: row,
      scoreRows: [],
    });
  }

  for (const row of scoreRows) {
    const variantIndex = toNumber(row.variantIndex);
    const key = caseKey(row.personaId, row.scenarioId, variantIndex);
    const accumulator =
      byKey.get(key) ??
      ({
        key,
        personaId: row.personaId,
        scenarioId: row.scenarioId,
        variantIndex,
        scoreRows: [],
      } satisfies CaseAccumulator);
    accumulator.scoreRows.push(row);
    byKey.set(key, accumulator);
  }

  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

async function normalizeCase(
  accumulator: CaseAccumulator,
  input: NormalizeEvalCasesInput,
): Promise<Record<string, unknown> | null> {
  const row = accumulator.conversationRow;
  const persona = input.personasById.get(accumulator.personaId);
  const scenario = input.scenariosById.get(accumulator.scenarioId);
  const conversation = row
    ? await decodeEvalCaseJsonField<Array<Record<string, unknown>>>(row.conversation)
    : [];
  const traceEvents = row
    ? await decodeEvalCaseJsonField<Array<Record<string, unknown>>>(row.traceEvents)
    : [];
  const toolCalls = row
    ? await decodeEvalCaseJsonField<Array<Record<string, unknown>>>(row.toolCalls)
    : [];
  const milestonesHit = row?.milestonesHit ?? [];
  const expectedMilestones = scenario?.expectedMilestones ?? [];
  const missedMilestones = expectedMilestones.filter(
    (milestone) => !milestonesHit.includes(milestone),
  );
  const actualAgentPath = row?.actualAgentPath ?? [];
  const expectedAgentPath = scenario?.agentPath ?? [];
  const normalizedScores = await Promise.all(
    accumulator.scoreRows.map((scoreRow) =>
      normalizeScore(scoreRow, input.evaluatorsById.get(scoreRow.evaluatorId)),
    ),
  );
  const failureLabels = deriveFailureLabels({
    hasError: row ? toBoolean(row.hasError) : false,
    missedMilestones,
    scores: normalizedScores,
  });
  const diagnosticTranscript = buildDiagnosticTranscript({
    accumulator,
    conversation,
    traceEvents,
    scores: normalizedScores,
    failureLabels,
  });

  return {
    caseId: accumulator.key,
    persona: {
      id: accumulator.personaId,
      name: persona?.name ?? accumulator.personaId,
      version: row ? toNumber(row.personaVersion) : undefined,
    },
    scenario: {
      id: accumulator.scenarioId,
      name: scenario?.name ?? accumulator.scenarioId,
      version: row ? toNumber(row.scenarioVersion) : undefined,
      expectedMilestones,
      expectedAgentPath,
    },
    variantIndex: accumulator.variantIndex,
    diagnosticTranscriptAvailable: Boolean(row),
    turnCount: row ? toNumber(row.turnCount) : 0,
    durationMs: row ? toNumber(row.durationMs) : 0,
    conversation,
    diagnosticTranscript,
    toolCalls: input.includeToolCalls ? toolCalls : null,
    traceEvents: input.includeTraceEvents ? traceEvents : null,
    trajectory: {
      milestonesHit,
      expectedMilestones,
      missedMilestones,
      actualAgentPath,
      expectedAgentPath,
    },
    scores: input.includeScores ? normalizedScores : [],
    failureLabels,
    error: row && toBoolean(row.hasError) ? row.errorMessage : undefined,
  };
}

function buildNextCursor(
  lastCase: Record<string, unknown> | undefined,
  fallback: NormalizeEvalCasesInput['paginationCursorFallback'],
): string | null {
  if (lastCase) {
    return encodeEvalCasesCursor({
      personaId: String((lastCase.persona as { id: string }).id),
      scenarioId: String((lastCase.scenario as { id: string }).id),
      variantIndex: Number(lastCase.variantIndex),
    });
  }
  if (!fallback) return null;
  return encodeEvalCasesCursor(fallback);
}

async function normalizeScore(
  row: EvalCaseScoreRow,
  evaluator?: EvalCaseEntitySummary,
): Promise<Record<string, unknown>> {
  const score = toNumber(row.score);
  const passed = toBoolean(row.passed);
  const needsHumanReview = toBoolean(row.needsHumanReview);
  const reasoning = await decodeEvalCaseStringField(row.reasoning);
  const evidence = await decodeEvalCaseStringField(row.evidence);
  const scoreLabels = deriveScoreFailureLabels(score, passed, needsHumanReview, evidence);

  return {
    evaluator: {
      id: row.evaluatorId,
      name: evaluator?.name ?? row.evaluatorId,
      version: toNumber(row.evaluatorVersion),
    },
    score,
    passed,
    confidence: toNumber(row.confidence),
    reasoning,
    evidence,
    bias: {
      scoreOriginal: toNumber(row.scoreOriginal),
      scoreSwapped: toNumber(row.scoreSwapped),
      wasPositionSwapped: toBoolean(row.wasPositionSwapped),
    },
    trajectory: {
      milestoneCompletionRate: toNumber(row.milestoneCompletionRate),
      handoffCorrectnessRate: toNumber(row.handoffCorrectnessRate),
      pathEfficiencyScore: toNumber(row.pathEfficiencyScore),
    },
    needsHumanReview,
    judge: {
      tokensUsed: toNumber(row.judgeTokensUsed),
      cost: toNumber(row.judgeCost),
      latencyMs: toNumber(row.judgeLatencyMs),
    },
    failureLabels: scoreLabels,
  };
}

function buildDiagnosticTranscript(input: {
  accumulator: CaseAccumulator;
  conversation: Array<Record<string, unknown>>;
  traceEvents: Array<Record<string, unknown>>;
  scores: Array<Record<string, unknown>>;
  failureLabels: string[];
}): Record<string, unknown> {
  const stepEvents = input.traceEvents.filter(hasDiagnosticStep);

  return {
    source: 'eval_run_case',
    caseId: input.accumulator.key,
    personaId: input.accumulator.personaId,
    scenarioId: input.accumulator.scenarioId,
    variantIndex: input.accumulator.variantIndex,
    events: stepEvents,
    steps: stepEvents.map((event) => ({
      type: event.type,
      agent: eventValue(event, ['agent', 'agentName', 'toAgent', 'targetAgent']),
      step: eventValue(event, ['step', 'stepName', 'state', 'node', 'phase', 'decision']),
    })),
    conversation: {
      turns: input.conversation.map((turn) => ({
        role: turn.role,
        content: turn.content,
        agentName: turn.agentName,
      })),
    },
    scores: input.scores.map((score) => ({
      evaluator: score.evaluator,
      score: score.score,
      passed: score.passed,
      confidence: score.confidence,
      reasoning: score.reasoning,
      failureLabels: score.failureLabels,
    })),
    failureLabels: input.failureLabels,
  };
}

function hasDiagnosticStep(event: Record<string, unknown>): boolean {
  return (
    typeof eventValue(event, ['step', 'stepName', 'state', 'node', 'phase', 'decision']) ===
    'string'
  );
}

function eventValue(event: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const direct = event[key];
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }
  }

  const data = event.data;
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  for (const key of keys) {
    const nested = record[key];
    if (typeof nested === 'string' && nested.length > 0) {
      return nested;
    }
  }
  return undefined;
}

function deriveFailureLabels(input: {
  hasError: boolean;
  missedMilestones: string[];
  scores: Array<Record<string, unknown>>;
}): string[] {
  const labels = new Set<string>();
  if (input.hasError) labels.add('conversation_error');
  if (input.missedMilestones.length > 0) labels.add('missed_milestone');
  for (const score of input.scores) {
    for (const label of (score.failureLabels as string[] | undefined) ?? []) {
      labels.add(label);
    }
  }
  return sortFailureLabels(labels);
}

function deriveScoreFailureLabels(
  score: number,
  passed: boolean,
  needsHumanReview: boolean,
  evidence: string,
): string[] {
  const labels = new Set<string>();
  if (!passed || score < LOW_SCORE_THRESHOLD) labels.add('low_score');
  if (needsHumanReview) labels.add('needs_human_review');
  if (/no .*tool|missing .*tool|tool .*not|lookup .*not/i.test(evidence)) {
    labels.add('missing_tool_call');
  }
  return sortFailureLabels(labels);
}

function sortFailureLabels(labels: Iterable<string>): string[] {
  return [...labels].sort((left, right) => {
    const leftIndex = FAILURE_LABEL_ORDER.indexOf(left);
    const rightIndex = FAILURE_LABEL_ORDER.indexOf(right);
    const normalizedLeftIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRightIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (normalizedLeftIndex !== normalizedRightIndex) {
      return normalizedLeftIndex - normalizedRightIndex;
    }
    return left.localeCompare(right);
  });
}

function compactDiagnosticCase(value: Record<string, unknown>): Record<string, unknown> {
  return {
    caseId: value.caseId,
    persona: value.persona,
    scenario: value.scenario,
    variantIndex: value.variantIndex,
    diagnosticTranscriptAvailable: value.diagnosticTranscriptAvailable,
    diagnosticTranscript: value.diagnosticTranscript,
    failureLabels: value.failureLabels,
  };
}

function isFailedCase(value: Record<string, unknown>): boolean {
  return Array.isArray(value.failureLabels) && value.failureLabels.length > 0;
}

function caseKey(personaId: string, scenarioId: string, variantIndex: number): string {
  return `${personaId}:${scenarioId}:v${variantIndex}`;
}

function toNumber(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBoolean(value: string | number | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
}
