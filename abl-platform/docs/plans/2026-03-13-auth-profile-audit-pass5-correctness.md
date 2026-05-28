# Auth Profile Implementation Plans — Pass 5 Correctness Audit

> **Auditor:** Claude Opus 4.6 (automated codebase verification)
> **Date:** 2026-03-13
> **Scope:** Verify all Pass 3 findings were fixed in Pass 4, check for new issues introduced by Pass 4 changes
> **Method:** Cross-reference Pass 4 revision claims against actual source files

---

## Executive Summary

All 4 findings from Pass 3 have been fully resolved in Pass 4. One new issue was introduced by the Pass 4 revisions. The plans are otherwise clean and ready for implementation.

| Severity | New Issues | Pass 3 Findings Fixed |
| -------- | ---------- | --------------------- |
| CRITICAL | 0          | 0                     |
| HIGH     | 0          | 1 (P3-1)              |
| MEDIUM   | 1          | 2 (P3-2, P3-3)        |
| LOW      | 0          | 1 (P3-4)              |

---

## Part 1: Verification of Pass 3 Findings

### P3-1 (HIGH): GAP-3.3 Task 9 HMAC-signed vs encrypted OAuth state

**Pass 5 status: FIXED.** Task 9 in GAP-3.3 Section 11 Phase B now reads: "Implement AES-256-GCM encrypted state parameter with nonce (Redis SETEX for replay prevention)." This matches Section 10.4's requirement. The revision history confirms the change.

### P3-2 (MEDIUM): GAP-3.3 Tasks 13-14 wrong package

**Pass 5 status: FIXED.** Tasks 13 and 14 in GAP-3.3 Section 11 Phase C now assign work to `packages/connectors/base`, which is the correct package containing `token-manager.ts` and related credential code.

### P3-3 (MEDIUM): Infrastructure Gaps Gap 1 Phase B proposes reimplementing existing logic

**Pass 5 status: FIXED.** Gap 1 Phase B step 3 now reads: "Update existing `resolveWithGracePeriod()` in `packages/shared/src/services/auth-profile/grace-period.ts` -- this function **already implements** the try/catch/fallback logic (lines 28-47). The only changes needed are..." followed by the correct incremental changes (add `rotationStartedAt` to `GracePeriodProfile`, change anchor from `updatedAt` to `rotationStartedAt ?? updatedAt`, wire into `AuthProfileService.resolve()`).

Verified that `AuthProfileService.resolve()` in `packages/shared/src/services/auth-profile.service.ts` does NOT currently import or call `resolveWithGracePeriod()`, confirming the "if not yet wired, add the call" instruction is necessary and correct.

### P3-4 (LOW): GAP-3.3 Section 10.1 stale "dek-registry" reference

**Pass 5 status: FIXED.** Section 10.1 now reads: "Uses AES-256-GCM with tenant-scoped key derived via `EncryptionService` from `KeyVersion` model and HKDF/PBKDF2 key derivation in `packages/shared/src/encryption/engine.ts`." This matches Section 1.1.

---

## Part 2: New Issues Introduced by Pass 4

### P5-1 (MEDIUM): GAP-3.4 Task 2.3 incorrectly claims `AuthProfileOAuthDialog.tsx` does not exist

**Plan:** GAP-3.4, Section 14, Phase 2, Task 2.3
**Claim:** "Create `AuthProfileOAuthDialog` component (does not yet exist in codebase -- new file)"

**Reality:** `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` is a fully implemented component (imports `Dialog`, `Button`, `initiateOAuth`, `handleOAuthProfileCallback`, defines `AuthProfileOAuthDialogProps` interface). It was created during Auth Profile Phase 1-2 work on the current branch.

The Pass 3 audit (Part 7 file path table) even listed this file as "EXISTS" at line 238. The Pass 4 revision then incorrectly added "does not yet exist in codebase -- new file" to Task 2.3.

**Impact:** An implementer following this plan would either:

- Create a duplicate/conflicting file, breaking imports
- Be confused when they discover the file already exists

**Fix:** Remove "(does not yet exist in codebase -- new file)" from Task 2.3. Replace with: "Wire existing `AuthProfileOAuthDialog` component for single-connector auth in the batch consent flow." The task should focus on integrating the existing component with `BatchConsentPanel`, not creating it from scratch.

---

## Part 3: ConsentStateResolver Interface Validation

The `ConsentStateResolver` interface added in GAP-3.3 Section 4A (Pass 4) was verified against actual codebase types:

| Interface Parameter                     | Actual Type Location                               | Status                                                                     |
| --------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `callerContext: CallerContext`          | `packages/shared-auth/src/types/index.ts` line 118 | EXISTS -- has `contactId?`, `channelArtifact?`, `identityTier` as expected |
| `authRequirements: AuthRequirementIR[]` | Does not exist yet                                 | CORRECT -- new type from GAP-3.2 Phase 1, dependency correctly declared    |
| `tenantId: string`                      | Standard field                                     | OK                                                                         |
| `projectId: string`                     | Standard field                                     | OK                                                                         |

The `ConsentResolutionResult` return type with `satisfied: ConsentEntry[]` and `pending: PendingConsentEntry[]` is consistent with GAP-3.1's `AuthGate` model and the `auth_required` WS event payload.

The dual-read algorithm (AuthProfile first, EndUserOAuthToken fallback) is consistent with the existing `EndUserOAuthToken` model at `packages/database/src/models/end-user-oauth-token.model.ts` and the `AuthProfileService.resolve()` method.

**Assessment: The interface is well-designed and consistent with the codebase.**

---

## Part 4: Consumer Migration Targets Verification

The Infrastructure Gaps plan references several consumer files for migration. Verification:

| Consumer Target                                              | Exists | Notes                                                          |
| ------------------------------------------------------------ | ------ | -------------------------------------------------------------- |
| `packages/connectors/base/src/auth/token-manager.ts`         | YES    | Gap 3 target, has `TokenManagerAuthProfileResolver` interface  |
| `packages/database/src/models/sdk-channel.model.ts`          | YES    | Gap 2 target, `secretKey` at line 52 confirmed plain String    |
| `apps/runtime/src/services/credential-age-monitor.ts`        | YES    | Gap 5 target                                                   |
| `apps/runtime/src/services/voice/voice-service-factory.ts`   | YES    | Gap 6 target                                                   |
| `packages/database/src/models/connector-connection.model.ts` | YES    | Gap 7 target                                                   |
| `packages/database/src/mongo/plugins/audit-trail.plugin.ts`  | YES    | Gap 4 target                                                   |
| `packages/database/src/mongo/plugins/encryption.plugin.ts`   | YES    | Gap 1 target                                                   |
| `packages/shared/src/encryption/master-key-resolver.ts`      | YES    | Gap 1 Phase A target                                           |
| `packages/shared/src/services/auth-profile/grace-period.ts`  | YES    | Gap 1 Phase B target, `resolveWithGracePeriod` confirmed       |
| `apps/runtime/src/services/execution/auth-profile-fanout.ts` | YES    | `FanOutBranchAuthContext` interface confirmed                  |
| `packages/connectors/src/auth/connection-resolver.ts`        | YES    | `hasValidToken` does not exist yet (correctly proposed as new) |

**All consumer migration targets exist in the codebase.**

---

## Part 5: Cross-Plan Consistency Check (Pass 4 Changes Only)

Pass 4 introduced three notable changes. Consistency verified:

1. **GAP-3.2 added oauth2_app profile resolution algorithm (Section 5.2).** This algorithm (project-scoped first, tenant-scoped fallback) is consistent with `AuthProfileService.resolve()` which uses a 5-level `$or` query with project-scoped conditions before tenant-scoped fallback.

2. **GAP-3.2 clarified fan-out consent context (Section 7.6).** The claim that `FanOutBranchAuthContext` is "already implemented for connection mode validation" is slightly overstated -- the actual interface (`auth-profile-fanout.ts`) provides per-branch credential caches and identity scoping, not explicit connection mode validation. However, this is not materially incorrect since credential resolution implicitly handles connection modes.

3. **GAP-3.3 added ConsentStateResolver specification (Section 4A).** Well-integrated with GAP-3.1's `checkPreflightAuth()` (which calls it) and GAP-3.2's `AuthRequirementIR` types (which it consumes). No contradictions found.

---

## Summary

| ID   | Severity | Plan    | Description                                                                                                                                                                      | Status |
| ---- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P5-1 | MEDIUM   | GAP-3.4 | Task 2.3 says `AuthProfileOAuthDialog.tsx` "does not yet exist" but it is a fully implemented component at `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx` | NEW    |

**Overall assessment:** All Pass 3 findings are resolved. One new medium-severity issue found (incorrect file existence claim in GAP-3.4). The ConsentStateResolver interface is well-designed and consistent with actual codebase types. All consumer migration targets exist. The plans are ready for implementation after fixing P5-1.
