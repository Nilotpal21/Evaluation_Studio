# Test Specification: Page Context Awareness

**Feature Spec**: [`docs/features/page-context-awareness.md`](../features/page-context-awareness.md)
**HLD**: N/A (not yet generated)
**LLD**: N/A (not yet generated)
**Status**: BETA
**Last Updated**: 2026-04-06

---

## 1. Coverage Matrix

| FR   | Description                            | Unit | Integration | E2E | Manual | Status  |
| ---- | -------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1 | buildPageContext() function            | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-2 | Context sources (7 page types)         | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-3 | pageContext in MessageRequest          | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-4 | System prompt injection                | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-5 | Token budget enforcement               | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-6 | Reactive context updates on navigation | ❌   | ✅          | ✅  | ❌     | PASSING |
| FR-7 | Graceful missing context handling      | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-8 | No sensitive data in context           | ✅   | ✅          | ✅  | ❌     | PASSING |

---

## 2. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests exercise the real Arch AI pipeline through HTTP. No mocks, no direct DB access, no stubbed servers.

### E2E-1: Agent editor context — "fix this" resolves to correct agent

- **Preconditions**: Project with 3 agents (triage, billing, returns). User on billing_agent editor page. Arch IN_PROJECT session active.
- **Steps**:
  1. Navigate to `/projects/:id/agents/billing_agent` in Studio (Playwright)
  2. Open Arch overlay
  3. `POST /api/arch-ai/message` with `{ text: "fix the handoff in this agent", sessionId: '<id>', pageContext: { area: 'project', page: 'agents', entity: { type: 'agent', id: 'billing_agent', name: 'billing_agent', metadata: { compileStatus: 'pass', toolCount: 4 } } } }`
  4. Parse SSE response
- **Expected Result**:
  - Response references `billing_agent` by name without asking "which agent?"
  - No clarification message like "Which agent's handoff would you like me to fix?"
  - Response content is specific to billing_agent's HANDOFF section
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: Response only references agents from this project

### E2E-2: Trace viewer context — "explain this error" resolves to specific trace

- **Preconditions**: Project with at least 1 trace containing an error event. User on trace viewer page.
- **Steps**:
  1. Navigate to `/projects/:id/sessions` → select a session with error traces
  2. Open Arch overlay
  3. `POST /api/arch-ai/message` with `{ text: "explain this error", sessionId: '<id>', pageContext: { area: 'project', page: 'sessions', entity: { type: 'trace', id: 'trace-abc123', metadata: { status: 'error', errorSummary: 'Tool timeout on lookup_order at step 3', agentName: 'billing_agent' } } } }`
  4. Parse SSE response
- **Expected Result**:
  - Response references trace `trace-abc123` specifically
  - Response analyzes the tool timeout error, not a generic error explanation
  - Response mentions `lookup_order` tool and step 3
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: Trace data from other projects is never referenced

### E2E-3: Navigation context update between pages

- **Preconditions**: Active IN_PROJECT session. User starts on agent editor, navigates to sessions page.
- **Steps**:
  1. `POST /api/arch-ai/message` with `{ text: "describe this agent", pageContext: { area: 'project', page: 'agents', entity: { type: 'agent', id: 'billing_agent' } } }`
  2. Verify response references billing_agent
  3. `POST /api/arch-ai/message` with `{ text: "how many active sessions?", pageContext: { area: 'project', page: 'sessions', summary: { activeSessions: 12, totalSessions: 45 } } }`
  4. Verify response references session data, not agent data
- **Expected Result**:
  - First response: about billing_agent
  - Second response: about sessions (12 active, 45 total) — context updated correctly
  - No confusion between the two contexts
- **Auth Context**: Same session, same user
- **Isolation Check**: N/A (single project)

### E2E-4: Settings page — no sensitive data in context

