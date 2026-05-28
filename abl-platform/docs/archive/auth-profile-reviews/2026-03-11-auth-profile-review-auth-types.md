# Auth Profile Design — Auth Type Coverage Review

> Reviewed: `docs/plans/2026-03-11-auth-profile-design.md`
> Reviewer: Claude (code-review agent)
> Date: 2026-03-11
> Scope: Auth type completeness, missing auth patterns, addon layer gaps, config/secrets boundary clarity

---

## Executive Summary

The design covers the 17 declared auth types at a **schema level** (config fields, encrypted
secrets, library selection) but has **systematic gaps** in three areas:

1. **No request-application specification** — the design never describes how each auth type mutates
   an outbound HTTP request (header format, body modification, TLS layer). This is the most
   critical gap: an implementer cannot write `applyAuth()` from the doc alone for 9 of 17 types.

2. **Token refresh/rotation is specified only for `oauth2_token`** — the six other types that
   produce short-lived credentials (`aws_iam`, `azure_ad`, `oauth2_client_credentials`, `kerberos`,
   and `saml` assertions) have no refresh strategy documented.

3. **One active auth pattern in the codebase is not in the 17 types**: the `searchai` auth mode
   used by `ToolAuthTypeIR` in the compiler. It is a first-class auth pattern with its own executor
   logic and tests but has no representation in the Auth Profile model.

There are also narrower gaps in the addon layer (webhook verification direction ambiguity, proxy
circular-reference check, and no invalid-combination guardrails) and several config/secrets
boundary ambiguities for `custom_header`, `aws_iam`, and `oauth2_app`.

---

## 1. Auth Type Completeness — Per-Type Analysis

### 1.1 `none`

- Config / secrets boundary: clear (both empty).
- Request application: trivial (no-op). Not explicitly stated but implied.
- Refresh strategy: N/A.
- Error handling: N/A.
- Library: none. No gap.

### 1.2 `api_key`

- Config / secrets boundary: clear. `headerName`, `prefix`, `placement` in config; `apiKey` in secrets.
- Request application: **not specified**. The design says `placement: 'header' | 'query'` exists in
  config but never describes the injection logic: when `placement = 'query'`, which query-param name
  is used? Is it always `headerName`? The existing `service-node-executor.ts` only injects into
  headers (`headers[headerName] = secrets.apiKey`). The `queryParam` field in the IR schema
  (`HttpBindingIR.auth.config.queryParam`) is a separate concept. The Auth Profile design needs to
  specify: when `placement = 'query'`, the param name is `headerName` (or a separate `queryParamName`
  field).
- Refresh/rotation: the `rotationPolicy` + `rotationGracePeriodMs` fields exist but there is no
  specification of **what triggers rotation** — is it schedule-based, age-based, or manual only? The
  "rotation schedule, grace period" note in the Rotation table is insufficient for implementation.
- Error handling: 401 response behavior not described (should mark `status: 'expired'`? retry?).
- Library: none. No gap.

### 1.3 `bearer`

- Config / secrets boundary: clear.
- Request application: not explicitly stated (implied `Authorization: Bearer <token>`). The bearer
  prefix is hardcoded convention — this is fine but should be stated.
- Refresh: same gap as `api_key` rotation.
- Error handling: not described.
- Library: none. No gap.

### 1.4 `basic`

- Config / secrets boundary: clear.
- Request application: **not specified**. Standard is `Authorization: Basic base64(username:password)`.
  The design never states this. The codebase confirms this pattern (e.g., `zendesk-adapter.ts`,
  `twilio-sms-media-downloader.ts`) but the design doc must specify it.
- Refresh: N/A (static credentials, covered by rotation policy).
- Error handling: not described.
- Library: none. No gap.

### 1.5 `digest`

- Config / secrets boundary: clear. Algorithm, qop, realm in config; username/password in secrets.
- Request application: **significantly underspecified**. HTTP Digest (RFC 7616) requires a
  challenge-response handshake: the client makes an unauthenticated request, receives a
  `WWW-Authenticate: Digest ...` header with a nonce from the server, then resubmits with a computed
  response. The design does not describe:
  - That the initial unauthenticated request and 401 retry are required.
  - How the nonce, cnonce, nc counter, and qop affect the `Authorization` header computation.
  - Whether `realm` and `opaque` in `config` are pre-supplied (to skip the first round-trip) or
    validated against the server's challenge.
  - The `digest-fetch` library handles this, but the design should state that it is used as the HTTP
    client wrapper, not just named in the library table.
- Refresh: N/A (per-request computation, no token to refresh).
- Error handling: 401 with a fresh nonce triggers a new computation — not described.
- Library: `digest-fetch`. Loading strategy says "Direct import" but `digest-fetch` is not a trivial
  dependency and adds size. Lazy import would be more consistent with the other protocol libraries.

### 1.6 `oauth2_app`

- Config / secrets boundary: mostly clear. However, `deviceAuthorizationUrl` is in config (correct)
  but the design never specifies that `oauth2_app` itself is **never directly used to sign requests**
  — it only exists to mint tokens. This is implied by the two-layer model but should be explicit.
  An implementer could reasonably wonder if `oauth2_app` can be applied directly to an HTTP call.
- Request application: none (app credential is not applied to calls; tokens are). **Should be
  stated explicitly** to prevent misuse.
- Refresh: N/A (its children `oauth2_token` profiles refresh using it).
- Error handling: what happens when `clientSecret` is invalid at token exchange time? The design
  does not describe this path. Section 10 covers `oauth2_token` expiry but not `oauth2_app`
  credential invalidity.
- Library: `simple-oauth2`. No gap.

### 1.7 `oauth2_token`

- Config / secrets boundary: clear and detailed.
- Request application: not explicitly stated (implied `Authorization: Bearer <accessToken>`).
- Refresh: **well specified** — the 7-step distributed-lock refresh in Section 5 is the best-
  specified type in the document. No gap.
- Error handling: `status → 'expired'` on refresh failure is described. No gap.
- Library: `simple-oauth2`. No gap.

### 1.8 `oauth2_client_credentials`

- Config / secrets boundary: clear. `tokenUrl`, `scopes` in config; `clientId`, `clientSecret` in
  secrets.
- Request application: token is fetched and used as `Authorization: Bearer`. Not stated.
- **Refresh gap**: The design specifies token refresh only for `oauth2_token` (the 7-step
  procedure). `oauth2_client_credentials` also produces short-lived access tokens that expire.
  There is no specification of:
  - Whether a cached token is reused until expiry (yes, this is the standard pattern).
  - Where the token expiry/TTL is tracked (the profile's `config` has no `expiresAt` field for
    this type, unlike `oauth2_token`).
  - Whether the distributed lock pattern applies to concurrent refresh.
  - What happens on a 401 from the downstream service (retry with a fresh token?).
    The existing `service-node-executor.ts` implements a local in-memory OAuth token cache with a
    60-second buffer, but Auth Profile needs to specify whether this moves to a shared Redis cache
    or stays local.
- Error handling: client-credentials token fetch failure not described.
- Library: `simple-oauth2`. No gap.

### 1.9 `custom_header`

