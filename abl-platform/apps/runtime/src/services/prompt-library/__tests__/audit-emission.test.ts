/**
 * INT-7: Audit Emission — real record creation and querying
 *
 * Uses the InMemoryAuditStore (clickhouseReady=false, no DB available in unit
 * context) so records are written synchronously and immediately queryable
 * without vi.mock of any internal module.
 *
 * Test flow: call each audit helper → query the store → assert the record
 * was created with the correct event type, resourceType, and metadata.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  auditPromptCreated,
  auditPromptVersionCreated,
  auditPromptVersionPromoted,
  auditPromptVersionArchived,
} from '../../audit-helpers.js';
import {
  initializeAuditStore,
  getAuditStore,
  _resetAuditStore,
} from '../../audit-store-singleton.js';
import type { IPromptLibraryItem, IPromptLibraryVersion } from '@agent-platform/database/models';

const ACTOR = 'user-int7-001';
const PROMPT_ID = 'pl_int7-test';
const VERSION_ID = 'plv_int7-test';

const mockItem: IPromptLibraryItem = {
  _id: PROMPT_ID,
  tenantId: 'tenant-int7',
  projectId: 'project-int7',
  name: 'INT-7 Test Prompt',
  tags: ['test'],
  usageCount: 0,
  nextVersionNumber: 1,
  status: 'active',
  createdBy: ACTOR,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockVersion: IPromptLibraryVersion = {
  _id: VERSION_ID,
  tenantId: 'tenant-int7',
  projectId: 'project-int7',
  promptId: PROMPT_ID,
  versionNumber: 1,
  template: 'Hello {{name}}',
  variables: ['name'],
  status: 'draft',
  sourceHash: 'deadbeef',
  createdBy: ACTOR,
  createdAt: new Date(),
};

beforeEach(async () => {
  _resetAuditStore();
  // No ClickHouse, no MongoDB available → falls through to InMemoryAuditStore
  await initializeAuditStore({ clickhouseReady: false });
});

afterEach(() => {
  _resetAuditStore();
});

describe('INT-7: audit emission — real record verification', () => {
  test('auditPromptCreated writes a queryable record with correct fields', async () => {
    const before = new Date(Date.now() - 1000);

    await auditPromptCreated(mockItem, ACTOR);

    const store = getAuditStore()!;
    const { logs } = await store.query({
      startTime: before,
      endTime: new Date(Date.now() + 5000),
      tenantId: mockItem.tenantId,
      projectId: mockItem.projectId,
      resourceType: 'prompt',
      resourceId: PROMPT_ID,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe('prompt.created');
    expect(logs[0].actor).toBe(ACTOR);
    expect(logs[0].actorType).toBe('user');
    expect(logs[0].resourceId).toBe(PROMPT_ID);
    expect(logs[0].tenantId).toBe(mockItem.tenantId);
    expect(logs[0].projectId).toBe(mockItem.projectId);
    expect(logs[0].metadata).toMatchObject({
      tenantId: mockItem.tenantId,
      projectId: mockItem.projectId,
      name: mockItem.name,
    });
  });

  test('auditPromptVersionCreated writes a record with version metadata', async () => {
    const before = new Date(Date.now() - 1000);

    await auditPromptVersionCreated(mockVersion, ACTOR);

    const store = getAuditStore()!;
    const { logs } = await store.query({
      startTime: before,
      endTime: new Date(Date.now() + 5000),
      resourceType: 'prompt',
      resourceId: PROMPT_ID,
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe('prompt.version_created');
    expect(logs[0].tenantId).toBe(mockVersion.tenantId);
    expect(logs[0].projectId).toBe(mockVersion.projectId);
    expect(logs[0].metadata).toMatchObject({
      versionNumber: mockVersion.versionNumber,
      sourceHash: mockVersion.sourceHash,
    });
  });

  test('auditPromptVersionPromoted writes a record with promoted status', async () => {
    const promotedVersion: IPromptLibraryVersion = {
      ...mockVersion,
      status: 'active',
      publishedAt: new Date(),
      publishedBy: ACTOR,
    };
    const before = new Date(Date.now() - 1000);

    await auditPromptVersionPromoted(promotedVersion, ACTOR);

    const store = getAuditStore()!;
    const { logs } = await store.query({
      startTime: before,
      endTime: new Date(Date.now() + 5000),
      resourceType: 'prompt',
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe('prompt.version_promoted');
    expect(logs[0].tenantId).toBe(promotedVersion.tenantId);
    expect(logs[0].projectId).toBe(promotedVersion.projectId);
    expect(logs[0].metadata).toMatchObject({ status: 'active' });
  });

  test('auditPromptVersionArchived writes a record with archived status', async () => {
    const archivedVersion: IPromptLibraryVersion = { ...mockVersion, status: 'archived' };
    const before = new Date(Date.now() - 1000);

    await auditPromptVersionArchived(archivedVersion, ACTOR);

    const store = getAuditStore()!;
    const { logs } = await store.query({
      startTime: before,
      endTime: new Date(Date.now() + 5000),
      resourceType: 'prompt',
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].eventType).toBe('prompt.version_archived');
    expect(logs[0].tenantId).toBe(archivedVersion.tenantId);
    expect(logs[0].projectId).toBe(archivedVersion.projectId);
    expect(logs[0].metadata).toMatchObject({ status: 'archived' });
  });

  test('records from different events are ordered by timestamp descending', async () => {
    const baseTime = new Date('2026-01-01T00:00:00.000Z');
    const before = new Date(baseTime.getTime() - 1000);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(baseTime);
      await auditPromptCreated(mockItem, ACTOR);
      vi.setSystemTime(new Date(baseTime.getTime() + 1000));
      await auditPromptVersionCreated(mockVersion, ACTOR);
      vi.setSystemTime(new Date(baseTime.getTime() + 2000));
      await auditPromptVersionPromoted({ ...mockVersion, status: 'active' }, ACTOR);
    } finally {
      vi.useRealTimers();
    }

    const store = getAuditStore()!;
    const { logs, total } = await store.query({
      startTime: before,
      endTime: new Date(baseTime.getTime() + 5000),
      resourceType: 'prompt',
      resourceId: PROMPT_ID,
    });

    expect(total).toBe(3);
    // InMemoryAuditStore returns newest first
    expect(logs[0].eventType).toBe('prompt.version_promoted');
    expect(logs[1].eventType).toBe('prompt.version_created');
    expect(logs[2].eventType).toBe('prompt.created');
  });

  test('no records written before the query time window', async () => {
    await auditPromptCreated(mockItem, ACTOR);

    const store = getAuditStore()!;
    // Query window is in the future — should return empty
    const future = new Date(Date.now() + 10_000);
    const { logs } = await store.query({
      startTime: future,
      endTime: new Date(future.getTime() + 5000),
      resourceType: 'prompt',
    });

    expect(logs).toHaveLength(0);
  });
});
