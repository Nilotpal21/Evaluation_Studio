# Auth Profile Phase 3 — Deferred Auth Types & Addons Implementation Plan

**Date:** 2026-03-13
**Status:** Draft
**Prerequisites:** Phase 2 stable in production (30+ days), zero `AUTH_PROFILE_DECRYPTION_FAILED` errors for 14 days, `EncryptionService` multi-key deployed, full MongoDB snapshot with 90-day retention.
**Scope:** 5 enterprise auth types (`digest`, `kerberos`, `saml`, `hawk`, `ws_security`), 2 deferred addons (`certificatePinning`, `jwtWrapping`), feature flags, testing, rollback.

---

## Dependencies

This plan depends on the following:

1. **Auth Profile Phase 2** — Must be stable in production for 30+ days.
2. **Infrastructure Gaps plan (Gap 1)** — `EncryptionService` multi-key must be deployed for rotation support.

Plans that depend on this plan: None (this is the final phase).

This plan is **independent** of the consent plans (GAP-3.1 through GAP-3.4). Consent flows work with all auth types (core and enterprise) as long as `AUTH_PROFILE_CONSENT_ENABLED=true`. Enterprise type flags only control profile creation, not consent mechanics.

---

## Existing Schema Acknowledgment

The following already exist in the codebase and do NOT need to be created:

- **Enterprise auth type enum values** (`digest`, `kerberos`, `saml`, `hawk`, `ws_security`) are already present in `AUTH_PROFILE_AUTH_TYPES` at lines 36-40 of `packages/database/src/models/auth-profile.model.ts`, marked as "Phase 3 types". Sprint 1 step 4 ("Add enterprise types to Mongoose enum") is already done.
- **Addon schema fields** (`certificatePinning` and `jwtWrapping`) already exist in the `IAuthProfile` interface (lines 89-90) and schema (lines 157-158) as `Schema.Types.Mixed`. Tasks related to "adding schema fields" are already complete — focus on Zod validation and runtime implementation.
- **Feature flag file** `packages/shared/src/services/auth-profile/feature-flag.ts` already exists with `isAuthProfileEnabled()`. New functions (`isEnterpriseAuthTypeEnabled`, `isAddonEnabled`) will be added alongside it.

---

## 1. Enterprise Auth Types — Per-Type Implementation Details

### 1.1 `digest` — HTTP Digest Auth

| Aspect                | Detail                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**           | `digest-fetch` (~15KB, no native bindings)                                                                                            |
| **Config fields**     | `algorithm` (required: `'MD5'` \| `'MD5-sess'`), `qop?` (`'auth'` \| `'auth-int'`), `realm?`, `opaque?`                               |
| **Encrypted secrets** | `username`, `password`                                                                                                                |
| **Token lifecycle**   | Stateless — no token caching needed. Each request performs the challenge-response handshake (initial 401, then resubmit with digest). |
| **TTL**               | N/A (no token to cache)                                                                                                               |
| **Request mutation**  | Wraps `fetch` via `digest-fetch`. The library handles the 401 challenge-response cycle transparently.                                 |
| **Lazy loading**      | `const DigestFetch = (await import('digest-fetch')).default;` at call time, not module load.                                          |
| **Risk**              | Low. Small library, no native deps, zero current codebase usage.                                                                      |

**Implementation notes:**

- Returns a `DigestAuthResult` with a custom `fetch` wrapper, not raw headers (unlike other auth types), because Digest auth requires the initial unauthenticated request to obtain the server nonce.
- The `applyAuth()` dispatcher stores credentials in `result.digestCredentials` for the runtime HTTP client to use.
- Callers must use the Digest-aware fetch instead of standard `fetch` when this auth type is active.

### 1.2 `kerberos` — Enterprise SSO

| Aspect                | Detail                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Library**           | `kerberos` (~2MB, **native C++ bindings**, maintained by MongoDB team)                                                                                       |
| **System deps**       | `libkrb5-dev` (build), `libgssapi-krb5-2` + `libkrb5-3` (runtime shared libs)                                                                                |
| **Config fields**     | `realm` (required), `kdcHost` (required), `kdcPort` (required, default 88), `servicePrincipal` (required), `spnegoEnabled` (default `true`)                  |
| **Encrypted secrets** | `keytab` (base64-encoded), `principal?`, `password?`                                                                                                         |
| **Token lifecycle**   | Service tickets: 8-10h TTL, renewable up to 7 days. Cache SPNEGO tokens in Redis with key `auth-profile:kerberos:{tenantId}:{profileId}:{servicePrincipal}`. |
| **TTL**               | Default 8 hours (configurable via `ticketTtlSeconds` config field). Redis `SETEX` with TTL.                                                                  |
| **Request mutation**  | Sets `Authorization: Negotiate <base64-spnego-token>`.                                                                                                       |

**Keytab security protocol:**

