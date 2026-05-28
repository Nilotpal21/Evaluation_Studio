/**
 * Project-scoped trace explorer routes.
 *
 * GET /api/projects/:projectId/traces
 *
 * Returns debuggable span/execution-unit rows. Raw event payloads stay out of
 * list responses; previews are derived from event type summaries only.
 */

import { Router, type Router as RouterType } from 'express';
import type { ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@abl/compiler/platform';
import { requireProjectPermission } from '../middleware/rbac.js';
import { isDatabaseAvailable } from '../db/index.js';

const router: RouterType = Router({ mergeParams: true });
const log = createLogger('routes:traces');

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const DEFAULT_RANGE_DAYS = 7;
const MAX_LEGACY_ENVIRONMENT_SESSION_IDS = 5_000;
const RANGE_PATTERN = /^(\d+)d$/i;
const SORT_FIELDS = new Set([
  'startedAt',
  'durationMs',
  'eventCount',
  'errorCount',
  'totalTokens',
  'estimatedCost',
]);
const TRACE_TYPE_CATEGORY_FILTERS: Readonly<Record<string, readonly string[]>> = {
  llm_call: ['llm'],
  tool_call: ['tool'],
  agent: ['agent'],
  session: ['session'],
  error: ['system'],
};

type TraceStatus = 'ok' | 'error';

type TraceExplorerQueryRow = {
  // ClickHouse aliases use the `resolved_` prefix so they never collide with
  // `platform_events` column names (`trace_id`, `span_id`, `session_id`)
  // referenced inside the WITH expressions. Reusing the column names as SELECT
  // aliases triggers ClickHouse `CYCLIC_ALIASES` (174) and `ILLEGAL_AGGREGATION`
  // (184) under the new analyzer enabled by default in 24.3+.
  resolved_trace_id: string;
  resolved_span_id: string;
  resolved_session_id: string;
  agent_name: string;
  environment: string;
  channel: string;
  // Pre-formatted UTC ISO 8601 string from `formatDateTime(..., '%Y-%m-%dT%H:%i:%S.%fZ')`.
  // Avoids `new Date('YYYY-MM-DD HH:MM:SS.fff')` being parsed as local time.
  started_at: string;
  duration_ms: number;
  event_count: number;
  error_count: number;
  warning_count: number;
  warning_codes: string[];
  diagnostic_code?: string;
  diagnostic_customer_message?: string;
  diagnostic_operator_hint?: string;
  diagnostic_trace_id?: string;
  diagnostic_category?: string;
  diagnostic_severity?: string;
  diagnostic_agent_name?: string;
  diagnostic_tool_name?: string;
  diagnostic_recommended_action?: string;
  event_types: string[];
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
};

type TraceExplorerWarningCode = 'REASONING_FALLBACK' | 'OPENAI_RESPONSES_REASONING_ITEM_MISSING';

type TraceExplorerWarning = {
  code: TraceExplorerWarningCode;
  message: string;
  severity: 'warning';
};

type TraceExplorerOperatorDiagnostic = {
  code: string;
  customerMessage: string;
  operatorHint: string;
  traceId: string;
  severity: 'info' | 'warning' | 'error';
  category: 'llm' | 'tool' | 'runtime';
  agentName: string | null;
  toolName: string | null;
  recommendedAction: string | null;
};

type TraceExplorerRow = {
  traceId: string;
  spanId: string;
  sessionId: string;
  agentName: string | null;
  environment: string | null;
  channel: string | null;
  type: string;
  status: TraceStatus;
  startedAt: string;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  eventCount: number;
  errorCount: number;
  warningCount: number;
  warnings: TraceExplorerWarning[];
  operatorDiagnostics: TraceExplorerOperatorDiagnostic[];
  preview: string;
};

type TimeRange = { from: Date; to: Date } | { error: string };
type TraceExplorerQueryResult = {
  rows: TraceExplorerQueryRow[];
  total: number;
};
type SessionEnvironmentProjection = {
  _id: unknown;
  environment?: unknown;
};
type SessionIdProjection = {
  _id: unknown;
};

router.get('/', async (req, res) => {
  try {
    if (!(await requireProjectPermission(req, res, 'session:read'))) return;

    const tenantId = req.tenantContext?.tenantId;
    const projectId = (req.params as Record<string, string>).projectId;
    if (!tenantId) {
      res.status(400).json({
        success: false,
        error: { code: 'MISSING_TENANT', message: 'Tenant context required' },
      });
      return;
    }

    const limit = clampInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(req.query.offset, 0, 0, 10_000);
    const timeRange = resolveTimeRange(req.query);
    if ('error' in timeRange) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: timeRange.error },
      });
      return;
    }

    const environmentFilters = readStringList(req.query.environment);
    const typeFilters = readStringList(req.query.type);
    const statusFilters = readStringList(req.query.status);
    const errorsOnly = parseBoolean(req.query.errorsOnly);
    if (errorsOnly === null) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_QUERY', message: 'errorsOnly must be a boolean query value' },
      });
      return;
    }

    const legacyEnvironmentSessionIds =
      environmentFilters.length > 0
        ? await loadSessionIdsForEnvironmentFilters(
            environmentFilters,
            tenantId,
            projectId,
            timeRange.from,
            timeRange.to,
          )
        : [];
    const ch = await getClickHouse();
    const { rows, total } = await queryTraceExplorerRows(ch, {
      tenantId,
      projectId,
      limit,
      offset,
      from: timeRange.from,
      to: timeRange.to,
      q: readString(req.query.q) ?? readString(req.query.search),
      agentNames: readStringList(req.query.agentName),
      environments: environmentFilters,
      legacyEnvironmentSessionIds,
      channels: readStringList(req.query.channel),
      types: typeFilters,
      statuses: statusFilters,
      errorsOnly: errorsOnly === true,
      minLatencyMs: readNumber(req.query.minLatencyMs),
      maxLatencyMs: readNumber(req.query.maxLatencyMs),
      minTokens: readNumber(req.query.minTokens),
      maxTokens: readNumber(req.query.maxTokens),
      minCost: readNumber(req.query.minCost),
      maxCost: readNumber(req.query.maxCost),
      sortBy: readSortBy(req.query.sortBy),
      sortDir: readSortDir(req.query.sortDir),
    });

    const fallbackEnvironments = await loadSessionEnvironmentFallbacks(
      rows
        .filter((row) => !row.environment && row.resolved_session_id)
        .map((row) => row.resolved_session_id),
      tenantId,
      projectId,
    );

    const mapped = rows
      .map((row) => mapTraceExplorerRow(row, fallbackEnvironments))
      .filter((row) => {
        const environmentMatches =
          environmentFilters.length === 0 ||
          environmentFilters.some(
            (environment) => row.environment?.toLowerCase() === environment.toLowerCase(),
          );
        const typeMatches = typeFilters.length === 0 || typeFilters.includes(row.type);
        return environmentMatches && typeMatches;
      });

    res.set('Cache-Control', 'private, max-age=5, stale-while-revalidate=10');
    res.json({
      success: true,
      total,
      offset,
      limit,
      traces: mapped,
    });
  } catch (error) {
    log.error('Trace explorer query failed', {
      projectId: (req.params as Record<string, string>).projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'TRACE_EXPLORER_FAILED', message: 'Failed to query traces' },
    });
  }
});

