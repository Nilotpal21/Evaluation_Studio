# LLD + Implementation Plan: ABL Language

**Feature**: ABL Language
**Date**: 2026-03-22
**Feature Spec**: [docs/features/abl-language.md](../features/abl-language.md)
**HLD**: [docs/specs/abl-language.hld.md](../specs/abl-language.hld.md)
**Test Spec**: [docs/testing/abl-language.md](../testing/abl-language.md)

---

## 1. Design Decisions

### Decision Log

| Decision                                                         | Rationale                                                                                                 | Alternatives Rejected                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Maintain dual-parser architecture                                | Both formats are active domain conventions. Parser rewrite risk is high.                                  | YAML-only (breaking change), grammar-based rewrite (XL effort, no functional gain)     |
| Keep compiler as pure function library                           | No database access, no network dependencies, stateless. Maximizes testability and horizontal scalability. | Service-based compiler (unnecessary complexity for a CPU-bound operation)              |
| Layer improvements on existing architecture                      | Feature is STABLE with 200+ test files passing. Improvements are additive, not structural.                | Full redesign (no production bugs warrant it)                                          |
| Focus improvements on coverage gaps, not parser/compiler rewrite | Browser-driven E2E, CEL hardening, and diagnostic improvements provide the highest ROI.                   | Parser grammar migration, incremental compilation (higher risk, lower immediate value) |

### Key Interfaces & Types (Existing -- No Changes)

```typescript
// packages/core/src/types/agent-based.ts
interface AgentBasedDocument {
  name: string;
  meta: DocumentMeta;
  // ... 30+ fields for all agent sections
}

// packages/compiler/src/platform/ir/schema.ts
interface AgentIR {
  ir_version: string;
  metadata: AgentIRMetadata;
  identity: { goal: string; persona?: string; limitations?: string[] };
  execution?: ExecutionConfig;
  tools?: ToolDefinition[];
  gather?: GatherConfig;
  flow?: FlowConfig;
  coordination?: CoordinationConfig;
  constraints?: ConstraintConfig;
  memory?: MemoryConfig;
  guardrails?: Guardrail[];
  // ... additional sections
}

interface CompilationOutput {
  agents: Record<string, AgentIR>;
  compilation_errors: CompilationError[];
  compilation_warnings: CompilationError[];
  deployment_hints?: DeploymentHints;
}

// packages/compiler/src/platform/ir/compiler.ts
function compileABLtoIR(
  documents: AgentBasedDocument[],
  options?: CompilerOptions,
): CompilationOutput;
```

### Module Boundaries

| Module                                  | Responsibility                          | Dependencies                              |
| --------------------------------------- | --------------------------------------- | ----------------------------------------- |
| `packages/core/parser`                  | Parse DSL/YAML into AST                 | `js-yaml`, `chevrotain` (supervisor only) |
| `packages/core/types`                   | AST type definitions                    | None                                      |
| `packages/compiler/platform/ir`         | AST -> IR compilation + validation      | `packages/core`, `crypto`                 |
| `packages/compiler/platform/constructs` | CEL evaluation, custom functions        | `@marcbachmann/cel-js`                    |
| `packages/language-service`             | Editor diagnostics, completions, hover  | `packages/core`, `packages/compiler`      |
| `apps/studio/api/abl`                   | HTTP API routes for compile/diagnostics | All above packages                        |

---

## 2. File-Level Change Map

### Context: This Is a STABLE Feature

ABL Language is a production-stable feature with 200+ test files passing. This LLD documents the existing architecture and identifies targeted improvement phases. No structural rewrites are planned.

### New Files

| File                                                                       | Purpose                                                        | LOC Estimate |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ |
| `packages/compiler/src/__tests__/e2e/cel-edge-cases.e2e.test.ts`           | CEL evaluator edge case E2E tests (BigInt, max length, nested) | ~200         |
| `packages/compiler/src/__tests__/e2e/multi-agent-compile.e2e.test.ts`      | Multi-agent compilation E2E with cross-references              | ~250         |
| `packages/compiler/src/__tests__/e2e/behavior-profile-compose.e2e.test.ts` | Behavior profile composition E2E                               | ~150         |
| `packages/language-service/src/__tests__/diagnostics-integration.test.ts`  | Full diagnostic pipeline integration test                      | ~200         |

### Modified Files

| File                                                         | Change Description                                                   | Risk |
| ------------------------------------------------------------ | -------------------------------------------------------------------- | ---- |
| `packages/compiler/src/platform/constructs/cel-evaluator.ts` | Add explicit edge case guards (NaN, Infinity, nested depth limit)    | Low  |
| `packages/compiler/src/platform/ir/validation-types.ts`      | Add new validation codes for CEL depth limit and config var patterns | Low  |
| `packages/compiler/src/platform/ir/compiler.ts`              | Add compilation metrics (timing per agent, total compile time)       | Low  |
| `packages/language-service/src/diagnostics.ts`               | Add diagnostic severity levels and structured output                 | Low  |
| `packages/language-service/src/completions.ts`               | Improve YAML-mode completions for flow steps                         | Low  |
| `packages/compiler/src/platform/constants.ts`                | Add CEL_MAX_NESTING_DEPTH constant                                   | Low  |