1. Decrypt keytab from `encryptedSecrets`.
2. Create per-invocation random subdirectory: `fs.mkdtemp(path.join(os.tmpdir(), 'krb5-'))`. Ensure the runtime container has a dedicated `tmpfs` mount for sensitive temp files.
3. Write to temp file within that directory with `mode: 0o600` (owner-only read/write).
4. Set `KRB5_KTNAME` env var to temp path.
5. Acquire service ticket via `kerberos.initializeClient()` + `client.step('')`.
6. Restore previous `KRB5_KTNAME` value in `finally` block.
7. Delete temp directory with `fs.rm(tmpDir, { recursive: true, force: true })` in outer `finally` block.

**Redis caching flow:**

1. Check Redis for cached SPNEGO token: `GET auth-profile:kerberos:{tenantId}:{profileId}:{servicePrincipal}`.
2. If found and not expired, return cached token.
3. If missing, acquire new ticket from KDC, cache with `SETEX` (TTL = ticket lifetime minus 5-minute buffer).
4. On cache miss during token refresh, acquire distributed lock via `refresh-lock.ts` pattern to prevent thundering herd.

### 1.3 `saml` — Outbound SAML Assertion Acquisition

| Aspect                | Detail                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**           | `@node-saml/node-saml` (~2MB; verify `apps/studio/package.json` for existing dependency — if not present, add to `packages/auth-enterprise/package.json`)     |
| **Config fields**     | `entityId` (required, SP entity ID), `idpEntityId` (required), `idpSsoUrl` (required, URL-validated), `assertionConsumerServiceUrl` (required, URL-validated) |
| **Encrypted secrets** | `idpCertificate` (required, PEM), `spPrivateKey?` (PEM), `spCertificate?` (PEM)                                                                               |
| **Token lifecycle**   | SAML assertions have `NotOnOrAfter` TTL (typically 5-60 minutes). Cache in Redis with key `auth-profile:saml:{tenantId}:{profileId}`.                         |
| **TTL**               | Parse `NotOnOrAfter` from assertion XML. Cache with `SETEX` (TTL = NotOnOrAfter minus 30-second buffer).                                                      |
| **Request mutation**  | Sets `Authorization: SAML <base64(assertion-xml)>`.                                                                                                           |

**Important distinction:** This is _outbound_ SAML assertion acquisition (the platform acts as SP to fetch assertions from external IdPs for use in API calls). This is NOT the same as the existing inbound SAML SSO in Studio (where the platform acts as RP for user authentication).

### 1.4 `hawk` — MAC-Based HTTP Auth

| Aspect                | Detail                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**           | `@hapi/hawk` (~100KB, pure JS)                                                                                                                 |
| **Config fields**     | `algorithm` (required: `'sha256'` \| `'sha1'`), `ext?` (app-specific data), `dlg?` (delegation string), `timestampSkewSec?` (positive integer) |
| **Encrypted secrets** | `id` (required), `key` (required)                                                                                                              |
| **Token lifecycle**   | Stateless — MAC is computed per-request. No caching.                                                                                           |
| **TTL**               | N/A                                                                                                                                            |
| **Request mutation**  | Computes MAC via `Hawk.client.header()`. Sets `Authorization: Hawk id="...", ts="...", nonce="...", mac="..."`.                                |

**Implementation notes:**

- Unlike most auth types, Hawk requires the full request URL and method at MAC computation time. The `applyHawkAuth()` function takes an additional `request: { url, method, payload?, contentType? }` parameter.
- The `applyAuth()` dispatcher stores credentials in `result.hawkCredentials` for the runtime to use at the point where the full request is assembled.

### 1.5 `ws_security` — SOAP WS-Security

| Aspect                | Detail                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Library**           | `soap` (~8MB including `xml-crypto`, `xmldom`, `xmlbuilder`, `xpath`)                                                                          |
| **Config fields**     | `mode` (required: `'UsernameToken'` \| `'X509'`), `passwordType?` (e.g., `'PasswordDigest'`), `addTimestamp?` (boolean), `signatureAlgorithm?` |
| **Encrypted secrets** | `username?`, `password?` (for UsernameToken), `privateKey?`, `publicCert?` (for X509)                                                          |
| **Token lifecycle**   | Stateless per SOAP call.                                                                                                                       |
| **TTL**               | N/A                                                                                                                                            |
| **Request mutation**  | Modifies SOAP XML envelope via `soap` library's `setSecurity()`. NOT applicable to REST HTTP calls.                                            |

**SOAP-only constraint enforcement:**

- The `ws_security` auth type MUST be rejected at profile creation/update time if the associated tool or endpoint is not a SOAP endpoint.
- Validation rule in `auth-profile.schema.ts`: When `authType === 'ws_security'`, the profile MUST have `category: 'tool'` or `category: 'connector'`, and the consumer MUST be a SOAP-type tool binding.
- Runtime enforcement: The `applyAuth()` dispatcher for `ws_security` returns a `WsSecurityHandler` object with `applySecurity(soapClient)` method. If the runtime HTTP client is not a SOAP client, the handler is a no-op with a logged warning.
- Additional runtime guard: If `ws_security` credentials are resolved for a non-SOAP request, emit a `TRACE_AUTH_WS_SECURITY_MISUSE` warning event and skip application (do not throw, to avoid breaking existing flows during migration).

---

## 2. Kerberos Isolation Strategy

