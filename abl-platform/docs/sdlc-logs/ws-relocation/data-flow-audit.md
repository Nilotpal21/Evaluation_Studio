# Data-Flow & Dependency-Wiring Audit: WS Relay Relocation (PR #917)

**Date**: 2026-05-07
**Auditor**: Claude Code (automated) — triggered by mandatory CLAUDE.md gate
**Round**: 1
**Feature**: `docs/sdlc-logs/ws-relocation/`
**PR**: https://bitbucket.org/koreteam1/abl-platform/pull-requests/917

## Sensitive Values Audited

- Connector raw output — DATA CLASS: BUSINESS (may contain PII / partial credentials from external API responses)
- Workflow execution snapshot (triggerMetadata + context.steps) — DATA CLASS: CREDENTIAL / BUSINESS
- WS JWT auth token — DATA CLASS: CREDENTIAL

---

## Round 1: Path Trace Findings

---

### VALUE 1: Connector raw output

```
VALUE: connector action output (Slack/GitHub/Jira/HubSpot/etc. API responses)
  DATA CLASS: BUSINESS (may include PII — contact records, emails; partial credentials — OAuth token fields in API response bodies)
  APPROVED CONSUMERS: Workflow designer viewing debug panel (Studio, project-scoped authenticated user)

  1. Source:
     connector-action-executor.ts:87 — deps.connectorToolExecutor.execute(toolName, resolvedParams, timeout, step.connectionId)
     Returns: unknown (widened from Record<string,unknown> in this PR)
     Validation: none applied to the return value

  2. Writes:
     - workflow-handler.ts:1056 — rebuildStepContext() → buildCleanStepContext('connector_action', ..., { output: result.output })
       → ctx.steps[step.id].output = output (raw, type unknown, no sanitization)
     - execution-store.ts:229–232 — context.steps.[stepKey] written to MongoDB as-is
       Format: raw (no encryption, no hashing, no field-level redaction for connector output)

  3. Serialization Boundaries:
     - workflow-handler.ts:1097-1112 — deps.publisher.publish(channel, JSON.stringify({ ..., stepData: sanitizePublishedStepData(getStepContext(ctx, step)) }))
       sanitizePublishedStepData only strips 'callbackSecret'; connector output passes through
     - wf-bridge.ts:293 — parsed.stepData forwarded to Studio WS clients as-is in workflow_step_status message
     - wf-bridge.ts:149–212 — on subscribe, findOne fetches full context doc including context.steps[*].output;
       sanitizeSnapshotDoc strips only 'callbackSecret' from step contexts; connector output passes through

  4. Read Paths:
     - wf-bridge.ts:149–168 — projection includes 'context' (which contains context.steps[*].output); audience: Studio project member
     - execution-store.ts (not shown) — any route that fetches execution context; audience: workflow engine, admin
     - Studio useExecutionWebSocket.ts + execution-merge.ts:89 — merges stepData into local state; renders in debug panel

  5. Policy Boundary:
     Consumer: Studio debug panel (project-scoped authenticated user)
       Allowed: YES for connector output that is pure business data
       CONCERN: connector API responses from HubSpot (contact PII), Jira (user info), GitHub (code/org data)
         may contain fields that should be classified PII or CREDENTIAL under data minimization policy.
         No per-field gate exists — the full response body reaches Studio.

  6. Consumers / Sinks:
     - Studio WS client (project-scoped, authenticated) — receives full stepData including connector output
     - MongoDB execution collection — persists full connector output for the execution lifetime

  7. Dependency Wiring:
     DEPENDENCY: sanitizePublishedStepData (workflow-handler.ts:697)
       Constructed at: workflow-handler.ts:690 (closure, PUBLISH_SENSITIVE_STEP_FIELDS = Set(['callbackSecret']))
       Applied at: all publisher.publish() call sites — WIRED ✓
       Gap: PUBLISH_SENSITIVE_STEP_FIELDS only contains 'callbackSecret', not connector output fields

     DEPENDENCY: sanitizeSnapshotDoc (wf-bridge.ts:449)
       Applied at: wf-bridge.ts:212 (snapshot send) — WIRED ✓
       Gap: SNAPSHOT_STEP_SENSITIVE_FIELDS = Set(['callbackSecret']); connector output not in set

  8. Parallel Paths:
     Before this PR: workflow-engine/WfBridge had `sanitizeConnectorOutput()` that discarded non-Google-shaped
       connector outputs. This was wrong behavior (silently dropped Slack/GitHub/Jira outputs) but accidentally
       prevented connector PII from reaching Studio.
     After this PR: WfBridge in runtime has NO equivalent filter. All connector outputs pass through.
     VERDICT: parallel path parity broken (intentionally, to fix silent discard) but no replacement gate added.

  9. Boundary Tests:
     - MISSING: No test asserts that a connector step output containing a PII field (e.g. 'email')
       is absent from the Studio WS message after sanitization.
     - MISSING: No test asserts that connector output containing 'access_token' in response body is filtered.
     - EXISTING: wf-bridge.test.ts tests snapshot sanitization of encryptedAccessToken/accessToken — but only for
       triggerMetadata, not for connector output inside context.steps[*].output.
```