### Deleted Files

None. This is an additive improvement plan.

---

## 3. Implementation Phases

### Phase 1: CEL Evaluator Hardening

**Goal**: Harden the CEL evaluator against edge cases identified in GAP-006 and improve diagnostic coverage for expression evaluation.

**Tasks**:

1.1. Add explicit guards in `cel-evaluator.ts` for NaN, Infinity, and undefined values returned by CEL evaluation
1.2. Add a nesting depth limit (configurable via constant in `constants.ts`, default 32) to prevent stack overflow from deeply nested expressions
1.3. Add validation code `CEL_NESTING_EXCEEDED` to `validation-types.ts`
1.4. Write E2E tests for CEL edge cases: BigInt overflow boundaries, max length (4,096 bytes), deeply nested expressions, mixed-type arithmetic

**Files Touched**:

- `packages/compiler/src/platform/constructs/cel-evaluator.ts` -- add guards
- `packages/compiler/src/platform/constants.ts` -- add `CEL_MAX_NESTING_DEPTH`
- `packages/compiler/src/platform/ir/validation-types.ts` -- add new code
- `packages/compiler/src/__tests__/e2e/cel-edge-cases.e2e.test.ts` -- new test file

**Exit Criteria**:

- [ ] `cel-evaluator.ts` handles NaN, Infinity, and undefined without throwing
- [ ] Nesting depth limit is enforced at 32 levels (configurable)
- [ ] `CEL_NESTING_EXCEEDED` validation code exists in `validation-types.ts`
- [ ] E2E test file has at least 10 test cases covering edge scenarios
- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [ ] `pnpm --filter @abl/compiler test` passes with 0 failures

**Test Strategy**:

- Unit: CEL evaluator edge case tests
- E2E: Full compile pipeline with edge-case expressions

**Rollback**: Revert the 3 modified files and delete the new test file. No database changes.

---

### Phase 2: Multi-Agent Compilation E2E Coverage

**Goal**: Add E2E test coverage for multi-agent compilation scenarios including cross-agent references, supervisor composition, and behavior profile attachment.

**Tasks**:

2.1. Write multi-agent compilation E2E tests covering: 3+ agents with handoff chains, circular delegate detection, supervisor routing with intent matching
2.2. Write behavior profile composition E2E tests covering: profile definition, attachment to multiple agents, override behavior
2.3. Add cross-agent validation E2E cases: missing handoff targets across compilation boundaries, fan-out with partial agent resolution

**Files Touched**:

- `packages/compiler/src/__tests__/e2e/multi-agent-compile.e2e.test.ts` -- new file
- `packages/compiler/src/__tests__/e2e/behavior-profile-compose.e2e.test.ts` -- new file

**Exit Criteria**:

- [ ] Multi-agent E2E test file has at least 8 test cases
- [ ] Behavior profile E2E test file has at least 5 test cases
- [ ] Tests exercise real `compileABLtoIR()` with multi-document input (no mocks)
- [ ] Tests verify cross-agent validation catches broken references
- [ ] `pnpm --filter @abl/compiler test` passes with 0 failures

**Test Strategy**:

- E2E: Full multi-document compilation pipeline tests
- No mocking of codebase components

**Rollback**: Delete the 2 new test files. No source code changes.

---

### Phase 3: Compilation Metrics and Diagnostic Improvements

**Goal**: Add compilation timing metrics and improve diagnostic pipeline output for better operator visibility.

**Tasks**:

3.1. Add per-agent compilation timing to `CompilationOutput` as optional `compilation_metrics` field
3.2. Add total compile time tracking (already partially exists via timeout mechanism)
3.3. Improve diagnostic severity levels in `diagnostics.ts` -- ensure all diagnostics carry severity (error, warning, info)
3.4. Add YAML-mode completion improvements for flow step transitions
3.5. Write diagnostic integration tests

**Files Touched**:

- `packages/compiler/src/platform/ir/compiler.ts` -- add metrics collection
- `packages/compiler/src/platform/ir/schema.ts` -- add `CompilationMetrics` type
- `packages/language-service/src/diagnostics.ts` -- improve severity output
- `packages/language-service/src/completions.ts` -- YAML flow completions
- `packages/language-service/src/__tests__/diagnostics-integration.test.ts` -- new test file

**Exit Criteria**:

- [ ] `CompilationOutput` optionally includes `compilation_metrics` with per-agent timing
- [ ] `CompilationMetrics` type defined in `schema.ts`
- [ ] All diagnostics carry severity level (error, warning, info)
- [ ] YAML flow step completions suggest valid transition targets
- [ ] Diagnostic integration test file has at least 8 test cases
- [ ] `pnpm build --filter=@abl/compiler --filter=@abl/language-service` succeeds with 0 errors
- [ ] All package tests pass with 0 failures