- Config / secrets boundary: **ambiguous**. Config has `headers: Record<string, string>` described
  as "header names" and secrets have `headerValues: Record<string, string>`. The validation table
  says "at least one header name" for config and "matching header values" for secrets. However:
  - Are the keys in `config.headers` the same as the keys in `encryptedSecrets.headerValues`? If
    yes, the header names are in config (non-secret) and the values are in secrets. This is correct
    behavior but needs an explicit statement: "keys in `config.headers` and `encryptedSecrets.
headerValues` must match."
  - The value in `config.headers` is described only as the header name (e.g., `"X-Custom-Token"`),
    not a static value. Static, non-secret header values (e.g., a content-type override) would go
    in `config.headers` with the value left empty or not present in secrets. This is not addressed.
- Request application: all `headerValues` injected as HTTP headers. Not stated.
- Refresh: N/A.
- Error handling: not described.
- Library: none. No gap.

### 1.10 `aws_iam`

- Config / secrets boundary: `region`, `service` in config; `accessKeyId`, `secretAccessKey`,
  `sessionToken?` in secrets.
- **`sessionToken` expiry gap**: When `sessionToken` is present (STS-issued temporary credentials),
  it has a TTL (typically 1–12 hours). The design has no mechanism to refresh temporary STS
  credentials. Options include: (a) re-assuming the IAM role using a role ARN stored in config,
  or (b) requiring the user to update the profile before expiry. Neither is addressed. The design
  also does not include `roleArn` or `externalId` in `config`, which are needed for role-assumption
  flows. This is a significant gap for any AWS deployment that uses IAM roles rather than long-lived
  access keys.
- Request application: **not specified** beyond library name. AWS SigV4 requires signing a canonical
  request string covering method, URI, query params, headers, and body hash. The design does not
  describe which headers are signed, whether `x-amz-date` and `x-amz-security-token` headers are
  added automatically, or how the `service` config field maps to the SigV4 service name parameter.
- Error handling: AWS 403 / `SignatureDoesNotMatch` response handling not described.
- Library: `@aws-sdk/signature-v4`. Direct import. No gap.

### 1.11 `azure_ad`

- Config / secrets boundary: `tenantId`, `resource`, `endpoint` in config; `clientId`,
  `clientSecret` in secrets.
- **Token refresh gap**: `@azure/identity` produces access tokens with ~1 hour TTL. Azure tokens
  can be refreshed silently (the SDK caches credentials internally). The design does not specify:
  - Whether the SDK's internal token cache is trusted or the platform manages expiry.
  - Whether `expiresAt` is tracked in the profile's config (analogous to `oauth2_token`).
  - What happens on a 401 from the Azure endpoint (force-refresh the token cache?).
- Request application: not specified. Standard is `Authorization: Bearer <azure_token>`. Not stated.
- Error handling: Azure 401 / token expiry not described.
- Library: `@azure/identity`. Lazy import. No gap.

### 1.12 `kerberos`

- Config / secrets boundary: clear and detailed.
- **Request application: not specified at all**. Kerberos SPNEGO authentication over HTTP requires:
  - Obtaining a service ticket for `servicePrincipal` using the keytab or password.
  - Base64-encoding the GSSAPI/SPNEGO token.
  - Sending `Authorization: Negotiate <base64token>` on the request.
  - Potentially handling multi-round `WWW-Authenticate: Negotiate <token>` challenges.
    None of this is described. The `kerberos` npm library's API for HTTP negotiation must be
    specified (it is not obvious — the library wraps native GSSAPI, not an HTTP client).
- **Token refresh/TTL gap**: Kerberos service tickets have configurable TTLs (typically 8–10 hours,
  renewable up to 7 days). The design does not describe:
  - How often a new service ticket is obtained.
  - Whether the ticket is cached per-profile in Redis.
  - What happens when a ticket expires mid-session.
  - How `delegateCredentials: true` interacts with ticket forwarding in proxy scenarios.
- Error handling: `401 Unauthorized` with `WWW-Authenticate: Negotiate` challenge not described.
- Library: `kerberos` npm. Lazy import. The Dockerfile requirement (native C++ bindings,
  `libkrb5-dev`) is documented in the library table — this is the only auth type with a
  **native binary dependency**. The review notes this is called out, but the design does not
  specify which app Dockerfiles need the apt-get lines. The note says "Dockerfile builder stages
  need..." without naming the specific files — implementers must check all four Dockerfiles
  (`apps/runtime/Dockerfile`, `apps/search-ai/Dockerfile`, `apps/admin/Dockerfile`,
  `apps/studio/Dockerfile`). Given that `kerberos` is only relevant to runtime/search-ai
  (enterprise connectors), only those two Dockerfiles should be modified. This should be stated.

### 1.13 `saml`

- Config / secrets boundary: clear and detailed.
- **Request application: not specified for the outbound case**. SAML 2.0 has two main use patterns:
  - **Inbound** (SP-initiated SSO): The platform is the Service Provider. A user authenticates via
    IdP and the platform consumes a SAML assertion. This is "platform login" SSO which the design
    explicitly excludes (`Organization.ssoConfigs` is out of scope).
  - **Outbound** (as a bearer credential for API calls): The platform acts as an SP requesting a
    SAML assertion to call an external API that accepts SAML bearer tokens. This is the use case
    implied by having `saml` as a tool/connector auth type.
    The design does not specify which use case is in scope. If it is the outbound bearer token
    pattern, the design must describe: how the SAML assertion is obtained (from IdP via
    `idpSsoUrl`), how it is packaged in the HTTP request (typically
    `Authorization: SAML <base64-assertion>` or in a SOAP header), and the assertion TTL.
    If this type is only intended for inbound SSO (channel adapters verifying inbound webhooks),
    that must be stated clearly.
- **Token refresh/TTL gap**: SAML assertions have a `NotOnOrAfter` expiry. No refresh strategy
  is described.
- Error handling: assertion expiry / signature verification failure not described.
- Library: `@node-saml/node-saml`. Lazy import. No gap, but the purpose must be clarified.

### 1.14 `hawk`

- Config / secrets boundary: clear and detailed.
- **Request application: not specified beyond library name**. Hawk requires computing a MAC over
  the request method, URI, timestamp, nonce, and optionally the body hash. The resulting
  `Authorization: Hawk id="...", ts="...", nonce="...", mac="..."` header format is not described.
  The design must state: (a) Hawk signs each request individually (no token to cache), (b) nonce
  generation strategy, (c) `ext` and `dlg` config fields affect the MAC calculation and must be
  passed to the library's `header()` call.
- Refresh: N/A (per-request MAC computation, no token to refresh).
- **Clock skew handling**: `timestampSkewSec` and `localtimeOffsetMsec` are in config but their
  effect on server-side validation is not described. Specifically: if the server rejects a Hawk
  request due to clock skew, should the client retry with the server's `ts` from the
  `WWW-Authenticate` response? This retry-on-clock-skew pattern is standard in Hawk
  implementations but is not mentioned.
- Error handling: 401 with stale timestamp not described.
- Library: `@hapi/hawk`. Lazy import. No gap.

### 1.15 `ssh_key`

- Config / secrets boundary: `keyType` in config; `privateKey`, `passphrase?` in secrets.
- **Request application: completely unspecified**. SSH keys are not an HTTP authentication
  mechanism. They are used for: (a) Git operations over SSH, (b) SSH tunnel establishment,
  (c) remote command execution. The design must specify the use case. The Consumer Reference
  Model lists `ssh_key` only for "Git Integration" (`authProfileId`). If that is the sole use
  case, the design should state: "This type is not applied to HTTP requests. The Git client
  (e.g., `simple-git`) receives the private key path or passphrase via environment variable."
  Without this, an implementer might try to inject an SSH key as an HTTP header, which is
  nonsensical.
- Refresh: N/A.
- Error handling: not described (key rejected by remote? passphrase failure?).
- Library: none listed. For actual SSH connections, `ssh2` or similar is required. Git over SSH
  uses system `git` + `GIT_SSH_COMMAND`. Neither is mentioned.

### 1.16 `mtls`

- Config / secrets boundary: clear. Secrets hold `clientCert`, `clientKey`, `caCert?`.
- **Request application: completely unspecified**. mTLS requires configuring the TLS socket, not
  HTTP headers. The Node.js `https.Agent` (or `fetch`-compatible equivalent) must be configured
  with `cert`, `key`, and optionally `ca`. The design does not describe:
  - Which HTTP client is used (native `fetch`, `node-fetch`, `axios`)?
  - How the TLS agent is constructed and passed to the HTTP call.
  - Whether `caCert` is appended to the system CA store or replaces it.
  - How this interacts with the proxy addon (a proxy intercepts TLS, defeating the mTLS purpose).
- Refresh: N/A (certificates have expiry via `expiresAt` field but no rotation mechanism is
  described for certificate renewal).
- **Certificate expiry**: The `expiresAt` field exists on the Auth Profile but there is no
  mechanism for notifying users that a client certificate is approaching expiry. This is
  especially important since expired client certificates cause TLS handshake failures, not HTTP
  401s, and are harder to diagnose.
- Error handling: TLS handshake failure (certificate rejected by server) not described.
- Library: none. Node built-in TLS. No external dependency gap.

### 1.17 `ws_security`

- Config / secrets boundary: clear and detailed.
- **Request application: completely unspecified**. WS-Security requires modifying the SOAP
  envelope XML (not HTTP headers). Specifically:
  - `UsernameToken` mode: adds `<wsse:UsernameToken>` with `<wsse:Username>` and
    `<wsse:Password>` (plaintext or digest) to the SOAP header.
  - `x509` mode: signs the SOAP body using the private key and embeds the certificate.
  - `username_token_x509` mode: both of the above.
    The design never describes how the `soap` library is invoked (it provides `setSecurity()`),
    which SOAP client wraps the HTTP call, or how WS-Security headers are constructed and attached.
- Refresh: N/A (per-request computation, no token).
- Error handling: SOAP fault for invalid security not described.
- Library: `soap`. Lazy import. However, `soap` is a SOAP **client** library, not just a
  WS-Security signing library. Using it only for WS-Security signing may be overly heavy.
  `xml-crypto` or `wssecurity` npm packages are purpose-built alternatives. This is a library
  choice gap, not a blocking issue.
- **Use case ambiguity**: `wsdlUrl` in config suggests this type is for SOAP-over-HTTP services.
  The design should explicitly state that `ws_security` is not applicable to REST HTTP calls.

---

## 2. Missing Auth Types Found in Codebase

### 2.1 `searchai` (Compiler `ToolAuthTypeIR`)

**Status: Active, unrepresented in the 17 types.**

The compiler's `ToolAuthTypeIR` type (`packages/compiler/src/platform/ir/schema.ts:715`) includes
a `'searchai'` auth type that is not in the Auth Profile's 17-type enum. This is a first-class
auth pattern with:

- Its own case in `auth-config-builder.ts` (`buildAuthConfigFromAST`)
- Its own executor path in `http-tool-executor.ts` (lines 710–805) with two modes:
  full token lifecycle (fetch JWT from `tokenUrl` using `clientId`/`clientSecret`) and env-backed
  token (read from secrets provider with 401 retry)
- Dedicated tests (`packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`)

The SearchAI consumer mapping (Section 4) shows `ConnectorConfig (SearchAI)` uses `oauth2_token`,
but the actual credential mechanism used by the DSL-defined HTTP tools calling SearchAI is
`searchai`, not `oauth2_token`. These are distinct. The `searchai` type needs either:

- A new 18th auth type in the Auth Profile model (if it is to be a first-class credential type), or
- An explicit statement that `searchai` DSL auth is being migrated to `oauth2_client_credentials`,
  and a mapping of the existing `searchai` config fields (`tokenUrl`, `clientId`, `clientSecret`,
  `botId`, `headerName`) to the new model.

Without this, the migration from `{{secrets.X}}` to `auth:` for SearchAI internal tools is
undefined.

### 2.2 `device_code` OAuth Flow (`packages/connectors/base/src/auth/device-code-flow.ts`)

**Status: Active in `search-ai` connector service, not addressable via Auth Profile.**

The SearchAI connector service (`apps/search-ai/src/services/connector.service.ts`) supports three
`authMethod` values: `device_code`, `authorization_code`, and `client_credentials`. The
`device_code` and `authorization_code` flows produce `oauth2_token` credentials, but the flow
initiation (the interactive device code display, polling, callback handling) is a connector-level
behavior. The Auth Profile design migrates the `ConnectorConfig.oauthTokenId` to `authProfileId`
but does not address how the **flow initiation endpoints** for `device_code` and
`authorization_code` (currently in `apps/search-ai/src/routes/connectors.ts`) map to the new
OAuth flow endpoints (`POST /api/projects/:pid/auth-profiles/oauth/initiate` and
`/oauth/callback`). The design's OAuth flow endpoints appear to cover only authorization-code flow
(they produce a `state` + `authUrl`). Device code flow is different and not mentioned.

### 2.3 Cookie/Session-Based Auth (Admin Proxy)

**Status: Internal only, no gap for external tool auth.**

The admin app uses cookie-based session authentication (`apps/admin/src/proxy.ts`). This is
platform-internal and not a connector/tool auth type. Confirmed out of scope. No gap.

### 2.4 NTLM

No NTLM patterns found in the codebase. Not a gap for the current platform scope.

### 2.5 Client Certificate (TLS) Authentication

Covered by `mtls`. No separate gap beyond the request-application specification gap in §1.16.

---

## 3. Addon Layer Gaps

### 3.1 Request Signing (HMAC)

- **Composition with `aws_iam`**: The `aws_iam` type already performs SigV4 signing. Adding a
  `signing` addon on top of an `aws_iam` profile is either redundant or conflicting. The design
  provides a composable-examples list but does not flag invalid combinations. Specifically:
  `aws_iam + signing` should be explicitly called out as a conflict (aws_iam handles its own
  signing; a second HMAC signing layer would corrupt the request).
- **Signing order when combined with proxy**: When both `signing` and `proxy` addons are present,
  the signing must happen **before** the request is sent to the proxy (to sign the intended target
  URL), or **after** (to sign the proxy URL). The design does not specify the evaluation order.
- **`rsa-sha256` algorithm**: Requires a private key. The design does not state where this key is
  stored. It is presumably in `encryptedSecrets` as a `signingSecret` field, but RSA keys are
  structurally different from HMAC secrets. The encrypted secrets blob structure for the `signing`
  addon is not defined.

### 3.2 JWT Wrapping

- **`jwtSigningKey` storage**: The design mentions `jwtSigningKey in encryptedSecrets` as a comment
  in the code block but does not specify the field structure in the Validation Rules table or
  Database Schema section. An `HS256` signing key is a symmetric secret; `RS256`/`ES256` require
  an asymmetric private key (PEM-encoded). These are structurally different. The encrypted secrets
  blob for this addon is not defined anywhere.
- **Combination with `oauth2_token`**: `bearer + jwtWrapping` is listed as a valid composition
  example. However, combining `oauth2_token + jwtWrapping` would create a JWT that wraps an
  existing OAuth bearer token. Is this valid? The use case is not described.
- **JWT claim value templating**: `claims?: Record<string, string>` allows custom claims. Can
  claim values reference the base auth profile's resolved credentials (e.g., include the user ID
  from `oauth2_token`)? This dynamic claims use case is not addressed.

### 3.3 Webhook Verification (Inbound)

- **Direction ambiguity**: The addon is named "Webhook Verification" with description "inbound" in
  the code comment, but it is defined on an `AuthProfile` entity that represents **outbound**
  credentials. The SDK Channel and WebhookSubscription consumers use this addon for verifying
  that **incoming** webhook payloads are authentic. This is the correct use — but the design never
  explicitly states that this addon is exclusively for **inbound request verification**, not for
  signing outbound requests. Without this statement, implementers may confuse it with the `signing`
  addon.
- **`webhookSecret` storage**: Same gap as `signing` — the comment says `webhookSecret in
encryptedSecrets` but the encrypted secrets blob structure for this addon is not defined in the
  Validation Rules table.
- **`svix` method**: The `svix` verification method has a unique signature structure (includes
  message ID and timestamp). The design does not describe how `svix` differs from `hmac-sha256`
  in implementation (Svix uses `svix-signature`, `svix-id`, `svix-timestamp` headers).

### 3.4 Certificate Pinning

- **Interaction with `mtls`**: Certificate pinning and mTLS both operate at the TLS layer. When
  both are present, the pinning check validates the **server's** certificate against the stored
  pins. `mtls` provides the **client's** certificate. These are complementary and can coexist.
  The design does not explain this, which could cause confusion.
- **`report-only` mode**: What is reported and where? The design mentions `enforceMode:
'report-only'` but does not describe the report destination (log, audit event, alerting
  system). Without this, `report-only` mode is unimplementable.
- **Pin format**: SHA-256 fingerprints should be SPKI fingerprints (not whole-certificate
  fingerprints), as recommended by RFC 7469. The design does not specify the pin format.

### 3.5 Proxy

- **Circular reference check**: `proxyAuthProfileId` must point to a different Auth Profile than
  the current one. A profile that proxies through itself would cause infinite recursion. The design
  says "same tenantId" validation but does not prohibit `proxyAuthProfileId === this._id`.
- **Proxy chain depth**: If `Profile A` has `proxyAuthProfileId → Profile B`, and `Profile B` also
  has a `proxy` addon, should chains be followed? The design does not specify a max chain depth or
  whether nested proxies are resolved at all.
- **Valid proxy auth types**: The design does not restrict which auth types are valid for a proxy
  profile. A proxy referenced by `proxyAuthProfileId` should only be `basic`, `bearer`, or `mtls`
  (standard proxy auth methods). Using `kerberos` or `ws_security` as proxy auth would be
  nonsensical. No validation rule is specified.
- **Interaction with `signing`**: When both `signing` and `proxy` addons are present (see §3.1
  above), the order of application is unspecified.

### 3.6 Invalid Combination Guardrails (Missing)

The design lists five composable examples but provides no list of **invalid** compositions.
Combinations that should be rejected (or at minimum warned):

| Combination                                     | Reason                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `aws_iam` + `signing`                           | AWS SigV4 is itself a signing mechanism; double-signing corrupts the request   |
| `ws_security` + any HTTP addon                  | `ws_security` operates on SOAP XML, not HTTP; HTTP-layer addons are irrelevant |
| `ssh_key` + `signing` / `jwtWrapping` / `proxy` | SSH key is not used in HTTP requests                                           |
| `webhookVerification` + `signing`               | These are opposite directions (inbound vs outbound)                            |
| `mtls` + `proxy`                                | mTLS is typically terminated at the proxy, not forwarded                       |

The design should include a compatibility matrix or at minimum a validation rule that rejects
structurally nonsensical combinations at profile creation time.

---

## 4. Config/Secrets Boundary Ambiguities

### 4.1 `oauth2_app` — `clientId` Placement

The type table places `clientId` and `clientSecret` in `encryptedSecrets`. The Validation Rules
table confirms this. However, `clientId` in OAuth 2.0 is **not a secret** — it is a public
identifier (it appears in authorization URLs, redirect URIs, and is shared with the identity
provider in plaintext). Encrypting it provides no security benefit but prevents it from being
returned in API responses without decryption. The design should explicitly justify this choice
(e.g., "clientId is encrypted alongside clientSecret for simplicity, even though it is not
sensitive") to prevent future implementers from moving it to `config`.

### 4.2 `custom_header` — Static vs Dynamic Header Values

As noted in §1.9: the design does not address whether header values that are **not secrets** (e.g.,
`X-API-Version: v2`) belong in `config.headers` (with a null secrets entry) or whether all header
values must be in `encryptedSecrets`. The model forces all header values into encrypted storage,
which is wasteful for non-sensitive headers.

### 4.3 `aws_iam` — `sessionToken` Conditional Requirement

`sessionToken?` is marked optional in `encryptedSecrets`. The design does not specify when it is
required vs absent. STS temporary credentials always include a session token; long-lived IAM user
credentials never do. A Zod validation rule should enforce: if `sessionToken` is present, then
`expiresAt` must also be set (STS credentials always expire). This is not stated.

### 4.4 `digest` — `realm` and `opaque` in Config

`realm?` and `opaque?` are in `config`. These values come from the server's `WWW-Authenticate`
header, not from the credential owner. Pre-populating them skips the initial unauthenticated
challenge round-trip (performance optimization). However, if the server changes its realm, the
stored config will be stale and the auth will fail silently without a clear error. The design
should specify whether these are optional hints (pre-populate to skip the challenge) or required
fields.

### 4.5 `kerberos` — Dual Secret Types (`keytab` vs `password`)

The Validation Rules table says `keytab OR password` is required, but both are optional in the
type table (`keytab?` and `password?`). The Zod discriminated union must enforce that exactly one
of the two is present (`keytab XOR password`). This validation rule is not described.

### 4.6 Addon Secrets Not in Encrypted Secrets Schema

The `encryptedSecrets` field is a single AES-256-GCM encrypted JSON blob. Addons (`signing`,
`jwtWrapping`, `webhookVerification`) also have secrets (`signingSecret`, `jwtSigningKey`,
`webhookSecret`). These secrets are mentioned only in code comments within the addon type
definitions. They are never included in:

- The Validation Rules table.
- The Database Schema section.
- The Zod validation spec.

The encrypted secrets blob must include addon secrets alongside the base-type secrets, or addon
secrets must be stored in a separate encrypted field. Neither approach is specified.

---

## 5. Other Gaps Not Covered by the Four Review Axes

### 5.1 Credential Validation Strategy per Auth Type

The `/validate` endpoint is declared (`POST /api/auth-profiles/:id/validate`) but the design
never specifies how validation works for each type. For example:

- `api_key`: make a test HTTP call to what endpoint?
- `oauth2_token`: check `expiresAt` only, or actually call the token introspection endpoint?
- `kerberos`: attempt to get a service ticket?
- `mtls`: perform a TLS handshake?
- `ssh_key`: attempt a Git ls-remote?
- `ws_security`: there is no generic test endpoint for SOAP services.

Without per-type validation logic, the validate endpoint will be a no-op for most types.

### 5.2 `oauth2_client_credentials` Token Caching Location

The design says this type replaces `getOAuthToken()` in `service-node-executor.ts`, which uses a
local `Map`-based token cache. The CLAUDE.md rules require "Every in-memory `Map` needs max size,
TTL, and eviction." The design does not specify whether the replacement uses:

- A shared Redis cache (required for multi-pod deployments to avoid thundering herd on token
  renewal).
- A per-pod in-memory cache with the same expiry logic.
- The `AuthProfile.config.expiresAt` field as the canonical expiry tracker.

### 5.3 `digest-fetch` Loading Strategy Inconsistency

The library table marks `digest-fetch` as "Direct import" while all other protocol-specific
libraries (`@node-saml/node-saml`, `@hapi/hawk`, `soap`, `kerberos`, `@azure/identity`) use
lazy `import()`. `digest-fetch` is only needed when the `digest` auth type is used. This
inconsistency should be intentional or corrected.

---

## 6. Summary Table

| Gap                                                       | Severity | Affected Types                                                                                         |
| --------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| No request-application spec                               | Critical | `basic`, `digest`, `kerberos`, `saml`, `hawk`, `aws_iam`, `azure_ad`, `mtls`, `ws_security`, `ssh_key` |
| No token refresh/rotation spec                            | High     | `oauth2_client_credentials`, `aws_iam` (STS), `azure_ad`, `kerberos`, `saml`                           |
| `searchai` type unrepresented                             | High     | New type or migration mapping needed                                                                   |
| Addon secrets not in encrypted secrets schema             | High     | `signing`, `jwtWrapping`, `webhookVerification`                                                        |
| No invalid combination validation                         | Medium   | `aws_iam+signing`, `ws_security+HTTP addons`, `ssh_key+HTTP addons`                                    |
| `oauth2_app` is never applied to HTTP requests (unstated) | Medium   | `oauth2_app`                                                                                           |
| `aws_iam` missing `roleArn`/STS refresh                   | Medium   | `aws_iam`                                                                                              |
| `ssh_key` use case unspecified                            | Medium   | `ssh_key`                                                                                              |
| `saml` outbound vs inbound use case unspecified           | Medium   | `saml`                                                                                                 |
| Proxy circular reference + chain depth unspecified        | Medium   | `proxy` addon                                                                                          |
| Validate endpoint per-type strategy missing               | Medium   | all types                                                                                              |
| `clientId` in secrets for `oauth2_app` unjustified        | Low      | `oauth2_app`                                                                                           |
| `digest-fetch` should be lazy-loaded                      | Low      | `digest`                                                                                               |
| `kerberos` Dockerfile scope over-broad                    | Low      | `kerberos`                                                                                             |
| `device_code` flow not mapped to new OAuth endpoints      | Low      | `device_code` connector flow                                                                           |
| `ws_security` library choice not final                    | Low      | `ws_security`                                                                                          |

```

