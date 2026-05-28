# SSO / Enterprise Authentication — Low-Level Design

## Task T-1: Enterprise Auth Types (packages/auth-enterprise)

### Files

- `packages/auth-enterprise/src/digest-auth.ts` — RFC 2617/7616 Digest header computation (MD5, SHA-256)
- `packages/auth-enterprise/src/hawk-auth.ts` — Hawk HTTP MAC authentication
- `packages/auth-enterprise/src/kerberos-auth.ts` — SPNEGO/Kerberos ticket (dynamic import, stub fallback)
- `packages/auth-enterprise/src/saml-auth.ts` — SAML 2.0 assertion generation for outbound requests
- `packages/auth-enterprise/src/ws-security-auth.ts` — WS-Security UsernameToken SOAP header
- `packages/auth-enterprise/src/index.ts` — Barrel exports

### Key Design Notes

- Kerberos uses `await import('kerberos')` with a catch fallback to a stub base64 ticket. This keeps the package installable in environments without native module support.
- All auth types are synchronous header computations except Kerberos (async due to native module).
- Each auth type exports a single function that returns an HTTP header value or headers object.

### Tests

- `packages/auth-enterprise/src/__tests__/digest-auth.test.ts`
- `packages/auth-enterprise/src/__tests__/hawk-auth.test.ts`
- `packages/auth-enterprise/src/__tests__/kerberos-auth.test.ts`
- `packages/auth-enterprise/src/__tests__/saml-auth.test.ts`
- `packages/auth-enterprise/src/__tests__/ws-security-auth.test.ts`

---

## Task T-2: Domain Claiming & DNS Verification

### Files

- `apps/studio/src/app/api/sso/domains/route.ts` — POST: claim a domain for SSO (generates verification token)
- `apps/studio/src/app/api/sso/domains/verify/route.ts` — POST: verify domain via DNS TXT record lookup

### Function Flow

1. Admin claims domain via POST `/api/sso/domains` with `{ domain }` body
2. System generates a verification token (e.g., `abl-verify=<token>`)
3. Admin adds TXT record to their DNS
4. Admin triggers verification via POST `/api/sso/domains/verify`
5. System uses `dns.resolveTxt()` to check for the token
6. On success, marks domain as verified in `domain_mappings` collection

### Data Model

```
Collection: domain_mappings
  - domain: string (unique, indexed)
  - organizationId: string (indexed)
  - verificationToken: string
  - verified: boolean
```

---

## Task T-3: SSO Config Management

### Files

- `apps/studio/src/app/api/sso/config/route.ts` — POST: create/update SSO configuration (admin only)
- `apps/studio/src/lib/sso-helpers.ts` — SSO config encryption/decryption using EncryptionService

### Key Design Notes

- SSO configs are encrypted using AES-256-GCM via `EncryptionService` before storage
- Configs are stored as subdocuments on the `organizations` collection (not via Mongoose encryption plugin)
- Supports both SAML and OIDC protocol types
- SAML config includes: entityId, ssoUrl, certificate (X.509), nameIdFormat
- OIDC config includes: issuer, authorizeUrl, tokenUrl, userInfoUrl, clientId, clientSecret

---

## Task T-4: SAML Login Flow

### Files

- `apps/studio/src/app/api/sso/init/route.ts` — GET: detect SSO flow from email domain, return SAML redirect URL
- `apps/studio/src/app/api/sso/saml/callback/route.ts` — POST: handle SAML assertion from IdP

### Flow

1. `GET /api/sso/init?email=user@corp.com` looks up domain mapping, finds SAML config
2. Returns `{ ssoEnabled: true, redirectUrl: "<saml-authn-request-url>" }`
3. Browser redirects to IdP
4. IdP posts assertion to `POST /api/sso/saml/callback`
5. Callback validates XML signature using @node-saml/node-saml
6. Extracts email and display name from assertion attributes
7. Finds or creates user, auto-accepts pending invitations
8. Generates one-time auth code (60s TTL), redirects to `/auth/callback?code=...`

### Security

- XML signature verification using IdP X.509 certificate
- Assertion replay protection via consumed assertion ID tracking
- Audience restriction validation

---

## Task T-5: OIDC Login Flow

### Files

- `apps/studio/src/app/api/sso/init/route.ts` — Returns OIDC authorize URL
- `apps/studio/src/app/api/sso/oidc/callback/route.ts` — GET: handle OIDC authorization code callback
- `apps/studio/src/lib/sso-state-store.ts` — Redis-backed OIDC state storage for CSRF protection

### Flow

1. `GET /api/sso/init?email=user@corp.com` finds OIDC config, generates state, stores in Redis
2. Returns `{ ssoEnabled: true, redirectUrl: "<oidc-authorize-url>" }`
3. Browser redirects to authorization server
4. Authorization server redirects to `GET /api/sso/oidc/callback?code=...&state=...`
5. Callback validates state parameter against Redis store
6. Validates token endpoint URL against SSRF allowlist (blocks private IPs, metadata endpoints)
7. Exchanges authorization code for tokens
8. Fetches user info from userinfo endpoint
9. Finds or creates user, auto-accepts pending invitations
10. Generates one-time auth code, redirects to `/auth/callback?code=...`

---

## Task T-6: Auth Code Exchange

### Files

- `apps/studio/src/app/api/sso/exchange/route.ts` — POST: exchange one-time auth code for JWT token pair
- `apps/studio/src/lib/sso-auth-codes.ts` — One-time auth code generation and validation

### Key Design Notes

- Auth codes are single-use, 60-second TTL
- Rate limited to 20 requests/minute
- Returns `{ accessToken, refreshToken, expiresIn, needsOnboarding?, pendingInvitations? }`

---

## Task T-7: Social OAuth

### Files

- `apps/studio/src/app/api/auth/google/route.ts` — Initiate Google OAuth consent flow
- `apps/studio/src/app/api/auth/microsoft/route.ts` — Initiate Microsoft OAuth consent flow
- `apps/studio/src/app/api/auth/microsoft/callback/route.ts` — Microsoft OAuth callback
- `apps/studio/src/app/api/auth/linkedin/route.ts` — Initiate LinkedIn OAuth consent flow
- `apps/studio/src/app/api/auth/linkedin/callback/route.ts` — LinkedIn OAuth callback
- `apps/studio/src/app/api/auth/callback/route.ts` — General OAuth callback handler

### Key Design Notes

- Each provider uses CSRF state parameter stored in httpOnly cookies
- Google uses cached OAuth2Client instances for performance
- All callbacks redirect through the one-time auth code exchange flow

---

## Known Gaps

| Gap                                                      | Severity | Notes                                                   |
| -------------------------------------------------------- | -------- | ------------------------------------------------------- |
| DNS rebinding not fully mitigated on OIDC token exchange | Medium   | Private IP validation may be bypassed via DNS rebinding |
| Kerberos uses stub ticket when native module missing     | Low      | Acceptable for environments without krb5                |
| No SCIM provisioning                                     | Medium   | Manual user management required                         |
| console.log in some SSO routes                           | Low      | Should migrate to createLogger                          |
| SSO config encryption is manual (not plugin-based)       | Low      | Subdocument limitation; encryption is still AES-256-GCM |

## Exit Criteria

- All auth-enterprise unit tests pass: `pnpm test --filter=auth-enterprise`
- All SSO route integration tests pass: `pnpm test --filter=studio -- api-sso-routes`
- SSO config is encrypted at rest (verified by helper tests)
- One-time auth codes expire after 60 seconds
- Domain verification requires valid DNS TXT record
