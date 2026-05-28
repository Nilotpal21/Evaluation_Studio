# Encryption E2E Review

Date: 2026-03-18

## Executive Summary

The AES/KMS primitives are not the main problem. The current risk is that encryption responsibilities are split across multiple write paths, and those paths do not agree on whether callers should pass plaintext or pre-encrypted values. I found one active high-severity bug in the user credential flow, one systemic guardrail gap in the v3 Mongoose plugin, and two medium-severity architecture issues that make mixed encryption states and key mismatches possible.

## High Severity

### ENC-001: User LLM credentials are double-encrypted under two different scopes

Impact: User-scoped credentials can be stored as `tenant(user(secret))`, while runtime consumers assume the model layer already returned plaintext. This can cause authentication failures, make decryption dependent on two unrelated identifiers, and leave records in a format that other readers cannot validate.

Evidence:

- The Studio user credential create/update routes pre-encrypt with `user.id` before saving:
  - `apps/studio/src/app/api/credentials/route.ts:104-117`
  - `apps/studio/src/app/api/credentials/[id]/route.ts:130-146`
- The same `LLMCredential` fields are also encrypted by the Mongoose plugin:
  - `packages/database/src/models/llm-credential.model.ts:64-67`
- The plugin then re-encrypts those fields with tenant-scoped v3 encryption on save:
  - `packages/database/src/mongo/plugins/encryption.plugin.ts:474-501`
- Runtime consumers assume `encryptedApiKey` is already plaintext after the plugin runs:
  - `apps/runtime/src/repos/llm-resolution-repo.ts:358-381`
  - `apps/runtime/src/services/llm/model-resolution.ts:1289-1309`
  - `apps/search-ai/src/services/llm-config/resolver.ts:495-510`

Why this is a real bug:

- The tenant credential route correctly passes plaintext into the same repo/model:
  - `apps/studio/src/app/api/tenant-credentials/route.ts:107-121`
- The user credential route does not, so the same collection is written with two incompatible conventions.
- The Studio GET route hides this by manually decrypting the inner user-scoped layer when masking the endpoint:
  - `apps/studio/src/app/api/credentials/[id]/route.ts:77-86`

Recommended fix:

- Pick one canonical contract for `LLMCredential`: callers always pass plaintext to the model plugin, or callers always bypass the plugin and persist fully annotated ciphertext through a single service.
- Given the rest of the codebase, the safer fix is to remove the manual `encrypt(..., user.id)` calls from the Studio user credential routes and let the plugin be the only writer for those fields.
- Add a backfill that detects and unwraps existing double-encrypted user credentials.

### ENC-002: The v3 Mongoose encryption plugin does not reject already-encrypted input

Impact: Any caller that accidentally passes ciphertext into a plugin-managed field will silently produce double-encrypted records. Because v3 stores only raw `iv:tag:ciphertext`, there is no metadata proving whether the inner payload is plaintext, tenant-scoped ciphertext, or user-scoped ciphertext.

Evidence:

- The plugin pre-save path unconditionally encrypts modified values with `encryptForTenant` and performs no "already encrypted" validation:
  - `packages/database/src/mongo/plugins/encryption.plugin.ts:443-501`
- By contrast, the shared field interceptor already has explicit double-encryption checks:
  - `packages/shared-encryption/src/field-interceptor.ts:11-29`
  - `packages/shared/src/encryption/__tests__/field-interceptor.test.ts:31-42`

Why this matters:

- `ENC-001` exists because the plugin accepts pre-encrypted values as if they were plaintext.
- Several comments in the repo already warn humans not to pre-encrypt before plugin-managed saves:
  - `apps/runtime/src/scripts/migrate-env-to-instances.ts:217-220`
  - `apps/studio/src/app/api/projects/[id]/connections/oauth/callback/route.ts:93-95`
- That is a fragile contract. The enforcement needs to be in code, not comments.

Recommended fix:

- Add a single canonical envelope or prefix for plugin-managed v3 fields so the plugin can fail fast on already-encrypted inputs.
- At minimum, add an `isAlreadyEncryptedV3()` guard in the plugin before `encryptForTenant()`.
- Add tests that prove plugin-managed fields reject pre-encrypted input from both tenant and user scopes.

## Medium Severity

### ENC-003: `LLMCredential` migration bypasses the canonical encryption path and stores mixed-state records without explicit metadata

