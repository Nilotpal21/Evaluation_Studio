# Test Spec: Arch AI Assistant

> **Feature**: Arch -- AI-Guided Project Lifecycle Assistant
> **Backlog Item**: #74
> **Status**: BETA
> **Last Updated**: 2026-04-06

---

## 1. Test Coverage Matrix (v0.3)

> Full report: [`docs/arch/14-test-coverage.md`](../arch/14-test-coverage.md) | ~1,087+ tests across 97+ files (32 engine unit + 60 studio unit/integration + 5 E2E)

| Component                   | Unit                                         | Integration                                     | E2E                                             | Status        |
| --------------------------- | -------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | ------------- |
| Phase machine (coordinator) | ✅ phase-machine.test.ts                     | --                                              | --                                              | ✅ Covered    |
| Session state machine       | ✅ session-state-machine.test.ts             | --                                              | ✅ 35 E2E tests                                 | ✅ Covered    |
| Scope classifier            | ✅ scope-classifier.test.ts                  | --                                              | --                                              | ✅ Covered    |
| Loop detection              | ✅ loop-detection.test.ts                    | --                                              | --                                              | ✅ Covered    |
| Content router              | ✅ content-router.test.ts                    | --                                              | --                                              | ✅ Covered    |
| Specialist executor         | ✅ specialist-executor.test.ts               | --                                              | --                                              | ✅ Covered    |
| Multi-turn executor         | ✅ multi-turn-executor.test.ts               | --                                              | --                                              | ✅ Covered    |
| Executor guards             | ✅ executor-guards\*.test.ts                 | --                                              | --                                              | ✅ Covered    |
| Tool validator              | ✅ tool-validator.test.ts                    | --                                              | --                                              | ✅ Covered    |
| SSE streaming               | ✅ sse-streaming.test.ts                     | --                                              | --                                              | ✅ Covered    |
| Specification schemas       | ✅ specification.test.ts                     | --                                              | --                                              | ✅ Covered    |
| Blueprint schemas           | ✅ blueprint.test.ts                         | --                                              | --                                              | ✅ Covered    |
| SSE event schemas           | ✅ sse-events.test.ts                        | --                                              | --                                              | ✅ Covered    |
| Message request schemas     | ✅ message-request.test.ts                   | --                                              | --                                              | ✅ Covered    |
| Tool definitions            | ✅ tool-definitions.test.ts                  | --                                              | --                                              | ✅ Covered    |
| In-project tool schemas     | ✅ in-project-types.test.ts                  | --                                              | --                                              | ✅ Covered    |
| Resume summary              | ✅ resume-summary.test.ts                    | --                                              | --                                              | ✅ Covered    |
| Prompt composition          | ✅ prompts.test.ts                           | --                                              | --                                              | ✅ Covered    |
| Error classes               | ✅ errors.test.ts                            | --                                              | --                                              | ✅ Covered    |
| Tool extractor              | ✅ tool-extractor.test.ts                    | --                                              | --                                              | ✅ Covered    |
| Mock project generator      | ✅ mock-project-generator.test.ts            | --                                              | --                                              | ✅ Covered    |
| Session CRUD routes         | --                                           | ✅ arch-ai-sessions-\*.test.ts                  | ✅ arch-ai-sessions.e2e.test.ts                 | ✅ Covered    |
| Message route (validation)  | --                                           | ✅ arch-ai-message-route.test.ts                | ✅ arch-ai-message-streaming.e2e.test.ts        | ✅ Covered    |
| Message route (streaming)   | --                                           | ✅ arch-ai-message-streaming.test.ts            | ✅ 13 E2E with mock LLM                         | Partial (29%) |
| Journal route               | --                                           | ✅ arch-ai-sessions-journal.test.ts             | ✅ 4 E2E tests                                  | ✅ Covered    |
| LLM resolution              | --                                           | ✅ arch-ai-llm-resolution.test.ts (15)          | --                                              | ✅ Covered    |
| Constraint coaching         | --                                           | ✅ constraint-coaching-integration.test.ts (35) | ✅ arch-ai-constraint-coaching.e2e.test.ts (10) | ✅ BETA       |
| Page context                | --                                           | ✅ page-context-integration.test.ts (32)        | ✅ arch-ai-page-context.e2e.test.ts (7)         | ✅ BETA       |
| Multimodality               | --                                           | ✅ b03-multimodality-integration.test.ts (19)   | ✅ arch-ai-multimodality.e2e.test.ts (10)       | ✅ BETA       |
| Ask-user widgets (5 types)  | ✅ arch-ai-ask-user-widgets.test.tsx (36)    | --                                              | --                                              | ✅ Covered    |
| QACard                      | ✅ arch-ai-qa-card.test.tsx (9)              | --                                              | --                                              | ✅ Covered    |
| ThinkingIndicator           | ✅ arch-ai-thinking-indicator.test.tsx (6)   | --                                              | --                                              | ✅ Covered    |
| ConversationDivider         | ✅ arch-ai-conversation-divider.test.tsx (5) | --                                              | --                                              | ✅ Covered    |
| arch-ai-store               | ✅ arch-ai-store-v03.test.ts (38)            | --                                              | --                                              | ✅ Covered    |
| ArchAIChatPanel             | ✅ 2 tests (minimal)                         | --                                              | --                                              | ❌ Needs more |
| DynamicTabRenderer          | --                                           | --                                              | --                                              | ❌ Not tested |
| TopologyViewer              | --                                           | --                                              | --                                              | ❌ Not tested |
| ArtifactPanel               | --                                           | --                                              | --                                              | ❌ Not tested |

