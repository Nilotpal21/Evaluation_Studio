# Auth Profile Design — False Positive Review

**Design doc reviewed:** `docs/plans/2026-03-11-auth-profile-design.md`
**Review date:** 2026-03-11
**Reviewer:** Code review agent

This document audits claims made in the Auth Profile design against the actual codebase. Each finding states whether the design is **correct**, **incorrect** (false positive — the claim is wrong), **incomplete** (missing something), or **speculative** (no codebase evidence for or against).

---

## 1. Section 14 — Models Simplified (14): Field Verification

### 1.1 `ConnectorConnection` — Fields Claimed to Drop

**Design claims:** Drop `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider`.

**Codebase evidence:** Confirmed in `/packages/database/src/models/connector-connection.model.ts`. All three fields exist. However, the model also has `oauth2TokenExpiresAt` (line 59) which is not listed in the drop set. This is an **incomplete** migration plan — `oauth2TokenExpiresAt` is also OAuth-state and should be dropped alongside `oauth2RefreshToken` and `oauth2Provider`. **Minor false positive**: the drop list is incomplete.

**Also note:** The model comment at line 70–72 explicitly states `encryptedCredentials` is NOT managed by `encryptionPlugin` — it is encrypted externally by `ConnectionService` via `findOneAndUpdate`. The migration plan does not account for this: Auth Profile uses `encryptionPlugin`, but the existing `encryptedCredentials` was encrypted by a different code path. The migration script must decrypt using the old path before re-encrypting via `encryptionPlugin`.

### 1.2 `ChannelConnection` — Fields Claimed to Drop

**Design claims:** Drop `encryptedCredentials`, `config.encryptedInboundAuthToken`.

**Codebase evidence:** Confirmed in `/packages/database/src/models/channel-connection.model.ts`. However, `encryptedInboundAuthToken` is NOT a top-level schema field — it lives inside `config: Schema.Types.Mixed` (see model comment at lines 90–93). The `encryptionPlugin` cannot encrypt it (it only handles top-level fields); it is encrypted manually via `encryptForTenant`/`decryptForTenant` in the route layer. **False positive:** the design treats `config.encryptedInboundAuthToken` as a normal schema field migration, but it requires special handling since it is embedded in a `Mixed` subdocument.

### 1.3 `TenantModel.connections[]` — Consumer Table Label

**Design claims:** `TenantModel.connections[]` drops `credentialId`.

**Codebase evidence:** The consumer table uses the label `TenantModel.connections[]` which is ambiguous. The actual Mongoose model is `TenantModel` (in `/packages/database/src/models/tenant-model.model.ts`) with an embedded `connections[]` array where each element has `credentialId`. This is not the same as `Tenant.connections[]`. **Correct** in substance, but **misleading** in naming — the model is `TenantModel` (LLM model config), not `Tenant`.

### 1.4 `SDKChannel` — Field Claimed to Drop

**Design claims:** Drop `secretKey`.

**Codebase evidence:** Confirmed in `/packages/database/src/models/sdk-channel.model.ts` at line 28. Field exists and is stored as plain text (no `encryptionPlugin` on `SDKChannelSchema`). **Correct.**

### 1.5 `WebhookSubscriptionConnector` — Field Claimed to Drop

**Design claims:** Drop `encryptedClientState`.

**Codebase evidence:** Confirmed in `/packages/database/src/models/webhook-subscription-connector.model.ts` at line 29. The field is declared as `encryptedClientState` but the `WebhookSubscriptionConnectorSchema` does NOT apply `encryptionPlugin` (no plugin calls in the schema). This field is named "encrypted" but has no automatic encryption. **False positive:** the design calls this a straightforward migration but the field is actually not currently encrypted at rest — it requires encryption as part of migration, not just pointer replacement.

### 1.6 `ServiceNode` — Structural Mismatch with Auth Profile

**Design claims:** `ServiceNode` drops `encryptedSecrets`, `authConfig`; keeps `authProfileId`.

**Codebase evidence:** Confirmed fields exist in `/packages/database/src/models/service-node.model.ts`. However, `ServiceNode` has **no `tenantId` field** — tenant isolation is enforced via `projectId → Project.tenantId` join. The design's `validateAuthProfileAccess` helper takes `tenantId` as a required parameter, but `ServiceNode` cannot provide it directly. **False positive:** the design's consumer validation pattern does not apply cleanly to `ServiceNode` and requires a project-to-tenant lookup at resolution time that the design does not account for.

### 1.7 `ConnectorConfig` (SearchAI) — Wrong Field Name

**Design claims:** Drop `oauthTokenId`.

