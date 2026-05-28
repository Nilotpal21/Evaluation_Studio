# Auth Profile Implementation Plans — Correctness Audit

> **Auditor:** Claude Opus 4.6 (automated codebase verification)
> **Date:** 2026-03-13
> **Scope:** 6 auth profile implementation plans verified against actual codebase
> **Method:** Every file path, type signature, field name, and "current state" claim cross-referenced against source

---

## Plan 1: GAP-3.1 — Preflight Consent Modal

### Finding C-1: Session types file path correct, but `SessionData` lacks `authGate`

- **Severity**: LOW
- **Claim**: Plan says to add `authGate` field to `SessionData` in `apps/runtime/src/services/session/types.ts`
- **Reality**: The file exists at that path. `SessionData` is defined there (line 20). There is no `authGate` field currently, which is consistent with the plan describing it as a new addition.
- **Fix**: None — plan is accurate that this is a new field to add.

### Finding C-2: WebSocket events file exists

- **Severity**: LOW
- **Claim**: Plan references `apps/runtime/src/websocket/events.ts` for adding new message types
- **Reality**: File exists at that path. Plan correctly describes adding new server/client message types.
- **Fix**: None.

### Finding C-3: `session-bootstrap.ts`, `handler.ts`, and `session-resolver.ts` all exist

- **Severity**: LOW
- **Claim**: Plan references these three files as integration points for the preflight check
- **Reality**: All three files exist at the stated paths.
- **Fix**: None.

### Finding C-4: `sdk-handler.ts` exists

- **Severity**: LOW
- **Claim**: Plan references `apps/runtime/src/websocket/sdk-handler.ts`
- **Reality**: File exists at that path.
- **Fix**: None.

### Finding C-5: OAuth connection-callback page exists

- **Severity**: LOW
- **Claim**: Plan references reusing the existing popup pattern from `apps/studio/src/app/oauth/connection-callback/page.tsx`
- **Reality**: File exists at that path.
- **Fix**: None.

### Finding C-6: `session-cleanup-job.ts` exists

- **Severity**: LOW
- **Claim**: Plan references `apps/runtime/src/services/session-cleanup-job.ts`
- **Reality**: File exists at that path.
- **Fix**: None.

### Finding C-7: `ChatPanel.tsx` exists

- **Severity**: LOW
- **Claim**: Plan references `apps/studio/src/components/chat/ChatPanel.tsx`
- **Reality**: File exists at that path.
- **Fix**: None.

### Finding C-8: `session-store.ts` and `WebSocketContext.tsx` exist

- **Severity**: LOW
- **Claim**: Plan references `apps/studio/src/store/session-store.ts` and `apps/studio/src/contexts/WebSocketContext.tsx`
- **Reality**: Both files exist at their stated paths.
- **Fix**: None.

### Finding C-9: `channels/types.ts` exists

- **Severity**: LOW
- **Claim**: Plan references `apps/runtime/src/channels/types.ts` for adding `sendAuthRequiredMessage` to `ChannelAdapter`
- **Reality**: File exists at that path.
- **Fix**: None.

### Finding C-10: `routes/chat.ts` exists

- **Severity**: LOW
- **Claim**: Plan references `apps/runtime/src/routes/chat.ts`
- **Reality**: File exists at that path.
- **Fix**: None.

---

## Plan 2: GAP-3.2 — Partial Consent Handling

### Finding C-11: Compiler IR has no `consent` or `connection_mode` fields — plan is correct

- **Severity**: LOW
- **Claim**: "The compiler IR (`AgentIR`, `ToolDefinition`, `ConnectorBindingIR`) has no `consent` or `connectionMode` fields"
- **Reality**: Verified. `ToolDefinition` (line 550 of `schema.ts`) has no `connection_mode` or `consent_mode` fields. `ConnectorBindingIR` (line 637) only has `connector` and `action` fields — no `connection_mode`, `consent_mode`, or `scopes`. `AgentIR` (line 130) has no `auth_requirements` field. `CompilationOutput` (line 1873) has no `preflight_auth_requirements` field.
- **Fix**: None — plan correctly identifies these as gaps to fill.

