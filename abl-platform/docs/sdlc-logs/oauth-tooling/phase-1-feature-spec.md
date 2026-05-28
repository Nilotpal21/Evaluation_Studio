# SDLC Log: OAuth Tooling -- Phase 1 (Feature Spec)

**Date:** 2026-03-23
**Phase:** Feature Spec
**Artifact:** `docs/features/oauth-tooling.md`

## Decisions Made

| ID  | Decision                                                   | Classification | Rationale                                                                                               |
| --- | ---------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------- |
| D-1 | Auth Profile as single credential store for tool OAuth     | DECIDED        | Eliminates duplication between EndUserOAuthToken and AuthProfile; single encryption/rotation/audit path |
| D-2 | PKCE S256 mandatory for all browser flows                  | DECIDED        | Security best practice per RFC 7636; prevents authorization code interception                           |
| D-3 | Server-side token exchange (clientSecret never in browser) | DECIDED        | Standard security pattern; prevents client secret exposure                                              |
| D-4 | Redis-backed OAuth state (not in-memory)                   | DECIDED        | Multi-pod deployment safety; matches existing runtime pattern                                           |
| D-5 | Gradual migration via AUTH_PROFILE_ENABLED flag            | DECIDED        | Allows rollback; existing flag already in codebase                                                      |
| D-6 | Token health polling (not WebSocket)                       | DECIDED        | Simpler; token status changes infrequently                                                              |

## Codebase Grounding

- Auth Profile schemas: `packages/shared/src/validation/auth-profile.schema.ts` (17 auth types, discriminated union)
- Token refresh: `packages/shared/src/services/auth-profile/token-refresh-service.ts` (distributed Redis locking)
- Tool OAuth service: `apps/runtime/src/services/tool-oauth-service.ts` (end-user OAuth flows)
- OAuth HTTP helper: `apps/studio/src/lib/oauth-http.ts` (dual-stack-safe HTTPS)
- Connector OAuth: `apps/studio/src/lib/connector-oauth.ts` (in-memory state -- to be migrated)
- Secrets provider: `apps/runtime/src/services/secrets-provider.ts` (5-layer resolution chain)
- Apply auth: `packages/shared/src/services/auth-profile/apply-auth.ts` (header/TLS dispatcher)
- Project tool schemas: `packages/shared/src/validation/project-tool-schemas.ts` (oauth2_client, oauth2_user types)

## Audit Round 1 (Self-Review)

| #   | Finding                                                                | Severity | Status   |
| --- | ---------------------------------------------------------------------- | -------- | -------- |
| 1   | Feature spec covers 5 user stories, 10 functional requirements, 8 NFRs | --       | Complete |
| 2   | All requirements grounded in existing codebase components              | --       | Verified |
| 3   | Out-of-scope items explicitly listed (device auth, SAML, key rotation) | --       | Complete |
| 4   | Dependencies all marked as "Implemented" with specific file references | --       | Verified |
| 5   | Success metrics defined with measurement methods                       | --       | Complete |