**Codebase evidence:** Confirmed in `/packages/database/src/models/connector-config.model.ts` at line 26. Field exists as `oauthTokenId`. **Correct.**

### 1.8 `GitIntegration` — `webhookSecret` Is NOT Plain Text

**Design claims (Section 14, Additional Consumers):** `GitIntegration.webhookSecret` is stored as **plain text** (not encrypted at rest).

**Codebase evidence:** Confirmed in `/packages/database/src/models/git-integration.model.ts` at line 39: `webhookSecret: string | null`. The `GitIntegrationSchema` has **no `encryptionPlugin`**. The field is indeed stored as plain text. **Correct.**

However, `GitIntegration.credentials.secretId` (line 15) is described in the design as a field to drop. The design does not call `secretId` "plain text" — it treats it as a generic secret. But looking at `/apps/studio/src/lib/git-credentials.ts`, `secretId` is a value that has been encrypted via `encryptionService.encryptForTenant()`. The migration must decrypt these before re-encrypting via Auth Profile's `encryptionPlugin`. **Not a false positive** but an important migration detail not spelled out.

### 1.9 Missing Consumer: `TriggerRegistration.webhookSecret`

**Design claims:** Lists `GuardrailPolicy.settings.webhookSecret` as a missing consumer found in audit.

**Codebase evidence:** `/packages/database/src/models/trigger-registration.model.ts` line 28 shows `webhookSecret?: string` stored as plain text with no `encryptionPlugin`. The design's "Additional Consumers Found in Audit" section **misses `TriggerRegistration`**, which has the same problem as `GuardrailPolicy.settings.webhookSecret` — webhook secrets stored unencrypted. **Incomplete:** the design omits `TriggerRegistration` from the audit findings.

---

## 2. Section 2 — Are All 17 Auth Types Needed?

### 2.1 `hawk` — Zero Codebase Usage

**Design claims:** `hawk` auth type using `@hapi/hawk` library.

**Codebase evidence:** Grep for `hawk` across all TypeScript source files finds no references to Hawk authentication in `packages/`, `apps/runtime/`, or `apps/search-ai/`. No existing or planned connector, tool, or integration uses Hawk. **Speculative / YAGNI.** The only consumers that would plausibly need Hawk are legacy enterprise APIs. No customer requirement is cited. Recommend deferring to a "v2 auth type" extension mechanism rather than shipping code for it in v1.

### 2.2 `kerberos` — Zero Codebase Usage

**Design claims:** `kerberos` auth type using the `kerberos` npm package (native C++ bindings, requires `libkrb5-dev`).

**Codebase evidence:** No references to Kerberos in the codebase. No connector, tool, worker, or infrastructure component requires Kerberos. This library has native bindings requiring system packages (`libkrb5-dev`) added to Dockerfiles, which is a non-trivial build dependency for an unproven use case. **Speculative / YAGNI.** The `kerberos` npm package also has a history of OS-specific build failures. Recommend deferring entirely.

### 2.3 `ws_security` — Zero Codebase Usage

**Design claims:** `ws_security` auth type using the `soap` npm library (~8MB) for SOAP/WS-Security.

**Codebase evidence:** No references to SOAP, WS-Security, or WSDL in the codebase. No existing tool, connector, or integration uses SOAP. **Speculative / YAGNI.** The `soap` package is ~8MB with its own XML parsing stack. This is a significant dependency for zero current customers. Recommend deferring.

### 2.4 `digest` — Zero Codebase Usage

**Design claims:** `digest` auth type using `digest-fetch` library for HTTP Digest authentication.

**Codebase evidence:** No references to Digest authentication in the codebase. **Speculative.** However, `digest` is a standard HTTP auth method with moderate usage in legacy enterprise APIs, and `digest-fetch` is a lightweight library with lazy loading. This is lower risk than `kerberos`/`ws_security`/`hawk`, but still YAGNI without a concrete customer requirement.

### 2.5 `saml` (Outbound) — No Evidence of Need

**Design claims:** `saml` auth type for outbound calls to SAML-protected APIs using `@node-saml/node-saml`.

**Codebase evidence:** The only SAML code in the codebase is in `apps/studio/src/services/sso/saml-service.ts` — this is inbound SP-initiated SSO for platform login, which the design explicitly declares out of scope. `@node-saml/node-saml` is already installed in `apps/studio/package.json` but for inbound SSO, not outbound tool auth. There is no evidence that any tool, connector, or integration needs outbound SAML bearer token auth. **Speculative / YAGNI.** The design correctly excludes inbound SSO but then adds outbound SAML with no codebase justification.

---

