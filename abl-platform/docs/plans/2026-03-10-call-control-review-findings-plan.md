# Call Control & Agent Transfer — Review Findings Implementation Plan

**Date:** 2026-03-10
**Status:** Draft
**Input:** 5-agent parallel review (UI, Integrations, XO Parity, Performance, Reliability)
**Scope:** 52 findings — 13 critical/high, 21 medium, 16 low + XO parity gaps (22 missing features)

---

## Phase 1 — Production Safety (Critical/High Fixes)

> These must be fixed before any production voice deployment. All are in existing files — no new packages.

### Task 1: Fix session `update()` TOCTOU race with Lua script

**Reviewers:** Reliability #1, Performance P0-2
**Files:** `packages/agent-transfer/src/session/transfer-session-store.ts`, `packages/agent-transfer/src/session/lua-scripts.ts`

- Replace the `EXISTS` + `HMSET` two-command pattern in `update()` (lines 164–213) with a Lua script that atomically checks existence and sets fields
- Remove the redundant `EXISTS` round-trip — this also fixes the performance issue (doubles Redis latency on every message)
- Add the new `LUA_UPDATE_SESSION` script to `lua-scripts.ts` alongside the existing `LUA_CREATE_SESSION`, `LUA_END_SESSION`, `LUA_CLAIM_SESSION`
- **Test:** Add a concurrency test — two concurrent `update()` calls on the same session should not create ghost sessions

### Task 2: Fix leader election TOCTOU in `tryBecomeLeader()`

**Reviewer:** Reliability #2
**Files:** `packages/agent-transfer/src/session/session-recovery-service.ts`

- Replace the `SET NX` → `GET` → `EXPIRE` three-command pattern (lines 159–190) with:
  - Initial acquisition: `SET key value NX EX ttl` (already correct)
  - Renewal: `SET key value XX EX ttl` (single atomic update-if-exists)
- Remove the `GET` + `EXPIRE` fallback path entirely
- **Test:** Verify two pods cannot both set `isLeader = true` simultaneously

### Task 3: Fix session timeout scheduler pod-local `activeJobs` map

**Reviewers:** Reliability #3, Performance P2-4
**Files:** `packages/agent-transfer/src/events/session-timeout-scheduler.ts`

- `cancelTimeout()` should call `queue.remove('timeout:' + sessionKey)` directly using the deterministic BullMQ jobId, rather than relying on the pod-local `activeJobs` Map
- Keep the Map as a performance cache (skip the `queue.remove()` call if the Map confirms the job was already cancelled locally)
- Remove the eviction-by-oldest logic — evict by soonest-scheduled if a cap is needed
- **Test:** Simulate pod restart — verify a timeout scheduled on pod A can be cancelled by pod B

### Task 4: Implement auth token refresh (JWT and OAuth2)

**Reviewers:** Integrations INT-01/09/10, Reliability #7
**Files:**

- `packages/agent-transfer/src/adapters/auth/jwt.ts`
- `packages/agent-transfer/src/adapters/auth/oauth2-client.ts`
- `packages/agent-transfer/src/adapters/registry.ts`

- `JWTAuth.refresh()` (line 21): Implement actual token fetch — call the configured token endpoint, parse JWT response, update cached credential
- `OAuth2ClientAuth.refresh()` (line 44): Implement client_credentials grant refresh — POST to token endpoint, parse access_token, update cached credential
- `AdapterRegistry.invalidateAuth()` (lines 50–55): Wire through to `adapter.invalidateAuth?.(tenantId)` if the adapter exposes it; add `invalidateAuth` to the `AgentDesktopAdapter` interface
- **Test:** Mock token endpoint returning new credentials, verify refresh replaces the stale token

### Task 5: Replace `SMEMBERS` with `SSCAN` + pipeline batching in recovery

**Reviewers:** Performance P0-1/P1-1, Reliability #10
**Files:** `packages/agent-transfer/src/session/session-recovery-service.ts`

- Replace `redis.smembers(ACTIVE_SESSIONS_SET)` (line 195) with `SSCAN` cursor-based iteration (batch size ~100)
- Batch heartbeat checks with `redis.pipeline()` across each scan batch instead of sequential per-key calls
- Consider sharding `at_active_sessions` by tenant (`at_active_sessions:{tenantId}`) — evaluate if recovery needs a global view or can operate per-tenant
- **Test:** Mock 1,000 sessions — verify recovery completes in < 1s instead of 2s × N sequential round-trips

