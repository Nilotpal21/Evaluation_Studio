# HLD: Arch AI IN_PROJECT Generalist Router

**Feature Spec**: `docs/features/sub-features/arch-ai-generalist-router.md`
**Test Spec**: `docs/testing/sub-features/arch-ai-generalist-router.md`
**Status**: APPROVED
**Author**: Sri Harsha
**Date**: 2026-04-15

---

## 1. Problem Statement

Arch AI's IN_PROJECT mode uses regex-based content routing (`routeByContent()`) to select one of 10 specialist system prompts per user message. This routing layer introduces three failure classes:

1. **Misrouting** (~40% estimated): First-match-wins regex across ~80 patterns produces incorrect specialist selection for ambiguous messages. "My agent is broken and I need to add error handling" routes to diagnostician (matches `broken`) instead of construct-expert.

2. **Cross-turn prompt instability**: Every user message re-evaluates routing, changing the system prompt mid-conversation. A follow-up "why is it failing?" after an agent modification switches from construct-expert to diagnostician persona.

3. **Redundant dual-routing**: `routeByContent()` (specialist selection) and `selectKnowledgeCards()` (L2 construct cards) both regex-match the same message independently with overlapping patterns.

All IN_PROJECT specialists already receive the full 25-tool set — routing only affects which system prompt the LLM gets. The routing layer adds complexity without adding capability.

---

## 1a. Feature Spec FR Traceability

| FR    | Name                                             | HLD Section | Notes                                                   |
| ----- | ------------------------------------------------ | ----------- | ------------------------------------------------------- |
| FR-1  | Generalist base prompt + dynamic knowledge cards | S3, C2      | Core architecture change — data access pattern          |
| FR-2  | Stable base prompt across turns                  | S3          | Direct consequence of removing specialist routing       |
| FR-3  | Multiple knowledge cards for multi-domain msgs   | S3, C3      | Existing `selectKnowledgeCards` behavior, no change     |
| FR-4  | 8 domain cards from specialist prompts           | S3, S5      | New card content derived from specialist prompt files   |
| FR-5  | All 25 tools available every turn                | N/A         | Already true — no implementation change needed          |
| FR-6  | SSE specialist event emits "Arch AI"             | S6, C3      | API contract — SSE event change                         |
| FR-7  | Backward compat with activeSpecialist field      | C10, S5     | Migration path — session metadata reuse                 |
| FR-8  | tool_answer resume without re-routing            | S3, C5      | Error model — simplified by removing routing            |
| FR-9  | Knowledge card budget increased to 6000          | C9          | Performance budget — token cost change                  |
| FR-10 | ONBOARDING mode unaffected                       | S3          | Explicit scope boundary — different code path preserved |

---

## 2. Alternatives Considered

### Option A: LLM-Based Specialist Router

**Description**: Replace the regex router with an LLM call that classifies the user message and selects the appropriate specialist. The LLM sees all specialist descriptions and picks the best match.

**Pros**:

- Higher accuracy than regex for ambiguous messages
- Handles nuance ("my agent is broken and I need error handling" → construct-expert)
- Can understand multi-intent messages

**Cons**:

- Adds 500-1500ms latency per message (extra LLM call before the main call)
- Doubles LLM cost per message
- Still has the cross-turn prompt instability problem (specialist changes each turn)
- Still has the dual-routing redundancy (specialist prompt + knowledge cards)
- Adds a failure point — router LLM errors block all messages

**Effort**: M

### Option B: Single Generalist + Knowledge Cards (Chosen)

**Description**: Remove specialist routing for IN_PROJECT mode entirely. Use one generalist base prompt (derived from `abl-construct-expert`) for all turns. Inject domain knowledge via L2 knowledge cards selected by the existing `selectKnowledgeCards()` function. Convert specialist prompt content into 8 new domain knowledge cards.

**Pros**:

