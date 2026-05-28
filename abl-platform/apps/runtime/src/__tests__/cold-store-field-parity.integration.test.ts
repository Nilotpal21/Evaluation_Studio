import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { SessionStateRepo } from '../services/session/session-state-repo.js';
import type { SessionData, AgentThreadData } from '../services/session/types.js';
import { setupTestMongo, teardownTestMongo, clearCollections } from './helpers/setup-mongo.js';

async function getModels() {
  return import('@agent-platform/database/models');
}

beforeAll(async () => {
  await setupTestMongo();

  // Set up encryption facade (required by SessionState model's encryption plugin)
  const { setMasterKey, setEncryptionFacade } = await getModels();
  setMasterKey('a'.repeat(64));
  // No-op encryption facade: pass through plaintext unchanged.
  // stateData is a gzipped Buffer serialized as JSON; any encoding transformation
  // (e.g. base64 wrapping) would corrupt the gzip header on decompression.
  setEncryptionFacade({
    encrypt: async (plaintext: string) => plaintext,
    decrypt: async (ciphertext: string) => ciphertext,
    encryptJson: async (data: unknown) => JSON.stringify(data),
    decryptJson: async (data: string) => JSON.parse(data),
  });
}, 60_000);

afterEach(async () => {
  await clearCollections();
}, 120_000);

afterAll(async () => {
  const { _resetEncryptionStateForTesting } = await getModels();
  _resetEncryptionStateForTesting();
  await teardownTestMongo();
}, 60_000);

function makeThread(overrides: Partial<AgentThreadData> = {}): AgentThreadData {
  return {
    agentName: 'TestAgent',
    irSourceHash: 'hash-abc',
    conversationHistory: [{ role: 'user', content: 'hello' }],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    dataValues: {},
    dataGatheredKeys: [],
    startedAt: Date.now(),
    returnExpected: false,
    status: 'completed',
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  const now = Date.now();
  return {
    id: `test-cold-parity-${now}-${Math.random().toString(36).slice(2, 8)}`,
    agentName: 'TestAgent',
    irSourceHash: 'hash-abc',
    compilationHash: 'comp-hash-xyz',
    conversationHistory: [
      { role: 'user', content: 'thread0 message' },
      { role: 'assistant', content: 'thread1 response' },
    ],
    state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
    version: 1,
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    dataValues: {},
    dataGatheredKeys: [],
    initialized: true,
    createdAt: now - 5000, // 5 seconds ago
    lastActivityAt: now,
    threads: [
      makeThread({
        conversationHistory: [{ role: 'user', content: 'thread0 message' }],
        status: 'completed',
      }),
      makeThread({
        agentName: 'SubAgent',
        conversationHistory: [{ role: 'assistant', content: 'thread1 response' }],
        status: 'active',
      }),
    ],
    activeThreadIndex: 1,
    threadStack: [0],
    tenantId: 'tenant-test',
    projectId: 'proj-test',
    userId: 'user-test-123',
    piiVaultData: 'encrypted-pii-blob',
    piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: false },
    gatherFieldsCollected: ['email', 'name'],
    agentRawVersions: { TestAgent: '2.0.0', SubAgent: '1.0.0' },
    moduleProvenance: {
      'mod-1': {
        alias: 'payments',
        moduleProjectId: 'mod-proj-1',
        moduleReleaseId: 'rel-1',
        sourceAgentName: 'TestAgent',
      },
    },
    ...overrides,
  };
}

describe('Cold store field parity', () => {
  const repo = new SessionStateRepo({ coldTtlDays: 90 });

  it('round-trips piiVaultData through cold store', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.piiVaultData).toBe('encrypted-pii-blob');
  });

  it('round-trips piiRedactionConfig through cold store', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.piiRedactionConfig).toEqual({
      enabled: true,
      redactInput: true,
      redactOutput: false,
    });
  });

  it('round-trips gatherFieldsCollected through cold store', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.gatherFieldsCollected).toEqual(['email', 'name']);
  });

  it('round-trips agentRawVersions through cold store', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.agentRawVersions).toEqual({ TestAgent: '2.0.0', SubAgent: '1.0.0' });
  });

  it('round-trips moduleProvenance through cold store', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.moduleProvenance?.['mod-1']).toEqual({
      alias: 'payments',
      moduleProjectId: 'mod-proj-1',
      moduleReleaseId: 'rel-1',
      sourceAgentName: 'TestAgent',
    });
  });

  it('maps userId back from top-level mongo field', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.userId).toBe('user-test-123');
  });

  it('round-trips compilationHash through cold store', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.compilationHash).toBe('comp-hash-xyz');
  });

  it('round-trips originalCreatedAt faithfully', async () => {
    const session = makeSession();
    const originalCreatedAt = session.createdAt;
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    expect(loaded?.createdAt).toBe(originalCreatedAt);
  });

  it('merges conversationHistory from all threads in stack order', async () => {
    const session = makeSession();
    await repo.upsert(session);
    const loaded = await repo.load(session.id, session.tenantId!);
    // Verify both presence AND ordering: stack threads come before active thread
    const contents = loaded?.conversationHistory.map((m) => m.content);
    expect(contents).toEqual(['thread0 message', 'thread1 response']);
  });

  it('restores pendingAwaitAttachment in thread after cold load', async () => {
    const sessionWithAwait = makeSession({
      threads: [
        makeThread({
          status: 'suspended',
          pendingAwaitAttachment: {
            type: 'await_attachment',
            variable: 'doc',
            required: true,
            prompt: 'Please upload your document',
            startedAt: Date.now(),
          },
        }),
      ],
      activeThreadIndex: 0,
      threadStack: [],
    });
    await repo.upsert(sessionWithAwait);
    const loaded = await repo.load(sessionWithAwait.id, sessionWithAwait.tenantId!);
    expect(loaded?.threads[0]?.pendingAwaitAttachment?.variable).toBe('doc');
  });
});
