# LLD: Constraint & Guardrail Design Coaching

**Feature Spec**: `docs/features/constraint-design-coaching.md`
**HLD**: `docs/specs/constraint-design-coaching.hld.md`
**Test Spec**: `docs/testing/constraint-design-coaching.md`
**Status**: IN PROGRESS
**Date**: 2026-04-05

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                    | Rationale                                                                                                                         | Alternatives Rejected                                               |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| D-1 | Three separate helper files (classify, generate, analyze) instead of one monolith                           | Each is independently testable and has a single responsibility. ~50-80 LOC each.                                                  | Single `constraint-coaching.ts` (would be 200+ LOC, harder to test) |
| D-2 | Regulation mapping as a static TypeScript constant, not a database collection                               | Only 4 regulations × ~3 rules each = ~12 entries. Doesn't justify a DB collection. Compiled into the package for instant access.  | MongoDB collection (over-engineering for 12 entries)                |
| D-3 | Generated `Constraint[]` objects use the exact IR schema from `packages/compiler/src/platform/ir/schema.ts` | Compiler validation (`validate-ir.ts`) is the source of truth. Generating IR-compatible objects ensures zero validation failures. | Custom constraint format converted later (error-prone)              |
| D-4 | ON_FAIL action selection based on a `agentRole` string parameter                                            | Simple lookup table. Agent role is determined by the specialist during topology design (supervisor, customer-facing, internal).   | LLM decides ON_FAIL actions (non-deterministic)                     |

### Key Interfaces & Types

```typescript
// apps/studio/src/lib/arch-ai/helpers/classify-data-sensitivity.ts

export type SensitivityCategory = 'payment' | 'pii' | 'health' | 'financial' | 'general';

export interface SensitivityResult {
  categories: SensitivityCategory[];
  evidence: {
    category: SensitivityCategory;
    source: 'tool_name' | 'parameter' | 'description';
    match: string;
  }[];
}

// apps/studio/src/lib/arch-ai/helpers/generate-constraints.ts

export interface ConstraintGenerationInput {
  regulations: string[];
  sensitivity: SensitivityCategory[];
  agentRole: 'customer_facing' | 'internal' | 'supervisor';
  agentName: string;
}

// Uses Constraint from packages/compiler/src/platform/ir/schema.ts as output type
```

### Module Boundaries

| Module                            | Responsibility                                                        | Depends On           |
| --------------------------------- | --------------------------------------------------------------------- | -------------------- |
| `classify-data-sensitivity.ts`    | Tool name/param/description pattern matching → sensitivity categories | None (pure function) |
| `generate-constraints.ts`         | Regulation + sensitivity + role → `Constraint[]` IR objects           | Compiler IR types    |
| `constraint-coverage-analyzer.ts` | Compare existing constraints vs required → coverage matrix            | classify + generate  |
| `analyze-constraints-tool.ts`     | Specialist-visible tool wrapping the analyzer                         | All 3 helpers        |
| `ConstraintCoverageWidget.tsx`    | Coverage matrix visualization                                         | Design tokens        |

---

## 2. File-Level Change Map

### New Files

| File                                                                      | Purpose                                             | LOC Estimate |
| ------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `apps/studio/src/lib/arch-ai/helpers/classify-data-sensitivity.ts`        | Sensitivity classification                          | ~80          |
| `apps/studio/src/lib/arch-ai/helpers/generate-constraints.ts`             | Regulation → constraint mapping + ON_FAIL selection | ~120         |
| `apps/studio/src/lib/arch-ai/helpers/constraint-coverage-analyzer.ts`     | Coverage matrix computation                         | ~80          |
| `apps/studio/src/lib/arch-ai/tools/analyze-constraints.ts`                | `analyze_constraints` specialist tool               | ~80          |
| `apps/studio/src/components/arch-v3/widgets/ConstraintCoverageWidget.tsx` | Coverage matrix UI                                  | ~100         |
| `apps/studio/src/__tests__/arch-ai/classify-data-sensitivity.test.ts`     | Unit tests                                          | ~150         |
| `apps/studio/src/__tests__/arch-ai/generate-constraints.test.ts`          | Unit tests                                          | ~200         |
| `apps/studio/src/__tests__/arch-ai/constraint-coverage-analyzer.test.ts`  | Unit tests                                          | ~100         |

### Modified Files

| File                                                         | Change Description                           | Risk                         |
| ------------------------------------------------------------ | -------------------------------------------- | ---------------------------- |
| `apps/studio/src/lib/arch-ai/tools/generate-agents.ts`       | Add post-generation constraint analysis call | Low — additive step          |
| `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx` | Render `constraint_analysis` journal events  | Low — new event type handler |

---

## 3. Implementation Phases