### Task 6: Fix `extendTTL()` N+1 HGETALL pattern

**Reviewer:** Performance P0-3
**Files:** `packages/agent-transfer/src/session/transfer-session-store.ts`

- Accept an optional `channel` hint parameter so callers (who already have the session) can skip the full `get()` call
- Alternatively, consolidate into a Lua script: single round-trip for `HGET channel` + `EXPIRE` both keys + `HMSET` timestamp
- Update callers in `message-bridge.ts` and `agent-transfer-webhooks.ts` to pass the channel hint

---

## Phase 2 — Reliability & Integration Hardening (High/Medium Fixes)

### Task 7: Fix UI error handling gaps

**Reviewers:** UI C1, C2, H4
**Files:**

- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`

- Add `catch` block with `toast.error` to `handleEndSession` (line 96–108) — currently swallows errors silently
- Add `post_agent` to the "End" button disable condition (line 224–226) — prevent ending sessions that have returned to bot
- Add `catch` with `toast.error` to `handleReset` in settings page (line 284–294)

### Task 8: Add per-agent voice settings to EscalationEditor

**Reviewers:** UI H1, H2
**Files:**

- `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx`
- Agent-editor types file (EscalationRouting type)

- Extend the `EscalationRouting` type with `voice?: { transfer_method?: 'invite' | 'refer' | 'bye'; sip_headers?: Record<string, string> }`
- Add a collapsible "Voice Settings" sub-section inside `RoutingEditor` (lines 402–566) with:
  - Transfer method dropdown (invite/refer/bye)
  - SIP headers key-value editor
- Only show when connection is a voice-capable provider

### Task 9: Fix provider list mismatch (NICE/Five9)

**Reviewer:** UI H3
**Files:**

- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/components/connections/agent-desktop-registry.ts`

- Remove `nice` and `five9` from `PROVIDER_OPTIONS` in TransferSessionsPage (line 33–39) — they are not creatable
- OR add them to `AGENT_DESKTOP_PROVIDERS` in agent-desktop-registry.ts if they should be supported
- Ensure the two surfaces are always derived from the same source of truth

### Task 10: Fix webhook session TTL skip on delivery errors

**Reviewer:** Integrations INT-12
**Files:** `apps/runtime/src/routes/agent-transfer-webhooks.ts`

- Move the `extendTTL()` call (line 191) into the `handleInboundEvent` success path, BEFORE `routeAgentEvent`
- Or wrap `routeAgentEvent` in its own try/catch so that delivery failures don't prevent TTL extension
- **Test:** Verify session TTL is extended even when message delivery fails

### Task 11: Surface agent status events on chat channels

**Reviewer:** Integrations INT-05
**Files:** `apps/runtime/src/services/agent-transfer/message-bridge.ts`

- `deliverViaChatChannel` (line 297) currently only delivers `agent:message` and `agent:form`
- Add support for `agent:connected`, `agent:queued` (with estimated wait/position), and `agent:typing` events
- Map these to appropriate text messages for text-only channels (Slack, WhatsApp)

### Task 12: Fix SmartAssist connection pool hardcoding

**Reviewer:** Performance P1-2
**Files:** `packages/agent-transfer/src/adapters/kore/smartassist-client.ts`

- Make `connections: 50` configurable via `SmartAssistConfig` (line 59–63)
- Add pool queue depth metric (OTel gauge)
- Consider `pipelining: 2` for idempotent check calls (availability, hours)

### Task 13: Fix `forceEvictOldest()` O(N) sort in message bridge

**Reviewer:** Performance P1-3
**Files:** `apps/runtime/src/services/agent-transfer/message-bridge.ts`

- Replace the spread + sort + slice pattern (line 225–233) with Map iteration (insertion order = oldest first)
- For bulk eviction of 1,000 entries, iterate the Map directly with a counter — O(k) instead of O(N log N)

### Task 14: Fix dead letter store per-tenant isolation

**Reviewer:** Reliability #4
**Files:** `apps/runtime/src/services/agent-transfer/event-queue-factory.ts`

