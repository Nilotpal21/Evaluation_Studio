# RFC: Remove Contact Context in Favor of Fact Store

**Status:** Proposed
**Author:** Platform Team
**Date:** 2026-03-06

---

## Summary

Contact Context (`contactContext` on the Contact model) is a cross-session data persistence mechanism that bulk-promotes all session variables to the contact record at session end and bulk-loads them at the next session start. It should be removed entirely because it is **functionally superseded by the Fact Store**, introduces **data hygiene problems**, and its outputs are **not consumed by any engine code**.

---

## Background

The platform currently has two mechanisms for persisting data across sessions:

1. **Contact Context** — A subdocument on the `Contact` MongoDB model that automatically promotes all `session.data.values` at session end and seeds them back at the next session start.

2. **Fact Store** — A general-purpose persistent key-value memory system driven by the `MEMORY` DSL (`persistent:`, `remember:`, `recall:` sections in agent definitions).

Both aim to give agents access to data from previous sessions. However, they differ significantly in design, control, and data hygiene — and one of them is never actually consumed by the runtime engine.

---

## Reasons for Removal

### 1. Contact Context Outputs Are Dead Code

The promotion pipeline writes two values onto `CallerContext` at session initialization:

```typescript
// initialize-session.ts:229-230
callerContext.contactContext = contactCtx.dataValues;
callerContext.contactPreferences = contactCtx.preferences;
```

A codebase-wide search for any code that **reads** `callerContext.contactContext` or `callerContext.contactPreferences` returns **zero results** outside of the write sites and their tests. The execution engine (`services/execution/`), the compiler (`packages/compiler/`), the routing executor, the LLM wiring layer — none of them reference these fields. They are written at session init and carried as dead weight for the lifetime of the session.

The only runtime effect is the non-overwriting seed in `sdk-handler.ts:756-760`, which merges old `dataValues` into `session.data.values`. This is undirected — the agent designer has no control over what gets seeded or whether it happens at all.

### 2. Fact Store Already Does Everything Contact Context Does — Better

Every capability Contact Context provides has a strictly superior counterpart in the Fact Store's `MEMORY` DSL:

| Capability                   | Contact Context                          | Fact Store                                                                                  |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Persist data across sessions | Bulk-dumps **all** `session.data.values` | Agent declares exactly which keys via `remember:` rules                                     |
| Load data at session start   | Loads **everything** non-selectively     | `recall: ON: session:start` loads specific paths; `persistent:` declares defaults and types |
| Load data mid-session        | Not supported                            | `recall: ON: tool:X:after` loads on specific events                                         |
| Access control               | None — everything is read-write          | `ACCESS: read` prevents agent from overwriting CRM-managed fields                           |
| TTL / Expiry                 | None — data lives forever                | Per-fact TTL, default 90 days, auto-cleaned by MongoDB TTL index                            |
| Scoping                      | Per-contact only                         | User-scoped **and** project-scoped (shared across all users)                                |
| Provenance                   | None                                     | Full: source type, agent name, session ID, trace ID                                         |
| Type safety                  | None — `Record<string, unknown>`         | `TYPE` declarations with validation on write                                                |
| Cross-agent sharing          | N/A                                      | Agent A's `remember:` writes are readable by Agent B's `recall:`                            |

There is no use case served by Contact Context that is not already served by the Fact Store with more control, more safety, and more visibility.

### 3. Contact Context Promotes Data That Should Not Be Promoted

The promotion job (`promote-contact-context.ts:117-119`) merges **all** `session.data.values` into the contact record:

```typescript
dataValues: {
  ...(existing?.dataValues ?? {}),
  ...snapshot.dataValues,    // everything — no filtering
},
```

`session.data.values` contains every variable the agent manipulates during a session: temporary loop counters, intermediate extraction results, validation flags, error states, step markers. None of these are meaningful across sessions. Promoting them creates a growing pile of stale, irrelevant data on the contact record.

The Fact Store avoids this by design — only values matched by explicit `remember:` conditions with named target paths are persisted. Everything else is ephemeral and dies with the session.

### 4. No Expiration Creates Unbounded Growth

Contact Context has no TTL mechanism. Every completed session additively merges its data, and nothing is ever pruned. The only safeguard is a 64KB hard cap on serialized size (`contact.model.ts:159`), which means the system silently fails when a contact accumulates enough sessions.

The Fact Store enforces a 90-day default TTL per fact, with a MongoDB TTL index that automatically removes expired documents. This is both GDPR-compliant and operationally sustainable.

### 5. The Contact Identity Axis Is Not Leveraged

The one theoretically unique aspect of Contact Context is its scoping to `contactId` — a resolved identity that spans channels. A user calling from phone and later chatting on web would share the same contact record.

However, this cross-channel identity benefit is not realized in practice:

- **Session resolution is channel-bound.** The resolution key is `(tenantId, channelId, artifactHash)` (`session-resolution-key.ts:12-18`). A web session can never be resumed from a phone call — they always create separate sessions. CC does not bridge active sessions across channels.
- **CC only promotes at session close.** If Jane has a web session open and starts a phone session concurrently, CC has nothing to bridge — promotion only happens when the first session ends with a `completed` or `escalated` disposition.
- **The engine never reads the CC-populated `callerContext` fields.** `callerContext.contactContext` and `callerContext.contactPreferences` are written but never consumed by any execution engine code, so cross-channel data does not influence agent behavior.
- **The Fact Store handles cross-channel better.** REMEMBER writes facts immediately (mid-session), so data written by one channel's session is available to another channel's session without waiting for the first session to close. This requires using `contactId` as the Fact Store's `userId` — a one-line change in `runtime-executor.ts:658` (currently uses `callerContext.customerId || userId`, which may differ per channel).

### 6. Metadata Fields Belong on the Contact Record, Not in a Context Subdocument

Contact Context carries three metadata fields: `lastDisposition`, `lastInteraction`, and `sessionCount`. None are consumed by any engine code today. However, if they are valuable for analytics or admin UIs in the future:

- `sessionCount` is **already a top-level field** on the Contact model (`contact.model.ts:48`).
- `lastDisposition` and `lastInteraction` are natural contact-level metadata and should be promoted to top-level Contact fields alongside the existing `lastSeenAt` — not buried in a cross-session data bag.

### 7. The Maintenance Surface Is Significant for Zero Value

Contact Context spans 7 production files and 3 test files totaling ~2200 lines:

| File                                                             | Role                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `services/contact-context-service.ts`                            | Redis cache + MongoDB read/write with fail-open pattern |
| `contexts/orchestration/jobs/promote-contact-context.ts`         | BullMQ job processor                                    |
| `services/queues/promote-context-producer.ts`                    | Queue producer                                          |
| `services/queues/promote-context-worker.ts`                      | Worker with concurrency management                      |
| `contexts/orchestration/use-cases/initialize-session.ts:224-240` | Session initialization pre-population logic             |
| `websocket/sdk-handler.ts:739-762`                               | SDK handler seeding logic                               |
| `shared/types/index.ts:152-155`                                  | `CallerContext` type extensions                         |

This is a Redis-cached, queue-backed, async-promoted subsystem maintained for a feature whose outputs are never consumed.

### 8. The Project Is Not Live — No Migration Burden

There are no production contacts with accumulated `contactContext` data that would need migration. Removal is a clean delete with no backward-compatibility concerns.

---

## How Fact Store Replaces Every Contact Context Behavior

### Replacing: Bulk session data promotion at session end

**Contact Context behavior:** At session end, the `promote-contact-context` job dumps all `session.data.values` into the contact record — every temporary variable, every intermediate state.

**Fact Store replacement:** Agent designers declare explicit `remember:` rules that fire only when specific conditions are met and write only named keys:

```yaml
# Only persists destination preferences when a quote was actually created
remember:
  - WHEN quote_created == true
    STORE: {destination, travelers: num_travelers} -> user.travel_preferences
    TTL: 90d
```

Temporary variables like `search_status`, `validation_errors`, `step_index` are never persisted because no `remember:` rule targets them. The agent designer chooses what survives.

### Replacing: Bulk session data seeding at session start

**Contact Context behavior:** At session start, all previously promoted `dataValues` are merged into `session.data.values` non-selectively (`sdk-handler.ts:756-760`). The agent gets every variable from the last session whether it needs them or not.

**Fact Store replacement:** Agents declare exactly which keys to load and when, via `persistent:` and `recall:`:

```yaml
persistent:
  - PATH: user.preferred_destinations
    SCOPE: user
    ACCESS: readwrite
    TYPE: array
    DEFAULT_VALUE: []

recall:
  - ON: session:start
    ACTION: inject_context
    PATHS: [user.preferred_destinations, user.loyalty_tier]
```

Only the declared paths are loaded. Each has a type, a default value, and access control. Nothing unexpected leaks in from a previous session.

### Replacing: Cross-session preferences

**Contact Context behavior:** The `preferences` field on `contactContext` is intended for long-lived contact settings managed via contact APIs. However, **there are zero writers for this field in the entire codebase** — no API endpoint, no admin route, no service method ever sets `contactContext.preferences`. The promotion job explicitly preserves existing preferences but never adds new ones. The "contact management APIs" referenced in the design were never built. It is entirely dead code.

**Fact Store replacement:** `persistent:` declarations with `ACCESS: read` protect externally managed values:

```yaml
persistent:
  - PATH: user.loyalty_tier
    SCOPE: user
    ACCESS: read # Agent cannot overwrite — managed by CRM
    TYPE: string
```

The Fact Store enforces the access control at write time. Contact Context had no such enforcement.

### Replacing: Cross-channel identity continuity

**Contact Context behavior:** Scoped to `contactId`, which spans channels (phone, web, etc.). In theory, data from a phone session is available in a web session for the same contact. In practice, CC only promotes data at session close, so it cannot bridge concurrent cross-channel sessions. And session resolution is channel-bound (`tenantId, channelId, artifactHash`), so sessions are never shared across channels — each channel always creates a separate session.

