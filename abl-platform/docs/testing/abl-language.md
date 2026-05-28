# Feature Test Guide: ABL Language

**Feature**: ABL DSL, YAML flow parsing, compile, diagnostics, and validation
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/abl-language.md](../features/abl-language.md)
**First tested**: 2026-03-18
**Last updated**: 2026-03-22
**Overall status**: STABLE

---

## Current State (as of 2026-03-22)

ABL parsing and compilation have strong unit and integration coverage across `packages/core`, `packages/compiler`, and the Studio compile/diagnostics APIs. The main remaining gap is browser-level coverage for the full editing/diagnostics loop, not parser/compiler correctness itself.

### Quick Health Dashboard

| Area                       | Status  | Last Verified | Notes                                               |
| -------------------------- | ------- | ------------- | --------------------------------------------------- |
| DSL parser                 | PASS    | 2026-03-22    | Agent, tool, expression, and memory parsers covered |
| YAML flow parser           | PASS    | 2026-03-22    | YAML-to-AST parity coverage exists                  |
| Lexer + schema             | PASS    | 2026-03-22    | Tokenization and schema checks present              |
| Cross-reference validation | PASS    | 2026-03-22    | Tool/agent/field reference checks covered           |
| IR compilation             | PASS    | 2026-03-22    | End-to-end compile suites exist                     |
| Studio compile APIs        | PASS    | 2026-03-22    | Backed by API/unit coverage                         |
| Browser authoring loop     | PARTIAL | 2026-03-22    | No dedicated full-browser compile doc flow          |

---

## Coverage Matrix

| FR    | Description                                         | Unit | Integration | E2E | Manual | Status |
| ----- | --------------------------------------------------- | ---- | ----------- | --- | ------ | ------ |
| FR-1  | Parse uppercase DSL into AgentBasedDocument AST     | YES  | YES         | YES | --     | PASS   |
| FR-2  | Parse YAML-format ABL into identical AST            | YES  | YES         | YES | --     | PASS   |
| FR-3  | Auto-detect DSL vs YAML format                      | YES  | --          | --  | --     | PASS   |
| FR-4  | Compile AgentBasedDocument[] into CompilationOutput | YES  | YES         | YES | --     | PASS   |
| FR-5  | Post-compilation validators                         | YES  | YES         | --  | --     | PASS   |
| FR-6  | CEL expression evaluation with abl.\* functions     | YES  | --          | --  | --     | PASS   |
| FR-7  | 3-tier diagnostics (syntax, structural, compile)    | YES  | --          | --  | --     | PASS   |
| FR-8  | Completions, hover, document symbols                | YES  | --          | --  | --     | PASS   |
| FR-9  | Tool file parsing and import resolution             | YES  | --          | --  | --     | PASS   |
| FR-10 | Supervisor document parsing                         | YES  | YES         | YES | --     | PASS   |
| FR-11 | Behavior profile compilation and attachment         | YES  | YES         | --  | --     | PASS   |
| FR-12 | Config variable resolution at compile time          | YES  | YES         | --  | --     | PASS   |
| FR-13 | Compilation timeout enforcement (E727)              | YES  | --          | --  | --     | PASS   |
| FR-14 | System tool name shadowing prevention               | YES  | --          | --  | --     | PASS   |
| FR-15 | Source hash generation (SHA-256)                    | YES  | YES         | --  | --     | PASS   |

---

## E2E Test Scenarios (Minimum 5)

### E2E-1: Full DSL-to-IR Compilation Pipeline

**Preconditions**: A valid uppercase DSL file defining an agent with GOAL, TOOLS, GATHER, FLOW, and HANDOFF sections.

**Steps**:

1. Load the DSL source from fixture file (`packages/compiler/src/__tests__/e2e/fixtures/agents.ts`)
2. Call `parseAgentBasedABL(source)` to produce `AgentBasedDocument[]`
3. Call `compileABLtoIR(documents, options)` to produce `CompilationOutput`
4. Assert `compilation_errors` array is empty
5. Assert `agents` record contains the expected agent name
6. Assert the compiled `AgentIR` has correct `metadata.name`, `identity.goal`, non-empty `tools`, and valid `flow.entry_point`
7. Assert `metadata.source_hash` is a non-empty SHA-256 hex string