Now I need to save this file and run prettier. Since I don't have a write tool in this environment, I'll present this to the user. Let me check if there's a way to use bash:

Looking at the available tools again: Glob, Grep, Read, WebFetch, WebSearch. There is no Bash or Write tool. I cannot directly create the file.

I'll present this as my response with the full file content and explicit save instructions.

---

I cannot directly write files with the tools available in this environment. Here is the complete review file content to save, followed by the prettier command to run.

**Save the following to `/Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-review-auth-types.md`, then run:**

```

npx prettier --write /Users/prasannaarikala/projects/agent-platform/docs/plans/2026-03-11-auth-profile-review-auth-types.md

````

---

## Review File Content

```markdown
# Auth Profile Design — Auth Type Coverage Review

> Reviewed: `docs/plans/2026-03-11-auth-profile-design.md`
> Reviewer: Code-review agent
> Date: 2026-03-11
> Scope: Auth type completeness, missing auth patterns, addon layer gaps, config/secrets boundary clarity

---

## Executive Summary

The design covers the 17 declared auth types at a schema level (config fields, encrypted secrets,
library selection) but has systematic gaps in three areas:

1. **No request-application specification** — the design never describes how each auth type mutates
   an outbound HTTP request (header format, body modification, TLS layer). This is the most critical
   gap: an implementer cannot write `applyAuth()` from the doc alone for 9 of 17 types.

