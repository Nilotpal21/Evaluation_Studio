# Auth Profile — Phase 3: Enterprise Types, Addons & Cleanup (2-3 Sprints)

> **Master design doc:** [`2026-03-11-auth-profile-design.md`](./2026-03-11-auth-profile-design.md)
> **Phase 1 (Connector OAuth):** [`2026-03-11-auth-profile-phase1-core.md`](./2026-03-11-auth-profile-phase1-core.md)
> **Phase 2 (Credential Consolidation):** [`2026-03-11-auth-profile-phase2-consolidation.md`](./2026-03-11-auth-profile-phase2-consolidation.md)

---

## Prerequisites

- Phase 2 stable in production
- All workers confirmed reading `authProfileId` (not `credentialId`) for 30+ days
- Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for preceding 14 days
- `EncryptionService` multi-key support deployed
- Full MongoDB snapshot taken with documented retention policy
- All consumers from Phase 2 have `authProfileId` populated
- Dual-read fallback path exercised < 1% of total credential resolutions

---

## Goal

Add enterprise auth types and remaining addons for customers with specialized protocol requirements. Execute final cleanup: drop legacy credential models and fields, remove obsolete environment variables. After Phase 3, the platform has a single, universal credential system.

---

## 1. Deferred Auth Types

5 enterprise auth types, each with distinct operational requirements:

| `authType`    | `config` (summary)                                                    | `encryptedSecrets`                                     | Library                | Rationale / Notes                                                                                                                              |
| ------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `digest`      | `algorithm`, `qop?`, `realm?`, `opaque?`                              | `username`, `password`                                 | `digest-fetch` (lazy)  | HTTP Digest Auth. Zero current codebase usage. Simple lazy-loaded library, minimal risk.                                                       |
| `kerberos`    | `realm`, `kdcHost`, `kdcPort`, `servicePrincipal`, `spnegoEnabled`    | `keytab` (base64), `principal?`, `password?`           | `kerberos` (npm)       | Enterprise SSO. Native C++ bindings require `libkrb5-dev` in Docker builds. Service tickets 8-10h TTL, renewable to 7d. Cache in Redis.        |
| `saml`        | `entityId`, `idpEntityId`, `idpSsoUrl`, `assertionConsumerServiceUrl` | `idpCertificate`, `spPrivateKey?`, `spCertificate?`    | `@node-saml/node-saml` | Outbound SAML assertion acquisition. Only inbound SSO exists today; no outbound SAML evidence in codebase. Assertions have `NotOnOrAfter` TTL. |
| `hawk`        | `algorithm`, `ext?`, `dlg?`, `timestampSkewSec?`                      | `id`, `key`                                            | `@hapi/hawk`           | MAC-based HTTP auth. Zero codebase usage. Lightweight library.                                                                                 |
| `ws_security` | `mode`, `passwordType?`, `addTimestamp?`, `signatureAlgorithm?`       | `username?`, `password?`, `privateKey?`, `publicCert?` | `soap`                 | SOAP WS-Security. ~8MB dependency. Only applicable to SOAP XML, not REST. Zero current usage.                                                  |

### Request Application

| `authType`    | Request Mutation                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `digest`      | Uses `digest-fetch` as HTTP client wrapper. Initial unauthenticated request then 401 then resubmit. |
| `kerberos`    | Obtain service ticket, base64-encode GSSAPI/SPNEGO token, set `Authorization: Negotiate`.           |
| `saml`        | Obtain SAML assertion from IdP, set `Authorization: SAML` + base64(assertion).                      |
| `hawk`        | Compute MAC via `@hapi/hawk`. Set `Authorization: Hawk id="...", ts="...", nonce="...", mac="..."`. |
| `ws_security` | Modifies SOAP envelope XML via `soap` library `setSecurity()`. Not applicable to REST HTTP calls.   |

### Token Refresh Strategies

| Auth Type  | Refresh Strategy                                                                            |
| ---------- | ------------------------------------------------------------------------------------------- |
| `kerberos` | Service tickets (8-10h TTL, renewable to 7d). Cache in Redis. Re-obtain from KDC on expiry. |
| `saml`     | SAML assertions have `NotOnOrAfter` TTL. Obtain fresh assertion from IdP. Cache in Redis.   |

### Docker Build Changes Required

**`kerberos` npm package** requires native C++ bindings:

1. Add `libkrb5-dev` to all Dockerfile `apt-get install` lines in `apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`
2. Consider multi-stage build to keep production image lean (install dev deps in build stage, copy compiled bindings)
3. Test on both `linux/amd64` and `linux/arm64` (Apple Silicon CI)

**`soap` library** (~8MB) should be lazy-loaded to avoid impacting startup time for non-SOAP workloads.

---

## 2. Deferred Addons

### `certificatePinning`

```typescript
certificatePinning?: {
  pins: Array<{
    fingerprint: string;      // SPKI SHA-256
    expiresAt?: Date;
  }>;
  mode: 'strict' | 'report-only';
  reportUrl?: string;         // report-only mode sends violations here
};
```

**Rationale for deferral:** Zero codebase usage. Breaks standard TLS certificate rotation operationally --- requires coordinated pin updates before cert renewal. `report-only` mode mitigates this but adds monitoring complexity.

### `jwtWrapping`

```typescript
jwtWrapping?: {
  algorithm: 'RS256' | 'ES256' | 'RS384';
  issuer: string;
  audience: string;
  expiresInSeconds: number;
  claims?: Record<string, unknown>;
  // privateKey in encryptedSecrets (as jwtPrivateKey)
};
```

**Rationale for deferral:** Real pattern (service-to-service JWT) but zero current customer requirement.

### Additional Invalid Combinations (Phase 3)

| Combination                    | Reason                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `ws_security` + any HTTP addon | `ws_security` operates on SOAP XML, not HTTP; HTTP-layer addons are irrelevant |
| `ssh_key` + `jwtWrapping`      | SSH key is not used in HTTP requests                                           |

---

## 3. `packages/auth-enterprise` Optional Package

**Recommendation:** Create a separate workspace package for enterprise auth libraries.

```
packages/auth-enterprise/
  package.json          # depends on: kerberos, @node-saml/node-saml, @hapi/hawk, digest-fetch, soap
  src/
    digest-auth.ts      # digest-fetch wrapper
    kerberos-auth.ts    # kerberos ticket acquisition + caching
    saml-auth.ts        # SAML assertion acquisition
    hawk-auth.ts        # Hawk MAC computation
    ws-security-auth.ts # SOAP WS-Security
    index.ts            # lazy exports
```

**Benefits:**

- Core platform does not bundle ~8MB+ of unused enterprise dependencies
- Docker builds only include native C++ bindings (`kerberos`) when explicitly opted in
- Security audit surface isolated to tenants that need enterprise auth
- Can be deployed as an optional sidecar or feature module

**Dockerfile update pattern:**

```dockerfile
# Only in enterprise-enabled builds:
COPY packages/auth-enterprise/package.json packages/auth-enterprise/package.json
# Add to pnpm install step
RUN apt-get install -y libkrb5-dev  # only for kerberos support
```

Remember to add the `COPY` line to all relevant Dockerfiles (`apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`, `apps/studio/Dockerfile`).

---

## 4. Multi-Agent Credential Propagation

### Handoff

When Agent A hands off to Agent B:

- Agent B's `authRequirements` are checked against the user's existing `oauth2_token` profiles
- Missing authorizations are requested (inline consent or session block depending on `consent` mode)
- Credentials are NOT copied --- Agent B resolves its own `authProfileId` references at runtime

### Delegate

When Agent A delegates a task to Agent B:

- Agent A's user context (including userId for personal token resolution) propagates to Agent B
- Agent B resolves credentials using the delegating user's identity
- Audit trail records the delegation chain: `delegatedBy: [agentA.sessionId]`

### Fan-Out

When a supervisor fans out to multiple agents:

- Each agent independently resolves its `authProfileId` references
- Personal tokens are resolved per the originating user's identity
- Shared tokens are resolved per the project scope
- No credential sharing between fan-out branches

---

## 5. Import/Export Auth Mapping

### Export

Auth Profile metadata (never secrets) included in `ProjectManifestV2.metadata`:

```typescript
required_auth_profiles: Array<{
  name: string;
  authType: string;
  scope: 'tenant' | 'project';
  connector?: string;
  category?: string;
  connectionMode?: 'shared' | 'per_user';
  config: Record<string, unknown>; // non-secret config only
  referencedBy: string[]; // agent/tool names
}>;
```

