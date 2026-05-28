# ABLP Prathyusha/Deeksha Open Issues Regression Matrix

Date: 2026-05-06

Scope: open ABLP issues reported by Deeksha singh and Prathyusha Gopavaram that are assigned to Prasanna Arikala. Jira comments were reviewed, but Jira evidence is not treated as coverage. Coverage below means a repeatable test case exists in the repo or is explicitly defined here for execution.

## Summary

| Issue    | Scenario Family                   | Test Cases | Automated Coverage |
| -------- | --------------------------------- | ---------: | ------------------ |
| ABLP-734 | Runtime guardrails                |          5 | Covered            |
| ABLP-666 | WebSDK templates/actions          |          4 | Covered            |
| ABLP-623 | DSL intent.category handoff       |          3 | Covered            |
| ABLP-616 | DSL-imported tool availability    |          3 | Covered            |
| ABLP-732 | Optional tool return signature    |          4 | Covered            |
| ABLP-729 | Tool syntax contexts              |          5 | Covered            |
| ABLP-631 | Knowledge/SearchAI import binding |          4 | Covered            |
| ABLP-555 | Step-level reasoning GOAL prompt  |          2 | Covered            |
| ABLP-534 | PII render/runtime tool boundary  |         19 | Covered            |
| ABLP-517 | Generic error leak after retry    |          3 | Covered            |

## Jira Description and Comment Traceability