## 3. Section 3 — Are All 5 Addon Layers Needed?

### 3.1 `certificatePinning` — Zero Codebase Usage

**Design claims:** Certificate pinning addon using SPKI SHA-256 fingerprints.

**Codebase evidence:** No references to certificate pinning, SPKI, or `tls.checkServerIdentity` fingerprint checking anywhere in the codebase. No connector, tool, or infrastructure component implements or documents a need for cert pinning. **Speculative.** Certificate pinning in Node.js requires custom `https.Agent` configuration per request and breaks standard TLS cert rotation. This is an advanced security feature with niche use cases. Recommend deferring to a security hardening pass rather than shipping in v1.

### 3.2 `jwtWrapping` — Speculative

**Design claims:** JWT wrapping addon for generating JWTs from private keys.

**Codebase evidence:** The codebase does have JWT signing (for platform tokens), but no evidence that any HTTP tool needs to wrap its auth credentials in a freshly-signed JWT. **Speculative.** Some API gateways require client-signed JWTs as access tokens — this is a real pattern. However, it has zero current implementation evidence and should be flagged as a lower-priority addon.

### 3.3 `signing` (Request HMAC), `webhookVerification`, `proxy` — Justified

**Codebase evidence:**

- `signing`: `packages/connectors/src/triggers/webhook-handler.ts` and `apps/runtime/src/channels/security/webhook-signature.ts` show HMAC signing is already used for outbound webhook delivery. **Justified.**
- `webhookVerification`: `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts` and multiple channel adapters verify inbound webhooks. **Justified.**
- `proxy`: `packages/database/src/models/org-proxy-config.model.ts` shows proxy config is already a first-class concept with 6 encrypted fields. **Justified.**

---

## 4. Section 14 — Migration Complexity: Worker Count

### 4.1 "31+ Workers" Claim

**Design claims:** 31+ BullMQ workers need updating (updated from original 22+ estimate).

**Codebase evidence:** Counting unique worker files in `/apps/search-ai/src/workers/` (excluding test files): 28 workers. In `/apps/runtime/src/services/queues/`: `delivery-worker.ts` and `inbound-worker.ts`. Total: 30 worker files.

More importantly, many of these workers do **not** resolve credentials directly:

- `delivery-worker.ts` and `inbound-worker.ts`: grep confirms **no** `credentialId` or `LLMCredential` references — they do not need dual-read updates.
- Workers that go through `resolveEnhancedIndexLLMConfig` (page-processing, noise-detection, question-synthesis, scope-classification, tree-building, taxonomy-setup, multimodal — 7 workers) resolve credentials through the resolver service, not directly. They need updating only in the **resolver**, not individually.

**False positive:** The claim that "31+ workers" each need updating is overstated. The actual number of workers requiring direct code changes is closer to 10–12 (those that access `oauthTokenId`, `LLMCredential`, or `EndUserOAuthToken` directly). The other ~18 workers that use the LLM config resolver need only the resolver updated once, not per-worker changes.

### 4.2 `embedding-worker` Singleton Description

**Design claims (Section 14, line 1585–1591):** `embedding-worker.ts` uses a "module-level lazy singleton initialized from `process.env.OPENAI_API_KEY`" that "bypasses the dual-read path entirely."

**Codebase evidence:** `/apps/search-ai/src/workers/embedding-worker.ts` does have a module-level singleton `_embeddingProvider` (line 63) that falls back to `process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY` (line 87). However, the primary resolution path `resolveEmbeddingProviderForJob()` uses `resolveEmbeddingCredentials(provider, tenantId)` which reads from the DB. The singleton is only used when `knowledgeBaseId` is absent (fallback for jobs without pipeline context). **Partially correct** — the env var bypass exists but is a fallback, not the primary path. The design's statement that it "bypasses the dual-read path entirely" is an overstatement.

---

## 5. Section 15 — Libraries: YAGNI and Accuracy

### 5.1 `@aws-sdk/signature-v4` — Not Actually in the Monorepo

**Design claims:** `@aws-sdk/signature-v4` — "AWS SDK already in monorepo."

**Codebase evidence:** The monorepo has `@aws-sdk/client-lambda` (in `apps/runtime/package.json`) and `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` (in `apps/studio/package.json`). `@aws-sdk/signature-v4` specifically is NOT listed in any `package.json`. **False positive:** the design incorrectly states this is "already in monorepo." It must be added explicitly. This is a minor error but misleading for implementers.

### 5.2 `@node-saml/node-saml` — Already Installed But in Wrong Package

**Design claims:** "Add `@node-saml/node-saml`."