- Namespace dead letter keys per tenant: `agent-transfer:dead-letters:{tenantId}`
- Add per-tenant cap (e.g., 100 entries) with `ZREMRANGEBYRANK` after add
- Schedule periodic `deleteOlderThan()` cleanup (the method exists but is never called)

### Task 15: Increase graceful shutdown drain timeout

**Reviewer:** Reliability #5
**Files:** `packages/agent-transfer/src/events/graceful-shutdown.ts`

- Raise `DRAIN_TIMEOUT_MS` from 5s to 15s (line 16)
- Pause BullMQ workers (stop polling) before calling close, to prevent new job acquisition during drain

### Task 16: Add WebSocket routing recovery metadata

**Reviewer:** Reliability #6
**Files:** `apps/runtime/src/services/agent-transfer/message-bridge.ts`

- Store channel type and connection hints in Redis session metadata during WebSocket registration
- On pod failover, the recovering pod can reconstruct delivery path from session metadata
- Add a metric counter for dropped/undeliverable agent messages

---

## Phase 3 — UI Polish & Accessibility (Medium/Low)

### Task 17: UI accessibility and validation fixes

**Reviewers:** UI M1–M8, L1–L5
**Files:**

- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`
- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/components/operate/TransferSessionDetailModal.tsx`
- `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx`
- `apps/studio/src/components/navigation/ProjectSidebar.tsx`

Batch of UI fixes:

- **M1:** Add `aria-label` to ToggleField buttons
- **M2:** Use unique `name` attributes for radio groups (include component instance ID)
- **M3:** Add input clamping/validation for NumberField (reject out-of-range on blur)
- **M4:** Add `useInterval(1000)` for live duration display in sessions table
- **M5:** Add pagination or virtualization to sessions table (limit 50 rows per page)
- **M6:** Add "End Session" action button to TransferSessionDetailModal
- **M7:** Add "Test Connection" button to ConnectionCreatePage agent desktop flow
- **M8:** Add loading skeleton for sessions table (distinguish loading from empty)
- **L1:** Default `connectionId` to `undefined` instead of `''` in RoutingEditor
- **L2:** Add tooltip drill-down for collapsed sidebar groups
- **L3:** Use `Intl.DateTimeFormat` with explicit locale/timezone for date display
- **L4:** Default Voice Gateway section to open for voice-enabled projects
- **L5:** Add Framer Motion entrance animation to TransferSessionDetailModal

### Task 18: Replace Studio polling with WebSocket push

**Reviewers:** Performance P2-1, UI M4
**Files:**

- `apps/studio/src/hooks/useTransferSessions.ts`
- `apps/runtime/src/services/agent-transfer/message-bridge.ts`
- Runtime WebSocket handler

- Push session-state-change events over the existing Studio debug WebSocket connection
- Use `mutate()` to update the SWR cache on receipt
- Fall back to 30s polling only when WebSocket is unavailable

---

## Phase 4 — Integration Completeness (Medium/Low)

### Task 19: Fix webhook security gaps

**Reviewers:** Integrations INT-02/03/04
**Files:**

- `apps/runtime/src/routes/agent-transfer-webhooks.ts`
- `packages/agent-transfer/src/security/webhook-verification.ts`

- **INT-02:** Add per-provider webhook config lookup (header name, signature scheme) instead of hardcoded `'kore'` → `x-kore-signature`
- **INT-03:** Add `log.warn('Webhook signature verification DISABLED')` when `webhookSecret` is absent
- **INT-04:** Use the inbound signature (not server-computed) as the nonce key for replay detection

### Task 20: Fix VoiceGatewayRegistry and SIP issues

**Reviewers:** Integrations INT-07/08, Performance P2-2
**Files:**

- `packages/agent-transfer/src/voice/voice-gateway.ts`

- **INT-07:** Add TTL-based auto-cleanup for stale gateway registrations
- **INT-08:** Add default `referredBy` population in `refer()` verb for SIP UA compatibility
- **P2-2:** Add cross-gateway session index (`sessionId → gatewayName`) for O(1) lookup

### Task 21: Wire SDK notification failures to dead letter store

**Reviewer:** Integrations INT-11
**Files:** `packages/agent-transfer/src/events/event-worker.ts`

- Add dead letter handler path for `SdkNotificationQueue` failures
- Failed SDK notifications should be persisted in `DeadLetterStore` like other event failures