- **Preconditions**: User on project settings → API keys page. Arch overlay open.
- **Steps**:
  1. `POST /api/arch-ai/message` with `{ text: "help me configure API keys", pageContext: { area: 'project', page: 'settings-api-keys', summary: { apiKeyCount: 3, settingsTab: 'api-keys' } } }`
  2. Parse the full SSE response and the server request log
- **Expected Result**:
  - `pageContext` does NOT contain any actual API key values (only count: 3)
  - Response discusses API key configuration generically
  - No raw `abl_*` key strings in the response or context
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: Settings data from other tenants never referenced

### E2E-5: Missing context fallback — works without entity data

- **Preconditions**: User on project list page (no specific entity context).
- **Steps**:
  1. `POST /api/arch-ai/message` with `{ text: "how do I create an agent?", pageContext: { area: 'projects', page: 'overview' } }`
  2. Parse SSE response
- **Expected Result**:
  - Response provides helpful answer about agent creation
  - No error from missing `entity` field in pageContext
  - No "I can't determine which project you're in" type error
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A

### E2E-6: Topology view with selected node

- **Preconditions**: Project with topology graph. User has selected the `triage_agent` node.
- **Steps**:
  1. `POST /api/arch-ai/message` with `{ text: "add a tool to this agent", pageContext: { area: 'project', page: 'agents', entity: { type: 'topology_node', id: 'triage_agent', name: 'triage_agent', metadata: { agentType: 'supervisor', edgeCount: 3 } } } }`
  2. Parse SSE response
- **Expected Result**:
  - Response addresses adding a tool to `triage_agent` specifically
  - No "which agent?" clarification needed
  - Response is aware that triage_agent is a supervisor with 3 edges
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: Only topology data from this project

### E2E-7: Dashboard KPI context

- **Preconditions**: User on project dashboard page with visible KPIs.
- **Steps**:
  1. `POST /api/arch-ai/message` with `{ text: "how are my agents doing?", pageContext: { area: 'project', page: 'dashboard', summary: { activeAgents: 4, errorRate: 0.12, avgLatency: 2.8, activeSessions: 150 } } }`
  2. Parse SSE response
- **Expected Result**:
  - Response references actual KPI data: "4 active agents, 12% error rate, 2.8s avg latency"
  - Response identifies the high error rate (12%) as concerning
  - Response is data-driven, not generic "your agents are doing fine"
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-1`
- **Isolation Check**: KPI data from other projects never referenced

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: buildPageContext() for agent editor page

- **Boundary**: `buildPageContext()` → navigation-store + project-store (Zustand stores)
- **Setup**: Set navigation store: `{ area: 'project', page: 'agents' }`, URL params: `agentName=billing_agent`, project store: `{ agents: [{ name: 'billing_agent', type: 'specialist', compileStatus: 'pass', tools: ['t1','t2','t3'] }] }`
- **Steps**:
  1. Call `buildPageContext()`
  2. Verify result.area === 'project'
  3. Verify result.page === 'agents'
  4. Verify result.entity.type === 'agent'
  5. Verify result.entity.name === 'billing_agent'
  6. Verify result.entity.metadata includes compileStatus and toolCount
- **Expected Result**: Full PageContext with agent entity data
- **Failure Mode**: If store read fails, returns `{ area: 'project', page: 'agents' }` only

### INT-2: System prompt injection at correct position

- **Boundary**: `composeSystemPrompt()` → PageContext formatting
- **Setup**: System prompt template with specialist identity, PageContext with agent entity
- **Steps**:
  1. Call `composeSystemPrompt({ specialistId: 'abl-expert', pageContext: { area: 'project', page: 'agents', entity: { type: 'agent', id: 'billing', name: 'billing_agent' } } })`
  2. Parse the resulting prompt string
  3. Verify `## Current Context` section exists
  4. Verify it appears AFTER specialist identity section
  5. Verify it appears BEFORE conversation history
- **Expected Result**: Context section correctly positioned in prompt with agent name and type
- **Failure Mode**: If pageContext is null/undefined, no `## Current Context` section (no error)

### INT-3: Token budget enforcement with large context

