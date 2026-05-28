const CH_DATABASE = 'abl_platform';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface EvalCasesCursor {
  personaId: string;
  scenarioId: string;
  variantIndex: number;
}

export interface EvalCasesQueryParams {
  tenantId: string;
  projectId: string;
  runId: string;
  personaId?: string;
  scenarioId?: string;
  evaluatorId?: string;
  variantIndex?: number;
  minScore?: number;
  maxScore?: number;
  cursor?: string;
  limit?: number;
}

export interface EvalCasesQuerySpec {
  query: string;
  query_params: Record<string, string>;
  format: 'JSONEachRow';
}

export function encodeEvalCasesCursor(cursor: EvalCasesCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeEvalCasesCursor(cursor?: string): EvalCasesCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<EvalCasesCursor>;
    if (
      typeof candidate.personaId !== 'string' ||
      typeof candidate.scenarioId !== 'string' ||
      typeof candidate.variantIndex !== 'number' ||
      !Number.isInteger(candidate.variantIndex) ||
      candidate.variantIndex < 0 ||
      candidate.variantIndex > 255
    ) {
      return null;
    }
    return {
      personaId: candidate.personaId,
      scenarioId: candidate.scenarioId,
      variantIndex: candidate.variantIndex,
    };
  } catch {
    return null;
  }
}

