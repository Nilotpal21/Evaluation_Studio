# SDLC Log: Auth Profiles -- HLD UPDATE Oracle (Phase 1)

**Date**: 2026-05-01
**Phase**: HLD Update -- Oracle clarifying questions
**Feature**: auth-profiles (BETA, r2 gap-closure scope)
**Branch**: `fixes/AuthProfiles`
**HLD under update**: `docs/specs/auth-profiles.hld.md` (385 lines, STABLE state, dated 2026-04-03)

---

## Context Consulted

- `docs/features/auth-profiles.md` (1051 lines, BETA, FR-1..FR-17 + 6 normative contracts + GAP-7..GAP-26)
- `docs/testing/auth-profiles.md` (627 lines, PARTIAL, 15 E2E + 14 INT)
- `docs/specs/auth-profiles.hld.md` (385 lines, STABLE, 12 concerns + 3 alternatives + 6 risks)
- `docs/sdlc-logs/auth-profiles/feature-spec-update-2026-04-30.log.md`
- `docs/sdlc-logs/auth-profiles/feature-spec-audit-2026-04-30.log.md`
- `docs/sdlc-logs/auth-profiles/test-spec-update-2026-04-30.log.md`
- `docs/sdlc-logs/auth-profiles/hld.log.md` (original HLD generation, 2026-03-22)
- `docs/sdlc-logs/auth-profiles/lld.log.md` (original LLD generation, 2026-03-22)
- `docs/sdlc-logs/auth-profiles/post-impl-sync.log.md` (last sync 2026-04-03)
- `docs/specs/integration-auth-profiles.hld.md` (sibling APPROVED, non-touch boundary)
- `CLAUDE.md` (invariants: Studio Route Handler Gotchas, Test Architecture, Commit Discipline, Core Invariants 1-6)

---

## Section A -- Architecture & Data Flow

| #   | Question (short)                                                    | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| A1  | Full rewrite vs additive sections?                                  | **DECIDED**    | **Additive update with structural amendments.** Keep the existing 385 lines (they accurately document STABLE-era architecture). Add new sections: (a) r2 status banner at top noting BETA and r2 scope; (b) new Component Architecture additions under existing SS2 for `packages/shared-auth-profile/` consolidation + signRequest hook; (c) new Data Flow diagrams (workspace OAuth, MCP unified auth lifecycle); (d) new SS "Error Code Registry" (per OQ-9); (e) expand existing SS3.x sub-sections for r2 performance/security/observability additions already in the feature spec; (f) new SS "Deferred Limitations" for GAP-19..26; (g) expand SS7 Risks table. A full rewrite is unnecessary because the existing 12-concern structure is architecturally sound and matches the TEMPLATE.md expectations -- r2 adds to each concern rather than restructuring.                           | Precedent: the feature spec was updated in-place (A1 decision in `feature-spec-update-2026-04-30.log.md:41`). The `integration-auth-profiles.hld.md` is a separate doc at 50+ lines -- the parent HLD update follows the same in-place pattern. Risk of full rewrite: loss of the grounded code evidence from the original HLD pass (2026-03-22), which was verified against codebase.        |
| A2  | Document pre-Phase-0 dual-path, post-consolidation, or both?        | **DECIDED**    | **Document both as a before/after in SS2, with the migration as an explicit transition note.** The HLD's SS2 currently lists `packages/shared/src/services/auth-profile/apply-auth.ts` (line 75). Add a subsection "Package Consolidation (Phase 0)" that shows: (a) pre-consolidation state (two `apply-auth.ts` -- one in `packages/shared/`, one in `packages/shared-auth-profile/`); (b) post-consolidation single-path in `packages/shared-auth-profile/src/apply-auth.ts` with thin re-export in `packages/shared/` for one minor release. This follows the same pattern used for dual-read (SS3.8 documents both states).                                                                                                                                                                                                                                                                 | Feature spec SS7 r2 Technical Considerations (lines 189-190): "Two `apply-auth.ts` paths exist today... They must be consolidated into `packages/shared-auth-profile/`; the `packages/shared` versions become thin re-exports for one minor release." Feature spec P8 Phase 0.1 (line 841): effort S, 1 day.                                                                                  |
| A3  | Where does SSE-vs-HTTP MCP refresh distinction go?                  | **DECIDED**    | **New SS "MCP Auth Flow" with sequence diagram, containing a sub-section for transport-specific refresh behavior.** Rationale: (a) SS3.3 Performance is wrong -- this is a correctness concern, not a performance concern (SSE streams physically cannot hot-swap headers; this is a protocol constraint, not a latency optimization); (b) a new SS3.4 under the existing 12-concern structure would miscategorize it; (c) a dedicated "MCP Auth Flow" section (parallel to the existing "Data Flow: OAuth2 Authorization" at HLD lines 175-213) is the right architectural level. The section should include a Mermaid sequence diagram showing: HTTP transport (per-request header injection -> 30s pre-expiry refresh -> hot-swap), and SSE transport (persistent connection -> 30s pre-expiry refresh -> close stream -> reconnect with new token).                                          | Feature spec FR-11 (line 121): "HTTP transports hot-swap headers; SSE transports must close stream and reconnect." MCP Authorization Spec 2025-03-26 SS"Access Token Usage": "authorization MUST be included in every HTTP request." Feature spec SS7 (line 731): "Long-lived MCP transports trigger a 30 s pre-expiry refresh..." `mcp-server-config.model.ts:57`: transport enum is `'http' | 'sse'`. |
| A4  | Reproduce SS12.0 contracts verbatim or reference by ID?             | **DECIDED**    | **Reference by ID with the HLD documenting HOW the architecture satisfies each contract.** Rationale: (a) verbatim reproduction creates a maintenance burden -- the feature spec is the single source of truth for the normative contract statements; (b) the HLD's job is to show architectural compliance, not to restate requirements; (c) precedent: the existing HLD SS6 API Design (lines 363-373) says "See Feature Spec Section 8" rather than reproducing the API table; (d) add a new "Contract Compliance" sub-section that maps each contract ID (TI-1, CK-1, RP-1, ST-1, TE-1, FF-1) to the specific architectural mechanism that satisfies it (e.g., TI-1 -> `tenantIsolationPlugin` + explicit `tenantId` in all queries; CK-1 -> `auth-token:{tenantId}:{authType}:{profileId}:{profileVersion}:{scopeHash}` Redis key pattern).                                                 | Existing HLD pattern at lines 363-373: "See [Feature Spec Section 8: How to Consume](...) for the complete API documentation." Feature spec SS12.0 contracts at lines 665-676. Architectural principle: HLD shows mechanism, feature spec states requirement.                                                                                                                                 |
| A5  | Separate or unified sequence diagram for project + workspace OAuth? | **DECIDED**    | **Unified diagram with scope-annotated branches.** Rationale: (a) the flows are architecturally identical after Phase A refactoring (FR-13 Phase A extracts shared services from existing project routes -- feature spec line 863); (b) the difference is only in routing entry point and scope parameter (`projectId` present vs null); (c) two separate diagrams would duplicate 80%+ of the steps and obscure the shared-service architecture; (d) a single diagram with a `[project scope]` / `[workspace scope]` annotation at the divergence points (route entry, RBAC check, token storage principal) is clearer. Add a box annotation: "Workspace flow: `POST /api/auth-profiles/oauth/{initiate,callback}`, scope='tenant', token userId='**tenant**'." vs "Project flow: `POST /api/projects/:projectId/auth-profiles/oauth/{initiate,callback}`, scope='project', token userId=real." | Feature spec FR-13 Phase A (line 863): "Refactor existing project routes into shared services (no behavior change)." ST-1 contract applies to BOTH flows (feature spec line 125: "MUST be applied to BOTH the new workspace routes AND the existing project routes"). The architectural mechanism is identical; only the RBAC gate and storage principal differ.                              |

