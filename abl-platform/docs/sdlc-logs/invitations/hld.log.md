# SDLC Log: Invitations — HLD

**Phase**: HLD (Phase 3)
**Date**: 2026-03-23
**Status**: Complete

## Oracle Decisions

### Architecture & Data Flow

- **Preferred pattern?** ANSWERED — Next.js API route → service → repository → MongoDB. Follows existing Studio patterns. Code evidence: all invitation routes use this pattern.
- **Data flow?** ANSWERED — Request-driven (synchronous). Email sending is synchronous in the create path. Code evidence: invitation-service.ts createInvitation().
- **Scale?** INFERRED — Low volume (invitations are infrequent administrative actions). No pagination needed at current scale.
- **Deployment?** ANSWERED — Single Next.js app (Studio). No microservice extraction needed. Code evidence: all code lives in apps/studio.

### Integration & Dependencies

- **Dependencies?** ANSWERED — MongoDB, SMTP, auth system, i18n. Code evidence: import graph in invitation-service.ts.
- **Breaking changes?** DECIDED — Error envelope format change (from `{error}` to `{success, error: {code, message}}`) is a breaking change for API consumers. Recommend gradual migration.
- **SSO integration?** ANSWERED — All 6 auth callbacks use resolveUserContextOrAutoAcceptInvite(). Code evidence: grep found 13 files referencing auto-accept.

### Risk & Migration

- **Biggest risk?** DECIDED — Partial acceptance state (GAP-003). TenantMember created without invitation update. Fix: MongoDB transaction.
- **Migration?** ANSWERED — No data migration needed. Schema is stable.
- **Rollback?** ANSWERED — All changes are backwards-compatible code fixes. No schema changes.

## Files Created

- `docs/specs/invitations.hld.md` — High-Level Design
- `docs/sdlc-logs/invitations/hld.log.md` — This log

## Audit Summary

### Round 1 — Full Audit

- All 12 architectural concerns addressed
- 3 alternatives considered with trade-off analysis
- Architecture diagrams (system context, component, data flow) included
- Data model documented with all indexes
- API design documented with all 7 endpoints
- 4 open questions listed

### Round 2 — Deep Dive

- Error model covers 7 distinct failure conditions
- Failure modes table with mitigation strategies
- Performance budget with realistic targets
- Gap fixes documented with specific remediation steps

### Round 3 — Cross-Phase Consistency

- All 15 FRs traceable to HLD architecture components
- Test strategy aligns with test spec (10 E2E, 8 integration, 4 unit)
- No contradictions between feature spec and HLD
