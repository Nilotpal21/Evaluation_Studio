# Feature Test Guide: Omnichannel Session Continuity

**Feature**: Project-scoped cross-channel recall, strong identity verification, shared live transcript sync, same-session multimodal continuity
**Owner**: Runtime, Channels, SDK, and Studio teams
**Branch**: develop
**First tested**: 2026-03-23
**Last updated**: 2026-04-23
**Overall status**: IN PROGRESS (ALPHA)

---

## Current State (as of 2026-04-23)

Omnichannel Session Continuity is at ALPHA status. The core implementation is complete: transcript recall with consent, GDPR, merged contacts, PII redaction, retention enforcement, and 64KB payload limits is working; live session discovery, join, detach, and backfill are Redis-backed and operational; the SDK supports simultaneous voice+text with source-channel badges and join prompts; Studio settings and audit panels are functional; identity verification is fully wired with all 6 verifier types (OTP, email_link, HMAC, provider, webhook, OAuth); GDPR cascade cleanup covers omnichannel models; retention is enforced as a compliance boundary on recall. 115 tests cover the feature (46 E2E, 15 integration, 54 unit).

Recent runtime/channel work from 2026-03-30 through 2026-04-01 tightened the seams this feature depends on:

- `/ws/sdk` auth is now documented with the actual subprotocol contract (`Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>`) instead of the older query-string token shape.
- Channel control-plane identity policy is now normalized around `identityVerification.providerVerificationStrength`, which keeps provider-verification trust configuration aligned with omnichannel recall/join policy.
- The remaining blockers are still the production wiring and recovery-path gaps already tracked below; this refresh does not change the 115-test count.

Gap closure phase 2 (2026-03-24) addressed 6 gaps: GAP-014 (verifier wiring), GAP-015 (retention enforcement), GAP-016 (GDPR cascade), GAP-017 (E2E token fix), GAP-018 (Studio panel tests), GAP-019 (identity verification E2E). Remaining gaps for BETA: session-to-contact linking has inconsistent paths (GAP-004), SDK contact linking has a race condition (GAP-005), audit events are in-memory only (GAP-011), and recovery E2E tests are not yet implemented (GAP-013). All tests use real servers via HTTP/WS APIs with no mocks of codebase components.

### Quick Health Dashboard

| Area                                   | Status                  | Last Verified | Notes                                                                                                           |
| -------------------------------------- | ----------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| SDK channel authentication             | PASS (subprotocol auth) | 2026-04-01    | Runtime-issued `sdk_session` is the trusted channel principal; `/ws/sdk` uses `sdk-auth` subprotocol auth       |
| Identity verification (all 6 methods)  | PASS (ALPHA)            | 2026-03-24    | All 6 verifiers wired: OTP, email_link, HMAC, provider, webhook, OAuth                                          |
| Explicit session-contact linking       | PARTIAL                 | 2026-03-21    | Link routes and use cases exist, but session/contact consistency gaps remain                                    |
| Eager contact-context preload          | PASS (foundation only)  | 2026-03-21    | Facts and preferences preload exists today                                                                      |
| Transcript recall                      | PASS (ALPHA)            | 2026-03-23    | RecallService with consent, GDPR, merged contacts, PII redaction, 64KB limit                                    |
| Project-safe recall scoping            | PASS (ALPHA)            | 2026-03-23    | projectId added to message model, indexes, recall queries, and backfill                                         |
| Shared live session discovery and join | PASS (ALPHA)            | 2026-03-23    | Redis-backed live session with discover, join, detach, backfill                                                 |
| Multi-subscriber transcript fan-out    | PASS (ALPHA)            | 2026-03-23    | Connection registry extended with sessionToConnections multi-connection support                                 |
| Web SDK simultaneous transcript UI     | PASS (ALPHA)            | 2026-03-23    | UnifiedWidget with simultaneous voice+text, source-channel badges, join prompt                                  |
| Privacy, audit, and retention gates    | PASS (ALPHA)            | 2026-03-23    | Consent, audit (11 event types), PII redaction, project/tenant isolation                                        |
| Verification provenance for continuity | NOT TESTED              | -             | No end-to-end proof yet that recall/join consume project-safe session-resolution records + `sessionPrincipalId` |

---

## Test File Inventory

### Existing Foundation Coverage