### Phase 1: Data Sensitivity Classifier

**Goal**: Create `classifyDataSensitivity()` that analyzes agent tools and returns sensitivity categories.

**Tasks**:
1.1. Read existing tool name patterns in the codebase (search for tool definitions in `apps/studio/src/lib/arch-ai/`)
1.2. Create `classify-data-sensitivity.ts` with:

- `TOOL_NAME_PATTERNS`: regex map of tool names → categories (`/process_payment|check_balance|refund/` → `payment`)
- `PARAMETER_PATTERNS`: parameter name → category (`/ssn|credit_card|dob/` → `pii`)
- `DESCRIPTION_KEYWORDS`: keyword → category (`/medical|diagnosis|prescription/` → `health`)
- `classifyDataSensitivity(tools: AgentTool[]): SensitivityResult`
- Dedup: if multiple patterns match same category, include once with all evidence
  1.3. Create unit tests with known tool profiles for each category

**Files Touched**:

- `apps/studio/src/lib/arch-ai/helpers/classify-data-sensitivity.ts` — NEW
- `apps/studio/src/__tests__/arch-ai/classify-data-sensitivity.test.ts` — NEW

**Exit Criteria**:

- [ ] `classifyDataSensitivity([{ name: 'process_refund' }])` returns `categories: ['payment']`
- [ ] `classifyDataSensitivity([{ name: 'get_diagnosis' }])` returns `categories: ['health']`
- [ ] `classifyDataSensitivity([{ name: 'search_faq' }])` returns `categories: ['general']`
- [ ] Multi-category: tools with both payment and PII patterns return both categories
- [ ] Unknown tools: `categories: ['general']` (no false positives)
- [ ] Evidence array includes source type and matched pattern
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: test each pattern type (name, parameter, description) and multi-category

**Rollback**: Delete 2 new files. No side effects.

---

### Phase 2: Constraint Generator

**Goal**: Create `generateConstraints()` that maps regulations + sensitivity to valid `Constraint[]` IR objects.

**Tasks**:
2.1. Read `packages/compiler/src/platform/ir/schema.ts` to verify exact `Constraint`, `ConstraintAction`, `ConstraintCheckpoint` field types
2.2. Create `generate-constraints.ts` with:

- `REGULATION_CONSTRAINT_MAP`: static mapping table (PCI-DSS, HIPAA, GDPR, SOC2)
- `selectConstraintKind(regulation, severity)` → `'require' | 'limit' | 'restrict'`
- `selectOnFailAction(agentRole)` → `ConstraintAction` with correct `type` field
- `selectGuardrailTier(pattern)` → `'local' | 'model' | 'llm'`
- `generateConstraints(input: ConstraintGenerationInput): Constraint[]`
- Dedup: same constraint condition from 2 regulations → use stricter severity
  2.3. Validate generated objects match IR schema (import types, construct valid objects)
  2.4. Create unit tests covering each regulation, role-based ON_FAIL, deduplication

**Files Touched**:

- `apps/studio/src/lib/arch-ai/helpers/generate-constraints.ts` — NEW
- `apps/studio/src/__tests__/arch-ai/generate-constraints.test.ts` — NEW

**Exit Criteria**:

- [ ] `generateConstraints({ regulations: ['PCI-DSS'], sensitivity: ['payment'], agentRole: 'customer_facing' })` returns `Constraint[]` with credit card guard, `on_fail.type === 'respond'`
- [ ] Same call with `agentRole: 'internal'` returns `on_fail.type === 'block'`
- [ ] HIPAA generates model-tier guardrail reference
- [ ] Generated `Constraint` objects have all required fields: `condition`, `on_fail`, `severity`, `kind`
- [ ] Multi-regulation (PCI-DSS + GDPR) produces no duplicate constraints
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: regulation mapping, ON_FAIL selection, deduplication
- Integration: import `Constraint` type from compiler, verify type compatibility

**Rollback**: Delete 2 new files. No side effects.

---

### Phase 3: Coverage Analyzer + BUILD Integration

**Goal**: Create coverage analysis and wire constraint coaching into the BUILD flow.

**Tasks**:
3.1. Create `constraint-coverage-analyzer.ts`:

- `analyzeConstraintCoverage(agents: AgentWithConstraints[], regulations: string[]): CoverageMatrix`
- Per-agent, per-regulation status: `covered` (constraint exists), `partial` (some evaluation kinds missing), `missing` (no constraint), `n/a` (no sensitive data)
- Generate gap descriptions with actionable fix suggestions
  3.2. Wire into `generateSingleAgent()` in `tools/generate-agents.ts`:
