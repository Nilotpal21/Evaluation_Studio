# Test Specification: Constraint & Guardrail Design Coaching

**Feature Spec**: [`docs/features/constraint-design-coaching.md`](../features/constraint-design-coaching.md)
**HLD**: N/A (not yet generated)
**LLD**: N/A (not yet generated)
**Status**: IN PROGRESS
**Last Updated**: 2026-04-05

---

## 1. Coverage Matrix

| FR    | Description                                    | Unit | Integration | E2E | Manual | Status  |
| ----- | ---------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Data sensitivity classification                | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-2  | Regulation → constraint mapping                | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-3  | Constraint kind selection (require/limit/warn) | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-4  | ON_FAIL action by agent role                   | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-5  | Coverage matrix computation                    | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-6  | Guardrail tier recommendation                  | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-7  | Generated constraints pass compiler validation | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-8  | analyze_constraints tool (IN_PROJECT)          | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-9  | Guardrail cascade compatibility validation     | ✅   | ✅          | ✅  | ❌     | PASSING |
| FR-10 | Activity feed integration                      | ✅   | ✅          | ✅  | ❌     | PASSING |

---

## 2. E2E Test Scenarios (MANDATORY)

> CRITICAL: E2E tests exercise the real Arch AI pipeline through HTTP API. No mocks, no direct DB access, no stubbed servers.

### E2E-1: PCI-DSS project BUILD auto-generates payment constraints

- **Preconditions**: Project with PCI-DSS compliance tag in specification. Agents include a `billing_agent` with tools: `process_refund`, `check_balance`, `create_invoice`.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'ONBOARDING' }`
  2. Send interview messages describing a payment processing system with PCI-DSS compliance
  3. Approve topology with billing_agent
  4. Wait for BUILD phase to generate agents
  5. `GET /api/arch-ai/sessions/:id/journal` → retrieve journal events
  6. Parse generated ABL for billing_agent
- **Expected Result**:
  - Journal contains `constraint_analysis` event for billing_agent
  - Event shows `sensitivityClassification: ['payment']`
  - Event shows `regulationsApplicable: ['PCI-DSS']`
  - Generated ABL CONSTRAINTS section includes credit card regex guard (REQUIRE kind, severity: error)
  - ON_FAIL action for customer-facing billing_agent uses `respond` + `redact` (not `block`)
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-pci`
- **Isolation Check**: N/A for BUILD

### E2E-2: HIPAA project BUILD auto-generates health data constraints

- **Preconditions**: Project with HIPAA compliance tag. Agents include `health_intake_agent` with tools: `lookup_patient`, `get_diagnosis`, `schedule_appointment`.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'ONBOARDING' }`
  2. Send interview messages describing a healthcare intake system with HIPAA compliance
  3. Approve topology and wait for BUILD
  4. `GET /api/arch-ai/sessions/:id/journal` → journal events
  5. Parse generated ABL for health_intake_agent
- **Expected Result**:
  - Sensitivity classification includes `health` and `pii`
  - CONSTRAINTS section includes PII detection guard (model tier)
  - CONSTRAINTS section includes health data access logging constraint
  - Guardrail tier: model (NLI) for PII detection, not just local regex
  - ON_FAIL action: `respond` + `escalate` for customer-facing agent
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A for BUILD

### E2E-3: IN_PROJECT constraint analysis returns coverage matrix

- **Preconditions**: Existing project with 3 agents. `billing_agent` has PCI-DSS constraints, `triage_agent` has no constraints, `health_agent` has partial HIPAA constraints (input only, missing output).
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'IN_PROJECT', projectId: '<id>' }`
  2. `POST /api/arch-ai/message` with `{ text: "check my constraints" }`
  3. Parse SSE stream response
