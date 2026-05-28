# SDLC Log — pii-detection-tiered-recognizers — HLD

**Feature**: PII Detection Tiered Recognizers (Foundation + STANDARD Tier)
**Slug**: `pii-detection-tiered-recognizers`
**Phase**: HLD
**Date**: 2026-05-09
**JIRA**: ABLP-921
**Author flow**: `/hld pii-detection-tiered-recognizers`

---

## Inputs

- Feature spec: `docs/features/sub-features/pii-detection-tiered-recognizers.md`
- Test spec: `docs/testing/sub-features/pii-detection-tiered-recognizers.md`
- Parent HLD: `docs/specs/pii-detection.hld.md`
- Sibling sub-feature: `docs/features/sub-features/pii-detection-enhancements.md` (cloud tier — shares Foundation prerequisites)
- Source plan: `docs/audit/2026-05-08-pii-detection-gap-analysis-and-enhancement-plan.md`
- Existing implementation under `packages/compiler/src/platform/security/`, `apps/runtime/src/services/pii/`, `apps/runtime/src/routes/project-runtime-config.ts`
- CLAUDE.md (Core Invariants, Quality Gates, dependency policy)

## Output Artifacts

- `docs/specs/sub-features/pii-detection-tiered-recognizers.hld.md` — full HLD (DRAFT)
- `docs/testing/sub-features/pii-detection-tiered-recognizers.md` — companion edits (validator.js / cockatiel removed; INT-5/UT-2/UT-3/UT-8 reworded; INT-6 reduced to 3 entry points; E2E-6 marked DEFERRED; E2E-ERR-1 expectations realigned to `VALIDATION_ERROR` + `issues`)
- This log

---

## User-Facing Decisions

| #   | Question                                                                                                                                              | Resolution                                                                                                                                                                                                                                                        | Source                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Q1  | Library policy: keep `validator.js` + `cockatiel` (per feature-spec §11), drop only `cockatiel`, or zero new deps?                                    | **Zero new runtime deps** (Recommended). Drop both `validator.js` and `cockatiel`. Reuse in-house `withTimeout`, existing `luhnCheck`, `libphonenumber-js`, `performance.now()` idiom; hand-port ~150 LoC of validators (IBAN mod-97, Verhoeff, DEA, BTC base58). | User answer (in response to prompt to audit current libs) |
| Q2  | International-phone pack: reuse `phone-extraction.ts` (delegates to `libphonenumber-js#findPhoneNumbersInText`) or write new E.164 regex in the pack? | **Reuse `phone-extraction.ts`**.                                                                                                                                                                                                                                  | User answer                                               |

## Oracle Decisions (DECIDED — judgment calls)

| #    | Decision                                                                                                              | Rationale                                                                                                                   | Risk   |
| ---- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-1  | Wrap entire `detectAllAsync()` with `withTimeout` (not per-recognizer)                                                | Sync recognizers run before timer; no async recognizers ship yet; per-call budget matches API shape                         | Low    |
| D-2  | Context-word boost inside `RegexPIIRecognizer.detect()` (not as post-pass)                                            | Feature spec FR-7 says "at recognition time"; context words are per-recognizer config; avoids reverse-mapping               | Low    |
| D-3  | `MAX_RECOGNIZERS` 50 → **100** + `permanent: true` for pack recognizers                                               | Keeps cap meaningful (not 200); platform packs survive eviction; 50+ slots for custom patterns                              | Low    |
| D-4  | Defer per-pattern execution timeout (GAP-009)                                                                         | No consumer yet; UT-6 ReDoS adversarial corpus is primary mitigation                                                        | Medium |
| D-5  | Feature-flag FR-4 bypass fix via `PII_BYPASS_FIX_DISABLED` env per pod                                                | Cheap toggleability; three independent guards; default fix-enabled                                                          | Low    |
| D-6  | Keep `detectAllAsync` in WS-1 (not WS-3)                                                                              | Low cost (~30 LoC); UT-8 + INT-5 cover both paths; WS-3 inherits a tested seam                                              | Low    |
| D-7  | `core` pack adopts 13–19-digit + Luhn credit-card pattern (detection-expanding bug fix; not feature-flagged)          | All paths converge on registry; Luhn validator gates precision; closes documented divergence                                | Low    |
| D-8  | `registerBuiltInRecognizers()` becomes a thin shim delegating to `core.register(registry)`                            | Eliminates the name-collision question; `core-*` prefix becomes canonical                                                   | Low    |
| D-9  | GAP-010 closes via Zod `z.enum([...])` producing existing `VALIDATION_ERROR` (not new `INVALID_RECOGNIZER_PACK` code) | Reuses existing `onValidationError` pipeline + `error.issues` precedent                                                     | Low    |
| D-10 | `entry_point='streaming_chunk'` deferred — `StreamingPIIBuffer` has no production caller                              | FR-8 instrumentation requires a runtime caller to wrap; LLD ships buffer-side fields/hooks; emit-site wiring is a follow-up | Low    |
| D-11 | Telemetry seam stays in the runtime caller (not in `streaming-pii-buffer.ts`)                                         | Compiler must not import runtime trace infra                                                                                | Low    |
| D-12 | `withTimeout` MUST clear `setTimeout` on success path                                                                 | High-throughput consumer forces cleanup; existing call sites are lower throughput                                           | Low    |
| D-13 | Performance budget split: p95 ≤ 5 ms on ≤ 2 KB payloads; p95 ≤ 30 ms on ≤ 10 KB                                       | Honest accounting against IBM mcp-context-forge benchmark (~30 ms naive at 40 patterns / 1 KB scaled)                       | Low    |

