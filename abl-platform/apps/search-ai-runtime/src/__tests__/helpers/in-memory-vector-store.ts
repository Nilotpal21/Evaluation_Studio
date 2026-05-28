/**
 * In-Memory Vector Store for Testing
 *
 * Implements VectorStoreProvider using a Map-based store with cosine similarity search.
 * Supports metadata filtering and all basic operations.
 */

import type {
  VectorStoreProvider,
  VectorRecord,
  VectorSearchParams,
  VectorSearchResult,
  CollectionConfig,
  CollectionInfo,
} from '@agent-platform/search-ai-internal/vector-store';
import type { MetadataFilter } from '@agent-platform/search-ai-sdk';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    magA = 0,
    magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Resolve a dot-notation path (e.g. 'sys.appId') against a nested object.
 * Falls back to direct key lookup for flat fields.
 */
function getNestedValue(obj: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined; // guard against non-MetadataFilter objects (e.g. OpenSearch DSL bool clauses)
  if (path in obj) return obj[path]; // fast path for flat fields
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchesFilters(
  metadata: Record<string, unknown> | undefined,
  filters: MetadataFilter[],
): boolean {
  if (!metadata) return filters.length === 0;

  for (const filter of filters) {
    const value = getNestedValue(metadata, filter.field);
    switch (filter.operator) {
      case 'eq':
        if (value !== filter.value) return false;
        break;
      case 'neq':
        if (value === filter.value) return false;
        break;
      case 'gt':
        if (typeof value !== 'number' || value <= (filter.value as number)) return false;
        break;
      case 'gte':
        if (typeof value !== 'number' || value < (filter.value as number)) return false;
        break;
      case 'lt':
        if (typeof value !== 'number' || value >= (filter.value as number)) return false;
        break;
      case 'lte':
        if (typeof value !== 'number' || value > (filter.value as number)) return false;
        break;
      case 'in':
        if (!Array.isArray(filter.value) || !(filter.value as unknown[]).includes(value))
          return false;
        break;
      case 'not_in':
        if (Array.isArray(filter.value) && (filter.value as unknown[]).includes(value))
          return false;
        break;
      case 'contains':
        if (typeof value !== 'string' || !value.includes(filter.value as string)) return false;
        break;
      case 'not_contains':
        if (typeof value === 'string' && value.includes(filter.value as string)) return false;
        break;
      case 'exists':
        if (value === undefined || value === null) return false;
        break;
      case 'not_exists':
        if (value !== undefined && value !== null) return false;
        break;
    }
  }
  return true;
}

interface InMemoryQueryHit {
  id: string;
  score: number;
  source: Record<string, unknown>;
}

interface InMemoryScoredRecord {
  record: VectorRecord;
  hit: InMemoryQueryHit;
}

function toClauseArray(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
    );
  }
  if (typeof value === 'object') {
    return [value as Record<string, unknown>];
  }
  return [];
}

function stripKeywordSuffix(path: string): string {
  return path.endsWith('.keyword') ? path.slice(0, -'.keyword'.length) : path;
}

function getSourceValue(source: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;

  const normalized = stripKeywordSuffix(path);
  const directValue = getNestedValue(source, normalized);
  if (directValue !== undefined) return directValue;

  // OpenSearch queries sometimes refer to logical field names without the
  // nested metadata prefix. Mirror the common search-runtime fallbacks here.
  if (!normalized.includes('.')) {
    const canonicalValue = getNestedValue(source, `metadata.canonical.${normalized}`);
    if (canonicalValue !== undefined) return canonicalValue;

    const metadataValue = getNestedValue(source, `metadata.${normalized}`);
    if (metadataValue !== undefined) return metadataValue;
  }

  return directValue;
}

function normalizeText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).join(' ');
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map((item) => normalizeText(item))
      .join(' ');
  }
  return '';
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function parseBoostedField(field: string): { path: string; boost: number } {
  const [path, rawBoost] = field.split('^');
  const boost = rawBoost ? Number(rawBoost) : 1;
  return {
    path,
    boost: Number.isFinite(boost) && boost > 0 ? boost : 1,
  };
}

