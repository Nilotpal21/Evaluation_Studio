# SDLC Log — pii-detection-tiered-recognizers — Feature Spec

**Feature**: PII Detection Tiered Recognizers (Foundation + STANDARD Tier)
**Slug**: `pii-detection-tiered-recognizers`
**Phase**: Feature Spec
**Date**: 2026-05-08
**JIRA**: ABLP-921
**Author flow**: `/feature-spec pii-detection-gap-analysis` (slug renamed during clarification)

---

## Inputs

- Source plan: `docs/audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md` (929 lines, [ABLP-534] commit `86635885d`)
- Parent feature: `docs/features/pii-detection.md` (BETA)
- Sibling sub-feature (cloud-tier path): `docs/features/sub-features/pii-detection-enhancements.md` (PLANNED)
- Template: `docs/features/TEMPLATE.md`
- Authoring guide: `docs/features/AUTHORING_GUIDE.md`
- Project conventions: `CLAUDE.md`

## Output Artifacts

- `docs/features/sub-features/pii-detection-tiered-recognizers.md`
- `docs/testing/sub-features/pii-detection-tiered-recognizers.md`
- Index updates:
  - `docs/features/sub-features/README.md` (row inserted after sibling)
  - `docs/testing/sub-features/README.md` (row inserted after sibling)
  - `docs/testing/README.md` (row 102, PLANNED 05-08)
- This log

---

## User-Facing Decisions

| #   | Question                                                                                                                                                    | Resolution                                                                                                                      | Source                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Q1  | Existing sibling sub-feature `pii-detection-enhancements.md` proposes cloud-provider PII path; new gap analysis proposes GLiNER+Presidio. How to reconcile? | **New separate sub-feature spec** (sibling kept; complementary, share Foundation prerequisites)                                 | User answer                                   |
| Q2  | Implementation scope for this spec                                                                                                                          | **Foundation (WS-1) + STANDARD tier (WS-2) only**. ADVANCED/MAXIMUM (WS-3 GLiNER) and Studio UX (WS-4) explicitly out of scope. | User answer                                   |
| Q3  | JIRA ticket                                                                                                                                                 | **ABLP-921** (separate from ABLP-534 used for the gap-analysis doc)                                                             | User answer                                   |
| Q4  | Sub-feature filename                                                                                                                                        | **`pii-detection-tiered-recognizers.md`** with reference to `pii-detection-enhancements.md` for future extension                | User answer                                   |
| Q5  | Priority/timeline driver                                                                                                                                    | **Industry parity (Decagon/Sierra/Vectara)** — internal tech-debt with parity framing, no fixed external deadline               | User answer (escalated from oracle AMBIGUOUS) |

## Oracle Decisions (DECIDED — judgment calls)

| #   | Decision                                                                                                                                                             | Rationale                                                                                                       | Risk |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---- |
| D-1 | Keep `detectPII`/`redactPII`/`containsPII` as standalone exports; change fallback to `getDefaultPIIRecognizerRegistry()` (do not require explicit registry argument) | Zero call-site changes; both gap-analysis and sibling-spec proposals converge on this; singleton already exists | Low  |
| D-2 | Default tier on existing deployments = `'basic'` (not `'standard'`)                                                                                                  | Preserves current 5-regex behavior; avoids silent false-positive increase on upgrade                            | Low  |
| D-3 | Backfill nothing on migration; apply defaults at read time                                                                                                           | Existing `IPIIRedactionConfig` schema uses `default: () => ({})` pattern — safe, zero-downtime                  | Low  |
| D-4 | 3 personas for WS-1+WS-2: platform operator, project builder (API-only), compliance auditor                                                                          | Studio UX persona deferred to WS-4; builder interacts via runtime config API                                    | Low  |
| D-5 | 8 FRs as drafted (FR-1 through FR-8) — map 1:1 to gap-analysis WS-1 + WS-2 deliverables                                                                              | Consolidated by oracle; no FR-9 needed since `PIIType` is already extensible                                    | Low  |

## Inferred Decisions

| #   | Decision                                                                                                                              | Source                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| I-1 | Pack-enable enforcement happens at session-init (registry overlay), tenant-agnostic in-process code with project-scoped configuration | Existing `loadProjectPIIPatterns()` flow + parent feature isolation rules |
| I-2 | No new auth-profile or secret concerns (recognizer packs are platform code; no external calls)                                        | All Tier 1/2 recognizers are pure-regex                                   |
| I-3 | Built-in pack patterns get manual ReDoS review; `CATASTROPHIC_BACKTRACKING_PATTERNS` heuristic borrowed from custom-pattern path      | `pattern-service.ts` precedent                                            |

---

## Audit Rounds

### Pass 1 — Phase-Auditor (round 1 of 2)

