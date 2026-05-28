# Feature: Page Context Awareness

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `customer experience`
**Package(s)**: `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/page-context-awareness.md](../testing/page-context-awareness.md)
**Last Updated**: 2026-04-05

---

## 1. Introduction / Overview

### Problem Statement

When a user opens the Arch overlay in IN_PROJECT mode from a specific Studio page (agent editor, trace viewer, topology graph, sessions list, dashboard), the system has no awareness of what the user is currently looking at. Every conversation starts cold — the user must explain "I'm looking at the billing agent" or "I see an error in the traces." This is 2-3 extra messages per interaction just to establish context.

Cursor, Claude Code, and similar tools automatically inject the current file, selection, and terminal context into every request. Arch should do the same — when a user is on the agent editor page viewing `billing_agent`, saying "fix this" should immediately work without explaining which agent.

### Goal Statement

Automatically detect and inject the user's current Studio page context into every Arch message so that the specialist knows what the user is looking at without asking. This makes IN_PROJECT interactions faster, smarter, and more natural.

### Summary

Page Context Awareness adds a `buildPageContext()` function that reads the current navigation state (from `navigation-store.ts`), active project data (from `project-store`), and page-specific state (selected agent, trace, topology node) to assemble a structured context object. This object is attached to every `POST /api/arch-ai/message` request as a `pageContext` field. The coordinator prepends the context as a `## Current Context` section in the system prompt so the specialist knows what the user is looking at.

The feature builds on existing infrastructure: the `NavigationStore` with structured `NavigationArea` and `ProjectPage` types (`apps/studio/src/store/navigation-store.ts`), the `useArchChat` hook (`apps/studio/src/hooks/useArchChat.ts`), and the message route (`apps/studio/src/app/api/arch-ai/message/route.ts`).

---

## 2. Scope

### Goals

- Build a `buildPageContext()` function that reads current navigation state and assembles structured context
- Attach `pageContext` to every `POST /api/arch-ai/message` request alongside the user's text
- Inject page context into the system prompt as a `## Current Context` section
- Support context from: agent editor, trace viewer, topology view, sessions page, dashboard, settings pages, guardrails config
- Enable smart defaults: "fix this" on an agent page knows which agent, "explain this error" on traces knows which trace
- Token-budget the context injection to avoid bloating the system prompt (max ~2K tokens)
- Make context transparent: specialist can reference the context silently or acknowledge it explicitly based on relevance

### Non-Goals (Out of Scope)

- Explicit `@mentions` for entity references — that's B57 (Quick Actions & Commands)
- Full agent ABL content injection into every message — context should be metadata, not full file contents
- Automatic actions based on context (e.g., auto-running health checks when landing on dashboard) — that's B04 (Enhanced In-Project)
- Cross-tab or cross-session context sharing
- Context from external pages or non-Studio surfaces

---

## 3. User Stories

1. As an **agent developer**, I want Arch to know I'm on the billing_agent editor page so that when I say "fix the handoff" it knows which agent I mean without asking.
2. As an **operator**, I want Arch to see the trace I'm viewing so that "explain this error" gives me analysis of the specific trace, not a generic answer.
3. As a **project owner**, I want Arch to know I'm on the dashboard so that "how are my agents doing?" answers with the actual KPI data visible on screen.
4. As an **agent developer**, I want Arch to know which topology node I've selected so that "add a tool to this agent" works without specifying which agent.
5. As an **agent developer**, I want the context to stay current as I navigate between pages so that Arch always knows where I am without me re-explaining.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a `buildPageContext()` function that reads the current `NavigationArea`, `ProjectPage`, and page-specific state to produce a structured `PageContext` object.
2. **FR-2**: The system must detect and include the following context sources:

   | Source            | Context Data                                           | Store Source                     |
   | ----------------- | ------------------------------------------------------ | -------------------------------- |
   | Agent editor      | `agentName`, agent type, compile status, tool count    | URL params + project agent store |
   | Trace viewer      | `traceId`, trace status, error summary, agent involved | URL params + trace panel state   |
   | Topology view     | Selected node/edge, topology structure summary         | Topology store selection state   |
   | Sessions page     | Active session count, selected session ID if any       | Sessions list state              |
   | Dashboard         | KPI summary (active sessions, error rate, latency)     | Dashboard data store             |
   | Settings page     | Current settings tab (models, API keys, guardrails)    | URL params                       |
   | Guardrails config | Active guardrail policy, violation summary             | Guardrails config state          |

