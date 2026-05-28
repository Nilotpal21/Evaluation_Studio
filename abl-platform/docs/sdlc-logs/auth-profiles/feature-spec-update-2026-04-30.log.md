# SDLC Log: Auth Profiles — Feature Spec UPDATE (Phase 1)

**Date**: 2026-04-30
**Phase**: Feature Spec (gap-closure update; r2 plan)
**Feature**: auth-profiles
**Source plan**: `/home/karthikeya.andhoju/Desktop/Commented.md` (r2, 1028 lines)
**Branch**: `fixes/AuthProfiles`
**Author**: Karthikeya Andhoju + AI orchestration

---

## Trigger

User invoked `/feature-spec` to fold the gap-closure plan in `Commented.md` into the existing `docs/features/auth-profiles.md` spec. The existing spec is at STABLE; the plan surfaces CRITICAL/HIGH gaps that warrant a status downgrade and FR additions.

## Inputs Consulted

- `/home/karthikeya.andhoju/Desktop/Commented.md` (r2 plan)
- `docs/features/auth-profiles.md` (existing STABLE spec, 681 lines)
- `docs/testing/auth-profiles.md`
- `docs/specs/auth-profiles.hld.md`
- `docs/sdlc-logs/auth-profiles/feature-spec.log.md`
- `docs/sdlc-logs/auth-profiles/post-impl-sync.log.md` (last sync 2026-04-03)
- `docs/features/sub-features/integration-auth-profiles.md`
- `docs/features/AUTHORING_GUIDE.md`, `docs/features/TEMPLATE.md`
- `docs/sdlc/pipeline.md`
- `CLAUDE.md`
- `packages/shared-auth/src/rbac/role-permissions.ts`
- `apps/studio/src/lib/workspace-permission.ts`
- `apps/studio/src/lib/permissions.ts`
- `packages/database/src/models/auth-profile.model.ts`
- `packages/database/src/models/end-user-oauth-token.model.ts`
- `packages/shared-auth-profile/package.json`

## Clarifying Questions & Oracle Decisions

### Section A — Scope & Problem

| #   | Question                                                   | Classification                    | Resolution                                                                                                                                                |
| --- | ---------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Update existing spec in-place vs new sub-feature?          | DECIDED                           | Update `docs/features/auth-profiles.md` in-place — Commented.md spans every parent FR area; sub-feature split would duplicate tracking.                   |
| A2  | Downgrade STABLE → BETA?                                   | ANSWERED                          | Yes — CK-1, ST-1, RP-1 are Critical-severity open gaps; H1–H8 are HIGH; per `AUTHORING_GUIDE.md:101` STABLE forbids open Critical/High gaps.              |
| A3  | All 9 items in scope, or descope kerberos/saml/ssh_key UI? | DECIDED                           | Include all 9; tag `kerberos`/`saml`/`ssh_key` UI in §6 as SHOULD/deferrable. Their runtime protocol handlers (§7) stay MUST.                             |
| A4  | OOS items complete?                                        | INFERRED                          | Yes — the 6 listed OOS items + non-touch boundary at lines 929-944 of Commented.md cover all deferred scope; runtime per-tool MCP signing implicitly OOS. |
| A5  | Priority/timeline driver?                                  | **AMBIGUOUS — escalated to user** | No Jira epic, customer commitment, or audit finding cited. 36-44 engineer-day total scope needs explicit prioritization.                                  |

### Section B — User Stories & Requirements