### Recommended: Optional `packages/auth-enterprise` Package with Conditional Dockerfile Stage

Three strategies were evaluated. The recommended approach balances isolation with operational simplicity.

### 2.1 Option A: Separate Optional Package (RECOMMENDED)

**Structure:**

```
packages/auth-enterprise/
  package.json          # depends on: kerberos, @node-saml/node-saml, @hapi/hawk, digest-fetch, soap
  tsconfig.json
  vitest.config.ts
  src/
    digest-auth.ts
    kerberos-auth.ts
    saml-auth.ts
    hawk-auth.ts
    ws-security-auth.ts
    index.ts            # lazy re-exports
    __tests__/
```

**Dockerfile changes for `kerberos` native bindings:**

Builder stage (all Dockerfiles that need enterprise auth):

```dockerfile
# Only in enterprise-enabled builds:
FROM node:22-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libkrb5-dev python3 \
    && rm -rf /var/lib/apt/lists/*
```

Production stage (runtime only — requires Kerberos shared libraries):

```dockerfile
# Switch from distroless to debian-slim for Kerberos shared lib support:
FROM node:22-slim AS production-enterprise
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgssapi-krb5-2 libkrb5-3 \
    && rm -rf /var/lib/apt/lists/*
```

**COPY line additions** (all relevant Dockerfiles):

```dockerfile
COPY packages/auth-enterprise/package.json packages/auth-enterprise/package.json
```

Affected Dockerfiles:

- `apps/runtime/Dockerfile`
- `apps/search-ai/Dockerfile`
- `apps/search-ai-runtime/Dockerfile`
- `apps/admin/Dockerfile`
- `apps/studio/Dockerfile`
- `packages/pipeline-engine/Dockerfile`

**Pros:** Core platform image unchanged. Enterprise customers opt in. Clear dependency boundary.
**Cons:** Two Dockerfile variants to maintain (standard vs enterprise). pnpm workspace COPY lines in 6 Dockerfiles.

### 2.2 Option B: Kerberos Sidecar (REJECTED)

Run a Kerberos ticket-granting sidecar that exposes a local HTTP API for ticket acquisition.

**Why rejected:** Adds operational complexity (extra container, health checks, networking). The ticket acquisition latency doubles due to the extra HTTP hop. Monitoring/alerting must cover the sidecar. Not justified given that `kerberos` npm bindings work fine in Node.js.

### 2.3 Option C: Conditional Dockerfile Multi-Stage with Build Arg (ALTERNATIVE)

```dockerfile
ARG ENTERPRISE_AUTH=false

FROM node:22-slim AS builder-base
# ... standard build ...

FROM builder-base AS builder-enterprise-true
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libkrb5-dev python3

FROM builder-base AS builder-enterprise-false
# No additional deps

FROM builder-enterprise-${ENTERPRISE_AUTH} AS builder
```

**Pros:** Single Dockerfile. Toggle with `--build-arg ENTERPRISE_AUTH=true`.
**Cons:** Docker BuildKit required. Conditional stages add complexity. Hard to reason about in CI.

### Recommendation

**Use Option A** (separate package) for initial implementation. If maintaining two Dockerfile variants proves burdensome after 2 sprints, migrate to Option C.

---

## 3. WS-Security SOAP-Only Constraint

### 3.1 Schema-Level Validation

In `packages/shared/src/validation/auth-profile.schema.ts`, add a refinement:

```
WsSecurityCreateSchema.refine():
  - If authType === 'ws_security', category MUST be 'tool' or 'connector'
  - Error: "WS-Security auth type is only applicable to SOAP endpoints. Set category to 'tool' or 'connector'."
```

### 3.2 Invalid Addon Combinations for `ws_security`

| Combination                           | Rejection Reason                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ws_security` + `signing`             | WS-Security operates on SOAP XML, not HTTP headers. HMAC signing on HTTP headers is meaningless for SOAP. |
| `ws_security` + `proxy`               | SOAP clients handle their own proxy configuration. HTTP proxy settings do not apply to SOAP envelopes.    |
| `ws_security` + `certificatePinning`  | Certificate pinning is an HTTP/TLS concern. SOAP WS-Security uses XML-level security.                     |
| `ws_security` + `jwtWrapping`         | JWT is an HTTP bearer token wrapper. SOAP uses WS-Security tokens, not JWT.                               |
| `ws_security` + `webhookVerification` | WS-Security is outbound SOAP. Webhook verification is inbound HTTP.                                       |

### 3.3 Runtime Guard

In the `applyAuth()` dispatcher, the `ws_security` case returns a `WsSecurityHandler` object. The runtime HTTP client checks:

1. If the request target is a SOAP endpoint (WSDL URL or `Content-Type: text/xml` or `application/soap+xml`), apply the handler.
2. If not, log a warning trace event `AUTH_WS_SECURITY_REST_MISUSE` and skip WS-Security application.
3. Never throw — degrade gracefully to prevent breaking existing flows.

---

## 4. Addon Implementations

### 4.1 `certificatePinning` — SPKI SHA-256 Fingerprint Validation

**Schema:**

```typescript
certificatePinning?: {
  pins: Array<{
    fingerprint: string;      // SPKI SHA-256 (hex or base64)
    expiresAt?: Date;         // Optional per-pin expiration
  }>;
  mode: 'strict' | 'report-only';
  reportUrl?: string;         // POST violation reports here in report-only mode
};
```

**SPKI validation implementation:**

1. **Hook into TLS connection:** Use Node.js `tls.connect()` `secureConnect` event or `https.Agent` with `checkServerIdentity` callback.
2. **Extract server certificate SPKI:** `crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64')`.
3. **Compare against pins:** Match the server cert's SPKI fingerprint against the `pins` array (after filtering expired pins where `expiresAt < now`).
4. **Mode behavior:**
   - `strict`: If no pin matches, reject the TLS connection with `AUTH_CERTIFICATE_PIN_MISMATCH` error. Emit trace event.
   - `report-only`: If no pin matches, allow the connection but POST a violation report to `reportUrl` (if configured) and emit `AUTH_CERTIFICATE_PIN_VIOLATION_REPORT` trace event.

