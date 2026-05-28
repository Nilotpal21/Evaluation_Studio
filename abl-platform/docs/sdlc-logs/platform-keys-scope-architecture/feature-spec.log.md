# SDLC Log: Platform Keys Scope Architecture — Feature Spec

**Date**: 2026-04-12
**Phase**: Feature Spec (Phase 1 of SDLC)
**Artifact**: `docs/features/sub-features/platform-keys.md`
**Ticket**: ABLP-277

## Oracle Decisions

17 clarifying questions asked. All answered — zero AMBIGUOUS escalations.

### Key Findings

1. **NOT greenfield**: Platform Keys is an existing BETA sub-feature with all 16 FRs DONE. CRUD routes, UI, `resolveApiKey`, and tests all exist. The work is expanding the scope system, not building from scratch.
2. **Four apps already have `resolveApiKey`**: Runtime, SearchAI, SearchAI-Runtime, Workflow Engine — all need scope expansion updates.
3. **Existing RBAC has `getPermissionCeiling()`** — designed exactly for the ceiling check use case.

### Oracle Classification Summary

| #   | Question                  | Classification | Decision                                                                               |
| --- | ------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| Q1  | Problem ServiceKey solves | ANSWERED       | Machine-to-machine access, scoped permissions, project/env isolation                   |
| Q2  | Out of scope for v1       | ANSWERED       | Key rotation, IP allowlisting, per-key rate limiting, pagination                       |
| Q3  | New vs enhancement        | ANSWERED       | Enhancement — all infrastructure exists                                                |
| Q4  | Priority driver           | INFERRED       | Workflow triggers feature was primary; broader scope expansion driven by API consumers |
| Q5  | OAuth2 alternative        | DECIDED        | Continue with custom API keys; OAuth2 CC is additive future work                       |
| Q6  | Personas                  | ANSWERED       | Any project write user creates; external systems consume                               |
| Q7  | User journeys             | ANSWERED       | Create → Use → Edit → Revoke (rotation deferred)                                       |
| Q8  | Must-have vs nice-to-have | ANSWERED       | All Phase 1 FRs are P0/P1 and DONE                                                     |
| Q9  | Rate limiting             | ANSWERED       | No per-key; tenant-level inherited                                                     |
| Q10 | Runtime vs Studio         | ANSWERED       | Runtime + SearchAI + SearchAI-Runtime + Workflow Engine                                |
| Q11 | Package split             | ANSWERED       | Studio only for Phase 1; shared-auth for Phase 2 scope registry                        |
| Q12 | Scope registry location   | DECIDED        | `packages/shared-auth` (follows RBAC precedent)                                        |
| Q13 | Scope-to-RBAC mapping     | DECIDED        | Scopes map to groups of permissions (not 1:1)                                          |
| Q14 | Route enforcement         | INFERRED       | Expand scopes to permissions at resolve time; existing middleware works                |
| Q15 | Workspace archive         | DECIDED        | No auto-revoke in v1; document as GAP-010                                              |
| Q16 | Model rename              | DECIDED        | Keep `ApiKey` in code/DB; naming is display-layer only                                 |
| Q17 | resolveApiKey wiring      | ANSWERED       | Fully implemented in 4 apps                                                            |

## Files Created/Modified

- `docs/features/sub-features/platform-keys.md` — Updated with Phase 2 scope architecture (FR-17 through FR-25)
- `docs/sdlc-logs/platform-keys-scope-architecture/feature-spec.log.md` — This file

## Open Questions Carried Forward

1. Should ceiling check consider project-level roles in addition to tenant-level?
2. Should scope expansion be cached per key?
3. Should revoked keys be shown in a separate UI section?
