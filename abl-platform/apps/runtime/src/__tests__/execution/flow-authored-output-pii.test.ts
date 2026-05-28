import { compileABLtoIR } from '@abl/compiler';
import { PIIVault, PIIRecognizerRegistry, RegexPIIRecognizer } from '@abl/compiler/platform';
import { parseAgentBasedABL } from '@abl/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCheckOutputGuardrails } = vi.hoisted(() => ({
  mockCheckOutputGuardrails: vi.fn(),
}));

vi.mock('../../services/execution/session-policy.js', () => ({
  getSessionPolicy: vi.fn().mockResolvedValue(null),
  getSessionGuardrailCacheScopeKey: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../services/execution/output-guardrails.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/execution/output-guardrails.js')>();
  mockCheckOutputGuardrails.mockImplementation(actual.checkOutputGuardrails);
  return {
    ...actual,
    checkOutputGuardrails: mockCheckOutputGuardrails,
  };
});
import { FlowStepExecutor } from '../../services/execution/flow-step-executor.js';
import { SESSION_KEY_ACTION_EVENT } from '../../services/execution/flow-step-executor.js';
import type { RoutingExecutor } from '../../services/execution/routing-executor.js';
import type {
  AgentThread,
  ExecutorContext,
  RuntimeSession,
} from '../../services/execution/types.js';

const { mockRefreshSessionPIIContext } = vi.hoisted(() => ({
  mockRefreshSessionPIIContext: vi.fn(),
}));

vi.mock('../../services/pii/session-pii-context.js', () => ({
  createPIIVaultForProjectSnapshot: vi.fn(),
  resolveProjectPIISnapshot: vi.fn(),
  refreshSessionPIIContext: mockRefreshSessionPIIContext,
}));

const rawContractId = '780b4d1c-1166-487e-ae7a-27eedd12905b';

function compileAgent(dsl: string, agentName: string) {
  const parsed = parseAgentBasedABL(dsl);
  expect(parsed.document).toBeDefined();
  expect(parsed.errors).toHaveLength(0);
  const compiled = compileABLtoIR([parsed.document!]);
  const agent = compiled.agents[agentName];
  expect(agent).toBeDefined();
  return agent;
}

function buildSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'flow-output-pii-session',
    agentName: 'FlowOutputPIIAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: true,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'user-1',
    callerContext: {
      customerId: 'user-1',
      tenantId: 'tenant-1',
      channel: 'test',
      initiatedById: 'user-1',
    },
    currentFlowStep: 'start',
    llmClient: null,
    ...overrides,
  } as RuntimeSession;
}

function buildExecutor(): FlowStepExecutor {
  const ctx = {
    debouncedPersist: vi.fn(),
    persistSession: vi.fn().mockResolvedValue(undefined),
    config: {},
    sessions: new Map(),
    agentRegistry: {},
    agentRegistryStore: {},
    executeMessage: vi.fn(),
    wireLLMClient: vi.fn(),
    checkConstraints: vi.fn().mockReturnValue(null),
    handleConstraintViolation: vi.fn(),
    interpolateTemplate: vi.fn((template: string) => template),
    markExecuting: vi.fn(),
    unmarkExecuting: vi.fn(),
    cancelPendingPersist: vi.fn(),
    reasoning: {
      execute: vi.fn(),
    },
  } as unknown as ExecutorContext;

  const routing = {
    checkHandoffConditions: vi.fn().mockResolvedValue(null),
    checkCompletionConditions: vi.fn().mockReturnValue(null),
    handleHandoff: vi.fn(),
    handleDelegate: vi.fn(),
    handleReturnToParent: vi.fn(),
  } as unknown as RoutingExecutor;

  return new FlowStepExecutor(ctx, routing);
}

function getLastAssistantHistoryWithEnvelope(session: RuntimeSession) {
  return [...session.conversationHistory]
    .reverse()
    .find((entry) => entry.role === 'assistant' && entry.contentEnvelope);
}

