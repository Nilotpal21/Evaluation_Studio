/**
 * RCA 3 reproduction — `failed to decompress cold session (internal)`.
 *
 * Goal: prove that when SessionState.stateData is encrypted by the plugin, the
 * plugin's post-findOne hook decrypts back to a JSON string, Mongoose coerces
 * that string into a Buffer-typed schema field using utf8 encoding, and
 * SessionStateRepo.decompressJson then feeds those UTF-8 bytes into gunzip,
 * producing "incorrect header check".
 *
 * This is a reproduction test — it should FAIL with the current code and
 * start passing only after the fix in decompressJson.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { randomBytes } from 'node:crypto';

// ── DEK manager fixture (replaces the DB-backed one from @agent-platform/database) ──
class InMemoryDEKManager {
  private masterKey = randomBytes(32);
  private deks = new Map<string, Buffer>();

  async acquireDEK(scope: { tenantId: string; projectId: string; environment: string }) {
    const dekId = `dek-${scope.tenantId}`;
    let dek = this.deks.get(dekId);
    if (!dek) {
      dek = randomBytes(32);
      this.deks.set(dekId, dek);
    }
    return { dekId, plaintext: dek };
  }

  async unwrapDEK(dekId: string) {
    const dek = this.deks.get(dekId);
    if (!dek) throw new Error(`DEK not found for dekId ${dekId}`);
    return dek;
  }

  getActiveDEKId() {
    return 'unused-sync-path';
  }
  getCachedDEK() {
    return null;
  }
}

describe('RCA 3 — Mongoose coerces decrypted string to Buffer, gunzip fails', () => {
  let replSet: MongoMemoryReplSet;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri(), { dbName: 'rca-test' });

    // Initialize the encryption facade BEFORE importing session-state-repo
    const { TenantEncryptionFacade, setGlobalEncryptionFacade } =
      await import('@agent-platform/shared-encryption');
    setGlobalEncryptionFacade(new TenantEncryptionFacade(new InMemoryDEKManager() as never));
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet.stop();
  });

  it('round-trips a session through upsert + loadInternal (fails with incorrect header check)', async () => {
    const { SessionStateRepo } = await import('../session-state-repo.js');
    const repo = new SessionStateRepo({ coldTtlDays: 1 });

    const sessionId = 'rca3-test-' + Date.now();
    const tenantId = '019d77a2-5e60-7f87-ad01-207f672041ef';
    const projectId = '019d86e3-629c-7c00-9f4f-31ab8713b8e7';

    const session: any = {
      id: sessionId,
      tenantId,
      projectId,
      environment: 'dev',
      agentName: 'test-agent',
      version: 1,
      lastActivityAt: Date.now(),
      activeThreadIndex: 0,
      threadStack: [0],
      dataValues: { foo: 'bar' },
      dataGatheredKeys: [],
      state: {},
      handoffStack: [],
      delegateStack: [],
      isComplete: false,
      isEscalated: false,
      transferInitiated: false,
      initialized: true,
      callerContext: { tenantId, initiatedById: 'u1' },
      executionScopeKind: 'user',
      agentVersions: {},
      threads: [
        {
          agentName: 'test-agent',
          status: 'active',
          irSourceHash: 'hash',
          dataValues: {},
          dataGatheredKeys: [],
          state: {},
          conversationHistory: [{ role: 'user', content: 'hi' }],
          startedAt: Date.now(),
        },
      ],
    };

    // Step 1: Save via the real upsert — this invokes the encryption plugin's
    // pre('save') hook to encrypt stateData.
    await repo.upsert(session);

    // Step 2: Load via loadInternal — this invokes the plugin's post('findOne')
    // hook which decrypts stateData back to a JSON string. Mongoose schema-casts
    // that string into a Buffer (utf8), then decompressJson tries to gunzip it.
    const loaded = await repo.loadInternal(sessionId);

    // If the bug exists, loadInternal catches the gunzip failure and returns null.
    // If fixed, it returns the original session data.
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(sessionId);
    expect((loaded as any)?.dataValues).toEqual({ foo: 'bar' });
  }, 30_000);
});
