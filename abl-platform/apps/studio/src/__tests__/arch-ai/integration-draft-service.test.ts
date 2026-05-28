import { beforeEach, describe, expect, it, vi } from 'vitest';

type DraftStatus =
  | 'draft'
  | 'needs_input'
  | 'ready_to_test'
  | 'ready_to_apply'
  | 'complete'
  | 'archived'
  | 'failed';

interface TestHistoryEntry {
  at: Date;
  status: 'pass' | 'fail';
  error?: string;
  sanitizedSampleInput?: string;
}

interface DraftDoc {
  _id: string;
  tenantId: string;
  projectId: string;
  sessionId: string | null;
  source: 'onboarding' | 'in_project';
  status: DraftStatus;
  title: string;
  providerKey: string | null;
  toolIds: string[];
  authProfileIds: string[];
  envVarKeys: string[];
  configVarKeys: string[];
  variableNamespaceIds: string[];
  targetAgentNames: string[];
  pendingSteps: string[];
  lastIntentSummary: string | null;
  createdBy: string;
  lastEditedBy: string | null;
  connectionIds: string[];
  lastTestStatus: 'pass' | 'fail' | 'pending' | null;
  lastTestAt: Date | null;
  lastTestError: string | null;
  testHistory: TestHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

interface SessionDoc {
  _id: string;
  tenantId: string;
  userId: string;
  state: string;
  metadata: {
    projectId: string;
    activeIntegrationDraftId?: string | null;
  };
}

const { ensureDbMock } = vi.hoisted(() => ({
  ensureDbMock: vi.fn().mockResolvedValue(undefined),
}));

const draftDocs: DraftDoc[] = [];
const sessionDocs: SessionDoc[] = [];
let draftCounter = 0;
let timestampCounter = 0;

function now(): Date {
  timestampCounter += 1;
  return new Date(Date.UTC(2026, 3, 22, 12, 0, timestampCounter));
}

function getPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function matchesFilter(
  document: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = getPath(document, key);

    if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
      const ops = expected as Record<string, unknown>;
      if ('$in' in ops) {
        return Array.isArray(ops.$in) ? ops.$in.includes(actual) : false;
      }
      if ('$ne' in ops) {
        return actual !== ops.$ne;
      }
    }

    return actual === expected;
  });
}