## 2. Test Files (v0.3)

### Core Engine (`packages/arch-ai/src/__tests__/`)

| File                               | Type | Tests | Focus                                                  |
| ---------------------------------- | ---- | ----- | ------------------------------------------------------ |
| phase-machine.test.ts              | Unit | 24    | Phase transitions, exit criteria, specialist routing   |
| scope-classifier.test.ts           | Unit | 22    | LARGE/SMALL mutation classification                    |
| session-state-machine.test.ts      | Unit | 24    | Valid/invalid state transitions, state sets            |
| loop-detection.test.ts             | Unit | 10    | Threshold, reset, independent tracking                 |
| content-router.test.ts             | Unit | 24    | IN_PROJECT specialist routing                          |
| specialist-executor.test.ts        | Unit | 20    | Text streaming, client/server tools, display           |
| multi-turn-executor.test.ts        | Unit | 5     | Single-turn, multi-turn, guards                        |
| executor-guards.test.ts + extended | Unit | 20    | TTFT, stall, timeout, maxTurns, executeWithTimeout     |
| tool-validator.test.ts             | Unit | 5     | Zod validation, defaults, forward compat               |
| specification.test.ts              | Unit | 17    | Schemas, defaults, canExitInterview                    |
| blueprint.test.ts                  | Unit | 23    | Topology/Blueprint schemas, topological sort           |
| tools.test.ts                      | Unit | 20    | Phase-tool mapping, client-side tools                  |
| errors.test.ts                     | Unit | 9     | All 7 error classes                                    |
| sse-events.test.ts                 | Unit | 18    | All 12 SSE event types                                 |
| message-request.test.ts            | Unit | 14    | All 5 request types                                    |
| sse-streaming.test.ts              | Unit | 26    | Serializer, parser, chunking, roundtrips               |
| prompts.test.ts                    | Unit | 12    | System prompt composition                              |
| resume-summary.test.ts             | Unit | 18    | All 4 phases, notes, pending interaction               |
| tool-definitions.test.ts           | Unit | 7     | LLM tool JSON schemas                                  |
| in-project-types.test.ts           | Unit | 22    | Constants, display, AuthContext, ChainContext, schemas |
| tool-extractor.test.ts             | Unit | 10    | YAML list/nested, topology fallback                    |
| mock-project-generator.test.ts     | Unit | 8     | OpenAPI, files, kebab paths, empty                     |
| coverage-gaps.test.ts              | Unit | 23    | generateMockData branches, parser edges                |

### Studio (`apps/studio/src/__tests__/arch-ai/`)

