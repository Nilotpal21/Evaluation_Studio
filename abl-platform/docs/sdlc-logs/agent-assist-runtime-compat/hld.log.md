# HLD Audit Log: Agent Assist V1 Compatibility Facade

## Phase-Auditor Round 1

**Date**: 2026-04-22
**Artifact**: `docs/specs/agent-assist-runtime-compat.hld.md`
**Verdict**: APPROVED

### Findings

No CRITICAL or HIGH findings. The HLD is exceptionally thorough.

#### MEDIUM

- [HD-9] Line number references inherited from feature spec are stale. `createSessionFromResolved` cited as `:1142` (actual `:1175`), `executeMessage` as `:2460` (actual `:2493`), `endSession` as `:3968` (actual `:4170`), PII refs `:108,2187` (actual `:117,813`). These appear in HLD section 10 References and data flow descriptions.
  - **Fix**: Update line numbers in section 10 References to current values, or remove line-number pinning and reference by method name only (more maintainable).

- [HD-5] `placeholder` binding status referenced in component table (line 157: `binding.status === "placeholder"`) but data model (section 5.1, line 319) only defines `"active" | "disabled"`. Open question 5 (line 641) discusses keeping placeholder mode but does not reconcile the type mismatch.
  - **Fix**: Either add `"placeholder"` to the schema enum in section 5.1, or clarify that placeholder mode is runtime-only (env-seeded, not persisted) and update the component description accordingly.

### Cross-Phase Consistency

