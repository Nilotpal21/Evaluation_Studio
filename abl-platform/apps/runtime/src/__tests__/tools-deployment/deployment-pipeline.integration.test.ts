/**
 * Deployment Pipeline End-to-End Integration Test
 *
 * Exercises the entire deployment pipeline with a real LLM:
 * Agent creation -> Version compilation -> Deployment resolution -> Session creation ->
 * Multi-turn conversation -> Trace verification.
 *
 * Uses mocked repo functions (deployment-repo, project-repo) and Mongoose model
 * stubs but real:
 * - LLM calls (Anthropic, OpenAI, etc. via LLM_PROVIDER env var)
 * - RuntimeExecutor
 * - DeploymentResolver
 * - Agent DSL compilation (parseAgentBasedABL + compileABLtoIR)
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { parseAgentBasedABL } from '@abl/core';
import { compileABLtoIR } from '@abl/compiler';
import type { AgentIR, CompilationOutput } from '@abl/compiler';

// Load .env so loadConfig() can read JWT_SECRET, API keys, etc.
dotenvConfig({ path: resolve(__dirname, '../../.env') });

import { SessionLLMClient } from '../../services/llm/session-llm-client';
import type { ModelResolutionService } from '../../services/llm/model-resolution';
import {
  getSkipReason,
  getApiKey,
  DEFAULT_PROVIDER,
  PROVIDER_MODELS,
} from '../../../../../packages/compiler/src/__tests__/e2e/fixtures/test-utils.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const skipReason = getSkipReason();
const HAS_API_KEY = !skipReason;

const PROJECT_ID = 'proj-e2e-1';
const TENANT_ID = 'tenant-e2e-1';
const DEPLOYMENT_ID = 'deploy-e2e-1';
const AGENT_VERSION = '0.1.0';

// =============================================================================
// AGENT DSL
// =============================================================================

const BOOKING_AGENT_DSL = `
AGENT: booking_agent

GOAL: "Help users book hotels by collecting destination, check-in date, and number of guests."
PERSONA: "You are a friendly hotel booking assistant. Be concise — ask one question at a time. When collecting information, extract the value from the user's message and confirm it briefly."

MODEL:
  PROVIDER: anthropic
  DEFAULT: claude-haiku-4-5-20251001

TOOLS:
  search_hotels(destination: string, checkin_date: string, guests: number) -> {results: array}
    description: "Search for available hotels"

GATHER:
  STRATEGY: conversational
  FIELDS:
    destination:
      TYPE: string
      REQUIRED: true
      PROMPT: "Where would you like to stay?"
    checkin_date:
      TYPE: string
      REQUIRED: true
      PROMPT: "What date would you like to check in?"
    guests:
      TYPE: number
      REQUIRED: true
      PROMPT: "How many guests?"

FLOW:
  steps:
    - greeting
    - collect_details
    - confirm_booking

  greeting:
    REASONING: false
    RESPOND: "Welcome! I can help you find and book a hotel. Where would you like to stay?"
    THEN: collect_details

  collect_details:
    REASONING: false
    GATHER:
      - destination: required
      - checkin_date: required
      - guests:
          required: true
          type: number
    THEN: confirm_booking

  confirm_booking:
    REASONING: false
    RESPOND: "Great! I have found options for your trip!"
`;

// =============================================================================
// COMPILATION HELPER
// =============================================================================

function compileBookingAgent(): {
  agentIR: AgentIR;
  compilationOutput: CompilationOutput;
  sourceHash: string;
} {
  const parseResult = parseAgentBasedABL(BOOKING_AGENT_DSL);
  if (!parseResult.document) {
    throw new Error(`Parse failed: ${parseResult.errors.map((e) => e.message || e).join(', ')}`);
  }

  const compilationOutput = compileABLtoIR([parseResult.document]);
  const agentKeys = Object.keys(compilationOutput.agents);
  const entryName = compilationOutput.entry_agent || agentKeys[0] || 'booking_agent';
  const agentIR = compilationOutput.agents[entryName];
  if (!agentIR) {
    throw new Error(
      `Agent "${entryName}" not found in compilation output. Available: ${agentKeys.join(', ')}`,
    );
  }

  // Compute a simple source hash (matches DeploymentResolver pattern)
  const { createHash } = require('crypto');
  const content = `booking_agent:${JSON.stringify(agentIR)}`;
  const sourceHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

  return { agentIR, compilationOutput, sourceHash };
}

// =============================================================================
// MOCK FACTORIES
// =============================================================================

function createMockSessionService() {
  const irCache = new Map<string, AgentIR>();
  const compilationCache = new Map<string, CompilationOutput>();

  return {
    cacheAgentIR: vi.fn(async (ir: AgentIR) => {
      const hash = `ir_${ir.metadata.name}_hash`;
      irCache.set(hash, ir);
      return hash;
    }),
    resolveAgentIR: vi.fn(async (hash: string) => irCache.get(hash) || null),
    cacheCompilationOutput: vi.fn(async (output: CompilationOutput) => {
      const hash = `comp_hash_${Date.now()}`;
      compilationCache.set(hash, output);
      return hash;
    }),
    resolveCompilationOutput: vi.fn(async (hash: string) => compilationCache.get(hash) || null),
    compilationL1Cache: {
      get: vi.fn((hash: string) => compilationCache.get(hash) || undefined),
    },
  };
}

// =============================================================================
// MONGOOSE MODEL MOCKS
// =============================================================================

// The DeploymentResolver uses dynamic `import('@agent-platform/database/models')`
// internally, so we mock the Mongoose models at that module boundary.
// Individual mock functions are wired up via setupRepoMocks() below.

const {
  mockDeploymentFindOne,
  mockDeploymentUpdateOne,
  mockProjectAgentFind,
  mockAgentVersionFindOne,
  mockAuditLogCreate,
  mockProjectFindById,
} = vi.hoisted(() => ({
  mockDeploymentFindOne: vi.fn(),
  mockDeploymentUpdateOne: vi.fn().mockReturnValue({ catch: vi.fn() }),
  mockProjectAgentFind: vi.fn(),
  mockAgentVersionFindOne: vi.fn(),
  mockAuditLogCreate: vi.fn().mockReturnValue({ catch: vi.fn() }),
  mockProjectFindById: vi.fn(),
}));

/** Creates a chainable query mock that simulates Mongoose .lean() / .sort(). */
function chainable(result: any) {
  const chain: any = {
    lean: vi.fn(() => Promise.resolve(result)),
    sort: vi.fn(function (this: any) {
      return this;
    }),
  };
  chain.sort.mockReturnValue(chain);
  return chain;
}

