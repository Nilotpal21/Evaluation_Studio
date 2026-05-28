/**
 * HybridExecutionReader unit tests (LLD §5.2).
 *
 * Covers:
 *  - flag-off: delegates to Mongo only (no CH query emitted).
 *  - flag-on: unions Mongo + CH; Mongo wins on overlap; sorted DESC.
 *  - getById: Mongo hit returns with source=mongo; miss → CH fallback
 *    when flag on; miss+flag-off returns null.
 *  - CH failure is caught and returns Mongo-only (no bubble).
 *  - Latency observer receives the correct mode label.
 *  - Inspection helpers (mongoOnly / chOnly / union) — LLD §5.7 surface.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  HybridExecutionReader,
  type HybridExecutionMongoModel,
  type HybridReaderChClient,
  type HybridReadFlags,
  type WorkflowExecutionRow,
} from '../hybrid-execution-reader.js';

function makeMongoModel(
  rows: WorkflowExecutionRow[],
  single: WorkflowExecutionRow | null = null,
): HybridExecutionMongoModel {
  return {
    find: vi.fn((filter) => ({
      sort: vi.fn(() => ({
        limit: vi.fn(() => ({
          lean: vi.fn(async () => rows.filter((r) => matchesFilter(r, filter))),
        })),
      })),
    })),
    findOne: vi.fn(() => ({
      lean: vi.fn(async () => single),
    })),
  };
}

function matchesFilter(row: WorkflowExecutionRow, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const rowValue = (row as unknown as Record<string, unknown>)[key];
    if (rowValue !== value) return false;
  }
  return true;
}

function makeChClient(
  chRowsByQuery: Record<string, unknown>[] = [],
  shouldFail = false,
): HybridReaderChClient {
  return {
    query: vi.fn(async () => {
      if (shouldFail) throw new Error('CH down');
      return { json: async <T>() => chRowsByQuery as T[] };
    }),
  };
}

const MONGO_ROW: WorkflowExecutionRow = {
  _id: 'exec-1',
  tenantId: 't1',
  projectId: 'p1',
  workflowId: 'wf-1',
  workflowVersion: '7',
  status: 'running',
  triggerType: 'manual',
  startedAt: '2026-04-21T10:00:00Z',
  completedAt: null,
};

const CH_ROW = {
  execution_id: 'exec-2',
  tenant_id: 't1',
  project_id: 'p1',
  workflow_id: 'wf-1',
  workflow_version: '6',
  status: 'completed',
  trigger_type: 'manual',
  started_at: '2026-04-21T09:00:00Z',
  completed_at: '2026-04-21T09:05:00Z',
  duration_ms: 300_000,
  last_event_at: '2026-04-21T09:05:00Z',
  _version: '1745220000000',
};

describe('HybridExecutionReader — listByWorkflow', () => {
  it('flag off — returns Mongo rows only, records mongo-only latency', async () => {
    const mongo = makeMongoModel([MONGO_ROW]);
    const ch = makeChClient([CH_ROW]);
    const latencies: Array<{ mode: string; ms: number }> = [];
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: (): HybridReadFlags => ({ dualReadEnabled: false }),
      onLatency: (mode, ms) => latencies.push({ mode, ms }),
    });

    const result = await reader.listByWorkflow({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!._id).toBe('exec-1');
    expect(result[0]!.source).toBe('mongo');
    expect(ch.query).not.toHaveBeenCalled();
    expect(latencies).toEqual([expect.objectContaining({ mode: 'mongo-only' })]);
  });

  it('flag on — unions Mongo + CH, CH-only rows included with source=ch', async () => {
    const mongo = makeMongoModel([MONGO_ROW]);
    const ch = makeChClient([CH_ROW]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.listByWorkflow({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      limit: 10,
    });
    expect(result).toHaveLength(2);
    const sources = result.map((r) => ({ id: r._id, source: r.source }));
    expect(sources).toEqual(
      expect.arrayContaining([
        { id: 'exec-1', source: 'mongo' },
        { id: 'exec-2', source: 'ch' },
      ]),
    );
  });

  it('flag on — Mongo wins on overlapping _id', async () => {
    const overlapping = {
      ...CH_ROW,
      execution_id: 'exec-1', // same id as MONGO_ROW
    };
    const mongo = makeMongoModel([MONGO_ROW]);
    const ch = makeChClient([overlapping]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.listByWorkflow({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe('mongo');
    expect(result[0]!.status).toBe('running'); // Mongo value, not CH's 'completed'
  });

  it('flag on — CH failure falls back to Mongo-only without throwing', async () => {
    const mongo = makeMongoModel([MONGO_ROW]);
    const ch = makeChClient([], true);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.listByWorkflow({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      limit: 10,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe('mongo');
  });

  it('honours the page limit when the union exceeds it', async () => {
    const mongo = makeMongoModel([MONGO_ROW]);
    const chExtras = Array.from({ length: 5 }, (_, i) => ({
      ...CH_ROW,
      execution_id: `exec-ch-${i}`,
      started_at: `2026-04-20T10:0${i}:00Z`,
    }));
    const ch = makeChClient(chExtras);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.listByWorkflow({
      tenantId: 't1',
      projectId: 'p1',
      workflowId: 'wf-1',
      limit: 3,
    });
    expect(result).toHaveLength(3);
  });
});

describe('HybridExecutionReader — getById', () => {
  it('Mongo hit returns source=mongo', async () => {
    const mongo = makeMongoModel([], MONGO_ROW);
    const ch = makeChClient([]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.getById({
      tenantId: 't1',
      projectId: 'p1',
      executionId: 'exec-1',
    });
    expect(result?.source).toBe('mongo');
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('Mongo miss + flag off returns null (no CH fallback)', async () => {
    const mongo = makeMongoModel([], null);
    const ch = makeChClient([]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: false }),
    });
    const result = await reader.getById({
      tenantId: 't1',
      projectId: 'p1',
      executionId: 'exec-x',
    });
    expect(result).toBeNull();
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('Mongo miss + flag on returns CH row when present', async () => {
    const mongo = makeMongoModel([], null);
    const ch = makeChClient([CH_ROW]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.getById({
      tenantId: 't1',
      projectId: 'p1',
      executionId: 'exec-2',
    });
    expect(result?.source).toBe('ch');
    expect(result?._id).toBe('exec-2');
  });
});

describe('HybridExecutionReader — inspection (LLD §5.7)', () => {
  it('inspectMongoOnly does not touch CH', async () => {
    const mongo = makeMongoModel([], MONGO_ROW);
    const ch = makeChClient([CH_ROW]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.inspectMongoOnly({
      tenantId: 't1',
      projectId: 'p1',
      executionId: 'exec-1',
    });
    expect(result?.source).toBe('mongo');
    expect(ch.query).not.toHaveBeenCalled();
  });

  it('inspectChOnly does not touch Mongo', async () => {
    const mongo = makeMongoModel([], MONGO_ROW);
    const ch = makeChClient([CH_ROW]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.inspectChOnly({
      tenantId: 't1',
      projectId: 'p1',
      executionId: 'exec-2',
    });
    expect(result?.source).toBe('ch');
    expect(mongo.findOne).not.toHaveBeenCalled();
  });

  it('inspectUnion prefers Mongo on overlap', async () => {
    const mongo = makeMongoModel([], MONGO_ROW);
    const ch = makeChClient([{ ...CH_ROW, execution_id: 'exec-1' }]);
    const reader = new HybridExecutionReader({
      mongoModel: mongo,
      chClient: ch,
      readFlags: () => ({ dualReadEnabled: true }),
    });
    const result = await reader.inspectUnion({
      tenantId: 't1',
      projectId: 'p1',
      executionId: 'exec-1',
    });
    expect(result?.source).toBe('mongo');
    expect(result?.status).toBe('running');
  });
});
