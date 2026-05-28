# Feature Test Guide: Session Compaction

**Feature**: Session Compaction -- automatic conversation history summarization when context usage approaches model limits
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/session-compaction.md](../features/session-compaction.md)
**First tested**: 2026-03-22
**Last updated**: 2026-03-22
**Overall status**: PARTIAL -- unit coverage solid, integration and E2E tests not yet implemented

---

## Current State (as of 2026-03-22)

Session Compaction has solid unit test coverage across the CompactionEngine (trigger logic, extractive fallback, trace events), CompactionPolicy resolution (3-level merge, essential_fields collection, caching), tool-result compressor, and cross-turn tool truncation. No integration or E2E tests exist yet -- these are the primary testing gaps.

### Quick Health Dashboard

| Area                                      | Status     | Last Verified | Notes                                                       |
| ----------------------------------------- | ---------- | ------------- | ----------------------------------------------------------- |
| CompactionEngine autoCompact trigger      | PASS       | 2026-03-22    | Disabled skip, under-threshold skip, over-threshold trigger |
| CompactionEngine compactThread            | PASS       | 2026-03-22    | History split, summary generation, minimum window guard     |
| Model context window resolution           | PASS       | 2026-03-22    | Registry lookup, smaller model behavior                     |
| Extractive fallback summary               | PASS       | 2026-03-22    | Agent name, first/last user messages, gathered data         |
| LLM abstractive summary                   | NOT TESTED | -             | No test exercises the real LLM client path                  |
| Trace event emission                      | PASS       | 2026-03-22    | auto_compact event with token counts                        |
| Per-session threshold override            | PASS       | 2026-03-22    | resolvedCompactionThreshold overrides global config         |
| CompactionPolicy 3-level merge            | PASS       | 2026-03-22    | Platform defaults, project config, agent IR                 |
| Tool essential_fields collection          | PASS       | 2026-03-22    | Collected from ToolDefinition.compaction entries            |
| Policy lazy caching                       | PASS       | 2026-03-22    | Same reference on repeated calls                            |
| Tool-result compressor                    | PASS       | 2026-03-22    | Structured field extraction, truncation, LLM summarization  |
| Cross-turn tool truncation                | PASS       | 2026-03-22    | Prior-turn tool results truncated                           |
| Integration: compaction in reasoning loop | NOT TESTED | -             | No test exercises compaction during a real reasoning loop   |
| E2E: long conversation auto-compaction    | NOT TESTED | -             | No real WebSocket E2E test                                  |

---

## Coverage Matrix

| FR    | Description                                   | Unit | Integration | E2E | Manual | Status     |
| ----- | --------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Token estimation via character heuristic      | PASS | -           | -   | -      | COVERED    |
| FR-2  | Auto-compact trigger at threshold             | PASS | -           | -   | -      | COVERED    |
| FR-3  | Context window resolution via model registry  | PASS | -           | -   | -      | COVERED    |
| FR-4  | History split + summary replacement           | PASS | -           | -   | -      | COVERED    |
| FR-5  | MIN_ACTIVE_WINDOW guard (10 messages)         | PASS | -           | -   | -      | COVERED    |
| FR-6  | LLM abstractive summarization                 | -    | -           | -   | -      | NOT TESTED |
| FR-7  | Extractive fallback on LLM failure            | PASS | -           | -   | -      | COVERED    |
| FR-8  | 3-level policy merge (platform/project/agent) | PASS | -           | -   | -      | COVERED    |
| FR-9  | Tool essential_fields collection              | PASS | -           | -   | -      | COVERED    |
| FR-10 | auto_compact trace event emission             | PASS | -           | -   | -      | COVERED    |
| FR-11 | Tool-result compressor 4-strategy support     | PASS | -           | -   | -      | COVERED    |
| FR-12 | Disabled by default, requires opt-in          | PASS | -           | -   | -      | COVERED    |

---

## E2E Test Scenarios (Minimum 5)

### E2E-1: Long Conversation Auto-Compaction via WebSocket

**Preconditions**:

- Runtime server started on random port with `SESSION_COMPACTION_ENABLED=true` and `SESSION_AUTO_COMPACT_THRESHOLD=0.8`
- Agent DSL compiled with a known model (e.g., `gpt-4o-mini`, context window 128K)
- Full middleware chain active (auth, rate limiting, tenant isolation)

**Steps**:

1. POST `/api/projects/:projectId/agents` to create an agent with a simple DSL
2. Open WebSocket connection to `ws://localhost:{port}/ws` with auth headers (tenantId, projectId, userId)
3. Send 50+ user messages, each with 500+ characters of content, to push token usage above 80% threshold
4. After each response, verify the response is coherent (non-empty, contextually relevant)
5. GET session state and verify `conversationHistory` length is less than the total messages sent (compaction occurred)
6. Verify the first message in the history is a system message starting with `[Conversation Summary]`

**Expected Result**: Conversation continues without errors; history is compacted transparently; summary message is present.

**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`

**Isolation Check**: A second WebSocket connection with `tenantId=other-tenant` must not see the first session's conversation.

### E2E-2: Compaction with ContentBlock[] Messages

**Preconditions**:

- Runtime server started with compaction enabled
- Agent configured to handle multimodal content

**Steps**:

1. Open WebSocket connection with auth context
2. Send messages with `ContentBlock[]` content (text blocks with `{ type: 'text', text: '...' }`)
3. Continue sending until token estimation exceeds threshold
4. Verify compaction triggers and handles ContentBlock content correctly
5. Verify the summary message content is a plain string (not ContentBlock[])
6. Verify remaining messages in the active window preserve their original ContentBlock format

**Expected Result**: Compaction handles mixed content types without errors; active window preserves original formats.

**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`

**Isolation Check**: Cross-tenant access returns 404.

### E2E-3: Compaction Disabled by Default

**Preconditions**:

- Runtime server started WITHOUT setting `SESSION_COMPACTION_ENABLED` (defaults to false)

**Steps**:

1. Open WebSocket connection with auth context
2. Send 100+ messages to exceed what would be the compaction threshold
3. Verify all messages are retained in conversation history (no compaction)
4. Verify no `auto_compact` trace events are emitted

**Expected Result**: When disabled, compaction never triggers regardless of conversation length.

**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`

**Isolation Check**: N/A (feature disabled).

### E2E-4: Per-Agent Compaction Threshold Override

**Preconditions**:

- Runtime server started with compaction enabled
- Agent DSL configured with `EXECUTION.compaction_threshold: 0.5` (lower than default 0.8)

**Steps**:

1. POST agent creation with DSL containing `compaction_threshold: 0.5`
2. Open WebSocket connection
3. Send messages to push token usage above 50% but below 80%
4. Verify compaction triggers at the 50% threshold (not the default 80%)
5. Verify the `auto_compact` trace event records the correct threshold

**Expected Result**: Per-agent threshold overrides the global default; compaction triggers earlier.

**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`

**Isolation Check**: Different agent with default threshold in same project should not trigger at 50%.

### E2E-5: Compaction Preserves Conversation Coherence

**Preconditions**:

- Runtime server started with compaction enabled
- Agent DSL with a conversational agent that tracks gathered data (name, email, etc.)

**Steps**:

1. Open WebSocket connection
2. Send messages that establish user context: name, email, order number
3. Continue conversation with 40+ exchanges to trigger compaction
4. After compaction, ask the agent to recall the user's name and order number
5. Verify the agent's response includes the previously gathered data (from the compaction summary)
6. Verify the `[Conversation Summary]` message includes gathered data references

**Expected Result**: Key information survives compaction via the summary; agent recalls previously gathered data.

**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`

**Isolation Check**: Cross-project session access returns 404.

### E2E-6: Compaction with Tool Results in History

**Preconditions**:

- Runtime server started with compaction enabled
- Agent with at least one tool configured (e.g., search tool returning large JSON)

**Steps**:

1. Open WebSocket connection
2. Trigger tool calls that produce large JSON results (>10KB each)
3. Continue conversation to approach context window limit
4. Verify compaction triggers and tool-result messages in the compacted portion are summarized
5. Verify recent tool results (within the active window) are preserved intact
6. Verify the conversation continues to function correctly after compaction

**Expected Result**: Tool results in the compacted portion are included in the summary; recent tool results preserved.

**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`

