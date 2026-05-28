# Data-Flow & Dependency-Wiring Audit: Guardrails Sensitive Data Block

**Date**: 2026-05-18
**Auditor**: Claude (Phase 6 Data-Flow Audit Agent)
**Round**: 1
**Feature**: `docs/features/sub-features/guardrails-sensitive-data-block.md`
**JIRA**: ABLP-723
**Branch**: `discuss/guardrails-pii-consolidation`

---

## Sensitive Values Audited

- **PII detection content** — DATA CLASS: PII
- **Trace event payloads** — DATA CLASS: INTERNAL (includes redacted PII echoes)
- **failMode policy decisions** — DATA CLASS: INTERNAL (affects safe-by-default)
- **enabled_recognizer_packs config** — DATA CLASS: INTERNAL (drives entity filter scope)

---

## Chain A — Entity Filter (Schema → Resolver → Tier2 → Provider)

### VALUE: PII Detection Content (entity allowlist filter chain)

**DATA CLASS**: PII
**APPROVED CONSUMERS**: BuiltinPIIProvider (post-detection filter), trace events (redacted echoes only)

#### 1. Source

- **Hop 1 — Studio form**: `apps/studio/src/components/guardrails/GuardrailPolicyForm.tsx:373`
  - Entry type: User selection in EntityMultiselect component
  - Validation: `Array.isArray(rule.entities)` check at L373; SWR-fetched catalog constrains values
  - `entities` array serialized at L563: `...(rule.entities ? { entities: rule.entities } : {})`
  - `kind: 'both'` expansion at L596-601 spreads `base` which includes `entities` — BOTH input and output rules carry the same entities. VERIFIED.

#### 2. Writes

- **MongoDB**: `guardrail_policies.rules[].entities` — `packages/database/src/models/guardrail-policy.model.ts:172`
  - Schema: `entities: { type: [String], default: undefined }` — written raw (string array, no PII content)
  - `enabled: { type: Boolean, default: undefined }` at L173-180 — VERIFIED with explicit validator
  - `presetKey: { type: String, default: undefined }` at L181
  - `actionMessage: { type: String, default: undefined }` at L182
- **Route normalizer**: `apps/runtime/src/routes/guardrail-policies.ts:504-508` — validates `Array.isArray(rule.entities)`, strips if malformed
- **Server-side validation**: `validateRulesServerSide()` at L604-629 calls shared `validateRule()` which enforces 1 <= entities.length <= 37

#### 3. Serialization Boundaries

- **HTTP POST/PUT** Studio → Runtime: entities in JSON request body, no boundary-specific serialization
- **In-process**: Route handler → PolicyResolver → Pipeline → Tier2Evaluator → Provider — all in-process, no serialization boundary crossed

#### 4. Read Paths

- **Hop 2 — PolicyResolver**: `apps/runtime/src/services/guardrails/policy-resolver.ts:159` — `entities: rule.entities` propagated to `Guardrail` IR
- **Hop 3 — Tier2Evaluator**: `packages/compiler/src/platform/guardrails/tier2-evaluator.ts:179` — `allowedEntityTypes: guardrail.entities` projected into `GuardrailEvalRequest.context`
- **Hop 4 — BuiltinPIIProvider**: `packages/compiler/src/platform/guardrails/providers/builtin-pii.ts:37-41` — reads `request.context?.allowedEntityTypes`, builds `Set`, filters `result.detections.filter((d) => allowSet.has(d.type))`. CRITICAL: uses `d.type` (correct), NOT `d.entityType`. VERIFIED at L41.

#### 5. Policy Boundary

| Consumer                                | Policy                                                                                                                                                                                                                                  | Verdict                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| BuiltinPIIProvider (filter)             | Entity allowlist restricts which detections trigger a violation                                                                                                                                                                         | PASS — filter at L40-42 uses `allowSet.has(d.type)` with Set for O(1) |
| Trace events (guardrail_input_blocked)  | Only `presetKey`, `guardrailName`, `action`, `message` emitted; no raw entity content                                                                                                                                                   | PASS — reasoning-executor.ts:1904-1914                                |
| Trace events (guardrail_output_blocked) | Same — only metadata, no raw content                                                                                                                                                                                                    | PASS — reasoning-executor.ts:3486-3497                                |
| GuardrailEvalResult.raw                 | Contains full `PIIDetectionResult` but `PIIDetection.value` is documented as "Never contains the matched raw substring" (pii-detector.ts:26). `raw` is NOT forwarded to `GuardrailViolation` or trace events — stays local to provider. | PASS                                                                  |
| Log lines                               | `log.warn('Output guardrail violation', ...)` at output-guardrails.ts:89-93 logs `violation.name`, `action`, `message` — no raw PII content                                                                                             | PASS                                                                  |