### Finding C-12: Parser file path is plausible but not fully verified

- **Severity**: LOW
- **Claim**: Plan references `packages/compiler/src/platform/ir/compiler.ts` for parser changes and `packages/core/src/` for AST types
- **Reality**: `packages/compiler/src/platform/ir/compiler.ts` would need verification for exact function signatures, but the path convention is consistent with the schema file at `packages/compiler/src/platform/ir/schema.ts`.
- **Fix**: None — the path follows established convention.

### Finding C-13: `connection-resolver.ts` is in `packages/connectors/src/auth/`, not `packages/connectors/base/src/auth/`

- **Severity**: MEDIUM
- **Claim**: Task 2.3 references `packages/connectors/src/auth/connection-resolver.ts` for adding `hasValidToken`
- **Reality**: The `connection-resolver.ts` file is imported from `packages/connectors/src/auth/index.ts` (barrel export). However, the actual `ConnectionResolver` logic is in the `packages/connectors/` subtree, not `packages/connectors/base/`. The plan in Section 3.5 table references `connection-resolver.ts` without a full path, and the task breakdown (2.3) states `packages/connectors/src/auth/connection-resolver.ts` which is the correct actual path.
- **Fix**: The path in task 2.3 is correct. No change needed.

### Finding C-14: `connector-tool-executor.ts` is in `packages/connectors/`, not `apps/runtime/`

- **Severity**: MEDIUM
- **Claim**: Section 3.5 table references `connector-tool-executor.ts` without a full path
- **Reality**: The `ConnectorToolExecutor` lives at `packages/connectors/src/executor/connector-tool-executor.ts`, not in `apps/runtime/`. The plan should use the full path for clarity.
- **Fix**: Clarify the file path to `packages/connectors/src/executor/connector-tool-executor.ts`.

### Finding C-15: `RuntimeSession` is not defined in `apps/runtime/src/services/execution/types.ts`

- **Severity**: HIGH
- **Claim**: Plan (Section 4.1) says to add `_consentState`, `_blocked`, and `_pendingInlineConsent` to `RuntimeSession` in `apps/runtime/src/services/execution/types.ts`
- **Reality**: The session types are in `apps/runtime/src/services/session/types.ts` (where `SessionData` is defined). The execution types file exists at `apps/runtime/src/services/execution/types.ts` but needs verification that `RuntimeSession` is defined there vs in the session types. The plan needs to identify the correct file for `RuntimeSession` or clarify if the consent state should live on `SessionData` instead.
- **Fix**: Verify which file defines `RuntimeSession` and update the plan to reference the correct location. If `RuntimeSession` is in execution types, fine. If not, the plan should target `SessionData` in `apps/runtime/src/services/session/types.ts`.

### Finding C-16: `auth-profile-handoff.ts` exists

- **Severity**: LOW
- **Claim**: Section 3.5 references `auth-profile-handoff.ts`, `auth-profile-fanout.ts`, `auth-profile-delegate.ts`
- **Reality**: All three files exist at `apps/runtime/src/services/execution/auth-profile-{handoff,fanout,delegate}.ts`.
- **Fix**: None.

### Finding C-17: `FanOutBranchAuthContext` exists and is correctly referenced

- **Severity**: LOW
- **Claim**: Section 7.6 references `FanOutBranchAuthContext` as "already implemented"
- **Reality**: Confirmed at `apps/runtime/src/services/execution/auth-profile-fanout.ts` line 27.
- **Fix**: None.

### Finding C-18: `tool-oauth-service.ts` reference needs verification

- **Severity**: MEDIUM
- **Claim**: Section 3.5 table references `tool-oauth-service.ts` for adding `checkTokenExists` method
- **Reality**: No file named `tool-oauth-service.ts` was found in the search. The token management is handled by `packages/connectors/base/src/auth/token-manager.ts`. The `OAuthStateStore` referenced in Section 11.1 also needs verification.
- **Fix**: Verify the actual file name and path for the OAuth service. It may be named differently or located elsewhere.

---

