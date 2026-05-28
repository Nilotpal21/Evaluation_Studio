/**
 * Session Resolver Gap Tests
 *
 * Covers:
 * - Gap 2: allowWorkingCopy inconsistency between new session (line 112) and
 *   stale refresh (line 304) — environment-only connections should NOT get
 *   working copy in either path.
 * - Gap 3: Comprehensive test coverage for resolveSession(), resolveEmailSession(),
 *   and reuseOrRefreshSession() branches.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedConnection, NormalizedIncomingMessage } from '../../channels/types.js';
import { hashArtifact } from '../../services/identity/artifact-hasher.js';
import { computeToolRuntimeMetadataHash } from '@agent-platform/shared/tools';

// =============================================================================
// MOCKS — must be declared before imports
// =============================================================================

// Mock the database check
vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn().mockReturnValue(true),
}));

// Track pipelineCreateSession calls
const mockPipelineCreateSession = vi.fn();
const mockCreateAndLinkDBSession = vi.fn().mockResolvedValue(undefined);
vi.mock('../../channels/pipeline/index.js', () => ({
  createRuntimeSession: (...args: any[]) => mockPipelineCreateSession(...args),
  createAndLinkDBSession: (...args: any[]) => mockCreateAndLinkDBSession(...args),
  resolveEnvironmentLabel: (env: string | undefined) => env ?? 'development',
}));

const mockRegisterResolutionKey = vi.fn().mockResolvedValue(undefined);
const mockResolveIdentitySession = vi.fn().mockResolvedValue({
  outcome: 'new',
  reason: 'no_match',
});
const mockResolutionStoreLoad = vi.fn().mockResolvedValue(null);
const mockGetSessionService = vi.fn(() => ({
  isDistributed: () => true,
  store: {
    kind: 'session-store',
    load: (...args: any[]) => mockResolutionStoreLoad(...args),
  },
}));
vi.mock('../../services/identity/session-resolver.js', () => ({
  resolveSession: (...args: any[]) => mockResolveIdentitySession(...args),
  registerResolutionKey: (...args: any[]) => mockRegisterResolutionKey(...args),
}));
vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: (...args: any[]) => mockGetSessionService(...args),
}));

// Mock the ChannelSession model
const mockChannelSessionFindOne = vi.fn();
const mockChannelSessionCreate = vi.fn();
const mockChannelSessionUpdateOne = vi.fn();
const mockProjectFindOne = vi.fn();
const mockProjectAgentFind = vi.fn();
const mockProjectToolFind = vi.fn();
const mockProjectConfigVariableFind = vi.fn();
const mockProjectRuntimeConfigFindOne = vi.fn();
const mockPromptLibraryVersionFind = vi.fn();
const mockFindMcpServerConfigsRaw = vi.fn();
const mockContactModel = {};

vi.mock('@agent-platform/database/models', () => ({
  Contact: mockContactModel,
  ChannelSession: {
    findOne: (...args: any[]) => mockChannelSessionFindOne(...args),
    create: (...args: any[]) => mockChannelSessionCreate(...args),
    updateOne: (...args: any[]) => mockChannelSessionUpdateOne(...args),
  },
  Project: {
    findOne: (...args: any[]) => mockProjectFindOne(...args),
  },
  ProjectAgent: {
    find: (...args: any[]) => mockProjectAgentFind(...args),
  },
  ProjectTool: {
    find: (...args: any[]) => mockProjectToolFind(...args),
  },
  ProjectConfigVariable: {
    find: (...args: any[]) => mockProjectConfigVariableFind(...args),
  },
  ProjectRuntimeConfig: {
    findOne: (...args: any[]) => mockProjectRuntimeConfigFindOne(...args),
  },
  PromptLibraryVersion: {
    find: (...args: any[]) => mockPromptLibraryVersionFind(...args),
  },
}));

vi.mock('@agent-platform/shared/repos', () => ({
  findMcpServerConfigsRaw: (...args: any[]) => mockFindMcpServerConfigsRaw(...args),
}));

// Mock the runtime executor (used in reuseOrRefreshSession)
const mockGetSession = vi.fn();
const mockRehydrateSession = vi.fn();
vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: () => ({
    getSession: (...args: any[]) => mockGetSession(...args),
    rehydrateSession: (...args: any[]) => mockRehydrateSession(...args),
  }),
}));

// Mock the logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockIsEncryptionAvailable = vi.fn(() => false);
const mockGetEncryptionService = vi.fn(() => ({ kind: 'encryptor' }));
const mockResolveOrCreateContactExecute = vi.fn();
const mockLinkSessionToContactExecute = vi.fn();
const mockConversationLinkContact = vi.fn();

vi.mock('@agent-platform/shared/encryption', () => ({
  isEncryptionAvailable: (...args: any[]) => mockIsEncryptionAvailable(...args),
  getEncryptionService: (...args: any[]) => mockGetEncryptionService(...args),
}));

vi.mock('../../contexts/contact/infrastructure/contact-mongo-repository.js', () => ({
  ContactMongoRepository: class ContactMongoRepository {
    constructor(_model: unknown) {}
  },
}));

vi.mock('../../contexts/contact/use-cases/resolve-or-create-contact.js', () => ({
  ResolveOrCreateContact: class ResolveOrCreateContact {
    constructor(_repo: unknown, _encryptor: unknown) {}

    execute(...args: any[]) {
      return mockResolveOrCreateContactExecute(...args);
    }
  },
}));

vi.mock('../../contexts/contact/use-cases/link-session-to-contact.js', () => ({
  LinkSessionToContact: class LinkSessionToContact {
    constructor(_repo: unknown) {}

    execute(...args: any[]) {
      return mockLinkSessionToContactExecute(...args);
    }
  },
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      linkContact: (...args: any[]) => mockConversationLinkContact(...args),
    },
  })),
}));

vi.mock('../../services/identity/contact-linking-deps.js', () => ({
  getContactLinkingDeps: () => ({
    resolveOrCreateContact: {
      execute: (...args: any[]) => mockResolveOrCreateContactExecute(...args),
    },
    linkSessionToContact: {
      execute: (...args: any[]) => mockLinkSessionToContactExecute(...args),
    },
  }),
  setContactLinkingDeps: vi.fn(),
  clearContactLinkingDeps: vi.fn(),
}));

// =============================================================================
// FIXTURES
// =============================================================================

function makeConnection(overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: null,
    channelType: 'whatsapp',
    externalIdentifier: 'ext-1',
    credentials: null,
    config: {},
    status: 'active',
    ...overrides,
  } as ResolvedConnection;
}

function makeMessage(
  overrides: Partial<NormalizedIncomingMessage> = {},
): NormalizedIncomingMessage {
  return {
    externalMessageId: 'msg-1',
    externalSessionKey: 'session-key-default',
    text: 'Hello',
    timestamp: new Date(),
    ...overrides,
  };
}

function mockNewRuntimeSession(id = 'runtime-sess-1') {
  return { id, conversationHistory: [], state: {}, threads: [] };
}

type WorkingCopyProjectSnapshot = {
  entryAgentName: string | null;
  updatedAt: Date;
};

type WorkingCopySourceSnapshot = {
  name: string;
  sourceHash: string;
  updatedAt: Date;
  systemPromptLibraryRef?: { promptId: string; versionId: string } | null;
  variableNamespaceIds?: string[];
};

type WorkingCopyConfigVariableSnapshot = {
  key: string;
  value: string;
  updatedAt: Date;
};

type WorkingCopyMcpServerSnapshot = {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  encryptedEnv: string | null;
  encryptedAuthConfig: string | null;
  authType: string | null;
  authProfileId: string | null;
  headers: string | null;
  connectionTimeoutMs: number | null;
  requestTimeoutMs: number | null;
};

type WorkingCopyPromptVersionSnapshot = {
  _id: string;
  promptId: string;
  sourceHash: string;
  status: 'draft' | 'active' | 'archived';
  updatedAt: Date;
};

type WorkingCopyRuntimeConfigSnapshot = {
  updatedAt: Date;
  filler?: {
    enabled?: boolean;
    modelSource?: string;
    promptRef?: { promptId: string; versionId: string } | null;
  };
  pipeline?: {
    enabled?: boolean;
    modelSource?: string;
    tenantModelId?: string;
  };
};

const DEFAULT_WORKING_COPY_PROJECT: WorkingCopyProjectSnapshot = {
  entryAgentName: 'test-agent',
  updatedAt: new Date('2026-04-05T00:00:00.000Z'),
};

const DEFAULT_WORKING_COPY_AGENTS: WorkingCopySourceSnapshot[] = [
  {
    name: 'test-agent',
    sourceHash: 'agent-hash-1',
    updatedAt: new Date('2026-04-05T00:00:00.000Z'),
  },
];

const DEFAULT_WORKING_COPY_TOOLS: WorkingCopySourceSnapshot[] = [];
const DEFAULT_WORKING_COPY_CONFIG_VARIABLES: WorkingCopyConfigVariableSnapshot[] = [];
const DEFAULT_WORKING_COPY_PROMPT_VERSIONS: WorkingCopyPromptVersionSnapshot[] = [];
const DEFAULT_WORKING_COPY_MCP_SERVERS: WorkingCopyMcpServerSnapshot[] = [];
const DEFAULT_WORKING_COPY_RUNTIME_CONFIG: WorkingCopyRuntimeConfigSnapshot | null = null;

function leanQuery<T>(value: T) {
  return {
    lean: () => Promise.resolve(value),
  };
}

function computeWorkingCopyCompilationHashForTest(options?: {
  project?: Partial<WorkingCopyProjectSnapshot>;
  agents?: WorkingCopySourceSnapshot[];
  tools?: WorkingCopySourceSnapshot[];
  configVariables?: WorkingCopyConfigVariableSnapshot[];
  promptVersions?: WorkingCopyPromptVersionSnapshot[];
  mcpServers?: WorkingCopyMcpServerSnapshot[];
  runtimeConfig?: WorkingCopyRuntimeConfigSnapshot | null;
  agentId?: string | null;
}): string {
  const project = { ...DEFAULT_WORKING_COPY_PROJECT, ...(options?.project ?? {}) };
  const agents = (options?.agents ?? DEFAULT_WORKING_COPY_AGENTS).map((agent) => ({
    name: agent.name,
    sourceHash: agent.sourceHash,
    updatedAt: agent.updatedAt.toISOString(),
    systemPromptLibraryRef: agent.systemPromptLibraryRef ?? null,
  }));
  const tools = (options?.tools ?? DEFAULT_WORKING_COPY_TOOLS).map((tool) => ({
    name: tool.name,
    sourceHash: tool.sourceHash,
    updatedAt: tool.updatedAt.toISOString(),
    runtimeMetadataHash: computeToolRuntimeMetadataHash({
      variableNamespaceIds: tool.variableNamespaceIds,
    }),
  }));
  const configVariables = (options?.configVariables ?? DEFAULT_WORKING_COPY_CONFIG_VARIABLES).map(
    (variable) => ({
      key: variable.key,
      valueHash: createHash('sha256').update(variable.value).digest('hex'),
      updatedAt: variable.updatedAt.toISOString(),
    }),
  );
  const promptVersions = (options?.promptVersions ?? DEFAULT_WORKING_COPY_PROMPT_VERSIONS).map(
    (version) => ({
      versionId: version._id,
      promptId: version.promptId,
      sourceHash: version.sourceHash,
      status: version.status,
      updatedAt: version.updatedAt.toISOString(),
    }),
  );
  const mcpServers = (options?.mcpServers ?? DEFAULT_WORKING_COPY_MCP_SERVERS).map((server) => ({
    id: server.id,
    name: server.name,
    transport: server.transport,
    url: server.url,
    encryptedEnv: server.encryptedEnv,
    encryptedAuthConfig: server.encryptedAuthConfig,
    authType: server.authType,
    authProfileId: server.authProfileId,
    headers: server.headers,
    connectionTimeoutMs: server.connectionTimeoutMs,
    requestTimeoutMs: server.requestTimeoutMs,
  }));
  const runtimeConfig = options?.runtimeConfig ?? DEFAULT_WORKING_COPY_RUNTIME_CONFIG;

  const payload = {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: options?.agentId ?? null,
    entryAgentName: project.entryAgentName,
    projectUpdatedAt: project.updatedAt.toISOString(),
    agents: [...agents].sort((left, right) => left.name.localeCompare(right.name)),
    tools: [...tools].sort((left, right) => left.name.localeCompare(right.name)),
    configVariables: [...configVariables].sort((left, right) => left.key.localeCompare(right.key)),
    promptVersions: [...promptVersions].sort(
      (left, right) =>
        left.promptId.localeCompare(right.promptId) ||
        left.versionId.localeCompare(right.versionId),
    ),
    runtimeConfig: runtimeConfig
      ? {
          value: runtimeConfig,
          updatedAt: runtimeConfig.updatedAt.toISOString(),
        }
      : null,
    mcpServers: [...mcpServers].sort(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  };

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

function setWorkingCopyCompilationState(options?: {
  project?: Partial<WorkingCopyProjectSnapshot>;
  agents?: WorkingCopySourceSnapshot[];
  tools?: WorkingCopySourceSnapshot[];
  configVariables?: WorkingCopyConfigVariableSnapshot[];
  promptVersions?: WorkingCopyPromptVersionSnapshot[];
  mcpServers?: WorkingCopyMcpServerSnapshot[];
  runtimeConfig?: WorkingCopyRuntimeConfigSnapshot | null;
  agentId?: string | null;
}): string {
  const project = { ...DEFAULT_WORKING_COPY_PROJECT, ...(options?.project ?? {}) };
  const agents = options?.agents ?? DEFAULT_WORKING_COPY_AGENTS;
  const tools = options?.tools ?? DEFAULT_WORKING_COPY_TOOLS;
  const configVariables = options?.configVariables ?? DEFAULT_WORKING_COPY_CONFIG_VARIABLES;
  const promptVersions = options?.promptVersions ?? DEFAULT_WORKING_COPY_PROMPT_VERSIONS;
  const mcpServers = options?.mcpServers ?? DEFAULT_WORKING_COPY_MCP_SERVERS;
  const runtimeConfig = options?.runtimeConfig ?? DEFAULT_WORKING_COPY_RUNTIME_CONFIG;

  mockProjectFindOne.mockReturnValue(
    leanQuery({
      _id: 'project-1',
      tenantId: 'tenant-1',
      entryAgentName: project.entryAgentName,
      updatedAt: project.updatedAt,
    }),
  );
  mockProjectAgentFind.mockReturnValue(leanQuery(agents));
  mockProjectToolFind.mockReturnValue(leanQuery(tools));
  mockProjectConfigVariableFind.mockReturnValue(leanQuery(configVariables));
  mockProjectRuntimeConfigFindOne.mockReturnValue(leanQuery(runtimeConfig));
  mockPromptLibraryVersionFind.mockReturnValue(leanQuery(promptVersions));
  mockFindMcpServerConfigsRaw.mockResolvedValue(mcpServers);

  return computeWorkingCopyCompilationHashForTest({
    project,
    agents,
    tools,
    configVariables,
    promptVersions,
    runtimeConfig,
    mcpServers,
    agentId: options?.agentId ?? null,
  });
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();

  // Default: pipelineCreateSession succeeds
  mockPipelineCreateSession.mockResolvedValue({
    runtimeSession: mockNewRuntimeSession(),
    entryAgentName: 'test-agent',
  });

  // Default: ChannelSession.create returns a doc with _id
  mockChannelSessionCreate.mockResolvedValue({ _id: 'cs-new-1' });

  // Default: ChannelSession.findOne returns a lean()-chainable mock
  mockChannelSessionFindOne.mockReturnValue({
    lean: () => Promise.resolve(null),
  });

  // Default: ChannelSession.updateOne resolves
  mockChannelSessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mockRegisterResolutionKey.mockResolvedValue(undefined);
  mockResolveIdentitySession.mockResolvedValue({
    outcome: 'new',
    reason: 'no_match',
  });
  mockGetSessionService.mockReturnValue({
    isDistributed: () => true,
    store: {
      kind: 'session-store',
      load: (...args: any[]) => mockResolutionStoreLoad(...args),
    },
  });
  mockResolutionStoreLoad.mockResolvedValue(null);
  mockIsEncryptionAvailable.mockReturnValue(false);
  mockGetEncryptionService.mockReturnValue({ kind: 'encryptor' });
  mockResolveOrCreateContactExecute.mockResolvedValue({ id: 'contact-1', displayName: null });
  mockLinkSessionToContactExecute.mockResolvedValue(undefined);
  mockConversationLinkContact.mockResolvedValue(undefined);
  setWorkingCopyCompilationState();
});

// =============================================================================
// GAP 2: allowWorkingCopy INCONSISTENCY
// =============================================================================

describe('Gap 2: allowWorkingCopy consistency', () => {
  it('new session with environment but no deploymentId should NOT allow working copy', async () => {
    const { resolveSession } = await import('../../channels/session-resolver.js');

    const connection = makeConnection({
      deploymentId: undefined,
      environment: 'staging',
    });
    const message = makeMessage({
      metadata: { whatsappFrom: '+1234567890' },
    });

    // No existing channel session
    mockChannelSessionFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    await resolveSession(connection, message);

    // Verify pipelineCreateSession was called with allowWorkingCopy: false
    // because environment is set (even though deploymentId is absent)
    expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
    const createArgs = mockPipelineCreateSession.mock.calls[0][0];
    expect(createArgs.allowWorkingCopy).toBe(false);
    expect(createArgs.environment).toBe('staging');
  });

  it('new session with neither deploymentId nor environment should allow working copy', async () => {
    const { resolveSession } = await import('../../channels/session-resolver.js');

    const connection = makeConnection({
      deploymentId: undefined,
      environment: undefined,
    });
    const message = makeMessage({
      metadata: { whatsappFrom: '+1234567890' },
    });

    mockChannelSessionFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    await resolveSession(connection, message);

    expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
    const createArgs = mockPipelineCreateSession.mock.calls[0][0];
    expect(createArgs.allowWorkingCopy).toBe(true);
  });

  it('new session with deploymentId should NOT allow working copy', async () => {
    const { resolveSession } = await import('../../channels/session-resolver.js');

    const connection = makeConnection({
      deploymentId: 'deploy-1',
      environment: 'production',
    });
    const message = makeMessage({
      metadata: { whatsappFrom: '+1234567890' },
    });

    mockChannelSessionFindOne.mockReturnValue({
      lean: () => Promise.resolve(null),
    });

    await resolveSession(connection, message);

    expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
    const createArgs = mockPipelineCreateSession.mock.calls[0][0];
    expect(createArgs.allowWorkingCopy).toBe(false);
    // When deploymentId is set, environment should not be passed
    expect(createArgs.environment).toBeUndefined();
  });

  it('stale refresh with environment but no deploymentId should NOT allow working copy', async () => {
    const { resolveSession } = await import('../../channels/session-resolver.js');

    const connection = makeConnection({
      deploymentId: undefined,
      environment: 'staging',
    });
    const message = makeMessage({
      metadata: { whatsappFrom: '+1234567890' },
    });

    // Return an existing active channel session
    const existingChannelSession = {
      _id: 'cs-existing-1',
      sessionId: 'runtime-old',
      externalSessionKey: 'session-key-default',
      status: 'active',
    };
    mockChannelSessionFindOne.mockReturnValue({
      lean: () => Promise.resolve(existingChannelSession),
    });

    // Runtime session is expired (not in memory, not in Redis)
    mockGetSession.mockReturnValue(null);
    mockRehydrateSession.mockResolvedValue(null);

    await resolveSession(connection, message);

    // Verify stale refresh path also uses allowWorkingCopy: false
    expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
    const createArgs = mockPipelineCreateSession.mock.calls[0][0];
    expect(createArgs.allowWorkingCopy).toBe(false);
  });
});

// =============================================================================
// GAP 3: resolveSession COMPREHENSIVE COVERAGE
// =============================================================================

describe('resolveSession', () => {
  it('throws when database is unavailable', async () => {
    const { isDatabaseAvailable } = await import('../../db/index.js');
    (isDatabaseAvailable as any).mockReturnValue(false);

    const { resolveSession } = await import('../../channels/session-resolver.js');

    await expect(resolveSession(makeConnection(), makeMessage())).rejects.toThrow(
      'Database not available',
    );

    (isDatabaseAvailable as any).mockReturnValue(true);
  });

  describe('non-email channels', () => {
    it('creates new session when no existing channel session found', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'slack' });
      const message = makeMessage({
        metadata: { slackUserId: 'U12345' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(true);
      expect(result.sessionId).toBe('runtime-sess-1');
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionCreate).toHaveBeenCalledTimes(1);

      // Verify channel session creation payload
      const createPayload = mockChannelSessionCreate.mock.calls[0][0];
      expect(createPayload.tenantId).toBe('tenant-1');
      expect(createPayload.externalSessionKey).toBe('session-key-default');
      expect(createPayload.status).toBe('active');
    });

    it('persists only the durable sessionMetadata subset to channel sessions for new sessions', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'slack' });
      const message = makeMessage({
        metadata: {
          slackUserId: 'U12345',
          sessionMetadata: {
            locale: 'fr-FR',
            token: 'fresh-secret',
            clientInfo: {
              timezone: 'Europe/Paris',
              authToken: 'fresh-client-secret',
            },
          },
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const createRuntimeArgs = mockPipelineCreateSession.mock.calls[0][0];
      expect(createRuntimeArgs.metadata).toEqual({
        locale: 'fr-FR',
        token: 'fresh-secret',
        clientInfo: {
          timezone: 'Europe/Paris',
          authToken: 'fresh-client-secret',
        },
      });

      const createPayload = mockChannelSessionCreate.mock.calls[0][0];
      expect(createPayload.metadata).toEqual({
        slackUserId: 'U12345',
        sessionMetadata: {
          locale: 'fr-FR',
          clientInfo: {
            timezone: 'Europe/Paris',
          },
        },
      });
    });

    it('builds and persists normalized caller identity for new sessions', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        metadata: { whatsappFrom: '+1234567890' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const expectedArtifactHash = hashArtifact('+1234567890');
      const createRuntimeArgs = mockPipelineCreateSession.mock.calls[0][0];

      expect(createRuntimeArgs.callerContext).toMatchObject({
        tenantId: 'tenant-1',
        channel: 'whatsapp',
        channelId: 'conn-1',
        anonymousId: '+1234567890',
        channelArtifact: expectedArtifactHash,
        channelArtifactType: 'phone',
        identityTier: 0,
        verificationMethod: 'none',
      });

      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'runtime-sess-1',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          anonymousId: '+1234567890',
          channelArtifact: expectedArtifactHash,
          channelArtifactType: 'phone',
          identityTier: 0,
          verificationMethod: 'none',
          channelId: 'conn-1',
        }),
      );

      expect(mockRegisterResolutionKey).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'session-store' }),
        {
          tenantId: 'tenant-1',
          channelId: 'conn-1',
          artifactHash: expectedArtifactHash,
          sessionId: 'runtime-sess-1',
        },
      );
    });

    it('uses explicit http_async metadata artifacts for stable identity resolution', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'http_async' as any });
      const message = makeMessage({
        externalSessionKey: 'http_async:tenant-1:sub-1:thread-1',
        metadata: {
          anonymousId: 'account-123',
          channelArtifact: 'device-abc',
          channelArtifactType: 'device_id',
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const expectedArtifactHash = hashArtifact('device-abc');
      const createRuntimeArgs = mockPipelineCreateSession.mock.calls[0][0];

      expect(createRuntimeArgs.callerContext).toMatchObject({
        tenantId: 'tenant-1',
        channel: 'http_async',
        channelId: 'conn-1',
        anonymousId: 'account-123',
        channelArtifact: expectedArtifactHash,
        channelArtifactType: 'device_id',
        identityTier: 0,
        verificationMethod: 'none',
      });

      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          anonymousId: 'account-123',
          channelArtifact: expectedArtifactHash,
          channelArtifactType: 'device_id',
        }),
      );

      expect(mockRegisterResolutionKey).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'session-store' }),
        {
          tenantId: 'tenant-1',
          channelId: 'conn-1',
          artifactHash: expectedArtifactHash,
          sessionId: 'runtime-sess-1',
        },
      );
    });

    it('defaults provider-verified channel identities to tier 1', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        metadata: {
          whatsappFrom: '+1234567890',
          providerVerified: true,
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const createRuntimeArgs = mockPipelineCreateSession.mock.calls[0][0];

      expect(createRuntimeArgs.callerContext).toMatchObject({
        identityTier: 1,
        verificationMethod: 'provider',
      });

      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          identityTier: 1,
          verificationMethod: 'provider',
        }),
      );
    });

    it('throws 413 when follow-up sessionMetadata would overflow merged runtime metadata', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const existingChannelSession = {
        _id: 'cs-existing-metadata-1',
        sessionId: 'runtime-existing-metadata-1',
        externalSessionKey: 'session-key-default',
        status: 'active',
        compilationHash: computeWorkingCopyCompilationHashForTest(),
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingChannelSession),
      });

      mockGetSession.mockReturnValue({
        id: 'runtime-existing-metadata-1',
        data: {
          values: {
            _metadata: {
              existingBlob: 'x'.repeat(262_000),
            },
          },
        },
        versionInfo: {
          deploymentId: undefined,
          environment: 'dev',
        },
      });

      await expect(
        resolveSession(
          makeConnection({ channelType: 'whatsapp' }),
          makeMessage({
            metadata: {
              whatsappFrom: '+1234567890',
              sessionMetadata: {
                nextBlob: 'y'.repeat(1_000),
              },
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
      });

      expect(mockChannelSessionUpdateOne).not.toHaveBeenCalled();
    });

    it('rehydrates the durable sessionMetadata subset after runtime session expiry and overlays fresh ingress metadata', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const existingChannelSession = {
        _id: 'cs-existing-metadata-reload-1',
        sessionId: 'runtime-existing-metadata-reload-1',
        externalSessionKey: 'session-key-default',
        status: 'active',
        compilationHash: computeWorkingCopyCompilationHashForTest(),
        metadata: {
          slackUserId: 'U12345',
          sessionMetadata: {
            locale: 'pt-BR',
            clientInfo: {
              timezone: 'America/Sao_Paulo',
            },
          },
        },
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingChannelSession),
      });

      mockGetSession.mockReturnValue(undefined);
      mockRehydrateSession.mockResolvedValue(undefined);

      await resolveSession(
        makeConnection({ channelType: 'slack' }),
        makeMessage({
          metadata: {
            slackUserId: 'U12345',
            sessionMetadata: {
              token: 'fresh-secret',
              clientInfo: {
                locale: 'fr-FR',
                authToken: 'fresh-client-secret',
              },
            },
          },
        }),
      );

      const createRuntimeArgs = mockPipelineCreateSession.mock.calls[0][0];
      expect(createRuntimeArgs.metadata).toEqual({
        locale: 'pt-BR',
        token: 'fresh-secret',
        clientInfo: {
          timezone: 'America/Sao_Paulo',
          locale: 'fr-FR',
          authToken: 'fresh-client-secret',
        },
      });

      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-existing-metadata-reload-1' },
        {
          $set: {
            sessionId: 'runtime-existing-metadata-reload-1',
            compilationHash: computeWorkingCopyCompilationHashForTest(),
            agentId: null,
            metadata: {
              slackUserId: 'U12345',
              sessionMetadata: {
                locale: 'pt-BR',
                clientInfo: {
                  timezone: 'America/Sao_Paulo',
                  locale: 'fr-FR',
                },
              },
            },
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('promotes provider-verified channel identities to tier 2 when the connection enables strong provider verification', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({
        channelType: 'whatsapp',
        config: {
          identityVerification: {
            providerVerificationStrength: 'strong',
          },
        },
      });
      const message = makeMessage({
        metadata: {
          whatsappFrom: '+1234567890',
          providerVerified: true,
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const createRuntimeArgs = mockPipelineCreateSession.mock.calls[0][0];

      expect(createRuntimeArgs.callerContext).toMatchObject({
        identityTier: 2,
        verificationMethod: 'provider',
      });

      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          identityTier: 2,
          verificationMethod: 'provider',
        }),
      );
    });

    it('resolves and links a provider-verified contact for new sessions', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      mockIsEncryptionAvailable.mockReturnValue(true);

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        metadata: {
          whatsappFrom: '+1234567890',
          providerVerified: true,
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const expectedArtifactHash = hashArtifact('+1234567890');
      expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
        'tenant-1',
        'phone',
        expectedArtifactHash,
        'whatsapp',
        {
          contactAuditSource: 'channel_artifact',
          suppressContactCreatedAudit: false,
        },
      );
      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'contact-1',
        }),
      );
      expect(mockLinkSessionToContactExecute).toHaveBeenCalledWith(
        'tenant-1',
        'contact-1',
        'runtime-sess-1',
        'whatsapp',
        'conn-1',
      );
      expect(mockConversationLinkContact).toHaveBeenCalledWith('runtime-sess-1', 'contact-1');
    });

    it('still links provider-verified contacts when encryption is unavailable', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      mockIsEncryptionAvailable.mockReturnValue(false);

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        metadata: {
          whatsappFrom: '+1234567890',
          providerVerified: true,
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const expectedArtifactHash = hashArtifact('+1234567890');
      expect(mockResolveOrCreateContactExecute).toHaveBeenCalledWith(
        'tenant-1',
        'phone',
        expectedArtifactHash,
        'whatsapp',
        {
          contactAuditSource: 'channel_artifact',
          suppressContactCreatedAudit: false,
        },
      );
      expect(mockLinkSessionToContactExecute).toHaveBeenCalledWith(
        'tenant-1',
        'contact-1',
        'runtime-sess-1',
        'whatsapp',
        'conn-1',
      );
      expect(mockConversationLinkContact).toHaveBeenCalledWith('runtime-sess-1', 'contact-1');
      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'contact-1',
        }),
      );
    });

    it('skips resolution-key registration when the session store is not distributed', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      mockGetSessionService.mockReturnValue({
        isDistributed: () => false,
        store: { kind: 'session-store' },
      });

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        metadata: { whatsappFrom: '+1234567890' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      expect(mockRegisterResolutionKey).not.toHaveBeenCalled();
    });

    it('skips resolution-key registration when no stable channel artifact is available', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'slack' });
      const message = makeMessage({
        metadata: {},
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      expect(mockRegisterResolutionKey).not.toHaveBeenCalled();
      expect(mockCreateAndLinkDBSession).toHaveBeenCalledWith(
        expect.objectContaining({
          anonymousId: 'session-key-default',
          contactId: 'contact-1',
          channelArtifact: undefined,
          channelArtifactType: undefined,
        }),
      );
    });

    it('reuses an active runtime session via identity resolution when the thread key changes', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      mockResolveIdentitySession.mockResolvedValue({
        outcome: 'existing',
        sessionId: 'runtime-artifact',
        reason: 'channel_artifact',
      });
      mockResolutionStoreLoad.mockResolvedValue({
        id: 'runtime-artifact',
        deploymentId: undefined,
      });

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        externalSessionKey: 'whatsapp:new-thread',
        metadata: { whatsappFrom: '+1234567890' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-new-1',
        sessionId: 'runtime-artifact',
        isNew: false,
      });
      expect(mockPipelineCreateSession).not.toHaveBeenCalled();
      expect(mockResolveIdentitySession).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'session-store' }),
        expect.objectContaining({
          tenantId: 'tenant-1',
          channelId: 'conn-1',
          callerContext: expect.objectContaining({
            channelArtifact: hashArtifact('+1234567890'),
          }),
        }),
      );
      expect(mockChannelSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          channelConnectionId: 'conn-1',
          externalSessionKey: 'whatsapp:new-thread',
          sessionId: 'runtime-artifact',
          status: 'active',
        }),
      );
    });

    it('creates a new session instead of artifact-resuming across deployment changes', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      mockResolveIdentitySession.mockResolvedValue({
        outcome: 'existing',
        sessionId: 'runtime-artifact',
        reason: 'channel_artifact',
      });
      mockResolutionStoreLoad.mockResolvedValue({
        id: 'runtime-artifact',
        deploymentId: 'deploy-A',
      });

      const connection = makeConnection({
        channelType: 'whatsapp',
        deploymentId: 'deploy-B',
      });
      const message = makeMessage({
        externalSessionKey: 'whatsapp:new-thread',
        metadata: { whatsappFrom: '+1234567890' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-new-1',
        sessionId: 'runtime-sess-1',
        isNew: true,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'runtime-sess-1',
        }),
      );
    });

    it('skips identity-based resume when no stable artifact exists', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'slack' });
      const message = makeMessage({
        externalSessionKey: 'slack:new-thread',
        metadata: {},
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      expect(mockResolveIdentitySession).not.toHaveBeenCalled();
    });

    it('reuses active existing session when runtime session exists', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({ channelType: 'slack' });
      const message = makeMessage({
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-1',
        sessionId: 'runtime-existing',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'session-key-default',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Runtime session exists in memory
      mockGetSession.mockReturnValue({ id: 'runtime-existing' });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-existing');
      expect(result.channelSessionId).toBe('cs-1');
      // Should NOT create a new runtime session
      expect(mockPipelineCreateSession).not.toHaveBeenCalled();
      // Should update lastMessageAt
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-1' },
        {
          $set: {
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('creates new session when connection deployment changed since session was created', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: 'deploy-B',
      });
      const message = makeMessage({
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-old-deploy',
        sessionId: 'runtime-old-deploy',
        externalSessionKey: 'session-key-default',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Runtime session exists but was created with a different deployment
      mockGetSession.mockReturnValue({
        id: 'runtime-old-deploy',
        versionInfo: { deploymentId: 'deploy-A', versions: {} },
      });

      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-new-deploy'),
        entryAgentName: 'new-agent',
      });

      const result = await resolveSession(connection, message);

      // Should create a new runtime session with the updated deployment
      expect(result.isNew).toBe(false);
      expect(result.channelSessionId).toBe('cs-old-deploy');
      expect(result.sessionId).toBe('runtime-old-deploy');
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockPipelineCreateSession.mock.calls[0][0].deploymentId).toBe('deploy-B');
      expect(mockPipelineCreateSession.mock.calls[0][0].sessionId).toBe('runtime-old-deploy');

      // Should keep the canonical runtime session ID aligned with the existing DB row
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-old-deploy' },
        {
          $set: {
            sessionId: 'runtime-old-deploy',
            compilationHash: null,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('refreshes Slack working-copy sessions so project agent changes do not reuse stale agent IR', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const previousWorkingCopyHash = computeWorkingCopyCompilationHashForTest();
      const refreshedWorkingCopyHash = setWorkingCopyCompilationState({
        agents: [
          ...DEFAULT_WORKING_COPY_AGENTS,
          {
            name: 'cost_estimator_helper',
            sourceHash: 'agent-hash-2',
            updatedAt: new Date('2026-04-05T01:00:00.000Z'),
          },
        ],
      });

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        externalSessionKey: 'slack:thread:cost-estimator',
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-working-copy',
        sessionId: 'runtime-working-copy',
        compilationHash: previousWorkingCopyHash,
        externalSessionKey: 'slack:thread:cost-estimator',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Working-copy sessions have no deployment pin, so channel tests can keep
      // running stale agent/tool IR after project edits (for example, adding a
      // new agent and re-testing the same Slack thread).
      mockGetSession.mockReturnValue({
        id: 'runtime-working-copy',
        agentName: 'Cost_Estimator',
        versionInfo: { environment: 'dev', versions: {} },
      });

      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-working-copy-refreshed'),
        entryAgentName: 'Cost_Estimator',
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-working-copy',
        sessionId: 'runtime-working-copy',
        isNew: false,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockPipelineCreateSession.mock.calls[0][0].sessionId).toBe('runtime-working-copy');
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-working-copy' },
        {
          $set: {
            sessionId: 'runtime-working-copy',
            compilationHash: refreshedWorkingCopyHash,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('refreshes working-copy sessions when project config variables change', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const previousWorkingCopyHash = computeWorkingCopyCompilationHashForTest({
        configVariables: [
          {
            key: 'profile:voice_profile',
            value: 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 10',
            updatedAt: new Date('2026-04-05T00:00:00.000Z'),
          },
        ],
      });
      const refreshedWorkingCopyHash = setWorkingCopyCompilationState({
        configVariables: [
          {
            key: 'profile:voice_profile',
            value: 'BEHAVIOR_PROFILE: voice_profile\nPRIORITY: 20',
            updatedAt: new Date('2026-04-05T01:00:00.000Z'),
          },
        ],
      });

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        externalSessionKey: 'slack:thread:profile-update',
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-working-copy-config',
        sessionId: 'runtime-working-copy-config',
        compilationHash: previousWorkingCopyHash,
        externalSessionKey: 'slack:thread:profile-update',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });
      mockGetSession.mockReturnValue({
        id: 'runtime-working-copy-config',
        agentName: 'Cost_Estimator',
        versionInfo: { environment: 'dev', versions: {} },
      });
      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-working-copy-config-refreshed'),
        entryAgentName: 'Cost_Estimator',
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-working-copy-config',
        sessionId: 'runtime-working-copy-config',
        isNew: false,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-working-copy-config' },
        {
          $set: {
            sessionId: 'runtime-working-copy-config',
            compilationHash: refreshedWorkingCopyHash,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('refreshes working-copy sessions when tool namespace metadata changes', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const baseTool = {
        name: 'lookup_ticket',
        sourceHash: 'tool-hash-1',
        updatedAt: new Date('2026-04-05T00:00:00.000Z'),
      };
      const previousWorkingCopyHash = computeWorkingCopyCompilationHashForTest({
        tools: [{ ...baseTool, variableNamespaceIds: ['ns-old'] }],
      });
      const refreshedWorkingCopyHash = setWorkingCopyCompilationState({
        tools: [{ ...baseTool, variableNamespaceIds: ['ns-new'] }],
      });

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        externalSessionKey: 'slack:thread:tool-namespace-update',
        metadata: { slackUserId: 'U12345' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () =>
          Promise.resolve({
            _id: 'cs-working-copy-tool-namespace',
            sessionId: 'runtime-working-copy-tool-namespace',
            compilationHash: previousWorkingCopyHash,
            externalSessionKey: 'slack:thread:tool-namespace-update',
            status: 'active',
          }),
      });
      mockGetSession.mockReturnValue({
        id: 'runtime-working-copy-tool-namespace',
        agentName: 'Cost_Estimator',
        versionInfo: { environment: 'dev', versions: {} },
      });
      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-working-copy-tool-namespace-refreshed'),
        entryAgentName: 'Cost_Estimator',
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-working-copy-tool-namespace',
        sessionId: 'runtime-working-copy-tool-namespace',
        isNew: false,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-working-copy-tool-namespace' },
        {
          $set: {
            sessionId: 'runtime-working-copy-tool-namespace',
            compilationHash: refreshedWorkingCopyHash,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('refreshes working-copy sessions when a referenced prompt-library version changes', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const agentsWithPromptRef = [
        {
          name: 'test-agent',
          sourceHash: 'agent-hash-1',
          updatedAt: new Date('2026-04-05T00:00:00.000Z'),
          systemPromptLibraryRef: { promptId: 'prompt-1', versionId: 'version-1' },
        },
      ];
      const previousWorkingCopyHash = computeWorkingCopyCompilationHashForTest({
        agents: agentsWithPromptRef,
        promptVersions: [
          {
            _id: 'version-1',
            promptId: 'prompt-1',
            sourceHash: 'prompt-hash-old',
            status: 'draft',
            updatedAt: new Date('2026-04-05T00:00:00.000Z'),
          },
        ],
      });
      const refreshedWorkingCopyHash = setWorkingCopyCompilationState({
        agents: agentsWithPromptRef,
        promptVersions: [
          {
            _id: 'version-1',
            promptId: 'prompt-1',
            sourceHash: 'prompt-hash-new',
            status: 'draft',
            updatedAt: new Date('2026-04-05T02:00:00.000Z'),
          },
        ],
      });

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        externalSessionKey: 'slack:thread:prompt-update',
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-working-copy-prompt',
        sessionId: 'runtime-working-copy-prompt',
        compilationHash: previousWorkingCopyHash,
        externalSessionKey: 'slack:thread:prompt-update',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });
      mockGetSession.mockReturnValue({
        id: 'runtime-working-copy-prompt',
        agentName: 'test-agent',
        versionInfo: { environment: 'dev', versions: {} },
      });
      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-working-copy-prompt-refreshed'),
        entryAgentName: 'test-agent',
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-working-copy-prompt',
        sessionId: 'runtime-working-copy-prompt',
        isNew: false,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-working-copy-prompt' },
        {
          $set: {
            sessionId: 'runtime-working-copy-prompt',
            compilationHash: refreshedWorkingCopyHash,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('refreshes working-copy sessions when MCP raw config changes', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const previousWorkingCopyHash = computeWorkingCopyCompilationHashForTest({
        mcpServers: [
          {
            id: 'srv-1',
            name: 'tool-server',
            transport: 'sse',
            url: 'https://old.example.com/mcp',
            encryptedEnv: null,
            encryptedAuthConfig: null,
            authType: null,
            authProfileId: null,
            headers: null,
            connectionTimeoutMs: 30000,
            requestTimeoutMs: 30000,
          },
        ],
      });
      const refreshedWorkingCopyHash = setWorkingCopyCompilationState({
        mcpServers: [
          {
            id: 'srv-1',
            name: 'tool-server',
            transport: 'sse',
            url: 'https://new.example.com/mcp',
            encryptedEnv: null,
            encryptedAuthConfig: null,
            authType: null,
            authProfileId: null,
            headers: null,
            connectionTimeoutMs: 30000,
            requestTimeoutMs: 30000,
          },
        ],
      });

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        externalSessionKey: 'slack:thread:mcp-update',
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-working-copy-mcp',
        sessionId: 'runtime-working-copy-mcp',
        compilationHash: previousWorkingCopyHash,
        externalSessionKey: 'slack:thread:mcp-update',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });
      mockGetSession.mockReturnValue({
        id: 'runtime-working-copy-mcp',
        agentName: 'test-agent',
        versionInfo: { environment: 'dev', versions: {} },
      });
      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-working-copy-mcp-refreshed'),
        entryAgentName: 'test-agent',
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-working-copy-mcp',
        sessionId: 'runtime-working-copy-mcp',
        isNew: false,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-working-copy-mcp' },
        {
          $set: {
            sessionId: 'runtime-working-copy-mcp',
            compilationHash: refreshedWorkingCopyHash,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('refreshes working-copy sessions when runtime config changes', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const previousWorkingCopyHash = computeWorkingCopyCompilationHashForTest({
        runtimeConfig: {
          updatedAt: new Date('2026-04-05T00:00:00.000Z'),
          filler: {
            enabled: true,
            modelSource: 'system',
          },
        },
      });
      setWorkingCopyCompilationState({
        runtimeConfig: {
          updatedAt: new Date('2026-04-06T00:00:00.000Z'),
          filler: {
            enabled: true,
            modelSource: 'system',
            promptRef: {
              promptId: 'prompt-runtime',
              versionId: 'prompt-runtime-v2',
            },
          },
        },
        promptVersions: [
          {
            _id: 'prompt-runtime-v2',
            promptId: 'prompt-runtime',
            sourceHash: 'prompt-hash-2',
            status: 'active',
            updatedAt: new Date('2026-04-06T00:00:00.000Z'),
          },
        ],
      });

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        externalSessionKey: 'slack:thread:runtime-config-update',
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-working-copy-runtime-config',
        sessionId: 'runtime-working-copy-runtime-config',
        compilationHash: previousWorkingCopyHash,
        externalSessionKey: 'slack:thread:runtime-config-update',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });
      mockGetSession.mockReturnValue({
        id: 'runtime-working-copy-runtime-config',
        agentName: 'test-agent',
        versionInfo: { environment: 'dev', versions: {} },
      });
      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-working-copy-runtime-config-refreshed'),
        entryAgentName: 'test-agent',
      });

      const result = await resolveSession(connection, message);

      expect(result).toEqual({
        channelSessionId: 'cs-working-copy-runtime-config',
        sessionId: 'runtime-working-copy-runtime-config',
        isNew: false,
      });
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-working-copy-runtime-config' },
        {
          $set: {
            sessionId: 'runtime-working-copy-runtime-config',
            compilationHash: expect.any(String),
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
      const [, update] = mockChannelSessionUpdateOne.mock.calls[0] as [
        unknown,
        { $set: { compilationHash: string } },
      ];
      expect(update.$set.compilationHash).not.toBe(previousWorkingCopyHash);
    });

    it('does not false-positive when connection.deploymentId is null and session has no deployment', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      // connection.deploymentId is explicitly null (common DB representation)
      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: null,
      });
      const message = makeMessage({
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-null-deploy',
        sessionId: 'runtime-no-deploy',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'session-key-default',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Runtime session has no deployment (versionInfo.deploymentId is undefined)
      mockGetSession.mockReturnValue({
        id: 'runtime-no-deploy',
        versionInfo: { versions: {} },
      });

      const result = await resolveSession(connection, message);

      // null and undefined both mean "no deployment" — should NOT trigger mismatch
      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-no-deploy');
      expect(mockPipelineCreateSession).not.toHaveBeenCalled();
    });

    it('reuses session when deployment has NOT changed', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({
        channelType: 'slack',
        deploymentId: 'deploy-A',
      });
      const message = makeMessage({
        metadata: { slackUserId: 'U12345' },
      });

      const existingCS = {
        _id: 'cs-same-deploy',
        sessionId: 'runtime-same-deploy',
        externalSessionKey: 'session-key-default',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Runtime session exists with the same deployment
      mockGetSession.mockReturnValue({
        id: 'runtime-same-deploy',
        versionInfo: { deploymentId: 'deploy-A', versions: {} },
      });

      const result = await resolveSession(connection, message);

      // Should reuse — no new session created
      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-same-deploy');
      expect(mockPipelineCreateSession).not.toHaveBeenCalled();
    });

    it('reuses session via rehydration when not in memory but in Redis', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({
        metadata: { whatsappFrom: '+1234567890' },
      });

      const existingCS = {
        _id: 'cs-1',
        sessionId: 'runtime-rehydrated',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'session-key-default',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Not in memory, but rehydratable from Redis
      mockGetSession.mockReturnValue(null);
      mockRehydrateSession.mockResolvedValue({ id: 'runtime-rehydrated' });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-rehydrated');
      expect(mockRehydrateSession).toHaveBeenCalledWith('runtime-rehydrated', {
        locator: {
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          sessionId: 'runtime-rehydrated',
        },
      });
    });

    it('creates new runtime session when existing channel session is stale', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({
        channelType: 'whatsapp',
        deploymentId: undefined,
        environment: undefined,
      });
      const message = makeMessage({
        metadata: { whatsappFrom: '+1234567890' },
      });

      const staleCS = {
        _id: 'cs-stale',
        sessionId: 'runtime-expired',
        externalSessionKey: 'session-key-default',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(staleCS),
      });

      // Runtime session fully expired
      mockGetSession.mockReturnValue(null);
      mockRehydrateSession.mockResolvedValue(null);

      mockPipelineCreateSession.mockResolvedValue({
        runtimeSession: mockNewRuntimeSession('runtime-refreshed'),
        entryAgentName: 'test-agent',
      });

      const result = await resolveSession(connection, message);

      // Should reuse the channel session but with a new runtime session
      expect(result.isNew).toBe(false);
      expect(result.channelSessionId).toBe('cs-stale');
      expect(result.sessionId).toBe('runtime-expired');
      expect(mockPipelineCreateSession.mock.calls[0][0].sessionId).toBe('runtime-expired');

      // Should keep the DB conversation row aligned to the refreshed runtime session
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-stale' },
        {
          $set: {
            sessionId: 'runtime-expired',
            compilationHash: currentWorkingCopyHash,
            agentId: null,
            metadata: {},
            lastMessageAt: expect.any(Date),
          },
        },
      );
    });

    it('skips inactive channel sessions and creates new one', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'slack' });
      const message = makeMessage({
        metadata: { slackUserId: 'U12345' },
      });

      // Existing session but status is NOT 'active'
      const inactiveCS = {
        _id: 'cs-inactive',
        sessionId: 'runtime-old',
        externalSessionKey: 'session-key-default',
        status: 'completed',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(inactiveCS),
      });

      const result = await resolveSession(connection, message);

      // Should create a new session since existing is not active
      expect(result.isNew).toBe(true);
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('email channel', () => {
    it('creates new session when no email thread match exists', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'email' });
      const message = makeMessage({
        externalSessionKey: 'email:subject:hash',
        metadata: {
          from: 'user@example.com',
          messageId: '<msg-001@example.com>',
          hasThreadingHeaders: false,
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(true);
      // Should seed emailMessageIds for new email sessions
      const createPayload = mockChannelSessionCreate.mock.calls[0][0];
      expect(createPayload.emailMessageIds).toEqual(['<msg-001@example.com>']);
    });

    it('resolves session via In-Reply-To message ID threading', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({ channelType: 'email' });
      const message = makeMessage({
        externalSessionKey: 'email:subject:hash',
        metadata: {
          from: 'user@example.com',
          messageId: '<msg-003@example.com>',
          inReplyTo: '<msg-001@example.com>',
          hasThreadingHeaders: true,
        },
      });

      // First findOne: email thread search by emailMessageIds
      const existingCS = {
        _id: 'cs-email-1',
        sessionId: 'runtime-email',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'email:subject:hash',
        emailMessageIds: ['<msg-001@example.com>', '<msg-002@example.com>'],
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      // Runtime session exists
      mockGetSession.mockReturnValue({ id: 'runtime-email' });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-email');

      // Should add current messageId to the session
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-email-1' },
        { $addToSet: { emailMessageIds: '<msg-003@example.com>' } },
      );
    });

    it('resolves session via References header threading', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({ channelType: 'email' });
      const message = makeMessage({
        externalSessionKey: 'email:subject:hash',
        metadata: {
          from: 'user@example.com',
          messageId: '<msg-004@example.com>',
          references: '<msg-001@example.com> <msg-002@example.com>',
          hasThreadingHeaders: true,
        },
      });

      const existingCS = {
        _id: 'cs-email-ref',
        sessionId: 'runtime-email-ref',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'email:subject:hash',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(existingCS),
      });

      mockGetSession.mockReturnValue({ id: 'runtime-email-ref' });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-email-ref');

      // Verify the search included both reference message IDs
      const findOneArgs = mockChannelSessionFindOne.mock.calls[0][0];
      expect(findOneArgs.emailMessageIds.$in).toContain('<msg-001@example.com>');
      expect(findOneArgs.emailMessageIds.$in).toContain('<msg-002@example.com>');
    });

    it('falls back to subject-based key when threading headers unmatched', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({ channelType: 'email' });
      const message = makeMessage({
        externalSessionKey: 'email:subject:hash',
        metadata: {
          from: 'user@example.com',
          messageId: '<msg-005@example.com>',
          inReplyTo: '<msg-unknown@example.com>',
          hasThreadingHeaders: true,
          subjectBasedKey: 'email:re:support-question',
        },
      });

      // First call: emailMessageIds search returns null
      // Second call: subject-based fallback returns a match
      const subjectMatch = {
        _id: 'cs-subject',
        sessionId: 'runtime-subject',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'email:re:support-question',
        status: 'active',
      };
      let callCount = 0;
      mockChannelSessionFindOne.mockImplementation(() => ({
        lean: () => {
          callCount++;
          if (callCount === 1) return Promise.resolve(null); // emailMessageIds miss
          return Promise.resolve(subjectMatch); // subject-based hit
        },
      }));

      mockGetSession.mockReturnValue({ id: 'runtime-subject' });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-subject');
      // Should append messageId to subject-matched session
      expect(mockChannelSessionUpdateOne).toHaveBeenCalledWith(
        { _id: 'cs-subject' },
        { $addToSet: { emailMessageIds: '<msg-005@example.com>' } },
      );
    });

    it('creates new session when threading headers present but no match found', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'email' });
      const message = makeMessage({
        externalSessionKey: 'email:subject:hash',
        metadata: {
          from: 'user@example.com',
          messageId: '<msg-006@example.com>',
          inReplyTo: '<msg-unknown@example.com>',
          hasThreadingHeaders: true,
          // No subjectBasedKey
        },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(true);
      expect(mockPipelineCreateSession).toHaveBeenCalledTimes(1);
    });

    it('resolves session via subject-based key when no threading headers', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');
      const currentWorkingCopyHash = setWorkingCopyCompilationState();

      const connection = makeConnection({ channelType: 'email' });
      const message = makeMessage({
        externalSessionKey: 'email:subject:hash',
        metadata: {
          from: 'user@example.com',
          messageId: '<msg-007@example.com>',
          hasThreadingHeaders: false,
          subjectBasedKey: 'email:re:support',
        },
      });

      const subjectMatch = {
        _id: 'cs-subject-only',
        sessionId: 'runtime-subject-only',
        compilationHash: currentWorkingCopyHash,
        externalSessionKey: 'email:subject:hash',
        status: 'active',
      };
      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(subjectMatch),
      });

      mockGetSession.mockReturnValue({ id: 'runtime-subject-only' });

      const result = await resolveSession(connection, message);

      expect(result.isNew).toBe(false);
      expect(result.sessionId).toBe('runtime-subject-only');
    });
  });

  describe('callerContext propagation', () => {
    it('passes contact-backed CallerContext and scope to pipelineCreateSession', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({
        channelType: 'whatsapp',
        tenantId: 'tenant-99',
      });
      const message = makeMessage({
        metadata: { whatsappFrom: '+1555000111' },
      });

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const createArgs = mockPipelineCreateSession.mock.calls[0][0];
      expect(createArgs.callerContext).toEqual({
        tenantId: 'tenant-99',
        channel: 'whatsapp',
        channelId: 'conn-1',
        anonymousId: '+1555000111',
        channelArtifact: hashArtifact('+1555000111'),
        channelArtifactType: 'phone',
        contactId: 'contact-1',
        customerId: undefined,
        identityTier: 0,
        initiatedById: undefined,
        sessionPrincipalId: 'session-key-default',
        sourceIp: undefined,
        userAgent: undefined,
        verificationMethod: 'none',
      });
      expect(createArgs.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-99',
          projectId: 'project-1',
          subject: expect.objectContaining({
            kind: 'contact',
            contactId: 'contact-1',
          }),
        }),
      );
    });

    it('falls back to externalSessionKey when no anonymous identity artifact is extracted', async () => {
      const { resolveSession } = await import('../../channels/session-resolver.js');

      const connection = makeConnection({ channelType: 'whatsapp' });
      const message = makeMessage({ metadata: {} }); // no whatsappFrom

      mockChannelSessionFindOne.mockReturnValue({
        lean: () => Promise.resolve(null),
      });

      await resolveSession(connection, message);

      const createArgs = mockPipelineCreateSession.mock.calls[0][0];
      expect(createArgs.callerContext).toEqual(
        expect.objectContaining({
          anonymousId: 'session-key-default',
          contactId: 'contact-1',
        }),
      );
      expect(createArgs.scope).toEqual(
        expect.objectContaining({
          kind: 'production',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          subject: expect.objectContaining({
            kind: 'contact',
            contactId: 'contact-1',
          }),
        }),
      );
    });
  });
});