3. **FR-3**: The system must attach the `pageContext` object to every message sent via `useArchChat.send()` as a new field in the `MessageRequest` payload.
4. **FR-4**: The server-side message route must extract `pageContext` from the request and inject it into the system prompt as a `## Current Context` section, positioned after the specialist identity but before conversation history.
5. **FR-5**: The system must enforce a token budget of ~2K tokens for the injected context. If the raw context exceeds this budget, it must be summarized (e.g., agent metadata without full ABL content, trace summary without full event list).
6. **FR-6**: The system must update `pageContext` reactively as the user navigates — if the user switches from the agent editor to the sessions page, the next message must include the updated context.
7. **FR-7**: The system must handle missing or unavailable context gracefully: if a store is empty or a page has no contextual data, the `pageContext` should include the navigation area and page name but no entity-specific data.
8. **FR-8**: The system must NOT include sensitive data in the page context: no raw API keys from the settings page, no raw credentials from model configuration, no session conversation content.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                  |
| -------------------------- | ------------ | ------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Context is project-scoped                              |
| Agent lifecycle            | PRIMARY      | Agent editor context is the most common context source |
| Customer experience        | PRIMARY      | Directly improves interaction quality and speed        |
| Integrations / channels    | NONE         | Studio-only feature                                    |
| Observability / tracing    | SECONDARY    | Trace viewer context enables trace-aware assistance    |
| Governance / controls      | NONE         | Context is read-only, no governance implications       |
| Enterprise / compliance    | NONE         | No compliance data in context; sensitive data excluded |
| Admin / operator workflows | SECONDARY    | Dashboard context enables operational awareness        |

### Related Feature Integration Matrix

| Related Feature                                                                   | Relationship Type | Why It Matters                                                       | Key Touchpoints                               | Current State               |
| --------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------- | --------------------------------------------- | --------------------------- |
| [Arch AI Assistant](arch-ai-assistant.md)                                         | extends           | B02 enhances how Arch receives context in IN_PROJECT mode            | `useArchChat`, message route, system prompt   | BETA — in-project exists    |
| [Agent Development (Studio)](agent-development-studio.md)                         | shares data with  | Agent editor provides the richest context source                     | Project agent store, agent metadata           | STABLE — editor exists      |
| [Tracing & Observability](tracing-observability.md)                               | shares data with  | Trace viewer provides trace-specific context                         | Trace panel state, trace events               | ALPHA — trace viewer exists |
| [Quick Actions & Commands (B57)](../arch/backlogs/B57-quick-actions-commands.md)  | extends           | B57's `@mentions` are the explicit version of B02's implicit context | `@agent_name` resolves to B02's context data  | PLANNED — not yet built     |
| [Enhanced In-Project Mode (B04)](../arch/backlogs/B04-enhanced-inproject-mode.md) | depends on        | B04's suggestion chips and workflows require page awareness          | `pageContext` feeds suggestion chip selection | PLANNED — not yet built     |

---

## 6. Design Considerations

### UX Patterns

**Transparent context — no visual indicator needed:** The context is injected silently. The specialist uses it when relevant and ignores it when not. No "I see you're on the billing agent page" preamble unless the user's question is ambiguous.

**Examples of context-aware responses:**

```
User (on billing_agent editor): "fix the handoff"
Before B02: "Which agent's handoff would you like me to fix?"
After B02:  "billing_agent's HANDOFF to escalation_agent has a missing
            condition. I'll add a fallback..."

User (on trace viewer, viewing trace abc123): "explain this error"
Before B02: "Which error would you like me to explain?"
After B02:  "Trace abc123 shows a tool timeout on lookup_order at step 3.
            The tool took 12s — the default timeout is 10s..."

User (on dashboard): "how are my agents doing?"
Before B02: Generic response about agent design best practices
After B02:  "Your project has 4 agents. billing_agent has a 12% error rate
            (up from 3% last week). All others are healthy. Want me to
            investigate billing_agent?"
```

### Context Object Shape