- Eliminates misrouting entirely — no routing step to get wrong
- Eliminates cross-turn prompt instability — base prompt never changes
- Consolidates dual-routing into one mechanism (card selection only)
- Zero additional latency — card selection is a pure function (~0ms)
- Leverages proven infrastructure (26 existing L2 cards, tested golden corpus)
- Multi-domain messages handled naturally (multiple cards load simultaneously)
- Simpler code — removes `routeByContent()` call, specialist pinning logic, and specialist display lookup from IN_PROJECT path

**Cons**:

- Specialist personas ("You are the Diagnostician") are lost — LLM no longer has a focused identity per domain. Mitigated by domain cards providing equivalent knowledge without persona framing.
- Domain knowledge cards must be carefully extracted from specialist prompts — risk of knowledge regression if content is omitted.
- Token cost increases slightly (~200-600 tokens per turn) when domain cards load alongside construct cards. Mitigated by budget increase (4000 → 6000) and deduplication of overlapping specialist/card content.

**Effort**: M

### Option C: Hierarchical Router (Intent Classification + Specialist Handoff)

**Description**: Keep specialists but replace the regex router with a structured intent classification system. First pass classifies intent categories (construct, diagnose, test, integrate, etc.). Second pass selects specialist and optionally loads multiple specialists for multi-intent messages.

**Pros**:

- Preserves specialist personas
- Better multi-intent handling than current regex
- Structured classification enables analytics

**Cons**:

- More complex than Option B — adds an intent classification layer
- Still has cross-turn prompt instability (specialist changes)
- Still has dual-routing with knowledge cards
- More code to maintain than a generalist
- Classification accuracy depends on implementation quality

**Effort**: L

### Recommendation: Option B — Single Generalist + Knowledge Cards

**Rationale**: Option B eliminates two of the three failure classes entirely (misrouting and prompt instability) with zero additional latency. The third failure class (dual-routing) is resolved by consolidation. The knowledge card system is already proven in production for 26 cards. The effort is moderate because the core infrastructure exists — we're extending it, not building from scratch.

Option A solves misrouting but not instability, and adds latency. Option C is overengineered for the actual problem — the specialist personas provide domain knowledge, which cards can deliver without the routing overhead.

The industry consensus (Anthropic "Building Effective Agents", Claude Code, Cursor, Devin, Replit Agent) is that single-agent-with-all-tools outperforms specialist routing for open-ended assistant tasks.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                       Studio (Next.js)                       │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           POST /api/arch-ai/message                  │    │
│  │                                                      │    │
│  │  ┌──────────────┐    ┌───────────────────────────┐  │    │
│  │  │ Session Mgmt  │    │   Prompt Composition      │  │    │
│  │  │ (MongoDB)     │    │                           │  │    │
│  │  └──────┬───────┘    │  BASE_PROMPT              │  │    │
│  │         │             │  + GENERALIST_PROMPT (new)│  │    │
│  │         │             │  + selectKnowledgeCards() │  │    │
│  │         │             │  + pageContext             │  │    │
│  │         │             │  + IN_PROJECT_PHASE_PROMPT│  │    │
│  │         │             └────────────┬──────────────┘  │    │
│  │         │                          │                  │    │
│  │         │             ┌────────────▼──────────────┐  │    │
│  │         └─────────────► Multi-Turn Executor       │  │    │
│  │                       │ (LLM call + tool loop)    │  │    │
│  │                       └────────────┬──────────────┘  │    │
│  │                                    │                  │    │
│  │                       ┌────────────▼──────────────┐  │    │
│  │                       │     SSE Response Stream    │  │    │
│  │                       │  specialist: "Arch AI"     │  │    │
│  │                       │  text_delta, tool_call...  │  │    │
│  │                       └───────────────────────────┘  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           ONBOARDING Mode (UNCHANGED)                │    │
│  │  Phase Machine → routeByContent() → Specialist Prompt│    │
│  │  Per-phase tool filtering remains                     │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Component Diagram — Knowledge Layer

