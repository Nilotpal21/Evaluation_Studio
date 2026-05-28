import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isGatherInterruptTrace, type GatherInterruptTrace } from '@agent-platform/shared-kernel';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor.js';
import { createThread } from '../../services/execution/types.js';

const DIGRESSION_TRACE_AGENT = `
AGENT: DigressionTraceConsistency

GOAL: "Collect the user's request"

FLOW:
  entry_point: collect_request
  steps:
    - collect_request

collect_request:
  REASONING: false
  GATHER:
    - request: required
  DIGRESSIONS:
    - INTENT: branch_locator
      KEYWORDS: [branch]
      RESPOND: "I can help find branches nearby."
      RESUME: true
  THEN: COMPLETE
`;

const SUB_INTENT_TRACE_AGENT = `
AGENT: SubIntentTraceConsistency

GOAL: "Collect the user's destination"

FLOW:
  entry_point: collect_destination
  steps:
    - collect_destination

collect_destination:
  REASONING: false
  GATHER:
    - destination: required
  SUB_INTENTS:
    - INTENT: "change destination"
      CLEAR: [destination]
      RESPOND: "What's the new destination?"
  THEN: COMPLETE
`;

const LOCATION_ROUTING_SUPERVISOR = `
SUPERVISOR: OceanFirstSupervisor

GOAL: "Route banking requests during authentication"

PERSONA: "Ocean First routing supervisor"

INTENTS:
  auth: "Authentication and phone ID verification"
  atm_locator: "Users asking for ATM or branch locations"
  branch_locator: "Users asking for branch locations"

HANDOFF:
  - TO: AuthenticationFlowChild
    WHEN: intent.category == "auth"
    RETURN: true

  - TO: BranchLocatorChild
    WHEN: intent.category == "atm_locator" || intent.category == "branch_locator"
    RETURN: true
`;

const AUTHENTICATION_FLOW_CHILD = `
AGENT: AuthenticationFlowChild

GOAL: "Collect the caller phone ID"

FLOW:
  entry_point: ask_phone_id
  steps:
    - ask_phone_id

ask_phone_id:
  REASONING: false
  GATHER:
    - phone_id: required
  THEN: COMPLETE
`;

const BRANCH_LOCATOR_CHILD = `
AGENT: BranchLocatorChild

GOAL: "Help find nearby ATMs and branches"

FLOW:
  entry_point: respond_location
  steps:
    - respond_location

respond_location:
  REASONING: false
  RESPOND: "I can help locate nearby ATMs and branches."
  THEN: COMPLETE
`;

function createTraceCollector(): {
  traces: Array<{ type: string; data: Record<string, unknown> }>;
  callback: (event: { type: string; data: Record<string, unknown> }) => void;
} {
  const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    traces,
    callback: (event) => traces.push(event),
  };
}

function extractGatherInterruptTrace(data: Record<string, unknown>): GatherInterruptTrace {
  return {
    detectionMode: data.detectionMode as GatherInterruptTrace['detectionMode'],
    candidateSurface: data.candidateSurface as GatherInterruptTrace['candidateSurface'],
    ...(typeof data.lexicalMatchType === 'string'
      ? {
          lexicalMatchType: data.lexicalMatchType as GatherInterruptTrace['lexicalMatchType'],
        }
      : {}),
    ...(typeof data.policyApplied === 'string'
      ? { policyApplied: data.policyApplied as GatherInterruptTrace['policyApplied'] }
      : {}),
    ...(typeof data.classifierConfidence === 'number'
      ? { classifierConfidence: data.classifierConfidence }
      : {}),
  };
}