| File                                                                                       | Type               | Scenarios                                                                      | Status |
| ------------------------------------------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------ | ------ |
| `apps/runtime/src/__tests__/contexts/orchestration/initialize-session-prepopulate.test.ts` | Integration        | Contact facts and preferences preload                                          | PASS   |
| `apps/runtime/src/__tests__/contexts/orchestration/initialize-session.test.ts`             | Integration        | Session bootstrap and caller-context wiring                                    | PASS   |
| `apps/runtime/src/__tests__/contexts/orchestration/switch-channel.test.ts`                 | Integration        | Continuity metadata during channel switches                                    | PASS   |
| `apps/runtime/src/__tests__/contexts/orchestration/promote-and-link.test.ts`               | Integration        | Mid-session promote-and-link flow                                              | PASS   |
| `apps/runtime/src/__tests__/contexts/orchestration/sdk-handler-wiring.test.ts`             | Integration        | SDK handler orchestration wiring                                               | PASS   |
| `apps/runtime/src/__tests__/session-resolver.test.ts`                                      | Unit / Integration | Session resolution by identity artifacts                                       | PASS   |
| `apps/runtime/src/__tests__/sessions/session-resolver-gaps.test.ts`                        | Unit / Integration | Same-channel continuity, contact-link edge cases, deployment mismatch fallback | PASS   |
| `apps/runtime/src/__tests__/channels-session-resolver.test.ts`                             | Unit / Integration | Channel-specific identity resolution behavior                                  | PASS   |
| `apps/runtime/src/__tests__/ws-sdk-handler.test.ts`                                        | Integration        | SDK WebSocket token and lifecycle behavior                                     | PASS   |
| `apps/runtime/src/__tests__/contexts/identity/verification-routes.test.ts`                 | Integration        | Verification route surface and validation                                      | PASS   |
| `apps/runtime/src/__tests__/contact-context-service.test.ts`                               | Unit               | Contact context loading and shape handling                                     | PASS   |

### Runtime Tests

| File                                                                          | Type        | Scenarios                                                                                                           | Status    |
| ----------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- | --------- |
| `apps/runtime/src/__tests__/omnichannel-identity-linking.integration.test.ts` | Integration | Consent lifecycle, recall gating by consent                                                                         | PASS (6)  |
| `apps/runtime/src/__tests__/omnichannel-recall-service.integration.test.ts`   | Integration | Project-scoped recall, message limits, consent, merged contacts, GDPR                                               | PASS (9)  |
| `apps/runtime/src/__tests__/omnichannel-sdk-handler.integration.test.ts`      | Integration | Shared-session join, backfill, sequencing, and fan-out contract                                                     | PLANNED   |
| `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts`                   | E2E         | Settings CRUD, recall retrieval, maxMessages, structured content, consent                                           | PASS (11) |
| `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`             | E2E         | Live session discovery, join, detach, identity gating, consent, join-links                                          | PASS (12) |
| `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`            | E2E         | Project isolation, tenant isolation, settings isolation, cross-project recall                                       | PASS (5)  |
| `apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts`    | E2E         | OTP round-trip, HMAC single-step, auth enforcement, error codes                                                     | PASS (12) |
| `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`            | E2E         | WS↔http_async recall, voice→WhatsApp with verification, multi-channel, identity tier gating, allowedChannels filter | PASS (6)  |
| `apps/runtime/src/__tests__/omnichannel-recovery.e2e.test.ts`                 | E2E         | Redis loss, reconnect, duplicate joins, out-of-order transcript recovery                                            | PLANNED   |

### SDK and Studio Tests

| File                                                                 | Type               | Scenarios                                                               | Status    |
| -------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------- | --------- |
| `packages/web-sdk/src/__tests__/session-manager-omnichannel.test.ts` | Unit               | Discover, join, reconnect re-join, transcript/participant subscriptions | PASS (13) |
| `packages/web-sdk/src/__tests__/chat-backfill.test.ts`               | Unit               | Transcript hydration, source-channel badges, dedupe, ordering           | PASS (13) |
| `packages/web-sdk/src/__tests__/unified-widget-live-sync.test.ts`    | Unit               | Simultaneous transcript + typed input UX, join prompt, badges           | PASS (18) |
| `apps/studio/src/__tests__/omnichannel-settings-panel.test.tsx`      | Unit               | Settings panel render, load, save, validation, empty states             | PASS (10) |
| `apps/studio/src/__tests__/omnichannel-settings-routes.test.ts`      | Unit / Integration | Project-scoped settings validation and permission checks                | PLANNED   |
| `apps/studio/e2e/omnichannel-session-continuity-smoke.spec.ts`       | Browser smoke      | Enable feature, verify join prompt, check builder-facing settings       | PLANNED   |

---

## Test Coverage Map

### Foundation Checks Already Present

- [x] SDK session authentication already anchors tenant, project, channel, and granted capabilities
- [x] Session bootstrap can preload contact facts and preferences
- [x] Channel-switch orchestration exists as a continuity foundation
- [x] Promote-and-link orchestration exists for mid-session identity upgrade
- [x] Contact merge and GDPR-delete route surfaces exist
- [x] Verification route surface exists for initiate, complete, and status flows

### Identity and Linking

