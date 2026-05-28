/**
 * Eval Repository
 *
 * Data access layer for all eval entities (personas, scenarios, evaluators,
 * eval sets, runs). Uses lean queries and scoped lookups following platform
 * conventions.
 */

import { ensureDb } from '@/lib/ensure-db';
import {
  EVAL_LIST_DEFAULT_PAGE_SIZE,
  EVAL_LIST_MAX_PAGE_SIZE,
} from '@agent-platform/database/constants/eval-limits';

export interface EvalListOptions {
  cursor?: string | null;
  limit?: number | null;
  search?: string | null;
}

interface NormalizedEvalListOptions {
  cursor: string | null;
  limit: number;
  search: string | null;
}

export interface EvalListPagination {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}

export interface EvalListResult<T> {
  items: T[];
  pagination: EvalListPagination;
}

export interface EvalCaseEntitySummary {
  name?: string;
  expectedMilestones?: string[];
  agentPath?: string[];
}

export interface EvalCaseEntitySummaryIds {
  personaIds: string[];
  scenarioIds: string[];
  evaluatorIds: string[];
}

export interface EvalCaseEntitySummaries {
  personasById: Map<string, EvalCaseEntitySummary>;
  scenariosById: Map<string, EvalCaseEntitySummary>;
  evaluatorsById: Map<string, EvalCaseEntitySummary>;
}

interface EvalListCursor {
  createdAt: string;
  id: string;
}

interface EvalListDoc {
  _id: string;
  id?: string;
  createdAt?: Date | string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

interface EvalListQuery<TDoc extends EvalListDoc> {
  select(fields: string): {
    sort(sort: Record<string, 1 | -1>): {
      limit(limit: number): {
        lean(): Promise<TDoc[]>;
      };
    };
  };
}

interface EvalListModel<TDoc extends EvalListDoc> {
  find(filter: Record<string, unknown>): EvalListQuery<TDoc>;
  countDocuments(filter: Record<string, unknown>): Promise<number>;
}

// ─── ID Normalization ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeId(doc: any): any {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { ...rest, id: _id };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIds(docs: any[]): any[] {
  return docs.map((d) => normalizeId(d));
}

function normalizeListOptions(options: EvalListOptions = {}): NormalizedEvalListOptions {
  const rawLimit = options.limit ?? EVAL_LIST_DEFAULT_PAGE_SIZE;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), EVAL_LIST_MAX_PAGE_SIZE)
      : EVAL_LIST_DEFAULT_PAGE_SIZE;

  return {
    cursor: options.cursor?.trim() || null,
    limit,
    search: options.search?.trim() || null,
  };
}

function encodeEvalListCursor(doc: EvalListDoc): string | null {
  const id = doc.id ?? doc._id;
  const rawCreatedAt = doc.createdAt;
  if (!id || !rawCreatedAt) return null;

  const createdAt =
    rawCreatedAt instanceof Date
      ? rawCreatedAt.toISOString()
      : new Date(rawCreatedAt).toISOString();
  return Buffer.from(JSON.stringify({ createdAt, id } satisfies EvalListCursor)).toString(
    'base64url',
  );
}

function decodeEvalListCursor(cursor: string | null): EvalListCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.createdAt !== 'string' || typeof candidate.id !== 'string') return null;
    const cursorDate = new Date(candidate.createdAt);
    if (Number.isNaN(cursorDate.getTime()) || candidate.id.trim().length === 0) return null;
    return { createdAt: cursorDate.toISOString(), id: candidate.id };
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildEvalListFilter(
  tenantId: string,
  projectId: string,
  options: NormalizedEvalListOptions,
  includeCursor = true,
): Record<string, unknown> {
  const filter: Record<string, unknown> = { tenantId, projectId };
  const clauses: Record<string, unknown>[] = [];

  if (options.search) {
    const pattern = new RegExp(escapeRegex(options.search), 'i');
    clauses.push({ $or: [{ name: pattern }, { description: pattern }] });
  }

  const cursor = decodeEvalListCursor(options.cursor);
  if (options.cursor && !cursor) {
    const error = new Error('Invalid pagination cursor');
    (error as Error & { statusCode: number }).statusCode = 400;
    throw error;
  }

  if (cursor && includeCursor) {
    const cursorDate = new Date(cursor.createdAt);
    clauses.push({
      $or: [{ createdAt: { $lt: cursorDate } }, { createdAt: cursorDate, _id: { $lt: cursor.id } }],
    });
  }

  if (clauses.length > 0) {
    filter.$and = clauses;
  }

  return filter;
}

