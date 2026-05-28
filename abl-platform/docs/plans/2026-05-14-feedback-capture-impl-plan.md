# LLD: In-Chat Feedback Capture (Platform Side) — v5

**Feature Spec**: `docs/features/feedback.md` (ALPHA)
**HLD**: `docs/specs/feedback.hld.md`
**Test Spec**: `docs/testing/feedback.md` (PLANNED)
**Prior LLD**: `docs/plans/2026-03-23-feedback-impl-plan.md` (DRAFT, not implemented)
**Parent Ticket**: ABLP-1068 — _feat: wire in-chat feedback capture (WS + persisted-id binding + agentName)_
**Consuming Ticket**: ABLP-988 — _Show captured feedback in Analytics/Insights section_ (blocked by ABLP-1068)
**Status**: DRAFT v5 — cleanup pass: D-6 wording aligned with `getMessageById`; runtime `ClientMessage` left untouched (loose-parse path); CH migration registered three ways (DDL + inline converge + manifest entry).
**v4 → v5 diff**: D-6 references `getMessageById` (was `findOne`); D-22 split into asymmetric SDK/runtime union updates (no `feedback.submit` in `ClientMessage`); D-25 + Phase 2.9 + §3 list the three migration-registration sites.
**Date**: 2026-05-14
**Scope**: Platform (`apps/runtime`, `packages/web-sdk`, `packages/database`, `packages/eventstore`, `packages/compiler` core types, `packages/observatory`) only. Sales-assistant / consumer wiring deferred.

---

## 0. Why This Plan Exists — Verified Code Gaps

Two product gaps and **eleven** implementation gaps. Every claim is grounded in `develop` HEAD `72a1b445cd`.

### Product gaps

1. **Capture is not wired.** `feedback.submitted` is registered (`packages/eventstore/src/schema/events/feedback-events.ts`). The **only emitter** is `apps/runtime/src/routes/feedback.ts:114` (email CSAT). `apps/runtime/src/websocket/sdk-handler.ts` has no `feedback.submit` case; `handleActionSubmit` (~3475) forwards every action — including `actionId='feedback'` — into `executeMessage`.
2. **No durable feedback store.** `packages/database/src/clickhouse-schemas/init.ts` has no `feedback` table. `TraceStore.addEvent` (`apps/runtime/src/services/trace-store.ts:164`) is in-memory + OTel + WS broadcast — not durable.

### Implementation gaps (each verified)