vi.mock('@agent-platform/database/models', () => ({
  Deployment: {
    findOne: (...args: any[]) => {
      const result = mockDeploymentFindOne(...args);
      return chainable(result);
    },
    updateOne: mockDeploymentUpdateOne,
  },
  ProjectAgent: {
    find: (...args: any[]) => {
      const result = mockProjectAgentFind(...args);
      const chain: any = {
        sort: vi.fn(),
        lean: vi.fn(() => Promise.resolve(result)),
      };
      chain.sort.mockReturnValue(chain);
      return chain;
    },
  },
  AgentVersion: {
    findOne: (...args: any[]) => {
      const result = mockAgentVersionFindOne(...args);
      return chainable(result);
    },
  },
  AuditLog: {
    create: mockAuditLogCreate,
  },
  Project: {
    findById: (...args: any[]) => {
      const result = mockProjectFindById(...args);
      return chainable(result);
    },
    findOne: (...args: any[]) => {
      const result = mockProjectFindById(...args);
      return chainable(result);
    },
  },
  DeploymentModuleSnapshot: {
    findOne: vi.fn().mockReturnValue(chainable(null)),
  },
  PromptTemplate: {
    find: vi.fn().mockReturnValue(chainable([])),
  },
}));

// =============================================================================
// SETUP HELPERS
// =============================================================================

/**
 * Configures all mock model returns for a given agentIR and optional overrides.
 * Replaces the old mock factory with repo-style setup.
 */