**Codebase evidence:** `@node-saml/node-saml` is already in `apps/studio/package.json` but for inbound SSO, not tool auth. The auth profile service would live in `packages/shared` or `packages/database`. The library would need to be added to the package where Auth Profile service lives, even though it already exists in the monorepo. **Not a false positive** but incomplete guidance — implementers may think it can be imported from studio, when it needs to be in the shared package.

### 5.3 `soap`, `kerberos`, `@hapi/hawk`, `digest-fetch` — YAGNI

As established in Section 2, these four libraries have no codebase usage. The design includes them unconditionally. Even with lazy loading, adding them to `packages/shared` creates:

- Security audit surface for 4 additional libraries
- `kerberos` requires Docker build changes (native bindings)
- `soap` is ~8MB even when not tree-shaken in builds that don't support it

**Recommendation:** Gate these 4 libraries behind a separate `packages/auth-enterprise` workspace package that is opt-in, rather than bundling them into `packages/shared` for all consumers.

---

## 6. Section Design Over-Specification

### 6.1 Redis Lock Key Format

**Design claims (Section 5):** Specifies exact Redis lock key: `auth-profile:refresh:{tenantId}:{profileId}`.

**Assessment:** Lock key naming is a pure implementation detail. Specifying it in the design doc creates a false "contract" — if the implementation chooses a different key format (e.g., namespaced differently for multi-region), any doc referencing this design will be stale. Lock key format belongs in code comments, not design docs.

### 6.2 Exact Cache TTL Formula

**Design claims:** "TTL = `expires_in - 60s`" specified multiple times for different auth types.

**Assessment:** This is correct engineering but over-specified. The 60-second buffer is configurable via `AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS`. Hardcoding the formula in the design doc means every TTL reference is a potential inconsistency if the env var default changes. The design should say "TTL = `expires_in - AUTH_PROFILE_TOKEN_REFRESH_BUFFER_SECONDS`" throughout.

### 6.3 Component Prop Signatures

**Design claims (Section 7.7):** Specifies exact TypeScript props for `<AuthProfilePicker>` including parameter names and types.

**Assessment:** Component API design belongs in the implementation PR, not the design doc. Specifying it here constrains the UI implementation team and creates a stale reference the moment the component signature changes. **Over-specified.**

### 6.4 `LLMWiringService._wireExecutor()` Line Number Reference

**Design claims (Section 8, Runtime Hook Point):** References `llm-wiring.ts:356` as the hook point.

**Codebase evidence:** Current codebase has `_wireExecutor` at line 349 and the `wireToolExecutor` call at line 340 (verified in `/apps/runtime/src/services/execution/llm-wiring.ts`). The line numbers are already stale by ~7 lines. **Minor false positive:** line number references in design docs are immediately stale and should not be used — reference function/method names instead.

---

## 7. Correct Claims Verified (Summary)

These design claims were verified as accurate:

- `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` exist as described and are the correct targets for deletion.
- `ConnectorConfig.oauthTokenId` references `EndUserOAuthToken._id` (verified).
- `ToolOAuthService.refreshToken()` has no distributed lock — race condition is real (verified: no Redis lock in `/apps/runtime/src/services/tool-oauth-service.ts`).
- `idp-sync-scheduler.ts` does repurpose `LLMCredential` for IdP admin credentials via `metadata` field (verified at lines 226–244).
- `GuardrailPolicy.settings.webhookSecret` is stored as plain text (no `encryptionPlugin` on `GuardrailPolicySchema` — verified).
- `GitIntegration.webhookSecret` is stored as plain text (no `encryptionPlugin` — verified).
- `TenantGuardrailProviderConfig.apiKeyCredentialId` field exists (verified).
- `SDKChannel.secretKey` is plain text (no `encryptionPlugin` — verified).
- `channel-oauth-service.ts` exists alongside `tool-oauth-service.ts` as parallel refresh implementations (verified).
- Workers that go through `resolver.ts` do access `LLMCredential` via `resolveTenantModelWithFallback` chain (verified).
- `WebhookSubscription.encryptedSecret` uses `encryptionPlugin` (verified — it IS encrypted).

---

## Summary of Findings

