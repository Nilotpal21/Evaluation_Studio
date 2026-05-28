/**
 * DbQuery — Restate activity service for executing database queries.
 *
 * Supports ClickHouse (SQL) and MongoDB (JSON filter) queries.
 * Template substitution via {{variable}} in query strings.
 *
 * Security:
 *   - sessionId is required — all queries are scoped to a single session
 *   - ClickHouse: Only SELECT queries allowed (reuses validateSQL from nl-query)
 *   - ClickHouse: tenant_id, project_id, and session_id enforced via parameterized query_params
 *   - MongoDB: tenantId, projectId, and sessionId always injected into filter
 *   - Error messages never expose raw user query strings
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineStepContext, StepOutput } from '../types.js';
import { substituteTemplates } from '../template-engine.js';
import { validateSQL } from './nl-query.service.js';
import { renderPipelineActionValue } from './pii-boundary.js';
import {
  ALLOWED_MONGO_COLLECTION_NAMES,
  FORBIDDEN_MONGO_OPERATORS,
  ALLOWED_CLICKHOUSE_TABLE_NAMES,
} from '../contracts/mongo-query-contract.js';

const log = createLogger('db-query');

export const dbQueryService = restate.service({
  name: 'DbQueryService',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const { config, previousSteps, pipelineInput } = input;

      const database = config.database as 'clickhouse' | 'mongodb';
      const collection = config.collection as string | undefined;
      const table = config.table as string | undefined;
      const MAX_QUERY_LIMIT = 10;
      const limit = Math.min((config.limit as number) ?? 10, MAX_QUERY_LIMIT);
      const tenantId = input.tenantId ?? pipelineInput.tenantId;
      const projectId = input.projectId ?? pipelineInput.projectId;
      const rawSessionId = config.sessionId as string | undefined;
      // Resolve template expressions in the config sessionId field (e.g. "{{input.sessionId}}").
      // Without this, "{{input.sessionId}}" would be used as a literal string and fail to match
      // any documents. The Trigger Session quick-fill chip inserts that expression.
      const stepsContext: Record<string, { output: unknown }> = {};
      for (const [stepId, stepOutput] of Object.entries(previousSteps)) {
        stepsContext[stepId] = { output: stepOutput.data };
      }
      const resolvedConfigSessionId =
        rawSessionId && rawSessionId.includes('{{')
          ? substituteTemplates(rawSessionId, { input: pipelineInput, steps: stepsContext })
          : rawSessionId;
      const sessionId =
        (resolvedConfigSessionId && resolvedConfigSessionId.trim()) ||
        input.sessionId ||
        pipelineInput.sessionId;

      if (!database) {
        return {
          status: 'fail',
          data: { error: "db-query requires 'database' in config" },
        };
      }

      if (!tenantId || !projectId) {
        return {
          status: 'fail',
          data: { error: 'db-query requires tenantId and projectId in pipeline input' },
        };
      }

      if (!sessionId) {
        return {
          status: 'fail',
          data: {
            error: 'db-query requires sessionId in pipeline context — queries are session-scoped',
          },
        };
      }

      if (database === 'mongodb' && !collection) {
        return {
          status: 'fail',
          data: { error: "db-query with database='mongodb' requires 'collection' in config" },
        };
      }

      // ClickHouse: table is required and must be in the allowlist.
      // Checking unconditionally (not just when table !== undefined) closes the bypass where
      // a user omits 'table' and writes arbitrary SQL that references non-allowlisted tables.
      if (database === 'clickhouse') {
        if (!table) {
          return {
            status: 'fail',
            data: { error: "db-query with database='clickhouse' requires 'table' in config" },
          };
        }
        if (!ALLOWED_CLICKHOUSE_TABLE_NAMES.includes(table)) {
          return {
            status: 'fail',
            data: { error: `Table '${table}' is not in the allowed list` },
          };
        }
      }

      // Default query when field is left empty — selects all documents in session scope.
      // ClickHouse default uses the validated table; MongoDB default matches all.
      const DEFAULT_QUERY =
        database === 'mongodb'
          ? '{}'
          : `SELECT * FROM ${table!} WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}`;
      const queryTemplate = (config.query as string | undefined)?.trim() || DEFAULT_QUERY;

      const templateContext = await renderPipelineActionValue(
        {
          input: pipelineInput,
          nodeOutputs: previousSteps,
        },
        { tenantId: input.tenantId, projectId: input.projectId },
      );

      const query = substituteTemplates(queryTemplate, templateContext);

      return ctx.run('db-query', async () => {
        try {
          if (database === 'clickhouse') {
            return await executeClickHouseQuery(
              query,
              limit,
              tenantId,
              projectId,
              sessionId,
              table,
            );
          } else {
            return await executeMongoDBQuery(
              query,
              collection!,
              limit,
              tenantId,
              projectId,
              sessionId,
            );
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
            return {
              status: 'fail' as const,
              data: {
                error: `Database client for '${database}' not available. Ensure database packages are installed.`,
              },
            };
          }
          log.error('db-query execution failed', {
            database,
            sessionId: input.sessionId,
            error: msg,
          });
          return {
            status: 'fail' as const,
            data: { error: 'db-query execution failed', database },
          };
        }
      });
    },
  },
});

async function executeClickHouseQuery(
  query: string,
  limit: number,
  tenantId: string,
  projectId: string,
  sessionId: string,
  table?: string,
): Promise<StepOutput> {
  // Validate SQL safety — reuse the validated patterns from nl-query
  const validationError = validateSQL(query);
  if (validationError) {
    log.warn('ClickHouse query rejected by SQL validation', {
      tenantId,
      projectId,
      error: validationError,
    });
    return {
      status: 'fail',
      data: { error: `Query validation failed: ${validationError}` },
    };
  }

  // Dynamic import — package may not be installed in all deployments
  const modulePath = '@agent-platform/database/clickhouse';
  const mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ modulePath);
  const client = mod.getClickHouseClient();

  // Enforce tenant, project, and session isolation via parameterized query_params.
  // session_id scopes every query to a single conversation — matches read-conversation behaviour.
  //
  // The isolation clause must be inserted BEFORE any LIMIT clause — appending after LIMIT
  // produces "LIMIT 100 AND ..." which ClickHouse rejects as a non-constant LIMIT expression.
  const isolationClause =
    'AND tenant_id = {tenantId:String} AND project_id = {projectId:String} AND session_id = {sessionId:String}';

  const limitIdx = query.search(/\bLIMIT\b/i);
  let securedQuery: string;
  if (limitIdx !== -1) {
    // Insert isolation clause before the existing LIMIT
    const beforeLimit = query.slice(0, limitIdx).trimEnd();
    const limitPart = query.slice(limitIdx);
    securedQuery = `${beforeLimit} ${isolationClause} ${limitPart}`;
  } else {
    securedQuery = `${query} ${isolationClause} LIMIT {limit:UInt32}`;
  }

  const result = await client.query({
    query: securedQuery,
    query_params: { tenantId, projectId, sessionId, limit },
    format: 'JSONEachRow',
  });
  const rows = await result.json();

  return {
    status: 'success',
    data: {
      rows,
      rowCount: Array.isArray(rows) ? rows.length : 0,
      database: 'clickhouse',
      ...(table ? { table } : {}),
    },
  };
}

const SAFE_COLLECTION_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function rejectForbiddenOperators(filter: Record<string, unknown>): string | null {
  const serialized = JSON.stringify(filter);
  const operatorMatches = serialized.match(/"\$[a-zA-Z]+"/g) ?? [];
  for (const match of operatorMatches) {
    const op = match.replace(/"/g, '');
    if (FORBIDDEN_MONGO_OPERATORS.includes(op)) {
      return `Operator ${op} is not allowed in db-query filters`;
    }
  }
  return null;
}

async function executeMongoDBQuery(
  query: string,
  collection: string,
  limit: number,
  tenantId: string,
  projectId: string,
  sessionId: string,
): Promise<StepOutput> {
  // Validate collection name to prevent namespace traversal (e.g., "system.users")
  if (!SAFE_COLLECTION_RE.test(collection) || collection.length > 128) {
    return {
      status: 'fail',
      data: { error: 'Invalid collection name' },
    };
  }

  // Only allow reads from the server-controlled allowlist
  if (!ALLOWED_MONGO_COLLECTION_NAMES.includes(collection)) {
    return {
      status: 'fail',
      data: { error: `Collection '${collection}' is not in the allowed list` },
    };
  }

  const mongooseModule = await import('mongoose');
  // CJS default export lands on .default in ESM dynamic import context
  const mongooseInstance = (mongooseModule as any).default ?? mongooseModule;
  // Use connection.db (native Db) → ensures find().limit().toArray() uses the native driver cursor
  const nativeDb = mongooseInstance.connection?.db;
  if (!nativeDb) {
    return { status: 'fail', data: { error: 'MongoDB connection not ready' } };
  }

  let filter: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(query);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        status: 'fail',
        data: { error: 'MongoDB filter must be a JSON object' },
      };
    }
    filter = parsed as Record<string, unknown>;

    // Block JS-execution and aggregation-bypass operators
    const operatorError = rejectForbiddenOperators(filter);
    if (operatorError) {
      return {
        status: 'fail',
        data: { error: operatorError },
      };
    }
  } catch {
    log.warn('Invalid MongoDB filter JSON in db-query', { tenantId, projectId, collection });
    return {
      status: 'fail',
      data: { error: 'Invalid MongoDB filter JSON. Ensure the query is valid JSON.' },
    };
  }

  // Always scope to tenant, project, and session — session_id cannot be overridden by user filter
  filter.tenantId = tenantId;
  filter.projectId = projectId;
  filter.sessionId = sessionId;

  const coll = nativeDb.collection(collection);
  const docs = await coll.find(filter).limit(limit).toArray();

  return {
    status: 'success',
    data: { rows: docs, rowCount: docs.length, database: 'mongodb', collection },
  };
}

export type DbQueryService = typeof dbQueryService;