function setupRepoMocks(agentIR: AgentIR, overrides: Record<string, any> = {}) {
  const mockDeployment = {
    _id: DEPLOYMENT_ID,
    projectId: PROJECT_ID,
    tenantId: TENANT_ID,
    environment: 'production',
    status: 'active',
    agentVersionManifest: JSON.stringify({ booking_agent: AGENT_VERSION }),
    entryAgentName: 'booking_agent',
    compilationHash: null,
    drainingStartedAt: null,
    ...overrides.deployment,
  };

  const mockProjectAgents = overrides.projectAgents || [
    {
      _id: 'pa-e2e-1',
      name: 'booking_agent',
      projectId: PROJECT_ID,
      dslContent: BOOKING_AGENT_DSL,
      activeVersions: JSON.stringify({ production: AGENT_VERSION, default: AGENT_VERSION }),
      createdAt: new Date('2024-01-01'),
    },
  ];

  const mockAgentVersions: Record<string, any> = {
    [`pa-e2e-1:${AGENT_VERSION}`]: {
      _id: 'av-e2e-1',
      agentId: 'pa-e2e-1',
      version: AGENT_VERSION,
      irContent: JSON.stringify(agentIR),
      status: 'active',
    },
    ...(overrides.agentVersions || {}),
  };

  // Deployment.findOne — resolve by _id+tenantId or by environment
  mockDeploymentFindOne.mockImplementation((where: any) => {
    if (overrides.deploymentFindFirst) return overrides.deploymentFindFirst(where);
    if (where._id === mockDeployment._id && where.tenantId === mockDeployment.tenantId) {
      return mockDeployment;
    }
    return null;
  });

  // Deployment.updateOne — fire-and-forget style (returns thenable with .catch)
  mockDeploymentUpdateOne.mockReturnValue({ catch: vi.fn() });

  // ProjectAgent.find — returns agents matching projectId
  mockProjectAgentFind.mockImplementation((where: any) => {
    return mockProjectAgents.filter((a: any) => a.projectId === where.projectId);
  });

  // AgentVersion.findOne — keyed by agentId:version
  mockAgentVersionFindOne.mockImplementation((where: any) => {
    const key = `${where.agentId}:${where.version}`;
    return mockAgentVersions[key] || null;
  });

  // AuditLog.create — returns thenable
  mockAuditLogCreate.mockReturnValue({ catch: vi.fn() });

  // Project.findById — returns project with tenantId
  mockProjectFindById.mockImplementation(() => {
    return { tenantId: TENANT_ID };
  });

  return { mockDeployment, mockProjectAgents, mockAgentVersions };
}

// Import modules under test (must be after vi.mock)
import {
  DeploymentResolver,
  DeploymentError,
  type ResolvedAgent,
} from '../../services/deployment-resolver.js';
import { RuntimeExecutor } from '../../services/runtime-executor.js';
import { loadConfig, isConfigLoaded } from '../../config/index.js';

// =============================================================================
// TESTS
// =============================================================================

/**
 * Create a RuntimeExecutor wired with the multi-provider LLM client.
 * Bypasses ModelResolutionService (no DB in tests) — uses mock resolution
 * that returns the active provider's API key and model.
 */
function createWiredExecutor(): RuntimeExecutor {
  const provider = DEFAULT_PROVIDER;
  const apiKey = getApiKey(provider);
  const modelMapping = PROVIDER_MODELS[provider] || PROVIDER_MODELS.anthropic;
  const modelId = `${provider}/${modelMapping.haiku}`;

  const executor = new RuntimeExecutor();

  const mockResolution = {
    resolve: async () => ({
      modelId,
      provider,
      source: 'system_default' as const,
      credential: { apiKey, authType: 'api_key' },
      parameters: { maxTokens: 2048 },
    }),
  } as unknown as ModelResolutionService;

  (executor as any).llmWiring.wireLLMClient = async (session: any, agentIR: any) => {
    session.llmClient = new SessionLLMClient(mockResolution, {
      tenantId: session.tenantId,
      agentName: agentIR?.metadata?.name || session.agentName,
      agentIR,
      sessionId: session.id,
    });
  };

  return executor;
}