**Pin rotation support:**

- Multiple pins can be active simultaneously (primary + backup).
- `expiresAt` allows pre-staging the next pin before rotating the server certificate.
- Recommendation: Always have at least 2 active pins (current + next) to avoid lockout during certificate rotation.

**Validation rules:**

- `pins` array must have at least 1 entry.
- `fingerprint` must be valid hex (64 chars) or base64 (44 chars with padding).
- If `mode === 'report-only'` and `reportUrl` is provided, `reportUrl` must be a valid HTTPS URL.
- `reportUrl` must NOT point to the same host being pinned (prevents infinite loops).

### 4.2 `jwtWrapping` — Service-to-Service JWT Wrapper

**Schema:**

```typescript
jwtWrapping?: {
  algorithm: 'RS256' | 'ES256' | 'RS384';
  issuer: string;
  audience: string;
  expiresInSeconds: number;    // 60-3600 (1 min to 1 hour)
  claims?: Record<string, unknown>;
  // jwtPrivateKey stored in encryptedSecrets
};
```

**Key management:**

- The JWT signing private key is stored in `encryptedSecrets.jwtPrivateKey` (PEM format).
- Key format requirements by algorithm:
  - `RS256`, `RS384`: RSA private key (minimum 2048-bit).
  - `ES256`: EC private key (P-256 curve).
- Key validation at profile create/update: Parse the PEM, verify it matches the declared algorithm. Reject mismatched key types (e.g., EC key with RS256).

**JWT generation flow:**

1. After base auth type is applied (e.g., `api_key` sets `Authorization` header).
2. JWT wrapping adds a _second_ token: Generate JWT with `{ iss, aud, exp, iat, ...claims }`.
3. Sign with `jwtPrivateKey` using the configured algorithm.
4. Set `X-JWT-Assertion` header (configurable via `claims.headerName` or default).
5. The original `Authorization` header from the base auth type is preserved.

**Implementation:** Use Node.js `crypto.sign()` directly (no external JWT library needed for RS256/ES256/RS384). Build JWT header + payload manually, sign with `crypto.createSign()`.

**Caching:** JWTs are short-lived (1-60 min). Cache the generated JWT in the session-level `CredentialCache` with TTL = `expiresInSeconds - 10` seconds. Regenerate on cache miss.

### 4.3 Invalid Addon Combinations (Phase 3 Additions)

These are enforced at profile create/update time in the Zod schema refinement:

| Combination                           | Reason                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `ws_security` + `signing`             | SOAP XML security, not HTTP                                              |
| `ws_security` + `proxy`               | SOAP handles own transport                                               |
| `ws_security` + `certificatePinning`  | XML-level security, not TLS                                              |
| `ws_security` + `jwtWrapping`         | SOAP uses WS-Security tokens, not JWT                                    |
| `ws_security` + `webhookVerification` | Outbound SOAP vs inbound HTTP                                            |
| `ssh_key` + `jwtWrapping`             | SSH is not HTTP                                                          |
| `ssh_key` + `certificatePinning`      | SSH is not TLS/HTTP                                                      |
| `mtls` + `jwtWrapping`                | mTLS already provides mutual authentication; JWT wrapping adds confusion |

Combined with existing Phase 1-2 rules:

| Combination                       | Reason                                  |
| --------------------------------- | --------------------------------------- |
| `aws_iam` + `signing`             | AWS SigV4 is itself a signing mechanism |
| `ssh_key` + `signing` / `proxy`   | SSH is not HTTP                         |
| `webhookVerification` + `signing` | Opposite directions                     |
| `mtls` + `proxy`                  | mTLS typically terminated at proxy      |

---

## 5. Docker Build Impact Analysis

### 5.1 Image Size Impact