function applySet(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (typeof existing !== 'object' || existing === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
}

function cloneDraft(doc: DraftDoc): DraftDoc {
  return {
    ...doc,
    toolIds: [...doc.toolIds],
    authProfileIds: [...doc.authProfileIds],
    envVarKeys: [...doc.envVarKeys],
    configVarKeys: [...doc.configVarKeys],
    variableNamespaceIds: [...doc.variableNamespaceIds],
    targetAgentNames: [...doc.targetAgentNames],
    pendingSteps: [...doc.pendingSteps],
    connectionIds: [...doc.connectionIds],
    lastTestAt: doc.lastTestAt ? new Date(doc.lastTestAt) : null,
    testHistory: doc.testHistory.map((entry) => ({
      ...entry,
      at: new Date(entry.at),
    })),
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
  };
}

function sortDocs<T extends { updatedAt: Date }>(docs: T[], sortSpec: Record<string, number>): T[] {
  const [[field, direction]] = Object.entries(sortSpec);
  if (field !== 'updatedAt') {
    return [...docs];
  }

  return [...docs].sort((left, right) =>
    direction < 0
      ? right.updatedAt.getTime() - left.updatedAt.getTime()
      : left.updatedAt.getTime() - right.updatedAt.getTime(),
  );
}

function makeSingleQuery<T extends Record<string, unknown>>(value: T | null) {
  return {
    sort: (_sortSpec: Record<string, number>) => ({
      lean: vi.fn().mockResolvedValue(value ? structuredClone(value) : null),
    }),
    lean: vi.fn().mockResolvedValue(value ? structuredClone(value) : null),
  };
}

function makeSortedSingleQuery<T extends Record<string, unknown>>(docs: T[]) {
  return {
    sort: (sortSpec: Record<string, number>) => ({
      lean: vi
        .fn()
        .mockResolvedValue(
          sortDocs(docs as Array<T & { updatedAt: Date }>, sortSpec)[0]
            ? structuredClone(sortDocs(docs as Array<T & { updatedAt: Date }>, sortSpec)[0]!)
            : null,
        ),
    }),
  };
}

function makeListQuery<T extends Record<string, unknown>>(docs: T[]) {
  return {
    sort: (sortSpec: Record<string, number>) => ({
      limit: (limit: number) => ({
        lean: vi.fn().mockResolvedValue(
          sortDocs(docs as Array<T & { updatedAt: Date }>, sortSpec)
            .slice(0, limit)
            .map((doc) => structuredClone(doc)),
        ),
      }),
    }),
  };
}

const mockDraftModel = {
  findOne: vi.fn((filter: Record<string, unknown>) => {
    const matches = draftDocs.filter((doc) =>
      matchesFilter(doc as unknown as Record<string, unknown>, filter),
    );

    if (matches.length <= 1) {
      return makeSingleQuery(matches[0] ? cloneDraft(matches[0]) : null);
    }

    return makeSortedSingleQuery(matches.map((doc) => cloneDraft(doc)));
  }),
  find: vi.fn((filter: Record<string, unknown>) => {
    const matches = draftDocs
      .filter((doc) => matchesFilter(doc as unknown as Record<string, unknown>, filter))
      .map((doc) => cloneDraft(doc));
    return makeListQuery(matches);
  }),
  create: vi.fn((input: Record<string, unknown>) => {
    draftCounter += 1;
    const createdAt = now();
    const doc: DraftDoc = {
      _id: `draft-${draftCounter}`,
      tenantId: String(input.tenantId),
      projectId: String(input.projectId),
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
      source: (input.source as DraftDoc['source']) ?? 'in_project',
      status: (input.status as DraftStatus) ?? 'draft',
      title: String(input.title),
      providerKey: input.providerKey ? String(input.providerKey) : null,
      toolIds: [...((input.toolIds as string[] | undefined) ?? [])],
      authProfileIds: [...((input.authProfileIds as string[] | undefined) ?? [])],
      envVarKeys: [...((input.envVarKeys as string[] | undefined) ?? [])],
      configVarKeys: [...((input.configVarKeys as string[] | undefined) ?? [])],
      variableNamespaceIds: [...((input.variableNamespaceIds as string[] | undefined) ?? [])],
      targetAgentNames: [...((input.targetAgentNames as string[] | undefined) ?? [])],
      pendingSteps: [...((input.pendingSteps as string[] | undefined) ?? [])],
      lastIntentSummary:
        typeof input.lastIntentSummary === 'string' ? input.lastIntentSummary : null,
      createdBy: String(input.createdBy),
      lastEditedBy: typeof input.lastEditedBy === 'string' ? input.lastEditedBy : null,
      connectionIds: [...((input.connectionIds as string[] | undefined) ?? [])],
      lastTestStatus: (input.lastTestStatus as DraftDoc['lastTestStatus'] | undefined) ?? null,
      lastTestAt: input.lastTestAt instanceof Date ? input.lastTestAt : null,
      lastTestError: typeof input.lastTestError === 'string' ? input.lastTestError : null,
      testHistory: ((input.testHistory as TestHistoryEntry[] | undefined) ?? []).map((entry) => ({
        ...entry,
        at: new Date(entry.at),
      })),
      createdAt,
      updatedAt: createdAt,
    };
    draftDocs.push(doc);
    return {
      toObject: () => cloneDraft(doc),
    };
  }),
  findOneAndUpdate: vi.fn(
    (filter: Record<string, unknown>, update: Record<string, unknown>, _options: unknown) => {
      const doc = draftDocs.find((entry) =>
        matchesFilter(entry as unknown as Record<string, unknown>, filter),
      );
      if (!doc) {
        return makeSingleQuery<DraftDoc>(null);
      }

      const set = update.$set as Record<string, unknown> | undefined;
      for (const [path, value] of Object.entries(set ?? {})) {
        applySet(doc as unknown as Record<string, unknown>, path, value);
      }
      doc.updatedAt = now();

      return makeSingleQuery(cloneDraft(doc));
    },
  ),
};

const mockSessionModel = {
  findOne: vi.fn((filter: Record<string, unknown>) => {
    const doc =
      sessionDocs.find((entry) =>
        matchesFilter(entry as unknown as Record<string, unknown>, filter),
      ) ?? null;
    return makeSingleQuery(doc ? structuredClone(doc) : null);
  }),
  updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
    const doc = sessionDocs.find((entry) =>
      matchesFilter(entry as unknown as Record<string, unknown>, filter),
    );
    if (!doc) {
      return { matchedCount: 0 };
    }

    const set = update.$set as Record<string, unknown> | undefined;
    for (const [path, value] of Object.entries(set ?? {})) {
      applySet(doc as unknown as Record<string, unknown>, path, value);
    }
    return { matchedCount: 1 };
  }),
};

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: ensureDbMock,
}));