describe('flow authored output PII protection', () => {
  beforeEach(() => {
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );

    const patternConfigs: NonNullable<RuntimeSession['piiPatternConfigs']> = [
      {
        patternName: 'ContractID',
        defaultRenderMode: 'redacted',
        consumerAccess: [],
      },
    ];

    mockRefreshSessionPIIContext.mockReset();
    mockCheckOutputGuardrails.mockClear();
    mockRefreshSessionPIIContext.mockImplementation(async (session: RuntimeSession) => {
      session.piiRedactionConfig = { enabled: true, redactInput: true, redactOutput: true };
      session.piiRecognizerRegistry = registry;
      session.piiPatternConfigs = patternConfigs;
      if (session.piiVault) {
        session.piiVault.setRecognizerRegistry(registry);
      } else {
        session.piiVault = new PIIVault({ recognizerRegistry: registry });
      }
    });
  });

  it('redacts ON_START authored output after refreshing project PII context', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: OnStartPIIAgent
GOAL: "Protect ON_START output"

ON_START:
  RESPOND: "Contract ${rawContractId}"
`,
        'OnStartPIIAgent',
      ),
    });
    const chunks: string[] = [];

    const result = await executor.executeOnStart(session, (chunk: string) => {
      chunks.push(chunk);
    });

    expect(mockRefreshSessionPIIContext).toHaveBeenCalledWith(session);
    expect(result?.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result?.response).not.toContain(rawContractId);
    expect(result?.action).toMatchObject({
      type: 'respond',
      message: expect.stringContaining('[REDACTED_CONTRACT_ID]'),
    });
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
  });

  it('stores tokenized history while delivering redacted flow RESPOND output', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: FlowPIIAgent
GOAL: "Protect flow output"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Contract ${rawContractId}"
  THEN: COMPLETE
`,
        'FlowPIIAgent',
      ),
      currentFlowStep: 'start',
    });
    const chunks: string[] = [];

    const result = await executor.executeFlowStep(session, '', (chunk: string) => {
      chunks.push(chunk);
    });

    expect(mockRefreshSessionPIIContext).toHaveBeenCalledWith(session);
    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    expect(session.pendingResponse).toContain('[REDACTED_CONTRACT_ID]');

    const assistantHistory = session.conversationHistory.find(
      (entry) => entry.role === 'assistant',
    );
    expect(typeof assistantHistory?.content).toBe('string');
    expect(String(assistantHistory?.content)).toContain('{{PII:ContractID:');
    expect(String(assistantHistory?.content)).not.toContain(rawContractId);
  });

  it('detokenizes flow API tool params for execution while preserving protected trace params', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: FlowApiToolPIIAgent
GOAL: "Call API tools with original PII values"

TOOLS:
  lookup_contract(contractId: string) -> object

FLOW:
  entry_point: lookup
  steps:
    - lookup

lookup:
  REASONING: false
  CALL: lookup_contract(contractId)
    AS: lookupResult
  RESPOND: "Done"
  THEN: COMPLETE
`,
        'FlowApiToolPIIAgent',
      ),
      currentFlowStep: 'lookup',
    });
    const registry = new PIIRecognizerRegistry();
    registry.register(
      new RegexPIIRecognizer(
        'custom-contract-id',
        ['ContractID'],
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g,
        'ContractID',
        undefined,
        'custom',
      ),
    );
    session.piiVault = new PIIVault({ recognizerRegistry: registry });
    const tokenizedContractId = session.piiVault!.tokenize(rawContractId).text;
    session.data.values.contractId = tokenizedContractId;
    const execute = vi.fn().mockResolvedValue({ found: true });
    session.toolExecutor = { execute } as RuntimeSession['toolExecutor'];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    await executor.executeFlowStep(
      session,
      '',
      undefined,
      (event: { type: string; data: Record<string, unknown> }) => traceEvents.push(event),
    );

    expect(execute).toHaveBeenCalledWith(
      'lookup_contract',
      expect.objectContaining({ contractId: rawContractId }),
      expect.any(Number),
    );
    const dslCall = traceEvents.find((event) => event.type === 'dsl_call');
    expect(JSON.stringify(dslCall?.data.params)).toContain('{{PII:ContractID:');
    expect(JSON.stringify(dslCall?.data.params)).not.toContain(rawContractId);
  });

  it('redacts ON_START rich content payloads before returning them', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: OnStartStructuredPIIAgent
GOAL: "Protect ON_START structured output"

ON_START:
  RESPOND: "Welcome"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
`,
        'OnStartStructuredPIIAgent',
      ),
    });

    const result = await executor.executeOnStart(session);

    expect(result?.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result?.richContent?.markdown).not.toContain(rawContractId);
  });

  it('preserves ON_START structured-only payloads imported from IR without requiring text', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: OnStartStructuredOnlyPIIAgent
GOAL: "Protect structured-only ON_START output"

ON_START:
  RESPOND: "Carrier"
    VOICE:
      plain_text: "Contract ${rawContractId}"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Approve ${rawContractId}" -> approve_contract
`,
      'OnStartStructuredOnlyPIIAgent',
    );
    delete (agentIR.on_start as { respond?: string }).respond;
    const session = buildSession({ agentIR });
    const chunks: string[] = [];

    const result = await executor.executeOnStart(session, (chunk: string) => {
      chunks.push(chunk);
    });

    expect(chunks).toEqual([]);
    expect(result?.response).toBe('');
    expect(result?.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result?.richContent?.markdown).not.toContain(rawContractId);
    expect(result?.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result?.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result?.actions?.elements[0]?.label).not.toContain(rawContractId);
  });

  it('redacts structured flow payloads and pending rich content for authored RESPOND steps', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: FlowStructuredPIIAgent
GOAL: "Protect flow structured output"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Contract ${rawContractId}"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Approve ${rawContractId}" -> approve_contract
  THEN: COMPLETE
`,
        'FlowStructuredPIIAgent',
      ),
      currentFlowStep: 'start',
    });

    const result = await executor.executeFlowStep(session, '');

    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.actions?.elements[0].label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0].label).not.toContain(rawContractId);
    expect(session.pendingRichContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(session.pendingRichContent?.markdown).not.toContain(rawContractId);
  });

  it('interpolates authored flow action payloads before result, pending, and history storage', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: FlowActionInterpolationAgent
GOAL: "Interpolate flow actions"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Review {{session.customer_id}}"
    ACTIONS:
      - BUTTON: "Approve {{session.customer_id}}"
        ID: approve_customer
        VALUE: "{{session.customer_id}}"
        DESCRIPTION: "Approve case {{session.customer_id}}"
  THEN: COMPLETE
`,
        'FlowActionInterpolationAgent',
      ),
      currentFlowStep: 'start',
      data: {
        values: {
          session: { customer_id: 'cust-42' },
        },
        gatheredKeys: new Set(),
      },
    });

    const result = await executor.executeFlowStep(session, '');
    const assistantHistory = session.conversationHistory.find(
      (entry) => entry.role === 'assistant',
    );

    expect(result.actions?.elements[0]).toMatchObject({
      label: 'Approve cust-42',
      value: 'cust-42',
      description: 'Approve case cust-42',
    });
    expect(session.pendingActions?.elements[0]).toMatchObject({
      label: 'Approve cust-42',
      value: 'cust-42',
      description: 'Approve case cust-42',
    });
    expect(assistantHistory?.contentEnvelope?.actions?.elements[0]).toMatchObject({
      label: 'Approve cust-42',
      value: 'cust-42',
      description: 'Approve case cust-42',
    });
  });

  it('sanitizes failed CHECK output while retaining the diagnostic condition in traces', async () => {
    const executor = buildExecutor();
    const failedCondition = `session.contract_id == "${rawContractId}"`;
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: CheckFailureSanitizationAgent
GOAL: "Sanitize failed check output"

FLOW:
  entry_point: guarded
  steps:
    - guarded

guarded:
  REASONING: false
  CHECK: ${failedCondition}
  RESPOND: "Verified"
  THEN: COMPLETE
`,
        'CheckFailureSanitizationAgent',
      ),
      currentFlowStep: 'guarded',
      data: {
        values: {
          session: { contract_id: 'different-contract' },
        },
        gatheredKeys: new Set(),
      },
    });
    const chunks: string[] = [];
    const traceEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

    const result = await executor.executeFlowStep(
      session,
      '',
      (chunk: string) => {
        chunks.push(chunk);
      },
      (event) => {
        traceEvents.push(event);
      },
    );
    const assistantHistory = session.conversationHistory.find(
      (entry) => entry.role === 'assistant',
    );
    const constraintTrace = traceEvents.find((event) => event.type === 'constraint_check');

    expect(result.response).toBe(
      "I can't continue because this step's requirements were not met. Please try again.",
    );
    expect(chunks.join('')).toBe(result.response);
    expect(assistantHistory?.content).toBe(result.response);
    expect(result.response).not.toContain('Check failed');
    expect(result.response).not.toContain(failedCondition);
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).not.toContain(failedCondition);
    expect(String(assistantHistory?.content)).not.toContain(rawContractId);
    expect(constraintTrace?.data).toMatchObject({
      condition: failedCondition,
      passed: false,
    });
  });

  it('drops original structured payloads when output guardrails replace flow RESPOND text', async () => {
    mockCheckOutputGuardrails.mockResolvedValueOnce({
      passed: false,
      text: `Contract ${rawContractId}`,
      violation: {
        guardrailName: 'block_contract_output',
        action: 'block',
        message: 'Blocked safe response',
      },
    });
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: FlowGuardrailStructuredPIIAgent
GOAL: "Protect blocked structured output"

GUARDRAILS:
  block_contract_output:
    kind: output
    check: "block_contract"
    action: block
    message: "Blocked safe response"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Contract ${rawContractId}"
    VOICE:
      plain_text: "Contract ${rawContractId}"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Approve ${rawContractId}" -> approve_contract
  THEN: COMPLETE
`,
        'FlowGuardrailStructuredPIIAgent',
      ),
      currentFlowStep: 'start',
    });
    const chunks: string[] = [];

    const result = await executor.executeFlowStep(session, '', (chunk: string) => {
      chunks.push(chunk);
    });

    expect(result.response).toBe('Blocked safe response');
    expect(chunks.join('')).toBe('Blocked safe response');
    expect(result.richContent).toBeUndefined();
    expect(result.voiceConfig).toBeUndefined();
    expect(result.actions).toBeUndefined();
    expect(session.pendingResponse).toBe('Blocked safe response');
    expect(session.pendingRichContent).toBeUndefined();
    expect(session.pendingVoiceConfig).toBeUndefined();
    expect(session.pendingActions).toBeUndefined();

    const serializedSession = JSON.stringify({
      conversationHistory: session.conversationHistory,
      pendingResponse: session.pendingResponse,
      pendingRichContent: session.pendingRichContent,
      pendingVoiceConfig: session.pendingVoiceConfig,
      pendingActions: session.pendingActions,
    });
    expect(serializedSession).toContain('Blocked safe response');
    expect(serializedSession).not.toContain(rawContractId);
    expect(serializedSession).not.toContain('Approve');
    expect(serializedSession).not.toContain('approve_contract');
  });

  it('drops original structured payloads when output guardrails modify flow RESPOND text', async () => {
    mockCheckOutputGuardrails.mockResolvedValueOnce({
      passed: true,
      text: `Contract ${rawContractId}`,
      modifiedContent: 'Guardrail sanitized response',
    });
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: FlowGuardrailModifiedStructuredPIIAgent
GOAL: "Protect modified structured output"

GUARDRAILS:
  redact_contract_output:
    kind: output
    check: "redact_contract"
    action: redact
    message: "Redacted for safety"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Contract ${rawContractId}"
    VOICE:
      plain_text: "Contract ${rawContractId}"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Approve ${rawContractId}" -> approve_contract
  THEN: COMPLETE
`,
        'FlowGuardrailModifiedStructuredPIIAgent',
      ),
      currentFlowStep: 'start',
    });

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toBe('Guardrail sanitized response');
    expect(result.richContent).toBeUndefined();
    expect(result.voiceConfig).toBeUndefined();
    expect(result.actions).toBeUndefined();
    expect(session.pendingResponse).toBe('Guardrail sanitized response');

    const serializedSession = JSON.stringify({
      conversationHistory: session.conversationHistory,
      pendingResponse: session.pendingResponse,
      pendingRichContent: session.pendingRichContent,
      pendingVoiceConfig: session.pendingVoiceConfig,
      pendingActions: session.pendingActions,
    });
    expect(serializedSession).toContain('Guardrail sanitized response');
    expect(serializedSession).not.toContain(rawContractId);
    expect(serializedSession).not.toContain('Approve');
    expect(serializedSession).not.toContain('approve_contract');
  });

  it('stores a tokenized history envelope for structured-only flow step output', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: FlowStructuredOnlyHistoryPIIAgent
GOAL: "Protect structured-only flow history"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
  RESPOND: "Carrier"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Approve ${rawContractId}" -> approve_contract
  THEN: COMPLETE
`,
      'FlowStructuredOnlyHistoryPIIAgent',
    );
    const startStep = agentIR.flow?.definitions.start as { respond?: string };
    delete startStep.respond;
    const session = buildSession({
      agentIR,
      currentFlowStep: 'start',
    });

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toBe('');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    const assistantHistory = session.conversationHistory.find(
      (entry) => entry.role === 'assistant',
    );
    expect(assistantHistory).toMatchObject({
      role: 'assistant',
      content: '',
      contentEnvelope: {
        richContent: {
          markdown: expect.stringContaining('{{PII:ContractID:'),
        },
        actions: {
          elements: [
            {
              label: expect.stringContaining('{{PII:ContractID:'),
              value: 'approve_contract',
            },
          ],
        },
      },
    });
  });

  it('preserves ON_INPUT structured payloads across auto-advance for runtime delivery', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: OnInputStructuredPIIAgent
GOAL: "Protect ON_INPUT structured output"

FLOW:
  entry_point: start
  steps:
    - start
    - followup

start:
  REASONING: false
  ON_INPUT:
    - IF: input contains "show"
      RESPOND: "Contract ${rawContractId}"
        VOICE:
          plain_text: "Contract ${rawContractId}"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Approve ${rawContractId}" -> approve_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
        'OnInputStructuredPIIAgent',
      ),
      currentFlowStep: 'start',
    });

    const result = await executor.executeFlowStep(session, 'show contract');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);

    const assistantHistory = getLastAssistantHistoryWithEnvelope(session);
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).toContain('{{PII:ContractID:');
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).not.toContain(rawContractId);
    expect(assistantHistory?.contentEnvelope?.voiceConfig?.plain_text).toContain(
      '{{PII:ContractID:',
    );
    expect(assistantHistory?.contentEnvelope?.actions?.elements[0]?.label).toContain(
      '{{PII:ContractID:',
    );
  });

  it('preserves ON_INPUT structured-only payloads across auto-advance for runtime delivery', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: OnInputStructuredOnlyPIIAgent
GOAL: "Protect ON_INPUT structured-only output"

FLOW:
  entry_point: start
  steps:
    - start
    - followup

start:
  REASONING: false
  ON_INPUT:
    - IF: input contains "show"
      RESPOND: "Carrier"
        VOICE:
          plain_text: "Contract ${rawContractId}"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Approve ${rawContractId}" -> approve_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
      'OnInputStructuredOnlyPIIAgent',
    );
    delete (agentIR.flow?.definitions.start.on_input?.[0] as { respond?: string }).respond;
    const session = buildSession({
      agentIR,
      currentFlowStep: 'start',
    });

    const result = await executor.executeFlowStep(session, 'show contract');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);

    const assistantHistory = getLastAssistantHistoryWithEnvelope(session);
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).toContain('{{PII:ContractID:');
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).not.toContain(rawContractId);
    expect(assistantHistory?.contentEnvelope?.voiceConfig?.plain_text).toContain(
      '{{PII:ContractID:',
    );
    expect(assistantHistory?.contentEnvelope?.actions?.elements[0]?.label).toContain(
      '{{PII:ContractID:',
    );
  });

  it('preserves navigation-command ON_INPUT structured payloads across auto-advance for runtime delivery', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: OnInputNavigationStructuredPIIAgent
GOAL: "Protect ON_INPUT navigation structured output"

FLOW:
  entry_point: start
  steps:
    - start
    - followup

start:
  REASONING: false
  GATHER:
    - amount:
        type: number
        required: true
  ON_INPUT:
    - IF: input contains "show"
      RESPOND: "Contract ${rawContractId}"
        VOICE:
          plain_text: "Contract ${rawContractId}"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Approve ${rawContractId}" -> approve_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
        'OnInputNavigationStructuredPIIAgent',
      ),
      currentFlowStep: 'start',
      waitingForInput: ['amount'],
    });

    const result = await executor.executeFlowStep(session, 'show contract');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.voiceConfig?.plain_text).not.toContain(rawContractId);
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);
  });

  it('preserves navigation-command ON_INPUT structured-only payloads across auto-advance', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: OnInputNavigationStructuredOnlyPIIAgent
GOAL: "Protect ON_INPUT navigation structured-only output"

FLOW:
  entry_point: start
  steps:
    - start
    - followup

start:
  REASONING: false
  GATHER:
    - amount:
        type: number
        required: true
  ON_INPUT:
    - IF: input contains "show"
      RESPOND: "Carrier"
        VOICE:
          plain_text: "Contract ${rawContractId}"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Approve ${rawContractId}" -> approve_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
      'OnInputNavigationStructuredOnlyPIIAgent',
    );
    delete (agentIR.flow?.definitions.start.on_input?.[0] as { respond?: string }).respond;
    const session = buildSession({
      agentIR,
      currentFlowStep: 'start',
      waitingForInput: ['amount'],
    });

    const result = await executor.executeFlowStep(session, 'show contract');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);
  });

  it('preserves ELSE fallback structured-only payloads across auto-advance', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: ElseFallbackStructuredOnlyPIIAgent
GOAL: "Protect fallback branch structured output"

FLOW:
  entry_point: collect
  steps:
    - collect
    - followup

collect:
  REASONING: false
  ON_INPUT:
    - IF: input == "known"
      RESPOND: "Known"
      THEN: followup
    - ELSE:
      RESPOND: "Carrier"
        VOICE:
          plain_text: "Contract ${rawContractId}"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Open ${rawContractId}" -> open_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
      'ElseFallbackStructuredOnlyPIIAgent',
    );
    delete (agentIR.flow?.definitions.collect.on_input?.[1] as { respond?: string }).respond;
    const session = buildSession({
      agentIR,
      currentFlowStep: 'collect',
    });

    const result = await executor.executeFlowStep(session, 'unknown');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.voiceConfig?.plain_text).not.toContain(rawContractId);
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);

    const assistantHistory = getLastAssistantHistoryWithEnvelope(session);
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).toContain('{{PII:ContractID:');
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).not.toContain(rawContractId);
    expect(assistantHistory?.contentEnvelope?.voiceConfig?.plain_text).toContain(
      '{{PII:ContractID:',
    );
    expect(assistantHistory?.contentEnvelope?.actions?.elements[0]?.label).toContain(
      '{{PII:ContractID:',
    );
  });

  it('interpolates ON_INPUT branch action payloads across normal and navigation shortcuts', async () => {
    const executor = buildExecutor();
    const normalAgentIR = compileAgent(
      `
AGENT: OnInputActionInterpolationAgent
GOAL: "Interpolate ON_INPUT actions"

FLOW:
  entry_point: start
  steps:
    - start
    - followup

start:
  REASONING: false
  ON_INPUT:
    - IF: input contains "show"
      RESPOND: "Review {{session.customer_id}}"
        ACTIONS:
          - BUTTON: "Approve {{session.customer_id}}"
            ID: approve_customer
            VALUE: "{{session.customer_id}}"
            DESCRIPTION: "Approve case {{session.customer_id}}"
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
      'OnInputActionInterpolationAgent',
    );
    const navigationAgentIR = compileAgent(
      `
AGENT: OnInputNavigationActionInterpolationAgent
GOAL: "Interpolate navigation ON_INPUT actions"

FLOW:
  entry_point: start
  steps:
    - start
    - followup

start:
  REASONING: false
  GATHER:
    - amount:
        type: number
        required: true
  ON_INPUT:
    - IF: input contains "show"
      RESPOND: "Review {{session.customer_id}}"
        ACTIONS:
          - BUTTON: "Approve {{session.customer_id}}"
            ID: approve_customer
            VALUE: "{{session.customer_id}}"
            DESCRIPTION: "Approve case {{session.customer_id}}"
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
      'OnInputNavigationActionInterpolationAgent',
    );
    const normalSession = buildSession({
      agentIR: normalAgentIR,
      currentFlowStep: 'start',
      data: {
        values: {
          session: { customer_id: 'cust-42' },
        },
        gatheredKeys: new Set(),
      },
    });
    const navigationSession = buildSession({
      agentIR: navigationAgentIR,
      currentFlowStep: 'start',
      waitingForInput: ['amount'],
      data: {
        values: {
          session: { customer_id: 'cust-42' },
        },
        gatheredKeys: new Set(),
      },
    });

    const normalResult = await executor.executeFlowStep(normalSession, 'show customer');
    const navigationResult = await executor.executeFlowStep(navigationSession, 'show customer');

    for (const sessionResult of [normalResult, navigationResult]) {
      expect(sessionResult.response).toBe('Next step');
      expect(sessionResult.actions?.elements[0]).toMatchObject({
        label: 'Approve cust-42',
        value: 'cust-42',
        description: 'Approve case cust-42',
      });
    }
    expect(normalSession.pendingActions?.elements[0]?.label).toBe('Approve cust-42');
    expect(navigationSession.pendingActions?.elements[0]?.label).toBe('Approve cust-42');
  });

  it('preserves ON_RESULT structured payloads across auto-advance for runtime delivery', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: OnResultStructuredPIIAgent
GOAL: "Protect ON_RESULT structured output"

TOOLS:
  lookup_contract() -> object

FLOW:
  entry_point: verify
  steps:
    - verify
    - followup

verify:
  REASONING: false
  CALL: lookup_contract()
    AS: contractResult
  ON_RESULT:
    - IF: contractResult.status == "expired"
      RESPOND: "Contract ${rawContractId}"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Renew ${rawContractId}" -> renew_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
        'OnResultStructuredPIIAgent',
      ),
      currentFlowStep: 'verify',
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ status: 'expired' }),
      } as RuntimeSession['toolExecutor'],
    });

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);
  });

  it('preserves ON_RESULT structured-only payloads across auto-advance for runtime delivery', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: OnResultStructuredOnlyPIIAgent
GOAL: "Protect ON_RESULT structured-only output"

TOOLS:
  lookup_contract() -> object

FLOW:
  entry_point: verify
  steps:
    - verify
    - followup

verify:
  REASONING: false
  CALL: lookup_contract()
    AS: contractResult
  ON_RESULT:
    - IF: contractResult.status == "expired"
      RESPOND: "Carrier"
        FORMATS:
          MARKDOWN: "Contract ${rawContractId}"
        ACTIONS:
          - BUTTON: "Renew ${rawContractId}" -> renew_contract
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
      'OnResultStructuredOnlyPIIAgent',
    );
    delete (agentIR.flow?.definitions.verify.on_result?.[0] as { respond?: string }).respond;
    const session = buildSession({
      agentIR,
      currentFlowStep: 'verify',
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ status: 'expired' }),
      } as RuntimeSession['toolExecutor'],
    });

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toBe('Next step');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);

    const assistantHistory = getLastAssistantHistoryWithEnvelope(session);
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).toContain('{{PII:ContractID:');
    expect(assistantHistory?.contentEnvelope?.richContent?.markdown).not.toContain(rawContractId);
    expect(assistantHistory?.contentEnvelope?.actions?.elements[0]?.label).toContain(
      '{{PII:ContractID:',
    );
  });

  it('interpolates ON_RESULT branch action payloads across auto-advance', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: OnResultActionInterpolationAgent
GOAL: "Interpolate ON_RESULT actions"

TOOLS:
  lookup_customer() -> object

FLOW:
  entry_point: verify
  steps:
    - verify
    - followup

verify:
  REASONING: false
  CALL: lookup_customer()
    AS: customerResult
  ON_RESULT:
    - IF: customerResult.status == "needs_review"
      RESPOND: "Review {{session.customer_id}}"
        ACTIONS:
          - BUTTON: "Approve {{session.customer_id}}"
            ID: approve_customer
            VALUE: "{{session.customer_id}}"
            DESCRIPTION: "Approve case {{session.customer_id}}"
      THEN: followup

followup:
  REASONING: false
  RESPOND: "Next step"
  THEN: COMPLETE
`,
        'OnResultActionInterpolationAgent',
      ),
      currentFlowStep: 'verify',
      data: {
        values: {
          session: { customer_id: 'cust-42' },
        },
        gatheredKeys: new Set(),
      },
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ status: 'needs_review' }),
      } as RuntimeSession['toolExecutor'],
    });

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toBe('Next step');
    expect(result.actions?.elements[0]).toMatchObject({
      label: 'Approve cust-42',
      value: 'cust-42',
      description: 'Approve case cust-42',
    });
    expect(session.pendingActions?.elements[0]?.label).toBe('Approve cust-42');
  });

  it('interpolates ON_SUCCESS and ON_FAILURE action payloads before delivery', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: CallResultActionInterpolationAgent
GOAL: "Interpolate call result actions"

TOOLS:
  validate_customer() -> object

FLOW:
  entry_point: verify
  steps:
    - verify
    - done
    - retry

verify:
  REASONING: false
  CALL: validate_customer()
  ON_SUCCESS:
    RESPOND: "Approved {{session.customer_id}}"
      ACTIONS:
        - BUTTON: "Continue {{session.customer_id}}"
          ID: continue_customer
          VALUE: "{{session.customer_id}}"
          DESCRIPTION: "Continue case {{session.customer_id}}"
    THEN: done
  ON_FAILURE:
    RESPOND: "Retry {{session.customer_id}}"
      ACTIONS:
        - BUTTON: "Retry {{session.customer_id}}"
          ID: retry_customer
          VALUE: "{{session.customer_id}}"
          DESCRIPTION: "Retry case {{session.customer_id}}"
    THEN: retry

done:
  REASONING: false
  RESPOND: "Done"
  THEN: COMPLETE

retry:
  REASONING: false
  RESPOND: "Retry next"
  THEN: COMPLETE
`,
      'CallResultActionInterpolationAgent',
    );
    const successSession = buildSession({
      agentIR,
      currentFlowStep: 'verify',
      data: {
        values: {
          session: { customer_id: 'cust-42' },
        },
        gatheredKeys: new Set(),
      },
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ status: 'approved' }),
      } as RuntimeSession['toolExecutor'],
    });
    const failureSession = buildSession({
      agentIR,
      currentFlowStep: 'verify',
      data: {
        values: {
          session: { customer_id: 'cust-42' },
        },
        gatheredKeys: new Set(),
      },
      toolExecutor: {
        execute: vi.fn().mockResolvedValue({ _error: true, message: 'denied' }),
      } as RuntimeSession['toolExecutor'],
    });

    const successResult = await executor.executeFlowStep(successSession, '');
    const failureResult = await executor.executeFlowStep(failureSession, '');

    expect(successResult.actions?.elements[0]).toMatchObject({
      label: 'Continue cust-42',
      value: 'cust-42',
      description: 'Continue case cust-42',
    });
    expect(failureResult.actions?.elements[0]).toMatchObject({
      label: 'Retry cust-42',
      value: 'cust-42',
      description: 'Retry case cust-42',
    });
  });

  it('preserves ON_ERROR default handler structured payloads through complete fallback', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: DefaultErrorStructuredPIIAgent
GOAL: "Protect structured default error output"

TOOLS:
  lookup_contract() -> object

ON_ERROR:
  DEFAULT:
    RESPOND: "Contract ${rawContractId}"
      VOICE:
        plain_text: "Contract ${rawContractId}"
      FORMATS:
        MARKDOWN: "Contract ${rawContractId}"
      ACTIONS:
        - BUTTON: "Retry ${rawContractId}" -> retry_contract
    THEN: COMPLETE

FLOW:
  entry_point: verify
  steps:
    - verify

verify:
  REASONING: false
  CALL: lookup_contract()
  THEN: COMPLETE
`,
      'DefaultErrorStructuredPIIAgent',
    );
    const session = buildSession({
      agentIR,
      currentFlowStep: 'verify',
      toolExecutor: {
        execute: vi.fn().mockRejectedValue(new Error('tool failed')),
      } as RuntimeSession['toolExecutor'],
    });
    const chunks: string[] = [];

    const result = await executor.executeFlowStep(session, '', (chunk: string) => {
      chunks.push(chunk);
    });

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    expect(result.voiceConfig?.plain_text).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.actions?.elements[0]?.label).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
  });

  it('preserves complete-transition structured payloads when returning from a child thread', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: ChildReturnStructuredPIIAgent
GOAL: "Protect child return structured output"

FLOW:
  entry_point: finish
  steps:
    - finish

finish:
  REASONING: false
  RESPOND: "Contract ${rawContractId}"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Open ${rawContractId}" -> open_contract
  THEN: COMPLETE
`,
      'ChildReturnStructuredPIIAgent',
    );
    const session = buildSession({
      agentIR,
      agentName: 'ChildReturnStructuredPIIAgent',
      currentFlowStep: 'finish',
    });
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildReturnStructuredPIIAgent',
      agentIR,
      conversationHistory: [],
      state: session.state,
      data: session.data,
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
      currentFlowStep: 'finish',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    const returnedMessage = parentThread.conversationHistory.at(-1);
    expect(returnedMessage?.contentEnvelope?.richContent?.markdown).toContain('{{PII:ContractID:');
    expect(returnedMessage?.contentEnvelope?.actions?.elements[0]?.label).toContain(
      '{{PII:ContractID:',
    );
    expect(returnedMessage?.contentEnvelope?.richContent?.markdown).not.toContain(rawContractId);
  });

  it('preserves structured-only complete-transition payloads when returning from a child thread', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: ChildReturnStructuredOnlyPIIAgent
GOAL: "Protect child return structured-only output"

FLOW:
  entry_point: finish
  steps:
    - finish

finish:
  REASONING: false
  RESPOND: "Carrier"
    FORMATS:
      MARKDOWN: "Contract ${rawContractId}"
    ACTIONS:
      - BUTTON: "Open ${rawContractId}" -> open_contract
  THEN: COMPLETE
`,
      'ChildReturnStructuredOnlyPIIAgent',
    );
    const finishStep = agentIR.flow?.definitions.finish as { respond?: string };
    delete finishStep.respond;
    const session = buildSession({
      agentIR,
      agentName: 'ChildReturnStructuredOnlyPIIAgent',
      currentFlowStep: 'finish',
    });
    const parentThread: AgentThread = {
      agentName: 'ParentAgent',
      agentIR: null,
      conversationHistory: [],
      state: { gatherProgress: {}, conversationPhase: 'active', context: {} },
      data: { values: {}, gatheredKeys: new Set() },
      startedAt: Date.now(),
      returnExpected: false,
      status: 'waiting',
    };
    const childThread: AgentThread = {
      agentName: 'ChildReturnStructuredOnlyPIIAgent',
      agentIR,
      conversationHistory: [],
      state: session.state,
      data: session.data,
      startedAt: Date.now(),
      returnExpected: true,
      status: 'active',
      currentFlowStep: 'finish',
    };
    session.threads = [parentThread, childThread];
    session.activeThreadIndex = 1;
    session.threadStack = [0];

    const result = await executor.executeFlowStep(session, '');

    expect(result.response).toBe('');
    expect(result.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.richContent?.markdown).not.toContain(rawContractId);
    const returnedMessage = parentThread.conversationHistory.at(-1);
    expect(returnedMessage).toMatchObject({
      role: 'assistant',
      content: '',
      contentEnvelope: {
        richContent: {
          markdown: expect.stringContaining('{{PII:ContractID:'),
        },
        actions: {
          elements: [
            {
              label: expect.stringContaining('{{PII:ContractID:'),
              value: 'open_contract',
            },
          ],
        },
      },
    });
    expect(returnedMessage?.contentEnvelope?.richContent?.markdown).not.toContain(rawContractId);
  });

  it('redacts ACTION_HANDLER authored responses before streaming, history, and result delivery', async () => {
    const executor = buildExecutor();
    const session = buildSession({
      agentIR: compileAgent(
        `
AGENT: ActionHandlerStructuredPIIAgent
GOAL: "Protect action handler output"

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose an option"
    ACTIONS:
      - BUTTON: "Reveal" -> reveal_contract
  ON_ACTION:
    reveal_contract:
      DO:
        - RESPOND: "Contract ${rawContractId}"
          FORMATS:
            MARKDOWN: "Contract ${rawContractId}"
`,
        'ActionHandlerStructuredPIIAgent',
      ),
      currentFlowStep: 'menu',
    });
    const initResult = await executor.executeFlowStep(session, '');
    const actionChunks: string[] = [];

    session.data.values[SESSION_KEY_ACTION_EVENT] = {
      actionId: 'reveal_contract',
      renderId: initResult.actions?.renderId,
    };
    const actionResult = await executor.executeFlowStep(session, '', (chunk: string) => {
      actionChunks.push(chunk);
    });

    expect(actionResult.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(actionResult.response).not.toContain(rawContractId);
    expect(actionResult.richContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(actionResult.richContent?.markdown).not.toContain(rawContractId);
    expect(actionChunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(actionChunks.join('')).not.toContain(rawContractId);
    expect(session.pendingRichContent?.markdown).toContain('[REDACTED_CONTRACT_ID]');
    expect(session.pendingRichContent?.markdown).not.toContain(rawContractId);

    const assistantHistory = session.conversationHistory.filter(
      (entry) => entry.role === 'assistant',
    );
    expect(String(assistantHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(assistantHistory.at(-1)?.content)).not.toContain(rawContractId);
  });

  it('redacts multi-intent disambiguation output before streaming, history, and result delivery', async () => {
    const executor = buildExecutor();
    const agentIR = compileAgent(
      `
AGENT: MultiIntentPIIAgent
GOAL: "Protect multi-intent disambiguation output"

FLOW:
  entry_point: start
  steps:
    - start

start:
  REASONING: false
`,
      'MultiIntentPIIAgent',
    );
    agentIR.intent_handling = {
      multi_intent: {
        enabled: true,
        strategy: 'disambiguate',
        max_intents: 3,
        confidence_threshold: 0.5,
        queue_max_age_ms: 600_000,
      },
    };
    const session = buildSession({
      agentIR,
      agentName: 'MultiIntentPIIAgent',
      currentFlowStep: 'start',
    });
    const executorWithInternals = executor as unknown as {
      detectMultipleIntents: ReturnType<typeof vi.fn>;
      dispatchMultiIntentIfNeeded: ReturnType<typeof vi.fn>;
      executeFlowStep: FlowStepExecutor['executeFlowStep'];
    };
    executorWithInternals.detectMultipleIntents = vi.fn().mockReturnValue({
      primary: { intent: 'billing', confidence: 0.92, source: 'classifier' },
      alternatives: [{ intent: 'shipping', confidence: 0.81, source: 'classifier' }],
      relationships: { type: 'independent' },
    });
    executorWithInternals.dispatchMultiIntentIfNeeded = vi.fn().mockReturnValue({
      strategy: 'disambiguate',
      disambiguationMessage: `Contract ${rawContractId}`,
    });
    const chunks: string[] = [];

    const result = await executorWithInternals.executeFlowStep(session, 'I need help', (chunk) => {
      chunks.push(chunk);
    });

    expect(result.response).toContain('[REDACTED_CONTRACT_ID]');
    expect(result.response).not.toContain(rawContractId);
    expect(chunks.join('')).toContain('[REDACTED_CONTRACT_ID]');
    expect(chunks.join('')).not.toContain(rawContractId);
    const assistantHistory = session.conversationHistory.filter(
      (entry) => entry.role === 'assistant',
    );
    expect(String(assistantHistory.at(-1)?.content)).toContain('{{PII:ContractID:');
    expect(String(assistantHistory.at(-1)?.content)).not.toContain(rawContractId);
  });
});
