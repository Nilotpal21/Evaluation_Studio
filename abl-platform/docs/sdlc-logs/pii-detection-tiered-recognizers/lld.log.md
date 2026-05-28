# Oracle Answers: PII Detection Tiered Recognizers LLD

**Date**: 2026-05-09
**Phase**: LLD (Phase 4)
**JIRA**: ABLP-921

---

## Context Consulted

- `docs/features/sub-features/pii-detection-tiered-recognizers.md` (feature spec, full)
- `docs/specs/sub-features/pii-detection-tiered-recognizers.hld.md` (HLD, full)
- `docs/testing/sub-features/pii-detection-tiered-recognizers.md` (test spec, full)
- `docs/features/pii-detection.md` (parent feature, first 100 lines)
- `docs/audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md` (gap analysis, first 150 lines)
- `docs/features/sub-features/pii-detection-enhancements.md` (sibling spec, header/status only)
- `packages/compiler/src/platform/security/pii-recognizer-registry.ts` (full, 273 lines)
- `apps/runtime/src/services/pii/session-pii-context.ts` (full, 160 lines)
- `apps/runtime/src/routes/project-runtime-config.ts` (lines 340-400, 480-510)
- `apps/runtime/src/routes/pii-patterns.ts` (lines 180-200)
- `apps/runtime/vitest.e2e.config.ts` (full, 147 lines — explicit `defaultInclude` list)
- `packages/agent-transfer/src/session/transfer-session-store.ts` (lines 35-65 — `withTimeout` implementation)
- `packages/arch-ai/src/session/file-store-service.ts` (lines 230-260 — `withTimeout` implementation)
- `CLAUDE.md` (root, runtime)
- `docs/sdlc/pipeline.md` (first 60 lines — phase rules, commit constraints)
- grep for `withTimeout` across all packages (found in 4 files: `agent-transfer`, `arch-ai`, `pipeline-engine`, plus `shared/repos`)
- grep for `recognizer-packs/` directory (does not exist yet)
- Sibling spec status check: PLANNED, no HLD, no LLD, no implementation

---

## Answers

### Implementation Strategy

---

#### Q1: Phase ordering — Foundation refactors first, then core pack, then regional? Or Foundation + core together?

**Classification**: DECIDED
**Answer**: **Option B — Foundation + `core` pack together as Phase 1.** The `core` pack IS the Foundation's DRY fix. HLD section 3.1 makes this explicit: "refactor `registerBuiltInRecognizers()` to delegate to `core.register(registry)` -- i.e., the `core` pack becomes the single source of truth for the legacy 5 entity types, and `registerBuiltInRecognizers()` becomes a thin compatibility shim." You cannot complete FR-3 (remove `detectWithLocalPatterns()`) or FR-4 (registry bypass fixes) without the `core` pack existing as the target. Splitting them would leave Foundation in a half-finished state with no valid registry content.
**Source**: HLD section 3.1, paragraph "Decision (binding for the LLD)"; feature spec section 13 delivery plan item 1.4 (aligns credit-card pattern with `core` pack form).
**Confidence**: HIGH

---

#### Q2: Phase granularity for packs — separate phase per pack, or grouped?

**Classification**: DECIDED
**Answer**: **Group into 3 implementation phases after Phase 1 (Foundation + core):**

- **Phase 2**: `us` + `eu` (highest customer demand per feature spec section 1 -- EU/APAC market gaps). Estimated ~15-20 new files (pack source + test fixtures + test files). Well under the 40-file commit limit.
- **Phase 3**: `apac` + `financial` + `medical` (regulated-industry packs). Estimated ~15-18 new files. The Verhoeff/DEA validators in `_validators.ts` land here because `apac` (Aadhaar) and `medical` (DEA) consume them.
- **Phase 4**: `network` + `international-phone` + `context-enhancer.ts` (lower priority; `international-phone` depends on `libphonenumber-js` integration via `phone-extraction.ts`). Plus the microbenchmark suite (`recognizer-packs.bench.ts`).