- **Boundary**: `buildPageContext()` → token budget logic
- **Setup**: Topology with 20 agents, each with 5 tools and descriptions
- **Steps**:
  1. Set topology store with full 20-agent graph
  2. Call `buildPageContext()` with `page: 'agents'` (topology view)
  3. Measure the serialized output token count
  4. Verify output is under 2000 tokens
- **Expected Result**: Context truncated — agent names present but metadata trimmed. Under 2K token budget.
- **Failure Mode**: If budget is exceeded, truncation removes entity.metadata first, then summary data

### INT-4: MessageRequest schema validation with pageContext

- **Boundary**: `MessageRequestSchema` (Zod) → pageContext field
- **Setup**: Various MessageRequest payloads
- **Steps**:
  1. Valid: `{ text: 'hello', pageContext: { area: 'project', page: 'agents' } }` → passes
  2. Valid: `{ text: 'hello' }` (no pageContext) → passes (field is optional)
  3. Invalid: `{ text: 'hello', pageContext: { area: 123 } }` → fails (area must be string)
  4. Invalid: `{ text: 'hello', pageContext: 'not-an-object' }` → fails
- **Expected Result**: Schema accepts valid contexts, rejects malformed, allows missing
- **Failure Mode**: N/A — schema validation is deterministic

### INT-5: Sensitive data redaction on settings pages

- **Boundary**: `buildPageContext()` → settings page handling
- **Setup**: Navigation to settings-api-keys page, project store has API key data
- **Steps**:
  1. Set navigation store to `{ area: 'project', page: 'settings-api-keys' }`
  2. Call `buildPageContext()`
  3. Verify result does NOT contain any `abl_*` key strings
  4. Verify result does NOT contain credential values
  5. Verify result includes only `{ settingsTab: 'api-keys', apiKeyCount: N }`
- **Expected Result**: Only metadata (count, tab name), never actual key values
- **Failure Mode**: If redaction fails, return empty summary for settings pages (fail-safe)

### INT-6: Empty store graceful degradation

- **Boundary**: `buildPageContext()` → Zustand store.getState()
- **Setup**: Navigation store initialized but project store empty (no project loaded)
- **Steps**:
  1. Call `buildPageContext()` with empty project store
  2. Verify result has `area` and `page` but no `entity` or `project`
  3. Verify no errors thrown
- **Expected Result**: Partial context returned; specialist works with area/page only
- **Failure Mode**: N/A — graceful degradation is the expected behavior

### INT-7: Multiple store reads are synchronous (no race conditions)

- **Boundary**: `buildPageContext()` → multiple store.getState() calls
- **Setup**: Navigation and project stores both populated
- **Steps**:
  1. Call `buildPageContext()` 100 times rapidly
  2. Verify all results are consistent (no partial reads from mid-update stores)
  3. Verify no errors from concurrent getState() calls
- **Expected Result**: All 100 calls return valid, consistent PageContext objects
- **Failure Mode**: N/A — Zustand getState() is synchronous

---

## 4. Unit Test Scenarios

### UT-1: PageContext type construction

- **Module**: `PageContext` type and builder
- **Input**: Various area/page/entity combinations
- **Expected Output**: Valid PageContext objects matching TypeScript interface

### UT-2: Context extraction per page type

- **Module**: `buildPageContext()` — page-specific extractors
- **Input**: 7 page types (agent, trace, topology, sessions, dashboard, settings, guardrails)
- **Expected Output**: Correct entity type and metadata for each page

### UT-3: Token counting accuracy

- **Module**: Token budget enforcement
- **Input**: Known strings with measurable token counts
- **Expected Output**: Accurate token estimation within 10% of actual

### UT-4: URL parameter parsing for entity IDs

- **Module**: `buildPageContext()` — URL parsing
- **Input**: URLs like `/projects/abc/agents/billing_agent`, `/projects/abc/sessions/trace-123`
- **Expected Output**: Correct entity ID extraction from path segments

