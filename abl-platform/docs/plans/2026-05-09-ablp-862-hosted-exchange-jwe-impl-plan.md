# ABLP-862 Hosted Exchange JWE Implementation Plan

**Ticket**: ABLP-862
**Status**: Runtime implementation complete; production rollout gates pending
**Date**: 2026-05-09
**Last Updated**: 2026-05-11
**Scope**: Add optional JWE confidentiality for hosted_exchange WebSDK bootstrap and SDK session tokens while preserving existing signed-token flows.

---

## 0. As-Built Completion Summary

The Runtime implementation is complete for the ABLP-862 hosted_exchange JWE scope:

- `packages/shared-auth/src/sdk-token-envelope.ts` provides compact JWE wrapping/unwrapping with canonical compact-serialization validation, protected-header validation, purpose checks, opaque key handles, size budgets, and generic key-resolution/decrypt failures.
- `apps/runtime/src/services/identity/sdk-jwe-keyring.ts` and `sdk-jwe-runtime-config.ts` provide Runtime JWE capability and key-provider abstractions without exposing raw key material through normal metadata serialization.
- `apps/runtime/src/services/identity/sdk-token-envelope-runtime.ts` wraps existing signed bootstrap/session tokens and verifies by decrypting first, then delegating to the existing signed-token verifiers.
- `apps/runtime/src/services/identity/sdk-session-token-auth.ts` is the Runtime-owned SDK session auth wrapper used by HTTP auth and WebSocket auth. It enforces channel policy after verification and rejects signed hosted_exchange sessions for `jwe_required` channels.
- `apps/runtime/src/routes/sdk-customer-sessions.ts`, `sdk-init.ts`, `middleware/auth.ts`, `websocket/sdk-handler.ts`, and `server.ts` are wired for JWE issuance, refresh, HTTP auth, WebSocket auth, and boundary size checks.
- `apps/runtime/src/routes/sdk-token-diagnostics.ts` adds an authenticated, project-scoped, rate-limited, audited diagnostics endpoint that returns coarse envelope information only. It does not expose claims, key IDs, key existence, decrypted payloads, or token material.
- Scenario coverage is locked by `apps/runtime/src/__tests__/identity/sdk-jwe-hidden-scenarios.test.ts` and `apps/runtime/src/__tests__/e2e/sdk-jwe-acceptance.e2e.test.ts`.

Verified locally:

```bash
pnpm --filter @agent-platform/shared-auth build
pnpm --filter @agent-platform/runtime build
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.config.ts src/__tests__/identity/sdk-jwe-hidden-scenarios.test.ts src/__tests__/identity/sdk-token-envelope-runtime.test.ts src/__tests__/identity/sdk-token-envelope-policy-scenarios.test.ts
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts src/__tests__/e2e/sdk-jwe-acceptance.e2e.test.ts
./tools/run-semgrep.sh
```

Current coverage result:

- Fast hidden matrix: 124 passing scenarios.
- Public API JWE acceptance E2E: 16 passing scenarios.
- Semgrep: 0 findings.

Deployment gates still required before enabling a regulated production channel:

- Record production-like browser, Node, CDN/proxy/ALB, nginx, and customer-ingress HTTP/WebSocket header-budget evidence.
- Confirm production log/access-log redaction for `Sec-WebSocket-Protocol`, `X-SDK-Token`, `bootstrapToken`, and diagnostic request bodies.
- Confirm operational owner and SLA for emergency key rotation or key removal.

## 1. Current State

The hosted_exchange flow is already the preferred authentication model for customer-hosted WebSDK integrations:

1. Customer backend authenticates the end user.
2. Customer backend calls `POST /api/v1/sdk/customer-sessions` with `X-SDK-Channel-Secret`.
3. Runtime returns a short-lived, single-use `bootstrapToken`.
4. Browser sends that `bootstrapToken` to `POST /api/v1/sdk/init`.
5. Runtime issues a short-lived SDK session token.
6. Browser authenticates `/ws/sdk` using `Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>`.

The remaining ABLP-862 gap is confidentiality, not integrity:

| Token                              | Current Format                                    | Integrity | Confidentiality                  | Sensitive Fields                                                                                |
| ---------------------------------- | ------------------------------------------------- | --------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| hosted_exchange bootstrap artifact | custom HMAC-signed `base64url(payload).signature` | Yes       | No                               | `verifiedUserId`, `channelArtifact`, `userContext.customAttributes`                             |
| SDK session token                  | HS256 JWS JWT                                     | Yes       | No                               | `verifiedUserId`, `channelArtifact`, `userContext.customAttributes`, tenant/project/channel IDs |
| WebSocket auth transport           | `Sec-WebSocket-Protocol` header                   | N/A       | Header/token visible in DevTools | token string                                                                                    |

JWE adds value because Florida Blue may send sensitive session attributes. The goal is to make those token payloads opaque to the browser, browser extensions, DevTools payload decoding, screenshots, and accidental frontend/proxy logging.

## 2. Design Decisions