- **Expected Result**:
  - Response contains `tool_call` for `analyze_constraints`
  - Coverage matrix returned with 3 agent rows
  - `billing_agent`: PCI-DSS = `covered`
  - `triage_agent`: all regulations = `—` (no sensitive data, no constraints needed)
  - `health_agent`: HIPAA = `partial` with explanation "input evaluation configured, output evaluation missing"
  - Actionable fix suggestion for health_agent's gap
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`, project: `test-project-mixed`
- **Isolation Check**: Only agents from this project appear in the matrix

### E2E-4: Fix constraint gap applies valid ABL

- **Preconditions**: From E2E-3 result, health_agent has a partial HIPAA gap.
- **Steps**:
  1. Continue the IN_PROJECT session from E2E-3
  2. `POST /api/arch-ai/message` with `{ text: "fix the HIPAA gap on health_agent" }`
  3. Parse SSE stream — expect agent modification flow
  4. Verify the modification includes a new CONSTRAINTS entry
  5. `GET /api/arch-ai/sessions/:id/journal` → verify constraint_analysis event
- **Expected Result**:
  - New CONSTRAINT added to health_agent ABL: output evaluation for PII detection
  - Generated constraint passes compiler validation (no syntax errors)
  - Constraint has correct fields: `condition`, `on_fail` with `ConstraintAction`, `severity`, `kind`, `checkpoint`
  - Journal records both the analysis and the fix application
- **Auth Context**: Same session as E2E-3
- **Isolation Check**: Modification scoped to health_agent only; other agents unchanged

### E2E-5: No false alarms for general-purpose agents

- **Preconditions**: Project with agents that have generic tools (`search_faq`, `get_status`, `format_response`) — no sensitive data handling.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'ONBOARDING' }`
  2. Send interview messages describing a simple FAQ bot with no compliance requirements
  3. Approve topology and wait for BUILD
  4. `GET /api/arch-ai/sessions/:id/journal` → journal events
  5. Parse generated ABL for all agents
- **Expected Result**:
  - No `constraint_analysis` events with `constraintsGenerated > 0`
  - Generated agents have no CONSTRAINTS section (or empty CONSTRAINTS)
  - No false positive sensitivity classifications
  - Activity feed does not show constraint generation messages
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A

### E2E-6: Multi-regulation project (PCI-DSS + GDPR) generates all constraints

- **Preconditions**: Project with both PCI-DSS and GDPR compliance tags. Agent handles payments AND personal data.
- **Steps**:
  1. `POST /api/arch-ai/sessions` with `{ mode: 'ONBOARDING' }`
  2. Send interview describing EU payment processing (PCI-DSS + GDPR)
  3. Approve topology with payment_agent (tools: `process_payment`, `store_customer_data`)
  4. Wait for BUILD
  5. Parse generated ABL CONSTRAINTS section
- **Expected Result**:
  - Both PCI-DSS constraints (credit card guard) and GDPR constraints (data minimization, consent verification) present
  - No duplicate constraints for overlapping concerns
  - Constraint count >= 3 (at least 1 PCI-DSS + 2 GDPR)
  - All constraints pass compiler validation
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A

### E2E-7: Internal vs customer-facing ON_FAIL action differentiation

- **Preconditions**: Project with 2 agents: `public_support_agent` (customer-facing) and `internal_processor` (backend only).
- **Steps**:
  1. Complete BUILD with both agents handling payment data
  2. Parse generated CONSTRAINTS for both agents
- **Expected Result**:
  - `public_support_agent` ON_FAIL actions: `respond` (explain), `escalate`, `collect_field`
  - `internal_processor` ON_FAIL actions: `block`, `redact`
  - Same regulation (PCI-DSS) produces different ON_FAIL strategies per agent role
- **Auth Context**: `Authorization: Bearer <user-jwt>`, tenant: `test-tenant-1`
- **Isolation Check**: N/A

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: Data sensitivity classification accuracy

- **Boundary**: `classifyDataSensitivity()` → agent TOOLS definitions
- **Setup**: Agent tool arrays with known sensitive patterns
- **Steps**:
  1. Call with tools: `['process_refund', 'check_balance']` → expect `['payment']`
  2. Call with tools: `['lookup_ssn', 'verify_identity']` → expect `['pii']`
  3. Call with tools: `['get_diagnosis', 'schedule_appointment']` → expect `['health']`
  4. Call with tools: `['search_faq', 'format_response']` → expect `['general']`
  5. Call with tools: `['process_payment', 'lookup_patient']` → expect `['payment', 'health']` (multi-category)
- **Expected Result**: Correct sensitivity categories for all inputs including multi-category detection
- **Failure Mode**: Unknown tool names → `general` classification (no false positives)

### INT-2: Generated constraints pass compiler validation

- **Boundary**: `generateConstraints()` → `validate-ir.ts` (compiler)
- **Setup**: Generate constraints for PCI-DSS payment agent
- **Steps**:
  1. Call `generateConstraints({ regulations: ['PCI-DSS'], agentRole: 'specialist', sensitivity: ['payment'] })`
  2. Extract the `Constraint[]` from the result
  3. Construct a minimal IR with the generated constraints
  4. Run through `validate-ir.ts` validation
