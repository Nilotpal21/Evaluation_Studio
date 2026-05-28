/**
 * Message Persistence — Multi-Tenant Integration Tests
 *
 * Uses mongodb-memory-server (real MongoDB) to validate:
 * 1. Tenant isolation: messages from tenant A don't leak to tenant B
 * 2. Cross-tenant write rejection by the Mongoose tenant isolation plugin
 * 3. Atomic session updates (applySessionTurnUpdate) combine all counters
 * 4. Multi-tenant batches correctly grouped and processed in parallel
 *
 * These tests exercise the actual Mongoose plugin + ALS context bridge,
 * which is the root cause of the production circuit breaker issue.
 *
 * NOTE: Direct DB access is intentional here — we are testing the database
 * layer's tenant isolation enforcement, not an HTTP API. This is an
 * integration test of the Mongoose plugin + ALS bridge, not an E2E test.
 *
 * IMPORTANT: All Mongoose queries inside runWithTenantContext MUST be
 * explicitly awaited (async () => await Model.find()). Mongoose query
 * thenables resolve outside the ALS context if returned un-awaited.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  ensureTestIndexes,
} from './helpers/setup-mongo.js';
import {
  registerTenantContextProvider,
  withSuperAdminContext,
} from '@agent-platform/database/mongo';
import { runWithTenantContext, getTenantContextData } from '@agent-platform/shared-auth/middleware';
import { batchCreateMessages, applySessionTurnUpdate } from '../repos/session-repo.js';

// Dynamic import to avoid auto-connect side effects
async function getModels() {
  return import('@agent-platform/database/models');
}

// Build a tenant context object matching what buildWorkerTenantContext() produces
function buildWorkerTenantContext(tenantId: string) {
  return {
    tenantId,
    userId: 'system',
    role: 'system' as const,
    permissions: [] as string[],
    authType: 'api_key' as const,
    isSuperAdmin: false,
  };
}

// Minimal session data for creating test sessions
function buildSession(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'tenant-A',
    projectId: 'proj-1',
    currentAgent: 'test-agent',
    environment: 'dev',
    channel: 'web_debug',
    status: 'active',
    lastActivityAt: new Date(),
    startedAt: new Date(),
    messageCount: 0,
    tokenCount: 0,
    estimatedCost: 0,
    traceEventCount: 0,
    errorCount: 0,
    handoffCount: 0,
    ...overrides,
  };
}

describe('Message Persistence — Multi-Tenant Integration', () => {
  beforeAll(async () => {
    await setupTestMongo();

    // Set master key and encryption facade (required by Message model's encryption plugin)
    const { setMasterKey, setEncryptionFacade } = await getModels();
    setMasterKey('a'.repeat(64));
    setEncryptionFacade({
      encrypt: async (plaintext: string) => `enc:${Buffer.from(plaintext).toString('base64')}`,
      decrypt: async (ciphertext: string) => {
        if (ciphertext.startsWith('enc:')) {
          return Buffer.from(ciphertext.slice(4), 'base64').toString('utf8');
        }
        return ciphertext;
      },
      encryptJson: async (data: unknown) => JSON.stringify(data),
      decryptJson: async (data: string) => JSON.parse(data),
    });

    // Bridge shared-auth ALS → Mongoose tenant isolation plugin.
    // This replicates what apps/runtime/src/db/index.ts does at startup.
    registerTenantContextProvider(() => {
      const ctx = getTenantContextData();
      if (!ctx) return undefined;
      return { tenantId: ctx.tenantId, isSuperAdmin: ctx.isSuperAdmin };
    });

    // Ensure indexes are created (needed for idempotency unique index test)
    const { Message } = await getModels();
    await ensureTestIndexes('runtime-message-indexes', async () => {
      await Message.syncIndexes();
    });
  }, 60_000);

  afterEach(async () => {
    await clearCollections();
  });

  afterAll(async () => {
    const { _resetEncryptionStateForTesting } = await getModels();
    _resetEncryptionStateForTesting();
    await teardownTestMongo();
  }, 60_000);

  // ─── Tenant Isolation: Message Persistence ───────────────────────────

  describe('tenant isolation on message persistence', () => {
    it(
      'batchCreateMessages persists messages scoped to the correct tenant',
      { timeout: 15_000 },
      async () => {
        const { Session, Message } = await getModels();

        // Create sessions for two tenants using shared-auth ALS (production path)
        await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
          await Session.create(buildSession({ _id: 'session-A', tenantId: 'tenant-A' }));
        });
        await runWithTenantContext(buildWorkerTenantContext('tenant-B'), async () => {
          await Session.create(buildSession({ _id: 'session-B', tenantId: 'tenant-B' }));
        });

        // Persist messages for tenant-A using runWithTenantContext (the fix pattern)
        await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
          await batchCreateMessages([
            {
              sessionId: 'session-A',
              tenantId: 'tenant-A',
              projectId: 'proj-1',
              role: 'user',
              content: 'Hello from tenant A',
              channel: 'web_debug',
              timestamp: new Date(),
            },
            {
              sessionId: 'session-A',
              tenantId: 'tenant-A',
              projectId: 'proj-1',
              role: 'assistant',
              content: 'Response for tenant A',
              channel: 'web_debug',
              timestamp: new Date(),
            },
          ]);
        });

        // Persist messages for tenant-B
        await runWithTenantContext(buildWorkerTenantContext('tenant-B'), async () => {
          await batchCreateMessages([
            {
              sessionId: 'session-B',
              tenantId: 'tenant-B',
              projectId: 'proj-1',
              role: 'user',
              content: 'Hello from tenant B',
              channel: 'web_debug',
              timestamp: new Date(),
            },
          ]);
        });

        // Verify: tenant-A sees only its own messages
        const tenantAMessages = await runWithTenantContext(
          buildWorkerTenantContext('tenant-A'),
          async () => await Message.find({ sessionId: 'session-A' }).lean(),
        );
        expect(tenantAMessages).toHaveLength(2);
        expect(tenantAMessages.every((m: any) => m.tenantId === 'tenant-A')).toBe(true);

        // Verify: tenant-B sees only its own messages
        const tenantBMessages = await runWithTenantContext(
          buildWorkerTenantContext('tenant-B'),
          async () => await Message.find({ sessionId: 'session-B' }).lean(),
        );
        expect(tenantBMessages).toHaveLength(1);
        expect(tenantBMessages[0].tenantId).toBe('tenant-B');

        // Verify: tenant-A cannot see tenant-B's messages
        const crossTenantQuery = await runWithTenantContext(
          buildWorkerTenantContext('tenant-A'),
          async () => await Message.find({ sessionId: 'session-B' }).lean(),
        );
        expect(crossTenantQuery).toHaveLength(0);

        // Verify total: admin sees all 3 messages across both tenants
        const totalMessages = await withSuperAdminContext(
          async () => await Message.countDocuments({}),
        );
        expect(totalMessages).toBe(3);
      },
    );

    it(
      'rejects cross-tenant insertMany with tenant isolation violation',
      { timeout: 15_000 },
      async () => {
        // Attempt to insert a message with tenantId='tenant-B' while ALS says 'tenant-A'.
        // This is the exact bug that caused the production circuit breaker trip.
        await expect(
          runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
            await batchCreateMessages([
              {
                sessionId: 'session-B',
                tenantId: 'tenant-B', // Document says tenant-B
                projectId: 'proj-1',
                role: 'user',
                content: 'Cross-tenant attempt',
                channel: 'web_debug',
                timestamp: new Date(),
              },
            ]);
          }),
        ).rejects.toThrow(/[Tt]enant isolation violation/);
      },
    );

    it(
      'grouping by tenant and processing each in its own ALS context prevents violations',
      { timeout: 15_000 },
      async () => {
        const { Session, Message } = await getModels();

        // Create sessions for both tenants
        await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
          await Session.create(buildSession({ _id: 'sess-multi-A', tenantId: 'tenant-A' }));
        });
        await runWithTenantContext(buildWorkerTenantContext('tenant-B'), async () => {
          await Session.create(buildSession({ _id: 'sess-multi-B', tenantId: 'tenant-B' }));
        });

        // Mixed batch — exactly what comes through the BullMQ worker
        const mixedBatch = [
          {
            sessionId: 'sess-multi-A',
            tenantId: 'tenant-A',
            projectId: 'proj-1',
            role: 'user',
            content: 'Message for A',
            channel: 'web_debug',
            timestamp: new Date(),
          },
          {
            sessionId: 'sess-multi-B',
            tenantId: 'tenant-B',
            projectId: 'proj-1',
            role: 'user',
            content: 'Message for B',
            channel: 'web_debug',
            timestamp: new Date(),
          },
          {
            sessionId: 'sess-multi-A',
            tenantId: 'tenant-A',
            projectId: 'proj-1',
            role: 'assistant',
            content: 'Reply for A',
            channel: 'web_debug',
            timestamp: new Date(),
          },
        ];

        // Group by tenant (same logic as groupByTenant in message-persistence-queue.ts)
        const byTenant = new Map<string, typeof mixedBatch>();
        for (const m of mixedBatch) {
          let group = byTenant.get(m.tenantId);
          if (!group) {
            group = [];
            byTenant.set(m.tenantId, group);
          }
          group.push(m);
        }

        // Process each tenant group in its own ALS context — exactly what the fix does
        await Promise.all(
          [...byTenant.entries()].map(([tenantId, messages]) =>
            runWithTenantContext(buildWorkerTenantContext(tenantId), async () => {
              await batchCreateMessages(messages);
            }),
          ),
        );

        // Verify total records using admin context
        const allMessages = await withSuperAdminContext(async () => await Message.find({}).lean());
        expect(allMessages).toHaveLength(3);

        // Verify isolation: tenant-A sees only its 2 messages
        const aMessages = await runWithTenantContext(
          buildWorkerTenantContext('tenant-A'),
          async () => await Message.find({}).lean(),
        );
        expect(aMessages).toHaveLength(2);
        expect(aMessages.every((m: any) => m.tenantId === 'tenant-A')).toBe(true);
      },
    );
  });

  // ─── Atomic Session Updates ──────────────────────────────────────────

  describe('atomic session updates (applySessionTurnUpdate)', () => {
    it('combines all counters in a single atomic update', { timeout: 15_000 }, async () => {
      const { Session } = await getModels();

      await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
        await Session.create(
          buildSession({
            _id: 'sess-atomic',
            tenantId: 'tenant-A',
            messageCount: 5,
            tokenCount: 100,
            estimatedCost: 0.05,
            traceEventCount: 2,
            errorCount: 0,
            handoffCount: 0,
          }),
        );
      });

      // Apply atomic turn update inside correct ALS context
      await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
        await applySessionTurnUpdate(
          'sess-atomic',
          {
            messageCountIncrement: 3,
            tokenCountIncrement: 250,
            estimatedCostIncrement: 0.012,
            traceEventCountIncrement: 1,
            errorCountIncrement: 1,
            handoffCountIncrement: 1,
            touchLastActivityAt: true,
          },
          'tenant-A',
        );
      });

      // Verify all counters incremented atomically (admin bypass)
      const session: any = await withSuperAdminContext(
        async () => await Session.findOne({ _id: 'sess-atomic' }).lean(),
      );

      expect(session).toBeDefined();
      expect(session.messageCount).toBe(8); // 5 + 3
      expect(session.tokenCount).toBe(350); // 100 + 250
      expect(session.estimatedCost).toBeCloseTo(0.062); // 0.05 + 0.012
      expect(session.traceEventCount).toBe(3); // 2 + 1
      expect(session.errorCount).toBe(1); // 0 + 1
      expect(session.handoffCount).toBe(1); // 0 + 1
      expect(session.lastActivityAt).toBeDefined();
    });

    it(
      'skips zero-value increments (no $inc for undefined fields)',
      { timeout: 15_000 },
      async () => {
        const { Session } = await getModels();

        await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
          await Session.create(
            buildSession({
              _id: 'sess-partial',
              tenantId: 'tenant-A',
              messageCount: 10,
              tokenCount: 500,
              estimatedCost: 0.1,
            }),
          );
        });

        // Only update tokenCount and estimatedCost (metrics-only path)
        await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
          await applySessionTurnUpdate(
            'sess-partial',
            {
              tokenCountIncrement: 100,
              estimatedCostIncrement: 0.005,
            },
            'tenant-A',
          );
        });

        const session: any = await withSuperAdminContext(
          async () => await Session.findOne({ _id: 'sess-partial' }).lean(),
        );

        expect(session.messageCount).toBe(10); // unchanged
        expect(session.tokenCount).toBe(600); // 500 + 100
        expect(session.estimatedCost).toBeCloseTo(0.105); // 0.1 + 0.005
        expect(session.traceEventCount).toBe(0); // unchanged
      },
    );

    it('rejects when tenantId is missing', { timeout: 15_000 }, async () => {
      await expect(
        applySessionTurnUpdate('some-session', { messageCountIncrement: 1 }, ''),
      ).rejects.toThrow('tenantId is required');
    });

    it('scoped to tenant — cannot update another tenant session', { timeout: 15_000 }, async () => {
      const { Session } = await getModels();

      await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
        await Session.create(
          buildSession({
            _id: 'sess-scope-test',
            tenantId: 'tenant-A',
            messageCount: 5,
          }),
        );
      });

      // Try to update from tenant-B's context — filter includes tenantId, so no-op
      await runWithTenantContext(buildWorkerTenantContext('tenant-B'), async () => {
        await applySessionTurnUpdate(
          'sess-scope-test',
          {
            messageCountIncrement: 100,
            touchLastActivityAt: true,
          },
          'tenant-B',
        );
      });

      // Session should be unchanged
      const session: any = await withSuperAdminContext(
        async () => await Session.findOne({ _id: 'sess-scope-test' }).lean(),
      );
      expect(session.messageCount).toBe(5); // unchanged
    });
  });

  // ─── Multi-Tenant Concurrent Batch Processing ────────────────────────

  describe('multi-tenant concurrent batch processing', () => {
    it(
      'parallel tenant batches do not interfere with each other',
      { timeout: 30_000 },
      async () => {
        const { Session, Message } = await getModels();
        const tenantIds = ['tenant-1', 'tenant-2', 'tenant-3'];

        // Create sessions for each tenant
        for (const tenantId of tenantIds) {
          await runWithTenantContext(buildWorkerTenantContext(tenantId), async () => {
            await Session.create(
              buildSession({
                _id: `sess-${tenantId}`,
                tenantId,
                messageCount: 0,
                tokenCount: 0,
                estimatedCost: 0,
              }),
            );
          });
        }

        // Process all tenants concurrently — same as Promise.all in workerJobHandler
        await Promise.all(
          tenantIds.map((tenantId) =>
            runWithTenantContext(buildWorkerTenantContext(tenantId), async () => {
              await batchCreateMessages(
                Array.from({ length: 5 }, (_, i) => ({
                  sessionId: `sess-${tenantId}`,
                  tenantId,
                  projectId: 'proj-1',
                  role: i % 2 === 0 ? 'user' : 'assistant',
                  content: `Message ${i} for ${tenantId}`,
                  channel: 'web_debug',
                  timestamp: new Date(Date.now() + i),
                })),
              );

              await applySessionTurnUpdate(
                `sess-${tenantId}`,
                {
                  messageCountIncrement: 5,
                  tokenCountIncrement: 100 + tenantIds.indexOf(tenantId) * 50,
                  estimatedCostIncrement: 0.01,
                  traceEventCountIncrement: 2,
                  touchLastActivityAt: true,
                },
                tenantId,
              );
            }),
          ),
        );

        // Verify total: 15 messages across all tenants
        const totalMessages = await withSuperAdminContext(
          async () => await Message.countDocuments({}),
        );
        expect(totalMessages).toBe(15);

        // Verify isolation: each tenant sees only 5 messages
        for (const tenantId of tenantIds) {
          const messages = await runWithTenantContext(
            buildWorkerTenantContext(tenantId),
            async () => await Message.find({}).lean(),
          );
          expect(messages).toHaveLength(5);
          expect(messages.every((m: any) => m.tenantId === tenantId)).toBe(true);

          const session: any = await withSuperAdminContext(
            async () => await Session.findOne({ _id: `sess-${tenantId}` }).lean(),
          );
          expect(session.messageCount).toBe(5);
          expect(session.tokenCount).toBe(100 + tenantIds.indexOf(tenantId) * 50);
          expect(session.estimatedCost).toBeCloseTo(0.01);
          expect(session.traceEventCount).toBe(2);
        }
      },
    );

    it(
      'multiple session updates for the same tenant accumulate correctly',
      { timeout: 15_000 },
      async () => {
        const { Session } = await getModels();

        await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
          await Session.create(
            buildSession({
              _id: 'sess-accumulate',
              tenantId: 'tenant-A',
              messageCount: 0,
              tokenCount: 0,
              estimatedCost: 0,
            }),
          );
        });

        // Simulate multiple turn updates (different flush cycles)
        for (let i = 0; i < 5; i++) {
          await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
            await applySessionTurnUpdate(
              'sess-accumulate',
              {
                messageCountIncrement: 2,
                tokenCountIncrement: 50,
                estimatedCostIncrement: 0.003,
                touchLastActivityAt: true,
              },
              'tenant-A',
            );
          });
        }

        const session: any = await withSuperAdminContext(
          async () => await Session.findOne({ _id: 'sess-accumulate' }).lean(),
        );
        expect(session.messageCount).toBe(10); // 5 * 2
        expect(session.tokenCount).toBe(250); // 5 * 50
        expect(session.estimatedCost).toBeCloseTo(0.015); // 5 * 0.003
      },
    );
  });

  // ─── ALS Context Bridge Validation ───────────────────────────────────

  describe('ALS context bridge (shared-auth → Mongoose plugin)', () => {
    it(
      'runWithTenantContext auto-injects tenantId on document creation',
      { timeout: 15_000 },
      async () => {
        const { Session } = await getModels();

        // Create a session with tenantId omitted — plugin should auto-inject from ALS
        const session = await runWithTenantContext(
          buildWorkerTenantContext('tenant-auto'),
          async () =>
            await Session.create({
              _id: 'sess-als-bridge',
              projectId: 'proj-1',
              currentAgent: 'test-agent',
              environment: 'dev',
              channel: 'web_debug',
              status: 'active',
              lastActivityAt: new Date(),
              startedAt: new Date(),
              messageCount: 0,
              tokenCount: 0,
              estimatedCost: 0,
              traceEventCount: 0,
              errorCount: 0,
              handoffCount: 0,
            }),
        );

        expect(session.tenantId).toBe('tenant-auto');

        // Verify findOne also filtered by tenant
        const found: any = await runWithTenantContext(
          buildWorkerTenantContext('tenant-auto'),
          async () => await Session.findOne({ _id: 'sess-als-bridge' }).lean(),
        );
        expect(found).toBeDefined();
        expect(found.tenantId).toBe('tenant-auto');
      },
    );

    it(
      'queries are scoped by tenant context — different context sees nothing',
      { timeout: 15_000 },
      async () => {
        const { Session, Message } = await getModels();

        // Create data inside tenant-X context
        await runWithTenantContext(buildWorkerTenantContext('tenant-X'), async () => {
          await Session.create(buildSession({ _id: 'sess-no-ctx', tenantId: 'tenant-X' }));
        });

        await runWithTenantContext(buildWorkerTenantContext('tenant-X'), async () => {
          await batchCreateMessages([
            {
              sessionId: 'sess-no-ctx',
              tenantId: 'tenant-X',
              projectId: 'proj-1',
              role: 'user',
              content: 'Test message',
              channel: 'web_debug',
              timestamp: new Date(),
            },
          ]);
        });

        // Query with different tenant context — should return empty
        const wrongTenant = await runWithTenantContext(
          buildWorkerTenantContext('tenant-Y'),
          async () => await Message.find({ sessionId: 'sess-no-ctx' }).lean(),
        );
        expect(wrongTenant).toHaveLength(0);

        // Query with correct tenant context — should return the message
        const rightTenant = await runWithTenantContext(
          buildWorkerTenantContext('tenant-X'),
          async () => await Message.find({ sessionId: 'sess-no-ctx' }).lean(),
        );
        expect(rightTenant).toHaveLength(1);

        // Admin sees it regardless
        const adminView = await withSuperAdminContext(
          async () => await Message.find({ sessionId: 'sess-no-ctx' }).lean(),
        );
        expect(adminView).toHaveLength(1);
      },
    );
  });

  // ─── Message Idempotency ─────────────────────────────────────────────

  describe('message idempotency', () => {
    it('duplicate idempotencyKey messages are silently ignored', { timeout: 15_000 }, async () => {
      const { Session, Message } = await getModels();

      await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
        await Session.create(buildSession({ _id: 'sess-idem', tenantId: 'tenant-A' }));
      });

      const messageData = {
        sessionId: 'sess-idem',
        tenantId: 'tenant-A',
        projectId: 'proj-1',
        role: 'user',
        content: 'Duplicate test',
        channel: 'web_debug',
        timestamp: new Date(),
        idempotencyKey: 'unique-key-123',
      };

      // Insert once
      await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
        await batchCreateMessages([messageData]);
      });

      // Insert again with same idempotencyKey — should not throw
      await runWithTenantContext(buildWorkerTenantContext('tenant-A'), async () => {
        await batchCreateMessages([messageData]);
      });

      // Should still be only 1 message
      const count = await withSuperAdminContext(
        async () => await Message.countDocuments({ sessionId: 'sess-idem' }),
      );
      expect(count).toBe(1);
    });
  });
});