---

## Section B -- Error Code Registry & Cross-Cutting Concerns

| #   | Question (short)                                                              | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Error Code Registry: HLD SS6 or new top-level SS7?                            | **DECIDED**    | **New dedicated section "Error Code Registry" as a top-level section (insert as new SS7, renumbering existing SS7 Risks to SS8).** Rationale: (a) the registry is a first-class architectural deliverable (per OQ-9 carry-forward from phase-auditor pass 2 -- see `feature-spec-audit-2026-04-30.log.md:49`); (b) it consolidates 11 new error codes + 16 existing ones = 27 total, which is too large for a sub-section of SS6 API Design; (c) the error model is cross-cutting (errors surface in runtime, MCP, Studio Test, Studio UI, audit logs) -- a standalone section better captures the dispatch matrix; (d) it parallels the "Error Handling" sub-section already at HLD SS3.12 (lines 309-315) but at a registry level rather than a behavioral level.                                                                                                                                                                                                                                                                                                  | Feature spec OQ-9 (line 916): "HLD must consolidate into an 'Error Code Registry' section with HTTP status, consumer surface (runtime/MCP/Studio Test/Studio UI), NEW vs EXISTING tag, and introducing FR." Phase-auditor pass 2 finding (audit log line 49): "Error-code taxonomy table -- 11 new error codes scattered across FR-9..FR-17; HLD must consolidate." |
| B2  | Full registry (all 27 codes) or delta registry (11 new only)?                 | **DECIDED**    | **Full registry (all 27 codes).** Rationale: (a) the SS17 audit suite (test spec SS5) needs a complete registry to verify against -- a delta registry forces auditors to cross-reference two locations; (b) the existing 16 codes at `AuthProfileError` in `packages/shared/src/errors/auth-profile-errors.ts` (HLD line 311) are documented only as a count ("16 error codes") not enumerated -- the HLD has never listed them individually; (c) a full registry is easier to maintain than a partial one (single location for HTTP status mapping, consumer surface, and introducing FR); (d) precedent in the codebase: `packages/shared/src/errors/` files enumerate all error codes rather than splitting by release. The table should have columns: Code, HTTP Status, Consumer Surface(s), NEW/EXISTING, Introducing FR, Description.                                                                                                                                                                                                                         | HLD SS3.12 (line 311): "16 error codes: `AuthProfileError` class with typed error codes (e.g., `PROFILE_NOT_FOUND`, `PROFILE_EXPIRED`, `REFRESH_FAILED`, `DECRYPTION_FAILED`, `LINKED_APP_INVALID`)." Feature spec OQ-9 lists all 11 new codes. The full set is: 16 existing (from `auth-profile-errors.ts`) + 11 new (from FR-9..FR-17) = 27 total.                |
| B3  | signRequest in SS6 API Design or new "Runtime Protocol Handler Architecture"? | **DECIDED**    | **Sub-section of SS2 Component Architecture, NOT a new top-level section.** Rationale: (a) the signRequest callback is a component-level design decision (it is a property of `ApplyAuthResult` returned by `applyAuth()` in `packages/shared-auth-profile/src/apply-auth.ts`) -- not an API surface; (b) creating a new "Runtime Protocol Handler Architecture" top-level section is architecturally over-weighted for what is a dispatch table with 6 entries; (c) the right place is SS2 Component Architecture, which already documents `apply-auth.ts` (line 75) and the auth-profile service module structure; (d) add a "Protocol Dispatch" sub-section to SS2 showing the dispatch table: `azure_ad` (token exchange), `aws_iam` (signRequest callback), `digest` (retry-on-401 in HttpToolExecutor), `hawk` (signRequest callback), `saml` (RFC 7522 grant), `kerberos` (SPNEGO), `ws_security` (SOAP envelope). Include a note: "signRequest is headers-only by design; body-mutating protocols (digest, ws_security) use separate code paths per GAP-23." | Feature spec FR-15 (line 129): "`ApplyAuthResult` must gain an optional `signRequest` callback." GAP-23 (line 956): "signRequest callback returns Headers only; body-mutating protocols use a different code path." Feature spec SS7 Technical Considerations (line 193): external deps for protocol handlers.                                                      |
| B4  | Deferred Limitations sub-section for GAP-21 + GAP-25 + GAP-26?                | **DECIDED**    | **Yes -- add a "Known BETA Limitations" sub-section under the expanded SS8 Risks (formerly SS7).** Rationale: (a) these 3 GAPs are explicitly documented as open/accepted limitations in the feature spec (GAP-21 line 954: "known limitation in BETA"; GAP-25 line 958: "Document deployment topology assumption"; GAP-26 line 959: "Add documentation note in HLD"); (b) they are architecturally distinct from risks with mitigations (they are accepted trade-offs, not risks to be mitigated); (c) the HLD should enumerate them so the LLD knows which items are explicitly deferred vs which need design; (d) include: GAP-21 (grant revocation propagation -- mitigation: short TTLs + refresh-failure path; RFC 7662 introspection = LLD item), GAP-25 (cross-region Redis -- mitigation: document single-region assumption), GAP-26 (MCP spec compliance scoping -- document `bearer` as spec-compliant, other 11 as platform extensions).                                                                                                                 | Feature spec SS16 GAP-21 (line 954), GAP-25 (line 958), GAP-26 (line 959). All three carry `Status: Open` with explicit resolution text pointing to HLD documentation.                                                                                                                                                                                              |

---

## Section C -- Risk & Migration

