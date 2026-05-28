# Test Specification: Arch AI IN_PROJECT Generalist Router

**Feature Spec**: `docs/features/sub-features/arch-ai-generalist-router.md`
**HLD**: `docs/specs/arch-ai-generalist-router.hld.md`
**LLD**: `docs/plans/2026-04-15-arch-ai-generalist-router-impl-plan.md`
**Status**: PARTIAL
**Last Updated**: 2026-04-15 (post-impl sync)

---

## 1. Coverage Matrix

| FR    | Description                                      | Unit | Integration | E2E      | Manual | Status |
| ----- | ------------------------------------------------ | ---- | ----------- | -------- | ------ | ------ |
| FR-1  | Generalist base prompt + dynamic knowledge cards | ✅   | ✅ INT-2    | ✅ E2E-1 | -      | PASS   |
| FR-2  | Stable base prompt across turns                  | ✅   | -           | ✅ E2E-2 | -      | PASS   |
| FR-3  | Multiple knowledge cards for multi-domain msgs   | ✅   | ✅ INT-1    | ✅ E2E-2 | -      | PASS   |
| FR-4  | 8 domain cards from specialist prompts           | ✅   | ✅ INT-5    | -        | -      | PASS   |
| FR-5  | All 25 tools available every turn                | ✅   | -           | ✅ E2E-5 | -      | PASS   |
| FR-6  | SSE specialist event emits "Arch AI"             | -    | -           | ✅ E2E-1 | -      | PASS   |
| FR-7  | Backward compat with activeSpecialist field      | -    | -           | ✅ E2E-5 | -      | PASS   |
| FR-8  | tool_answer resume without re-routing            | ✅   | -           | ✅ E2E-3 | -      | PASS   |
| FR-9  | Knowledge card budget increased to 6000          | ✅   | ✅ INT-3    | -        | -      | PASS   |
| FR-10 | ONBOARDING mode unaffected                       | ✅   | ✅ INT-4    | ✅ E2E-4 | -      | PASS   |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API.
No mocks, no direct DB access, no stubbed servers.

All E2E tests start a real Studio server on a random port with the full middleware chain (auth, rate limiting, session management). Data seeding happens via API calls, not direct Mongoose operations.

### E2E-1: Cross-domain workflow — stable prompt across modify -> diagnose

- **Preconditions**: Authenticated tenant + user, existing IN_PROJECT session with at least one agent ("PaymentBot")
- **Steps**:
  1. POST `/api/arch-ai/message` with `{ type: "message", text: "add error handling to PaymentBot", sessionId }` — Auth header: `Bearer <tenant-token>`
  2. Parse SSE stream; collect all events
  3. Assert SSE event `{ type: "specialist", name: "Arch AI", icon: "code" }` is present (not "Diagnostician", not "ABL Construct Expert")
  4. Assert the LLM response references error-handler knowledge (tool preference hints from error-handlers card)
  5. POST `/api/arch-ai/message` with `{ type: "message", text: "why is PaymentBot still failing?", sessionId }` — same session
  6. Parse SSE stream; collect all events
  7. Assert SSE event still shows `{ type: "specialist", name: "Arch AI" }` (base identity unchanged)
  8. Assert the LLM response demonstrates diagnostic capability (references validate_agent or diagnose_project tool)
- **Expected Result**: Both turns use the same "Arch AI" identity. No specialist switch between turns. Both turns have access to all 25 tools.
- **Auth Context**: Tenant token with valid `tenantId` + `userId`
- **Isolation Check**: N/A for this scenario (session-scoped, no cross-tenant data)

### E2E-2: Multi-intent message loads multiple domain knowledge

- **Preconditions**: Authenticated tenant + user, existing IN_PROJECT session with agents and tools
- **Steps**:
  1. POST `/api/arch-ai/message` with `{ type: "message", text: "diagnose my agent's tool auth configuration and recommend a better model", sessionId }`
  2. Parse SSE stream
  3. Assert SSE specialist badge is "Arch AI"
  4. Assert the response addresses tool auth diagnostics (references auth_ops or tool-auth concepts)
  5. Assert the response addresses model recommendation (references recommend_model or model configuration concepts)
- **Expected Result**: Single response handles both domains. No "I can only help with X" limitations. The LLM has knowledge from both tool-auth and diagnostics cards.
- **Auth Context**: Tenant token with valid `tenantId` + `userId`
- **Isolation Check**: N/A

