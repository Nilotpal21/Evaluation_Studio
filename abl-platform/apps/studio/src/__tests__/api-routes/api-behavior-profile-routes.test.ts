import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const mockRequireAuth = vi.fn();
const mockIsAuthError = vi.fn(() => false);
const mockRequireProjectAccess = vi.fn();
const mockRequireProjectMemberOrAdmin = vi.fn();
const mockIsAccessError = vi.fn(() => false);
const mockProjectConfigVariableFind = vi.fn();
const mockProjectConfigVariableFindOne = vi.fn();
const mockProjectConfigVariableCreate = vi.fn();
const mockProjectConfigVariableFindOneAndUpdate = vi.fn();
const mockProjectConfigVariableFindOneAndDelete = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockRefreshProjectAgentDraftMetadataForConfigMutation = vi.fn();

type BehaviorProfileDoc = {
  _id: string;
  tenantId: string;
  projectId: string;
  key: string;
  value: string;
  description: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  _v: number;
};

type AgentDoc = {
  name: string;
  dslContent: string;
  tenantId: string;
  projectId: string;
};

const TEST_USER = {
  id: 'user-1',
  email: 'behavior@test.example',
  name: 'Behavior Test User',
  tenantId: 'tenant-1',
  permissions: ['*:*'],
};

const TEST_PROJECT_ACCESS = {
  project: {
    id: 'proj-1',
    _id: 'proj-1',
    name: 'Behavior Project',
    tenantId: 'tenant-1',
    ownerId: 'user-1',
  },
  accessPath: 'membership',
};

const VOICE_VIP_DSL = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 5
WHEN: channel == "voice"

CONVERSATION:
  speaking:
    tone: reassuring
`;

const VOICE_VIP_WITH_INSTRUCTIONS = `BEHAVIOR_PROFILE: voice_vip
PRIORITY: 5
WHEN: channel == "voice"

INSTRUCTIONS: Keep it calm and premium

CONVERSATION:
  speaking:
    tone: reassuring
`;

const AGENT_USING_VOICE_VIP = `AGENT: Concierge
GOAL: "Support premium callers"

USE BEHAVIOR_PROFILE: voice_vip

COMPLETE:
  - WHEN: true
    RESPOND: "Done"