#### 6. Consumers/Sinks

- No external API, Kafka, email, or file sink receives entity allowlist or detection content
- The `explanation` field at builtin-pii.ts:54 includes entity _types_ (e.g., "us*ssn") but not raw \_values*. SAFE.

#### 7. Dependency Wiring

```
DEPENDENCY: allowedEntityTypes (entity filter)
  Constructed at: tier2-evaluator.ts:179
  Consumer 1: BuiltinPIIProvider via request.context.allowedEntityTypes — WIRED ✓
  Consumer 2: Other providers (custom-http, etc.) — IGNORED (they don't read allowedEntityTypes) — SAFE (no-op)
  Null-handling: builtin-pii.ts:38-39 — `allow && allow.length > 0 ? new Set(...) : null`; null → no filter (all detections pass through) — CORRECT for backward compat
```

```
DEPENDENCY: piiRecognizerRegistry
  Constructed at: tier2-evaluator.ts:178 via options or context
  Consumer 1: BuiltinPIIProvider via request.context.piiRecognizerRegistry — WIRED ✓
  Null-handling: pii-detector.ts falls back to default registry
```

#### 8. Parallel Paths

| Path                                              | entities propagated?                                                                         | Verdict  |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- |
| Input guardrails (reasoning-executor.ts:~1870)    | Via pipeline → tier2 → provider chain                                                        | PARITY ✓ |
| Output guardrails (output-guardrails.ts)          | Same pipeline, same chain                                                                    | PARITY ✓ |
| kind='both' expansion (form L596-601)             | `{ ...base, kind: 'input' }` and `{ ...base, kind: 'output' }` both carry entities from base | PARITY ✓ |
| Route normalizer kind='both' expansion (L525-531) | Same spread pattern                                                                          | PARITY ✓ |

#### 9. Boundary Tests

- [x] `sensitive-data-block.e2e.test.ts` — E2E via HTTP, seeds SDB policy with entities
- [x] `guardrail-rule-validation.test.ts` — entities validation (length, type checks)
- [x] `policy-rbac.integration.test.ts` — pii-entities route RBAC
- [ ] **MISSING**: No dedicated integration test that seeds a rule with `entities: ['us_ssn']`, sends content containing both `us_ssn` AND `email`, and asserts that only `us_ssn` triggers a violation while `email` passes through. This is the INT-2 8-case matrix from the test spec. (MEDIUM — E2E-14 covers the happy path but not the negative entity exclusion case at the boundary)

---

## Chain B — presetKey Propagation (Schema → Violation → Trace)

### VALUE: presetKey (preset identifier for trace correlation + cleanup)

**DATA CLASS**: INTERNAL
**APPROVED CONSUMERS**: Trace events, cleanup script, Studio UI

#### 1. Source

- **Schema**: `packages/compiler/src/platform/ir/schema.ts:1641` — `presetKey?: string` on `Guardrail` interface
- **DB model**: `packages/database/src/models/guardrail-policy.model.ts:181` — `presetKey: { type: String, default: undefined }`
- **Entry**: Studio form sets `presetKey: 'sensitive_data_block'` in preset rules

#### 2. Writes

- MongoDB `guardrail_policies.rules[].presetKey` — string, no sensitive content
- ClickHouse `trace_events.data.presetKey` — via trace event emission (see hop 5-6)

#### 3. Serialization Boundaries

- HTTP POST/PUT body → MongoDB (persist)
- In-process: resolver → IR → tier2 violations → trace events (no serialization)
- ClickHouse trace event write (structured JSON in `data` column)

#### 4. Read Paths

- **Hop 1 — PolicyResolver**: `policy-resolver.ts:160` — `presetKey: rule.presetKey` → `Guardrail` IR. VERIFIED.
- **Hop 2 — Tier2Evaluator violation construction (4 sites)**:
  - Score violation: `tier2-evaluator.ts:271` — `presetKey: guardrail.presetKey`. VERIFIED.
  - Provider-disabled violation: `tier2-evaluator.ts:152` — `presetKey: guardrail.presetKey`. VERIFIED.
  - Provider-unregistered violation: `tier2-evaluator.ts:221` — `presetKey: guardrail.presetKey`. VERIFIED.
  - Error/catch violation: `tier2-evaluator.ts:293` — `presetKey: guardrail.presetKey`. VERIFIED.