| #   | Question (short)                                                              | Classification | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | HLD SS11 Config: mirror env var list or reference feature spec?               | **DECIDED**    | **Reference feature spec SS11 for the full list; HLD SS11 documents only the architectural significance.** Rationale: (a) the HLD's existing SS7 Deployment (line 275-277) and SS3.7 (not present as a separate section -- it is embedded) already follow the pattern of documenting architectural behavior, not enumerating config; (b) 14 env vars is operational detail that belongs in the feature spec; (c) the HLD should document: (i) the FF-1 contract requires per-protocol gates (architectural invariant); (ii) the staged rollout pattern (flags default `false -> true`); (iii) the kill-switch fidelity requirement (flag=false fully restores legacy behavior); (iv) the build-time vs runtime gate distinction (`ENABLE_KERBEROS` is build-time; all others are runtime). This is the architectural significance without duplicating the table.                                                                                                                                                                                                                                                                                                                                                                    | Feature spec SS11 (lines 631-648): 14 env vars enumerated. HLD existing pattern at SS6 API Design (lines 363-373): "See Feature Spec Section 8" rather than reproducing the table. Precedent: the HLD consistently references the feature spec for detail tables and documents architectural significance.                                                                                       |
| C2  | Expand SS7 Risks to ~13 rows or split into resolved/open?                     | **DECIDED**    | **Split into two sub-sections: "Risks and Mitigations" (existing + new risks with mitigations) and "Known BETA Limitations" (accepted trade-offs).** Rationale: (a) the current 6 rows are all risk-with-mitigation pairs; (b) the r2 additions include both risk-with-mitigation pairs (cross-tenant cache leak -> CK-1; OAuth state replay -> ST-1; SSRF -> blocklist) AND accepted limitations (GAP-21, GAP-25, GAP-26 per B4 above); (c) mixing both in a single table confuses "risks we've mitigated" with "limitations we've accepted"; (d) the risk table should grow to ~10 rows (existing 6 + cross-tenant cache leak + OAuth state replay + reserved-principal collision + SSRF + redirect_uri manipulation + thundering-herd refresh); the limitations sub-section handles GAP-21/25/26 separately. Provider rate limits (GAP-22) is a risk with mitigation (token bucket rate limiter = LLD design item), so it goes in the risk table with "Mitigation: LLD -- token-exchange rate limiter per {tenantId, profileId}."                                                                                                                                                                                                | Feature spec SS16 GAPs: GAP-7 (CK-1 violation, CRITICAL), GAP-8 (ST-1 violation, CRITICAL), GAP-9 (RP-1 violation, CRITICAL), GAP-19 (SSRF, HIGH), GAP-20 (redirect_uri, HIGH), GAP-22 (rate limits, MEDIUM), GAP-24 (thundering herd, MEDIUM). These are risk-with-mitigation. GAP-21 (revocation, MEDIUM), GAP-25 (cross-region, LOW), GAP-26 (MCP spec scope, LOW) are accepted limitations.  |
| C3  | HLD SS10 Migration Path: rollout sequence or architectural enablement points? | **DECIDED**    | **Architectural enablement points only.** Rationale: (a) the rollout sequence (kill-switch off -> progressive enablement -> flag removal) is an operational concern that belongs in the LLD/implementation plan, not the HLD; (b) the HLD should document WHERE flags gate (route level, middleware level, protocol handler level, build system level) and WHERE dual-paths exist (apply-auth consolidation re-export, MCP authProfileId/envProfileId field split); (c) the HLD's existing SS3.7 Deployment (lines 275-277) and SS3.8 Migration (lines 279-285) already follow this pattern -- they describe architectural mechanisms, not rollout timelines; (d) the feature spec P8 Phase 0-5 plan (lines 835-883) already covers the sequencing in detail; duplicating it in the HLD creates a maintenance burden. The HLD should add: "r2 introduces 9 feature flags (SS11) and 3 migration scripts (SS7 Technical Considerations). Flags gate at four levels: route middleware (WORKSPACE_OAUTH_ENABLED), tool-level middleware constructor (WORKFLOW_AUTH_PROFILE_ENABLED), protocol handler dispatch (AUTH_AZURE_AD_ENABLED et al.), and build system (ENABLE_KERBEROS). See feature spec SS13 P8 for the rollout sequence." | HLD SS3.7 Deployment (lines 275-277): documents dual-read activation, zero-downtime, rolling updates -- all architectural descriptions, not operational timelines. HLD SS3.8 Migration (lines 279-285): documents dual-read pattern, no schema migration, rollback mechanism -- all architectural. Feature spec SS13 P8 (lines 835-883): 36-44 engineer-days rollout plan with phase sequencing. |

---

## Decisions Summary

- **D-A1**: Additive update (not full rewrite). Preserve existing 385 lines; add r2 sections for new data flows, component additions, error registry, and risk expansion. **Risk: Low** -- existing structure is sound; additive changes are smaller in review surface.
- **D-A2**: Document both pre- and post-Phase-0 consolidation states in SS2 with a transition note. **Risk: Low** -- standard migration documentation pattern.
- **D-A3**: New "MCP Auth Flow" section with sequence diagram, separate from SS3.3 Performance (this is a correctness/protocol concern). **Risk: Low** -- clear architectural separation.
- **D-A4**: Reference contracts by ID; HLD documents mechanism compliance. Feature spec is single source of truth for normative statements. **Risk: Low** -- matches existing HLD referencing pattern.
- **D-A5**: Unified OAuth sequence diagram with scope-annotated branches (not two separate diagrams). **Risk: Low** -- flows share 80%+ of steps; Phase A refactoring makes them architecturally identical.
- **D-B1**: New top-level "Error Code Registry" section (insert as SS7, bump existing SS7 Risks to SS8). **Risk: Low** -- OQ-9 explicitly requires this; 27 codes warrant a dedicated section.
- **D-B2**: Full registry (all 27 codes), not delta. **Risk: Low** -- single location is easier to maintain and audit.
- **D-B3**: signRequest dispatch table as sub-section of SS2 Component Architecture, not a new top-level section. **Risk: Low** -- dispatch table has 6 entries; doesn't warrant a top-level section.
- **D-B4**: "Known BETA Limitations" sub-section under Risks for GAP-21/25/26. **Risk: Low** -- these are explicitly documented as accepted trade-offs in the feature spec.
- **D-C1**: HLD SS11 references feature spec for env var list; documents only architectural significance of the flag pattern. **Risk: Low** -- matches existing HLD referencing convention.
- **D-C2**: Split risks into "Risks and Mitigations" (~10 rows) + "Known BETA Limitations" (~3 rows). **Risk: Low** -- cleaner separation of concerns.
- **D-C3**: Document architectural enablement points (where flags gate, where dual-paths exist), not rollout sequence. **Risk: Low** -- rollout sequence is an LLD/operational concern.

---

## Open Items Escalated

No items classified as AMBIGUOUS. All 12 questions were resolvable from the existing feature spec, test spec, HLD structure, audit logs, and CLAUDE.md invariants without user input.

---

## Proposed HLD Section Outline (for reference)

The updated HLD should have this structure (new/modified sections marked with `[NEW]` or `[MODIFIED]`):

```
# High-Level Design: Auth Profiles

Status: BETA [MODIFIED from STABLE]
Feature Spec: ... (r2 gap-closure scope)
Last Updated: 2026-05-01

## 1. System Context [MODIFIED -- add r2 consumer types, MCP unified auth]
## 2. Component Architecture [MODIFIED -- add Phase 0 consolidation, signRequest dispatch, protocol handler table]
   ### Data Flow: Credential Resolution (Runtime) [EXISTING]
   ### Data Flow: OAuth2 Authorization (Unified Project + Workspace) [MODIFIED -- unified diagram with scope branches]
   ### Data Flow: MCP Auth Lifecycle [NEW -- SSE vs HTTP refresh, sequence diagram]
   ### Protocol Dispatch Table [NEW -- 6 protocol handlers + signRequest callback shape]
## 3. Architectural Concerns (12 Areas) [MODIFIED per-concern r2 additions]
   ### 3.1 Isolation [MODIFIED -- add workspace-scope resolution, FR-10 canonical filter]
   ### 3.2 Security [MODIFIED -- add RP-1, ST-1, SSRF blocklist, CSRF, init-lock]
   ### 3.3 Performance [MODIFIED -- add MCP pre-expiry refresh, Redis CC cache, profileVersion keying]
   ### 3.4 Reliability [EXISTING + minor r2 additions]
   ### 3.5 Observability [MODIFIED -- add TraceStore wiring, new event types, drift lint]
   ### 3.6 Data Lifecycle [EXISTING]
   ### 3.7 Deployment [MODIFIED -- add flag-gating architecture: route/middleware/handler/build]
   ### 3.8 Migration [MODIFIED -- add Phase 0 consolidation, 3 migration scripts]
   ### 3.9 Backwards Compatibility [EXISTING + alias sunset note]
   ### 3.10 Testing Strategy [MODIFIED -- add matrix E2E, kill-switch fidelity, 15 E2E / 14 INT]
   ### 3.11 Monitoring [EXISTING]
   ### 3.12 Error Handling [EXISTING -- behavioral description; registry is separate]
## 4. Alternatives Considered [EXISTING]
## 5. Data Model Design [MODIFIED -- add profileVersion, mcp_server_configs field split, CK-1 cache schema, ST-1 state schema]
## 6. API Design [MODIFIED -- add workspace OAuth routes, tools/workflow-compatible, reference feature spec SS8]
## 7. Error Code Registry [NEW -- full 27-code table: code, HTTP status, consumer surface, NEW/EXISTING, introducing FR]
## 8. Risks and Mitigations [MODIFIED from existing SS7 -- expand to ~10 rows]
   ### Known BETA Limitations [NEW -- GAP-21, GAP-25, GAP-26]
## 9. Contract Compliance Matrix [NEW -- maps TI-1/CK-1/RP-1/ST-1/TE-1/FF-1 to architectural mechanisms]
```