- **Expected Result**: Zero validation errors. All `condition`, `on_fail`, `severity`, `kind` fields match the `Constraint` IR schema.
- **Failure Mode**: If validation fails, log the specific schema violation for debugging

### INT-3: ON_FAIL action selection by agent role

- **Boundary**: `generateConstraints()` → role-based action mapping
- **Setup**: Same regulation, two different agent roles
- **Steps**:
  1. Call with `agentRole: 'customer_facing'` + PCI-DSS → extract ON_FAIL actions
  2. Call with `agentRole: 'internal'` + PCI-DSS → extract ON_FAIL actions
  3. Call with `agentRole: 'supervisor'` + PCI-DSS → extract ON_FAIL actions
- **Expected Result**:
  - Customer-facing: `respond`, `escalate`, `collect_field` (never `block`)
  - Internal: `block`, `redact` (never `escalate` to human)
  - Supervisor: `handoff`, `goto_step`
- **Failure Mode**: Unknown role → defaults to customer-facing actions (safest)

### INT-4: Coverage matrix identifies gaps correctly

- **Boundary**: `analyzeConstraintCoverage()` → existing agent constraints comparison
- **Setup**: 3 agents with known constraint states
- **Steps**:
  1. Agent A: has PCI-DSS constraint → expect `covered`
  2. Agent B: has HIPAA input guard but missing output guard → expect `partial`
  3. Agent C: handles payment data but no constraints → expect `missing`
  4. Agent D: no sensitive data → expect `—` (not applicable)
- **Expected Result**: Matrix correctly classifies all 4 states with actionable gap descriptions for `partial` and `missing`
- **Failure Mode**: If constraint parsing fails, classify as `unknown` (not `covered`)

### INT-5: Guardrail tier recommendation matches evaluation kind

- **Boundary**: Tier selection logic → evaluation kind mapping
- **Setup**: Different regulation/pattern combinations
- **Steps**:
  1. Credit card numbers → expect local tier (regex)
  2. PII detection (names, addresses) → expect model tier (NLI)
  3. GDPR consent verification → expect LLM tier (semantic)
  4. SSN format → expect local tier (regex)
  5. Topic drift detection → expect LLM tier
- **Expected Result**: Each pattern maps to the correct guardrail tier
- **Failure Mode**: Unknown pattern → defaults to model tier (balanced cost/accuracy)

### INT-6: Multi-regulation constraint deduplication

- **Boundary**: `generateConstraints()` with multiple regulations
- **Setup**: Agent with PCI-DSS + GDPR both requiring PII protection
- **Steps**:
  1. Call with `regulations: ['PCI-DSS', 'GDPR']`
  2. Count constraints in the result
  3. Check for duplicate constraint conditions
- **Expected Result**: No duplicate constraints. PII protection appears once with the stricter regulation's parameters (higher severity wins).
- **Failure Mode**: If dedup fails, constraints still valid but redundant (not harmful, just noisy)

### INT-7: Activity feed events for constraint generation

- **Boundary**: Constraint helper → activity feed event emission
- **Setup**: Mock activity feed event collector
- **Steps**:
  1. Run constraint analysis for an agent with PCI-DSS
  2. Capture emitted events
  3. Verify event sequence: "Analyzing constraints..." → "Detected: payment data" → "Adding PCI-DSS constraints" → "Complete"
- **Expected Result**: 3-4 structured events with correct agent name, regulation, and constraint count
- **Failure Mode**: Missing events → analysis still works, just no UI feedback

---

## 4. Unit Test Scenarios

### UT-1: Tool name pattern matching

- **Module**: `classifyDataSensitivity()` — tool name patterns
- **Input**: Various tool names (`process_payment`, `lookup_order`, `get_patient_record`, `search_faq`)
- **Expected Output**: Correct category for each (`payment`, `general`, `health`, `general`)

### UT-2: Tool parameter name inspection

- **Module**: `classifyDataSensitivity()` — parameter analysis
- **Input**: Tool with parameter named `credit_card_number` but generic tool name `validate_input`
- **Expected Output**: `payment` classification from parameter name despite generic tool name

### UT-3: Tool description keyword analysis

- **Module**: `classifyDataSensitivity()` — description parsing
- **Input**: Tool with description "Retrieves medical records and prescription history"
- **Expected Output**: `health` classification from description keywords

