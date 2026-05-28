# Diagnostics Engine — Low-Level Design

## Implementation Structure

The Diagnostics Engine is implemented as a singleton `DiagnosticEngine` class with a pluggable analyzer registry. Analyzers are registered lazily via dynamic imports to avoid circular dependencies. The engine runs applicable analyzers based on depth level and aggregates findings into a structured report.

## Key Files

| File                                                           | Purpose                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/diagnostics/engine.ts`              | `DiagnosticEngine` class: `register()`, `diagnose()`, `getAnalyzersForDepth()`. Singleton via `getDiagnosticEngine()`. Lazy registration via `registerAnalyzers()` with `ensureAnalyzersReady()` guard. |
| `apps/runtime/src/services/diagnostics/types.ts`               | Core types: `DiagnosticFinding`, `DiagnosticEvidence`, `DiagnosticReport`, `DiagnosticContext`, `DiagnosticDepth`, `Analyzer` interface.                                                                |
| `apps/runtime/src/services/diagnostics/diagnostic-patterns.ts` | `runDiagnostics(request)`: scans trace events for signature patterns. Separate from analyzer engine. Returns `DiagnosticResult` with detected patterns.                                                 |

### Analyzers (7 plugins)

| File                                   | Category   | Codes                                                                            |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `analyzers/model-resolution.ts`        | infra      | Model chain resolution: agent -> project -> tenant -> platform                   |
| `analyzers/credential-chain.ts`        | infra      | LLM credential availability, scope, active status                                |
| `analyzers/encryption-availability.ts` | infra      | Encryption subsystem health for credential storage                               |
| `analyzers/tool-binding.ts`            | execution  | Tool bind success/failure, schema mismatches                                     |
| `analyzers/execution-status.ts`        | execution  | Execution completion, error states                                               |
| `analyzers/empty-response.ts`          | execution  | Empty response root cause (no model, no creds, tool failure, reasoning disabled) |
| `analyzers/flow-state.ts`              | behavioral | Flow execution state, stuck flows, loop detection                                |

### Depth Levels

| Depth    | Analyzers Included                                                     |
| -------- | ---------------------------------------------------------------------- |
| quick    | infra only: ModelResolution, CredentialChain, EncryptionAvailability   |
| standard | infra + execution: above + ToolBinding, ExecutionStatus, EmptyResponse |
| deep     | all: above + FlowState (behavioral)                                    |

### Key Function Signatures

- `DiagnosticEngine.register(analyzer: Analyzer): void`
- `DiagnosticEngine.diagnose(context: DiagnosticContext): Promise<DiagnosticReport>`
- `getDiagnosticEngine(): DiagnosticEngine` — singleton accessor
- `ensureAnalyzersReady(): Promise<void>` — await before first diagnose call
- `runDiagnostics(request: DiagnosticRequest): DiagnosticResult` — pattern detection (separate system)

## Test Files

| File                                          | Scenarios                                                   |
| --------------------------------------------- | ----------------------------------------------------------- |
| `__tests__/diagnostic-engine.test.ts`         | Engine lifecycle, depth filtering, failed analyzer handling |
| `__tests__/model-resolution-analyzer.test.ts` | Model chain steps, resolved info, missing model             |
| `__tests__/credential-chain-analyzer.test.ts` | Credential availability, scope, inactive                    |
| `__tests__/tool-binding-analyzer.test.ts`     | Success, failure, error details                             |
| `__tests__/encryption-analyzer.test.ts`       | Available, unavailable, degraded                            |
| `__tests__/execution-status-analyzer.test.ts` | Complete, incomplete, error                                 |
| `__tests__/empty-response-analyzer.test.ts`   | 4 root causes                                               |
| `__tests__/flow-state-analyzer.test.ts`       | Completion, stuck, loops                                    |
| `__tests__/arch-diagnostics.test.ts`          | Pattern signatures                                          |
| `__tests__/preflight-validation.test.ts`      | Pre-execution checks                                        |

## Known Gaps

| ID      | Gap                                                                | Severity | Notes                                         |
| ------- | ------------------------------------------------------------------ | -------- | --------------------------------------------- |
| GAP-001 | No REST API endpoint for diagnostics                               | Medium   | Only consumed via MCP tools and internal code |
| GAP-002 | No integration tests with real agent configs                       | Medium   | All tests use mock DiagnosticContext          |
| GAP-003 | Pattern detection and analyzer engine are separate systems         | Low      | Two different entry points for diagnostics    |
| GAP-004 | ensureAnalyzersReady() race condition not tested under concurrency | Low      | Single-threaded Node.js mitigates risk        |