```
┌──────────────────────────────────────────────────────────────────┐
│                    Knowledge Layer (4 tiers)                       │
│                                                                    │
│  L0: Platform Limits ─── Always loaded ──────────────────────────│
│  L1: GENERALIST_PROMPT ─ Always loaded (replaces specialist L1)  │
│  L2: Construct Cards ─── 26 existing (flow-steps, CEL, etc.)    │
│  L2: Domain Cards ────── 8 new (diagnostics, analytics, etc.)   │
│  L3: RAG Fallback ────── Deferred                                │
│                                                                    │
│  ┌──────────────────────────────────┐                            │
│  │      CARD_REGISTRY (card-router) │                            │
│  │                                  │                            │
│  │  Construct cards (high priority) │  ← existing, unchanged    │
│  │  ┌────────────────────────────┐  │                            │
│  │  │ execution-config           │  │                            │
│  │  │ flow-steps                 │  │                            │
│  │  │ cel-expressions            │  │                            │
│  │  │ ... (26 total)             │  │                            │
│  │  └────────────────────────────┘  │                            │
│  │                                  │                            │
│  │  Domain cards (lower priority)   │  ← NEW                    │
│  │  ┌────────────────────────────┐  │                            │
│  │  │ diagnostics-workflow       │  │  from diagnostician.ts    │
│  │  │ analytics-workflow         │  │  from analyst.ts          │
│  │  │ observer-workflow          │  │  from observer.ts         │
│  │  │ tool-integration-workflow  │  │  from integration-meth..  │
│  │  │ topology-design-workflow   │  │  from multi-agent-arch..  │
│  │  │ channel-voice-workflow     │  │  from channel-voice.ts    │
│  │  │ entity-collection-workflow │  │  from entity-collection.. │
│  │  │ testing-eval-workflow      │  │  from testing-eval.ts     │
│  │  └────────────────────────────┘  │                            │
│  │                                  │                            │
│  │  Budget: 6000 tokens (was 4000)  │                            │
│  └──────────────────────────────────┘                            │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow — IN_PROJECT Message (Before vs After)

**BEFORE (current):**

```
User message
  │
  ├─1─► routeByContent(msg)  ──► specialist ID
  │                                    │
  ├─2─► selectKnowledgeCards(msg) ──► L2 construct cards
  │                                    │
  └─3─► composeInProjectPrompt(specialist, ..., msg)
            │
            ├── BASE_PROMPT
            ├── SPECIALIST_PROMPTS[specialist]    ← changes per turn
            ├── L2 construct card content
            ├── pageContext, specDocument, memory
            └── IN_PROJECT_PHASE_PROMPT
                    │
                    ▼
            Multi-Turn Executor (LLM + tool loop)
                    │
                    ▼
            SSE: specialist badge = specialist display name  ← changes per turn
```

**AFTER (proposed):**

```
User message
  │
  ├─1─► selectKnowledgeCards(msg, 6000)  ──► L2 construct + domain cards
  │                                              │
  └─2─► composeInProjectPrompt(..., msg)
            │
            ├── BASE_PROMPT
            ├── GENERALIST_PROMPT               ← constant every turn
            ├── L2 construct card content
            ├── L2 domain card content (NEW)
            ├── pageContext, specDocument, memory
            └── IN_PROJECT_PHASE_PROMPT
                    │
                    ▼
            Multi-Turn Executor (LLM + tool loop)  ← UNCHANGED
                    │
                    ▼
            SSE: specialist badge = "Arch AI"      ← constant every turn
```

**Key difference**: One routing step removed. One prompt composition step simplified. System prompt base identity is constant. Domain knowledge is additive per turn (cards) rather than substitutive (specialist switch).

### tool_answer Resume Flow (Before vs After)

**BEFORE:**

```
tool_answer arrives
  │
  ├── Read session.metadata.activeSpecialist (e.g. "diagnostician")
  ├── Use stored specialist to select prompt  ← specialist pinning
  └── composeInProjectPrompt("diagnostician", ...)