### Task 22: Fix rate limiter unbounded sorted set growth

**Reviewer:** Performance P2-3
**Files:** `packages/agent-transfer/src/security/rate-limiter.ts`

- Add `ZREMRANGEBYRANK` after `ZADD` to cap sorted set size at `maxTransfers * 2`
- Or replace with a Lua-based sliding window counter for simpler high-throughput scenarios

### Task 23: Connect fallback executor metrics to OTel

**Reviewer:** Reliability #8
**Files:** `packages/agent-transfer/src/adapters/fallback-executor.ts`

- Replace module-level mutable `metrics` object with OTel counters (consistent with `metrics.ts`)
- Remove `resetFallbackMetrics()` export

### Task 24: Add queue depth and dead letter count to health checks

**Reviewer:** Reliability #9
**Files:** `packages/agent-transfer/src/observability/health.ts`

- Add BullMQ queue depth (`waiting`, `active`, `delayed` counts) to `AgentTransferHealthReport`
- Add dead letter entry count
- Set `status: 'degraded'` if `waiting > threshold` or `deadLetterCount > 0`

### Task 25: Defer recovery scan from boot path

**Reviewer:** Performance P3-1
**Files:** `apps/runtime/src/services/agent-transfer/index.ts`

- Move `recoverOrphanedSessions()` to an async background task after the HTTP server is listening
- Don't block `initializeAgentTransfer()` on the first recovery scan

---

## Phase 5 — XO Parity: Voice Foundation

> These are new feature work required for voice channel completeness. Depends on Phase 1–2.

### Task 26: Implement Voice Gateway Bridge (KoreVG)

**Reviewer:** XO Parity — critical blocker
**Files:**

- `packages/agent-transfer/src/voice/` — new files: `gateway-interface.ts`, `korevg-gateway.ts`
- `apps/runtime/src/services/voice/korevg/korevg-session.ts`

- Implement the `VoiceGateway` interface from the design doc (Section 8.3): `transfer`, `playMessage`, `hangup`, `sendDTMF`, `collectDTMF`
- Wire KoreVG implementation to Jambonz verb builder
- Connect to `VoiceGatewayRegistry`
- **This unblocks:** hold/MOH, call recording, speech IVR, attended transfer

### Task 27: Add hold/unhold + music on hold

**Reviewer:** XO Parity — high gap
**Files:**

- `packages/agent-transfer/src/voice/` — extend gateway interface
- `apps/runtime/src/services/voice/korevg/verb-builder.ts` — add hold verb

- Add `hold()`, `unhold()` to VoiceGateway interface
- Implement MOH (configurable hold music URL or TTS loop)
- Add periodic hold messages (XO11 "waiting experience")
- Support DTMF-during-hold for re-trigger

### Task 28: Enable speech input mode in IVR tools

**Reviewer:** XO Parity — medium gap
**Files:**

- `packages/agent-transfer/src/tools/ivr-menu.ts`
- `packages/agent-transfer/src/tools/ivr-digit-input.ts`

- Remove hardcoded `enableSpeechInput: false`
- Add `inputMode: 'dtmf' | 'speech' | 'dtmf_speech'` parameter (default: `'dtmf'`)
- Wire speech recognition config through to KoreVG gather verb

### Task 29: Add call recording controls

**Reviewer:** XO Parity — high gap (compliance)
**Files:**

- `packages/agent-transfer/src/voice/` — extend gateway interface
- New tool: `packages/agent-transfer/src/tools/call-recording.ts`

- Add `startRecording`, `stopRecording`, `pauseRecording`, `resumeRecording` to VoiceGateway
- Create `CallRecordingTool` with start/stop/pause/resume actions
- Wire to `TransferToolExecutor`

### Task 30: Add conference/consult call support

**Reviewer:** XO Parity — high gap
**Files:**

- `packages/agent-transfer/src/tools/call-transfer.ts` — extend
- `packages/agent-transfer/src/types.ts` — new types

- Add `transferType: 'blind' | 'attended' | 'consult'` to `CallTransferInput`
- Implement consult flow: agent A connects to agent B while caller is on hold, then merge
- Add `isConsultCall`, `isConsultMerged` tracking fields

---

## Phase 6 — Provider Expansion

### Task 31: Implement Genesys Cloud adapter

**Files:** `packages/agent-transfer/src/adapters/genesys/`