**Isolation Check**: Cross-tenant access returns 404.

---

## Integration Test Scenarios (Minimum 5)

### INT-1: CompactionEngine Integration with Reasoning Executor

**Boundary**: CompactionEngine + ReasoningExecutor

**Setup**: Create a ReasoningExecutor with a CompactionEngine instance and a mock LLM client that returns fixed responses. Create a RuntimeSession with enough messages to exceed the compaction threshold.

**Steps**:

1. Create a session with 60+ messages and compaction enabled (`autoCompactThreshold: 0.3` for easier triggering)
2. Call the reasoning executor's main loop (which internally calls `autoCompact()`)
3. Verify that after the LLM call, the session's conversation history has been compacted
4. Verify a `[Conversation Summary]` system message is present
5. Verify the trace events include an `auto_compact` event

**Expected Result**: CompactionEngine triggers correctly within the reasoning executor's pre-LLM-call flow.

**Failure Mode**: If the compaction engine throws, the reasoning executor should catch and continue (line 579: `log.warn('auto-compact failed, continuing without compaction')`).

### INT-2: CompactionPolicy Resolution with Real Project Config

**Boundary**: CompactionPolicy + RuntimeSession + ProjectRuntimeConfig

**Setup**: Create a RuntimeSession with `_projectRuntimeConfig.compaction` set to override defaults and `agentIR.execution.compaction` set to override project config.

**Steps**:

1. Create session with project config: `{ compaction: { tool_results: { max_chars: 80000, keep_recent: 3 } } }`
2. Set agent IR: `{ execution: { compaction: { tool_results: { max_chars: 50000 } } } }`
3. Call `resolveCompactionPolicy(session)`
4. Verify `max_chars` is 50000 (agent wins), `keep_recent` is 3 (project fills gap), `strategy` is 'summarize' (platform default fills rest)
5. Call `resolveCompactionPolicy(session)` again and verify same object reference (cached)

**Expected Result**: 3-level merge works correctly with real session structure.

**Failure Mode**: If `_projectRuntimeConfig` is undefined, should fall through to defaults without error.

### INT-3: Tool-Result Compressor with CompactionPolicy Essential Fields

**Boundary**: ToolResultCompressor + CompactionPolicy

**Setup**: Create a CompactionPolicy with tool-specific `essential_fields` for a tool named `product_search`.

**Steps**:

1. Create policy with `tool_results.essential_fields = { product_search: ['id', 'title', 'price'] }`
2. Create a large JSON tool result (>10KB) with many fields including id, title, price, description, image_url, etc.
3. Call `compressToolResult(serialized, 'product_search', policy)`
4. Parse the result and verify only `id`, `title`, `price` fields are preserved per item
5. Verify `description` field is not present (not in essential_fields)
6. Call `compressToolResult(serialized, 'unknown_tool', policy)` and verify all fields are preserved (no essential_fields for this tool)

**Expected Result**: Tool-specific essential_fields filtering works correctly in the compression pipeline.

**Failure Mode**: Unknown tool names should fall through to no-filter behavior (all fields kept, only char-cap applies).

### INT-4: Compaction with Tiered Session Store Persistence

**Boundary**: CompactionEngine + SessionService + TieredSessionStore

**Setup**: Create a SessionService backed by a MemorySessionStore wrapped in TieredSessionStore (with MongoDB cold storage mocked at the repo level via DI).

**Steps**:

1. Create a session with 40+ messages via SessionService
2. Manually trigger `CompactionEngine.compactThread()` on the session
3. Save the session via `SessionService.saveSession()`
4. Load the session via `SessionService.loadSession()` and verify the compacted history is persisted
5. Verify the `[Conversation Summary]` message is present in the loaded session's history
6. Verify the session version was incremented correctly

**Expected Result**: Compacted history round-trips correctly through the session store.

**Failure Mode**: Version conflict on save should return false and not corrupt the session state.

