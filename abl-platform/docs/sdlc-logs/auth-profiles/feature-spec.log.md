# SDLC Log: Auth Profiles -- Feature Spec (Phase 1)

**Date**: 2026-03-22
**Phase**: Feature Spec
**Feature**: auth-profiles
**Author**: AI Agent (SDLC pipeline)

---

## Clarifying Questions & Decisions

### Scope Questions

1. **Q**: Does the `shared-auth-profile` package exist as a standalone package?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: No. Despite prior docs referencing `@agent-platform/shared-auth-profile`, the auth profile modules live in `packages/shared/src/services/auth-profile/` (17 files). There is no standalone `shared-auth-profile` package in the workspace.

2. **Q**: What is the actual default for `AUTH_PROFILE_ENABLED`?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Disabled. `feature-flag.ts` uses `process.env.AUTH_PROFILE_ENABLED === 'true'` -- strict equality check means it defaults to false when unset. Prior docs incorrectly stated "default: true".

3. **Q**: Does the runtime expose a dedicated auth-profiles REST router?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: No. `apps/runtime/src/routes/auth-profiles.ts` does not exist. Runtime auth profile access is through internal services (resolver, cache, rotation job). The only related routes are in `platform-admin-health.ts`.

### User Stories Questions

4. **Q**: How many consumers currently integrate with auth profiles?
   - **Classification**: INFERRED (from grep results)
   - **Answer**: At least 12+ consumers based on code references: connectors, connections, model configs, voice services, MCP servers, channel connections, guardrail providers, SearchAI, secrets provider, proxy config, delivery worker, git credentials.

5. **Q**: Is batch OAuth consent a real feature?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: The `useBatchOAuth.ts` hook is referenced in Studio but does not exist. This appears to be a planned but unimplemented feature.

### Technical Questions

6. **Q**: How many unique indexes does the model actually have?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: 2 partial unique indexes (not 4 as prior docs claimed). One for `projectId: null`, one for `projectId: { $ne: null }`. Both use `{tenantId, name, environment}` / `{tenantId, projectId, name, environment}`. No personal-visibility partials.

7. **Q**: What encryption algorithm and parameters are used?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: AES-256-GCM, 12-byte IV (96 bits per NIST SP 800-38D), 16-byte auth tag, 32-byte key length, PBKDF2 100K iterations or HKDF SHA-256. Master key is 64-character hex string (256-bit). Confirmed in `packages/shared/src/encryption/constants.ts`.

8. **Q**: How many test files actually exist vs. claimed in prior docs?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: 24 test files verified to exist out of 37 claimed. 13 test files from prior docs are missing from the codebase.

9. **Q**: What is the trace event integration status?
   - **Classification**: ANSWERED (code evidence)
   - **Answer**: Trace events use structured logging (`log.info`) via `emitAuthProfileTraceEvent()`. Comment in trace-events.ts explicitly states "TraceStore integration deferred to Phase 2". Not yet wired to the full TraceStore event pipeline.

### Architecture Questions

10. **Q**: Is the encryption layer a separate package?
    - **Classification**: ANSWERED (code evidence)
    - **Answer**: No. `packages/shared-encryption/` does not exist. Encryption lives in `packages/shared/src/encryption/` (engine.ts, constants.ts, types.ts, key-derivation/, cache/, errors.ts, field-interceptor.ts, encryption-manifest.ts).

11. **Q**: Where do the addon mechanism implementations live?
    - **Classification**: ANSWERED (code evidence)
    - **Answer**: In `packages/shared/src/services/auth-profile/`: `apply-signing.ts`, `verify-webhook.ts`, `apply-proxy.ts`. Schema in `packages/shared/src/validation/auth-profile-addons.schema.ts`. Certificate pinning and JWT wrapping are schema-only (Phase 3 forward-compat fields in model).

12. **Q**: How does import/export handle auth profiles?
    - **Classification**: ANSWERED (code evidence)
    - **Answer**: Via `packages/project-io/src/import/auth-profile-resolver.ts` (name-based resolution with fuzzy matching) and `auth-mapping.ts`. Export uses `connections-assembler.ts` and `manifest-generator.ts`.

---

## Key Findings

1. **Package naming mismatch**: Prior docs reference `@agent-platform/shared-auth-profile` as a standalone package, but the code lives in `packages/shared/src/services/auth-profile/`. The actual standalone `packages/shared-auth/` is for platform auth middleware (not auth profiles).