async function getClickHouse(): Promise<ClickHouseClient> {
  const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
  return getClickHouseClient();
}

async function queryTraceExplorerRows(
  client: ClickHouseClient,
  params: {
    tenantId: string;
    projectId: string;
    limit: number;
    offset: number;
    from: Date;
    to: Date;
    q?: string;
    agentNames: string[];
    environments: string[];
    legacyEnvironmentSessionIds: string[];
    channels: string[];
    types: string[];
    statuses: string[];
    errorsOnly: boolean;
    minLatencyMs?: number;
    maxLatencyMs?: number;
    minTokens?: number;
    maxTokens?: number;
    minCost?: number;
    maxCost?: number;
    sortBy: string;
    sortDir: 'ASC' | 'DESC';
  },
): Promise<TraceExplorerQueryResult> {
  const where = [
    'tenant_id = {tenantId:String}',
    'project_id = {projectId:String}',
    'timestamp >= {from:DateTime64(3)}',
    'timestamp <= {to:DateTime64(3)}',
    "(session_id != '' OR trace_id != '' OR span_id != '')",
  ];
  const queryParams: Record<string, unknown> = {
    tenantId: params.tenantId,
    projectId: params.projectId,
    from: formatClickHouseDateTime(params.from),
    to: formatClickHouseDateTime(params.to),
    limit: params.limit,
    offset: params.offset,
  };

  if (params.q) {
    where.push(`(
      positionCaseInsensitive(trace_id, {q:String}) > 0 OR
      positionCaseInsensitive(span_id, {q:String}) > 0 OR
      positionCaseInsensitive(session_id, {q:String}) > 0 OR
      positionCaseInsensitive(agent_name, {q:String}) > 0
    )`);
    queryParams.q = params.q;
  }
  if (params.agentNames.length > 0) {
    where.push('agent_name IN {agentNames:Array(String)}');
    queryParams.agentNames = params.agentNames;
  }
  if (params.environments.length > 0) {
    if (params.legacyEnvironmentSessionIds.length > 0) {
      where.push(`(
        environment IN {environments:Array(String)}
        OR (environment = '' AND session_id IN {legacyEnvironmentSessionIds:Array(String)})
      )`);
      queryParams.legacyEnvironmentSessionIds = params.legacyEnvironmentSessionIds;
    } else {
      where.push('environment IN {environments:Array(String)}');
    }
    queryParams.environments = params.environments;
  }
  if (params.channels.length > 0) {
    where.push('channel IN {channels:Array(String)}');
    queryParams.channels = params.channels;
  }
  const categoryFilters = resolveTraceExplorerCategoryFilters(params.types);
  if (categoryFilters.length > 0) {
    where.push('category IN {categories:Array(String)}');
    queryParams.categories = categoryFilters;
  }

  const having: string[] = [];
  const wantsOnlyErrors =
    params.errorsOnly ||
    (params.statuses.length === 1 && params.statuses[0]?.toLowerCase() === 'error');
  const wantsOnlyOk = params.statuses.length === 1 && params.statuses[0]?.toLowerCase() === 'ok';
  if (wantsOnlyErrors) {
    having.push('error_count > 0');
  } else if (wantsOnlyOk) {
    having.push('error_count = 0');
  }
  addNumberRange(
    having,
    queryParams,
    'duration_ms',
    'LatencyMs',
    params.minLatencyMs,
    params.maxLatencyMs,
  );
  addNumberRange(having, queryParams, 'total_tokens', 'Tokens', params.minTokens, params.maxTokens);
  addNumberRange(having, queryParams, 'estimated_cost', 'Cost', params.minCost, params.maxCost);

  const orderBy = toClickHouseSortColumn(params.sortBy);
  const reasoningFallbackWarningCondition = `(
        JSONExtractBool(data, 'isReasoningFallback')
        OR JSONExtractBool(data, 'reasoningFallback')
        OR JSONExtractString(data, 'routingSource') = 'reasoning_fallback'
        OR JSONExtractString(data, 'decisionSource') = 'reasoning_fallback'
        OR JSONExtractString(data, 'source') = 'reasoning_fallback'
      )`;
  const errorEnvelopeRawExpression = "JSONExtractRaw(data, 'errorEnvelope')";
  const errorEnvelopeCodeExpression =
    "JSONExtractString(JSONExtractRaw(data, 'errorEnvelope'), 'code')";
  const llmDiagnosticCodeExpression =
    "JSONExtractString(JSONExtractRaw(data, 'diagnostic'), 'code')";
  const missingReasoningItemDiagnosticCondition = `(
        ${llmDiagnosticCodeExpression} = 'OPENAI_RESPONSES_REASONING_ITEM_MISSING'
        OR ${errorEnvelopeCodeExpression} = 'OPENAI_RESPONSES_REASONING_ITEM_MISSING'
      )`;
  const hasErrorEnvelopeCondition = `${errorEnvelopeCodeExpression} != ''`;
  // ClickHouse 24.3+ rejects this query under the new analyzer when SELECT
  // aliases reuse column names that the WITH expressions reference:
  //   - `trace_key AS trace_id` (with `trace_id` inside the WITH `if(...)`)
  //     raises CYCLIC_ALIASES (Code 174).
  //   - the same shape for `span_id` and `session_id`.
  // Naming the WITH outputs with a `resolved_` prefix removes the collision and
  // keeps the GROUP BY referring to the WITH alias (not the underlying column).
  const query = `
    WITH
      if(trace_id = '', session_id, trace_id) AS resolved_trace_id,
      if(span_id = '', event_id, span_id) AS resolved_span_id
    SELECT
      resolved_trace_id,
      resolved_span_id,
      anyLast(session_id) AS resolved_session_id,
      anyLast(agent_name) AS agent_name,
      anyLast(environment) AS environment,
      anyLast(channel) AS channel,
      formatDateTime(min(timestamp), '%Y-%m-%dT%H:%i:%S.%fZ') AS started_at,
      max(duration_ms) AS duration_ms,
      count() AS event_count,
      sum(has_error) AS error_count,
      countIf(
        ${reasoningFallbackWarningCondition}
        OR ${missingReasoningItemDiagnosticCondition}
      ) AS warning_count,
      arrayConcat(
        groupUniqArrayIf('REASONING_FALLBACK', ${reasoningFallbackWarningCondition}),
        groupUniqArrayIf(
          'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
          ${missingReasoningItemDiagnosticCondition}
        )
      ) AS warning_codes,
      anyIf(${errorEnvelopeCodeExpression}, ${hasErrorEnvelopeCondition}) AS diagnostic_code,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'customer_message'), ${hasErrorEnvelopeCondition}) AS diagnostic_customer_message,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'operator_hint'), ${hasErrorEnvelopeCondition}) AS diagnostic_operator_hint,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'trace_id'), ${hasErrorEnvelopeCondition}) AS diagnostic_trace_id,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'category'), ${hasErrorEnvelopeCondition}) AS diagnostic_category,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'severity'), ${hasErrorEnvelopeCondition}) AS diagnostic_severity,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'agent_name'), ${hasErrorEnvelopeCondition}) AS diagnostic_agent_name,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'tool_name'), ${hasErrorEnvelopeCondition}) AS diagnostic_tool_name,
      anyIf(JSONExtractString(${errorEnvelopeRawExpression}, 'recommended_action'), ${hasErrorEnvelopeCondition}) AS diagnostic_recommended_action,
      groupUniqArray(event_type) AS event_types,
      sum(greatest(
        JSONExtractFloat(data, 'inputTokens'),
        JSONExtractFloat(data, 'input_tokens'),
        JSONExtractFloat(data, 'tokensIn'),
        JSONExtractFloat(data, 'promptTokens')
      )) AS input_tokens,
      sum(greatest(
        JSONExtractFloat(data, 'outputTokens'),
        JSONExtractFloat(data, 'output_tokens'),
        JSONExtractFloat(data, 'tokensOut'),
        JSONExtractFloat(data, 'completionTokens')
      )) AS output_tokens,
      input_tokens + output_tokens AS total_tokens,
      sum(greatest(
        JSONExtractFloat(data, 'estimatedCost'),
        JSONExtractFloat(data, 'estimated_cost'),
        JSONExtractFloat(data, 'cost')
      )) AS estimated_cost
    FROM abl_platform.platform_events
    WHERE ${where.join(' AND ')}
    GROUP BY resolved_trace_id, resolved_span_id
    ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
    ORDER BY ${orderBy} ${params.sortDir}
    LIMIT {limit:UInt32} OFFSET {offset:UInt32}
  `;
  // Count query: WITH lives INSIDE the subquery because columns referenced
  // by the WITH expressions (`trace_id`, `session_id`, etc.) are only in scope
  // there. An outer-level WITH raises UNKNOWN_IDENTIFIER (Code 47) even when
  // the alias is never consumed at the outer level.
  const countQuery = `
    SELECT count() AS total
    FROM (
      WITH
        if(trace_id = '', session_id, trace_id) AS resolved_trace_id,
        if(span_id = '', event_id, span_id) AS resolved_span_id
      SELECT
        resolved_trace_id,
        resolved_span_id,
        max(duration_ms) AS duration_ms,
        sum(has_error) AS error_count,
        sum(greatest(
          JSONExtractFloat(data, 'inputTokens'),
          JSONExtractFloat(data, 'input_tokens'),
          JSONExtractFloat(data, 'tokensIn'),
          JSONExtractFloat(data, 'promptTokens')
        )) AS input_tokens,
        sum(greatest(
          JSONExtractFloat(data, 'outputTokens'),
          JSONExtractFloat(data, 'output_tokens'),
          JSONExtractFloat(data, 'tokensOut'),
          JSONExtractFloat(data, 'completionTokens')
        )) AS output_tokens,
        input_tokens + output_tokens AS total_tokens,
        sum(greatest(
          JSONExtractFloat(data, 'estimatedCost'),
          JSONExtractFloat(data, 'estimated_cost'),
          JSONExtractFloat(data, 'cost')
        )) AS estimated_cost
      FROM abl_platform.platform_events
      WHERE ${where.join(' AND ')}
      GROUP BY resolved_trace_id, resolved_span_id
      ${having.length > 0 ? `HAVING ${having.join(' AND ')}` : ''}
    )
  `;

  const [rowResult, countResult] = await Promise.all([
    client.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    }),
    client.query({
      query: countQuery,
      query_params: queryParams,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = (await rowResult.json()) as TraceExplorerQueryRow[];
  const countRows = await countResult.json<{ total: number | string }>();
  const rawTotal = countRows[0]?.total;
  const total =
    typeof rawTotal === 'number' ? rawTotal : Number.parseInt(String(rawTotal ?? 0), 10) || 0;
  return { rows, total };
}

async function loadSessionEnvironmentFallbacks(
  sessionIds: string[],
  tenantId: string,
  projectId: string,
): Promise<Map<string, string>> {
  const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
  if (uniqueSessionIds.length === 0 || !isDatabaseAvailable()) {
    return new Map();
  }

  const { Session } = await import('@agent-platform/database/models');
  const sessions = (await Session.find(
    { _id: { $in: uniqueSessionIds }, tenantId, projectId },
    { _id: 1, environment: 1 },
  )
    .lean()
    .exec()) as SessionEnvironmentProjection[];

  return new Map(
    sessions
      .filter(
        (session): session is { _id: unknown; environment: string } =>
          typeof session.environment === 'string',
      )
      .map((session) => [String(session._id), session.environment]),
  );
}

async function loadSessionIdsForEnvironmentFilters(
  environments: string[],
  tenantId: string,
  projectId: string,
  from: Date,
  to: Date,
): Promise<string[]> {
  const normalizedEnvironments = Array.from(
    new Set(environments.map((environment) => environment.trim()).filter(Boolean)),
  );
  if (normalizedEnvironments.length === 0 || !isDatabaseAvailable()) {
    return [];
  }

  const { Session } = await import('@agent-platform/database/models');
  const sessions = (await Session.find(
    {
      tenantId,
      projectId,
      environment: { $in: normalizedEnvironments },
      startedAt: { $lte: to },
      lastActivityAt: { $gte: from },
    },
    { _id: 1 },
  )
    .limit(MAX_LEGACY_ENVIRONMENT_SESSION_IDS + 1)
    .lean()
    .exec()) as SessionIdProjection[];

  if (sessions.length > MAX_LEGACY_ENVIRONMENT_SESSION_IDS) {
    log.warn('Skipping legacy trace environment fallback because session match set is too large', {
      tenantId,
      projectId,
      environments: normalizedEnvironments,
      maxSessionIds: MAX_LEGACY_ENVIRONMENT_SESSION_IDS,
    });
    return [];
  }

  return sessions
    .map((session) => String(session._id ?? '').trim())
    .filter((sessionId) => sessionId.length > 0);
}

function mapTraceExplorerRow(
  row: TraceExplorerQueryRow,
  fallbackEnvironments: ReadonlyMap<string, string>,
): TraceExplorerRow {
  const eventTypes = Array.isArray(row.event_types) ? row.event_types.filter(Boolean).sort() : [];
  const warnings = normalizeTraceWarnings(row.warning_codes, row.warning_count);
  const operatorDiagnostics = normalizeTraceOperatorDiagnostics(row);
  const type = classifyTraceType(eventTypes);
  const environment = row.environment || fallbackEnvironments.get(row.resolved_session_id) || null;
  const inputTokens = toFiniteNumber(row.input_tokens);
  const outputTokens = toFiniteNumber(row.output_tokens);

  return {
    traceId: row.resolved_trace_id,
    spanId: row.resolved_span_id,
    sessionId: row.resolved_session_id,
    agentName: row.agent_name || null,
    environment,
    channel: row.channel || null,
    type,
    status: toFiniteNumber(row.error_count) > 0 ? 'error' : 'ok',
    startedAt: normalizeClickHouseDateTimeToIso(row.started_at),
    durationMs: toFiniteNumber(row.duration_ms) || null,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCost: roundCost(toFiniteNumber(row.estimated_cost)),
    eventCount: toFiniteNumber(row.event_count),
    errorCount: toFiniteNumber(row.error_count),
    warningCount:
      warnings.length > 0 ? Math.max(toFiniteNumber(row.warning_count), warnings.length) : 0,
    warnings,
    operatorDiagnostics,
    preview: eventTypes.length > 0 ? eventTypes.slice(0, 4).join(', ') : type,
  };
}

function normalizeTraceOperatorDiagnostics(
  row: TraceExplorerQueryRow,
): TraceExplorerOperatorDiagnostic[] {
  const code = readNonEmpty(row.diagnostic_code);
  const operatorHint = readNonEmpty(row.diagnostic_operator_hint);
  if (!code || !operatorHint) {
    return [];
  }

  return [
    {
      code,
      customerMessage:
        readNonEmpty(row.diagnostic_customer_message) ??
        'The runtime reported a sanitized execution diagnostic.',
      operatorHint,
      traceId: readNonEmpty(row.diagnostic_trace_id) ?? row.resolved_trace_id,
      severity: normalizeDiagnosticSeverity(row.diagnostic_severity),
      category: normalizeDiagnosticCategory(row.diagnostic_category),
      agentName: readNonEmpty(row.diagnostic_agent_name) ?? row.agent_name ?? null,
      toolName: readNonEmpty(row.diagnostic_tool_name) ?? null,
      recommendedAction: readNonEmpty(row.diagnostic_recommended_action) ?? null,
    },
  ];
}

function normalizeTraceWarnings(
  warningCodes: string[] | undefined,
  warningCount: number | string | undefined,
): TraceExplorerWarning[] {
  const codes = Array.isArray(warningCodes) ? warningCodes : [];
  const includesReasoningFallback =
    codes.includes('REASONING_FALLBACK') ||
    (codes.length === 0 && toFiniteNumber(warningCount) > 0);
  const warnings: TraceExplorerWarning[] = [];

  if (includesReasoningFallback) {
    warnings.push({
      code: 'REASONING_FALLBACK',
      severity: 'warning',
      message:
        "Rule didn't match; LLM made this routing decision. This usually means the WHEN condition is broken or under-specified. See validation diagnostics.",
    });
  }

  if (codes.includes('OPENAI_RESPONSES_REASONING_ITEM_MISSING')) {
    warnings.push({
      code: 'OPENAI_RESPONSES_REASONING_ITEM_MISSING',
      severity: 'warning',
      message:
        'OpenAI Responses rejected a function call because its required reasoning item was missing from replayed history. Verify previous_response_id or reasoning-item preservation.',
    });
  }

  return warnings;
}

function classifyTraceType(eventTypes: string[]): string {
  if (eventTypes.some((type) => type.startsWith('llm.'))) return 'llm_call';
  if (eventTypes.some((type) => type.startsWith('tool.'))) return 'tool_call';
  if (eventTypes.some((type) => type.startsWith('agent.'))) return 'agent';
  if (eventTypes.some((type) => type.startsWith('session.'))) return 'session';
  if (eventTypes.some((type) => type.includes('error'))) return 'error';
  return eventTypes[0] || 'span';
}

function resolveTraceExplorerCategoryFilters(types: string[]): string[] {
  return [
    ...new Set(
      types.flatMap((type) => {
        const filters = TRACE_TYPE_CATEGORY_FILTERS[type];
        return filters ? [...filters] : [];
      }),
    ),
  ];
}

function resolveTimeRange(query: Record<string, unknown>): TimeRange {
  const to = parseDate(query.to) ?? new Date();
  const from = parseDate(query.from);
  if (query.from && !from) return { error: 'from must be a valid ISO 8601 timestamp' };
  if (query.to && !to) return { error: 'to must be a valid ISO 8601 timestamp' };

  const range = readString(query.range);
  if (range) {
    const match = range.match(RANGE_PATTERN);
    if (!match) return { error: 'range must be in Nd format (for example 7d or 30d)' };
    const days = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isFinite(days) || days < 1) {
      return { error: 'range must be a positive number of days' };
    }
    return { from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000), to };
  }

  return {
    from: from ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000),
    to,
  };
}