describe('flow-step executor gather trace consistency', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  afterEach(() => {
    executor.stopStaleReaper();
  });

  it('emits the canonical gather-interrupt trace payload for digressions', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([DIGRESSION_TRACE_AGENT], 'DigressionTraceConsistency'),
    );
    await executor.initializeSession(session.id);

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'show me nearby branches',
      undefined,
      traceCollector.callback,
    );

    const digressionTrace = traceCollector.traces.find((event) => event.type === 'digression');
    expect(digressionTrace).toBeDefined();

    const gatherTrace = extractGatherInterruptTrace(digressionTrace!.data);
    expect(isGatherInterruptTrace(gatherTrace)).toBe(true);
    expect(gatherTrace).toMatchObject({
      detectionMode: 'lexical',
      lexicalMatchType: 'normalized',
      policyApplied: 'when_unavailable',
      candidateSurface: {
        kind: 'digression',
        size: 1,
        candidates: ['branch_locator'],
      },
    });
  });

  it('emits the canonical gather-interrupt trace payload for sub-intents', async () => {
    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([SUB_INTENT_TRACE_AGENT], 'SubIntentTraceConsistency'),
    );
    await executor.initializeSession(session.id);
    session.data.values.destination = 'Paris';

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'change destination please',
      undefined,
      traceCollector.callback,
    );

    const subIntentTrace = traceCollector.traces.find((event) => event.type === 'sub_intent');
    expect(subIntentTrace).toBeDefined();

    const gatherTrace = extractGatherInterruptTrace(subIntentTrace!.data);
    expect(isGatherInterruptTrace(gatherTrace)).toBe(true);
    expect(gatherTrace).toMatchObject({
      detectionMode: 'lexical',
      lexicalMatchType: 'exact',
      policyApplied: 'when_unavailable',
      candidateSurface: {
        kind: 'sub_intent',
        size: 1,
        candidates: ['"change destination"'],
      },
    });
  });

  it('emits the canonical gather-interrupt trace payload for parent supervisor reroutes', async () => {
    const resolved = compileToResolvedAgent(
      [LOCATION_ROUTING_SUPERVISOR, AUTHENTICATION_FLOW_CHILD, BRANCH_LOCATOR_CHILD],
      'OceanFirstSupervisor',
    );
    const session = executor.createSessionFromResolved(resolved, {
      tenantId: 'tenant-1',
      projectId: 'project-1',
    });
    const childAgentIR = resolved.agents.AuthenticationFlowChild ?? null;
    const parentThread = session.threads[0];
    parentThread.status = 'waiting';
    parentThread.conversationHistory.push({ role: 'user', content: 'check my balance' });

    const childThread = createThread(session, 'AuthenticationFlowChild', childAgentIR, {
      handoffFrom: 'OceanFirstSupervisor',
      returnExpected: true,
    });
    childThread.currentFlowStep = 'ask_phone_id';
    childThread.waitingForInput = ['phone_id'];
    childThread.status = 'active';

    session.handoffReturnInfo = { AuthenticationFlowChild: true, BranchLocatorChild: true };
    session.activeThreadIndex = 1;
    session.threadStack = [0];
    session.agentName = 'AuthenticationFlowChild';
    session.agentIR = childAgentIR;
    session.currentFlowStep = 'ask_phone_id';
    session.waitingForInput = ['phone_id'];

    const traceCollector = createTraceCollector();
    const result = await (
      executor as unknown as {
        flowStep: {
          executeFlowStep: (
            runtimeSession: ReturnType<RuntimeExecutor['createSessionFromResolved']>,
            userMessage: string,
            onChunk?: (chunk: string) => void,
            onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void,
          ) => Promise<{ action?: { type?: string; target?: string } }>;
        };
      }
    ).flowStep.executeFlowStep(session, 'get atms near me', undefined, traceCollector.callback);

    expect(result.action?.type).toBe('return_to_parent');

    const digressionTrace = traceCollector.traces.find(
      (event) =>
        event.type === 'digression' &&
        event.data.action === 'return_to_parent' &&
        event.data.target === 'BranchLocatorChild',
    );
    expect(digressionTrace).toBeDefined();

    const gatherTrace = extractGatherInterruptTrace(digressionTrace!.data);
    expect(isGatherInterruptTrace(gatherTrace)).toBe(true);
    expect(gatherTrace).toMatchObject({
      detectionMode: 'lexical',
      lexicalMatchType: 'normalized',
      policyApplied: 'when_unavailable',
      candidateSurface: {
        kind: 'parent_supervisor_route',
        size: 3,
        candidates: ['auth', 'atm_locator', 'branch_locator'],
      },
    });
  });
});