`;

let nextId = 1;
let behaviorProfileDocs: BehaviorProfileDoc[] = [];
let agentDocs: AgentDoc[] = [];

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function makeRequest(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function applyProjectionToRecord<T extends Record<string, unknown>>(
  value: T,
  projection?: string,
): T {
  if (!projection) {
    return cloneValue(value);
  }

  const keys = projection.split(/\s+/).filter(Boolean);
  return cloneValue(
    Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, value[key]])),
  ) as T;
}

function applyProjection<T>(value: T, projection?: string): T {
  if (value === null || value === undefined || !projection) {
    return value === undefined ? value : cloneValue(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry && typeof entry === 'object'
        ? applyProjectionToRecord(entry as Record<string, unknown>, projection)
        : entry,
    ) as T;
  }

  if (typeof value === 'object') {
    return applyProjectionToRecord(value as Record<string, unknown>, projection) as T;
  }

  return cloneValue(value);
}

function makeQuery<T>(resolver: () => T) {
  let projection: string | undefined;

  const execute = () => applyProjection(resolver(), projection);

  const query = {
    select(value: string) {
      projection = value;
      return query;
    },
    lean() {
      return query;
    },
    then<TResult1 = Awaited<ReturnType<typeof execute>>, TResult2 = never>(
      onfulfilled?:
        | ((value: Awaited<ReturnType<typeof execute>>) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(execute()).then(onfulfilled, onrejected);
    },
    catch<TResult = never>(
      onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ) {
      return Promise.resolve(execute()).catch(onrejected);
    },
    finally(onfinally?: (() => void) | null) {
      return Promise.resolve(execute()).finally(onfinally);
    },
  };

  return query;
}

function matchesFilter(record: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];

    if (expected instanceof RegExp) {
      return typeof actual === 'string' && expected.test(actual);
    }

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$ne' in expected) {
        return actual !== (expected as { $ne?: unknown }).$ne;
      }
    }

    return actual === expected;
  });
}

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  isAuthError: (...args: unknown[]) => mockIsAuthError(...args),
  formatUserLabel: (user: { name?: string; email?: string; id: string }) =>
    user.name || user.email || user.id,
}));

vi.mock('@/lib/project-access', () => ({
  requireProjectAccess: (...args: unknown[]) => mockRequireProjectAccess(...args),
  isAccessError: (...args: unknown[]) => mockIsAccessError(...args),
}));

vi.mock('@/lib/require-project-member-or-admin', () => ({
  requireProjectMemberOrAdmin: (...args: unknown[]) => mockRequireProjectMemberOrAdmin(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectConfigVariable: {
    find: (...args: unknown[]) => mockProjectConfigVariableFind(...args),
    findOne: (...args: unknown[]) => mockProjectConfigVariableFindOne(...args),
    create: (...args: unknown[]) => mockProjectConfigVariableCreate(...args),
    findOneAndUpdate: (...args: unknown[]) => mockProjectConfigVariableFindOneAndUpdate(...args),
    findOneAndDelete: (...args: unknown[]) => mockProjectConfigVariableFindOneAndDelete(...args),
  },
  ProjectAgent: {
    find: (...args: unknown[]) => mockProjectAgentFind(...args),
  },
}));

vi.mock('@/lib/project-config-draft-invalidation', () => ({
  refreshProjectAgentDraftMetadataForConfigMutation: (...args: unknown[]) =>
    mockRefreshProjectAgentDraftMetadataForConfigMutation(...args),
}));

import {
  GET as listBehaviorProfiles,
  POST as createBehaviorProfile,
} from '@/app/api/projects/[id]/behavior-profiles/route';
import {
  GET as getBehaviorProfile,
  PATCH as updateBehaviorProfile,
  DELETE as deleteBehaviorProfile,
} from '@/app/api/projects/[id]/behavior-profiles/[profileName]/route';

beforeEach(() => {
  nextId = 1;
  mockRefreshProjectAgentDraftMetadataForConfigMutation.mockResolvedValue(undefined);
  behaviorProfileDocs = [
    {
      _id: 'profile-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      key: 'profile:voice_vip',
      value: VOICE_VIP_DSL,
      description: null,
      createdBy: 'seed',
      updatedBy: 'seed',
      createdAt: new Date('2026-04-22T10:00:00.000Z'),
      updatedAt: new Date('2026-04-22T10:00:00.000Z'),
      _v: 0,
    },
  ];
  agentDocs = [
    {
      name: 'Concierge',
      dslContent: AGENT_USING_VOICE_VIP,
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    },
  ];

  vi.clearAllMocks();

  mockRequireAuth.mockResolvedValue(TEST_USER);
  mockIsAuthError.mockReturnValue(false);
  mockRequireProjectAccess.mockResolvedValue(TEST_PROJECT_ACCESS);
  mockRequireProjectMemberOrAdmin.mockResolvedValue(TEST_PROJECT_ACCESS);
  mockIsAccessError.mockReturnValue(false);

  mockProjectConfigVariableFind.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(() =>
      behaviorProfileDocs.filter((doc) => matchesFilter(doc as Record<string, unknown>, filter)),
    ),
  );

  mockProjectConfigVariableFindOne.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(
      () =>
        behaviorProfileDocs.find((doc) => matchesFilter(doc as Record<string, unknown>, filter)) ??
        null,
    ),
  );

  mockProjectConfigVariableCreate.mockImplementation(
    async (
      input: Pick<
        BehaviorProfileDoc,
        'tenantId' | 'projectId' | 'key' | 'value' | 'description' | 'createdBy' | 'updatedBy'
      >,
    ) => {
      const now = new Date(`2026-04-23T10:00:0${nextId}.000Z`);
      const doc: BehaviorProfileDoc = {
        _id: `profile-${nextId}`,
        createdAt: now,
        updatedAt: now,
        _v: 0,
        ...input,
      };
      nextId += 1;
      behaviorProfileDocs.push(doc);
      return cloneValue(doc);
    },
  );

  mockProjectConfigVariableFindOneAndUpdate.mockImplementation(
    (filter: Record<string, unknown>, update: Record<string, unknown>) =>
      makeQuery(() => {
        const index = behaviorProfileDocs.findIndex((doc) =>
          matchesFilter(doc as Record<string, unknown>, filter),
        );
        if (index === -1) {
          return null;
        }

        const current = behaviorProfileDocs[index]!;
        const nextUpdatedAt = new Date('2026-04-23T11:00:00.000Z');
        const nextDoc: BehaviorProfileDoc = {
          ...current,
          ...(update.$set as Partial<BehaviorProfileDoc> | undefined),
          _v: current._v + ((update.$inc as { _v?: number } | undefined)?._v ?? 0),
          updatedAt: nextUpdatedAt,
        };
        behaviorProfileDocs[index] = nextDoc;
        return nextDoc;
      }),
  );

  mockProjectConfigVariableFindOneAndDelete.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(() => {
      const index = behaviorProfileDocs.findIndex((doc) =>
        matchesFilter(doc as Record<string, unknown>, filter),
      );
      if (index === -1) {
        return null;
      }

      const [deleted] = behaviorProfileDocs.splice(index, 1);
      return deleted ?? null;
    }),
  );

  mockProjectAgentFind.mockImplementation((filter: Record<string, unknown>) =>
    makeQuery(() =>
      agentDocs.filter((doc) => matchesFilter(doc as Record<string, unknown>, filter)),
    ),
  );
});

describe('GET /api/projects/:id/behavior-profiles', () => {
  it('lists stored behavior profiles with usage metadata', async () => {
    const response = await listBehaviorProfiles(
      makeRequest('/api/projects/proj-1/behavior-profiles'),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0]).toMatchObject({
      name: 'voice_vip',
      priority: 5,
      whenExpression: 'channel == "voice"',
      overrideCategories: ['conversation'],
      usedByAgents: ['Concierge'],
      parseErrors: [],
    });
  });
});

describe('POST /api/projects/:id/behavior-profiles', () => {
  it('creates a structured behavior profile', async () => {
    const response = await createBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles', 'POST', {
        mode: 'structured',
        name: 'voice_concierge',
        priority: 7,
        whenExpression: 'channel == "voice"',
        conversationBehavior: {
          speaking: {
            tone: 'calm',
            max_sentences: 2,
          },
        },
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.profile).toMatchObject({
      name: 'voice_concierge',
      priority: 7,
      whenExpression: 'channel == "voice"',
      overrideCategories: ['conversation'],
      usedByAgents: [],
      parseErrors: [],
    });
    expect(body.profile.dslContent).toContain('BEHAVIOR_PROFILE: voice_concierge');
    expect(body.profile.dslContent).toContain('PRIORITY: 7');
    expect(body.profile.dslContent).toContain('WHEN: channel == "voice"');
    expect(body.profile.dslContent).toContain('CONVERSATION:');
    expect(body.profile.dslContent).toContain('tone: calm');
    expect(body.profile.dslContent).toContain('max_sentences: 2');

    expect(behaviorProfileDocs).toHaveLength(2);
    expect(behaviorProfileDocs[1]).toMatchObject({
      key: 'profile:voice_concierge',
      createdBy: 'Behavior Test User',
      updatedBy: 'Behavior Test User',
    });
    expect(mockRefreshProjectAgentDraftMetadataForConfigMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('rejects invalid raw DSL payloads', async () => {
    const response = await createBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles', 'POST', {
        mode: 'raw',
        dslContent: 'NOT_A_BEHAVIOR_PROFILE: invalid',
      }),
      {
        params: Promise.resolve({ id: 'proj-1' }),
      },
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Behavior profile DSL is invalid');
    expect(body.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('requires a PRIORITY: declaration'),
        expect.stringContaining('requires a WHEN: declaration'),
      ]),
    );
  });
});

describe('GET /api/projects/:id/behavior-profiles/:profileName', () => {
  it('returns structured detail for a stored behavior profile', async () => {
    const response = await getBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles/voice_vip'),
      {
        params: Promise.resolve({ id: 'proj-1', profileName: 'voice_vip' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile).toMatchObject({
      name: 'voice_vip',
      priority: 5,
      whenExpression: 'channel == "voice"',
      overrideCategories: ['conversation'],
      usedByAgents: ['Concierge'],
      parseErrors: [],
      conversationBehavior: {
        speaking: {
          tone: 'reassuring',
        },
      },
    });
  });
});

describe('PATCH /api/projects/:id/behavior-profiles/:profileName', () => {
  it('preserves unmanaged sections when saving structured edits', async () => {
    behaviorProfileDocs[0] = {
      ...behaviorProfileDocs[0]!,
      value: VOICE_VIP_WITH_INSTRUCTIONS,
    };

    const response = await updateBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles/voice_vip', 'PATCH', {
        mode: 'structured',
        name: 'voice_vip',
        priority: 9,
        whenExpression: 'true',
        conversationBehavior: {
          speaking: {
            tone: 'warm',
            max_sentences: 1,
          },
        },
      }),
      {
        params: Promise.resolve({ id: 'proj-1', profileName: 'voice_vip' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.profile).toMatchObject({
      name: 'voice_vip',
      priority: 9,
      whenExpression: 'true',
      overrideCategories: expect.arrayContaining(['instructions', 'conversation']),
    });
    expect(body.profile.dslContent).toContain('BEHAVIOR_PROFILE: voice_vip');
    expect(body.profile.dslContent).toContain('PRIORITY: 9');
    expect(body.profile.dslContent).toContain('WHEN: true');
    expect(body.profile.dslContent).toContain('INSTRUCTIONS: Keep it calm and premium');
    expect(body.profile.dslContent).toContain('tone: warm');
    expect(body.profile.dslContent).toContain('max_sentences: 1');

    expect(behaviorProfileDocs[0]).toMatchObject({
      key: 'profile:voice_vip',
      updatedBy: 'Behavior Test User',
    });
    expect(behaviorProfileDocs[0]?.value).toContain('INSTRUCTIONS: Keep it calm and premium');
    expect(mockRefreshProjectAgentDraftMetadataForConfigMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });

  it('blocks renaming a behavior profile that is still attached to agents', async () => {
    const response = await updateBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles/voice_vip', 'PATCH', {
        mode: 'structured',
        name: 'voice_vip_plus',
        priority: 9,
        whenExpression: 'true',
        conversationBehavior: {
          speaking: {
            tone: 'warm',
          },
        },
      }),
      {
        params: Promise.resolve({ id: 'proj-1', profileName: 'voice_vip' }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      error: 'Behavior profile is in use and cannot be renamed',
      usedByAgents: ['Concierge'],
    });
    expect(behaviorProfileDocs[0]?.key).toBe('profile:voice_vip');
  });
});

describe('DELETE /api/projects/:id/behavior-profiles/:profileName', () => {
  it('returns not found when the behavior profile does not exist', async () => {
    const response = await deleteBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles/missing_profile', 'DELETE'),
      {
        params: Promise.resolve({ id: 'proj-1', profileName: 'missing_profile' }),
      },
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      error: 'Behavior profile not found',
    });
  });

  it('blocks deletion when agents still reference the behavior profile', async () => {
    const response = await deleteBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles/voice_vip', 'DELETE'),
      {
        params: Promise.resolve({ id: 'proj-1', profileName: 'voice_vip' }),
      },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      success: false,
      error: 'Behavior profile is in use and cannot be deleted',
      usedByAgents: ['Concierge'],
    });
    expect(behaviorProfileDocs).toHaveLength(1);
  });

  it('deletes the stored behavior profile', async () => {
    agentDocs = [];

    const response = await deleteBehaviorProfile(
      makeRequest('/api/projects/proj-1/behavior-profiles/voice_vip', 'DELETE'),
      {
        params: Promise.resolve({ id: 'proj-1', profileName: 'voice_vip' }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ success: true, deleted: 'voice_vip' });
    expect(behaviorProfileDocs).toHaveLength(0);
    expect(mockRefreshProjectAgentDraftMetadataForConfigMutation).toHaveBeenCalledWith({
      projectId: 'proj-1',
      tenantId: 'tenant-1',
    });
  });
});
