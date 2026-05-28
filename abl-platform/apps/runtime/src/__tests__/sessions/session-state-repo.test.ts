import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionData } from '../../services/session/types.js';

type StoredSessionDoc = Record<string, any>;

const storedDocs = new Map<string, StoredSessionDoc>();

function matchesQuery(doc: StoredSessionDoc, query: Record<string, unknown>): boolean {
  return Object.entries(query).every(([key, value]) => doc[key] === value);
}

class MockSessionState {
  _id: string;
  [key: string]: any;

  constructor(data: Record<string, any>) {
    Object.assign(this, data);
    this._id = data._id;
  }

  async save(): Promise<void> {
    storedDocs.set(this._id, { ...this });
  }

  static async findOne(query: Record<string, unknown>): Promise<MockSessionState | null> {
    for (const doc of storedDocs.values()) {
      if (matchesQuery(doc, query)) {
        return new MockSessionState({ ...doc });
      }
    }

    return null;
  }
}

vi.mock('@agent-platform/database/models', () => ({
  SessionState: MockSessionState,
}));

function createSessionData(): SessionData {
  return {
    id: 'session-state-1',
    agentName: 'SupervisorAgent',
    irSourceHash: 'hash-supervisor',
    compilationHash: null,
    conversationHistory: [{ role: 'assistant', content: 'Working on it...' }],
    state: {
      gatherProgress: {},
      conversationPhase: 'active',
      context: {},
    },
    version: 3,
    isComplete: false,
    isEscalated: false,
    handoffStack: ['RemoteShippingAgent'],
    delegateStack: [],
    dataValues: {
      customer_id: 'cust-123',
    },
    dataGatheredKeys: ['customer_id'],
    initialized: true,
    createdAt: 1000,
    lastActivityAt: 2000,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    threads: [
      {
        agentName: 'SupervisorAgent',
        irSourceHash: 'hash-supervisor',
        conversationHistory: [{ role: 'user', content: 'Where is my order?' }],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        dataValues: {
          customer_id: 'cust-123',
        },
        dataGatheredKeys: ['customer_id'],
        startedAt: 1010,
        returnExpected: false,
        status: 'waiting',
      },
      {
        agentName: 'RemoteShippingAgent',
        irSourceHash: 'hash-remote',
        conversationHistory: [{ role: 'assistant', content: 'Shipment is being checked.' }],
        state: {
          gatherProgress: {},
          conversationPhase: 'active',
          context: {},
        },
        dataValues: {
          status_request: true,
        },
        dataGatheredKeys: ['status_request'],
        startedAt: 1020,
        endedAt: 1030,
        handoffFrom: 'SupervisorAgent',
        handoffContext: {
          traceId: 'trace-1',
        },
        returnExpected: true,
        currentFlowStep: 'await_remote_status',
        waitingForInput: ['tracking_number'],
        pendingResponse: 'Still checking',
        pendingRichContent: {
          markdown: 'Shipment lookup',
        },
        pendingAwaitAttachment: {
          type: 'await_attachment',
          variable: 'tracking_document',
          category: 'document',
          required: true,
          prompt: 'Upload the shipping notice',
          timeoutSeconds: 120,
          onTimeout: 'escalate_to_human',
          startedAt: 1040,
        },
        status: 'suspended',
      },
    ],
    activeThreadIndex: 1,
    threadStack: [0],
  };
}

describe('SessionStateRepo', () => {
  beforeEach(() => {
    storedDocs.clear();
    vi.resetModules();
  });

  it('round-trips suspended thread metadata needed for async handoff resumption', async () => {
    const { SessionStateRepo } = await import('../../services/session/session-state-repo.js');
    const repo = new SessionStateRepo({ coldTtlDays: 7 });
    const originalSession = createSessionData();

    await repo.upsert(originalSession);
    const loaded = await repo.loadInternal(originalSession.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.activeThreadIndex).toBe(1);
    expect(loaded!.threads[1]).toMatchObject({
      agentName: 'RemoteShippingAgent',
      status: 'suspended',
      startedAt: 1020,
      endedAt: 1030,
      handoffFrom: 'SupervisorAgent',
      handoffContext: { traceId: 'trace-1' },
      returnExpected: true,
      currentFlowStep: 'await_remote_status',
      waitingForInput: ['tracking_number'],
      pendingResponse: 'Still checking',
      pendingAwaitAttachment: {
        type: 'await_attachment',
        variable: 'tracking_document',
        category: 'document',
        required: true,
        prompt: 'Upload the shipping notice',
        timeoutSeconds: 120,
        onTimeout: 'escalate_to_human',
        startedAt: 1040,
      },
    });
    expect(loaded!.threads[1].pendingRichContent).toEqual({
      markdown: 'Shipment lookup',
    });
  });
});
