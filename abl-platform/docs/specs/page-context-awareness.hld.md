# HLD: Page Context Awareness

**Feature Spec**: `docs/features/page-context-awareness.md`
**Test Spec**: `docs/testing/page-context-awareness.md`
**Status**: APPROVED
**Author**: Sri Harsha
**Date**: 2026-04-05

---

## 1. Problem Statement

When users open Arch in IN_PROJECT mode, every conversation starts cold — Arch has no awareness of which Studio page the user is on, which agent they're editing, or which trace they're viewing. Users waste 2-3 messages per interaction just establishing context ("I'm looking at the billing agent"). Cursor, Claude Code, and similar tools inject file/selection context automatically. Arch should do the same.

---

## 2. Alternatives Considered

### Option A: Client-side context builder with server-side prompt injection

- **Description**: `buildPageContext()` reads Zustand stores client-side, attaches to `MessageRequest`, server extracts and injects into system prompt as `## Current Context` section.
- **Pros**: Simple, fast (<5ms), no new APIs. Context is always fresh from current store state. Additive change — existing flow unaffected. Token-budgeted server-side.
- **Cons**: Context accuracy depends on store population timing. Client sends extra ~1-3KB per message.
- **Effort**: S

### Option B: Server-side context detection from session metadata

- **Description**: Server detects current page from session metadata or a separate `context` endpoint. Studio sends a lightweight `pageChanged` event, server maintains current context.
- **Pros**: Server is the authority — no client-side trust. Context state survives reconnections.
- **Cons**: Requires a new `pageChanged` API endpoint and server-side session state. More complex. Context updates are async (may lag behind navigation). Over-engineering for a read-only context injection.
- **Effort**: M

### Option C: LLM infers context from conversation history

- **Description**: No explicit context injection. The specialist LLM infers what the user is looking at from conversation patterns and previous messages.
- **Pros**: Zero implementation. Works today for experienced users who explicitly mention context.
- **Cons**: Unreliable — LLM can't know the user navigated from agents to sessions. "Fix this" remains ambiguous. Wastes tokens on clarification messages. Fails for first message in a session.
- **Effort**: None (status quo)

### Recommendation: Option A (Client-side builder + server-side injection)

**Rationale**: Page context is inherently client-side information — the browser knows the URL, the stores, the selected entities. Sending it with each message is the simplest, most reliable approach. Token budget enforcement happens server-side. The `MessageRequest` schema extension is non-breaking (optional field). No new services, no session state management, no async sync issues.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Studio Browser                        │
│                                                           │
│  ┌─────────────────┐     ┌───────────────────────────┐   │
│  │ User navigates   │────>│ Zustand Stores             │   │
│  │ Studio pages     │     │  ├── navigation-store      │   │
│  └─────────────────┘     │  ├── project-store         │   │
│                           │  ├── agent stores          │   │
│                           │  └── trace/session stores  │   │
│                           └──────────┬────────────────┘   │
│                                      │                    │
│  ┌─────────────────┐     ┌──────────▼────────────────┐   │
│  │ useArchChat      │────>│ buildPageContext()         │   │
│  │  .send(text)     │     │  ├── read navigation area  │   │
│  └────────┬────────┘     │  ├── read page type         │   │
│           │               │  ├── extract entity data    │   │
│           │               │  ├── redact sensitive data  │   │
│           │               │  └── enforce token budget   │   │
│           │               └──────────┬────────────────┘   │
│           │                          │                    │
│           └── MessageRequest ────────┘                    │
│               { text, pageContext }                        │
└───────────────────┬──────────────────────────────────────┘
                    │ POST /api/arch-ai/message
                    ▼
┌──────────────────────────────────────────────────────────┐
│                     Studio Server                         │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ Message Route                                        │ │
│  │  1. Extract pageContext from request                  │ │
│  │  2. composeSystemPrompt({ specialistId, pageContext })│ │
│  │  3. Inject "## Current Context" section               │ │
│  │  4. Stream response via SSE                           │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Component Diagram