### UT-4: Regulation → constraint field mapping

- **Module**: `generateConstraints()` — field completeness
- **Input**: PCI-DSS regulation
- **Expected Output**: Constraint objects with all required IR fields: `condition`, `on_fail.type`, `on_fail.message`, `severity`, `kind`

### UT-5: Constraint kind selection logic

- **Module**: `generateConstraints()` — kind mapping
- **Input**: Hard regulatory mandate (PCI-DSS credit card) vs best practice (SOC2 audit trail)
- **Expected Output**: `require` (severity: error) for PCI-DSS; `warn` (severity: warning) for SOC2 audit

---

## 5. Security & Isolation Tests

- [x] **Cross-project constraint isolation**: Coverage matrix only shows agents from the current project
  - Seed: Project 1 has 3 agents; Project 2 has 4 agents
  - Test: Coverage analysis for Project 1 returns exactly 3 rows
- [x] **Cross-tenant isolation**: Constraint analysis uses only the current tenant's compliance requirements
  - Seed: Tenant A has PCI-DSS; Tenant B has HIPAA
  - Test: Tenant B's analysis never references PCI-DSS constraints
- [x] **Missing auth returns 401**: `POST /api/arch-ai/message` with `analyze_constraints` tool without auth returns 401
- [x] **Insufficient permissions returns 403**: User without project access cannot analyze that project's constraints
- [x] **No sensitive data in constraint output**: Generated constraints reference tool names and regulation codes, never actual customer data
- [x] **Input validation**: `analyze_constraints` tool rejects invalid agent names
- [x] **Compiler validation gate**: All generated constraints must pass `validate-ir.ts` — no invalid IR escapes to ABL

---

## 6. Performance & Load Tests

| Scenario                                       | Target | How Measured                                     |
| ---------------------------------------------- | ------ | ------------------------------------------------ |
| Single agent sensitivity classification        | <10ms  | `classifyDataSensitivity()` call duration        |
| Coverage matrix (10 agents × 4 regulations)    | <50ms  | `analyzeConstraintCoverage()` call duration      |
| Constraint generation (1 agent, 2 regulations) | <20ms  | `generateConstraints()` call duration            |
| Compiler validation of generated constraints   | <100ms | `validate-ir.ts` call with generated constraints |

---

## 7. Test Infrastructure

- **Required services**: Studio dev server (Next.js), MongoDB (for sessions/journals), ABL compiler (for validation)
- **Data seeding**:
  - Projects with various compliance tags (PCI-DSS, HIPAA, GDPR, SOC2, none)
  - Agents with diverse tool profiles (payment, health, PII, general)
  - Agents with existing constraints (for coverage gap analysis)
- **Environment variables**: Standard Studio dev env. No new vars needed.
- **CI configuration**: Runs as part of `apps/studio` test suite. Compiler package imported directly.

---

## 8. Test File Mapping

| Test File                                                                   | Type        | Covers                            |
| --------------------------------------------------------------------------- | ----------- | --------------------------------- |
| `apps/studio/src/__tests__/arch-ai/classify-data-sensitivity.test.ts`       | unit        | FR-1, UT-1–UT-3                   |
| `apps/studio/src/__tests__/arch-ai/generate-constraints.test.ts`            | unit        | FR-2, FR-3, FR-4, FR-6, UT-4–UT-5 |
| `apps/studio/src/__tests__/arch-ai/constraint-coverage-analyzer.test.ts`    | unit        | FR-5                              |
| `apps/studio/src/__tests__/arch-ai/constraint-coaching-integration.test.ts` | integration | FR-7, FR-9, INT-1–INT-7           |
| `apps/studio/src/__tests__/e2e/arch-ai-constraint-coaching.e2e.test.ts`     | e2e         | FR-8, FR-10, E2E-1–E2E-7          |

---

## 9. Open Testing Questions

1. How should E2E tests verify the generated ABL CONSTRAINTS content? Parse the ABL output text, or check via a compilation round-trip?
2. Should integration tests import `validate-ir.ts` directly from the compiler package, or call it through a service boundary?
3. For multi-category sensitivity classification (tool handles both payment and health), how should the constraint priority be tested?
4. Should E2E tests for the "Fix" flow (E2E-4) verify the agent modification persists after session close, or just verify the modification event?
5. How should the BUILD phase constraint injection be verified — by inspecting the generated ABL text, or by checking journal events only?