| Component                                  | Size Impact                     | Affected Images    |
| ------------------------------------------ | ------------------------------- | ------------------ |
| `digest-fetch`                             | +15KB                           | Negligible         |
| `@hapi/hawk`                               | +100KB                          | Negligible         |
| `@node-saml/node-saml`                     | +2MB                            | Moderate           |
| `soap` + transitive deps                   | +8MB                            | Significant        |
| `kerberos` (compiled)                      | +2MB binary + 15MB shared libs  | Significant        |
| `libkrb5-dev` (build only)                 | +50MB build stage (not in prod) | Build time only    |
| `libgssapi-krb5-2` + `libkrb5-3` (runtime) | +15MB                           | Production image   |
| **Total (all enterprise types)**           | **+27MB production**            | Runtime, Search-AI |
| **Total (without kerberos)**               | **+10MB production**            | All apps           |

### 5.2 Build Time Impact

| Change                                                | Time Impact                                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| `apt-get install build-essential libkrb5-dev python3` | +30-60 seconds                                                    |
| `kerberos` npm native compilation                     | +15-30 seconds                                                    |
| `pnpm install` with 5 new deps                        | +5-10 seconds                                                     |
| **Total**                                             | **+50-100 seconds** (with kerberos) / **+5-10 seconds** (without) |

### 5.3 Production Image Compatibility

**Current production base:** `gcr.io/distroless/nodejs22-debian12` — minimal image with no shell, no package manager, no shared libraries beyond Node.js.

**Problem:** `kerberos` npm package links against `libgssapi_krb5.so.2` and `libkrb5.so.3`. These are not present in the distroless image.

**Solutions (in order of preference):**

1. **Enterprise Dockerfile variant** with `node:22-slim` production base (adds ~80MB but includes all shared libs). Only for enterprise-enabled deployments.
2. **Copy shared libs from builder:** `COPY --from=builder /usr/lib/x86_64-linux-gnu/libkrb5* /usr/lib/x86_64-linux-gnu/libgssapi_krb5* /usr/lib/...` into distroless. Fragile but keeps image small.
3. **Kerberos sidecar** (rejected — see Section 2.2).

**Recommendation:** Option 1 (enterprise Dockerfile variant) for simplicity and reliability.

### 5.4 Multi-Architecture Support

- `kerberos` npm package supports `linux/amd64` and `linux/arm64`.
- CI must build and test on both architectures if multi-arch images are produced.
- macOS (Apple Silicon) developers will get different native binaries via pnpm platform resolution — this is handled automatically.

---

## 6. Feature Flags — Per-Type Gradual Rollout

### 6.1 Feature Flag Design

Each enterprise auth type and addon gets an independent feature flag. This allows:

- Per-type rollout (e.g., enable `digest` first, then `hawk`, then `saml`).
- Quick per-type disable if issues arise.
- Enterprise customers can enable only the types they need.

**Environment variables:**

| Flag                                  | Default | Controls                   |
| ------------------------------------- | ------- | -------------------------- |
| `AUTH_ENTERPRISE_DIGEST_ENABLED`      | `false` | `digest` auth type         |
| `AUTH_ENTERPRISE_KERBEROS_ENABLED`    | `false` | `kerberos` auth type       |
| `AUTH_ENTERPRISE_SAML_ENABLED`        | `false` | `saml` auth type           |
| `AUTH_ENTERPRISE_HAWK_ENABLED`        | `false` | `hawk` auth type           |
| `AUTH_ENTERPRISE_WS_SECURITY_ENABLED` | `false` | `ws_security` auth type    |
| `AUTH_ADDON_CERT_PINNING_ENABLED`     | `false` | `certificatePinning` addon |
| `AUTH_ADDON_JWT_WRAPPING_ENABLED`     | `false` | `jwtWrapping` addon        |

### 6.2 Enforcement Points

1. **Profile creation:** If `authType === 'kerberos'` and `AUTH_ENTERPRISE_KERBEROS_ENABLED !== 'true'`, reject with 400: `{ code: 'AUTH_TYPE_NOT_ENABLED', message: 'kerberos auth type is not enabled in this environment' }`.
2. **Profile update:** Same check on `authType` field changes.
3. **Credential resolution:** If a profile with a disabled auth type is resolved, fall back to returning an error result (not throwing) and emit `AUTH_ENTERPRISE_TYPE_DISABLED` trace event.
4. **Addon application:** If `certificatePinning` is present on a profile but `AUTH_ADDON_CERT_PINNING_ENABLED !== 'true'`, skip the addon (log warning, do not throw).

### 6.3 Feature Flag Implementation

Add to `packages/shared/src/services/auth-profile/feature-flag.ts`:

```typescript
export function isEnterpriseAuthTypeEnabled(authType: string): boolean {
  const flagMap: Record<string, string> = {
    digest: 'AUTH_ENTERPRISE_DIGEST_ENABLED',
    kerberos: 'AUTH_ENTERPRISE_KERBEROS_ENABLED',
    saml: 'AUTH_ENTERPRISE_SAML_ENABLED',
    hawk: 'AUTH_ENTERPRISE_HAWK_ENABLED',
    ws_security: 'AUTH_ENTERPRISE_WS_SECURITY_ENABLED',
  };
  const flag = flagMap[authType];
  if (!flag) return true; // Not an enterprise type — always enabled
  return process.env[flag] === 'true';
}

export function isAddonEnabled(addon: string): boolean {
  const flagMap: Record<string, string> = {
    certificatePinning: 'AUTH_ADDON_CERT_PINNING_ENABLED',
    jwtWrapping: 'AUTH_ADDON_JWT_WRAPPING_ENABLED',
  };
  const flag = flagMap[addon];
  if (!flag) return true; // Not a Phase 3 addon — always enabled
  return process.env[flag] === 'true';
}
```