This grouping keeps each commit under 40 files and 3 packages (CLAUDE.md commit constraint enforced by `commit-scope-guard.sh`), groups packs by natural dependency affinity (`_validators.ts` validators land alongside their first consumer), and aligns with the feature spec's delivery plan ordering (WS-2.2 → WS-2.3 → WS-2.4 → WS-2.5).
**Source**: CLAUDE.md commit discipline (max 40 non-doc files, max 3 packages); feature spec section 13 delivery plan.
**Confidence**: HIGH

---

#### Q3: Feature flag rollout — tenant-level allowlist env var for packs beyond core?

**Classification**: ANSWERED
**Answer**: **No tenant-level allowlist env var.** The HLD explicitly settled this. HLD section 9 item 2 states: "Tenant-level cap on packs (feature spec OQ-2 / GAP-004). Out of scope for this spec; flagged for a future governance sub-feature. Decision deferred." HLD section 11 (Rollback Plan) provides three rollback levers without a tenant-level env var: (a) per-project `enabled_recognizer_packs = ['core']`, (b) per-project `tier = 'basic'`, (c) per-pod `PII_BYPASS_FIX_DISABLED=true`. Per-project opt-in via PATCH is sufficient for rollout granularity per HLD section 10.2.
**Source**: HLD section 9 item 2; HLD section 11 (Rollback Plan); feature spec GAP-004 status "Accepted".
**Confidence**: HIGH

---

#### Q4: Test-first vs test-after for validators and pack regexes?

**Classification**: DECIDED
**Answer**: **Test-first for validators (UT-3, UT-4); test-alongside for pack regexes (UT-2).** Rationale:

