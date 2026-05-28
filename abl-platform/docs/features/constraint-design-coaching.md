# Feature: Constraint & Guardrail Design Coaching

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `governance`, `agent lifecycle`, `customer experience`
**Package(s)**: `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/constraint-design-coaching.md](../testing/constraint-design-coaching.md)
**Last Updated**: 2026-04-05

---

## 1. Introduction / Overview

### Problem Statement

The Governance specialist (S2-F13) validates that a topology meets compliance requirements, but it only checks — it doesn't design. When developers build agents that handle payment data, health records, or PII, they get no guidance on:

- When to use REQUIRE vs WARN vs LIMIT constraint kinds
- What ON_FAIL action fits each scenario (escalate, block, respond, redact, handoff, retry_step, goto_step, collect_field)
- How to translate regulations (GDPR, PCI-DSS, HIPAA, SOC2) into ABL CONSTRAINTS sections
- Which agents in the topology need which constraints (coverage gaps)
- How to configure the 3-tier guardrail cascade (local regex → model classification → LLM evaluation) per agent

Developers discover constraint gaps in production — a billing agent handling credit card numbers without PCI-DSS guardrails, a healthcare agent without HIPAA-mandated PII detection. The cost of missing a constraint is regulatory fines, data breaches, and broken trust.

### Goal Statement

Enhance the Governance specialist from a "compliance checker" into a "compliance designer" that proactively analyzes each agent's tools, data sensitivity, and regulatory requirements to suggest complete CONSTRAINTS sections with appropriate constraint kinds, ON_FAIL actions, guardrail tiers, and coverage validation.

### Summary

Constraint Design Coaching extends the existing Governance specialist (S2-F13) with proactive constraint generation. During BUILD, after each agent is generated, the system scans the agent's TOOLS for sensitive data patterns (payment, PII, health, financial), cross-references with the project's compliance requirements from the specification, and suggests a complete CONSTRAINTS section with regulation-appropriate rules. In IN_PROJECT mode, developers can request a constraint coverage analysis that shows a matrix of agents × regulations → covered/missing, with one-click application of suggested constraints.

The feature builds on existing infrastructure: the ABL `Constraint`, `ConstraintAction`, `Guardrail` IR types (`packages/compiler/src/platform/ir/schema.ts`), the 3-tier guardrail evaluator (`packages/compiler/src/platform/guardrails/`), and the Governance specialist spec (`docs/arch/features/S2-F13-governance-specialist.md`).

---

## 2. Scope

### Goals

- Scan agent TOOLS for sensitive data patterns and classify data sensitivity (payment, PII, health, financial, general)
- Map regulations (PCI-DSS, HIPAA, GDPR, SOC2) to concrete ABL CONSTRAINTS with correct constraint kinds and ON_FAIL actions
- Recommend per-agent guardrail tier configuration: which evaluation kinds (input, output, tool_input, tool_output, handoff) need which tiers (local, model, LLM)
- Generate complete CONSTRAINTS sections ready to inject into ABL agent definitions
- Validate constraint coverage: identify agents that handle sensitive data but lack appropriate constraints
- Provide constraint coverage matrix visualization (agent × regulation → covered/missing/partial)
- Recommend ON_FAIL action strategies based on agent role: customer-facing agents should escalate/respond, internal agents can block/redact
- Support both BUILD phase (automatic) and IN_PROJECT mode (on-demand analysis)

### Non-Goals (Out of Scope)

- Runtime guardrail evaluation or enforcement — that's the Guardrails feature
- Guardrail provider configuration (registering OpenAI Moderation, custom HTTP endpoints) — that's Admin/Model Hub
- Cross-tenant shared compliance templates — each tenant manages independently
- Automated compliance certification or audit reporting — this is design-time guidance only
- Custom regulation definitions — only built-in regulation mappings (PCI-DSS, HIPAA, GDPR, SOC2)

---

## 3. User Stories

1. As an **agent developer**, I want Arch to automatically add appropriate CONSTRAINTS to each agent during BUILD so that I don't accidentally deploy agents without compliance guardrails.
2. As an **agent developer**, I want to ask Arch "what constraints does the billing agent need?" and receive a regulation-mapped constraint recommendation with ready-to-apply ABL.
3. As a **project owner**, I want a constraint coverage matrix showing which agents have which compliance constraints so that I can verify complete coverage before deployment.
4. As an **agent developer**, I want ON_FAIL action recommendations based on my agent's role (customer-facing vs internal) so that violations are handled appropriately without breaking the user experience.
5. As a **compliance officer**, I want to verify that all data-sensitive agents have regulation-mandated guardrails (PCI-DSS for payment, HIPAA for health) before the project exits BUILD.

---

## 4. Functional Requirements

1. **FR-1**: The system must scan each agent's TOOLS section and classify data sensitivity into categories: `payment` (credit cards, bank accounts), `pii` (names, addresses, SSN, phone), `health` (medical records, diagnoses, prescriptions), `financial` (transactions, balances, tax), `general` (no sensitive data detected).
2. **FR-2**: The system must map compliance requirements from the project specification to concrete ABL CONSTRAINTS configurations using the following regulation → constraint mappings:
   - PCI-DSS → credit card regex guard (local tier), payment tool output redaction, encryption-at-rest verification
   - HIPAA → PII detection (model tier), health data access logging, minimum-necessary constraint
   - GDPR → data minimization constraint, consent verification, right-to-erasure tool guard
   - SOC2 → access control verification, audit trail constraint, session timeout enforcement
3. **FR-3**: The system must recommend constraint kinds (`require`, `limit`, `restrict`) based on the regulation severity: hard regulatory mandates use `require` (severity: error), best-practice guidelines use `limit` (severity: warning).
4. **FR-4**: The system must recommend ON_FAIL actions based on agent role:
   - Customer-facing agents: `respond` (explain the issue), `escalate` (route to human), `collect_field` (ask for compliant alternative)
   - Internal/backend agents: `block` (stop execution), `redact` (remove sensitive data), `retry_step` (attempt with sanitized input)
   - Supervisor agents: `handoff` (route to compliant specialist), `goto_step` (backtrack to safe point)
5. **FR-5**: The system must generate a constraint coverage matrix showing each agent against each applicable regulation with coverage status: `covered` (constraint exists and matches), `partial` (constraint exists but incomplete), `missing` (no constraint for required regulation).
6. **FR-6**: The system must recommend guardrail tier configuration per evaluation kind: local (regex) for known patterns (SSN, credit card), model (NLI) for content classification (PII, toxicity), LLM for semantic policy enforcement (topic drift, factual grounding).
7. **FR-7**: The system must generate complete, valid ABL CONSTRAINTS sections that pass compiler validation, including `condition`, `on_fail`, `severity`, `kind`, `applies_when`, and `checkpoint` fields.
8. **FR-8**: The system must expose a specialist-visible `analyze_constraints` tool in IN_PROJECT mode that accepts an agent name (or "all") and returns constraint analysis with recommendations.
9. **FR-9**: The system must validate that generated constraints are compatible with the 3-tier guardrail cascade — e.g., a constraint requiring model-tier evaluation must reference a registered guardrail provider.
10. **FR-10**: The system must integrate with the BUILD phase activity feed (B05) to show constraint generation progress: "Adding PCI-DSS constraints to billing_agent: 3 rules, 1 guardrail."

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                          |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Affects project compliance posture                             |
| Agent lifecycle            | PRIMARY      | Core to agent design — every agent gets constraint analysis    |
| Customer experience        | SECONDARY    | Better constraints → fewer compliance violations in production |
| Integrations / channels    | NONE         | Constraints are channel-agnostic                               |
| Observability / tracing    | SECONDARY    | Constraint events in session journal for audit trail           |
| Governance / controls      | PRIMARY      | This IS the governance design feature                          |
| Enterprise / compliance    | PRIMARY      | Directly addresses enterprise compliance requirements          |
| Admin / operator workflows | NONE         | Guardrail provider setup is Admin, not this feature            |

### Related Feature Integration Matrix

| Related Feature                             | Relationship Type | Why It Matters                                                | Key Touchpoints                                        | Current State                  |
| ------------------------------------------- | ----------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------ |
| [Guardrails](guardrails.md)                 | depends on        | Provides the runtime guardrail cascade and evaluation kinds   | `Constraint`, `Guardrail`, `ConstraintAction` IR types | BETA — full 3-tier pipeline    |
| [PII Detection](pii-detection.md)           | shares data with  | PII patterns feed into data sensitivity classification        | PII regex patterns, detection categories               | BETA — pattern library exists  |
| [Arch AI Assistant](arch-ai-assistant.md)   | extends           | B23 enhances the Governance specialist within the Arch system | S2-F13 spec, specialist routing, tool registry         | BETA — specialist spec exists  |
| [ABL Language](abl-language.md)             | depends on        | CONSTRAINTS is an ABL construct — generated ABL must be valid | `ConstraintConfig`, compiler validation                | STABLE — constraint IR defined |
| [Audit Logging](audit-logging.md)           | emits into        | Constraint recommendations create audit-worthy events         | Session journal, compliance audit trail                | ALPHA — logging infrastructure |
| [Encryption at Rest](encryption-at-rest.md) | shares data with  | PCI-DSS constraints reference encryption requirements         | DEK encryption status, at-rest encryption verification | BETA — encryption exists       |

---

## 6. Design Considerations

### UX Patterns

**BUILD phase (automatic):** After each agent is generated and compiled, the constraint analyzer runs:

```
⚙️ Analyzing billing_agent constraints...
  🔍 Detected: payment data (process_refund, check_balance tools)
  🛡️ PCI-DSS: Adding credit card regex guard (local tier)
  🛡️ PCI-DSS: Adding payment tool output redaction
  🛡️ CONSTRAINTS: 3 rules added (2 REQUIRE, 1 WARN)
  ✅ Constraint analysis complete