### E2E-3: tool_answer resume does not re-route on "true"

- **Preconditions**: Authenticated tenant + user, existing IN_PROJECT session, at least one agent
- **Steps**:
  1. POST `/api/arch-ai/message` with `{ type: "message", text: "change the persona of PaymentBot to be more formal", sessionId }`
  2. Parse SSE stream; expect `propose_modification` tool call followed by `ask_user` with `widgetType: "Confirmation"`
  3. Extract `toolCallId` from the `ask_user` tool call event
  4. POST `/api/arch-ai/message` with `{ type: "tool_answer", toolCallId, answer: true, sessionId }`
  5. Parse SSE stream
  6. Assert `apply_modification` tool call is present (modification applied, not re-routed)
  7. Assert SSE specialist badge is "Arch AI" (not re-routed based on "true" text)
- **Expected Result**: The tool_answer "true" does not trigger card re-selection based on the word "true". The system continues the modification workflow seamlessly.
- **Auth Context**: Tenant token with valid `tenantId` + `userId`
- **Isolation Check**: N/A

### E2E-4: ONBOARDING mode regression — specialist routing preserved

- **Preconditions**: Authenticated tenant + user, no existing ONBOARDING session
- **Steps**:
  1. POST `/api/arch-ai/message` with `{ type: "message", text: "I want to create a customer service agent project", mode: "ONBOARDING" }`
  2. Parse SSE stream
  3. Assert SSE specialist badge is NOT "Arch AI" — it should be the ONBOARDING phase-specific specialist (e.g., "Onboarding Specialist" for INTERVIEW phase)
  4. Assert the tool set is INTERVIEW-scoped: `ask_user`, `collect_file`, `update_specification`, `proceed_to_next_phase`, `platform_context` — NOT the full IN_PROJECT set
  5. Assert `routeByContent()` is NOT used (ONBOARDING uses phase machine, not content routing)
- **Expected Result**: ONBOARDING mode is completely unaffected by the generalist router changes. Phase machine, per-phase tool filtering, and phase-specific specialists all work as before.
- **Auth Context**: Tenant token with valid `tenantId` + `userId`
- **Isolation Check**: N/A

### E2E-5: Backward compatibility — existing session with legacy activeSpecialist

- **Preconditions**: Authenticated tenant + user. Seed an IN_PROJECT session via API with `metadata.activeSpecialist = 'diagnostician'` (simulating a pre-migration session)
- **Steps**:
  1. POST `/api/arch-ai/message` with `{ type: "message", text: "show me the topology", sessionId }` on the legacy session
  2. Parse SSE stream
  3. Assert SSE specialist badge is "Arch AI" (generalist, not "Diagnostician")
  4. Assert the response includes topology information (read_topology tool accessible)
  5. GET session metadata via API; assert `metadata.activeSpecialist` is now `'abl-construct-expert'`
  6. Assert all 25 IN_PROJECT tools were available (not filtered to diagnostician-only set)
- **Expected Result**: Legacy sessions transparently migrate to generalist behavior on first new message. The `activeSpecialist` field is updated. No user-visible error or degradation.
- **Auth Context**: Tenant token with valid `tenantId` + `userId`
- **Isolation Check**: Cross-tenant session access returns 404 (verify by attempting with different tenant token)

### E2E-6: Empty and ambiguous messages use generalist gracefully

- **Preconditions**: Authenticated tenant + user, existing IN_PROJECT session
- **Steps**:
  1. POST `/api/arch-ai/message` with `{ type: "message", text: "help", sessionId }`
  2. Assert SSE specialist badge is "Arch AI" (not "Diagnostician" via fallback regex)
  3. Assert response is helpful and does not claim to be a specific specialist
  4. POST `/api/arch-ai/message` with `{ type: "message", text: "hi", sessionId }`
  5. Assert SSE specialist badge is "Arch AI"
  6. Assert response is conversational without domain-specific framing
- **Expected Result**: Ambiguous messages that previously hit the diagnostician fallback regex now use the generalist naturally. No misrouting to diagnostician for "help", "hi", "hello", etc.
- **Auth Context**: Tenant token with valid `tenantId` + `userId`
- **Isolation Check**: N/A

---

## 3. Integration Test Scenarios (MANDATORY)

Integration tests call real functions with real data structures. No vi.mock of internal packages. External LLM client may use a test double via dependency injection.