| Finding                                                                            | Category                                  | Severity |
| ---------------------------------------------------------------------------------- | ----------------------------------------- | -------- |
| `oauth2TokenExpiresAt` not in `ConnectorConnection` drop list                      | Incomplete model migration                | Low      |
| `ChannelConnection.config.encryptedInboundAuthToken` not a top-level field         | False positive — wrong migration approach | Medium   |
| `WebhookSubscriptionConnector.encryptedClientState` not actually encrypted         | False positive — field name misleading    | Medium   |
| `ServiceNode` has no `tenantId` — auth helper mismatch                             | Design gap                                | Medium   |
| `TriggerRegistration.webhookSecret` missed in additional consumers audit           | Incomplete audit                          | Medium   |
| `hawk`, `kerberos`, `ws_security`, `digest`, `saml` (outbound) — no codebase usage | YAGNI                                     | High     |
| `certificatePinning` addon — no codebase usage                                     | YAGNI / speculative                       | Medium   |
| `jwtWrapping` addon — no codebase usage                                            | YAGNI / speculative                       | Low      |
| "31+ workers need updating" overcounts direct credential access                    | False positive — overcounting             | Low      |
| `embedding-worker` singleton description overstates bypass                         | Partially incorrect                       | Low      |
| `@aws-sdk/signature-v4` not already in monorepo                                    | False positive                            | Low      |
| Redis lock key, TTL formula, component props over-specified                        | Over-specification                        | Low      |
| Line number references already stale                                               | Minor false positive                      | Low      |

---

I'll now write this to the file. Since I cannot run arbitrary code, I'll need to present the complete file content and then confirm it was written. Actually, looking more carefully, I realize I need to use an approach to persist this. The task instruction says "Save findings to..." which implies I should write the file. Let me check if there's a way to invoke a write through the Bash tool... no Bash tool is available.

I'll present the findings in my response and the user can save them, but I realize I need to be transparent that I cannot directly write files with the available tools.

Wait — I re-read the system prompt: "You are a Claude agent, built on Anthropic's Claude Agent SDK." The available tools listed are Glob, Grep, Read, WebFetch, WebSearch. There is no Write tool available. The instruction says "Save findings to..." but I cannot write files.

Let me present the complete findings in my response now, clearly formatted.

Based on thorough codebase research across the model files, worker files, and library usage, here are my findings on the auth profile design document:

---

## Review: False Positives in `docs/plans/2026-03-11-auth-profile-design.md`

I was unable to write directly to the output file as no file-write tool is available. The complete findings are below — copy the content between the code fences to create `docs/plans/2026-03-11-auth-profile-review-false-positives.md`.

**Files examined:**

- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/connector-connection.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/mcp-server-config.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/channel-connection.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/service-node.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/org-proxy-config.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tenant.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tenant-model.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/git-integration.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tenant-service-instance.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/arch-workspace-config.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/connector-config.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/webhook-subscription.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/webhook-subscription-connector.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/sdk-channel.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/llm-credential.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/end-user-oauth-token.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/tool-secret.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/guardrail-provider-config.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/guardrail-policy.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/models/trigger-registration.model.ts`
- `/Users/prasannaarikala/projects/agent-platform/packages/database/src/cascade/cascade-delete.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/execution/llm-wiring.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/services/tool-oauth-service.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/src/channels/security/webhook-signature.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/embedding-worker.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/workers/idp-sync-scheduler.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/search-ai/src/services/llm-config/resolver.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/services/sso/saml-service.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/src/lib/git-credentials.ts`
- `/Users/prasannaarikala/projects/agent-platform/apps/studio/package.json`
- `/Users/prasannaarikala/projects/agent-platform/apps/runtime/package.json`

---

```markdown
# Auth Profile Design — False Positive Review

**Design doc reviewed:** `docs/plans/2026-03-11-auth-profile-design.md`
**Review date:** 2026-03-11

This document audits claims in the Auth Profile design against the actual codebase. Each finding
states whether a design claim is correct, a false positive (wrong), incomplete (missing something),
or speculative (no codebase evidence).

---

## 1. Section 14 — Models Simplified (14): Field-Level Verification

### 1.1 `ConnectorConnection` — Drop List Is Incomplete

**Design claims:** Drop `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider`.

**Finding:** All three fields confirmed in
`packages/database/src/models/connector-connection.model.ts`. However the model also has
`oauth2TokenExpiresAt` (line 59), which is OAuth state and should be dropped alongside the others.
**Minor false positive:** the drop list is incomplete by one field.

**Additional issue:** A comment at lines 70–72 states `encryptedCredentials` is NOT managed by
`encryptionPlugin` — it is pre-encrypted externally by `ConnectionService` using
`findOneAndUpdate`. The migration script must decrypt via the old service path before writing to
Auth Profile's `encryptionPlugin`-managed `encryptedSecrets`. The design does not call this out.

### 1.2 `ChannelConnection` — `encryptedInboundAuthToken` Is Not a Schema Field

**Design claims:** Drop `encryptedCredentials`, `config.encryptedInboundAuthToken`.

