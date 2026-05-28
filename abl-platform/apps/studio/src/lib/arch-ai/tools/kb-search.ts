import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import { createKBApiClient } from './kb-api-client';
import { resolveKBContext } from './kb-context';
import type { PageContext } from '@agent-platform/arch-ai';

const log = createLogger('arch-ai:kb-search');

type SearchAction = 'query' | 'structured_query' | 'discover' | 'resolve_vocab';

type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists';

type FilterValue = string | number | boolean | string[] | number[];

interface MetadataFilter {
  field: string;
  operator: FilterOperator;
  value: FilterValue;
}

interface RawMetadataFilter {
  field: string;
  operator: FilterOperator;
  value?: unknown;
}

interface KBSearchInput {
  action: SearchAction;
  kbId?: string;
  kbName?: string;
  query?: string;
  filters?: Record<string, unknown> | RawMetadataFilter[];
  limit?: number;
  mode?: 'exact' | 'alias' | 'fuzzy';
}

interface KBSearchEnv {
  pageContext: PageContext | null | undefined;
  authToken: string;
}

const FILTER_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
] as const satisfies readonly FilterOperator[];

const FILTER_OPERATOR_SET = new Set<FilterOperator>(FILTER_OPERATORS);

type KBIndexResolution = NonNullable<Awaited<ReturnType<typeof resolveIndexId>>['resolved']>;

function isFilterValue(value: unknown): value is FilterValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }

  if (!Array.isArray(value)) {
    return false;
  }

  const stringArray = value.every((entry) => typeof entry === 'string');
  const numberArray = value.every((entry) => typeof entry === 'number');
  return stringArray || numberArray;
}

function normalizeOperator(value: unknown): FilterOperator | null {
  if (typeof value !== 'string') {
    return null;
  }

  return FILTER_OPERATOR_SET.has(value as FilterOperator) ? (value as FilterOperator) : null;
}

function normalizeMetadataFilter(filter: RawMetadataFilter): MetadataFilter | null {
  if (!filter.field) {
    return null;
  }

  const operator = normalizeOperator(filter.operator);
  if (!operator) {
    return null;
  }

  const resolvedValue =
    (operator === 'exists' || operator === 'not_exists') && filter.value === undefined
      ? true
      : filter.value;

  if (!isFilterValue(resolvedValue)) {
    return null;
  }

  return {
    field: filter.field,
    operator,
    value: resolvedValue,
  };
}

function normalizeRecordFilter(field: string, rawValue: unknown): MetadataFilter | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }

  if (Array.isArray(rawValue)) {
    if (!isFilterValue(rawValue) || rawValue.length === 0) {
      return null;
    }
    return {
      field,
      operator: 'in',
      value: rawValue,
    };
  }

  if (
    typeof rawValue === 'string' ||
    typeof rawValue === 'number' ||
    typeof rawValue === 'boolean'
  ) {
    return {
      field,
      operator: 'eq',
      value: rawValue,
    };
  }

  if (typeof rawValue !== 'object') {
    return null;
  }

  const typedValue = rawValue as {
    operator?: unknown;
    op?: unknown;
    value?: unknown;
    values?: unknown;
  };
  const operator = normalizeOperator(typedValue.operator ?? typedValue.op);
  if (!operator) {
    return null;
  }

  const resolvedValue =
    (operator === 'exists' || operator === 'not_exists') &&
    typedValue.value === undefined &&
    typedValue.values === undefined
      ? true
      : (typedValue.value ?? typedValue.values);

  if (!isFilterValue(resolvedValue)) {
    return null;
  }

  return {
    field,
    operator,
    value: resolvedValue,
  };
}

function normalizeFilters(filters?: KBSearchInput['filters']): MetadataFilter[] | undefined {
  if (!filters) {
    return undefined;
  }

  const normalized = Array.isArray(filters)
    ? filters
        .map(normalizeMetadataFilter)
        .filter((filter): filter is MetadataFilter => filter !== null)
    : Object.entries(filters)
        .map(([field, value]) => normalizeRecordFilter(field, value))
        .filter((filter): filter is MetadataFilter => filter !== null);

  return normalized.length > 0 ? normalized : undefined;
}

function withKBContext(idx: KBIndexResolution, data: Record<string, unknown>) {
  return {
    kbId: idx.kbId,
    kbName: idx.kbName,
    indexId: idx.indexId,
    ...data,
  };
}