### UT-5: Null/undefined field handling

- **Module**: `buildPageContext()`
- **Input**: Partially populated stores (some fields null/undefined)
- **Expected Output**: Valid PageContext with available fields, no null property access errors

---

## 5. Security & Isolation Tests

- [x] **No API keys in context**: pageContext from settings-api-keys page never contains raw key values
  - Seed: Project with 3 API keys
  - Test: Serialize pageContext → grep for `abl_` prefix → zero matches
- [x] **No credentials in context**: pageContext from settings-models page never contains provider credentials
  - Seed: Tenant with 2 model connections (Anthropic, OpenAI)
  - Test: Serialize pageContext → grep for `sk-`, `key`, `secret` → zero matches
- [x] **No conversation content**: pageContext from sessions page never contains message text
  - Seed: Session with 10 messages
  - Test: pageContext.summary has sessionCount only, no message content
- [x] **Cross-project isolation**: pageContext.project.id matches the requested project only
  - Seed: User has access to 2 projects
  - Test: pageContext from project-1 never references project-2 agent names
- [x] **Cross-tenant isolation**: pageContext never includes other tenant's data
  - Test: Tenant-1's navigation to agent page never resolves tenant-2's agents
- [x] **Missing auth returns 401**: `POST /api/arch-ai/message` with pageContext but no auth → 401
- [x] **Server-side validation**: Malformed pageContext (oversized, wrong types) rejected with 400

---

## 6. Performance & Load Tests

| Scenario                                 | Target | How Measured                                |
| ---------------------------------------- | ------ | ------------------------------------------- |
| buildPageContext() latency               | <5ms   | Time from call to return (store reads only) |
| System prompt with context serialization | <10ms  | composeSystemPrompt() with full context     |
| pageContext payload size                 | <3KB   | Serialized JSON size in MessageRequest      |
| 100 rapid context builds (no race)       | <500ms | 100 sequential calls total duration         |

---

## 7. Test Infrastructure

- **Required services**: Studio dev server (Next.js), MongoDB (for sessions)
- **Data seeding**:
  - Projects with agents, traces, sessions, KPI data
  - Settings pages with API keys and model configurations (to test redaction)
  - Topology graphs with selectable nodes
- **Environment variables**: Standard Studio dev env. No new vars.
- **UI testing**: Playwright for navigation-based E2E tests (navigate to page → open overlay → send message)
- **CI configuration**: Runs as part of `apps/studio` test suite.

---

## 8. Test File Mapping

| Test File                                                            | Type        | Covers                            |
| -------------------------------------------------------------------- | ----------- | --------------------------------- |
| `apps/studio/src/__tests__/arch-ai/build-page-context.test.ts`       | unit        | FR-1, FR-2, FR-5, FR-7, UT-1–UT-5 |
| `apps/studio/src/__tests__/arch-ai/page-context-integration.test.ts` | integration | FR-3, FR-4, FR-8, INT-1–INT-7     |
| `apps/studio/src/__tests__/arch-ai/page-context-security.test.ts`    | unit        | FR-8, security checks             |
| `apps/studio/e2e/arch-ai-page-context.e2e.spec.ts`                   | e2e         | FR-6, E2E-1–E2E-7                 |

---

## 9. Open Testing Questions

1. Should E2E tests use Playwright to navigate Studio pages and inject real pageContext from the UI, or send pageContext directly in the HTTP request body? UI-driven is more realistic but slower.
2. How should token budget tests measure token count? Use tiktoken (OpenAI tokenizer) or a rough estimate (4 chars ≈ 1 token)?
3. For the topology view context (E2E-6), does the topology store expose the selected node ID in a way that `buildPageContext()` can read it? Need to verify the store API.
4. Should we test context behavior when the user has the Arch overlay open but navigates away from the project entirely (e.g., to admin page)?
5. How should dashboard KPI data be provided to pageContext — is it in a Zustand store or does it require a fresh API call? This affects whether it's a sync store read or async.
