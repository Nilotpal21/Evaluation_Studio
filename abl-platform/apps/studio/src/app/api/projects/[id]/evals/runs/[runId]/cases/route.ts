/**
 * GET /api/projects/:id/evals/runs/:runId/cases
 *
 * Returns per-case eval run drill-down data. The default shape includes the
 * conversation, scores, trajectory metadata, and a compact diagnostic transcript.
 * Use view=diagnostic for a smaller payload intended for automated root-cause
 * analysis.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import {
  findEvalCaseEntitySummaries,
  findRunById,
  type EvalCaseEntitySummaryIds,
} from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import {
  buildEvalCaseConversationsQuery,
  buildEvalCaseScoresQuery,
  normalizeEvalCasesLimit,
} from '@/lib/eval-cases-query';
import {
  normalizeEvalCases,
  type EvalCaseConversationRow,
  type EvalCaseScoreRow,
} from '@/lib/eval-cases-normalizer';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';

type RouteParams = { params: Promise<{ id: string; runId: string }> };

const querySchema = z.object({
  personaId: z.string().min(1).optional(),
  scenarioId: z.string().min(1).optional(),
  evaluatorId: z.string().min(1).optional(),
  variantIndex: z.coerce.number().int().min(0).max(255).optional(),
  minScore: z.coerce.number().optional(),
  maxScore: z.coerce.number().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
  includeTraceEvents: z.enum(['true', 'false']).optional(),
  includeToolCalls: z.enum(['true', 'false']).optional(),
  includeScores: z.enum(['true', 'false']).optional(),
  failedOnly: z.enum(['true', 'false']).optional(),
  view: z.enum(['full', 'diagnostic']).optional(),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const parsedQuery = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsedQuery.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: parsedQuery.error.issues },
      { status: 400 },
    );
  }

  const query = parsedQuery.data;
  const limit = normalizeEvalCasesLimit(query.limit);
  const scanLimit = resolveScanLimit(query, limit);

  try {
    const run = await findRunById(runId, user.tenantId, projectId);
    if (!run) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    const client = getClickHouseClient();
    const queryParams = {
      tenantId: user.tenantId,
      projectId,
      runId,
      personaId: query.personaId,
      scenarioId: query.scenarioId,
      evaluatorId: query.evaluatorId,
      variantIndex: query.variantIndex,
      minScore: query.minScore,
      maxScore: query.maxScore,
      cursor: query.cursor,
      limit: scanLimit,
    };
    const shouldReadScores =
      query.includeScores !== 'false' ||
      query.failedOnly === 'true' ||
      shouldPostFilterByScores(query);

    const [conversationResult, scoreResult] = await Promise.all([
      client.query(buildEvalCaseConversationsQuery(queryParams)),
      shouldReadScores
        ? client.query(buildEvalCaseScoresQuery(queryParams))
        : Promise.resolve(null),
    ]);

    const [fetchedConversationRows, fetchedScoreRows] = await Promise.all([
      conversationResult.json<EvalCaseConversationRow>(),
      scoreResult ? scoreResult.json<EvalCaseScoreRow>() : Promise.resolve([]),
    ]);
    const rawHasMore = fetchedConversationRows.length > scanLimit;
    const conversationRows = fetchedConversationRows.slice(0, scanLimit);
    const paginationCursorFallback = cursorFromConversationRow(
      conversationRows[conversationRows.length - 1],
    );
    const matchingScoreCaseKeys = scoreCaseKeys(fetchedScoreRows);
    const matchedConversationRows = shouldPostFilterByScores(query)
      ? conversationRows.filter((row) => matchingScoreCaseKeys.has(caseKey(row)))
      : conversationRows;
    const matchedCaseKeys = conversationCaseKeys(matchedConversationRows);
    const scoreRows =
      matchedCaseKeys.size > 0
        ? fetchedScoreRows.filter((row) => matchedCaseKeys.has(caseKey(row)))
        : [];
    const entityIds = collectEntityIds(matchedConversationRows, scoreRows);
    const summaries = await findEvalCaseEntitySummaries(user.tenantId, projectId, entityIds);
    const normalized = await normalizeEvalCases({
      conversationRows: matchedConversationRows,
      scoreRows,
      ...summaries,
      includeTraceEvents: query.includeTraceEvents === 'true',
      includeToolCalls: query.includeToolCalls !== 'false',
      includeScores: query.includeScores !== 'false',
      failedOnly: query.failedOnly === 'true',
      view: query.view ?? 'full',
      limit,
      paginationHasMore: rawHasMore || matchedConversationRows.length > limit,
      paginationCursorFallback,
    });

    return NextResponse.json({
      success: true,
      run,
      cases: normalized.cases,
      pagination: normalized.pagination,
    });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.cases');
  }
}

function collectEntityIds(
  conversationRows: EvalCaseConversationRow[],
  scoreRows: EvalCaseScoreRow[],
): EvalCaseEntitySummaryIds {
  return {
    personaIds: uniqueStrings([
      ...conversationRows.map((row) => row.personaId),
      ...scoreRows.map((row) => row.personaId),
    ]),
    scenarioIds: uniqueStrings([
      ...conversationRows.map((row) => row.scenarioId),
      ...scoreRows.map((row) => row.scenarioId),
    ]),
    evaluatorIds: uniqueStrings(scoreRows.map((row) => row.evaluatorId)),
  };
}

function shouldPostFilterByScores(query: z.infer<typeof querySchema>): boolean {
  return Boolean(query.evaluatorId || query.minScore !== undefined || query.maxScore !== undefined);
}

function resolveScanLimit(query: z.infer<typeof querySchema>, limit: number): number {
  if (query.failedOnly === 'true' || shouldPostFilterByScores(query)) {
    return Math.min(Math.max(limit * 5, limit), 100);
  }
  return limit;
}

function scoreCaseKeys(scoreRows: EvalCaseScoreRow[]): Set<string> {
  return new Set(scoreRows.map((row) => caseKey(row)));
}

function conversationCaseKeys(conversationRows: EvalCaseConversationRow[]): Set<string> {
  return new Set(conversationRows.map((row) => caseKey(row)));
}

function caseKey(
  row: Pick<
    EvalCaseConversationRow | EvalCaseScoreRow,
    'personaId' | 'scenarioId' | 'variantIndex'
  >,
): string {
  return `${row.personaId}:${row.scenarioId}:v${Number(row.variantIndex)}`;
}

function cursorFromConversationRow(
  row: EvalCaseConversationRow | undefined,
): { personaId: string; scenarioId: string; variantIndex: number } | null {
  if (!row) return null;
  return {
    personaId: row.personaId,
    scenarioId: row.scenarioId,
    variantIndex: Number(row.variantIndex),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