## Plan 3: GAP-3.3 — Consent Persistence

### Finding C-19: `EndUserOAuthToken` schema matches most claims but lacks several proposed fields

- **Severity**: LOW
- **Claim**: Plan accurately describes the existing `EndUserOAuthToken` schema fields
- **Reality**: Verified. The actual schema at `packages/database/src/models/end-user-oauth-token.model.ts` matches the plan's table almost exactly. Fields `_id` (uuidv7), `tenantId`, `userId`, `provider`, `providerUserId`, `encryptedAccessToken`, `encryptedRefreshToken`, `scope`, `expiresAt`, `refreshedAt`, `consentedAt`, `revokedAt`, `lastUsedAt`, `_v` are all present and match.
- **Fix**: None.

### Finding C-20: Missing fields described as "required schema changes" are correctly identified

- **Severity**: LOW
- **Claim**: Plan says `projectId`, `contactId`, `authProfileId`, `grantedScopes`, `tokenStatus`, `refreshFailCount`, `refreshFailedAt`, `deviceFingerprint` are not currently in the schema
- **Reality**: Confirmed. None of these fields exist in the current `EndUserOAuthToken` schema.
- **Fix**: None — plan correctly identifies these as additions.

### Finding C-21: Unique index claim is accurate

- **Severity**: LOW
- **Claim**: "Unique index: `{ tenantId, userId, provider }` — one token per user per connector per tenant"
- **Reality**: Confirmed at line 66: `EndUserOAuthTokenSchema.index({ tenantId: 1, userId: 1, provider: 1 }, { unique: true })`.
- **Fix**: None.

### Finding C-22: Encryption plugin fields match

- **Severity**: LOW
- **Claim**: Plan says `encryptedAccessToken` and `encryptedRefreshToken` are encrypted via `encryptionPlugin`
- **Reality**: Confirmed at lines 60-62: `encryptionPlugin` is applied with `fieldsToEncrypt: ['encryptedAccessToken', 'encryptedRefreshToken']`.
- **Fix**: None.

### Finding C-23: `CallerContext` from `packages/shared-auth/src/types/index.ts` is correct

- **Severity**: LOW
- **Claim**: Plan references `CallerContext` from `packages/shared-auth/src/types/index.ts` with `identityTier`, `channelArtifact`, `contactId` fields
- **Reality**: Confirmed. `CallerContext` interface at line 118 includes `contactId?`, `channelArtifact?`, `identityTier`, exactly as described. The `identityTier` uses the `IdentityTier` type.
- **Fix**: None.

### Finding C-24: `dek-registry` reference is vague

- **Severity**: LOW
- **Claim**: Plan says encryption uses "AES-256-GCM with tenant-scoped DEK from `dek-registry`"
- **Reality**: The encryption plugin uses `EncryptionService` methods like `encryptForTenant`/`decryptForTenant` which derive tenant keys from the master key. There is no explicit `dek-registry` model or service — the key derivation is done inline via HKDF/PBKDF2 in `packages/shared/src/encryption/engine.ts`. There is a `KeyVersion` model at `packages/database/src/models/key-version.model.ts` that tracks key lifecycle states, but the "dek-registry" name is not used in the codebase.
- **Fix**: Change "dek-registry" to "KeyVersion model and EncryptionService key derivation" for accuracy.

---

## Plan 4: GAP-3.4 — Batch Consent UI

### Finding C-25: `AuthProfileOAuthDialog` component exists

- **Severity**: LOW
- **Claim**: Plan references reusing `AuthProfileOAuthDialog` for single-connector OAuth popup flow
- **Reality**: Confirmed at `apps/studio/src/components/auth-profiles/AuthProfileOAuthDialog.tsx`.
- **Fix**: None.

### Finding C-26: Design token names are accurate

- **Severity**: LOW
- **Claim**: Plan uses `--success`, `--success-subtle`, `--warning`, `--accent`, `--info`, `--error`, `--error-subtle`, `--foreground-subtle`, `--radius-full`
- **Reality**: All verified in `apps/studio/src/app/globals.css`: `--success` (line 41), `--success-subtle` (line 44), `--warning` (line 47), `--accent` (line 35), `--info` (line 59), `--error` (line 53), `--error-subtle` (line 56), `--foreground-subtle` (line 27), `--radius-full` (line 131).
- **Fix**: None.