- **Hop 3 — GuardrailViolation type**: `packages/compiler/src/platform/guardrails/types.ts:50` — `presetKey?: string`. VERIFIED.
- **Hop 4 — Output guardrails projection**: `apps/runtime/src/services/execution/output-guardrails.ts:103` — `presetKey: violation.presetKey` in `OutputGuardrailResult.violation`. VERIFIED.
- **Hop 5 — Input trace event**: `apps/runtime/src/services/execution/reasoning-executor.ts:1911` — `presetKey: primary.presetKey` in `guardrail_input_blocked` trace data. VERIFIED.
- **Hop 6 — Output trace event**: `apps/runtime/src/services/execution/reasoning-executor.ts:3493` — `presetKey: guardrailResult.violation.presetKey` in `guardrail_output_blocked` trace data. VERIFIED.

#### 5. Policy Boundary

| Consumer       | Policy                                                                                                              | Verdict |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| Trace events   | presetKey is a string constant ('sensitive_data_block'), no PII content                                             | PASS    |
| Cleanup script | Reads `presetKey` from ClickHouse via parameterized query — `{presetKey:String}` at cleanup-guardrail-traces.ts:189 | PASS    |
| Studio UI      | Reads from API response for display                                                                                 | PASS    |

#### 6. Consumers/Sinks

- ClickHouse trace events (parameterized delete query, no injection risk)
- Studio UI (display only)
- No external consumers

#### 7. Dependency Wiring

```
DEPENDENCY: presetKey field propagation
  Source: IGuardrailRule.presetKey (DB model)
  Hop 1: PolicyRule.presetKey (policy-resolver.ts:30) → toSyntheticGuardrail (L160) — WIRED ✓
  Hop 2: Guardrail.presetKey (ir/schema.ts:1641) → tier2-evaluator (4 violation sites) — WIRED ✓
  Hop 3: GuardrailViolation.presetKey (types.ts:50) → output-guardrails projection (L103) — WIRED ✓
  Hop 4: OutputGuardrailResult.violation.presetKey → reasoning-executor trace (L3493) — WIRED ✓
  Hop 5: reasoning-executor input trace (L1911) reads from primaryViolation.presetKey — WIRED ✓
```

#### 8. Parallel Paths

| Path                                                       | presetKey propagated?                        | Verdict  |
| ---------------------------------------------------------- | -------------------------------------------- | -------- |
| Input guardrails (reasoning-executor:1911)                 | `primary.presetKey`                          | PARITY ✓ |
| Output guardrails (reasoning-executor:3493)                | `guardrailResult.violation.presetKey`        | PARITY ✓ |
| 4 tier2-evaluator violation sites (L152, L221, L271, L293) | All include `presetKey: guardrail.presetKey` | PARITY ✓ |

#### 9. Boundary Tests

- [x] `sensitive-data-block.e2e.test.ts:579` — "E2E-14: SDB block carries presetKey in trace events"
- [x] `sensitive-data-block.e2e.test.ts:654-660` — trace endpoint assertion: `guardrailTrace.data?.presetKey === 'sensitive_data_block'`
- [x] `cleanup-guardrail-traces.test.ts` — cleanup script test exists

---

## Cross-Cutting Checks

### failMode default = 'open' at 3 sites

| Site                      | File                        | Line | Value              | Status                           |
| ------------------------- | --------------------------- | ---- | ------------------ | -------------------------------- |
| Mongoose schema           | `guardrail-policy.model.ts` | L214 | `default: 'open'`  | VERIFIED ✓                       |
| Route normalizer fallback | `guardrail-policies.ts`     | L169 | `... : 'open'`     | VERIFIED ✓                       |
| DEFAULT_POLICY_SETTINGS   | `guardrail-policies.ts`     | L104 | `failMode: 'open'` | VERIFIED ✓                       |
| PolicyResolver default    | `policy-resolver.ts`        | L123 | `failMode: 'open'` | VERIFIED ✓ (4th site, all agree) |

### `enabled` semantics

