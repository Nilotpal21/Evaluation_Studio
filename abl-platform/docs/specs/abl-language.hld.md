# HLD: ABL Language

**Feature**: ABL Language
**Status**: STABLE
**Author**: Platform team
**Date**: 2026-03-22
**Feature Spec**: [docs/features/abl-language.md](../features/abl-language.md)
**Test Spec**: [docs/testing/abl-language.md](../testing/abl-language.md)

---

## 1. Problem Statement

The platform requires a single authoring language that can define agent behavior (goals, tools, flows, constraints, handoffs, guardrails) and compile it into a portable, framework-agnostic intermediate representation (IR) consumed by all runtimes. Without this, agent definitions would fragment across runtime-specific formats, validation would be inconsistent, and Studio could not provide rich editor diagnostics.

ABL Language addresses this by providing a two-format DSL (uppercase and YAML), a shared AST (`AgentBasedDocument`), a compilation pipeline that produces `AgentIR`, and a language service that powers Studio editing with diagnostics, completions, hover, and symbols.

---

## 2. Alternatives Considered

### Alternative A: Single YAML-Only Format

**Description**: Drop the uppercase DSL format entirely. All agent authoring uses YAML with `js-yaml` parsing.

**Pros**:

- Single parser codepath reduces maintenance burden
- YAML is widely known and tooling-rich (schema validation, linters)
- Simpler format detection (always YAML)

**Cons**:

- Breaking change for existing uppercase DSL users (production agents use uppercase format)
- Uppercase DSL is the domain convention documented in ABL specification materials
- Lose the more expressive, human-readable section-header syntax that some teams prefer
- Migration effort for existing agent definitions

**Effort**: L (migration tooling, user communication, deprecation period)

### Alternative B: Full Grammar-Based Parser (Chevrotain/ANTLR for Both Formats)

**Description**: Replace the regex-based line scanner for uppercase DSL with a full Chevrotain grammar (like the supervisor parser already uses).

**Pros**:

- Better error recovery and more precise error messages
- Grammar-based parsing enables true LSP with semantic analysis
- CST provides source position information for source maps
- Shared infrastructure between agent and supervisor parsing

**Cons**:

- The regex-based parser works correctly today (6,701 LOC, 25+ test files passing)
- Rewrite risk is high for a core component with no production bugs
- Chevrotain grammar for the full ABL surface would be complex (~30+ section types)
- Dual maintenance during migration period

**Effort**: XL (full parser rewrite, regression testing, migration)

### Alternative C: Current Architecture (Recommended)

**Description**: Maintain the current dual-parser architecture with shared AST types and unified IR compilation.

**Pros**:

- Both formats are production-proven and well-tested (200+ test files)
- Shared `AgentBasedDocument` AST ensures format-agnostic compilation
- Uppercase and YAML formats serve different user preferences without compromise
- Minimal risk -- no rewrite needed

**Cons**:

- Two parser codepaths to maintain
- Language service operates on heuristics, not full semantic analysis
- No incremental compilation (full recompile on every change)

**Effort**: S (ongoing maintenance, no new development required)

**Recommendation**: Alternative C. The current architecture is production-stable with strong test coverage. The dual-parser model is intentional (both formats are active domain conventions). Rewriting the parser (Alt B) carries high risk for no functional gain. Dropping uppercase DSL (Alt A) would break existing workflows. Future improvements (incremental compilation, better diagnostics) can be layered on the current architecture.

---

## 3. Architecture

### System Context Diagram

```
+---------------------+
|    Agent Developer   |
|    (Studio UI)       |
+---------------------+
         |
         | edits DSL / YAML
         v
+---------------------+     +-----------------------+
|   apps/studio       |     |   apps/runtime        |
|   /api/abl/*        |---->|   /api/.../validate   |
|   (compile, diag,   |     |   /api/.../versions   |
|    parse, docs)     |     +-----------------------+
+---------------------+              |
         |                            | consumes compiled IR
         v                            v
+---------------------+     +-----------------------+
| packages/           |     |  agent_versions       |
| language-service    |     |  (MongoDB)            |
| (diagnostics,       |     |  irContent field      |
|  completions,       |     +-----------------------+
|  hover, symbols)    |
+---------------------+
         |
         | uses
         v
+---------------------+
| packages/core       |
| (parser, types,     |
|  schema, lexer)     |
+---------------------+
         |
         | produces AST
         v
+---------------------+
| packages/compiler   |
| (IR compiler,       |
|  validators, CEL,   |
|  guardrails)        |
+---------------------+
         |
         | produces AgentIR
         v
+---------------------+
| CompilationOutput   |
| {agents, errors,    |
|  warnings, hints}   |
+---------------------+
```