export function normalizeEvalCasesLimit(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

export function buildEvalCaseConversationsQuery(params: EvalCasesQueryParams): EvalCasesQuerySpec {
  const queryParams = baseQueryParams(params);
  const where = baseWhereClauses(params, queryParams, {
    includeCursor: true,
    includeEvaluator: false,
  });
  const limit = normalizeEvalCasesLimit(params.limit);
  queryParams.limit = String(limit + 1);

  return {
    query: `
      SELECT
        persona_id AS personaId,
        scenario_id AS scenarioId,
        variant_index AS variantIndex,
        conversation,
        trace_events AS traceEvents,
        tool_calls AS toolCalls,
        turn_count AS turnCount,
        duration_ms AS durationMs,
        token_usage AS tokenUsage,
        estimated_cost AS estimatedCost,
        customer_visible_cost AS customerVisibleCost,
        cost_by_model AS costByModel,
        milestones_hit AS milestonesHit,
        actual_agent_path AS actualAgentPath,
        tool_call_count AS toolCallCount,
        has_error AS hasError,
        error_message AS errorMessage,
        persona_version AS personaVersion,
        scenario_version AS scenarioVersion,
        latest_created_at AS createdAt
      FROM (
        SELECT
          persona_id,
          scenario_id,
          variant_index,
          argMax(conversation, created_at) AS conversation,
          argMax(trace_events, created_at) AS trace_events,
          argMax(tool_calls, created_at) AS tool_calls,
          argMax(turn_count, created_at) AS turn_count,
          argMax(duration_ms, created_at) AS duration_ms,
          argMax(token_usage, created_at) AS token_usage,
          argMax(estimated_cost, created_at) AS estimated_cost,
          argMax(customer_visible_cost, created_at) AS customer_visible_cost,
          argMax(cost_by_model, created_at) AS cost_by_model,
          argMax(milestones_hit, created_at) AS milestones_hit,
          argMax(actual_agent_path, created_at) AS actual_agent_path,
          argMax(tool_call_count, created_at) AS tool_call_count,
          argMax(has_error, created_at) AS has_error,
          argMax(error_message, created_at) AS error_message,
          argMax(persona_version, created_at) AS persona_version,
          argMax(scenario_version, created_at) AS scenario_version,
          max(created_at) AS latest_created_at
        FROM ${CH_DATABASE}.eval_conversations
        WHERE ${where.join('\n          AND ')}
        GROUP BY persona_id, scenario_id, variant_index
      )
      ORDER BY personaId, scenarioId, variantIndex
      LIMIT {limit: UInt32}
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  };
}

export function buildEvalCaseScoresQuery(params: EvalCasesQueryParams): EvalCasesQuerySpec {
  const queryParams = baseQueryParams(params);
  const innerWhere = baseWhereClauses(params, queryParams, {
    includeCursor: true,
    includeEvaluator: true,
  });
  const outerWhere: string[] = [];
  const limit = normalizeEvalCasesLimit(params.limit);
  queryParams.limit = String(limit * 50);

  if (typeof params.minScore === 'number' && Number.isFinite(params.minScore)) {
    outerWhere.push('score >= {minScore: Float32}');
    queryParams.minScore = String(params.minScore);
  }
  if (typeof params.maxScore === 'number' && Number.isFinite(params.maxScore)) {
    outerWhere.push('score <= {maxScore: Float32}');
    queryParams.maxScore = String(params.maxScore);
  }

  return {
    query: `
      SELECT
        personaId,
        scenarioId,
        variantIndex,
        evaluatorId,
        score,
        passed,
        reasoning,
        evidence,
        confidence,
        scoreOriginal,
        scoreSwapped,
        wasPositionSwapped,
        milestoneCompletionRate,
        handoffCorrectnessRate,
        pathEfficiencyScore,
        needsHumanReview,
        humanScore,
        humanReviewedAt,
        judgeTokensUsed,
        judgeCost,
        judgeLatencyMs,
        evaluatorVersion,
        latest_created_at AS createdAt
      FROM (
        SELECT
          persona_id AS personaId,
          scenario_id AS scenarioId,
          variant_index AS variantIndex,
          evaluator_id AS evaluatorId,
          argMax(score, created_at) AS score,
          argMax(passed, created_at) AS passed,
          argMax(reasoning, created_at) AS reasoning,
          argMax(evidence, created_at) AS evidence,
          argMax(confidence, created_at) AS confidence,
          argMax(score_original, created_at) AS scoreOriginal,
          argMax(score_swapped, created_at) AS scoreSwapped,
          argMax(was_position_swapped, created_at) AS wasPositionSwapped,
          argMax(milestone_completion_rate, created_at) AS milestoneCompletionRate,
          argMax(handoff_correctness_rate, created_at) AS handoffCorrectnessRate,
          argMax(path_efficiency_score, created_at) AS pathEfficiencyScore,
          argMax(needs_human_review, created_at) AS needsHumanReview,
          argMax(human_score, created_at) AS humanScore,
          argMax(human_reviewed_at, created_at) AS humanReviewedAt,
          argMax(judge_tokens_used, created_at) AS judgeTokensUsed,
          argMax(judge_cost, created_at) AS judgeCost,
          argMax(judge_latency_ms, created_at) AS judgeLatencyMs,
          argMax(evaluator_version, created_at) AS evaluatorVersion,
          max(created_at) AS latest_created_at
        FROM ${CH_DATABASE}.eval_scores
        WHERE ${innerWhere.join('\n          AND ')}
        GROUP BY persona_id, scenario_id, variant_index, evaluator_id
      )
      ${outerWhere.length > 0 ? `WHERE ${outerWhere.join('\n        AND ')}` : ''}
      ORDER BY personaId, scenarioId, variantIndex, evaluatorId
      LIMIT {limit: UInt32}
    `,
    query_params: queryParams,
    format: 'JSONEachRow',
  };
}

function baseQueryParams(params: EvalCasesQueryParams): Record<string, string> {
  return {
    tenantId: params.tenantId,
    projectId: params.projectId,
    runId: params.runId,
  };
}

function baseWhereClauses(
  params: EvalCasesQueryParams,
  queryParams: Record<string, string>,
  options: { includeCursor: boolean; includeEvaluator: boolean },
): string[] {
  const where = [
    'tenant_id = {tenantId: String}',
    'project_id = {projectId: String}',
    'run_id = {runId: String}',
  ];

  if (params.personaId) {
    where.push('persona_id = {personaId: String}');
    queryParams.personaId = params.personaId;
  }
  if (params.scenarioId) {
    where.push('scenario_id = {scenarioId: String}');
    queryParams.scenarioId = params.scenarioId;
  }
  if (options.includeEvaluator && params.evaluatorId) {
    where.push('evaluator_id = {evaluatorId: String}');
    queryParams.evaluatorId = params.evaluatorId;
  }
  if (typeof params.variantIndex === 'number' && Number.isInteger(params.variantIndex)) {
    where.push('variant_index = {variantIndex: UInt8}');
    queryParams.variantIndex = String(params.variantIndex);
  }

  const cursor = options.includeCursor ? decodeEvalCasesCursor(params.cursor) : null;
  if (cursor) {
    where.push(`(
            persona_id > {cursorPersonaId: String}
            OR (persona_id = {cursorPersonaId: String} AND scenario_id > {cursorScenarioId: String})
            OR (
              persona_id = {cursorPersonaId: String}
              AND scenario_id = {cursorScenarioId: String}
              AND variant_index > {cursorVariantIndex: UInt8}
            )
          )`);
    queryParams.cursorPersonaId = cursor.personaId;
    queryParams.cursorScenarioId = cursor.scenarioId;
    queryParams.cursorVariantIndex = String(cursor.variantIndex);
  }

  return where;
}
