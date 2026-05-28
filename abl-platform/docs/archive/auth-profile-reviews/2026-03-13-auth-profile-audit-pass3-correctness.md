# Auth Profile Implementation Plans — Pass 3 Correctness Audit

> **Auditor:** Claude Opus 4.6 (automated codebase verification)
> **Date:** 2026-03-13
> **Scope:** Re-audit of 6 revised auth profile plans after Pass 2 revisions
> **Method:** Verify Pass 1 findings were fixed, check cross-plan consistency, find new issues introduced by revisions

---

## Executive Summary

The Pass 2 revisions addressed the majority of the 131 findings from 3 auditors. The unified consent state model is now consistent across all 4 GAP plans. Cross-plan dependencies are explicitly stated in every plan. Most file path issues from Pass 1 are resolved.

**However, 3 new issues were introduced by the revisions, and 2 prior findings were only partially fixed.**

| Severity | New Issues | Partially Fixed | Fully Fixed |
| -------- | ---------- | --------------- | ----------- |
| CRITICAL | 0          | 0               | 1           |
| HIGH     | 1          | 0               | 1           |
| MEDIUM   | 2          | 2               | 5           |
| LOW      | 0          | 0               | 57          |

---

## Part 1: Verification of Previous Critical and High Findings

### C-47 (CRITICAL): Audit trail `findOneAndUpdate` hook leaks ciphertext

**Previous finding:** The `findOneAndUpdate` post hook passes `this.getUpdate()` raw to `writeAuditEntry`, and encrypted fields are NOT masked.

**Pass 3 status: FIXED.** The Infrastructure Gaps plan (Gap 4) explicitly addresses this in its "Target State" section and provides a concrete implementation strategy (Step 1 in Migration Strategy). The plan correctly identifies that `getModifiedFields` masking is only called for `save()`, not `findOneAndUpdate`, and proposes filtering the `changes` object before calling `writeAuditEntry`. The fix is well-specified.

### C-15 (HIGH): `RuntimeSession` location uncertainty

**Previous finding:** Plan (GAP-3.2 Section 4.1) said to add consent fields to `RuntimeSession` in `apps/runtime/src/services/execution/types.ts` but the correct location might be `SessionData` in `session/types.ts`.

**Pass 3 status: FIXED.** All 4 GAP plans now consistently place consent state fields (`authGate`, `blocked`, `pendingInlineConsent`) on `SessionData` in `apps/runtime/src/services/session/types.ts`. GAP-3.2 Section 3.1 explicitly states: "Previous versions of this plan proposed separate `_consentState`, `_blocked`, and `_pendingInlineConsent` fields on `RuntimeSession` in `apps/runtime/src/services/execution/types.ts`. This has been unified -- all state lives on `SessionData` for serialization consistency." Verified that `RuntimeSession` is defined in `execution/types.ts` (line 101) and `SessionData` is defined in `session/types.ts` (line 20). The unified approach on `SessionData` is correct since it survives pod restarts via Redis serialization.

---

## Part 2: Verification of Previous Medium Findings

### C-14: `connector-tool-executor.ts` path clarification

**Pass 3 status: FIXED.** GAP-3.2 now consistently references `packages/connectors/src/executor/connector-tool-executor.ts` with full path in the integration table (Section 3.5) and task breakdown (Phase 3, Task 3.3).

### C-18: `tool-oauth-service.ts` reference

**Pass 3 status: NOT EXPLICITLY FIXED, but no longer an issue.** The revised plans no longer reference `tool-oauth-service.ts` for adding a `checkTokenExists` method. The consent token checking has been moved to `ConsentStateResolver` (GAP-3.3) and `ConnectionResolver.hasValidToken` (GAP-3.2 Section 3.5). The file `apps/runtime/src/services/tool-oauth-service.ts` does exist in the codebase, but the revised plans avoid depending on it for consent operations.

### C-54: `master-key-resolver.ts` does not resolve previous keys

**Pass 3 status: FIXED.** Infrastructure Gaps plan (Gap 1, Phase A, step 2) explicitly addresses: "Wire `resolveMasterKey()` to also resolve `ENCRYPTION_PREVIOUS_MASTER_KEYS` (comma-separated hex pairs of `version:hex`)." The implementation order table lists this as Sprint 1, 1 day effort, P0 priority.

### C-61: `@node-saml/node-saml` in Studio

**Pass 3 status: FIXED.** Verified that `@node-saml/node-saml` is indeed in `apps/studio/package.json` (line 39: `"@node-saml/node-saml": "^5.1.0"`). The Deferred Types plan (Section 1.3) has been updated to say "verify `apps/studio/package.json` for existing dependency -- if not present, add to `packages/auth-enterprise/package.json`" which is a safer phrasing. The dependency exists.