### Component Diagram

```
packages/core
├── parser/
│   ├── agent-based-parser.ts    (uppercase DSL -> AgentBasedDocument)
│   ├── yaml-parser.ts           (YAML -> AgentBasedDocument)
│   ├── expression-parser.ts     (CEL/legacy expressions)
│   ├── lexer.ts                 (Chevrotain tokens, supervisor only)
│   ├── supervisor-parser.ts     (SUPERVISOR: documents)
│   ├── tool-file-parser.ts      (.tools.abl files)
│   └── tool-import-resolver.ts  (cross-file imports)
├── types/
│   ├── agent-based.ts           (AgentBasedDocument AST)
│   ├── base.ts                  (DocumentMeta, TypeDefinition)
│   ├── expressions.ts           (Expression, Condition)
│   ├── supervisor.ts            (SupervisorDocument)
│   └── tool-file.ts             (ToolFileDocument)
└── schema/
    └── abl-schema.json          (JSON Schema for YAML validation)

packages/compiler
├── platform/ir/
│   ├── compiler.ts              (compileABLtoIR: AST -> AgentIR)
│   ├── schema.ts                (AgentIR, CompilationOutput types)
│   ├── validate-ir.ts           (validation orchestrator)
│   ├── validate-cross-agent.ts  (handoff/delegate refs)
│   ├── validate-field-refs.ts   (condition variables)
│   ├── validate-preflight.ts    (deployment readiness)
│   ├── validate-input-mappings.ts (CEL safety)
│   ├── graph-extractor.ts       (flow visualization)
│   ├── guardrail-validator.ts   (guardrail IR validation)
│   ├── auth-config-builder.ts   (AUTH: -> AuthConfigIR)
│   ├── compile-behavior-profile.ts (profile compilation)
│   └── recall-validation.ts     (RECALL event validation)
├── platform/constructs/
│   ├── cel-evaluator.ts         (CEL evaluation + BigInt normalization)
│   └── cel-functions.ts         (35+ abl.* functions)
└── platform/constants.ts        (system tool names, defaults)

packages/language-service
├── diagnostics.ts               (3-tier: syntax, structural, compile)
├── completions.ts               (context-aware completions)
├── hover.ts                     (keyword documentation)
├── symbols.ts                   (document symbol extraction)
├── detect-format.ts             (YAML vs uppercase heuristic)
├── serialize-yaml.ts            (IR -> YAML round-trip)
├── docs.ts                      (keyword docs registry)
├── cel-functions.ts             (CEL function metadata)
└── types.ts                     (Diagnostic, CompletionItem, etc.)
```

### Data Flow

1. **Editor Input**: Agent developer writes DSL or YAML in Studio editor
2. **Format Detection**: `detect-format.ts` inspects first non-empty line to determine format
3. **Parsing**: Either `agent-based-parser.ts` (uppercase) or `yaml-parser.ts` (YAML) produces `AgentBasedDocument[]`
4. **Diagnostics** (parallel path): `diagnostics.ts` runs 3-tier checks and returns to editor
5. **Compilation**: `compileABLtoIR()` processes documents:
   - Separates behavior profiles from agents
   - Compiles profiles first (`compileBehaviorProfile()`)
   - Compiles each agent document (`compileAgentToIR()`)
   - Attaches profiles to referencing agents (`attachProfilesToAgent()`)
   - Resolves config variables (`CONFIG_VAR_PATTERN`)
   - Generates source hashes (SHA-256)