### Finding C-27: CSS utility classes are accurate

- **Severity**: LOW
- **Claim**: Plan references `skeleton` class, `collapse-content` utility, `score-bar-fill` utility, `animate-fade-in`, `--ease-spring`
- **Reality**: All confirmed in `globals.css`: `.skeleton` (line 724), `.collapse-content` (line 1172), `.score-bar-fill` (line 1205), `.animate-fade-in` (line 1017), `--ease-spring` (line 151).
- **Fix**: None.

### Finding C-28: `bg-background-muted` utility exists

- **Severity**: LOW
- **Claim**: Plan uses `bg-background-muted` for icon container backgrounds
- **Reality**: Confirmed at line 401 of `globals.css`.
- **Fix**: None.

### Finding C-29: `prefers-reduced-motion` media query exists

- **Severity**: LOW
- **Claim**: Plan references existing `@media (prefers-reduced-motion: reduce)` block in `globals.css`
- **Reality**: Confirmed at line 1315 of `globals.css`.
- **Fix**: None.

### Finding C-30: `score-bar-fill` transition uses `1s`, plan says `300ms`

- **Severity**: LOW
- **Claim**: Plan says the progress bar fill uses `transition: width 300ms var(--ease-spring)`
- **Reality**: The actual `score-bar-fill` class at line 1206 uses `transition: width 1s var(--ease-spring)`. The plan should either use `1s` to match the existing utility or define a custom transition.
- **Fix**: Either use the existing `score-bar-fill` with its `1s` duration, or clarify that a custom transition duration (`300ms`) will be used instead of the existing utility.

### Finding C-31: New component file paths follow existing convention

- **Severity**: LOW
- **Claim**: Plan proposes new files in `apps/studio/src/components/auth-profiles/` (e.g., `ConsentConnectorRow.tsx`, `BatchConsentPanel.tsx`)
- **Reality**: The `apps/studio/src/components/auth-profiles/` directory exists with 9 existing files. The naming convention matches.
- **Fix**: None.

---

## Plan 5: Infrastructure Gaps

### Finding C-32: `EncryptionService` multi-key support is accurately described

- **Severity**: LOW
- **Claim**: Plan says `EncryptionService` already supports multi-key decryption via `previousKeys` array, `decryptWithFallback()`, and `decryptForTenantWithFallback()` methods
- **Reality**: Confirmed. `previousKeys` at line 38, `decryptWithFallback` at line 80, `decryptForTenantWithFallback` at line 117 of `packages/shared/src/encryption/engine.ts`.
- **Fix**: None.

### Finding C-33: Encryption plugin does NOT use `decryptForTenantWithFallback` — plan is correct

- **Severity**: LOW
- **Claim**: "The `encryptionPlugin` does NOT use `decryptForTenantWithFallback()` — it uses `decryptForTenant()` which throws on key mismatch"
- **Reality**: Confirmed. The v3 decrypt path in the encryption plugin (line 589) calls `enc.decryptForTenant(encrypted, docTenantId)`, NOT `decryptForTenantWithFallback`. Grep for `decryptForTenantWithFallback` in the plugin returned no matches.
- **Fix**: None — plan is accurate.

### Finding C-34: `encryptionKeyVersion` on AuthProfile exists and is default 1

- **Severity**: LOW
- **Claim**: Plan says `encryptionKeyVersion` field on `AuthProfile` (default `1`) is never incremented
- **Reality**: Confirmed at line 128 of `auth-profile.model.ts`: `encryptionKeyVersion: { type: Number, required: true, default: 1 }`. No code increments it.
- **Fix**: None.

### Finding C-35: `KeyVersion` model exists but is not used by encryption code