**Expected Result**: The DSL source compiles into a well-formed `AgentIR` with zero compilation errors. All agent sections (identity, tools, gather, flow, coordination) are present in the output.

**Auth Context**: N/A (pure library function, no HTTP)

**Test File**: `packages/compiler/src/__tests__/e2e/e2e.test.ts`
**Status**: PASS

---

### E2E-2: Supervisor/Topology Composition Compilation

**Preconditions**: A supervisor DSL defining SUPERVISOR:, AGENTS:, INTENTS:, and POLICIES: sections with multiple agent references.

**Steps**:

1. Parse the supervisor DSL source into a `SupervisorDocument`
2. Parse all referenced agent DSL sources into `AgentBasedDocument[]`
3. Compile the combined document set via `compileABLtoIR()`
4. Assert the supervisor agent appears in the output with correct routing configuration
5. Assert all referenced agents are present in the compiled output
6. Assert cross-agent validation passes (no dangling handoff/delegate targets)

**Expected Result**: Multi-agent topology compiles correctly with all routing references resolved.

**Auth Context**: N/A (pure library function, no HTTP)

**Test File**: `packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts`
**Status**: PASS

---

### E2E-3: Full Travel Booking Scenario with Real LLM Calls

**Preconditions**: A hotel booking agent DSL with gather fields, tool calls, flow steps, and handoff configuration. Requires LLM API credentials or cached responses.

**Steps**:

1. Load the `traveldesk-hotel-booking` fixture DSL
2. Parse and compile the full agent definition
3. Assert the compiled IR contains gather fields with CEL validation rules
4. Assert tool definitions include correct parameter schemas
5. Assert flow steps are connected with valid transitions
6. Assert handoff configuration targets exist in the compilation context

**Expected Result**: A realistic multi-section agent compiles successfully with all constructs (gather, tools, flow, handoff, constraints) present in the output IR.

**Auth Context**: N/A (pure library function; LLM calls use cached responses in test)

**Test File**: `packages/compiler/src/__tests__/e2e/traveldesk-hotel-booking.e2e.test.ts`
**Status**: PASS

---

### E2E-4: Dual-Format Parity (Uppercase DSL + YAML produce identical IR)

**Preconditions**: The same agent definition written in both uppercase DSL format and YAML format.

**Steps**:

1. Parse the uppercase DSL version via `parseAgentBasedABL()`
2. Parse the YAML version via `parseYamlABL()`
3. Compile both into IR via `compileABLtoIR()`
4. Compare the resulting `AgentIR` objects field-by-field (excluding timestamps and source hashes)
5. Assert identity, tools, gather, flow, coordination, and constraints sections are structurally identical

**Expected Result**: Both formats produce the same compiled IR, confirming format-agnostic compilation.

**Auth Context**: N/A (pure library function, no HTTP)

**Test File**: `packages/compiler/src/__tests__/dual-format-compilation.test.ts`
**Status**: PASS

---

### E2E-5: Studio Compile API Round-Trip

**Preconditions**: Studio compile API endpoint available at `/api/abl/compile`.

**Steps**:

1. POST a valid YAML-format agent DSL to `/api/abl/compile` with resolved tool implementations
2. Assert HTTP 200 response
3. Assert response body contains `agents` with compiled IR
4. Assert response body `compilation_errors` is empty
5. Assert the compiled IR includes the expected agent name and valid structure
6. POST an invalid DSL with syntax errors
7. Assert the response contains `compilation_errors` with diagnostic messages

**Expected Result**: The Studio compile API returns well-formed CompilationOutput for valid input and structured error diagnostics for invalid input.

**Auth Context**: Studio session (project-scoped)

**Test File**: `apps/studio/src/app/api/abl/compile/route.ts` + unit coverage
**Status**: PASS

---

### E2E-6: Validation Pipeline Catches Cross-Agent Broken References