6. **Validation**: `validateIR()` runs all post-compilation validators
7. **Output**: `CompilationOutput` with agents, errors, warnings, deployment hints
8. **Storage**: Versioning route stores `irContent` + `toolSnapshot` in `agent_versions`

### Sequence Diagram: Compile Request

```
Studio Editor          Studio API          Language Service     Core Parser       Compiler           Validators
     |                     |                     |                  |                |                   |
     |-- POST /api/abl/compile ----------------->|                  |                |                   |
     |                     |-- detectFormat() --->|                  |                |                   |
     |                     |<-- "yaml" / "dsl" --|                  |                |                   |
     |                     |-- parseAgentBasedABL() --------------->|                |                   |
     |                     |                     |                  |-- parse() ---->|                   |
     |                     |<-- AgentBasedDocument[] ---------------|                |                   |
     |                     |-- compileABLtoIR(docs, opts) -------------------------------->|             |
     |                     |                     |                  |    separateProfiles() |             |
     |                     |                     |                  |    compileAgentToIR() |             |
     |                     |                     |                  |    attachProfiles()   |             |
     |                     |                     |                  |    resolveConfigVars()|             |
     |                     |                     |                  |    generateHash()     |             |
     |                     |<-- CompilationOutput (pre-validation) -|                      |             |
     |                     |-- validateIR(agents) -------------------------------------------------->|  |
     |                     |                     |                  |                |   flowGraph()    |
     |                     |                     |                  |                |   toolRefs()     |
     |                     |                     |                  |                |   crossAgent()   |
     |                     |                     |                  |                |   fieldRefs()    |
     |                     |                     |                  |                |   guardrails()   |
     |                     |                     |                  |                |   preflight()    |
     |                     |<-- ValidationDiagnostic[] --------------------------------------------|  |
     |<-- CompilationOutput + diagnostics --------|                  |                |                   |
     |                     |                     |                  |                |                   |
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | How It Is Addressed                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | The compiler itself is stateless and tenant-agnostic -- it takes DSL source and options as input and returns IR. Tenant isolation is enforced at the route level: `project_agents` queries include `tenantId`, Studio compile API routes operate within project-scoped sessions, and runtime validation routes use `requireProjectPermission()`. Cross-tenant access returns 404.                             |
| 2   | **Data Access Pattern** | No direct database access in the compiler/parser/language-service packages. These are pure function libraries. Data access occurs in Studio API routes (project_agents, agent_versions) and runtime routes (versions, validate), which follow the repository pattern with tenantId/projectId scoping.                                                                                                         |
| 3   | **API Contract**        | Studio compile API: `POST /api/abl/compile` accepts `{ source: string, options?: CompilerOptions }` and returns `CompilationOutput`. Runtime validation: `POST /api/projects/:projectId/validate`. Error envelope follows the platform standard: `{ success: boolean, data?: ..., error?: { code, message } }`. Compile errors are structured as `CompilationError[]` with `agent`, `message`, `type` fields. |
| 4   | **Security Surface**    | System tool names cannot be shadowed by user declarations. CEL expressions are length-capped at 4,096 bytes. Config variables resolve at compile time; secrets are not embedded in IR (injected at runtime). Guardrail validation ensures safety constraints are well-formed. Input validation occurs at the parse level (malformed DSL produces diagnostics, not crashes).                                   |

### Behavioral Concerns

| #   | Concern           | How It Is Addressed                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Three categories of errors: (a) parse errors -- syntax issues surfaced as diagnostics in the editor, non-blocking for compilation; (b) compilation errors -- blocking, agents with errors are omitted from `CompilationOutput.agents`; (c) validation warnings -- non-blocking, surfaced in `CompilationOutput.compilation_warnings`. All errors carry structured data: agent name, message, optional path, machine-readable code (20+ `VALIDATION_CODES`). |
| 6   | **Failure Modes** | Compilation timeout (E727) prevents runaway compilations (default 30s). Parse failures for individual agents don't crash the batch -- other agents continue compiling. CEL evaluation failures are caught and reported as diagnostics. If `@marcbachmann/cel-js` throws, the error is caught and normalized. No network dependencies during compilation (pure CPU-bound).                                                                                   |
| 7   | **Idempotency**   | Compilation is purely functional: same input always produces same output (excluding timestamps). Source hash generation is deterministic (SHA-256 of source string). Calling `compileABLtoIR()` multiple times with the same input is safe and produces identical results.                                                                                                                                                                                  |
| 8   | **Observability** | `CompilationOutput` carries structured `compilation_errors` and `compilation_warnings` arrays. Validation diagnostics include machine-readable codes (`VALIDATION_CODES`) for programmatic processing. Studio and runtime routes log compile failures via `createLogger()`. Version creation preserves compile error history. No custom trace events within the compiler itself (it is a synchronous library, not a service).                               |

### Operational Concerns

| #   | Concern                | How It Is Addressed                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Target: P95 compile latency < 5s for single-agent definitions. Compilation is synchronous and CPU-bound. Studio debounces diagnostic requests to prevent flooding. CEL expression length capped at 4,096 bytes. The main performance concern is tool/config resolution (I/O), not AST generation. Compilation timeout at 30s catches pathological cases.                      |
| 10  | **Migration Path**     | No migration needed -- this is an existing, production-stable feature. Format evolution is additive (new sections/constructs added to both parsers). YAML format added alongside uppercase DSL without breaking changes. IR schema versioning via `ir_version` field enables forward compatibility.                                                                           |
| 11  | **Rollback Plan**      | Compiler is a library -- rollback is a package version revert. No database migrations, no state changes. Agent versions with `irContent` are immutable snapshots, so rolling back the compiler does not affect previously compiled versions. New compilations after rollback will use the previous compiler version.                                                          |
| 12  | **Test Strategy**      | Unit tests: 200+ test files across 3 packages (core: 25, compiler: 168, language-service: 7). Integration tests: 9 validator integration suites. E2E tests: 3 full pipeline tests plus 1 dual-format parity test. Coverage target: maintain current pass rates, add browser-driven E2E for Studio compile loop. See [test spec](../testing/abl-language.md) for full details. |

---

## 5. Data Model

### Existing Collections (No Changes)

The ABL Language feature operates on existing collections:

```text
Collection: project_agents
Purpose: Stores agent DSL source and metadata
Key Fields:
  - _id, tenantId, projectId, name, dslContent, ownerId, status