Note: This outline renumbers existing SS7 Risks to SS8 to accommodate the new SS7 Error Code Registry. The existing SS8-SS10 content (if any -- current HLD ends at SS7) is not affected. The Contract Compliance Matrix (SS9) is a new section that maps the 6 normative contracts to the architectural mechanisms described in SS2 and SS3.

---

## Phase 4b -- Round 1 (phase-auditor)

**Date**: 2026-05-01
**Auditor**: phase-auditor (Round 1 of 3)
**Artifact**: `docs/specs/auth-profiles.hld.md` (947 lines)
**Verdict**: **APPROVED**

### Findings

#### CRITICAL (must fix before next phase)

None.

#### HIGH (should fix)

- **[HD-2 / FS-2] Index count and unique index strategy are code-grounding errors**
  Location: `docs/specs/auth-profiles.hld.md:129`, `:716`, `:893`
  The HLD line 129 claims the model has "17 types, 11 indexes" but the actual code at `packages/database/src/models/auth-profile.model.ts:207-261` has 10 query indexes + 4 partial unique indexes = 14 total indexes. HLD line 716 claims "Two partial indexes for name uniqueness ... No personal-visibility partials" but the code already has 4 partial unique indexes including personal-visibility partials at lines 248-261 (with the comment "Shared and personal namespaces are isolated"). HLD OQ-5 (line 893) asks "Should personal profiles also have per-owner unique name constraints (4 partial indexes total)?" -- this is already implemented. This creates confusion downstream for the LLD which may plan work for something already done.
  Fix: Update line 129 to "17 types, 14 indexes (10 query + 4 partial unique)". Update line 716 to "Four partial unique indexes for name uniqueness (tenant-scoped shared, project-scoped shared, tenant-scoped personal, project-scoped personal)." Remove or reword OQ-5 (line 893) from "Should personal profiles also have per-owner unique name constraints?" to "Confirm the current 4 partial unique indexes are the final strategy; no additional indexes required."

- **[HD-4 / FS-2] Plugin line references are stale**
  Location: `docs/specs/auth-profiles.hld.md:361`
  HLD line 361 says "plugins applied at lines 166-170" for `packages/database/src/models/auth-profile.model.ts`. The actual code has plugins applied at lines 199-205 (the model grew since the original HLD was written on 2026-03-22).
  Fix: Update "lines 166-170" to "lines 199-205" in the Evidence field of SS3.1 Isolation.

#### MEDIUM (recommended)

- **[XP-4] `oauth2_client_creds` truncation in Protocol Dispatch table**
  Location: `docs/specs/auth-profiles.hld.md:315`
  The protocol dispatch table (SS2.4) uses `oauth2_client_creds` as the auth type name, but the canonical vocabulary everywhere else (feature spec, HLD SS2.5, error registry, alias map) is `oauth2_client_credentials`. This truncation could mislead an implementer reading only the dispatch table.
  Fix: Use the canonical name `oauth2_client_credentials` in the table cell, even if it widens the column.

- **[HD-9] `design-lint.sh` crash on the HLD**
  Location: `tools/design-lint.sh:21`
  Running `tools/design-lint.sh docs/specs/auth-profiles.hld.md` exits with code 1 after printing only "Required Sections" header. Root cause: the `pass()` function uses `((PASS_COUNT++))` which returns exit code 1 when PASS_COUNT=0 under `set -e`. This is a bug in the lint script, not in the HLD. Manual inspection confirms the HLD passes all 12 architectural concern checks and all required sections.
  Fix: Not an HLD fix -- file a bug against `tools/design-lint.sh` to change `((PASS_COUNT++))` to `PASS_COUNT=$((PASS_COUNT + 1))` (or use `set +e` around the arithmetic).

- **[XP-1] ST-1 callback step ordering differs between feature spec and HLD**
  Location: Feature spec line 674 vs HLD lines 270-283 and 772-776
  Feature spec ST-1 contract numbers the callback steps as: (1) verify tenantId, (2) verify csrfNonce, (3) atomic GETDEL. The HLD diagram (SS2.3) and schema (SS5) both place atomic GETDEL first, then tenantId check, then CSRF check. The HLD ordering is architecturally correct (you must retrieve the state payload before checking its tenantId), but the numbering inconsistency could confuse an implementer reading both docs.
  Fix: Add a one-line note in SS2.3 after line 270: "Note: GETDEL is performed first (it retrieves the state payload needed for subsequent checks). The ST-1 contract numbers steps by logical priority, not execution order."

- **[HD-4] Oracle log error code count discrepancy**
  Location: `docs/sdlc-logs/auth-profiles/hld-update-2026-05-01.log.md:44`
  Oracle decision B2 says "16 existing (from auth-profile-errors.ts) + 11 new = 27 total" but the actual `AuthProfileErrorCode` type in `packages/shared-auth-profile/src/errors.ts` has 17 error codes (not 16). The HLD correctly uses 17 in the registry (SS7 has 17 EXISTING rows + 11 NEW rows = 28 total). The oracle log is the stale one. The HLD registry is correct.
  Fix: No HLD fix needed -- the HLD is correct (17 + 11 = 28 codes in the registry table). Note: the SS7 header text says "existing 17 ... plus 11 new codes" which matches the actual `errors.ts`. The oracle log's "16" was written before the final count was verified.

- **[HD-3] MCP Auth Flow diagrams use ASCII but oracle proposed Mermaid**
  Location: `docs/specs/auth-profiles.hld.md:574-647` (SS3.14)
  Oracle decision A3 specified "a Mermaid sequence diagram" for the MCP Auth Flow section, but the HLD uses ASCII flow diagrams (consistent with all other diagrams in the HLD). This is actually fine -- consistency within the document is more important than oracle compliance. No action needed unless the team prefers Mermaid.
  Fix: No fix required. The ASCII diagrams are clear and consistent with the document's style.

#### LOW (informational)

- **[XP-5] No auth-profiles-specific learnings in package agents.md files**
  Location: `packages/shared/agents.md`, `packages/database/agents.md`, `apps/runtime/agents.md`, `apps/studio/agents.md`, `docs/sdlc-logs/agents.md`
  None of the package agents.md files or the cross-cutting agents.md contain auth-profiles-related learnings from the r2 spec or HLD phases. The SDLC pipeline requires updating agents.md after each phase.
  Fix: After the HLD update is finalized, the producing skill should append auth-profile learnings (e.g., the index count discrepancy, the ST-1 ordering design decision, the `apply-auth.ts` consolidation dependency chain) to the relevant package agents.md files.

### Cross-Phase Consistency