| #    | Decision                                                                                                                                                                                                                                                                         | Rationale                                                                                                                                                                                                                           | Alternatives Rejected                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| D-1  | Use nested tokens: JWE wraps the existing signed token.                                                                                                                                                                                                                          | Reuses existing validation, replay protection, refresh logic, and claims checks. Encryption becomes an envelope, not a rewrite of auth.                                                                                             | Replacing HMAC/JWS validation with JWE-only payload trust.                                              |
| D-2  | Start with hosted_exchange only.                                                                                                                                                                                                                                                 | This is where verified user data and customer attributes enter the browser. Public-key, preview, and share flows remain compatible.                                                                                                 | Encrypting every SDK token in the first phase.                                                          |
| D-3  | Separate token format, customer policy, and environment capability. Format is `signed` or `jwe`; project/channel policy is `inherit`, `signed`, `jwe_preferred`, or `jwe_required`; Runtime capability says whether JWE can actually be issued and verified in this environment. | Prevents rollout/rollback ambiguity without adding many env flags. `jwe_preferred` may downgrade during controlled rollback; `jwe_required` fails closed and never mints or accepts signed hosted_exchange tokens for that channel. | Boolean `useJwe` flags, ambiguous `jwe` mode, or environment-wide policy flags embedded in route logic. |
| D-4  | Use compact JWE with `alg: 'dir'` and `enc: 'A256GCM'` for Runtime-issued tokens.                                                                                                                                                                                                | Runtime mints and consumes these tokens; symmetric AEAD is simpler, fast, and operationally smaller than RSA for this internal envelope.                                                                                            | Per-channel RSA key pairs for Runtime-to-Runtime tokens.                                                |
| D-5  | Always include `kid` in the JWE protected header.                                                                                                                                                                                                                                | Enables active/previous key rotation from day one.                                                                                                                                                                                  | Single unnamed encryption secret.                                                                       |
| D-6  | Keep signing and encryption keys separate.                                                                                                                                                                                                                                       | Signing proves integrity; JWE provides confidentiality. Key compromise blast radius should not overlap.                                                                                                                             | Reusing `AUTH_SDK_SESSION_SIGNING_SECRET` or `AUTH_SDK_BOOTSTRAP_SIGNING_SECRET` as JWE material.       |
| D-7  | Decrypt first, then verify the inner signed token.                                                                                                                                                                                                                               | Prevents trusting unauthenticated plaintext and keeps legacy validation as the source of truth.                                                                                                                                     | Parsing decrypted payload directly into session/auth state.                                             |
| D-8  | Preserve policy semantics on refresh.                                                                                                                                                                                                                                            | A `jwe_preferred` session may downgrade only during documented rollback. A `jwe_required` hosted_exchange session must fail closed instead of returning readable JWS.                                                               | Refresh always returns legacy signed JWT.                                                               |
| D-9  | Resolve envelope behavior through a policy service.                                                                                                                                                                                                                              | A single policy resolver prevents route-level drift between customer-session, init, refresh, HTTP auth, and WebSocket auth.                                                                                                         | Each route independently checking config and channel fields.                                            |
| D-10 | Version the envelope contract from the first release.                                                                                                                                                                                                                            | Future formats such as KMS-backed keys, per-tenant keys, or server-side context references can be added without guessing token meaning.                                                                                             | Inferring behavior only from segment count and `typ`.                                                   |
| D-11 | Keep key-provider abstraction independent of key source.                                                                                                                                                                                                                         | First release can use env/Vault keyring, while later releases can use KMS/HSM without changing token callers.                                                                                                                       | Baking JSON keyring parsing into token encryption functions.                                            |
| D-12 | Treat JWE as confidentiality, not data minimization.                                                                                                                                                                                                                             | Sensitive attributes may still need a server-side context vault later to reduce token replay blast radius and token size.                                                                                                           | Assuming encrypted client-carried claims are always sufficient.                                         |
| D-13 | Keep encrypted token size defaults conservative until transport limits are measured end-to-end.                                                                                                                                                                                  | WebSocket subprotocol and HTTP header limits may fail before Runtime validation sees the request. The first release must prove browser, Node, proxy, CDN, ALB, and customer ingress budgets before raising limits.                  | Defaulting encrypted session headers to 12KB based only on local Runtime parsing.                       |
| D-14 | Build diagnostics and log redaction before JWE issuance.                                                                                                                                                                                                                         | Opaque bearer tokens can still be replayed if logged, and diagnostic endpoints can become key/config oracles unless scoped and audited.                                                                                             | Adding support diagnostics after production rollout.                                                    |
| D-15 | Put the enforce/prefer/signed choice on project/channel endpoint settings, not env vars.                                                                                                                                                                                         | A single Runtime environment can serve channels with different customer/regulatory needs. Environment config should only describe operational readiness: key provider, verified budgets, and safe diagnostics.                      | Per-environment default policy as the primary customer security control.                                |
| D-16 | Treat SDK token envelope policy as live operational config, not deployment-versioned execution settings.                                                                                                                                                                         | Hosted_exchange endpoint security must be adjustable for rollback, incident response, and customer rollout without publishing a new deployment settings version.                                                                    | Resolving JWE policy from `settingsVersionId` or freezing it into project settings snapshots.           |

## 3. Target Token Formats

### Bootstrap Artifact

Legacy:

```text
base64url(JSON.stringify(SDKBootstrapArtifactPayload)).hmac_signature
```

JWE:

```text
JWE(legacy_bootstrap_artifact)
```

Protected header:

```json
{
  "alg": "dir",
  "enc": "A256GCM",
  "kid": "sdk-jwe-2026-05",
  "typ": "abl-sdk-bootstrap+jwe",
  "cty": "abl-sdk-bootstrap",
  "epv": 1
}
```

### SDK Session Token

Legacy:

```text
HS256 JWT with aud=sdk-session, iss=abl-platform
```

JWE:

```text
JWE(legacy_sdk_session_jwt)
```

Protected header:

```json
{
  "alg": "dir",
  "enc": "A256GCM",
  "kid": "sdk-jwe-2026-05",
  "typ": "abl-sdk-session+jwe",
  "cty": "JWT",
  "epv": 1
}
```

Detection:

| Segment Count | Meaning                                      |
| ------------- | -------------------------------------------- |
| 2             | Legacy bootstrap artifact                    |
| 3             | Legacy SDK JWS JWT                           |
| 5             | Compact JWE, decrypt then verify inner token |

Segment count is format detection only. It must not decide rollout policy or authorization behavior; those decisions come from the Runtime policy resolver after tenant/project/channel context is known.

## 4. Key Management Design

Add a Runtime-owned SDK JWE keyring. Initial key source can be environment/Vault config; the resolver API must allow KMS-backed keys later.

```typescript
export type SDKTokenEnvelopeKind = 'sdk_bootstrap' | 'sdk_session';

export type SDKTokenEnvelopeMode = 'signed' | 'jwe';
export type SDKTokenEnvelopeResolvedPolicyMode = 'signed' | 'jwe_preferred' | 'jwe_required';
export type SDKTokenEnvelopeConfiguredPolicyMode = 'inherit' | SDKTokenEnvelopeResolvedPolicyMode;

export interface SDKJweKeyMetadata {
  kid: string;
  active: boolean;
  notBefore?: Date;
  notAfter?: Date;
  purposes: SDKTokenEnvelopeKind[];
}

export interface SDKJweKeyHandle {
  metadata: SDKJweKeyMetadata;
  /**
   * Opaque imported key handle. Implementations may use CryptoKey, KeyObject,
   * or a provider-specific handle, but must not expose raw key bytes through
   * normal object spreading, JSON serialization, or logging.
   */
  keyHandle: unknown;
}

/** Internal config parser output only; never returned by providers. */
export interface SDKJweConfigKeyDescriptor extends SDKJweKeyMetadata {
  material: Uint8Array; // 32 bytes for A256GCM direct encryption
}

export interface SDKJweKeyring {
  activeKid: string;
  keys: SDKJweConfigKeyDescriptor[];
}

export interface SDKJweKeyProvider {
  getActiveEncryptionKey(input: {
    purpose: SDKTokenEnvelopeKind;
    tenantId?: string;
    projectId?: string;
    channelId?: string;
  }): Promise<SDKJweKeyHandle>;
  getDecryptionKey(input: {
    kid: string;
    purpose: SDKTokenEnvelopeKind;
    tenantId?: string;
    projectId?: string;
    channelId?: string;
  }): Promise<SDKJweKeyHandle | null>;
  listSafeKeyMetadata(): Promise<SDKJweKeyMetadata[]>;
}
```

Provider strategy:

| Provider              | Release | Behavior                                                                                            |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `config-json-keyring` | Phase 2 | Reads base64url 32-byte keys from env/Vault-backed config. No committed JSON defaults.              |
| `tenant-keyring`      | Future  | Resolves keys by tenant/project while preserving the same provider interface.                       |
| `kms-dek-provider`    | Future  | Uses KMS/HSM to unwrap or derive data-encryption keys, then returns in-memory key handles with TTL. |

Key provider caches must have max size, TTL, and eviction. They must cache only opaque imported key handles or safe metadata, never raw config JSON or plaintext key material in logs. Key handles must be non-serializable in diagnostics and must never be included in logger context.

Runtime capability configuration:

