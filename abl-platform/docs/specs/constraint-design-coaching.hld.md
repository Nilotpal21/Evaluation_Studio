# HLD: Constraint & Guardrail Design Coaching

**Feature Spec**: `docs/features/constraint-design-coaching.md`
**Test Spec**: `docs/testing/constraint-design-coaching.md`
**Status**: APPROVED
**Author**: Sri Harsha
**Date**: 2026-04-05

---

## 1. Problem Statement

The Governance specialist (S2-F13) validates compliance requirements but doesn't design constraints. Developers deploy agents handling sensitive data (payment, health, PII) without appropriate ABL CONSTRAINTS sections. The gap is discovered in production — regulatory fines, data breaches, broken trust. No tooling exists to classify agent tool sensitivity, map regulations to concrete constraints, or analyze constraint coverage across a topology.

---

## 2. Alternatives Considered

### Option A: Internal helper functions + prompt enhancement

- **Description**: Create 3 new helper functions (`classifyDataSensitivity`, `generateConstraints`, `analyzeConstraintCoverage`) called during BUILD and via a specialist-visible tool in IN_PROJECT. Enhance the Governance specialist prompt to use these helpers.
- **Pros**: Follows the same pattern as `getModelRecommendation()` and `getRelevantConstructs()`. No new services. Deterministic constraint generation passes compiler validation. Minimal blast radius.
- **Cons**: Growing helper count in `arch-ai/helpers/`. Regulation mappings are hardcoded (4 regulations).
- **Effort**: S

### Option B: LLM-driven constraint generation

- **Description**: Give the Governance specialist the full guardrail documentation and let it reason about which constraints to add per agent.
- **Pros**: Handles edge cases and novel regulations. More natural constraint descriptions.
- **Cons**: Non-deterministic — may generate invalid ABL. Can't guarantee compiler validation pass. Expensive per-agent. Regulation mapping accuracy depends on prompt quality. Can't enforce coverage matrix deterministically.
- **Effort**: M

### Option C: Separate constraint recommendation service

- **Description**: New `POST /api/constraint-analysis` endpoint with its own data model for regulation mappings, sensitivity patterns, and constraint templates.
- **Pros**: Clean separation. Reusable outside Arch. Could become a platform-wide compliance tool.
- **Cons**: Over-engineering for design-time analysis. Adds deployment complexity. Regulation mappings are small (4 regulations × ~3 rules each = ~12 entries) — doesn't justify a service.
- **Effort**: L

### Recommendation: Option A (Internal helpers + prompt enhancement)

**Rationale**: Constraint generation is a deterministic mapping problem — regulation + sensitivity + role → concrete `Constraint[]` objects. The compiler already validates the IR schema. Helpers keep it testable and composable. The Governance specialist prompt gets enhanced to use these helpers, same pattern as the staged pipeline design.

---

## 3. Architecture

### System Context Diagram

```
┌──────────────────────────────────────────────────────────┐
│                     Studio (Next.js)                      │
│                                                           │
│  ┌─────────────────┐     ┌───────────────────────────┐   │
│  │ generateSingle   │────>│ classifyDataSensitivity() │   │
│  │ Agent() — BUILD  │     │  ├── tool name patterns    │   │
│  └─────────────────┘     │  ├── parameter inspection   │   │
│                           │  └── description keywords   │   │
│                           └──────────┬────────────────┘   │
│                                      │                    │
│                           ┌──────────▼────────────────┐   │
│                           │ generateConstraints()      │   │
│                           │  ├── regulation mapping     │   │
│                           │  ├── constraint kind select │   │
│                           │  ├── ON_FAIL by agent role  │   │
│                           │  └── guardrail tier assign  │   │
│                           └──────────┬────────────────┘   │
│                                      │                    │
│                           ┌──────────▼────────────────┐   │
│                           │ Compiler validate-ir.ts    │   │
│                           │  (validates Constraint[])  │   │
│                           └──────────────────────────┘   │
│                                                           │
│  IN_PROJECT:                                              │
│  ┌─────────────────┐     ┌───────────────────────────┐   │
│  │ analyze_          │────>│ analyzeConstraintCoverage()│   │
│  │ constraints tool  │     │  ├── scan existing ABL     │   │
│  └─────────────────┘     │  ├── compare vs required   │   │
│                           │  └── produce coverage matrix│   │
│                           └───────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Component Diagram

```
classify-data-sensitivity.ts (NEW)
├── classifyByToolName(tools) → SensitivityCategory[]
├── classifyByParameters(tools) → SensitivityCategory[]
├── classifyByDescription(tools) → SensitivityCategory[]
└── classifyDataSensitivity(agent) → SensitivityCategory[]