### INT-5: Cross-Turn Tool Truncation with CompactionPolicy

**Boundary**: ReasoningExecutor.truncatePriorTurnToolResults + CompactionPolicy

**Setup**: Create a session with multiple turns of tool calls in the conversation history. Set `prior_turns.assistant_preview_chars = 100`.

**Steps**:

1. Create a conversation history with 3 turns, each containing tool call + tool result messages
2. Set the most recent turn as "current" (not truncated)
3. Resolve the compaction policy with `assistant_preview_chars: 100`
4. Apply prior-turn truncation
5. Verify prior-turn tool results are truncated to 100 chars
6. Verify current-turn tool results are preserved in full
7. Verify non-tool messages (user/assistant text) are not affected

**Expected Result**: Prior-turn tool results are truncated per policy; current-turn results preserved.

**Failure Mode**: If policy is not resolved (null), should use DEFAULT_COMPACTION_POLICY values.

### INT-6: Token Estimation Accuracy for Various Content Types

**Boundary**: estimateTokens() + CompactionEngine threshold check

**Setup**: Prepare message arrays with different content types: plain strings, ContentBlock[] arrays, mixed content.

**Steps**:

1. Create 20 messages with plain string content (100 chars each)
2. Estimate tokens: should be approximately `(100 + 10) * 20 / 4 = 550`
3. Create 20 messages with `ContentBlock[]` content containing text blocks
4. Estimate tokens: should count text block content, not the array structure
5. Create 20 messages with mixed content (some string, some ContentBlock[])
6. Verify consistent estimation across content types
7. Verify the threshold check (`currentTokens < contextWindow * threshold`) works correctly with these estimates

**Expected Result**: Token estimation handles all message content formats consistently.

**Failure Mode**: ContentBlock[] messages with non-text blocks (image, etc.) should be counted as 0 tokens for those blocks (only `text` fields contribute).

---

## Unit Test Scenarios

### Existing Tests (PASS)

| Module                  | Input                                        | Expected Output                                          |
| ----------------------- | -------------------------------------------- | -------------------------------------------------------- |
| estimateTokens          | 10 messages, 200 chars each                  | ~525 tokens (2000 + 100 overhead) / 4                    |
| autoCompact (disabled)  | compactionEnabled: false                     | null (no compaction)                                     |
| autoCompact (under)     | tokens < threshold                           | null (no compaction)                                     |
| autoCompact (over)      | tokens > threshold                           | CompactionResult with compacted: true                    |
| compactThread (min)     | <=10 messages                                | CompactionResult with compacted: false                   |
| extractiveSummary       | Messages with user content and gathered data | String containing agent name, first/last messages, data  |
| resolveCompactionPolicy | 3-level config                               | Merged policy with agent > project > platform precedence |
| essential_fields        | Tools with compaction annotations            | Collected into policy keyed by tool name                 |
| compressToolResult      | Large JSON + essential_fields policy         | Filtered JSON with only essential fields per item        |

### Planned Tests (NOT YET IMPLEMENTED)

| Module                     | Input                                        | Expected Output                       |
| -------------------------- | -------------------------------------------- | ------------------------------------- |
| generateSummary (LLM path) | Messages + mock LLM client returning summary | LLM summary text in CompactionResult  |
| estimateTokens (CB[])      | ContentBlock[] messages with text blocks     | Correct token count from text content |
| compactThread (large)      | 100+ messages exceeding context window       | Compacted to ~50 + summary message    |

---

## Security & Isolation Tests

- [ ] Compaction operates within session scope -- no cross-session data leakage
- [ ] LLM summarization call uses session's own credentials (not a shared/global client)
- [ ] Compaction summaries inherit session TTL (not persisted independently)
- [ ] Cross-tenant session access returns 404 (existing session isolation tests cover this)
- [ ] Cross-project session access returns 404
- [ ] PII in compaction summaries follows session's PII redaction config

---

## Performance & Load Tests