```typescript
auth: {
  sdk: {
    jwe: {
      provider: 'disabled' | 'local_ephemeral' | 'vault' | 'kms'; // default disabled outside local/dev
      keyRef?: string; // Vault path, KMS alias/key id, or local dev key reference
      maxSignedBootstrapBytes: number; // default 4096
      maxEncryptedBootstrapBytes: number; // default 8192
      maxSignedSessionBytes: number; // default 4096 until infra budget is verified
      maxEncryptedSessionBytes: number; // default 4096 until infra budget is verified
      verifiedHeaderBudgetBytes?: number; // documented ingress/browser/proxy limit
      diagnosticsEnabled: boolean; // default true only when auth/audit/rate limits are wired
    }
  }
}
```

The environment exposes capability, not customer policy:

```typescript
export interface RuntimeSdkJweCapability {
  supported: boolean; // provider ready, redaction ready, diagnostics safe
  canIssueBootstrap: boolean; // supported plus bootstrap size/budget ready
  canIssueSession: boolean; // supported plus SDK session header budget ready
  canVerify: boolean; // decrypt-capable key provider ready
  verifiedHeaderBudgetBytes?: number;
  blockedReason?:
    | 'provider_disabled'
    | 'key_provider_unavailable'
    | 'transport_budget_unverified'
    | 'diagnostics_unready'
    | 'redaction_unverified';
}
```

Minimal env mapping:

| Env Var                     | Config Path             | Notes                                                                     |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `AUTH_SDK_JWE_KEY_PROVIDER` | `auth.sdk.jwe.provider` | `disabled`, `local_ephemeral`, `vault`, or `kms`; default local/dev only. |
| `AUTH_SDK_JWE_KEY_REF`      | `auth.sdk.jwe.keyRef`   | Vault path or KMS alias/key id. Required for `vault` or `kms`.            |

Token-size limits and verified header budgets should come from the environment capability profile or deployment config, not one-off env vars. Emergency overrides may exist for operators, but they are not part of the steady-state public configuration contract.

Do not add environment variables for `verifyEnabled`, bootstrap issuance, session issuance, or default hosted_exchange policy. Runtime derives verify/issue behavior from capability plus project/channel policy.

Project/channel policy shape:

```typescript
Project.sdkDefaults.hostedExchangeTokenEnvelopePolicy?: SDKTokenEnvelopeConfiguredPolicyMode; // default inherit -> signed
SDKChannel.config.sdkTokenEnvelopePolicy?: SDKTokenEnvelopeConfiguredPolicyMode; // default inherit
```

`sdkDefaults.hostedExchangeTokenEnvelopePolicy` is the live project-level SDK operational default. It is resolved from current project settings at token issue/verify time and is intentionally not read from deployment `settingsVersionId` or stored in project settings version snapshots.
Project defaults accept explicit `inherit`, which behaves like unset and resolves to signed unless a channel override applies.
Channel-level `sdkTokenEnvelopePolicy` is valid only for hosted_exchange channels; anonymous/public-key SDK channels must not persist JWE policy because Runtime intentionally ignores it for non-customer bootstrap flows.

Resolution order:

1. Channel endpoint policy wins.
2. Project default policy applies when channel policy is `inherit` or absent.
3. Runtime environment capability can block JWE issuance/verification, but it must not silently weaken `jwe_required`.
4. If effective policy is `jwe_required` and capability is not ready, issuance and signed-token verification fail closed with sanitized errors.
5. If effective policy is `jwe_preferred` and capability is not ready, signed fallback is allowed and the resolver records the capability-blocked reason.

Keyring rules:

- Active key encrypts new tokens.
- Active and previous non-expired keys may decrypt.
- Decryption must fail closed when `kid` is unknown, expired, disabled, or not allowed for the token purpose.
- Rotation requires no token invalidation while previous keys remain available for at least `max(SDK session TTL, bootstrap TTL)`.
- Rotation is multi-pod safe only when all Runtime pods have the new keyring before `activeKid` changes. Rollout order: deploy keyring containing old + new keys, verify decrypt across pods, then flip `activeKid`.
- Emergency rotation supports immediate removal of compromised keys; existing tokens using removed keys fail closed and must re-authenticate.
- JWE protected headers must not include `zip`; compression is forbidden to avoid compression side-channel risk when token claims contain user-controlled attributes.
- `maxEncryptedSessionBytes` must not be raised above 4096 until browser, Node, WebSocket subprotocol, nginx, ALB/CDN, and any customer ingress limits are measured and recorded in the rollout evidence. If sensitive context cannot fit within the verified header budget, use the future server-side context store instead of raising the limit blindly.

Policy semantics:

| Policy          | Issue Behavior                                                                                                        | Accept Behavior                                                                                                   | Rollback Behavior                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `signed`        | Mint signed tokens only.                                                                                              | Accept legacy signed tokens. JWE may be accepted only when Runtime capability can verify it, but is not required. | No JWE-specific rollback.                                                                                                                 |
| `jwe_preferred` | Mint JWE when Runtime capability is ready; may mint signed when capability is blocked during staged rollout/rollback. | Accept both signed and JWE when Runtime capability can verify JWE.                                                | Normal rollback may stop JWE issuance by changing channel/project policy or capability while continuing to verify existing JWE until TTL. |
| `jwe_required`  | Mint JWE or fail closed; never downgrade to signed.                                                                   | Reject signed hosted_exchange bootstrap/session tokens after resolving channel policy.                            | Rollback must keep Runtime JWE capability healthy or intentionally break new sessions; no silent signed downgrade.                        |

Because policy is live operational config, changing a hosted_exchange channel or inherited project default from `signed` to `jwe_required` immediately rejects already-issued signed hosted_exchange sessions before token TTL. Operators should roll out with `jwe_preferred` or channel-scoped canaries before using `jwe_required` when preserving active browser sessions matters.

Rollback controls:

| Scenario                                                          | Required Setting                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Prepare environment for JWE                                       | configure key provider, verified transport budget, redaction, diagnostics, and `canVerify=true`                    |
| Enable encrypted hosted_exchange bootstrap/session for a channel  | set channel/project policy to `jwe_preferred` or `jwe_required`; Runtime capability must report issue-ready        |
| Stop minting new encrypted tokens during `jwe_preferred` rollback | downgrade channel/project policy to `signed` or keep `jwe_preferred` while capability reports blocked              |
| Roll back a `jwe_required` channel                                | change the channel/project policy with customer approval, or keep capability healthy, or intentionally fail closed |
| Emergency disable after key compromise                            | disable or rotate the key provider; affected JWE channels fail closed and browsers re-authenticate                 |

## 5. File-Level Change Map

### New Files

| File                                                               | Purpose                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `packages/shared-auth/src/sdk-token-envelope.ts`                   | Pure JWE envelope primitives and types. No Runtime config access.                                       |
| `packages/shared/src/sdk-bootstrap-envelope.ts`                    | Pure bootstrap envelope primitives that wrap/unwrap existing `signSdkBootstrapArtifact` output.         |
| `apps/runtime/src/services/identity/sdk-jwe-keyring.ts`            | Runtime config-backed keyring resolver and validation.                                                  |
| `apps/runtime/src/services/identity/sdk-token-envelope-runtime.ts` | Runtime-owned unwrap/sign wrappers that combine keyring resolution with existing token verifiers.       |
| `apps/runtime/src/services/identity/sdk-token-envelope-policy.ts`  | Resolves bootstrap/session envelope mode from channel policy, project defaults, and Runtime capability. |
| `apps/runtime/src/routes/sdk-token-diagnostics.ts`                 | Privileged, rate-limited diagnostic metadata endpoint with no decrypted claims.                         |
| `docs/guides/xo-vs-apv2-auth-comparison.md`                        | Required stakeholder/security comparison doc referenced by ABLP-862.                                    |