Indexes:
  - { tenantId: 1, projectId: 1 }
  - { projectId: 1, name: 1 } (unique)
```

```text
Collection: agent_versions
Purpose: Immutable compiled snapshots for deployment
Key Fields:
  - _id, tenantId, projectId, agentId, version, status
  - dslContent (frozen), irContent (JSON AgentIR), sourceHash (SHA-256)
  - toolSnapshot (frozen tool defs)
Indexes:
  - { agentId: 1, version: 1 } (unique)
  - { agentId: 1, createdAt: -1 }
```

### In-Memory Data Structures

| Structure                         | Package            | Purpose                                      | Size Bound                |
| --------------------------------- | ------------------ | -------------------------------------------- | ------------------------- |
| `AgentBasedDocument[]`            | core/types         | Parse output, compiler input                 | Bounded by source size    |
| `CompilationOutput`               | compiler/ir        | Compile output with agents, errors, warnings | Bounded by document count |
| `Map<string, BehaviorProfileIR>`  | compiler/ir        | Compiled profiles during compilation         | Bounded by profile count  |
| `Set<string>` (SYSTEM_TOOL_NAMES) | compiler/constants | Reserved tool names                          | Fixed (6 entries)         |

---

## 6. API Design

### Existing Endpoints (No Changes)

| Method | Path                                                | Auth               | Purpose                |
| ------ | --------------------------------------------------- | ------------------ | ---------------------- |
| POST   | `/api/abl/compile`                                  | Studio session     | Compile DSL to IR      |
| POST   | `/api/abl/diagnostics`                              | Studio session     | 3-tier diagnostics     |
| POST   | `/api/abl/parse`                                    | Studio session     | Parse DSL to AST       |
| GET    | `/api/abl/docs`                                     | Studio session     | Language docs/snippets |
| POST   | `/api/abl/analysis`                                 | Studio session     | Analysis helpers       |
| POST   | `/api/projects/:projectId/validate`                 | Project permission | Project validation     |
| POST   | `/api/projects/:projectId/agents/:agentId/versions` | Project permission | Version creation       |

### Error Responses

All endpoints follow the platform error envelope:

```json
{
  "success": false,
  "error": {
    "code": "COMPILATION_ERROR",
    "message": "Agent 'Booking' has unresolved handoff target 'NonExistent'"
  }
}
```

Compile-specific errors also include structured `CompilationOutput`:

```json
{
  "agents": {},
  "compilation_errors": [
    {
      "agent": "Booking",
      "message": "Unresolved handoff target: NonExistent",
      "type": "validation"
    }
  ],
  "compilation_warnings": []
}
```

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Version creation events (who compiled, what changed) are tracked via `agent_versions` metadata (`createdBy`, `promotedBy`, `promotedAt`)
- Source hashes enable change detection between versions
- Tool snapshots provide full auditability of what was deployed

### Rate Limiting

- Studio compile API is rate-limited by the standard Studio middleware
- No custom rate limiting within the compiler itself (it is a synchronous library call)

### Caching

- No compilation result caching (compilation is stateless and fast)
- LLM response caching (`LLM_CACHE_ENABLED`) is used only in tests, not production compilation
- Studio debounces diagnostic requests client-side to reduce API call frequency

### Encryption

- DSL source stored in `project_agents.dslContent` follows platform encryption-at-rest policy
- Compiled IR in `agent_versions.irContent` follows the same policy
- No secrets embedded in IR output -- credential injection happens at runtime

---

## 8. Dependencies

### Upstream (ABL Language Depends On)

| Dependency             | Package  | Risk   | Notes                                                                  |
| ---------------------- | -------- | ------ | ---------------------------------------------------------------------- |
| `js-yaml`              | external | Low    | Well-maintained YAML parser, used only for YAML format                 |
| `chevrotain`           | external | Low    | Used only for supervisor parser (lexer + CST)                          |
| `@marcbachmann/cel-js` | external | Medium | CEL evaluator with BigInt quirks (GAP-006). Wrapping layer normalizes. |
| `crypto` (Node.js)     | stdlib   | None   | SHA-256 source hashing                                                 |

### Downstream (Depends on ABL Language)

| Consumer                   | Impact | Notes                                                                     |
| -------------------------- | ------ | ------------------------------------------------------------------------- |
| Runtime execution          | High   | Runtime executes compiled IR; compiler changes affect all agent execution |
| Studio editor              | High   | Editor depends on language-service for diagnostics, completions, hover    |
| Versioning/deployment      | Medium | Version creation depends on `compileABLtoIR()` output                     |
| Project IO (import/export) | Medium | Import/export depends on parse + compile pipeline                         |
| Topology visualization     | Low    | Graph extractor provides flow visualization data                          |

---

## 9. Open Questions & Decisions Needed

| #   | Question                                              | Status       | Notes                                                                                             |
| --- | ----------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| 1   | Should incremental compilation be implemented?        | OPEN         | Current full-recompile model works but may cause latency for large multi-agent projects (GAP-005) |
| 2   | Should language service move toward full LSP?         | OPEN         | Current heuristic-based approach works for Studio but limits IDE integration (GAP-008)            |
| 3   | Should source maps be fully implemented?              | OPEN         | `include_source_maps` declared but not implemented (GAP-007)                                      |
| 4   | Should package-level coverage thresholds be enforced? | OPEN         | No minimum coverage gates in CI currently (GAP-003)                                               |
| 5   | Should a dedicated ABL linter CLI be built?           | LOW PRIORITY | Currently requires programmatic import of `compileABLtoIR()` (GAP-009)                            |

---

## 10. References

- Feature spec: [docs/features/abl-language.md](../features/abl-language.md)
- Test spec: [docs/testing/abl-language.md](../testing/abl-language.md)
- IR Schema: `packages/compiler/src/platform/ir/schema.ts`
- AST Types: `packages/core/src/types/agent-based.ts`
- CEL Functions: `packages/compiler/src/platform/constructs/cel-functions.ts`
- Validation Codes: `packages/compiler/src/platform/ir/validation-types.ts`