- After agent ABL is generated and compiled, call `classifyDataSensitivity()` on the agent's tools
- If sensitive data detected AND project has compliance tags, call `generateConstraints()`
- Inject generated CONSTRAINTS into the ABL before final output
- Emit `constraint_analysis` journal event
  3.3. Create unit tests for coverage matrix computation

**Files Touched**:

- `apps/studio/src/lib/arch-ai/helpers/constraint-coverage-analyzer.ts` — NEW
- `apps/studio/src/__tests__/arch-ai/constraint-coverage-analyzer.test.ts` — NEW
- `apps/studio/src/lib/arch-ai/tools/generate-agents.ts` — add constraint analysis step
- `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx` — render new event

**Exit Criteria**:

- [ ] Coverage matrix correctly identifies: agent with PCI-DSS constraint as `covered`, agent missing HIPAA as `missing`, agent with partial coverage as `partial`
- [ ] BUILD flow with PCI-DSS project auto-generates constraints for payment agents
- [ ] BUILD flow with no compliance tags does NOT generate constraints (no false alarms)
- [ ] `constraint_analysis` journal events persisted
- [ ] JournalPanel renders constraint analysis entries
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: coverage matrix computation with known states
- Integration: real `generateSingleAgent()` flow with compliance tags

**Rollback**: Remove constraint analysis step from `generate-agents.ts`. Delete new helper files. Agent generation works as before.

---

### Phase 4: IN_PROJECT Tool + Widget

**Goal**: Expose `analyze_constraints` as a specialist-visible tool for on-demand constraint analysis.

**Tasks**:
4.1. Create `tools/analyze-constraints.ts`:

- Tool schema: `{ agentName: z.string().min(1) }` (or "all")
- Execute: read project agents, run classify + coverage analysis, return matrix
  4.2. Register tool in IN_PROJECT tool set
  4.3. Create `ConstraintCoverageWidget.tsx`:
- Matrix table: rows = agents, columns = regulations, cells = covered/partial/missing
- Color-coded: green (covered), yellow (partial), red (missing)
- "Fix" button per gap row (triggers constraint generation → agent modification)
  4.4. Register widget in chat message renderer

**Files Touched**:

- `apps/studio/src/lib/arch-ai/tools/analyze-constraints.ts` — NEW
- `apps/studio/src/components/arch-v3/widgets/ConstraintCoverageWidget.tsx` — NEW
- Tool registration file
- Widget renderer

**Exit Criteria**:

- [ ] `analyze_constraints` tool callable by specialist in IN_PROJECT
- [ ] Tool returns coverage matrix with correct status per agent × regulation
- [ ] Widget renders matrix with semantic color tokens (not hardcoded colors)
- [ ] "Fix" button generates and applies missing constraints
- [ ] `pnpm build --filter=studio` succeeds

**Test Strategy**:

- Unit: widget rendering with mock coverage data
- Integration: tool invocation with real project data

**Rollback**: Delete new tool and widget. Unregister from tool set.

---

## 4. Wiring Checklist

- [ ] `classifyDataSensitivity` imported in `generate-agents.ts`
- [ ] `generateConstraints` imported in `generate-agents.ts`
- [ ] `analyzeConstraintCoverage` imported in `analyze-constraints` tool
- [ ] `analyze_constraints` tool registered in IN_PROJECT tool set
- [ ] `ConstraintCoverageWidget` imported in chat message widget renderer
- [ ] `constraint_analysis` event type handled in JournalPanel
- [ ] `SensitivityCategory` and `SensitivityResult` types exported from helper

---

## 5. Cross-Phase Concerns

### Database Migrations

None.

### Feature Flags

| Flag                              | Default | Description                                     |
| --------------------------------- | ------- | ----------------------------------------------- |
| `arch.constraintCoaching.enabled` | `true`  | Skip constraint analysis in BUILD when disabled |

### Configuration Changes

No new env vars. Regulation mapping is a static constant.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 4 phases complete with exit criteria met
- [ ] PCI-DSS project BUILD → payment agents get credit card constraints automatically
- [ ] HIPAA project BUILD → health agents get PII detection constraints
- [ ] No-compliance project BUILD → no constraints generated (no false alarms)
- [ ] IN_PROJECT "check constraints" → coverage matrix widget with correct status
- [ ] "Fix" action applies valid constraints that pass compiler validation
- [ ] Customer-facing agents get escalate/respond ON_FAIL, internal agents get block/redact
- [ ] Existing tests pass (no regression)
- [ ] `pnpm build` succeeds for all affected packages

---

## 7. Open Questions

1. Should constraints be injected BEFORE or AFTER the compile-and-fix loop in `generateSingleAgent()`? Before = compiler validates them. After = they bypass validation.
2. How to determine `agentRole` (customer_facing vs internal) — is this in the topology node metadata or inferred from agent type?