- [ ] Tier-0 anonymous SDK session stays valid for session-scoped work but never becomes eligible for cross-session recall
- [ ] Unsigned `userContext.userId` is treated as metadata only and cannot drive resume, recall, or user-scoped authorization
- [ ] Tenant-signed identity envelopes can promote an SDK session into a verified end-user identity
- [x] HMAC-required channels reject missing signatures
- [x] HMAC-required channels reject invalid signatures
- [ ] HMAC-optional channels accept unsigned users but keep them unverified
- [x] Strong OTP verification can promote a session to verified identity
- [ ] OAuth verification can promote a session to verified identity
- [x] Email-link verification can promote a session to verified identity
- [x] Provider-verified identities default to weak tier 1 and can preserve or resume same-channel continuity on stable channel artifacts without granting recall or live-session authorization
- [ ] Explicitly trusted provider verification can classify a channel/provider as strong tier 2 and satisfy minTier=2 recall/live gates
- [ ] Verification completion registers a project-safe session-resolution record carrying `sessionLocator`, `sessionPrincipalId`, `verificationAttemptId`, `policySource`, `grantScope`, and `traceId`
- [ ] Verified caller ID plus explicit confirmation can link the session to the correct contact
- [ ] Gathered phone number waits for explicit verification and confirmation before linking
- [ ] Gathered email waits for explicit verification and confirmation before linking
- [ ] Gathered member or account number waits for explicit verification and confirmation before linking
- [ ] Mid-session verification backfills pre-link messages with the final `contactId`
- [ ] Re-linking the same session is idempotent
- [ ] Explicit admin or runtime link updates both the session record and contact history
- [ ] Conflicting strong identity signals fail closed and require explicit resolution
- [ ] Manual merge makes future recall span the merged history under the surviving primary contact

### Recall Retrieval and Policy

- [ ] Recall disabled at project level returns no prior transcript context
- [ ] Recall enabled with no prior sessions returns a safe “no prior discussion” result
- [x] Recall remains strictly project-scoped even when the same contact exists in multiple projects
- [x] Recall remains tenant-scoped and does not cross tenant boundaries
- [ ] Hybrid mode eagerly preloads facts but does not eagerly inject transcript history
- [ ] On-demand recall returns only final transcript items
- [x] Recall excludes the current session when the user asks about “last time”
- [ ] Recall limited to the last `N` sessions excludes older sessions
- [ ] Recall limited by age excludes expired sessions
- [x] Recall limited by `maxMessages=20` truncates correctly
- [ ] Recall limited by token budget truncates correctly
- [x] Recall works bidirectionally between web_chat and http_async channels, preserving original channel metadata (OCS-E07/E08 — PASS)
- [x] Recall filters by allowed channels (OCS-E12 — PASS)
- [ ] Recall can span merged contact history only after merge finalization
- [ ] Recall does not return GDPR-deleted or retention-expired content
- [ ] Recall ranking surfaces the relevant prior discussion when multiple candidates exist
- [ ] Recall timeouts degrade gracefully without failing the main conversation path
- [ ] Session-start latency remains below one second with hybrid mode enabled

### Live Transcript Sync and Shared Session Behavior

- [ ] Verified web chat can discover an active voice session in the same project
- [x] No join option is shown when there is no active live session
- [ ] An explicit one-time verified join link auto-joins the live session
- [ ] Without a verified join link, the user is prompted to join
- [ ] Accepting the join attaches to the existing session instead of creating a new one
- [ ] Joining mid-call backfills the transcript up to the current point
- [ ] Backfill preserves sequence ordering and deduplicates replayed items
- [ ] Only final transcript text is shown to attached chat participants
- [ ] User voice turns render with `sourceChannel=voice`
- [ ] Typed chat turns render with `sourceChannel=web` or equivalent attached channel
- [ ] Agent replies are rendered in text and delivered to voice exactly once
- [ ] Typed input interrupts active TTS playback
- [ ] Multiple attached tabs or windows can participate in the same shared session
- [ ] Closing one attached tab detaches that participant but does not affect the call
- [ ] Ending the voice call leaves the same session active for text continuity
- [ ] Refreshing the browser reattaches to the same session and backfills missed final turns
- [x] Cross-channel recall generalizes to voice, WhatsApp, web_chat, and http_async channels (OCS-E09/E11 — PASS for recall; live attach still open)

### Security, Privacy, and Compliance