```
build-page-context.ts (NEW)
├── buildPageContext() → PageContext
├── extractAgentContext(navStore, projectStore) → EntityContext | null
├── extractTraceContext(navStore, traceStore) → EntityContext | null
├── extractTopologyContext(navStore, topologyStore) → EntityContext | null
├── extractDashboardSummary(dashStore) → Record<string, unknown> | null
├── extractSettingsContext(navStore) → Record<string, unknown> | null
├── redactSensitiveData(context) → PageContext
└── enforceTokenBudget(context, maxTokens) → PageContext

types.ts (@agent-platform/arch-ai — ENHANCED)
├── PageContext { area, page, project?, entity?, summary? }
├── EntityContext { type, id, name?, metadata? }
└── MessageRequest.pageContext?: PageContext  (NEW optional field)

compose-system-prompt.ts (@agent-platform/arch-ai — ENHANCED)
└── formatContextSection(pageContext) → string  (## Current Context markdown)
```

### Data Flow

1. User navigates to `/projects/:id/agents/billing_agent`
2. Navigation store updates: `{ area: 'project', page: 'agents' }`
3. User opens Arch overlay, types "fix the handoff"
4. `useArchChat.send("fix the handoff")` calls `buildPageContext()`
5. `buildPageContext()` reads stores: navigation → `agents` page, project → `billing_agent` entity
6. `PageContext` attached to `MessageRequest`: `{ text: "fix the handoff", pageContext: { area: 'project', page: 'agents', entity: { type: 'agent', id: 'billing_agent', ... } } }`
7. Server extracts `pageContext`, calls `composeSystemPrompt()` with it
8. System prompt includes: `## Current Context\nYou are on the agent editor page for billing_agent (specialist, 4 tools, compile: pass).`
9. Specialist LLM receives context → responds about billing_agent's handoff without asking "which agent?"

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                             |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | `buildPageContext()` reads from the user's own browser stores — inherently isolated. Server validates that `pageContext.project.id` matches the session's project. No cross-tenant data possible.                                                                           |
| 2   | **Data Access Pattern** | Client: synchronous Zustand `store.getState()` reads — no network, no async. Server: `pageContext` is a plain JSON object on the request — no DB lookup needed.                                                                                                             |
| 3   | **API Contract**        | `MessageRequest` gains optional `pageContext?: PageContext` field. Non-breaking — existing clients that omit it continue to work. `PageContext` validated by Zod on the server.                                                                                             |
| 4   | **Security Surface**    | `buildPageContext()` runs `redactSensitiveData()` before serialization — strips API keys, credentials, conversation content. Server enforces max payload size. `pageContext` cannot inject arbitrary content into the system prompt (template-formatted, not raw-injected). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                               |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Any store read failure → return partial context (area + page only). `buildPageContext()` never throws. Server receives null/undefined `pageContext` → composes prompt without context section. Specialist works fine with or without context. |
| 6   | **Failure Modes** | Store not populated (lazy loading) → partial context. URL parsing fails → fallback to navigation store. Malformed `pageContext` on server → ignore with warning log. All failures are graceful degradation — never breaks the message flow.   |
| 7   | **Idempotency**   | Same page state → same context. Context is a pure function of store state. No side effects from `buildPageContext()`.                                                                                                                         |
| 8   | **Observability** | `createLogger('arch-ai:page-context')` logs assembled context at debug level. System prompt includes `<!-- page: {area}/{page} -->` HTML comment for debugging. No new metrics — this is a transparent enhancement.                           |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | `buildPageContext()`: <5ms (synchronous store reads). Payload overhead: 1-3KB JSON. System prompt injection: ~500-2000 tokens (within context window budget). Token budget enforced: >2K tokens → truncate metadata.                                                                                                                                                       |
| 10  | **Migration Path**     | Additive: new optional field on `MessageRequest`, new helper function, enhanced `composeSystemPrompt()`. Zero migration needed — existing sessions, messages, and prompts unaffected.                                                                                                                                                                                      |
| 11  | **Rollback Plan**      | `arch.pageContext.enabled = false` → `buildPageContext()` returns null → no context injected. Alternatively: revert the 3 file changes (build-page-context.ts, types.ts update, compose-system-prompt.ts update). No data to clean up.                                                                                                                                     |
| 12  | **Test Strategy**      | Unit: `buildPageContext()` for each of 7 page types, token budget, redaction, null handling. Integration: `composeSystemPrompt()` with `pageContext` → verify `## Current Context` section positioning and content. E2E (Playwright): navigate to page → open Arch → send message → verify response references correct entity. No mocking of stores or prompt composition. |

