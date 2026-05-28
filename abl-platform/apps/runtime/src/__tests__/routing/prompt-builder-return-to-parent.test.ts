/**
 * ABLP-900: __return_to_parent__ topology guard
 *
 * Locks the contract that buildTools does NOT expose
 * `__return_to_parent__` to the root supervisor's tool list, even when
 * the root's active thread transiently carries `returnExpected=true` /
 * `handoffFrom` because of:
 *
 * 1. Google realtime path: buildRealtimeToolDefinitionsForAgent spreads
 *    `...activeThread` (with the child's `returnExpected`/`handoffFrom`)
 *    into the root's temp session.
 * 2. Grok deferred session.update race: after a child returns, the root's
 *    thread briefly inherits the child flags before the session.update
 *    arrives.
 *
 * The structural fix in prompt-builder additionally checks
 * `threadStack.length > 0` (i.e., a real parent frame exists) before
 * surfacing the system tool.
 */

import { beforeAll, describe, test, expect } from 'vitest';
import { SYSTEM_TOOL_RETURN_TO_PARENT } from '@abl/compiler';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { AgentIR } from '@abl/compiler';

type PromptBuilderModule = typeof import('../../services/execution/prompt-builder.js');
type ExecutionTypesModule = typeof import('../../services/execution/types.js');
type RuntimeExecutorModule = typeof import('../../services/runtime-executor.js');

let buildTools: PromptBuilderModule['buildTools'];
let createInitialThread: ExecutionTypesModule['createInitialThread'];
let createThread: ExecutionTypesModule['createThread'];
let compileToResolvedAgent: RuntimeExecutorModule['compileToResolvedAgent'];
let RuntimeExecutor: RuntimeExecutorModule['RuntimeExecutor'];

beforeAll(async () => {
  ({ buildTools } = await import('../../services/execution/prompt-builder.js'));
  ({ createInitialThread, createThread } = await import('../../services/execution/types.js'));
  ({ compileToResolvedAgent, RuntimeExecutor } =
    await import('../../services/runtime-executor.js'));
});

// =============================================================================
// AGENT DSL — minimal two-agent topology (root + child with RETURN: true)
// =============================================================================

const ROOT_SUPERVISOR_DSL = `
SUPERVISOR: CignaRouter

GOAL: "Route users to the right specialist"

PERSONA: "Helpful insurance routing supervisor"

HANDOFF:
  - TO: CAIAuth_Specialist
    WHEN: intent.category == "authentication"
    RETURN: true
`;

const CHILD_AGENT_DSL = `
AGENT: CAIAuth_Specialist

GOAL: "Handle authentication flows"

PERSONA: "Authentication specialist"
`;

// =============================================================================
// HELPERS
// =============================================================================

function makeIR(name: string): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name,
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 1800000,
      },
    },
    identity: {
      goal: 'Help user',
      persona: '',
      limitations: [],
      system_prompt: { template: '', sections: {} },
    },
    tools: [],
    gather: { fields: [], strategy: 'llm' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], escalation: undefined },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: { type: 'default', then: 'continue' },
    },
  } as AgentIR;
}

function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'test-session-ablp-900',
    agentName: 'CignaRouter',
    agentIR: makeIR('CignaRouter'),
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    delegateStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  } as RuntimeSession;
}

// =============================================================================
// TESTS
// =============================================================================

describe('ABLP-900: buildTools threadStack guard for __return_to_parent__', () => {
  test('excludes __return_to_parent__ for root agent even when thread state has returnExpected=true', () => {
    // Simulates the state produced by buildRealtimeToolDefinitionsForAgent
    // (realtime-tool-definitions.ts:34-57), which spreads ...activeThread
    // (the child's thread with returnExpected=true) into the root's temp
    // session. Root's threadStack stays empty so the topology guard must
    // win.
    const session = makeSession();
    createInitialThread(session);

    session.threads[0].returnExpected = true;
    session.threads[0].handoffFrom = 'SomeParent';
    session.threads[0].status = 'active';
    session.activeThreadIndex = 0;
    // Critically: threadStack is EMPTY — root has no parent to return to.
    session.threadStack = [];

    const tools = buildTools(session);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).not.toContain(SYSTEM_TOOL_RETURN_TO_PARENT);
  });

  test('includes __return_to_parent__ for legitimate child agent with parent on stack', () => {
    // Inverse — a real child agent WITH a parent on the threadStack should
    // still receive the system tool.
    const session = makeSession();
    createInitialThread(session);
    session.threads[0].agentName = 'CignaRouter';
    session.threads[0].status = 'waiting';

    session.threadStack.push(0);
    const childIR = makeIR('CAIAuth_Specialist');
    const childThread = createThread(session, 'CAIAuth_Specialist', childIR, {
      handoffFrom: 'CignaRouter',
      returnExpected: true,
    });
    session.activeThreadIndex = session.threads.indexOf(childThread);
    session.agentName = 'CAIAuth_Specialist';
    session.agentIR = childIR;

    const tools = buildTools(session);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).toContain(SYSTEM_TOOL_RETURN_TO_PARENT);
  });

  test('compiled topology: root agent tool list does not contain __return_to_parent__ at compile time', () => {
    // Real compiler + RuntimeExecutor.createSessionFromResolved — root at
    // initial session creation should never have __return_to_parent__.
    const executor = new RuntimeExecutor();
    const resolved = compileToResolvedAgent([ROOT_SUPERVISOR_DSL, CHILD_AGENT_DSL], 'CignaRouter');
    const session = executor.createSessionFromResolved(resolved);

    const tools = buildTools(session);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).not.toContain(SYSTEM_TOOL_RETURN_TO_PARENT);
  });

  test('compiled topology: root agent tool list does not contain __return_to_parent__ after child returns', () => {
    // Lifecycle: root -> child handoff -> child returns -> root resumes.
    // After the child returns, the root is active again with threadStack
    // empty, but the child thread frame may still be present.
    const executor = new RuntimeExecutor();
    const rootResolved = compileToResolvedAgent(
      [ROOT_SUPERVISOR_DSL, CHILD_AGENT_DSL],
      'CignaRouter',
    );
    const childResolved = compileToResolvedAgent(
      [ROOT_SUPERVISOR_DSL, CHILD_AGENT_DSL],
      'CAIAuth_Specialist',
    );
    const session = executor.createSessionFromResolved(rootResolved);

    // Simulate handoff
    session.threads[0].status = 'waiting';
    session.threadStack = [0];
    session.handoffStack = ['CignaRouter'];

    const childSession = executor.createSessionFromResolved(childResolved);
    const childThread = childSession.threads[0];
    childThread.returnExpected = true;
    childThread.handoffFrom = 'CignaRouter';
    childThread.status = 'active';
    session.threads.push(childThread);
    session.activeThreadIndex = 1;
    session.agentName = 'CAIAuth_Specialist';
    session.agentIR = childSession.agentIR;

    // Simulate return
    session.threadStack = [];
    session.handoffStack = [];
    session.activeThreadIndex = 0;
    session.threads[0].status = 'active';
    session.threads[1].status = 'completed';
    session.agentName = 'CignaRouter';
    session.agentIR = rootResolved.ir;

    const tools = buildTools(session);
    const toolNames = tools.map((t) => t.name);

    expect(toolNames).not.toContain(SYSTEM_TOOL_RETURN_TO_PARENT);
  });
});