2. **Feature flag default is opposite of documented**: Code shows `=== 'true'` (disabled by default), prior docs said "default: true (enabled unless explicitly 'false')".

3. **Significant file existence gaps**: 7 source files and 13 test files referenced in prior docs do not exist in the codebase. This suggests either incomplete implementation or documentation drift.

4. **Strong implementation core**: The actual implemented code is robust -- 17 auth types, encryption at rest, dual-read migration, LRU caching, distributed locking, redaction, health probes, alert evaluator, and comprehensive Studio UI components.

5. **Unique index strategy simpler than documented**: Only 2 partial unique indexes (shared namespace), not 4 (no personal-visibility partials).

---

## Audit Checklist

- [x] All 18 TEMPLATE sections present
- [x] All file paths verified with Glob/test -f
- [x] Feature flag default corrected from prior docs
- [x] Package naming corrected (shared/src/services/auth-profile/, not standalone package)
- [x] Index count corrected (2 unique, not 4)
- [x] Missing files explicitly listed in Gaps section
- [x] Test file inventory verified (24 exist, 13 missing)
- [x] All claims grounded in code evidence

---

# ABLP-913 Update Run — 2026-05-08

**Ticket**: ABLP-913 — Auth Profile Design — Decisions & Behavior Spec
**Mode**: UPDATE existing `docs/features/auth-profiles.md` to reflect ABLP-913 decisions
**Scope**: Full ticket (P0 + P1 + P2)
**Surfaces**: Backend (runtime/admin/packages) + Studio UI + SDK

## Pre-Discovery Gap Map

Source: explorer agent run.

### MISSING (8)

1. `profileType` discriminator field (Integration vs Custom). Currently inferred from `connector` presence.
2. "To be Authorized" status. Current statuses: active|expired|revoked|invalid.
3. Token Refresh URL required for Preconfigured OAuth (currently optional).
4. Type-aware stepped Auth Assignment UI at tool level (currently flat AuthProfilePicker).
5. Revoke User Tokens action (NEW; only Revoke Profile exists).
6. Pre-revoke blast-radius warning modal.
7. Mid-session token invalidation (revocation does not bust live sessions).
8. Scope error handling (insufficient_scope errors).

### PARTIAL (4)

9. Consumers endpoint missing A2A servers; HTTP tools as distinct from ServiceNode.
10. Audit logs: audit-trail plugin captures writes but no auth-profile-specific log surface for authorize/refresh/revoke events.
11. Project-scoped consent persistence: `EndUserOAuthToken` is tenant-scoped, no projectId field.
12. Filter unauthorized profiles in dropdowns: filterStatus='active' works but can't distinguish "active but not authorized".

### PRESENT (4)

13. Integrations Tab with vendor grouping (`IntegrationAuthTab.tsx`, `IntegrationCard.tsx`).
14. Usage Mode field (`preconfigured|user_token|jit|preflight`) — `auth-profile.model.ts:57-63`.
15. Authorize CTA on integration cards — `IntegrationCard.tsx:96-100`.
16. Profile deletion guard with consumer check — `auth-profiles.ts:633-644` (runtime), Studio route 419.

## Product Oracle Decisions

All 16 clarifying questions classified. **Zero AMBIGUOUS** — no human escalation needed.