### INT-1: Domain card selection — each specialist domain has a triggering message

- **Boundary**: User message → `selectKnowledgeCards()` → card IDs
- **Setup**: Import `selectKnowledgeCards` from `knowledge/card-router.ts`. No mocks.
- **Steps**:
  1. Call `selectKnowledgeCards("validate my agents and check for errors")` — diagnostics domain
  2. Assert `selectedIds` includes `'diagnostics-workflow'`
  3. Call `selectKnowledgeCards("show me performance metrics and sentiment trends")` — analytics domain
  4. Assert `selectedIds` includes `'analytics-workflow'`
  5. Call `selectKnowledgeCards("configure OAuth for my API tool")` — tool-integration domain
  6. Assert `selectedIds` includes `'tool-integration-workflow'`
  7. Call `selectKnowledgeCards("add a new agent to handle billing")` — topology-design domain
  8. Assert `selectedIds` includes `'topology-design-workflow'`
  9. Call `selectKnowledgeCards("configure voice prompts for my phone bot")` — channel-voice domain
  10. Assert `selectedIds` includes `'channel-voice-workflow'`
  11. Call `selectKnowledgeCards("design gather fields with progressive activation")` — entity-collection domain
  12. Assert `selectedIds` includes `'entity-collection-workflow'`
  13. Call `selectKnowledgeCards("run tests and evaluate agent quality")` — testing-eval domain
  14. Assert `selectedIds` includes `'testing-eval-workflow'`
  15. Call `selectKnowledgeCards("give me a weekly briefing on what changed")` — observer domain
  16. Assert `selectedIds` includes `'observer-workflow'`
- **Expected Result**: Every former specialist domain is reachable via knowledge card selection.
- **Failure Mode**: If a domain card is not registered or patterns don't match, `selectedIds` will be missing the card — test fails.

### INT-2: Generalist prompt composition — no specialist persona leak

- **Boundary**: `composeInProjectPrompt()` → system prompt string
- **Setup**: Import `composeInProjectPrompt` from `prompts/index.ts`. No mocks.
- **Steps**:
  1. Call `composeInProjectPrompt(undefined, "validate my agents")` (post-implementation — after FR-1 removes the specialist param from the signature; until then, call with `'abl-construct-expert'`)
  2. Assert prompt contains BASE_PROMPT content
  3. Assert prompt contains "IN-PROJECT" (from IN_PROJECT_PHASE_PROMPT)
  4. Assert prompt does NOT contain "You are the Diagnostician"
  5. Assert prompt does NOT contain "You are the Performance Analyst"
  6. Assert prompt does NOT contain "You are the Observer"
  7. Assert prompt does NOT contain "You are the Integration Methodologist"
  8. Assert prompt DOES contain diagnostics card content (from selectKnowledgeCards matching "validate")
  9. Call `composeInProjectPrompt(undefined, "hello world")` — no domain match
  10. Assert prompt contains BASE_PROMPT + IN_PROJECT_PHASE_PROMPT + platform-limits
  11. Assert prompt does NOT contain any specialist persona string
- **Expected Result**: The generalist prompt never contains specialist persona declarations. Domain knowledge comes from cards, not specialist prompts.
- **Failure Mode**: If specialist prompts leak into IN_PROJECT composition, persona strings will appear.

### INT-3: Token budget enforcement at 6000 tokens

- **Boundary**: `selectKnowledgeCards()` → token budget enforcement
- **Setup**: Import `selectKnowledgeCards` from `card-router.ts`. No mocks.
- **Steps**:
  1. Craft a message that matches many cards: `"validate agents, check tool auth OAuth, configure flow steps with CEL expressions and gather fields using templates and guardrails"`
  2. Call `selectKnowledgeCards(message, 6000)`
  3. Assert `estimatedTokens <= 6000`
  4. Assert `selectedIds.length > 0` (at least platform-limits + some matches)
  5. If `skippedIds.length > 0`, assert they are lower-priority cards that didn't fit
  6. Call `selectKnowledgeCards(message, 4000)` — old budget
  7. Assert some cards that fit at 6000 are now in `skippedIds` at 4000
- **Expected Result**: Budget increase from 4000 to 6000 allows more cards to load simultaneously. Budget is enforced — no overflow.
- **Failure Mode**: If `MAX_KNOWLEDGE_TOKENS` isn't updated, domain cards may be skipped even at 6000.