- Schema default: `undefined` (NOT `false`) at `guardrail-policy.model.ts:175`. CORRECT for backward compat.
- Resolver skip predicate: `rule.enabled === false` at `policy-resolver.ts:299`. Treats `undefined` as enabled. CORRECT.
- Activation gate: `r.enabled !== false` at `guardrail-policies.ts:1490`. Treats `undefined` as enabled. CORRECT.
- Auto-deactivation: `r?.enabled === false` at `guardrail-policies.ts:1350`. Only triggers on explicit `false`. CORRECT.
- Route normalizer: `rule.enabled === true || rule.enabled === false ? rule.enabled : undefined` at L510. Strips non-boolean. CORRECT.

### `pii_redaction.enabled_recognizer_packs` field name

- Read at: `apps/runtime/src/services/pii/project-pii-config.ts:143-144`
- Field name is `enabled_recognizer_packs` (NOT `.packs`). VERIFIED ✓.

### Trace event registry count

- `GUARDRAIL_TRACE_EVENT_TYPES` at `trace-event-registry.ts:167-190` contains 22 entries (including new `guardrail_activation_blocked` at L188 and `guardrail_auto_deactivation` at L189). VERIFIED ✓.

### Sanitization gate

- `validateRule()` at `packages/shared/src/validation/guardrail-rule-validation.ts:124` is reached on every POST/PUT via `validateRulesServerSide()` at `guardrail-policies.ts:604-629`. VERIFIED ✓.
- actionMessage sanitization: null-byte reject, <=500 char, HTML strip via `sanitize-html`. Sanitized value replaces raw at L612-617. VERIFIED ✓.

### Cleanup script injection safety

- `tools/cleanup-guardrail-traces.ts` uses ClickHouse parameterized queries exclusively:
  - `{presetKey:String}` at L189
  - `{tenantId:String}` at L199-200
  - `{ttlDays:UInt32}` at L190
  - `{types:Array(String)}` at L188
- `FULLY_QUALIFIED_TABLE` is a compile-time constant (L41), not user-supplied. VERIFIED ✓.

---

## Findings Summary

| ID  | Severity | Dimension                        | Finding                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | -------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | MEDIUM   | Boundary Tests (Chain A, Dim 9)  | No dedicated integration test for entity-exclusion negative case (rule allows `us_ssn` only, content contains `us_ssn` + `email`, assert email detection is filtered out). E2E-14 covers the happy path; the 8-case INT-2 matrix from the test spec is not yet implemented.                                                                                                                                                 |
| F-2 | LOW      | Consumers/Sinks (Chain A, Dim 6) | `BuiltinPIIProvider.evaluate()` returns `raw: result` (L58) containing `PIIDetectionResult` with `detections[].start`/`end` offsets. While `raw` is never forwarded to violations or traces, a future consumer of `GuardrailEvalResult.raw` could reconstruct PII positions. The `PIIDetection.value` field is safe (documented as "never contains raw substring"). Risk is theoretical — no current consumer reads `.raw`. |

### Per-Finding Detail

```
FINDING: F-1
  SEVERITY: MEDIUM
  DIMENSION: 9 — Boundary Tests
  PATH: Studio form → normalizeRules → PolicyResolver → tier2-evaluator → BuiltinPIIProvider entity filter
  EVIDENCE: No test file exercises the negative case (content has PII types NOT in entities[])
  IMPACT: If a future refactor accidentally changes the filter from `allowSet.has(d.type)` to a
          different field (e.g., `d.entityType`), the regression would not be caught by existing tests
          until the full INT-2 matrix lands.
  FIX: Implement the INT-2 8-case matrix from the test spec. Specifically: seed a rule with
       entities: ['us_ssn'], send content containing both SSN and email, assert the provider
       returns score 1.0 for SSN-only and 0.0 when only email is present.
  TEST: Integration test at the tier2-evaluator boundary with a real BuiltinPIIProvider instance.
```

```
FINDING: F-2
  SEVERITY: LOW
  DIMENSION: 5 — Policy Boundary
  PATH: BuiltinPIIProvider.evaluate() → GuardrailEvalResult.raw
  EVIDENCE: builtin-pii.ts:58 returns `raw: result` (full PIIDetectionResult).
            PIIDetection has `start`/`end` offsets.
  IMPACT: Theoretical — no current code path reads `.raw` from the eval result beyond the
          provider itself. If a future consumer logs or persists `.raw`, PII position data
          could be exposed.
  FIX: No action required for v1. Document the invariant: "GuardrailEvalResult.raw MUST NOT
       be forwarded to trace events, logs, or external sinks." Consider replacing `raw: result`
       with `raw: { hasPII: result.hasPII, detectionCount: filteredDetections.length }` in a
       future hardening pass.
  TEST: N/A for v1 — no consumer to test against.
```