| #   | Question                                   | Classification | Resolution                                                                                                                                                           |
| --- | ------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | New personas?                              | DECIDED        | Add 3: workflow author (§1), Studio Test user (§4), MCP server administrator (§3). Fold workspace-auditor compliance reviewer into existing platform operator story. |
| B2  | FR numbering?                              | DECIDED        | Continue from FR-9 onward — preserves test-spec / HLD / LLD cross-references.                                                                                        |
| B3  | Contracts as FRs or §12 sub-section?       | DECIDED        | New §12.0 sub-section "Cross-Cutting Normative Contracts" — TI-1/CK-1/RP-1/ST-1/TE-1/FF-1 are architectural invariants, not user-testable FRs.                       |
| B4  | New quantitative SLOs?                     | DECIDED        | No — keep existing §14 metrics; add qualitative constraints (30s pre-expiry refresh, 600s init-lock TTL, Redis-backed CC cache) to §12.                              |
| B5  | Feature flags per-tenant or process-level? | INFERRED       | Process-level env vars — matches existing pattern; `tenant.model.ts` has no per-tenant feature-flag mechanism.                                                       |

### Section C — Technical & Architecture

| #   | Question                       | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Schema/data-model changes?     | ANSWERED       | (i) New `profileVersion: number` on `auth_profiles` (NOT `version` — collides with existing `_v` schema-version at `auth-profile.model.ts:113`). (ii) `mcp_server_configs` field split: `authProfileId` + `envProfileId`. (iii) MCP transport `tlsOptions` extension for streamable-http mTLS. (iv) **Backfill migration for `profileVersion=1`** added (not in original Commented.md but required by CK-1). `EndUserOAuthToken` needs no schema change. |
| C2  | External deps?                 | INFERRED       | Add `@aws-sdk/signature-v4`, `@aws-sdk/protocol-http`, `@hapi/hawk`, `kerberos` (env-gated). Skip `@azure/msal-node` — plain `fetch` suffices, matches SharePoint connector pattern.                                                                                                                                                                                                                                                                     |
| C3  | Migration scripts?             | INFERRED       | THREE scripts: (a) `mcp_server_configs` field split, (b) `tools/migrate-auth-aliases.ts` (sunset `v2026.07.x`), (c) **NEW: backfill `profileVersion=1` on all existing rows** — required by CK-1.                                                                                                                                                                                                                                                        |
| C4  | RBAC/security Phase-0 prereqs? | ANSWERED       | (a) `auth-profile:write` does NOT exist in `WORKSPACE_PERMISSIONS` (`workspace-permission.ts:12-17`) — must be added. (b) Workspace-auditor read-only role does not exist — extend VIEWER or add new role. (c) Reserved-principal validator missing at user-creation paths (`apps/studio/src/services/auth-service.ts`) — add per RP-1.                                                                                                                  |
| C5  | Observability deliverables?    | ANSWERED       | (a) TraceStore wiring (matches existing GAP-6). (b) New sanitizer at `packages/shared-auth-profile/src/sanitize-error.ts`. (c) Audit log emissions (constants exist at `packages/database/src/auth-profile/audit-events.ts` but never emitted). (d) `.claude/hooks/auth-type-coverage.sh` drift lint. (e) NEW: `mcp.auth_refreshed` trace event constant.                                                                                                |

## Decisions Summary

- Update existing `docs/features/auth-profiles.md` in-place
- Downgrade status STABLE → BETA
- Add FR-9 through FR-N (oracle to determine N during draft)
- Add 3 new user stories (workflow author, Studio Test user, MCP admin)
- Add §12.0 Cross-Cutting Normative Contracts (TI-1, CK-1, RP-1, ST-1, TE-1, FF-1)
- Add 3 migration scripts (incl. profileVersion backfill)
- Phase 0 RBAC prerequisites: workspace `auth-profile:write` permission, workspace-auditor role, reserved-principal validator
- New model field is `profileVersion` (not `version` — avoids `_v` collision)
- No `@azure/msal-node` dep — use plain `fetch`

## Open Items Escalated

- **A5 priority/timeline driver** — user must specify whether scope is security-driven (Critical-finding fix), platform-consistency goal, or customer-committed deadline. This affects phase ordering (P0 vs P1 split) and effort allocation.

## Next Steps

1. Resolve A5 with user
2. Generate feature-spec update (Phase 2)
3. Update testing guide placeholder (Phase 3)
4. 5-pass audit (Phase 4b)
5. Commit (Phase 5)
