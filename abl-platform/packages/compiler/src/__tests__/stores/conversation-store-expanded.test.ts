/**
 * Conversation Store Expanded Fields Tests
 *
 * Tests for the new contactId, workflowId, linkContact, and associateWorkflow methods.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { runWithTenantContext } from '@agent-platform/shared';
import {
  InMemoryConversationStore,
  type ConversationStoreConfig,
} from '../../platform/stores/conversation-store.js';

describe('InMemoryConversationStore - Expanded Fields', () => {
  let store: InMemoryConversationStore;

  beforeEach(() => {
    const config: ConversationStoreConfig = { type: 'memory' };
    store = new InMemoryConversationStore(config);
  });

  describe('createSession with new fields', () => {
    test('creates session with contactId', async () => {
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'test_agent',
        agentVersion: '1.0.0',
        contactId: 'contact-123',
      });

      expect(session.contactId).toBe('contact-123');
    });

    test('creates session with all expanded fields', async () => {
      const session = await store.createSession({
        channel: 'voice',
        environment: 'production',
        agentName: 'voice_agent',
        agentVersion: '2.0.0',
        contactId: 'contact-1',
        callerNumber: '+15551234567',
        initiatedById: 'user-1',
        projectId: 'proj-1',
        tenantId: 'org-1',
        workflowId: 'wf-1',
        parentId: 'parent-session-1',
      });

      expect(session.contactId).toBe('contact-1');
      expect(session.callerNumber).toBe('+15551234567');
      expect(session.initiatedById).toBe('user-1');
      expect(session.projectId).toBe('proj-1');
      expect(session.tenantId).toBe('org-1');
      expect(session.workflowId).toBe('wf-1');
      expect(session.parentId).toBe('parent-session-1');
    });

    test('expanded fields are undefined when not provided', async () => {
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'test_agent',
        agentVersion: '1.0.0',
      });

      expect(session.contactId).toBeUndefined();
      expect(session.callerNumber).toBeUndefined();
      expect(session.initiatedById).toBeUndefined();
      expect(session.projectId).toBeUndefined();
      expect(session.workflowId).toBeUndefined();
      expect(session.parentId).toBeUndefined();
    });
  });

  describe('linkContact', () => {
    test('links a contact to a session', async () => {
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'agent',
        agentVersion: '1.0.0',
      });

      expect(session.contactId).toBeUndefined();

      await store.linkContact(session.id, 'contact-456');

      const updated = await store.getSession(session.id);
      expect(updated!.contactId).toBe('contact-456');
    });

    test('throws for non-existent session', async () => {
      await expect(store.linkContact('non-existent', 'contact-1')).rejects.toThrow(
        'Session non-existent not found',
      );
    });

    test('updates lastActivityAt', async () => {
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'agent',
        agentVersion: '1.0.0',
      });

      const originalTime = session.lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));

      await store.linkContact(session.id, 'contact-1');

      const updated = await store.getSession(session.id);
      expect(updated!.lastActivityAt.getTime()).toBeGreaterThan(originalTime.getTime());
    });
  });

  describe('associateWorkflow', () => {
    test('associates a workflow with a session', async () => {
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'agent',
        agentVersion: '1.0.0',
      });

      await store.associateWorkflow(session.id, 'wf-123');

      const updated = await store.getSession(session.id);
      expect(updated!.workflowId).toBe('wf-123');
    });

    test('associates workflow with step ID', async () => {
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'dev',
        agentName: 'agent',
        agentVersion: '1.0.0',
      });

      await store.associateWorkflow(session.id, 'wf-123', 'step-2');

      const updated = await store.getSession(session.id);
      expect(updated!.workflowId).toBe('wf-123');
      expect(updated!.workflowStepId).toBe('step-2');
    });

    test('throws for non-existent session', async () => {
      await expect(store.associateWorkflow('non-existent', 'wf-1')).rejects.toThrow(
        'Session non-existent not found',
      );
    });
  });

  describe('captureAbandonedCall', () => {
    test('creates abandoned sessions with tenantId from ambient tenant context', async () => {
      await runWithTenantContext(
        {
          tenantId: 'tenant-from-als',
          userId: 'user-1',
          role: 'member',
          permissions: [],
          authType: 'user',
          isSuperAdmin: false,
        },
        async () => {
          await store.captureAbandonedCall(
            'abandoned-session-als',
            'partial transcript',
            'caller_hangup',
          );
        },
      );

      const abandoned = await store.getSession('abandoned-session-als');
      expect(abandoned).not.toBeNull();
      expect(abandoned!.tenantId).toBe('tenant-from-als');
      expect(abandoned!.context.lastTranscript).toBe('partial transcript');
      expect(abandoned!.metadata.tags).toEqual(
        expect.arrayContaining(['abandoned_call', 'incomplete_transcript']),
      );
      expect(abandoned!.metadata.tags).not.toContain('tenant_orphaned');
    });

    test('marks abandoned sessions as orphaned when no tenant context is available', async () => {
      await store.captureAbandonedCall('abandoned-session-orphaned', '', 'caller_hangup');

      const abandoned = await store.getSession('abandoned-session-orphaned');
      expect(abandoned).not.toBeNull();
      expect(abandoned!.tenantId).toBe('__orphaned__');
      expect(abandoned!.context.tenantResolution).toBe('orphaned');
      expect(abandoned!.metadata.tags).toContain('tenant_orphaned');
    });

    test('backfills tenantId on existing sessions before marking them abandoned', async () => {
      const session = await store.createSession({
        channel: 'voice',
        environment: 'production',
        agentName: 'voice_agent',
        agentVersion: '1.0.0',
      });
      const staleActivityAt = new Date(Date.now() - 60_000);
      session.lastActivityAt = staleActivityAt;

      await runWithTenantContext(
        {
          tenantId: 'tenant-backfill',
          userId: 'user-2',
          role: 'member',
          permissions: [],
          authType: 'user',
          isSuperAdmin: false,
        },
        async () => {
          await store.captureAbandonedCall(session.id, 'goodbye', 'disconnect');
        },
      );

      const updated = await store.getSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.tenantId).toBe('tenant-backfill');
      expect(updated!.status).toBe('abandoned');
      expect(updated!.disposition).toBe('abandoned');
      expect(updated!.context.lastTranscript).toBe('goodbye');
      expect(updated!.lastActivityAt.getTime()).toBeGreaterThan(staleActivityAt.getTime());

      const deleted = await store.cleanup(1_000);
      expect(deleted).toBe(0);
      expect(await store.getSession(session.id)).not.toBeNull();
    });
  });

  describe('end-to-end: contact linking flow', () => {
    test('anonymous session → identify contact → link', async () => {
      // 1. Create anonymous session
      const session = await store.createSession({
        channel: 'web_chat',
        environment: 'production',
        agentName: 'support_agent',
        agentVersion: '1.0.0',
        anonymousId: 'anon-visitor-42',
      });

      expect(session.contactId).toBeUndefined();
      expect(session.anonymousId).toBe('anon-visitor-42');

      // 2. Later, contact is identified and linked
      await store.linkContact(session.id, 'contact-real-user');

      // 3. Verify round-trip
      const final = await store.getSession(session.id);
      expect(final!.contactId).toBe('contact-real-user');
      expect(final!.anonymousId).toBe('anon-visitor-42');
      expect(final!.status).toBe('active');
    });
  });
});