---

## Field Propagation Matrix

| Field              | DB Schema    | Route Normalizer | Shared Validation       | PolicyResolver      | IR Schema              | Tier2 Violation      | Output Projection | Trace Events     |
| ------------------ | ------------ | ---------------- | ----------------------- | ------------------- | ---------------------- | -------------------- | ----------------- | ---------------- |
| entities           | Y (L172)     | Y (L504-508)     | Y (L189-197)            | Y (L159)            | Y (L1639)              | - (not in violation) | -                 | -                |
| enabled            | Y (L173-180) | Y (L509-511)     | Y (L31)                 | Y (L299 skip)       | - (runtime-only)       | -                    | -                 | -                |
| presetKey          | Y (L181)     | Y (L513-518)     | Y (L33)                 | Y (L160)            | Y (L1641)              | Y (L152,221,271,293) | Y (L103)          | Y (L1911, L3493) |
| actionMessage      | Y (L182)     | Y (L520-523)     | Y (L199-208, sanitized) | Y (L141 precedence) | - (via action.message) | -                    | -                 | -                |
| failMode           | Y (L214)     | Y (L169)         | -                       | Y (L123)            | -                      | -                    | -                 | -                |
| allowedEntityTypes | -            | -                | -                       | -                   | -                      | Y (tier2-eval L179)  | -                 | -                |

**Symbols**: Y = field handled at this layer; - = intentionally not applicable; GAP = should be here but isn't.

**No GAPs detected.**

---

## Round 1 Final Verdict

- [x] No CRITICAL findings
- [x] No HIGH findings
- [x] 1 MEDIUM finding (F-1: missing INT-2 boundary test matrix)
- [x] 1 LOW finding (F-2: theoretical `.raw` exposure)
- [x] Every path from Source to Consumer/Sink accounted for
- [x] All 4 failMode defaults agree on 'open'
- [x] `enabled` semantics consistent across all 5 sites
- [x] presetKey propagated through all 6 hops with no gaps
- [x] Entity filter uses correct field `d.type` (not `d.entityType`)
- [x] Cleanup script uses parameterized ClickHouse queries exclusively
- [x] Trace event registry count = 22 (verified)
- [x] actionMessage sanitized before persist (null-byte, length, HTML strip)

**PASS** — No CRITICAL or HIGH findings. F-1 (MEDIUM) should be addressed in Round 2 by landing the INT-2 test matrix. F-2 (LOW) is deferred to post-v1 hardening.

---

## Round 2 — Fix Verification & Boundary-Test Checklist

**Date**: 2026-05-18
**Round**: 2 (final)

### R1 Finding Verification

| ID  | R1 Severity | R2 Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1 | MEDIUM      | **RESOLVED**                 | `entity-filter.test.ts` (INT-2) has 9 cases. Case 4 (`['ssn'] + email => no violation`) covers exact negative-filter scenario: allowlist is `['ssn']`, content contains only email, asserts `score === 0.0`. Case 9 (`['us_bank_account'] + SSN+email => no violation`) proves filter is exercised not bypassed when allowlist has no matching detections, using `SSN_AND_EMAIL_CONTENT` (both SSN and email present). Together these two cases prove email detections are filtered out when the allowlist restricts to a different entity type. |
| F-2 | LOW         | **CONFIRMED LOW — deferred** | Only non-test consumer of `result.raw` is `guardrail-providers.ts:708`, which reads `raw.failedOpen` / `raw.failedClosed` booleans for health-check status. No PII data (positions, types, content) is forwarded to the HTTP response. Zero consumers of `.raw.detections` outside tests.                                                                                                                                                                                                                                                        |

### Boundary-Test Checklist (Dimension 9)