| Scenario                               | Target   | How to Measure                            |
| -------------------------------------- | -------- | ----------------------------------------- |
| Token estimation for 100 messages      | < 1ms    | `performance.now()` around estimateTokens |
| Extractive fallback summary generation | < 5ms    | No I/O path, pure CPU                     |
| LLM summary generation                 | < 3s     | LLM call latency                          |
| Policy resolution (first call)         | < 1ms    | Deep merge computation                    |
| Policy resolution (cached)             | < 0.01ms | Object reference return                   |

---

## Test Infrastructure

### Required Services

- Runtime Express server started on random port (`{ port: 0 }`)
- Redis (for RedisSessionStore integration tests; MemorySessionStore for unit tests)
- MongoDB (for TieredSessionStore cold storage tests; can use MongoMemoryServer)

### Data Seeding

- Agent DSL strings for compilation
- Pre-built RuntimeSession objects with varying message counts
- Mock LLM client that returns fixed summarization responses (for integration tests only -- E2E uses real LLM)

### Environment Variables

| Variable                         | Test Value | Purpose                               |
| -------------------------------- | ---------- | ------------------------------------- |
| `SESSION_COMPACTION_ENABLED`     | `true`     | Enable compaction in test sessions    |
| `SESSION_AUTO_COMPACT_THRESHOLD` | `0.3`      | Lower threshold for faster triggering |

### CI Configuration

- Compaction unit tests run in standard CI (no external dependencies)
- Integration tests require Redis and MongoDB (Docker services in CI)
- E2E tests require full runtime server startup

---

## Test File Mapping

| Test File                                                                           | Type        | Covers                                           |
| ----------------------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `apps/runtime/src/__tests__/compaction-engine.test.ts`                              | unit        | FR-1, FR-2, FR-3, FR-4, FR-5, FR-7, FR-10, FR-12 |
| `apps/runtime/src/__tests__/compaction-policy.test.ts`                              | unit        | FR-8, FR-9                                       |
| `apps/runtime/src/__tests__/tool-result-compressor.test.ts`                         | unit        | FR-11                                            |
| `apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts`                     | unit        | FR-11 (prior-turn truncation)                    |
| PLANNED: `apps/runtime/src/__tests__/integration/compaction-reasoning-loop.test.ts` | integration | FR-2, FR-4, FR-6, FR-7, FR-10                    |
| PLANNED: `apps/runtime/src/__tests__/e2e/compaction-e2e.test.ts`                    | e2e         | FR-1 through FR-12                               |

---

## Coverage Gaps

| Gap                                                                | Severity | Notes                                                                       |
| ------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------- |
| No test for LLM abstractive summary path (FR-6)                    | Medium   | The LLM client path in generateSummary is never exercised                   |
| No integration test for compaction within reasoning loop           | High     | Compaction is triggered before LLM calls but no test verifies the full flow |
| No E2E test for long-conversation auto-compaction                  | High     | No real session with WebSocket verifying compaction happens transparently   |
| No test for CJK token estimation accuracy                          | Low      | Heuristic is 4 chars/token, may under-estimate for CJK                      |
| No test for compaction with ContentBlock[] messages                | Medium   | Tests only use string content, not structured ContentBlock arrays           |
| No test for project-level config merge with real DB config         | Medium   | Tests use in-memory mock, not real \_projectRuntimeConfig from DB           |
| No test for compaction + PII redaction interaction                 | Low      | Compaction should process already-redacted content                          |
| No test for concurrent compaction on same session (race condition) | Medium   | Execution lock should prevent concurrent compaction but not verified        |

---

## Open Testing Questions

1. Should E2E tests use a real LLM for summarization, or can they use a deterministic mock LLM server that returns fixed summaries? (Real LLM adds cost and non-determinism.)
2. What is the minimum number of messages needed to reliably trigger compaction in E2E tests? (Depends on model context window and threshold.)
3. Should performance benchmarks be automated in CI or run manually?

---

## How to Run

```bash
# All compaction-related tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "compaction"

# Specific test files
pnpm test --filter=runtime -- apps/runtime/src/__tests__/compaction-engine.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/compaction-policy.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/tool-result-compressor.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/cross-turn-tool-truncation.test.ts
```