- [x] Cross-project transcript access returns no data and does not reveal resource existence
- [x] Cross-tenant transcript access returns no data and does not reveal resource existence
- [x] Tier 0 anonymous sessions cannot perform cross-channel recall — identity tier blocked by minTier policy (OCS-E10 — PASS)
- [x] Tier 1 weak-verification sessions are blocked by default minTier:2 policy (OCS-E10 — PASS)
- [ ] Anonymous users cannot infer whether a prior verified session exists
- [ ] Recall and live-session join never authorize off a tenant-only artifact match or reconstructed session guess; they require canonical production scope plus the project-safe session-resolution record
- [x] Consent-required projects block recall until consent is granted
- [ ] Consent-required projects block live transcript join until consent is granted
- [x] Revoking consent disables future recall and future live-session joins
- [ ] Retention windows remove expired transcript content from recallability
- [ ] GDPR deletion removes future recallability and live-session join eligibility
- [ ] Redaction rules apply to recalled transcript snippets
- [ ] Redaction rules apply to live transcript output
- [ ] Audit events are emitted for session link, recall access, join, detach, merge, revoke, and delete
- [ ] Join tokens are one-time use and expire correctly
- [ ] Granted channel capabilities cannot be widened by SDK-side requests

### Failure, Recovery, and Performance

- [ ] Identity-verification service outage does not block anonymous session creation
- [ ] Contact-context preload failure does not block conversation start
- [ ] Recall service timeout does not fail the active conversation
- [ ] Redis participant-registry outage blocks join gracefully without killing the live call
- [ ] Duplicate join requests are idempotent
- [ ] Duplicate transcript events are deduplicated by sequence or event ID
- [ ] Out-of-order transcript chunks resolve into final ordered output
- [ ] Lost chat connection during the call reconnects and backfills missed items
- [ ] Lost voice transport does not corrupt text transcript state
- [ ] Shared-session fan-out works across multiple runtime pods
- [ ] Join and backfill APIs enforce rate limits correctly
- [ ] Large histories still respect bounded backfill and recall limits
- [ ] Recall-enabled startup meets the less-than-one-second latency target
- [ ] Live transcript fan-out meets the project’s latency budget under multiple subscribers

---

## Detailed E2E Scenarios

### OCS-E01: Verified Web Chat to Voice Recall

**Goal**

Prove the Part 1 customer story end to end through public APIs.

**Setup**

- Start a web chat through the SDK using a valid `sdk_session`
- Collect strong identity verification and explicit confirmation
- Ask about a claim and end the session
- Start a later voice session for the same verified contact in the same project

**Assertions**

- The voice session resolves the same verified contact
- The session starts within the latency budget
- When asked about the prior conversation, the agent retrieves the relevant prior discussion
- No data from other projects or tenants is visible

### OCS-E02: Anonymous SDK Session Safety

**Goal**

Prove that anonymous SDK usage remains supported without cross-session leakage.

**Setup**

- Start an SDK session without verified identity
- Use auth-preflight or OAuth initiation through the authenticated SDK channel
- End the session and start a second anonymous session

**Assertions**

- Both sessions succeed at session scope
- The second session cannot recall or resume the first as the same end user
- Unsigned `userContext.userId` never changes authorization behavior

### OCS-E03: Active Voice Session Join with Prompt

**Goal**

Prove the main Part 2 shared-session path without a join link.

**Setup**

- Start a verified live voice session
- Open web chat in the same project for the same verified identity

**Assertions**

- The web surface discovers the active live session
- The user is prompted to join
- On acceptance, the session backfills prior final transcript items and continues live
- Typed follow-ups enter the same session and interrupt TTS

### OCS-E04: Explicit Join Link Auto-Join

**Goal**

Prove the stronger auto-join path.

**Setup**

- Start a verified live voice session
- Issue an explicit one-time join link through the registered phone or trusted channel identity
- Open the web chat from that join link

**Assertions**

- The chat surface auto-joins without a prompt
- The link is bound to the intended project and verified contact
- Reusing the same link fails closed

### OCS-E05: Same Session After Voice Ends

**Goal**

Prove that post-call chat continuity stays in the same session.

**Setup**

- Start a verified shared voice + web session
- End the voice call while keeping chat open

**Assertions**

- The same `sessionId` stays active in chat
- The user can continue by typing
- Future recall treats the interaction as one continuous session

### OCS-E07: WebSocket to HTTP Async Cross-Channel Recall

**Goal**

Prove that a conversation started on the SDK WebSocket channel (web chat) can be recalled from a later session on the HTTP async webhook channel, verifying cross-channel transcript continuity for the same verified contact.

**Preconditions**

- Project with omnichannel enabled (`BUSINESS` tier, recall enabled)
- Contact with `identityTier: 2` (verified) and phone artifact `+15551234567`
- `cross_channel_recall` consent granted for the contact

**Steps**