| Issue    | Jira-derived scenario                                                                                                             | Coverage file                                                                                                          | Status  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| ABLP-734 | Project-level active guardrail policy is included in runtime policy resolution.                                                   | `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`                                      | Covered |
| ABLP-734 | Provider-backed content-safety/PII/prompt-injection rule preserves provider/category/threshold/action.                            | `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`                                      | Covered |
| ABLP-734 | Empty provider or empty `llmCheck` preset does not create a no-op guardrail that silently passes.                                 | `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`                                      | Covered |
| ABLP-734 | Policy-defined guardrails apply even when the DSL has no `GUARDRAILS:` block.                                                     | `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`                                      | Covered |
| ABLP-734 | Studio edit flow keeps provider/status/settings/advanced fields instead of saving stripped shells.                                | `apps/studio/src/__tests__/components/guardrail-policy-form.test.tsx`                                                  | Covered |
| ABLP-666 | Runtime button `ACTIONS` are emitted as structured action content.                                                                | `apps/runtime/src/__tests__/execution/flow-rich-content-templates.test.ts`                                             | Covered |
| ABLP-666 | Handoff output preserves child rich content/buttons.                                                                              | `apps/runtime/src/__tests__/execution/flow-rich-content-templates.test.ts`                                             | Covered |
| ABLP-666 | WebSDK renders action templates as buttons rather than strings.                                                                   | `packages/web-sdk/src/__tests__/template-renderers.test.ts`                                                            | Covered |
| ABLP-666 | Clicking a button sends the selected value back as `action_submit`.                                                               | `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`, `packages/web-sdk/src/__tests__/react-components.test.tsx` | Covered |
| ABLP-623 | DSL parses explicit `INTENTS:` categories for `intent.category` handoff.                                                          | `packages/core/src/__tests__/parser/intents-section.test.ts`                                                           | Covered |
| ABLP-623 | Missing `INTENTS:` remains detectable so import/runtime validation can avoid implicit hallucinated routing.                       | `packages/core/src/__tests__/parser/intents-section.test.ts`                                                           | Covered |
| ABLP-623 | Pipeline classifier drops hallucinated categories outside the known set.                                                          | `apps/runtime/src/__tests__/pipeline-classifier.test.ts`                                                               | Covered |
| ABLP-616 | DSL-imported tools without project tools create generated global/project tool stubs.                                              | `packages/project-io/src/__tests__/core-direct-apply.test.ts`                                                          | Covered |
| ABLP-616 | Preview warns that generated tools still need endpoint/auth configuration.                                                        | `packages/project-io/src/__tests__/core-direct-apply.test.ts`                                                          | Covered |
| ABLP-616 | Existing declared tools are not deleted by `deleteUnmatched`.                                                                     | `packages/project-io/src/__tests__/core-direct-apply.test.ts`                                                          | Covered |
| ABLP-732 | UI/DSL generated tool signature without `-> returnType` is retained.                                                              | `packages/core/src/__tests__/tool-signature-optional-return.test.ts`                                                   | Covered |
| ABLP-732 | Standalone `.tools.abl` signature without `-> returnType` is retained.                                                            | `packages/core/src/__tests__/tool-signature-optional-return.test.ts`                                                   | Covered |
| ABLP-732 | Omitted return type defaults to `object`.                                                                                         | `packages/core/src/__tests__/tool-signature-optional-return.test.ts`                                                   | Covered |
| ABLP-732 | Invalid tool names error instead of silently disappearing from IR/LLM prompt.                                                     | `packages/core/src/__tests__/tool-signature-optional-return.test.ts`                                                   | Covered |
| ABLP-729 | `TOOLS:` declaration signature parses as a tool contract.                                                                         | `packages/core/src/__tests__/tool-signature-optional-return.test.ts`                                                   | Covered |
| ABLP-729 | `AVAILABLE_TOOLS: [tool_a, tool_b]` parses as reasoning tool references.                                                          | `packages/core/src/__tests__/yaml-flow-parser.test.ts`                                                                 | Covered |
| ABLP-729 | FLOW `CALL` with `WITH` and `AS` parses into canonical `callSpec`.                                                                | `packages/core/src/__tests__/dsl-extensions-parser.test.ts`                                                            | Covered |
| ABLP-729 | `ON_INPUT` branch function-call style parses into invocation data.                                                                | `packages/core/src/__tests__/parser/call-result-blocks.test.ts`                                                        | Covered |
| ABLP-729 | `ON_START`/`HOOKS` lowercase `call` forms parse into canonical `callSpec`.                                                        | `packages/core/src/__tests__/parser-on-start.test.ts`                                                                  | Covered |
| ABLP-631 | Imported Knowledge/SearchAI tool with stale source `tenant_id`/`index_id` requires binding validation.                            | `packages/project-io/src/__tests__/core-direct-apply.test.ts`                                                          | Covered |
| ABLP-631 | Import fails closed when no async SearchAI binding validator is wired.                                                            | `packages/project-io/src/__tests__/core-direct-apply.test.ts`                                                          | Covered |
| ABLP-631 | Import rejects stale SearchAI binding when target project index does not exist.                                                   | `packages/project-io/src/__tests__/core-direct-apply.test.ts`                                                          | Covered |
| ABLP-631 | Valid imported tools are represented as project tool operations so they can be edited/deleted rather than ghost agent-only tools. | `packages/project-io/src/__tests__/import-applier-tools.test.ts`                                                       | Covered |
| ABLP-555 | Step-scoped reasoning `GOAL:` is included in the LLM system prompt.                                                               | `apps/runtime/src/__tests__/execution/reasoning-zone-init-guard.test.ts`                                               | Covered |
| ABLP-555 | Agent-level goal remains fallback when a reasoning step omits `GOAL:`.                                                            | `apps/runtime/src/__tests__/execution/reasoning-zone-init-guard.test.ts`                                               | Covered |
| ABLP-534 | Masked preview for UUID does not leak raw value.                                                                                  | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Tokenized preview emits synthetic token instead of raw PII.                                                                       | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Random replacement preview emits generated data instead of raw PII.                                                               | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Random replacement is stable within one preview run.                                                                              | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Unsupported render mode fails closed to redacted output.                                                                          | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Built-in email masking works when no custom mask config is supplied.                                                              | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Built-in recognizer metadata is used when previewing saved built-in overrides.                                                    | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Comment follow-up: Redacted render mode overrides masked strategy instead of honoring masked output.                              | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Comment follow-up: Redacted render mode overrides random strategy instead of honoring random output.                              | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Comment follow-up: explicit email mask config applies across the full email, including the domain side after `@`.                 | `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`                                                         | Covered |
| ABLP-534 | Runtime LLM prompt rendering stays tokenized even when the display/render mode is redacted or random.                             | `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                                                         | Covered |
| ABLP-534 | Runtime blocks explicit raw LLM rendering when input redaction is enabled.                                                        | `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                                                         | Covered |
| ABLP-534 | API tool calls from reasoning mode receive the original PII value while traces retain the protected token.                        | `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                                                         | Covered |
| ABLP-534 | API tool calls from scripted FLOW `CALL` receive the original PII value while DSL call traces retain the protected token.         | `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`                                                | Covered |
| ABLP-534 | API tool calls from lifecycle HOOKS receive the original PII value without mutating session state back to raw PII.                | `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                                                         | Covered |
| ABLP-534 | API tool calls from synchronous fan-out receive the original PII value while fan-out traces retain protected params.              | `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                                                         | Covered |
| ABLP-534 | API tool calls from async fan-out barrier execution receive the original PII value.                                               | `apps/runtime/src/__tests__/routing/async-fanout-execution.test.ts`                                                    | Covered |
| ABLP-534 | Session read surfaces mask the original value, not a generated random replacement, when user masking overrides random defaults.   | `apps/runtime/src/__tests__/pii/runtime-pii-boundary-service.test.ts`                                                  | Covered |
| ABLP-534 | Trace read surfaces use the same runtime PII boundary for custom-pattern payloads.                                                | `apps/runtime/src/__tests__/pii/runtime-pii-boundary-service.test.ts`                                                  | Covered |
| ABLP-517 | Top-level runtime errors still surface to SDK as user-visible terminal errors.                                                    | `apps/studio/src/__tests__/studio-transport.test.ts`                                                                   | Covered |
| ABLP-517 | Transient `trace_event:error` retry diagnostics are filtered from the user transcript.                                            | `apps/studio/src/__tests__/studio-transport.test.ts`                                                                   | Covered |
| ABLP-517 | Successful `response_end` after transient trace error renders only the final assistant response.                                  | `apps/studio/src/__tests__/studio-transport.test.ts`                                                                   | Covered |

## Test Cases

### ABLP-734 Guardrails Are Not Working During Runtime

1. Provider-backed project policy with `status: active` and `isActive: true` is loaded into runtime policy resolution.
2. Active provider-backed define rule becomes an executable model-tier guardrail with provider/category/threshold/action preserved.
3. Define rules with empty `provider`, empty `llmCheck`, and no CEL `check` are ignored instead of creating a no-op local guardrail.
4. Runtime policy resolution includes policy-defined guardrails even when the DSL has no `GUARDRAILS:` block.
5. Studio guardrail form preserves stored provider, status, settings, and advanced policy fields while editing.

Automation:

- `apps/runtime/src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts`
- `apps/studio/src/__tests__/components/guardrail-policy-form.test.tsx`

### ABLP-666 Templates Are Not Rendering on WebSDK

1. Runtime FLOW response with `ACTIONS` produces `ActionSetIR` button elements, not plain text.
2. Handoff outcome preserves child rich content and buttons through Web Chat channel outcome building.
3. WebSDK action renderer renders action elements as native `<button>` controls.
4. Button click submits the selected button value back through `action_submit` instead of only rendering text.

Automation:

- `apps/runtime/src/__tests__/execution/flow-rich-content-templates.test.ts`
- `packages/web-sdk/src/__tests__/template-renderers.test.ts`
- `packages/web-sdk/src/__tests__/rich-renderer-dom.test.ts`
- `packages/web-sdk/src/__tests__/react-components.test.tsx`

### ABLP-623 Handoff Issues with `intent.category` DSL

1. `INTENTS:` section parses explicit categories used by `HANDOFF WHEN: intent.category == ...`.
2. Missing `INTENTS:` section remains detectable as absent parser output so import/runtime validation can distinguish explicit vs implicit intent routing.
3. Pipeline classifier drops hallucinated categories that are not part of the known intent set.

Automation:

- `packages/core/src/__tests__/parser/intents-section.test.ts`
- `apps/runtime/src/__tests__/pipeline-classifier.test.ts`
- `apps/runtime/src/__tests__/execution/reasoning-pipeline-contract.test.ts`

### ABLP-616 Tools Attached Without Global Tool Creation

1. Agent-imported `TOOLS:` signatures without matching project tools create generated tool stubs in the import plan.
2. Generated stubs are surfaced in preview warnings so users know endpoint/auth configuration is still required.
3. Existing declared tools are retained and not deleted when `deleteUnmatched` is enabled.

Automation:

- `packages/project-io/src/__tests__/core-direct-apply.test.ts`

### ABLP-732 Reasoning Tools Without Return Signature Are Dropped

1. Agent `TOOLS:` entry without `-> returnType` is retained by the parser.
2. Standalone `.tools.abl` entry without `-> returnType` is retained by the parser.
3. Default return type is `object` when omitted.
4. Invalid dotted tool names produce explicit parser errors instead of silent drops.

Automation:

- `packages/core/src/__tests__/tool-signature-optional-return.test.ts`

### ABLP-729 Tool Reference and Invocation Syntax

1. `TOOLS:` declaration signature is parsed as a tool contract.
2. Reasoning `AVAILABLE_TOOLS: [tool_a, tool_b]` is parsed as available tool references.
3. Scripted FLOW `CALL` with `WITH` and `AS` is parsed into canonical `callSpec`.
4. `ON_INPUT` branch `CALL` forms are parsed into branch-level invocation data.
5. `ON_START` and `HOOKS` `CALL WITH/AS` are parsed into canonical `callSpec`.

Automation:

- `packages/core/src/__tests__/tool-signature-optional-return.test.ts`
- `packages/core/src/__tests__/yaml-flow-parser.test.ts`
- `packages/core/src/__tests__/dsl-extensions-parser.test.ts`
- `packages/core/src/__tests__/parser-on-start.test.ts`
- `packages/core/src/__tests__/parser/call-result-blocks.test.ts`

### ABLP-631 Knowledge Base Binding Orphaned on App Import

1. SearchAI/knowledge tools with legacy `tenant_id` and stale `index_id` require referential binding validation.
2. Import fails closed when no async binding validator is wired for a SearchAI tool.
3. Import rejects stale SearchAI binding when the validator reports the index does not exist in the target project.
4. Valid imported tools remain editable/deleteable through the generated project-tool operation plan rather than being hidden as ghost agent-only tools.

Automation:

- `packages/project-io/src/__tests__/core-direct-apply.test.ts`
- `packages/project-io/src/__tests__/import-applier-tools.test.ts`

### ABLP-555 Step-Level GOAL Not Attached to Reasoning Prompt

1. FLOW reasoning step with step-scoped `GOAL:` sends that step goal into the LLM system prompt.
2. Agent-level goal remains the fallback when a reasoning step omits `GOAL:`.

Automation:

- `apps/runtime/src/__tests__/execution/reasoning-zone-init-guard.test.ts`

### ABLP-534 PII Render Mode and Runtime Tool Boundary

1. Masked preview does not leak the raw UUID.
2. Tokenized preview emits a synthetic token and does not leak raw PII.
3. Random preview emits generated replacement data and does not leak raw PII.
4. Random replacement is stable within one test run.
5. Unsupported render mode fails closed to redacted output.
6. Built-in email masking preserves the domain behavior.
7. Built-in recognizer preview uses recognizer metadata where available and falls back safely when unavailable.
8. Redacted render mode overrides masked strategy and displays a redaction label.
9. Redacted render mode overrides random strategy and displays a redaction label.
10. Explicit email mask configuration applies across the full email value, including after `@`.
11. LLM prompt rendering remains tokenized when custom-pattern display mode is redacted.
12. LLM prompt rendering remains tokenized when custom-pattern display mode is random.
13. Explicit raw LLM rendering is blocked when input redaction is enabled.
14. Reasoning-mode API tools receive original values at execution time while trace input stays protected.
15. Scripted FLOW API tools receive original values at execution time while `dsl_call` params stay protected.
16. Lifecycle HOOK API tools receive original values at execution time without writing raw PII back into session state.
17. Synchronous fan-out API tool tasks receive original values at execution time while trace params stay protected.
18. Async fan-out barrier API tool tasks receive original values at execution time.
19. Session and trace read surfaces render masks from the original value, not a generated replacement, when user-visible masking overrides a random default.

Automation:

- `apps/runtime/src/__tests__/pii-pattern-preview-modes.test.ts`
- `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`
- `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`
- `apps/runtime/src/__tests__/routing/async-fanout-execution.test.ts`
- `apps/runtime/src/__tests__/pii/runtime-pii-boundary-service.test.ts`

### ABLP-517 Generic Error Leak After Successful Tool Retry

1. Top-level runtime `error` messages still translate to SDK-visible errors.
2. Transient `trace_event:error` diagnostics are filtered from the user transcript.
3. A successful `response_end` after a transient trace error renders only the successful assistant response.

Automation:

- `apps/studio/src/__tests__/studio-transport.test.ts`

## Verification Results

`pnpm build` passed before the original cross-issue targeted test run: 55/55 Turbo tasks successful. The PII/API-tool follow-up also passed `pnpm --filter @agent-platform/runtime build`.

| Command                                                                                                                                                                                                                                                                                                                                          | Result                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `pnpm --filter @abl/core exec vitest run src/__tests__/parser/intents-section.test.ts src/__tests__/tool-signature-optional-return.test.ts --maxWorkers=1`                                                                                                                                                                                       | Passed: 2 files, 15 tests |
| `pnpm --filter @abl/core exec vitest run src/__tests__/yaml-flow-parser.test.ts src/__tests__/dsl-extensions-parser.test.ts src/__tests__/parser-on-start.test.ts src/__tests__/parser/call-result-blocks.test.ts --maxWorkers=1`                                                                                                                | Passed: 4 files, 37 tests |
| `pnpm --filter @agent-platform/web-sdk exec vitest run src/__tests__/template-renderers.test.ts src/__tests__/rich-renderer-dom.test.ts src/__tests__/react-components.test.tsx --maxWorkers=1`                                                                                                                                                  | Passed: 3 files, 85 tests |
| `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/pii-pattern-preview-modes.test.ts src/__tests__/execution/flow-rich-content-templates.test.ts src/__tests__/execution/reasoning-pipeline-contract.test.ts src/__tests__/execution/guardrails/pipeline-factory-policy.test.ts` | Passed: 4 files, 69 tests |
| `pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/execution/reasoning-zone-init-guard.test.ts src/__tests__/pipeline-classifier.test.ts`                                                                                                                                        | Passed: 2 files, 25 tests |
| `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/reported-pii-masking-gaps.test.ts src/__tests__/pii/runtime-pii-boundary-service.test.ts`                                                                                                                                                                                   | Passed: 2 files, 31 tests |
| `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/execution/flow-authored-output-pii.test.ts -t "detokenizes flow API tool params"`                                                                                                                                                                                           | Passed: 1 file, 1 test    |
| `pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/routing/async-fanout-execution.test.ts -t "detokenizes API tool params"`                                                                                                                                                                                                    | Passed: 1 file, 1 test    |
| `pnpm --filter @agent-platform/studio exec vitest run src/__tests__/studio-transport.test.ts src/__tests__/components/guardrail-policy-form.test.tsx --maxWorkers=1`                                                                                                                                                                             | Passed: 2 files, 44 tests |
| `pnpm --filter @agent-platform/project-io exec vitest run src/__tests__/core-direct-apply.test.ts src/__tests__/import-applier-tools.test.ts --maxWorkers=1`                                                                                                                                                                                     | Passed: 2 files, 38 tests |

Note: an initial verification attempt used `--runInBand`, which this repo's Vitest version does not support. The command was rerun with `--maxWorkers=1`.
