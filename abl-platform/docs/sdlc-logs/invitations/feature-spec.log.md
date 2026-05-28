# SDLC Log: Invitations — Feature Spec

**Phase**: Feature Spec (Phase 1)
**Date**: 2026-03-23
**Status**: Complete

## Oracle Decisions

All clarifying questions were answered via code analysis (ANSWERED classification). No AMBIGUOUS items required user escalation.

### Scope & Problem

- **What problem?** ANSWERED — No way for admins to add users to existing workspaces. Code evidence: `invitation-service.ts` createInvitation logic.
- **Boundary?** ANSWERED — Workspace-scoped only, no project-level invitations. Code evidence: all routes under `/api/workspaces/:tenantId/invitations`.
- **New or enhancement?** ANSWERED — Existing implemented feature at ALPHA status. Code evidence: full service, repo, model, UI exist.

### User Stories & Requirements

- **Personas?** ANSWERED — OWNER, ADMIN (inviters), invited users (acceptors). Code evidence: role checks in invitation-service.ts.
- **Critical journeys?** ANSWERED — Email-link acceptance, SSO auto-accept, picker page. Code evidence: 3 acceptance flows in routes.
- **Scale?** INFERRED — No pagination currently; acceptable at current scale.

### Technical & Architecture

- **Packages?** ANSWERED — apps/studio, packages/database, packages/shared, packages/i18n. Code evidence: import graph.
- **Data models?** ANSWERED — workspace_invitations collection. Code evidence: workspace-invitation.model.ts.
- **Security?** ANSWERED — Token hashing, role hierarchy, tenant isolation. Code evidence: invitation-service.ts checks.

## Files Created

- `docs/features/invitations.md` — Feature spec (MAJOR FEATURE, ALPHA)
- `docs/testing/invitations.md` — Testing guide placeholder (PLANNED)
- `docs/testing/README.md` — Updated feature index
- `docs/sdlc-logs/invitations/feature-spec.log.md` — This log

## Audit Summary

### Round 1 — Self-Review Findings

- 15 functional requirements identified, all testable
- 7 user stories covering all personas
- 8 gaps identified with severity ratings
- Integration matrix references 4 related features
- All 18 template sections addressed
- Isolation concerns documented for tenant and user levels

### Key Findings

- GAP-001 (HIGH): `acceptInvitationById()` missing tenant scoping
- GAP-003 (HIGH): No transaction in acceptance flow
- GAP-004 (HIGH): No E2E tests
- GAP-002 (MEDIUM): console.error usage in routes
