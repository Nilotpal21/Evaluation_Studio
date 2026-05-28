# Project Tool Contract Coverage Matrix

Date: 2026-05-05

Scope: reusable project tool propagation from Studio authoring to DB persistence, import/export, DSL parse/serialize, compiler IR, deployment snapshots, and runtime execution.

This document replaces repeated open-ended audit passes with a bounded contract inventory. The goal is not to claim every cell is already tested. The goal is to make every cell explicit so hidden issues become named work items instead of being rediscovered one seam at a time.

## Legend

| Mark    | Meaning                                                                           |
| ------- | --------------------------------------------------------------------------------- |
| PASS    | Source inspection or existing tests show the field is handled in this lane.       |
| FAIL    | Confirmed defect or contract drift.                                               |
| PARTIAL | Some subfields or paths pass, but at least one subfield/path is missing.          |
| UNKNOWN | Lane exists but has not yet been proven by source inspection plus a focused test. |
| N/A     | Field intentionally does not apply to the lane.                                   |

## Canonical Lanes

| Lane                       | Boundary                                                     | Primary files                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 Studio create UI        | Wizard/detail form state before POST                         | `apps/studio/src/components/tools/*`, `apps/studio/src/components/tools/form-adapters.ts`, `apps/studio/src/api/tools.ts`                                                   |
| L2 Studio create API       | `POST /api/projects/:id/tools` validation and DSL creation   | `apps/studio/src/app/api/projects/[id]/tools/route.ts`, `packages/shared/src/validation/project-tool-schemas.ts`, `packages/shared/src/tools/serialize-tool-form-to-dsl.ts` |
| L3 DB persistence          | ProjectTool write/read with tenant/project scope             | `packages/shared/src/repos/project-tool-repo.ts`, database ProjectTool model                                                                                                |
| L4 Studio read/edit/export | GET/list/export response and edit adapters                   | `apps/studio/src/lib/tool-response.ts`, `apps/studio/src/app/api/projects/[id]/tools/[toolId]/export/route.ts`, `apps/studio/src/components/tools/form-adapters.ts`         |
| L5 Studio update/import    | PUT raw DSL, tool import, namespace/default handling         | `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`, `apps/studio/src/app/api/projects/[id]/tools/import/route.ts`                                              |
| L6 DSL parse/serialize     | Form <-> DSL and DSL -> binding IR local                     | `packages/shared/src/tools/parse-dsl-to-tool-form.ts`, `packages/shared/src/tools/dsl-property-parser.ts`, `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`        |
| L7 Binding validation      | Tool-type DB and identity validation                         | `apps/studio/src/lib/project-tool-binding-validation.ts`, `packages/shared/src/tools/validate-*-tool-binding.ts`                                                            |
| L8 Compile/IR shape        | Project tool resolution into compiler ToolDefinition/AgentIR | `packages/shared/src/tools/resolve-tool-implementations.ts`, `packages/compiler/src/platform/ir/schema.ts`                                                                  |
| L9 Deployment direct       | Direct deployment config resolution and fail-closed behavior | `apps/runtime/src/routes/deployments.ts`, `apps/runtime/src/services/tool-runtime-config-resolution.ts`                                                                     |
| L10 Deployment module      | Module dependency snapshot resolution and diagnostics        | `apps/runtime/src/services/modules/deployment-build-service.ts`, `apps/runtime/src/routes/deployments.ts`                                                                   |
| L11 Runtime dispatch       | ToolBindingExecutor and per-tool executor selection          | `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`                                                                                              |
| L12 Runtime executor       | HTTP/Sandbox/MCP/SearchAI/Workflow consumption               | `packages/compiler/src/platform/constructs/executors/*`, `apps/runtime/src/services/search-ai/*`, `apps/runtime/src/services/workflow/*`                                    |
| L13 Studio tool-test       | Studio-side test execution, diagnostics, rendered config     | `apps/studio/src/services/tool-test-service.ts`, Studio tool test routes                                                                                                    |

## Canonical Field Inventory