1. Seed 4 messages for session-1 with `channel: 'web_chat'`, `sourceChannel: 'web'`, `inputMode: 'typed'`, `contactId`, `projectId`, `tenantId`, `final: true` — including at least one structured `ContentBlock[]` message (not just plain text)
2. Seed 2 messages for session-2 with `channel: 'http_async'`, `sourceChannel: 'http_async'`, `inputMode: 'typed'`, same `contactId` and `projectId`, different `sessionId`
3. Mint an SDK session token for session-2 with `contactId`, `identityTier: 2`, channel context `http_async`
4. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId, maxMessages: 10 }` using the session-2 SDK token
5. Assert response contains messages from session-1 (web_chat) with correct `channel` and `sourceChannel` metadata
6. Assert response does NOT contain messages from session-2 (current session excluded)
7. Assert structured `ContentBlock[]` content is preserved in recalled messages (not flattened to string)

**Expected Result**

- Recall returns session-1's web_chat messages when queried from an http_async context
- Messages retain their original `channel: 'web_chat'` and `sourceChannel: 'web'` metadata
- `maxMessages` limit is respected
- Structured content round-trips correctly

**Auth Context**: SDK session token with `tenantId`, `projectId`, `identityTier: 2`, `contactId`
**Isolation Check**: Same contact in a different project returns no messages

---

### OCS-E08: HTTP Async to WebSocket Cross-Channel Recall (Reverse Direction)

**Goal**

Prove the reverse direction — messages from an HTTP async session are recallable from a later WebSocket (web chat) session.

**Preconditions**

- Same project setup as OCS-E07
- Contact verified at tier 2 with consent

**Steps**

1. Seed 3 messages for session-A with `channel: 'http_async'`, `sourceChannel: 'http_async'`, including a mix of `role: 'user'` and `role: 'assistant'` messages, `final: true`
2. Mint an SDK session token for session-B with `sessionId: session-B-id`, `contactId`, `identityTier: 2` (session context is required — the recall route checks `req.tenantContext?.sessionId`)
3. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId, maxMessages: 10 }` from session-B using `X-SDK-Token` header
4. Assert response contains the http_async messages from session-A
5. Verify `channel: 'http_async'` metadata is preserved on recalled messages
6. Assert session-B's own messages (if any were seeded) are excluded

**Expected Result**

- Bidirectional recall works: http_async → web_chat and web_chat → http_async
- Channel metadata is preserved, not overwritten by the querying channel

**Auth Context**: SDK session token with `tenantId`, `projectId`, `identityTier: 2`, `contactId`
**Isolation Check**: A different contact in the same project returns no messages from session-A

---

### OCS-E09: Voice to WhatsApp Cross-Channel Recall with Verification

**Goal**

Prove the multi-modal cross-channel story: a verified voice caller's conversation is recalled when the same customer continues on WhatsApp, using the shared phone number as the cross-channel identity artifact.

**Preconditions**

- Project with omnichannel enabled, recall enabled, identity verification configured
- Contact created with normalized phone artifact `+15559876543` (matches both voice caller_id and WhatsApp phone)
- `cross_channel_recall` consent granted
- Identity verification wired (verifierMap active)

**Steps**

1. Seed a contact with `_id: contactId` and phone artifact `+15559876543`
2. Seed 5 voice session messages for session-V with `channel: 'voice'`, `sourceChannel: 'voice'`, `inputMode: 'voice'`, `contactId`, `final: true` — including user voice turns and agent replies
3. Initiate OTP verification via `POST /api/identity/verify/initiate` with `{ method: 'otp', identityValue: '+15559876543', identityType: 'phone' }` using a session-V SDK token
4. Complete verification via `POST /api/identity/verify/complete` with the correct proof
5. Verify the attempt reaches `verified` status via `GET /api/identity/verify/:attemptId`

> **Note**: The OTP verification round-trip (steps 3-5) is tested here as a cross-channel workflow integration point, not as the recall authorization gate. Recall authorization is governed by the `identityTier` in the SDK session token (step 7). In production, the runtime upgrades the session's identity tier after successful verification; in this E2E scenario the token is minted with `identityTier: 2` directly because the token minting harness does not simulate the full runtime tier-upgrade flow.

