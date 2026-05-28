# LLD: Page Context Awareness

**Feature Spec**: `docs/features/page-context-awareness.md`
**HLD**: `docs/specs/page-context-awareness.hld.md`
**Test Spec**: `docs/testing/page-context-awareness.md`
**Status**: DONE
**Date**: 2026-04-05

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                                     | Rationale                                                                                                                                            | Alternatives Rejected                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| D-1 | Add `pageContext` as optional field on the `type: 'message'` variant only (not tool_answer, gate_response, continue, create) | Only user messages benefit from page context. Tool answers and gate responses are in response to specific tool/gate calls that already have context. | Adding to all variants (unnecessary complexity)     |
| D-2 | `buildPageContext()` uses `store.getState()` (imperative) not hooks                                                          | Called once before each `send()`, not reactively. Hooks would cause unnecessary re-renders.                                                          | useEffect-based context tracking (over-engineering) |
| D-3 | Token budget enforced client-side before serialization                                                                       | Avoid sending oversized payloads. Server still validates max size as defense-in-depth.                                                               | Server-only truncation (wastes bandwidth)           |
| D-4 | `PageContext` type defined in `@agent-platform/arch-ai` package                                                              | Shared between client (Studio) and server (message route). Single source of truth.                                                                   | Duplicate type in Studio (drift risk)               |

### Key Interfaces & Types

```typescript
// packages/arch-ai/src/types/page-context.ts (NEW)

export interface PageContext {
  area: string; // NavigationArea values
  page: string; // ProjectPage | AdminPage values
  project?: {
    id: string;
    name: string;
    agentCount: number;
  };
  entity?: {
    type: 'agent' | 'trace' | 'session' | 'topology_node' | 'topology_edge';
    id: string;
    name?: string;
    metadata?: Record<string, unknown>;
  };
  summary?: Record<string, unknown>;
}
```

### Module Boundaries

| Module                                              | Responsibility                      | Depends On                      |
| --------------------------------------------------- | ----------------------------------- | ------------------------------- |
| `packages/arch-ai/src/types/page-context.ts`        | PageContext type + Zod schema       | zod                             |
| `apps/studio/src/lib/arch-ai/build-page-context.ts` | Context assembly from stores        | navigation-store, project-store |
| `packages/arch-ai/src/prompts/index.ts`             | Prompt injection with context       | PageContext type                |
| `apps/studio/src/hooks/useArchChat.ts`              | Wire buildPageContext into send()   | build-page-context              |
| `apps/studio/src/app/api/arch-ai/message/route.ts`  | Extract pageContext, pass to prompt | MessageRequestSchema            |

---

## 2. File-Level Change Map

### New Files

| File                                                                 | Purpose                                                               | LOC Estimate |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| `packages/arch-ai/src/types/page-context.ts`                         | `PageContext` interface + `PageContextSchema` (Zod)                   | ~40          |
| `apps/studio/src/lib/arch-ai/build-page-context.ts`                  | `buildPageContext()` + per-page extractors + redaction + token budget | ~150         |
| `apps/studio/src/__tests__/arch-ai/build-page-context.test.ts`       | Unit tests for context builder                                        | ~200         |
| `apps/studio/src/__tests__/arch-ai/page-context-integration.test.ts` | Integration tests for prompt injection                                | ~150         |

### Modified Files

| File                                               | Change Description                                                                | Risk                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------- |
| `packages/arch-ai/src/types/message-request.ts`    | Add optional `pageContext` to `type: 'message'` variant                           | Low — additive optional field          |
| `packages/arch-ai/src/types/index.ts`              | Re-export `PageContext` type and schema                                           | Low — export addition                  |
| `packages/arch-ai/src/index.ts`                    | Re-export `PageContext`                                                           | Low — export addition                  |
| `packages/arch-ai/src/prompts/index.ts`            | Add `pageContext` param to `composeSystemPrompt()` and `composeInProjectPrompt()` | Med — signature change, update callers |
| `apps/studio/src/hooks/useArchChat.ts`             | Call `buildPageContext()` in `send()`, include in payload                         | Low — additive                         |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | Extract `pageContext` from parsed request, pass to prompt composition             | Low — additive                         |

---

## 3. Implementation Phases

### Phase 1: Type Definitions & Schema (packages/arch-ai)

**Goal**: Define `PageContext` type and extend `MessageRequestSchema` so the contract is established before any consumers.