### Modified Files

| File                                                                           | Change                                                                                                                  | Risk   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/config/src/schemas/auth.schema.ts`                                   | Add `auth.sdk.jwe` config schema.                                                                                       | Medium |
| `packages/config/src/env-mapping.ts`                                           | Add minimal JWE capability env mappings for key provider and key reference only.                                        | Low    |
| `packages/config/src/validation/json-layer-checks.ts`                          | Block raw JWE key material from JSON config defaults; allow only provider names and non-secret key references.          | High   |
| `packages/config/src/constants/sensitive-paths.ts`                             | Add any JWE key references or provider-specific key material paths to the sensitive path registry.                      | High   |
| `packages/shared/src/sdk-bootstrap-artifact.ts`                                | Add verification path or exported helper that accepts both signed and JWE-wrapped bootstrap artifacts.                  | Medium |
| `packages/shared-auth/src/purpose-jwt.ts`                                      | Keep existing JWS signing/verification as the inner-token source of truth.                                              | Medium |
| `packages/shared-auth/src/types/index.ts`                                      | Add optional `tokenEnvelope` (`signed` or `jwe`) to `SDKSessionTokenPayload`.                                           | Low    |
| `packages/database/src/models/Project.ts` or equivalent project settings model | Add optional hosted_exchange default token envelope policy if project-level inheritance is supported.                   | Medium |
| SDK channel config model/schema                                                | Add optional `config.sdkTokenEnvelopePolicy` with `inherit`, `signed`, `jwe_preferred`, or `jwe_required`.              | Medium |
| `apps/runtime/src/routes/sdk-customer-sessions.ts`                             | Wrap hosted_exchange bootstrap tokens when configured.                                                                  | Medium |
| `apps/runtime/src/routes/sdk-init.ts`                                          | Unwrap bootstrap tokens through Runtime wrappers; resolve token envelope from channel policy; preserve mode on refresh. | High   |
| `apps/runtime/src/middleware/auth.ts`                                          | Use Runtime-owned JWE-capable SDK session verifier wrapper.                                                             | Medium |
| `apps/runtime/src/websocket/sdk-handler.ts`                                    | Use Runtime-owned JWE-capable SDK session verifier wrapper; no transport change.                                        | Medium |
| `packages/shared-auth/src/rbac/role-permissions.ts`                            | Add a narrow `sdk_token:diagnose` permission if the diagnostics route is implemented.                                   | Medium |
| `apps/runtime/src/__tests__/auth/sdk-bootstrap-auth.integration.test.ts`       | Add hosted_exchange JWE coverage.                                                                                       | Medium |
| `packages/shared-auth/src/__tests__/jwt-verify.test.ts`                        | Add SDK JWE session token unit tests.                                                                                   | Medium |
| `packages/shared/src/__tests__/sdk-bootstrap-artifact.test.ts`                 | Add bootstrap JWE unit tests.                                                                                           | Medium |
| `apps/runtime/src/__tests__/channels/ws-sdk-handler.test.ts`                   | Add WebSocket auth with JWE SDK token.                                                                                  | Medium |

No destructive migration is required. Existing projects and channels inherit the legacy signed behavior because absent policy is treated as `inherit -> signed`. If project-level defaults are added, backfill is optional and should leave existing documents unset.

Package boundary rule:

- Shared packages may implement cryptographic primitives and typed interfaces, but they must not read Runtime config, env vars, Vault, or keyring secrets.
- Runtime owns all key resolution and exposes local wrappers such as `verifyRuntimeSdkSessionToken()` and `unwrapRuntimeSdkBootstrapArtifact()`.
- Existing `verifySDKSessionToken(token, signingSecret)` remains a signed-token verifier; it must not silently gain hidden Runtime JWE dependencies.

## 6. Future-Ready Architecture Contract

The implementation must introduce three small seams so future work extends the system instead of replacing it.

### 6.1 Envelope Policy Resolver

All Runtime paths must call the same resolver before issuing tokens:

```typescript
export interface SDKTokenEnvelopePolicyInput {
  tenantId: string;
  projectId: string;
  channelId: string;
  bootstrapType: 'public_key' | 'studio_preview' | 'studio_share' | 'customer';
  channelAuthMode: 'anonymous' | 'hosted_exchange';
  projectDefaultPolicy?: SDKTokenEnvelopeConfiguredPolicyMode;
  runtimeCapability: RuntimeSdkJweCapability;
  channelConfig?: Record<string, unknown>;
}

export interface SDKTokenEnvelopePolicy {
  policyMode: SDKTokenEnvelopeResolvedPolicyMode;
  bootstrapMode: SDKTokenEnvelopeMode;
  sessionMode: SDKTokenEnvelopeMode;
  requiresEncryptedBootstrap: boolean;
  requiresEncryptedSession: boolean;
  reason:
    | 'project_default'
    | 'channel_override'
    | 'legacy_default'
    | 'unsupported_bootstrap_type'
    | 'keyring_unavailable'
    | 'transport_budget_unverified'
    | 'diagnostics_unready'
    | 'redaction_unverified'
    | 'strict_required';
}
```

Rules:

- `hosted_exchange` is the only bootstrap type eligible for JWE in the first release.
- Channel `config.sdkTokenEnvelopePolicy` overrides the project default only when `channelAuthMode === 'hosted_exchange'`.
- Project default applies when the channel policy is `inherit` or absent.
- Absent project and channel policy resolves to `signed` for backward compatibility.
- `signed` policy never requires encryption.
- `jwe_preferred` policy issues JWE when Runtime capability is healthy, but may downgrade to signed when capability is blocked during staged rollout or rollback.
- `jwe_required` policy never downgrades. If key provider, redaction, diagnostics, or transport budgets cannot support JWE, token issuance fails closed with a sanitized 503/401 instead of minting signed tokens.
- Signed hosted_exchange bootstrap/session tokens are accepted for backward compatibility only when the resolved policy is `signed` or `jwe_preferred`. They must be rejected when the resolved policy is `jwe_required`.
- Environment capability is a safety gate, not a policy override. Runtime may issue signed only for `jwe_preferred`; `jwe_required` fails closed when capability is missing.
- `/sdk/customer-sessions`, `/sdk/init`, `/sdk/refresh`, HTTP SDK auth, and WebSocket SDK auth must not duplicate policy logic.

### 6.2 Envelope Versioning

JWE protected headers use `epv: 1` for the envelope protocol version. Version 1 means:

- Compact JWE only.
- `alg='dir'`.
- `enc='A256GCM'`.
- No `zip`.
- Plaintext is an existing signed token, not raw claims.

Future envelope versions must be accepted only in an explicit compatibility branch with tests. Unknown `epv` fails closed with the same generic auth error as other invalid encrypted tokens.

### 6.3 Runtime Wrapper Contract

Runtime should expose local wrappers with explicit dependencies:

```typescript
export interface RuntimeSdkTokenEnvelopeDeps {
  keyProvider: SDKJweKeyProvider;
  getSessionSigningSecret(): string;
  getBootstrapSigningSecret(tenantId?: string): string;
  getJweCapability(): RuntimeSdkJweCapability;
  maxEncryptedBootstrapBytes: number;
  maxEncryptedSessionBytes: number;
}
```

Wrappers must return typed results instead of throwing raw crypto errors across route boundaries:

```typescript
type RuntimeEnvelopeResult<T> =
  | { success: true; data: T; envelope: SDKTokenEnvelopeMode; safeKidAlias?: string; epv?: number }
  | { success: false; status: 400 | 401 | 503; code: string; logReason: string };