generate-constraints.ts (NEW)
├── REGULATION_CONSTRAINT_MAP: Record<Regulation, ConstraintTemplate[]>
├── selectConstraintKind(regulation, pattern) → 'require' | 'limit' | 'restrict'
├── selectOnFailAction(agentRole, regulation) → ConstraintAction
├── selectGuardrailTier(pattern) → 'local' | 'model' | 'llm'
└── generateConstraints(config) → Constraint[]

constraint-coverage-analyzer.ts (NEW)
├── parseExistingConstraints(abl) → ExistingConstraint[]
├── computeCoverage(existing, required) → CoverageMatrix
└── generateGapDescriptions(matrix) → GapDescription[]

ConstraintCoverageWidget.tsx (NEW)
└── Renders agent × regulation matrix with covered/partial/missing status
```

### Data Flow

**BUILD phase:**

1. `generateSingleAgent()` produces ABL for an agent
2. `classifyDataSensitivity(agent.tools)` → determines sensitivity categories
3. Cross-reference with project spec compliance requirements
4. `generateConstraints({ regulations, sensitivity, agentRole })` → `Constraint[]`
5. Inject constraints into ABL CONSTRAINTS section
6. Compiler validates the full IR (including new constraints)
7. Journal event `constraint_analysis` persisted

**IN_PROJECT mode:**

1. User asks "check my constraints"
2. Specialist calls `analyze_constraints` tool
3. Tool reads all project agents, runs `classifyDataSensitivity` on each
4. `analyzeConstraintCoverage()` compares existing constraints vs required
5. Returns coverage matrix → rendered as `ConstraintCoverageWidget`
6. User clicks "Fix" → generates missing constraints → applies via IP-F01

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                              |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Constraint analysis uses only the current project's agents and the project specification's compliance tags. No cross-tenant or cross-project data access. Coverage matrix scoped to `projectId`.                                             |
| 2   | **Data Access Pattern** | No database access in helpers. Agent data read from project store (already loaded). Regulation mappings are static constants. Compiler imported as a package dependency.                                                                     |
| 3   | **API Contract**        | No new endpoints. `analyze_constraints` tool: `{ agentName: string \| 'all' }` → `{ coverageMatrix, gaps, suggestedConstraints }`. Generated `Constraint[]` objects match `packages/compiler/src/platform/ir/schema.ts` exactly.             |
| 4   | **Security Surface**    | No sensitive data in constraint output — only tool names, regulation codes, constraint templates. No user-supplied regex or evaluation logic (regulation mappings are built-in). All generated constraints validated by compiler before use. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                           |
| --- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Sensitivity classification failure → skip constraint suggestions, log warning, continue BUILD. Constraint generation failure → log error, don't inject constraints. Compiler validation failure → retry with simplified constraint (remove optional fields), log the validation error. Never block BUILD. |
| 6   | **Failure Modes** | Unknown tool name → classify as `general` (no false positive). Regulation not in mapping table → skip that regulation with info log. No models match the suggested guardrail tier → suggest alternative tier. Compiler rejects generated constraint → fall back to basic constraint template.             |
| 7   | **Idempotency**   | Same agent profile + same regulations → same constraints. Deterministic mapping with no randomness. Coverage analysis is a pure function of current state.                                                                                                                                                |
| 8   | **Observability** | Journal event `constraint_analysis` with sensitivity, regulations, constraint count, coverage status. `createLogger('arch-ai:constraint-coaching')`. Activity feed shows constraint generation per agent during BUILD.                                                                                    |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Classification: <10ms per agent (string matching). Constraint generation: <20ms (static mapping). Coverage matrix (10 agents × 4 regulations): <50ms. Compiler validation: <100ms. Total per-agent overhead during BUILD: <150ms.                                                                                                |
| 10  | **Migration Path**     | New helpers added to `arch-ai/helpers/`. Governance specialist prompt enhanced. `generateSingleAgent()` gains a post-generation constraint analysis step. No existing behavior changed — constraints are additive to the generated ABL.                                                                                          |
| 11  | **Rollback Plan**      | `arch.constraintCoaching.enabled = false` skips constraint analysis entirely. No data to roll back — generated constraints are part of the ABL output (regenerating agents removes them).                                                                                                                                        |
| 12  | **Test Strategy**      | Unit: sensitivity classification accuracy, regulation→constraint mapping correctness, ON_FAIL action selection. Integration: generated constraints pass real compiler `validate-ir.ts`. E2E: full BUILD with compliance-tagged project → verify constraints in ABL output and journal events. No mocking of compiler validation. |

---

## 5. Data Model

### New Collections/Tables

None.

### Modified Collections/Tables

**arch_sessions (existing)** — journal gains a new event type:

```
Journal event: constraint_analysis
Fields:
  - type: 'constraint_analysis'
  - agentName: string
  - sensitivityClassification: string[] (e.g., ['payment', 'pii'])
  - regulationsApplicable: string[] (e.g., ['PCI-DSS', 'GDPR'])
  - constraintsGenerated: number
  - coverageStatus: 'complete' | 'partial' | 'missing'
  - timestamp: Date