**Preconditions**: Two agent DSL files where Agent A has a HANDOFF target referencing Agent B, but Agent B has a typo in its name.

**Steps**:

1. Parse both agent DSL sources
2. Compile both via `compileABLtoIR()`
3. Run `validateIR()` on the compiled output
4. Assert the validation returns a diagnostic with code matching cross-agent reference error
5. Assert the diagnostic message identifies the unresolved handoff target

**Expected Result**: The validation pipeline detects and reports the broken cross-agent reference with a machine-readable validation code.

**Auth Context**: N/A (pure library function)

**Test File**: `packages/compiler/src/__tests__/validate-cross-agent.test.ts`
**Status**: PASS

---

### E2E-7: Guardrail Compilation and Validation Pipeline

**Preconditions**: An agent DSL with GUARDRAILS: section containing input, output, and tool guardrails with various action types.

**Steps**:

1. Parse the agent DSL with guardrail definitions
2. Compile via `compileABLtoIR()`
3. Assert the compiled IR `guardrails` array contains entries for each defined guardrail
4. Assert each guardrail has correct `kind`, `tier`, and `action` configuration
5. Run `validateGuardrailsForIR()` and assert no validation errors

**Expected Result**: Guardrail definitions compile into correct IR guardrail configs and pass validation.

**Auth Context**: N/A (pure library function)

**Test File**: `packages/compiler/src/__tests__/guardrails/*.test.ts`
**Status**: PASS

---

## Integration Test Scenarios (Minimum 5)

### INT-1: Cross-Agent Reference Validation

**Boundary**: `packages/compiler` IR compiler + cross-agent validator

**Setup**: Multiple `AgentBasedDocument` fixtures with handoff, delegate, and routing references between them.

**Steps**:

1. Compile a set of agents where handoff targets reference other agents in the set
2. Compile a set where a handoff target references a non-existent agent
3. Compile a set where a delegate target creates a circular reference

**Expected Result**:

- Valid references produce zero cross-agent validation diagnostics
- Missing targets produce diagnostics with the appropriate validation code
- Circular references produce diagnostics

**Failure Mode**: If the validator silently accepts missing targets, agents would deploy with broken handoff paths that fail at runtime.

**Test File**: `packages/compiler/src/__tests__/validate-cross-agent.test.ts`
**Status**: PASS

---

### INT-2: Flow Graph Integrity Validation

**Boundary**: `packages/compiler` IR compiler + flow graph validator

**Setup**: Agent IR fixtures with flow steps that have various transition patterns (linear, branching, conditional, unreachable).

**Steps**:

1. Compile an agent with all flow steps reachable from the entry point
2. Compile an agent with an unreachable step
3. Compile an agent with a step that transitions to a non-existent step

**Expected Result**:

- Well-formed flow graphs pass validation
- Unreachable steps produce warning diagnostics
- Missing transition targets produce error diagnostics

**Failure Mode**: Unreachable steps waste resources at runtime; missing targets cause runtime crashes.

**Test File**: `packages/compiler/src/__tests__/validate-flow-graph.test.ts`
**Status**: PASS

---

### INT-3: Field Reference Validation

**Boundary**: `packages/compiler` field reference validator + gather config

**Setup**: Agent IR with gather fields, conditions referencing field values, and `depends_on` relationships.

**Steps**:

1. Compile an agent where conditions reference defined gather fields
2. Compile an agent where a condition references an undefined field
3. Compile an agent where `depends_on` references a non-existent gather field

**Expected Result**:

- Valid field references pass
- Undefined field references produce diagnostics
- Broken `depends_on` chains produce diagnostics

**Failure Mode**: Unresolved field references cause runtime evaluation errors.

**Test File**: `packages/compiler/src/__tests__/validate-field-refs.test.ts`
**Status**: PASS

---

### INT-4: Input Mapping Validation (CEL Safety)

**Boundary**: `packages/compiler` input mapping validator + CEL evaluator

**Setup**: Agent IR with `call_with` input mappings using CEL expressions.

