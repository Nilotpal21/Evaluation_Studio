# Auth Profile Design — Security Review

## Security Review: Auth Profile Design

Reviewing `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` against the existing encryption infrastructure in `packages/shared/src/encryption/`, `packages/database/src/mongo/plugins/encryption.plugin.ts`, and related models.

---

### CRITICAL Issues (Confidence >= 80)

**FINDING-001: Key Rotation Leaves `encryptionKeyVersion` as a Dead Field (Confidence: 95)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 1, Core Model)

The design declares `encryptionKeyVersion: number` on the `AuthProfile` document as a field "for key rotation," but the existing `encryptionPlugin` (`packages/database/src/mongo/plugins/encryption.plugin.ts`) uses a `v3` mode where the tenant-derived key is computed on-the-fly from `ENCRYPTION_MASTER_KEY` via HKDF/PBKDF2 every time. There is no stored key-version-to-key mapping, no re-encryption job infrastructure for Auth Profiles, and no lookup table that maps version integers to different master keys.

The `KeyVersion` model (`packages/database/src/models/key-version.model.ts`) tracks `status: active | decrypt_only | destroyed` per tenant, but there is no code path that selects a different encryption key based on `encryptionKeyVersion`. If `ENCRYPTION_MASTER_KEY` changes, every existing `encryptedSecrets` field becomes permanently unreadable — even though `encryptionKeyVersion` implies old data can still be decrypted.

The design acknowledges this in its "Prerequisite Gaps" but does not specify how `encryptionKeyVersion` maps to actual keys at decrypt time. Without a concrete mechanism (e.g., a per-version key store, an envelope-encryption pattern, or explicit re-encryption before key retirement), the field is misleading and key rotation is not actually safe.

Fix required: Either (a) remove `encryptionKeyVersion` from the design and document that `ENCRYPTION_MASTER_KEY` rotation requires a re-encryption batch job before the old key is retired, or (b) specify the concrete key-versioning mechanism — a mapping from version number to master key hex, stored in a vault — and document that decryption must select the key by version.

**FINDING-002: Audit Trail Plugin Records Encrypted Ciphertext in `changes` Field (Confidence: 90)**