describe.skipIf(!HAS_API_KEY)('Deployment Pipeline E2E (real LLM)', () => {
  let agentIR: AgentIR;
  let compilationOutput: CompilationOutput;
  let sourceHash: string;

  // Load runtime config so SessionLLMClient can create providers
  beforeAll(async () => {
    if (!isConfigLoaded()) {
      await loadConfig();
    }
  });

  // Compile once for all tests (deterministic, no LLM)
  beforeEach(() => {
    vi.clearAllMocks();
    const compiled = compileBookingAgent();
    agentIR = compiled.agentIR;
    compilationOutput = compiled.compilationOutput;
    sourceHash = compiled.sourceHash;
  });

  // ---------------------------------------------------------------------------
  // Test 1: Full Pipeline — Resolve, Create Session, Multi-Turn Conversation
  // ---------------------------------------------------------------------------
  it('should resolve deployment, create session, and complete multi-turn conversation', async () => {
    setupRepoMocks(agentIR);
    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    // Step 1: Resolve deployment
    const resolved = await resolver.resolve({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    // Verify resolution
    expect(resolved.entryAgent).toBe('booking_agent');
    expect(resolved.agents).toHaveProperty('booking_agent');
    expect(resolved.versionInfo.deploymentId).toBe(DEPLOYMENT_ID);
    expect(resolved.versionInfo.environment).toBe('production');
    expect(resolved.versionInfo.versions).toEqual({ booking_agent: 1000 }); // 0.1.0 -> 1000

    // Step 2: Create session from resolved agents
    const executor = createWiredExecutor();
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channelType: 'test',
    });

    expect(session.id).toBeTruthy();
    expect(session.agentName).toBe('booking_agent');
    expect(session.versionInfo?.deploymentId).toBe(DEPLOYMENT_ID);
    expect(session.versionInfo?.environment).toBe('production');
    expect(session.versionInfo?.versions).toEqual({ booking_agent: 1000 });

    // Step 3: Initialize the flow session (execute greeting step)
    const initChunks: string[] = [];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };

    await executor.initializeSession(session.id, (c) => initChunks.push(c), onTraceEvent);

    const greeting = initChunks.join('');
    expect(greeting.toLowerCase()).toContain('hotel');
    expect(session.currentFlowStep).toBe('collect_details');

    // Step 4: Multi-turn conversation with real LLM
    // Turn 1: Provide destination
    const turn1Chunks: string[] = [];
    const result1 = await executor.executeMessage(
      session.id,
      'I want to book a hotel in Barcelona',
      (c) => turn1Chunks.push(c),
      onTraceEvent,
    );
    expect(result1).toBeTruthy();
    // Should have extracted or be asking for more info
    const turn1Response = turn1Chunks.join('');
    expect(turn1Response.length).toBeGreaterThan(0);

    // Turn 2: Provide check-in date
    const turn2Chunks: string[] = [];
    const result2 = await executor.executeMessage(
      session.id,
      'March 15th, 2025',
      (c) => turn2Chunks.push(c),
      onTraceEvent,
    );
    expect(result2).toBeTruthy();

    // Turn 3: Provide guest count
    const turn3Chunks: string[] = [];
    const result3 = await executor.executeMessage(
      session.id,
      '2 guests',
      (c) => turn3Chunks.push(c),
      onTraceEvent,
    );
    expect(result3).toBeTruthy();

    // Step 5: Verify gathered data
    // The LLM should have extracted the key fields across the turns
    const gatheredKeys = session.data.gatheredKeys;
    const values = session.data.values;

    // At minimum, destination should have been captured (LLM extraction is non-deterministic)
    expect(gatheredKeys.size).toBeGreaterThanOrEqual(1);

    // Conversation history should have multiple entries
    expect(session.conversationHistory.length).toBeGreaterThanOrEqual(4); // init + 3 turns (user+assistant pairs)

    // Trace events should contain flow-related events
    expect(traceEvents.length).toBeGreaterThan(0);
    const traceTypes = new Set(traceEvents.map((e) => e.type));
    expect(
      traceTypes.has('flow_step_enter') ||
        traceTypes.has('dsl_collect') ||
        traceTypes.has('dsl_on_start'),
    ).toBe(true);
  }, 90_000);

  // ---------------------------------------------------------------------------
  // Test 2: Deployment Cache Hit — Second Resolve Reuses Cached IR
  // ---------------------------------------------------------------------------
  it('should cache compilation output and reuse on second resolve', async () => {
    setupRepoMocks(agentIR);
    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    // First resolve — populates cache
    const resolved1 = await resolver.resolve({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      deploymentId: DEPLOYMENT_ID,
    });
    expect(resolved1.entryAgent).toBe('booking_agent');

    // SessionService.cacheAgentIR should have been called
    expect(mockSessionService.cacheAgentIR).toHaveBeenCalled();
    expect(mockSessionService.cacheCompilationOutput).toHaveBeenCalled();

    // The Deployment.updateOne should have been called to set compilationHash
    // (since mockDeployment.compilationHash was null)
    expect(mockDeploymentUpdateOne).toHaveBeenCalled();

    // Second resolve — now the deployment has a compilationHash set from the first call
    // We need to make the mock return the updated deployment with compilationHash
    const updatedDeployment = {
      _id: DEPLOYMENT_ID,
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      environment: 'production',
      status: 'active',
      agentVersionManifest: JSON.stringify({ booking_agent: AGENT_VERSION }),
      entryAgentName: 'booking_agent',
      compilationHash: resolved1.sourceHash,
      drainingStartedAt: null,
    };

    // Override Deployment.findOne to return deployment with compilationHash
    mockDeploymentFindOne.mockImplementation((where: any) => {
      if (where._id === DEPLOYMENT_ID && where.tenantId === TENANT_ID) {
        return updatedDeployment;
      }
      return null;
    });

    // Seed the compilation cache so resolveCompilationOutput hits
    await mockSessionService.cacheCompilationOutput(resolved1.compilationOutput);

    // Mock resolveCompilationOutput to return the cached compilation
    mockSessionService.resolveCompilationOutput.mockResolvedValue(resolved1.compilationOutput);

    const callCountBefore = mockAgentVersionFindOne.mock.calls.length;

    const resolved2 = await resolver.resolve({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    expect(resolved2.entryAgent).toBe('booking_agent');
    expect(resolved2.agents).toHaveProperty('booking_agent');

    // On cache hit, AgentVersion.findOne should NOT have been called again
    const callCountAfter = mockAgentVersionFindOne.mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore);
  });

  // ---------------------------------------------------------------------------
  // Test 3: Retired Deployment — 410 Gone
  // ---------------------------------------------------------------------------
  it('should reject retired deployment with 410 status', async () => {
    setupRepoMocks(agentIR, {
      deployment: { status: 'retired' },
    });
    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    await expect(
      resolver.resolve({
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        deploymentId: DEPLOYMENT_ID,
      }),
    ).rejects.toThrow(DeploymentError);

    try {
      await resolver.resolve({
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        deploymentId: DEPLOYMENT_ID,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(DeploymentError);
      expect((err as DeploymentError).statusCode).toBe(410);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: Environment Resolution Fallback
  // ---------------------------------------------------------------------------
  it('should resolve via environment when no deploymentId is provided', async () => {
    setupRepoMocks(agentIR);
    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    // Resolve by environment (no deploymentId)
    const resolved = await resolver.resolve({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      environment: 'production',
    });

    expect(resolved.entryAgent).toBe('booking_agent');
    expect(resolved.agents).toHaveProperty('booking_agent');
    expect(resolved.versionInfo.environment).toBe('production');
    expect(resolved.versionInfo.deploymentId).toBeUndefined();
    expect(resolved.versionInfo.versions).toEqual({ booking_agent: 1000 });

    // Should have used ProjectAgent.find (environment path)
    expect(mockProjectAgentFind).toHaveBeenCalled();

    // Should still be able to create a session
    const executor = createWiredExecutor();
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channelType: 'test',
    });

    expect(session.agentName).toBe('booking_agent');
    expect(session.versionInfo?.environment).toBe('production');
    expect(session.versionInfo?.deploymentId).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Trace Event Enrichment — Deployment Context in Traces
  // ---------------------------------------------------------------------------
  it('should include deployment context in trace events during conversation', async () => {
    setupRepoMocks(agentIR);
    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    const resolved = await resolver.resolve({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    const executor = createWiredExecutor();
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channelType: 'test',
      deploymentId: DEPLOYMENT_ID,
    });

    // Collect trace events
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      traceEvents.push(event);
    };

    // Initialize and execute one turn
    await executor.initializeSession(session.id, () => {}, onTraceEvent);
    await executor.executeMessage(session.id, 'I want to go to Tokyo', () => {}, onTraceEvent);

    // Verify trace events were emitted
    expect(traceEvents.length).toBeGreaterThan(0);

    // Check that flow-related trace events exist
    const flowEvents = traceEvents.filter(
      (e) =>
        e.type === 'flow_step_enter' ||
        e.type === 'flow_step_exit' ||
        e.type === 'dsl_collect' ||
        e.type === 'dsl_on_start' ||
        e.type === 'dsl_respond' ||
        e.type === 'dsl_prompt',
    );
    expect(flowEvents.length).toBeGreaterThan(0);

    // Verify session still has version info bound
    expect(session.versionInfo?.deploymentId).toBe(DEPLOYMENT_ID);
    expect(session.versionInfo?.environment).toBe('production');
  }, 60_000);
});

// =============================================================================
// UNIT-LEVEL PIPELINE TESTS (no API key required)
// =============================================================================

describe('Deployment Pipeline (compilation + resolution, no LLM)', () => {
  it('should compile booking agent DSL and produce valid IR', () => {
    const { agentIR, compilationOutput } = compileBookingAgent();

    // Verify IR structure
    expect(agentIR.metadata.name).toBeTruthy();

    expect(agentIR.flow).toBeTruthy();
    expect(agentIR.flow?.entry_point).toBe('greeting');
    expect(agentIR.gather?.fields?.length).toBeGreaterThanOrEqual(3);

    // Verify field names
    const fieldNames = agentIR.gather?.fields?.map((f: any) => f.name) || [];
    expect(fieldNames).toContain('destination');
    expect(fieldNames).toContain('checkin_date');
    expect(fieldNames).toContain('guests');

    // Verify compilation output
    expect(compilationOutput.agents).toHaveProperty('booking_agent');
    // entry_agent is only set for supervisors; for single agent, it's undefined
    // The DeploymentResolver and RuntimeExecutor handle this by falling back to the first agent
    expect(compilationOutput.entry_agent).toBeUndefined();
  });

  it('should resolve compiled IR through deployment pipeline', async () => {
    const { agentIR } = compileBookingAgent();
    setupRepoMocks(agentIR);
    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    const resolved = await resolver.resolve({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      deploymentId: DEPLOYMENT_ID,
    });

    // The resolved IR should match what we compiled
    expect(resolved.agents.booking_agent.metadata.name).toBe('booking_agent');

    expect(resolved.entryAgent).toBe('booking_agent');
    expect(resolved.versionInfo.deploymentId).toBe(DEPLOYMENT_ID);
  });

  it('should create a session from resolved deployment without LLM', () => {
    const { agentIR, compilationOutput, sourceHash } = compileBookingAgent();

    // Build a ResolvedAgent manually (simulating what DeploymentResolver.resolve returns)
    const resolved: ResolvedAgent = {
      agents: { booking_agent: agentIR },
      entryAgent: 'booking_agent',
      compilationOutput,
      sourceHash,
      versionInfo: {
        deploymentId: DEPLOYMENT_ID,
        environment: 'production',
        versions: { booking_agent: 1000 },
      },
    };

    const executor = new RuntimeExecutor(); // no API key — won't be able to chat, but can create session
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      channelType: 'test',
    });

    expect(session.id).toBeTruthy();
    expect(session.agentName).toBe('booking_agent');
    expect(session.agentIR?.metadata.name).toBe('booking_agent');
    expect(session.currentFlowStep).toBe('greeting');
    expect(session.versionInfo).toEqual({
      deploymentId: DEPLOYMENT_ID,
      environment: 'production',
      versions: { booking_agent: 1000 },
    });
    expect(session.threads.length).toBe(1);
    expect(session.threads[0].agentName).toBe('booking_agent');
    expect(session.isComplete).toBe(false);
  });

  it('should reject tenant mismatch on environment resolution', async () => {
    const { agentIR } = compileBookingAgent();
    setupRepoMocks(agentIR, {
      projectAgents: [
        {
          _id: 'pa-e2e-1',
          name: 'booking_agent',
          projectId: PROJECT_ID,
          dslContent: BOOKING_AGENT_DSL,
          activeVersions: JSON.stringify({ production: AGENT_VERSION }),
          createdAt: new Date('2024-01-01'),
        },
      ],
    });

    // Override Project.findById to return a different tenantId
    mockProjectFindById.mockImplementation(() => {
      return { tenantId: 'different-tenant' };
    });

    const mockSessionService = createMockSessionService();
    const resolver = new DeploymentResolver(mockSessionService as any);

    await expect(
      resolver.resolve({
        projectId: PROJECT_ID,
        tenantId: TENANT_ID,
        environment: 'production',
      }),
    ).rejects.toThrow('Tenant mismatch');
  });
});