**Tasks**:
1.1. Create `packages/arch-ai/src/types/page-context.ts` with `PageContext` interface and `PageContextSchema` (Zod)
1.2. Modify `packages/arch-ai/src/types/message-request.ts` — add `pageContext: PageContextSchema.optional()` to the `type: 'message'` variant
1.3. Export `PageContext` from `packages/arch-ai/src/types/index.ts` and `packages/arch-ai/src/index.ts`
1.4. Add unit test `packages/arch-ai/src/__tests__/page-context-schema.test.ts` — validate accept/reject cases

**Files Touched**:

- `packages/arch-ai/src/types/page-context.ts` — NEW
- `packages/arch-ai/src/types/message-request.ts` — add `pageContext` field
- `packages/arch-ai/src/types/index.ts` — re-export
- `packages/arch-ai/src/index.ts` — re-export
- `packages/arch-ai/src/__tests__/page-context-schema.test.ts` — NEW

**Exit Criteria**:

- [ ] `PageContextSchema.parse({ area: 'project', page: 'agents' })` succeeds
- [ ] `PageContextSchema.parse({ area: 123 })` throws ZodError
- [ ] `MessageRequestSchema.parse({ type: 'message', sessionId: 'x', text: 'hi' })` succeeds (no pageContext — optional)
- [ ] `MessageRequestSchema.parse({ type: 'message', sessionId: 'x', text: 'hi', pageContext: { area: 'project', page: 'agents' } })` succeeds
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds with 0 errors
- [ ] Existing `message-request.test.ts` still passes (no regression)

**Test Strategy**:

- Unit: Zod schema validation — valid, invalid, missing, oversized

**Rollback**: Revert the 4 file changes. No data impact.

---

### Phase 2: Context Builder (apps/studio client-side)

**Goal**: Create `buildPageContext()` that reads Zustand stores and produces a `PageContext` object, with sensitive data redaction and token budget enforcement.

**Tasks**:
2.1. Create `apps/studio/src/lib/arch-ai/build-page-context.ts` with:

- `buildPageContext(): PageContext | null` — main entry point
- `extractAgentContext()` — reads navigation-store + project-store for agent page
- `extractTraceContext()` — reads navigation-store for trace viewer
- `extractSettingsContext()` — reads navigation-store, redacts API keys
- `extractDashboardSummary()` — reads dashboard store if available
- `redactSensitiveData(context)` — strips credentials, keys, conversation content
- `enforceTokenBudget(context, maxTokens)` — truncates metadata if over ~2K tokens
  2.2. Create unit tests `apps/studio/src/__tests__/arch-ai/build-page-context.test.ts`:
- Test each page type context extraction
- Test sensitive data redaction (settings page)
- Test token budget enforcement
- Test null/empty store handling

**Files Touched**:

- `apps/studio/src/lib/arch-ai/build-page-context.ts` — NEW (~150 LOC)
- `apps/studio/src/__tests__/arch-ai/build-page-context.test.ts` — NEW (~200 LOC)

**Exit Criteria**:

- [ ] `buildPageContext()` returns valid `PageContext` for agent editor page with agent name, type, compile status
- [ ] `buildPageContext()` returns valid `PageContext` for settings page WITHOUT API key values
- [ ] `buildPageContext()` returns `{ area, page }` only when entity stores are empty
- [ ] `buildPageContext()` never throws (returns null on catastrophic failure)
- [ ] Token budget test: context with 20 agents truncated to <2000 tokens
- [ ] All unit tests pass: `pnpm test --filter=studio -- build-page-context`
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: mock Zustand stores via `store.setState()`, verify context extraction per page type

**Rollback**: Delete the 2 new files. No side effects.

---

### Phase 3: Prompt Injection (packages/arch-ai server-side)

**Goal**: Enhance `composeSystemPrompt()` and `composeInProjectPrompt()` to accept and inject `PageContext` into the system prompt.

**Tasks**:
3.1. Modify `packages/arch-ai/src/prompts/index.ts`:

- Add `pageContext?: PageContext` parameter to `composeSystemPrompt()` and `composeInProjectPrompt()`
- Create `formatContextSection(pageContext: PageContext): string` that produces the `## Current Context` markdown section
- Insert context section after specialist prompt, before phase prompt
  3.2. Create integration test `apps/studio/src/__tests__/arch-ai/page-context-integration.test.ts`:
- Verify `## Current Context` section appears in composed prompt
- Verify position: after specialist identity, before phase instructions
- Verify null pageContext → no section added
- Verify agent entity renders with name, type, tools

**Files Touched**:

- `packages/arch-ai/src/prompts/index.ts` — add `pageContext` param + `formatContextSection()`
- `apps/studio/src/__tests__/arch-ai/page-context-integration.test.ts` — NEW

**Exit Criteria**:

- [ ] `composeSystemPrompt('onboarding', 'INTERVIEW', { area: 'project', page: 'agents', entity: { type: 'agent', id: 'billing', name: 'billing_agent' } })` returns prompt containing `## Current Context` with `billing_agent`
- [ ] `composeSystemPrompt('onboarding', 'INTERVIEW')` (no context) returns prompt WITHOUT `## Current Context` section
- [ ] `composeInProjectPrompt('abl-construct-expert', { area: 'project', page: 'agents', entity: { type: 'agent', id: 'x', name: 'x' } })` includes context
- [ ] Existing `packages/arch-ai/src/__tests__/prompts.test.ts` still passes
- [ ] `pnpm build --filter=@agent-platform/arch-ai` succeeds

**Test Strategy**:

- Integration: real `composeSystemPrompt()` with real prompts, verify string output

**Rollback**: Revert `prompts/index.ts` signature change. Callers that don't pass `pageContext` are unaffected (parameter is optional).

---

### Phase 4: Wire into Message Flow (apps/studio)

**Goal**: Connect `buildPageContext()` to `useArchChat.send()` on the client, and extract/forward `pageContext` in the message route on the server.

**Tasks**:
4.1. Modify `apps/studio/src/hooks/useArchChat.ts`:

- Import `buildPageContext` from `@/lib/arch-ai/build-page-context`
- In `send()`, call `buildPageContext()` and add to the fetch body: `{ type: 'message', sessionId, text, files, pageContext }`
  4.2. Modify `apps/studio/src/app/api/arch-ai/message/route.ts`:
- After parsing `MessageRequestSchema`, extract `parsed.pageContext` (if `type === 'message'`)
- Pass `pageContext` to `composeSystemPrompt()` or `composeInProjectPrompt()` call
  4.3. Verify end-to-end manually or via E2E test

**Files Touched**:

- `apps/studio/src/hooks/useArchChat.ts` — add `buildPageContext()` call in `send()`
- `apps/studio/src/app/api/arch-ai/message/route.ts` — extract and forward `pageContext`

**Exit Criteria**:

- [ ] Sending a message from the agent editor page includes `pageContext` in the request body (verify via network inspector or debug log)
- [ ] The system prompt received by the LLM contains `## Current Context` with the agent name
- [ ] Sending a message without page context (e.g., from tests) still works (optional field)
- [ ] `pnpm build --filter=studio` succeeds
- [ ] Existing Arch AI E2E tests (`arch-ai-message-streaming.e2e.test.ts`, `arch-ai-sessions.e2e.test.ts`) still pass

**Test Strategy**:

- E2E: send message via `POST /api/arch-ai/message` with `pageContext` → verify SSE response references entity

**Rollback**: Revert 2 file changes. Messages without `pageContext` work identically to before.

---

## 4. Wiring Checklist

- [ ] `PageContext` type exported from `packages/arch-ai/src/types/index.ts`
- [ ] `PageContext` type exported from `packages/arch-ai/src/index.ts`
- [ ] `PageContextSchema` exported from `packages/arch-ai/src/types/page-context.ts`
- [ ] `pageContext` field added to `MessageRequestSchema` `type: 'message'` variant
- [ ] `buildPageContext` imported in `useArchChat.ts`
- [ ] `pageContext` passed to `composeSystemPrompt()` / `composeInProjectPrompt()` in message route
- [ ] `formatContextSection()` exported from prompts module (for testing)
- [ ] No new routes, no new models, no new middleware, no new workers

---

## 5. Cross-Phase Concerns

### Database Migrations

None. No schema changes.

### Feature Flags

| Flag                       | Default | Description                                                     |
| -------------------------- | ------- | --------------------------------------------------------------- |
| `arch.pageContext.enabled` | `true`  | Master switch — `buildPageContext()` returns null when disabled |

### Configuration Changes

No new env vars. Token budget is a constant in `build-page-context.ts` (`MAX_CONTEXT_TOKENS = 2000`).

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] User on agent editor → "fix this" → response references the specific agent (no clarification)
- [ ] User on trace viewer → "explain this error" → response references the specific trace
- [ ] User on settings/API keys → context does NOT contain raw key values
- [ ] Navigation between pages → next message uses updated context
- [ ] Empty stores → partial context with area/page only (no crash)
- [ ] Existing Arch AI tests pass (no regression)
- [ ] `pnpm build` succeeds for `@agent-platform/arch-ai` and `apps/studio`

---

## 7. Open Questions

1. Should `buildPageContext()` also read the Arch onboarding store for ONBOARDING mode (home context), or only IN_PROJECT?
2. Does the topology store expose selected node/edge in a way accessible via `store.getState()`? Need to verify before Phase 2 coding.