async function resolveIndexId(
  input: { kbId?: string; kbName?: string },
  ctx: ToolPermissionContext,
  env: KBSearchEnv,
) {
  const client = createKBApiClient({
    authToken: env.authToken,
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
  });

  const resolved = await resolveKBContext(
    { kbId: input.kbId, kbName: input.kbName },
    {
      pageContext: env.pageContext,
      projectId: ctx.projectId,
      authToken: env.authToken,
      tenantId: ctx.user.tenantId,
      userId: ctx.user.userId,
    },
  );
  if (!resolved.kbId) {
    return {
      resolved: null,
      error: {
        success: false as const,
        needsInput: true,
        availableKBs: resolved.availableKBs,
        error: {
          code: 'KB_NOT_SPECIFIED',
          message:
            'Which knowledge base? ' +
            (resolved.availableKBs ?? []).map((kb) => `"${kb.name}"`).join(', '),
        },
      },
    };
  }

  const kb = await client.get<{
    knowledgeBase: Record<string, unknown>;
  }>(`/api/search-ai/knowledge-bases/${resolved.kbId}`);
  const knowledgeBase = kb.knowledgeBase;
  const indexId = knowledgeBase.searchIndexId as string | undefined;
  if (!indexId) {
    return {
      resolved: null,
      error: {
        success: false as const,
        error: { code: 'NO_INDEX', message: 'Knowledge base has no search index yet' },
      },
    };
  }

  return {
    resolved: {
      kbId: resolved.kbId,
      kbName: String(knowledgeBase.name ?? input.kbName ?? ''),
      indexId,
    },
    client,
    error: null,
  };
}

export async function executeKBSearch(
  input: KBSearchInput,
  ctx: ToolPermissionContext,
  env: KBSearchEnv,
) {
  try {
    const perm = await checkToolPermission('kb_search', input.action, ctx);
    if (!perm.allowed) {
      return {
        success: false,
        error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
      };
    }

    switch (input.action) {
      case 'query': {
        if (!input.query) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'query is required' },
          };
        }
        const idx = await resolveIndexId(input, ctx, env);
        if (idx.error) return idx.error;
        const filters = normalizeFilters(input.filters);

        const data = await idx.client!.post<Record<string, unknown>>(
          `/api/search-ai-runtime/search/${idx.resolved!.indexId}/query`,
          {
            queryType: 'semantic',
            query: input.query,
            filters,
            topK: input.limit ?? 5,
          },
        );
        log.info('KB search query via Arch', {
          kbId: idx.resolved!.kbId,
          query: input.query,
          filterCount: filters?.length ?? 0,
        });
        return { success: true, data: withKBContext(idx.resolved!, data) };
      }

      case 'structured_query': {
        if (!input.query) {
          return {
            success: false,
            error: { code: 'MISSING_PARAM', message: 'query is required' },
          };
        }
        const idx = await resolveIndexId(input, ctx, env);
        if (idx.error) return idx.error;
        const filters = normalizeFilters(input.filters);

        const data = await idx.client!.post<Record<string, unknown>>(
          `/api/search-ai-runtime/search/${idx.resolved!.indexId}/query`,
          {
            queryType: 'structured',
            query: input.query,
            filters,
            limit: input.limit ?? 10,
          },
        );
        log.info('KB structured search via Arch', {
          kbId: idx.resolved!.kbId,
          query: input.query,
          filterCount: filters?.length ?? 0,
        });
        return { success: true, data: withKBContext(idx.resolved!, data) };
      }

      case 'discover': {
        const idx = await resolveIndexId(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await idx.client!.get<Record<string, unknown>>(
          `/api/search-ai-runtime/search/${idx.resolved!.indexId}/discover`,
        );
        return { success: true, data: withKBContext(idx.resolved!, data) };
      }

      case 'resolve_vocab': {
        if (!input.query) {
          return {
            success: false,
            error: {
              code: 'MISSING_PARAM',
              message: 'query is required for vocabulary resolution',
            },
          };
        }
        const idx = await resolveIndexId(input, ctx, env);
        if (idx.error) return idx.error;

        const data = await idx.client!.post<Record<string, unknown>>(
          `/api/search-ai-runtime/search/${idx.resolved!.indexId}/resolve`,
          {
            query: input.query,
            mode: input.mode ?? 'fuzzy',
          },
        );
        return { success: true, data: withKBContext(idx.resolved!, data) };
      }

      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${input.action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('KB search failed', { action: input.action, error: message });
    return { success: false, error: { code: 'API_ERROR', message } };
  }
}
