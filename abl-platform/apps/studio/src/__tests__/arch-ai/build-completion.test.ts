import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCompletionWidgetPayload,
  handleBuildAction,
  type AgentGenResult,
} from '@/lib/arch-ai/build-completion';

const updateOne = vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
const collection = vi.fn(() => ({ updateOne }));

const DEFAULT_QUALITY = {
  guardrails: true,
  memory: false,
  errorHandlers: true,
  constraints: false,
  catchAllHandoff: true,
};

function makeAgent(overrides: Partial<AgentGenResult> = {}): AgentGenResult {
  return {
    agentName: 'Alpha',
    status: 'compiled',
    warnings: [],
    errors: [],
    mode: 'reasoning',
    agentType: 'agent',
    toolCount: 2,
    handoffCount: 1,
    quality: DEFAULT_QUALITY,
    elapsed: 1200,
    ...overrides,
  };
}

beforeEach(() => {
  updateOne.mockClear();
  collection.mockClear();
  updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  (mongoose.connection as unknown as { db?: unknown }).db = {
    collection,
  };
});

describe('arch-ai handleBuildAction(create)', () => {
  it('delegates to createProject instead of falling back to legacy phase transition', async () => {
    const createProject = vi.fn().mockResolvedValue(undefined);
    const executePhaseTransitionFn = vi.fn();
    const emit = vi.fn();
    const close = vi.fn();

    await handleBuildAction(
      'create',
      { tenantId: 'tenant-1', userId: 'user-1' },
      {
        id: 'sess-create',
        tenantId: 'tenant-1',
        userId: 'user-1',
        state: 'ACTIVE',
        metadata: {
          phase: 'BUILD',
          mode: 'ONBOARDING',
          specification: {} as never,
          pendingInteraction: null,
          messages: [],
          topology: {
            agents: [{ name: 'Alpha' }, { name: 'Beta' }],
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      [makeAgent({ agentName: 'Alpha', status: 'compiled' }), makeAgent({ agentName: 'Beta' })],
      emit,
      close,
      {
        sessionService: {} as never,
        journalFn: vi.fn(),
        executePhaseTransitionFn,
        createProject,
      },
      'Project X',
    );

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'sess-create', tenantId: 'tenant-1', userId: 'user-1' },
      {
        $set: {
          'metadata.buildProgress.stage': 'complete',
          'metadata.buildProgress.agentStatuses': {
            Alpha: 'compiled',
            Beta: 'compiled',
          },
        },
      },
    );
    expect(createProject).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1' },
      expect.objectContaining({ id: 'sess-create' }),
      emit,
      close,
    );
    expect(executePhaseTransitionFn).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('accepts create_project as a defensive alias for create', async () => {
    const createProject = vi.fn().mockResolvedValue(undefined);
    const executePhaseTransitionFn = vi.fn();
    const emit = vi.fn();
    const close = vi.fn();

    await handleBuildAction(
      'create_project',
      { tenantId: 'tenant-1', userId: 'user-1' },
      {
        id: 'sess-create-alias',
        tenantId: 'tenant-1',
        userId: 'user-1',
        state: 'ACTIVE',
        metadata: {
          phase: 'BUILD',
          mode: 'ONBOARDING',
          specification: {} as never,
          pendingInteraction: null,
          messages: [],
          topology: {
            agents: [{ name: 'Alpha' }],
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      [makeAgent({ agentName: 'Alpha', status: 'compiled' })],
      emit,
      close,
      {
        sessionService: {} as never,
        journalFn: vi.fn(),
        executePhaseTransitionFn,
        createProject,
      },
      'Project X',
    );

    expect(createProject).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1' },
      expect.objectContaining({ id: 'sess-create-alias' }),
      emit,
      close,
    );
    expect(executePhaseTransitionFn).not.toHaveBeenCalled();
  });
});

describe('buildCompletionWidgetPayload retry guidance', () => {
  it('omits retry actions when all failures are structural', () => {
    const payload = buildCompletionWidgetPayload([
      makeAgent({
        agentName: 'Alpha',
        status: 'error',
        errors: ['[CO-02] COMPLETION references undeclared state.'],
        retryable: false,
        diagnosticCodes: ['CO-02'],
        retryReason: 'Declared completion state must be fixed before retry.',
      }),
    ]);

    expect(payload.question).toContain('structural errors');
    expect(payload.options.map((option) => option.value)).toEqual(['modify', 'back']);
  });
});

describe('arch-ai handleBuildAction(retry)', () => {
  it('reruns only retryable failed agents', async () => {
    const runParallelGeneration = vi.fn().mockResolvedValue([
      makeAgent({
        agentName: 'Beta',
        status: 'compiled',
      }),
    ]);
    const emit = vi.fn();
    const close = vi.fn();
    const appendMessage = vi.fn().mockResolvedValue(undefined);
    const setPendingInteraction = vi.fn().mockResolvedValue(undefined);

    await handleBuildAction(
      'retry',
      { tenantId: 'tenant-1', userId: 'user-1' },
      {
        id: 'sess-retry',
        tenantId: 'tenant-1',
        userId: 'user-1',
        state: 'ACTIVE',
        metadata: {
          phase: 'BUILD',
          mode: 'ONBOARDING',
          specification: {} as never,
          pendingInteraction: null,
          messages: [],
          topology: {
            agents: [{ name: 'Alpha' }, { name: 'Beta' }],
          },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as never,
      [
        makeAgent({
          agentName: 'Alpha',
          status: 'error',
          errors: ['[CO-02] COMPLETION references undeclared state.'],
          retryable: false,
        }),
        makeAgent({
          agentName: 'Beta',
          status: 'error',
          errors: ['Temporary compile worker timeout'],
          retryable: true,
        }),
      ],
      emit,
      close,
      {
        sessionService: {
          appendMessage,
          setPendingInteraction,
        } as never,
        journalFn: vi.fn(),
        runParallelGeneration,
      },
      'Project X',
    );

    expect(runParallelGeneration).toHaveBeenCalledWith(
      ['Beta'],
      { tenantId: 'tenant-1', userId: 'user-1' },
      expect.objectContaining({ id: 'sess-retry' }),
      emit,
    );
    expect(setPendingInteraction).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', userId: 'user-1' },
      'sess-retry',
      expect.objectContaining({
        payload: expect.objectContaining({
          options: [
            { label: 'Modify an agent', value: 'modify' },
            { label: 'Back to design', value: 'back' },
          ],
        }),
      }),
    );
  });
});