### INT-4: ONBOARDING routing regression — routeByContent still works

- **Boundary**: `routeByContent()` → specialist ID
- **Setup**: Import `routeByContent` from `coordinator/content-router.ts`. No mocks.
- **Steps**:
  1. Verify all existing test vectors still pass:
     - `"modify agent PaymentBot"` → `'abl-construct-expert'`
     - `"add a new agent for billing"` → `'multi-agent-architect'`
     - `"debug this issue"` → `'diagnostician'`
     - `"run tests on this agent"` → `'testing-eval'`
     - `"Configure voice prompts"` → `'channel-voice'`
  2. Verify default fallback: `"hello world"` → `'abl-construct-expert'`
  3. Verify empty string: `""` → `'abl-construct-expert'`
- **Expected Result**: `routeByContent()` is unchanged. ONBOARDING mode can continue using it.
- **Failure Mode**: If someone accidentally modifies content-router.ts, ONBOARDING breaks.

### INT-5: Golden corpus — domain card coverage

- **Boundary**: Golden corpus scenarios → `selectKnowledgeCards()` + `composeInProjectPrompt()`
- **Setup**: Extend `GOLDEN_SCENARIOS` array with 8 new domain-card scenarios. No mocks.
- **Steps**:
  1. Add scenarios for each domain card:
     - `{ id: 'domain-diagnostics', userMessage: 'validate my agents and check for errors', expectedCards: ['platform-limits', 'diagnostics-workflow'] }`
     - `{ id: 'domain-analytics', userMessage: 'show me agent performance and sentiment data', expectedCards: ['platform-limits', 'analytics-workflow'] }`
     - `{ id: 'domain-observer', userMessage: 'why did resolution drop and what is the root cause', expectedCards: ['platform-limits', 'observer-workflow', 'observer-patterns'] }`
     - `{ id: 'domain-integration', userMessage: 'configure OAuth for my API tool endpoint', expectedCards: ['platform-limits', 'tool-integration-workflow'] }`
     - `{ id: 'domain-topology', userMessage: 'add a new billing agent to the topology', expectedCards: ['platform-limits', 'topology-design-workflow'] }`
     - `{ id: 'domain-channel', userMessage: 'configure voice prompts and DTMF for IVR', expectedCards: ['platform-limits', 'channel-voice-workflow'] }`
     - `{ id: 'domain-entity', userMessage: 'design gather fields with depends_on and lookup validation', expectedCards: ['platform-limits', 'entity-collection-workflow'] }`
     - `{ id: 'domain-testing', userMessage: 'run tests and create eval scenarios for my agent', expectedCards: ['platform-limits', 'testing-eval-workflow'] }`
  2. For each scenario, call `selectKnowledgeCards(scenario.userMessage)` and assert expected cards
  3. For each scenario, call `composeInProjectPrompt(undefined, scenario.userMessage)` and assert prompt contains domain knowledge
  4. Assert domain card content is present in composed prompt (requiredKnowledge strings)
- **Expected Result**: Every domain card is reachable via at least one golden corpus scenario. Composed prompt includes the card content.
- **Failure Mode**: Missing patterns, card not registered, or card content empty.

### INT-6: SSE specialist event structure validation

- **Boundary**: Route handler → SSE event emission
- **Setup**: Call the specialist display function or equivalent with the generalist ID.
- **Steps**:
  1. Assert `getSpecialistDisplay('abl-construct-expert')` returns `{ name: 'Arch AI', icon: 'code' }` (or equivalent generalist display)
  2. Assert the SSE event schema matches `{ type: 'specialist', name: string, icon: string }`
  3. Assert no other specialist display (diagnostician, analyst, observer) is emitted for IN_PROJECT turns
- **Expected Result**: SSE specialist event uses the generalist display for all IN_PROJECT turns.
- **Failure Mode**: If display map isn't updated, old specialist names leak into SSE events.

### INT-7: Backward compatibility — activeSpecialist field handling

- **Boundary**: Session metadata → prompt composition path
- **Setup**: Construct a mock session metadata object with `activeSpecialist: 'diagnostician'`. No DB mocks — test the logic path.
- **Steps**:
  1. Simulate the IN_PROJECT message handler logic: given `msg.type === 'message'` and an existing session with `activeSpecialist: 'diagnostician'`
  2. Assert the prompt composition uses the generalist prompt (not the diagnostician prompt)
  3. Assert `activeSpecialist` would be set to `'abl-construct-expert'` after processing
  4. Simulate `msg.type === 'tool_answer'` path: assert the system does NOT re-use stored specialist to select a specialist prompt