| Tool family | Field group           | Canonical DSL / IR keys                                                                                                                                                                  | Placeholder policy                                                                                                                 |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Common      | Identity and metadata | `name`, `description`, `parameters`, `returnType`, `tool_type`                                                                                                                           | No config placeholders except parameter defaults/descriptions as plain strings.                                                    |
| Common      | Namespace scope       | `variableNamespaceIds` in API/DB, `variable_namespace_ids` in IR                                                                                                                         | Required for namespace-scoped `env`, `secrets`, and `config` resolution.                                                           |
| HTTP        | Request identity      | `endpoint`, `method`                                                                                                                                                                     | `endpoint` may use `{{env.*}}`, `{{secrets.*}}`, `{{config.*}}` and must be resolved before SSRF validation.                       |
| HTTP        | Auth                  | `auth`, `auth_config`, `auth_profile_ref`, `auth_jit`, `consent`, `connection`                                                                                                           | Secrets/env/config allowed inside string auth material. `auth_profile_ref` is preserved for runtime middleware.                    |
| HTTP        | Request shape         | `headers`, `query_params`, `body`, `body_type`, `body_schema`, `use_body_schema`                                                                                                         | String placeholders allowed and resolved at runtime.                                                                               |
| HTTP        | Runtime numeric       | `timeout`, `retry`, `retry_delay`, `rate_limit`, `circuit_breaker.threshold`, `circuit_breaker.reset_ms`; IR uses `timeout_ms`, `retry.count`, `retry.delay_ms`, `rate_limit_per_minute` | Numbers or exact `{{config.KEY}}` templates. Must resolve to numbers before dispatch/executor use.                                 |
| HTTP        | SOAP                  | `protocol`, `soap_version`, `soap_action`, `on_soap_fault`                                                                                                                               | String policy, no numeric placeholder handling required.                                                                           |
| Sandbox     | Runtime/code          | `runtime`, `code`                                                                                                                                                                        | `code` may call runtime secret/env APIs; binding numeric fields must resolve before sandbox limits.                                |
| Sandbox     | Runtime numeric       | `timeout`, `memory_mb`; IR uses `timeout_ms`, `memory_mb`                                                                                                                                | Numbers or exact `{{config.KEY}}` templates. Must resolve to numbers before runner limits.                                         |
| MCP         | Server/tool identity  | `server`, `server_tool`, `transport_type`, `server_config`                                                                                                                               | Server/tool names are concrete selectors. Headers and params may contain placeholders.                                             |
| MCP         | Headers               | `headers`                                                                                                                                                                                | String placeholders resolved per call.                                                                                             |
| Workflow    | Workflow identity     | `workflow_id`, `workflow_version_id`, `workflow_version`, `trigger_id`, `mode`                                                                                                           | Identity fields reject config placeholders for live project tools unless an explicit module/import compatibility mode allows them. |
| Workflow    | Runtime numeric       | `timeout_ms`; IR uses `timeoutMs`                                                                                                                                                        | Numbers or exact `{{config.KEY}}` templates. Must resolve to number and be honored by workflow executor.                           |
| Workflow    | Param mapping         | `param_mapping`                                                                                                                                                                          | JSON object; no runtime numeric handling required.                                                                                 |
| SearchAI    | Identity              | `tenant_id`, `index_id`, `kb_name`                                                                                                                                                       | Live project tool validation rejects config placeholders for `tenant_id` and `index_id`.                                           |

## Coverage Matrix By Field Group

| Field group                   | L1 UI | L2 Create API | L3 DB | L4 Read/Edit/Export | L5 Update/Import | L6 DSL | L7 Validation | L8 IR | L9 Direct Deploy | L10 Module Deploy | L11 Dispatch | L12 Executor | L13 Tool-Test |
| ----------------------------- | ----- | ------------- | ----- | ------------------- | ---------------- | ------ | ------------- | ----- | ---------------- | ----------------- | ------------ | ------------ | ------------- |
| Common identity/metadata      | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PARTIAL           | PASS         | N/A          | PASS          |
| Common `variableNamespaceIds` | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PARTIAL       | PASS  | PASS             | PARTIAL           | PASS         | PARTIAL      | PARTIAL       |
| HTTP request identity         | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PARTIAL           | PASS         | PASS         | PASS          |
| HTTP auth fields              | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PARTIAL           | PASS         | PASS         | PASS          |
| HTTP request shape            | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PARTIAL           | PASS         | PASS         | PASS          |
| HTTP runtime numeric          | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| HTTP SOAP fields              | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| Sandbox runtime/code          | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PARTIAL           | PASS         | PASS         | PASS          |
| Sandbox runtime numeric       | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| MCP identity/server config    | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| MCP headers                   | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| Workflow identity/version     | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| Workflow runtime numeric      | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| Workflow param mapping        | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |
| SearchAI identity             | PASS  | PASS          | PASS  | PASS                | PASS             | PASS   | PASS          | PASS  | PASS             | PASS              | PASS         | PASS         | PASS          |

## Confirmed Failing Cells

No confirmed project-tool contract cells remain open in this matrix. Residual `PARTIAL` cells are broad parity follow-ups, not the high-value tool-test/module-deployment unknowns closed in Slice 17.

## Closed Cells