```

**IN_PROJECT mode (on-demand):** Developer asks "check my constraints" → coverage matrix widget:

```
┌─────────────────────────────────────────────────────────────┐
│  Constraint Coverage Matrix                                 │
│                                                             │
│              PCI-DSS   HIPAA    GDPR     SOC2               │
│  triage      —         —        ✅        ✅                 │
│  billing     ✅        —        ✅        ✅                 │
│  health      —         ⚠️ PARTIAL ✅      ✅                 │
│  escalation  —         —        ✅        ✅                 │
│                                                             │
│  ⚠️ health_agent: HIPAA requires PII detection guard        │
│     but only input evaluation is configured (missing output) │
│                                                             │
│  [Fix All Gaps]  [Fix health_agent]  [View Details]         │
└─────────────────────────────────────────────────────────────┘
```

### Regulation → Constraint Mapping Reference

| Regulation | Data Pattern           | Constraint Kind | ON_FAIL (Customer) | ON_FAIL (Internal) | Guardrail Tier |
| ---------- | ---------------------- | --------------- | ------------------ | ------------------ | -------------- |
| PCI-DSS    | Credit card numbers    | require         | respond + redact   | block + redact     | local (regex)  |
| PCI-DSS    | Payment tool outputs   | require         | redact             | block              | local (regex)  |
| HIPAA      | Medical records / PHI  | require         | respond + escalate | block              | model (NLI)    |
| HIPAA      | PII in health context  | require         | redact             | redact             | local + model  |
| GDPR       | Personal data handling | limit           | respond            | block              | model (NLI)    |
| GDPR       | Consent verification   | require         | collect_field      | block              | LLM            |
| SOC2       | Access control         | require         | escalate           | block              | LLM            |
| SOC2       | Audit trail            | warn            | respond            | respond            | local          |

---

## 7. Technical Considerations

### Architecture Decision: Prompt Enhancement, Not New Service

B23 is implemented as an enhancement to the Governance specialist's prompt and a new internal helper function — not a new microservice or API endpoint. The constraint analysis runs within the existing `generateSingleAgent()` flow, similar to how `getModelRecommendation()` and `getRelevantConstructs()` work.

### Data Sensitivity Classification

A new `classifyDataSensitivity()` helper analyzes agent TOOLS definitions:

- Pattern matching on tool names: `process_payment`, `lookup_order`, `check_balance` → `payment`
- Parameter inspection: tool parameters named `ssn`, `credit_card`, `dob` → `pii`
- Description analysis: tool descriptions mentioning "medical", "diagnosis", "prescription" → `health`
- Falls back to `general` when no sensitive patterns detected

### Compiler Validation

All generated CONSTRAINTS must pass the existing compiler validation (`validate-ir.ts`). The helper generates `Constraint` objects matching the IR schema exactly — `condition`, `on_fail` (with proper `ConstraintAction` type), `severity`, `kind`, and optional `checkpoint`.

---

## 8. How to Consume

### Studio UI

- **BUILD phase**: Automatic constraint analysis after each agent generation. Results shown in activity feed.
- **IN_PROJECT mode**: "Check constraints" or "What constraints for X?" → coverage matrix widget.
- **Routes**: No new routes — uses existing `POST /api/arch-ai/message` with `analyze_constraints` tool.

### API (Runtime)

No new runtime endpoints. Constraint data is generated client-side (in Studio) and applied to ABL agent definitions.

| Method | Path | Purpose          |
| ------ | ---- | ---------------- |
| N/A    | N/A  | No new endpoints |

### API (Studio)

No new Studio API routes. The `analyze_constraints` tool runs within the Arch AI message processing pipeline.

### Admin Portal

N/A — guardrail provider registration is handled by the existing Guardrails admin UI.

### Channel / SDK / Voice / A2A / MCP Integration

Not applicable — this is a design-time feature. The constraints it generates are enforced at runtime by the existing Guardrails pipeline.

---

## 9. Data Model

### Collections / Tables

No new collections. B23 uses existing data:

```text
Collection: arch_sessions (existing — session journal)
  Extended with: constraint_analysis journal event type
  Fields (new event):
    - type: 'constraint_analysis'
    - agentName: string
    - sensitivityClassification: string[]
    - regulationsApplicable: string[]
    - constraintsGenerated: number
    - coverageStatus: 'complete' | 'partial' | 'missing'
    - timestamp: Date