**Finding:** The `channel-connection.model.ts` comment at lines 90–93 explicitly states that
`encryptedInboundAuthToken` lives inside `config: Schema.Types.Mixed` and is encrypted manually
by the route layer via `encryptForTenant`/`decryptForTenant`, not via `encryptionPlugin`.
**False positive:** the design treats this as a normal field migration, but because it is embedded
in a `Mixed` subdocument, dropping it requires a different migration approach (query
`config.encryptedInboundAuthToken`, decrypt manually, write to Auth Profile).

### 1.3 `TenantModel.connections[]` — Label Refers to Wrong Model

**Design claims (Consumer table):** `TenantModel.connections[]` drops `credentialId`.

**Finding:** The actual Mongoose model is `TenantModel` in
`packages/database/src/models/tenant-model.model.ts` — this is the LLM model configuration
entity, not the `Tenant` model. The field `connections[].credentialId` is confirmed at line 19.
The design's consumer table label `TenantModel.connections[]` is ambiguous and could be misread
as `Tenant.connections[]` (the Tenant model has no such array). **Correct in substance, misleading
in naming.**

### 1.4 `WebhookSubscriptionConnector.encryptedClientState` — Not Currently Encrypted

**Design claims:** Drop `encryptedClientState` (migrate to Auth Profile with `webhookVerification`
addon).

**Finding:** `packages/database/src/models/webhook-subscription-connector.model.ts` declares
`encryptedClientState: string` (line 29) but `WebhookSubscriptionConnectorSchema` applies **no
`encryptionPlugin`**. The field is named "encrypted" but is stored as plain text. **False
positive:** the migration cannot simply copy this value into Auth Profile's encrypted blob — it
must be treated as plain text input and encrypted for the first time during migration.

### 1.5 `ServiceNode` Has No `tenantId` — Auth Profile Helper Mismatch

**Design claims:** `ServiceNode` drops `encryptedSecrets`, `authConfig`; keeps `authProfileId`.

**Finding:** `packages/database/src/models/service-node.model.ts` confirms `encryptedSecrets`
and `authConfig` exist. However, `ServiceNode` has **no `tenantId` field** — tenant isolation goes
through `projectId → Project.tenantId`. The design's `validateAuthProfileAccess` helper signature
requires `(authProfileId, tenantId, projectId, userId, isAdmin)`, but `ServiceNode` cannot provide
`tenantId` without a DB lookup. **Design gap:** the consumer validation helper does not apply
cleanly to `ServiceNode` without an additional `Project.findOne({ _id: projectId })` to get the
`tenantId`. This is not mentioned in the design.

### 1.6 Missing Consumer: `TriggerRegistration.webhookSecret`

**Design claims:** "Additional Consumers Found in Audit" lists `GitIntegration.webhookSecret` and
`GuardrailPolicy.settings.webhookSecret` as plain-text webhook secrets to migrate.

**Finding:** `packages/database/src/models/trigger-registration.model.ts` line 28 declares
`webhookSecret?: string` with no `encryptionPlugin` on `TriggerRegistrationSchema`. This is also
a plain-text webhook secret that needs migration. **The design's audit is incomplete** — it misses
`TriggerRegistration` as a third consumer with the same problem.

---

## 2. Section 2 — Are All 17 Auth Types Needed?

### 2.1 `hawk` — Zero Codebase Usage, YAGNI

No references to Hawk authentication in any TypeScript source file across `packages/` or `apps/`.
No existing connector, tool, or integration uses Hawk. No customer requirement is cited.
`@hapi/hawk` v7.1.1 would be a dependency added solely for a speculative use case.
**Recommend deferring.** If needed, it can be added as an optional extension type.

### 2.2 `kerberos` — Zero Codebase Usage, Build Risk, YAGNI

No references to Kerberos in the codebase. The `kerberos` npm package requires native C++ bindings
(`libkrb5-dev` in builder, `libgssapi_krb5.so.2` in production image). Adding OS packages to
Dockerfiles for an unproven use case is a non-trivial maintenance burden and introduces OS-specific
build failures. **Recommend deferring entirely.** If an enterprise customer needs Kerberos, add it
as an optional package then.

### 2.3 `ws_security` — Zero Codebase Usage, Large Dependency, YAGNI

No references to SOAP or WS-Security in the codebase. The `soap` npm package is ~8MB. No existing
tool, connector, or integration uses SOAP-based services. **Recommend deferring.** The `soap`
package should not be bundled into `packages/shared` as a lazy dependency without at least one
concrete customer requirement.

### 2.4 `digest` — Zero Codebase Usage, Low Risk but Still YAGNI

