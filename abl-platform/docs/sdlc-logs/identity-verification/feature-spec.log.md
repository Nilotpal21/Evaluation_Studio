# Feature Spec SDLC Log: Identity Verification

**Phase**: 1 -- Feature Spec
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                                       | Classification | Answer                                                                                                                                               |
| --- | -------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What packages implement identity verification?                 | ANSWERED       | `apps/runtime/src/contexts/identity/` (domain, use cases, infrastructure, routes) and `@agent-platform/shared-auth` (shared types)                   |
| 2   | How many verification methods are implemented?                 | ANSWERED       | Six: HMAC, OTP, OAuth, email link, provider, webhook. All have adapters in `infrastructure/verifiers/`                                               |
| 3   | Is the feature wired in production?                            | ANSWERED       | No -- `server.ts` mounts routes with **stub dependencies** (empty verifier map, no-op token store). Comment says "TODO: Wire full verifier registry" |
| 4   | What shared types exist?                                       | ANSWERED       | `VerificationMethod` (`none`, `cookie`, `caller_id`, `provider`, `hmac`, `otp`, `oauth`), `ChannelArtifactType`, `IdentityTier` in `shared-auth`     |
| 5   | Are `email_link` and `webhook` in the VerificationMethod type? | ANSWERED       | No -- they are missing. `EmailLinkVerifier.method = 'otp'` and `WebhookVerifier.method = 'provider'` as workarounds                                  |
| 6   | Does the feature have E2E tests?                               | ANSWERED       | No E2E tests with real HTTP API. The `identity.e2e.test.ts` uses in-memory stores, not HTTP endpoints                                                |
| 7   | Is timing-safe comparison used everywhere?                     | ANSWERED       | Only in `OtpVerifier`. `EmailLinkVerifier` and `WebhookVerifier` use plain `!==` for hash comparison (GAP-013, GAP-014)                              |

## Files Read

- `apps/runtime/src/contexts/identity/index.ts` -- barrel exports and factory
- `apps/runtime/src/contexts/identity/domain/identity-verifier.ts` -- port interface
- `apps/runtime/src/contexts/identity/domain/verification-attempt.ts` -- value object
- `apps/runtime/src/contexts/identity/domain/identity-tier.ts` -- tier logic
- `apps/runtime/src/contexts/identity/domain/identity-artifact.ts` -- SHA-256 hashing
- `apps/runtime/src/contexts/identity/domain/session-resolution-key.ts` -- key builder
- `apps/runtime/src/contexts/identity/use-cases/verify-identity.ts` -- dispatcher
- `apps/runtime/src/contexts/identity/use-cases/promote-tier.ts` -- tier promotion
- `apps/runtime/src/contexts/identity/use-cases/resolve-session.ts` -- session resolution
- `apps/runtime/src/contexts/identity/use-cases/register-resolution-key.ts` -- key registration
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/hmac-verifier.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/otp-verifier.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/oauth-verifier.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/email-link-verifier.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/provider-verifier.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verifiers/webhook-verifier.ts`
- `apps/runtime/src/contexts/identity/infrastructure/verification-token-store.ts`
- `apps/runtime/src/contexts/identity/infrastructure/redis-verification-token-store.ts`
- `apps/runtime/src/contexts/identity/infrastructure/resolution-key-store.ts`
- `apps/runtime/src/routes/identity-verification.ts` -- Express router
- `apps/runtime/src/server.ts` -- production wiring (stub deps)
- `apps/runtime/src/__tests__/contexts/integration/identity.e2e.test.ts`
- `packages/shared-auth/src/types/index.ts` -- shared type definitions
- `packages/shared-auth/src/types/auth-context.ts` -- CallerIdentity

## Files Created

- `docs/features/identity-verification.md` -- feature spec (all 18 sections)
- `docs/sdlc-logs/identity-verification/feature-spec.log.md` -- this log

## Key Findings

1. **Production wiring is stubbed**: `server.ts` lines 1167-1198 use empty verifier map and no-op token store. The feature is structurally complete but not functional in production.
2. **Type mismatches in verifier methods**: `EmailLinkVerifier.method = 'otp'` and `WebhookVerifier.method = 'provider'` because `email_link` and `webhook` are not in the `VerificationMethod` union type.
3. **Timing-safe comparison inconsistency**: `OtpVerifier` uses `timingSafeEqual` but `EmailLinkVerifier` and `WebhookVerifier` use plain `!==` for hash comparison. This is a security gap.
4. **Non-atomic Redis increment**: `RedisVerificationTokenStore.incrementAttempts()` does GET+SET, not atomic INCR. Race condition risk under concurrent verification attempts.
5. **14 gaps identified**: 2 High severity (no E2E tests, non-timing-safe comparisons), 8 Medium, 4 Low.

## Review Summary

### Round 1 -- Completeness & Quality

- [x] All 18 TEMPLATE.md sections addressed
- [x] 7 user stories (minimum 3)
- [x] 12 functional requirements (minimum 4)
- [x] Integration matrix references 6 related features
- [x] Non-functional concerns address tenant, project, user isolation
- [x] Delivery plan has parent tasks with numbered subtasks
- [x] Open questions section has 6 items
- [x] Claims grounded in code evidence

### Round 2 -- Cross-Phase Consistency

- [x] FR numbering is consistent and referenced in test matrix
- [x] Scope boundaries match non-goals
- [x] User stories align with functional requirements
- [x] Implementation files verified to exist at stated paths