### C-63: `AuthProfileService.resolve()` method signature unverified

**Pass 3 status: PARTIALLY FIXED.** The Infrastructure Gaps plan (Gap 1 Phase B, step 3) now describes the `resolve()` behavior in detail: "In `AuthProfileService.resolve()`, wrap decryption in try/catch" with specific fallback logic. However, the actual `resolveWithGracePeriod` function has been discovered in `packages/shared/src/services/auth-profile/grace-period.ts`. Both GAP-3.1 and the Infrastructure Gaps plan mention this file in their "Existing Schema Acknowledgment" sections, which is good. But the Infrastructure Gaps plan's Gap 1 Phase B still proposes implementing grace period fallback in `AuthProfileService.resolve()` without acknowledging that `resolveWithGracePeriod()` **already implements the exact proposed logic** (decrypt primary, catch, check grace period window, decrypt previous). See finding P3-3 below for the new issue this creates.

### C-64: No plan verifies the existing `grace-period.ts` module

**Pass 3 status: PARTIALLY FIXED.** All relevant plans now include `resolveWithGracePeriod` in their "Existing Schema Acknowledgment" sections with the note "verify if grace period logic is already partially implemented before implementing Gap 1 Phase B." This is a good safety net. However, the `resolveWithGracePeriod` function is not just "partially" implemented -- it is **fully implemented** with the exact try/catch/fallback logic described in Gap 1 Phase B. The plans should acknowledge this more directly. See finding P3-3.

### C-65: `packages/connectors-base/` vs `packages/connectors/base/` path inconsistency

**Pass 3 status: FIXED.** All revised plans consistently use `packages/connectors/base/src/` for connectors-base code. The Infrastructure Gaps plan (Gap 3) correctly references `packages/connectors/base/src/auth/token-manager.ts`.

---

## Part 3: Unified Consent State Model Cross-Plan Consistency

The unified consent state model is now consistent across all 4 GAP plans. Verification:

| Aspect                  | GAP-3.1                 | GAP-3.2                   | GAP-3.3                  | GAP-3.4        |
| ----------------------- | ----------------------- | ------------------------- | ------------------------ | -------------- |
| `AuthGate` defined in   | Section 3.1 (canonical) | "see GAP-3.1 Section 3.1" | N/A (references GAP-3.1) | "uses GAP-3.1" |
| Location: `SessionData` | Section 3.2             | Section 3.1               | N/A                      | N/A            |
| WS events               | Section 5.1 (canonical) | "see GAP-3.1 Section 5.1" | N/A                      | "from GAP-3.1" |
| Satisfaction endpoint   | Section 9.2 (canonical) | Section 3.3               | N/A                      | Section 1.1    |
| Inline consent approach | Tool error result       | Section 3.4 (canonical)   | N/A                      | N/A            |

**Finding: CONSISTENT.** All 4 plans reference the same canonical definitions in GAP-3.1 for the `AuthGate` type and WS events, and in GAP-3.2 for the inline consent tool error result pattern. No contradictions found.

**WS event names are unified:**

- `auth_required`, `auth_gate_updated`, `auth_gate_satisfied`, `auth_gate_timeout` (server)
- `inline_consent_required`, `inline_consent_satisfied` (server, GAP-3.2)
- `auth_consent_denied` (client)

All plans reference the same event names without deviation.

---

## Part 4: Cross-Plan Dependency Accuracy

All 6 plans now have explicit "Dependencies" sections. Verification of the dependency graph:

```
GAP-3.2 Phase 1 (Compiler IR) — Sprint N
  |
  +-> GAP-3.1 Runtime + GAP-3.2 Phase 2 — Sprint N+1
  |     |
  |     +-> GAP-3.4 (Batch Consent UI) — Sprint N+2
  |     |
  |     +-> GAP-3.3 + GAP-3.2 Phase 3 — Sprint N+3
  |
Infrastructure Gaps — Independent (parallel)
  |
  +-> GAP-3.1 (rotation affects token validation)
  +-> GAP-3.3 (decryption failure handling)

Deferred Types — Independent (after Phase 2 stable for 30 days)
```

**Findings:**