- [XP-1] All 31 FRs trace to design decisions: FR-1..FR-3 in API Contract (#3) + section 6; FR-4..FR-9 in API Design (section 6); FR-10..FR-13 in Security Surface (#4) + Tenant Isolation (#1); FR-14..FR-16 in Data Access (#2) + Data Model (section 5); FR-17..FR-21 in section 3.3-3.5 data flows; FR-22..FR-23 in Error Model (#5); FR-24..FR-26 in section 3.5 + Failure Modes (#6); FR-27..FR-30 in Observability (#8) + section 7; FR-31 in section 6.2 Admin endpoints.
- [XP-2] Forward compatibility: HLD provides sufficient detail for LLD generation -- component breakdown, data flows, API contracts, module responsibilities, and migration path are all specified.
- [XP-3] No new scope introduced beyond feature spec. Deliberately deferred items (canonical service, new permission, Studio UI) are consistent.
- [XP-4] Terminology consistent across all three docs: `AgentAssistBinding`, `agent_assist_bindings`, `agent_assist.*` trace family, `APP_NOT_FOUND`, `session:send_message`, `logAdminAction`.
- [XP-5] Prior audit round findings (R1: admin is Next.js not Express; R2: `auditLogStore.write` invented) are correctly reflected -- HLD uses `logAdminAction` throughout and admin routes are Next.js App Router pattern.

### Verified

- [x] HD-1 -- All 12 architectural concerns addressed with implementation-ready detail
- [x] HD-2 -- Three alternatives (canonical service, in-process facade, HTTP loopback) with concrete pros/cons/effort; no strawmen -- Alternative A has genuine merit but is deferred for valid reasons, Alternative C has real implementation simplicity but prohibitive operational cost
- [x] HD-3 -- System context ASCII diagram (section 3.1) and sequence diagram (section 3.6) present and accurate
- [x] HD-4 -- Data model (section 5) matches feature spec section 9 field-for-field including indexes and plugins
- [x] HD-5 -- API design (section 6) byte-compatible with V1 contract and matches test spec section 5 scenarios
- [x] HD-6 -- Problem statement (section 1) consistent with feature spec section 1
- [x] HD-7 -- Cross-cutting concerns (section 7) address audit logging, rate limiting, caching, encryption, PII, data retention, i18n
- [x] HD-8 -- Rollback plan (concern #11) specifies three levels: per-tenant flag, global kill-switch, code revert; addresses in-flight BullMQ jobs and orphaned data
- [x] HD-10 -- Five open questions (section 9) including HMAC rotation, admin RBAC, session GET endpoint, DLQ UI, placeholder mode
- [x] No forbidden patterns: no new permission scope, no HTTP loopback, no Layer A canonical service
- [x] No HLD statements contradict the test spec (session idempotency in concern #7 matches E2E-5; 404 byte-identical bodies in concern #1/section 6 matches E2E-6; reserved-key stripping in concern #4/section 3.3 matches test spec section 3.4 FR-21)
- [x] Dependencies section (section 8) honest about risk -- `DeploymentResolver` and `RuntimeExecutor` marked medium risk due to active evolution
- [x] Self-contained for LLD generation

### Notes for Next Round

- Focus on line number accuracy if updated, and placeholder status type reconciliation.

## Phase-Auditor Round 2

**Date**: 2026-04-22
**Artifact**: `docs/specs/agent-assist-runtime-compat.hld.md`
**Verdict**: APPROVED

### Round 1 Fix Verification

- [HD-9] FIXED. Section 10 References now references by method name only with an explicit note explaining the rationale. No stale line numbers remain.
- [HD-5] FIXED. Section 5.1 documents `status: "active" | "disabled"` for persisted bindings with a clear inline NOTE: placeholder is env-seeded POC/canary only (behind `AGENT_ASSIST_SEED_MODE=env`), never persisted. Open question 5 tracks long-term disposition. Component table reference to `binding.status === "placeholder"` is consistent since that code path exists in the env-seeded resolver.

### Findings

No CRITICAL, HIGH, or MEDIUM findings.

### Deep-Dive: Data Model (section 5)

- Every field has a documented purpose. `apiKeyId: string | null` verified against POC code: used in `execution-bridge.ts:151` for `_agentAssist.apiKeyId` traceability stamping and in `session-envelope.ts:36` as part of the `externalReference` composite key for deterministic sessionId derivation. Meaningful for Observatory/billing filtering and session isolation (two different API keys produce different sessions for the same sessionReference).
- Indexes necessary and sufficient: unique `(tenantId, appId, environment)` covers primary lookup; `(tenantId, projectId)` covers Admin list + cascade; `(tenantId, status)` covers operational queries.
- No missing indexes for documented query patterns.

### Deep-Dive: API Design (section 6)

- Three transport modes (sync/SSE/async-push) cover all modes Kore.ai Agent Assist uses. Edge case `stream.enable:true + isAsync:true` handled (streaming wins).
- Sync response shape matches feature spec FR-4 exactly.
- HMAC signature format `t=<unix-ts>,v1=<hex>` matches Stripe webhook signature convention. Timestamp validity window (300 seconds / 5 minutes) explicitly called out in section 6.1.2.
- Error shapes consistent: pre-execution -> standard HTTP codes with `{error:{code,message}}`; execution-time -> HTTP 200 with `sessionInfo.status:"error"`.

### Deep-Dive: Open Questions (section 9)

All five genuinely open and non-blocking for Phase Actual: HMAC secret rotation (real operational concern, decision deferred), Admin RBAC sub-tenant scope (correctly deferred), GET session endpoint (not called by widget), DLQ UI/replay (infrastructure ships now, UI later), placeholder mode disposition (canary value documented).

### Cross-Tenant 404 Consistency (concern #1 -> data model -> API errors)

Three layers agree: concern #1 specifies "cross-tenant -> 404 APP_NOT_FOUND (never 403)"; `tenantIsolationPlugin` + unique index ensure cross-tenant queries return no results; API error table collapses all existence-disclosure cases (missing/disabled/tenant mismatch/project-scope mismatch/feature-gate off/kill-switch off) to the same 404 `APP_NOT_FOUND` code and shape. Test spec section 5.3 explicitly requires byte-identical 404 bodies.

### Cross-Phase Consistency

- [XP-1] All FRs trace back to feature spec section 4.
- [XP-2] HLD provides sufficient detail for LLD: module breakdown, data flows, API contracts, migration path.
- [XP-3] No new scope.
- [XP-4] Terminology consistent across all docs.
- [XP-5] Prior audit findings reflected.

### Verified

- [x] Round 1 HD-9 fix -- method-name-only references, no stale line numbers
- [x] Round 1 HD-5 fix -- placeholder status reconciled with env-seeded-only note
- [x] Data model fields all purposeful; `apiKeyId` usage verified in POC code
- [x] Indexes necessary and sufficient
- [x] Three transport modes fully documented with request/response shapes
- [x] HMAC signature format matches Stripe-style; 5-minute validity window stated
- [x] Open questions genuinely open and non-blocking
- [x] Cross-tenant 404 byte-identical agreement across all three layers
- [x] No contradictions between HLD, feature spec, and test spec

### Notes for Round 3

- Final lightweight pass: verify no regressions from intervening edits; confirm self-contained for LLD generation. No findings require correction.

## Phase-Auditor Round 3

**Date**: 2026-04-22
**Artifact**: `docs/specs/agent-assist-runtime-compat.hld.md`
**Verdict**: APPROVED

### Regression Check

- [HD-9] R1 fix HOLDS. Section 10 References uses method-name-only references with explicit rationale note (line 665). No stale line numbers in References or data flow sections.
- [HD-5] R1 fix HOLDS. Placeholder status reconciliation consistent: data model (line 320-325) documents env-seeded-only, component table correctly references it for that code path, open question 5 tracks disposition.

### Findings

No CRITICAL or HIGH findings.

#### MEDIUM (carry forward to LLD as context)

- [HD-9] One residual line-number reference at section 7 PII bullet (line 602): `runtime-executor.ts:108,2187`. The References section disclaims line numbers, but this cross-cutting concern still pins them. Non-blocking -- informational context only. LLD author should reference by method name (`scrubPII`, `PIIVault`) when pinning call sites.

### Cross-Phase Consistency

- [XP-1] All 31 FRs still trace to design decisions. No orphaned or unaddressed FR after edits.
- [XP-2] HLD self-contained for LLD: module breakdown, data flows, API contracts with request/response shapes, migration path (concern #10), dependency table, and open questions all present.
- [XP-3] No new scope introduced.
- [XP-4] Terminology consistent: `logAdminAction`, `APP_NOT_FOUND`, `createUnifiedAuthMiddleware`, `agent_assist_bindings` used identically across HLD, feature spec, and test spec.
- [XP-5] Prior audit findings (R1/R2 feature-spec: admin is Next.js, `auditLogStore.write` was invented) correctly reflected in HLD throughout.

### Verified

- [x] R1 line-number fix -- no regression in References or data flows
- [x] R1 placeholder status fix -- no regression; three references internally consistent
- [x] No section contradicts another after R1 edits
- [x] HLD self-contained for LLD generation without re-reading feature spec
- [x] All 12 concerns addressed; no gaps introduced
- [x] Three alternatives with real tradeoffs preserved
- [x] Open questions still genuinely open and non-blocking

### Notes for LLD

- Section 7 PII bullet still pins `runtime-executor.ts:108,2187` -- LLD should reference by method name when pinning call sites against current HEAD.
- HMAC secret rotation (open question 1) should be resolved during LLD or deferred with explicit Phase Actual scope boundary.
