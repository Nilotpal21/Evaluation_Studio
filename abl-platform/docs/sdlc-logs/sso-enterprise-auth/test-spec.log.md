# SDLC Log: SSO Enterprise Auth -- Test Spec

**Phase**: 2 (Test Spec)
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                   | Classification | Resolution                                                                                                                              |
| --- | ------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What existing tests cover SSO/auth?        | ANSWERED       | `unified-auth.test.ts`, `permission-resolver.test.ts`, `jwt-verify.test.ts`, `saml-auth.test.ts` -- unit tests only, no E2E/integration |
| 2   | Should mock SAML IdP use real XML signing? | DECIDED        | Yes, use `@node-saml/node-saml` to generate test assertions for realistic integration testing                                           |
| 3   | How to test DNS verification in CI?        | DECIDED        | Mock `node:dns/promises.resolveTxt` at the module level for integration tests; manual DNS for E2E                                       |
| 4   | What test infrastructure exists?           | ANSWERED       | MongoMemoryServer available via `@agent-platform/database`; Redis via Docker compose                                                    |
| 5   | E2E server setup?                          | INFERRED       | Studio runs as Next.js; E2E tests likely need custom Express or next-test-utils server on random port                                   |

## Files Created

- `docs/testing/sso-enterprise-auth.md` -- Test specification (7 E2E, 12 integration, 7 unit scenarios)
- `docs/sdlc-logs/sso-enterprise-auth/test-spec.log.md` -- This log

## Review Summary

Round 1 -- Coverage & Completeness:

- 7 E2E scenarios (exceeds minimum 5)
- 12 integration scenarios (exceeds minimum 5)
- 7 unit test scenarios
- All 14 FRs from feature spec appear in coverage matrix
- E2E scenarios specify auth context and isolation checks
- Integration scenarios specify service boundaries and failure modes
- Security & isolation section has 12 specific checks
- Test file mapping has planned paths

Round 2 -- Alignment:

- E2E scenarios cover highest-risk FRs: SAML signature verification, OIDC flow, MFA enforcement, auth code exchange, force-SSO
- E2E scenarios match user stories from feature spec
- Integration boundaries match data flow from feature spec (SSO state store, org-repo, mfa-service, auth-service)