File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/mongo/plugins/audit-trail.plugin.ts` lines 124-126

The `auditTrailPlugin` captures `getModifiedFields(this)` before the `post('save')` hook fires. The `encryptionPlugin`'s `pre('save')` hook runs first and replaces plaintext field values with ciphertext in-place. After save, `getModifiedFields` reads `doc.get(path)` which returns the post-encryption ciphertext. So the `changes` map in the audit log will contain the full base64/hex ciphertext of `encryptedSecrets` (and `previousEncryptedSecrets`) on every update. This means the audit log table contains the full encrypted blob of all credentials.

While ciphertext is not plaintext, storing the full ciphertext in audit logs is a security concern: it leaks ciphertext size/length (enabling timing attacks), it means audit logs grow proportionally to credential payload size, and it creates a secondary path for obtaining ciphertexts that bypasses the main model's access controls.

The design specifies that `auditTrailPlugin` will be applied to `AuthProfile`, but does not address this.

Fix: The audit trail plugin (or the `getModifiedFields` helper) should mask fields named in the schema's `fieldsToEncrypt` option — replacing values with `[ENCRYPTED]` sentinel rather than the actual ciphertext.

**FINDING-003: Personal Profile Visibility Enforcement Missing in `validate` Endpoint (Confidence: 88)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 8, API Design)

The design correctly enforces personal profile visibility on list queries (`$or: [{ visibility: 'shared' }, { visibility: 'personal', createdBy: userId }]`), but the `POST .../validate` endpoint is described only as "test credentials." The design does not specify that the validate endpoint must also enforce visibility — a non-admin user with `AUTH_PROFILE_READ` can currently enumerate profile IDs from the list endpoint (where they see only their own personal ones) and then call `validate` with any ID they can guess, causing credential decryption and use without ownership verification.

Fix: Every ID-based endpoint (`GET /:id`, `PUT /:id`, `DELETE /:id`, `POST /:id/validate`) must apply the same visibility filter as the list endpoint, not just the `tenantId`/`projectId` check. The `validateAuthProfileAccess` helper shown in the design does not include a visibility clause.

**FINDING-004: `proxyAuthProfileId` Not Validated for `visibility: personal` at Link Time (Confidence: 85)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 3.5, Proxy addon; Section 11, Cross-Reference Security)

The cross-reference security table validates `proxyAuthProfileId` only for same-`tenantId` membership. It does not check `visibility`. This means a shared Auth Profile (visible to all project members) could reference a personal Auth Profile as its proxy. If a non-owner calls `validate` or the runtime resolves the proxy chain, the system would decrypt the personal profile's credentials on behalf of someone who shouldn't have access to them. The design explicitly says personal profiles are "only [accessible by] creator," but the proxy chain can bypass this.

Fix: When setting `proxyAuthProfileId`, validate not only same-`tenantId` but also that the referencing user is the `createdBy` of the personal proxy profile, or that the proxy profile has `visibility: 'shared'`. Personal-to-shared proxy links are fine; shared-to-personal proxy links are not.

**FINDING-005: No DECRYPT Audit on `authProfileService.resolve()` at Runtime (Confidence: 88)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 8, Resolution endpoint; Section 11, Audit Logging)

The audit table specifies `AUTH_PROFILE_SECRETS_ACCESSED` for "Decrypt secrets" but this is scoped to the Studio API (admin decrypt endpoint). The `authProfileService.resolve()` call at runtime — called by every BullMQ worker, connector, and HTTP tool executor during agent execution — also decrypts `encryptedSecrets`. The design does not specify that runtime resolution emits an audit event. Given that runtime runs service-to-service (not as a user-authenticated request), there is no actor context available for `withAuditActor`.

This creates a compliance gap: an auditor can see who accessed credentials through the Studio UI, but cannot see the far more frequent runtime access path. For credentials like AWS IAM keys, OAuth tokens, and mTLS private keys, the absence of runtime decryption audit makes it impossible to detect credential abuse.

Fix: The design must specify that `authProfileService.resolve()` emits a lightweight audit event (profileId, tenantId, consumerId/sessionId, timestamp). Given the high call frequency, this should go to ClickHouse (event store), not MongoDB audit_logs. Audit the invocation context (worker name, sessionId) rather than the actor.

**FINDING-006: `config` Field on Auth Profile Can Leak Sensitive Non-Secret Data (Confidence: 82)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 1, Auth Type table; Section 2)

Several `config` field values in the design contain sensitive non-secret data that is stored in plaintext:

- `kerberos.config.kdcHost` and `kdcPort` — exposes internal Kerberos infrastructure topology
- `saml.config.idpSsoUrl`, `idpSloUrl` — internal IdP endpoints
- `aws_iam.config.region` + `service` — partially reveals AWS service usage
- `azure_ad.config.tenantId` + `resource` + `endpoint` — reveals Azure tenant/resource structure
- `digest.config.realm` — could leak server identity

These are returned in API responses for any user with `AUTH_PROFILE_READ` (which is all project members). The design says `config` is "non-sensitive," but for enterprise deployments this is infrastructure reconnaissance data.

More critically: The design specifies `oauth2_token.config.providerUserId` — the end user's provider-side user ID — is stored in plaintext `config`. For personal `oauth2_token` profiles with `visibility: 'personal'`, a tenant admin who calls `GET /api/auth-profiles/:id` (permitted by the "Tenant admins can see all personal profiles" rule) can see another user's provider user ID without holding `AUTH_PROFILE_DECRYPT`. This is a PII leak path.

Fix: `oauth2_token.config.providerUserId` must either be omitted from API responses unless the requester is the profile owner or holds `AUTH_PROFILE_DECRYPT`, or it must be moved to `encryptedSecrets`.

**FINDING-007: Audit Log `changes` Field Contains No Filtering for `encryptedSecrets` Field Name (Confidence: 90)**

File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/mongo/plugins/audit-trail.plugin.ts` lines 201-213

The `getModifiedFields` function captures all modified paths indiscriminately. When `encryptedSecrets` is modified (e.g. during rotation or credential update), the `changes` object in the audit entry will contain `{ encryptedSecrets: "<base64 ciphertext>" }`. The `AuditLog` model's `changes` field is `Schema.Types.Mixed` with no field-level access control. Any user or service that can read `audit_logs` (including the Studio UI audit log viewer) would see the full ciphertext. This is a direct ciphertext exposure path through a secondary collection.