- **Verdict**: APPROVED
- **HIGH findings**:
  - FS-6: Missing session-derived isolation row in §12 → **FIXED** (added Session-derived isolation row referencing CLAUDE.md Core Invariant #1)
  - TS-4: §17 scenarios 10/11 + companion E2E-1/E2E-2/E2E-3 implied direct DB reads of `pii_audit_logs` → **FIXED** (rewrote to assert via runtime trace API + session detail; added "no direct DB" parentheticals)
- **MEDIUM findings**:
  - XP-3: Missing OQ on Foundation prerequisite ordering with sibling → **FIXED** (added OQ-6)
  - HD-3 precursor: No architecture diagram → **DEFERRED to HLD** (auditor noted feature-spec level is acceptable without diagram; HLD will own this)
- Added bonus OQ-7: explicitly flag the audit-log-read API question as a parent-feature gap, not a sub-feature blocker.

### Pass 2 — Phase-Auditor (round 2 of 2, fresh-eyes)

- **Verdict**: APPROVED
- All round 1 HIGH/MEDIUM fixes verified.
- **MEDIUM findings (non-blocking)**:
  - E2E-5 testing scenario lacked the explicit "no direct DB" parenthetical that peer scenarios got → **FIXED** (added the clause)
  - "Tier" terminology overload: project-tier (`pii_redaction.tier`) vs `RecognizerTier` enum → **DEFERRED to HLD** (terminology section will disambiguate)
- Cross-spec coexistence with sibling verified — no field-name or schema conflicts.

### Pass 3 — Platform Audit (general-purpose)

- **Verdict**: APPROVED
- **MEDIUM findings**:
  - FR-7 referenced a `RegexPIIRecognizerConfig` interface that doesn't exist → **FIXED** (FR-7 reworded to allow either a widened constructor or a new config interface).
  - `session-pii-context.ts` has parallel runtime interfaces (`RuntimePIIRedactionConfig`, `ProjectPIIRedactionConfig`, `RuntimePIIProjectSnapshot`, `mapProjectPIIRedactionConfig`) all needing additive extension → **FIXED** (§10 row enhanced; cross-boundary propagation flagged).
  - `MAX_RECOGNIZERS = 50` cap could be exceeded by ~40 pack recognizers → **FIXED** (§7 capacity note added; new GAP-008 logged with binding LLD decision).
- All Core Invariants verified pass (tenant isolation, project isolation, user isolation, session-derived isolation, centralized auth, stateless distributed, traceability, compliance, performance).

### Pass 4 — Industry Research Audit (web sources)

- 12 substantive findings tagged IMPROVEMENT / RISK / GAP. Sources cited: Microsoft Presidio docs, Google Cloud DLP, AWS Bedrock Guardrails, AWS Comprehend Service Card, Azure AI Language, OWASP LLM Top 10 (2025), NIST SP 800-188, IBM `mcp-context-forge` benchmarks, Protecto.ai research, John Snow Labs comparative study, Databricks LogSentinel.
- **Promoted into the spec**:
  - §1 Summary: prominent callout that STANDARD is structured/semi-structured-only; person-name/address/DOB are deferred to ADVANCED.
  - §7: RegExp pre-compilation requirement and microbenchmark gate (100/500/1000/5000-char payloads). Lemmatization stance documented (raw-token by design; OQ-8 tracks Porter stemmer follow-up).
  - §12 Observability: drift signals (per-recognizer volume, threshold-ratio shift, concentration alert).
  - §14 Success Metrics: precision/recall per entity type, F2 (recall-weighted) aggregate, automated 500-entry-per-type FP measurement (replaces manual 200-entry sample).
  - §15 Open Questions: OQ-8 (Porter stemmer), OQ-9 (per-entity-type confidence overrides), OQ-10 (tier naming conflation), OQ-11 (async-path YAGNI).
  - §16 Gaps: GAP-005 promoted Accepted → Open with RE2-compile lint mitigation; new GAP-009 (per-pattern timeout); new GAP-010 (Zod validation on `enabled_recognizer_packs`).
- **Logged but not promoted** (HLD or future-iteration concerns): per-entity-type threshold UX, lemmatization library choice if OQ-8 is taken.

### Pass 5 — OSS Library Audit (web sources)

- Reviewed 10 candidate libraries against the spec's custom-implementation proposals.
- **Adopted**:
  - **`validator.js`** (MIT, ~16.5M weekly downloads, v13.15.x active) — validation backend for Luhn / IBAN / passport / identity card / tax ID / credit card / mobile / BTC / IP. Eliminates the highest-risk hand-port code from the recognizer packs.
  - **`cockatiel`** (MIT, ~269k weekly downloads) — `Policy.timeout()` for `detectAllAsync()` latency budget; cleaner than hand-rolled `Promise.race` + `AbortController`.
- **Kept inline** (no maintained alternative or trivial implementation): Verhoeff (Aadhaar), DEA checksum, context-word boosting.
- **Avoided**: `redact-pii` (abandoned), `node-verhoeff` (abandoned), `@yellowsakura/js-pii-mask` (early), `@openredaction/openredaction` (early; useful for design review only).
- **Spec changes**: §7 "Validator reuse" rewritten; §11 new "New npm Dependencies" table (`validator`, `cockatiel`, `@types/validator`); §18 References extended.

---

## Open Questions Logged on the Spec (§15)

1. Pack composition semantics — is `core` always-on or opt-in via `enabled_recognizer_packs`?
2. Tenant-level pack cap (governance lever) — out of scope, flagged for follow-up.
3. Empirical context-boost default — `0.35` borrowed from Presidio; revisit with FP/FN data.
4. IPv6 placement — `core` or `network`?
5. Tenant-level rollback switch for the registry-bypass-fix during rollout.
6. Foundation interface coordination with sibling sub-feature.
7. Audit-log read API for compliance reporting (parent-feature gap).

---

## Files Touched (this phase)

| Path                                                                  | Action             |
| --------------------------------------------------------------------- | ------------------ |
| `docs/features/sub-features/pii-detection-tiered-recognizers.md`      | created            |
| `docs/testing/sub-features/pii-detection-tiered-recognizers.md`       | created            |
| `docs/features/sub-features/README.md`                                | row added          |
| `docs/testing/sub-features/README.md`                                 | row added          |
| `docs/testing/README.md`                                              | row 102 added      |
| `docs/sdlc-logs/pii-detection-tiered-recognizers/feature-spec.log.md` | created (this log) |

## Next Phase

`/test-spec pii-detection-tiered-recognizers` (test-spec skill) once this commit lands. The feature spec already includes a coverage matrix and 14 test scenarios across unit/integration/E2E, but the test-spec skill will harden them with explicit fixtures, harness layout, and test-data plans.