function addNumberRange(
  having: string[],
  queryParams: Record<string, unknown>,
  column: string,
  paramSuffix: string,
  min?: number,
  max?: number,
): void {
  if (min !== undefined) {
    having.push(`${column} >= {min${paramSuffix}:Float64}`);
    queryParams[`min${paramSuffix}`] = min;
  }
  if (max !== undefined) {
    having.push(`${column} <= {max${paramSuffix}:Float64}`);
    queryParams[`max${paramSuffix}`] = max;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeDiagnosticSeverity(value: unknown): 'info' | 'warning' | 'error' {
  return value === 'info' || value === 'warning' || value === 'error' ? value : 'error';
}

function normalizeDiagnosticCategory(value: unknown): 'llm' | 'tool' | 'runtime' {
  return value === 'llm' || value === 'tool' || value === 'runtime' ? value : 'runtime';
}

function readStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .flatMap((item) => (typeof item === 'string' ? item.split(',') : []))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function readNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined | null {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed =
    typeof value === 'string' && value.trim().length > 0 ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function readSortBy(value: unknown): string {
  const sortBy = readString(value) ?? 'startedAt';
  return SORT_FIELDS.has(sortBy) ? sortBy : 'startedAt';
}

function readSortDir(value: unknown): 'ASC' | 'DESC' {
  return readString(value)?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

function toClickHouseSortColumn(sortBy: string): string {
  switch (sortBy) {
    case 'durationMs':
      return 'duration_ms';
    case 'eventCount':
      return 'event_count';
    case 'errorCount':
      return 'error_count';
    case 'totalTokens':
      return 'total_tokens';
    case 'estimatedCost':
      return 'estimated_cost';
    default:
      return 'started_at';
  }
}

function toFiniteNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatClickHouseDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

// ClickHouse DateTime64 values arrive UTC-encoded but with the ClickHouse text
// format (`YYYY-MM-DD HH:MM:SS.fff`) when not pre-formatted. V8 parses that
// space-separated form as *local* time, which silently shifts the timestamp by
// the server's offset (e.g. -5h30 on dev). Our SQL now pre-formats with
// `formatDateTime(..., '%Y-%m-%dT%H:%i:%S.%fZ')`; this helper passes those
// values through and only falls back to Date-based normalization for the
// pre-format legacy shape so test fixtures and any stragglers remain safe.
function normalizeClickHouseDateTimeToIso(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return new Date(0).toISOString();
  }
  if (value.endsWith('Z') && value.includes('T')) {
    return value;
  }
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = normalized.endsWith('Z') ? normalized : `${normalized}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

export default router;