```typescript
interface PageContext {
  /** Current navigation area */
  area: NavigationArea; // 'project' | 'admin' | 'settings' | 'arch-v3'
  /** Current page within the area */
  page: ProjectPage | AdminPage | string;
  /** Project context (if in a project) */
  project?: {
    id: string;
    name: string;
    agentCount: number;
  };
  /** Entity-specific context */
  entity?: {
    type: 'agent' | 'trace' | 'session' | 'topology_node' | 'topology_edge';
    id: string;
    name?: string;
    metadata?: Record<string, unknown>; // agent type, compile status, error summary, etc.
  };
  /** Page-level summary data (dashboard KPIs, settings tab, etc.) */
  summary?: Record<string, unknown>;
}
```

---

## 7. Technical Considerations

### Architecture: Client-Side Context Collection, Server-Side Prompt Injection

`buildPageContext()` runs client-side in the browser, reading Zustand stores and URL params. The assembled `PageContext` object is serialized into the `MessageRequest` payload. The server-side message route (`apps/studio/src/app/api/arch-ai/message/route.ts`) extracts it and calls `composeSystemPrompt()` with the context, which formats it as a `## Current Context` section.

### Store Access Pattern

The `buildPageContext()` function needs to read from multiple Zustand stores. It should use `store.getState()` (non-reactive) rather than hooks, since it's called imperatively before sending a message. Stores involved:

- `navigation-store.ts` — current area, page, URL params
- `project-store.ts` — project metadata, agent list
- Agent-specific stores (if on agent editor) — selected agent, compile status
- Trace stores (if on trace viewer) — selected trace, events

### MessageRequest Schema Extension

The existing `MessageRequestSchema` (in `@agent-platform/arch-ai`) needs a new optional `pageContext` field. This is a non-breaking additive change — existing clients that don't send `pageContext` continue to work.

### Token Budget Enforcement

The context is formatted as a short markdown section (~500-2000 tokens depending on page):

- Agent editor: agent name + type + compile status + tool list ≈ 200 tokens
- Trace viewer: trace ID + status + error summary ≈ 300 tokens
- Topology: topology structure summary ≈ 500 tokens
- Dashboard: KPI summary ≈ 300 tokens

If total exceeds 2K tokens, truncate entity metadata first (keep name + type, drop details).

---

## 8. How to Consume

### Studio UI

- **Automatic**: `buildPageContext()` called before every `send()` in `useArchChat`. No user action required.
- **No new UI elements**: Context collection is invisible to the user.
- **Developer visibility**: Console log (debug level) shows the injected context for troubleshooting.

### API (Runtime)

No runtime changes.

### API (Studio)

| Method | Path                   | Purpose                                         |
| ------ | ---------------------- | ----------------------------------------------- |
| POST   | `/api/arch-ai/message` | ENHANCED — accepts optional `pageContext` field |

### Admin Portal

N/A — this is a Studio-only feature.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable — page context is specific to the Studio browser environment. When Arch is available via MCP (B56), context will come from the MCP client's environment instead.

---

## 9. Data Model

### Collections / Tables

No new collections. The `pageContext` is ephemeral — sent per-request, injected into the prompt, not persisted.

```text
Existing schema extension:
  MessageRequest (in @agent-platform/arch-ai)
    + pageContext?: PageContext (optional, non-breaking)
```

### Key Relationships