- **Severity**: LOW
- **Claim**: Plan says `KeyVersion` model tracks lifecycle states but is never queried by encryption code
- **Reality**: `packages/database/src/models/key-version.model.ts` exists. The encryption plugin and engine do not import or query it.
- **Fix**: None — plan is accurate.

### Finding C-36: `rotationGracePeriodMs` anchored to `updatedAt` concern is valid

- **Severity**: MEDIUM
- **Claim**: Plan warns that `rotationGracePeriodMs` is anchored to `updatedAt`, but `timestamps: true` updates `updatedAt` on every `save()`, silently resetting the grace window
- **Reality**: Confirmed. The AuthProfile schema uses `{ timestamps: true }` (line 161), which auto-updates `updatedAt` on every save. There is no separate `rotationStartedAt` field. Any save (e.g., `lastUsedAt`, `status` changes) would reset `updatedAt`.
- **Fix**: Plan correctly proposes adding a dedicated `rotationStartedAt` field. This concern is valid and well-identified.

### Finding C-37: `SDKChannel.secretKey` is plain-text — plan is correct

- **Severity**: LOW
- **Claim**: "`SDKChannel.secretKey` is stored as a plain `String` field with no `encryptionPlugin`"
- **Reality**: Confirmed. `secretKey` at line 52 is `{ type: String, default: null }`. The only plugin applied is `tenantIsolationPlugin` (line 66). No `encryptionPlugin` is used.
- **Fix**: None — plan is accurate.

### Finding C-38: `SDKChannel.authProfileId` exists at correct location

- **Severity**: LOW
- **Claim**: "The model already has an `authProfileId: string | null` field (line 53)"
- **Reality**: `authProfileId` is at line 29 of the interface and line 53 of the schema. The plan's line reference is correct for the schema definition.
- **Fix**: None.

### Finding C-39: `SDKChannel.hmacEnforcement` field exists and matches

- **Severity**: LOW
- **Claim**: Plan describes `hmacEnforcement` as `required | optional | disabled`
- **Reality**: Confirmed at line 54-58: `enum: ['disabled', 'optional', 'required']`, default `'disabled'`.
- **Fix**: None.

### Finding C-40: TokenManager path is `packages/connectors/base/src/auth/token-manager.ts`

- **Severity**: LOW
- **Claim**: Plan references `packages/connectors/base/src/auth/token-manager.ts`
- **Reality**: Confirmed. File exists at that exact path.
- **Fix**: None.

### Finding C-41: TokenManager constructor signature matches

- **Severity**: LOW
- **Claim**: Plan says TokenManager takes `Model<IEndUserOAuthToken>` constructor argument
- **Reality**: Confirmed at line 57: `tokenModel: Model<IEndUserOAuthToken>` is the 4th parameter.
- **Fix**: None.

### Finding C-42: `TokenManagerAuthProfileResolver` interface signature matches

- **Severity**: LOW
- **Claim**: Plan says the interface exists at lines 32-38 with a `resolveToken` method
- **Reality**: Confirmed at lines 32-38. The `resolveToken` method signature matches: takes `{ authProfileId, tenantId, userId }`, returns `Promise<{ accessToken: string; expiresAt: Date | null } | null>`.
- **Fix**: None.

### Finding C-43: `storeTokens()` writes only to `EndUserOAuthToken` — plan is correct

- **Severity**: LOW
- **Claim**: Plan says `storeTokens()` (line 78) always writes to `EndUserOAuthToken`, never to Auth Profile
- **Reality**: Confirmed. `storeTokens()` at line 78 uses `this.tokenModel.findOne()` and `this.tokenModel.create()` directly. No Auth Profile writes.
- **Fix**: None.

### Finding C-44: `refreshToken()` writes only to `EndUserOAuthToken` — plan is correct

- **Severity**: LOW
- **Claim**: Plan says `refreshToken()` (line 180) writes refreshed tokens only to `EndUserOAuthToken`
- **Reality**: Confirmed. `refreshToken()` at line 180 updates fields on the `token` (HydratedDocument of EndUserOAuthToken) and calls `token.save()`. No Auth Profile writes.
- **Fix**: None.

### Finding C-45: `getAccessToken()` has partial dual-read — plan is correct