| ID         | Decision                                                                                                                                                                                          | Source/Rationale                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-1 (Q1)   | Add persisted `profileType: 'integration' \| 'custom'` field. Backfill: `connector ? 'integration' : 'custom'`.                                                                                   | Platform convention: explicit discriminators (`authType`, `scope`) over inferred state.                      |
| D-2 (Q2)   | "No connection layer" is a clarifying statement, not a refactor. `ConnectorConnection` is a binding record only — no credentials. `connectionMode` controls token-storage scope.                  | `connector-connection.model.ts:1-11` docstring.                                                              |
| D-3 (Q3)   | Show unauthorized OAuth profiles as **disabled** rows with inline Authorize CTA in dropdowns — not hidden.                                                                                        | Visibility + safety. Hiding removes blast-radius awareness.                                                  |
| D-4 (Q4)   | Add `projectId` to `EndUserOAuthToken`. New unique index `{tenantId, projectId, userId, provider}`. Migration: backfill from profile.projectId when known; null-safe for tenant-scoped profiles.  | CLAUDE.md Core Invariant #1 (project isolation); ABLP-913 §13 explicit requirement.                          |
| D-5 (Q5)   | `Revoke User Tokens` supports both per-profile bulk and per-user via optional `userId` query param.                                                                                               | Bulk for credential compromise; per-user for offboarding.                                                    |
| D-6 (Q6)   | Mid-session invalidation: P1 = TTL-based eventual (5min), P2 = explicit force-invalidate broadcast endpoint. P0/P1 sign-off treated as granted.                                                   | `auth-profile-cache.ts:34` already 5-min TTL. Pub/sub adds infra for marginal benefit.                       |
| D-7 (Q7)   | Scope errors: generic re-auth prompt to end user; detailed scope info (required vs granted) to admin audit logs. Reactive — detect `insufficient_scope` from provider errors.                     | CLAUDE.md User-Facing Runtime Error Sanitization. No proactive scope registry exists.                        |
| D-8 (Q8)   | Inline-Add for simple types creates a transient (tool-scoped) auth profile behind the scenes — encrypted. NEVER plaintext on tool config.                                                         | CLAUDE.md Core Invariant #5 (encryption at rest).                                                            |
| D-9 (Q9)   | "To be Authorized" is a **computed/derived** field (`isAuthorized`) per-user, not a new status enum value.                                                                                        | Status = profile health; authorization = per-user state. Orthogonal.                                         |
| D-10 (Q10) | New `AuthProfileAssignment` component (stepped, type-aware) coexists with existing `AuthProfilePicker`. Migrate 8 callers incrementally.                                                          | 8 callers found across Git, Model, Guardrail, Voice, Connection, MCP, Channel — breaking changes too costly. |
| D-11 (Q11) | "Activity" tab on `AuthProfileSlideOver` for per-profile audit log. No separate `/audit-logs` page in this scope.                                                                                 | Matches existing slide-over tab pattern.                                                                     |
| D-12 (Q12) | `tokenRefreshUrl` required on CREATE for `oauth2_app + preconfigured`. Optional on UPDATE (backward compat). Validate endpoint warns existing profiles missing it.                                | `auth-profile.schema.ts:169` currently optional. Backward compatibility per CLAUDE.md.                       |
| D-13 (Q13) | New endpoint `POST /:profileId/revoke-user-tokens`. Separate from existing `/revoke` (which still decommissions the profile).                                                                     | Different semantics + side effects = different endpoints.                                                    |
| D-14 (Q14) | Extend existing `/consumers` to cover ToolDefinition (HTTP tools) and A2A servers (when model exists). Authoritative list: integrations, channels, MCP, services, HTTP tools, git, triggers, A2A. | `consumers/route.ts:65-85` covers 6 types today.                                                             |
| D-15 (Q15) | UI shows all 17 auth types organized by category: "Common" (the 9 in ABLP-913), "Enterprise" (Phase 2), "Advanced" (Phase 3). Phase 3 visually de-emphasized.                                     | Removing types orphans existing profiles. `AUTH_TYPE_CATEGORIES` already exists.                             |
| D-16 (Q16) | Authorize CTA on `AuthProfileSlideOver` in addition to integration cards.                                                                                                                         | Lifecycle actions (revoke/delete/validate) already on slide-over.                                            |

## Status

- [x] Read template, authoring guide, existing spec
- [x] Explore codebase for gap map
- [x] Spawn product-oracle for clarifying questions
- [x] Log decisions
- [x] Generate updated feature spec (auth-profiles.md: 681 → ~1015 lines)
- [x] Update testing guide placeholder (ABLP-913 PLANNED section added at top)
- [x] Audit loop round 1 — phase-auditor returned NEEDS_REVISION (3 CRITICAL, 4 HIGH, 3 MEDIUM)
- [x] Round-1 fixes applied (EndUserOAuthToken accuracy, Surface Semantics, Design-Time/Runtime, customer-experience reclassified, integration matrix extended, user_token non-goal)
- [x] Audit loop round 2 — phase-auditor returned APPROVED with 2 non-blocking MEDIUM (EndUserOAuthToken isolation + audit events isolation tables)
- [x] Round-2 fixes applied (isolation tables added)

## Final Outputs

- `docs/features/auth-profiles.md` — 1015 lines, 18 TEMPLATE sections complete, 31 FRs (8 EXISTING + 23 ABLP-913 PLANNED)
- `docs/testing/auth-profiles.md` — placeholder section added; full ABLP-913 scenarios pending in /test-spec
- `docs/sdlc-logs/auth-profiles/feature-spec.log.md` — this log

## Next Phase

`/test-spec` — fill the FR-9..FR-31 coverage matrix with ≥5 E2E + ≥5 integration scenarios for ABLP-913.
