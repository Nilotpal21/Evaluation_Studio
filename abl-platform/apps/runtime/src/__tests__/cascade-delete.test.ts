/**
 * Cascade Delete Tests
 *
 * Tests cascade delete operations using mongodb-memory-server.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { initDEKFacade } from '@agent-platform/database/kms';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';
import {
  deleteTenant,
  deleteProject,
  deleteUser,
  deleteSession,
} from '@agent-platform/database/cascade';

// Dynamic import to avoid auto-connect side effect from models/index.ts
async function getModels() {
  return import('@agent-platform/database/models');
}

const now = new Date();

function buildPiiAuditLog(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    sessionId: 'session-1',
    tokenId: 'token-1',
    piiType: 'email',
    consumer: 'tools',
    action: 'render',
    ...overrides,
  };
}

describe('Cascade Delete', () => {
  beforeAll(async () => {
    // Connect to in-memory MongoDB FIRST (before models auto-connect)
    await setupTestMongo();
    // Encryption plugin requires a master key for User model
    const { setMasterKey } = await getModels();
    setMasterKey('a'.repeat(64));
    await initDEKFacade({ masterKeyHex: 'a'.repeat(64) });
  }, 60_000);

  afterEach(async () => {
    await clearCollections();
  }, 120_000);

  afterAll(async () => {
    await teardownTestMongo();
  });

  describe('deleteTenant', () => {
    test('deletes tenant and all children', { timeout: 30_000 }, async () => {
      const models = await getModels();

      // Create tenant hierarchy
      const tenant = await models.Tenant.create({
        name: 'Test Tenant',
        slug: 'test-tenant',
        organizationId: 'org-1',
        ownerId: 'owner-1',
      });
      const tenantId = tenant._id.toString();

      const project = await models.Project.create({
        name: 'Test Project',
        slug: 'test-project',
        ownerId: 'owner-1',
        tenantId,
      });
      const projectId = project._id.toString();

      const agent = await models.ProjectAgent.create({
        tenantId,
        projectId,
        name: 'Test_Agent',
        agentPath: `${projectId}/Test_Agent`,
      });
      const agentId = agent._id.toString();

      await models.AgentVersion.create({
        agentId,
        version: '1.0.0',
        status: 'active',
        sourceHash: 'abc123',
        dslContent: 'AGENT test',
        irContent: '{}',
        createdBy: 'owner-1',
      });

      const session = await models.Session.create({
        tenantId,
        projectId,
        channel: 'web',
        status: 'active',
        currentAgent: 'Test_Agent',
        environment: 'dev',
        startedAt: now,
        lastActivityAt: now,
      });
      const sessionId = session._id.toString();

      await models.Message.create({
        sessionId,
        tenantId,
        projectId,
        role: 'user',
        content: 'Hello',
        channel: 'web',
      });

      await models.Contact.create({
        tenantId,
        type: 'customer',
        firstSeenAt: now,
        lastSeenAt: now,
      });

      await models.AuditLog.create({
        tenantId,
        userId: 'user-1',
        action: 'session.created',
      });

      await models.PIIAuditLog.create([
        buildPiiAuditLog({
          tenantId,
          projectId,
          sessionId,
          tokenId: 'tenant-log-token',
        }),
        buildPiiAuditLog({
          tenantId: 'tenant-2',
          projectId: 'other-project',
          sessionId: 'tenant-2-session',
          tokenId: 'other-tenant-token',
        }),
      ]);

      // Execute cascade delete
      const result = await deleteTenant(tenantId);

      // Verify counts
      expect(result.total).toBeGreaterThan(0);
      expect(result.counts.Tenant).toBe(1);
      expect(result.counts.Project).toBe(1);
      expect(result.counts.ProjectAgent).toBe(1);
      expect(result.counts.AgentVersion).toBe(1);
      expect(result.counts.Session).toBe(1);
      expect(result.counts.Message).toBe(1);
      expect(result.counts.Contact).toBe(1);
      expect(result.counts.PIIAuditLog).toBe(1);

      // Verify AuditLog is anonymized, not deleted
      // Note: audit trail plugin auto-creates entries on model save, so filter by the test's specific entry
      expect(result.anonymized.AuditLog).toBeGreaterThanOrEqual(1);
      const auditLogs = await models.AuditLog.find({ action: 'session.created' }).lean();
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0].userId).toBeNull();

      // Verify all children actually deleted
      expect(await models.Tenant.countDocuments({ _id: tenantId })).toBe(0);
      expect(await models.Project.countDocuments({ tenantId })).toBe(0);
      expect(await models.Session.countDocuments({ tenantId })).toBe(0);
      expect(await models.PIIAuditLog.countDocuments({ tenantId })).toBe(0);
      expect(await models.PIIAuditLog.countDocuments({ tenantId: 'tenant-2' })).toBe(1);
    });
  });

  describe('deleteProject', () => {
    test('deletes project and all children', async () => {
      const models = await getModels();

      const project = await models.Project.create({
        name: 'Test Project',
        slug: 'test-project-2',
        ownerId: 'owner-1',
        tenantId: 'tenant-1',
      });
      const projectId = project._id.toString();

      const agent = await models.ProjectAgent.create({
        tenantId: 'tenant-1',
        projectId,
        name: 'Agent_1',
        agentPath: `${projectId}/Agent_1`,
      });

      await models.AgentVersion.create({
        agentId: agent._id.toString(),
        version: '1.0.0',
        status: 'draft',
        sourceHash: 'hash1',
        dslContent: 'AGENT test',
        irContent: '{}',
        createdBy: 'owner-1',
      });

      const session = await models.Session.create({
        projectId,
        tenantId: 'tenant-1',
        channel: 'web',
        status: 'active',
        currentAgent: 'Agent_1',
        environment: 'dev',
        startedAt: now,
        lastActivityAt: now,
      });

      await models.Message.create({
        sessionId: session._id.toString(),
        tenantId: 'tenant-1',
        projectId,
        role: 'assistant',
        content: 'Hi there',
        channel: 'web',
      });

      await models.PIIAuditLog.create([
        buildPiiAuditLog({
          projectId,
          sessionId: session._id.toString(),
          tokenId: 'project-log-token',
        }),
        buildPiiAuditLog({
          tenantId: 'tenant-2',
          projectId,
          sessionId: 'tenant-2-session',
          tokenId: 'cross-tenant-log-token',
        }),
      ]);

      const result = await deleteProject(projectId);

      expect(result.counts.Project).toBe(1);
      expect(result.counts.ProjectAgent).toBe(1);
      expect(result.counts.AgentVersion).toBe(1);
      expect(result.counts.Session).toBe(1);
      expect(result.counts.Message).toBe(1);
      expect(result.counts.PIIAuditLog).toBe(1);
      expect(result.total).toBeGreaterThanOrEqual(5);
      expect(await models.PIIAuditLog.countDocuments({ tenantId: 'tenant-1', projectId })).toBe(0);
      expect(await models.PIIAuditLog.countDocuments({ tenantId: 'tenant-2', projectId })).toBe(1);
    });
  });

  describe('deleteUser', () => {
    test('deletes user and anonymizes audit logs', async () => {
      const models = await getModels();

      const user = await models.User.create({
        email: 'test@example.com',
        passwordHash: 'hash',
        name: 'Test User',
        authProvider: 'local',
      });
      const userId = user._id.toString();

      await models.RefreshToken.create({
        userId,
        token: 'refresh-token-hash',
        expiresAt: new Date(Date.now() + 86400000),
      });

      await models.AuditLog.create({
        userId,
        action: 'session.created',
      });

      const result = await deleteUser(userId);

      expect(result.counts.User).toBe(1);
      expect(result.counts.RefreshToken).toBe(1);
      expect(result.anonymized.AuditLog).toBe(1);

      // Audit log still exists but userId is null
      // Note: audit trail plugin auto-creates entries on model save, so filter by the test's specific entry
      const logs = await models.AuditLog.find({ action: 'session.created' }).lean();
      expect(logs).toHaveLength(1);
      expect(logs[0].userId).toBeNull();
    });
  });

  describe('deleteSession', () => {
    test('deletes session and messages', async () => {
      const models = await getModels();

      const session = await models.Session.create({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channel: 'web',
        status: 'active',
        currentAgent: 'agent-1',
        environment: 'dev',
        startedAt: now,
        lastActivityAt: now,
      });
      const sessionId = session._id.toString();

      await models.Message.create([
        {
          sessionId,
          tenantId: 'tenant-1',
          projectId: 'project-1',
          role: 'user',
          content: 'msg 1',
          channel: 'web',
        },
        {
          sessionId,
          tenantId: 'tenant-1',
          projectId: 'project-1',
          role: 'assistant',
          content: 'msg 2',
          channel: 'web',
        },
        {
          sessionId,
          tenantId: 'tenant-1',
          projectId: 'project-1',
          role: 'user',
          content: 'msg 3',
          channel: 'web',
        },
      ]);

      const result = await deleteSession(sessionId);

      expect(result.counts.Session).toBe(1);
      expect(result.counts.Message).toBe(3);
      expect(result.total).toBe(4);

      expect(await models.Session.countDocuments({ _id: sessionId })).toBe(0);
      expect(await models.Message.countDocuments({ sessionId })).toBe(0);
    });
  });
});