| File                                    | Type        | Tests | Focus                           |
| --------------------------------------- | ----------- | ----- | ------------------------------- |
| arch-ai-sessions-create.test.ts         | Integration | 6     | POST /sessions                  |
| arch-ai-sessions-current.test.ts        | Integration | 7     | GET /sessions/current           |
| arch-ai-sessions-id.test.ts             | Integration | 7     | GET/DELETE /sessions/:id        |
| arch-ai-sessions-archive.test.ts        | Integration | 5     | POST /sessions/:id/archive      |
| arch-ai-sessions-journal.test.ts        | Integration | 6     | GET /sessions/:id/journal       |
| arch-ai-message-route.test.ts           | Integration | 13    | POST /message validation        |
| arch-ai-message-streaming.test.ts       | Integration | 8     | SSE streaming paths             |
| arch-ai-llm-resolution.test.ts          | Integration | 15    | LLM credential resolution       |
| constraint-coaching-integration.test.ts | Integration | 35    | Constraint coaching sub-feature |
| page-context-integration.test.ts        | Integration | 32    | Page context sub-feature        |
| b03-multimodality-integration.test.ts   | Integration | 19    | Multimodality sub-feature       |
| arch-ai-ask-user-widgets.test.tsx       | Component   | 36    | 5 widget types + renderer       |
| arch-ai-qa-card.test.tsx                | Component   | 9     | All answer types                |
| arch-ai-thinking-indicator.test.tsx     | Component   | 6     | Running/complete/error          |
| arch-ai-conversation-divider.test.tsx   | Component   | 5     | Status indicators               |
| arch-ai-store-v03.test.ts               | Store       | 38    | Tabs, files, journal, reset     |

### E2E (`apps/studio/src/__tests__/e2e/`)

| File                                    | Tests | Infrastructure                                                    |
| --------------------------------------- | ----- | ----------------------------------------------------------------- |
| arch-ai-sessions.e2e.test.ts            | 35    | MongoMemoryServer, real auth (dev-login JWT), real route handlers |
| arch-ai-message-streaming.e2e.test.ts   | 13    | + Mock OpenAI-compatible LLM server                               |
| arch-ai-constraint-coaching.e2e.test.ts | 10    | Constraint coaching E2E with real middleware chain                |
| arch-ai-page-context.e2e.test.ts        | 7     | Page context awareness E2E                                        |
| arch-ai-multimodality.e2e.test.ts       | 10    | Multimodality E2E with real middleware chain                      |

## 3. E2E Test Scenarios

### E2E-1: Chat Conversation Round-Trip

**Objective**: Verify that sending a message through the Arch chat API returns a valid response and updates the UI.

**Preconditions**: Arch is configured with a valid LLM model and API key.

**Steps**:

1. `POST /api/arch/status` -- verify `configured: true`
2. `POST /api/arch/chat` with `{ stage: "build", messages: [{ role: "user", content: "Add error handling to the payment tool" }], context: { page: "agent-editor", agentId: "agent-1" } }`
3. Assert response has `message` (non-empty string)
4. Assert response has `type` field (one of: message, error, plan, proposal, system)
5. If `suggestions` present, assert each has `id`, `label`, `category`, `prompt`
6. If `toolsUsed` present, assert array of strings
7. Assert HTTP 200 status

**Expected Result**: Valid `ArchChatResponse` with message content.

### E2E-2: Workflow State Machine -- Propose and Apply Diff

**Objective**: Verify the full workflow cycle: idle -> contextualizing -> responding -> confirming -> executing.

**Preconditions**: Project exists with at least one agent. Arch configured.

**Steps**:

1. `POST /api/arch/chat` with `{ stage: "edit", messages: [{ role: "user", content: "Add a greeting message" }], context: { page: "agent-editor", agentId: "agent-1", agentName: "TestAgent" } }`
2. Assert response includes `state` field
3. If state is `confirming`, assert `proposal` is present with `scope` (small/large)
4. For small scope, assert `proposal.diffs` is an array of `ArchSectionDiff`
5. Send follow-up with `userAction: "confirm"` and `workflowState: "confirming"`
6. Assert response state transitions to `executing` or `idle`
7. If `validation` present, assert `valid` is boolean
8. Verify agent DSL was updated via `GET /api/projects/:projectId/agents/:agentName/dsl`