- The 8 hand-ported validators (IBAN mod-97, Verhoeff, DEA, BTC base58, plus the existing `luhnCheck` reuse) are pure functions with well-defined truth tables (valid/invalid inputs from Presidio's test corpus). Writing `_validators.test.ts` first provides an implementation harness and catches off-by-one errors in the checksum ports immediately.
- Pack regex patterns (UT-2 core parity, UT-3 per-pack fixtures) should land alongside the pack source because the regex patterns and their fixtures are co-dependent -- writing the test before the regex exists provides no useful harness.
- This matches the "prefer pure-function tests for logic" rule in CLAUDE.md Test Architecture.

**Source**: CLAUDE.md Test Architecture ("Prefer pure-function tests for logic -- budget enforcement, error classification, cache eviction. Pure functions need zero mocks."); test spec UT-3, UT-4.
**Confidence**: HIGH

---

#### Q5: Acceptable scope for first commit?

**Classification**: DECIDED
**Answer**: **Phase 1 should be split into two commits, not one monolithic commit and not three micro-commits:**

- **Commit 1a** (`refactor(compiler)`): Foundation interface changes + bypass fixes.
  - Add `confidence: number` and `recognizer?: string` to `PIIDetection` (FR-1).
  - Add `detectAllAsync()` to `PIIRecognizerRegistry` (FR-2) with the cleaned-up `withTimeout` helper.
  - Fix the 3 bypass call sites (FR-3, FR-4) with `PII_BYPASS_FIX_DISABLED` guard.
  - Extend `RegexPIIRecognizer` constructor with optional config bag (FR-7 surface only).
  - Add `context-enhancer.ts` pure function.
  - Thread `confidence`/`recognizer` through `PIIAuditEntry`, `PIIToken`, `StreamingPIIChunkResult`.
  - Include unit + integration tests for UT-1, INT-1 through INT-5, UT-5, UT-8.
  - Estimated ~20-25 files across `packages/compiler` only (1 package).

- **Commit 1b** (`feat(runtime)`): Runtime wiring + `core` pack + config fields.
  - Create `recognizer-packs/` directory with `index.ts`, `core.ts`.
  - Refactor `registerBuiltInRecognizers()` to delegate to `core.register()` (HLD section 3.1 binding decision).
  - Extend `IPIIRedactionConfig` with 4 new fields (FR-5).
  - Wire `mapProjectPIIRedactionConfig()` mapper extension.
  - Add `registerEnabledPacks()` in `pattern-loader.ts`.
  - Add Zod enum validation on `enabled_recognizer_packs` (GAP-010).
  - Add `pii-telemetry.ts` helper and wire latency telemetry (FR-8).
  - Include tests for UT-2, INT-7, INT-8, INT-9, INT-12, E2E-ERR-1.
  - Estimated ~25-30 files across `packages/compiler`, `packages/database`, `apps/runtime` (3 packages -- at the limit).

This split keeps each commit under 40 files and at most 3 packages, separates the pure refactor (1a) from the additive feature (1b), and makes the Foundation refactors independently revertable. The combination of 1a+1b constitutes the ALPHA-eligible drop.
**Source**: CLAUDE.md commit discipline (max 40 files, max 3 packages, one concern per commit, feature commits additive); docs/sdlc/pipeline.md commit conventions.
**Confidence**: HIGH

---

### Technical Details

---

#### Q6: Where should `withTimeout` live for `detectAllAsync`?

**Classification**: DECIDED
**Answer**: **Option (a) with a scope amendment -- extract to `packages/compiler/src/platform/security/_with-timeout.ts` with the `clearTimeout` fix, and defer migration of existing call sites to a separate follow-up.**

Evidence and reasoning:

1. The HLD section 4 Concern 6 explicitly states: "The version of `withTimeout` used by `detectAllAsync` MUST clear its `setTimeout` handle on the success path." Both existing implementations (at `transfer-session-store.ts:45-52` and `file-store-service.ts:241-248`) are confirmed buggy -- neither calls `clearTimeout`. I verified this by reading both source files.
2. Option (b) (inline in `pii-recognizer-registry.ts`) is viable since `detectAllAsync` is the only consumer in this spec, but the HLD recommends extraction and the existing pattern has 4+ duplicates across the codebase.
3. Option (c) (`packages/shared/src/util/`) would be ideal but crosses the 3-package-per-commit limit -- `packages/compiler` + `packages/shared` + `apps/runtime` + `packages/database` = 4 packages. Migrating the 2 existing buggy sites (`agent-transfer`, `arch-ai`) adds 2 more packages. This blows the commit scope constraint.
4. The right compromise: extract to `packages/compiler/src/platform/security/_with-timeout.ts` (underscore prefix per HLD convention for internal helpers), fix the `clearTimeout` leak, and file a follow-up tech-debt ticket to consolidate the 4+ duplicates into `packages/shared`. The existing buggy sites are low-throughput (Redis ops per HLD) and the leak is non-critical there. The PII detection path is high-throughput and needs the fix now.

**Source**: HLD section 4 Concern 6 (cleanup invariant); HLD section 8.1 (dependency table mentions extraction); verified `transfer-session-store.ts:45-52` and `file-store-service.ts:241-248` lack `clearTimeout`; CLAUDE.md max 3 packages per commit.
**Confidence**: HIGH

---

#### Q7: Confidence-field migration on `PIIRecognizer` interface

**Classification**: ANSWERED
**Answer**: **Option (b) -- add `confidence?: number` as optional on `PIIDetection` return type and have the registry default to `1.0` post-detect.** This is explicitly specified in the HLD.

HLD section 5.2 states: `confidence: number; // NEW -- required, defaults to 1.0 for legacy regex matches`. The mechanism is: `PIIDetection` gains `confidence` as a required field in the type definition, but the actual population happens inside `PIIRecognizerRegistry.detectAll()` at the point where `createSafePIIDetection()` is called (line 68 of `pii-recognizer-registry.ts`). Since `createSafePIIDetection()` today only takes `(type, start, end)`, it will be extended to accept optional `confidence` and `recognizer` params with defaults. The existing `RegexPIIRecognizer.detect()` returns detections via `createSafePIIDetection` -- extending that factory function means zero changes to existing recognizer `detect()` implementations. New recognizers (pack recognizers) can pass explicit confidence values.

This is NOT option (a) (breaking change to `PIIRecognizer` interface) because the `detect()` return signature stays `PIIDetection[]` and existing code that constructs `PIIDetection` without `confidence` just uses the factory. It's NOT option (c) (wrapper adapter) because the registry's existing `detectAll()` loop already wraps each recognizer's output through `createSafePIIDetection` -- we just extend that factory.

**Source**: HLD section 5.2 (`PIIDetection` type); feature spec FR-1 ("default `confidence = 1.0`"); `pii-recognizer-registry.ts:68` (`createSafePIIDetection` call site).
**Confidence**: HIGH

---

#### Q8: Audit-log read API for compliance

**Classification**: DECIDED
**Answer**: **Do NOT scope a `findByTenantProject` method or a `GET /api/projects/:projectId/pii-audit` route in this LLD.** INT-11's DI-based capture is sufficient for this sub-feature, and the audit-log read API gap should be logged for the parent feature.

Reasoning:

1. The HLD ships zero new routes (HLD section 6.1: "This sub-feature ships zero new HTTP routes").
2. The feature spec section 11 ("Open Questions") item 7 explicitly asks this question and frames it as a parent-feature concern: "If neither path covers compliance reads, this is a gap to flag for the parent feature, not this sub-feature."
3. The test spec INT-11 already documents the DI approach: "inject a test-only `PIIAuditStore` implementation (constructor-injected via `new PIIAuditLogger(store)`, not a module mock) that captures every `insert(entry)` call." This is architecturally sound per CLAUDE.md test architecture (DI, not mocks).
4. E2E-1 already asserts `confidence`/`recognizer` appear on trace events at the HTTP boundary -- the compliance-read concern is covered through the trace API for this sub-feature's scope.
5. Adding a read route would violate the "no new routes" HLD commitment and would require additional auth middleware decisions (who can read audit logs? `pii:read`? `pii-audit:read`? compliance officer role?) that are out of scope.

**Source**: HLD section 6.1; feature spec OQ-7; test spec INT-11 and OQ-2.
**Confidence**: HIGH

---

#### Q9: `registerBuiltInRecognizers` rename strategy -- compatibility shim for audit logs?

**Classification**: ANSWERED
**Answer**: **No compatibility shim needed.** The HLD explicitly addresses this in section 3.1: "Audit-log entries and trace events written before this spec retain their original recognizer-name strings (no rename migration); going forward they carry the `core-*` form." Since this LLD does NOT introduce a read API for audit logs (Q8 above), there is no consumer that would need to reconcile `builtin-*` vs `core-*` names. The divergent names are acceptable in the stored data.

When a read API eventually ships (parent feature scope), it can normalize names at the presentation layer if needed -- that's a trivially additive concern on the read path.

**Source**: HLD section 3.1, final paragraph: "Audit-log entries and trace events written before this spec retain their original recognizer-name strings (no rename migration)."
**Confidence**: HIGH

---

#### Q10: Database migration strategy -- one-time script or read-time defaults?

**Classification**: ANSWERED
**Answer**: **Rely entirely on read-time defaults. No migration script.** Both the feature spec and HLD explicitly state this.

- Feature spec section 12 ("Data Lifecycle"): "No migration scripts. Defaults apply at read time so missing fields on legacy documents are interpreted identically to today's behavior."
- HLD section 10.3: "No data migration scripts. All new fields... are additive with documented Mongoose-level defaults. Read-time defaults applied via `mapProjectPIIRedactionConfig()` in `session-pii-context.ts` (existing `??` fallback pattern extended)."

The new fields are not indexed (HLD section 5.1: "New fields not indexed"), so there is no indexing concern that would force a backfill. The Mongoose schema defaults fill in missing fields at document read time, and the `mapProjectPIIRedactionConfig()` mapper provides a second defensive layer with `??` fallbacks.

**Source**: Feature spec section 12; HLD section 10.3; HLD section 5.1 (indexes unchanged).
**Confidence**: HIGH

---

#### Q11: Performance benchmarks -- blocking build gate or non-blocking?

**Classification**: ANSWERED
**Answer**: **Non-blocking (report deltas, do not fail CI on regression).** The test spec section 6 explicitly states: "The benchmark stage is non-blocking (reports deltas, does not fail CI on regression)." The HLD section 4 Concern 9 commits to the budget tiers (5ms/2KB, 30ms/10KB) as operational targets measured via the `pii.detect.latency_ms` trace dimension in production, not as CI gates.

A blocking benchmark would add CI flakiness risk (machine-dependent timing, GC pauses, concurrent test interference) disproportionate to its value. The ReDoS adversarial test (UT-6) already provides a hard CI gate at 50ms per pattern -- that catches catastrophic regression. The microbenchmark suite provides visibility into pack-level latency trends without blocking.

**Source**: Test spec section 6 ("The benchmark stage is non-blocking"); HLD section 4 Concern 9 (performance budget is operational, not CI-gated).
**Confidence**: HIGH

---

### Risk & Dependencies

---

#### Q12: Sibling spec parity -- who owns Foundation?

**Classification**: ANSWERED
**Answer**: **This LLD canonically owns Foundation.** The sibling spec (`pii-detection-enhancements.md`) is at status PLANNED with no HLD and no LLD (verified via filesystem check). This spec (`pii-detection-tiered-recognizers`) has completed feature spec, test spec, and HLD, and is now entering LLD. It will land Foundation first by a significant margin.

The HLD section 9 item 1 already settled the parity question: "whichever spec ships Foundation first owns the canonical interfaces; the second spec consumes them unchanged via `/post-impl-sync` parity check." Since this spec lands first, this LLD's Phase 1 should explicitly mark the Foundation interfaces as reusable exported types with stable signatures. Specifically:

- `PIIDetection` (with `confidence`, `recognizer`) -- exported from `pii-detector.ts`
- `detectAllAsync()` -- exported from `pii-recognizer-registry.ts`
- `RegexPIIRecognizerConfig` (context-word boost config shape) -- exported from `pii-recognizer-registry.ts`
- `IPIIRedactionConfig` extensions (`tier`, `latency_budget_ms`, `confidence_threshold`, `enabled_recognizer_packs`) -- exported from `packages/database`
- `RuntimePIIRedactionConfig` / `RuntimePIIProjectSnapshot` extensions -- exported from `session-pii-context.ts`

The LLD should include a "Foundation Stability Contract" section listing these exported types as stable interfaces that the sibling spec may depend on without modification.

**Source**: Sibling spec status PLANNED (verified via `ls` -- no HLD, no LLD exists); HLD section 9 item 1; feature spec section 1 ("whichever lands first should deliver them").
**Confidence**: HIGH

---

#### Q13: Biggest implementation risk

**Classification**: INFERRED
**Answer**: **(d) `mapProjectPIIRedactionConfig` field-propagation gap** is the single biggest implementation risk.

Evidence:

1. The feature spec section 10 explicitly calls this out: "This file maintains parallel interfaces -- `RuntimePIIRedactionConfig`, `ProjectPIIRedactionConfig`, `RuntimePIIProjectSnapshot`, and the `mapProjectPIIRedactionConfig()` mapper -- that ALL need additive extension so the new fields propagate from DB to snapshot to session detection callers. This is a cross-boundary field-propagation concern."
2. Today, NONE of these interfaces are exported (verified: `session-pii-context.ts:19-35` defines `RuntimePIIRedactionConfig` and `ProjectPIIRedactionConfig` as non-exported local interfaces; `mapProjectPIIRedactionConfig` at line 42 is a non-exported function). The LLD must export them for the sibling spec to consume (Q12 above), adding another dimension of risk.
3. The test spec ranks FR-5 (field propagation) as coverage risk #3 -- the highest risk that isn't already mitigated by the bypass fix tests.
4. CLAUDE.md explicitly enforces this via `field-propagation-lint.sh`: "when adding fields to exported schemas/types or boundary-shaped types, verify every consumer in the same change."
5. The other candidates are lower risk: (a) credit-card alignment is a detection-expanding bug fix with Luhn validation gating FPs (HLD section 10.1); (b) MAX_RECOGNIZERS is addressed by the HLD's binding decision to raise to 100 + `permanent: true` (HLD section 5.2); (c) `withTimeout` cleanup is addressed by the extraction with `clearTimeout` (Q6 above).

**Source**: Feature spec section 10 (`session-pii-context.ts` entry); test spec coverage risk ranking #3; CLAUDE.md `field-propagation-lint.sh`; verified `session-pii-context.ts:19-48` shows non-exported interfaces.
**Confidence**: HIGH

---

#### Q14: Pre-rollout monitoring requirements -- ship a Grafana dashboard?

**Classification**: ANSWERED
**Answer**: **No Grafana dashboard or Prometheus alert is required as a phase deliverable.** The HLD section 4 Concern 8 explicitly states: "No new dashboard or alert is introduced in this HLD." The feature spec section 12 ("Observability") confirms: "No new dashboard or alert work in this spec; the Observability team owns visualization in a follow-up."

The trace event channel (`pii.detect.latency_ms`, `pii.detect.degraded`) provides the raw primitives. The existing trace infrastructure makes these queryable. The rollout strategy (HLD section 10.2) requires "monitoring for one week" but does not mandate a purpose-built dashboard -- existing trace queries suffice for the initial validation window.

The LLD should document the trace event schema (dimension names, sub-dimensions, value types) as a deliverable so the Observability team can build a dashboard without reading implementation code, but the dashboard itself is out of scope.

**Source**: HLD section 4 Concern 8 (last line); feature spec section 12 ("Observability"); HLD section 10.2.
**Confidence**: HIGH

---

#### Q15: Definition of done (whole feature) -- ALPHA or BETA?

**Classification**: INFERRED
**Answer**: **ABLP-921 is complete at ALPHA promotion.** BETA promotion is a separate gate with additional criteria.

Per the SDLC pipeline (`docs/sdlc/pipeline.md`), the feature status lifecycle is PLANNED -> ALPHA -> BETA -> STABLE with transitions gated by criteria. ALPHA requires: all planned implementation phases complete, tests passing in CI, `/post-impl-sync` run. BETA requires: saturation re-run confirming p95/p99 budgets hold with all packs enabled (feature spec section 13 item 3.3), `PII_BYPASS_FIX_DISABLED` env var removed after one stable release cycle (HLD section 11), and one week of production monitoring (HLD section 10.2).

The LLD's scope should be: all 8 packs + Foundation refactors + tests passing in CI + ALPHA promotion via `/post-impl-sync`. The BETA criteria (saturation re-run, monitoring window, env var cleanup) are operational gates that occur post-implementation and should be documented as exit criteria in the LLD's delivery plan but are not implementation deliverables.

**Source**: CLAUDE.md feature status lifecycle; feature spec section 13 items 3.3-3.5 (verification and rollout phase); HLD section 10.2 (rollout strategy with one-week monitoring window).
**Confidence**: HIGH

---

## Decisions Made (for DECIDED items)

| #        | Decision                                                                                                                                             | Rationale                                                                           | Risk                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| D-1 (Q1) | Foundation + core pack together as Phase 1                                                                                                           | `core` pack IS the DRY fix target per HLD 3.1; cannot complete FR-3/FR-4 without it | Low                                                          |
| D-2 (Q2) | Group packs into 3 phases: (us+eu), (apac+financial+medical), (network+international-phone+context-enhancer)                                         | Keeps each commit under 40-file/3-package limits; groups by dependency affinity     | Low                                                          |
| D-4 (Q4) | Test-first for validators; test-alongside for pack regexes                                                                                           | Pure functions get test-first per CLAUDE.md; regex patterns co-depend on fixtures   | Low                                                          |
| D-5 (Q5) | Phase 1 split into 2 commits: 1a (Foundation refactors) + 1b (runtime wiring + core pack + config)                                                   | Keeps each under 40 files/3 packages; separates refactor from feat for clean revert | Low                                                          |
| D-6 (Q6) | Extract `withTimeout` to `packages/compiler/src/platform/security/_with-timeout.ts` with `clearTimeout` fix; defer migration of existing leaky sites | Fixes the high-throughput consumer now; avoids blowing the 3-package commit limit   | Medium -- existing sites remain buggy but are low-throughput |
| D-8 (Q8) | No audit-log read API in this LLD scope; DI-based test capture sufficient                                                                            | HLD commits zero new routes; feature spec frames this as parent-feature concern     | Low -- compliance reads use trace API for now                |

---

## Escalations (for AMBIGUOUS items -- requires user input)

None. All 15 questions were resolved via explicit HLD/feature-spec answers, codebase evidence, or principled decisions with documented rationale.

---

## Audit Trail (Phase 4b — 8 rounds)

**Date**: 2026-05-09

### Round 1 — lld-reviewer (Architecture Compliance) — APPROVED

- 3 MEDIUM findings, all resolved:
  - `pii-telemetry.ts` trace channel emit pattern unspecified — fixed: documented exact `traceStore.addEvent(sessionId, event)` shape with `data: Record<string, unknown>` field.
  - `PACK_NAMES` re-export plan would create a circular dep — fixed: moved declaration to `packages/shared/src/validation/pii-pack-names.ts` (compiler→shared, never reverse).
  - Phase 2 inline IBAN mod-97 with TODO marker — accepted, P3 grep-based exit criterion enforces consolidation.

### Round 2 — lld-reviewer (Pattern Consistency) — NEEDS_REVISION → APPROVED after fixes

- 1 HIGH, 4 MEDIUM, 2 LOW, all resolved:
  - HIGH: TraceStore.addEvent shape was fabricated — rewrote with verified `(sessionId, event)` signature.
  - MEDIUM: `runtimeConfigResponseSchema` and `PROJECT_RUNTIME_CONFIG_DEFAULTS` not modified — added to 1b-prep tasks.
  - MEDIUM: `luhnCheck` is private — added explicit "promote to named export" step in 1a.2.
  - MEDIUM: D-12 wrongly claimed all 4 interfaces non-exported — corrected (2 already exported; only `ProjectPIIRedactionConfig` and `mapProjectPIIRedactionConfig` need promotion).
  - MEDIUM: Mongoose-level defaults diverged from existing `default: undefined` pattern — switched to mapper-layer `??` fallbacks only.
  - LOW: `_DISABLED` env-var name diverged from runtime convention — renamed to `PII_BYPASS_FIX_ENABLED` (default `true`, set `false` to revert).
  - LOW: underscore prefix not a compiler convention — acknowledged as new local convention.

### Round 3 — lld-reviewer (Completeness) — NEEDS_REVISION → APPROVED after fixes

- 2 CRITICAL, 1 HIGH, 4 MEDIUM, all resolved:
  - CRITICAL: §5.2/5.3 default-column inversion after `_DISABLED → _ENABLED` rename — fixed (default `true`).
  - CRITICAL: §3 P1a exit criterion `=true` should be `=false` to exercise legacy bypass — fixed.
  - HIGH: `pii-streaming-iban.e2e.test.ts` (E2E-6) listed in test spec but absent from LLD — added explicit deferral note.
  - MEDIUM: `onDegraded` callback chain missing from wiring checklist — added.
  - MEDIUM: OpenAPI conditional unresolved — verified `apps/runtime/openapi/` does not exist; resolved as N/A.
  - MEDIUM: Foundation Stability Contract freeze missing from acceptance criteria — added.
  - MEDIUM: fixtures/ directory claim conflict — added clarifying note (runtime namespace, nothing committed).
  - LOW: OQ-2 `unsupported_tier` recommendation not tracked — disposition added (deferred to sibling sub-feature).

### Round 4 — phase-auditor (Cross-Phase Consistency) — NEEDS_REVISION → APPROVED after fixes

- 1 CRITICAL, 3 HIGH, 1 MEDIUM, all resolved:
  - CRITICAL: HLD used `PII_BYPASS_FIX_DISABLED` while LLD used `PII_BYPASS_FIX_ENABLED` — updated HLD (4 references) to align on LLD's positive-logic naming.
  - HIGH: `PACK_NAMES` placement deviation from HLD §3.3 component diagram — added explicit deviation note in §1.2.
  - HIGH: E2E-2 context-boost path source ambiguous (custom pattern vs pack) — clarified at task 2.4.
  - HIGH: P2 inline IBAN TODO ambiguous — clarified as fully functional, not stub.
  - MEDIUM: §6 "All 8 E2E" miscounted (only 7 active) — corrected.
  - LOW: Phase 5.5 missed `agents.md` updates — added explicit per-package learnings step.

### Round 5 — lld-reviewer (Final Sweep) — APPROVED

- 1 MEDIUM, 2 LOW, all resolved:
  - MEDIUM: `apps/runtime/src/services/observability/` directory does not exist — moved `pii-telemetry.ts` to `apps/runtime/src/observability/` (matches existing convention).
  - LOW: §2.1 file-map said `recognizer-packs/index.ts` "contains" `PACK_NAMES` — clarified to "imports".
  - LOW: stale "re-export from compiler or import directly" alternative phrasing in §2.2 — replaced with authoritative 1b-prep description.

### Round 6 — Platform Audit (general-purpose) — APPROVED

- 2 MEDIUM, 1 LOW, all resolved:
  - MEDIUM: `phone-extraction.ts` import path unspecified — added at task 4.2 (`'../../utils/phone-extraction.js'`).
  - MEDIUM: commit-type ambiguity (P1a high deletion ratio could trigger guard) — added per-phase commit-type table (`refactor(compiler):` for 1a).
  - LOW: D-3 cited factory call site rather than definition — clarified definition is at `pii-detector.ts:115`.

### Round 7 — Industry Research Audit — APPROVED with 5 follow-up improvements

- 2 RISK, 2 GAP, 1 IMPROVEMENT logged as Open Questions §7 items 5–9 (non-blocking for ALPHA):
  - RISK: ReDoS threshold tightened from 50 ms → 25 ms per pattern (industry guidance for developer-authored patterns).
  - RISK: Per-pack smoke ReDoS check added at each phase (don't defer all ReDoS testing to P4).
  - GAP: Context-enhancer recall gap (raw-token vs lemma) — documented in JSDoc; pack authors must enumerate inflections.
  - GAP: SSN undashed FP regression coverage — added 9-digit non-SSN negative-test fixture group to 1b.14.
  - IMPROVEMENT: Shadow/dry-run mode + golden-set regression corpus — disposition deferred (existing `redact_*=false` covers detect-only mode for v1).

### Round 8 — OSS Library Audit — APPROVED

- Final verdict: **zero new deps decision holds**. `validator.js` evaluated and rejected (documented ReDoS CVE history; 3 of 12 validators still need hand-port; upstream regex change risk). `cockatiel` blocked by Node ≥22 requirement. `p-timeout` overkill. NLP libraries 100× heavier than needed. `libphonenumber-js` (already installed) is the right choice for `international-phone` pack.
- Action taken: added `ibantools` and `bs58check` as design references in P3 task 3.2 for `_validators.ts` correctness verification (MIT attribution comments only — no transitive deps added).

---

## Final Disposition

**Verdict**: All 8 audit rounds APPROVED. Zero remaining CRITICAL or HIGH findings. 9 MEDIUM/LOW findings logged in §7 Open Questions and §8 Risk Register with explicit dispositions.

**Next action**: commit the LLD with prefix `[ABLP-921] docs(compiler): add pii-detection-tiered-recognizers LLD + implementation plan`.