2. **Token refresh/rotation is specified only for `oauth2_token`** — the five other types that
   produce short-lived credentials (`aws_iam` with STS, `azure_ad`, `oauth2_client_credentials`,
   `kerberos`, and `saml` assertions) have no refresh strategy documented.

3. **One active auth pattern in the codebase is not in the 17 types** — the `searchai` auth mode
   used by `ToolAuthTypeIR` in the compiler. It is a first-class auth pattern with its own executor
   logic and tests but has no representation in the Auth Profile model.

There are also narrower gaps in the addon layer (webhook verification direction ambiguity, proxy
circular-reference check, no invalid-combination guardrails) and several config/secrets boundary
ambiguities for `custom_header`, `aws_iam`, and `oauth2_app`.

---

## 1. Auth Type Completeness — Per-Type Analysis

### 1.1 `none`

- Config/secrets boundary: clear (both empty).
- Request application: trivial no-op. Not explicitly stated but safely implied.
- Refresh: N/A.
- Error handling: N/A.
- Library: none. No gap.

### 1.2 `api_key`

- Config/secrets boundary: clear. `headerName`, `prefix`, `placement` in config; `apiKey` in secrets.
- **Request application gap**: The design lists `placement: 'header' | 'query'` in config but never
  describes the injection logic. When `placement = 'query'`, which query-parameter name is used —
  the value of `headerName`? A separate `queryParamName` field? The existing
  `service-node-executor.ts` only implements header injection; the `queryParam` field in the IR
  schema (`HttpBindingIR.auth.config.queryParam`) is a distinct concept. The design must specify: when
  `placement = 'query'`, the parameter name equals `headerName`.