- [XP-1] All 17 FRs (FR-1 through FR-17) trace into the HLD -- verified, every FR has architectural coverage across SS1-SS7.
- [XP-1] All 6 normative contracts (TI-1, CK-1, RP-1, ST-1, TE-1, FF-1) have mechanism mappings in SS3.13 -- verified.
- [XP-1] All GAPs (GAP-7 through GAP-26) are addressed -- GAP-7..GAP-18 through FR coverage, GAP-19..GAP-24 through risks/mitigations, GAP-21/25/26 through known limitations.
- [XP-3] No scope creep -- HLD stays within feature spec SS2 goals and non-goals. Non-touch boundary (SS12.4) explicitly preserved.
- [XP-4] Terminology is consistent across feature spec, test spec, and HLD with one exception (oauth2_client_creds truncation noted above).
- [XP-2] Forward compatibility for LLD is strong: error code registry, alternative evaluations (OQ-12 oauth4webapi deferred to LLD), migration scripts, and GAP-22 rate limiter all explicitly marked as "LLD design items."
- [XP-1] ST-1 ordering: feature spec and HLD differ on step numbering (see MEDIUM finding above) but the HLD's execution ordering is architecturally sound.

### OQ-9 Satisfaction Check

Feature spec line 916 (OQ-9) mandates: "HLD must consolidate into an 'Error Code Registry' section with HTTP status, consumer surface (runtime/MCP/Studio Test/Studio UI), NEW vs EXISTING tag, and introducing FR."

HLD SS7 (lines 815-851) provides:

- Full table with 28 rows (17 existing + 11 new)
- Columns: Code, HTTP Status, Consumer Surface(s), Status (NEW/EXISTING), FR, Description
- TE-1 sanitization note

**Verdict: OQ-9 fully satisfied.**

### Error Code Registry Completeness Check

**Existing codes (17 from `packages/shared-auth-profile/src/errors.ts`)**: All 17 present in the registry.

**New codes (11 from feature spec OQ-9)**: All 11 present:

1. AUTH_PROFILE_PER_USER_IN_MCP -- present
2. AUTH_TYPE_NOT_MCP_COMPATIBLE -- present
3. MCP_TRANSPORT_NOT_TLS_CAPABLE -- present
4. AUTH_PROFILE_PER_USER_IN_WORKFLOW -- present
5. AUTH_PROTOCOL_DISABLED -- present
6. AUTH_REFRESH_FAILED -- present
7. OAUTH_REAUTH_REQUIRED -- present
8. OAUTH_FLOW_IN_PROGRESS -- present
9. JIT_AUTH_NOT_SUPPORTED -- present
10. AUTH_PROFILE_IN_USE_BY_MCP -- present
11. AUTH_KERBEROS_NOT_BUILT -- present

**Verdict: Error code registry is complete (28 codes = 17 existing + 11 new).**

### Diagram Correctness Check

**SS2.3 Unified OAuth diagram (lines 230-299)**: Correctly shows ST-1 ordering (atomic GETDEL, then tenantId check, then CSRF check, then redirect_uri check), audit emissions, scope annotations for project vs workspace. CSRF cookie set on initiate, verified on callback. RP-1 `__tenant__` used for workspace token storage. Init-lock 409 shown.

**SS2.2 Runtime Resolution flow (lines 167-224)**: Correctly shows CK-1 cache key composition, TI-1 findOne filter, grace period fallback, signRequest hook for FR-15, exponential backoff for GAP-24.

**SS3.14 MCP Auth Flow (lines 568-654)**: Correctly distinguishes HTTP (per-request header injection, hot-swap transparent) from SSE (stream close on refresh, reconnect). Key invariants for mtls, kerberos, and per-request signing exclusions documented.

### Code Evidence Accuracy

| Reference                                | Claimed Location              | Actual Location          | Status                                                                                                          |
| ---------------------------------------- | ----------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| tenantIsolationPlugin                    | auth-profile.model.ts:166-170 | lines 199-205            | STALE (HIGH finding)                                                                                            |
| ToolBindingExecutor                      | internal-tools.ts:170-178     | lines 170-177            | CORRECT                                                                                                         |
| tool-test-service.ts oauth2 block        | :719-723                      | lines 719-723            | CORRECT                                                                                                         |
| mcp-auth-resolver Map                    | :34-131                       | lines 34-136             | APPROXIMATE (file is 136 lines, not 131; close enough)                                                          |
| TraceEvent interface                     | trace-event.ts:17-39          | lines 17-39              | CORRECT                                                                                                         |
| WORKSPACE_PERMISSIONS                    | workspace-permission.ts:12-17 | lines 12-17              | CORRECT                                                                                                         |
| audit-events.ts INITIATED/COMPLETED      | :15-16                        | lines 15-16              | CORRECT                                                                                                         |
| \_v schema version                       | auth-profile.model.ts:113     | line 113                 | CORRECT                                                                                                         |
| mcp-server-config transport enum         | :57                           | line 57                  | CORRECT                                                                                                         |
| oauth2_app/token block in workspace POST | route.ts:215-220              | Not found at those lines | APPROXIMATE (file structure changed; the workspace route.ts exists but the specific lines need re-verification) |

### Contract Compliance (SS3.13)

| Contract | Feature Spec Definition                                                      | HLD Mechanism                                                                                    | Match?                   |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| TI-1     | findOne({\_id, tenantId}), never findById; 404 not 403                       | tenantIsolationPlugin + explicit tenantId in Studio queries + canonical $or filter + static lint | YES                      |
| CK-1     | auth-token:{tenantId}:{authType}:{profileId}:{profileVersion}:{scopeHash}... | Documented identically in SS3.3, SS3.13, SS5 CK-1 schema                                         | YES                      |
| RP-1     | ** prefix reserved; **tenant\_\_ approved; user-creation rejects             | reserved-principals.ts + auth-service.ts validator                                               | YES                      |
| ST-1     | State carries tenantId, csrfNonce, etc.; callback verifies all 3 checks      | Unified OAuth diagram shows all checks; GETDEL ordering differs (see MEDIUM)                     | YES (with ordering note) |
| TE-1     | Zero credential material in trace events; allowed-key set                    | Sanitizer + payload-shape regression test + allowed-key list                                     | YES                      |
| FF-1     | Flag=false returns AUTH_PROTOCOL_DISABLED 503; never silent success          | Per-protocol flag dispatch in handlers + kill-switch fidelity tests                              | YES                      |

### Non-Goals Check

HLD stays within feature spec SS2 non-goals:

- Integration auth profiles: explicitly non-touch (SS12.4 enforced)
- Per-user OAuth in workflows: rejected with AUTH_PROFILE_PER_USER_IN_WORKFLOW
- Per-user OAuth on MCP: rejected with AUTH_PROFILE_PER_USER_IN_MCP
- Workspace MCP registration: not addressed (separate feature)
- No new auth types introduced

### CLAUDE.md Alignment

- Studio Route Handler Gotchas: Acknowledged in SS3.1 (line 367) and SS2 Component Architecture (line 195 in feature spec referenced)
- Test Architecture (no platform mocking): Acknowledged in SS3.10 (line 512)
- E2E Test Standards: Acknowledged in SS3.10 (line 512, 516-522)
- Commit Discipline: Not explicitly referenced in HLD, but not required at the HLD level (operational concern for LLD/implementation)

### Verified

- [x] HD-1 (12 concerns) -- All 12 architectural concerns addressed in SS3.1-3.12, each with existing content + r2 additions
- [x] HD-2 (alternatives) -- 8 alternatives with clear tradeoffs (3 existing + 5 r2)
- [x] HD-3 (architecture diagrams) -- 5 ASCII diagrams present: system context (SS1), runtime resolution (SS2.2), unified OAuth (SS2.3), MCP HTTP (SS3.14), MCP SSE (SS3.14)
- [x] HD-4 (data model) -- Collections with fields, types specified; r2 additions (profileVersion, mcp_server_configs split, CK-1 cache schema, ST-1 state schema)
- [x] HD-5 (API design) -- Endpoints with method, path, purpose, auth; r2 additions table present
- [x] HD-6 (feature spec alignment) -- Problem statement and scope match; all FRs and GAPs traced
- [x] HD-7 (cross-cutting concerns) -- Audit logging (SS3.5), rate limiting (SS3.3 R10), caching (SS3.3), encryption (SS3.2) all addressed
- [x] HD-8 (rollback plan) -- Per-FR kill switches, dual-read rollback, migration --restore flag, re-export window
- [x] HD-10 (open questions) -- 8 open questions in SS9; genuine and load-bearing