6. Seed 2 WhatsApp session messages for session-W with `channel: 'whatsapp'`, `sourceChannel: 'whatsapp'`, same `contactId`, different `sessionId`
7. Mint an SDK session token for session-W with `sessionId: session-W-id`, `contactId`, `identityTier: 2`
8. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId, maxMessages: 20 }` from session-W
9. Assert response contains voice messages from session-V with `channel: 'voice'`, `sourceChannel: 'voice'`, `inputMode: 'voice'`
10. Assert voice messages are ordered by `createdAt` descending
11. Assert session-W's own messages are excluded from recall

**Expected Result**

- Voice conversation is recallable from WhatsApp context
- Voice messages retain `channel: 'voice'` and `inputMode: 'voice'` metadata
- Identity verification round-trip completes successfully (proving the verifier wiring works end-to-end)
- The shared phone artifact is the cross-channel identity anchor

**Auth Context**: SDK session token with `tenantId`, `projectId`, `identityTier: 2`, `contactId`
**Isolation Check**: Different project with same phone artifact returns no messages

---

### OCS-E10: Voice to WhatsApp Recall Blocked Without Verification

**Goal**

Prove that cross-channel recall from WhatsApp is blocked when the identity tier is below the project's `identity.minTier` setting. The recall route checks `identityTier < settings.identity.minTier` and returns 403 `IDENTITY_INSUFFICIENT` when the tier is too low.

**Preconditions**

- Same project setup as OCS-E09 (voice messages seeded, consent granted)
- Project `identity.minTier` set to `2` (strong verification required)

**Steps**

1. Seed voice messages for a contact (same as OCS-E09 setup)
2. Seed `cross_channel_recall` consent for the contact
3. `PATCH /api/projects/:projectId/omnichannel` to set `{ identity: { minTier: 2 } }` with admin token
4. Mint an SDK session token with `identityTier: 0`, `contactId`, `sessionId` for a WhatsApp session
5. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId }` from the tier-0 token
6. Assert response is 403 with `error.code === 'IDENTITY_INSUFFICIENT'`
7. Mint a second token with `identityTier: 1`, same `contactId`
8. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId }` from the tier-1 token
9. Assert response is still 403 `IDENTITY_INSUFFICIENT` (tier 1 < minTier 2)
10. Mint a third token with `identityTier: 2`, same `contactId`
11. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId }` from the tier-2 token
12. Assert response is 200 with voice messages returned successfully

**Expected Result**

- Tier 0 (anonymous) and tier 1 (weak) are both blocked by `identity.minTier: 2` → 403 `IDENTITY_INSUFFICIENT`
- Only tier 2 (strong verification) passes the identity gate and returns recalled messages
- Any weak provider-verified same-channel continuity exception remains local to bootstrap/resume and does not bypass this recall gate
- Explicitly trusted provider verification that is classified as tier 2 should pass this gate and be covered by dedicated policy tests
- The same `contactId` is used in all three requests — the difference is purely the `identityTier` on the SDK token

**Auth Context**: SDK tokens at `identityTier: 0`, `1`, and `2` — all with the same `contactId`
**Isolation Check**: Verification tier enforcement is consistent regardless of channel

---

### OCS-E11: Multi-Channel Recall Across Three Channels

**Goal**

Prove that recall spans messages from multiple prior channels (not just one) when the same verified contact has interacted across voice, web chat, and WhatsApp.

**Preconditions**

- Contact verified at tier 2 with consent granted
- Messages seeded across 3 channels for 3 different sessions, all for the same contact and project

**Steps**