### 6.4 Rollout Sequence

1. **Week 1:** Enable `digest` and `hawk` (low-risk, pure JS, no native deps).
2. **Week 2:** Enable `saml` (moderate risk, already have `@node-saml` in Studio).
3. **Week 3:** Enable `ws_security` (moderate risk, large dependency but lazy-loaded).
4. **Week 4:** Enable `kerberos` (high risk, native bindings, Docker changes).
5. **Week 5:** Enable `certificatePinning` and `jwtWrapping` addons.

Each week includes a 5-day soak period in staging before production enablement.

---

## 7. Testing Strategy

### 7.1 Unit Tests (per auth type)

All unit tests use `vitest` and live in `packages/auth-enterprise/src/__tests__/`.

| Test File                  | Coverage                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `digest-auth.test.ts`      | Config/secrets validation, fetch wrapper creation, algorithm passthrough                         |
| `kerberos-auth.test.ts`    | Mock `kerberos` module, keytab temp file lifecycle, SPNEGO token in header, Redis cache hit/miss |
| `saml-auth.test.ts`        | Mock `@node-saml/node-saml`, assertion generation, base64 encoding, NotOnOrAfter parsing         |
| `hawk-auth.test.ts`        | MAC computation with known test vectors (from Hawk spec), ext/dlg passthrough                    |
| `ws-security-auth.test.ts` | UsernameToken handler creation, X509 handler creation, `applySecurity` invocation                |

### 7.2 Mock Kerberos KDC

**Approach:** Do NOT run a real KDC in CI. Instead:

1. **Unit tests:** Mock the `kerberos` npm module via `vi.mock('kerberos')`. Test the keytab file lifecycle (temp file creation, 0o600 permissions, cleanup) using the real filesystem with a mock keytab.
2. **Integration tests:** Use a `kerberos-mock` test fixture that:
   - Stubs `kerberos.initializeClient()` to return a mock client.
   - The mock client's `step()` returns a deterministic base64 token.
   - Verifies the `Authorization: Negotiate <token>` header is set.
3. **E2E tests (optional, not in CI):** Use a Docker Compose KDC container (e.g., `gcavalcante8808/krb5-server`) for manual verification. Document in `packages/auth-enterprise/README.md`.

### 7.3 SAML IdP Test Fixture

**Approach:** Mock the SAML library, not a real IdP.

1. **Unit tests:** Mock `@node-saml/node-saml`'s `SAML` class. Verify constructor args match config. Verify `generateAuthorizeRequestAsync()` output is base64-encoded in the header.
2. **Integration fixture:** Create `packages/auth-enterprise/src/__tests__/fixtures/saml-idp-fixture.ts` that:
   - Generates a self-signed X.509 certificate for test IdP.
   - Produces a valid SAML assertion XML with configurable `NotOnOrAfter`.
   - Returns the assertion when the mock IdP's SSO URL is called.
3. **TTL parsing test:** Verify that `NotOnOrAfter` is correctly extracted and used for Redis cache TTL.

### 7.4 SOAP Test Server

**Approach:** Use an in-process mock SOAP server.

1. **Unit tests:** Mock the `soap` library. Verify `WSSecurity` / `ClientSSLSecurity` constructors are called with correct args.
2. **Integration fixture:** Create `packages/auth-enterprise/src/__tests__/fixtures/soap-server-fixture.ts` that:
   - Uses `soap.listen()` to create a minimal WSDL-based SOAP server on a random port.
   - Verifies that WS-Security headers are present in the incoming SOAP envelope.
   - Supports both `UsernameToken` and `X509` modes.
3. **SOAP-only constraint test:** Verify that `ws_security` profiles are rejected when the tool endpoint is REST (not SOAP).

### 7.5 Addon Tests

| Test                           | Coverage                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `certificate-pinning.test.ts`  | Pin match/mismatch with test certs, expired pin filtering, strict vs report-only mode, report URL POST    |
| `jwt-wrapping.test.ts`         | JWT generation with RS256/ES256/RS384, claim inclusion, expiration, header placement, key type validation |
| `invalid-combinations.test.ts` | All combinations from Section 4.3 table are rejected at creation time                                     |

### 7.6 Test Infrastructure Requirements

| Requirement         | Solution                                                               |
| ------------------- | ---------------------------------------------------------------------- |
| MongoDB             | `mongodb-memory-server` (existing devDependency)                       |
| Redis               | `ioredis-mock` or testcontainers Redis (for Kerberos/SAML cache tests) |
| Kerberos KDC        | Mocked — no real KDC in CI                                             |
| SAML IdP            | Mocked — self-signed test fixtures                                     |
| SOAP server         | In-process mock via `soap.listen()`                                    |
| Certificate pinning | Self-signed test certificates generated with `node:crypto`             |