**Fact Store replacement:** The Fact Store is scoped to `(tenantId, userId, projectId)`. Currently, `userId` is set from `callerContext.customerId || userId` (`runtime-executor.ts:658`), which may differ per channel. A one-line fix to prefer `contactId` as the `userId` when available gives the Fact Store the same cross-channel identity that CC has — without CC's limitation of only bridging data after session close. Because REMEMBER writes facts immediately (not at session end), data written by one channel's agent is available to another channel's session in real time.

### Replacing: Session metadata (lastDisposition, lastInteraction, sessionCount)

**Contact Context behavior:** Tracks `lastDisposition`, `lastInteraction`, and `sessionCount` as fields on the `contactContext` subdocument. None are consumed by any engine code.

**Fact Store replacement:** These are not agent memory — they are contact-level metadata. The correct solution is:

- `sessionCount` — already exists as a top-level field on the Contact model (`contact.model.ts:48`).
- `lastDisposition` and `lastInteraction` — should be promoted to top-level Contact model fields alongside the existing `lastSeenAt`. They can be updated by the session-close handler directly, without a separate queue or promotion job.

### Replacing: Write timing (immediate vs deferred)

**Contact Context behavior:** CC only persists data at session end, via a BullMQ job that fires after the session closes with a promotable disposition. This means: (a) if the session is abandoned, nothing is persisted; (b) data is unavailable to other sessions until the first session closes; (c) a queue + worker infrastructure is needed just to run the promotion.

**Fact Store replacement:** REMEMBER writes to the Fact Store immediately when conditions match — during the session, not after it. This is superior because:

- **Durability on crash**: If a session dies at turn 5, facts written at turn 3 are already safe in MongoDB.
- **Cross-agent availability**: In fan-out/handoff flows, Agent A's facts are readable by Agent B's `recall:` in the same session, immediately.
- **Cross-channel availability**: If Jane's web agent writes a fact mid-session, her concurrent phone session can read it via `recall:` without waiting for the web session to close.
- **No queue infrastructure**: No BullMQ job, no producer, no worker, no race condition between session cleanup and data capture.

The agent designer controls what gets written via `WHEN` conditions — tying writes to business outcomes (e.g., `WHEN booking_confirmed == true`) rather than relying on session disposition.

### Replacing: Data expiration and GDPR compliance

**Contact Context behavior:** No TTL. Data accumulates indefinitely until the 64KB hard cap is hit or the contact is deleted.

**Fact Store replacement:** Every fact has an `expiresAt` field with a configurable TTL (default 90 days). A MongoDB TTL index automatically removes expired documents. Per-fact TTL can be set in `remember:` rules:

```yaml
remember:
  - WHEN user.is_authenticated == true
    STORE: last_verified_at -> user.last_verified_at
    TTL: 30d      # Expires in 30 days — no manual cleanup needed
```

This satisfies GDPR data minimization requirements out of the box.

---

## Proposed Action

1. **Delete** the entire Contact Context subsystem: service, job processor, producer, worker, seeding logic, `CallerContext` fields, and all associated tests.
2. **Promote** `lastDisposition` and `lastInteraction` to top-level Contact model fields (if desired for future admin/analytics use).
3. **Drop** the `contactContext` subdocument from the Contact schema.
4. **Use `contactId` for Fact Store identity** — change `runtime-executor.ts:658` to prefer `contactId` over `customerId` as the Fact Store `userId`, ensuring cross-channel identity continuity without CC.
5. **No agent DSL changes needed** — agents already using `persistent:` / `remember:` / `recall:` are unaffected.

---

## Files Affected

### Deleted Entirely

- `apps/runtime/src/services/contact-context-service.ts`
- `apps/runtime/src/contexts/orchestration/jobs/promote-contact-context.ts`
- `apps/runtime/src/services/queues/promote-context-producer.ts`
- `apps/runtime/src/services/queues/promote-context-worker.ts`
- `apps/runtime/src/__tests__/contact-context-service.test.ts`
- `apps/runtime/src/__tests__/contexts/orchestration/promote-contact-context.test.ts`
- `apps/runtime/src/__tests__/contexts/contact/contact-context-model.test.ts`

### Modified

- `apps/runtime/src/contexts/orchestration/use-cases/initialize-session.ts` — Remove pre-population block (lines 224-240)
- `apps/runtime/src/websocket/sdk-handler.ts` — Remove seeding block (lines 739-762)
- `apps/runtime/src/contexts/contact/domain/contact.ts` — Remove `ContactContext` interface and field
- `packages/database/src/models/contact.model.ts` — Remove `contactContext` subdocument schema; optionally add `lastDisposition` and `lastInteraction` as top-level fields
- `packages/shared/src/types/index.ts` — Remove `contactContext` and `contactPreferences` from `CallerContext`
- `apps/runtime/src/server.ts` — Remove CC service wiring

---

## Conclusion

Contact Context is a bulk, uncontrolled, non-expiring persistence mechanism whose outputs are not consumed by any runtime code. The Fact Store provides the same cross-session memory capability with selectivity, TTL, access control, type safety, provenance, and dual scoping. Removing Contact Context eliminates dead code, prevents data hygiene issues, and reduces the maintenance surface — with zero functional regression.