- **Rotation gap**: The `rotationPolicy` + `rotationGracePeriodMs` fields exist but no trigger
  mechanism is specified — is rotation schedule-based, age-based, or manual only?
- Error handling: 401 response behavior not described (should mark `status: 'expired'`?).
- Library: none. No gap.

### 1.3 `bearer`

- Config/secrets boundary: clear.
- Request application: implied `Authorization: Bearer <token>` but not explicitly stated.
- Refresh: same rotation gap as `api_key`.
- Error handling: not described.
- Library: none. No gap.

### 1.4 `basic`

- Config/secrets boundary: clear.
- **Request application gap**: Standard is `Authorization: Basic base64(username:password)`. The
  design never states this. The codebase confirms the pattern
  (`zendesk-adapter.ts:339`, `twilio-sms-media-downloader.ts:91`) but the design doc must specify it.
- Refresh: N/A (covered by rotation policy).
- Error handling: not described.
- Library: none. No gap.

### 1.5 `digest`

- Config/secrets boundary: clear. Algorithm, qop, realm in config; username/password in secrets.
- **Request application: significantly underspecified**. HTTP Digest (RFC 7616) requires a
  challenge-response handshake: the client makes an unauthenticated request, receives
  `WWW-Authenticate: Digest ...` with a server nonce, then resubmits with a computed response. The
  design does not describe:
  - That the initial unauthenticated request and 401 retry are required.
  - How nonce, cnonce, nc counter, and qop affect the `Authorization` header.
  - Whether `realm` and `opaque` in config are pre-supplied hints (to skip the first round-trip) or
    validated against the server's challenge.
  The `digest-fetch` library handles this internally, but the design must state that it is used as the
  HTTP client wrapper, not merely listed in the library table.
