import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  redactSensitive,
  setLogHandler,
  type LogEntry,
} from '@agent-platform/shared-observability/logger';
import type { PIIType } from '@abl/compiler/platform/security/index.js';
import {
  PIIVault,
  PIIRecognizerRegistry,
  RegexPIIRecognizer,
} from '@abl/compiler/platform/security/index.js';
import { SYSTEM_TOOL_COMPLETE, SYSTEM_TOOL_ESCALATE } from '@abl/compiler';
const { mockRefreshSessionPIIContext } = vi.hoisted(() => ({
  mockRefreshSessionPIIContext: vi.fn(),
}));
vi.mock('../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  refreshSessionPIIContext: mockRefreshSessionPIIContext,
}));
vi.mock('../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockResolvedValue(null),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
  getSessionStreamingConfig: vi.fn().mockReturnValue(undefined),
  toStreamingEvalConfig: vi.fn((config: unknown) => config),
}));
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor.js';
import { ReasoningExecutor } from '../services/execution/reasoning-executor.js';
import { executeHook } from '../services/execution/hook-executor.js';
import { renderTextForLLMWithPIIRedaction } from '../services/execution/pii-llm-redaction.js';
import { restorePIITokensForToolExecutionText } from '../services/execution/pii-tool-execution.js';
import type { RuntimeSession } from '../services/execution/types.js';
import { getTraceStore, resetTraceStore } from '../services/trace-store.js';

interface StoredMessage {
  sessionId: string;
  role: string;
  content: string;
  tenantId?: string;
  channel?: string;
  hasPII?: boolean;
}

async function loadMessagePersistenceModule(options: {
  envRedactOnPersist: boolean;
  tenantScrubPII: boolean;
  projectPIIMatch?: { raw: string; redacted: string };
  projectSnapshot?: {
    piiRedactionConfig: { enabled: boolean; redactInput: boolean; redactOutput: boolean };
    piiRecognizerRegistry?: unknown;
    piiPatternConfigs: unknown[];
  };
}) {
  vi.resetModules();
  process.env.REDACT_PII_ON_PERSIST = options.envRedactOnPersist ? 'true' : 'false';

  const storedMessages: StoredMessage[] = [];
  const projectSnapshot = options.projectSnapshot ?? {
    piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
    piiRecognizerRegistry: undefined,
    piiPatternConfigs: [],
  };
  const resolveProjectPIISnapshotMock = vi.fn().mockResolvedValue(projectSnapshot);
  const mockGetConfigAsync = vi.fn().mockResolvedValue({
    tenantId: 'tenant-1',
    plan: 'TEAM',
    limits: { messageRetentionDays: 90 },
    security: { scrubPII: options.tenantScrubPII },
  });

  vi.doMock('@abl/compiler/platform', () => ({
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      setCorrelationId: vi.fn(),
    }),
  }));

  vi.doMock('../db/index.js', () => ({
    isDatabaseAvailable: () => true,
  }));

  vi.doMock('../services/stores/store-factory.js', () => ({
    getStores: () => ({
      message: {
        addMessage: vi.fn(async (message: StoredMessage) => {
          storedMessages.push(message);
        }),
      },
    }),
    DualWriteMessageStore: class {},
  }));

  vi.doMock('../services/tenant-config.js', () => ({
    getTenantConfigService: () => ({
      getConfigAsync: mockGetConfigAsync,
      resolveProjectMessageRetention: vi.fn().mockResolvedValue(null),
    }),
    PLAN_LIMITS: {
      TEAM: { messageRetentionDays: 90 },
    },
  }));

  vi.doMock('../services/redis/redis-client.js', () => ({
    isRedisAvailable: () => false,
    getRedisClient: () => null,
  }));

  vi.doMock('../repos/session-repo.js', () => ({
    batchCreateMessages: vi.fn(),
    findSessionPersistenceContexts: vi.fn().mockResolvedValue([]),
    updateSessionActivity: vi.fn(),
    incrementSessionTokens: vi.fn(),
    incrementSessionMetrics: vi.fn(),
  }));

  vi.doMock('@agent-platform/shared/encryption', () => ({
    isEncryptionAvailable: () => false,
    getEncryptionService: vi.fn(),
    wrapJobDataForEncrypt: vi.fn(),
    unwrapJobDataForDecrypt: vi.fn(),
  }));

  vi.doMock('@abl/compiler', () => ({
    containsPII: vi.fn((text: string, registry?: unknown) => {
      if (
        options.projectPIIMatch &&
        registry === projectSnapshot.piiRecognizerRegistry &&
        text.includes(options.projectPIIMatch.raw)
      ) {
        return true;
      }

      return text.includes('user@example.com');
    }),
    redactPII: vi.fn((text: string, registry?: unknown) => {
      let redacted = text
        .replaceAll('user@example.com', '[REDACTED_EMAIL]')
        .replaceAll('555-123-4567', '[REDACTED_PHONE]');

      if (options.projectPIIMatch && registry === projectSnapshot.piiRecognizerRegistry) {
        redacted = redacted.replaceAll(
          options.projectPIIMatch.raw,
          options.projectPIIMatch.redacted,
        );
      }

      return redacted;
    }),
  }));

  vi.doMock('../services/pii/session-pii-context.js', () => ({
    resolveProjectPIISnapshot: resolveProjectPIISnapshotMock,
  }));

  const module = await import('../services/message-persistence-queue.js');
  module._resetForTest();

  return {
    persistMessage: module.persistMessage,
    storedMessages,
    mockGetConfigAsync,
    resolveProjectPIISnapshotMock,
  };
}