vi.mock('@agent-platform/database/models', () => ({
  ArchIntegrationDraft: mockDraftModel,
  ArchSession: mockSessionModel,
}));

describe('integration-draft-service', () => {
  beforeEach(() => {
    draftDocs.length = 0;
    sessionDocs.length = 0;
    draftCounter = 0;
    timestampCounter = 0;
    ensureDbMock.mockClear();
    mockDraftModel.findOne.mockClear();
    mockDraftModel.find.mockClear();
    mockDraftModel.create.mockClear();
    mockDraftModel.findOneAndUpdate.mockClear();
    mockSessionModel.findOne.mockClear();
    mockSessionModel.updateOne.mockClear();

    sessionDocs.push({
      _id: 'sess-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      state: 'ACTIVE',
      metadata: { projectId: 'proj-1', activeIntegrationDraftId: null },
    });
  });

  it('resumes the same draft for the same session and provider key', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    const first = await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'CRM Sync',
      providerKey: 'crm',
      pendingSteps: ['create_tool'],
    });

    const second = await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'CRM Sync',
      providerKey: 'crm',
      pendingSteps: ['create_tool', 'configure_auth'],
    });

    expect(first.id).toBe(second.id);
    expect(second.pendingSteps).toEqual(expect.arrayContaining(['create_tool', 'configure_auth']));
    expect(sessionDocs[0]?.metadata.activeIntegrationDraftId).toBe(first.id);
  });

  it('prefers the session pointer when resolving the active draft', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    const first = await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'CRM Sync',
      providerKey: 'crm',
    });

    const second = await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'Billing Sync',
      providerKey: 'billing',
    });

    sessionDocs[0]!.metadata.activeIntegrationDraftId = first.id;

    const active = await service.getActiveIntegrationDraftForSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(second.id).not.toBe(first.id);
    expect(active?.id).toBe(first.id);
  });

  it('deduplicates merged references and clears the session pointer on complete', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    const created = await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'CRM Sync',
      providerKey: 'crm',
    });

    const merged = await service.mergeIntoIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      draftId: created.id,
      toolIds: ['tool-1', 'tool-1', 'tool-2'],
      authProfileIds: ['auth-1', 'auth-1'],
      envVarKeys: ['crm_base_url', 'CRM_BASE_URL'],
      configVarKeys: ['CRM_AUTH_PROFILE', 'CRM_AUTH_PROFILE'],
      variableNamespaceIds: ['ns-1', 'ns-1'],
      targetAgentNames: ['SupportAgent', 'SupportAgent'],
      pendingSteps: ['create_tool', 'create_tool', 'configure_auth'],
    });

    expect(merged).toMatchObject({
      toolIds: ['tool-1', 'tool-2'],
      authProfileIds: ['auth-1'],
      envVarKeys: ['CRM_BASE_URL'],
      configVarKeys: ['CRM_AUTH_PROFILE'],
      variableNamespaceIds: ['ns-1'],
      targetAgentNames: ['SupportAgent'],
      pendingSteps: ['create_tool', 'configure_auth'],
    });

    const completed = await service.completeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      draftId: created.id,
    });

    expect(completed?.status).toBe('complete');
    expect(completed?.pendingSteps).toEqual([]);
    expect(sessionDocs[0]?.metadata.activeIntegrationDraftId).toBeNull();
  });

  it('syncActiveDraftFromConnection appends connectionId and flips status to ready_to_test', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'Slack Integration',
      providerKey: 'slack',
    });

    const updated = await service.syncActiveDraftFromConnection({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      connectionId: 'conn_abc',
    });

    expect(updated?.connectionIds).toContain('conn_abc');
    expect(updated?.status).toBe('ready_to_test');
  });

  it('syncActiveDraftFromConnection returns null when sessionId is omitted', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    const result = await service.syncActiveDraftFromConnection({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      connectionId: 'conn_abc',
    });
    expect(result).toBeNull();
  });

  it('syncActiveDraftFromConnection returns null when no active draft exists for the session', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    const result = await service.syncActiveDraftFromConnection({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      connectionId: 'conn_abc',
    });
    expect(result).toBeNull();
  });

  it('syncActiveDraftFromConnection deduplicates connectionIds across calls', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    await service.createOrResumeIntegrationDraft({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      title: 'Slack Integration',
      providerKey: 'slack',
    });

    await service.syncActiveDraftFromConnection({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      connectionId: 'conn_abc',
    });
    const updated = await service.syncActiveDraftFromConnection({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      connectionId: 'conn_abc',
    });

    expect(updated?.connectionIds.filter((id) => id === 'conn_abc').length).toBe(1);
  });

  it('IntegrationDraftSummary surfaces connectionIds, lastTestStatus, and testHistory', async () => {
    const service = await import('@/lib/arch-ai/integration-draft-service');

    const at = new Date('2026-05-05T12:00:00.000Z');
    draftCounter += 1;
    const seededAt = now();
    draftDocs.push({
      _id: `draft-${draftCounter}`,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
      source: 'in_project',
      status: 'ready_to_test',
      title: 'Slack Integration',
      providerKey: 'slack',
      toolIds: [],
      authProfileIds: [],
      envVarKeys: [],
      configVarKeys: [],
      variableNamespaceIds: [],
      targetAgentNames: [],
      pendingSteps: [],
      lastIntentSummary: null,
      createdBy: 'user-1',
      lastEditedBy: 'user-1',
      connectionIds: ['conn_a'],
      lastTestStatus: 'pass',
      lastTestAt: at,
      lastTestError: null,
      testHistory: [{ at, status: 'pass' }],
      createdAt: seededAt,
      updatedAt: seededAt,
    });
    sessionDocs[0]!.metadata.activeIntegrationDraftId = `draft-${draftCounter}`;

    const summary = await service.getActiveIntegrationDraftForSession({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'sess-1',
    });

    expect(summary?.connectionIds).toEqual(['conn_a']);
    expect(summary?.lastTestStatus).toBe('pass');
    expect(summary?.lastTestAt).toBe(at.toISOString());
    expect(summary?.lastTestError).toBeNull();
    expect(summary?.testHistory.length).toBe(1);
    expect(summary?.testHistory[0]?.status).toBe('pass');
    expect(summary?.testHistory[0]?.at).toBe(at.toISOString());
  });
});