```

**AFTER:**

```
tool_answer arrives
  │
  ├── Re-select cards based on the ORIGINAL user message (from session history)
  │   (not the tool_answer text "true"/"false")
  └── composeInProjectPrompt(..., originalUserMessage)
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | No change. Session queries already include `tenantId`. `selectKnowledgeCards()` is a pure function with no DB access — cannot leak tenant data. Card content is static code, not tenant-scoped data.                                                                                                                                        |
| 2   | **Data Access Pattern** | No new data access. `selectKnowledgeCards()` reads only from in-memory constants (`CARD_REGISTRY`). `composeInProjectPrompt()` is a pure string concatenation function. The route handler's session read/write is unchanged.                                                                                                                |
| 3   | **API Contract**        | The SSE `specialist` event shape (`{ type: "specialist", name: string, icon: string }`) is preserved. The `name` field changes from variable (specialist display name) to constant ("Arch AI"). Studio UI already handles arbitrary name/icon values. The POST `/api/arch-ai/message` request schema is unchanged. No breaking API changes. |
| 4   | **Security Surface**    | No new attack surface. No new API endpoints, no new user inputs, no new data flows. System prompt content is static code. Auth middleware (`requireTenantAuth`) is unchanged. Knowledge card patterns are RegExp — no user-supplied regex (no ReDoS risk).                                                                                  |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | No new error paths. Card selection is infallible — if no cards match, only `platform-limits` loads (always-present L0). If budget is exceeded, extra cards appear in `skippedIds` (logged, no user error). Prompt composition is pure concatenation — cannot throw.                                                                                                                                                                                |
| 6   | **Failure Modes** | **Card selection returns empty**: Impossible — L0 always loads. **All domain cards skipped (budget)**: Generalist prompt + IN_PROJECT phase prompt provides full tool access and modification workflow. This is strictly better than the current fallback to `abl-construct-expert` with no domain knowledge. **Specialist prompt regression**: Mitigated by golden corpus tests — each domain card is verified against requiredKnowledge strings. |
| 7   | **Idempotency**   | N/A — `selectKnowledgeCards()` is a pure function. Same input always produces same output. No side effects. No state mutation.                                                                                                                                                                                                                                                                                                                     |
| 8   | **Observability** | **SSE specialist event**: Continues to fire with `name: "Arch AI"`. **Card selection**: `selectedIds` and `skippedIds` available for logging in the route handler. **Existing logging**: `createLogger('arch-ai:specialist-executor')` logs in multi-turn executor are unchanged. **Recommendation**: Add structured log at card selection point: `log.info('arch_ai.knowledge_cards', { selectedIds, skippedIds, estimatedTokens })`.             |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | **Latency**: Net zero. Removes one regex pass (`routeByContent` ~0ms), adds nothing (card selection already runs). **Token cost**: +200-600 tokens per turn from domain cards loading alongside construct cards. Offset by removing redundancy between specialist prompt and overlapping card content (e.g., diagnostician prompt repeats tool descriptions already in construct cards). **Budget**: 6000 tokens for knowledge cards = ~1.5KB of card content. Acceptable within the 200K context window.                                                                                                 |
| 10  | **Migration Path**     | **Schema**: No migration. `activeSpecialist` field preserved, set to `'abl-construct-expert'` for all new IN_PROJECT turns. **Code**: Additive — new cards and generalist prompt added first, then routing removed. **Rollback**: Revert `composeInProjectPrompt` to read `SPECIALIST_PROMPTS[specialist]`. New cards remain harmlessly in the registry. **Existing sessions**: First new message on a legacy session transparently picks up generalist behavior.                                                                                                                                         |
| 11  | **Rollback Plan**      | **Step 1**: Revert the `composeInProjectPrompt()` change in `prompts/index.ts` (re-add specialist param, re-read `SPECIALIST_PROMPTS[specialist]`). **Step 2**: Revert the `route.ts` change (re-add `routeByContent()` call). **Step 3**: New domain cards and `GENERALIST_PROMPT` can remain — they're dead code in the reverted path. **Risk**: Low — changes are in 2 files (prompts/index.ts and route.ts). New cards in `knowledge/cards/` are additive and have no consumers if routing is restored.                                                                                               |
| 12  | **Test Strategy**      | **Unit (8 tests)**: Pure function tests for card selection, prompt composition, tool set validation. All in `packages/arch-ai/src/__tests__/`. **Integration (7 tests)**: Golden corpus extension, ONBOARDING regression, SSE event validation, backward compatibility. Call real functions with real data. **E2E (6 tests)**: Real Studio server, real HTTP API, real auth middleware. Cross-domain workflows, tool_answer resume, ONBOARDING regression. See test spec for full details. No mocking of internal packages — card selection and prompt composition are pure functions that need no mocks. |

