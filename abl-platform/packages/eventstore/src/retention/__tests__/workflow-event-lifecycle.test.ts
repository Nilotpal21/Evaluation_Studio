/**
 * WorkflowEventLifecycle (LLD §4.6) — IEventLifecycle contract tests.
 *
 * Covers:
 *  - `purgeExpired`: issues one ALTER TABLE DELETE per raw table with the
 *    `olderThan` cutoff, returns `{ deletedEstimate: -1 }`.
 *  - `scrubPII`: UPDATEs payload/error columns on matching rows across raw
 *    tables, and identity columns on human-task projections when `eventTypes`
 *    contains human-task events. No-op with empty list.
 *  - `deleteBySessionIds` / `anonymizeActor`: intentionally no-op.
 *  - `deleteTenant`: issues DELETE against BOTH raw + `_latest`
 *    projection tables so tenant offboarding is atomic.
 *
 * FR-8 plan-tiered retention end-to-end: `EventRetentionService` (the
 * caller) computes the cutoff from `RetentionPolicy.totalRetentionDays`
 * and delegates to our `purgeExpired`. The retention test here confirms
 * the full pipeline works against a fake CH client.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowEventLifecycle } from '../workflow-event-lifecycle.js';
import { EventRetentionService } from '../event-retention-service.js';

function fakeClient() {
  return {
    command: vi.fn().mockResolvedValue(undefined),
  };
}

describe('WorkflowEventLifecycle', () => {
  describe('purgeExpired', () => {
    it('issues ALTER TABLE DELETE for each raw event table', async () => {
      const client = fakeClient();
      const lifecycle = new WorkflowEventLifecycle(client);
      const result = await lifecycle.purgeExpired('t1', new Date('2026-01-01T00:00:00Z'));

      expect(client.command).toHaveBeenCalledTimes(4);
      const queries = client.command.mock.calls.map((c) => c[0].query);
      expect(queries[0]).toMatch(
        /ALTER TABLE abl_platform\.workflow_execution_events DELETE WHERE tenant_id = \{tenantId:String\} AND occurred_at < \{olderThan:DateTime64\(3\)\}/,
      );
      expect(queries[1]).toMatch(
        /ALTER TABLE abl_platform\.human_task_events DELETE WHERE tenant_id = \{tenantId:String\} AND occurred_at < \{olderThan:DateTime64\(3\)\}/,
      );
      expect(queries[2]).toMatch(
        /ALTER TABLE abl_platform\.workflow_executions_latest DELETE WHERE tenant_id = \{tenantId:String\} AND last_event_at < \{olderThan:DateTime64\(3\)\}/,
      );
      expect(queries[3]).toMatch(
        /ALTER TABLE abl_platform\.human_tasks_latest DELETE WHERE tenant_id = \{tenantId:String\} AND last_event_at < \{olderThan:DateTime64\(3\)\}/,
      );
      for (const call of client.command.mock.calls) {
        expect(call[0].query).toContain('SETTINGS mutations_sync = 1');
        expect(call[0].query_params).toEqual({
          tenantId: 't1',
          olderThan: '2026-01-01T00:00:00.000Z',
        });
      }
      expect(result).toEqual({ deletedEstimate: -1 });
    });
  });

  describe('scrubPII', () => {
    it('issues UPDATE on raw tables when event types are provided', async () => {
      const client = fakeClient();
      const lifecycle = new WorkflowEventLifecycle(client);
      await lifecycle.scrubPII('t1', new Date('2026-01-01T00:00:00Z'), [
        'workflow.execution.started',
        'human_task.approved',
      ]);
      expect(client.command).toHaveBeenCalledTimes(3);
      for (const call of client.command.mock.calls) {
        expect(call[0].query).toMatch(/ALTER TABLE abl_platform\./);
        expect(call[0].query).toContain('SETTINGS mutations_sync = 1');
        expect(call[0].query_params).toMatchObject({
          tenantId: 't1',
        });
      }
      const queries = client.command.mock.calls.map((c) => c[0].query);
      expect(queries[0]).toMatch(
        /UPDATE payload = '\{"anonymized":true\}', payload_truncated = 1, error_message = ''/,
      );
      expect(queries[0]).toContain('workflow_execution_events');
      expect(queries[1]).toMatch(/UPDATE payload = '\{"anonymized":true\}', payload_truncated = 1/);
      expect(queries[1]).toContain('human_task_events');
      expect(queries[2]).toContain('human_tasks_latest');
      expect(queries[2]).toContain("assigned_to = [], claimed_by = '', responded_by = ''");
      expect(client.command.mock.calls[0]![0].query_params).toMatchObject({
        eventTypes: ['workflow.execution.started', 'human_task.approved'],
      });
      expect(client.command.mock.calls[1]![0].query_params).toMatchObject({
        eventTypes: ['workflow.execution.started', 'human_task.approved'],
      });
    });

    it('no-ops when event types list is empty', async () => {
      const client = fakeClient();
      const lifecycle = new WorkflowEventLifecycle(client);
      await lifecycle.scrubPII('t1', new Date(), []);
      expect(client.command).not.toHaveBeenCalled();
    });
  });

  describe('deleteBySessionIds / anonymizeActor', () => {
    it('both are no-ops that resolve without touching the client', async () => {
      const client = fakeClient();
      const lifecycle = new WorkflowEventLifecycle(client);
      await lifecycle.deleteBySessionIds('t1', ['s1', 's2']);
      await lifecycle.anonymizeActor('t1', 'user-abc');
      expect(client.command).not.toHaveBeenCalled();
    });
  });

  describe('deleteTenant', () => {
    it('drops rows across BOTH raw event tables AND _latest projection tables', async () => {
      const client = fakeClient();
      const lifecycle = new WorkflowEventLifecycle(client);
      await lifecycle.deleteTenant('t1');
      expect(client.command).toHaveBeenCalledTimes(4);
      const queries = client.command.mock.calls.map((c) => c[0].query);
      for (const query of queries) {
        expect(query).toContain('SETTINGS mutations_sync = 1');
      }
      expect(queries.some((q) => q.includes('workflow_execution_events DELETE'))).toBe(true);
      expect(queries.some((q) => q.includes('human_task_events DELETE'))).toBe(true);
      expect(queries.some((q) => q.includes('workflow_executions_latest DELETE'))).toBe(true);
      expect(queries.some((q) => q.includes('human_tasks_latest DELETE'))).toBe(true);
    });

    it('propagates CH errors (non-swallowing)', async () => {
      const client = {
        command: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('ch down'))
          .mockResolvedValue(undefined),
      };
      const lifecycle = new WorkflowEventLifecycle(client);
      await expect(lifecycle.deleteTenant('t1')).rejects.toThrow('ch down');
    });
  });
});

describe('FR-8 — EventRetentionService + WorkflowEventLifecycle end-to-end', () => {
  it('translates RetentionPolicy into a purge cutoff and delegates to lifecycle.purgeExpired', async () => {
    const client = fakeClient();
    const lifecycle = new WorkflowEventLifecycle(client);
    const retention = new EventRetentionService(lifecycle);
    const now = Date.now();
    const result = await retention.runRetention('t1', {
      events: { totalRetentionDays: 30, piiRetentionDays: 30 },
    });

    // purge touches both raw event tables and their latest projections.
    expect(client.command).toHaveBeenCalledTimes(4);
    const firstCallParams = client.command.mock.calls[0]![0].query_params as {
      tenantId: string;
      olderThan: string;
    };
    expect(firstCallParams.tenantId).toBe('t1');
    const cutoffMs = Date.parse(firstCallParams.olderThan);
    // cutoff should be ~30 days ago (±10s tolerance for test slack)
    const expected = now - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoffMs - expected)).toBeLessThan(10_000);

    // deletedEstimate propagates; piiRetentionDays == totalRetentionDays ⇒ no scrub
    expect(result).toEqual({ deleted: -1, scrubbed: 0 });
  });
});