**Test Strategy**:

- Unit: Diagnostic severity tests
- Integration: Full diagnostic pipeline tests with real DSL input

**Rollback**: Revert the 4 modified files and delete the 1 new test file. No database changes. CompilationMetrics is optional so downstream consumers are unaffected.

---

### Phase 4: Coverage Gates and Documentation

**Goal**: Address GAP-003 by establishing coverage thresholds and improving developer documentation for the ABL compilation pipeline.

**Tasks**:

4.1. Add coverage threshold configuration for `packages/core`, `packages/compiler`, and `packages/language-service` to `coverage-thresholds.json`
4.2. Ensure all 20+ validation codes in `validation-types.ts` are exercised in at least one test
4.3. Verify all 35+ CEL functions in `cel-functions.ts` have at least one test case
4.4. Update `packages/compiler/src/platform/README.md` with compilation pipeline documentation

**Files Touched**:

- `coverage-thresholds.json` -- add package-specific thresholds
- `packages/compiler/src/platform/README.md` -- update documentation

**Exit Criteria**:

- [ ] `coverage-thresholds.json` includes entries for `@abl/core`, `@abl/compiler`, `@abl/language-service`
- [ ] All 20+ validation codes referenced in at least one test file (verified by grep)
- [ ] All 35+ CEL functions referenced in at least one test file (verified by grep)
- [ ] `packages/compiler/src/platform/README.md` documents the compilation pipeline stages
- [ ] All package tests pass with 0 failures

**Test Strategy**:

- Verification: Coverage threshold validation in CI
- Audit: Grep-based verification of validation code and CEL function test coverage

**Rollback**: Revert `coverage-thresholds.json` and `README.md`. No source code changes.

---

## 4. Wiring Checklist

Since ABL Language is an existing STABLE feature with all components already wired, this checklist confirms existing wiring rather than documenting new wiring:

- [x] Parser functions exported from `packages/core/src/parser/index.ts`
- [x] Compiler function `compileABLtoIR` exported from `packages/compiler/src/platform/ir/index.ts`
- [x] Language service functions exported from `packages/language-service/src/index.ts`
- [x] Studio API routes registered at `/api/abl/*` in Next.js app router
- [x] Runtime validation route registered at `/api/projects/:projectId/validate`
- [x] Runtime versions route registered at `/api/projects/:projectId/agents/:agentId/versions`
- [x] AgentIR types exported and consumed by runtime executor
- [x] Editor store (`editor-store.ts`) wired to compile API responses

**New wiring required by this plan**:

- [ ] `CompilationMetrics` type exported from `packages/compiler/src/platform/ir/schema.ts` (Phase 3)
- [ ] `CEL_MAX_NESTING_DEPTH` constant exported from `packages/compiler/src/platform/constants.ts` (Phase 1)
- [ ] `CEL_NESTING_EXCEEDED` code exported from `packages/compiler/src/platform/ir/validation-types.ts` (Phase 1)

---

## 5. Cross-Phase Concerns

### Database Migrations

None required. ABL Language changes are library-level. The `CompilationOutput` structure changes (Phase 3: metrics) are additive and backward-compatible.

### Feature Flags

None required. All changes are additive (new constants, new tests, optional output fields) and do not change existing behavior.

### Configuration Changes

| Phase | Change                                     | Type           | Default            |
| ----- | ------------------------------------------ | -------------- | ------------------ |
| 1     | `CEL_MAX_NESTING_DEPTH` constant           | Named constant | 32                 |
| 3     | `compilation_metrics` in CompilationOutput | Optional field | undefined (opt-in) |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] E2E tests from test spec passing (7 scenarios)
- [ ] Integration tests from test spec passing (7 scenarios)
- [ ] New E2E tests added in Phases 1-2 passing (23+ test cases total)
- [ ] No regressions in existing 200+ test files
- [ ] Feature spec updated with Phase 3 metrics capability
- [ ] Coverage thresholds established for all 3 packages
- [ ] `pnpm build` succeeds across all affected packages
- [ ] All new code formatted with prettier

---

## 7. Open Questions

| #   | Question                                                      | Status  | Notes                                                                                                                       |
| --- | ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should `CompilationMetrics` be opt-in or always-on?           | DECIDED | Opt-in via compiler options to avoid performance overhead for callers that don't need it                                    |
| 2   | What nesting depth limit is appropriate for CEL?              | DECIDED | 32 levels, matching common expression language limits. Configurable for override.                                           |
| 3   | Should coverage thresholds block CI or just warn?             | OPEN    | Start with warn-only, promote to blocking after baseline is established                                                     |
| 4   | Should YAML flow completions suggest tools and gather fields? | DECIDED | Yes, completions should be contextual. Flow `call:` should suggest tool names, `gather:` should suggest gather field names. |