**Steps**:

1. Compile an agent with valid CEL input mappings (`{{field_name}}`, `abl.upper(name)`)
2. Compile an agent with an invalid CEL expression (syntax error)
3. Compile an agent with an expression exceeding the 4,096-byte limit

**Expected Result**:

- Valid CEL expressions pass validation
- Syntax errors produce diagnostics with the line/expression context
- Oversized expressions are rejected

**Failure Mode**: Invalid CEL expressions would cause runtime evaluation failures.

**Test File**: `packages/compiler/src/__tests__/validate-input-mappings.test.ts`
**Status**: PASS

---

### INT-5: Preflight Deployment Validation

**Boundary**: `packages/compiler` preflight validator + full compilation pipeline

**Setup**: Agent IR with various deployment-readiness states (complete vs missing required fields).

**Steps**:

1. Compile a fully-specified agent and run preflight validation
2. Compile an agent missing a GOAL and run preflight
3. Compile an agent with unresolved tool references in strict mode

**Expected Result**:

- Complete agents pass preflight
- Missing GOAL produces a preflight error
- Unresolved tools in strict mode produce preflight errors

**Failure Mode**: Deploying an agent without a GOAL would produce empty responses at runtime.

**Test File**: `packages/compiler/src/__tests__/validate-preflight.test.ts`
**Status**: PASS

---

### INT-6: ABL Export Compatibility

**Boundary**: `packages/compiler` compile + export validation

**Setup**: Agent DSL files that exercise the export/import round-trip path.

**Steps**:

1. Parse and compile an agent DSL
2. Export the compiled IR
3. Validate the exported format is compatible with import expectations

**Expected Result**: Exported IR can be re-imported without loss of information.

**Test File**: `packages/compiler/src/__tests__/validate-abl-export.test.ts`
**Status**: PASS

---

### INT-7: Full Validation Pipeline Integration

**Boundary**: All validators running together via `validateIR()`

**Setup**: Agent IR fixtures that exercise multiple validator paths simultaneously.

**Steps**:

1. Compile an agent with flow graph issues, field reference issues, and tool reference issues
2. Run `validateIR()` to collect all diagnostics
3. Assert diagnostics from multiple validators are present with correct codes
4. Assert no validator throws an exception (graceful degradation)

**Expected Result**: The validation orchestrator collects diagnostics from all validators without short-circuiting.

**Test File**: `packages/compiler/src/__tests__/validate-integration.test.ts`
**Status**: PASS

---

## Unit Test Coverage

### packages/core (25 test files)

| Test File                                | Module                | Coverage Focus                                                                   |
| ---------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `agent-based-parser.test.ts`             | DSL parser            | All agent sections: GOAL, TOOLS, GATHER, FLOW, CONSTRAINT, MEMORY, HANDOFF, etc. |
| `yaml-parser.test.ts`                    | YAML parser           | YAML-to-AST mapping for all agent sections                                       |
| `yaml-flow-parser.test.ts`               | YAML flow             | Flow step parsing, transitions, gather-in-flow                                   |
| `expression-parser.test.ts`              | Expression parser     | CEL expressions, comparisons, logical operators                                  |
| `lexer.test.ts`                          | Chevrotain lexer      | Token recognition for all ABL keywords and operators                             |
| `supervisor-parser.test.ts`              | Supervisor parser     | SUPERVISOR, AGENTS, INTENTS, POLICIES sections                                   |
| `tool-file-parser.test.ts`               | Tool file parser      | `.tools.abl` file parsing with shared defaults                                   |
| `tool-import-resolver.test.ts`           | Import resolver       | Cross-file tool import resolution                                                |
| `rich-content-parser.test.ts`            | Rich content          | Carousel, adaptive card, multi-channel output                                    |
| `behavior-profile-parser.test.ts`        | Behavior profiles     | Profile definition parsing                                                       |
| `dsl-extensions-parser.test.ts`          | Extensions (positive) | Extended DSL constructs                                                          |
| `dsl-extensions-parser-negative.test.ts` | Extensions (negative) | Error handling for malformed constructs                                          |
| `parser-memory-enhanced.test.ts`         | Memory parsing        | SESSION_MEMORY, PERSISTENT_MEMORY, REMEMBER, RECALL                              |
| `parser-gather-enhanced.test.ts`         | Gather parsing        | Complex gather fields, validation rules                                          |
| `parser-handoff-enhanced.test.ts`        | Handoff parsing       | Handoff with context, conditions, expect_return                                  |
| `parser-constraint-control-flow.test.ts` | Constraints           | Constraint phases, requirements, actions                                         |
| `parser-phase3-features.test.ts`         | Phase 3 constructs    | NLU, lookup, multi-intent                                                        |
| `parser-tool-on-result.test.ts`          | Tool callbacks        | ON_RESULT handler parsing                                                        |
| `parser-memory-scope.test.ts`            | Memory scope          | Scoped memory access patterns                                                    |
| `parser-lookup-redesign.test.ts`         | Lookup tables         | LOOKUP construct parsing                                                         |
| `parser-error-handling-enhanced.test.ts` | Error handling        | Parser error recovery and diagnostics                                            |
| `parser-utils.test.ts`                   | Utilities             | Shared parser utility functions                                                  |
| `abl-schema.test.ts`                     | JSON Schema           | Schema validation against agent definitions                                      |