1. Seed 3 messages for session-1 with `channel: 'voice'`, `sourceChannel: 'voice'`, `final: true`
2. Seed 3 messages for session-2 with `channel: 'web_chat'`, `sourceChannel: 'web'`, `final: true`
3. Seed 3 messages for session-3 with `channel: 'whatsapp'`, `sourceChannel: 'whatsapp'`, `final: true`
4. Mint an SDK token for session-4 with `sessionId: session-4-id`, `contactId`, `identityTier: 2` (sessionId required — recall route returns 400 `NO_SESSION` without it)
5. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId, maxMessages: 20 }` from session-4
6. Assert response contains messages from ALL three prior sessions (voice, web_chat, whatsapp)
7. Assert each message retains its original `channel` and `sourceChannel` metadata
8. Assert messages are ordered by `createdAt` descending across all channels
9. Assert `maxMessages` truncation works correctly when total exceeds limit

**Expected Result**

- Recall spans all channels the verified contact has used within the same project
- No channel is privileged or excluded (unless `defaultAllowedChannels` filter is set)
- Ordering is global (by time), not grouped by channel

**Auth Context**: SDK session token with `tenantId`, `projectId`, `identityTier: 2`, `contactId`
**Isolation Check**: A second contact in the same project with messages on different channels returns only their own messages

---

### OCS-E12: Cross-Channel Recall with allowedChannels Filter

**Goal**

Prove that the `allowedChannels` recall setting correctly restricts which channels' messages are included in cross-channel recall.

**Preconditions**

- Messages seeded across voice, web_chat, and whatsapp (same as OCS-E11)
- Project omnichannel settings configured with `recall.defaultAllowedChannels: ['voice', 'web_chat']` (WhatsApp excluded)

**Steps**

1. Seed messages across 3 channels (same as OCS-E11 steps 1-3)
2. `PATCH /api/projects/:projectId/omnichannel` with admin token to set `{ recall: { defaultAllowedChannels: ['voice', 'web_chat'] } }` — note: the settings field is `defaultAllowedChannels`, not `allowedChannels` (the Zod schema `OmnichannelSettingsUpdateSchema` uses `defaultAllowedChannels`)
3. Mint an SDK token with `sessionId: filter-test-session`, `contactId`, `identityTier: 2`. `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId, maxMessages: 20 }` (no per-request `allowedChannels` override)
4. Assert response contains messages from voice and web_chat sessions ONLY
5. Assert WhatsApp messages are excluded
6. `PATCH /api/projects/:projectId/omnichannel` to set `{ recall: { defaultAllowedChannels: ['whatsapp'] } }`
7. Repeat recall — assert only WhatsApp messages are returned
8. Test per-request override: `POST /api/projects/:projectId/omnichannel/recall` with `{ contactId, allowedChannels: ['voice'] }` — the per-request `allowedChannels` field overrides `defaultAllowedChannels` from settings
9. Assert only voice messages are returned (per-request override takes precedence)
10. `PATCH /api/projects/:projectId/omnichannel` to set `{ recall: { defaultAllowedChannels: [] } }`
11. Repeat recall with no per-request override — assert all channels' messages are returned (empty array = no filter)

**Expected Result**

- `defaultAllowedChannels` in project settings correctly filters recall by source channel
- Per-request `allowedChannels` in the recall POST body overrides settings (route logic: `bodyResult.data.allowedChannels ?? settings.recall.defaultAllowedChannels`)
- Changing the settings filter dynamically changes recall results
- Empty array = no filter (all channels returned)

**Auth Context**: Admin/owner token for PATCH settings, SDK session token with `sessionId`, `contactId`, `identityTier: 2` for recall
**Isolation Check**: Channel filter does not leak messages from other contacts or projects

---

### OCS-E06: Merge, Recall, and Privacy Enforcement

**Goal**

Prove that manual merge expands valid recall history without weakening privacy.

**Setup**

- Create two verified contacts that represent the same person
- Merge them using the public contact-management API
- Start a new verified session in the same project

**Assertions**

- Future recall can span both historical contact histories under the merged primary contact
- Cross-project and cross-tenant histories remain inaccessible
- Audit events record the merge and later recall access

---

## Production Wiring Verification

These checks verify that implemented code is actually reachable from production entry points — not just that it exists and passes tests in isolated harnesses. This is a separate concern from functional correctness.

| ID      | Wiring check                                                                   | Expected state                                                                 | Actual state (2026-03-24)                                         | Status  |
| ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------- |
| OCS-W01 | Omnichannel HTTP router mounted in `server.ts`                                 | `app.use('/api/projects/:projectId/omnichannel', omnichannelRouter)` in server | Router NOT mounted — only in E2E test harnesses (GAP-020)         | FAIL    |
| OCS-W02 | `executeOmnichannelRecall()` called from production agent execution path       | Called from agent memory pipeline or tool dispatch                             | Exported from `memory-integration.ts` but zero callers (GAP-021)  | FAIL    |
| OCS-W03 | SDK `UnifiedWidget.discoveredSession` populated in production                  | Set by `SessionManager.discoverLiveSession()` response                         | Property exists but never assigned in production code (GAP-022)   | FAIL    |
| OCS-W04 | Studio audit UI renders data from audit BFF route                              | Component fetches and displays audit events                                    | BFF route exists; no component renders the data (GAP-023)         | FAIL    |
| OCS-W05 | Omnichannel settings reachable via Studio settings panel in production         | Studio PATCH → runtime PATCH → DB upsert                                       | Studio proxies to unmounted runtime route (GAP-020 + GAP-024)     | FAIL    |
| OCS-W06 | Feature gate chain complete: plan tier → project settings → consent → identity | All 4 gates evaluated on every omnichannel request                             | Plan tier gate works; remaining gates unreachable without OCS-W01 | PARTIAL |

> **Convention**: "Production Wiring Verification" is a distinct test category from E2E and integration tests. E2E tests prove functional correctness using test harnesses. Wiring verification proves that the same functionality is reachable from the production entry point (`server.ts`, SDK production builds, Studio production builds).

---

## Regression Matrix

| ID      | Regression risk                                                           | Required assertion                                                                         | Planned test location                                                         |
| ------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| OCS-R01 | SDK auth loses channel-scoped source-of-truth semantics                   | `sdk_session` remains authoritative for tenant, project, channel, and granted capabilities | `apps/runtime/src/__tests__/omnichannel-identity-linking.integration.test.ts` |
| OCS-R02 | Unsigned `userContext.userId` starts behaving like authorization identity | Unsigned values remain metadata only                                                       | `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`            |
| OCS-R03 | Existing anonymous SDK flows regress                                      | Anonymous users can still start sessions and auth-preflight flows                          | `apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts`                   |
| OCS-R04 | Contact preload regresses session-start latency                           | Hybrid mode keeps startup under one second                                                 | `apps/runtime/src/__tests__/omnichannel-recall-service.integration.test.ts`   |
| OCS-R05 | History leaks across projects because contact history is reused           | Recall remains strictly project-scoped                                                     | `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`            |
| OCS-R06 | Shared-session transcript duplicates assistant messages                   | Voice and text delivery persist and render once                                            | `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`             |
| OCS-R07 | Browser refresh creates a new live session instead of reattaching         | Refresh rejoins the same session and backfills missed items                                | `apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts`             |
| OCS-R08 | Merge or GDPR delete produces stale recall data                           | Merge expands only valid history and GDPR delete removes it                                | `apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts`            |
| OCS-R09 | Redis or cross-pod fan-out gaps break attached participants               | Participants can reconnect and recover missed transcript items                             | `apps/runtime/src/__tests__/omnichannel-recovery.e2e.test.ts`                 |
| OCS-R10 | Studio settings widen capabilities beyond project policy                  | Channel and SDK requests can only narrow behavior                                          | `apps/studio/src/__tests__/omnichannel-settings-routes.test.ts`               |
| OCS-R11 | Cross-channel recall breaks when channel metadata format changes          | Recall preserves original channel/sourceChannel metadata across all supported channels     | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`            |
| OCS-R12 | allowedChannels filter silently drops all messages instead of filtering   | Channel filter returns correct subset, empty filter returns all                            | `apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts`            |
| OCS-R13 | Omnichannel router not mounted in server.ts (production dead code)        | Router registration exists and matches E2E harness wiring                                  | Manual verification against `apps/runtime/src/server.ts` (GAP-020)            |
| OCS-R14 | Recall integration never called from agent execution pipeline             | `executeOmnichannelRecall()` has at least one production caller                            | Grep for callers in production code (GAP-021)                                 |