| #   | Boundary Gate                                                                         | Covered?           | File:Line                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Chain A: persist entities via HTTP POST, fetch via HTTP GET, assert round-trip        | COVERED            | `sensitive-data-block.e2e.test.ts:233` (POST `entities: ['ssn']`), `:395-397` (GET verifies rule fields survive round-trip)                                                                                              |
| 2   | Chain A: end-to-end PII detection with mocked LLM, assert entity filter               | COVERED            | `sensitive-data-block.e2e.test.ts:251` (E2E-1: sends SSN, asserts block); `entity-filter.test.ts` case 4/9 (INT-2: negative filter at provider boundary)                                                                 |
| 3   | Chain B: presetKey in trace event — input-blocked path                                | COVERED            | `sensitive-data-block.e2e.test.ts:579-660` (E2E-14: queries `guardrail_input_blocked` traces, asserts `presetKey === 'sensitive_data_block'`)                                                                            |
| 4   | Chain B: presetKey in trace event — output-blocked path                               | GAP (non-blocking) | E2E-14 only tests input-blocked path. Output-blocked presetKey is verified by code-level audit (R1 Hop 6: `reasoning-executor.ts:3493`) but no dedicated E2E seeds an output guardrail with presetKey and asserts trace. |
| 5   | failMode default: POST without failMode, GET back asserts `'open'`                    | COVERED            | `failmode-default.test.ts:150-179` (INT-10 Case 1: POST with `failMode` omitted, GET asserts `'open'`)                                                                                                                   |
| 6   | enabled legacy compat: persist rule with `enabled` absent, runtime resolves as active | COVERED            | `sensitive-data-block.e2e.test.ts:520-563` (E2E-8: POST with no `enabled` field, GET asserts `enabled === undefined`, activate succeeds — proving `enabled !== false` treats undefined as active)                        |
| 7   | Cleanup script: parameterized query test                                              | COVERED            | `tools/__tests__/cleanup-guardrail-traces.test.ts` — mocks `@clickhouse/client` (external, allowed), validates parameterized query calls                                                                                 |

### Parallel-Path Check (Dimension 8)

| Path Pair                                                | Entity Filter Applied?                                                                                                                                                                                                                                                                                  | Verdict                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Workspace-scoped vs. project-scoped guardrail routes** | Single route file `guardrail-policies.ts` mounts at both `/api/guardrail-policies` and `/api/projects/:projectId/guardrail-policies` (L9-10). Same `normalizeRules()` pipeline for both.                                                                                                                | PARITY — no divergence risk                                                                           |
| **Input vs. output guardrail trace events**              | Input: `reasoning-executor.ts:1904` emits `guardrail_input_blocked` with `presetKey`. Output: `reasoning-executor.ts:3486` emits `guardrail_output_blocked` with `presetKey`. Both read from the same `GuardrailViolation` type which carries `presetKey`.                                              | PARITY — same violation shape                                                                         |
| **Tier1 (CEL) vs. Tier2 (provider-based) entity filter** | Tier1 (`tier1-evaluator.ts`) is CEL-expression-based: binary pass/fail, no PII detection, no entity filter needed or present. Tier2 (`tier2-evaluator.ts:179`) passes `allowedEntityTypes: guardrail.entities` to providers. `BuiltinPIIProvider` is the only consumer that reads `allowedEntityTypes`. | CORRECT by design — entity filter is a Tier2/PII-only concern; Tier1 CEL checks are category-agnostic |

### Findings Delta from R1

- **F-1**: Upgraded from OPEN to **RESOLVED**. INT-2 case 4 (`['ssn'] + email => no violation`) and case 9 (`['us_bank_account'] + SSN+email => no violation`) together cover the negative-filter boundary. The R1 concern that "no test exercises content with PII types NOT in entities[]" is conclusively addressed.
- **F-2**: Remains **LOW, deferred**. The single non-test consumer (`guardrail-providers.ts:708`) reads only boolean status flags from `.raw`, not PII data.
- **NEW — Boundary-Test #4**: Output-blocked presetKey trace is verified by code audit but has no dedicated E2E test. Severity: LOW (non-blocking). The code path is structurally identical to the input path (same `GuardrailViolation` type, same field access pattern). This is a test-depth refinement for post-v1.

---

## Round 2 Final Verdict

- [x] F-1 (MEDIUM) — **RESOLVED** (INT-2 case 4 + case 9 cover negative entity filter)
- [x] F-2 (LOW) — **CONFIRMED LOW, deferred** (no PII-exposing consumer of `.raw`)
- [x] Boundary-Test Checklist: 6/7 covered, 1 LOW gap (output-blocked presetKey E2E)
- [x] Parallel-Path Check: 3/3 pairs at parity
- [x] No CRITICAL findings
- [x] No HIGH findings
- [x] No new MEDIUM or higher findings

**PASS** — Data-Flow Audit COMPLETE — feature cleared for Phase 7 Post-Impl Sync.