The CLAUDE.md core invariants state that audit logging is a compliance requirement, but the existing `auditTrailPlugin` was not designed for models with encrypted fields — those were added later (v3 encryption). This is a real gap when `AuthProfile` is added.

Fix: In `getModifiedFields`, skip any path that is in the model's `fieldsToEncrypt` list, or add a pre-filter step that strips encrypted field names from the captured changes before writing the audit entry.

**FINDING-008: `previousEncryptedSecrets` Grace-Period Window Relies on `updatedAt` But Plugin Can Lose Timestamp Precision (Confidence: 80)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 1, Rotation fields)

The design states: "`rotationGracePeriodMs` is relative to `updatedAt`, not absolute." During the grace period, the runtime falls back to `previousEncryptedSecrets` if `encryptedSecrets` fails. However, MongoDB's `timestamps: true` updates `updatedAt` on every `save()`, including non-rotation saves (e.g. updating `lastUsedAt` or `status`). If the runtime calls `authProfileService.resolve()` (which may touch `lastUsedAt`), and that triggers a `save()`, the grace period window silently resets. After enough resolve calls, `previousEncryptedSecrets` could become permanently unreachable even within what was supposed to be the grace window.

Fix: Either use an explicit `rotationStartedAt` field instead of `updatedAt` as the grace period anchor, or make `previousEncryptedSecrets` include its own `rotatedAt` timestamp in the stored value. The design should explicitly forbid grace-period expiry logic from depending on `updatedAt`.

### Important Issues (Confidence 80-88)

**FINDING-009: `NormalizedToolSecret` (and similar normalized types) Passes `encryptedValue` Through to API Callers (Confidence: 82)**

File: `/Users/prasannaarikala/projects/agent-platform/packages/shared-kernel/src/types/security.ts` lines 16-21

The `NormalizedToolSecret` type exposes `encryptedValue: string` in its interface. The `findToolSecrets` function in `security-repo.ts` returns this field to callers without stripping it. If the Auth Profile design follows the same normalization pattern (creating `NormalizedAuthProfile` with `encryptedSecrets: string`), the normalized type would pass the ciphertext to every API route that calls the repo, increasing the blast radius if any route accidentally serializes the full object to a response.

The design says secrets are "redacted" in responses, but the current normalized-type pattern does not enforce this at the type level — it would require every API route handler to manually omit the field. The `EndUserOAuthToken` normalized type has the same problem (`encryptedAccessToken: string` in `NormalizedEndUserOAuthToken`).

Fix: The `NormalizedAuthProfile` type (and any normalized types replacing `NormalizedToolSecret`) should use `encryptedSecrets?: never` or should not include the `encryptedSecrets` field at all. A separate `DecryptedAuthProfile` type should be used in the runtime service layer where decryption is intentional. The API layer should only ever receive the non-encrypted form, never the ciphertext.

**FINDING-010: GDPR Cascade Missing for `AuthProfile` in `cascade-delete.ts` (Confidence: 85)**

File: `/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts` line 103

The `deleteTenant` function deletes `LLMCredential` at line 103 and `ConnectorConnection`. The design says `AuthProfile` replaces `LLMCredential`, `EndUserOAuthToken`, and `ToolSecret`. During the dual-read migration phase (Phase 1+2), `AuthProfile` documents will coexist with the old models. The `deleteTenant` cascade does not include `AuthProfile`. When a tenant is deleted during migration, `AuthProfile` documents will remain as orphaned encrypted-credentials in MongoDB — a GDPR and data-hygiene violation.

Similarly, the user-level erasure path (right to erasure for personal profiles where `createdBy === subjectId`) is specified in the design but there is no existing `deleteUser` cascade function that can be updated — the design relies on `MongoGDPRStore` which does not yet include `AuthProfile`.

Fix: Add `AuthProfile` to the `deleteTenant` cascade from day one. Do not wait for Phase 3 cleanup. Ensure personal profiles (`visibility: 'personal'`) are handled in the per-user erasure path.

**FINDING-011: Token Refresh Distributed Lock Does Not Account for KV Re-Encryption After Master Key Rotation (Confidence: 81)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 5, Token Refresh)