**Expected Result**: Full workflow cycle completes; DSL is updated on confirm.

### E2E-3: Context-Aware Suggestion Chips

**Objective**: Verify that suggestion chips change based on the current section context.

**Preconditions**: Project with agents exists.

**Steps**:

1. `POST /api/arch/chat` with context `{ page: "agent-editor", editingStage: "agents" }` and `editContext: { section: "TOOLS", agentId: "agent-1", currentContent: {}, siblingContext: { mode: "scripted", goal: "Test", toolNames: ["tool1"], gatherFieldNames: [], flowStepNames: [] } }`
2. Assert response `suggestions` includes tool-specific chips (e.g., ids containing "add-tool" or "configure-auth")
3. Repeat with `section: "FLOW"` and assert flow-specific chips (e.g., "add-step", "add-digression")
4. Repeat with `section: "RULES"` and assert rules-specific chips (e.g., "add-guardrail", "add-constraint")

**Expected Result**: Suggestions are section-appropriate.

### E2E-4: Quick Generate Pipeline (Topology through Agents)

**Objective**: Verify the multi-stage generation pipeline produces valid artifacts.

**Steps**:

1. `POST /api/arch/generate` with `{ type: "topology", brief: { domain: "healthcare", problemStatement: "Patient support system", useCases: [{ label: "Appointments", enabled: true }], targetUsers: ["Patients"], channels: ["Chat"], tone: "Professional", constraints: [], estimatedAgents: "3", complexity: "medium", uploadedFiles: [] } }`
2. Assert response has `topology` with `nodes` array (each with `id`, `name`, `type`, `executionMode`) and `edges` array
3. Assert at least one node has `isEntry: true`
4. `POST /api/arch/generate` with `{ type: "agent_specs", brief: <same>, topology: <from step 2> }`
5. Assert `agentSpecs` array, each with `name`, `type`, `executionMode`, `tools`, `gatherFields`
6. `POST /api/arch/generate` with `{ type: "agents", brief: <same>, topology: <from step 2>, agentSpecs: <from step 4> }`
7. Assert `agents` array, each with `ablContent` (non-empty string), `name`, `executionMode`

**Expected Result**: Pipeline produces valid topology, specs, and ABL content.

### E2E-5: Conversation Persistence Round-Trip

**Objective**: Verify conversations are saved to and loaded from MongoDB.

**Steps**:

1. `POST /api/arch/chat` with `projectId: "test-project"` to generate a conversation message
2. Save conversation via internal persistence mechanism (the store's `saveToServer`)
3. `GET /api/arch/conversations/:projectId` (or equivalent) to load conversation
4. Assert loaded messages match what was saved (content, role, timestamp)
5. `DELETE /api/arch/conversations/:projectId` to clean up
6. Verify load returns empty after delete

**Expected Result**: Conversation CRUD works end-to-end.

### E2E-6: Admin Configuration CRUD

**Objective**: Verify admin can configure Arch LLM settings.

**Steps**:

1. `GET /api/arch/status` -- note current state
2. `GET /api/arch/models` -- assert returns `{ recommended: [...], other: [...] }` with model objects
3. `PUT /api/arch/config` with `{ modelId: "gpt-4o", provider: "openai", temperature: 0.7, maxTokensChat: 4096, maxTokensGenerate: 8192, rateLimitRpm: 60, rateLimitRph: 1000 }`
4. Assert HTTP 200
5. `GET /api/arch/config` -- assert updated values match
6. `POST /api/arch/validate-key` with `{ provider: "openai", apiKey: "test-key" }` -- assert returns `{ valid, message }`
7. `GET /api/arch/status` -- assert reflects configuration change

**Expected Result**: Config CRUD cycle works; status reflects changes.

### E2E-7: Deploy Mocks

**Objective**: Verify mock project generation and deployment endpoint.

**Steps**:

1. `POST /api/arch/generate` with `{ type: "openapi", brief: <brief>, agents: <agents> }`
2. Assert `openapi` response has `openapi`, `info`, `paths`
3. `POST /api/arch/generate` with `{ type: "mock_project", brief: <brief>, openapi: <from step 2> }`
4. Assert `mockProject` has `projectName` (string) and `files` (array of `{ path, content }`)
5. `POST /api/arch/deploy-mocks` with the mock project bundle
6. Assert response has deployment URL or error message

**Expected Result**: Mock project is generated and deployment endpoint responds.

## 4. Integration Test Scenarios

### INT-1: Arch Store -- Conversation Compaction

**Objective**: Verify that conversations exceeding 30 messages are compacted with a summary preamble.

**Steps**:

1. Create an arch store instance
2. Add 35 messages to a conversation
3. Trigger persistence (via Zustand persist partialize)
4. Assert persisted conversations have exactly 31 messages (1 summary + 30 recent)
5. Assert first message has `id: "summary-preamble"` and role `"arch"`
6. Assert summary content includes topic excerpts from oldest messages

**Expected Result**: Compaction preserves recent messages and summarizes old ones.

### INT-2: Arch Store -- Heavy Payload Stripping

**Objective**: Verify that topology, diff, and code block payloads are stripped before persistence.

**Steps**:

1. Add messages with `topology`, `diff`, `briefUpdates`, `codeBlocks`, and `isStreaming` fields
2. Trigger persistence
3. Assert persisted messages lack `topology`, `diff`, `briefUpdates`, `codeBlocks`, `isStreaming`
4. Assert `content`, `role`, `id`, `timestamp` are preserved

**Expected Result**: Heavy payloads removed; lightweight fields preserved.

### INT-3: Lifecycle Store -- Onboarding Phase Transitions

**Objective**: Verify phase transitions and state management during onboarding wizard.

**Steps**:

1. Call `startOnboarding()` -- assert `isOnboardingActive: true`, `onboardingPhase: "welcome"`
2. Call `setOnboardingPhase("interview")` -- assert phase updated
3. Call `updateBrief({ domain: "healthcare" })` -- assert brief.domain updated
4. Call `setTopology(testTopology)` -- assert topology stored
5. Call `setGeneratedAgents(testAgents)` -- assert agents stored
6. Call `advanceReview()` through all 3 tabs -- assert `selectAllReviewed` returns true
7. Call `exitOnboarding()` -- assert reset to initial state

**Expected Result**: All lifecycle transitions work correctly.

### INT-4: Arch Store -- Workflow State Machine Transitions

**Objective**: Verify workflow state machine transitions and proposal handling.

**Steps**:

1. Assert initial state is `idle` with `send` action
2. Call `handleWorkflowResponse({ state: "contextualizing", actions: [], message: "Reading..." })`
3. Assert `workflowState` is `contextualizing`
4. Call `handleWorkflowResponse({ state: "confirming", actions: [{ type: "confirm" }, { type: "reject" }], proposal: { scope: "small", sections_affected: ["TOOLS"], diffs: [...] }, message: "Here's my proposal" })`
5. Assert `workflowState` is `confirming`, `currentProposal` is set, `allowedActions` has confirm and reject
6. Call `resetWorkflow()` -- assert back to `idle` with `send` action, proposal cleared

**Expected Result**: State machine transitions are correct and consistent.

### INT-5: Config Store -- Fetch and Update Cycle

**Objective**: Verify config store fetches, updates, and validates correctly.

**Steps**:

1. Mock `/api/arch/status` to return `{ configured: true, model: "gpt-4o", provider: "openai", source: "tenant" }`
2. Call `fetchStatus()` -- assert `status.configured` is true
3. Mock `/api/arch/models` to return model list
4. Call `fetchModels()` -- assert `models.recommended` has entries
5. Mock `/api/arch/config` PUT to return 200
6. Call `updateConfig({ temperature: 0.5 })` -- assert returns true
7. Mock `/api/arch/validate-key` to return `{ valid: true, message: "OK" }`
8. Call `validateApiKey("openai", "sk-test")` -- assert `keyValidation.valid` is true

**Expected Result**: Store correctly manages async operations.

### INT-6: Context Navigation -- Agent-Scoped Conversations

**Objective**: Verify that switching agents switches the active conversation.

**Steps**:

1. Set context `{ projectId: "proj-1", agentId: "agent-a", page: "agent-editor" }`
2. Add messages to conversation
3. Set context `{ projectId: "proj-1", agentId: "agent-b", page: "agent-editor" }`
4. Assert `activeConversationId` changed to `proj-1/agent-b`
5. Assert previous conversation messages are preserved at `proj-1/agent-a`
6. Assert workflow state reset to `idle` on context change

**Expected Result**: Conversations are scoped per agent; context changes reset workflow.

### INT-7: Diff Application -- DSL Persistence

**Objective**: Verify that applying a diff reconstructs DSL and persists via PUT API.

**Steps**:

1. Mock `PUT /api/projects/:projectId/agents/:agentName/dsl` endpoint
2. Add a diff to pendingDiffs with lines (added, removed, unchanged)
3. Call `applyDiff(diffId)`
4. Assert PUT was called with reconstructed DSL (unchanged + added lines, removed lines excluded)
5. Assert diff status changed to `applied`
6. Assert `lastAgentEditTimestamp` was updated

**Expected Result**: Diff application correctly reconstructs DSL and persists.

## 5. Unit Test Coverage Requirements

### Critical Paths (Must Have)

| Area                   | Test Focus                                               | Min Cases |
| ---------------------- | -------------------------------------------------------- | --------- |
| Message compaction     | Boundary at 30 messages, summary content, preamble shape | 5         |
| Workflow transitions   | All 5 states, invalid transitions rejected               | 8         |
| Suggestion mapping     | All 8 sections + DEFAULT, correct chips per section      | 9         |
| Brief completeness     | 0%, partial, 100% calculation                            | 3         |
| Conversation eviction  | Max 10 conversations, oldest evicted                     | 3         |
| Payload stripping      | All 5 heavy fields removed                               | 2         |
| Project ID extraction  | `proj-{id}` parsing, `new` returns null                  | 3         |
| Review tab advancement | All 3 tabs, back navigation, selectAllReviewed           | 5         |

### Type Safety

| Area              | Test Focus                                      | Min Cases |
| ----------------- | ----------------------------------------------- | --------- |
| ArchMessage shape | All optional fields, type discriminants         | 4         |
| ArchChatRequest   | Required vs optional fields, context shape      | 3         |
| ArchChatResponse  | All response variants (message, plan, proposal) | 4         |
| TopologyData      | Nodes with all fields, edges with conditions    | 3         |
| AgentSpec         | Full spec with tools, gather, flow, constraints | 2         |
| WorkflowState     | Valid states, action types                      | 3         |

## 6. Test Environment Requirements

| Requirement   | Details                                                    |
| ------------- | ---------------------------------------------------------- |
| LLM API       | Real or mocked LLM endpoint for chat/generate tests        |
| MongoDB       | Required for conversation persistence E2E tests            |
| Auth          | Tenant context required for all API endpoints              |
| Studio Server | Next.js dev server running for API route tests             |
| Vitest        | Test runner with React Testing Library for component tests |

## 7. Coverage Gaps & Recommendations

| Gap                                            | Priority | Recommendation                                     |
| ---------------------------------------------- | -------- | -------------------------------------------------- |
| No E2E tests exercising real LLM responses     | P1       | Add smoke tests with real (or reliably mocked) LLM |
| Conversation persistence E2E missing           | P1       | Add MongoDB round-trip test                        |
| Deploy mocks endpoint untested E2E             | P2       | Add Vercel deployment smoke test                   |
| Multi-agent topology generation E2E            | P1       | Test full pipeline from brief to compiled agents   |
| Rate limiting behavior                         | P2       | Test rate limit enforcement and error messages     |
| Error recovery (LLM timeout, invalid response) | P1       | Test graceful degradation paths                    |
| Accessibility (screen reader, keyboard nav)    | P2       | Add axe-core tests for chat interface              |

---

_Test spec generated 2026-03-23. Updated 2026-04-06 for BETA status. 3 sub-features (Constraint Coaching, Page Context, Multimodality) at BETA with full integration + E2E coverage. Grounded in existing test files at `apps/studio/src/__tests__/arch-*.test.{ts,tsx}`._