- Refresh: N/A (per-request computation).
- Error handling: 401 with a fresh nonce triggers recomputation — not described.
- **Loading strategy inconsistency**: The library table marks `digest-fetch` as "Direct import" while
  all other protocol libraries use lazy `import()`. `digest-fetch` is only needed when `digest` auth
  is used and should be lazy-loaded for consistency.

### 1.6 `oauth2_app`

- Config/secrets boundary: mostly clear. However, the design never states that `oauth2_app` is
  **never applied directly to HTTP requests** — it only exists to mint tokens. This must be explicit
  to prevent misuse.
- Request application: none. Must be stated explicitly.
- Refresh: N/A (its children `oauth2_token` profiles refresh using it).
- Error handling: `clientSecret` invalidity at token exchange time is not described in Section 10.
  Only `oauth2_token` expiry is covered.
- **`clientId` in secrets**: OAuth 2.0 `clientId` is a public identifier (it appears in
  authorization URLs and is shared with identity providers in plaintext). Encrypting it provides no
  security benefit. The design should justify this choice explicitly, e.g.: "`clientId` is encrypted
  alongside `clientSecret` for simplicity even though it is not sensitive." Without justification,
  future implementers will move it to `config`.
- Library: `simple-oauth2`. No gap.

### 1.7 `oauth2_token`

- Config/secrets boundary: clear and detailed.
- Request application: implied `Authorization: Bearer <accessToken>` — not explicitly stated.
- **Refresh: well specified**. The 7-step distributed-lock procedure in Section 5 is the best-
  specified type in the document. No gap.
- Error handling: `status → 'expired'` on refresh failure is described. No gap.
- Library: `simple-oauth2`. No gap.

### 1.8 `oauth2_client_credentials`

- Config/secrets boundary: clear. `tokenUrl`, `scopes` in config; `clientId`, `clientSecret` in
  secrets.
- Request application: token is fetched and injected as `Authorization: Bearer`. Not stated.
- **Refresh gap (critical)**: The design specifies token refresh only for `oauth2_token`. Client
  credentials also produce short-lived access tokens that expire. The design does not describe:
  - Whether the cached token is reused until expiry (standard pattern) or fetched per request.
  - Where token expiry/TTL is tracked — the profile's `config` has no `expiresAt` field for this
    type, unlike `oauth2_token`.
  - Whether the distributed lock pattern from Section 5 applies to concurrent refresh.
  - What happens on a 401 from the downstream service (retry with a fresh token?).
  - Whether the replacement for `getOAuthToken()` in `service-node-executor.ts` uses a shared Redis
    cache (required for multi-pod deployments) or a per-pod in-memory cache.
- Error handling: client-credentials token fetch failure not described.
- Library: `simple-oauth2`. No gap.

### 1.9 `custom_header`

- **Config/secrets boundary: ambiguous**. Config has `headers: Record<string, string>` (header
  names) and secrets have `headerValues: Record<string, string>`. The design does not state that the
  keys in both maps must match. It also does not address whether non-sensitive static header values
  (e.g., `X-API-Version: v2`) can have their values in `config.headers` directly — the current model
  forces all header values into encrypted storage regardless of sensitivity.
- Request application: all `headerValues` injected as HTTP headers. Not stated.
- Refresh: N/A.
- Error handling: not described.
- Library: none. No gap.

### 1.10 `aws_iam`

- Config/secrets boundary: `region`, `service` in config; `accessKeyId`, `secretAccessKey`,
  `sessionToken?` in secrets.
- **`sessionToken` expiry gap**: When `sessionToken` is present (STS temporary credentials), it
  has a TTL of 1–12 hours. The design has no mechanism to refresh STS credentials. The config also
  lacks `roleArn` and `externalId` fields needed for role-assumption flows. For tenants that use IAM
  roles rather than long-lived access keys, the current model is insufficient.
- **`sessionToken` validation gap**: When `sessionToken` is present, `expiresAt` should be
  required (STS credentials always expire). This Zod validation rule is not specified.
- **Request application: not specified** beyond library name. AWS SigV4 requires signing a canonical
  request covering method, URI, query params, headers, and body hash. The design does not describe
  which headers are signed, whether `x-amz-date` and `x-amz-security-token` are added automatically,
  or how the `service` config field maps to the SigV4 service name parameter.
- Error handling: AWS 403 / `SignatureDoesNotMatch` not described.
- Library: `@aws-sdk/signature-v4`. Direct import. No gap.

### 1.11 `azure_ad`

- Config/secrets boundary: `tenantId`, `resource`, `endpoint` in config; `clientId`, `clientSecret`
  in secrets.
- **Token refresh gap**: `@azure/identity` produces tokens with ~1 hour TTL. The design does not
  specify whether the SDK's internal token cache is trusted, whether `expiresAt` is tracked in the
  profile's config (analogous to `oauth2_token`), or what happens on a 401 (force-refresh the SDK
  token cache?).
- Request application: implied `Authorization: Bearer <azure_token>`. Not stated.
- Error handling: Azure 401 / token expiry not described.
- Library: `@azure/identity`. Lazy import. No gap.

### 1.12 `kerberos`

- Config/secrets boundary: clear and detailed.
- **Request application: not specified at all**. Kerberos SPNEGO over HTTP requires: (1) obtaining
  a service ticket for `servicePrincipal` using the keytab or password, (2) base64-encoding the
  GSSAPI/SPNEGO token, (3) sending `Authorization: Negotiate <base64token>`, (4) potentially
  handling multi-round `WWW-Authenticate: Negotiate <token>` challenges. The `kerberos` npm library
  wraps native GSSAPI — its API for HTTP negotiation must be described.
- **Token refresh/TTL gap**: Kerberos service tickets have configurable TTLs (typically 8–10 hours,
  renewable up to 7 days). The design does not describe how often a new ticket is obtained, whether
  tickets are cached in Redis, what happens when a ticket expires mid-session, or how
  `delegateCredentials: true` interacts with ticket forwarding.
