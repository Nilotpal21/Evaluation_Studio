import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { RedisSessionStore } from '../services/session/redis-session-store.js';
import type { SessionData } from '../services/session/types.js';
import Redis from 'ioredis';

// Real Redis required — no mocking
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

afterAll(async () => {
  await redis.quit();
});

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: `test-redis-parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: 'TestAgent',
    irSourceHash: 'hash-abc',
    compilationHash: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    initialized: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    tenantId: 'tenant-test',
    // New fields
    agentRawVersions: { TestAgent: '1.2.3' },
    backtrackCounts: { step1: 2, step2: 1 },
    constraintCollectState: {
      fields: ['email'],
      thenAction: 'continue',
      thenStep: 'confirm',
      constraintCondition: 'email_valid',
    },
    moduleProvenance: {
      'some-module': {
        alias: 'some',
        moduleProjectId: 'mod-proj-1',
        moduleReleaseId: 'rel-1',
        sourceAgentName: 'TestAgent',
      },
    },
    ...overrides,
  };
}

describe('Redis field parity', () => {
  const createdSessionIds: string[] = [];
  const store = new RedisSessionStore(redis);

  afterEach(async () => {
    for (const id of createdSessionIds) {
      try {
        await store.delete(id);
      } catch {
        // Best-effort cleanup only; failed cleanup should not mask the assertion result.
      }
    }
    createdSessionIds.length = 0;
  });

  it('round-trips agentRawVersions through Redis', async () => {
    const session = makeSession();
    await store.create(session);
    createdSessionIds.push(session.id);
    const loaded = await store.load(session.id);
    expect(loaded?.agentRawVersions).toEqual({ TestAgent: '1.2.3' });
  });

  it('round-trips backtrackCounts through Redis', async () => {
    const session = makeSession();
    await store.create(session);
    createdSessionIds.push(session.id);
    const loaded = await store.load(session.id);
    expect(loaded?.backtrackCounts).toEqual({ step1: 2, step2: 1 });
  });

  it('round-trips constraintCollectState through Redis', async () => {
    const session = makeSession();
    await store.create(session);
    createdSessionIds.push(session.id);
    const loaded = await store.load(session.id);
    expect(loaded?.constraintCollectState).toEqual({
      fields: ['email'],
      thenAction: 'continue',
      thenStep: 'confirm',
      constraintCondition: 'email_valid',
    });
  });

  it('round-trips moduleProvenance through Redis', async () => {
    const session = makeSession();
    await store.create(session);
    createdSessionIds.push(session.id);
    const loaded = await store.load(session.id);
    expect(loaded?.moduleProvenance?.['some-module']).toEqual({
      alias: 'some',
      moduleProjectId: 'mod-proj-1',
      moduleReleaseId: 'rel-1',
      sourceAgentName: 'TestAgent',
    });
  });

  it('preserves existing fields when new fields are also present', async () => {
    const session = makeSession({ agentVersions: { TestAgent: 3 } });
    await store.create(session);
    createdSessionIds.push(session.id);
    const loaded = await store.load(session.id);
    expect(loaded?.agentVersions).toEqual({ TestAgent: 3 });
    expect(loaded?.agentRawVersions).toEqual({ TestAgent: '1.2.3' });
  });
});