### packages/compiler (168 test files)

Major test areas:

- `e2e/` (3 files): Full pipeline compilation tests
- `ir/` (12 files): IR-level construct tests (behavior profiles, auth, config vars, rich content)
- `guardrails/` (29 files): Guardrail compilation and evaluation
- `validate-*.test.ts` (9 files): All validators
- `gather-*.test.ts` (8 files): Gather compilation
- `memory-*.test.ts` (2 files): Memory compilation
- `llm/` directory: LLM integration tests
- `constructs/` directory: CEL evaluator and function tests

### packages/language-service (7 test files)

| Test File                 | Module           | Coverage Focus              |
| ------------------------- | ---------------- | --------------------------- |
| `diagnostics.test.ts`     | Diagnostics      | 3-tier diagnostic pipeline  |
| `completions.test.ts`     | Completions      | Context-aware completions   |
| `cel-completions.test.ts` | CEL completions  | CEL function completions    |
| `hover.test.ts`           | Hover            | Keyword hover documentation |
| `symbols.test.ts`         | Symbols          | Document symbol extraction  |
| `detect-format.test.ts`   | Format detection | YAML vs uppercase heuristic |
| `serialize-yaml.test.ts`  | Serialization    | IR-to-YAML round-trip       |

---

## Security & Isolation Tests

- [x] System tool name shadowing prevention (compiler rejects project tools named `__handoff__`, etc.)
- [x] CEL expression length cap enforcement (4,096 bytes)
- [x] Config variable pattern resolution (unresolved vars emit warnings)
- [x] Guardrail validation ensures well-formed safety constraints
- [ ] Cross-tenant compile isolation (Studio API routes scope by tenant) -- covered by Studio route tests, not compiler unit tests
- [ ] Cross-project compile isolation (project_agents scoped by projectId) -- covered by runtime route tests
- [ ] Cross-user DSL access restriction -- covered by Studio auth middleware

---

## Test Infrastructure

### Required Services

- None for parser/compiler/language-service tests (pure library functions)
- Studio API tests may require Next.js dev server
- LLM cache (`LLM_CACHE_DIR=.llm-cache`) for E2E tests with real model calls

### Data Seeding

- DSL fixtures in `packages/compiler/src/__tests__/e2e/fixtures/agents.ts`
- Inline DSL strings in individual test files

### Environment Variables

| Variable            | Required    | Purpose                                   |
| ------------------- | ----------- | ----------------------------------------- |
| `LLM_CACHE_ENABLED` | Optional    | Enable cached LLM responses for E2E tests |
| `LLM_CACHE_DIR`     | Optional    | Cache directory (default: `.llm-cache`)   |
| `OPENAI_API_KEY`    | For LLM E2E | Real LLM calls in travel booking scenario |