- Navigation store → provides current area/page
- Project store → provides project metadata, agent list
- URL params → provides entity IDs (agent name, trace ID)
- System prompt composition → consumes `pageContext` for injection

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                | Purpose                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/build-page-context.ts` | `buildPageContext()` — context assembly, redaction, token budget                       |
| `packages/arch-ai/src/types/page-context.ts`        | `PageContext` interface + `PageContextSchema` (Zod)                                    |
| `packages/arch-ai/src/types/message-request.ts`     | `MessageRequest` 'message' variant extended with optional `pageContext`                |
| `packages/arch-ai/src/prompts/index.ts`             | `formatContextSection()` + `composeSystemPrompt()`/`composeInProjectPrompt()` enhanced |
| `apps/studio/src/store/navigation-store.ts`         | READ — current area, page, URL params                                                  |

### Routes / Handlers

| File                                               | Purpose                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | ENHANCE — extract `pageContext` from request, pass to prompt |

### UI Components

| File                                   | Purpose                                             |
| -------------------------------------- | --------------------------------------------------- |
| `apps/studio/src/hooks/useArchChat.ts` | ENHANCE — call `buildPageContext()` before `send()` |

### Jobs / Workers / Background Processes

N/A — context collection is synchronous, per-request.

### Tests

| File                                                            | Type | Coverage Focus                                           |
| --------------------------------------------------------------- | ---- | -------------------------------------------------------- |
| `apps/studio/src/__tests__/arch-ai/build-page-context.test.ts`  | unit | Context assembly, redaction, token budget (12 tests)     |
| `apps/studio/src/__tests__/arch-ai/page-context-prompt.test.ts` | unit | formatContextSection + composeSystemPrompt (12 tests)    |
| `apps/studio/e2e/arch-b02-b20-b23.spec.ts`                      | e2e  | Playwright — schema validation, no-regression, no errors |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

| Setting                            | Default | Description                                            |
| ---------------------------------- | ------- | ------------------------------------------------------ |
| `arch.pageContext.enabled`         | `true`  | Enable/disable page context injection                  |
| `arch.pageContext.maxTokens`       | `2000`  | Maximum token budget for injected context              |
| `arch.pageContext.includeTopology` | `true`  | Include topology structure in context (larger payload) |

### DSL / Agent IR / Schema

N/A — this is a Studio UI feature, not a DSL/IR concern.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Project isolation | Context is scoped to the current project. No cross-project data in the context object.                         |
| Tenant isolation  | Context is built from the user's own session state. No cross-tenant data access.                               |
| User isolation    | Context reads from the user's own browser state. No cross-user data. Settings page omits API keys/credentials. |

### Security & Compliance

- `pageContext` must NEVER include raw API keys, credentials, or tokens from settings pages
- Agent ABL content is NOT included in full — only metadata (name, type, compile status, tool count)
- Trace content is summarized — only error summary, not full conversation content
- The `pageContext` field is validated server-side (type-checked, max size enforced) to prevent injection

### Performance & Scalability

- `buildPageContext()` reads from in-memory Zustand stores — sub-millisecond, no network calls
- Context serialization adds ~1-2KB to the message payload — negligible
- System prompt injection adds ~500-2000 tokens — well within context window limits
- No caching needed — context is always fresh from current store state

### Reliability & Failure Modes

- If any store is unavailable: `buildPageContext()` returns partial context (area + page, no entity data)
- If URL parsing fails: fallback to navigation store area/page only
- If `pageContext` field is malformed on the server: ignore it and proceed without context (log warning)
- Context injection is advisory — the specialist works with or without it

### Observability

- Debug-level logging: `createLogger('arch-ai:page-context')` logs the assembled context
- No new metrics — this is a transparent enhancement
- System prompt includes `<!-- Page context: {area}/{page} -->` comment for debugging

### Data Lifecycle

- `pageContext` is ephemeral — not persisted anywhere
- No new database writes, no retention concerns
- Context is rebuilt from current store state on every message send

---

## 13. Delivery Plan / Work Breakdown

1. **Define PageContext type**
   1.1 Add `PageContext` interface to `@agent-platform/arch-ai` types
   1.2 Add optional `pageContext` field to `MessageRequestSchema` (Zod validation)
   1.3 Unit tests for schema validation (valid context, missing context, oversized context)

2. **Build context collector**
   2.1 Create `buildPageContext()` in `apps/studio/src/lib/arch-ai/build-page-context.ts`
   2.2 Implement context extraction for each page type (agent, trace, topology, dashboard, settings)
   2.3 Add token budget enforcement with truncation strategy
   2.4 Unit tests for each page type context extraction

3. **Wire into message flow**
   3.1 Enhance `useArchChat.send()` to call `buildPageContext()` and include in payload
   3.2 Enhance message route to extract `pageContext` and pass to `composeSystemPrompt()`
   3.3 Enhance `composeSystemPrompt()` to inject `## Current Context` section

4. **System prompt formatting**
   4.1 Design the `## Current Context` section template with conditional sections
   4.2 Test prompt injection with each page type
   4.3 Verify token budget stays within limits

5. **Security hardening**
   5.1 Add server-side validation for `pageContext` (type check, max size)
   5.2 Verify no sensitive data leakage (API keys, credentials, conversation content)
   5.3 Add redaction for settings page context

---

## 14. Success Metrics