function scoreTextMatch(
  haystack: unknown,
  query: string,
  options?: { operator?: 'and' | 'or'; phrase?: boolean },
): number {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;

  const text = normalizeText(haystack).toLowerCase();
  if (!text) return 0;

  if (options?.phrase) {
    return text.includes(normalizedQuery) ? 2 : 0;
  }

  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) {
    return text.includes(normalizedQuery) ? 1 : 0;
  }

  const textTokens = new Set(tokenize(text));
  const matchedTokens = queryTokens.filter((token) => textTokens.has(token)).length;
  const operator = options?.operator ?? 'or';

  if (operator === 'and' && matchedTokens < queryTokens.length) {
    return 0;
  }

  if (matchedTokens === 0) {
    return 0;
  }

  const exactPhraseBonus = text.includes(normalizedQuery) ? 1 : 0;
  return matchedTokens / queryTokens.length + exactPhraseBonus;
}

function sameScalar(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return false;
}

function matchesTermValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => sameScalar(item, expected));
  }
  return sameScalar(actual, expected);
}

function matchesTermsValue(actual: unknown, expected: unknown[]): boolean {
  if (Array.isArray(actual)) {
    return actual.some((item) => expected.some((candidate) => sameScalar(item, candidate)));
  }
  return expected.some((candidate) => sameScalar(actual, candidate));
}

function coerceComparable(value: unknown): number | string | null {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) return numeric;

    const timestamp = Date.parse(trimmed);
    if (!Number.isNaN(timestamp)) return timestamp;

    return trimmed.toLowerCase();
  }
  return null;
}