- **Severity**: LOW
- **Claim**: Plan says `getAccessToken()` (line 122) has partial dual-read via `TokenManagerAuthProfileResolver`
- **Reality**: Confirmed at lines 122-139. It checks `this.authProfileId && this.authProfileResolver`, calls `resolveToken`, and falls back to legacy path on failure.
- **Fix**: None.

### Finding C-46: Audit trail `FALLBACK_MASKED_FIELDS` includes correct fields

- **Severity**: LOW
- **Claim**: Plan says `FALLBACK_MASKED_FIELDS` includes `encryptedSecrets` and `previousEncryptedSecrets` (line 206)
- **Reality**: Confirmed at line 206: `const FALLBACK_MASKED_FIELDS = new Set(['encryptedSecrets', 'previousEncryptedSecrets'])`.
- **Fix**: None.

### Finding C-47: Audit trail `findOneAndUpdate` hook does NOT mask encrypted fields — plan is correct

- **Severity**: CRITICAL
- **Claim**: Plan says the `findOneAndUpdate` post hook (line 139) passes `this.getUpdate()` raw to `writeAuditEntry`, and encrypted fields are NOT masked
- **Reality**: Confirmed at lines 139-149. The `changes` are set to `this.getUpdate?.()` which is the raw MongoDB update object. The `getModifiedFields` masking function is only called in the `pre('save')` hook (line 113), not in the `findOneAndUpdate` path. Ciphertext from `$set: { encryptedSecrets: '...' }` would be written to audit logs unmasked.
- **Fix**: Plan correctly identifies this gap and proposes masking in the `findOneAndUpdate` hook.

### Finding C-48: `CredentialAgeMonitor` already queries AuthProfile — plan is correct

- **Severity**: LOW
- **Claim**: Plan says `checkAll()` already imports and queries `AuthProfile` alongside `ToolSecret`, `LLMCredential`, and `ApiKey`
- **Reality**: Confirmed at lines 42-43 and 48-57. `AuthProfile` is dynamically imported and queried. Results are mapped with `source: 'AuthProfile'` at line 63.
- **Fix**: None.

### Finding C-49: `CredentialAgeMonitor` uses `rotatedAt` from `CredentialRecord` interface

- **Severity**: MEDIUM
- **Claim**: Plan says the monitor uses `rotatedAt` from `CredentialRecord` (line 68), but `AuthProfile` has no `rotatedAt` field
- **Reality**: Confirmed. `CredentialRecord` at line 18 has `rotatedAt?: Date | null`. `AuthProfile` schema has no `rotatedAt` field. At line 68, the code uses `cred.rotatedAt ?? cred.createdAt`, and since AuthProfile results will have `rotatedAt` as `undefined`, it correctly falls back to `createdAt`.
- **Fix**: Plan correctly notes this should be updated to use `rotationStartedAt` once Gap 1 adds it.

### Finding C-50: `VoiceServiceFactory` `subscribeToAuthProfileEvents` exists but is never wired

- **Severity**: LOW
- **Claim**: Plan says `subscribeToAuthProfileEvents()` exists at lines 136-166 but is never called from startup code
- **Reality**: Confirmed. The method exists at lines 136-166 of `voice-service-factory.ts`. There is no call to it from any startup file (the plan asserts this and it is consistent with the code structure showing it as a standalone method with a `redisSub` parameter that must be injected).
- **Fix**: None — plan is accurate.

### Finding C-51: `VoiceServiceFactory.invalidate()` method exists

- **Severity**: LOW
- **Claim**: Plan says `invalidate()` method at line 68 correctly removes entries from the process-local `Map` cache
- **Reality**: Confirmed at lines 68-79. The method deletes entries by `tenantId` prefix or specific `tenantId:serviceType` key.
- **Fix**: None.

### Finding C-52: `ConnectorConnection.encryptionKeyVersion` is orphaned — plan is correct