### 7.7 Estimated Test Count

| Area                                        | New Tests | Updated Tests |
| ------------------------------------------- | --------- | ------------- |
| Enterprise auth type schemas                | ~30       | 0             |
| Enterprise auth type implementations        | ~40       | 0             |
| `applyAuth()` dispatcher (enterprise cases) | ~15       | ~5            |
| Addon schemas + validation                  | ~20       | 0             |
| Addon implementations                       | ~25       | 0             |
| Invalid combination rules                   | ~15       | ~5            |
| Feature flag enforcement                    | ~15       | 0             |
| Redis caching (Kerberos, SAML)              | ~10       | 0             |
| **Total**                                   | **~170**  | **~10**       |

---

## 8. Rollback Plan

### 8.1 Per-Type Rollback (Feature Flag)

If a specific enterprise auth type causes issues:

1. Set the corresponding feature flag to `false` (e.g., `AUTH_ENTERPRISE_KERBEROS_ENABLED=false`).
2. No redeployment needed — flag is read at runtime.
3. Existing profiles with that auth type remain in the database but cannot be used for new credential resolution.
4. Active sessions using cached credentials from the disabled type continue until cache expiry.
5. Emit `AUTH_ENTERPRISE_TYPE_DISABLED` trace event for all resolution attempts.

### 8.2 Package-Level Rollback

If the entire `packages/auth-enterprise` package causes issues (build failures, import errors):

1. Remove the `@agent-platform/auth-enterprise` dependency from consumer packages.
2. The `applyAuth()` dispatcher's enterprise type cases fall through to `default: break` (returns empty result, no crash).
3. Redeploy without the enterprise package.
4. Profiles with enterprise auth types return a resolution error (not a crash).

### 8.3 Dockerfile Rollback

If Kerberos native bindings cause Docker build failures:

1. Revert Dockerfile changes (remove `apt-get install` and COPY lines).
2. Remove `kerberos` from `packages/auth-enterprise/package.json`.
3. The `kerberos-auth.ts` module's `import('kerberos')` fails at runtime with a clear error.
4. Set `AUTH_ENTERPRISE_KERBEROS_ENABLED=false` to prevent any resolution attempts.

### 8.4 Addon Rollback

If `certificatePinning` or `jwtWrapping` addons cause issues:

1. Set `AUTH_ADDON_CERT_PINNING_ENABLED=false` or `AUTH_ADDON_JWT_WRAPPING_ENABLED=false`.
2. The `applyAuth()` dispatcher skips addon enrichment when the flag is off.
3. Existing profiles with addon configuration remain unchanged in the database.
4. Addon fields on profiles are inert when the flag is off — no side effects.

### 8.5 Full Phase 3 Rollback

If the entire Phase 3 needs to be reverted:

1. Disable all 7 feature flags.
2. Remove `packages/auth-enterprise` from `pnpm-workspace.yaml` and consumer dependencies.
3. Revert Dockerfile changes.
4. Run a migration to remove enterprise auth type values from the `AUTH_PROFILE_AUTH_TYPES` enum (or leave them — Mongoose handles unknown enum values gracefully).
5. Enterprise auth profile documents remain in the database as orphans (harmless).
6. No data loss — Phase 1-2 auth profiles continue working unchanged.

### 8.6 Monitoring for Rollback Triggers

| Metric                                                    | Threshold                  | Action                                                      |
| --------------------------------------------------------- | -------------------------- | ----------------------------------------------------------- |
| `auth_profile_resolution_error_rate` for enterprise types | > 5% over 15 minutes       | Disable the specific type's flag                            |
| Docker build time increase                                | > 3 minutes above baseline | Investigate native compilation; consider deferring Kerberos |
| Production image size                                     | > 50MB above baseline      | Review dependency tree; lazy-load more aggressively         |
| `AUTH_CERTIFICATE_PIN_MISMATCH` rate (strict mode)        | > 10%                      | Switch to report-only mode                                  |
| Kerberos ticket acquisition latency (p99)                 | > 5 seconds                | Check KDC connectivity; increase Redis cache TTL            |

---

## 9. Implementation Sequence

### Sprint 1 (2 weeks): Low-Risk Types + Addons

1. Scaffold `packages/auth-enterprise` workspace package.
2. Implement `digest-auth.ts` and `hawk-auth.ts` (pure JS, small libraries).
3. Add Zod schemas for all 5 enterprise types (schema-only, no runtime code for Kerberos/SAML/WS yet).
4. Add enterprise types to Mongoose enum.
5. Implement `certificatePinning` addon (schema + SPKI validation + report-only mode).
6. Implement `jwtWrapping` addon (schema + JWT generation + key validation).
7. Add invalid combination rules for Phase 3.
8. Add feature flags (all defaulting to `false`).
9. Wire `digest` and `hawk` into `applyAuth()` dispatcher.
10. Add COPY lines for `packages/auth-enterprise` to all Dockerfiles.

### Sprint 2 (2 weeks): Medium-Risk Types + Kerberos Prep