### Notes for Next Round

If a round 2 is needed, focus on:

1. Verify the index count fix (HIGH finding)
2. Verify the plugin line reference fix (HIGH finding)
3. Confirm the oauth2_client_creds truncation is corrected or intentionally kept
4. Confirm the ST-1 ordering note is added

---

## Phase 4b -- Round 2 (phase-auditor)

**Date**: 2026-05-01
**Auditor**: phase-auditor (Round 2 of 3)
**Artifact**: `docs/specs/auth-profiles.hld.md` (953 lines)
**Verdict**: **APPROVED**

### Round 1 Fix Verification

| R1 ID         | Finding                                                                  | Claimed Fix                                                                                                       | Location Checked                                                                                                                                                                                                                                                                                                                                                                                                                         | Status       |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| HD-2 (HIGH)   | Index count "17 types, 11 indexes" was wrong                             | Line 129 updated to "14 indexes (10 query + 4 partial unique)"; line 722 updated to "Four partial unique indexes" | HLD line 129: `auth-profile.model.ts # Mongoose model (17 types, 14 indexes [10 query + 4 partial unique], profileVersion field)` -- CORRECT. HLD line 722: "Four partial unique indexes -- two for shared namespace (tenant-scoped and project-scoped), two for personal namespace (per-owner, tenant-scoped and project-scoped)" -- CORRECT. Code: `auth-profile.model.ts:207-261` has 10 query indexes + 4 partial unique = 14 total. | **VERIFIED** |
| HD-4 (HIGH)   | Plugin line reference stale (166-170 vs 199-205)                         | Line reference updated to 199-205 in SS3.1 Evidence and SS3.13 TI-1 row                                           | HLD line 367: "plugins applied at lines 199-205" -- CORRECT. HLD line 567 (SS3.13 TI-1): `auth-profile.model.ts:199-205` -- CORRECT. Code: lines 199-205 contain `tenantIsolationPlugin`, `encryptionPlugin`, `auditTrailPlugin`.                                                                                                                                                                                                        | **VERIFIED** |
| XP-4 (MEDIUM) | `oauth2_client_creds` truncation in dispatch table                       | Updated to `oauth2_client_credentials`                                                                            | HLD line 321: `oauth2_client_credentials` in protocol dispatch table -- CORRECT. Full canonical name used.                                                                                                                                                                                                                                                                                                                               | **VERIFIED** |
| XP-1 (MEDIUM) | ST-1 step ordering discrepancy between feature spec and HLD              | Explanatory note added in SS2.3                                                                                   | HLD lines 275-278: "Note: GETDEL must execute first to retrieve the payload needed for the tenant + CSRF + redirect_uri checks below. Feature-spec ST-1 numbers steps by logical priority (tenant-binding is the highest-impact check), not by execution order." -- CORRECT. Clear, actionable note.                                                                                                                                     | **VERIFIED** |
| OQ-5 (HIGH)   | Open Question implied personal indexes didn't exist when they already do | Reworded to acknowledge 4 existing partial indexes, flag feature-spec stale data                                  | HLD line 899 (OQ-5): "The model now has 4 partial unique indexes (2 shared + 2 personal per-owner) -- see `auth-profile.model.ts:230-261`. Confirm this is the final strategy and update the feature-spec data-model section (which still says '2 partial') in the next post-impl-sync pass." -- CORRECT. No longer asks whether to add personal indexes; correctly identifies feature spec staleness.                                   | **VERIFIED** |

**All 5 Round 1 findings VERIFIED as correctly applied.**

### Findings

#### CRITICAL (must fix before next phase)

None.

#### HIGH (should fix)

- **[HD-4 / FS-2] `profileVersion` field not yet in schema -- HLD discusses it as if it exists**
  Location: `docs/specs/auth-profiles.hld.md:129`, `:462`, `:728-730`; `packages/database/src/models/auth-profile.model.ts`
  The HLD's package structure annotation at line 129 says "profileVersion field" as part of the model description, and SS5 line 728-730 documents the `profileVersion` field in detail including its pre-save hook and backfill strategy. The actual code at `auth-profile.model.ts` does NOT contain a `profileVersion` field -- grep finds zero matches. This is correct behavior for an HLD documenting planned changes (profileVersion is an r2 addition), but the annotation at line 129 reads as a description of the current model state because it lists existing facts ("17 types, 14 indexes") alongside a planned field. This could mislead an LLD author into assuming the field already exists.
  Fix: Add `(planned r2)` suffix to the profileVersion mention at line 129, e.g.: `auth-profile.model.ts # Mongoose model (17 types, 14 indexes [10 query + 4 partial unique], profileVersion field [planned r2])`. The SS5 section (lines 728-730) already clearly marks it as "NEW" which is fine.

- **[HD-4 / FS-2] `envProfileId` field not yet in `mcp_server_configs` model -- HLD line 130 presents it as current**
  Location: `docs/specs/auth-profiles.hld.md:130`; `packages/database/src/models/mcp-server-config.model.ts`
  HLD line 130 says `mcp-server-config.model.ts # FR-11 split: authProfileId + envProfileId`. The actual model has `authProfileId` but no `envProfileId` field (grep confirms zero matches). The SS5 section (lines 732-747) correctly documents this as a post-FR-11 split with a migration script. Like the profileVersion finding above, the package structure annotation should be clearer about what is current vs planned.
  Fix: Change line 130 to `mcp-server-config.model.ts # FR-11 split: authProfileId + envProfileId (envProfileId planned r2)` or `mcp-server-config.model.ts # FR-11: adds envProfileId field (planned)`.

#### MEDIUM (recommended)

- **[HD-7] Error registry `MCP_TRANSPORT_NOT_TLS_CAPABLE` description references "stdio" but stdio is not in the transport enum**
  Location: `docs/specs/auth-profiles.hld.md:847`
  The error registry row for `MCP_TRANSPORT_NOT_TLS_CAPABLE` says "e.g., stdio" as an example of a non-HTTP transport. However, the actual `mcp_server_configs.transport` enum (`packages/database/src/models/mcp-server-config.model.ts:57`) is `['http', 'sse']` -- there is no `'stdio'` value. The "(e.g., stdio)" parenthetical is misleading and could confuse an LLD implementer who grep-searches for stdio support.
  Fix: Change the description at line 847 from "non-HTTP MCP transport (e.g., stdio)" to "non-HTTP MCP transport (i.e., SSE -- `transport: 'sse'`)". Alternatively, if stdio support is planned for the MCP model, add a note.

- **[XP-1] Feature spec ST-1 payload field list still missing `redirectUri` (GAP-20)**
  Location: Feature spec line 674 (ST-1 contract); HLD line 776 (ST-1 state schema)
  The HLD's ST-1 state schema at line 776 correctly includes `redirectUri` (per GAP-20 mitigation). The feature spec's ST-1 contract at line 674 still lists `{ tenantId, projectId | null, userId, authProfileId, scope, csrfNonce, codeVerifier? }` without `redirectUri`. This is a feature-spec staleness issue, not an HLD error -- the HLD is more complete. However, the HLD should note this cross-phase discrepancy for the next post-impl-sync.
  Fix: Add a one-line note in SS5 ST-1 schema (after line 776) or in SS9 Open Questions: "Note: Feature spec ST-1 contract (line 674) does not yet include `redirectUri`; will be updated in next post-impl-sync pass." Alternatively, this can be carried as a known issue for post-impl-sync.