```

The generated CONSTRAINTS sections are part of the ABL agent definition, stored in the project's agent files — no separate persistence needed.

### Key Relationships

- Project specification → compliance requirements (PCI-DSS, HIPAA, GDPR, SOC2)
- Agent TOOLS → data sensitivity classification
- `Constraint` / `Guardrail` IR types → generated constraint output format
- Session journal → persists constraint analysis events

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                  | Purpose                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/studio/src/lib/arch-ai/helpers/classify-data-sensitivity.ts`    | NEW — scan agent TOOLS for sensitive data patterns            |
| `apps/studio/src/lib/arch-ai/helpers/generate-constraints.ts`         | NEW — regulation → ABL CONSTRAINTS mapper                     |
| `apps/studio/src/lib/arch-ai/helpers/constraint-coverage-analyzer.ts` | NEW — coverage matrix computation                             |
| `packages/compiler/src/platform/ir/schema.ts`                         | READ — `Constraint`, `ConstraintAction`, `Guardrail` IR types |
| `packages/compiler/src/platform/guardrails/tier1-evaluator.ts`        | READ — local tier guardrail patterns (regex)                  |

### Routes / Handlers

| File | Purpose                                              |
| ---- | ---------------------------------------------------- |
| N/A  | No new routes — runs within Arch AI message pipeline |

