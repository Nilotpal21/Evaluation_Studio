# Project Runtime Config E2E Hardening Plan

## Goal

Make project runtime config behavior consistent from Studio authoring and import through database storage, IR generation, and runtime execution.

## Design Contract

1. Runtime config writes are validated at the API boundary before persistence.
2. The database-to-IR mapper is shared by runtime execution and Studio diagnostics so both surfaces resolve the same project config shape.
3. Project-level compaction is a first-class runtime config override. If stored, it must flow through API responses, update bodies, IR, session initialization, and compaction policy resolution.
4. Operation tier override compatibility mirrors must not survive delete flows. Runtime-config deletion deletes the LLM mirror because the LLM document contains only the mirrored override map. LLM-config deletion clears only the runtime mirror field and does not delete unrelated runtime settings.
5. Studio compile diagnostics include the same project runtime config that runtime execution injects, while runtime still reloads DB config at session start as the execution source of truth.

## Implementation Slices

### Slice 1: API Validation and Compaction Propagation

Test locks:

- Route PUT rejects invalid `extraction.correction_detection` before persistence.
- Route PUT strips/rejects unvalidated payloads by using the validated body.
- Route GET/PUT round-trips `compaction`.
- Resolver maps DB `compaction` into `ProjectRuntimeConfigIR`.
- Compaction policy uses the project override from resolved config.

Implementation:

- Enable request validation on `project-runtime-config`.
- Read `getValidatedRequestData(res).body` in the PUT handler.
- Add `compaction` schemas to route request/response normalization.
- Add `ProjectCompactionPolicy` to IR schema and use it from `ProjectRuntimeConfigIR`.
- Add a shared DB-to-IR mapper and make the runtime resolver use it.

### Slice 2: Project IO Delete Mirror Parity

Test locks:

- Runtime Project IO runtime-config delete deletes `ProjectRuntimeConfig` and `ProjectLLMConfig`.
- Runtime Project IO LLM-config delete deletes `ProjectLLMConfig` and clears only `ProjectRuntimeConfig.operationTierOverrides`.
- Studio direct-apply adapter performs the same delete behavior.

Implementation:

- Update runtime Project IO adapter delete path.
- Update Studio Project IO direct-apply adapter delete path.

### Slice 3: Studio Compile Parity

Test locks:

- `buildStudioCompilerOptions` loads project runtime config and includes `project_runtime_config`.
- Compiler writes `CompilerOptions.project_runtime_config` into every compiled agent IR.
- Diagnostics compile output includes runtime config for Studio previews.

Implementation:

- Add `CompilerOptions.project_runtime_config`.
- Load project runtime config in Studio compiler options via the shared mapper.
- Keep failures recoverable in best-effort Studio diagnostics with a warning.

## Verification

Run targeted tests first, then package builds:

```bash
pnpm --filter @agent-platform/runtime exec vitest run src/__tests__/project-runtime-config-route.test.ts src/__tests__/project-runtime-config-resolver.test.ts src/__tests__/compaction-policy.test.ts src/__tests__/project-io-routes.test.ts
pnpm --filter @agent-platform/studio exec vitest src/__tests__/project-aware-compile.test.ts src/__tests__/project-import-core-direct-apply-support.test.ts
pnpm --filter @abl/compiler exec vitest run src/__tests__/project-runtime-config-compiler-options.test.ts
pnpm --filter @abl/compiler build
pnpm --filter @agent-platform/runtime build
pnpm --filter @agent-platform/studio build
```