async function findEvalListPage<TDoc extends EvalListDoc>(
  model: EvalListModel<TDoc>,
  tenantId: string,
  projectId: string,
  select: string,
  options: EvalListOptions = {},
): Promise<EvalListResult<Record<string, unknown>>> {
  const normalizedOptions = normalizeListOptions(options);
  const filter = buildEvalListFilter(tenantId, projectId, normalizedOptions);
  const countFilter = buildEvalListFilter(tenantId, projectId, normalizedOptions, false);
  const [docs, total] = await Promise.all([
    model
      .find(filter)
      .select(select)
      .sort({ createdAt: -1, _id: -1 })
      .limit(normalizedOptions.limit + 1)
      .lean(),
    model.countDocuments(countFilter),
  ]);

  const hasMore = docs.length > normalizedOptions.limit;
  const pageDocs = hasMore ? docs.slice(0, normalizedOptions.limit) : docs;
  const nextCursor =
    hasMore && pageDocs.length > 0 ? encodeEvalListCursor(pageDocs[pageDocs.length - 1]) : null;

  return {
    items: normalizeIds(pageDocs),
    pagination: {
      limit: normalizedOptions.limit,
      nextCursor,
      hasMore,
      total,
    },
  };
}

// ─── Protected Field Stripping ───────────────────────────────────────────

/** Remove fields that must not be overwritten via $set (system-managed fields). */
function stripProtected(data: Record<string, unknown>): Record<string, unknown> {
  const {
    version: _ver,
    _v: _vv,
    _id: _id,
    tenantId: _t,
    projectId: _p,
    createdBy: _cb,
    createdAt: _ca,
    updatedAt: _ua,
    status: _st,
    startedAt: _sa,
    completedAt: _coa,
    ...safe
  } = data;
  return safe;
}

// ─── Reference Check ─────────────────────────────────────────────────────

/**
 * Check if an entity (persona/scenario/evaluator) is referenced by any eval set.
 * Returns list of referencing eval set names, or empty array if unreferenced.
 */
async function findReferencingEvalSets(
  tenantId: string,
  projectId: string,
  field: 'personaIds' | 'scenarioIds' | 'evaluatorIds',
  entityId: string,
): Promise<string[]> {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');
  const sets = await EvalSet.find({ tenantId, projectId, [field]: entityId })
    .select('name')
    .lean();
  return sets.map((s) => s.name);
}

/** Throw 409 if entity is still referenced by eval sets. */
async function guardDeletion(
  tenantId: string,
  projectId: string,
  field: 'personaIds' | 'scenarioIds' | 'evaluatorIds',
  entityId: string,
) {
  const refs = await findReferencingEvalSets(tenantId, projectId, field, entityId);
  if (refs.length > 0) {
    const err = new Error(`Cannot delete: referenced by eval sets: ${refs.join(', ')}`);
    (err as Error & { statusCode: number }).statusCode = 409;
    throw err;
  }
}

// =============================================================================
// PERSONAS
// =============================================================================