```

Routes convert failures to sanitized client responses and log only `logReason`, token kind, safe key alias when approved for internal logs, tenant/project/channel after verification, and request ID. Failure logs must not reveal unknown-vs-expired-vs-disabled `kid` distinctions to user-visible diagnostics.

## 7. Implementation Phases

### Phase 0: Transport, Logging, and Diagnostic Safety Preflight

**Goal**: Verify bearer-token transport limits and redaction before any JWE issuance can be enabled.

Tasks:

1. Measure the maximum safe SDK session token length across:
   - browser WebSocket subprotocol construction;
   - Node.js HTTP parser/header limits;
   - Runtime WebSocket upgrade handling;
   - nginx/ALB/CDN/customer ingress;
   - local and production log pipelines.
2. Keep `maxEncryptedSessionBytes` at 4096 until the measured budget proves a higher value is safe. If a JWE token cannot fit, do not raise the limit without security/ops approval; move sensitive attributes to the future server-side context store instead.
3. Verify `Sec-WebSocket-Protocol`, `X-SDK-Token`, and request bodies containing `bootstrapToken` are redacted in all expected access logs and diagnostic logs.
4. Define the privileged diagnostic workflow before encrypted token rollout:
   - require platform auth plus project permission such as `sdk_token:diagnose`;
   - rate limit by tenant/project/user;
   - audit every invocation;
   - return only coarse metadata and never decrypted claims;
   - do not reveal whether a `kid` exists to non-super-admin operators.

Exit criteria:

- Header budget evidence is recorded in the rollout notes.
- Runtime capability must report JWE unsupported until log redaction is verified.
- Diagnostic route requirements are approved by security reviewers.

Rollback:

- No runtime behavior changed; this is a deployment prerequisite.

### Phase 1: Token Envelope Foundation

**Goal**: Add JWE wrapping/unwrapping helpers without changing production behavior.

Tasks:

1. Add `jose` dependency to `packages/shared-auth` and `packages/shared` if primitives live there; run `pnpm install` to update the lockfile. Runtime already depends on `jose`.
2. Implement `isCompactJwe(token)` by segment count and protected-header parse.
3. Implement `wrapCompactToken(params)`:
   - accept only an opaque provider-returned key handle, not raw key material from route code;
   - set `kid`, `typ`, `cty`;
   - set `epv: 1`;
   - reject `zip` and never emit compressed JWE;
   - rely on `jose`/CSPRNG-generated IVs only; never accept caller-supplied IVs;
   - reject empty plaintext;
   - enforce max plaintext/ciphertext size.
4. Implement `unwrapCompactToken(params)`:
   - parse and validate protected header without logging token material before key lookup/decrypt where possible;
   - reject unsupported `alg`, `enc`, `typ`, `cty`, `epv`, and `zip`;
   - resolve key by `kid` and purpose;
   - decrypt;
   - return inner compact token string only.
5. Add unit tests for round trip, wrong key, unknown `kid`, tampered ciphertext, bad `typ`, and oversize inputs.

Exit criteria:

- `packages/shared-auth` exposes SDK token envelope helpers.
- `packages/shared` exposes bootstrap envelope helpers.
- Existing signed-token tests pass unchanged.
- New tests prove sensitive plaintext does not appear in the JWE string.
- New primitives are exported from package indexes and package `exports` maps where needed.
- Unknown `epv`, missing `epv`, or unsupported `epv` fails closed.

Rollback:

- Remove new helpers and dependency additions; no runtime behavior changed.

### Phase 2: Runtime JWE Capability and Key Provider

**Goal**: Add validated Runtime JWE capability detection without making environment variables the customer policy source.

Tasks:

1. Add `auth.sdk.jwe` config schema with minimal env mappings for key provider and key reference only. Token budgets come from environment capability profile or deployment config.
2. Implement `sdk-jwe-keyring.ts`.
3. Validate startup/config reads:
   - if provider is `disabled`, Runtime capability reports JWE unsupported and no keyring is required;
   - if provider is `local_ephemeral`, allow only local/dev/test unless explicitly approved;
   - if provider is `vault` or `kms`, key reference is required and at least one decrypt-capable key must resolve;
   - if Runtime capability reports issue-ready, active `kid` and 32-byte effective A256GCM key material/handle are required;
   - reject duplicate `kid`, malformed base64url, expired active keys, or keys with no purpose.
4. Convert parsed config keys into opaque key handles at the provider boundary. Raw `material` must be local to config parsing/import only and must not be returned from `SDKJweKeyProvider`.
5. Add raw JWE key material paths, provider-specific secret paths, and sensitive key references to restricted JSON-layer config validation, production checks, and config dump/debug redaction tests.
6. Add a lightweight health/config diagnostic for privileged operators that reports safe key aliases, purpose coverage, and active/previous counts without exposing key material or creating a `kid` existence oracle for project admins.
7. Add Runtime wrappers:
   - `unwrapRuntimeSdkBootstrapArtifact(token)` decrypts JWE only when Runtime capability can verify, maps all decrypt failures to generic auth failure, then returns the inner signed artifact.
   - `verifyRuntimeSdkSessionToken(token)` decrypts JWE only when Runtime capability can verify, then calls the existing `verifySDKSessionToken(inner, signingSecret)`.
   - `signRuntimeSdkSessionToken(payload, envelopeMode)` signs the inner JWS and wraps only when the resolved project/channel policy and Runtime capability allow it.
8. Add `sdk-token-envelope-policy.ts` with policy tests covering legacy default, project default, channel override, unsupported bootstrap types, missing capability, `jwe_preferred`, and `jwe_required` behavior.

Exit criteria:

- Runtime boots with JWE unsupported when no key provider env vars are present.
- Runtime capability reports unsupported when provider is disabled.
- Runtime fails closed when a channel/project requires JWE but capability is blocked.
- Unit tests cover keyring parsing and validation.
- JSON-layer checks fail if key material appears in committed config files.
- Config dump/debug tests prove key material is redacted.
- Provider tests prove returned key handles cannot be JSON-serialized into raw key bytes.
- Policy resolver tests prove no signed downgrade when channel policy requires JWE.

Rollback:

- For `jwe_preferred`, change project/channel policy to `signed` or allow capability-blocked signed fallback while keeping verification available until TTL.
- For `jwe_required`, keep capability available or intentionally fail closed; do not expect signed fallback.
- For emergency disablement, disable or rotate the key provider; affected JWE channels must re-authenticate.

### Phase 3: Encrypt hosted_exchange Bootstrap Tokens

**Goal**: Make hosted_exchange `bootstrapToken` opaque when the resolved policy issues JWE.

Tasks:

1. In `sdk-customer-sessions.ts`, continue creating the existing signed customer artifact.
2. Resolve hosted_exchange envelope policy from project default, channel config, and Runtime capability, not from request input:
   - channel `config.sdkTokenEnvelopePolicy` wins when present;
   - live project `sdkDefaults.hostedExchangeTokenEnvelopePolicy` is the fallback;
   - absent project/channel policy resolves to `signed`;
   - JWE issuance still requires `runtimeCapability.canIssueBootstrap=true`.
3. If the resolved policy is `jwe_preferred`, wrap the signed artifact with purpose `sdk_bootstrap` when capability is ready; otherwise signed fallback is allowed during rollout/rollback.
4. If the resolved policy is `jwe_required`, wrap the signed artifact with purpose `sdk_bootstrap` or fail closed. Do not return a signed bootstrap token when capability is blocked.
5. Add response metadata only if safe and useful, for example `tokenEnvelope: 'jwe'`; do not include key IDs in browser-facing responses unless required.
6. In `sdk-init.ts`, unwrap JWE bootstrap tokens before `verifySdkBootstrapArtifact`.
7. After verifying a signed hosted_exchange bootstrap artifact, resolve the channel policy. If the channel is `jwe_required` and the incoming envelope was signed, reject it with the same generic invalid-bootstrap response used for other auth failures.
8. Increase `SDKInitRequestSchema.bootstrapToken` max length to `auth.sdk.jwe.maxEncryptedBootstrapBytes` when JWE verification is enabled; keep signed-token caps for legacy validation.
9. Preserve existing replay guard: `consumeSdkBootstrapJti` runs after inner artifact verification exactly as today.
10. Add integration tests for encrypted hosted_exchange bootstrap issuance, decoded-segment confidentiality, `/sdk/init` acceptance/rejection, oversize failures, legacy signed acceptance for `signed` and `jwe_preferred`, and signed rejection for `jwe_required`.

Exit criteria:

- hosted_exchange bootstrap token can be encrypted without changing WebSDK config.
- Legacy signed bootstrap flow remains accepted for `signed` and `jwe_preferred` policies; `jwe_required` rejects it by design.
- Replay protection still rejects reuse.

Rollback:

- For `jwe_preferred`, change project/channel policy to `signed` or allow capability-blocked signed fallback; signed bootstrap tokens continue to verify.
- For `jwe_required`, keep JWE bootstrap capability available or intentionally fail closed; signed bootstrap fallback is not allowed.
- Already-issued JWE bootstrap tokens expire in 5 minutes and may fail if keyring is removed.

### Phase 4: Encrypt hosted_exchange SDK Session Tokens

**Goal**: Ensure the SDK session token returned by `/sdk/init` and `/sdk/refresh` is opaque for hosted_exchange.

Tasks:

1. Add `tokenEnvelope?: 'signed' | 'jwe'` to `SDKSessionTokenPayload`.
2. Carry the resolved project/channel `tokenEnvelope` policy in `ResolvedSdkIssueContext`; do not infer SDK session encryption only from whether the incoming bootstrap token had 5 segments.
3. When policy resolves to `jwe_preferred` and `runtimeCapability.canIssueSession=true`, set `tokenEnvelope: 'jwe'` on the inner SDK session payload and wrap the signed SDK session token with purpose `sdk_session`. If capability is blocked, signed fallback is allowed only for `jwe_preferred`.
4. When policy resolves to `jwe_required`, set `tokenEnvelope: 'jwe'` and wrap the signed SDK session token or fail closed. Do not mint a signed SDK session token when capability is blocked.
5. Add Runtime-owned SDK token verification wrappers to accept:
   - legacy 3-part signed JWT;
   - 5-part JWE wrapping a valid signed JWT when Runtime capability can verify JWE.
6. After verifying a signed hosted_exchange SDK session token, resolve channel policy where possible. If the channel is `jwe_required`, reject signed session tokens instead of accepting legacy compatibility.
7. Update `/sdk/refresh` so encrypted session token in or `payload.tokenEnvelope === 'jwe'` means encrypted refreshed token out when capability remains ready; if capability is blocked for rollback, signed downgrade is allowed only for `jwe_preferred` and only when documented and tested.
8. Ensure `middleware/auth.ts`, `sdk-handler.ts`, and any API route using SDK session auth go through the Runtime wrapper, not raw `verifySDKSessionToken`.
9. Enforce `auth.sdk.jwe.maxEncryptedSessionBytes` anywhere SDK session tokens are accepted from headers or WebSocket protocols.
10. Add tests for encrypted SDK session issuance, refresh preservation, `jwe_preferred` rollback downgrade, `jwe_required` fail-closed rollback, WebSocket auth, `X-SDK-Token` auth, signed-token rejection for `jwe_required`, and token-string confidentiality.

Exit criteria:

- Hosted exchange can run customer-session -> init -> refresh -> WebSocket with encrypted tokens.
- Public-key, preview, and share tokens remain backward compatible.
- No code path downgrades hosted_exchange JWE sessions to plaintext JWS during refresh except documented `jwe_preferred` rollback behavior.
- `jwe_required` refresh never returns signed SDK session tokens.

Rollback:

- For `jwe_preferred`, change project/channel policy to `signed` or allow capability-blocked signed fallback, and keep JWE verification available until existing SDK session TTL expires.
- For `jwe_required`, keep JWE capability ready or intentionally fail closed; never mint signed SDK session replacements.
- If emergency key removal is required, affected browsers must re-authenticate through hosted_exchange.

### Phase 4.5: Diagnostics and Support UX

**Goal**: Replace claim-decoding support workflows with safe, server-side diagnostics before payloads become opaque. Phase 0 redaction and diagnostic policy are prerequisites; this phase wires the production implementation.

Tasks:

1. Add sanitized diagnostics to token issuance logs:
   - envelope mode;
   - token kind;
   - `kid` only after redaction policy confirms it is acceptable for internal logs;
   - `epv`;
   - tenant/project/channel;
   - bootstrap type;
   - no raw token and no decrypted payload.
2. Add a privileged internal diagnostic route/helper that can report safe token metadata from a supplied token:
   - require platform authentication and project permission, for example `sdk_token:diagnose`;
   - apply route-level rate limiting and audit every invocation with tenant/project/channel/operator identity;
   - segment count;
   - coarse envelope/header metadata, for example `typ`, `cty`, `epv`, and whether the format is supported;
   - coarse policy state, for example `signed_allowed`, `jwe_preferred`, or `jwe_required`;
   - do not reveal whether a specific `kid` exists, is active, expired, or decrypt-capable to ordinary project admins;
   - reserve deeper keyring visibility for super-admin/internal break-glass diagnostics with audit logging;
   - never return decrypted claims.
3. Ensure diagnostic code never logs the submitted token, decrypted inner token, decrypted payload, raw key material, or full keyring.
4. Update support/runbook docs to avoid jwt.io-style debugging for hosted_exchange JWE.
5. Verify log redaction for `Sec-WebSocket-Protocol`, `X-SDK-Token`, and `bootstrapToken` in local/proxy/ALB/nginx logging paths before production enablement.

Exit criteria:

- Support can diagnose envelope/key/config mismatches without decoding token claims.
- Diagnostic output is not a token oracle: unauthorized users receive no signal, ordinary project admins receive only coarse policy/format information, and privileged keyring diagnostics are audited.
- Security review confirms no logs include opaque tokens, decrypted payloads, or key material.

Rollback:

- Diagnostics are additive; leave them enabled.

### Phase 5: Project/Channel Control and Studio Surface

**Goal**: Allow project admins to enable JWE per hosted_exchange endpoint, with optional project defaults and clear capability status.

Tasks:

1. Add optional `config.sdkTokenEnvelopePolicy: 'inherit' | 'signed' | 'jwe_preferred' | 'jwe_required'` to SDK channel config parsing. Reject it unless the effective channel auth mode is `hosted_exchange`.
2. Add optional live project default `sdkDefaults.hostedExchangeTokenEnvelopePolicy` with the same enum. Default is unset/`inherit`. This default is operational SDK config and is not part of deployment-pinned project settings versions.
3. Update `sdk-channels` create/update validation to accept the channel setting only for `auth.mode='hosted_exchange'`.
4. Add Studio UI control in the SDK channel configuration tab with explicit option copy:
   - `inherit`: use project default, or signed when no project default is set;
   - `signed`: readable signed tokens, existing compatibility behavior;
   - `jwe_preferred`: encrypted when available, signed fallback allowed during rollout/rollback;
   - `jwe_required`: encrypted required, signed tokens rejected, misconfiguration fails closed.
5. Add project settings UI only if product wants a default across many hosted_exchange endpoints; per-channel control is sufficient for the first regulated customer.
6. Show a clear state indicator for the resolved policy and current capability readiness: signed, encrypted preferred, encrypted required, or blocked by missing key/transport budget/redaction/diagnostics.
7. Disable or warn on `jwe_required` until Phase 0 capability evidence is complete for the deployment environment.
8. Ensure anonymous public-key channels cannot opt into hosted_exchange-only JWE accidentally unless the broader SDK encryption policy is explicitly expanded.

Exit criteria:

- Existing channels default to signed unless a project/channel policy says otherwise.
- Hosted exchange channels can opt into preferred or required JWE without server redeploy.
- Studio and Runtime agree on the project/channel config shape.
- Studio makes rollback semantics visible so admins understand that `jwe_required` will fail closed rather than falling back to signed tokens.

Rollback:

- Set channel config back to `signed` or `jwe_preferred` before disabling JWE capability if signed fallback is acceptable.
- For a regulated `jwe_required` channel, do not disable JWE capability unless the intended outcome is fail-closed session interruption.

### Phase 6: Documentation, Security Review, and Rollout

**Goal**: Close the ABLP-862 documentation/security-review acceptance criteria.

Tasks:

1. Create `docs/guides/xo-vs-apv2-auth-comparison.md`.
2. Document:
   - hosted_exchange vs public-key flow;
   - signed token vs JWE-wrapped signed token;
   - WebSocket subprotocol transport;
   - what JWE does and does not protect;
   - operational key rotation and emergency key removal.
3. Add security review notes:
   - browser can still see opaque token strings;
   - JWE prevents payload inspection, not token theft/replay;
   - replay is bounded by existing single-use bootstrap and SDK token TTL;
   - CSP/XSS hardening remains required.
4. Produce rollout checklist:
   - complete Phase 0 header-budget, redaction, and diagnostic safety gates;
   - deploy JWE verification capability first with project/channel policies still inheriting signed behavior;
   - configure key provider in staging;
   - enable a staging hosted_exchange channel with `jwe_preferred`;
   - verify WebSocket and refresh;
   - move the Florida Blue hosted_exchange channel to `jwe_required` only after transport-budget evidence, log redaction, and rollback ownership are approved.

Exit criteria:

- Docs exist and are linked from ABLP-862.
- Security review has a concrete comparison artifact.
- Rollout and rollback are explicit for `signed`, `jwe_preferred`, and `jwe_required`.

Rollback:

- Documentation-only phase; no runtime rollback.

### Phase 7: Future Server-Side Sensitive Context Store

**Goal**: Provide a later path for deployments where carrying sensitive attributes in encrypted browser tokens is still too much exposure or too large.

This phase is not required for ABLP-862, but the JWE implementation must not block it.

Future design:

- Store sensitive hosted_exchange `customAttributes` in a tenant-scoped, TTL-bound server-side context record.
- Token carries only an opaque `sessionContextRef` plus integrity claims.
- Context records are scoped by `tenantId`, `projectId`, `channelId`, `verifiedUserId`, and `jti`.
- Reads require verified SDK session identity and expire no later than the SDK session TTL.
- Erasure and audit hooks must cover the context store.

Why this matters:

- JWE prevents casual payload inspection, but stolen opaque tokens can still replay within TTL.
- Server-side context references reduce token size and keep sensitive attributes out of browser-carried artifacts entirely.
- The policy and wrapper seams above should allow a `jwe_ref` or `server_context` mode later without changing WebSDK public API shape.

## 8. Testing Strategy

Unit tests:

- JWE helper round trips.
- Header validation: `kid`, `typ`, `cty`, `alg`, `enc`.
- Envelope version validation: `epv=1` accepted, missing/unknown versions rejected.
- Encryption helper accepts only provider-owned opaque key handles; callers cannot pass raw key bytes or caller-supplied IVs.
- Key provider metadata serialization never includes raw key material.
- Wrong key, unknown key, expired key, disabled purpose.
- Size limits before and after encryption.
- Legacy signed bootstrap/session verification still passes.
- JWE with `zip` in the protected header is rejected.
- Runtime wrappers decrypt JWE and then delegate to existing signed-token verifiers.
- Raw shared-auth signed-token verifier does not read Runtime config or keyring state.
- Policy resolver covers legacy defaults, project defaults, channel overrides, missing capability, explicit JWE-required mode, and unsupported bootstrap types.
- Policy resolver proves `jwe_required` never downgrades to `signed` when keyring, redaction, diagnostics, or transport prerequisites are missing.

Integration tests:

- hosted_exchange customer session returns encrypted bootstrap.
- encrypted bootstrap exchanges for encrypted SDK session.
- refresh preserves JWE.
- rollback mode keeps JWE verification capability available while project/channel policy or capability blocks new JWE issuance for `jwe_preferred`.
- `jwe_required` rollback fails closed or keeps issuance alive; it never mints signed replacements.
- WebSocket connects with encrypted SDK session token.
- SDK HTTP routes accept encrypted `X-SDK-Token`.
- Tampering any JWE segment fails closed.
- Removing previous key after TTL fails old tokens and allows new tokens with active key.
- Project/channel policy controls issuance; signed bootstrap and signed SDK session tokens cannot downgrade a channel configured for `jwe_required`.
- Legacy signed bootstrap and SDK session tokens remain accepted for `signed` and `jwe_preferred` policies where compatibility is intended.
- Encrypted bootstrap and session tokens over configured size limits fail deterministically.
- Header and WebSocket subprotocol budget tests cover conservative defaults and fail deterministically before oversize tokens hit downstream handlers.
- Diagnostics require auth, permission, rate limiting, and audit logging.
- Diagnostics expose only safe metadata, never decrypted claims, and do not reveal `kid` existence to ordinary project admins.

Security regression tests:

- Returned bootstrap token string does not contain `verifiedUserId`.
- Decoded JWE header does not contain sensitive claims.
- Returned SDK session token string does not contain custom attributes.
- No server logs include plaintext token, decrypted payload, key material, or full `kid` keyring.
- Config validation fails if raw JWE key material appears in JSON-layer config files.
- Diagnostic endpoint responses are indistinguishable for unknown, expired, or disabled `kid` values unless the caller is a privileged audited operator.
- Redaction covers `Sec-WebSocket-Protocol`, `X-SDK-Token`, `bootstrapToken`, and diagnostic request bodies before Runtime capability can report issue-ready.

Required commands before PR:

```bash
pnpm build
pnpm test
pnpm --filter @agent-platform/shared-auth test:fast
pnpm --filter @agent-platform/runtime test:sdk-auth
./tools/run-semgrep.sh
```

## 9. Observability and Audit

Add structured, sanitized events:

| Event                          | Labels                                                                          | Sensitive Data Policy                         |
| ------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------- |
| `sdk_jwe_encrypt_success`      | token kind, safe kid hash/alias, tenantId, projectId, channelId                 | no token, no payload, no raw key material     |
| `sdk_jwe_decrypt_success`      | token kind, safe kid hash/alias, tenantId/projectId when available after verify | no token, no payload, no raw key material     |
| `sdk_jwe_decrypt_failure`      | coarse reason, token kind, policy mode                                          | no token, no payload, no key-existence oracle |
| `sdk_jwe_keyring_invalid`      | coarse reason, safe kid hash/alias                                              | no key material                               |
| `sdk_token_envelope_mode`      | signed vs jwe, bootstrap type, policy mode                                      | no token                                      |
| `sdk_token_policy_resolved`    | tenantId, projectId, channelId, bootstrap/session mode, policy mode, reason     | no token, no payload                          |
| `sdk_token_diagnostic_invoked` | tenantId, projectId, channelId, operatorId, outcome, rate-limit bucket          | no token, no payload, no raw header           |

Alert candidates:

- JWE decrypt failure rate above 5% for a project over 10 minutes.
- Unknown `kid` failures after a rotation.
- JWE enabled but no active encryption key.
- Diagnostic route failures or rate-limit trips above normal support baseline.

## 10. Rollout Plan

1. Complete Phase 0 in staging and production-like ingress: record measured HTTP header and WebSocket subprotocol budgets, verify token redaction, and approve diagnostic access controls.
2. Merge Phase 1 and Phase 2 with JWE disabled and conservative `maxEncryptedSessionBytes=4096`.
3. Deploy to staging with `AUTH_SDK_JWE_KEY_PROVIDER` and `AUTH_SDK_JWE_KEY_REF` configured so Runtime capability reports `canVerify`, `canIssueBootstrap`, and `canIssueSession`.
4. Enable a staging hosted_exchange channel with `config.sdkTokenEnvelopePolicy='jwe_preferred'`.
5. Run customer-session -> init -> refresh -> WebSocket evidence, including max-size and proxy/header-budget evidence.
6. Move the staging channel to `jwe_required` and verify signed bootstrap/session rejection plus fail-closed behavior when capability is intentionally blocked.
7. Enable the Florida Blue channel in `jwe_preferred` first if compatibility observation is required.
8. Move the Florida Blue channel endpoint to `jwe_required` only after the owner signs off that rollback means keeping JWE capability healthy or intentionally failing closed, never falling back to signed tokens.
9. Observe failure rates for one SDK session TTL.
10. Consider adding a project default of `jwe_preferred` for projects with many hosted_exchange channels; consider `jwe_required` only for channels or projects with explicit regulated-customer approval.

## 11. Future-Ready Extension Points

1. **KMS-backed keys**: replace config keyring resolver with KMS decrypt/generate data key flow without changing token envelope callers.
2. **Per-tenant keys**: resolve keyring by tenant/project instead of global Runtime keyring.
3. **Asymmetric customer encrypted claims**: add `RSA-OAEP-256` for customer-provided private claims later; keep separate from Runtime-owned hosted_exchange token wrapping.
4. **Ephemeral WebSocket tickets**: add a 30-60 second single-use `/api/v1/sdk/ws-token` if stakeholders require a smaller WebSocket replay window. This is separate from JWE confidentiality.
5. **Broader SDK encryption**: allow preview/share/public-key flows to opt into JWE once hosted_exchange proves stable.
6. **Server-side sensitive context references**: move PHI/PII attributes out of browser-carried tokens entirely while keeping JWE for token confidentiality.
7. **Envelope version 2**: reserve a compatibility branch for future token envelopes such as KMS-wrapped CEKs, tenant-scoped keys, or detached context references.

## 12. Decisions and Remaining Open Items

Decisions:

1. Florida Blue policy belongs on the hosted_exchange channel endpoint. Launch may use `jwe_preferred` for one observation window, but the target regulated state is channel-level `jwe_required`.
2. First release uses Runtime-level key provider capability, not per-channel key material. The provider interface must allow tenant/project keys later.
3. Browser responses may include coarse `tokenEnvelope: 'jwe'` for observability, but never `kid`, key aliases, or diagnostic hints.
4. Sensitive `customAttributes` should still be minimized. JWE is confidentiality for browser-carried tokens, not a replacement for the future server-side context store.
5. `sdk_token:diagnose` starts as platform/admin-only with audited break-glass for deeper keyring diagnostics.

Remaining open items:

1. What is the required emergency rotation SLA for Florida Blue?
2. What is the smallest measured encrypted SDK session token size that fits every deployed WebSocket and HTTP header hop with margin?
3. Should the first production rollout use per-channel `jwe_required` only, or should project-level defaults be enabled for a wider set of hosted_exchange channels after the first observation window?

## 13. Acceptance Criteria Mapping

| ABLP-862 Criterion                                                                                           | Plan Coverage                      |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| hosted_exchange can optionally accept JWE-encrypted bootstrap tokens                                         | Phases 1-3                         |
| Existing HMAC-signed token flows remain backward compatible except channels explicitly set to `jwe_required` | Phases 1, 3, 4 tests               |
| Key rotation is supported                                                                                    | Phase 2 keyring and rotation rules |
| Sensitive token payload data is encrypted and not client-readable                                            | Phases 3-4 security tests          |
| Strict regulated-customer policy cannot downgrade to signed tokens                                           | Phases 2-5 policy resolver/tests   |
| Encrypted token transport limits are verified before rollout                                                 | Phase 0 and Phase 10 rollout       |
| WebSocket auth approach is documented for security review                                                    | Phase 6                            |
| Auth comparison/security analysis documentation completed                                                    | Phase 6                            |