## Inferred Decisions

| #   | Decision                                                                                                                                                                                                                                                                | Source                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| I-1 | Pack registration happens at both module-load (`getDefaultPIIRecognizerRegistry`) and per-session bootstrap (`createRecognizerRegistry` → `registerEnabledPacks` → `loadProjectPIIPatterns`)                                                                            | Existing two-level pattern in `pii-recognizer-registry.ts` and `session-pii-context.ts`                           |
| I-2 | `bumpPIIConfigEpoch` already fires for any `pii_redaction` change → no new wiring required                                                                                                                                                                              | `apps/runtime/src/routes/project-runtime-config.ts:491-492`                                                       |
| I-3 | `IPIIRedactionConfig` validation extends both Zod (`packages/shared/src/validation/project-runtime-config.ts:36-40`) and Mongoose (`packages/database/src/models/project-runtime-config.model.ts:199-206`); `mapProjectPIIRedactionConfig()` extends with `??` fallback | Code reading at the cited locations                                                                               |
| I-4 | `builtin-pii.ts:25` is a fourth bypass surface, transitively closed by FR-3 (no separate code change)                                                                                                                                                                   | `request.context?.piiRecognizerRegistry` defaults to `undefined`; FR-3 makes `detectPII` default to the singleton |
| I-5 | Programmatic generation of golden corpus (≥ 500 entries / entity type) with deterministic seed under `__tests__/security/fixtures/`, not committed JSON                                                                                                                 | Test-spec OQ-4 trade-off                                                                                          |
| I-6 | Test infra reuse: existing `RuntimeApiHarness` + `MongoMemoryServer`; pure-JS deps run live; DI for synthetic async recognizer                                                                                                                                          | CLAUDE.md test architecture rules + test-spec §7                                                                  |

## Library Capability Audit (recorded for future reference)

User explicitly asked: "review the current libraries being used for pii and see if the same libraries have the capabilities which we are adding. do not add any capabilities which already exist either in our code or the libraries or frameworks which we are already using."

Result: feature-spec §11 originally proposed three deps (`validator ^13`, `cockatiel ^3`, `@types/validator ^13`). HLD §8.2 + Appendix A removes all three after auditing 12 categories of duplication:

| Category                                   | Already covered by                                                                                                                                           | Net                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Async timeout                              | `withTimeout(promise, ms)` pattern in `transfer-session-store.ts:45`, `file-store-service.ts:241`, `external-agent-config-repo.ts:265-275`, three more sites | Drop `cockatiel`                               |
| Luhn check                                 | `luhnCheck()` at `pii-recognizer-registry.ts:170-190`                                                                                                        | Drop `validator.isLuhnNumber` / `isCreditCard` |
| Phone parsing                              | `libphonenumber-js` via `phone-extraction.ts:11-16`                                                                                                          | Drop `validator.isMobilePhone`                 |
| IP detection                               | Existing IPv4 regex; new IPv6 in `network` pack                                                                                                              | Drop `validator.isIP`                          |
| IBAN, passport, identity card, tax ID, BTC | Hand-port ~150 LoC into `_validators.ts` (mod-97, Verhoeff, DEA, base58-check + per-pack format regexes)                                                     | Drop `validator.js` entirely                   |
| Latency telemetry                          | `performance.now()` idiom in `builtin-pii.ts:24-39`                                                                                                          | No new instrumentation library                 |
| Eviction protection                        | `register(rec, { permanent: true })` at `pii-recognizer-registry.ts:29-55`                                                                                   | No new abstraction                             |
| ReDoS heuristic                            | `CATASTROPHIC_BACKTRACKING_PATTERNS` at `pattern-service.ts:49`                                                                                              | No new linter                                  |
| `pii_redaction` cache invalidation         | `bumpPIIConfigEpoch` at `pii-epoch.ts:56-85`                                                                                                                 | No new wiring                                  |