The token refresh flow acquires a Redis `SET NX PX` distributed lock to prevent concurrent refresh. After refresh, step 5 ("If `refreshTokenRotation: true`, store new refresh token atomically") stores the new tokens by calling `encryptedSecrets` update. If `ENCRYPTION_MASTER_KEY` has been rotated between when the old `encryptedSecrets` was written and when the new tokens are stored, the old `encryptedSecrets` cannot be decrypted to obtain the `refreshToken` needed in step 4. The refresh will fail with a decryption error. The lock will time out. The profile enters an unrecoverable state.

The design does not specify error handling for decryption failure during token refresh, which is distinct from network/OAuth errors. If refresh fails due to decryption error, the `status` should be set to `'invalid'` (not `'expired'`), and a specific error code should indicate that re-encryption/re-authorization is required.

**FINDING-012: `config` Field Passed Through Zod but Stored as `Record<string, unknown>` — No Strip of Unknown Fields (Confidence: 80)**

File: `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-design.md` (Section 1)

The design says `config` is "validated server-side via Zod discriminated union keyed on `authType`." However, the MongoDB schema for `config` is `Record<string, unknown>` (essentially `Schema.Types.Mixed`). If Zod validation uses `.passthrough()` (the default for unrecognized keys) instead of `.strict()`, an attacker who knows the config structure for a given `authType` can include additional fields — such as `__proto__`, `constructor`, or fields that happen to be interpreted as embedded commands by downstream protocol libraries (`soap`, `kerberos`). The design must specify that Zod schemas use `.strict()` for config objects to prevent prototype pollution and field injection.

Additionally, if the `authorizationUrl` and `tokenUrl` in `oauth2_app.config` are not validated as HTTPS-only and non-internal URLs, a compromised tenant could configure an `oauth2_app` pointing to an internal service, effectively turning Auth Profile's token refresh into an SSRF vector. The codebase has `ssrf-validator` in `packages/shared-kernel/src/security/ssrf-validator.ts` and `packages/shared/src/security/ssrf-validator.ts`, but the design does not specify its use on URL fields in `config`.

Fix: (a) Specify Zod `.strict()` for all config discriminated union schemas. (b) Apply `ssrf-validator` to all URL fields in `oauth2_app`, `oauth2_client_credentials`, and `azure_ad` config. (c) Enforce HTTPS-only for `authorizationUrl`, `tokenUrl`, `refreshUrl`, `revocationUrl`.

---

### Summary

| Finding                                                                   | Category                | Confidence | Severity  |
| ------------------------------------------------------------------------- | ----------------------- | ---------- | --------- |
| 001 — `encryptionKeyVersion` is cosmetic; no actual key-version lookup    | Encryption/Key Rotation | 95         | Critical  |
| 007 — Audit log `changes` contains raw ciphertext                         | Secret Exposure         | 90         | Critical  |
| 002 — Audit trail captures post-encryption ciphertext                     | Secret Exposure         | 90         | Critical  |
| 003 — `validate` endpoint skips visibility enforcement                    | Access Control          | 88         | Critical  |
| 005 — Runtime `resolve()` emits no audit event                            | Audit Trail             | 88         | Critical  |
| 010 — GDPR cascade missing `AuthProfile`                                  | GDPR                    | 85         | Important |
| 004 — `proxyAuthProfileId` allows shared→personal proxy                   | Access Control          | 85         | Important |
| 006 — `providerUserId` leaks through `AUTH_PROFILE_READ`                  | Secret Exposure         | 82         | Important |
| 009 — Normalized type pattern passes ciphertext to routes                 | Secret Exposure         | 82         | Important |
| 011 — Token refresh has no error path for decryption failure              | Resilience              | 81         | Important |
| 008 — Grace-period anchor is `updatedAt`, which resets on unrelated saves | Logic Error             | 80         | Important |
| 012 — No SSRF guard on URL fields; Zod `.passthrough()` risk              | Input Validation        | 80         | Important |

---

## Key findings by category

### Encryption Implementation

**Finding 001 (Confidence: 95)** — `encryptionKeyVersion` field has no backing implementation.

The existing `EncryptionService` (`/Users/prasannaarikala/projects/agent-platform/packages/shared/src/encryption/engine.ts`) derives the tenant key from `ENCRYPTION_MASTER_KEY` using HKDF/PBKDF2 on every call. There is no version-to-key lookup table. The `KeyVersion` model (`/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/key-version.model.ts`) tracks lifecycle states but is never consulted during encryption or decryption. If `ENCRYPTION_MASTER_KEY` is rotated, all existing `encryptedSecrets` fields become unreadable. The design's `encryptionKeyVersion: number` field implies safe rotation is possible, but there is no implementation to support it. This is a data-loss risk disguised as a feature.