- Implement `AgentDesktopAdapter` for Genesys Cloud (OAuth2, conversations API, webhooks)
- Wire through `AdapterRegistry`

### Task 32: Implement Salesforce Service Cloud adapter

**Files:** `packages/agent-transfer/src/adapters/salesforce/`

- Implement adapter for Salesforce LiveAgent / Einstein Bots
- OAuth2 auth, Omni-Channel API

### Task 33: Implement ServiceNow adapter

**Files:** `packages/agent-transfer/src/adapters/servicenow/`

- Implement adapter for ServiceNow Agent Workspace
- OAuth2 auth, Connect Support API

---

## Phase 7 — Studio UI: Broken / Data Loss Fixes (CRITICAL)

> These cause data loss, silent corruption, or non-functional features. Must fix before users configure transfer via Studio.

### Task 34: Fix `endTransferSession` API route — 404

**Reviewer:** UX Flow #2
**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/agent-transfer/sessions/[sessionId]/end/route.ts`

- The End Session button calls `POST /api/projects/:id/agent-transfer/sessions/:sessionId/end` but no Next.js API route handler exists
- Create the route handler that proxies to the runtime's end-session endpoint
- **Test:** Verify End button in TransferSessionsPage actually terminates a session

### Task 35: Fix voice config structure mismatch (flat vs nested)

**Reviewer:** Settings #1
**Files:**

- `apps/studio/src/api/agent-transfer.ts` — fix `AgentTransferSettings.voice` type
- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` — update form field paths

- UI sends flat `voice.transferMethod` / `voice.headerPassthrough` / `voice.recordingEnabled`
- Backend expects nested `voice.sipDefaults.transferMethod` / `voice.sipDefaults.headerPassthrough` / `voice.recording.enabled`
- Restructure the UI type and form to match the backend `VoiceGatewayConfigSchema` exactly
- **Test:** Save voice settings, reload, verify they round-trip correctly

### Task 36: Fix TTL unit mismatch (minutes vs seconds)

**Reviewer:** Settings #2
**Files:**

- `apps/studio/src/api/agent-transfer.ts` — add conversion layer
- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` — display/input in minutes

- UI labels say "minutes" but sends raw numbers; backend stores seconds
- Add `* 60` on save, `/ 60` on load, or change UI to seconds with clear labels
- **Test:** Set TTL to 30 minutes in UI, verify backend stores 1800

### Task 37: Fix EscalationEditor priority enum mismatch

**Reviewer:** Agent Editor C1
**Files:**

- `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx` — fix priority options
- `apps/studio/src/store/agent-detail-store.ts` — fix parseEscalation default

- Form uses `['low', 'normal', 'high', 'urgent']`; IR uses `['low', 'medium', 'high', 'critical']`
- Change form options to match IR: `low`, `medium`, `high`, `critical`
- Fix parseEscalation to default to `'medium'` instead of `'normal'`
- **Test:** Round-trip agent with `critical` priority through form editor, verify preserved

### Task 38: Add voice transfer sub-editor to EscalationEditor

**Reviewer:** Agent Editor C2, C3
**Files:**

- `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx` — add voice sub-section to RoutingEditor

- Add collapsible "Voice Settings" inside RoutingEditor with:
  - Transfer method dropdown: `invite` | `refer` | `bye`
  - SIP headers key-value editor (add/remove pairs)
- Add `providerConfig` JSON editor (collapsible, for advanced users)
- Both fields are correctly serialized already (`abl-serializers.ts:432-444`) — they just need UI inputs
- **Test:** Set voice transfer method + SIP headers, save, reload, verify preserved

### Task 39: Fix agent transfer settings API route

**Reviewer:** UX Flow #3
**Files:**

- Create: `apps/studio/src/app/api/projects/[id]/agent-transfer/settings/route.ts` (GET + PUT)
- Modify: `apps/studio/src/api/agent-transfer.ts` — point to dedicated route

- Currently piggybacks on generic `/api/projects/:id/settings` which may ignore unknown keys
- Create a dedicated Next.js API route that stores/retrieves agent-transfer settings reliably
- **Test:** Save settings, reload, verify all fields persist

### Task 40: Fix `settings-pii-protection` AppShell routing

**Reviewer:** UX Flow #1, #7, #9
**Files:**

- `apps/studio/src/components/navigation/AppShell.tsx` — add case for `settings-pii-protection`

- Add `case 'settings-pii-protection': return <PIIProtectionTab />;` (or `<ComingSoonPage>` if component not ready)
- Import the component from `../settings/PIIProtectionTab` (referenced in `ProjectSettingsPage.tsx:40`)
- **Test:** Navigate to Settings → PII Protection, verify correct page renders

---

## Phase 8 — Studio UI: Monitoring Dashboard Fixes (HIGH)

### Task 41: Add search, pagination, and channel column to TransferSessionsPage

**Reviewer:** Monitoring #1, #2, #13
**Files:**

- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/hooks/useTransferSessions.ts`
- `apps/studio/src/api/agent-transfer.ts`

