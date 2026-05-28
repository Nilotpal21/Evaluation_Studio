/**
 * Workflow Definition Store Tests
 *
 * Tests for InMemoryWorkflowDefinitionStore CRUD operations.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  InMemoryWorkflowDefinitionStore,
  type WorkflowDefinitionStoreConfig,
} from '../../platform/stores/workflow-definition-store.js';

describe('InMemoryWorkflowDefinitionStore', () => {
  let store: InMemoryWorkflowDefinitionStore;

  beforeEach(() => {
    const config: WorkflowDefinitionStoreConfig = { type: 'memory' };
    store = new InMemoryWorkflowDefinitionStore(config);
  });

  describe('create', () => {
    test('creates a workflow definition with required fields', async () => {
      const def = await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'customer-onboarding',
      });

      expect(def.id).toBeDefined();
      expect(def.tenantId).toBe('org-1');
      expect(def.projectId).toBe('proj-1');
      expect(def.name).toBe('customer-onboarding');
      expect(def.type).toBe('cx_automation');
      expect(def.steps).toEqual([]);
      expect(def.triggers).toEqual([]);
      expect(def.escalationRules).toEqual([]);
      expect(def.status).toBe('active');
      expect(def.metadata).toEqual({});
      expect(def.createdAt).toBeInstanceOf(Date);
    });

    test('accepts optional fields', async () => {
      const def = await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'ticket-resolution',
        type: 'ex_automation',
        description: 'Auto-resolve support tickets',
        steps: [{ name: 'classify' }, { name: 'resolve' }],
        triggers: [{ event: 'ticket.created' }],
        slaMinutes: 60,
        escalationRules: [{ after: 30, to: 'manager' }],
        metadata: { version: '2.0' },
      });

      expect(def.type).toBe('ex_automation');
      expect(def.description).toBe('Auto-resolve support tickets');
      expect(def.steps).toHaveLength(2);
      expect(def.triggers).toHaveLength(1);
      expect(def.slaMinutes).toBe(60);
      expect(def.escalationRules).toHaveLength(1);
      expect(def.metadata).toEqual({ version: '2.0' });
    });
  });

  describe('getById', () => {
    test('returns definition by ID', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'test-wf',
      });

      const found = await store.getById(created.id, 'org-1', 'proj-1');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('test-wf');
    });

    test('returns null for non-existent ID', async () => {
      const found = await store.getById('non-existent', 'org-1', 'proj-1');
      expect(found).toBeNull();
    });

    test('returns null for wrong tenant', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'test-wf',
      });

      const found = await store.getById(created.id, 'org-2', 'proj-1');
      expect(found).toBeNull();
    });
  });

  describe('getByName', () => {
    test('finds definition by org, project, and name', async () => {
      await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'billing-workflow',
      });

      const found = await store.getByName('org-1', 'proj-1', 'billing-workflow');
      expect(found).not.toBeNull();
    });

    test('returns null when org does not match', async () => {
      await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'wf',
      });

      const found = await store.getByName('org-2', 'proj-1', 'wf');
      expect(found).toBeNull();
    });

    test('returns null when project does not match', async () => {
      await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'wf',
      });

      const found = await store.getByName('org-1', 'proj-2', 'wf');
      expect(found).toBeNull();
    });
  });

  describe('update', () => {
    test('updates definition fields', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'original',
      });

      const updated = await store.update(created.id, 'org-1', 'proj-1', {
        name: 'updated',
        slaMinutes: 120,
        status: 'paused',
      });

      expect(updated.name).toBe('updated');
      expect(updated.slaMinutes).toBe(120);
      expect(updated.status).toBe('paused');
    });

    test('merges metadata', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        projectId: 'proj-1',
        name: 'meta-test',
        metadata: { a: 1 },
      });

      const updated = await store.update(created.id, 'org-1', 'proj-1', {
        metadata: { b: 2 },
      });

      expect(updated.metadata).toEqual({ a: 1, b: 2 });
    });

    test('throws for non-existent definition', async () => {
      await expect(
        store.update('non-existent', 'org-1', 'proj-1', { name: 'test' }),
      ).rejects.toThrow('WorkflowDefinition non-existent not found');
    });
  });

  describe('query', () => {
    test('filters by organization', async () => {
      await store.create({ tenantId: 'org-1', projectId: 'p1', name: 'a' });
      await store.create({ tenantId: 'org-2', projectId: 'p1', name: 'b' });

      const result = await store.query({ tenantId: 'org-1' });
      expect(result.total).toBe(1);
      expect(result.definitions[0].name).toBe('a');
    });

    test('filters by project', async () => {
      await store.create({ tenantId: 'org-1', projectId: 'proj-1', name: 'a' });
      await store.create({ tenantId: 'org-1', projectId: 'proj-2', name: 'b' });

      const result = await store.query({ tenantId: 'org-1', projectId: 'proj-1' });
      expect(result.total).toBe(1);
    });

    test('filters by type', async () => {
      await store.create({
        tenantId: 'org-1',
        projectId: 'p1',
        name: 'a',
        type: 'cx_automation',
      });
      await store.create({
        tenantId: 'org-1',
        projectId: 'p1',
        name: 'b',
        type: 'internal',
      });

      const result = await store.query({ tenantId: 'org-1', type: 'internal' });
      expect(result.total).toBe(1);
      expect(result.definitions[0].type).toBe('internal');
    });

    test('filters by status', async () => {
      const def = await store.create({
        tenantId: 'org-1',
        projectId: 'p1',
        name: 'a',
      });
      await store.create({ tenantId: 'org-1', projectId: 'p1', name: 'b' });
      await store.archive(def.id, 'org-1', 'p1');

      const result = await store.query({ tenantId: 'org-1', status: 'active' });
      expect(result.total).toBe(1);
      expect(result.definitions[0].name).toBe('b');
    });

    test('paginates results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.create({
          tenantId: 'org-1',
          projectId: 'p1',
          name: `wf-${i}`,
        });
      }

      const result = await store.query({ tenantId: 'org-1', limit: 2, offset: 1 });
      expect(result.definitions.length).toBe(2);
      expect(result.total).toBe(5);
    });
  });

  describe('archive', () => {
    test('sets status to archived', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        projectId: 'p1',
        name: 'to-archive',
      });

      await store.archive(created.id, 'org-1', 'p1');

      const found = await store.getById(created.id, 'org-1', 'p1');
      expect(found!.status).toBe('archived');
    });

    test('throws for non-existent definition', async () => {
      await expect(store.archive('non-existent', 'org-1', 'p1')).rejects.toThrow(
        'WorkflowDefinition non-existent not found',
      );
    });
  });
});
