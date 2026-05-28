# Feature: Arch AI IN_PROJECT Generalist Router

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Arch AI Assistant](../arch-ai-assistant.md)
**Status**: BETA
**Feature Area(s)**: `agent lifecycle`, `customer experience`
**Package(s)**: `packages/arch-ai`, `apps/studio`
**Owner(s)**: `arch-ai team`
**Testing Guide**: `../../testing/sub-features/arch-ai-generalist-router.md`
**Last Updated**: 2026-04-15 (post-impl sync)

---

## 1. Introduction / Overview

### Problem Statement

Arch AI's IN_PROJECT mode uses regex-based content routing (`routeByContent()`) to select one of 10 specialist system prompts per user message. This causes three classes of failures:

1. **Misrouting**: Ambiguous keywords cause incorrect specialist selection. "My agent is broken and I need to add error handling" matches `broken` and routes to the diagnostician instead of `abl-construct-expert`. The regex router has ~80 patterns across 10 specialists with first-match-wins semantics; ordering comments in `content-router.ts:17-20` acknowledge that observer "MUST appear before diagnostician" to prevent swallowing.

2. **Cross-turn prompt instability**: Each user message re-evaluates routing (`route.ts:4113`), potentially changing the system prompt mid-conversation. A user modifying an agent (construct-expert) who then asks "why is it failing" (diagnostician) gets a different persona and behavioral framing on the next turn. The specialist is persisted per turn (`route.ts:4116`) but changes every new message.

3. **Redundant dual-routing**: `routeByContent()` and `selectKnowledgeCards()` both regex-match the same message independently with overlapping pattern sets. The specialist prompt and knowledge cards are composed together (`prompts/index.ts:113-117`), producing redundant or conflicting domain knowledge injection.

All IN_PROJECT specialists already receive the full 25-tool set (`IN_PROJECT_TOOLS` in `tools.ts:83-108`). There is no per-specialist tool filtering. The routing only affects which system prompt the LLM receives.

### Goal Statement

Replace the specialist routing layer in IN_PROJECT mode with a single generalist agent that always receives the same base system prompt, supplemented by intent-triggered knowledge cards loaded from the existing card-router system. This eliminates prompt instability across turns, removes the misrouting failure class entirely, and consolidates the dual-routing paths into one.

### Summary

This sub-feature converts the IN_PROJECT mode from a "route to one of 10 specialists" architecture to a "one generalist + dynamic knowledge cards" architecture. Specialist domain knowledge (diagnostician workflows, analyst data patterns, integration tool bindings, etc.) is extracted from specialist prompt files into new L2 knowledge cards. The existing `selectKnowledgeCards()` function — already proven in production for 26 construct-level cards — becomes the sole knowledge-injection mechanism. `routeByContent()` is removed from the IN_PROJECT message path. ONBOARDING mode is unaffected.

---

## 2. Scope

### Goals

- Eliminate regex-based specialist routing for IN_PROJECT mode
- Provide a single stable system prompt across all turns in a conversation
- Convert 8 IN_PROJECT-relevant specialist prompts into L2 knowledge cards (diagnostician, analyst, observer, integration-methodologist, multi-agent-architect, channel-voice, entity-collection, testing-eval; onboarding excluded as ONBOARDING-only; abl-construct-expert becomes the base generalist)
- Merge specialist trigger patterns into the existing card-router pattern registry
- Preserve all domain knowledge currently in specialist prompts
- Maintain backward compatibility with existing sessions (`activeSpecialist` field)
- Preserve the SSE specialist badge event (with updated semantics)

### Non-Goals (Out of Scope)

- Changes to ONBOARDING mode (phase machine, per-phase tool filtering, per-phase specialist selection)
- Adding new tools to the IN_PROJECT tool set
- Tiered tool loading (future-proofing for 30+ tools) — deferred until tool count warrants it
- MCP surface support (separate feature)
- Changes to the multi-turn executor, executor guards, or loop detection
- Changes to the knowledge card content of existing L2 construct cards (e.g., flow-steps, cel-expressions)
- Removing specialist prompt files entirely (ONBOARDING mode still uses multi-agent-architect, abl-construct-expert, channel-voice, entity-collection, integration-methodologist, testing-eval)

---

## 3. User Stories

