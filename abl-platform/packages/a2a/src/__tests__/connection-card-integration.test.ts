/**
 * Connection & Card Discovery + Dynamic Card Scenarios integration tests.
 *
 * Tests the agent-card-builder (buildAgentCard, cache invalidation) and
 * express-handlers (resolveConnection middleware, connectionId validation)
 * with mocked DB lookups.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (must be hoisted before imports) ──────────────────────────

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockFindProject = vi.fn();

vi.mock('../../../../apps/runtime/src/repos/project-repo.js', () => ({
  findProjectByIdAndTenant: (...args: unknown[]) => mockFindProject(...args),
}));

/**
 * Capture middlewares passed to the SDK's A2AExpressApp.setupRoutes().
 * We intercept the SDK so we can extract the resolveConnection middleware
 * that our express-handlers code passes through.
 */
let capturedMiddlewares: unknown[] = [];

vi.mock('@a2a-js/sdk/server', () => {
  class MockDefaultRequestHandler {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(
      public agentCard: any,
      _store: any,
      _executor: any,
    ) {}
    async getAgentCard() {
      return this.agentCard;
    }
    async sendMessage() {
      return {};
    }
  }
  class MockInMemoryTaskStore {}
  return {
    DefaultRequestHandler: MockDefaultRequestHandler,
    InMemoryTaskStore: MockInMemoryTaskStore,
  };
});