- `ConnectionsAssembler` exports `authProfileName` (resolved from ID). Strips `authProfileId`.
- `env-var-scanner.ts` extended to scan for `auth:` references in DSL.
- Encrypted secrets are NEVER exported.

### Import

Import flow gains an **auth mapping step**:

1. Preview extracts auth profile requirements from DSL `auth:` references
2. Preview response includes `auth_mapping` with candidates from existing Auth Profiles
3. UI presents mapping table: "Required: production-openai (api_key) -> [Select Existing v] / [Create New]"
4. Apply endpoint accepts `authProfileMapping` to remap references

### Cross-Tenant Import

All `authProfileId` references are stripped. Auth mapping wizard presents requirements for user to create/link in the target tenant. Encrypted secrets cannot be decrypted cross-tenant.

### Post-Import Doctor

Extended to check Auth Profiles:

- `provisioning_required.auth_profiles` --- profiles referenced but not found
- Distinguishes `shared` (needs pre-existing token) from `per_user` (needs only app credentials)

---

## 6. Voice Lifecycle Auth

### LiveKit Call Duration Caching

Voice service instances (Deepgram, ElevenLabs, Twilio, LiveKit) use `TenantServiceInstance.authProfileId` (wired in Phase 2). Phase 3 adds:

- **Call duration credential caching:** For active voice calls, cache decrypted credentials for the call duration (max 4 hours) to avoid repeated decryption during streaming
- **Cache key:** `auth-profile:voice:{tenantId}:{callId}`
- **Invalidation:** Call end event, auth profile rotation event, or 4-hour hard TTL
- **LiveKit-specific:** LiveKit room tokens are short-lived (configurable, typically 10 minutes). Auth Profile provides the API key to generate room tokens; the room token itself is not stored in Auth Profile.

---

## 7. Rotation Batch Job

Re-encrypt all `encryptedSecrets` with new master key version.

### Process

1. Read current `EncryptionService` config to get new key version
2. Query all Auth Profiles with `encryptionKeyVersion < currentVersion`
3. For each profile (batched, 100 at a time):
   a. Decrypt `encryptedSecrets` with old key
   b. Re-encrypt with new key
   c. Update `encryptionKeyVersion`
   d. Store old ciphertext in `previousEncryptedSecrets` with `rotationGracePeriodMs`
4. Log progress to audit trail

### Operational Notes

- Run as a one-time migration job, not a recurring cron
- Acquire per-profile distributed lock to prevent concurrent rotation + refresh
- Batch size configurable via `AUTH_PROFILE_ROTATION_BATCH_SIZE` (default 100)
- Estimated time: ~1 minute per 10,000 profiles (dominated by encryption overhead)
- **Rollback:** `previousEncryptedSecrets` remains valid during `rotationGracePeriodMs`

---

## 8. Cleanup

### Drop `credentialId` from Consumer Models

Remove legacy credential reference fields from all 14 consumer models listed in the master design doc Section 14. This includes:

| Model                           | Fields Dropped                                                 |
| ------------------------------- | -------------------------------------------------------------- |
| `ConnectorConnection`           | `encryptedCredentials`, `oauth2RefreshToken`, `oauth2Provider` |
| `MCPServerConfig`               | `encryptedAuthConfig`, `encryptedEnv`                          |
| `ChannelConnection`             | `encryptedCredentials`, `config.encryptedInboundAuthToken`     |
| `ServiceNode`                   | `encryptedSecrets`, `authConfig`                               |
| `OrgProxyConfig`                | 6 encrypted fields                                             |
| `TenantModel.connections[]`     | `credentialId`                                                 |
| `TenantGuardrailProviderConfig` | `apiKeyCredentialId`                                           |
| `GitIntegration`                | `credentials.secretId`, `webhookSecret`                        |
| `TenantServiceInstance`         | `encryptedApiKey`, `encryptedConfig`                           |
| `ArchWorkspaceConfig`           | `encryptedApiKey`, `encryptedEndpoint`                         |
| `ConnectorConfig` (SearchAI)    | `oauthTokenId`                                                 |
| `WebhookSubscription`           | `encryptedSecret`                                              |
| `WebhookSubscriptionConnector`  | `encryptedClientState`                                         |
| `SDKChannel`                    | `secretKey`                                                    |

### Delete Legacy Collections

Drop these MongoDB collections entirely:

1. `LLMCredential`
2. `EndUserOAuthToken`
3. `ToolSecret`

### Remove Obsolete Environment Variables

Remove from all Dockerfiles and deployment configs:

- `OAUTH_PROVIDER_<NAME>_CLIENT_ID/SECRET` (Studio)
- `CHANNEL_OAUTH_SLACK_*`, `CHANNEL_OAUTH_MSTEAMS_*`, `CHANNEL_OAUTH_META_*` (Runtime, 11 vars)
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_AI_API_KEY`, `AZURE_OPENAI_*` (Runtime)

### Remove Dual-Read Code

Strip all dual-read fallback paths. Every credential resolution goes through `authProfileService.resolve()` only.

### Remove Feature Flag

Remove `AUTH_PROFILE_ENABLED` flag and all conditional branches. Auth Profile is the only credential system.

---

## 9. Go/No-Go Gate

Phase 3 cleanup is irreversible at the service level. The go/no-go gate MUST be documented and approved before starting cleanup.

### Required Conditions

- [ ] All workers confirmed reading `authProfileId` (not `credentialId`) in production metrics for 30+ days
- [ ] Zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for preceding 14 days
- [ ] Full MongoDB snapshot confirmed with retention policy (minimum 90 days retention)
- [ ] Dual-read fallback path exercised 0% of total credential resolutions for 14+ days
- [ ] All 3 legacy collections (`LLMCredential`, `EndUserOAuthToken`, `ToolSecret`) have zero new writes for 30+ days
- [ ] Canary tenant fully on Auth Profile with zero legacy fallbacks for 30+ days
- [ ] Migration rollback procedure tested on staging environment

### Rollback Warning

**Phase 3 cleanup is irreversible at the service level.** If a production bug surfaces post-Phase 3:

- **Service-level rollback is NOT possible** --- legacy collections and fields have been deleted
- **Recovery path:** Full tenant restore from MongoDB backup
- **Implication:** Ensure backup retention policy covers the bake period (recommend 90 days minimum)
- **Mitigation:** Execute cleanup in stages (fields first, then collections) with 7-day bake between each

### Recommended Cleanup Order

1. **Week 1:** Remove dual-read code paths (deploy new code that only reads `authProfileId`)
2. **Week 2:** Drop legacy fields from consumer models (MongoDB `$unset` operations)
3. **Week 3:** Drop `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections
4. **Week 4:** Remove obsolete env vars from Dockerfiles and deployment configs
5. **Week 5:** Remove `AUTH_PROFILE_ENABLED` feature flag

Each step has a 7-day bake period before proceeding to the next.

---

## 10. Dependencies on Other Phases

### Depends on Phase 1

- `AuthProfile` model and schema (the foundation)
- `AuthProfileService` core methods
- Project-scoped CRUD API
- OAuth flow infrastructure
- GDPR cascade
- Health check and alerting

### Depends on Phase 2

- All 12 core auth types implemented
- All 3 core addons activated
- All consumer models migrated with `authProfileId`
- All workers updated with dual-read
- `EncryptionService` multi-key support
- Migration scripts executed
- Go/no-go criteria met

---

## 11. Deliverables Checklist

1. [ ] 5 enterprise auth types implemented with Zod validation
2. [ ] `packages/auth-enterprise` optional workspace package created
3. [ ] Docker build changes for `kerberos` native bindings
4. [ ] 2 deferred addons (`certificatePinning`, `jwtWrapping`) implemented
5. [ ] Additional invalid combination rules enforced
6. [ ] Multi-agent credential propagation (handoff, delegate, fan-out)
7. [ ] Import/export auth mapping step in preview + apply
8. [ ] Post-import doctor extended for Auth Profiles
9. [ ] Voice lifecycle auth with call duration caching
10. [ ] Rotation batch job for re-encryption
11. [ ] Drop `credentialId` fields from all 14 consumer models
12. [ ] Delete `LLMCredential`, `EndUserOAuthToken`, `ToolSecret` collections
13. [ ] Remove obsolete env vars from all Dockerfiles
14. [ ] Remove dual-read code paths
15. [ ] Remove `AUTH_PROFILE_ENABLED` feature flag
16. [ ] Full test suite for enterprise types, addons, and propagation
17. [ ] Go/no-go gate documented and approved before cleanup begins