---

## Known Gaps and Next Tests

### Highest Priority for BETA

1. Complete recovery E2E tests (`omnichannel-recovery.e2e.test.ts`) — reconnect, backfill after disconnect, Redis failover (GAP-013).
2. Add SDK handler integration tests (`omnichannel-sdk-handler.integration.test.ts`) — WS message routing, auth context propagation.
3. ~~Wire identity-verification completion to contact linking end-to-end (GAP-003) and add E2E coverage.~~ **DONE** (GAP-014 + GAP-019, 2026-03-24)
4. ~~Add Studio settings/smoke tests.~~ **PARTIAL** — panel unit tests done (GAP-018, 2026-03-24); route tests and browser smoke test still needed.

### Follow-On Coverage

5. Add join token one-time-use and expiry E2E test.
6. ~~Add retention window enforcement test.~~ **DONE** (GAP-015, 2026-03-24 — retention clamping in recall service).
7. ~~Add cross-channel recall coverage (WS↔http_async, voice→WhatsApp).~~ **DONE** — OCS-E07 through OCS-E12 implemented (2026-03-24), 6 tests passing in `omnichannel-cross-channel.e2e.test.ts`.
8. Add SMS, Slack, and Teams attachable-participant coverage after voice plus web and mobile are stable.
9. Add long-history ranking and token-budget tests with realistic transcript volume.
10. Add cross-pod fan-out and reconnect chaos tests in a shared staging environment.

---

## Running Tests

Use these commands after the planned test files land. Build before tests so Turbo resolves compiled outputs correctly.

```bash
# Runtime omnichannel suites
pnpm build --filter=runtime
pnpm test --filter=runtime -- apps/runtime/src/__tests__/omnichannel-identity-linking.integration.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/omnichannel-recall.e2e.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/omnichannel-live-session.e2e.test.ts
pnpm test --filter=runtime -- apps/runtime/src/__tests__/omnichannel-privacy-gates.e2e.test.ts

# SDK shared-session coverage
pnpm build --filter=@anthropic/agent-sdk
pnpm test --filter=@anthropic/agent-sdk -- packages/web-sdk/src/__tests__/session-manager-omnichannel.test.ts
pnpm test --filter=@anthropic/agent-sdk -- packages/web-sdk/src/__tests__/chat-backfill.test.ts
pnpm test --filter=@anthropic/agent-sdk -- packages/web-sdk/src/__tests__/unified-widget-live-sync.test.ts

# Identity verification E2E
pnpm test --filter=runtime -- apps/runtime/src/__tests__/omnichannel-identity-verification.e2e.test.ts

# Cross-channel recall E2E
pnpm test --filter=runtime -- apps/runtime/src/__tests__/omnichannel-cross-channel.e2e.test.ts

# Studio control-plane coverage
pnpm build --filter=studio
pnpm test --filter=studio -- apps/studio/src/__tests__/omnichannel-settings-panel.test.tsx
pnpm test --filter=studio -- apps/studio/src/__tests__/omnichannel-settings-routes.test.ts
pnpm test --filter=studio -- apps/studio/e2e/omnichannel-session-continuity-smoke.spec.ts
```

---

## References

- Feature doc: [../features/omnichannel-session-continuity.md](../features/omnichannel-session-continuity.md)
- High-level design: [../specs/omnichannel-session-continuity.hld.md](../specs/omnichannel-session-continuity.hld.md)