No references to HTTP Digest authentication in the codebase. `digest-fetch` is a lightweight
library with lazy loading. Lower risk than `kerberos`/`soap`/`hawk`, but still adds a dependency
with zero current usage. **Recommend deferring.**

### 2.5 `saml` (Outbound Tool Auth) — No Evidence, Confused With Inbound SSO

The only SAML code in the codebase is `apps/studio/src/services/sso/saml-service.ts` — this is
inbound SP-initiated SSO for platform login, which the design correctly excludes from scope. The
design then adds `saml` as an _outbound_ auth type (for tools to authenticate against
SAML-protected APIs) using `@node-saml/node-saml`. There is no evidence any tool, connector, or
integration needs outbound SAML bearer token auth. `@node-saml/node-saml` is already in
`apps/studio/package.json` but for the unrelated inbound SSO use case.
**Speculative / YAGNI.** No customer requirement cited.

---

## 3. Section 3 — Addon Layers: What Is Justified?

### 3.1 `certificatePinning` — Zero Codebase Usage, Speculative

No references to certificate pinning, SPKI fingerprints, or `tls.checkServerIdentity` fingerprint
validation anywhere. Certificate pinning in Node.js requires custom `https.Agent` per request,
breaks standard TLS cert rotation, and is operationally complex. **Speculative.** Recommend
deferring to a security hardening pass.

### 3.2 `jwtWrapping` — Speculative but Lower Risk

No existing tool or connector requires wrapping credentials in a client-signed JWT. This is a
real pattern used by some API gateways but has zero current implementation evidence. **Defer to v2
unless a concrete customer requirement arises.**

### 3.3 `signing`, `webhookVerification`, `proxy` — All Justified

- **`signing`:** HMAC signing for outbound webhooks is already used in
  `apps/runtime/src/channels/security/webhook-signature.ts` and
  `packages/connectors/src/triggers/webhook-handler.ts`. **Justified.**
- **`webhookVerification`:** Multiple channel adapters verify inbound webhooks. **Justified.**
- **`proxy`:** `packages/database/src/models/org-proxy-config.model.ts` has 6 encrypted proxy
  credential fields, confirming org proxy is a first-class existing feature. **Justified.**

---

## 4. Section 14 — Migration Complexity: Worker Count Is Overstated

### 4.1 "31+ Workers Need Updating" Overcounts

**Finding:** There are 28 unique non-test worker files in `apps/search-ai/src/workers/` plus
`delivery-worker.ts` and `inbound-worker.ts` in runtime — 30 total. Grep confirms
`delivery-worker.ts` and `inbound-worker.ts` have **no** `credentialId` or `LLMCredential`
references; they do not resolve credentials. Furthermore, the 7 LLM-use-case workers
(`page-processing`, `noise-detection`, `question-synthesis`, `scope-classification`,
`tree-building`, `taxonomy-setup`, `multimodal`) all delegate credential resolution to
`resolveEnhancedIndexLLMConfig()` / `resolver.ts` — only the resolver needs updating, not each
worker file individually. **False positive:** the "31+" number overstates individual file changes.
Direct credential access requiring per-file dual-read changes is closer to 10–12 workers.

### 4.2 `embedding-worker` Singleton Description Overstates the Bypass

**Design claims (Section 14):** The `embedding-worker` has a "module-level lazy singleton
initialized from `process.env.OPENAI_API_KEY`" that "bypasses the dual-read path entirely."

**Finding:** `apps/search-ai/src/workers/embedding-worker.ts` does have a singleton
`_embeddingProvider` that uses `process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY` as a
fallback. However, the **primary** resolution path `resolveEmbeddingProviderForJob()` calls
`resolveEmbeddingCredentials(provider, tenantId)` which reads from the DB via `LLMCredential`.
The env var singleton is only used when `knowledgeBaseId` is absent. **Partially false positive:**
the bypass exists but is the fallback, not the primary path. The design's statement that it
"bypasses the dual-read path entirely" overstates the issue.

---

## 5. Section 15 — Libraries: Accuracy and YAGNI

### 5.1 `@aws-sdk/signature-v4` — NOT Already in the Monorepo

**Design claims:** `@aws-sdk/signature-v4` — "AWS SDK already in monorepo."

**Finding:** `apps/runtime/package.json` has `@aws-sdk/client-lambda`. `apps/studio/package.json`
has `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`. Neither contains `@aws-sdk/signature-v4`.
**False positive:** this library must be explicitly added. It is not "already in the monorepo."

### 5.2 `soap`, `kerberos`, `@hapi/hawk`, `digest-fetch` — Recommend Separate Package