| ID              | Closed in | Cells moved to PASS                                                | Test/build evidence                                                                                                                                                                                                                                                                                                                    |
| --------------- | --------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PT-CONTRACT-001 | Slice 1   | HTTP/Sandbox/Workflow runtime numeric L8/L11/L12                   | `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`, `packages/compiler/src/__tests__/constructs/sandbox-tool-executor.test.ts`, `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts`; `pnpm --filter @abl/compiler build`                                                                   |
| PT-CONTRACT-003 | Slice 1   | Compiler IR L8                                                     | `packages/compiler/src/platform/ir/schema.ts` now models runtime numeric fields as `RuntimeNumericValue`; `pnpm --filter @abl/compiler build`                                                                                                                                                                                          |
| PT-CONTRACT-007 | Slice 1   | Workflow executor L12                                              | `apps/runtime/src/__tests__/workflow-tool-executor.test.ts`; focused runtime test passed. Full runtime build remains blocked by unrelated `guardrail-providers.ts` type errors in the dirty worktree.                                                                                                                                  |
| PT-CONTRACT-002 | Slice 2   | Module deployment L10                                              | `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts`; unresolved dependency config/runtime templates now emit error diagnostics and skip rewrite/snapshot.                                                                                                                                                   |
| PT-CONTRACT-004 | Slice 3   | Workflow runtime numeric L1/L4                                     | `apps/studio/src/__tests__/components/workflow-config-form-version-persistence.test.tsx`; `WorkflowConfigForm` now preserves `{{config.KEY}}` workflow timeout values and validation accepts exact config numeric templates.                                                                                                           |
| PT-CONTRACT-006 | Slice 4   | HTTP runtime numeric L13                                           | `apps/studio/src/__tests__/tool-test-service.test.ts`; Studio tool-test now coerces config-backed HTTP retry, retry delay, rate limit, and circuit-breaker numeric fields before executor setup.                                                                                                                                       |
| PT-CONTRACT-005 | Slice 16  | HTTP/Sandbox runtime numeric L1/L4                                 | `apps/studio/src/__tests__/form-adapters-runtime-numeric.test.ts`, `apps/studio/src/components/tools/__tests__/HttpConfigForm.test.ts`, and `apps/studio/src/components/tools/__tests__/SandboxConfigForm.test.ts`; Studio UI now displays, validates, edits, and preserves exact `{{config.KEY}}` runtime numeric placeholders.       |
| PT-UNKNOWN-001  | Slice 17  | HTTP SOAP fields L10/L13                                           | `apps/studio/src/__tests__/tool-test-service.test.ts` proves SOAP protocol/version/action, body formatting, auth, and config-backed runtime numeric values reach the Studio tool-test executor; `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts` proves unresolved SOAP module placeholders fail closed. |
| PT-UNKNOWN-002  | Slice 17  | MCP identity/headers L10/L13                                       | `apps/studio/src/__tests__/tool-test-service.test.ts` proves MCP headers resolve `{{config.KEY}}` through project config before executor setup; `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts` proves unresolved MCP module placeholders fail closed.                                                  |
| PT-UNKNOWN-003  | Slice 17  | Workflow identity/version/runtime numeric/param mapping L10/L13    | `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts` proves workflow version pins, trigger metadata, timeout, and param mapping register with the runtime workflow executor; module deployment unresolved workflow placeholders fail closed.                                                                       |
| PT-UNKNOWN-004  | Slice 17  | SearchAI identity L10/L13                                          | `apps/runtime/src/routes/__tests__/internal-tools-project-scope.test.ts` proves concrete SearchAI tenant/index bindings register with the runtime SearchAI executor; existing SearchAI binding validation rejects placeholder identity fields, and module deployment unresolved SearchAI placeholders fail closed.                     |
| PT-UNKNOWN-005  | Slice 17  | Module deployment for SOAP/MCP/Workflow/SearchAI/Sandbox snapshots | `apps/runtime/src/services/modules/__tests__/deployment-build-service.test.ts` now builds representative artifact tools with unresolved placeholders across the project-tool families and asserts deployment build returns diagnostics without rewriting or snapshotting.                                                              |

## High-Value UNKNOWN Cells

No high-value project-tool `UNKNOWN` cells remain open. Slice 17 converted `PT-UNKNOWN-001` through `PT-UNKNOWN-005` to deterministic regression locks. Future project-tool findings should add a new row instead of reusing these closed IDs.

## Test-First Closure Plan

1. Runtime numeric contract tests.
   Add focused compiler/runtime tests that build tool definitions with namespace-scoped `{{config.KEY}}` numeric fields and assert dispatch resolves to numbers before calling HTTP, Sandbox, and Workflow executors.

2. Module deployment fail-closed tests.
   Add tests for recompiled module artifacts and legacy `compiledIR` artifacts where unresolved `{{config.KEY}}` is present. Assert the module build returns `success: false` and the deployment route returns 422.

3. Type contract alignment tests.
   Update compiler IR types to accept a shared `RuntimeNumericValue` alias, then add type-level or compile-time fixture coverage that prevents numeric-only drift.

4. Studio runtime numeric UI tests.
   Add component/API tests that load existing HTTP, Sandbox, and Workflow tools with placeholder-backed numeric values, verify the UI shows a placeholder-aware state, and verify unrelated edits preserve the placeholders.

5. Tool-test parity tests.
   Add Studio tool-test tests for HTTP retry/circuit breaker placeholders, Workflow timeout/param mapping, SOAP fields, MCP headers, and SearchAI identity rejection.

## How To Keep The List Complete

Every future audit should add rows here instead of only returning findings. A review finding is complete only when it maps to:

1. A field group.
2. One or more lanes.
3. A status transition, usually `UNKNOWN -> FAIL` or `FAIL -> PASS`.
4. A focused regression test or an explicit reason the lane is `N/A`.

This gives us a finite backlog: close all `FAIL` and `UNKNOWN` cells, then require new tool fields to extend this matrix before implementation.