---

## 5. Data Model

### New Collections/Tables

None. No new collections, no schema changes.

### Modified Collections/Tables

None. The `metadata.activeSpecialist` field on `archSessions` is reused with different values (always `'abl-construct-expert'` for new IN_PROJECT turns). The field type remains `string?` — no migration needed.

### Key Relationships

- `archSessions.metadata.activeSpecialist` → display name mapping (simplified from 10-entry lookup to constant)
- `CARD_REGISTRY` → 34 cards (26 existing construct + 8 new domain) — in-memory only, no DB relationship

---

## 6. API Design

### New Endpoints

None.

### Modified Endpoints

| Method | Path                   | Change                                                                                                                                    | Impact                                                                     |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| POST   | `/api/arch-ai/message` | SSE `specialist` event `name` changes from variable specialist names to constant "Arch AI" for IN_PROJECT mode. Request schema unchanged. | Studio UI already handles arbitrary name values — no client change needed. |

### Error Responses

No new error responses. Existing error envelope unchanged.

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: No change. Arch AI session audit events are unchanged. The `activeSpecialist` field in audit context will show `'abl-construct-expert'` instead of variable specialist names.
- **Rate Limiting**: No change. Rate limits apply at the `/api/arch-ai/message` route level, not per specialist.
- **Caching**: No change. Knowledge cards are in-memory constants — no caching layer.
- **Encryption**: No change. Card content is static code. Session encryption is unchanged.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                         | Type                                        | Risk                                                      |
| -------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| `packages/arch-ai/src/knowledge/card-router.ts`    | Code — card selection engine                | Low — extending proven system                             |
| `packages/arch-ai/src/prompts/index.ts`            | Code — prompt composition                   | Low — simplifying existing function                       |
| `packages/arch-ai/src/prompts/specialists/*.ts`    | Code — specialist prompt content to extract | Low — read-only extraction                                |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | Code — message handler                      | Medium — large file (~6800 lines), surgical change needed |

### Downstream (depends on this feature)

| Consumer                  | Impact                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Studio Arch AI chat panel | SSE specialist badge text changes from variable to "Arch AI". No code change needed — UI already handles arbitrary values. |
| ONBOARDING mode           | None — explicitly excluded. `routeByContent()` preserved for ONBOARDING path.                                              |
| Future MCP surface        | Positive — MCP surface will benefit from the simpler generalist prompt path when implemented.                              |

---

## 9. Open Questions & Decisions Needed

1. **tool_answer card re-selection source**: When a `tool_answer` arrives, should card re-selection use the last user message from session history, or should it use the `pendingInteraction.originalMessage` if available? The feature spec (FR-8) says "based on conversation context" — implementation must decide the specific source.

2. **Generalist prompt tool guidance**: Should the generalist prompt include a brief "recommended tools for common tasks" section (e.g., "for debugging, start with validate_agent"), or should all tool guidance live in domain cards? A brief guide in the generalist ensures baseline tool awareness even when no domain cards load.

3. **Domain card priority relative to construct cards**: The feature spec says domain cards should have lower priority than construct cards (appended to registry). But some domain cards (e.g., diagnostics-workflow) may be more relevant than some construct cards (e.g., compaction) for specific messages. Should priority be message-dependent in a future iteration?

---

## 10. References

- Feature spec: `docs/features/sub-features/arch-ai-generalist-router.md`
- Test spec: `docs/testing/sub-features/arch-ai-generalist-router.md`
- Parent HLD: `docs/specs/arch-ai-v03.hld.md`
- Parent LLD: `docs/plans/2026-04-06-arch-ai-v03-impl-plan.md`
- Research: Agent Routing Architecture Research (2026-04-14)
- Anthropic, "Building Effective Agents" (2025)