1. GAP-3.1 says it depends on GAP-3.2 Phase 1 -- CORRECT (needs `preflight_auth_requirements` from `CompilationOutput`).
2. GAP-3.1 says it depends on GAP-3.3 for `ConsentStateResolver` -- CORRECT (defers token lookup).
3. GAP-3.2 says GAP-3.1 depends on it -- CORRECT (bidirectional acknowledgment).
4. GAP-3.3 says it depends on GAP-3.2 Phase 1 and GAP-3.1 -- CORRECT.
5. GAP-3.4 says it depends on GAP-3.1 and GAP-3.2 Phase 1-2 -- CORRECT.
6. Infrastructure Gaps says it is independent of consent plans -- CORRECT (Gap 1 creates `rotationStartedAt` which consent plans reference but don't block on).
7. Deferred Types says it depends on Phase 2 stability -- CORRECT.

**Sprint sequencing is consistent across all plans:**

- GAP-3.1 Section 14: "Sprint N = GAP-3.2 Phase 1, Sprint N+1 = GAP-3.1 + GAP-3.2 Phase 2, Sprint N+2 = GAP-3.4, Sprint N+3 = GAP-3.3"
- GAP-3.2: "Phase 1 Sprint N, Phase 2 Sprint N+1, Phase 3 Sprint N+3"
- GAP-3.3: "Sprint N+3"
- GAP-3.4: "Sprint N+2"

**All consistent.**

---

## Part 5: New Issues Introduced by Revisions

### P3-1 (HIGH): GAP-3.3 Task 9 contradicts Section 10.4 — HMAC-signed vs encrypted OAuth state

**Plan:** GAP-3.3, Section 11, Phase B, Task 9
**Issue:** Task 9 says "Implement HMAC-signed state parameter with nonce (Redis SET NX for replay prevention)" but Section 10.4 of the same plan explicitly says the OAuth state must be "**Encrypted** with AES-256-GCM using the platform encryption key (NOT just HMAC-signed -- the state contains `sessionId` which must remain confidential)."

This is a direct contradiction within the same plan. The Security section (10.4) was clearly updated during Pass 2 to require encryption, but the task breakdown (Task 9) was not updated to match.

GAP-3.1 Section 10.2 also says "The state is **encrypted** (AES-256-GCM) with the platform encryption key, not just HMAC-signed."

**Fix:** Update GAP-3.3 Task 9 description from "Implement HMAC-signed state parameter" to "Implement encrypted (AES-256-GCM) state parameter with nonce (Redis SETEX for replay prevention)." Also change "Redis SET NX" to "Redis SETEX" per Section 10.4's explicit requirement to use `SETEX` to prevent memory leaks.

### P3-2 (MEDIUM): GAP-3.3 references non-existent `packages/execution` package for tool-level code

**Plan:** GAP-3.3, Section 11, Phase C, Tasks 13-14
**Issue:** Tasks 13 and 14 assign on-demand refresh and revocation detection to package `packages/execution`. While `packages/execution` does exist in the codebase, it contains only execution-queue, suspension-store, fan-out-barrier, and related infrastructure utilities. It does NOT contain tool execution logic, connector integration, or credential resolution.

Tool execution and credential resolution live in:

- `packages/connectors/src/executor/connector-tool-executor.ts` (connector tool execution)
- `packages/connectors/base/src/auth/token-manager.ts` (token refresh)
- `apps/runtime/src/services/execution/reasoning-executor.ts` (reasoning loop)

**Fix:** Change Task 13 and 14 package to `packages/connectors/base` or `apps/runtime` depending on the exact implementation location. `packages/execution` is the wrong package for this code.

### P3-3 (MEDIUM): Infrastructure Gaps plan proposes implementing logic that already exists in `grace-period.ts`

**Plan:** Infrastructure Gaps, Gap 1 Phase B
**Issue:** Gap 1 Phase B step 3 proposes: "In `AuthProfileService.resolve()`, wrap decryption in try/catch: If decryption of `encryptedSecrets` fails AND `rotationStartedAt` is set AND within grace period, try `previousEncryptedSecrets`."

However, `resolveWithGracePeriod()` in `packages/shared/src/services/auth-profile/grace-period.ts` **already implements this exact logic** (lines 28-47):

```typescript
export async function resolveWithGracePeriod(
  profile: GracePeriodProfile,
  decrypt: (cipher: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  try {
    const decrypted = await decrypt(profile.encryptedSecrets);
    return JSON.parse(decrypted) as Record<string, unknown>;
  } catch (primaryErr) {
    if (
      profile.previousEncryptedSecrets &&
      profile.rotationGracePeriodMs &&
      Date.now() - profile.updatedAt.getTime() < profile.rotationGracePeriodMs
    ) {
      const decrypted = await decrypt(profile.previousEncryptedSecrets);
      return JSON.parse(decrypted) as Record<string, unknown>;
    }
    throw primaryErr;
  }
}
```

The only change needed is switching from `profile.updatedAt` to `profile.rotationStartedAt` (the bug both plans correctly identify). The plan should not propose "implementing" grace period fallback -- it should propose **modifying** the existing `resolveWithGracePeriod()` function to:

1. Accept `rotationStartedAt` on the `GracePeriodProfile` interface (currently only has `updatedAt`)
2. Use `rotationStartedAt ?? updatedAt` as the anchor timestamp
3. Verify that `AuthProfileService.resolve()` actually calls `resolveWithGracePeriod()` (it may not yet be wired)

The plans acknowledge the file exists in their "Existing Schema Acknowledgment" sections with "verify if grace period logic is already partially implemented," but this undersells the reality. The implementation is complete except for the `rotationStartedAt` field change.

**Fix:** Reframe Gap 1 Phase B step 3 as: "Update existing `resolveWithGracePeriod()` in `packages/shared/src/services/auth-profile/grace-period.ts` to use `rotationStartedAt` instead of `updatedAt`. Verify `AuthProfileService.resolve()` calls this function; if not, wire it in."

---

## Part 6: GAP-3.3 `dek-registry` Reference

### Previous finding C-24: `dek-registry` reference is vague

**Pass 3 status: PARTIALLY FIXED.** GAP-3.3 Section 1.1 was updated in the revision to say: "AES-256-GCM with tenant-scoped key derived via `EncryptionService` from `KeyVersion` model and HKDF/PBKDF2 key derivation in `packages/shared/src/encryption/engine.ts`." This is correct and addresses the finding.

However, Section 10.1 still says: "Uses AES-256-GCM with tenant-scoped DEK from `dek-registry`" -- the old, vague phrasing was not updated in this section. This is a minor inconsistency within the same plan.

**Severity:** LOW (cosmetic inconsistency, not a correctness issue).

**Fix:** Update Section 10.1 to match Section 1.1's corrected language.

---

## Part 7: File Path Verification Summary

All file paths referenced across the 6 revised plans have been verified against the codebase:

| File Path                                                             | Plans Referencing           | Status                                                                                  |
| --------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/session/types.ts`                          | 3.1, 3.2                    | EXISTS (SessionData at line 20)                                                         |
| `apps/runtime/src/services/execution/types.ts`                        | None (removed)              | EXISTS (RuntimeSession at line 101) -- correctly no longer referenced for consent state |
| `apps/runtime/src/websocket/events.ts`                                | 3.1, 3.2                    | EXISTS                                                                                  |
| `apps/runtime/src/websocket/handler.ts`                               | 3.1                         | EXISTS                                                                                  |
| `apps/runtime/src/websocket/sdk-handler.ts`                           | 3.1                         | EXISTS                                                                                  |
| `apps/runtime/src/channels/session-resolver.ts`                       | 3.1                         | EXISTS                                                                                  |
| `apps/runtime/src/services/session/session-bootstrap.ts`              | 3.1                         | EXISTS                                                                                  |
| `apps/runtime/src/routes/chat.ts`                                     | 3.1                         | EXISTS                                                                                  |
| `apps/runtime/src/services/session-cleanup-job.ts`                    | 3.1                         | EXISTS                                                                                  |
| `apps/studio/src/components/chat/ChatPanel.tsx`                       | 3.1, 3.4                    | EXISTS                                                                                  |
| `apps/studio/src/store/session-store.ts`                              | 3.1, 3.4                    | EXISTS                                                                                  |
| `apps/studio/src/contexts/WebSocketContext.tsx`                       | 3.1                         | EXISTS                                                                                  |
| `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` | 3.4                         | EXISTS                                                                                  |
| `apps/studio/src/app/oauth/connection-callback/page.tsx`              | 3.1                         | EXISTS                                                                                  |
| `apps/studio/src/app/globals.css`                                     | 3.4                         | EXISTS                                                                                  |
| `packages/compiler/src/platform/ir/schema.ts`                         | 3.2                         | EXISTS                                                                                  |
| `packages/compiler/src/platform/ir/compiler.ts`                       | 3.2                         | EXISTS                                                                                  |
| `packages/connectors/src/auth/connection-resolver.ts`                 | 3.2                         | EXISTS                                                                                  |
| `packages/connectors/src/executor/connector-tool-executor.ts`         | 3.2                         | EXISTS                                                                                  |
| `packages/connectors/base/src/auth/token-manager.ts`                  | Infra                       | EXISTS                                                                                  |
| `packages/database/src/models/end-user-oauth-token.model.ts`          | 3.3                         | EXISTS                                                                                  |
| `packages/database/src/models/auth-profile.model.ts`                  | Infra, Deferred             | EXISTS                                                                                  |
| `packages/database/src/models/sdk-channel.model.ts`                   | Infra                       | EXISTS                                                                                  |
| `packages/database/src/models/connector-connection.model.ts`          | Infra                       | EXISTS                                                                                  |
| `packages/database/src/models/key-version.model.ts`                   | Infra                       | EXISTS                                                                                  |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`            | Infra                       | EXISTS                                                                                  |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts`           | Infra                       | EXISTS                                                                                  |
| `packages/shared/src/encryption/engine.ts`                            | Infra                       | EXISTS                                                                                  |
| `packages/shared/src/encryption/master-key-resolver.ts`               | Infra                       | EXISTS                                                                                  |
| `packages/shared/src/services/auth-profile.service.ts`                | Infra                       | EXISTS                                                                                  |
| `packages/shared/src/services/auth-profile/feature-flag.ts`           | Deferred                    | EXISTS                                                                                  |
| `packages/shared/src/services/auth-profile/grace-period.ts`           | Infra (acknowledgment)      | EXISTS                                                                                  |
| `packages/shared/src/validation/auth-profile.schema.ts`               | Deferred                    | EXISTS                                                                                  |
| `packages/shared-auth/src/types/index.ts`                             | 3.1, 3.3                    | EXISTS                                                                                  |
| `apps/runtime/src/services/execution/auth-profile-handoff.ts`         | 3.2                         | EXISTS                                                                                  |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts`          | 3.2                         | EXISTS                                                                                  |
| `apps/runtime/src/services/execution/auth-profile-delegate.ts`        | 3.2                         | EXISTS                                                                                  |
| `apps/runtime/src/services/voice/voice-service-factory.ts`            | Infra                       | EXISTS                                                                                  |
| `apps/runtime/src/services/credential-age-monitor.ts`                 | Infra                       | EXISTS                                                                                  |
| `apps/runtime/src/services/tool-oauth-service.ts`                     | None (no longer referenced) | EXISTS                                                                                  |

**All referenced paths are valid.**

---

## Part 8: Additional Observations (Informational, not Findings)

### O-1: `SessionData` currently has no `authGate`, `blocked`, or `pendingInlineConsent` fields

Verified. `SessionData` (lines 20-96 of `apps/runtime/src/services/session/types.ts`) ends at `piiRedactionConfig`. The consent fields proposed by the plans are genuine additions. This is consistent with the plans' claims.

### O-2: `resolveWithGracePeriod` uses `updatedAt` (confirmed bug)

The existing `resolveWithGracePeriod` function at line 40 uses `Date.now() - profile.updatedAt.getTime() < profile.rotationGracePeriodMs`. The Infrastructure Gaps plan correctly identifies this as problematic because `timestamps: true` on the AuthProfile schema updates `updatedAt` on every save. The `GracePeriodProfile` interface (line 9) has `updatedAt: Date` but no `rotationStartedAt`. This confirms the plan's proposed fix is addressing a real bug.

### O-3: `@node-saml/node-saml` exists in Studio (confirmed)

`apps/studio/package.json` line 39: `"@node-saml/node-saml": "^5.1.0"`. The Deferred Types plan's claim is correct. Pass 1 finding C-61 is resolved.

---

## Summary of All Pass 3 Findings

| ID   | Severity | Plan       | Description                                                                                                                                              | Status                         |
| ---- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| P3-1 | HIGH     | GAP-3.3    | Task 9 says "HMAC-signed" but Section 10.4 says "encrypted (AES-256-GCM)". Also Task 9 says "SET NX" but Section 10.4 says "SETEX"                       | NEW -- internal contradiction  |
| P3-2 | MEDIUM   | GAP-3.3    | Tasks 13-14 assign work to `packages/execution` but tool execution/credential code is in `packages/connectors` or `apps/runtime`                         | NEW -- wrong package           |
| P3-3 | MEDIUM   | Infra Gaps | Gap 1 Phase B proposes implementing grace period fallback, but `resolveWithGracePeriod()` already implements it. Only `rotationStartedAt` swap is needed | NEW -- redundant work proposal |
| P3-4 | LOW      | GAP-3.3    | Section 10.1 still references "dek-registry" while Section 1.1 was correctly updated                                                                     | Residual from C-24             |

**Overall assessment:** The Pass 2 revisions successfully addressed the vast majority of findings. The unified consent state model is now consistent across all 4 GAP plans. Cross-plan dependencies are accurate and internally consistent. The 3 new issues are localized and straightforward to fix. The plans are ready for implementation after these 3 corrections.