3. **`responseMessageId` ≠ persisted `_id` across three stores.** sdk-handler generates `responseMessageId = crypto.randomUUID()` (`sdk-handler.ts:1994, 2996, 3514`). `persistMessage(...)` + `PersistMessageRequest` (`apps/runtime/src/services/message-persistence-queue.ts:77, 1251`) take no `messageId`. Same divergence in **ClickHouseMessageStore** (`apps/runtime/src/services/stores/clickhouse-message-store.ts:81` — `const messageId = randomUUID();`) and `AddMessageParams` (`packages/compiler/src/platform/stores/message-store.ts:24` — no `messageId`). Three stores, three independent ids.
4. **Trace → EventStore mapper drops `feedback.submitted`.** `apps/runtime/src/services/trace/emit-to-eventstore.ts:65` returns early on unmapped types; `TRACE_TO_PLATFORM_TYPE` (`packages/observatory/src/schema/trace-event-mappings.ts:9`) has no `feedback.submitted` entry.
5. **Rich-template renderer cannot post structured feedback.** `TemplateContext` (`packages/web-sdk/src/templates/types.ts:12`) exposes `{ theme, onAction, messageId, actionRenderId }` — no `submitFeedback`. Renderer (`packages/web-sdk/src/templates/renderers/feedback.ts:41`) calls `ctx.onAction('feedback', selected)` with no comment, no messageId payload. (v2 also miswrote `ctx.renderId` — the real field is `actionRenderId`.)
6. **Transport missing `feedback.ack` case.** `packages/web-sdk/src/transport/DefaultTransport.ts` (~167) is an explicit `switch` on `type`. Without a case, ChatClient never sees the ack.
7. **`Message` / `MessageMetadata` has no `agentName`.** `packages/compiler/src/platform/core/types.ts:259-285` carries tokens/latencyMs/model/toolCalls/voiceType/custom but no `agentName`. `packages/database/src/models/message.model.ts` has no `agentName` either. "Resolve from message row" is unimplementable today.
8. **`persistMessage(...)` is already 12 positional args** (`message-persistence-queue.ts:1251`). Adding a 13th is fragile. `PersistMessageRequest` (line 77) + `persistMessageRecord(params)` (line 1282) is the options-object path.
9. **AGENTS.md E2E rules** — public-API only, no internal mocks, no direct DB. v2's E2E asserted Mongo `_id` parity and spied on `executeMessage`; those belong in integration tests.
10. **PII handling undefined across three stores.** `feedback-events.ts:29` declares `containsPII: true`. Storing raw `feedback_text` in ClickHouse + `platform_events` + TraceStore needs an explicit policy.
11. **`source` enum drift.** Spec § 9 says `source ∈ {'api'|'email'|'websocket'}` (`docs/features/feedback.md:211`). v2 invented `'rich-template-action'` — schema-spec violation.
12. **DSL `FEEDBACK:` parser exists.** `packages/core/src/parser/agent-based-parser.ts:5654` lists `'FEEDBACK'` in the multi-format key set; `packages/compiler/src/platform/ir/compiler.ts:2911` compiles it to `FeedbackTemplateIR`. v2's "no parser surface" was wrong. Studio authoring is the gap.
13. **Dedup acceptance vs. soft-allow contradiction.** v2's acceptance "duplicate → only 1 row" was unconditional, but the implementation soft-allows when Redis is down.
14. **Typed protocol unions missing entries.** v3 added the `feedback.submit`/`feedback.ack` shapes in §2 but did not list the typed unions that must absorb them. Runtime: `apps/runtime/src/types/index.ts:216` defines `ClientMessage` and `:279` defines `ServerMessage` as discriminated unions — without entries here, `ServerMessages.feedbackAck(...)` fails to typecheck. SDK: `packages/web-sdk/src/transport/types.ts:54` (`TransportClientMessage`) and `:73` (`TransportServerMessage`) are the SDK-side equivalents — `DefaultTransport`'s new `case 'feedback.ack'` will not narrow unless extended here too.
15. **`MessageStore.findOne` does not exist.** v3 said target lookup goes through `MessageStore.findOne(...)`. The abstract class at `packages/compiler/src/platform/stores/message-store.ts:60` exposes only `addMessage`, `getMessages`, `getMessageCount`, `deleteBySession`, `cleanup`. There is no `findOne` / `getById`. Either extend the abstract class with a new `getMessageById(...)` method (implemented in Mongo + CH + InMemory) **or** inject a dedicated Mongo lookup service into the feedback service. v4 picks the abstract-method path so the in-memory store keeps unit tests mock-free.
16. **`RichContent.tsx` is a pure component, no hooks.** v3 said it should "pull chat from `useAgent()`." Current implementation at `packages/web-sdk/src/react/components/RichContent.tsx:13` is a pure component receiving `{ message, onAction, theme }` as props — no React hooks. Threading `submitFeedback` requires a new prop, supplied by the owner (`ChatWidget` / `MessageList` / the React `useAgent` consumer that already has the `ChatClient`). The vanilla DOM equivalent (`packages/web-sdk/src/ui/ChatWidget.ts`, `UnifiedWidget.ts`, `renderRichMessage`) gets the same prop-threading.
17. **`abl_platform.messages.agent_name` requires a migration.** Editing `CREATE TABLE IF NOT EXISTS messages` (`init.ts:633`) only affects fresh deploys. Existing tables stay schema-unchanged. The migrations dir at `packages/database/src/clickhouse-schemas/migrations/` is the established mechanism — Phase 2 must add an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS agent_name LowCardinality(String) DEFAULT ''` migration.
18. **Feedback encryption pattern must be explicit.** `clickhouse-message-store.ts:69` wires `BufferedClickHouseWriter` with `encryptionInterceptor: getClickHouseEncryptionInterceptor() ?? undefined`. The feedback service must use the **same** writer + interceptor pattern — and the test must assert that the persisted row's `encrypted` and `key_version` columns match the interceptor's state (0/0 when interceptor absent; 1/N when present).

---

## 1. Design Decisions

| #    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                                            | Alternatives Rejected                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Both WS transports converge on one service: new `feedback.submit` AND special-cased `action_submit(actionId='feedback')` both call `feedbackService.validateAndSubmit()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Rich-template already emits `action_submit`. Dedicated message keeps the explicit path obvious for SDK consumers.                                                                                                                                                                    | Pick one transport.                                                                                                                          |
| D-2  | Action-routed feedback **short-circuits the agent loop** — `handleActionSubmit` branches on `actionId==='feedback'` and returns after `feedback.ack`, never calling `executeMessage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Fixes the "treated as a normal user query" bug.                                                                                                                                                                                                                                      | Pass through as `actionEvent`.                                                                                                               |
| D-3  | **Persisted assistant message id = transport `responseMessageId`** across **all three** stores: Mongo (`messages` model), ClickHouse `abl_platform.messages`, in-memory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Closes gap #3. ABLP-988 joins feedback ↔ messages in ClickHouse; Mongo-only fix wouldn't be enough.                                                                                                                                                                                  | Mongo only.                                                                                                                                  |
| D-4  | **Extend `AddMessageParams` + `PersistMessageRequest` with optional `messageId` AND `agentName`.** No new positional args; new fields land via the options-object path. `persistMessage(...)` becomes a thin back-compat wrapper.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Closes gaps #3 + #7 + #8.                                                                                                                                                                                                                                                            | Add positional args.                                                                                                                         |
| D-5  | **Persist `agentName` on Message model + MessageMetadata.** Add `agentName?: string` to `MessageMetadata` (`packages/compiler/src/platform/core/types.ts:270`) AND the Mongoose schema in `packages/database/src/models/message.model.ts`. Default `''` when unknown. Also expose as a top-level column on `abl_platform.messages` so CH queries don't need to parse metadata JSON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Closes gap #7.                                                                                                                                                                                                                                                                       | Top-level only — breaks IR parity. Metadata-only — CH analytics queries can't index it.                                                      |
| D-6  | **Feedback validates target message ownership** via `messageStore.getMessageById(tenantId, projectId, sessionId, messageId)` (the new abstract method added in D-23). `null` or `role !== 'assistant'` → `INVALID_TARGET`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Hard requirement of FR-12. Prevents forgery + cross-scope writes. Goes through the abstract store so the feedback service stays Mongo-agnostic.                                                                                                                                      | Direct `MessageModel.findOne(...)` from Mongo — couples feedback to Mongo, blocks in-memory unit tests.                                      |
| D-7  | **Direct EventStore emit** via `getEventStore().emitter.emit({event_type:'feedback.submitted', ...})`. Apply `scrubSecrets` before emit (parity with `emit-to-eventstore.ts:60`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Closes gap #4. Auditable; no silent drop.                                                                                                                                                                                                                                            | Add to `TRACE_TO_PLATFORM_TYPE`.                                                                                                             |
| D-8  | **TraceStore broadcast for live subscribers** — fire-and-forget; failure logs warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Studio "live trace" needs real-time visibility.                                                                                                                                                                                                                                      | Drop.                                                                                                                                        |
| D-9  | **Redis SETNX dedup** key `feedback:{tenantId}:{sessionId}:{messageId}:{userId}`, TTL 90 days. Soft-allow on Redis down. **Backstop:** ABLP-988's queries use `argMax(feedback_id) GROUP BY tenant_id, session_id, message_id, user_id` so duplicates collapse on read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Matches email CSAT pattern. Closes gap #13 — no synchronous CH SELECT on the hot path; correctness preserved at read time.                                                                                                                                                           | Pre-INSERT CH SELECT.                                                                                                                        |
| D-10 | **Auth from WS session context.** `state.permissions.chat`; tenantId/projectId/sessionId/userId from `state` + `getBoundSessionId(state)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | No new auth surface.                                                                                                                                                                                                                                                                 | New `requireProjectScope` middleware.                                                                                                        |
| D-11 | **`feedbackText` capped at 5000 chars**, treated as PII.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Free-form input.                                                                                                                                                                                                                                                                     | Unlimited.                                                                                                                                   |
| D-12 | **PII storage policy** (closes gap #10): full `feedback_text` is stored **only** in `abl_platform.feedback.feedback_text` (encrypted at rest via the existing ClickHouse interceptor when configured). EventStore `platform_events.data` carries `has_feedback_text: boolean` + `feedback_text_length: number` but **NOT** the raw text. TraceStore broadcast carries the same length+flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Matches platform's data-minimisation pattern (message bodies are encrypted in CH; only metadata leaks to `platform_events`). Studio analytics queries `feedback` directly for content.                                                                                               | Store full text everywhere — fan-out of PII; breaks deletion semantics.                                                                      |
| D-13 | **`source` stays in the documented enum** — both WS ingresses use `source='websocket'`. Distinguish ingress in a new internal column.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Closes gap #11.                                                                                                                                                                                                                                                                      | `'rich-template-action'`.                                                                                                                    |
| D-14 | **Add `ingress_type LowCardinality(String)` column to `feedback` table** — values `'feedback_submit'` / `'action_submit'` / `''` (email).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Lets ABLP-988 split flows without violating `source` enum.                                                                                                                                                                                                                           | Pack into `source`.                                                                                                                          |
| D-15 | **REST endpoint deferred.** No `POST /api/projects/:projectId/feedback` in V1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | V2 chat clients open WS already; REST is for batch / headless.                                                                                                                                                                                                                       | Land both.                                                                                                                                   |
| D-16 | **Add optional `submitFeedback` callback to `TemplateContext`** (closes gap #5). Thread it from React `RichContent` and the vanilla DOM mounter into the rich-feedback renderer. Renderer prefers `ctx.submitFeedback`; falls back to `ctx.onAction('feedback', ...)` when undefined (back-compat).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Strictly additive at the type level. Lets the rich-template post structured `{messageId, ratingType, ratingValue, feedbackText, actionRenderId}`.                                                                                                                                    | Mutate `onAction` signature.                                                                                                                 |
| D-17 | **Renderer adds thumbs-down comment input.** Textarea (≤ 5000 chars) + Send/Skip on 👎 selection; submission calls `ctx.submitFeedback(...)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Closes gap #2 (missing comment UI). Reusable across consumers.                                                                                                                                                                                                                       | UI in client only.                                                                                                                           |
| D-18 | **Renderer uses `ctx.actionRenderId`** (existing field), not `ctx.renderId` (which doesn't exist).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | v3 corrects v2's miswrite. Matches `types.ts:27`.                                                                                                                                                                                                                                    | n/a                                                                                                                                          |
| D-19 | **`DefaultTransport` `case 'feedback.ack'`** forwards to ChatClient.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Closes gap #6.                                                                                                                                                                                                                                                                       | n/a                                                                                                                                          |
| D-20 | **No DSL FEEDBACK parser changes.** Parser supports it (`agent-based-parser.ts:5654`; compile at `compiler.ts:2911`). Capture **does not depend on agent opt-in.** Studio drag-and-drop authoring is the gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Closes gap #12. Corrects v2's wording.                                                                                                                                                                                                                                               | Land a parser change.                                                                                                                        |
| D-21 | **One new parent ticket** + ABLP-988 as `is blocked by`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Capture must land first.                                                                                                                                                                                                                                                             | Roll into ABLP-988.                                                                                                                          |
| D-22 | **Asymmetric protocol-union updates** matching where each side actually parses today. **Runtime ingress (SDK handler) parses with the loose `SDKIncomingMessage` interface** (`apps/runtime/src/websocket/sdk-handler.ts:174` — `{ type: string; [key: string]: unknown }`), NOT with `ClientMessage`. The strict `ClientMessage` union is parsed only by `parseClientMessage` (`apps/runtime/src/websocket/events.ts:36`), which is an internal parser path the SDK handler does not use. Therefore: (a) **Do NOT add `feedback.submit` to `ClientMessage`**; type it SDK-handler-local via the Zod schema in `services/feedback/types.ts` (already planned). (b) Add `feedback.submit` to `TransportClientMessage` (`packages/web-sdk/src/transport/types.ts:54`) so the SDK side narrows. (c) Add `feedback.ack` to **both** `ServerMessage` (`apps/runtime/src/types/index.ts:279` — so `ServerMessages.feedbackAck(...)` typechecks) AND `TransportServerMessage` (`packages/web-sdk/src/transport/types.ts:73` — so `DefaultTransport`'s new `case 'feedback.ack'` narrows). | Closes gap #14 without inventing duplicate ingress validation. SDK handler keeps its existing loose-parse → Zod-narrow pattern; outgoing typed messages stay strictly typed.                                                                                                         | Add `feedback.submit` to `ClientMessage` without also extending `parseClientMessage` — silent type drift, parser-vs-handler divergence.      |
| D-23 | **Add abstract `getMessageById(tenantId, projectId, sessionId, messageId)` to `MessageStore`** with implementations in Mongo, CH, and in-memory stores. Feedback service calls it via DI rather than reaching into Mongo directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Closes gap #15. Keeps the layering — feedback service depends on the `MessageStore` abstraction, not on Mongo. In-memory store gets a real implementation so unit tests stay mock-free.                                                                                              | Inject a dedicated Mongo lookup service — couples feedback to Mongo specifically; harder to test.                                            |
| D-24 | **Thread `submitFeedback` through props**, not hooks. `RichContent.tsx` gains a `submitFeedback?: (...)=>Promise<...>` prop. The owning component (`MessageList` / `ChatWidget` / consumer-side `useAgent` user) constructs it from the active `ChatClient` and passes it in. Vanilla DOM widgets do the same through their existing render pipeline.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Closes gap #16. Preserves RichContent's existing purity contract (no hooks, no SDK coupling) and lets non-React consumers wire it through their own composition.                                                                                                                     | Make RichContent stateful — breaks every existing pure caller / test snapshot.                                                               |
| D-25 | **Three-part CH migration registration** matching the actual repo mechanism: (a) **Inline converge DDL** in `packages/database/src/clickhouse-schemas/init.ts` alongside the existing `TABLES_NEEDING_ENC_COLUMN` block (~line 1644) — `ALTER TABLE ${DATABASE}.messages ADD COLUMN IF NOT EXISTS agent_name LowCardinality(String) DEFAULT ''` runs on every init pass. (b) **Standalone migration file** `packages/database/src/clickhouse-schemas/migrations/add-agent-name-to-messages.ts` (idempotent, same `ALTER`) for explicit invocation paths. (c) **Manifest entry** in `packages/database/src/change-management/manifest.ts` (~line 695, alongside the `clickhouse.add-custom-dimensions` entry) tracking the migration's lifecycle, environments, and reversibility for the change-management tooling.                                                                                                                                                                                                                                                                | Closes gap #17 the way the repo actually tracks ClickHouse changes. Inline converge guarantees idempotent application on fresh deploys + restarts; standalone file gives the migration a tracked source-of-truth; manifest entry hooks it into the change-management UI/audit trail. | Single mechanism only — leaves either (a) fresh deploys without the column, (b) untracked schema drift, or (c) invisible-to-audit migration. |
| D-26 | **Feedback service uses the existing `BufferedClickHouseWriter` + `getClickHouseEncryptionInterceptor()` pattern.** Same constructor shape as `ClickHouseMessageStore` (`clickhouse-message-store.ts:69`). Test asserts `encrypted` and `key_version` columns reflect the interceptor's state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Closes gap #18. Avoids ad-hoc encryption code; matches the platform's existing pattern.                                                                                                                                                                                              | Direct CH client `insert` — bypasses interceptor; `feedback_text` lands plaintext.                                                           |

---

## 2. Contract

### 2.1 WS `feedback.submit` (new client → server)

```jsonc
{
  "type": "feedback.submit",
  "messageId": "<uuid — MUST equal a persisted assistant message id in this session>",
  "ratingType": "thumbs" | "star" | "text",
  "ratingValue": 0 | 1 | <1..5>,        // ignored for ratingType='text'
  "feedbackText": "<optional, ≤ 5000 chars>",
  "actionRenderId": "<optional — echoed if rendered via a rich-template surface>"
}
```

### 2.2 WS `action_submit` with `actionId='feedback'` (existing; extended)

```jsonc
{
  "type": "action_submit",
  "actionId": "feedback",
  "value": "up" | "down" | "1".."5",
  "formData": {
    "messageId": "<uuid — REQUIRED in V1>",
    "feedbackText": "<optional>"
  },
  "renderId": "<optional, opaque — already on action_submit envelope; echoed as actionRenderId in ack>"
}
```

Server normaliser: `'up'→thumbs/1`; `'down'→thumbs/0`; `'1'..'5'→star/N`.

### 2.3 WS `feedback.ack` (new server → client)

```jsonc
// success
{ "type": "feedback.ack", "feedbackId": "<uuid>", "messageId": "<uuid>", "actionRenderId": "<echoed>", "success": true }
// failure
{ "type": "feedback.ack", "messageId": "<uuid>", "actionRenderId": "<echoed>", "success": false,
  "error": { "code": "DUPLICATE_FEEDBACK" | "INVALID_INPUT" | "INVALID_TARGET" | "STORAGE_FAILURE", "message": "..." } }
```

### 2.4 EventStore event (PII-minimised — D-12)

```ts
getEventStore().emitter.emit({
  event_id: feedbackId,
  event_type: 'feedback.submitted',
  category: EVENT_CATEGORIES.FEEDBACK,
  tenant_id, project_id, session_id,
  trace_id: session_id,
  agent_name,                       // looked up from persisted message row; '' when unknown
  timestamp: <Date>,
  data: {
    rating_type, rating_value,
    target_message_id,
    has_feedback_text: boolean,
    feedback_text_length: number,
    ingress: 'feedback_submit' | 'action_submit',
    // raw feedback_text NOT included
  },
});
```

### 2.5 TraceStore event (live; PII-minimised — D-12)

Same payload shape as 2.4 minus `ingress`. No raw text.

### 2.6 ClickHouse `abl_platform.feedback` (V1)

Schema = feature spec § 9 + one V1 addition: `ingress_type LowCardinality(String) DEFAULT ''` (D-14). `feedback_text` carries the raw comment, encrypted at rest via the existing CH interceptor when configured (pattern at `apps/runtime/src/services/stores/clickhouse-message-store.ts:75`).

### 2.7 `TemplateContext` (extended)

```ts
// packages/web-sdk/src/templates/types.ts
export interface TemplateContext {
  theme: Record<string, string>;
  onAction: (
    actionId: string,
    value?: string,
    options?: ActionSubmitOptions & { label?: string },
  ) => void;
  messageId: string;
  actionRenderId?: string;
  /**
   * NEW (D-16): optional first-class feedback submission callback. When present,
   * the rich-feedback renderer SHOULD call this instead of `onAction('feedback', ...)`.
   * Fallback to onAction preserves back-compat with older consumers.
   *
   * IMPORTANT (D-24): the renderer passes ONLY rating data. `messageId` and
   * `actionRenderId` are bound by the closure at the threading site
   * (RichContent / MessageList / vanilla mounter) — that's how the owning
   * component connects the renderer to the current ChatClient and the message
   * being rated. Renderer tests assert the rating-data input; threading tests
   * (separate) assert that the closure forwards the correct messageId and
   * actionRenderId to `chat.submitFeedback(...)`.
   */
  submitFeedback?: (input: {
    ratingType: 'thumbs' | 'star' | 'text';
    ratingValue: number;
    feedbackText?: string;
  }) => Promise<{ feedbackId: string }>;
}
```

---

## 3. Module Boundaries

| Module                                                                                                  | New / Modified | Responsibility                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/database/src/clickhouse-schemas/init.ts`                                                      | Modified       | Two edits: (a) Append `feedback` DDL with `ingress_type`. (b) Update `messages` DDL to include `agent_name` for fresh deploys. (c) Add **inline converge ALTER** alongside the existing `TABLES_NEEDING_ENC_COLUMN` block (~line 1644) for existing deployments (D-25 part b).                                                    |
| `packages/database/src/clickhouse-schemas/migrations/add-agent-name-to-messages.ts`                     | **New**        | Standalone idempotent migration file (D-25 part c).                                                                                                                                                                                                                                                                               |
| `packages/database/src/change-management/manifest.ts`                                                   | Modified       | Add `clickhouse.add-agent-name-to-messages` entry alongside `clickhouse.add-custom-dimensions` (~line 695) (D-25 part d).                                                                                                                                                                                                         |
| `packages/database/src/models/message.model.ts`                                                         | Modified       | Add `agentName: { type: String, default: '' }` to schema (D-5).                                                                                                                                                                                                                                                                   |
| `packages/compiler/src/platform/core/types.ts`                                                          | Modified       | Add `agentName?: string` to `MessageMetadata` (D-5).                                                                                                                                                                                                                                                                              |
| `packages/compiler/src/platform/stores/message-store.ts`                                                | Modified       | `AddMessageParams.messageId?: string`, `agentName?: string` (D-3, D-4, D-5). **New abstract method `getMessageById(tenantId, projectId, sessionId, messageId): Promise<Message \| null>`** (D-23). Implementations in Mongo, CH, in-memory.                                                                                       |
| `apps/runtime/src/services/stores/clickhouse-message-store.ts`                                          | Modified       | `const messageId = params.messageId ?? randomUUID();`. Persist `agentName` column. Implement `getMessageById`.                                                                                                                                                                                                                    |
| In-memory message store(s)                                                                              | Modified       | Honour `params.messageId` and `params.agentName`. Implement `getMessageById`.                                                                                                                                                                                                                                                     |
| Mongo-backed message store / `Message.model.ts` consumers                                               | Modified       | Add a `getMessageById` adapter on top of the model.                                                                                                                                                                                                                                                                               |
| `apps/runtime/src/services/message-persistence-queue.ts`                                                | Modified       | `PersistMessageRequest.messageId?: string`, `agentName?: string`. Propagate to stores. `persistMessage(...)` legacy positional API stays as a thin wrapper.                                                                                                                                                                       |
| `apps/runtime/src/websocket/sdk-handler.ts`                                                             | Modified       | (a) On every assistant `persistMessage*` call, pass `{ messageId: responseMessageId, agentName: <execution context> }`. (b) `case 'feedback.submit'`. (c) Branch in `handleActionSubmit` for `actionId='feedback'`.                                                                                                               |
| `apps/runtime/src/types/index.ts`                                                                       | Modified       | Add `{ type: 'feedback.ack', ... }` to `ServerMessage` (~line 279) (D-22). **Do NOT extend `ClientMessage`** — SDK handler parses with the loose `SDKIncomingMessage` shape at `sdk-handler.ts:174` and narrows via Zod; `parseClientMessage` (`events.ts:36`) is a different parser path that's not on the SDK feedback ingress. |
| `apps/runtime/src/services/feedback/types.ts`                                                           | New            | Zod + TS + `normaliseActionSubmit`.                                                                                                                                                                                                                                                                                               |
| `apps/runtime/src/services/feedback/feedback-service.ts`                                                | New            | Target lookup via injected `MessageStore.getMessageById` (D-6, D-23) → dedup (D-9) → CH INSERT via `BufferedClickHouseWriter` + `getClickHouseEncryptionInterceptor()` (D-26) → direct EventStore emit (D-7, D-12) → TraceStore broadcast (D-8, D-12).                                                                            |
| `apps/runtime/src/services/feedback/dedup.ts`                                                           | New            | Redis SETNX with soft-allow.                                                                                                                                                                                                                                                                                                      |
| `apps/runtime/src/services/feedback/agent-attribution.ts`                                               | New            | Read `agentName` from `MessageStore.getMessageById(...)` result (reliable post D-5, D-23).                                                                                                                                                                                                                                        |
| `apps/runtime/src/websocket/events.ts`                                                                  | Modified       | `ServerMessages.feedbackAck(...)`.                                                                                                                                                                                                                                                                                                |
| `packages/web-sdk/src/transport/types.ts`                                                               | Modified       | Add `{ type: 'feedback.submit', ... }` to `TransportClientMessage` (~line 54). Add `{ type: 'feedback.ack', ... }` to `TransportServerMessage` (~line 73) (D-22).                                                                                                                                                                 |
| `packages/web-sdk/src/transport/DefaultTransport.ts`                                                    | Modified       | `case 'feedback.ack'`.                                                                                                                                                                                                                                                                                                            |
| `packages/web-sdk/src/chat/ChatClient.ts`                                                               | Modified       | `submitFeedback(...)`, pending registry, ack handler.                                                                                                                                                                                                                                                                             |
| `packages/web-sdk/src/chat/types.ts`                                                                    | Modified       | `feedbackAck` chat event.                                                                                                                                                                                                                                                                                                         |
| `packages/web-sdk/src/templates/types.ts`                                                               | Modified       | Optional `submitFeedback` on `TemplateContext` (D-16). Renderer-input shape is rating-data only; messageId + actionRenderId bound by closure at the threading site.                                                                                                                                                               |
| `packages/web-sdk/src/react/components/RichContent.tsx`                                                 | Modified       | **Add `submitFeedback?: (...)=>Promise<...>` to `RichContentProps`** and pass it into the constructed `TemplateContext` (D-24). Stays pure — no hooks, no SDK coupling.                                                                                                                                                           |
| `packages/web-sdk/src/react/components/MessageList.tsx` (or equivalent)                                 | Modified       | Threading site (React): pull `chat` from `useAgent()` and construct the closure: `submitFeedback={(input) => chat.submitFeedback({ messageId: message.id, ...input, actionRenderId: message.actions?.renderId })}`. Pass to `<RichContent submitFeedback={...} />`.                                                               |
| `packages/web-sdk/src/ui/ChatWidget.ts`, `UnifiedWidget.ts`, `renderRichMessage` (vanilla DOM mounters) | Modified       | Threading site (vanilla): build the equivalent closure at `renderRichMessage` time using the widget's bound `ChatClient`; pass to the renderer through the existing context-construction path (D-24).                                                                                                                             |
| `packages/web-sdk/src/templates/renderers/feedback.ts`                                                  | Modified       | Prefer `ctx.submitFeedback`; thumbs-down reveals textarea + Send/Skip; uses `ctx.actionRenderId`. Fallback to `ctx.onAction` when `submitFeedback === undefined`.                                                                                                                                                                 |

**Untouched in V1**: Studio app, email `routes/feedback.ts`, DSL parser (already supports FEEDBACK), materialized views, REST endpoint, sales-assistant consumer.

---

## 4. Phased Implementation

### Phase 1 — ClickHouse `feedback` table + Zod surface

1.1 Append `feedback` DDL incl. `ingress_type`. Audit `abl_platform.messages` DDL for `agent_name`; add column if missing.
1.2 `services/feedback/types.ts` — `FeedbackSubmitSchema`, `normaliseActionSubmit`, TS interfaces.

Tests: ≥ 20 Zod cases (valid combos, invalid combos, missing messageId in action, comment > 5000, etc.).

Commit: `[ABLP-1068] feat(runtime,database): add feedback table DDL + Zod schemas`

### Phase 2 — Message-id + `agentName` plumbing across stores (D-3, D-4, D-5, D-23, D-25)

2.1 `core/types.ts` — `MessageMetadata.agentName?: string`.
2.2 `message.model.ts` — Mongoose schema field `agentName` (default `''`).
2.3 `message-store.ts` — `AddMessageParams.messageId?`, `agentName?`. **Add abstract method `getMessageById(tenantId, projectId, sessionId, messageId): Promise<Message | null>`** (D-23). Default implementations are NOT permissible — subclasses must implement.
2.4 `clickhouse-message-store.ts` — (a) `params.messageId ?? randomUUID()`; (b) write `agentName` column; (c) implement `getMessageById` (CH SELECT against `abl_platform.messages` filtered by tenant/project/session/message_id, mapping to `Message`).
2.5 In-memory store — same: honour `messageId` + `agentName`; implement `getMessageById` (Map lookup).
2.6 Mongo-backed lookup adapter — implement `getMessageById` reading from `MessageModel.findOne({ _id, tenantId, projectId, sessionId })`. Wherever the runtime selects which store to use for read paths (search for `MessageStore` resolution in `apps/runtime/src/services/stores/`), make sure the lookup-bearing store is the one passed to the feedback service.
2.7 `message-persistence-queue.ts` — `PersistMessageRequest.messageId?`, `agentName?`. Forward to stores. `persistMessage(...)` legacy wrapper unchanged signature; internally builds the request (D-4, D-8).
2.8 `sdk-handler.ts` — pass `{ messageId: responseMessageId, agentName: <from execution context> }` at every assistant `persistMessage*` call (≥ 3 sites today; grep audit before commit).
2.9 **ClickHouse DDL + migration**, three parts per the repo's actual mechanism (D-25):

- (a) Update the `messages` DDL in `init.ts` (~line 633) to include `agent_name LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))` so fresh deploys get the column natively.
- (b) Add an inline converge ALTER in `init.ts` alongside the existing `TABLES_NEEDING_ENC_COLUMN` loop (~line 1644):
  ```ts
  await runSchemaCommand(
    'alter-add-column:messages.agent_name',
    `ALTER TABLE ${DATABASE}.messages ADD COLUMN IF NOT EXISTS agent_name LowCardinality(String) DEFAULT ''`,
  );
  ```
  This runs on every schema init pass, so existing deployments converge on the next restart.
- (c) Add a standalone file `packages/database/src/clickhouse-schemas/migrations/add-agent-name-to-messages.ts` with the same idempotent ALTER, exported as a function the change-management tooling can invoke manually.
- (d) Add an entry to `packages/database/src/change-management/manifest.ts` (alongside `clickhouse.add-custom-dimensions` at line ~695) with id `clickhouse.add-agent-name-to-messages`, `kind: 'schema'`, `phase: 'pre_deploy'`, `trigger: 'manual'`, `blocking: 'manual_only'`, `scope: 'global'`, `environments: ALL_ENVIRONMENTS`, `lifecycle: 'inventory_only'`, `reversibility: 'forward_only'`, `destructive: false`, `sourcePaths: ['packages/database/src/clickhouse-schemas/migrations/add-agent-name-to-messages.ts']`.

Tests:

- Migration unit test: apply (c) twice; second application is a no-op (idempotent `IF NOT EXISTS`).
- Init test (if one exists for the converge path): boot the schema init twice; column appears once, no error on second boot.
- Manifest test (per existing change-management test patterns): the new entry is included in the manifest export and has the expected shape.

Tests:

- Unit per store: id and agentName honoured when supplied; fall back to random / empty otherwise. `getMessageById` returns the expected row; returns `null` for unknown / cross-scope / wrong session.
- **Integration `message-id-binding.integration.test.ts`**: drive a chat through WS → read **both** Mongo `messages` and CH `abl_platform.messages` → assert `_id == responseMessageId` AND `agent_name == <expected>` in both stores. Then call `messageStore.getMessageById(...)` for each store and assert it returns the same row.
- **Migration unit test** (per existing migrations pattern): apply the migration twice; second application is a no-op (idempotent `IF NOT EXISTS`).

Commit: `[ABLP-1068] feat(runtime,compiler,database): bind persisted message id to responseMessageId, persist agentName, add CH migration + MessageStore.getMessageById`

### Phase 3 — Feedback service (D-6, D-7, D-9, D-12, D-23, D-26)

3.1 `dedup.ts` — Redis SETNX with soft-allow.
3.2 `agent-attribution.ts` — call injected `messageStore.getMessageById(...)` (D-23) and return `agentName` from the row.
3.3 `feedback-service.ts`:

- **Construction**: takes injected dependencies — `messageStore: MessageStore` (for `getMessageById`), `chClient`, `redis`, `eventStore`, `traceStore`. Internally builds a `BufferedClickHouseWriter` with `table: 'abl_platform.feedback'`, `encryptionInterceptor: getClickHouseEncryptionInterceptor() ?? undefined` — same pattern as `ClickHouseMessageStore` (`clickhouse-message-store.ts:69`) (D-26).
- A: target lookup → `messageStore.getMessageById(ctx.tenantId, ctx.projectId, ctx.sessionId, input.messageId)`. Missing / `role !== 'assistant'` → `INVALID_TARGET`. Read `agent_name` from the returned row.
- B: dedup. Hit → `DUPLICATE_FEEDBACK`.
- C: build `FeedbackRecord` (`source='websocket'`, `ingress_type` from caller, `has_pii = feedback_text ? 1 : 0`). **`encrypted` and `key_version` are set by the interceptor at flush time — service writes plaintext into the row** (matches `clickhouse-message-store.ts:85` precedent).
- D: enqueue via `writer.enqueue(row)`; on flush failure → release Redis lock → `STORAGE_FAILURE`.
- E: `scrubSecrets(data)` then `getEventStore().emitter.emit({event_type:'feedback.submitted', data: { rating_type, rating_value, target_message_id, has_feedback_text, feedback_text_length, ingress }})` — raw text excluded (D-12).
- F: TraceStore broadcast with same PII-minimised shape.
- Return `{ ok: true, feedbackId }`.

Tests (unit, ≥ 16 cases) — clients DI'd; no internal mocks. **Encryption assertion**: with an interceptor configured, the persisted row's `encrypted` column = 1 and `key_version` matches the interceptor's `keyVersion`; with no interceptor, both columns = 0. Test by injecting a fake interceptor that records what it sees, and asserting the row passed to it has plaintext `feedback_text`.

Commit: `[ABLP-1068] feat(runtime): add feedback service (target validation via MessageStore.getMessageById, dedup, encrypted CH insert via BufferedWriter, direct EventStore emit)`

### Phase 4 — WS handlers + ack constructor + runtime typed protocol (D-22)

4.1 **`apps/runtime/src/types/index.ts`** — extend only the outgoing union (D-22):

- Add to `ServerMessage` (~line 279): `| { type: 'feedback.ack'; feedbackId?: string; messageId: string; actionRenderId?: string; success: boolean; error?: { code: string; message: string } }`.
- **Do NOT add `feedback.submit` to `ClientMessage`.** The SDK handler parses raw input with `SDKIncomingMessage` (`sdk-handler.ts:174` — `{ type: string; [key: string]: unknown }`), not `ClientMessage`, so the new case is validated via the Zod schema in `services/feedback/types.ts` at the handler entry. Adding to `ClientMessage` without also extending `parseClientMessage` (`events.ts:36`) would create a strict-union member that no code path ever produces.

  4.2 `ServerMessages.feedbackAck(messageId, actionRenderId, result)` — return type narrows to the new `ServerMessage` union member.
  4.3 `sdk-handler.ts`:

- New `case 'feedback.submit'` → `handleFeedbackSubmit` (permissions gate → parse → SubmitContext → service → ack).
- `handleActionSubmit`: branch on `actionId==='feedback'` → normalise → helper → ack → **return** (no `executeMessage`).

Integration tests (≥ 7):

- `feedback.submit` thumbs-down → 1 CH row, 1 ES emit (DI spy), 1 TraceStore event, ack success.
- Cross-scope `messageId` → `INVALID_TARGET`.
- Duplicate (Redis up) → `DUPLICATE_FEEDBACK`.
- `action_submit(actionId='feedback', value='down', formData.messageId=X)` → identical effect; **`executeMessage` spy not called**.
- `action_submit(actionId='feedback', value='down', formData={})` → `INVALID_INPUT`.
- `action_submit(actionId='confirm_booking', value='yes')` → `executeMessage` IS called (regression).
- `feedback.submit` for `role:'user'` messageId → `INVALID_TARGET`.

Commit: `[ABLP-1068] feat(runtime): wire WS feedback.submit and action_submit(feedback) to feedback service`

### Phase 5 — Web-SDK transport + ChatClient.submitFeedback (D-22)

5.1 **`packages/web-sdk/src/transport/types.ts`** — extend the typed unions:

- Add to `TransportClientMessage` (~line 54): `| { type: 'feedback.submit'; messageId: string; ratingType: 'thumbs'|'star'|'text'; ratingValue: number; feedbackText?: string; actionRenderId?: string }`.
- Add to `TransportServerMessage` (~line 73): `| { type: 'feedback.ack'; feedbackId?: string; messageId: string; actionRenderId?: string; success: boolean; error?: { code: string; message: string } }`.

  5.2 `DefaultTransport.ts` — `case 'feedback.ack'` (now narrows after 5.1).
  5.3 `chat/types.ts` — `feedbackAck` event in `ChatEvents`.
  5.4 `ChatClient.ts` — `pendingFeedback: Map<string, …>` keyed `${messageId}|${actionRenderId ?? ''}`. `submitFeedback(input)` sends WS msg, registers pending, resolves/rejects on ack, default 10 s timeout (`FEEDBACK_TIMEOUT` error code on timeout).

Tests (unit):

- Payload shape matches § 2.1.
- Resolves on success ack; rejects with `error.code` on failure ack; rejects with `FEEDBACK_TIMEOUT` on timeout.
- `feedback.ack` round-trip through `DefaultTransport`.

Commit: `[ABLP-1068] feat(web-sdk): add chat.submitFeedback and feedback.ack transport wiring`

### Phase 6 — Rich-template renderer (TemplateContext.submitFeedback)

6.1 `templates/types.ts` — optional `submitFeedback` on `TemplateContext`. Input shape is **rating-data only** (D-24).
6.2 `RichContent.tsx` — **stays pure**. Add `submitFeedback?: (input)=>Promise<{feedbackId:string}>` to `RichContentProps`. Construct `ctx.submitFeedback` by passing `props.submitFeedback` through (no hooks here).
6.3 React owner (`MessageList.tsx` or the host component that already calls `<RichContent message={...} onAction={...} />`): pull `chat` from `useAgent()` and bind the closure:

```ts
<RichContent
  message={message}
  onAction={onAction}
  submitFeedback={(input) =>
    chat.submitFeedback({
      messageId: message.id,
      actionRenderId: message.actions?.renderId,
      ...input,
    })
  }
/>
```

6.4 Vanilla DOM mounters (`ChatWidget.ts`, `UnifiedWidget.ts`, `renderRichMessage`): build the equivalent closure where they currently construct the `TemplateContext`. Use the widget's bound `ChatClient`.
6.5 `renderers/feedback.ts`:

- `thumbs`: 👍 → immediate submit. 👎 → reveal textarea (≤ 5000) + Send / Skip → submit.
- All submissions call `ctx.submitFeedback({ ratingType, ratingValue, feedbackText? })` — **no `messageId`, no `actionRenderId`** in the call (closure has them per D-24). When undefined, fall back to `ctx.onAction('feedback', selected)` (back-compat).
- Disable controls after success ack.
- Uses `ctx.actionRenderId` only for ARIA / dataset attributes, **not** for the submit payload (D-18, D-24).

Renderer tests (`renderer-feedback.test.ts`):

- Thumbs-down reveals textarea + Send/Skip.
- Submitting calls `ctx.submitFeedback` with `{ ratingType:'thumbs', ratingValue:0, feedbackText:'…' }` — assert the input matches the rating-data-only shape; assert `messageId`/`actionRenderId` are NOT in the submitted input.
- Skip submits without `feedbackText`.
- Success ack → controls disabled.
- When `ctx.submitFeedback === undefined` → falls back to `ctx.onAction` (back-compat snapshot test).

Threading tests (separate, in the React owner's test file): when the owner constructs the closure and the renderer calls it, the resulting `chat.submitFeedback(...)` is invoked with the correct `messageId` and `actionRenderId` resolved from the message being rated.

Commit: `[ABLP-1068] feat(web-sdk): rich feedback renderer posts via TemplateContext.submitFeedback + adds thumbs-down comment input`

### Phase 7 — E2E (SDK/WS visible behaviour only — AGENTS.md compliant)

`feedback-capture.e2e.test.ts` — real Express+WS+`@agent-platform/web-sdk` client, real Redis (testcontainers), CH + ES wired via the runtime's own factory in test mode (no internal interception). Assertions are **only** SDK/WS visible behaviour:

- **E2E-1**: connect → `chat.send('hello')` → assistant reply → `chat.submitFeedback({messageId, ratingType:'thumbs', ratingValue:1})` resolves with non-empty `feedbackId`.
- **E2E-2**: `chat.submitFeedback({messageId:'<unknown uuid>'})` rejects with `error.code === 'INVALID_TARGET'`.
- **E2E-3**: thumbs-down with `feedbackText: "missing 5G info"` resolves. **No new assistant `responseStart`/`responseEnd` arrives within 1.5 s of the ack** (proxy for "executeMessage not invoked"). `chat.getMessages().length` unchanged before vs. after submit.
- **E2E-4**: duplicate `submitFeedback` for same `messageId` → second rejects with `error.code === 'DUPLICATE_FEEDBACK'` (Redis up in test env).
- **E2E-5**: `chat.submitFeedback({ feedbackText: 'x'.repeat(5001) })` rejects with `error.code === 'INVALID_INPUT'`.
- **E2E-6**: raw `chat.submitAction('feedback', { value: 'down', formData: { messageId, feedbackText: 'bad' } })` → no new assistant turn within 1.5 s; transcript length unchanged.

DB / spy assertions (CH row count, ES emit count, `executeMessage` not invoked, `_id == responseMessageId`, agentName equals expected) live in the **integration suite** (Phases 2 + 3 + 4) — where DI fakes and direct store reads are permitted.

Commit: `[ABLP-1068] test(runtime): E2E coverage for in-chat feedback capture (public surface)`

### Phase 8 — Post-impl sync

8.1 `docs/features/feedback.md`:

- ALPHA → **BETA** after Phase 7 + `phase-auditor` clean.
- API table: WS rows shipped, REST/stats rows NOT IMPLEMENTED.
- Implementation-status callout with file:line trace.
- Fix wording on FEEDBACK parser status — D-20.

  8.2 `docs/testing/feedback.md`:

- **Do NOT re-scope FR-1.** FR-1 in the feature spec is explicitly REST (`docs/features/feedback.md:77` — "POST /api/projects/:projectId/feedback"). Leave it as **NOT IMPLEMENTED (deferred)** to preserve doc honesty.
- **FR-8 is the WS-specific FR** that already exists in the spec (`docs/features/feedback.md:82` — "WebSocket message type `feedback.submit` with payload `{ messageId, ratingType, ratingValue, feedbackText? }`"). Mark **FR-8 PASS** once Phase 7 E2Es land.
- Mark PASS: FR-2 (validation), FR-5 (trace event — re-worded: emission is to EventStore directly, TraceStore broadcast is a parallel non-durable path), FR-6 (CH insert), FR-8 (WS), FR-11 (envelope — but acks use the WS envelope, not the REST `{success,data,error}` shape; clarify in the test note), FR-12 (session-project binding via target lookup).
- Rephrase FR-4: dedup via Redis SETNX + read-side `argMax` backstop. The HTTP 409 wording does not apply (WS path returns `feedback.ack` with `error.code='DUPLICATE_FEEDBACK'`). Mark PASS, with explicit note about the wire-level shape difference.
- Leave **FR-1** (REST), **FR-3** (createUnifiedAuthMiddleware + requireProjectScope — REST-only), **FR-9** (stats endpoints), **FR-10** (rate limit) as **NOT IMPLEMENTED (deferred)**.
- New FRs to add (post the existing ones, do not renumber):
  - **FR-13**: target-message ownership validation (asserts the messageId belongs to tenant/project/session and `role='assistant'`; otherwise `INVALID_TARGET`).
  - **FR-14**: durable EventStore emission via `getEventStore().emitter.emit(...)` with PII-minimised data (per D-12).
  - **FR-15**: persisted message id binding — Mongo `_id` and CH `message_id` both equal the transport `responseMessageId`.
  - **FR-16**: `action_submit(actionId='feedback')` short-circuits the agent loop (no `executeMessage` invocation).
  - **FR-17**: PII storage policy — raw `feedback_text` only in `abl_platform.feedback.feedback_text`; EventStore + TraceStore carry only `has_feedback_text` + `feedback_text_length`.

    8.3 `docs/specs/feedback.hld.md` — status per concern.
    8.4 `agents.md` updates: `packages/eventstore`, `apps/runtime`, `packages/web-sdk`, `packages/database`, `packages/compiler`.
    8.5 ABLP-988 comment with the trace.
    8.6 `phase-auditor` run.

Commit: `[ABLP-1068] docs(feedback): post-impl-sync — capture wired (WS), REST/Studio deferred`

---

## 5. Test Strategy Summary

| Layer       | Coverage                                                                                                                                | Allowed                                                                     | Banned                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Unit        | Zod, normaliser, dedup, agent attribution, ChatClient.submitFeedback, renderer interaction.                                             | Pure functions; clients via DI.                                             | `vi.mock('@agent-platform/*')`, `vi.mock('@abl/*')`, relative-import mocks. |
| Integration | sdk-handler in-process; real Redis; DI-fake CH + ES; `executeMessage` spy; direct Mongo + CH reads to assert id + agentName parity.     | DI fakes; real Redis; real Mongo; direct store reads from the test process. | Same as Unit.                                                               |
| E2E         | Real Express+WS+SDK; SDK/WS-observable assertions: promise resolve/reject codes, no new assistant turn within 1.5 s, transcript length. | Real Mongo / Redis / CH via runtime's own factory.                          | Internal mocks; direct DB reads from the test; runtime-internal spies.      |
| Regression  | Non-feedback `action_submit` still hits agent; non-feedback `chat_message` persists with auto-id.                                       |                                                                             |                                                                             |
| Audits      | `pr-reviewer` (5 rounds); `data-flow-audit` (2 rounds) for `messageId` + `feedbackText`; `phase-auditor` after Phase 8.                 |                                                                             |                                                                             |

---

## 6. Risk Register

| #    | Risk                                                                                       | Mitigation                                                                                                                                              | L × I |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| R-1  | `handleActionSubmit` branch regresses existing rich-content buttons.                       | Phase 4 INT regression + Phase 7 E2E-6 ("no new turn"). Branch ≤ 12 LOC at top of handler.                                                              | M × H |
| R-2  | Threading `messageId` through three stores changes id semantics across callers.            | Param is optional; legacy paths unchanged. Full runtime + compiler + database test suites. Phase 2 INT pins parity.                                     | M × H |
| R-3  | Mongo `agentName` missing on legacy docs.                                                  | Default `''`; queries treat empty as "unknown". No migration.                                                                                           | L × L |
| R-4  | Direct EventStore emit bypasses trace mapper's PII scrubbing.                              | Service explicitly calls `scrubSecrets(...)`; unit-tested.                                                                                              | M × M |
| R-5  | ClickHouse table absent in dev breaks chat.                                                | Service returns `STORAGE_FAILURE` ack; never throws into WS loop. Chat unaffected.                                                                      | L × M |
| R-6  | Redis down → duplicates in CH.                                                             | Soft-allow + read-side `argMax`. ABLP-988 acknowledges the pattern.                                                                                     | L × L |
| R-7  | Renderer change ships in web-sdk but a consumer pins older sdk.                            | Optional `submitFeedback` on `TemplateContext`. Fallback to `onAction` preserves behaviour. Snapshot-tested.                                            | L × L |
| R-8  | Sales-assistant `__feedback__` chat path continues → double-counting.                      | Out of scope. Documented in ticket. Memory note exists.                                                                                                 | L × M |
| R-9  | PII policy mis-applied.                                                                    | Explicit D-12 policy; agents.md note; unit-tested ES + TraceStore payloads carry only length+flag.                                                      | L × M |
| R-10 | `ingress_type` column drifts from spec.                                                    | Phase 8 updates spec § 9 to include the column. Internal-only.                                                                                          | L × L |
| R-11 | Missing a message-creation site during Phase 2 → CH and Mongo `_id` divergence at runtime. | Grep audit: `randomUUID()` / `crypto.randomUUID()` in `**/stores/**` and every sdk-handler `persistMessage*` call. Phase 2 INT test catches at runtime. | M × M |

---

## 7. Acceptance Criteria

- [ ] `chat.submitFeedback({messageId, ratingType:'thumbs', ratingValue:0})` against a real persisted assistant message returns a `feedbackId` within 1 s p95.
- [ ] One row in `abl_platform.feedback` with `message_id == responseMessageId == Mongo messages._id == CH messages.message_id`, correct `tenant_id`/`project_id`/`session_id`/`user_id`/`agent_name`/`rating_type`/`rating_value`/`feedback_text`/`source='websocket'`/`ingress_type`.
- [ ] One `feedback.submitted` row in `platform_events` carrying PII-minimised data only (D-12) — raw `feedback_text` NOT present in `platform_events.data`.
- [ ] One TraceStore broadcast with the same PII-minimised shape.
- [ ] Thumbs-down with comment text: raw text in `feedback.feedback_text` only — not in `platform_events`, not in TraceStore, not as a chat message. Transcript length unchanged. Agent does not respond.
- [ ] `action_submit(actionId='feedback', ...)` produces identical effects to `feedback.submit` and does NOT invoke `executeMessage` (integration spy; E2E proxy via "no new turn within 1.5 s").
- [ ] Duplicate submission **when Redis is available** → `DUPLICATE_FEEDBACK`; only 1 row.
- [ ] **When Redis is unavailable** duplicates may write twice; **read-side `argMax(feedback_id) GROUP BY (tenant_id, session_id, message_id, user_id)`** collapses to 1. (ABLP-988 query path documented in spec § 9.)
- [ ] Feedback for an unknown / cross-scope / `role:'user'` `messageId` → `INVALID_TARGET`; no row.
- [ ] Email CSAT (`GET /api/v1/feedback/:token`) regression-free.
- [ ] All Phase-7 E2E + ≥ 7 integration + ≥ 16 unit scenarios pass.
- [ ] `phase-auditor`, `pr-reviewer` (5 rounds), `data-flow-audit` (2 rounds) clean.
- [ ] ABLP-988 commented with the message-flow trace.

---

## 8. Doc Honesty Rules (post-impl-sync invariants)

- **FR-1 (REST) stays DEFERRED.** Do not re-scope it to WS. The feature spec FR-1 is explicit about REST; the WS FR is **FR-8**, which already exists in the spec. Mark FR-8 PASS, leave FR-1 unchanged.
- Do NOT mark FR-3 / FR-9 / FR-10 as PASS — REST-only / not implemented.
- Do NOT mark Studio FRs as PASS — out of scope.
- DSL parser status reads: **parser/compiler support exists (`agent-based-parser.ts:5654`, `compiler.ts:2911`); Studio drag-and-drop authoring is the gap; capture does not depend on agent opt-in.**
- Feature-spec API tables distinguish "implemented" from "wired/reachable" with file:line trace.
- ALPHA → BETA only after Phase 7 + post-impl-sync + `phase-auditor` clean.

---

## 9. Out of Scope (follow-up tickets)

1. REST `POST /api/projects/:projectId/feedback` + `requireProjectScope` + rate limit.
2. `GET /feedback/stats`, `/feedback/recent` — ABLP-988.
3. Materialized view `feedback_daily_dest` + aggregates.
4. Studio drag-and-drop authoring of FeedbackTemplateIR.
5. Email CSAT bridge to ClickHouse.
6. Voice channel feedback.
7. Sales-assistant consumer changes (`__feedback__` removal).
8. **P2 - Studio FeedbackDetailDrawer long-session pagination.** The detail drawer fetches only the first `limit=200&direction=asc` transcript page and ignores `nextCursor` / `hasMore`, so sessions with more than 200 messages can miss or fail to highlight the rated assistant message. Follow-up should paginate until the rated `messageId` is found, or fetch a bounded window around the target message. Affected areas: `apps/studio/src/components/insights/FeedbackDetailDrawer.tsx:186`, `:205`, `:312`.

---

## 10. JIRA + Commit Conventions

- **New parent ticket**: `[ABLP-1068] feat: wire in-chat feedback capture (WS + persisted-id binding + agentName)`. `blocks` → ABLP-988; `related to` → ABLP-2.
- 8 commits, one per phase. Each ≤ 40 files, ≤ 3 packages, additive. `[ABLP-1068]` prefix.
- `npx prettier --write <files>` before every commit.
- SHA → ticket comment via Atlassian MCP after each commit.
- No commit without explicit user approval.

---

## 11. Rollback Strategy

- P1: drop DDL + service files. No consumers.
- P2: revert optional fields in `PersistMessageRequest` + `AddMessageParams`; revert sdk-handler call-site changes; revert Message schema + types. Stores fall back to random-id. Rows persisted with explicit `_id` during canary stay valid (UUID strings).
- P3-4: revert WS handler + service.
- P5-6: revert SDK + renderer (optional callback — non-breaking).
- P7-8: tests + docs only.

Worst case (Phase 4 prod regression): revert P4 only. P1–3 dormant (no callers) — zero impact.