- Error handling: `401 Unauthorized` with `WWW-Authenticate: Negotiate` challenge not described.
- **Dockerfile scope**: The note about native C++ bindings and `libkrb5-dev` does not name which
  Dockerfiles require the `apt-get` additions. Since `kerberos` is only relevant to enterprise
  connectors, only `apps/runtime/Dockerfile` and `apps/search-ai/Dockerfile` should be modified —
  the admin and studio Dockerfiles should not. This should be stated explicitly.
- Library: `kerberos` npm. Lazy import. No gap in loading strategy.

### 1.13 `saml`

- Config/secrets boundary: clear and detailed.
- **Use case ambiguity (critical)**: SAML 2.0 has two primary uses: (1) inbound SP-initiated SSO
  (platform as Service Provider consuming IdP assertions for user login), which the design explicitly
  excludes; (2) outbound SAML bearer token authentication (platform uses a SAML assertion as a
  bearer credential to call an external API). The design does not state which use case `saml` covers
  as a tool/connector auth type. If it is the outbound bearer token pattern, the design must
  describe: how the assertion is obtained from the IdP via `idpSsoUrl`, how it is packaged in the
  HTTP request (`Authorization: SAML <base64-assertion>` or in a SOAP header), and the assertion TTL.
- **Token refresh/TTL gap**: SAML assertions have a `NotOnOrAfter` expiry. No refresh strategy is
  described.
- Error handling: assertion expiry / signature verification failure not described.
- Library: `@node-saml/node-saml`. Lazy import. No gap.

### 1.14 `hawk`

- Config/secrets boundary: clear and detailed.
- **Request application: not specified** beyond library name. Hawk requires computing a MAC over
  request method, URI, timestamp, nonce, and optionally body hash. The resulting `Authorization:
  Hawk id="...", ts="...", nonce="...", mac="..."` format is not described. The design must state:
  (a) Hawk signs each request individually (no token to cache), (b) nonce generation strategy,
  (c) `ext` and `dlg` config fields must be passed to `@hapi/hawk`'s `header()` call.