1. As a **platform builder** using Arch in Studio, I want my conversation with Arch to maintain consistent behavior across turns, so that asking a follow-up question about a failed modification doesn't change Arch's persona and lose the context of what I was doing.

2. As a **platform builder**, I want Arch to understand multi-intent messages ("add error handling to my agent and run tests"), so that I don't have to break my requests into single-domain sentences to avoid misrouting.

3. As a **platform builder**, I want Arch to automatically load relevant domain knowledge (diagnostics workflows, analytics data patterns, tool integration syntax) based on what I'm asking, without me needing to phrase my question in a specific way to trigger the right specialist.

4. As a **platform builder**, I want Arch to be able to seamlessly handle cross-domain workflows (modify agent -> configure tool auth -> test -> diagnose), so that I don't experience context loss when my task naturally spans multiple domains.

5. As a **platform builder** resuming a conversation after a tool answer (e.g., confirming a proposed modification), I want Arch to continue with the same context and knowledge it had when it asked the question, rather than re-routing based on my "yes" or "true" answer text.

---

## 4. Functional Requirements

1. **FR-1**: The system must compose the IN_PROJECT system prompt using a single generalist base prompt (derived from `abl-construct-expert`) plus dynamically selected L2 knowledge cards, for all user messages in IN_PROJECT mode.

2. **FR-2**: The system must not change the base system prompt identity (persona, core capabilities, modification workflow) between turns within the same IN_PROJECT session. Knowledge cards may vary per turn based on user message content.

3. **FR-3**: The system must load multiple knowledge cards simultaneously when the user message matches patterns from multiple domains (e.g., "diagnose this agent's tool auth" loads both diagnostics and tool-auth cards), up to the configured token budget.

4. **FR-4**: The system must convert the domain knowledge from 8 specialist prompts (diagnostician, analyst, observer, integration-methodologist, multi-agent-architect, channel-voice, entity-collection, testing-eval) into L2 knowledge cards with appropriate trigger patterns, preserving tool-preference hints and domain workflows.

5. **FR-5**: The system must continue to provide all 25 IN_PROJECT tools to every turn, with no per-domain tool filtering.

6. **FR-6**: The system must emit an SSE `specialist` event per turn. The event must identify the generalist ("Arch AI") rather than a routed specialist. The existing SSE event schema (`{ type: 'specialist', name: string, icon: string }`) must not change.

7. **FR-7**: The system must preserve backward compatibility with existing sessions that have `activeSpecialist` set to a specific specialist ID in MongoDB. New turns on existing sessions must use the generalist prompt regardless of the stored specialist.

8. **FR-8**: The system must handle `tool_answer` resume messages without re-routing. Knowledge cards must be re-selected based on the conversation context (not the tool answer text, which is often "true"/"false").

9. **FR-9**: The system must increase the knowledge card token budget from 4000 to 6000 tokens to accommodate domain-specialist cards alongside existing construct-level cards.

10. **FR-10**: The system must preserve `routeByContent()` and all specialist prompt files for ONBOARDING mode, which continues to use specialist routing with per-phase tool filtering.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                              |
| -------------------------- | ------------ | ------------------------------------------------------------------ |
| Project lifecycle          | NONE         | No change to project CRUD or lifecycle                             |
| Agent lifecycle            | SECONDARY    | Agent modification workflow unchanged, but prompt framing improves |
| Customer experience        | PRIMARY      | Direct improvement to Arch AI conversation quality and consistency |
| Integrations / channels    | NONE         | No channel changes                                                 |
| Observability / tracing    | SECONDARY    | Specialist badge semantics change; card selection could be logged  |
| Governance / controls      | NONE         | No auth/permission changes                                         |
| Enterprise / compliance    | NONE         | No compliance impact                                               |
| Admin / operator workflows | NONE         | No admin changes                                                   |

### Related Feature Integration Matrix