function compareRangeValue(
  actual: unknown,
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  expected: unknown,
) {
  const actualComparable = coerceComparable(actual);
  const expectedComparable = coerceComparable(expected);
  if (actualComparable == null || expectedComparable == null) return false;
  if (typeof actualComparable !== typeof expectedComparable) return false;

  switch (operator) {
    case 'gt':
      return actualComparable > expectedComparable;
    case 'gte':
      return actualComparable >= expectedComparable;
    case 'lt':
      return actualComparable < expectedComparable;
    case 'lte':
      return actualComparable <= expectedComparable;
  }
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

function matchesWildcard(actual: unknown, pattern: string, caseInsensitive: boolean): boolean {
  const values = Array.isArray(actual) ? actual : [actual];
  const regex = wildcardToRegExp(pattern);

  return values.some((value) => {
    if (value == null) return false;
    const text = normalizeText(value);
    if (!text) return false;

    return caseInsensitive ? regex.test(text.toLowerCase()) : regex.test(text);
  });
}

function buildSource(record: VectorRecord): Record<string, unknown> {
  return {
    vector: record.vector,
    metadata: record.metadata ?? {},
    content: record.content ?? '',
    ...(record.permissions ? { permissions: record.permissions } : {}),
  };
}

function evaluateBoolClause(
  record: VectorRecord,
  source: Record<string, unknown>,
  boolClause: Record<string, unknown>,
  filterMode: boolean,
): number | null {
  const mustClauses = toClauseArray(boolClause.must);
  const filterClauses = toClauseArray(boolClause.filter);
  const shouldClauses = toClauseArray(boolClause.should);
  const mustNotClauses = toClauseArray(boolClause.must_not);

  for (const clause of mustNotClauses) {
    if (evaluateQueryClause(record, source, clause, true) !== null) {
      return null;
    }
  }

  for (const clause of filterClauses) {
    if (evaluateQueryClause(record, source, clause, true) === null) {
      return null;
    }
  }

  let score = 0;
  let hasScoringClause = false;

  for (const clause of mustClauses) {
    const clauseScore = evaluateQueryClause(record, source, clause, filterMode);
    if (clauseScore === null) {
      return null;
    }
    if (!filterMode) {
      score += clauseScore;
      hasScoringClause = true;
    }
  }

  let matchedShouldClauses = 0;
  for (const clause of shouldClauses) {
    const clauseScore = evaluateQueryClause(record, source, clause, filterMode);
    if (clauseScore !== null) {
      matchedShouldClauses += 1;
      if (!filterMode) {
        score += clauseScore;
        hasScoringClause = true;
      }
    }
  }

  const minimumShouldMatch =
    typeof boolClause.minimum_should_match === 'number'
      ? boolClause.minimum_should_match
      : boolClause.minimum_should_match !== undefined
        ? Number(boolClause.minimum_should_match)
        : mustClauses.length === 0 && filterClauses.length === 0 && shouldClauses.length > 0
          ? 1
          : 0;

  if (matchedShouldClauses < minimumShouldMatch) {
    return null;
  }

  if (filterMode) {
    return 1;
  }

  return hasScoringClause ? score : 1;
}

function evaluateQueryClause(
  record: VectorRecord,
  source: Record<string, unknown>,
  clause: Record<string, unknown> | undefined,
  filterMode = false,
): number | null {
  if (!clause) return 1;

  if ('match_all' in clause) {
    return 1;
  }

  if ('ids' in clause && typeof clause.ids === 'object' && clause.ids !== null) {
    const values = Array.isArray((clause.ids as Record<string, unknown>).values)
      ? ((clause.ids as Record<string, unknown>).values as unknown[]).map(String)
      : [];
    return values.includes(record.id) ? 1 : null;
  }

  if ('term' in clause && typeof clause.term === 'object' && clause.term !== null) {
    const [field, expected] = Object.entries(clause.term as Record<string, unknown>)[0] ?? [];
    if (!field) return null;
    return matchesTermValue(getSourceValue(source, field), expected) ? 1 : null;
  }

  if ('terms' in clause && typeof clause.terms === 'object' && clause.terms !== null) {
    const [field, rawExpected] = Object.entries(clause.terms as Record<string, unknown>)[0] ?? [];
    if (!field || !Array.isArray(rawExpected)) return null;
    return matchesTermsValue(getSourceValue(source, field), rawExpected) ? 1 : null;
  }

  if ('range' in clause && typeof clause.range === 'object' && clause.range !== null) {
    const [field, rawRange] = Object.entries(clause.range as Record<string, unknown>)[0] ?? [];
    if (!field || typeof rawRange !== 'object' || rawRange === null) return null;

    const actualValue = getSourceValue(source, field);
    const rangeSpec = rawRange as Record<string, unknown>;
    const operators: Array<'gt' | 'gte' | 'lt' | 'lte'> = ['gt', 'gte', 'lt', 'lte'];

    const matchesAll = operators.every((operator) => {
      if (!(operator in rangeSpec)) return true;
      return compareRangeValue(actualValue, operator, rangeSpec[operator]);
    });

    return matchesAll ? 1 : null;
  }

  if ('exists' in clause && typeof clause.exists === 'object' && clause.exists !== null) {
    const field = String((clause.exists as Record<string, unknown>).field ?? '');
    const value = getSourceValue(source, field);
    return value !== undefined && value !== null ? 1 : null;
  }

  if ('wildcard' in clause && typeof clause.wildcard === 'object' && clause.wildcard !== null) {
    const [field, rawWildcard] =
      Object.entries(clause.wildcard as Record<string, unknown>)[0] ?? [];
    if (!field || rawWildcard == null) return null;

    const spec =
      typeof rawWildcard === 'object'
        ? (rawWildcard as Record<string, unknown>)
        : { value: rawWildcard };
    const pattern = String(spec.value ?? '');
    const caseInsensitive = spec.case_insensitive === true;

    return matchesWildcard(getSourceValue(source, field), pattern, caseInsensitive) ? 1 : null;
  }

  if (
    'match_phrase' in clause &&
    typeof clause.match_phrase === 'object' &&
    clause.match_phrase !== null
  ) {
    const [field, rawValue] =
      Object.entries(clause.match_phrase as Record<string, unknown>)[0] ?? [];
    if (!field || rawValue == null) return null;

    const spec =
      typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : { query: rawValue };
    const score = scoreTextMatch(getSourceValue(source, field), String(spec.query ?? ''), {
      operator: 'and',
      phrase: true,
    });
    return score > 0 ? score : null;
  }

  if ('match' in clause && typeof clause.match === 'object' && clause.match !== null) {
    const [field, rawValue] = Object.entries(clause.match as Record<string, unknown>)[0] ?? [];
    if (!field || rawValue == null) return null;

    const spec =
      typeof rawValue === 'object' ? (rawValue as Record<string, unknown>) : { query: rawValue };
    const score = scoreTextMatch(getSourceValue(source, field), String(spec.query ?? ''), {
      operator: spec.operator === 'and' ? 'and' : 'or',
    });
    return score > 0 ? score : null;
  }

  if (
    'multi_match' in clause &&
    typeof clause.multi_match === 'object' &&
    clause.multi_match !== null
  ) {
    const spec = clause.multi_match as Record<string, unknown>;
    const fields = Array.isArray(spec.fields)
      ? (spec.fields as unknown[]).map(String)
      : ['content'];
    const operator = spec.operator === 'and' ? 'and' : 'or';
    const query = String(spec.query ?? '');

    let bestScore = 0;
    for (const field of fields) {
      const { path, boost } = parseBoostedField(field);
      const score = scoreTextMatch(getSourceValue(source, path), query, { operator }) * boost;
      if (score > bestScore) {
        bestScore = score;
      }
    }

    return bestScore > 0 ? bestScore : null;
  }

  if ('bool' in clause && typeof clause.bool === 'object' && clause.bool !== null) {
    return evaluateBoolClause(record, source, clause.bool as Record<string, unknown>, filterMode);
  }

  if ('knn' in clause && typeof clause.knn === 'object' && clause.knn !== null) {
    const [fieldName, rawSpec] = Object.entries(clause.knn as Record<string, unknown>)[0] ?? [];
    if (!fieldName || typeof rawSpec !== 'object' || rawSpec === null) return null;

    const spec = rawSpec as Record<string, unknown>;
    const vector = Array.isArray(spec.vector) ? spec.vector.map(Number) : [];
    if (vector.length === 0) return null;

    if (
      spec.filter &&
      typeof spec.filter === 'object' &&
      evaluateQueryClause(record, source, spec.filter as Record<string, unknown>, true) === null
    ) {
      return null;
    }

    return cosineSimilarity(vector, record.vector);
  }

  return 1;
}

type AggregationMetricName = 'sum' | 'avg' | 'min' | 'max' | 'count_distinct' | 'cardinality';

function getDirectAggregationMetric(
  aggregation: Record<string, unknown>,
): { name: AggregationMetricName; field: string } | null {
  const supportedMetrics: AggregationMetricName[] = [
    'sum',
    'avg',
    'min',
    'max',
    'count_distinct',
    'cardinality',
  ];

  for (const metricName of supportedMetrics) {
    const metric = aggregation[metricName];
    if (!metric || typeof metric !== 'object' || metric === null) continue;

    const field = String((metric as Record<string, unknown>).field ?? '');
    if (field) {
      return { name: metricName, field };
    }
  }

  return null;
}

function getAggregationMetric(
  aggregation: Record<string, unknown>,
): { name: AggregationMetricName; field: string } | null {
  if (!aggregation.aggs || typeof aggregation.aggs !== 'object' || aggregation.aggs === null) {
    return null;
  }

  const metricValue = (aggregation.aggs as Record<string, unknown>).metric_value;
  if (!metricValue || typeof metricValue !== 'object' || metricValue === null) {
    return null;
  }

  const supportedMetrics: AggregationMetricName[] = [
    'sum',
    'avg',
    'min',
    'max',
    'count_distinct',
    'cardinality',
  ];

  for (const metricName of supportedMetrics) {
    const metric = (metricValue as Record<string, unknown>)[metricName];
    if (!metric || typeof metric !== 'object' || metric === null) continue;

    const field = String((metric as Record<string, unknown>).field ?? '');
    if (field) {
      return { name: metricName, field };
    }
  }

  return null;
}

function aggregationFieldBase(path: string): string {
  return stripKeywordSuffix(path)
    .replace(/^metadata\.canonical\./, '')
    .replace(/^metadata\./, '');
}

function computeAggregationMetric(
  docs: InMemoryScoredRecord[],
  metric: { name: AggregationMetricName; field: string },
): number {
  const rawValues = docs
    .map((doc) => getSourceValue(doc.hit.source, metric.field))
    .filter((value) => value !== undefined && value !== null);

  if (metric.name === 'count_distinct' || metric.name === 'cardinality') {
    const distinctValues = new Set(
      rawValues.map((value) =>
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value),
      ),
    );
    return distinctValues.size;
  }

  const numericValues = rawValues
    .map((value) => (typeof value === 'number' ? value : Number(value)))
    .filter((value) => Number.isFinite(value));

  if (numericValues.length === 0) {
    return 0;
  }

  switch (metric.name) {
    case 'sum':
      return numericValues.reduce((sum, value) => sum + value, 0);
    case 'avg':
      return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
    case 'min':
      return Math.min(...numericValues);
    case 'max':
      return Math.max(...numericValues);
    case 'count_distinct':
    case 'cardinality':
      return 0;
  }
}