---

### VALUE 2: Workflow execution snapshot (triggerMetadata + context.steps)

```
VALUE: execution snapshot doc (full MongoDB execution document sent on subscribe)
  DATA CLASS: CREDENTIAL (encryptedAccessToken, accessToken, callbackSecret) + BUSINESS (step outputs)
  APPROVED CONSUMERS: Studio project member (project-scoped)

  1. Source:
     wf-bridge.ts:149–168 — executionModel.findOne({ _id, tenantId, projectId, workflowId }, projection)
     Projection includes: _id, status, context, startedAt, completedAt, output, workflowId, workflowVersionId,
       workflowVersion, projectId, tenantId, triggerType, triggerMetadata, input, durationMs, error
     Access gate: checkProjectAccess(tenantId, userId, projectId) with 5s timeout — WIRED ✓

  2. Writes:
     - workflow-handler.ts:3391-3397 — encryptedAccessToken stored in context.triggerMetadata.encryptedAccessToken
       Format: encrypted ciphertext (not plaintext)
     - context.steps[*].callbackSecret — encrypted ciphertext at rest

  3. Serialization Boundaries:
     - wf-bridge.ts:212 — sanitizeSnapshotDoc(execDoc) strips encryptedAccessToken + accessToken from triggerMetadata
       and callbackSecret from context.steps — then sends as WS snapshot message ✓
     - CONCERN: context.steps[*].output (connector raw outputs) NOT stripped — same as VALUE 1 above

  4. Read Paths:
     - wf-bridge.ts:149–168 — full execution doc read from MongoDB by authenticated project member
     - Studio useExecutionWebSocket.ts — snapshot merged into local state on subscribe

  5. Policy Boundary:
     encryptedAccessToken in triggerMetadata → REDACTED in snapshot ✓ (sanitizeSnapshotDoc)
     accessToken in triggerMetadata → REDACTED in snapshot ✓ (sanitizeSnapshotDoc)
     callbackSecret in context.steps → REDACTED in snapshot ✓ (sanitizeSnapshotDoc)
     context.steps[*].output (connector output) → NOT FILTERED — same as VALUE 1 finding F-1

  6. Consumers / Sinks:
     - Studio WS client — snapshot containing full context.steps[*].output
     - No external LLM or third-party API receives the snapshot directly

  7. Dependency Wiring:
     DEPENDENCY: sanitizeSnapshotDoc
       Constructed at: wf-bridge.ts:449 (module-level function)
       Applied at: wf-bridge.ts:212 — WIRED ✓
       Gap: SNAPSHOT_STEP_SENSITIVE_FIELDS missing connector-output fields (see F-1)

  8. Parallel Paths:
     Real-time path (Redis pub/sub → workflow_step_status): sanitizePublishedStepData applied ✓
     Snapshot path (MongoDB → workflow_snapshot): sanitizeSnapshotDoc applied ✓
     PARITY: both paths strip callbackSecret ✓; both paths do NOT strip connector output — consistent (but insufficient)

  9. Boundary Tests:
     EXISTING: wf-bridge.test.ts:~250+ — 'snapshot sanitization' tests verify encryptedAccessToken + accessToken
       are absent from snapshot; callbackSecret absent from step data ✓
     MISSING: No test verifies connector output inside context.steps[*].output is handled correctly
```

---

### VALUE 3: WS JWT auth token