export async function findPersonasByProject(projectId: string, tenantId: string) {
  await ensureDb();
  const { EvalPersona } = await import('@agent-platform/database/models');
  const docs = await EvalPersona.find({ tenantId, projectId })
    .select(
      '_id name description communicationStyle domainKnowledge behaviorTraits goals constraints sessionVariables isAdversarial isBuiltIn source version createdAt',
    )
    .sort({ createdAt: -1 })
    .limit(EVAL_LIST_DEFAULT_PAGE_SIZE)
    .lean();
  return normalizeIds(docs);
}

export async function findPersonasPageByProject(
  projectId: string,
  tenantId: string,
  options: EvalListOptions = {},
) {
  await ensureDb();
  const { EvalPersona } = await import('@agent-platform/database/models');
  return findEvalListPage(
    EvalPersona as unknown as EvalListModel<EvalListDoc>,
    tenantId,
    projectId,
    '_id name description communicationStyle domainKnowledge behaviorTraits goals constraints sessionVariables isAdversarial isBuiltIn source version createdAt',
    options,
  );
}

export async function findPersonaById(id: string, tenantId: string, projectId: string) {
  await ensureDb();
  const { EvalPersona } = await import('@agent-platform/database/models');
  const doc = await EvalPersona.findOne({ _id: id, tenantId, projectId }).lean();
  return normalizeId(doc);
}

export async function createPersona(data: Record<string, unknown>) {
  await ensureDb();
  const { EvalPersona } = await import('@agent-platform/database/models');
  const doc = await EvalPersona.create(data);
  return normalizeId(doc.toObject());
}