export class InMemoryVectorStore implements VectorStoreProvider {
  readonly name = 'in-memory';
  private collections = new Map<string, Map<string, VectorRecord>>();
  private configs = new Map<string, CollectionConfig>();

  async createCollection(config: CollectionConfig): Promise<void> {
    this.collections.set(config.name, new Map());
    this.configs.set(config.name, config);
  }

  async deleteCollection(name: string): Promise<void> {
    this.collections.delete(name);
    this.configs.delete(name);
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo | null> {
    const coll = this.collections.get(name);
    const config = this.configs.get(name);
    if (!coll) return null;
    return {
      name,
      vectorCount: coll.size,
      dimensions: config?.dimensions ?? 0,
      distance: config?.distance ?? 'cosine',
      status: 'ready',
    };
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name);
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    let coll = this.collections.get(collection);
    if (!coll) {
      coll = new Map();
      this.collections.set(collection, coll);
    }
    for (const record of records) {
      coll.set(record.id, record);
    }
  }

  async search(collection: string, params: VectorSearchParams): Promise<VectorSearchResult[]> {
    const coll = this.collections.get(collection);
    if (!coll) return [];

    const results: VectorSearchResult[] = [];
    for (const record of coll.values()) {
      const score = cosineSimilarity(params.vector, record.vector);
      if (params.scoreThreshold && score < params.scoreThreshold) continue;
      if (params.filters && !matchesFilters(record.metadata, params.filters)) continue;

      results.push({
        id: record.id,
        score,
        metadata: params.includeMetadata !== false ? record.metadata : undefined,
        vector: params.includeVectors ? record.vector : undefined,
        content: record.content,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, params.topK);
  }

  async executeQuery(
    collection: string,
    body: Record<string, unknown>,
  ): Promise<{
    hits: Array<{ id: string; score: number; source: Record<string, unknown> }>;
    aggregations?: Record<string, unknown>;
    total: number;
  }> {
    const coll = this.collections.get(collection);
    if (!coll) {
      return { hits: [], aggregations: undefined, total: 0 };
    }

    const queryClause =
      typeof body.query === 'object' && body.query !== null
        ? (body.query as Record<string, unknown>)
        : { match_all: {} };
    const postFilter =
      typeof body.post_filter === 'object' && body.post_filter !== null
        ? (body.post_filter as Record<string, unknown>)
        : undefined;
    const minScore =
      typeof body.min_score === 'number'
        ? body.min_score
        : body.min_score !== undefined
          ? Number(body.min_score)
          : undefined;

    let scoredRecords: InMemoryScoredRecord[] = Array.from(coll.values())
      .map((record) => {
        const source = buildSource(record);
        const score = evaluateQueryClause(record, source, queryClause);
        if (score === null) return null;

        return {
          record,
          hit: {
            id: record.id,
            score,
            source,
          },
        };
      })
      .filter((record): record is InMemoryScoredRecord => record !== null);

    if (postFilter) {
      scoredRecords = scoredRecords.filter(
        ({ record, hit }) => evaluateQueryClause(record, hit.source, postFilter, true) !== null,
      );
    }

    if (minScore !== undefined && Number.isFinite(minScore)) {
      scoredRecords = scoredRecords.filter(({ hit }) => hit.score >= minScore);
    }

    scoredRecords.sort((a, b) => {
      if (b.hit.score !== a.hit.score) {
        return b.hit.score - a.hit.score;
      }
      return a.hit.id.localeCompare(b.hit.id);
    });

    const aggregations =
      body.aggs && typeof body.aggs === 'object' && body.aggs !== null
        ? this.buildAggregations(scoredRecords, body.aggs as Record<string, unknown>)
        : undefined;

    const from =
      typeof body.from === 'number' ? body.from : body.from !== undefined ? Number(body.from) : 0;
    const size =
      typeof body.size === 'number' ? body.size : body.size !== undefined ? Number(body.size) : 10;

    const start = Number.isFinite(from) && from > 0 ? from : 0;
    const end = Number.isFinite(size) && size >= 0 ? start + size : scoredRecords.length;
    const hits = scoredRecords.slice(start, end).map(({ hit }) => hit);

    return {
      hits,
      aggregations,
      total: scoredRecords.length,
    };
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const coll = this.collections.get(collection);
    if (!coll) return;
    for (const id of ids) {
      coll.delete(id);
    }
  }

  async deleteByFilter(collection: string, filters: MetadataFilter[]): Promise<void> {
    const coll = this.collections.get(collection);
    if (!coll) return;
    for (const [id, record] of coll.entries()) {
      if (matchesFilters(record.metadata, filters)) {
        coll.delete(id);
      }
    }
  }

  async getByIds(collection: string, ids: string[]): Promise<VectorRecord[]> {
    const coll = this.collections.get(collection);
    if (!coll) return [];
    return ids.map((id) => coll.get(id)).filter(Boolean) as VectorRecord[];
  }

  async count(collection: string): Promise<number> {
    return this.collections.get(collection)?.size ?? 0;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  async close(): Promise<void> {
    this.collections.clear();
  }

  private buildAggregations(
    docs: InMemoryScoredRecord[],
    aggregations: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [aggregationName, rawAggregation] of Object.entries(aggregations)) {
      if (typeof rawAggregation !== 'object' || rawAggregation === null) continue;

      const aggregation = rawAggregation as Record<string, unknown>;
      const directMetric = getDirectAggregationMetric(aggregation);
      if (directMetric) {
        result[aggregationName] = {
          value: computeAggregationMetric(docs, directMetric),
        };
        continue;
      }

      const terms =
        typeof aggregation.terms === 'object' && aggregation.terms !== null
          ? (aggregation.terms as Record<string, unknown>)
          : null;
      if (!terms) continue;

      const field = String(terms.field ?? '');
      if (!field) continue;

      const metric = getAggregationMetric(aggregation);
      const bucketLimit =
        typeof terms.size === 'number'
          ? terms.size
          : terms.size !== undefined
            ? Number(terms.size)
            : 100;

      // COUNT_DISTINCT without an explicit groupBy is represented in the current
      // DSL as a terms aggregation on the same field plus a count_distinct metric.
      // Collapse that shape into a single total bucket so runtime tests match the
      // legacy aggregation contract.
      if (metric && aggregationFieldBase(metric.field) === aggregationFieldBase(field)) {
        if (metric.name === 'count_distinct' || metric.name === 'cardinality') {
          result[aggregationName] = {
            buckets: [
              {
                key: 'total',
                doc_count: docs.length,
                metric_value: {
                  value: computeAggregationMetric(docs, metric),
                },
              },
            ],
          };
          continue;
        }
      }

      const buckets = new Map<string, { key: unknown; docs: InMemoryScoredRecord[] }>();

      for (const doc of docs) {
        const bucketKey = getSourceValue(doc.hit.source, field);
        if (bucketKey === undefined || bucketKey === null) continue;

        const mapKey =
          typeof bucketKey === 'string' ||
          typeof bucketKey === 'number' ||
          typeof bucketKey === 'boolean'
            ? String(bucketKey)
            : JSON.stringify(bucketKey);
        const existing = buckets.get(mapKey);
        if (existing) {
          existing.docs.push(doc);
        } else {
          buckets.set(mapKey, { key: bucketKey, docs: [doc] });
        }
      }

      const bucketResults = Array.from(buckets.values())
        .sort((left, right) => {
          if (right.docs.length !== left.docs.length) {
            return right.docs.length - left.docs.length;
          }
          return String(left.key).localeCompare(String(right.key));
        })
        .slice(0, Number.isFinite(bucketLimit) && bucketLimit >= 0 ? bucketLimit : buckets.size)
        .map((bucket) => {
          const bucketResult: Record<string, unknown> = {
            key: bucket.key,
            doc_count: bucket.docs.length,
          };

          if (metric) {
            bucketResult.metric_value = {
              value: computeAggregationMetric(bucket.docs, metric),
            };
          }

          return bucketResult;
        });

      result[aggregationName] = { buckets: bucketResults };
    }

    return result;
  }
}