```
VALUE: JWT user auth token (extracted from Sec-WebSocket-Protocol header)
  DATA CLASS: CREDENTIAL
  APPROVED CONSUMERS: server-side only (verify identity; must not forward)

  1. Source:
     server.ts:2126 — extractWebDebugTokenFromProtocolHeader(req.headers)
     Entry: Sec-WebSocket-Protocol header on WebSocket upgrade request
     Validation: extractVerifiedUserTokenClaims(token) — full JWT verify via shared-auth

  2. Writes:
     - NOT persisted anywhere — token is used only for claim extraction then discarded
     - authCtx = { tenantId, userId, role } — only claims stored, not raw token

  3. Serialization Boundaries:
     - Token NOT forwarded in any WS message
     - authCtx NOT serialized or logged

  4. Read Paths:
     - server.ts:2131 — extractVerifiedUserTokenClaims(token) → claims (one-time use)
     - No other read path

  5. Policy Boundary:
     Token reaches: JWT verify function only — CLEAN ✓
     Claims passed to: wfBridge.handleMessage(ws, authCtx, ...) — no raw token, no credential leak ✓

  6. Consumers / Sinks:
     None — token consumed locally, claims propagated

  7. Dependency Wiring:
     DEPENDENCY: extractWebDebugTokenFromProtocolHeader (@agent-platform/shared/websocket-auth)
       Used at: server.ts:2126 — WIRED ✓ (same helper used by existing WS debug handler.ts:1363)
     DEPENDENCY: extractVerifiedUserTokenClaims (middleware/auth.ts:252)
       Used at: server.ts:2131 — WIRED ✓

  8. Parallel Paths:
     Existing debug WS (handler.ts:1363): same auth helpers used — PARITY ✓

  9. Boundary Tests:
     EXISTING: wf-bridge.test.ts covers access_check_failed, forbidden paths
     MISSING: No integration test that issues a WS upgrade with an invalid JWT and asserts ws.close(4001)
```

---

## Findings Summary

| ID  | Severity | Dimension        | Finding                                                                                            |
| --- | -------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| F-1 | MEDIUM   | Policy Boundary  | Raw connector API outputs (PII/partial credentials in response bodies) reach Studio WS unfiltered  |
| F-2 | LOW      | Policy Boundary  | `sanitizeStepOutput` is an exported no-op; future callers may assume it provides a safety gate     |
| F-3 | MEDIUM   | Regression Tests | No boundary test verifies connector output fields are absent from workflow_step_status WS messages |
| F-4 | LOW      | Regression Tests | No integration test for WS upgrade with invalid JWT asserting 4001 close                           |

**No CRITICAL findings** — the credential-specific fields (`encryptedAccessToken`, `accessToken`, `callbackSecret`) are correctly redacted on both the real-time and snapshot paths. The medium findings relate to the broader category of connector response body PII, which is a new risk surface introduced by removing `sanitizeConnectorOutput`.

---

## Round 2: Fix Verification

_Pending Phase B authorization from user._

| Finding | Fix Required                                                                                         | Boundary Test Required                                                |
| ------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| F-1     | Document policy decision: either add PII field allowlist to PUBLISH_SENSITIVE_STEP_FIELDS, or accept | Test: seed execution with known PII field in connector output; assert |
|         | connector outputs reaching Studio as intended for debug visibility                                   | field is absent OR present-with-permission from WS step message       |
| F-2     | Remove export of `sanitizeStepOutput` or replace no-op with a documented pass-through assertion      | N/A (no callers)                                                      |
| F-3     | Add unit test: wf-bridge receives step.completed event with output containing 'email' field;         | See F-1 boundary test                                                 |
|         | assert WS message includes/excludes per policy decision                                              |                                                                       |
| F-4     | Add integration test: WS upgrade with expired/invalid JWT → assert close code 4001                   | Server-level WS auth integration test                                 |

---

## Final Verdict

- [x] No CRITICAL findings open
- [ ] F-1 policy decision pending (accept or add gate)
- [ ] Boundary tests for F-3, F-4 not yet added
- [x] Parallel paths verified — WfBridge is in runtime only; workflow-engine copy removed
- [x] Credential fields (encryptedAccessToken, accessToken, callbackSecret) correctly redacted on all paths