1. Implement `saml-auth.ts` with SAML assertion caching.
2. Implement `ws-security-auth.ts` with SOAP-only constraint.
3. Wire `saml` and `ws_security` into `applyAuth()` dispatcher.
4. Create enterprise Dockerfile variant with `libkrb5-dev` and Kerberos shared libs.
5. Implement `kerberos-auth.ts` with keytab security protocol and Redis caching.
6. Wire `kerberos` into `applyAuth()` dispatcher.
7. Full test suite for all 5 types + 2 addons.

### Sprint 3 (1 week): Rollout + Bake

1. Enable `digest` and `hawk` flags in staging (Day 1).
2. Enable `saml` and `ws_security` flags in staging (Day 3).
3. Enable `kerberos` flag in staging (Day 5, enterprise Dockerfile only).
4. Enable addons in staging (Day 5).
5. Production rollout following the sequence in Section 6.4.

---

## 10. Open Questions

1. **Kerberos Docker variant ownership:** Should the enterprise Dockerfile be maintained in the `abl-platform` repo (alongside standard Dockerfiles) or in the `abl-platform-deploy` repo (as a Helm chart override)?
2. **SAML assertion storage:** Should SAML assertions be cached in Redis (recommended) or in the session-level `CredentialCache` (simpler but per-pod)?
3. **Certificate pinning report endpoint:** Should violation reports go to a platform-hosted endpoint (centralized monitoring) or to a customer-configured URL only?
4. **JWT wrapping header name:** Should the default be `X-JWT-Assertion` or should it be configurable via the `jwtWrapping.claims` field?
5. **`ws_security` + REST guard:** Should the runtime throw an error or silently skip WS-Security when applied to a REST endpoint? Current recommendation: skip with warning trace event.

---

## 11. Observability for Enterprise Auth Types

Enterprise types have unique failure modes that need specific trace events and metrics beyond the base `auth_profile_resolved` / `auth_profile_failed` events:

### Trace Events

| Event                                      | When                                          | Data                                                |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------------------- |
| `auth_enterprise_kerberos_ticket_acquired` | SPNEGO token successfully obtained from KDC   | `{ profileId, servicePrincipal, ticketTtlSeconds }` |
| `auth_enterprise_kerberos_kdc_unreachable` | KDC connection fails                          | `{ profileId, kdcHost, kdcPort, errorMessage }`     |
| `auth_enterprise_saml_assertion_acquired`  | SAML assertion obtained from IdP              | `{ profileId, idpEntityId, assertionTtlSeconds }`   |
| `auth_enterprise_saml_assertion_expired`   | Cached SAML assertion expired before use      | `{ profileId, idpEntityId, notOnOrAfter }`          |
| `auth_enterprise_ws_security_applied`      | WS-Security headers applied to SOAP envelope  | `{ profileId, mode, hasTimestamp }`                 |
| `auth_enterprise_ws_security_rest_misuse`  | WS-Security credentials resolved for non-SOAP | `{ profileId, requestContentType }`                 |

### Metrics

- `auth_enterprise_resolution_duration_seconds` (histogram, labels: `auth_type`) — latency per enterprise type
- `auth_enterprise_cache_hit_total` (counter, labels: `auth_type`) — Redis cache hits for Kerberos/SAML
- `auth_enterprise_kdc_latency_seconds` (histogram) — Kerberos KDC round-trip time

---

## 12. Certificate Pin Expiry Notification

Add a background check (as part of `CredentialAgeMonitor` or a new BullMQ job) that queries Auth Profiles with `certificatePinning.pins[].expiresAt` approaching and emits a warning trace event 7 days before expiry:

- Query: `AuthProfile.find({ 'certificatePinning.pins.expiresAt': { $lt: now + 7days, $gt: now } })`
- Emit: `auth_cert_pin_expiry_warning` trace event with `{ profileId, fingerprint, expiresAt, daysRemaining }`
- Metric: `auth_cert_pin_expiry_days` (gauge) — days until nearest pin expiry per profile

If all active pins expire, all HTTPS connections to the pinned host will fail. Operators must be alerted proactively.

---

## 13. Redis Cache Key Consistency

Use a consistent key pattern for all enterprise auth type caches:

- `auth-profile:{type}:{tenantId}:{profileId}` — base pattern
- Kerberos: `auth-profile:kerberos:{tenantId}:{profileId}:{servicePrincipal}` (extra component for per-principal tickets)
- SAML: `auth-profile:saml:{tenantId}:{profileId}`

Since `tenantId` and `profileId` are both UUIDs, cache key collisions are prevented by design.

---

## Revision History

- **Pass 1 (2026-03-13)**: Initial implementation plan.
- **Pass 2 (2026-03-13)**: Applied 131 audit findings from 3 auditors. Added cross-plan dependencies section, acknowledged existing schema (enterprise enum values, addon fields, feature flag file already exist), fixed Kerberos temp file security (per-invocation random subdirectory), verified `@node-saml/node-saml` dependency claim, added enterprise auth observability section (trace events + metrics), added certificate pin expiry notification, added Redis cache key consistency section, added consent flag interaction note (enterprise flags control creation only, not consent mechanics).