---

## 5. Data Model

### New Collections/Tables

None. `pageContext` is ephemeral — sent per-request, not persisted.

### Modified Collections/Tables

None. No schema migration.

### Schema Extension

```typescript
// @agent-platform/arch-ai/src/types.ts
interface PageContext {
  area: 'projects' | 'project' | 'admin' | 'settings' | 'arch-v3';
  page: string;
  project?: { id: string; name: string; agentCount: number };
  entity?: {
    type: 'agent' | 'trace' | 'session' | 'topology_node' | 'topology_edge';
    id: string;
    name?: string;
    metadata?: Record<string, unknown>;
  };
  summary?: Record<string, unknown>;
}

// MessageRequest — add optional field
interface MessageRequest {
  // ... existing fields ...
  pageContext?: PageContext;
}
```

---

## 6. API Design

### New Endpoints

None.

### Modified Endpoints

| Method | Path                   | Change           | Details                                                |
| ------ | ---------------------- | ---------------- | ------------------------------------------------------ |
| POST   | `/api/arch-ai/message` | Schema extension | Optional `pageContext` field added to `MessageRequest` |

### Validation

```typescript
const PageContextSchema = z
  .object({
    area: z.string(),
    page: z.string(),
    project: z.object({ id: z.string(), name: z.string(), agentCount: z.number() }).optional(),
    entity: z
      .object({
        type: z.enum(['agent', 'trace', 'session', 'topology_node', 'topology_edge']),
        id: z.string(),
        name: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })
      .optional(),
    summary: z.record(z.unknown()).optional(),
  })
  .optional();
```

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No audit events for context injection (it's transparent metadata, not a user action)
- **Rate Limiting**: Covered by existing Arch message rate limiting. Extra 1-3KB payload does not affect limits.
- **Caching**: None needed — context is built fresh from current store state each message.
- **Encryption**: No sensitive data in `pageContext` after redaction. Transit encryption via HTTPS covers the message payload.

---

## 8. Dependencies

### Upstream

| Dependency                      | Type       | Risk                                                |
| ------------------------------- | ---------- | --------------------------------------------------- |
| `navigation-store.ts` (Zustand) | Store read | Low — stable, well-typed                            |
| `project-store.ts` (Zustand)    | Store read | Low — existing, always populated in project context |
| `@agent-platform/arch-ai` types | Package    | Low — additive change to `MessageRequest`           |
| `composeSystemPrompt()`         | Function   | Low — adding a new optional section                 |

### Downstream

| Consumer                  | Impact                                                         |
| ------------------------- | -------------------------------------------------------------- |
| B04 (Enhanced In-Project) | Suggestion chips require `pageContext` to be context-aware     |
| B57 (Quick Actions)       | `@mentions` complement `pageContext`'s implicit context        |
| B37 (Design Critique)     | Critique mode uses page context to know which design to review |

---

## 9. Open Questions & Decisions Needed

1. Should `pageContext` be sent on every message or only when it changes? (Every time is simpler)
2. Should dashboard KPI data require a fresh API call, or only use cached store data?
3. How should the specialist handle a context navigation mid-conversation (user switches from agent A to agent B)?

---

## 10. References

- Feature spec: `docs/features/page-context-awareness.md`
- Test spec: `docs/testing/page-context-awareness.md`
- Navigation store: `apps/studio/src/store/navigation-store.ts`
- useArchChat hook: `apps/studio/src/hooks/useArchChat.ts`
- Message route: `apps/studio/src/app/api/arch-ai/message/route.ts`
- composeSystemPrompt: `packages/arch-ai/src/prompt/`
