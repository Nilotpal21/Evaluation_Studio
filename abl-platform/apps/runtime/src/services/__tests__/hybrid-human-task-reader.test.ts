/**
 * HybridHumanTaskReader unit tests (LLD §5.3).
 *
 * Covers:
 *  - flag-off: Mongo-only, no CH query.
 *  - flag-on: UNION + Mongo-wins dedup + exact hybrid total.
 *  - Mongo filter shape for workflow mailbox + multi-status lists.
 *  - CH query forwards visibility/priority filters.
 *  - CH failure falls back to Mongo-only semantics.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  HybridHumanTaskReader,
  type HybridHumanTaskMongoModel,
  type HybridReaderChClient,
  type HumanTaskRow,
  type WorkflowTaskVisibility,
} from '../hybrid-human-task-reader.js';

function makeMongoModel(args: {
  rows: HumanTaskRow[];
  count?: number;
  distinctIds?: string[];
}): HybridHumanTaskMongoModel & {
  _capturedFilters: Array<Record<string, unknown>>;
} {
  const capturedFilters: Array<Record<string, unknown>> = [];
  return {
    _capturedFilters: capturedFilters,
    find: vi.fn((filter) => {
      capturedFilters.push(filter);
      return {
        sort: vi.fn(() => ({
          skip: vi.fn(() => ({
            limit: vi.fn(() => ({ lean: vi.fn(async () => args.rows) })),
          })),
        })),
      };
    }),
    countDocuments: vi.fn(async () => args.count ?? args.rows.length),
    distinctTaskIds: vi.fn(async () => args.distinctIds ?? args.rows.map((row) => row._id)),
  };
}

function makeChClient(args: {
  rows?: Array<Record<string, unknown>>;
  count?: number;
  countExcludingMongo?: number;
  shouldFail?: boolean;
}): HybridReaderChClient & {
  _calls: Array<{ query: string; query_params?: Record<string, unknown> }>;
} {
  const calls: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
  return {
    _calls: calls,
    query: vi.fn(async (params: { query: string; query_params?: Record<string, unknown> }) => {
      calls.push(params);
      if (args.shouldFail) throw new Error('CH down');
      if (params.query.includes('count() AS row_count')) {
        const rowCount =
          params.query.includes('excludeTaskIds') && args.countExcludingMongo !== undefined
            ? args.countExcludingMongo
            : (args.count ?? 0);
        return {
          json: async <T>() => [{ row_count: rowCount }] as T[],
        };
      }
      return {
        json: async <T>() => (args.rows ?? []) as T[],
      };
    }),
  };
}

const MONGO_TASK: HumanTaskRow = {
  _id: 'task-mongo',
  tenantId: 't1',
  projectId: 'p1',
  mailbox: 'workflow',
  status: 'pending',
  createdAt: '2026-04-21T10:00:00Z',
};

const CH_TASK_ROW = {
  task_id: 'task-ch',
  tenant_id: 't1',
  project_id: 'p1',
  execution_id: 'exec-1',
  workflow_id: 'wf-1',
  task_type: 'approval',
  status: 'completed',
  priority: 'high',
  assigned_to: ['u2'],
  claimed_by: '',
  created_at: '2026-04-21T09:00:00Z',
  last_event_at: '2026-04-21T09:05:00Z',
  _version: '1745219000000',
};

async function listPage(
  reader: HybridHumanTaskReader,
  visibility: WorkflowTaskVisibility = { kind: 'all' },
) {
  return reader.listWorkflowTasksPage({
    tenantId: 't1',
    projectId: 'p1',
    statuses: ['pending'],
    visibility,
    limit: 10,
    offset: 0,
  });
}

describe('HybridHumanTaskReader — flag gating', () => {
  it('flag off returns Mongo rows and total without querying CH', async () => {
    const mongo = makeMongoModel({ rows: [MONGO_TASK], count: 7 });
    const ch = makeChClient({ rows: [CH_TASK_ROW], count: 1 });
    const reader = new HybridHumanTaskReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: false }),
    });

    const result = await listPage(reader);

    expect(result.total).toBe(7);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.source).toBe('mongo');
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('flag on unions Mongo + CH rows and reports the exact hybrid total', async () => {
    const mongo = makeMongoModel({
      rows: [MONGO_TASK],
      count: 1,
      distinctIds: ['task-mongo'],
    });
    const ch = makeChClient({
      rows: [CH_TASK_ROW],
      count: 3,
      countExcludingMongo: 2,
    });
    const reader = new HybridHumanTaskReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });

    const result = await listPage(reader);

    expect(result.rows.map((row) => row.source)).toEqual(['mongo', 'ch']);
    expect(result.total).toBe(3);
  });
});

describe('HybridHumanTaskReader — filter shape', () => {
  it('Mongo filter pins mailbox="workflow" and uses $in for multi-status', async () => {
    const mongo = makeMongoModel({ rows: [] });
    const ch = makeChClient({});
    const reader = new HybridHumanTaskReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: false }),
    });

    await reader.listWorkflowTasksPage({
      tenantId: 't1',
      projectId: 'p1',
      statuses: ['pending', 'assigned', 'in_progress'],
      visibility: { kind: 'all' },
      limit: 10,
      offset: 0,
    });

    const captured = mongo._capturedFilters[0]!;
    expect(captured.mailbox).toBe('workflow');
    expect(captured.status).toEqual({ $in: ['pending', 'assigned', 'in_progress'] });
    expect(captured.tenantId).toBe('t1');
    expect(captured.projectId).toBe('p1');
  });

  it('CH query forwards user-or-open-pool visibility and priority filters', async () => {
    const mongo = makeMongoModel({ rows: [] });
    const ch = makeChClient({});
    const reader = new HybridHumanTaskReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });

    await reader.listWorkflowTasksPage({
      tenantId: 't1',
      projectId: 'p1',
      statuses: ['pending', 'approved'],
      priority: 'critical',
      visibility: { kind: 'user_or_open_pool', userId: 'user-7' },
      limit: 10,
      offset: 0,
    });

    const rowQuery = ch._calls.find((call) => call.query.includes('SELECT task_id'))!;
    expect(rowQuery.query).toMatch(/status IN \{statuses:Array\(String\)\}/);
    expect(rowQuery.query).toMatch(/priority = \{priority:String\}/);
    expect(rowQuery.query).toMatch(/length\(assigned_to\) = 0/);
    expect(rowQuery.query_params).toMatchObject({
      statuses: ['pending', 'approved'],
      priority: 'critical',
      visibilityUserId: 'user-7',
    });
  });

  it('CH query narrows explicit assignedTo lookups without open-pool rows', async () => {
    const ch = makeChClient({});
    const reader = new HybridHumanTaskReader({
      mongoModel: makeMongoModel({ rows: [] }),
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });

    await listPage(reader, { kind: 'user_only', userId: 'user-99' });

    const rowQuery = ch._calls.find((call) => call.query.includes('SELECT task_id'))!;
    expect(rowQuery.query).toMatch(/has\(assigned_to, \{visibilityUserId:String\}\)/);
    expect(rowQuery.query).not.toMatch(/length\(assigned_to\) = 0/);
    expect(rowQuery.query_params?.visibilityUserId).toBe('user-99');
  });
});

describe('HybridHumanTaskReader — error handling', () => {
  it('CH failure falls back to Mongo-only rows and total without throwing', async () => {
    const mongo = makeMongoModel({ rows: [MONGO_TASK], count: 4 });
    const ch = makeChClient({ shouldFail: true });
    const reader = new HybridHumanTaskReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });

    const result = await listPage(reader);

    expect(result.total).toBe(4);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.source).toBe('mongo');
  });
});