- Wire `searchValue`/`onSearchChange` props to `ListPageShell` for contactId/sessionId search
- Add `page`/`limit` params to `useTransferSessions` and `listTransferSessions` API call
- Wire `pagination` prop to `ListPageShell` (component already exists)
- Add Channel column to the table between Provider and Status
- Add `campaign` to `CHANNEL_OPTIONS` filter
- Default status filter to exclude `ended` sessions
- **Test:** Verify search, pagination, and channel filter all work

### Task 42: Expand TransferSession API type and detail modal

**Reviewer:** Monitoring #4, #5
**Files:**

- `apps/studio/src/api/agent-transfer.ts` — extend `TransferSession` type
- `apps/studio/src/components/operate/TransferSessionDetailModal.tsx` — add missing fields

- Add to `TransferSession` type: `csatSurveyType`, `csatDialogId`, `dispositionCode`, `wrapUpNotes`, `postAgentConfig`, `tenantId`, `ownerPod`, `lastHeartbeat`, `ttl`
- Display these in the detail modal in organized sections (Session Info, Post-Agent Data, System Info)
- Add "End Session" action button to the modal footer
- **Test:** Open detail modal for a session with CSAT data, verify all fields visible

### Task 43: Fix empty state, error state, and duration display

**Reviewer:** Monitoring #3, #7, #8
**Files:**

- `apps/studio/src/components/operate/TransferSessionsPage.tsx`

- Empty state: Add action link to `settings-agent-transfer` ("Configure agent transfer")
- Error state: Replace raw error with generic "Failed to load sessions" + retry button, use `sanitizeError()`
- Duration: Add `useEffect`/`setInterval(1000)` ticker to keep durations live between polls
- **Test:** Verify all three states render correctly

### Task 44: Derive provider filter from configured connections

**Reviewer:** Monitoring #11
**Files:**

- `apps/studio/src/components/operate/TransferSessionsPage.tsx`
- `apps/studio/src/hooks/useConnections.ts` (or create)

- Replace hardcoded `PROVIDER_OPTIONS` (smartassist/genesys/nice/five9) with dynamic list from project's configured agent_desktop connections
- Remove NICE/Five9 if not in agent-desktop-registry
- **Test:** Create a SmartAssist connection, verify it appears as the only filter option

---

## Phase 9 — Studio UI: Agent Editor Form Completeness (HIGH)

### Task 45: Create IVR tool form editors

**Reviewer:** Agent Editor H1
**Files:**

- Create: `apps/studio/src/components/agent-editor/sections/IVRMenuEditor.tsx`
- Create: `apps/studio/src/components/agent-editor/sections/IVRDigitInputEditor.tsx`
- Modify: `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx` — detect IVR tools and render dedicated editors

- IVR Menu editor: prompt text, DTMF mappings table (key → action/intent), noInput config (timeout, maxRetries, message), noMatch config, bargeIn toggle, language
- IVR Digit Input editor: prompt, maxDigits (1-20), endingKeyPress, interDigitTimeout (500-30000ms), noInput/noMatch config, language
- Detect tool name `ivr_menu` / `ivr_digit_input` in ToolsEditor and render the dedicated editor instead of the generic grid
- **Test:** Configure an IVR menu tool via form, save, verify DSL output matches expected schema

### Task 46: Create call_transfer and deflect_to_chat form editors

**Reviewer:** Agent Editor H2, H3
**Files:**

- Create: `apps/studio/src/components/agent-editor/sections/CallTransferEditor.tsx`
- Create: `apps/studio/src/components/agent-editor/sections/DeflectToChatEditor.tsx`
- Modify: `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx`

