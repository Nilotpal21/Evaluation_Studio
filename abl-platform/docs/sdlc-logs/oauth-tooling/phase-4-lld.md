# SDLC Log: OAuth Tooling -- Phase 4 (LLD)

**Date:** 2026-03-23
**Phase:** Low-Level Design + Implementation Plan
**Artifact:** `docs/plans/2026-03-23-oauth-tooling-impl-plan.md`

## Implementation Phases

| Phase | Name                               | Duration | Dependencies                |
| ----- | ---------------------------------- | -------- | --------------------------- |
| 1     | Auth Profile Integration for Tools | 3 days   | None                        |
| 2     | Studio OAuth Config UI             | 2 days   | Phase 1                     |
| 3     | Studio OAuth Consent Flow          | 3 days   | Phase 2                     |
| 4     | Token Health + Tool Testing        | 2 days   | Phase 1                     |
| 5     | Connector OAuth Migration          | 2 days   | Phase 1 (parallel with 3-4) |

**Total estimated duration:** 12 days (Phases 3-4 and 5 can be parallelized for ~8 days critical path)

## Files to Create

| File                                                              | Phase | Purpose                      |
| ----------------------------------------------------------------- | ----- | ---------------------------- |
| `apps/studio/src/components/tools/AuthProfileSelector.tsx`        | 2     | Auth Profile dropdown        |
| `apps/studio/src/components/tools/OAuthScopeEditor.tsx`           | 2     | Scope tag editor             |
| `apps/studio/src/components/tools/OAuthConfigPanel.tsx`           | 2     | OAuth config container       |
| `apps/studio/src/app/api/oauth/tool-auth/route.ts`                | 3     | OAuth initiate endpoint      |
| `apps/studio/src/app/api/oauth/tool-auth/callback/route.ts`       | 3     | OAuth callback endpoint      |
| `apps/studio/src/components/tools/ConnectAccountButton.tsx`       | 3     | User OAuth connect button    |
| `apps/studio/src/lib/oauth-state-store.ts`                        | 3     | Redis state store for Studio |
| `packages/shared/src/services/auth-profile/token-health.ts`       | 4     | Token health computation     |
| `apps/studio/src/components/tools/TokenStatusBadge.tsx`           | 4     | Token health badge UI        |
| `apps/studio/src/services/migration/connector-oauth-migration.ts` | 5     | Connector migration job      |

## Files to Modify

| File                                                         | Phase | Change                                     |
| ------------------------------------------------------------ | ----- | ------------------------------------------ |
| `packages/shared/src/validation/project-tool-schemas.ts`     | 1     | Add authProfileId, oauthScopes             |
| `packages/database/src/models/project-tool.model.ts`         | 1     | Add authProfileId field + index            |
| `apps/runtime/src/services/secrets-provider.ts`              | 1     | Wire auth profile resolution for tools     |
| `apps/runtime/src/services/execution/llm-wiring.ts`          | 1     | Load tool auth profile map at session init |
| `apps/studio/src/components/tools/HttpConfigForm.tsx`        | 2     | Render OAuthConfigPanel                    |
| `apps/studio/src/services/tool-test-service.ts`              | 4     | Resolve OAuth credentials for test         |
| `packages/database/src/models/connector-connection.model.ts` | 5     | Add authProfileId field                    |
| `apps/studio/src/lib/connector-oauth.ts`                     | 5     | Redirect to Auth Profile flow              |

## Wiring Points

12 wiring points identified and tracked in the implementation plan.

## Risk Mitigations

| Risk                                   | Mitigation                                  |
| -------------------------------------- | ------------------------------------------- |
| Schema migration breaks existing tools | All new fields optional with defaults       |
| OAuth callback race conditions         | Unique compound index on token profiles     |
| PKCE verifier leakage                  | Never log codeVerifier                      |
| Redis unavailability                   | Fail-fast with clear error                  |
| Connector migration data loss          | Additive migration; original data preserved |

## Audit Round 1 (Self-Review)

| #   | Finding                                                        | Severity | Status   |
| --- | -------------------------------------------------------------- | -------- | -------- |
| 1   | All 5 phases have clear exit criteria with checkboxes          | --       | Complete |
| 2   | Wiring checklist covers all integration points                 | --       | Complete |
| 3   | File paths are concrete and verifiable                         | --       | Verified |
| 4   | Risk assessment covers top-5 risks with mitigations            | --       | Complete |
| 5   | Dependency graph documented with parallelization opportunities | --       | Complete |
| 6   | Uses z.string().min(1) for ID fields (not .cuid())             | --       | Verified |