export async function updatePersona(
  id: string,
  tenantId: string,
  projectId: string,
  data: Record<string, unknown>,
) {
  await ensureDb();
  const { EvalPersona } = await import('@agent-platform/database/models');
  const doc = await EvalPersona.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: stripProtected(data), $inc: { version: 1, _v: 1 } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

export async function deletePersona(id: string, tenantId: string, projectId: string) {
  await guardDeletion(tenantId, projectId, 'personaIds', id);
  await ensureDb();
  const { EvalPersona } = await import('@agent-platform/database/models');
  return EvalPersona.findOneAndDelete({ _id: id, tenantId, projectId });
}

// =============================================================================
// SCENARIOS
// =============================================================================

export async function findScenariosByProject(projectId: string, tenantId: string) {
  await ensureDb();
  const { EvalScenario } = await import('@agent-platform/database/models');
  const docs = await EvalScenario.find({ tenantId, projectId })
    .select(
      '_id name description category difficulty entryAgent initialMessage expectedOutcome maxTurns tags agentPath expectedMilestones version createdAt',
    )
    .sort({ createdAt: -1 })
    .limit(EVAL_LIST_DEFAULT_PAGE_SIZE)
    .lean();
  return normalizeIds(docs);
}

export async function findScenariosPageByProject(
  projectId: string,
  tenantId: string,
  options: EvalListOptions = {},
) {
  await ensureDb();
  const { EvalScenario } = await import('@agent-platform/database/models');
  return findEvalListPage(
    EvalScenario as unknown as EvalListModel<EvalListDoc>,
    tenantId,
    projectId,
    '_id name description category difficulty entryAgent initialMessage expectedOutcome maxTurns tags agentPath expectedMilestones version createdAt',
    options,
  );
}

export async function findScenarioById(id: string, tenantId: string, projectId: string) {
  await ensureDb();
  const { EvalScenario } = await import('@agent-platform/database/models');
  const doc = await EvalScenario.findOne({ _id: id, tenantId, projectId }).lean();
  return normalizeId(doc);
}

export async function createScenario(data: Record<string, unknown>) {
  await ensureDb();
  const { EvalScenario } = await import('@agent-platform/database/models');
  const doc = await EvalScenario.create(data);
  return normalizeId(doc.toObject());
}

export async function updateScenario(
  id: string,
  tenantId: string,
  projectId: string,
  data: Record<string, unknown>,
) {
  await ensureDb();
  const { EvalScenario } = await import('@agent-platform/database/models');
  const doc = await EvalScenario.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: stripProtected(data), $inc: { version: 1, _v: 1 } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

export async function deleteScenario(id: string, tenantId: string, projectId: string) {
  await guardDeletion(tenantId, projectId, 'scenarioIds', id);
  await ensureDb();
  const { EvalScenario } = await import('@agent-platform/database/models');
  return EvalScenario.findOneAndDelete({ _id: id, tenantId, projectId });
}

// =============================================================================
// EVALUATORS
// =============================================================================

export async function findEvaluatorsByProject(projectId: string, tenantId: string) {
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  const docs = await EvalEvaluator.find({ tenantId, projectId })
    .select(
      '_id name description type category judgeModel judgePrompt temperature scoringRubric biasSettings trajectoryMetrics chainOfThought isBuiltIn version createdAt',
    )
    .sort({ createdAt: -1 })
    .limit(EVAL_LIST_DEFAULT_PAGE_SIZE)
    .lean();
  return normalizeIds(docs);
}

export async function findEvaluatorsPageByProject(
  projectId: string,
  tenantId: string,
  options: EvalListOptions = {},
) {
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  return findEvalListPage(
    EvalEvaluator as unknown as EvalListModel<EvalListDoc>,
    tenantId,
    projectId,
    '_id name description type category judgeModel judgePrompt temperature scoringRubric biasSettings trajectoryMetrics chainOfThought isBuiltIn version createdAt',
    options,
  );
}

export async function findEvaluatorById(id: string, tenantId: string, projectId: string) {
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  const doc = await EvalEvaluator.findOne({ _id: id, tenantId, projectId }).lean();
  return normalizeId(doc);
}

export async function findEvalCaseEntitySummaries(
  tenantId: string,
  projectId: string,
  ids: EvalCaseEntitySummaryIds,
): Promise<EvalCaseEntitySummaries> {
  await ensureDb();
  const { EvalPersona, EvalScenario, EvalEvaluator } =
    await import('@agent-platform/database/models');

  const personaIds = uniqueNonEmpty(ids.personaIds);
  const scenarioIds = uniqueNonEmpty(ids.scenarioIds);
  const evaluatorIds = uniqueNonEmpty(ids.evaluatorIds);

  const [personas, scenarios, evaluators] = await Promise.all([
    personaIds.length
      ? EvalPersona.find({ _id: { $in: personaIds }, tenantId, projectId })
          .select('_id name')
          .lean()
      : [],
    scenarioIds.length
      ? EvalScenario.find({ _id: { $in: scenarioIds }, tenantId, projectId })
          .select('_id name expectedMilestones agentPath')
          .lean()
      : [],
    evaluatorIds.length
      ? EvalEvaluator.find({ _id: { $in: evaluatorIds }, tenantId, projectId })
          .select('_id name')
          .lean()
      : [],
  ]);

  return {
    personasById: new Map(personas.map((persona) => [String(persona._id), { name: persona.name }])),
    scenariosById: new Map(
      scenarios.map((scenario) => [
        String(scenario._id),
        {
          name: scenario.name,
          expectedMilestones: scenario.expectedMilestones ?? [],
          agentPath: scenario.agentPath ?? [],
        },
      ]),
    ),
    evaluatorsById: new Map(
      evaluators.map((evaluator) => [String(evaluator._id), { name: evaluator.name }]),
    ),
  };
}

export async function createEvaluator(data: Record<string, unknown>) {
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  const doc = await EvalEvaluator.create(data);
  return normalizeId(doc.toObject());
}

export async function updateEvaluator(
  id: string,
  tenantId: string,
  projectId: string,
  data: Record<string, unknown>,
) {
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  const doc = await EvalEvaluator.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: stripProtected(data), $inc: { version: 1, _v: 1 } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

export async function deleteEvaluator(id: string, tenantId: string, projectId: string) {
  await guardDeletion(tenantId, projectId, 'evaluatorIds', id);
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  return EvalEvaluator.findOneAndDelete({ _id: id, tenantId, projectId });
}

// When a project model config is deleted, any evaluator that had it set as
// judgeModel retains a stale modelId string that will fail preflight. This
// clears those references so evaluators fall through to the project/tenant
// default at runtime.
export async function clearStaleJudgeModelRefs(
  tenantId: string,
  projectId: string,
  modelId: string,
): Promise<number> {
  await ensureDb();
  const { EvalEvaluator } = await import('@agent-platform/database/models');
  const result = await EvalEvaluator.updateMany(
    { tenantId, projectId, judgeModel: modelId },
    { $unset: { judgeModel: 1 } },
  );
  return result.modifiedCount;
}

// =============================================================================
// EVAL SETS
// =============================================================================

/**
 * Resolve IDs → { id: name } maps for denormalized EvalSet name fields.
 * Also validates that all referenced IDs exist. Throws if any are missing.
 */
async function resolveEvalSetNames(
  tenantId: string,
  projectId: string,
  personaIds: string[],
  scenarioIds: string[],
  evaluatorIds: string[],
) {
  await ensureDb();
  const { EvalPersona, EvalScenario, EvalEvaluator } =
    await import('@agent-platform/database/models');

  const [personas, scenarios, evaluators] = await Promise.all([
    personaIds.length
      ? EvalPersona.find({ _id: { $in: personaIds }, tenantId, projectId })
          .select('_id name')
          .lean()
      : [],
    scenarioIds.length
      ? EvalScenario.find({ _id: { $in: scenarioIds }, tenantId, projectId })
          .select('_id name')
          .lean()
      : [],
    evaluatorIds.length
      ? EvalEvaluator.find({ _id: { $in: evaluatorIds }, tenantId, projectId })
          .select('_id name')
          .lean()
      : [],
  ]);

  // Validate all referenced IDs exist
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const foundIds = (docs: any[]) => new Set(docs.map((d) => String(d._id)));
  const missing: string[] = [];
  const pFound = foundIds(personas);
  personaIds.forEach((id) => {
    if (!pFound.has(id)) missing.push(`persona:${id}`);
  });
  const sFound = foundIds(scenarios);
  scenarioIds.forEach((id) => {
    if (!sFound.has(id)) missing.push(`scenario:${id}`);
  });
  const eFound = foundIds(evaluators);
  evaluatorIds.forEach((id) => {
    if (!eFound.has(id)) missing.push(`evaluator:${id}`);
  });
  if (missing.length > 0) {
    const err = new Error(`Referenced entities not found: ${missing.join(', ')}`);
    (err as Error & { statusCode: number }).statusCode = 400;
    throw err;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toMap = (docs: any[]) => Object.fromEntries(docs.map((d) => [d._id, d.name]));
  return {
    _personaNames: toMap(personas),
    _scenarioNames: toMap(scenarios),
    _evaluatorNames: toMap(evaluators),
  };
}

export async function findEvalSetsByProject(projectId: string, tenantId: string) {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');
  const docs = await EvalSet.find({ tenantId, projectId })
    .select(
      '_id name description personaIds scenarioIds evaluatorIds variants ciEnabled _personaNames _scenarioNames _evaluatorNames createdAt',
    )
    .sort({ createdAt: -1 })
    .limit(EVAL_LIST_DEFAULT_PAGE_SIZE)
    .lean();
  return normalizeIds(docs);
}

export async function findEvalSetsPageByProject(
  projectId: string,
  tenantId: string,
  options: EvalListOptions = {},
) {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');
  return findEvalListPage(
    EvalSet as unknown as EvalListModel<EvalListDoc>,
    tenantId,
    projectId,
    '_id name description personaIds scenarioIds evaluatorIds variants ciEnabled _personaNames _scenarioNames _evaluatorNames createdAt',
    options,
  );
}

export async function findEvalSetById(id: string, tenantId: string, projectId: string) {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');
  const doc = await EvalSet.findOne({ _id: id, tenantId, projectId }).lean();
  return normalizeId(doc);
}

export async function createEvalSet(data: Record<string, unknown>) {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');
  const names = await resolveEvalSetNames(
    data.tenantId as string,
    data.projectId as string,
    (data.personaIds as string[]) || [],
    (data.scenarioIds as string[]) || [],
    (data.evaluatorIds as string[]) || [],
  );
  const doc = await EvalSet.create({ ...data, ...names });
  return normalizeId(doc.toObject());
}

export async function updateEvalSet(
  id: string,
  tenantId: string,
  projectId: string,
  data: Record<string, unknown>,
) {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');

  // Re-resolve names if any ID array was updated
  const hasIdChange = data.personaIds || data.scenarioIds || data.evaluatorIds;
  let nameUpdate: Record<string, unknown> = {};
  if (hasIdChange) {
    // Fetch current doc to fill in unchanged ID arrays
    const current = await EvalSet.findOne({ _id: id, tenantId, projectId })
      .select('personaIds scenarioIds evaluatorIds')
      .lean();
    if (current) {
      nameUpdate = await resolveEvalSetNames(
        tenantId,
        projectId,
        (data.personaIds as string[]) || current.personaIds,
        (data.scenarioIds as string[]) || current.scenarioIds,
        (data.evaluatorIds as string[]) || current.evaluatorIds,
      );
    }
  }

  const doc = await EvalSet.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: { ...stripProtected(data), ...nameUpdate }, $inc: { _v: 1 } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}

export async function deleteEvalSet(id: string, tenantId: string, projectId: string) {
  await ensureDb();
  const { EvalSet } = await import('@agent-platform/database/models');
  return EvalSet.findOneAndDelete({ _id: id, tenantId, projectId });
}

// =============================================================================
// RUNS
// =============================================================================

export async function findRunsByProject(projectId: string, tenantId: string) {
  await ensureDb();
  const { EvalRun } = await import('@agent-platform/database/models');
  const docs = await EvalRun.find({ tenantId, projectId })
    .select(
      '_id name evalSetId status triggerSource knownSource triggeredBy summary regressionDetected archived archivedAt archivedReason startedAt completedAt createdAt',
    )
    .sort({ createdAt: -1 })
    .limit(EVAL_LIST_DEFAULT_PAGE_SIZE)
    .lean();
  return normalizeIds(docs);
}

export async function findRunsPageByProject(
  projectId: string,
  tenantId: string,
  options: EvalListOptions = {},
) {
  await ensureDb();
  const { EvalRun } = await import('@agent-platform/database/models');
  return findEvalListPage(
    EvalRun as unknown as EvalListModel<EvalListDoc>,
    tenantId,
    projectId,
    '_id name evalSetId status triggerSource knownSource triggeredBy summary regressionDetected archived archivedAt archivedReason startedAt completedAt createdAt',
    options,
  );
}

export async function findRunById(id: string, tenantId: string, projectId: string) {
  await ensureDb();
  const { EvalRun } = await import('@agent-platform/database/models');
  const doc = await EvalRun.findOne({ _id: id, tenantId, projectId }).lean();
  return normalizeId(doc);
}

export async function createRun(data: Record<string, unknown>) {
  await ensureDb();
  const { EvalRun } = await import('@agent-platform/database/models');
  const doc = await EvalRun.create(data);
  return normalizeId(doc.toObject());
}

export async function updateRun(
  id: string,
  tenantId: string,
  projectId: string,
  data: Record<string, unknown>,
) {
  await ensureDb();
  const { EvalRun } = await import('@agent-platform/database/models');
  const doc = await EvalRun.findOneAndUpdate(
    { _id: id, tenantId, projectId },
    { $set: stripProtected(data), $inc: { _v: 1 } },
    { new: true },
  ).lean();
  return normalizeId(doc);
}