Decision binding for the LLD. Test spec §1, §2, §3, §4 updated to drop `validator.js` / `cockatiel` references where they appeared as live-runtime claims.

## Audit Rounds

### Round 1 — phase-auditor (full audit, all 12 concerns)

VERDICT: NEEDS_REVISION. Findings:

- **CRITICAL [XP-3]** Test spec stale `validator.js` / `cockatiel` references at lines 53/189/193/275/277-282/317. **Resolved** by direct test-spec edits.
- **HIGH [HD-6a]** `builtin-pii.ts` is a fourth bypass surface. **Resolved** by adding migration-table row noting transitive FR-3 fix with code citation `pipeline.ts:595`.
- **HIGH [HD-6b]** Undashed SSN in `core` is a detection-expanding change. **Resolved** by expanding migration-table row with FP mitigation guidance.
- **HIGH [HD-5]** Typo `RegexPIyRecognizer`. **Resolved.**
- **MEDIUM [HD-1/XP-4]** Tier ambiguity (project tier vs recognizer tier). **Resolved** by adding clarifying note at top of §5.
- **MEDIUM [HD-9]** `withTimeout` cleanup invariant missing. **Resolved** in Concern 6.
- **MEDIUM [HD-3]** Performance budget gap (~30 ms naive vs 5 ms target at 10 KB). **Resolved** by committing to two-tier budget (≤ 2 KB at 5 ms; ≤ 10 KB at 30 ms).

### Round 2 — phase-auditor (deeper data-model / API / sibling-parity)

VERDICT: APPROVED with 1 HIGH and 2 MEDIUM new findings.

- **HIGH [HD-5 NEW]** `INVALID_RECOGNIZER_PACK` vs Zod `superRefine`/`VALIDATION_ERROR` ambiguity. **Resolved** by binding decision in §6.3: GAP-010 closes via Zod `z.enum([...])` producing existing `VALIDATION_ERROR` + `issues`; no new code introduced. Concern 3 + Concern 5 + §6.3 + component diagram all updated consistently.
- **MEDIUM [HD-3 NEW]** `StreamingPIIBuffer` has no production caller — FR-8 streaming entry point is aspirational. **Resolved** by deferring `entry_point='streaming_chunk'` in Concern 8; test-spec INT-6 reduced to 3 entry points; E2E-6 marked DEFERRED.
- **MEDIUM [HD-4 NEW]** Pack registration name collision (`builtin-*` vs `core-*`) not specified. **Resolved** in §3.1 by binding decision: `registerBuiltInRecognizers()` becomes a thin shim delegating to `core.register(registry)`; pack names use `core-*` prefix; no `builtin-*` names persist.

Round 2 also performed deeper checks and PASSED on:

- Data-model four-layer parity (interface + Mongoose + Zod + mapper)
- Sibling-spec parity (Foundation interfaces compatible with cloud-tier sub-feature)
- `MAX_RECOGNIZERS` 50 → 100 decision matches what test-spec INT-12 will bind to

### Round 3 — phase-auditor (verification-only final pass)

VERDICT: APPROVED. All round-2 findings RESOLVED. No regressions. One residual cross-artifact note (E2E-ERR-1 expectations) — fixed by test-spec edit after round 3.

## Design-Lint

`tools/design-lint.sh` results: 19 PASS, 0 missing, 1 warn (open-questions count, expected). 95% completeness. Document length 6190 words.

## Cross-Cutting Insights

- **Library audit as first-class HLD step.** This run elevated the library audit (originally an §11 dependency table item) into a binding §8.2 + Appendix A by user request. Pattern worth keeping for future HLDs that propose new deps: produce the audit table inline so the trade-off is visible.
- **`StreamingPIIBuffer` parent-feature deferred-wiring.** Discovered during round-2 audit that the streaming buffer has no production caller despite being part of the parent BETA feature spec. This is a parent-feature gap to flag in the next `/post-impl-sync` of `pii-detection.md`.
- **`registerBuiltInRecognizers` shim refactor** is the cleanest mechanism to land pack registration without name collisions; pattern usable for future packs (cloud, NER) that also subsume legacy registrations.
- **`pii-epoch` already invalidates on any `pii_redaction` change** — saved a round of "wire new fields to invalidation" work that the feature spec implied was needed.

## Next Phase

`/lld pii-detection-tiered-recognizers`