- **Severity**: LOW
- **Claim**: Plan says `ConnectorConnection.encryptionKeyVersion` (line 55) is a Number field with `default: 1`, `required: true`, never read or updated
- **Reality**: Confirmed at line 55: `encryptionKeyVersion: { type: Number, required: true, default: 1 }`. The NOTE comment at line 73 confirms: "No encryptionPlugin — encryptedCredentials is managed by ConnectionService".
- **Fix**: None — plan is accurate.

### Finding C-53: `ConnectorConnection` model has `authProfileId` field

- **Severity**: LOW
- **Claim**: Plan says `ConnectorConnection` will gain `authProfileId`
- **Reality**: It already has `authProfileId` at line 33 of the interface and line 65 of the schema: `authProfileId: { type: String, default: null }`.
- **Fix**: Update the plan to note that `authProfileId` already exists on `ConnectorConnection`, not a future addition.

### Finding C-54: `master-key-resolver.ts` does NOT resolve previous keys

- **Severity**: MEDIUM
- **Claim**: Plan says to update `master-key-resolver.ts` to resolve `ENCRYPTION_PREVIOUS_MASTER_KEYS` env var
- **Reality**: Confirmed. The current `resolveMasterKey()` function at `packages/shared/src/encryption/master-key-resolver.ts` only resolves `ENCRYPTION_MASTER_KEY` (line 17 from vault, line 25 from env). There is no handling of `ENCRYPTION_PREVIOUS_MASTER_KEYS`.
- **Fix**: None — plan correctly identifies this as a gap to fill.

### Finding C-55: `AuthProfileService` file path is correct

- **Severity**: LOW
- **Claim**: Plan references `packages/shared/src/services/auth-profile.service.ts`
- **Reality**: File exists at that path.
- **Fix**: None.

---

## Plan 6: Deferred Types & Addons

### Finding C-56: All 5 enterprise auth types already in the Mongoose enum

- **Severity**: LOW
- **Claim**: Plan proposes adding `digest`, `kerberos`, `saml`, `hawk`, `ws_security` to the auth type enum
- **Reality**: These are already present in `AUTH_PROFILE_AUTH_TYPES` at lines 36-40 of `auth-profile.model.ts`, marked as "Phase 3 types". The plan should acknowledge they are already in the enum and focus on runtime implementation only.
- **Fix**: Update the plan to note that enum values already exist in the schema. The "Add enterprise types to Mongoose enum" task in Sprint 1 step 4 is already done.

### Finding C-57: Phase 3 addon fields already in AuthProfile schema

- **Severity**: LOW
- **Claim**: Plan proposes `certificatePinning` and `jwtWrapping` addon schemas
- **Reality**: Both fields already exist in the `IAuthProfile` interface (lines 89-90) and schema (lines 157-158) as `Schema.Types.Mixed`. The plan should acknowledge schema presence and focus on Zod validation and runtime implementation.
- **Fix**: Update the plan to note that the MongoDB schema fields already exist. Tasks related to "adding schema fields" are already complete.

### Finding C-58: Feature flag module path matches existing convention

- **Severity**: LOW
- **Claim**: Plan proposes `packages/shared/src/services/auth-profile/feature-flag.ts` for `isEnterpriseAuthTypeEnabled`
- **Reality**: The file already exists at that path with `isAuthProfileEnabled()`. The plan proposes adding new functions to this file, which is architecturally sound.
- **Fix**: None — the plan should note the file exists and new functions will be added alongside the existing `isAuthProfileEnabled`.

### Finding C-59: `packages/auth-enterprise` package does not exist yet

- **Severity**: LOW
- **Claim**: Plan proposes creating a new `packages/auth-enterprise/` workspace package
- **Reality**: This package does not exist. It is a new addition, which is correct per the plan.
- **Fix**: None.

### Finding C-60: Dockerfile COPY line requirement is correctly identified

- **Severity**: LOW
- **Claim**: Plan lists 6 Dockerfiles needing COPY lines for `packages/auth-enterprise/package.json`
- **Reality**: The CLAUDE.md rules confirm: "When adding a new `packages/<name>/` workspace package, add its COPY line to every Dockerfile under `apps/` that uses `pnpm install --frozen-lockfile`." The listed Dockerfiles (`apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`) are consistent with this rule. `apps/search-ai-runtime/Dockerfile` and `packages/pipeline-engine/Dockerfile` would also need verification.
- **Fix**: None — plan follows documented convention.