- **[HD-4] Feature spec SS7 line 185 still claims "2 partial indexes" -- HLD should reference this staleness explicitly for LLD awareness**
  Location: Feature spec line 185; HLD OQ-5 line 899
  HLD OQ-5 correctly identifies that the feature spec says "2 partial" while the code has 4. However, the feature spec's SS9 Data Model (lines 388-390) also says "Unique Indexes (2 partial)" with only 2 entries listed. This staleness exists in multiple places in the feature spec (lines 185, 388-390, 907). The HLD's OQ-5 references `auth-profile.model.ts:230-261` which is correct, but an LLD author reading the feature spec before the HLD could be misled.
  Fix: No HLD change strictly required -- OQ-5 already covers this. Recommend the next post-impl-sync explicitly addresses lines 185, 388-390, and 907 of the feature spec. OQ-5 could add these line numbers for clarity.

- **[HD-5] MCP invariant 1 says `transport: 'sse'` with `mtls` is rejected, but error code says "e.g., stdio"**
  Location: HLD line 657 vs line 847
  HLD line 657 states: "`transport: 'sse'` with `mtls` is rejected at write time with `MCP_TRANSPORT_NOT_TLS_CAPABLE`." The error registry (line 847) describes the same code as applicable to "non-HTTP MCP transport (e.g., stdio)". These descriptions are inconsistent -- one says SSE, the other says stdio. The correct rejection is `transport: 'sse'` (since `transport: 'http'` is the only TLS-capable transport in the enum).
  Fix: Align both locations. Line 657 is correct (reject SSE); line 847 should match: "`mtls` profile attached to SSE MCP transport (SSE streams cannot initiate client-certificate TLS handshake per-request)".

#### LOW (informational)

- **[HD-4] mcp-auth-resolver.ts line count: HLD says "34-131", actual file is 136 lines (Round 1 flagged as APPROXIMATE, still not updated)**
  Location: HLD SS2.5 (`packages/shared/src/services/mcp-auth-resolver.ts:34-131`)
  The actual file is 136 lines. The reference covers lines 34-131 which is the main body of the resolver. The actual content extends to line 136 (the `clearOAuth2TokenCache` export helper at lines 133-136). Since the HLD is describing the resolver Map and dispatch logic (not the test helper), the reference is architecturally accurate even if the end-line is approximate.
  Fix: Optionally change `:34-131` to `:34-136` for precision, or keep as-is since it is architecturally non-misleading.

### Data Model Deep Dive (Audit Focus Area 2)

| Claim                                                                                        | Location                     | Verified Against                                                                                                                                                    | Status                                                                          |
| -------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| `profileVersion` is a planned new monotonic-integer field, bumped via pre-save hook          | SS5 lines 728-730            | `auth-profile.model.ts` -- field does NOT exist yet (r2 planned)                                                                                                    | CORRECT (planned, not current)                                                  |
| `profileVersion` distinct from `_v` schema version at line 113                               | SS5 line 730                 | `auth-profile.model.ts:113` -- `_v: { type: Number, default: 1 }` confirmed                                                                                         | CORRECT                                                                         |
| `mcp_server_configs.transport` enum is `'http'                                               | 'sse'`                       | SS3.14 line 576                                                                                                                                                     | `mcp-server-config.model.ts:57` -- `enum: ['http', 'sse']` confirmed            | CORRECT |
| CK-1 cache key pattern `auth-token:{tenantId}:{authType}:...`                                | SS5 lines 752-761            | `credential-cache.ts` -- generic LRU with no CK-1 format (r2 changes the key format); `client-credentials-service.ts:12` uses `auth-profile:cc-token:` prefix today | CORRECT (CK-1 is r2 addition; current key format documented as pre-r2 baseline) |
| ST-1 state payload includes `redirectUri`                                                    | SS5 line 776                 | Feature spec GAP-20 (line 953) mandates adding `redirectUri`                                                                                                        | CORRECT (HLD more complete than feature spec ST-1 contract which omits it)      |
| ST-1 state Redis key `auth-profile:oauth-state:{tenantId}:{state}` TTL 600s                  | SS5 line 767                 | Consistent with feature spec FR-13 init-lock 600s TTL                                                                                                               | CORRECT                                                                         |
| Init lock key `auth-profile:oauth-init-lock:{tenantId}:{authProfileId}` TTL 600s = state TTL | SS5 lines 788-792            | Feature spec FR-13                                                                                                                                                  | CORRECT (TTL coherence: both 600s)                                              |
| Backfill migration sets `profileVersion=1` on existing rows                                  | SS5 line 730, SS3.8 line 497 | Feature spec line 192                                                                                                                                               | CORRECT                                                                         |
| 4 partial unique indexes: 2 shared + 2 personal                                              | SS5 line 722                 | `auth-profile.model.ts:231-261` -- 4 indexes confirmed                                                                                                              | CORRECT                                                                         |

### API Design Deep Dive (Audit Focus Area 3)

| Claim                                                                    | Location     | Verified Against                                                                                                                                                             | Status                                                                  |
| ------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Workspace OAuth routes at `/api/auth-profiles/oauth/{initiate,callback}` | SS6 line 811 | File system: `apps/studio/src/app/api/auth-profiles/` has no `oauth/` subdirectory (planned for FR-13)                                                                       | CORRECT (planned, not current)                                          |
| `oauth2_token` blocked at workspace POST `route.ts:215-220`              | SS6 line 812 | `apps/studio/src/app/api/auth-profiles/route.ts:215-221` -- blocks `oauth2_token` with errorJson                                                                             | CORRECT (1-line offset, non-material)                                   |
| `/api/projects/:id/tools/workflow-compatible` is a Studio route          | SS6 line 813 | File system: `apps/studio/src/app/api/projects/[id]/tools/workflow-compatible/` does not exist (planned for FR-14)                                                           | CORRECT (planned, HLD line 142 correctly shows it under `apps/studio/`) |
| FR-9 wiring at `internal-tools.ts:170-178`                               | SS6 line 814 | `apps/runtime/src/routes/internal-tools.ts:170-177` -- `ToolBindingExecutor` constructor at line 170, `.execute()` at line 177                                               | CORRECT (1-line offset, non-material)                                   |
| FR-12 site at `tool-test-service.ts:719-723`                             | SS6 line 816 | `apps/studio/src/services/tool-test-service.ts:719-723` -- `oauth2_app`/`oauth2_token` hard-throw block confirmed                                                            | CORRECT                                                                 |
| Audit emissions attributed to FR-13 Phase F                              | SS6 line 817 | Feature spec FR-13 (line 125) specifies Phase F for audit constants; `audit-events.ts` currently has `OAUTH_INITIATED`/`COMPLETED` but not `OAUTH_FAILED` (Phase F addition) | CORRECT                                                                 |

### Error Code Registry Verification (Audit Focus Area 4)