### UI Components

| File                                                                      | Purpose                                     |
| ------------------------------------------------------------------------- | ------------------------------------------- |
| `apps/studio/src/components/arch-v3/widgets/ConstraintCoverageWidget.tsx` | NEW — coverage matrix visualization         |
| `apps/studio/src/components/arch-v3/panels/JournalPanel.tsx`              | ENHANCE — render constraint_analysis events |

### Jobs / Workers / Background Processes

N/A — all analysis is synchronous within the Arch message processing flow.

### Tests

| File                                                                     | Type        | Coverage Focus                                   |
| ------------------------------------------------------------------------ | ----------- | ------------------------------------------------ |
| `apps/studio/src/__tests__/arch-ai/classify-data-sensitivity.test.ts`    | unit        | Tool pattern classification                      |
| `apps/studio/src/__tests__/arch-ai/generate-constraints.test.ts`         | unit        | Regulation → constraint mapping, ON_FAIL actions |
| `apps/studio/src/__tests__/arch-ai/constraint-coverage-analyzer.test.ts` | unit        | Coverage matrix computation                      |
| TBD                                                                      | integration | End-to-end constraint analysis with compiler     |
| TBD                                                                      | e2e         | Full BUILD + IN_PROJECT constraint coaching flow |

---

## 11. Configuration

### Environment Variables

No new environment variables.

### Runtime Configuration

| Setting                             | Default | Description                                           |
| ----------------------------------- | ------- | ----------------------------------------------------- |
| `arch.constraintCoaching.enabled`   | `true`  | Enable/disable automatic constraint analysis in BUILD |
| `arch.constraintCoaching.autoApply` | `false` | Auto-apply suggested constraints without review gate  |

### DSL / Agent IR / Schema

Generated constraints use the existing ABL CONSTRAINTS syntax:

```yaml
CONSTRAINTS:
  - REQUIRE credit_card_guard
    WHEN handling_payment
    ON_FAIL:
      respond: "I cannot process credit card numbers directly. Let me route you to our secure payment system."
      collect:
        - payment_method
      then: continue

  - REQUIRE pii_detection
    CHECKPOINT: BEFORE response
    ON_FAIL:
      redact: true
      respond: "I've removed sensitive information from my response for your protection."
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Constraint analysis is scoped to the current project's agent topology and specification. No cross-project leakage. |
| Tenant isolation  | Compliance requirements come from the tenant's project specification. No cross-tenant data access.                 |
| User isolation    | Session journal events are user-scoped within the Arch session. N/A for broader user isolation.                    |

### Security & Compliance

- Constraint analysis never accesses actual customer data — it analyzes agent TOOL definitions (metadata only)
- Generated ABL CONSTRAINTS are validated by the compiler before application
- Regulation mappings are built-in and auditable — no user-supplied regex or evaluation logic
- Constraint analysis events in the session journal provide an audit trail for compliance reviews

### Performance & Scalability

- Data sensitivity classification is O(T) where T = number of tools per agent — typically 1-10, sub-millisecond
- Regulation mapping is a static lookup — O(R) where R = number of regulations, typically 1-4
- Coverage matrix computation is O(A × R) where A = agents, R = regulations — typically <20 agents × 4 regulations
- No external API calls during analysis — all logic is in-memory

### Reliability & Failure Modes

- If sensitivity classification fails: skip constraint suggestions, log warning, continue BUILD normally
- If generated constraints fail compiler validation: retry with simplified constraint, log the validation error
- Constraint coaching is advisory — it never blocks agent generation or BUILD completion
- Degraded mode: if the coverage analyzer encounters an unknown tool pattern, classify as `general` and skip

### Observability

- Journal events: `constraint_analysis` with agent name, classifications, regulations, coverage status
- Activity feed: constraint progress shown in real-time during BUILD
- Logging: `createLogger('arch-ai:constraint-coaching')` for debug-level traces

### Data Lifecycle

- Session journal events follow existing Arch session retention policy
- No new persistent data outside the session — all analysis is ephemeral
- Regulation mappings are compiled into the package — no runtime data lifecycle concerns

---

## 13. Delivery Plan / Work Breakdown

1. **Data sensitivity classifier**
   1.1 Create `classifyDataSensitivity()` helper with tool name pattern matching
   1.2 Add tool parameter name inspection (ssn, credit_card, dob, etc.)
   1.3 Add tool description keyword analysis for domain detection
   1.4 Unit tests for all sensitivity categories

2. **Regulation → constraint mapper**
   2.1 Define regulation-to-constraint mapping tables (PCI-DSS, HIPAA, GDPR, SOC2)
   2.2 Implement `generateConstraints()` that produces valid `Constraint[]` IR objects
   2.3 Add ON_FAIL action selection based on agent role (customer-facing vs internal)
   2.4 Add guardrail tier recommendation per evaluation kind
   2.5 Validate all generated constraints pass compiler validation

3. **Coverage analyzer**
   3.1 Implement `analyzeConstraintCoverage()` that compares existing constraints against required
   3.2 Produce coverage matrix: agent × regulation → covered/partial/missing
   3.3 Generate actionable gap descriptions with fix suggestions

4. **BUILD phase integration**
   4.1 Wire `classifyDataSensitivity()` + `generateConstraints()` into `generateSingleAgent()` flow
   4.2 Inject generated CONSTRAINTS into ABL before compilation
   4.3 Add activity feed events for constraint generation progress

5. **IN_PROJECT mode tool**
   5.1 Register `analyze_constraints` specialist-visible tool
   5.2 Create `ConstraintCoverageWidget.tsx` for matrix visualization
   5.3 Add "Fix" action button that applies suggested constraints via IP-F01

6. **Journal integration**
   6.1 Define `constraint_analysis` journal event type
   6.2 Persist analysis events in session journal
   6.3 Render events in JournalPanel

---

## 14. Success Metrics

| Metric                                   | Baseline         | Target              | How Measured                                                |
| ---------------------------------------- | ---------------- | ------------------- | ----------------------------------------------------------- |
| Agents with compliance constraints       | Manual (ad-hoc)  | 100% auto-suggested | Count agents with generated CONSTRAINTS in BUILD            |
| Constraint coverage gaps at deployment   | Unknown          | <5% missing         | Coverage matrix: missing / total required                   |
| Time to add compliance constraints       | Manual (~10 min) | Automatic (<2s)     | BUILD phase: automatic; IN_PROJECT: tool response time      |
| Constraint compiler validation pass rate | N/A              | >95%                | Generated constraints that pass `validate-ir.ts`            |
| Regulation mapping accuracy              | N/A              | >90%                | Correct constraint type for detected sensitive data pattern |

---

## 15. Open Questions

1. Should B23 generate constraints only for agents with compliance tags in the specification, or proactively analyze all agents for sensitive data patterns regardless?
2. How should the system handle agents that use generic tool names (e.g., `api_call`) where data sensitivity can't be determined from the name alone?
3. Should generated constraints be applied automatically during BUILD, or always shown as suggestions requiring explicit approval (review gate)?
4. Should B23 provide regulation-specific test scenarios (e.g., "send a credit card number and verify it's blocked") alongside the constraints?
5. How should constraint coaching interact with tenant-level guardrail provider availability? If the tenant hasn't registered a model-tier provider, should B23 suggest model-tier guardrails?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                     | Severity | Status |
| ------- | ----------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Governance specialist (S2-F13) only checks, doesn't design — needs prompt enhancement           | High     | Open   |
| GAP-002 | No data sensitivity classification exists for agent TOOLS — new capability needed               | High     | Open   |
| GAP-003 | Regulation → constraint mappings are hardcoded for 4 regulations — no custom regulation support | Medium   | Open   |
| GAP-004 | Tool name pattern matching may produce false positives/negatives for generic tool names         | Medium   | Open   |
| GAP-005 | No integration with tenant guardrail provider availability — may suggest unavailable tiers      | Medium   | Open   |
| GAP-006 | Coverage matrix is snapshot-only — no persistent tracking of coverage over time                 | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                  | Coverage Type | Status     | Test File / Note                     |
| --- | ------------------------------------------------------------------------- | ------------- | ---------- | ------------------------------------ |
| 1   | Payment tool detected → PCI-DSS constraints generated                     | unit          | NOT TESTED | classify-data-sensitivity.test.ts    |
| 2   | Health tool detected → HIPAA constraints generated                        | unit          | NOT TESTED | generate-constraints.test.ts         |
| 3   | Customer-facing agent → escalate/respond ON_FAIL actions                  | unit          | NOT TESTED | generate-constraints.test.ts         |
| 4   | Internal agent → block/redact ON_FAIL actions                             | unit          | NOT TESTED | generate-constraints.test.ts         |
| 5   | Generated constraints pass compiler validation                            | integration   | NOT TESTED | TBD                                  |
| 6   | Coverage matrix identifies missing PCI-DSS constraint                     | unit          | NOT TESTED | constraint-coverage-analyzer.test.ts |
| 7   | BUILD phase auto-injects constraints into agent ABL                       | integration   | NOT TESTED | TBD                                  |
| 8   | IN_PROJECT analyze_constraints tool returns coverage widget               | integration   | NOT TESTED | TBD                                  |
| 9   | Full BUILD with PCI-DSS project → all payment agents get constraints      | e2e           | NOT TESTED | TBD                                  |
| 10  | IN_PROJECT "check constraints" → matrix shows gaps → "Fix" applies them   | e2e           | NOT TESTED | TBD                                  |
| 11  | Agent with no sensitive tools → no constraints generated (no false alarm) | e2e           | NOT TESTED | TBD                                  |
| 12  | Multi-regulation project (PCI-DSS + GDPR) → all relevant constraints      | e2e           | NOT TESTED | TBD                                  |

### Testing Notes

E2E tests must exercise the real Arch AI message pipeline through HTTP. Tests should:

- Start a real Studio server with the Arch AI route mounted
- Create projects with compliance tags (PCI-DSS, HIPAA)
- Generate agents with sensitive tools via BUILD
- Verify CONSTRAINTS sections in the generated ABL
- Verify constraint coverage analysis via IN_PROJECT tool
- No mocking of compiler validation, data sensitivity classification, or constraint generation

> Full testing details: [../testing/constraint-design-coaching.md](../testing/constraint-design-coaching.md)

---

## 18. References

- Governance specialist: [`docs/arch/features/S2-F13-governance-specialist.md`](../arch/features/S2-F13-governance-specialist.md)
- Backlog item: [`docs/arch/backlogs/B23-constraint-design-coaching.md`](../arch/backlogs/B23-constraint-design-coaching.md)
- Guardrails feature: [`docs/features/guardrails.md`](guardrails.md)
- PII Detection: [`docs/features/pii-detection.md`](pii-detection.md)
- Constraint IR types: [`packages/compiler/src/platform/ir/schema.ts`](../../packages/compiler/src/platform/ir/schema.ts)
- 3-tier guardrail evaluators: [`packages/compiler/src/platform/guardrails/`](../../packages/compiler/src/platform/guardrails/)