| Related Feature                                              | Relationship Type | Why It Matters                                                                               | Key Touchpoints                                     | Current State |
| ------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------- |
| [Arch AI Assistant](../arch-ai-assistant.md)                 | extends           | This is the parent feature; generalist router replaces the specialist routing sub-system     | `content-router.ts`, `prompts/index.ts`, `route.ts` | BETA          |
| [Arch AI Knowledge Cards](../arch-ai-assistant.md#knowledge) | shares data with  | New domain cards extend the existing L2 card registry                                        | `card-router.ts`, `knowledge/cards/`                | BETA          |
| Arch AI ONBOARDING Mode                                      | depends on        | ONBOARDING mode must continue using specialist routing; specialist IDs and prompts preserved | `phase-machine.ts`, `SPECIALIST_IDS`                | BETA          |

---

## 6. Design Considerations

### SSE Specialist Badge

The specialist badge (`{ type: 'specialist', name: string, icon: string }`) is rendered in the Studio chat UI to indicate which specialist is active. With the generalist, options:

- **Option A (chosen)**: Emit a static "Arch AI" badge with a generic icon for all IN_PROJECT turns. Simple, no information overload.
- **Option B**: Emit the primary knowledge domain (e.g., "Diagnostics" if diagnostics card loaded). More informative but adds complexity and may confuse when multiple domains load.

### Generalist Prompt Design

The generalist prompt is derived from `abl-construct-expert` (already the default fallback) combined with the `IN_PROJECT_PHASE_PROMPT`. Domain-specific sections ("Your Tools" lists, workflows) move to knowledge cards. The generalist retains:

- Core identity and persona
- Agent modification workflow (mandatory steps)
- Project configuration guidance
- Model configuration guidance
- Memory management guidance
- Tool overview (brief, not domain-specific)

---

## 7. Technical Considerations

### Prompt Composition Change

**Before:**

```
systemPrompt = BASE_PROMPT + SPECIALIST_PROMPTS[specialist] + selectKnowledgeCards(msg) + IN_PROJECT_PHASE_PROMPT
```

**After:**

```
systemPrompt = BASE_PROMPT + GENERALIST_PROMPT + selectKnowledgeCards(msg) + IN_PROJECT_PHASE_PROMPT
```

Where `selectKnowledgeCards(msg)` now includes domain cards derived from former specialist prompts.

### Card Budget Arithmetic

| Component               | Tokens (approx) |
| ----------------------- | --------------- |
| BASE_PROMPT             | ~500            |
| GENERALIST_PROMPT       | ~1200           |
| L0 platform-limits      | ~400            |
| L2 construct cards      | ~800-1600       |
| L2 domain cards (new)   | ~600-1200       |
| IN_PROJECT_PHASE_PROMPT | ~800            |
| Page context            | ~200            |
| **Total**               | **~4500-5900**  |

Budget increase from 4000 to 6000 tokens for knowledge cards accommodates 2-3 domain cards alongside existing construct cards.

### Backward Compatibility

Existing sessions in MongoDB have `metadata.activeSpecialist` set to specialist IDs like `'diagnostician'`, `'analyst'`, etc. The `setActiveSpecialist` call (`route.ts:4116`) will be changed to always set `'abl-construct-expert'` for IN_PROJECT turns. The field is not removed from the schema to avoid migration.

---

## 8. How to Consume

### Studio UI

No visible change except the specialist badge text. Users interact with Arch the same way — the chat panel, modification workflow, and all tools work identically. The improvement is behavioral: more consistent responses, better multi-domain handling.

### API (Runtime)

N/A — Arch AI does not expose runtime API endpoints.

### API (Studio)

| Method | Path                   | Purpose                 | Change                                                          |
| ------ | ---------------------- | ----------------------- | --------------------------------------------------------------- |
| POST   | `/api/arch-ai/message` | Send message to Arch AI | System prompt composition changes; SSE specialist event changes |

### Admin Portal

N/A — No admin changes.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — Arch AI is Studio-only. MCP surface is a future feature (separate scope).

---

## 9. Data Model

### Collections / Tables

No schema changes. Existing fields are reused:

```text
Collection: archSessions
Fields (relevant):
  - metadata.activeSpecialist: string (preserved, set to 'abl-construct-expert' for new turns)
  - metadata.mode: 'ONBOARDING' | 'IN_PROJECT' (unchanged)
Indexes: unchanged
```

### Key Relationships

- `archSessions.metadata.activeSpecialist` → specialist display name (simplified to constant)
- Knowledge card selection → `card-router.ts` CARD_REGISTRY entries (new domain cards added)

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                 | Purpose                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/arch-ai/src/coordinator/content-router.ts`                 | Specialist router — preserved for ONBOARDING, no longer called by IN_PROJECT |
| `packages/arch-ai/src/knowledge/card-router.ts`                      | Card selection engine — 8 domain cards registered, budget increased to 6000  |
| `packages/arch-ai/src/knowledge/cards/diagnostics-workflow.ts`       | Domain card — diagnostician tool guidance + workflows                        |
| `packages/arch-ai/src/knowledge/cards/analytics-workflow.ts`         | Domain card — analyst tool guidance + metric thresholds                      |
| `packages/arch-ai/src/knowledge/cards/observer-workflow.ts`          | Domain card — production intelligence patterns                               |
| `packages/arch-ai/src/knowledge/cards/tool-integration-workflow.ts`  | Domain card — tool binding + auth configuration                              |
| `packages/arch-ai/src/knowledge/cards/topology-design-workflow.ts`   | Domain card — topology patterns + handoff types                              |
| `packages/arch-ai/src/knowledge/cards/channel-voice-workflow.ts`     | Domain card — channel config + voice prompts                                 |
| `packages/arch-ai/src/knowledge/cards/entity-collection-workflow.ts` | Domain card — GATHER design + validation                                     |
| `packages/arch-ai/src/knowledge/cards/testing-eval-workflow.ts`      | Domain card — test scenario taxonomy + eval criteria                         |
| `packages/arch-ai/src/prompts/specialists/in-project-generalist.ts`  | Generalist base prompt for IN_PROJECT mode                                   |
| `packages/arch-ai/src/prompts/index.ts`                              | Prompt composition — `composeInProjectPrompt` uses generalist prompt         |
| `packages/arch-ai/src/knowledge/index.ts`                            | Re-exports for all 8 domain card constants                                   |

### Routes / Handlers

| File                                               | Purpose                                              |
| -------------------------------------------------- | ---------------------------------------------------- |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | Message handler — routing logic simplified at ~L4087 |

### UI Components

No UI component changes. The specialist badge rendering already handles arbitrary `name` + `icon` values from the SSE event.

### Tests

| File                                                                      | Type        | Coverage Focus                                                      |
| ------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `packages/arch-ai/src/__tests__/domain-card-selection.test.ts`            | unit        | Domain card selection, multi-intent, tool_answer, budget (23 tests) |
| `packages/arch-ai/src/__tests__/content-router.test.ts`                   | unit        | ONBOARDING routing regression (preserved, unchanged)                |
| `packages/arch-ai/src/__tests__/content-router-tool-lifecycle.test.ts`    | unit        | ONBOARDING tool lifecycle routing (preserved, unchanged)            |
| `packages/arch-ai/src/__tests__/golden-corpus/knowledge-coverage.test.ts` | integration | 39 scenarios — 26 construct + 8 domain + 5 pattern cards            |
| `packages/arch-ai/src/__tests__/golden-corpus/scenarios.ts`               | data        | Golden corpus with 8 new domain card scenarios                      |
| `packages/arch-ai/src/__tests__/prompts.test.ts`                          | unit        | Generalist prompt identity, no specialist persona leak              |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

| Setting                | Default | Description                                    |
| ---------------------- | ------- | ---------------------------------------------- |
| `MAX_KNOWLEDGE_TOKENS` | 6000    | Token budget for L2 knowledge cards (was 4000) |

### DSL / Agent IR / Schema

N/A — No DSL or IR changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| Project isolation | No change — `composeInProjectPrompt` already receives project-scoped context. Card selection is stateless. |
| Tenant isolation  | No change — session lookup already includes `tenantId`. Card selection is pure function, no DB access.     |
| User isolation    | No change — session ownership unchanged. Knowledge cards are global (not user-specific).                   |

### Security & Compliance

- No change to auth flow — `requireTenantAuth` middleware unchanged
- No new API endpoints
- Knowledge card content is static code (not user data) — no PII concerns
- System prompt changes are internal — not exposed to end users

### Performance & Scalability

- **Latency**: Net zero change. Regex routing (`routeByContent`) is ~0ms. Card selection (`selectKnowledgeCards`) already runs in parallel. Removing `routeByContent` and merging into card selection = same cost.
- **Token cost**: Slight increase (~200-600 tokens per turn) due to domain cards loading alongside construct cards. Offset by removing redundancy between specialist prompt and overlapping card content.
- **Memory**: No change — card content is static constants, not per-request allocations.

### Reliability & Failure Modes

- **Degraded mode**: If no knowledge cards match (edge case), the generalist prompt + IN_PROJECT phase prompt provides full capability. All tools remain available. This is strictly better than the current fallback of routing to `abl-construct-expert` with no domain knowledge.
- **Token budget exhaustion**: Cards that exceed the budget are logged in `skippedIds` (existing behavior). No user-visible impact — core construct cards have priority.

### Observability

- SSE `specialist` event continues to fire (name changes to "Arch AI")
- Card selection results (`selectedIds`, `skippedIds`) can be logged for debugging
- `session.metadata.activeSpecialist` continues to be set (always `'abl-construct-expert'`)

### Data Lifecycle

No new data. Knowledge cards are code constants. Session metadata field reuse only.

---

## 13. Delivery Plan / Work Breakdown

1. **Create domain knowledge cards from specialist prompts**
   1.1 Extract diagnostician prompt → `knowledge/cards/diagnostics-workflow.ts`
   1.2 Extract analyst prompt → `knowledge/cards/analytics-workflow.ts`
   1.3 Extract observer prompt → `knowledge/cards/observer-workflow.ts`
   1.4 Extract integration-methodologist prompt → `knowledge/cards/tool-integration-workflow.ts`
   1.5 Extract multi-agent-architect (IN_PROJECT portions) → `knowledge/cards/topology-design-workflow.ts`
   1.6 Extract channel-voice prompt → `knowledge/cards/channel-voice-workflow.ts`
   1.7 Extract entity-collection prompt → `knowledge/cards/entity-collection-workflow.ts`
   1.8 Extract testing-eval prompt → `knowledge/cards/testing-eval-workflow.ts`

2. **Register domain cards in card-router**
   2.1 Add 8 new CardEntry items to CARD_REGISTRY with trigger patterns (merged from content-router patterns + new patterns)
   2.2 Increase MAX_KNOWLEDGE_TOKENS from 4000 to 6000
   2.3 Ensure domain cards have lower priority than existing construct cards (append to registry)

3. **Create generalist IN_PROJECT prompt**
   3.1 Create `prompts/specialists/in-project-generalist.ts` — consolidated base prompt derived from abl-construct-expert, minus domain-specific sections
   3.2 Update `composeInProjectPrompt()` in `prompts/index.ts` to use the generalist prompt instead of `SPECIALIST_PROMPTS[specialist]`
   3.3 Remove specialist parameter from `composeInProjectPrompt()` signature

4. **Update message route handler**
   4.1 Remove `routeByContent()` call from IN_PROJECT path in `route.ts`
   4.2 Simplify tool_answer resume path (remove specialist pinning logic)
   4.3 Update SSE specialist badge emission to use "Arch AI" constant
   4.4 Set `activeSpecialist` to `'abl-construct-expert'` for all IN_PROJECT turns

5. **Update and migrate tests**
   5.1 Migrate `content-router.test.ts` assertions to test card selection
   5.2 Migrate `content-router-tool-lifecycle.test.ts` assertions
   5.3 Update `prompts.test.ts` for generalist prompt
   5.4 Update golden corpus test for new domain cards
   5.5 Add cross-domain knowledge card selection tests

---

## 14. Success Metrics

| Metric                                 | Baseline                                               | Target                                              | How Measured                               |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------ |
| Cross-turn prompt stability            | ~60% (prompt changes on follow-up)                     | 100% (base prompt never changes)                    | SSE specialist events across session turns |
| Multi-intent handling                  | First-match-wins (1 domain per turn)                   | Multiple domains per turn                           | Knowledge card selectedIds count per turn  |
| Specialist-specific stuck states       | Occasional (wrong specialist lacks workflow knowledge) | Zero                                                | User-reported issues, trace analysis       |
| Knowledge card coverage (domain cards) | 0 domain cards                                         | 8 domain cards, 100% specialist knowledge preserved | Card registry count, golden corpus tests   |
| Token cost per IN_PROJECT turn         | ~4000-5000 tokens (system prompt)                      | ~4500-5900 tokens                                   | LLM API token counts                       |

---

## 15. Open Questions

1. Should the generalist prompt include a brief "tool selection guide" that maps common intents to recommended tools (e.g., "for debugging, start with validate_agent"), or should this guidance live entirely in the knowledge cards?

2. When the card token budget is exceeded and domain cards are skipped, should the system emit a warning or silently proceed? Currently `skippedIds` is returned but not surfaced.

3. Should the card-router pattern registry be refactored to use a weighted scoring system instead of first-match-wins, to better handle ambiguous multi-domain messages? (Deferred to future iteration.)

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                           | Severity | Status    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Card token budget (6000) may be insufficient if user message triggers many domain + construct cards simultaneously                                                                                    | Medium   | Open      |
| GAP-002 | No empirical measurement of current misrouting rate — improvement claims are based on architectural analysis, not A/B testing                                                                         | Low      | Open      |
| GAP-003 | ONBOARDING specialists that are also used in IN_PROJECT (multi-agent-architect, testing-eval, etc.) will have knowledge in two places: specialist prompt (ONBOARDING) and knowledge card (IN_PROJECT) | Medium   | Open      |
| GAP-004 | The `tool_answer` resume path re-selects cards based on conversation context — implemented: uses last real user message (>5 chars) from session history                                               | Medium   | Mitigated |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                | Coverage Type | Status | Test File / Note                                         |
| --- | ------------------------------------------------------- | ------------- | ------ | -------------------------------------------------------- |
| 1   | Domain card selection for each specialist domain        | unit          | PASS   | `domain-card-selection.test.ts` — 8 domain tests         |
| 2   | Multi-intent message loads multiple domain cards        | unit          | PASS   | `domain-card-selection.test.ts` — 2 multi-intent tests   |
| 3   | Generalist prompt — no specialist persona leak          | unit          | PASS   | `prompts.test.ts` — 3 persona-leak tests                 |
| 4   | Prompt identity stable across different domain messages | unit          | PASS   | `prompts.test.ts` — identity equality test               |
| 5   | Token budget enforcement at 6000                        | unit          | PASS   | `domain-card-selection.test.ts` — 2 budget tests         |
| 6   | tool_answer text does not trigger domain cards          | unit          | PASS   | `domain-card-selection.test.ts` — 3 boolean tests        |
| 7   | Cross-domain workflow (modify -> diagnose)              | e2e           | PASS   | `arch-ai-generalist-router.e2e.test.ts` (E2E-2)          |
| 8   | Backward compat with legacy activeSpecialist            | e2e           | PASS   | `arch-ai-generalist-router.e2e.test.ts` (E2E-5)          |
| 9   | SSE specialist event emits "Arch AI"                    | e2e           | PASS   | `arch-ai-generalist-router.e2e.test.ts` (E2E-1)          |
| 10  | ONBOARDING mode unaffected                              | e2e           | PASS   | `arch-ai-generalist-router.e2e.test.ts` (E2E-4)          |
| 11  | Golden corpus domain card coverage                      | integration   | PASS   | `knowledge-coverage.test.ts` — 39 scenarios, 34 card IDs |
| 12  | Empty/ambiguous messages use generalist                 | e2e           | PASS   | `arch-ai-generalist-router.e2e.test.ts` (E2E-6)          |

### Testing Notes

870 tests passing (34 new). Unit: 23 domain-card-selection + 4 prompt generalist tests. Integration: 39 golden corpus scenarios (8 new domain). E2E: 7 tests (6 scenarios + setup) — real MongoDB, real route handlers, mock LLM via DI. ONBOARDING regression: all existing content-router + tool-lifecycle tests pass unchanged, plus E2E-4 regression test.

> Full testing details: `../../testing/sub-features/arch-ai-generalist-router.md`

---

## 18. References

- Parent feature doc: [docs/features/arch-ai-assistant.md](../arch-ai-assistant.md)
- HLD: [docs/specs/arch-ai-generalist-router.hld.md](../../specs/arch-ai-generalist-router.hld.md)
- LLD: [docs/plans/2026-04-15-arch-ai-generalist-router-impl-plan.md](../../plans/2026-04-15-arch-ai-generalist-router-impl-plan.md)
- Research: Agent Routing Architecture Research (conversation context, 2026-04-14)
- Anthropic "Building Effective Agents" (2025) — agent patterns, routing vs agents