The design acknowledges key rotation as a "prerequisite gap" but does not specify the mechanism. Without it, implementing `encryptionKeyVersion` misleads future implementors into believing rotation is safe when it is not.

**Finding 008 (Confidence: 80)** — Grace-period window anchored to `updatedAt` resets on any save.

`rotationGracePeriodMs` is computed relative to `updatedAt` (design section 1). Mongoose `timestamps: true` updates `updatedAt` on every `save()`, including updates to `lastUsedAt`, `status`, and `lastValidatedAt` that happen during normal runtime resolution. The grace window silently resets with every field update, making `previousEncryptedSecrets` unreachable earlier than intended. Fix: use an explicit `rotationStartedAt` field.

### Secret Exposure Vectors

**Finding 007 (Confidence: 90)** — Audit trail plugin records ciphertext in `changes` field.

`/Users/prasannaarikala/projects/agent-platform/packages/database/src/mongo/plugins/audit-trail.plugin.ts` line 125: `getModifiedFields` captures all modified paths including `encryptedSecrets` after the encryption plugin has already replaced the value with ciphertext. Every credential update writes the full base64 ciphertext to `audit_logs.changes`, a `Mixed` field with no access control. Any service or user that can query `audit_logs` can extract ciphertexts from credential updates — a secondary exfiltration path that bypasses the primary model.

**Finding 002 (Confidence: 90)** — Same mechanism but from hook ordering perspective.

The `encryptionPlugin`'s `pre('save')` fires before `auditTrailPlugin`'s `pre('save')`, so `getModifiedFields` in the audit plugin runs after in-place encryption. The two findings are related but distinct: 007 is about the ciphertext being in the audit log; 002 is about the hook ordering making this unavoidable without a fix.

**Finding 006 (Confidence: 82)** — `oauth2_token.config.providerUserId` leaks via `AUTH_PROFILE_READ`.

