import { beforeEach, describe, expect, it } from 'vitest';
import type { Model } from 'mongoose';
import { createDefaultSpecification } from '../../types/specification.js';
import type { IArchSessionRecord } from '../../models/arch-session.model.js';
import { SessionService } from '../../session/session-service.js';
import {
  CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
  DEFAULT_SESSION_THREAD_ID,
} from '../../session/session-contract.js';

type SessionDoc = IArchSessionRecord;

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (typeof existing !== 'object' || existing === null) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = value;
}

function matchesFilter(
  document: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') {
      return Array.isArray(expected)
        ? expected.some(
            (clause) =>
              typeof clause === 'object' &&
              clause !== null &&
              matchesFilter(document, clause as Record<string, unknown>),
          )
        : false;
    }

    const actual = getPath(document, key);
    if (
      typeof expected === 'object' &&
      expected !== null &&
      !Array.isArray(expected) &&
      Object.keys(expected).some((operator) => operator.startsWith('$'))
    ) {
      const operators = expected as Record<string, unknown>;
      return Object.entries(operators).every(([operator, operand]) => {
        switch (operator) {
          case '$exists':
            return operand === true ? actual !== undefined : actual === undefined;
          case '$in':
            return Array.isArray(operand) ? operand.includes(actual) : false;
          case '$ne':
            return actual !== operand;
          case '$lte':
            return typeof actual === 'number' && typeof operand === 'number'
              ? actual <= operand
              : actual instanceof Date && operand instanceof Date
                ? actual.getTime() <= operand.getTime()
                : false;
          default:
            return false;
        }
      });
    }

    return actual === expected;
  });
}

function applyUpdate(document: SessionDoc, update: Record<string, unknown>): void {
  const set = update.$set;
  if (typeof set === 'object' && set !== null) {
    for (const [path, value] of Object.entries(set)) {
      setPath(document as unknown as Record<string, unknown>, path, value);
    }
  }
}

class FakeSessionModel {
  readonly docs: SessionDoc[] = [];
  private idCounter = 0;

