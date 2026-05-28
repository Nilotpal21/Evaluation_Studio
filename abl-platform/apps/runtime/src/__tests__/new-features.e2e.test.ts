/**
 * E2E: Multi-step flow with new executor unification features
 *
 * Exercises a realistic Account Balance Lookup agent workflow using:
 * - ON_START SET for session variable initialization
 * - GATHER for multi-turn user input collection
 * - CALL WITH/AS for tool invocation with explicit params and result binding
 * - ON_RESULT for multi-way branching on tool response (200, 401, ELSE)
 * - TRANSFORM (FILTER, MAP, SORT_BY DESC, LIMIT) for array pipeline processing
 * - CHECK / ON_FAIL for conditional guard with fallback step
 * - Trace event verification across the full lifecycle
 *
 * Flow: welcome -> collect_account -> fetch -> transform -> display | no_accounts
 *
 * The TRANSFORM source must be a flat key in session.data.values (since the
 * runtime does `session.data.values[source]`). Because SET in ON_RESULT cannot
 * dereference nested paths like apiResult.accounts, the tool executor mock
 * injects the accounts array into session.data.values.accountsList alongside
 * the CALL AS binding. This is a pragmatic test-only bridge that exercises
 * all pipeline stages end-to-end.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../services/runtime-executor';

// ---------------------------------------------------------------------------
// DSL: Account Balance Lookup Agent
// ---------------------------------------------------------------------------

const AGENT_DSL = `
AGENT: AccountBalanceLookup

GOAL: "Look up account balances for a customer"

ON_START:
  set: retries = 0
  set: maxRetries = 3

TOOLS:
  get_accounts(accountId: string, usecase: string) -> object
    description: "Fetch accounts from the banking API"

FLOW:
  welcome -> collect_account -> fetch -> transform -> display -> no_accounts

  welcome:
    REASONING: false
    RESPOND: "Welcome! Please provide your account number."
    THEN: collect_account

  collect_account:
    REASONING: false
    GATHER:
      - account_number: required
    THEN: fetch

  fetch:
    REASONING: false
    CALL: get_accounts
      WITH:
        accountId: account_number
        usecase: "balance"
      AS: apiResult
    ON_RESULT:
      REASONING: false
      - IF: apiResult.statusCode == 200
        THEN: transform
      - IF: apiResult.statusCode == 401
        RESPOND: "Session expired. Please log in again."
        THEN: COMPLETE
      - ELSE:
        RESPOND: "Error fetching accounts. Please try again later."
        THEN: COMPLETE

  transform:
    TRANSFORM: accountsList AS acct INTO displayAccounts
      FILTER: acct.active == true
      MAP:
        name: acct.name
        balance: acct.balance
      SORT_BY: balance DESC
      LIMIT: 5
    THEN: display

  display:
    REASONING: false
    CHECK: displayAccounts.length > 0
    ON_FAIL: no_accounts
    RESPOND: "Here are your top accounts."
    THEN: COMPLETE

  no_accounts:
    REASONING: false
    RESPOND: "No active accounts found."
    THEN: COMPLETE
`;

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const ACCOUNTS_FIXTURE = [
  { name: 'Checking', balance: 5000, active: true },
  { name: 'Savings', balance: 25000, active: true },
  { name: 'Closed CD', balance: 0, active: false },
  { name: 'Money Market', balance: 15000, active: true },
  { name: 'Investment', balance: 50000, active: true },
];

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSession(executor: RuntimeExecutor, toolResponse: Record<string, unknown>) {
  const session = executor.createSessionFromResolved(
    compileToResolvedAgent([AGENT_DSL], 'AccountBalanceLookup'),
  );

  let capturedToolName: string | undefined;
  let capturedToolArgs: Record<string, unknown> | undefined;

  session.toolExecutor = {
    execute: async (name: string, args: Record<string, unknown>) => {
      capturedToolName = name;
      capturedToolArgs = args;
      // Inject accounts array as a flat key so TRANSFORM can access it.
      if (Array.isArray((toolResponse as any).accounts)) {
        session.data.values.accountsList = (toolResponse as any).accounts;
      }
      return toolResponse;
    },
  } as any;

  return {
    session,
    getCapturedTool: () => ({ name: capturedToolName, args: capturedToolArgs }),
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe('E2E: Account Balance Lookup — multi-step flow with new features', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // =========================================================================
  // 1. Happy path: full lifecycle
  // =========================================================================

  test('happy path: welcome -> collect -> fetch -> transform -> display -> complete', async () => {
    const { session, getCapturedTool } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    // -- Initialize: ON_START runs, welcome step outputs, GATHER waits --
    const initChunks: string[] = [];
    await executor.initializeSession(session.id, (c) => initChunks.push(c));

    const initOutput = initChunks.join('');
    expect(initOutput).toContain('Welcome');
    expect(initOutput).toContain('account number');
    expect(session.currentFlowStep).toBe('collect_account');
    expect(session.data.values.retries).toBe(0);
    expect(session.data.values.maxRetries).toBe(3);

    // -- User message: provide account number --
    // Auto-advances through fetch -> ON_RESULT(200) -> transform -> display
    const msgChunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-12345', (c) => msgChunks.push(c));

    const msgOutput = msgChunks.join('');

    // GATHER collected the value
    expect(session.data.values.account_number).toBe('ACC-12345');

    // CALL WITH resolved params and invoked tool
    const tool = getCapturedTool();
    expect(tool.name).toBe('get_accounts');
    expect(tool.args!.accountId).toBe('ACC-12345');
    expect(tool.args!.usecase).toBe('balance');

    // CALL AS bound the full result
    expect(session.data.values.apiResult).toBeDefined();
    expect((session.data.values.apiResult as any).statusCode).toBe(200);

    // TRANSFORM produced displayAccounts
    const displayAccounts = session.data.values.displayAccounts as Array<Record<string, unknown>>;
    expect(displayAccounts).toBeDefined();
    expect(Array.isArray(displayAccounts)).toBe(true);

    // Display step responded
    expect(msgOutput).toContain('Here are your top accounts');

    // Session completed
    expect(session.isComplete).toBe(true);
  });

  // =========================================================================
  // 2. Error path: 401 -> "Session expired"
  // =========================================================================

  test('error path: 401 -> session expired message and complete', async () => {
    const { session } = createSession(executor, {
      statusCode: 401,
      error: 'Unauthorized',
    });

    await executor.initializeSession(session.id);
    expect(session.currentFlowStep).toBe('collect_account');

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-99999', (c) => chunks.push(c));

    expect(chunks.join('')).toContain('Session expired');
    expect(session.isComplete).toBe(true);
  });

  // =========================================================================
  // 3. Error path: 500 -> ELSE branch
  // =========================================================================

  test('error path: 500 -> generic error message and complete', async () => {
    const { session } = createSession(executor, {
      statusCode: 500,
      error: 'Internal Server Error',
    });

    await executor.initializeSession(session.id);

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-55555', (c) => chunks.push(c));

    expect(chunks.join('')).toContain('Error fetching accounts');
    expect(session.isComplete).toBe(true);
  });

  // =========================================================================
  // 4. ELSE branch with an unexpected status code (503)
  // =========================================================================

  test('error path: 503 hits ELSE branch (neither 200 nor 401)', async () => {
    const { session } = createSession(executor, {
      statusCode: 503,
      error: 'Service Unavailable',
    });

    await executor.initializeSession(session.id);

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-77777', (c) => chunks.push(c));

    expect(chunks.join('')).toContain('Error fetching accounts');
    expect(session.isComplete).toBe(true);
  });

  // =========================================================================
  // 5. TRANSFORM filters out inactive accounts
  // =========================================================================

  test('TRANSFORM FILTER removes inactive accounts', async () => {
    const { session } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'ACC-12345');

    const displayAccounts = session.data.values.displayAccounts as Array<Record<string, unknown>>;
    expect(displayAccounts).toBeDefined();

    // Closed CD (active: false) must be absent
    expect(displayAccounts.find((a) => a.name === 'Closed CD')).toBeUndefined();

    // All active accounts must be present
    const names = displayAccounts.map((a) => a.name);
    expect(names).toContain('Checking');
    expect(names).toContain('Savings');
    expect(names).toContain('Money Market');
    expect(names).toContain('Investment');
  });

  // =========================================================================
  // 6. TRANSFORM sorts by balance DESC and respects LIMIT
  // =========================================================================

  test('TRANSFORM SORT_BY balance DESC and LIMIT 5', async () => {
    const { session } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'ACC-12345');

    const displayAccounts = session.data.values.displayAccounts as Array<Record<string, unknown>>;
    expect(displayAccounts).toBeDefined();
    expect(displayAccounts.length).toBeGreaterThan(0);
    expect(displayAccounts.length).toBeLessThanOrEqual(5);

    // Sorted descending
    for (let i = 1; i < displayAccounts.length; i++) {
      expect(Number(displayAccounts[i - 1].balance)).toBeGreaterThanOrEqual(
        Number(displayAccounts[i].balance),
      );
    }

    // Highest-balance account first
    expect(displayAccounts[0].name).toBe('Investment');
    expect(displayAccounts[0].balance).toBe(50000);
  });

  // =========================================================================
  // 7. TRANSFORM MAP produces correct field shape
  // =========================================================================

  test('TRANSFORM MAP produces {name, balance} only (no active field)', async () => {
    const { session } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'ACC-12345');

    const displayAccounts = session.data.values.displayAccounts as Array<Record<string, unknown>>;
    expect(displayAccounts).toBeDefined();

    for (const acct of displayAccounts) {
      expect(acct).toHaveProperty('name');
      expect(acct).toHaveProperty('balance');
      expect(acct).not.toHaveProperty('active');
    }
  });

  // =========================================================================
  // 8. CHECK fails with empty results -> no_accounts fallback
  // =========================================================================

  test('CHECK fails when all accounts inactive -> no_accounts step', async () => {
    const allInactive = [
      { name: 'Closed A', balance: 0, active: false },
      { name: 'Closed B', balance: 100, active: false },
    ];

    const { session } = createSession(executor, {
      statusCode: 200,
      accounts: allInactive,
    });

    await executor.initializeSession(session.id);

    const chunks: string[] = [];
    await executor.executeMessage(session.id, 'ACC-00000', (c) => chunks.push(c));

    expect(chunks.join('')).toContain('No active accounts found');
    expect(session.isComplete).toBe(true);
  });

  // =========================================================================
  // 9. ON_START SET initializes session variables
  // =========================================================================

  test('ON_START SET initializes retries=0 and maxRetries=3', async () => {
    const { session } = createSession(executor, { statusCode: 200, accounts: [] });

    await executor.initializeSession(session.id);

    expect(session.data.values.retries).toBe(0);
    expect(session.data.values.maxRetries).toBe(3);
  });

  // =========================================================================
  // 10. CALL WITH resolves gathered data as tool parameters
  // =========================================================================

  test('CALL WITH resolves account_number from GATHER and literal "balance"', async () => {
    const { session, getCapturedTool } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'MY-ACCT-789');

    const tool = getCapturedTool();
    expect(tool.name).toBe('get_accounts');
    expect(tool.args!.accountId).toBe('MY-ACCT-789');
    expect(tool.args!.usecase).toBe('balance');
  });

  // =========================================================================
  // 11. CALL AS binds full result (no flat-spread)
  // =========================================================================

  test('CALL AS binds full result to apiResult without flat-spreading', async () => {
    const payload = {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
      metadata: { requestId: 'req-123' },
    };

    const { session } = createSession(executor, payload);

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'ACC-12345');

    const apiResult = session.data.values.apiResult as Record<string, unknown>;
    expect(apiResult).toBeDefined();
    expect(apiResult.statusCode).toBe(200);
    expect(apiResult.metadata).toEqual({ requestId: 'req-123' });

    // metadata should NOT leak to top-level session values
    expect(session.data.values.metadata).toBeUndefined();
  });

  // =========================================================================
  // 12. Conversation history integrity across turns
  // =========================================================================

  test('conversation history tracks init and user message turns', async () => {
    const { session } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    await executor.initializeSession(session.id);
    await executor.executeMessage(session.id, 'ACC-12345');

    const userMessages = session.conversationHistory.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(1);

    const assistantMessages = session.conversationHistory.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // No empty messages
    for (const msg of session.conversationHistory) {
      expect(msg.content.length).toBeGreaterThan(0);
    }
  });

  // =========================================================================
  // 13. Trace events: dsl_set, flow_step_enter, dsl_call, dsl_transform,
  //     flow_transition across the full happy-path flow
  // =========================================================================

  test('trace events cover ON_START, steps, CALL, TRANSFORM, and transitions', async () => {
    const { session } = createSession(executor, {
      statusCode: 200,
      accounts: ACCOUNTS_FIXTURE,
    });

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const collect = (evt: { type: string; data: Record<string, unknown> }) => traces.push(evt);

    await executor.initializeSession(session.id, undefined, collect);
    await executor.executeMessage(session.id, 'ACC-12345', undefined, collect);

    // dsl_set from ON_START (retries, maxRetries)
    const setEvents = traces.filter((t) => t.type === 'dsl_set');
    expect(setEvents.length).toBeGreaterThanOrEqual(2);

    // flow_step_enter for welcome, collect_account, fetch
    const stepEnters = traces.filter((t) => t.type === 'flow_step_enter');
    const enteredSteps = stepEnters.map((t) => t.data.stepName);
    expect(enteredSteps).toContain('welcome');
    expect(enteredSteps).toContain('collect_account');
    expect(enteredSteps).toContain('fetch');

    // dsl_call with source: 'call_with'
    const callEvents = traces.filter((t) => t.type === 'dsl_call');
    const accountsCall = callEvents.find((e) => e.data.toolName === 'get_accounts');
    expect(accountsCall).toBeDefined();
    expect(accountsCall!.data.source).toBe('call_with');

    // flow_transition events
    const transitions = traces.filter((t) => t.type === 'flow_transition');
    expect(transitions.length).toBeGreaterThanOrEqual(1);

    // dsl_transform with correct counts
    const transformEvents = traces.filter((t) => t.type === 'dsl_transform');
    expect(transformEvents.length).toBeGreaterThanOrEqual(1);
    const te = transformEvents[0];
    expect(te.data.source).toBe('accountsList');
    expect(te.data.target).toBe('displayAccounts');
    expect(te.data.inputCount).toBe(5);
    expect(te.data.outputCount).toBe(4); // 1 inactive filtered out
  });

  // =========================================================================
  // 14. Trace events for ON_RESULT branch (401 path)
  // =========================================================================

  test('401 path emits flow_step_exit with on_result_branch for fetch', async () => {
    const { session } = createSession(executor, {
      statusCode: 401,
      error: 'Unauthorized',
    });

    const traces: Array<{ type: string; data: Record<string, unknown> }> = [];
    const collect = (evt: { type: string; data: Record<string, unknown> }) => traces.push(evt);

    await executor.initializeSession(session.id, undefined, collect);
    await executor.executeMessage(session.id, 'ACC-99999', undefined, collect);

    const fetchExit = traces.find(
      (t) =>
        t.type === 'flow_step_exit' &&
        t.data.stepName === 'fetch' &&
        t.data.result === 'on_result_branch',
    );
    expect(fetchExit).toBeDefined();
    expect(fetchExit!.data.agentName).toBe('AccountBalanceLookup');
  });
});