```

### Static Data: Regulation Mapping Table

```typescript
const REGULATION_CONSTRAINT_MAP = {
  'PCI-DSS': [
    { pattern: 'credit_card', tier: 'local', kind: 'require', severity: 'error' },
    { pattern: 'payment_output', tier: 'local', kind: 'require', severity: 'error' },
  ],
  HIPAA: [
    { pattern: 'health_data', tier: 'model', kind: 'require', severity: 'error' },
    { pattern: 'pii_health', tier: 'local+model', kind: 'require', severity: 'error' },
  ],
  GDPR: [
    { pattern: 'personal_data', tier: 'model', kind: 'limit', severity: 'warning' },
    { pattern: 'consent', tier: 'llm', kind: 'require', severity: 'error' },
  ],
  SOC2: [
    { pattern: 'access_control', tier: 'llm', kind: 'require', severity: 'error' },
    { pattern: 'audit_trail', tier: 'local', kind: 'warn', severity: 'warning' },
  ],
};
```

---

## 6. API Design

### New Endpoints

None.

### Tool Schema

```typescript
{
  name: 'analyze_constraints',
  description: 'Analyze constraint coverage for agents — identifies compliance gaps and suggests fixes',
  parameters: {
    agentName: z.string().min(1).describe('Agent name or "all" for topology-wide coverage matrix'),
  },
  returns: {
    coverageMatrix: [{ agent: string, regulation: string, status: 'covered' | 'partial' | 'missing' | 'n/a' }],
    gaps: [{ agent: string, regulation: string, description: string, suggestedFix: Constraint }],
    summary: { totalAgents: number, coveredCount: number, gapCount: number },
  }
}
```

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Journal event `constraint_analysis` records every analysis with full details
- **Rate Limiting**: Covered by existing Arch message rate limiting
- **Caching**: None needed — analysis is fast (<50ms) and inputs change between calls
- **Encryption**: No sensitive data. Constraint templates reference regulation codes, not actual customer data.

---

## 8. Dependencies

### Upstream

| Dependency                                            | Type           | Risk                                          |
| ----------------------------------------------------- | -------------- | --------------------------------------------- |
| Compiler IR schema (`Constraint`, `ConstraintAction`) | Static import  | Low — stable, well-defined types              |
| Compiler validation (`validate-ir.ts`)                | Static import  | Low — existing, tested                        |
| Guardrail tier evaluators                             | Reference only | Low — used for tier documentation, not called |
| Project spec (compliance tags)                        | Session data   | Low — already in session metadata             |

### Downstream

| Consumer                        | Impact                                          |
| ------------------------------- | ----------------------------------------------- |
| `generateSingleAgent()` (BUILD) | Post-generation constraint injection            |
| IP-F01 (Agent Modification)     | "Fix" action applies suggested constraints      |
| B07 (Stress Testing)            | Constraint testing scenarios from coverage gaps |

---

## 9. Open Questions & Decisions Needed

1. Should constraint coaching analyze all agents or only those with compliance tags in the spec?
2. How to handle agents with generic tool names (`api_call`) where sensitivity can't be determined?
3. Should generated constraints be auto-applied or always shown as suggestions requiring approval?

---

## 10. References

- Feature spec: `docs/features/constraint-design-coaching.md`
- Test spec: `docs/testing/constraint-design-coaching.md`
- Governance specialist: `docs/arch/features/S2-F13-governance-specialist.md`
- Guardrails feature: `docs/features/guardrails.md`
- Constraint IR types: `packages/compiler/src/platform/ir/schema.ts`