vi.mock('@a2a-js/sdk/server/express', () => {
  class MockA2AExpressApp {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setupRoutes(app: any, baseUrl?: string, middlewares?: any[]) {
      capturedMiddlewares = middlewares ?? [];
      return app;
    }
  }
  return {
    A2AExpressApp: MockA2AExpressApp,
  };
});

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  buildAgentCard,
  getCachedCard,
  invalidateCard,
  invalidateAllCards,
  type A2AConnectionConfig,
} from '../../../../apps/runtime/src/services/a2a/agent-card-builder.js';
import {
  createA2AExpressHandlers,
  type A2AChannelConnection,
  type CreateA2AExpressHandlersConfig,
} from '../infrastructure/express-handlers.js';
import { a2aContextStorage } from '../infrastructure/agent-executor-adapter.js';
import type { A2ATracingPort, AgentExecutionPort, A2ARequestContext } from '../domain/ports.js';
import type { AgentCard } from '@a2a-js/sdk';
import type { IChannelConnection } from '@agent-platform/database/models';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeConnection(overrides: Partial<IChannelConnection> = {}): IChannelConnection {
  return {
    _id: 'conn-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    agentId: null,
    deploymentId: null,
    environment: null,
    channelType: 'a2a',
    externalIdentifier: 'ext-001',
    displayName: null,
    encryptedCredentials: null,
    authProfileId: null,
    verifyTokenHash: null,
    config: {},
    status: 'active',
    _v: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeA2AConnection(overrides: Partial<A2AChannelConnection> = {}): A2AChannelConnection {
  return {
    _id: 'conn-001',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    deploymentId: null,
    environment: null,
    status: 'active',
    inboundApiKey: null,
    ...overrides,
  };
}

/** Creates a mock Express req/res/next triple for middleware testing.
 *  Sets req.baseUrl to match real Express behavior when a sub-router is
 *  mounted at /a2a/:connectionId — the resolveConnection middleware extracts
 *  the connectionId from req.baseUrl (not req.params) because the SDK's
 *  A2AExpressApp creates its Router without mergeParams. */
function mockReqResNext(params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const connectionId = params.connectionId ?? '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const req = {
    params,
    baseUrl: connectionId ? `/a2a/${connectionId}` : '/a2a',
    headers,
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

function makeTracingPort(): A2ATracingPort {
  return {
    traceOutbound: vi.fn(),
    traceInbound: vi.fn(),
  };
}

function makeExecutionPort(): AgentExecutionPort {
  return {
    executeMessage: vi.fn().mockResolvedValue({
      response: 'Hello',
      action: { type: 'complete' },
    }),
    getSessionDetail: vi.fn().mockReturnValue(null),
    createSession: vi.fn().mockResolvedValue('session-1'),
  };
}

const sampleCard: AgentCard = {
  name: 'Test Agent',
  description: 'Test',
  url: '/a2a/conn-001',
  version: '1.0.0',
  capabilities: {},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [{ id: 'conn-001', name: 'Test Agent', description: 'Test', tags: ['a2a'] }],
} as AgentCard;

/**
 * Extracts the resolveConnection middleware from the captured middlewares
 * after calling setupRoutes on handlers configured with getConnection.
 */
function getResolveConnectionMiddleware(
  getConnection: (id: string) => Promise<A2AChannelConnection | null>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): (req: any, res: any, next: any) => Promise<void> {
  capturedMiddlewares = [];
  const config: CreateA2AExpressHandlersConfig = {
    agentCard: sampleCard,
    agentName: 'test-agent',
    executionPort: makeExecutionPort(),
    tracing: makeTracingPort(),
    getConnection,
  };

  const handlers = createA2AExpressHandlers(config);
  handlers.setupRoutes({});

  // The resolveConnection middleware is the last one in the array
  const mw = capturedMiddlewares[capturedMiddlewares.length - 1];
  if (typeof mw !== 'function') {
    throw new Error('resolveConnection middleware not found in captured middlewares');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mw as any;
}

// ─── Test suites ────────────────────────────────────────────────────────────

describe('Connection & Card Discovery', () => {
  beforeEach(() => {
    invalidateAllCards();
    mockFindProject.mockReset();
    capturedMiddlewares = [];
  });

  // 1. channelType: 'a2a' accepted by CRUD
  it('accepts channelType a2a in a connection record', () => {
    const conn = makeConnection({ channelType: 'a2a' });
    expect(conn.channelType).toBe('a2a');
    // The CHANNEL_CONNECTION_TYPES enum in the model includes 'a2a'
  });

  // 2. Auto-generated card — GET /.well-known/agent-card.json returns card with project info
  it('builds auto-generated card from project name and description', async () => {
    mockFindProject.mockResolvedValue({
      name: 'My Project',
      description: 'Project description',
    });

    const conn = makeConnection();
    const card = await buildAgentCard(conn);

    expect(card.name).toBe('My Project');
    expect(card.description).toBe('Project description');
    expect(card.url).toBe('/a2a/conn-001');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities).toEqual({
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: true,
    });
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].name).toBe('My Project');
  });

  // 3. Custom card overrides — connection with config.card overrides
  it('applies custom card overrides from connection config', async () => {
    mockFindProject.mockResolvedValue({
      name: 'My Project',
      description: 'Project description',
    });

    const customConfig: A2AConnectionConfig = {
      card: {
        name: 'Custom Agent',
        description: 'Custom description',
        version: '2.0.0',
        defaultInputModes: ['text', 'audio'],
        defaultOutputModes: ['text', 'video'],
        skills: [
          { name: 'Skill A', description: 'Does A', tags: ['alpha'] },
          { name: 'Skill B', description: 'Does B' },
        ],
      },
    };

    const conn = makeConnection({ config: customConfig });
    const card = await buildAgentCard(conn);

    expect(card.name).toBe('Custom Agent');
    expect(card.description).toBe('Custom description');
    expect(card.version).toBe('2.0.0');
    expect(card.defaultInputModes).toEqual(['text', 'audio']);
    expect(card.defaultOutputModes).toEqual(['text', 'video']);
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0].name).toBe('Skill A');
    expect(card.skills[0].tags).toEqual(['alpha']);
    expect(card.skills[1].name).toBe('Skill B');
    expect(card.skills[1].tags).toEqual(['a2a']);
  });

  // 4. Card cache invalidation — update config → card reflects change
  it('invalidates cached card so next build reflects config changes', async () => {
    mockFindProject.mockResolvedValue({ name: 'V1 Name', description: 'V1' });

    const conn = makeConnection();
    const cardV1 = await buildAgentCard(conn);
    expect(cardV1.name).toBe('V1 Name');
    expect(getCachedCard('conn-001')).toEqual(cardV1);

    mockFindProject.mockResolvedValue({ name: 'V2 Name', description: 'V2' });
    invalidateCard('conn-001');
    expect(getCachedCard('conn-001')).toBeNull();

    const cardV2 = await buildAgentCard(conn);
    expect(cardV2.name).toBe('V2 Name');
    expect(cardV2.description).toBe('V2');
  });

  // 5. Missing connection → 404
  it('returns 404 when connection is not found', async () => {
    const getConnection = vi.fn().mockResolvedValue(null);
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext({ connectionId: 'nonexistent' });

    await mw(req, res, next);

    expect(getConnection).toHaveBeenCalledWith('nonexistent');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Connection not found' });
    expect(next).not.toHaveBeenCalled();
  });

  // 6. Inactive connection → 410 Gone
  it('returns 410 for inactive connections', async () => {
    const getConnection = vi
      .fn()
      .mockResolvedValue(makeA2AConnection({ _id: 'conn-inactive', status: 'inactive' }));
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext({ connectionId: 'conn-inactive' });

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(410);
    expect(res.json).toHaveBeenCalledWith({ error: 'Connection is inactive' });
    expect(next).not.toHaveBeenCalled();
  });

  // 7. Invalid connectionId → 400
  describe('invalid connectionId returns 400', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mw: (req: any, res: any, next: any) => Promise<void>;

    beforeEach(() => {
      const getConnection = vi.fn().mockResolvedValue(makeA2AConnection());
      mw = getResolveConnectionMiddleware(getConnection);
    });

    it('rejects empty connectionId', async () => {
      // When Express has no connectionId segment, baseUrl is just the mount path
      // with a trailing slash but no ID. We simulate this by passing baseUrl = '/a2a/'
      // so urlAfterBase resolves to empty string.
      const { req, res, next } = mockReqResNext({ connectionId: '' });
      req.baseUrl = '/a2a/';
      await mw(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid connection ID' });
    });

    it('rejects special characters (path traversal)', async () => {
      // In real Express, :connectionId is a single path segment (no slashes).
      // The regex [\w-]+ rejects characters like dots, so test with a dotted ID.
      const { req, res, next } = mockReqResNext({ connectionId: 'conn..etc' });
      await mw(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects excessive length (>128 chars)', async () => {
      const longId = 'a'.repeat(129);
      const { req, res, next } = mockReqResNext({ connectionId: longId });
      await mw(req, res, next);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('accepts valid connectionId with alphanumeric, hyphens, underscores', async () => {
      const { req, res, next } = mockReqResNext({ connectionId: 'conn-001_valid' });
      await mw(req, res, next);
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(next).toHaveBeenCalled();
    });
  });
});

// ─── Inbound Auth Middleware ───────────────────────────────────────────────
describe('Inbound Auth Middleware', () => {
  it('allows requests when connection has no inboundApiKey (auth not configured)', async () => {
    const getConnection = vi.fn().mockResolvedValue(makeA2AConnection({ inboundApiKey: null }));
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext({ connectionId: 'conn-001' });
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('rejects requests with no Authorization header when inboundApiKey is set', async () => {
    const getConnection = vi
      .fn()
      .mockResolvedValue(makeA2AConnection({ inboundApiKey: 'secret-key-123' }));
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext({ connectionId: 'conn-001' });
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authorization header required' });
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with wrong Bearer token', async () => {
    const getConnection = vi
      .fn()
      .mockResolvedValue(makeA2AConnection({ inboundApiKey: 'secret-key-123' }));
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext(
      { connectionId: 'conn-001' },
      { authorization: 'Bearer wrong-key' },
    );
    await mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows requests with correct Bearer token', async () => {
    const getConnection = vi
      .fn()
      .mockResolvedValue(makeA2AConnection({ inboundApiKey: 'secret-key-123' }));
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext(
      { connectionId: 'conn-001' },
      { authorization: 'Bearer secret-key-123' },
    );
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('allows raw token without Bearer prefix', async () => {
    const getConnection = vi
      .fn()
      .mockResolvedValue(makeA2AConnection({ inboundApiKey: 'secret-key-123' }));
    const mw = getResolveConnectionMiddleware(getConnection);
    const { req, res, next } = mockReqResNext(
      { connectionId: 'conn-001' },
      { authorization: 'secret-key-123' },
    );
    await mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('Dynamic Card Scenarios', () => {
  beforeEach(() => {
    invalidateAllCards();
    mockFindProject.mockReset();
    capturedMiddlewares = [];
  });

  // 8. Simple project (no overrides) — project name, single auto-generated skill
  it('simple project produces card with project name and one auto-generated skill', async () => {
    mockFindProject.mockResolvedValue({
      name: 'Simple Project',
      description: 'A simple project',
    });

    const conn = makeConnection({ _id: 'conn-simple', displayName: null });
    const card = await buildAgentCard(conn);

    expect(card.name).toBe('Simple Project');
    expect(card.description).toBe('A simple project');
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe('conn-simple');
    expect(card.skills[0].name).toBe('Simple Project');
    expect(card.skills[0].description).toBe('A simple project');
    expect(card.skills[0].tags).toEqual(['a2a']);
    expect(card.defaultInputModes).toEqual(['text']);
    expect(card.defaultOutputModes).toEqual(['text']);
  });

  // 9. Custom skills (overrides) — config.card.skills → exact skills in card
  it('custom skills override produces card with exactly those skills', async () => {
    mockFindProject.mockResolvedValue({
      name: 'Skill Project',
      description: 'Has custom skills',
    });

    const customConfig: A2AConnectionConfig = {
      card: {
        skills: [
          { name: 'Research', description: 'Deep research', tags: ['research', 'analysis'] },
          { name: 'Summarize', description: 'Text summarization' },
          { name: 'Translate', description: 'Language translation', tags: ['i18n'] },
        ],
      },
    };

    const conn = makeConnection({ _id: 'conn-skills', config: customConfig });
    const card = await buildAgentCard(conn);

    expect(card.skills).toHaveLength(3);
    expect(card.skills[0]).toEqual({
      id: 'conn-skills-skill-0',
      name: 'Research',
      description: 'Deep research',
      tags: ['research', 'analysis'],
    });
    expect(card.skills[1]).toEqual({
      id: 'conn-skills-skill-1',
      name: 'Summarize',
      description: 'Text summarization',
      tags: ['a2a'],
    });
    expect(card.skills[2]).toEqual({
      id: 'conn-skills-skill-2',
      name: 'Translate',
      description: 'Language translation',
      tags: ['i18n'],
    });
  });

  // 10. Deployment-scoped connection — deploymentId stored in AsyncLocalStorage context
  it('deployment-scoped connection stores deploymentId in A2ARequestContext', async () => {
    const getConnection = vi.fn().mockResolvedValue(
      makeA2AConnection({
        _id: 'conn-deploy',
        deploymentId: 'deploy-xyz',
        environment: 'staging',
      }),
    );
    const mw = getResolveConnectionMiddleware(getConnection);

    // Capture the context stored in AsyncLocalStorage via next()
    let storedContext: A2ARequestContext | undefined;
    const { req, res } = mockReqResNext({ connectionId: 'conn-deploy' });
    const captureNext = vi.fn(() => {
      storedContext = a2aContextStorage.getStore();
    });

    await mw(req, res, captureNext);

    expect(getConnection).toHaveBeenCalledWith('conn-deploy');
    expect(captureNext).toHaveBeenCalled();
    expect(storedContext).toBeDefined();
    expect(storedContext!.tenantId).toBe('tenant-1');
    expect(storedContext!.projectId).toBe('project-1');
    expect(storedContext!.connectionId).toBe('conn-deploy');
    expect(storedContext!.deploymentId).toBe('deploy-xyz');
    expect(storedContext!.environment).toBe('staging');
  });

  // 11. Same project, two connections — independent card URLs and session spaces
  it('two connections on same project produce independent cards', async () => {
    mockFindProject.mockResolvedValue({
      name: 'Shared Project',
      description: 'Shared desc',
    });

    const conn1 = makeConnection({
      _id: 'conn-alpha',
      displayName: 'Alpha Agent',
      config: { card: { name: 'Alpha' } } as A2AConnectionConfig,
    });
    const conn2 = makeConnection({
      _id: 'conn-beta',
      displayName: 'Beta Agent',
      config: {
        card: {
          name: 'Beta',
          skills: [{ name: 'Beta Skill', description: 'Special' }],
        },
      } as A2AConnectionConfig,
    });

    const card1 = await buildAgentCard(conn1);
    const card2 = await buildAgentCard(conn2);

    // Each has its own URL
    expect(card1.url).toBe('/a2a/conn-alpha');
    expect(card2.url).toBe('/a2a/conn-beta');

    // Each has its own name from overrides
    expect(card1.name).toBe('Alpha');
    expect(card2.name).toBe('Beta');

    // Alpha has auto-generated skill, Beta has custom skill
    expect(card1.skills).toHaveLength(1);
    expect(card1.skills[0].id).toBe('conn-alpha');
    expect(card2.skills).toHaveLength(1);
    expect(card2.skills[0].id).toBe('conn-beta-skill-0');
    expect(card2.skills[0].name).toBe('Beta Skill');

    // Cards are cached independently
    expect(getCachedCard('conn-alpha')).toEqual(card1);
    expect(getCachedCard('conn-beta')).toEqual(card2);

    // Invalidating one does not affect the other
    invalidateCard('conn-alpha');
    expect(getCachedCard('conn-alpha')).toBeNull();
    expect(getCachedCard('conn-beta')).toEqual(card2);
  });
});