Impact: The migration can create `LLMCredential` documents whose decryptability depends on content heuristics instead of declared metadata. That makes it impossible to validate encryption state reliably and makes future rotations/backfills brittle.

Evidence:

- The migration bulk-inserts directly into the collection with `encryptedApiKey: conn.encryptedApiKey` and `encryptedEndpoint: tm.endpointUrl ?? tm.customEndpoint ?? null`:
  - `packages/database/src/migrations/scripts/20260219_001_unified_credential_store.ts:101-124`
- Those inserted documents do not set `ire`, `fieldsToEncrypt`, `cek`, or other encryption metadata.
- The plugin later falls back to guessing whether a field is route-encrypted based on a regex:
  - `packages/database/src/mongo/plugins/encryption.plugin.ts:268-270`
  - `packages/database/src/mongo/plugins/encryption.plugin.ts:705-744`

Why this matters:

- Once records are allowed to be "maybe plaintext, maybe v3 ciphertext" based only on string shape, you cannot reliably validate double encryption or key mismatches.
- This also couples correctness to the exact serialization format rather than to a schema-level invariant.

Recommended fix:

- Route migrations through a shared credential encryption service that emits one canonical format plus explicit metadata.
- If raw collection writes must remain, stamp every inserted credential with an explicit encryption-state/version field and validate the input state before insertion.

### ENC-004: Encryption is implemented through several parallel stacks instead of one centralized contract

Impact: New routes and migrations can easily choose the wrong encryption entrypoint, wrong key scope, or wrong lifecycle assumptions, because "how to store a secret" depends on which subsystem you are touching.

Evidence:

- `ChannelConnection` uses both plugin-managed encryption and manual field encryption inside `config`:
  - model note: `packages/database/src/models/channel-connection.model.ts:93-98`
  - manual encrypt on write: `apps/runtime/src/routes/channel-connections.ts:487-494`
  - manual decrypt on read: `apps/runtime/src/channels/connection-resolver.ts:92-107`
- `ConnectorConnection` opts out of the plugin entirely and relies on `ConnectionService` to pre-encrypt values before `create()` and `findOneAndUpdate()`:
  - `packages/database/src/models/connector-connection.model.ts:72-75`
  - `packages/connectors/src/services/connection-service.ts:171-189`
  - `packages/connectors/src/services/connection-service.ts:206-218`
  - `packages/connectors/src/services/connection-service.ts:240-263`
- Tenant-encryption wiring is duplicated across multiple process entrypoints:
  - `apps/runtime/src/server.ts:1220-1229`
  - `apps/studio/src/lib/ensure-db.ts:29-45`
  - `apps/search-ai/src/server.ts:293-306`
  - `packages/pipeline-engine/src/pipeline/server.ts:227-240`

Why this matters:

- The codebase already contains both "pass plaintext, plugin encrypts it" and "pass ciphertext, service manages it" patterns.
- That split is the root reason `ENC-001` was possible.

Recommended fix:

- Introduce a single secret-storage facade per storage domain and forbid direct `encrypt*` calls from route handlers for plugin-managed fields.
- Move mixed-field manual encryption (`config.encryptedInboundAuthToken`, connector credentials, etc.) behind that same facade or an equivalent dedicated service with explicit metadata and validation.

## Testing Gaps

- I found plugin-level encryption tests, including v3 and fallback coverage:
  - `packages/database/src/__tests__/encryption-plugin-v3.test.ts`
  - `packages/database/src/__tests__/encryption-plugin-resolver.test.ts`
- I did not find end-to-end tests covering the actual broken seam:
  - Studio user credential API write path
  - repo save/decrypt path
  - runtime/search-ai user credential consumers that treat `encryptedApiKey` as already-plaintext
- I also did not find a test that runs the `LLMCredential` migration and then verifies the resulting records have one canonical encryption state.

## Recommended Next Steps

1. Fix `ENC-001` first by removing caller-side user encryption from the Studio user credential routes and backfilling already double-encrypted records.
2. Add v3 double-encryption guards to the Mongoose plugin so this class of bug fails closed.
3. Introduce explicit encryption-state metadata for `LLMCredential` writes performed outside normal model saves.
4. Add one end-to-end test that creates a user credential through the Studio API path and resolves it through the runtime path, and another that verifies tenant and user credentials cannot be mixed or double-encrypted silently.