describe('reported bug: PII masking gaps', () => {
  const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
  const contractIdType: PIIType = 'ContractID';

  function createSessionWithContractIdPattern(
    consumerAccess: NonNullable<RuntimeSession['piiPatternConfigs']>[number]['consumerAccess'] = [],
  ): RuntimeSession {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        [contractIdType],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        contractIdType,
        undefined,
        'custom',
      ),
    );

    return {
      piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
      piiRecognizerRegistry: registry,
      piiVault: new PIIVault({ recognizerRegistry: registry }),
      piiPatternConfigs: [
        {
          patternName: contractIdType,
          defaultRenderMode: 'redacted',
          consumerAccess,
        },
      ],
    } as Partial<RuntimeSession> as RuntimeSession;
  }

  afterEach(() => {
    mockRefreshSessionPIIContext.mockReset();
    mockRefreshSessionPIIContext.mockImplementation(async (session: RuntimeSession) => session);
    setLogHandler(null);
    delete process.env.REDACT_PII_ON_PERSIST;
    resetTraceStore();
    vi.clearAllMocks();
    vi.resetModules();
    vi.doUnmock('@abl/compiler/platform');
    vi.doUnmock('../db/index.js');
    vi.doUnmock('../services/stores/store-factory.js');
    vi.doUnmock('../services/tenant-config.js');
    vi.doUnmock('../services/redis/redis-client.js');
    vi.doUnmock('../repos/session-repo.js');
    vi.doUnmock('@agent-platform/shared/encryption');
    vi.doUnmock('@abl/compiler');
    vi.doUnmock('../services/pii/session-pii-context.js');
  });

  it('logger leaves PII in message strings instead of redacting them', () => {
    const entries: LogEntry[] = [];
    setLogHandler((entry) => {
      entries.push(entry);
    });

    const log = createLogger('reported-pii-gap');
    log.info('Bearer sk-live-secret for user@example.com should call 555-123-4567', {
      context: 'safe',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain('[REDACTED_EMAIL]');
    expect(entries[0].message).toContain('[REDACTED_PHONE]');
    expect(entries[0].message).not.toContain('sk-live-secret');
  });

  it('redactSensitive misses trace-scrubber labels, phone numbers, and arrays', () => {
    const redacted = redactSensitive({
      summary:
        'Email user@example.com, SSN 123-45-6789, card 4111-1111-1111-1111, phone 555-123-4567',
      labels: ['user@example.com', '123-45-6789', '4111-1111-1111-1111', '555-123-4567'],
    });

    expect(redacted.summary).toContain('[REDACTED_EMAIL]');
    expect(redacted.summary).toContain('[REDACTED_SSN]');
    expect(redacted.summary).toContain('[REDACTED_CARD]');
    expect(redacted.summary).toContain('[REDACTED_PHONE]');
    expect(redacted.labels).toEqual([
      '[REDACTED_EMAIL]',
      '[REDACTED_SSN]',
      '[REDACTED_CARD]',
      '[REDACTED_PHONE]',
    ]);
  });

  it('persistMessage ignores tenant scrubPII when env redaction is disabled', async () => {
    const { persistMessage, storedMessages, mockGetConfigAsync } =
      await loadMessagePersistenceModule({
        envRedactOnPersist: false,
        tenantScrubPII: true,
      });

    await persistMessage(
      'session-1',
      'user',
      'Reach user@example.com at 555-123-4567',
      'web_debug',
      'tenant-1',
    );

    expect(mockGetConfigAsync).toHaveBeenCalledWith('tenant-1');
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].hasPII).toBe(true);
    expect(storedMessages[0].content).toBe('Reach [REDACTED_EMAIL] at [REDACTED_PHONE]');
  });

  it('persistMessage uses the project snapshot registry for custom pattern redaction', async () => {
    const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';
    const customRegistry = { id: 'contract-registry' };
    const { persistMessage, storedMessages, resolveProjectPIISnapshotMock } =
      await loadMessagePersistenceModule({
        envRedactOnPersist: false,
        tenantScrubPII: true,
        projectPIIMatch: {
          raw: rawContractId,
          redacted: '[REDACTED_CONTRACT_ID]',
        },
        projectSnapshot: {
          piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
          piiRecognizerRegistry: customRegistry,
          piiPatternConfigs: [],
        },
      });

    await persistMessage(
      'session-1',
      'user',
      `Contract ${rawContractId}`,
      'web_debug',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
    );

    expect(resolveProjectPIISnapshotMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].hasPII).toBe(true);
    expect(storedMessages[0].content).toBe('Contract [REDACTED_CONTRACT_ID]');
    expect(storedMessages[0].content).not.toContain(rawContractId);
  });

  it('persistMessage redacts structured assistant envelopes with project snapshot custom patterns', async () => {
    const customRegistry = { id: 'contract-registry' };
    const { persistMessage, storedMessages } = await loadMessagePersistenceModule({
      envRedactOnPersist: false,
      tenantScrubPII: true,
      projectPIIMatch: {
        raw: rawContractId,
        redacted: '[REDACTED_CONTRACT_ID]',
      },
      projectSnapshot: {
        piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
        piiRecognizerRegistry: customRegistry,
        piiPatternConfigs: [],
      },
    });

    await persistMessage(
      'session-1',
      'assistant',
      'Contract details are ready',
      'web_debug',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
      undefined,
      {
        richContent: {
          markdown: `Contract ${rawContractId}`,
        },
        voiceConfig: {
          plain_text: `Say ${rawContractId}`,
        },
      },
    );

    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].hasPII).toBe(true);
    expect(storedMessages[0].contentEnvelope).toBeDefined();
    expect(storedMessages[0].content).toBe('Contract details are ready');
    expect(JSON.parse(storedMessages[0].contentEnvelope ?? '{}')).toMatchObject({
      richContent: { markdown: 'Contract [REDACTED_CONTRACT_ID]' },
      voiceConfig: { plain_text: 'Say [REDACTED_CONTRACT_ID]' },
    });
    expect(storedMessages[0].contentEnvelope).not.toContain(rawContractId);
  });

  it('persistMessage drops structured envelopes when preserved transport fields still contain PII', async () => {
    const customRegistry = { id: 'contract-registry' };
    const { persistMessage, storedMessages } = await loadMessagePersistenceModule({
      envRedactOnPersist: false,
      tenantScrubPII: true,
      projectPIIMatch: {
        raw: rawContractId,
        redacted: '[REDACTED_CONTRACT_ID]',
      },
      projectSnapshot: {
        piiRedactionConfig: { enabled: true, redactInput: true, redactOutput: true },
        piiRecognizerRegistry: customRegistry,
        piiPatternConfigs: [],
      },
    });

    await persistMessage(
      'session-1',
      'assistant',
      'Contract details are ready',
      'web_debug',
      'tenant-1',
      undefined,
      undefined,
      'project-1',
      undefined,
      {
        actions: {
          elements: [
            {
              id: 'reveal-contract',
              type: 'button',
              label: `Reveal ${rawContractId}`,
              value: rawContractId,
            },
          ],
        },
      },
    );

    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].hasPII).toBe(true);
    expect(storedMessages[0].contentEnvelope).toBeUndefined();
  });

  it('tokenizes custom-pattern tool result content before it re-enters LLM context by default', () => {
    const session = createSessionWithContractIdPattern();
    const rawToolResult = `{"contractId":"${rawContractId}","status":"active"}`;
    const redactedForModel = renderTextForLLMWithPIIRedaction(session, rawToolResult);

    expect(redactedForModel).not.toContain(rawContractId);
    expect(redactedForModel).toContain('{{PII:ContractID:');
  });

  it('live output filtering redacts custom project patterns only when output redaction is enabled', () => {
    const session = createSessionWithContractIdPattern();
    const executor = new ReasoningExecutor(
      {} as ConstructorParameters<typeof ReasoningExecutor>[0],
      {} as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    ) as unknown as { filterChunkPII(session: RuntimeSession, chunk: string): string };

    const redacted = executor.filterChunkPII(session, `Contract ${rawContractId}`);

    session.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: false };
    const unredacted = executor.filterChunkPII(session, `Contract ${rawContractId}`);

    expect(redacted).toContain('[REDACTED_CONTRACT_ID]');
    expect(redacted).not.toContain(rawContractId);
    expect(unredacted).toContain(rawContractId);
  });

  it('escalated-session fallback redacts delivery while tokenizing assistant history for custom patterns', async () => {
    const executor = new RuntimeExecutor();
    executor.stopStaleReaper();

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [
          `
AGENT: Escalated_PII_Agent

GOAL: "Handle escalated fallback responses"
`,
        ],
        'Escalated_PII_Agent',
      ),
    );

    Object.assign(session, createSessionWithContractIdPattern());
    session.initialized = true;
    session.isEscalated = true;
    session.escalationReason = `Contract ${rawContractId} needs human review`;

    const result = await executor.executeMessage(session.id, `Please review ${rawContractId}`);

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(String(session.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(session.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
  });

  it('kb DIRECT short-circuit redacts delivery while tokenizing history for custom patterns', async () => {
    const session = createSessionWithContractIdPattern();
    session.id = 'session-kb-direct-pii';
    session.agentName = 'KbDirectPIIAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session.state = { gatherProgress: {}, conversationPhase: 'active', context: {} };
    session.conversationHistory = [{ role: 'user', content: 'Tell me about this contract.' }];
    session.agentIR = {
      metadata: { name: 'KbDirectPIIAgent', type: 'agent' },
      identity: { goal: 'Answer KB questions', limitations: [] },
      execution: { mode: 'reasoning', max_iterations: 3 },
      constraints: { constraints: [], guardrails: [] },
      gather: { fields: [], strategy: 'llm' },
      tools: [
        {
          name: 'search_contracts',
          tool_type: 'searchai',
          system: false,
        },
      ],
    } as RuntimeSession['agentIR'];
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
    session.activeThreadIndex = 0;
    session.llmClient = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: `{"action":"DIRECT","response":"Contract ${rawContractId}"}`,
        toolCalls: [],
        rawContent: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 12 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      }),
    } as RuntimeSession['llmClient'];
    session._searchaiToolExecutor = {
      getToolTier: vi.fn().mockReturnValue('simple'),
      getSearchInstructions: vi.fn().mockReturnValue(null),
      setCurrentTurn: vi.fn(),
      fireSpeculativeSearch: vi.fn(),
      getDiscoveryManifestForTool: vi.fn().mockReturnValue(null),
      triggerEagerDiscovery: vi.fn().mockResolvedValue(undefined),
    } as RuntimeSession['_searchaiToolExecutor'];

    mockRefreshSessionPIIContext.mockImplementation(async (currentSession: RuntimeSession) => {
      currentSession.piiRedactionConfig = session.piiRedactionConfig;
      currentSession.piiVault = session.piiVault;
      currentSession.piiPatternConfigs = session.piiPatternConfigs;
      currentSession.piiRecognizerRegistry = session.piiRecognizerRegistry;
    });

    const executor = new ReasoningExecutor(
      {
        checkConstraints: vi.fn().mockReturnValue(null),
      } as ConstructorParameters<typeof ReasoningExecutor>[0],
      {
        checkHandoffConditions: vi.fn().mockResolvedValue(null),
        handleHandoff: vi.fn(),
      } as ConstructorParameters<typeof ReasoningExecutor>[1],
      {
        extractEntitiesWithLLM: vi.fn().mockResolvedValue({}),
      } as ConstructorParameters<typeof ReasoningExecutor>[2],
    );
    const chunks: string[] = [];

    const result = await executor.execute(
      session,
      'system prompt',
      [{ name: 'search_contracts', description: 'Search contracts', inputSchema: {} } as any],
      (chunk) => chunks.push(chunk),
    );

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    const lastHistory = session.conversationHistory[session.conversationHistory.length - 1];
    expect(String(lastHistory.content)).toContain('{{PII:ContractID:');
    expect(String(lastHistory.content)).not.toContain(rawContractId);
  });

  it('detokenizes KB fast-path search queries for execution while keeping model and trace inputs protected', async () => {
    const session = createSessionWithContractIdPattern([
      { consumer: 'user', renderMode: 'masked' },
    ]);
    const tokenizedUserQuery = session.piiVault!.tokenize(
      `Can you help me with the contract ${rawContractId}?`,
    ).text;
    session.piiPatternConfigs![0] = {
      ...session.piiPatternConfigs![0],
      defaultRenderMode: 'random',
      maskConfig: { showFirst: 5, showLast: 6, maskChar: '*' },
      randomConfig: { charset: 'alphanumeric', length: 36 },
    };
    session.id = 'session-kb-search-pii-tools';
    session.agentName = 'DatabaseQueryAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session.state = { gatherProgress: {}, conversationPhase: 'active', context: {} };
    session.conversationHistory = [{ role: 'user', content: tokenizedUserQuery }];
    session.agentIR = {
      metadata: { name: 'DatabaseQueryAgent', type: 'agent' },
      identity: { goal: 'Answer contract database questions', limitations: [] },
      execution: { mode: 'reasoning', max_iterations: 2 },
      constraints: { constraints: [], guardrails: [] },
      gather: { fields: [], strategy: 'llm' },
      tools: [
        {
          name: 'search_contracts',
          tool_type: 'searchai',
          system: false,
        },
      ],
    } as RuntimeSession['agentIR'];
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
    session.activeThreadIndex = 0;
    const executePreSearch = vi.fn().mockResolvedValue([
      {
        toolName: 'search_contracts',
        formattedResult: { results: [], queryEcho: rawContractId },
        searchLatencyMs: 1,
      },
    ]);
    const fireSpeculativeSearch = vi.fn();
    session.llmClient = {
      chatWithToolUse: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          action: 'SEARCH',
          query: `Find contract ${tokenizedUserQuery.match(/\{\{PII:[^}]+\}\}/)?.[0]}`,
        }),
        toolCalls: [],
        rawContent: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 12 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      }),
      chatWithToolUseStreamable: vi.fn().mockResolvedValue({
        text: `No contract record was found with the ID ${rawContractId}.`,
        toolCalls: [],
        rawContent: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 12 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      }),
    } as RuntimeSession['llmClient'];
    session._searchaiToolExecutor = {
      getToolTier: vi.fn().mockReturnValue('simple'),
      getSearchInstructions: vi.fn().mockReturnValue(null),
      setCurrentTurn: vi.fn(),
      fireSpeculativeSearch,
      executePreSearch,
      getIndexIdForTool: vi.fn().mockReturnValue('contracts-index'),
      buildCitationMap: vi.fn().mockReturnValue([]),
      getDiscoveryManifestForTool: vi.fn().mockReturnValue(null),
      triggerEagerDiscovery: vi.fn().mockResolvedValue(undefined),
    } as RuntimeSession['_searchaiToolExecutor'];

    mockRefreshSessionPIIContext.mockImplementation(async (currentSession: RuntimeSession) => {
      currentSession.piiRedactionConfig = session.piiRedactionConfig;
      currentSession.piiVault = session.piiVault;
      currentSession.piiPatternConfigs = session.piiPatternConfigs;
      currentSession.piiRecognizerRegistry = session.piiRecognizerRegistry;
    });

    const executor = new ReasoningExecutor(
      {
        checkConstraints: vi.fn().mockReturnValue(null),
      } as ConstructorParameters<typeof ReasoningExecutor>[0],
      {
        checkHandoffConditions: vi.fn().mockResolvedValue(null),
        handleHandoff: vi.fn(),
      } as ConstructorParameters<typeof ReasoningExecutor>[1],
      {
        extractEntitiesWithLLM: vi.fn().mockResolvedValue({}),
      } as ConstructorParameters<typeof ReasoningExecutor>[2],
    );
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await executor.execute(
      session,
      'system prompt',
      [{ name: 'search_contracts', description: 'Search contracts', inputSchema: {} } as any],
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(fireSpeculativeSearch).toHaveBeenCalledWith(
      `Can you help me with the contract ${rawContractId}?`,
    );
    expect(executePreSearch).toHaveBeenCalledWith(`Find contract ${rawContractId}`);
    expect(session.llmClient.chatWithToolUse).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('{{PII:ContractID:'),
        }),
      ]),
      expect.any(Array),
      'extraction',
      expect.any(Object),
    );
    const toolTrace = traceEvents.find(
      (event) => event.type === 'tool_call' && event.data.toolName === 'search_contracts',
    );
    expect(JSON.stringify(toolTrace?.data.input)).toContain('{{PII:ContractID:');
    expect(JSON.stringify(toolTrace?.data.input)).not.toContain(rawContractId);
    expect(result.response).toContain('780b4*************************12905b');
    expect(result.response).not.toContain(rawContractId);
  });

  it('reasoning ESCALATE redacts streamed delivery while tokenizing final history for custom patterns', async () => {
    const session = createSessionWithContractIdPattern();
    session.id = 'session-escalate-pii';
    session.agentName = 'EscalatePIIAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session.state = { gatherProgress: {}, conversationPhase: 'active', context: {} };
    session.conversationHistory = [{ role: 'user', content: 'Please escalate this issue.' }];
    session.agentIR = {
      metadata: { name: 'EscalatePIIAgent', type: 'agent' },
      identity: { goal: 'Escalate issues', limitations: [] },
      execution: { mode: 'reasoning', max_iterations: 2 },
      constraints: { constraints: [], guardrails: [] },
      gather: { fields: [], strategy: 'llm' },
      coordination: {
        escalation: {
          target_team: 'support',
          on_human_complete: [],
        },
      },
      tools: [],
    } as RuntimeSession['agentIR'];
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
    session.activeThreadIndex = 0;
    session.llmClient = {
      chatWithToolUseStreamable: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          {
            id: 'tool-1',
            name: SYSTEM_TOOL_ESCALATE,
            input: { reason: `Contract ${rawContractId} needs review`, priority: 'high' },
          },
        ],
        rawContent: [],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 12 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      }),
    } as RuntimeSession['llmClient'];

    mockRefreshSessionPIIContext.mockImplementation(async (currentSession: RuntimeSession) => {
      currentSession.piiRedactionConfig = session.piiRedactionConfig;
      currentSession.piiVault = session.piiVault;
      currentSession.piiPatternConfigs = session.piiPatternConfigs;
      currentSession.piiRecognizerRegistry = session.piiRecognizerRegistry;
    });

    const executor = new ReasoningExecutor(
      {
        checkConstraints: vi.fn().mockReturnValue(null),
      } as ConstructorParameters<typeof ReasoningExecutor>[0],
      {
        handleEscalate: vi.fn().mockResolvedValue({
          success: true,
          message: `Contract ${rawContractId} needs review`,
        }),
      } as unknown as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    );
    const chunks: string[] = [];

    const result = await executor.execute(session, 'system prompt', [], (chunk) =>
      chunks.push(chunk),
    );

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(String(session.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(session.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
  });

  it('reasoning system-tool break-loop protects structured payloads for custom patterns', async () => {
    const session = createSessionWithContractIdPattern();
    session.id = 'session-complete-structured-pii';
    session.agentName = 'CompleteStructuredPIIAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session.state = { gatherProgress: {}, conversationPhase: 'active', context: {} };
    session.conversationHistory = [{ role: 'user', content: 'Complete the task.' }];
    session.agentIR = {
      metadata: { name: 'CompleteStructuredPIIAgent', type: 'agent' },
      identity: { goal: 'Complete tasks', limitations: [] },
      execution: { mode: 'reasoning', max_iterations: 2 },
      constraints: { constraints: [], guardrails: [] },
      gather: { fields: [], strategy: 'llm' },
      tools: [],
    } as RuntimeSession['agentIR'];
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
    session.activeThreadIndex = 0;
    session.llmClient = {
      chatWithToolUseStreamable: vi.fn().mockResolvedValue({
        text: '',
        toolCalls: [
          {
            id: 'tool-1',
            name: SYSTEM_TOOL_COMPLETE,
            input: { message: 'Done' },
          },
        ],
        rawContent: [],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 12 },
        resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
      }),
    } as RuntimeSession['llmClient'];

    mockRefreshSessionPIIContext.mockImplementation(async (currentSession: RuntimeSession) => {
      currentSession.piiRedactionConfig = session.piiRedactionConfig;
      currentSession.piiVault = session.piiVault;
      currentSession.piiPatternConfigs = session.piiPatternConfigs;
      currentSession.piiRecognizerRegistry = session.piiRecognizerRegistry;
    });

    const executor = new ReasoningExecutor(
      {
        checkConstraints: vi.fn().mockReturnValue(null),
      } as ConstructorParameters<typeof ReasoningExecutor>[0],
      {
        handleComplete: vi.fn().mockReturnValue({
          success: true,
          message: 'Done',
          richContent: { markdown: `Contract ${rawContractId}` },
          voiceConfig: { plain_text: `Contract ${rawContractId}` },
          actions: {
            elements: [
              {
                id: 'review',
                type: 'button',
                label: `Review ${rawContractId}`,
                value: rawContractId,
              },
            ],
          },
        }),
      } as unknown as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    );

    const result = await executor.execute(session, 'system prompt', []);

    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.value).toBe(rawContractId);
  });

  it('reasoning on_error respond returns protected structured payloads for custom patterns', async () => {
    const session = createSessionWithContractIdPattern();
    session.id = 'session-on-error-structured-pii';
    session.agentName = 'ErrorStructuredPIIAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session.state = { gatherProgress: {}, conversationPhase: 'active', context: {} };
    session.conversationHistory = [{ role: 'user', content: 'Look up the contract.' }];
    session.agentIR = {
      metadata: { name: 'ErrorStructuredPIIAgent', type: 'agent' },
      identity: { goal: 'Handle tool failures', limitations: [] },
      execution: { mode: 'reasoning', max_iterations: 2 },
      constraints: { constraints: [], guardrails: [] },
      gather: { fields: [], strategy: 'llm' },
      error_handling: {
        handlers: [
          {
            type: 'tool_error',
            then: 'complete',
            respond: `Contract ${rawContractId} needs review`,
            rich_content: {
              markdown: `### Review contract ${rawContractId}`,
            },
            voice_config: {
              plain_text: `Review contract ${rawContractId}`,
            },
            actions: {
              elements: [
                {
                  id: 'review-contract',
                  type: 'button',
                  label: `Review ${rawContractId}`,
                  value: rawContractId,
                },
              ],
            },
          },
        ],
        default_handler: {
          type: 'DEFAULT',
          then: 'complete',
          respond: 'Something went wrong.',
        },
      },
      tools: [
        {
          name: 'lookup_contract',
          system: false,
        },
      ],
    } as RuntimeSession['agentIR'];
    session.threads = [
      {
        agentName: session.agentName,
        agentIR: session.agentIR,
        conversationHistory: session.conversationHistory,
        state: session.state,
        data: session.data,
        startedAt: Date.now(),
        returnExpected: false,
        status: 'active',
      },
    ];
    session.activeThreadIndex = 0;
    session.llmClient = {
      chatWithToolUseStreamable: vi
        .fn()
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [
            {
              id: 'tool-1',
              name: 'lookup_contract',
              input: { contractId: rawContractId },
            },
          ],
          rawContent: [],
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 12 },
          resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
        })
        .mockResolvedValueOnce({
          text: '',
          toolCalls: [],
          rawContent: [],
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 4 },
          resolvedModel: { modelId: 'test-model', provider: 'test', source: 'test' },
        }),
    } as RuntimeSession['llmClient'];
    session.toolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error(`Contract ${rawContractId} lookup failed`)),
    } as RuntimeSession['toolExecutor'];

    mockRefreshSessionPIIContext.mockImplementation(async (currentSession: RuntimeSession) => {
      currentSession.piiRedactionConfig = session.piiRedactionConfig;
      currentSession.piiVault = session.piiVault;
      currentSession.piiPatternConfigs = session.piiPatternConfigs;
      currentSession.piiRecognizerRegistry = session.piiRecognizerRegistry;
    });

    const executor = new ReasoningExecutor(
      {
        checkConstraints: vi.fn().mockReturnValue(null),
      } as ConstructorParameters<typeof ReasoningExecutor>[0],
      {
        handleHandoff: vi.fn(),
      } as unknown as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    );
    const chunks: string[] = [];

    const result = await executor.execute(
      session,
      'system prompt',
      [{ name: 'lookup_contract', description: 'Lookup contract', inputSchema: {} } as any],
      (chunk) => chunks.push(chunk),
    );

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.voiceConfig?.plain_text).not.toContain(rawContractId);
    expect(result.actions?.elements?.[0].label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements?.[0].label).not.toContain(rawContractId);
    expect(result.actions?.elements?.[0].value).toBe(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(String(session.conversationHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(session.conversationHistory.at(-1)?.content)).not.toContain(rawContractId);
  });

  it('keeps LLM rendering tokenized even when custom patterns request redacted rendering', () => {
    const session = createSessionWithContractIdPattern([
      { consumer: 'llm', renderMode: 'redacted' },
    ]);
    const rawToolResult = `{"contractId":"${rawContractId}","status":"active"}`;
    const redactedForModel = renderTextForLLMWithPIIRedaction(session, rawToolResult);

    expect(redactedForModel).not.toContain(rawContractId);
    expect(redactedForModel).not.toContain('[REDACTED_CONTRACT_ID]');
    expect(redactedForModel).toContain('{{PII:ContractID:');
  });

  it('prevents explicit raw LLM rendering when input redaction is enabled', () => {
    const session = createSessionWithContractIdPattern([
      { consumer: 'llm', renderMode: 'original' },
    ]);
    const rawToolResult = `{"contractId":"${rawContractId}","status":"active"}`;
    const redactedForModel = renderTextForLLMWithPIIRedaction(session, rawToolResult);

    expect(redactedForModel).not.toContain(rawContractId);
    expect(redactedForModel).toContain('{{PII:ContractID:');
  });

  it('keeps LLM rendering tokenized when custom patterns request random rendering', () => {
    const session = createSessionWithContractIdPattern([{ consumer: 'llm', renderMode: 'random' }]);
    const rawToolResult = `{"contractId":"${rawContractId}","status":"active"}`;
    const redactedForModel = renderTextForLLMWithPIIRedaction(session, rawToolResult);

    expect(redactedForModel).not.toContain(rawContractId);
    expect(redactedForModel).toContain('{{PII:ContractID:');
  });

  it('renders default regular tool inputs through the safe tools PII view while retaining protected trace input', async () => {
    const session = createSessionWithContractIdPattern();
    const tokenized = session.piiVault!.tokenize(
      `SELECT * FROM contracts WHERE id = '${rawContractId}'`,
    ).text;
    const execute = vi.fn().mockResolvedValue({ ok: true });
    session.id = 'session-1';
    session.tenantId = 'tenant-1';
    session.projectId = 'project-1';
    session.agentName = 'DatabaseQueryAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session._guardrailPolicy = null;
    session.agentIR = {
      metadata: { name: 'DatabaseQueryAgent' },
      tools: [
        {
          name: 'execute_query',
          parameters: [{ name: 'query' }],
          hints: {},
        },
      ],
    } as RuntimeSession['agentIR'];
    session.toolExecutor = { execute } as RuntimeSession['toolExecutor'];

    const executor = new ReasoningExecutor(
      {} as ConstructorParameters<typeof ReasoningExecutor>[0],
      {} as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    ) as unknown as {
      executeToolCall(
        session: RuntimeSession,
        toolCall: {
          id: string;
          name: string;
          input: Record<string, unknown>;
        },
        onChunk?: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ): Promise<unknown>;
    };
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await executor.executeToolCall(
      session,
      {
        id: 'call-1',
        name: 'execute_query',
        input: { query: tokenized },
      },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result).toBeDefined();
    expect(execute).toHaveBeenCalledWith(
      'execute_query',
      expect.objectContaining({
        // ABLP-535: confirms default tool dispatch renders as [REDACTED_*] (secure default)
        query: "SELECT * FROM contracts WHERE id = '[REDACTED_CONTRACT_ID]'",
      }),
      30000,
    );
    const toolTrace = traceEvents.find((event) => event.type === 'tool_call');
    expect(toolTrace?.data.input).toEqual({ query: tokenized });
    expect(JSON.stringify(toolTrace?.data.input)).not.toContain(rawContractId);
  });

  it('allows raw tool input rendering only when the tools consumer explicitly opts into original values', () => {
    const session = createSessionWithContractIdPattern([
      { consumer: 'tools', renderMode: 'original' },
    ]);
    const tokenized = session.piiVault!.tokenize(
      `SELECT * FROM contracts WHERE id = '${rawContractId}'`,
    ).text;

    const rendered = restorePIITokensForToolExecutionText(session, tokenized);

    expect(rendered).toBe(`SELECT * FROM contracts WHERE id = '${rawContractId}'`);
  });

  it('renders LLM-stripped bare PII token ids through the safe tools view', () => {
    const session = createSessionWithContractIdPattern();
    const tokenized = session.piiVault!.tokenize(rawContractId).text;
    const bareTokenId = tokenized.match(/\{\{PII:[^:}]+:([^}]+)\}\}/)?.[1];

    expect(bareTokenId).toBeDefined();
    const bareToken = bareTokenId!;

    const rendered = restorePIITokensForToolExecutionText(session, `contract=${bareToken}`);

    expect(rendered).toBe('contract=[REDACTED_CONTRACT_ID]');
    expect(rendered).not.toContain(bareToken);
    expect(rendered).not.toContain(rawContractId);
  });

  it('restores LLM-stripped bare PII token ids for explicitly opted-in regular tools', async () => {
    const session = createSessionWithContractIdPattern([
      { consumer: 'tools', renderMode: 'original' },
    ]);
    const tokenized = session.piiVault!.tokenize(rawContractId).text;
    const bareTokenId = tokenized.match(/\{\{PII:[^:}]+:([^}]+)\}\}/)?.[1];
    const execute = vi.fn().mockResolvedValue({ ok: true });

    expect(bareTokenId).toBeDefined();
    const bareToken = bareTokenId!;

    session.id = 'session-bare-token-tool';
    session.tenantId = 'tenant-1';
    session.projectId = 'project-1';
    session.agentName = 'BareTokenToolAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session._guardrailPolicy = null;
    session.agentIR = {
      metadata: { name: 'BareTokenToolAgent' },
      tools: [
        {
          name: 'lookup_contract',
          parameters: [{ name: 'contractId' }],
          hints: {},
        },
      ],
    } as RuntimeSession['agentIR'];
    session.toolExecutor = { execute } as RuntimeSession['toolExecutor'];

    const executor = new ReasoningExecutor(
      {} as ConstructorParameters<typeof ReasoningExecutor>[0],
      {} as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    ) as unknown as {
      executeToolCall(
        session: RuntimeSession,
        toolCall: {
          id: string;
          name: string;
          input: Record<string, unknown>;
        },
        onChunk?: (chunk: string) => void,
        onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
      ): Promise<unknown>;
    };
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    await executor.executeToolCall(
      session,
      {
        id: 'call-bare-token',
        name: 'lookup_contract',
        input: {
          contractId: bareToken,
          nested: {
            auditIds: [bareToken],
          },
        },
      },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(execute).toHaveBeenCalledWith(
      'lookup_contract',
      expect.objectContaining({
        contractId: rawContractId,
        nested: {
          auditIds: [rawContractId],
        },
      }),
      30000,
    );
    const toolTrace = traceEvents.find((event) => event.type === 'tool_call');
    expect(JSON.stringify(toolTrace?.data.input)).toContain(bareToken);
    expect(JSON.stringify(toolTrace?.data.input)).not.toContain(rawContractId);
  });

  it('renders regular tool inputs through restricted pii_access instead of always detokenizing', async () => {
    const session = createSessionWithContractIdPattern();
    const tokenized = session.piiVault!.tokenize(rawContractId).text;
    const execute = vi.fn().mockResolvedValue({ ok: true });
    session.id = 'session-restricted-tool';
    session.tenantId = 'tenant-1';
    session.projectId = 'project-1';
    session.agentName = 'RestrictedToolAgent';
    session.data = { values: {}, gatheredKeys: new Set() };
    session._guardrailPolicy = null;
    session.agentIR = {
      metadata: { name: 'RestrictedToolAgent' },
      tools: [
        {
          name: 'restricted_lookup',
          pii_access: 'user',
          parameters: [{ name: 'contractId' }],
          hints: {},
        },
      ],
    } as RuntimeSession['agentIR'];
    session.toolExecutor = { execute } as RuntimeSession['toolExecutor'];

    const executor = new ReasoningExecutor(
      {} as ConstructorParameters<typeof ReasoningExecutor>[0],
      {} as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    ) as unknown as {
      executeToolCall(
        session: RuntimeSession,
        toolCall: {
          id: string;
          name: string;
          input: Record<string, unknown>;
        },
      ): Promise<unknown>;
    };

    await executor.executeToolCall(session, {
      id: 'call-restricted',
      name: 'restricted_lookup',
      input: { contractId: tokenized },
    });

    expect(execute).toHaveBeenCalledWith(
      'restricted_lookup',
      expect.objectContaining({
        contractId: '[REDACTED_CONTRACT_ID]',
      }),
      30000,
    );
    expect(JSON.stringify(execute.mock.calls[0]?.[1])).not.toContain(rawContractId);
  });

  it('renders context_access PII through the canonical safe tools view before tool execution', async () => {
    const session = createSessionWithContractIdPattern();
    const tokenized = session.piiVault!.tokenize(rawContractId).text;
    const execute = vi.fn().mockResolvedValue({ ok: true });
    session.id = 'session-context-tool';
    session.tenantId = 'tenant-1';
    session.projectId = 'project-1';
    session.agentName = 'ContextToolAgent';
    session.data = {
      values: {
        contractId: tokenized,
      },
      gatheredKeys: new Set(),
    };
    session._guardrailPolicy = null;
    session.agentIR = {
      metadata: { name: 'ContextToolAgent' },
      tools: [
        {
          name: 'context_lookup',
          parameters: [{ name: 'query' }],
          context_access: { read: ['contractId'] },
          hints: {},
        },
      ],
    } as RuntimeSession['agentIR'];
    session.toolExecutor = { execute } as RuntimeSession['toolExecutor'];

    const executor = new ReasoningExecutor(
      {} as ConstructorParameters<typeof ReasoningExecutor>[0],
      {} as ConstructorParameters<typeof ReasoningExecutor>[1],
      {} as ConstructorParameters<typeof ReasoningExecutor>[2],
    ) as unknown as {
      executeToolCall(
        session: RuntimeSession,
        toolCall: {
          id: string;
          name: string;
          input: Record<string, unknown>;
        },
      ): Promise<unknown>;
    };

    await executor.executeToolCall(session, {
      id: 'call-context',
      name: 'context_lookup',
      input: { query: 'lookup contract' },
    });

    expect(execute).toHaveBeenCalledWith(
      'context_lookup',
      expect.objectContaining({
        query: 'lookup contract',
        _context: {
          contractId: '[REDACTED_CONTRACT_ID]',
        },
      }),
      30000,
    );
    expect(JSON.stringify(execute.mock.calls[0]?.[1])).not.toContain(rawContractId);
  });

  it('renders lifecycle hook API tool inputs through the safe tools PII view before execution', async () => {
    const session = createSessionWithContractIdPattern();
    const tokenized = session.piiVault!.tokenize(rawContractId).text;
    const execute = vi.fn().mockResolvedValue({ found: true });
    session.id = 'hook-session-1';
    session.agentName = 'HookPIIAgent';
    session.data = {
      values: {
        contractId: tokenized,
      },
      gatheredKeys: new Set(),
    };
    session.conversationHistory = [];
    session.toolExecutor = { execute } as RuntimeSession['toolExecutor'];

    await executeHook(
      'before_turn',
      {
        before_turn: {
          call_spec: {
            tool: 'lookup_contract',
            with: {
              contractId: 'contractId',
              nested: {
                auditIds: ['contractId'],
              },
            },
            as: 'lookupResult',
          },
        },
      },
      session,
    );

    expect(execute).toHaveBeenCalledWith(
      'lookup_contract',
      {
        contractId: '[REDACTED_CONTRACT_ID]',
        nested: {
          auditIds: ['[REDACTED_CONTRACT_ID]'],
        },
      },
      expect.any(Number),
    );
    expect(session.data.values.contractId).toBe(tokenized);
    expect(JSON.stringify(session.data.values)).not.toContain(rawContractId);
  });

  it('renders fan-out API tool params through the safe tools PII view before direct tool execution', async () => {
    const session = createSessionWithContractIdPattern();
    const tokenized = session.piiVault!.tokenize(rawContractId).text;
    const execute = vi.fn().mockResolvedValue({ found: true });
    const executor = new RuntimeExecutor();
    executor.stopStaleReaper();
    const fanOutSession = executor.createSessionFromResolved(
      compileToResolvedAgent(
        [
          `
SUPERVISOR: FanOutPIIRouter
GOAL: "Route API tools with PII"

TOOLS:
  lookup_contract(contractId: string) -> object
`,
        ],
        'FanOutPIIRouter',
      ),
    );
    fanOutSession.piiRedactionConfig = session.piiRedactionConfig;
    fanOutSession.piiRecognizerRegistry = session.piiRecognizerRegistry;
    fanOutSession.piiVault = session.piiVault;
    fanOutSession.piiPatternConfigs = session.piiPatternConfigs;
    fanOutSession.toolExecutor = { execute } as RuntimeSession['toolExecutor'];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await (
      executor as unknown as {
        routing: {
          handleFanOut(
            runtimeSession: RuntimeSession,
            input: {
              tasks: Array<{
                type: 'tool';
                target: string;
                intent: string;
                params: Record<string, unknown>;
              }>;
            },
            onChunk?: (chunk: string) => void,
            onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
          ): Promise<{ success: boolean }>;
        };
      }
    ).routing.handleFanOut(
      fanOutSession,
      {
        tasks: [
          {
            type: 'tool',
            target: 'lookup_contract',
            intent: 'lookup contract',
            params: {
              contractId: tokenized,
              nested: {
                auditIds: [tokenized],
              },
            },
          },
        ],
      },
      undefined,
      (event) => traceEvents.push(event),
    );

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'lookup_contract',
      {
        contractId: '[REDACTED_CONTRACT_ID]',
        nested: {
          auditIds: ['[REDACTED_CONTRACT_ID]'],
        },
      },
      expect.any(Number),
    );
    const toolTrace = traceEvents.find((event) => event.type === 'tool_call');
    expect(JSON.stringify(toolTrace?.data.params)).toContain('{{PII:ContractID:');
    expect(JSON.stringify(toolTrace?.data.params)).not.toContain(rawContractId);
  });

  it('centralized trace storage resolves the live session recognizer registry when scrubbing', () => {
    const executor = new RuntimeExecutor();
    executor.stopStaleReaper();

    const session = {
      id: 'session-trace-handler',
      customDimensions: new Map<string, string>(),
    } as Partial<RuntimeSession> as RuntimeSession;
    const forwarded: Array<{ type: string; data: Record<string, unknown> }> = [];

    try {
      const handler = (
        executor as unknown as {
          createCentralizedTraceHandler(
            sessionId: string,
            tenantId: string | undefined,
            agentName: string | undefined,
            projectId: string | undefined,
            channelType: string | undefined,
            originalOnTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
            sessionRef?: RuntimeSession,
            traceId?: string,
            scrubPII?: boolean,
          ): (event: { type: string; data: Record<string, unknown> }) => void;
        }
      ).createCentralizedTraceHandler(
        session.id,
        undefined,
        'TraceAgent',
        'project-1',
        'web',
        (event) => forwarded.push({ type: event.type, data: structuredClone(event.data) }),
        session,
        undefined,
        true,
      );

      session.piiRecognizerRegistry = createSessionWithContractIdPattern().piiRecognizerRegistry;

      handler({
        type: 'tool_call',
        data: {
          toolName: 'lookup_contract',
          input: { contractId: rawContractId },
          output: { contractId: rawContractId },
          success: true,
        },
      });

      const storedEvent = getTraceStore().getEvents(session.id)[0];
      expect(storedEvent).toBeDefined();
      expect(JSON.stringify(storedEvent.data)).toContain('[REDACTED_CONTRACT_ID]');
      expect(JSON.stringify(storedEvent.data)).not.toContain(rawContractId);
      expect(JSON.stringify(forwarded[0]?.data)).toContain('[REDACTED_CONTRACT_ID]');
      expect(JSON.stringify(forwarded[0]?.data)).not.toContain(rawContractId);
    } finally {
      executor.stopStaleReaper();
    }
  });
});