The design puts `providerUserId` (the end user's provider-side account ID, e.g. Google user ID) in plaintext `config`, not `encryptedSecrets`. Tenant admins can view all personal profiles per the design. This means an admin with `AUTH_PROFILE_READ` (but not `AUTH_PROFILE_DECRYPT`) can see another user's Google/Slack/GitHub account identifier without the user's knowledge. This is a PII leak that bypasses the decrypt permission.

**Finding 009 (Confidence: 82)** — Normalized type pattern risks ciphertext in API responses.

`/Users/prasannaarikala/projects/agent-platform/packages/shared-kernel/src/types/security.ts` line 14: `NormalizedToolSecret.encryptedValue: string` is passed through to callers. If `NormalizedAuthProfile` follows the same pattern and includes `encryptedSecrets: string`, every API route handler must manually omit it or it will appear in responses. The current codebase does not consistently do this (compare `NormalizedEndUserOAuthToken` which also exposes `encryptedAccessToken`). The type-system should enforce this rather than relying on per-route diligence.

### Access Control Gaps

**Finding 003 (Confidence: 88)** — `validate` endpoint visibility enforcement not specified.

The `validateAuthProfileAccess` helper (design section 4) checks `tenantId` and `projectId` but not `visibility`. The `POST /:id/validate` endpoint is not shown to apply the personal profile visibility filter (`$or: [{ visibility: 'shared' }, { createdBy: userId }]`). A non-admin user with `AUTH_PROFILE_READ` who knows a personal profile's ID (e.g., from a shared reference) can trigger credential decryption and network use via `validate` without being the profile owner.

**Finding 004 (Confidence: 85)** — `proxyAuthProfileId` allows shared-to-personal proxy chain.

Cross-reference validation (design section 11) checks only same-`tenantId` for `proxyAuthProfileId`. A shared Auth Profile (accessible to all project members) can reference a personal Auth Profile as its proxy. When any project member uses the shared profile, the system decrypts the personal proxy profile's credentials on their behalf. This circumvents the `visibility: personal` restriction through the proxy addon.

**Finding 011 (Confidence: 81)** — Token refresh has no error path for decryption failure.

Token refresh (design section 5) step 4 requires decrypting `encryptedSecrets` to get `refreshToken`. If decryption fails (e.g., after a master key rotation that left data unreadable), the design only specifies error paths for network and OAuth errors. A decryption error in the refresh path has no specified behavior. The profile could be left in `expired` state (the OAuth error path) when the correct state is `invalid` with a re-authorization required message.

### Audit Trail Completeness

**Finding 005 (Confidence: 88)** — Runtime `authProfileService.resolve()` emits no audit event.

The audit table (design section 11) lists `AUTH_PROFILE_SECRETS_ACCESSED` for "Decrypt secrets," but this covers only the Studio admin decrypt endpoint. The `authProfileService.resolve()` function — called by every BullMQ worker, connector executor, and HTTP tool executor during agent runtime — also decrypts `encryptedSecrets`. This is the highest-frequency decryption path. It runs service-to-service with no `withAuditActor` context. There is no specification for runtime-side audit of credential decryption. For credentials like AWS IAM keys and OAuth tokens, the inability to audit runtime decryption makes it impossible to detect compromise.

The existing `encryption-manifest.ts` in `packages/shared/src/encryption/` already uses ClickHouse for high-frequency encrypted data (messages, traces). Runtime resolution audit should go to `audit_events` in ClickHouse, not MongoDB `audit_logs`.

### GDPR and Data Lifecycle

**Finding 010 (Confidence: 85)** — `AuthProfile` absent from `cascade-delete.ts`.

`/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts` line 103 deletes `LLMCredential` (one of the models that `AuthProfile` replaces) but there is no `AuthProfile` deletion. During the dual-read migration phase, both models coexist. A tenant deletion during migration leaves `AuthProfile` documents as orphaned encrypted credentials — a GDPR violation for `visibility: personal` profiles. `AuthProfile` must be added to `deleteTenant` from the first migration phase, not deferred to cleanup.

### SSRF and Input Validation

**Finding 012 (Confidence: 80)** — URL fields in `config` need SSRF validation; Zod must use `.strict()`.

The codebase has two SSRF validators (`packages/shared-kernel/src/security/ssrf-validator.ts`, `packages/shared/src/security/ssrf-validator.ts`). The design does not specify applying them to `authorizationUrl`, `tokenUrl`, `refreshUrl`, `revocationUrl`, or `oauth2_client_credentials.config.tokenUrl`. A compromised tenant could configure an `oauth2_app` pointing to an internal metadata service, turning OAuth token refresh into SSRF. Additionally, the design says config is "validated via Zod discriminated union" but does not specify `.strict()`. Using the Zod default (passthrough) allows unknown fields that could be interpreted as embedded commands by `soap`, `kerberos`, or `@node-saml/node-saml`.

---

## Summary table

| #   | Finding                                                                        | Confidence | Category         |
| --- | ------------------------------------------------------------------------------ | ---------- | ---------------- |
| 001 | `encryptionKeyVersion` has no backing key-lookup; rotation breaks decryption   | 95         | Encryption       |
| 007 | Audit log `changes` records full ciphertext of `encryptedSecrets`              | 90         | Secret Exposure  |
| 002 | `auditTrailPlugin` hook ordering means encrypted ciphertext lands in audit log | 90         | Secret Exposure  |
| 003 | `validate` endpoint skips personal-profile visibility enforcement              | 88         | Access Control   |
| 005 | Runtime `resolve()` decryption path emits no audit event                       | 88         | Audit Trail      |
| 010 | `AuthProfile` absent from `cascade-delete.ts` GDPR cascade                     | 85         | GDPR             |
| 004 | `proxyAuthProfileId` allows shared→personal proxy chain bypass                 | 85         | Access Control   |
| 006 | `providerUserId` in plaintext `config` leaks via `AUTH_PROFILE_READ`           | 82         | Secret Exposure  |
| 009 | Normalized type pattern risks ciphertext reaching API response layer           | 82         | Secret Exposure  |
| 011 | Token refresh has no error path for decryption failure after key rotation      | 81         | Resilience       |
| 008 | `rotationGracePeriodMs` anchored to `updatedAt` resets on any field save       | 80         | Logic Error      |
| 012 | No SSRF guard on `tokenUrl`/`authorizationUrl`; Zod needs `.strict()`          | 80         | Input Validation |