  async create(input: Record<string, unknown>): Promise<SessionDoc> {
    const now = new Date('2026-04-20T08:00:00.000Z');
    this.idCounter += 1;
    const metadata = (input.metadata ?? {}) as Record<string, unknown>;
    const doc = {
      _id: `sess-${this.idCounter}`,
      tenantId: input.tenantId as string,
      userId: input.userId as string,
      state: (input.state as SessionDoc['state']) ?? 'IDLE',
      metadata: {
        phase: (metadata.phase as SessionDoc['metadata']['phase']) ?? 'INTERVIEW',
        mode: (metadata.mode as SessionDoc['metadata']['mode']) ?? 'ONBOARDING',
        specification:
          (metadata.specification as SessionDoc['metadata']['specification']) ??
          createDefaultSpecification(),
        pendingInteraction:
          (metadata.pendingInteraction as SessionDoc['metadata']['pendingInteraction']) ?? null,
        messages: (metadata.messages as SessionDoc['metadata']['messages']) ?? [],
        projectId: (metadata.projectId as string | null | undefined) ?? null,
        contractVersion: (metadata.contractVersion as number | undefined) ?? undefined,
        surface: (metadata.surface as SessionDoc['metadata']['surface']) ?? 'project',
        agentName: (metadata.agentName as string | null | undefined) ?? null,
        agentNameKey: (metadata.agentNameKey as string | undefined) ?? '__project__',
        threadId: (metadata.threadId as string | undefined) ?? DEFAULT_SESSION_THREAD_ID,
        blueprintStage:
          (metadata.blueprintStage as SessionDoc['metadata']['blueprintStage']) ?? 'concept_ready',
        topology: (metadata.topology as Record<string, unknown> | undefined) ?? null,
        draftTopology: (metadata.draftTopology as Record<string, unknown> | undefined) ?? null,
        lockedTopology: (metadata.lockedTopology as Record<string, unknown> | undefined) ?? null,
        blueprintOutput: (metadata.blueprintOutput as Record<string, unknown> | undefined) ?? null,
        blueprintContextSummary:
          (metadata.blueprintContextSummary as string | null | undefined) ?? null,
        topologyApproved: (metadata.topologyApproved as boolean | undefined) ?? false,
        files: (metadata.files as Record<string, unknown> | undefined) ?? {},
        buildProgress: (metadata.buildProgress as SessionDoc['metadata']['buildProgress']) ?? null,
        buildSubPhase: (metadata.buildSubPhase as SessionDoc['metadata']['buildSubPhase']) ?? null,
        selectedTools: (metadata.selectedTools as SessionDoc['metadata']['selectedTools']) ?? null,
        toolDsls: (metadata.toolDsls as Record<string, string> | undefined) ?? {},
        approvedAgents: (metadata.approvedAgents as string[] | undefined) ?? [],
        qualityGateOverridden: (metadata.qualityGateOverridden as boolean | undefined) ?? false,
        mockServer: (metadata.mockServer as Record<string, unknown> | undefined) ?? null,
        activeSpecialist: (metadata.activeSpecialist as string | undefined) ?? null,
        pendingMutation: (metadata.pendingMutation as Record<string, unknown> | undefined) ?? null,
        pendingPlan: (metadata.pendingPlan as Record<string, unknown> | undefined) ?? null,
        queue: (metadata.queue as unknown[] | undefined) ?? [],
      },
      lastActiveAt: (input.lastActiveAt as Date | null | undefined) ?? null,
      archivedAt: (input.archivedAt as Date | null | undefined) ?? null,
      cancelRequested: (input.cancelRequested as boolean | undefined) ?? false,
      lastCommittedSeq: (input.lastCommittedSeq as number | undefined) ?? 0,
      seq: (input.seq as number | undefined) ?? 0,
      fencingToken: (input.fencingToken as number | undefined) ?? 0,
      _v: 1,
      createdAt: now,
      updatedAt: now,
    } satisfies SessionDoc;

    this.docs.push(doc);
    return doc;
  }

  find(filter: Record<string, unknown>) {
    const matches = this.docs.filter((doc) =>
      matchesFilter(doc as unknown as Record<string, unknown>, filter),
    );

    return {
      sort: (sortSpec: Record<string, number>) => ({
        limit: async (limit: number) => {
          const sorted = [...matches].sort((left, right) => {
            for (const [path, direction] of Object.entries(sortSpec)) {
              const leftValue = getPath(left, path);
              const rightValue = getPath(right, path);
              const leftScore =
                leftValue instanceof Date ? leftValue.getTime() : (leftValue as number);
              const rightScore =
                rightValue instanceof Date ? rightValue.getTime() : (rightValue as number);
              if (leftScore === rightScore) {
                continue;
              }
              return direction < 0 ? rightScore - leftScore : leftScore - rightScore;
            }
            return 0;
          });
          return sorted.slice(0, limit);
        },
      }),
    };
  }

  async findOne(filter: Record<string, unknown>): Promise<SessionDoc | null> {
    return (
      this.docs.find((doc) => matchesFilter(doc as unknown as Record<string, unknown>, filter)) ??
      null
    );
  }

  async updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const doc = await this.findOne(filter);
    if (!doc) {
      return { matchedCount: 0, modifiedCount: 0 };
    }

    applyUpdate(doc, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const matchingDocs = this.docs.filter((doc) =>
      matchesFilter(doc as unknown as Record<string, unknown>, filter),
    );

    for (const doc of matchingDocs) {
      applyUpdate(doc, update);
    }

    return {
      matchedCount: matchingDocs.length,
      modifiedCount: matchingDocs.length,
    };
  }
}