- **Clock skew retry**: If the server rejects a Hawk request due to clock skew (401 with a
  `WWW-Authenticate` header containing the server's `ts`), should the client retry with the server's
  timestamp? This standard Hawk pattern is not mentioned.
- Refresh: N/A (per-request MAC computation).
- Error handling: 401 stale timestamp not described.
- Library: `@hapi/hawk` v7.1.1. Lazy import. No gap.

### 1.15 `ssh_key`

- Config/secrets boundary: `keyType` in config; `privateKey`, `passphrase?` in secrets.
- **Request application: completely unspecified**. SSH keys are not an HTTP authentication
  mechanism. The Consumer Reference Model lists `ssh_key` only for "Git Integration". The design
  must explicitly state: "This type is not applied to HTTP headers. The Git client receives the
  private key via environment variable or `GIT_SSH_COMMAND`." Without this, an implementer may
  attempt to inject an SSH key as an HTTP header.
- Refresh: N/A.
- Error handling: not described (key rejected by remote? passphrase failure?).
- **Missing library**: For SSH key operations, `ssh2` or integration with system `git` +
  `GIT_SSH_COMMAND` is required. Neither is mentioned in the library table.

### 1.16 `mtls`

- Config/secrets boundary: clear. Secrets hold `clientCert`, `clientKey`, `caCert?`.
- **Request application: completely unspecified**. mTLS requires configuring the TLS socket, not
  HTTP headers. The design does not describe: which HTTP client is used, how the TLS agent is
  constructed (`https.Agent` with `cert`/`key`/`ca`), whether `caCert` is appended to the system CA
  store or replaces it, or how this interacts with the `proxy` addon (a proxy intercepts TLS,
  typically defeating the mTLS purpose).
- **Certificate expiry**: The `expiresAt` field exists but there is no mechanism for notifying users
  that a client certificate is approaching expiry. Expired client certificates cause TLS handshake
  failures (not HTTP 401s) and are harder to diagnose.
- Error handling: TLS handshake failure not described.
- Library: Node.js built-in TLS. No external dependency gap.

### 1.17 `ws_security`

- Config/secrets boundary: clear and detailed.
- **Request application: completely unspecified**. WS-Security modifies the SOAP envelope XML, not
  HTTP headers. The design never describes how the `soap` library's `setSecurity()` is invoked,
  which SOAP client wraps the HTTP call, or how the three modes (`username_token`, `x509`,
  `username_token_x509`) produce different SOAP header structures.
- **Use case ambiguity**: `wsdlUrl` in config suggests this type is for SOAP-over-HTTP services. The
  design must explicitly state that `ws_security` is not applicable to REST HTTP calls.
- Refresh: N/A (per-request computation).
- Error handling: SOAP fault for invalid security not described.
- **Library choice gap**: The `soap` npm package is a full SOAP client (~8MB). For WS-Security
  signing alone, `xml-crypto` or the `wssecurity` npm package are purpose-built and much lighter.
  The library choice should be justified or reconsidered.

---

## 2. Missing Auth Types Found in Codebase

### 2.1 `searchai` (Compiler `ToolAuthTypeIR`) — Active, Unrepresented

The compiler's `ToolAuthTypeIR` (`packages/compiler/src/platform/ir/schema.ts:715`) includes a
`'searchai'` auth type that is absent from the Auth Profile's 17-type enum. This is a first-class
pattern with:

- A dedicated case in `packages/compiler/src/platform/ir/auth-config-builder.ts`
- Its own execution path in `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
  (lines 710–805) supporting two modes: full JWT lifecycle (fetch from `tokenUrl` using
  `clientId`/`clientSecret`) and env-backed token (read from secrets provider with 401 retry)
- Dedicated unit tests in `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`

The Section 4 consumer mapping shows `ConnectorConfig (SearchAI)` using `oauth2_token`, but the DSL
auth type used by HTTP tools calling SearchAI is `searchai`, not `oauth2_token`. These are distinct.
The `searchai` type needs either:
- A new 18th auth type in the Auth Profile model, or
- An explicit statement that `searchai` DSL auth migrates to `oauth2_client_credentials`, with a
  field mapping from existing `searchai` config fields (`tokenUrl`, `clientId`, `clientSecret`,
  `botId`, `headerName`) to the new model.

Without this, the migration from `{{secrets.X}}` to `auth:` for SearchAI internal tools is
undefined.

### 2.2 OAuth Device Code Flow — Not Mapped to New Endpoints

The SearchAI connector service (`apps/search-ai/src/services/connector.service.ts`) supports three
`authMethod` values: `device_code`, `authorization_code`, and `client_credentials`. The new OAuth
flow endpoints (`POST .../oauth/initiate` and `.../oauth/callback`) appear to cover only the
authorization-code flow (they produce `state` + `authUrl`). Device code flow is structurally
different (it produces a `device_code` for the user to enter at a verification URL, then polls for
completion). The design does not address how the `device_code` flow in the SearchAI connector maps
to the new Auth Profile OAuth endpoints or whether a separate device-code flow endpoint is needed.

### 2.3 NTLM

No NTLM patterns found in the codebase. Not a gap for current platform scope.

### 2.4 Cookie/Session-Based Auth

The admin proxy uses cookie-based session authentication. This is platform-internal and correctly
out of scope for Auth Profile. No gap.

---

## 3. Addon Layer Gaps

### 3.1 Request Signing (HMAC)

- **`rsa-sha256` secret storage undefined**: This algorithm requires a private key, which is
  structurally different from an HMAC secret. The encrypted secrets blob for the `signing` addon is
  not defined in the Validation Rules table or Database Schema section.
- **`aws_iam` + `signing` conflict**: AWS SigV4 is itself a signing mechanism. Adding a `signing`
  addon to an `aws_iam` profile would produce a double-signed request that AWS will reject. This
  combination must be explicitly flagged as invalid.
- **Signing order with proxy**: When both `signing` and `proxy` addons are present, the design does
  not specify whether signing occurs before or after the proxy URL is substituted into the request.

### 3.2 JWT Wrapping

- **`jwtSigningKey` storage undefined**: The comment `jwtSigningKey in encryptedSecrets` appears in
  the code block but is absent from the Validation Rules table and Database Schema. For `RS256` and
  `ES256`, the signing key is a PEM-encoded private key. For `HS256`, it is a symmetric secret.
  These are structurally different and should be called out.
- **Dynamic claim values**: `claims?: Record<string, string>` allows custom claims. Whether claim
  values can reference the base auth profile's resolved credentials (e.g., include the `oauth2_token`
  user ID) is not addressed.

### 3.3 Webhook Verification (Inbound)

- **Direction not stated**: The design never explicitly states that this addon is exclusively for
  **inbound request verification** (verifying that incoming webhook payloads are authentic), not for
  signing outbound requests. Without this statement, implementers may confuse it with the `signing`
  addon.
- **`webhookSecret` storage undefined**: The comment `webhookSecret in encryptedSecrets` is not
  reflected in the Validation Rules table.
- **`svix` implementation gap**: The `svix` verification method uses distinct headers (`svix-id`,
  `svix-timestamp`, `svix-signature`) and a different verification algorithm from `hmac-sha256`. The
  design does not describe how `svix` differs from standard HMAC in implementation.

### 3.4 Certificate Pinning

- **`report-only` mode destination undefined**: The design mentions `enforceMode: 'report-only'`
  but does not describe where violations are reported (log, audit event, alert). Without this,
  `report-only` mode is unimplementable.
- **Pin format not specified**: SHA-256 fingerprints should be SPKI fingerprints (as recommended by
  RFC 7469), not whole-certificate fingerprints. The format must be specified.

### 3.5 Proxy

- **Circular reference not prevented**: `proxyAuthProfileId` must not equal the current profile's
  `_id`. The design only validates same-tenant membership; it does not prevent a profile from
  proxying through itself.
- **Chain depth not specified**: If profile A has a proxy pointing to profile B, and profile B also
  has a `proxy` addon, the design does not specify whether chains are resolved or rejected.
- **Valid proxy auth types not restricted**: A proxy profile should only be `basic`, `bearer`, or
  `mtls`. Using `kerberos` or `ws_security` as proxy auth is nonsensical. No validation rule is
  specified.

### 3.6 Invalid Combination Guardrails (Missing)

The design lists composable examples but provides no invalid-combination rules. The following
combinations should be rejected at profile creation time:

| Combination | Reason |
| --- | --- |
| `aws_iam` + `signing` | SigV4 is its own signing; double-signing corrupts the request |
| `ws_security` + any HTTP addon | WS-Security operates on SOAP XML, not HTTP headers |
| `ssh_key` + `signing` / `jwtWrapping` / `proxy` | SSH key is not used in HTTP requests |
| `webhookVerification` + `signing` | Opposite directions: inbound vs outbound |
| `mtls` + `proxy` | mTLS is typically terminated at the proxy, not forwarded |

---

## 4. Config/Secrets Boundary Ambiguities

| Type | Ambiguity |
| --- | --- |
| `oauth2_app` | `clientId` is public but encrypted — justification must be explicit |
| `custom_header` | Non-sensitive static values cannot be stored in config; all values forced into encrypted storage |
| `aws_iam` | `sessionToken` presence should require `expiresAt`; not stated in Zod rules |
| `digest` | `realm` / `opaque` in config are pre-supplied hints vs required fields — not distinguished |
| `kerberos` | `keytab XOR password` validation not described (both are optional in the type table) |
| All addon types | Addon secrets (`signingSecret`, `jwtSigningKey`, `webhookSecret`) not in Validation Rules table or Database Schema |

---

## 5. Additional Gaps

### 5.1 Credential Validation Strategy per Auth Type

The `POST .../validate` endpoint is declared but the design never specifies what validation does for
each auth type. Types with non-HTTP mechanisms (`ssh_key`, `kerberos`, `saml`, `ws_security`) have
no obvious generic validation target. Without per-type strategy, the endpoint will be a no-op for
most types.

### 5.2 `oauth2_client_credentials` Token Cache Location

The design replaces `getOAuthToken()` in `service-node-executor.ts`, which uses a local `Map`-based
cache. The CLAUDE.md rule requires "Every in-memory `Map` needs max size, TTL, and eviction."
The design does not specify whether the replacement uses a shared Redis cache (required for multi-pod
deployments to prevent thundering herd on token renewal) or a per-pod cache. For `oauth2_client_
credentials` used by runtime tool executors running across multiple pods, Redis caching is essential.

---

## 6. Summary Table

| Gap | Severity | Affected Types / Areas |
| --- | --- | --- |
| No request-application spec | Critical | `basic`, `digest`, `kerberos`, `saml`, `hawk`, `aws_iam`, `azure_ad`, `mtls`, `ws_security`, `ssh_key` |
| `searchai` type unrepresented | High | Compiler `ToolAuthTypeIR` vs Auth Profile enum |
| No token refresh spec | High | `oauth2_client_credentials`, `aws_iam` (STS), `azure_ad`, `kerberos`, `saml` |
| Addon secrets not in schema | High | `signing`, `jwtWrapping`, `webhookVerification` |
| No invalid-combination validation | Medium | `aws_iam+signing`, `ws_security+HTTP`, `ssh_key+HTTP` |
| `aws_iam` missing `roleArn`/STS refresh | Medium | `aws_iam` |
| `ssh_key` use case unspecified + missing library | Medium | `ssh_key` |
| `saml` outbound vs inbound unspecified | Medium | `saml` |
| `oauth2_app` never applied to HTTP (unstated) | Medium | `oauth2_app` |
| Proxy circular reference + chain depth | Medium | `proxy` addon |
| Validate endpoint per-type strategy missing | Medium | all types |
| `oauth2_client_credentials` token cache location | Medium | `oauth2_client_credentials` |
| Device code flow not mapped to new OAuth endpoints | Low | SearchAI connector |
| `clientId` in secrets unjustified | Low | `oauth2_app` |
| `digest-fetch` loading strategy inconsistent | Low | `digest` |
| `kerberos` Dockerfile scope over-broad | Low | `kerberos` |
| `ws_security` library choice not final | Low | `ws_security` |
| `report-only` cert pinning destination undefined | Low | `certificatePinning` addon |
````