| Code                                | HLD HTTP Status | Feature Spec Description                                         | Status                                                                                      |
| ----------------------------------- | --------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `AUTH_PROTOCOL_DISABLED`            | 503             | FR-15 / FF-1: "HTTP 503 from MCP/Studio Test"                    | MATCHES                                                                                     |
| `OAUTH_REAUTH_REQUIRED`             | 401             | FR-12: "structured OAUTH_REAUTH_REQUIRED 4xx error"              | CONSISTENT (401 is a 4xx)                                                                   |
| `OAUTH_FLOW_IN_PROGRESS`            | 409             | FR-13: "HTTP 409"                                                | MATCHES                                                                                     |
| `JIT_AUTH_NOT_SUPPORTED`            | 400             | FR-9: "structured error"                                         | CONSISTENT                                                                                  |
| `AUTH_PROFILE_IN_USE_BY_MCP`        | 409             | FR-11: "HTTP 409"                                                | MATCHES                                                                                     |
| `AUTH_KERBEROS_NOT_BUILT`           | 400             | FR-15: "reject at write time"                                    | CONSISTENT                                                                                  |
| `AUTH_PROFILE_PER_USER_IN_MCP`      | 400             | FR-11: rejected at write-time and runtime                        | CONSISTENT                                                                                  |
| `AUTH_TYPE_NOT_MCP_COMPATIBLE`      | 400             | FR-11: "rejected at MCP write time"                              | CONSISTENT                                                                                  |
| `MCP_TRANSPORT_NOT_TLS_CAPABLE`     | 400             | FR-11: "restricted to HTTP-based MCP transports"                 | CONSISTENT (but description says "stdio" which doesn't exist in enum -- see MEDIUM finding) |
| `AUTH_PROFILE_PER_USER_IN_WORKFLOW` | 400             | FR-9: "rejected at Studio create-time and at runtime resolution" | CONSISTENT                                                                                  |
| `AUTH_REFRESH_FAILED`               | 503             | FR-11: "transport closes with AUTH_REFRESH_FAILED"               | CONSISTENT                                                                                  |

All 11 new error codes trace to their introducing FR in the feature spec. No fabricated codes detected. HTTP status codes are consistent with feature spec descriptions.

All 17 existing error codes verified against `packages/shared-auth-profile/src/errors.ts` `AuthProfileErrorCode` union type (17 members). Registry total: 28 codes (17 + 11) = CORRECT.

### Diagram Correctness (Audit Focus Area 5)

**SS2.3 Unified OAuth diagram (lines 230-306)**:

- RBAC gate at workspace (line 238: `auth-profile:write` permission) -- CORRECT
- JIT/preflight rejection (line 249: `usageMode in {'jit','preflight'}` -> 400) -- CORRECT
- Init lock 409 (line 243: `OAUTH_FLOW_IN_PROGRESS`) -- CORRECT
- CSRF cookie set on initiate (line 253-254) -- CORRECT
- ST-1 ordering note (lines 275-278) -- CORRECT (Round 1 fix verified)
- Refresh failure path not shown in OAuth diagram -- ACCEPTABLE (refresh is covered in SS2.2 Runtime Resolution and SS3.14 MCP Auth Flow)
- RP-1 `__tenant__` for workspace (line 298) -- CORRECT

**SS3.14 MCP HTTP flow (lines 578-613)**:

- CK-1 key used for cache (line 584) -- CORRECT
- 30s pre-expiry refresh under distributed lock (line 591-592) -- CORRECT
- Lock failure -> use still-valid token (line 594) -- CORRECT
- Refresh failure -> close transport, next call reconnects (lines 602-603) -- CORRECT
- Header hot-swap transparent for HTTP (line 612) -- CORRECT

**SS3.14 MCP SSE flow (lines 615-653)**:

- Header sealed for stream duration (line 627) -- CORRECT
- Cannot mutate header mid-stream per MCP Auth Spec (line 641) -- CORRECT
- Refresh success -> close SSE stream -> next tool call reconnects (lines 639-644) -- CORRECT
- Refresh failure -> close SSE stream -> next tool call reconnects (lines 646-652) -- CORRECT

All diagrams are architecturally sound and capture the correct branching logic.

### Cross-Phase Consistency

- [XP-1] VERIFIED -- All 17 FRs (FR-1..FR-17) have architectural coverage in the HLD. All 6 normative contracts (TI-1, CK-1, RP-1, ST-1, TE-1, FF-1) have mechanism mappings in SS3.13.
- [XP-2] VERIFIED -- Forward compatibility for LLD is strong: profileVersion, envProfileId, error registry, alternative evaluations, migration scripts, and rate limiter all explicitly marked as "LLD design items" or "planned."
- [XP-3] VERIFIED -- No scope creep. HLD stays within feature spec SS2 goals and non-goals.
- [XP-4] VERIFIED -- Terminology consistent across all docs after Round 1 fixes (oauth2_client_credentials canonical name used everywhere).
- [XP-5] MEDIUM carry-forward -- Package agents.md files still lack auth-profile r2 learnings (same as Round 1 LOW finding, unchanged; out-of-scope for HLD audit -- will be addressed by producing skill after HLD finalization).
- [XP-1] NOTE -- Feature spec ST-1 contract (line 674) does not include `redirectUri` but HLD correctly includes it. This is a feature-spec staleness issue to be resolved in post-impl-sync.

### Verified (HLD Checklist)

- [x] HD-1 (12 concerns) -- All 12 architectural concerns addressed in SS3.1-3.12, each with existing content + r2 additions; plus SS3.13 (contract compliance) and SS3.14 (MCP auth flow)
- [x] HD-2 (alternatives) -- 8 alternatives (3 existing + 5 r2) with clear tradeoffs in SS4
- [x] HD-3 (architecture diagrams) -- 5 ASCII diagrams: system context (SS1), runtime resolution (SS2.2), unified OAuth (SS2.3), MCP HTTP (SS3.14), MCP SSE (SS3.14)
- [x] HD-4 (data model) -- SS5 covers profileVersion, mcp_server_configs split, CK-1 cache schema, ST-1 state schema, init lock schema. All verified against code and feature spec.
- [x] HD-5 (API design) -- SS6 covers all r2 route additions with method, path, purpose, auth. 7 rows in r2 additions table.
- [x] HD-6 (feature spec alignment) -- Problem statement and scope match feature spec. All FRs and GAPs traced.
- [x] HD-7 (cross-cutting concerns) -- Audit logging (SS3.5), rate limiting (SS3.3 R10), caching (SS3.3), encryption (SS3.2) all addressed.
- [x] HD-8 (rollback plan) -- Per-FR kill switches (SS3.7), dual-read rollback (SS3.8), migration --restore flag (SS3.8), re-export window (SS3.9).
- [x] HD-9 (design-lint) -- Round 1 flagged script bug in `tools/design-lint.sh`; not an HLD issue. Manual check: all 12 concerns present.
- [x] HD-10 (open questions) -- 8 open questions in SS9; genuine and load-bearing. All appropriate for LLD-phase resolution.

### Summary

Round 2 confirms all Round 1 fixes were correctly applied. The data model deep dive, API design deep dive, error code registry verification, and diagram correctness checks all pass. Two new HIGH findings relate to annotation clarity (planned vs current fields in the package structure overview) -- these are not architecturally wrong but could mislead an LLD author. Four MEDIUM findings address minor cross-phase inconsistencies and error-code description precision. One LOW finding is informational.

The HLD is architecturally sound, code-grounded, and ready for LLD consumption with the noted annotation improvements.

### Notes for Next Round (if needed)

Round 3 (if requested) should verify:

1. The two HIGH findings (profileVersion and envProfileId annotation clarity) are addressed
2. MCP_TRANSPORT_NOT_TLS_CAPABLE description consistency (MEDIUM findings) resolved
3. No further focus areas needed -- the HLD is otherwise complete and verified