| Metric                                 | Baseline                | Target           | How Measured                                               |
| -------------------------------------- | ----------------------- | ---------------- | ---------------------------------------------------------- |
| Messages needed to establish context   | 2-3 per interaction     | 0 (automatic)    | Count of "which agent?" clarification messages             |
| Time to first useful response          | +10-15s (clarification) | -10s (immediate) | Measure response time for context-dependent queries        |
| Context accuracy                       | N/A                     | >95%             | Correct entity identified vs user's actual intent          |
| Specialist using context appropriately | N/A                     | >90%             | Responses reference correct entity without user specifying |

---

## 15. Open Questions

1. Should page context be sent on every message, or only when it changes from the previous message? (Sending every time is simpler; sending on change saves tokens.)
2. How much context is too much? Should the topology view include the full graph structure or just the selected node?
3. Should the specialist acknowledge the context ("I see you're looking at billing_agent") or use it silently? A silent approach is more natural but risks confusion if the context is wrong.
4. When the user navigates mid-conversation (e.g., from billing_agent to returns_agent), should the specialist note the navigation change?
5. Should dashboard KPI data be included, or is that too expensive (requires API call, not just store read)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                              | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No page context exists in current implementation — `useArchChat.send()` doesn't pass any | High     | Open   |
| GAP-002 | Some page stores may not be populated when Arch overlay opens (lazy loading)             | Medium   | Open   |
| GAP-003 | Topology store structure may not expose selected node/edge for context extraction        | Medium   | Open   |
| GAP-004 | Dashboard KPI data may require an API call, not available in a Zustand store             | Low      | Open   |
| GAP-005 | No server-side validation of `pageContext` in the message route currently                | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                 | Coverage Type | Status     | Test File / Note                 |
| --- | ------------------------------------------------------------------------ | ------------- | ---------- | -------------------------------- |
| 1   | Agent editor page → context includes agentName, compile status           | unit          | NOT TESTED | build-page-context.test.ts       |
| 2   | Trace viewer page → context includes traceId, error summary              | unit          | NOT TESTED | build-page-context.test.ts       |
| 3   | Topology view with selected node → context includes node data            | unit          | NOT TESTED | build-page-context.test.ts       |
| 4   | Settings page → context excludes API keys and credentials                | unit          | NOT TESTED | build-page-context.test.ts       |
| 5   | Context injection into system prompt at correct position                 | integration   | NOT TESTED | page-context-integration.test.ts |
| 6   | Token budget enforcement — large context truncated to ~2K tokens         | unit          | NOT TESTED | build-page-context.test.ts       |
| 7   | Missing store data → partial context returned gracefully                 | unit          | NOT TESTED | build-page-context.test.ts       |
| 8   | MessageRequest with pageContext passes schema validation                 | unit          | NOT TESTED | TBD                              |
| 9   | Full send flow: navigate to agent page → send message → context injected | e2e           | NOT TESTED | TBD                              |
| 10  | Navigate between pages → context updates on next message                 | e2e           | NOT TESTED | TBD                              |
| 11  | IN_PROJECT "fix this" on agent page → correct agent identified           | e2e           | NOT TESTED | TBD                              |
| 12  | No sensitive data in context from settings pages                         | e2e           | NOT TESTED | TBD                              |

### Testing Notes

E2E tests must exercise the real Studio server and Arch AI pipeline. Tests should:

- Navigate to specific Studio pages using Playwright
- Open the Arch overlay and send messages
- Verify the system prompt (via debug logging or response analysis) includes correct page context
- Verify no sensitive data leakage from settings pages
- No mocking of navigation stores, project stores, or message route

> Full testing details: [../testing/page-context-awareness.md](../testing/page-context-awareness.md)

---

## 18. References

- Backlog item: [`docs/arch/backlogs/B02-page-context-awareness.md`](../arch/backlogs/B02-page-context-awareness.md)
- Navigation store: [`apps/studio/src/store/navigation-store.ts`](../../apps/studio/src/store/navigation-store.ts)
- useArchChat hook: [`apps/studio/src/hooks/useArchChat.ts`](../../apps/studio/src/hooks/useArchChat.ts)
- Message route: [`apps/studio/src/app/api/arch-ai/message/route.ts`](../../apps/studio/src/app/api/arch-ai/message/route.ts)
- Related: B57 (Quick Actions) — explicit `@mentions` complement B02's implicit context
- Related: B04 (Enhanced In-Project) — suggestion chips require B02's page awareness
