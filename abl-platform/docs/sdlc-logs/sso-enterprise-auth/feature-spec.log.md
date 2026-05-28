# SDLC Log: SSO Enterprise Auth -- Feature Spec

**Phase**: 1 (Feature Spec)
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                  | Classification | Resolution                                                                                                                       |
| --- | ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What SSO protocols are supported?         | ANSWERED       | SAML 2.0 and OIDC found in `apps/studio/src/services/sso/`                                                                       |
| 2   | Where is SSO config stored?               | ANSWERED       | Embedded in Organization model (`ssoConfigs` array) -- `packages/database/src/models/organization.model.ts`                      |
| 3   | How is SSO config encrypted?              | ANSWERED       | `EncryptionService.encryptForTenant/decryptForTenant` -- `apps/studio/src/lib/sso-helpers.ts`                                    |
| 4   | Where is MFA implemented?                 | ANSWERED       | `apps/studio/src/services/auth/mfa-service.ts` -- TOTP RFC 6238 + recovery codes                                                 |
| 5   | How does domain verification work?        | ANSWERED       | DNS TXT records via `node:dns/promises` -- `apps/studio/src/services/sso/domain-service.ts`                                      |
| 6   | Is MFA enforcement plan-gated?            | ANSWERED       | Yes, BUSINESS/ENTERPRISE plans or org `requireMfa` setting -- `mfa-service.ts:isMFARequired`                                     |
| 7   | How are SSO users matched?                | ANSWERED       | By email, with `googleId` overloaded with provider prefixes -- OIDC/SAML callback routes                                         |
| 8   | What state store is used for SSO?         | ANSWERED       | Hybrid Redis/in-memory -- `apps/studio/src/services/sso/sso-state-store.ts`                                                      |
| 9   | Is OIDC ID token signature verified?      | ANSWERED       | No -- current implementation decodes JWT payload without JWKS verification (GAP-001)                                             |
| 10  | Are SSO route handlers fully implemented? | INFERRED       | `init`, `oidc/callback`, `saml/callback` are implemented; `config`, `domains`, `exchange` routes exist as files but may be stubs |

## Files Created

- `docs/features/sso-enterprise-auth.md` -- Feature specification (18 sections)
- `docs/sdlc-logs/sso-enterprise-auth/feature-spec.log.md` -- This log

## Codebase Evidence

- **SSO types**: `apps/studio/src/services/sso/sso-types.ts` (SAMLConfig, OIDCConfig, SSOUser, DomainVerification)
- **SSO state store**: `apps/studio/src/services/sso/sso-state-store.ts` (Redis/in-memory hybrid for assertions, OIDC state, auth codes)
- **SAML service**: `apps/studio/src/services/sso/saml-service.ts` (SP metadata, AuthnRequest, basic assertion validation)
- **OIDC service**: `apps/studio/src/services/sso/oidc-service.ts` (PKCE, token exchange, ID token decode, UserInfo)
- **Domain service**: `apps/studio/src/services/sso/domain-service.ts` (claim, verify via DNS TXT, lookup)
- **MFA service**: `apps/studio/src/services/auth/mfa-service.ts` (TOTP RFC 6238, recovery codes, lockout)
- **Auth service**: `apps/studio/src/services/auth-service.ts` (JWT, token refresh, tenant context)
- **Unified auth**: `packages/shared-auth/src/middleware/unified-auth.ts` (3-flow dispatch: JWT, SDK, API key)
- **Org repo**: `apps/studio/src/repos/org-repo.ts` (Organization, DomainMapping, SSOConfig CRUD)
- **Org model**: `packages/database/src/models/organization.model.ts` (ssoConfigs, domainMappings embedded arrays)
- **SSO init route**: `apps/studio/src/app/api/sso/init/route.ts`
- **OIDC callback**: `apps/studio/src/app/api/sso/oidc/callback/route.ts`
- **SAML callback**: `apps/studio/src/app/api/sso/saml/callback/route.ts`

## Review Summary

Round 1 -- self-review completed:

- All 18 template sections addressed
- 7 user stories, 14 functional requirements
- Integration matrix references 5 related features
- Non-functional concerns address isolation, security, performance, reliability, observability, data lifecycle
- 8 gaps identified with severity ratings
- Delivery plan has 6 parent tasks with numbered subtasks

Round 2 -- cross-phase consistency:

- FR numbering consistent (FR-1 through FR-14)
- Scope boundaries match non-goals
- User stories align with functional requirements
- Implementation files verified at stated paths
