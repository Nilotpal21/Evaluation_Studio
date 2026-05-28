# Hosted Exchange JWE Auth Comparison

**Status**: As-built security handoff for ABLP-862  
**Last Updated**: 2026-05-11

This guide compares the customer-hosted WebSDK authentication options relevant to ABLP-862 and explains what JWE changes for hosted_exchange integrations.

## Auth Flow Comparison

| Flow                     | Who authenticates the end user?                                                 | Browser bootstrap input                               | Runtime session token      | Best fit                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Public key SDK bootstrap | Runtime accepts a public SDK key and anonymous/user-supplied context            | `X-Public-Key` or equivalent public key               | Signed SDK JWT             | Public or low-risk web chat where user identity is not strongly asserted by the customer backend.                       |
| hosted_exchange signed   | Customer backend authenticates the user, then calls Runtime with channel secret | Signed hosted_exchange bootstrap artifact             | Signed SDK JWT             | Existing compatible deployments where token payload confidentiality is not required.                                    |
| hosted_exchange JWE      | Customer backend authenticates the user, then calls Runtime with channel secret | JWE-wrapped signed hosted_exchange bootstrap artifact | JWE-wrapped signed SDK JWT | Regulated/customer-hosted flows where browser-carried token payloads may include sensitive identity or session context. |

## Signed Token vs JWE-Wrapped Signed Token

The JWE implementation uses nested tokens:

```text
legacy signed token -> compact JWE envelope -> browser-carried opaque token
```

Runtime decrypts the JWE first, then verifies the inner signed token through the existing verifier. This preserves the integrity, TTL, replay, and claim-validation behavior that already exists while adding browser-side payload confidentiality.

JWE protects against:

- casual payload inspection in browser DevTools;
- frontend screenshots or support captures exposing decoded claims;
- browser extensions or frontend logs reading claim JSON from the token;
- accidental proxy/application logs that record decoded token payloads.

JWE does not protect against:

- theft of the opaque bearer token itself;
- replay within the token's valid TTL;
- XSS that can read the token string from browser memory;
- compromised customer backend issuance;
- overly broad sensitive attributes being placed into tokens.

## WebSocket Transport

The preferred SDK WebSocket authentication path is now a short-lived, one-time
ticket:

```text
POST /api/v1/sdk/ws-ticket
X-SDK-Token: <sdk_session_token>

Sec-WebSocket-Protocol: sdk-ticket,<one_time_ticket>
```

Runtime verifies the SDK session token before issuing the ticket, stores the
ticket under a hashed Redis key with a minimized session-auth payload and a
short TTL, then atomically consumes and reauthorizes the ticket during WebSocket
connection setup. Reusing the same ticket should fail.

The legacy SDK WebSocket authentication path still exists for published SDK
compatibility:

```text
Sec-WebSocket-Protocol: sdk-auth,<sdk_session_token>
```

This `sdk-auth` mode is deprecated because it carries the reusable SDK session
token during the WebSocket handshake. With JWE enabled, `<sdk_session_token>` is
opaque, but it remains a bearer token. New SDK clients should request
`/api/v1/sdk/ws-ticket` immediately before opening the WebSocket and use the
`sdk-ticket` subprotocol. Runtime currently keeps `sdk-auth` available as a
compatibility path and logs its use for migration tracking.

Runtime rejects oversized SDK WebSocket tokens before upgrade with conservative
size limits. Production rollout still requires measured header-budget evidence
across browser, Node, CDN/proxy/ALB, nginx, and customer ingress.

## Policy Modes

| Mode            | Issuance behavior                                                                                                                    | Verification behavior                                                                                                                          | Rollback behavior                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `signed`        | Issues signed bootstrap/session tokens.                                                                                              | Accepts signed tokens and may continue accepting JWE while Runtime capability is healthy, so existing encrypted sessions can expire naturally. | Safe compatibility default.                                                                         |
| `jwe_preferred` | Issues JWE when Runtime capability and transport budget are ready; signed fallback is allowed during controlled rollout or rollback. | Accepts both signed and JWE where compatibility is intended.                                                                                   | Can downgrade issuance to signed while keeping JWE verification enabled through existing token TTL. |
| `jwe_required`  | Must issue JWE or fail closed.                                                                                                       | Rejects signed hosted_exchange bootstrap/session tokens for that channel.                                                                      | Do not disable JWE capability unless session interruption is intended.                              |

Project defaults can set the normal behavior for hosted_exchange endpoints, and channel config can override it for a specific endpoint.

## Diagnostics

The Runtime diagnostic endpoint is intentionally coarse:

- requires normal Runtime auth and project permission;
- is tenant/project rate-limited;
- writes an audit event for each invocation;
- reports only the envelope family, such as `jwe` or `signed`;
- never returns claims, decrypted payloads, `kid`, key existence, or key material;
- returns indistinguishable bodies for unknown-key and tampered JWE-shaped inputs.

Support should not use jwt.io-style client-side decoding for hosted_exchange JWE tokens.

## Key Rotation and Emergency Removal

The key-provider interface supports active and previous keys:

- active keys can issue and verify;
- previous keys can verify existing tokens during TTL drain but cannot issue new tokens;
- disabled keys cannot issue or verify.

Normal rotation:

1. Add a new active key for the purpose.
2. Keep the previous key available for at least the maximum SDK session TTL.
3. Confirm decrypt failure rate stays normal.
4. Remove or disable the previous key after TTL drain.

Emergency key removal:

1. Disable the affected key immediately.
2. Expect existing JWE tokens encrypted to that key to fail.
3. Keep customer communication ready for hosted_exchange re-authentication.
4. For `jwe_required` channels, do not fall back to signed tokens unless security explicitly changes the channel policy.

## Rollout Checklist

1. Verify log redaction for `Sec-WebSocket-Protocol`, `X-SDK-Token`, `bootstrapToken`, and diagnostic request bodies.
2. Record production-like header-budget evidence for HTTP and WebSocket paths.
3. Deploy Runtime with JWE verification capability healthy while existing policies remain signed/inherit.
4. Enable a staging hosted_exchange channel with `jwe_preferred`.
5. Verify customer-session -> init -> refresh -> `/sdk/ws-ticket` -> WebSocket.
6. Verify tamper, oversize, malformed, and diagnostics scenarios.
7. Move staging to `jwe_required` and verify signed-token rejection.
8. Enable regulated customer channel in `jwe_preferred` for observation if required.
9. Move regulated customer channel to `jwe_required` after owner signoff.
10. Monitor decrypt failures, auth failures, and diagnostic invocations for at least one SDK session TTL.