Even with lazy loading, shipping these in `packages/shared` means they enter the security audit
surface for all consumers, and `kerberos` requires Docker build changes. **Recommendation:**
move these four enterprise/legacy libraries to an optional `packages/auth-enterprise` package
rather than bundling them into `packages/shared`.

---

## 6. Implementation Over-Specification

### 6.1 Redis Lock Key Format Is an Implementation Detail

**Design (Section 5) specifies:** exact Redis lock key `auth-profile:refresh:{tenantId}:{profileId}`.

Lock key naming belongs in code comments, not design docs. This creates a false contract that
makes the design stale if the key format changes (e.g., for multi-region namespacing).

### 6.2 Line Number References Are Already Stale

**Design (Section 8) references:** `llm-wiring.ts:356` as the hook point.

**Finding:** Current codebase has `_wireExecutor` at line 349, not 356. Line numbers in design
docs are immediately stale. Reference method/function names instead.

### 6.3 Component Prop Signatures Belong in Implementation

**Design (Section 7.7)** specifies the exact TypeScript props for `<AuthProfilePicker>` including
parameter names and types. This constrains the UI implementation and becomes stale on the first
refactor. Component APIs belong in the implementation PR.

---

## 7. Confirmed-Correct Claims (Summary)

These design claims were verified accurate against the codebase:

- `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` exist as described and are correct targets
  for deletion.
- `ToolOAuthService.refreshToken()` has no distributed lock — race condition is real (confirmed:
  no Redis lock in `apps/runtime/src/services/tool-oauth-service.ts`).
- `idp-sync-scheduler.ts` repurposes `LLMCredential` for IdP admin credentials via untyped
  `metadata` field (confirmed at lines 221–244).
- `GuardrailPolicy.settings.webhookSecret` is stored as plain text (no `encryptionPlugin` on
  `GuardrailPolicySchema`).
- `GitIntegration.webhookSecret` is stored as plain text (no `encryptionPlugin`).
- `TenantGuardrailProviderConfig.apiKeyCredentialId` field exists.
- `SDKChannel.secretKey` is plain text (no `encryptionPlugin`).
- Three OAuth refresh implementations exist in parallel: `tool-oauth-service.ts`,
  `channel-oauth-service.ts`, and `connection-resolver.ts`.
- `WebhookSubscription.encryptedSecret` IS encrypted via `encryptionPlugin` (correct claim).
- The `searchai` auth type has executor logic in `http-tool-executor.ts` lines 710–805 (confirmed).

---

## Summary Table

| Finding                                                                                                         | Section | Category                 | Severity |
| --------------------------------------------------------------------------------------------------------------- | ------- | ------------------------ | -------- |
| `oauth2TokenExpiresAt` missing from `ConnectorConnection` drop list                                             | §14     | Incomplete               | Low      |
| `ChannelConnection.config.encryptedInboundAuthToken` not a schema field — requires different migration approach | §14     | False positive           | Medium   |
| `WebhookSubscriptionConnector.encryptedClientState` is not actually encrypted                                   | §14     | False positive           | Medium   |
| `ServiceNode` has no `tenantId` — auth helper mismatch                                                          | §14     | Design gap               | Medium   |
| `TriggerRegistration.webhookSecret` missed in additional consumers audit                                        | §14     | Incomplete               | Medium   |
| `hawk` auth type — no codebase usage, no customer requirement                                                   | §2      | YAGNI                    | High     |
| `kerberos` auth type — no codebase usage, Docker build risk                                                     | §2      | YAGNI                    | High     |
| `ws_security` auth type — no codebase usage, 8MB dependency                                                     | §2      | YAGNI                    | High     |
| `digest` auth type — no codebase usage                                                                          | §2      | YAGNI                    | Medium   |
| `saml` outbound auth — confused with existing inbound SSO, no evidence                                          | §2      | YAGNI / false positive   | High     |
| `certificatePinning` addon — no codebase usage                                                                  | §3      | Speculative              | Medium   |
| `jwtWrapping` addon — no codebase usage                                                                         | §3      | Speculative              | Low      |
| "31+ workers need updating" overcounts direct changes                                                           | §14     | False positive           | Low      |
| `embedding-worker` bypass described as "entirely" bypassing DB path                                             | §14     | Partially false positive | Low      |
| `@aws-sdk/signature-v4` claimed as "already in monorepo" — it is not                                            | §15     | False positive           | Low      |
| Redis lock key, TTL formula, component props over-specified                                                     | §5,§7   | Over-specification       | Low      |
| Line number references already stale                                                                            | §8      | Minor false positive     | Low      |
```