- Call Transfer editor: transferType dropdown (SIP/PSTN), conditional fields (phoneNumber for PSTN, sipTransferId for SIP), message, language
- Deflect editor: deflectionType (automation/agentTransfer), triggerType (userSelection/automationContext), message, language
- **Test:** Configure call transfer with PSTN, verify phoneNumber is required

### Task 47: Wire remaining ExecutionEditor fields

**Reviewer:** Agent Editor H4
**Files:**

- `apps/studio/src/components/agent-editor/sections/ExecutionEditor.tsx`

- Add UI controls for the 11 unwired fields: `thinkingBudget`, `reasoningEffort`, `toolTimeout`, `llmTimeout`, `sessionIdleTimeout`, `maxReasoningIterations`, `maxFlowIterations`, `voiceLatencyTarget`, `fallbackModel`, `concurrency`, `operationModels`
- Group into sections: LLM Settings, Timeouts, Voice, Advanced
- Use appropriate input types (number for timeouts, dropdown for reasoningEffort, model picker for fallbackModel)
- **Test:** Set each field, save, reload, verify all persist

---

## Phase 10 — Studio UI: UX & Discoverability (MEDIUM)

### Task 48: Add cross-page links and onboarding hints

**Reviewer:** UX Flow #4, #6
**Files:**

- `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx` — link empty state to Connections
- `apps/studio/src/components/creation/ReviewAndCreate.tsx` — add transfer setup hint

- EscalationEditor empty state: Change plain text to a clickable link/button navigating to Connections page
- Onboarding: Add optional step or post-creation hint: "To enable escalation to human agents, configure a Connection"
- **Test:** Click the link in EscalationEditor, verify it navigates to Connections

### Task 49: Add transfer lifecycle events to debug timeline

**Reviewer:** UX Flow #5
**Files:**

- `apps/studio/src/components/observatory/EventTimeline.tsx`

- Add event types to icon map: `transfer_queued`, `transfer_active`, `transfer_ended`, `transfer_failed`
- Map to appropriate icons and colors
- Wire event rendering for transfer state transitions during live debug sessions
- **Test:** Run a debug session with escalation, verify transfer events appear in timeline

### Task 50: Add connection edit flow

**Reviewer:** Settings #4
**Files:**

- `apps/studio/src/components/connections/ConnectionDetailPage.tsx`

- Add "Edit" button that toggles form fields to editable mode
- Wire `updateConnection()` from `api/connections.ts:100` (already exists, never called)
- Allow updating credentials, display name, and provider config
- **Test:** Edit a SmartAssist connection's API key, save, verify persisted

### Task 51: Add voice_config sub-editors to Gather/Completion/ErrorHandling editors

**Reviewer:** Agent Editor M6, M7
**Files:**

- `apps/studio/src/components/agent-editor/sections/GatherEditor.tsx`
- `apps/studio/src/components/agent-editor/sections/CompletionEditor.tsx`
- `apps/studio/src/components/agent-editor/sections/ErrorHandlingEditor.tsx`

- Add collapsible "Voice Config" sub-section to each editor
- Fields: SSML template, voice instructions, plain text fallback
- Only show when the project has voice channel enabled
- **Test:** Add voice config to a gather field, save, verify IR output

### Task 52: I18N — add translations for all transfer/escalation UI strings

**Reviewer:** UX Flow #10, #11
**Files:**

- `apps/studio/messages/en.json` — add translation keys
- `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx` — use `useTranslations()`
- `apps/studio/src/components/operate/TransferSessionsPage.tsx` — use `useTranslations()`
- `apps/studio/src/components/agent-editor/sections/EscalationEditor.tsx` — use `useTranslations()`

- Extract all hardcoded English strings into i18n keys
- Follow existing pattern from `DebugTabs.tsx` using `useTranslations('namespace')`
- **Test:** Verify no hardcoded English remains in transfer-related components

---

## Phase Summary