function makeSessionDoc(
  overrides: Partial<SessionDoc> & {
    metadata?: Partial<SessionDoc['metadata']>;
  },
): SessionDoc {
  const createdAt = new Date('2026-04-20T08:00:00.000Z');
  return {
    _id: overrides._id ?? 'sess-stale-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    userId: overrides.userId ?? 'user-1',
    state: overrides.state ?? 'IDLE',
    metadata: {
      phase: overrides.metadata?.phase ?? 'INTERVIEW',
      mode: overrides.metadata?.mode ?? 'IN_PROJECT',
      specification: overrides.metadata?.specification ?? createDefaultSpecification(),
      pendingInteraction: overrides.metadata?.pendingInteraction ?? null,
      messages: overrides.metadata?.messages ?? [],
      projectId: overrides.metadata?.projectId ?? 'proj-123',
      contractVersion: overrides.metadata?.contractVersion,
      surface: overrides.metadata?.surface ?? 'project',
      agentName: overrides.metadata?.agentName ?? null,
      agentNameKey: overrides.metadata?.agentNameKey ?? '__project__',
      threadId: overrides.metadata?.threadId ?? DEFAULT_SESSION_THREAD_ID,
      blueprintStage: overrides.metadata?.blueprintStage ?? 'concept_ready',
      topology: overrides.metadata?.topology ?? null,
      draftTopology: overrides.metadata?.draftTopology ?? null,
      lockedTopology: overrides.metadata?.lockedTopology ?? null,
      blueprintOutput: overrides.metadata?.blueprintOutput ?? null,
      blueprintContextSummary: overrides.metadata?.blueprintContextSummary ?? null,
      topologyApproved: overrides.metadata?.topologyApproved ?? false,
      files: overrides.metadata?.files ?? {},
      buildProgress: overrides.metadata?.buildProgress ?? null,
      buildSubPhase: overrides.metadata?.buildSubPhase ?? null,
      selectedTools: overrides.metadata?.selectedTools ?? null,
      toolDsls: overrides.metadata?.toolDsls ?? {},
      approvedAgents: overrides.metadata?.approvedAgents ?? [],
      qualityGateOverridden: overrides.metadata?.qualityGateOverridden ?? false,
      mockServer: overrides.metadata?.mockServer ?? null,
      activeSpecialist: overrides.metadata?.activeSpecialist ?? null,
      pendingMutation: overrides.metadata?.pendingMutation ?? null,
      pendingPlan: overrides.metadata?.pendingPlan ?? null,
      queue: overrides.metadata?.queue ?? [],
    },
    lastActiveAt: overrides.lastActiveAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    cancelRequested: overrides.cancelRequested ?? false,
    lastCommittedSeq: overrides.lastCommittedSeq ?? 0,
    seq: overrides.seq ?? 0,
    fencingToken: overrides.fencingToken ?? 0,
    _v: overrides._v ?? 1,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

describe('SessionService contract gating', () => {
  let model: FakeSessionModel;
  let service: SessionService;
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' };

  beforeEach(() => {
    model = new FakeSessionModel();
    service = new SessionService(model as unknown as Model<SessionDoc>);
  });

  it('stamps new in-project sessions with the current contract version', async () => {
    const session = await service.create(ctx, 'proj-123');

    expect(session.metadata.mode).toBe('IN_PROJECT');
    expect(session.metadata.contractVersion).toBe(CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION);
    expect(model.docs[0]?.metadata.contractVersion).toBe(
      CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
    );
  });

  it('keeps project and agent-editor sessions distinct for the same project', async () => {
    const projectSession = await service.create(ctx, 'proj-123');
    const editorSession = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: ' Returns Agent ',
    });

    expect(projectSession.id).not.toBe(editorSession.id);
    expect(projectSession.metadata.surface).toBe('project');
    expect(projectSession.metadata.agentName).toBeNull();
    expect(projectSession.metadata.agentNameKey).toBe('__project__');
    expect(projectSession.metadata.threadId).toBe(DEFAULT_SESSION_THREAD_ID);
    expect(editorSession.metadata.surface).toBe('agent-editor');
    expect(editorSession.metadata.agentName).toBe('Returns Agent');
    expect(editorSession.metadata.agentNameKey).toBe(
      Buffer.from('returns agent', 'utf8').toString('base64url'),
    );

    const currentProject = await service.getCurrent(ctx, 'IN_PROJECT', 'proj-123');
    const currentEditor = await service.getCurrent(ctx, 'IN_PROJECT', 'proj-123', {
      surface: 'agent-editor',
      agentName: ' returns   agent ',
    });

    expect(currentProject?.id).toBe(projectSession.id);
    expect(currentEditor?.id).toBe(editorSession.id);
  });

  it('keeps hidden threads distinct for the same project surface', async () => {
    const defaultThread = await service.create(ctx, 'proj-123');
    const secondThread = await service.create(ctx, 'proj-123', {
      threadId: 'thread-2',
    });

    expect(defaultThread.id).not.toBe(secondThread.id);
    expect(defaultThread.metadata.threadId).toBe(DEFAULT_SESSION_THREAD_ID);
    expect(secondThread.metadata.threadId).toBe('thread-2');

    const currentDefaultThread = await service.getCurrent(ctx, 'IN_PROJECT', 'proj-123', {
      threadId: DEFAULT_SESSION_THREAD_ID,
    });
    const currentSecondThread = await service.getCurrent(ctx, 'IN_PROJECT', 'proj-123', {
      threadId: 'thread-2',
    });

    expect(currentDefaultThread?.id).toBe(defaultThread.id);
    expect(currentSecondThread?.id).toBe(secondThread.id);
  });

  it('force-archives the whole legacy project scope before a fresh start', async () => {
    const projectSession = await service.create(ctx, 'proj-123');
    const editorSession = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Returns Agent',
    });
    const otherProjectSession = await service.create(ctx, 'proj-other');
    const otherUserSession = await service.create(
      { tenantId: 'tenant-1', userId: 'user-2' },
      'proj-123',
    );

    const archivedCount = await service.forceArchiveForFreshStart(ctx, 'proj-123');

    expect(archivedCount).toBe(2);
    expect(model.docs.find((doc) => doc._id === projectSession.id)?.state).toBe('ARCHIVED');
    expect(model.docs.find((doc) => doc._id === editorSession.id)?.state).toBe('ARCHIVED');
    expect(model.docs.find((doc) => doc._id === otherProjectSession.id)?.state).toBe('IDLE');
    expect(model.docs.find((doc) => doc._id === otherUserSession.id)?.state).toBe('IDLE');

    const fresh = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Returns Agent',
    });
    expect(fresh.id).not.toBe(editorSession.id);
    expect(fresh.metadata.surface).toBe('agent-editor');
  });

  it('force-archives only the explicit scoped thread before a fresh start', async () => {
    const targetThread = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Returns Agent',
      threadId: 'thread-cli-1',
    });
    const otherThread = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Returns Agent',
      threadId: 'thread-cli-2',
    });
    const projectThread = await service.create(ctx, 'proj-123', {
      threadId: 'thread-cli-1',
    });

    const archivedCount = await service.forceArchiveScopedFreshStart(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Returns Agent',
      threadId: 'thread-cli-1',
    });

    expect(archivedCount).toBe(1);
    expect(model.docs.find((doc) => doc._id === targetThread.id)?.state).toBe('ARCHIVED');
    expect(model.docs.find((doc) => doc._id === otherThread.id)?.state).toBe('IDLE');
    expect(model.docs.find((doc) => doc._id === projectThread.id)?.state).toBe('IDLE');
  });

  it('archives only matching agent-editor sessions when an agent scope disappears', async () => {
    const projectSession = await service.create(ctx, 'proj-123');
    const targetEditor = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Returns Agent',
    });
    const otherEditor = await service.create(ctx, 'proj-123', {
      surface: 'agent-editor',
      agentName: 'Billing Agent',
    });
    const otherUserEditor = await service.create(
      { tenantId: 'tenant-1', userId: 'user-2' },
      'proj-123',
      {
        surface: 'agent-editor',
        agentName: 'Returns Agent',
      },
    );

    const archivedCount = await service.archiveAgentEditorSessionsForAgent(
      ctx,
      'proj-123',
      'Returns Agent',
      'agent_deleted',
    );

    expect(archivedCount).toBe(2);
    expect(model.docs.find((doc) => doc._id === projectSession.id)?.state).toBe('IDLE');
    expect(model.docs.find((doc) => doc._id === targetEditor.id)?.state).toBe('ARCHIVED');
    expect(model.docs.find((doc) => doc._id === targetEditor.id)?.archivedAt).toBeInstanceOf(Date);
    expect(model.docs.find((doc) => doc._id === otherEditor.id)?.state).toBe('IDLE');
    expect(model.docs.find((doc) => doc._id === otherUserEditor.id)?.state).toBe('ARCHIVED');
  });

  it('rejects malformed agent-editor session scope', async () => {
    await expect(
      service.create(ctx, 'proj-123', { surface: 'agent-editor', agentName: ' ' }),
    ).rejects.toThrow('INVALID_SESSION_SCOPE');

    await expect(
      service.create(ctx, undefined, { surface: 'agent-editor', agentName: 'Returns Agent' }),
    ).rejects.toThrow('INVALID_SESSION_SCOPE');
  });

  it('archives unsupported in-project sessions before getCurrent resumes them', async () => {
    model.docs.push(
      makeSessionDoc({
        _id: 'sess-old-current',
        metadata: {
          mode: 'IN_PROJECT',
          projectId: 'proj-123',
          contractVersion: undefined,
        },
      }),
    );

    const current = await service.getCurrent(ctx, 'IN_PROJECT', 'proj-123');

    expect(current).toBeNull();
    expect(model.docs[0]?.state).toBe('ARCHIVED');
    expect(model.docs[0]?.archivedAt).toBeInstanceOf(Date);
  });

  it('drops malformed pending plans on read so old blobs force a new proposal', async () => {
    model.docs.push(
      makeSessionDoc({
        _id: 'sess-invalid-plan',
        metadata: {
          mode: 'IN_PROJECT',
          projectId: 'proj-123',
          contractVersion: CURRENT_IN_PROJECT_SESSION_CONTRACT_VERSION,
          pendingPlan: {
            id: 'plan-old',
            status: 'approved',
          } as never,
        },
      }),
    );

    const current = await service.getCurrent(ctx, 'IN_PROJECT', 'proj-123');

    expect(current?.metadata.pendingPlan).toBeUndefined();
    expect(model.docs[0]?.state).toBe('IDLE');
  });

  it('archives unsupported in-project sessions when loading by id', async () => {
    model.docs.push(
      makeSessionDoc({
        _id: 'sess-old-by-id',
        metadata: {
          mode: 'IN_PROJECT',
          projectId: 'proj-123',
          contractVersion: undefined,
        },
      }),
    );

    const session = await service.getById(ctx, 'sess-old-by-id');

    expect(session).toBeNull();
    expect(model.docs[0]?.state).toBe('ARCHIVED');
  });

  it('does not enforce the contract version for onboarding sessions', async () => {
    model.docs.push(
      makeSessionDoc({
        _id: 'sess-onboarding',
        metadata: {
          mode: 'ONBOARDING',
          projectId: null as unknown as string,
          contractVersion: undefined,
        },
      }),
    );

    const session = await service.getCurrent(ctx, 'ONBOARDING');

    expect(session?.id).toBe('sess-onboarding');
    expect(model.docs[0]?.state).toBe('IDLE');
  });
});