- **Expected Result**: Legacy specialist values in session metadata don't influence prompt composition.
- **Failure Mode**: If the tool_answer path still reads stored specialist and uses it for prompt selection, legacy values cause wrong prompts.

---

## 4. Unit Test Scenarios

### UT-1: composeInProjectPrompt produces generalist prompt

- **Module**: `packages/arch-ai/src/prompts/index.ts`
- **Input**: Call `composeInProjectPrompt()` with no specialist parameter (or default), user message "hello"
- **Expected Output**: String containing BASE_PROMPT + generalist identity + platform-limits + IN_PROJECT_PHASE_PROMPT. Does NOT contain any specialist-specific persona.

### UT-2: Prompt identity is stable across different user messages

- **Module**: `packages/arch-ai/src/prompts/index.ts`
- **Input**: Call `composeInProjectPrompt()` with messages from different domains:
  - `"validate my agents"` (diagnostics)
  - `"show me metrics"` (analytics)
  - `"add error handling"` (construct)
  - `"configure voice"` (channel)
- **Expected Output**: All four prompts share the same base identity section. The generalist persona ("You are Arch AI" or similar) appears in all. No specialist persona ("You are the Diagnostician") appears in any.

### UT-3: selectKnowledgeCards returns multiple domain cards for multi-intent

- **Module**: `packages/arch-ai/src/knowledge/card-router.ts`
- **Input**: `selectKnowledgeCards("validate agents and configure tool auth")`
- **Expected Output**: `selectedIds` includes both `'diagnostics-workflow'` and `'tool-integration-workflow'` (or `'tool-auth'` from existing cards). Multiple domain cards loaded simultaneously.

### UT-4: All 8 domain cards are registered and have non-empty content

- **Module**: `packages/arch-ai/src/knowledge/card-router.ts`
- **Input**: Read CARD_REGISTRY; filter for domain card IDs
- **Expected Output**: 8 domain cards found. Each has `id`, `content` (non-empty string), and `patterns` (non-empty array). Card IDs: `diagnostics-workflow`, `analytics-workflow`, `observer-workflow`, `tool-integration-workflow`, `topology-design-workflow`, `channel-voice-workflow`, `entity-collection-workflow`, `testing-eval-workflow`.

### UT-5: IN_PROJECT_TOOLS still contains all 25 tools

- **Module**: `packages/arch-ai/src/types/tools.ts`
- **Input**: Read `IN_PROJECT_TOOLS` constant
- **Expected Output**: Array length is 25. Contains all expected tool names including `auth_ops`, `collect_secret`, `tools_ops`, `manage_memory`, `platform_context`. No tools removed.

### UT-6: tool_answer text does not influence card selection

- **Module**: `packages/arch-ai/src/knowledge/card-router.ts`
- **Input**: `selectKnowledgeCards("true")`, `selectKnowledgeCards("false")`, `selectKnowledgeCards("yes")`
- **Expected Output**: All three return only `['platform-limits']` — no domain cards triggered by boolean answer text. This verifies that the route handler should use conversation context (not tool answer text) for card selection.

### UT-7: MAX_KNOWLEDGE_TOKENS is 6000

- **Module**: `packages/arch-ai/src/knowledge/card-router.ts`
- **Input**: Call `selectKnowledgeCards("some message")` with default budget
- **Expected Output**: The default budget allows up to 6000 tokens of card content. Verify by crafting a message that matches ~5000 tokens of cards — all should fit. With a 4000-token budget (explicit override), some should be skipped.

### UT-8: routeByContent is NOT imported or called in composeInProjectPrompt