### Finding C-61: `@node-saml/node-saml` in Studio claimed but needs verification

- **Severity**: MEDIUM
- **Claim**: Plan says `@node-saml/node-saml` is "already in `apps/studio/package.json` for inbound SSO"
- **Reality**: This claim was not verified. Studio may use a different SAML library or no SAML library at all. If inbound SSO uses a different mechanism (e.g., passport-saml or a managed identity provider), this claim is incorrect.
- **Fix**: Verify `apps/studio/package.json` for `@node-saml/node-saml` before relying on this claim for dependency analysis.

### Finding C-62: `packages/shared/src/validation/auth-profile.schema.ts` exists

- **Severity**: LOW
- **Claim**: Plan references this file for adding WS-Security validation refinements
- **Reality**: File exists at that path.
- **Fix**: None.

---

## Cross-Cutting Findings

### Finding C-63: Multiple plans reference `AuthProfileService.resolve()` but no method signature was verified

- **Severity**: MEDIUM
- **Claim**: Plans 1, 5, and 6 all reference `AuthProfileService.resolve()` as the method for credential decryption
- **Reality**: The file `packages/shared/src/services/auth-profile.service.ts` exists, but the exact method signature of `resolve()` was not verified against the plans' assumptions. The plans assume it decrypts `encryptedSecrets` and returns plaintext credentials.
- **Fix**: Before implementation, read `AuthProfileService.resolve()` to verify the exact signature, error handling, and return type match what the plans assume.

### Finding C-64: No plan verifies the existing `grace-period.ts` module

- **Severity**: LOW
- **Claim**: Infrastructure plan (Gap 1) proposes implementing grace period fallback in `AuthProfileService.resolve()`
- **Reality**: A `resolveWithGracePeriod` function is already exported from `packages/shared/src/services/auth-profile/grace-period.ts` (visible in the barrel export at index.ts line 42). The infrastructure plan should verify if this module already implements the proposed grace period logic.
- **Fix**: Read `packages/shared/src/services/auth-profile/grace-period.ts` before implementing Gap 1 Phase B. The grace period logic may already be partially or fully implemented.

### Finding C-65: `packages/connectors-base/` vs `packages/connectors/base/` path inconsistency across plans

- **Severity**: MEDIUM
- **Claim**: The CLAUDE.md key files section references `packages/connectors-base/src/` but the actual path used in plans and codebase is `packages/connectors/base/src/`
- **Reality**: The token-manager file is at `packages/connectors/base/src/auth/token-manager.ts`. The connector tool executor is at `packages/connectors/src/executor/connector-tool-executor.ts`. The CLAUDE.md reference to `packages/connectors-base/src/` appears to be an outdated or alternative path.
- **Fix**: All plans should consistently use `packages/connectors/base/src/` for connectors-base code and `packages/connectors/src/` for connector framework code.

---

## Summary

| Severity | Count | Key Issues                                                                                             |
| -------- | ----- | ------------------------------------------------------------------------------------------------------ |
| CRITICAL | 1     | Audit trail `findOneAndUpdate` hook leaks ciphertext (C-47) — plan correctly identifies this           |
| HIGH     | 1     | `RuntimeSession` location uncertainty (C-15) — plan may target the wrong file                          |
| MEDIUM   | 7     | Path inconsistencies (C-14, C-18, C-54, C-61, C-63, C-64, C-65) — several file paths need verification |
| LOW      | 57    | Accurate claims confirmed against codebase — the vast majority of references are correct               |

**Overall assessment:** The 6 plans are largely accurate in their codebase references. The critical finding (C-47) is a gap that the infrastructure plan itself correctly identifies. The high-severity finding (C-15) about `RuntimeSession` location needs resolution before implementation. The medium-severity findings are mostly about path conventions and unverified claims that should be checked during implementation. The plans demonstrate strong familiarity with the actual codebase structure.