### CI Configuration

```bash
pnpm --filter @abl/core test
pnpm --filter @abl/compiler test
pnpm --filter @abl/language-service test
pnpm --filter studio test -- abl
```

---

## Test File Mapping

| Test File                                                                  | Type        | Covers                  |
| -------------------------------------------------------------------------- | ----------- | ----------------------- |
| `packages/compiler/src/__tests__/e2e/e2e.test.ts`                          | e2e         | FR-1, FR-2, FR-4, FR-15 |
| `packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts`       | e2e         | FR-10, FR-5             |
| `packages/compiler/src/__tests__/e2e/traveldesk-hotel-booking.e2e.test.ts` | e2e         | FR-1, FR-4, FR-6        |
| `packages/compiler/src/__tests__/dual-format-compilation.test.ts`          | integration | FR-1, FR-2, FR-3        |
| `packages/compiler/src/__tests__/validate-cross-agent.test.ts`             | integration | FR-5                    |
| `packages/compiler/src/__tests__/validate-flow-graph.test.ts`              | integration | FR-5                    |
| `packages/compiler/src/__tests__/validate-field-refs.test.ts`              | integration | FR-5                    |
| `packages/compiler/src/__tests__/validate-input-mappings.test.ts`          | integration | FR-5, FR-6              |
| `packages/compiler/src/__tests__/validate-preflight.test.ts`               | integration | FR-5                    |
| `packages/compiler/src/__tests__/validate-abl-export.test.ts`              | integration | FR-4                    |
| `packages/compiler/src/__tests__/validate-integration.test.ts`             | integration | FR-5                    |
| `packages/core/src/__tests__/agent-based-parser.test.ts`                   | unit        | FR-1                    |
| `packages/core/src/__tests__/yaml-parser.test.ts`                          | unit        | FR-2                    |
| `packages/core/src/__tests__/expression-parser.test.ts`                    | unit        | FR-6                    |
| `packages/core/src/__tests__/lexer.test.ts`                                | unit        | FR-1, FR-10             |
| `packages/core/src/__tests__/supervisor-parser.test.ts`                    | unit        | FR-10                   |
| `packages/core/src/__tests__/tool-file-parser.test.ts`                     | unit        | FR-9                    |
| `packages/core/src/__tests__/tool-import-resolver.test.ts`                 | unit        | FR-9                    |
| `packages/language-service/src/__tests__/diagnostics.test.ts`              | unit        | FR-7                    |
| `packages/language-service/src/__tests__/completions.test.ts`              | unit        | FR-8                    |
| `packages/language-service/src/__tests__/hover.test.ts`                    | unit        | FR-8                    |
| `packages/language-service/src/__tests__/symbols.test.ts`                  | unit        | FR-8                    |
| `packages/language-service/src/__tests__/detect-format.test.ts`            | unit        | FR-3                    |
| `packages/language-service/src/__tests__/serialize-yaml.test.ts`           | unit        | FR-2                    |
| `packages/language-service/src/__tests__/cel-completions.test.ts`          | unit        | FR-6, FR-8              |

---

## Open Testing Questions

1. Should browser-level E2E tests be added for the Studio editing/diagnostics round-trip (edit -> save -> compile -> version)?
2. Should the CEL evaluator have dedicated fuzz testing for edge cases (BigInt overflow, deeply nested expressions)?
3. Should package-level minimum coverage thresholds be enforced in CI for `packages/core`, `packages/compiler`, and `packages/language-service`?

---

## Known Gaps

- Browser automation around the full Studio editing + diagnostics round-trip is lighter than the package-level parser/compiler coverage
- No package-wide minimum coverage thresholds enforced yet
- Cross-tenant/cross-project isolation for compile APIs is tested at the route level, not in compiler unit tests

---

## References

- Related feature doc: [docs/features/abl-language.md](../features/abl-language.md)
- Compiler E2E fixtures: `packages/compiler/src/__tests__/e2e/fixtures/`
- Validation codes: `packages/compiler/src/platform/ir/validation-types.ts`