- **Module**: `packages/arch-ai/src/prompts/index.ts`
- **Input**: Read the source code of `composeInProjectPrompt`
- **Expected Output**: No reference to `routeByContent` in the function body. The specialist parameter is either removed or ignored. Prompt composition uses `selectKnowledgeCards` only.

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant session access returns 404**: Existing test coverage in parent feature (Arch AI session tests). Session queries include `tenantId`. No change needed — card selection is stateless.
- [x] **Cross-project access returns 404**: Existing coverage. Session is project-scoped via `metadata.projectId`. No change.
- [x] **Cross-user access returns 404**: Existing coverage. Session is user-scoped via `userId`. No change.
- [x] **Missing auth returns 401**: Existing coverage. `requireTenantAuth` middleware is unchanged.
- [x] **Insufficient permissions returns 403**: N/A — Arch AI chat does not have granular permissions beyond tenant auth.
- [x] **Input validation rejects malformed data**: Existing coverage. Message schema validation is unchanged.

**New security consideration**: Knowledge card content is static code (not user-supplied). No injection vector. System prompt changes are internal — not exposed to end users via any API response.

---

## 6. Performance & Load Tests

Not applicable for this change. Justification:

- `selectKnowledgeCards()` is a pure function with regex matching against static strings — ~0ms execution time
- `routeByContent()` removal saves one regex pass (negligible)
- Token budget increase (4000 → 6000) adds ~200-600 tokens per LLM call — marginal cost increase
- No new network calls, DB queries, or async operations

If future monitoring shows token cost regression, add a benchmark test that measures average system prompt token count across golden corpus scenarios.

---

## 7. Test Infrastructure

- **Required services**: None for unit/integration tests (all pure function tests). E2E tests require Studio dev server (`pnpm dev --filter=apps/studio`).
- **Data seeding**: E2E tests seed sessions via POST `/api/arch-ai/message` to create IN_PROJECT sessions. Legacy session seeding (E2E-5) requires direct session creation via the session API or a test helper.
- **Environment variables**: `ANTHROPIC_API_KEY` or equivalent LLM provider key for E2E tests that exercise the full LLM path. Unit/integration tests do not require LLM access.
- **CI configuration**: Unit and integration tests run in standard vitest pipeline. E2E tests require the Studio server and LLM API access — may be limited to integration CI environment.
- **Test runner**: vitest (already configured in `packages/arch-ai/vitest.config.ts`)

---

## 8. Test File Mapping

| Test File                                                                 | Type                             | Covers                        | Status  |
| ------------------------------------------------------------------------- | -------------------------------- | ----------------------------- | ------- |
| `packages/arch-ai/src/__tests__/domain-card-selection.test.ts`            | unit (new, 23 tests)             | FR-1, FR-3, FR-4, FR-8, FR-9  | ✅ PASS |
| `packages/arch-ai/src/__tests__/prompts.test.ts`                          | unit (updated, 4 new assertions) | FR-1, FR-2                    | ✅ PASS |
| `packages/arch-ai/src/__tests__/content-router.test.ts`                   | unit (preserved)                 | FR-10 (ONBOARDING regression) | ✅ PASS |
| `packages/arch-ai/src/__tests__/content-router-tool-lifecycle.test.ts`    | unit (preserved)                 | FR-10                         | ✅ PASS |
| `packages/arch-ai/src/__tests__/golden-corpus/scenarios.ts`               | data (+8 domain scenarios)       | FR-4                          | ✅ PASS |
| `packages/arch-ai/src/__tests__/golden-corpus/knowledge-coverage.test.ts` | integration (updated)            | FR-1, FR-4, FR-9              | ✅ PASS |
| `apps/studio/src/__tests__/e2e/arch-ai-generalist-router.e2e.test.ts`     | e2e (7 tests)                    | FR-1 through FR-10            | ✅ PASS |

---

## 9. Open Testing Questions

1. **LLM behavior assertion in E2E**: E2E scenarios E2E-1 and E2E-2 assert that the LLM "demonstrates diagnostic capability" or "addresses both domains." This requires inspecting the LLM response text, which is non-deterministic. Options: (a) assert tool calls rather than text, (b) use regex for key phrases, (c) accept these as manual verification only.

2. **Legacy session seeding**: E2E-5 needs a session with `metadata.activeSpecialist = 'diagnostician'`. The public API may not allow setting this field directly. Options: (a) create a test helper that uses the session service, (b) modify the session via a test-only admin endpoint, (c) accept as integration-level only.

3. **E2E-4 ONBOARDING verification**: Checking tool filtering in ONBOARDING mode E2E requires intercepting the tool set passed to the LLM, which isn't directly observable from SSE events. Options: (a) verify indirectly by checking that only INTERVIEW-phase tools appear in tool calls, (b) add a debug SSE event that lists available tools, (c) test at integration level only.
