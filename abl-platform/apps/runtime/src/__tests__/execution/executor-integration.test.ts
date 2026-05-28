/**
 * Executor Integration Tests
 *
 * End-to-end tests that verify interactions between multiple executor features
 * working together in a single flow. Each test exercises a complete flow path
 * through FlowStepExecutor with multiple features chained:
 *
 * - CALL WITH / AS parameter resolution + ON_RESULT branching + SET + RESPOND
 * - CALL -> ON_RESULT -> TRANSFORM -> RESPOND pipeline
 * - Multi-step flow: SET -> CHECK -> CALL WITH -> ON_RESULT
 * - CALL AS + ON_RESULT with nested condition evaluation (three scenarios)
 * - TRANSFORM with FILTER using session context variables
 * - Loop-back retry pattern via ON_RESULT
 * - ON_RESULT fallthrough to ON_SUCCESS / ON_FAILURE
 * - Reasoning agent: tool call -> store result -> final response references result
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../services/runtime-executor';

// =============================================================================
// MOCK LLM CLIENT (for reasoning mode tests)
// =============================================================================

class MockAnthropicClient {
  calls: Array<{
    systemPrompt: string;
    messages: Array<{ role: string; content: unknown }>;
    tools: unknown[];
  }> = [];
  private responseHandler: (
    systemPrompt: string,
    messages: any[],
    tools: any[],
  ) => {
    text: string;
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    stopReason: string;
    rawContent: Array<{ type: string; [key: string]: unknown }>;
  };

  constructor() {
    this.responseHandler = () => ({
      text: 'Default response.',
      toolCalls: [],
      stopReason: 'end_turn',
      rawContent: [{ type: 'text', text: 'Default response.' }],
    });
  }

  setResponseHandler(handler: typeof this.responseHandler) {
    this.responseHandler = handler;
  }

  async chatWithToolUse(systemPrompt: string, messages: any[], tools: any[]) {
    this.calls.push({ systemPrompt, messages, tools });
    return this.responseHandler(systemPrompt, messages, tools);
  }

  async chatWithToolUseStreamable(
    systemPrompt: string,
    messages: any[],
    tools: any[],
    _operationType?: string,
    _onChunk?: (chunk: string) => void,
  ) {
    return this.chatWithToolUse(systemPrompt, messages, tools);
  }
}

function injectMockClient(executor: RuntimeExecutor): MockAnthropicClient {
  const mock = new MockAnthropicClient();
  (executor as any).llmWiring.wireLLMClient = async (session: any) => {
    session.llmClient = mock;
  };
  (executor as any).llmWiring.ensureSessionLLMClient = async (session: any) => {
    if (!session.llmClient) session.llmClient = mock;
  };
  return mock;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Executor Integration Tests', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // 1. CALL WITH -> ON_RESULT -> SET -> RESPOND chain
  // ===========================================================================

  test('CALL WITH -> ON_RESULT -> SET -> RESPOND chain', async () => {
    const dsl = `
AGENT: ChainTest

GOAL: "Test CALL WITH -> ON_RESULT -> SET -> RESPOND chain"

TOOLS:
  lookup_user(user_id: string, tier: string) -> object
    description: "Look up a user by ID and tier"

FLOW:
  start -> lookup -> found -> not_found

  start:
    REASONING: false
    RESPOND: "Starting lookup..."
    THEN: lookup

  lookup:
    REASONING: false
    CALL: lookup_user
      WITH:
        user_id: currentUserId
        tier: "premium"
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.found == true
        SET: greeting = Welcome back, {{result.name}}!
        THEN: found
      - ELSE:
        SET: greeting = User not found
        THEN: not_found

  found:
    REASONING: false
    RESPOND: "{{greeting}}"
    THEN: COMPLETE

  not_found:
    REASONING: false
    RESPOND: "{{greeting}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'ChainTest'));
    session.data.values.currentUserId = 'u-123';

    let capturedArgs: Record<string, unknown> | undefined;
    session.toolExecutor = {
      execute: async (_name: string, args: Record<string, unknown>) => {
        capturedArgs = args;
        return { found: true, name: 'Alice' };
      },
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // Verify params resolved from session context
    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.user_id).toBe('u-123');
    expect(capturedArgs!.tier).toBe('premium');

    // Verify ON_RESULT branching: found == true -> found step
    // Verify SET applied correctly with template interpolation
    expect(session.data.values.greeting).toBe('Welcome back, Alice!');

    // Verify the full chain rendered the RESPOND
    expect(output).toContain('Welcome back, Alice!');
    expect(output).not.toContain('User not found');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 2. CALL -> ON_RESULT -> TRANSFORM -> RESPOND pipeline
  // ===========================================================================

  test('CALL -> ON_RESULT -> TRANSFORM -> RESPOND pipeline', async () => {
    // CALL returns items at top level (no AS binding).
    // ON_RESULT branches based on count > 0.
    // TRANSFORM step filters/maps/sorts/limits the items array.
    // Display step renders the count from the transformed array.
    const dsl = `
AGENT: PipelineTest

GOAL: "Test CALL -> ON_RESULT -> TRANSFORM -> RESPOND pipeline"

TOOLS:
  search_items() -> object
    description: "Search for items"

FLOW:
  start -> search -> transform_step -> display -> empty

  start:
    REASONING: false
    RESPOND: "Searching..."
    THEN: search

  search:
    REASONING: false
    CALL: search_items()
    ON_RESULT:
      REASONING: false
      - IF: count > 0
        THEN: transform_step
      - ELSE:
        THEN: empty

  transform_step:
    REASONING: false
    TRANSFORM: items AS item INTO top_items
      FILTER: item.rating > 3
      MAP:
        name: item.title
        score: item.rating
      SORT_BY: score DESC
      LIMIT: 2
    THEN: display

  display:
    REASONING: false
    RESPOND: "Top items: {{top_items.length}} found"
    THEN: COMPLETE

  empty:
    REASONING: false
    RESPOND: "No items found"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'PipelineTest'),
    );

    session.toolExecutor = {
      execute: async () => ({
        count: 5,
        items: [
          { title: 'Alpha', rating: 5 },
          { title: 'Bravo', rating: 2 },
          { title: 'Charlie', rating: 4 },
          { title: 'Delta', rating: 1 },
          { title: 'Echo', rating: 4 },
        ],
      }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // Without AS, the tool result is flat-spread into session.data.values
    // so items, count are top-level keys
    expect(session.data.values.count).toBe(5);
    expect(session.data.values.items).toBeDefined();

    // ON_RESULT: count > 0 matched -> transform_step
    // TRANSFORM: items filtered (rating > 3), mapped (name/score), sorted DESC, limited to 2
    const topItems = session.data.values.top_items as Array<Record<string, unknown>>;
    expect(topItems).toBeDefined();
    expect(topItems).toHaveLength(2);
    // After filter: Alpha(5), Charlie(4), Echo(4) — 3 items with rating > 3
    // After sort DESC by score: Alpha(5), Charlie(4), Echo(4) — or Charlie/Echo tie
    // After limit 2: first two
    expect(topItems[0].score).toBe(5);
    expect(topItems[0].name).toBe('Alpha');
    expect([4, 5]).toContain(topItems[1].score); // second is one of the 4-rated items

    // Display step renders the count
    expect(output).toContain('Top items: 2 found');
    expect(output).not.toContain('No items found');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 3. Multi-step flow with ON_START SET -> CHECK -> CALL WITH -> ON_RESULT
  // ===========================================================================

  test('ON_START SET -> CHECK -> CALL WITH -> ON_RESULT multi-step flow', async () => {
    const dsl = `
AGENT: MultiStepTest

GOAL: "Test multi-step flow with ON_START SET, CHECK, CALL WITH, ON_RESULT"

ON_START:
  set: retries = 0

TOOLS:
  fetch_data(query: string) -> object
    description: "Fetch data with query"

FLOW:
  start -> fetch -> success -> error_step

  start:
    REASONING: false
    CHECK: retries < 5
    RESPOND: "Attempt {{retries}}"
    THEN: fetch

  fetch:
    REASONING: false
    CALL: fetch_data
      WITH:
        query: "test-query"
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.status == 200
        THEN: success
      - ELSE:
        THEN: error_step

  success:
    REASONING: false
    RESPOND: "Done in {{retries}} retries"
    THEN: COMPLETE

  error_step:
    REASONING: false
    RESPOND: "Error occurred"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'MultiStepTest'),
    );

    session.toolExecutor = {
      execute: async () => ({ status: 200, data: 'ok' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // ON_START set retries = 0
    expect(session.data.values.retries).toBe(0);

    // CHECK retries < 5 should pass (retries is 0)
    expect(output).toContain('Attempt 0');

    // CALL -> ON_RESULT: status == 200 -> success
    expect(output).toContain('Done in 0 retries');
    expect(output).not.toContain('Error occurred');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 4. CALL AS + ON_RESULT with nested condition evaluation (three scenarios)
  // ===========================================================================

  describe('CALL AS + ON_RESULT with nested condition evaluation', () => {
    const dsl = `
AGENT: NestedCondTest

GOAL: "Test ON_RESULT with nested conditions"

TOOLS:
  api_query() -> object
    description: "Query the API"

FLOW:
  start -> query -> found -> error_step -> empty

  start:
    REASONING: false
    RESPOND: "Querying..."
    THEN: query

  query:
    REASONING: false
    CALL: api_query()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.data.count > 0
        THEN: found
      - IF: result.error != undefined
        THEN: error_step
      - ELSE:
        THEN: empty

  found:
    REASONING: false
    RESPOND: "Found {{result.data.count}} items"
    THEN: COMPLETE

  error_step:
    REASONING: false
    RESPOND: "Error: {{result.error}}"
    THEN: COMPLETE

  empty:
    REASONING: false
    RESPOND: "No results"
    THEN: COMPLETE
`;

    test('scenario (a): {data: {count: 5}} -> found step', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'NestedCondTest'),
      );
      session.toolExecutor = {
        execute: async () => ({ data: { count: 5 }, error: undefined }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Found 5 items');
      expect(output).not.toContain('Error:');
      expect(output).not.toContain('No results');
      expect(session.isComplete).toBe(true);
    });

    test('scenario (b): {error: "timeout"} -> error step', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'NestedCondTest'),
      );
      session.toolExecutor = {
        execute: async () => ({ data: { count: 0 }, error: 'timeout' }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      // data.count is 0, so first branch (> 0) fails
      // error != undefined is true, so second branch matches
      expect(output).toContain('Error: timeout');
      expect(output).not.toContain('Found');
      expect(output).not.toContain('No results');
      expect(session.isComplete).toBe(true);
    });

    test('scenario (c): {data: {count: 0}} -> empty step', async () => {
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'NestedCondTest'),
      );
      session.toolExecutor = {
        execute: async () => ({ data: { count: 0 } }),
      } as any;

      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      // data.count is 0, first branch fails
      // error is undefined (not set at all), so result.error != undefined check:
      // When error is missing from the returned object, result.error is undefined.
      // The condition "result.error != undefined" should be false.
      // So ELSE branch -> empty
      expect(output).toContain('No results');
      expect(output).not.toContain('Found');
      expect(session.isComplete).toBe(true);
    });
  });

  // ===========================================================================
  // 5. TRANSFORM with FILTER using session context variables
  // ===========================================================================

  test('TRANSFORM with FILTER using session context variable as threshold', async () => {
    const dsl = `
AGENT: TransformContextTest

GOAL: "Test TRANSFORM FILTER with session context reference"

ON_START:
  set: threshold = 50

FLOW:
  start -> process -> display

  start:
    REASONING: false
    RESPOND: "Processing..."
    THEN: process

  process:
    REASONING: false
    TRANSFORM: scores AS item INTO passing
      FILTER: item.score > threshold
    THEN: display

  display:
    REASONING: false
    RESPOND: "Passing count: {{passing.length}}"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'TransformContextTest'),
    );
    session.data.values.scores = [
      { name: 'A', score: 80 },
      { name: 'B', score: 30 },
      { name: 'C', score: 60 },
      { name: 'D', score: 40 },
      { name: 'E', score: 90 },
    ];

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');
    // ON_START sets threshold = 50
    // FILTER: item.score > threshold should keep A(80), C(60), E(90) = 3 items
    const passing = session.data.values.passing as Array<Record<string, unknown>>;
    expect(passing).toBeDefined();
    expect(passing).toHaveLength(3);
    expect(passing.map((p) => p.name)).toEqual(['A', 'C', 'E']);
    expect(output).toContain('Passing count: 3');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 6. Loop-back with ON_RESULT retry pattern
  // ===========================================================================

  test('Loop-back retry pattern: check -> retry -> check -> done', async () => {
    const dsl = `
AGENT: RetryTest

GOAL: "Test loop-back retry pattern with ON_RESULT"

ON_START:
  set: attempts = 0

TOOLS:
  check_status() -> object
    description: "Check if system is ready"

FLOW:
  start -> check -> retry -> done

  start:
    REASONING: false
    RESPOND: "Starting check..."
    THEN: check

  check:
    CALL: check_status()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.ready == true
        THEN: done
      - ELSE:
        THEN: retry

  retry:
    REASONING: false
    RESPOND: "Retrying..."
    THEN: check

  done:
    REASONING: false
    RESPOND: "System ready!"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], 'RetryTest'));

    let callCount = 0;
    session.toolExecutor = {
      execute: async () => {
        callCount++;
        // Fail on first call, succeed on second
        if (callCount === 1) return { ready: false };
        return { ready: true };
      },
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // Flow: start -> check (ready=false) -> retry -> check (ready=true) -> done
    expect(callCount).toBe(2);
    expect(output).toContain('Starting check...');
    expect(output).toContain('Retrying...');
    expect(output).toContain('System ready!');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 7. ON_RESULT fallthrough to ON_SUCCESS/ON_FAILURE
  // ===========================================================================

  test('ON_RESULT no match falls through to ON_SUCCESS/ON_FAILURE handling', async () => {
    const dsl = `
AGENT: FallthroughTest

GOAL: "Test ON_RESULT fallthrough to ON_SUCCESS/ON_FAILURE"

TOOLS:
  run_check() -> object
    description: "Run a check"

FLOW:
  start -> check -> special -> success_path -> failure_path

  start:
    REASONING: false
    RESPOND: "Running check..."
    THEN: check

  check:
    CALL: run_check()
      AS: result
    ON_RESULT:
      REASONING: false
      - IF: result.code == 999
        THEN: special
    ON_SUCCESS:
      REASONING: false
      RESPOND: "Check passed via ON_SUCCESS"
      THEN: success_path
    ON_FAIL:
      RESPOND: "Check failed via ON_FAIL"
      THEN: failure_path

  special:
    REASONING: false
    RESPOND: "Special code 999"
    THEN: COMPLETE

  success_path:
    REASONING: false
    RESPOND: "Reached success path"
    THEN: COMPLETE

  failure_path:
    REASONING: false
    RESPOND: "Reached failure path"
    THEN: COMPLETE
`;

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'FallthroughTest'),
    );

    // Return code 200 -- doesn't match ON_RESULT (code == 999)
    // Tool returns successfully (no _error, no error field, success !== false)
    // So ON_SUCCESS should be taken
    session.toolExecutor = {
      execute: async () => ({ code: 200, status: 'ok' }),
    } as any;

    const chunks: string[] = [];
    await executor.initializeSession(session.id, (c) => chunks.push(c));

    const output = chunks.join('');

    // ON_RESULT has only IF: result.code == 999 which doesn't match
    // Falls through to ON_SUCCESS/ON_FAILURE evaluation
    // The call succeeded (no error fields) -> ON_SUCCESS branch
    expect(output).toContain('Check passed via ON_SUCCESS');
    expect(output).toContain('Reached success path');
    expect(output).not.toContain('Special code 999');
    expect(output).not.toContain('Check failed');
    expect(session.isComplete).toBe(true);
  });

  // ===========================================================================
  // 8. Reasoning agent: tool call -> store result -> final response
  // ===========================================================================

  test('Reasoning agent: tool call -> store result -> final response references result', async () => {
    const dsl = `
AGENT: ReasoningToolTest

GOAL: "Search for information and report findings"

TOOLS:
  search(query: string) -> object
    description: "Search for information"
`;

    const mock = injectMockClient(executor);

    let callIndex = 0;
    mock.setResponseHandler((_systemPrompt, _messages, tools) => {
      callIndex++;
      if (callIndex === 1) {
        // First call: LLM decides to call the search tool
        return {
          text: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'search',
              input: { query: 'latest news' },
            },
          ],
          stopReason: 'tool_use',
          rawContent: [
            { type: 'tool_use', id: 'call-1', name: 'search', input: { query: 'latest news' } },
          ],
        };
      }
      // Second call: LLM produces final response after seeing tool result
      return {
        text: 'Based on the search results, here are the latest findings.',
        toolCalls: [],
        stopReason: 'end_turn',
        rawContent: [
          {
            type: 'text',
            text: 'Based on the search results, here are the latest findings.',
          },
        ],
      };
    });

    const session = executor.createSessionFromResolved(
      compileToResolvedAgent([dsl], 'ReasoningToolTest'),
    );

    // Set up the tool executor to handle the search call
    session.toolExecutor = {
      execute: async (name: string, args: Record<string, unknown>) => {
        if (name === 'search') {
          return {
            results: [
              { title: 'Breaking news', url: 'https://example.com/1' },
              { title: 'Tech update', url: 'https://example.com/2' },
            ],
            total: 2,
          };
        }
        return { error: 'unknown tool' };
      },
    } as any;

    const chunks: string[] = [];
    const result = await executor.executeMessage(session.id, 'Search for latest news', (c) =>
      chunks.push(c),
    );

    // Verify the search tool was called
    expect(callIndex).toBe(2); // First call triggered tool use, second call got final response

    // Verify the tool result was stored in session data
    expect(session.data.values['last_search_result']).toBeDefined();
    const searchResult = session.data.values['last_search_result'] as Record<string, unknown>;
    expect(searchResult.total).toBe(2);
    expect(Array.isArray(searchResult.results)).toBe(true);

    // Verify the final response references the search
    expect(result.response).toContain('Based on the search results');
  });
});