| Phase                                    | Tasks | Priority              | Effort               |
| ---------------------------------------- | ----- | --------------------- | -------------------- |
| **1 — Production Safety**                | 1–6   | Critical              | ~1 week ✅ DONE      |
| **2 — Reliability/Integration**          | 7–16  | High                  | ~2 weeks             |
| **3 — UI Polish**                        | 17–18 | Medium                | ~1 week              |
| **4 — Integration Completeness**         | 19–25 | Medium                | ~1 week              |
| **5 — Voice Foundation**                 | 26–30 | High (new features)   | ~3 weeks             |
| **6 — Provider Expansion**               | 31–33 | Medium (new features) | ~2 weeks per adapter |
| **7 — Studio UI: Broken/Data Loss**      | 34–40 | **Critical**          | ~1 week              |
| **8 — Studio UI: Monitoring**            | 41–44 | High                  | ~1 week              |
| **9 — Studio UI: Agent Editor Forms**    | 45–47 | High                  | ~2 weeks             |
| **10 — Studio UI: UX & Discoverability** | 48–52 | Medium                | ~1.5 weeks           |

---

## Cross-Reference: Review Findings → Tasks

| Finding                          | Task    |
| -------------------------------- | ------- |
| Reliability #1 / Perf P0-2       | Task 1  |
| Reliability #2                   | Task 2  |
| Reliability #3 / Perf P2-4       | Task 3  |
| INT-01/09/10 / Reliability #7    | Task 4  |
| Perf P0-1/P1-1 / Reliability #10 | Task 5  |
| Perf P0-3                        | Task 6  |
| UI C1/C2/H4                      | Task 7  |
| UI H1/H2                         | Task 8  |
| UI H3                            | Task 9  |
| INT-12                           | Task 10 |
| INT-05                           | Task 11 |
| Perf P1-2                        | Task 12 |
| Perf P1-3                        | Task 13 |
| Reliability #4                   | Task 14 |
| Reliability #5                   | Task 15 |
| Reliability #6                   | Task 16 |
| UI M1-M8/L1-L5                   | Task 17 |
| Perf P2-1                        | Task 18 |
| INT-02/03/04                     | Task 19 |
| INT-07/08 / Perf P2-2            | Task 20 |
| INT-11                           | Task 21 |
| Perf P2-3                        | Task 22 |
| Reliability #8                   | Task 23 |
| Reliability #9                   | Task 24 |
| Perf P3-1                        | Task 25 |
| XO Voice Gateway                 | Task 26 |
| XO Hold/MOH                      | Task 27 |
| XO Speech IVR                    | Task 28 |
| XO Call Recording                | Task 29 |
| XO Conference/Consult            | Task 30 |
| XO Genesys                       | Task 31 |
| XO Salesforce                    | Task 32 |
| XO ServiceNow                    | Task 33 |

---

| UX Flow #2 — endTransferSession 404 | Task 34 |
| Settings #1 — voice config flat vs nested | Task 35 |
| Settings #2 — TTL minutes vs seconds | Task 36 |
| Agent Editor C1 — priority enum mismatch | Task 37 |
| Agent Editor C2/C3 — voice/providerConfig dropped | Task 38 |
| UX Flow #3 — settings via generic endpoint | Task 39 |
| UX Flow #1/#7/#9 — PII protection unrouted | Task 40 |
| Monitoring #1/#2/#13/#14 — search/pagination/channel | Task 41 |
| Monitoring #4/#5 — missing session fields | Task 42 |
| Monitoring #3/#7/#8 — empty/error/duration | Task 43 |
| Monitoring #11 — hardcoded provider filter | Task 44 |
| Agent Editor H1 — IVR tool editors | Task 45 |
| Agent Editor H2/H3 — call_transfer/deflect editors | Task 46 |
| Agent Editor H4 — ExecutionEditor unwired fields | Task 47 |
| UX Flow #4/#6 — cross-page links/onboarding | Task 48 |
| UX Flow #5 — debug timeline events | Task 49 |
| Settings #4 — connection edit flow | Task 50 |
| Agent Editor M6/M7 — voice_config sub-editors | Task 51 |
| UX Flow #10/#11 — i18n hardcoded English | Task 52 |

---

## Design Doc Status Updates Needed

1. **Section 8.1** (IVR tools): Change from "❌ Not Started" to "✅ Implemented" — `ivr-menu.ts` and `ivr-digit-input.ts` now exist
2. **Section 10.4 Phase 3b** (IVR tools): Same — mark as implemented
3. **XO11_TO_ABL_MAPPING.md**: Add call control and agent transfer parity section (currently only covers generative AI nodes)
