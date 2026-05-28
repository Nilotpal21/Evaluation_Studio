# Data Flow Audit: Studio Project Tool Runtime Numeric Placeholders

Date: 2026-05-06
Ticket: ABLP-856
Slice: 16, Project Tool Numeric Placeholder UI Parity

## Scope

This audit covers the cross-boundary value family changed in Slice 16: HTTP and Sandbox runtime numeric fields that may be authored as either numbers or exact `{{config.KEY}}` templates.

Fields audited:

- HTTP: `timeout`, `retry`, `retryDelay`, `rateLimit`, `circuitBreaker.threshold`, `circuitBreaker.resetMs`
- HTTP UI aliases: `timeoutMs`, `retryCount`, `retryDelayMs`, `rateLimitPerMinute`
- Sandbox: `memoryMb`, `timeout`
- Sandbox UI alias: `timeoutMs`

## Layer Map

| Layer                  | Files                                                                                                           | Direction                       | Result                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Shared API schema      | `packages/shared/src/validation/project-tool-schemas.ts`                                                        | Validate write payload          | OK: `RuntimeNumericSchema` accepts numbers or exact `{{config.KEY}}` templates for HTTP, Sandbox, and Workflow runtime numeric fields. |
| Studio UI state types  | `apps/studio/src/components/tools/shared-types.ts`                                                              | Define form state               | OK: HTTP and Sandbox numeric UI state now uses `RuntimeNumericValue`.                                                                  |
| Studio read adapters   | `apps/studio/src/components/tools/form-adapters.ts`                                                             | DB/API form -> UI config        | OK: `toolFormToHttpConfig` and `toolFormToSandboxConfig` preserve template strings into visible UI state.                              |
| Studio edit adapters   | `apps/studio/src/components/tools/form-adapters.ts`                                                             | UI config -> form payload       | OK: numeric edits and exact template edits round-trip without falling back to hidden existing values unless the field is absent.       |
| Studio forms           | `apps/studio/src/components/tools/HttpConfigForm.tsx`, `apps/studio/src/components/tools/SandboxConfigForm.tsx` | Present/edit/validate           | OK: placeholder-backed numeric values are visible in inputs and validation rejects non-exact mixed strings.                            |
| Studio create payloads | `apps/studio/src/components/tools/ToolCreatePage.tsx`, `apps/studio/src/components/tools/ToolCreateDialog.tsx`  | UI config -> API client payload | OK: string placeholders are not dropped by default-value comparisons. Valid falsy numeric values use nullish checks.                   |
| Studio API client type | `apps/studio/src/api/tools.ts`                                                                                  | Client payload typing           | OK: create payload runtime numeric fields accept `RuntimeNumericValue`, matching the server schema contract.                           |
| Review/display surface | `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`                                                    | UI review rendering             | OK: placeholder strings render without numeric comparison or arithmetic.                                                               |

## Propagation Matrix

| Field                                   | Schema | UI state | Read adapter | Form edit | Create payload | Client type | Display | Verdict |
| --------------------------------------- | ------ | -------- | ------------ | --------- | -------------- | ----------- | ------- | ------- |
| HTTP `timeout` / `timeoutMs`            | Y      | Y        | Y            | Y         | Y              | Y           | Y       | PASS    |
| HTTP `retry` / `retryCount`             | Y      | Y        | Y            | Y         | Y              | Y           | Y       | PASS    |
| HTTP `retryDelay` / `retryDelayMs`      | Y      | Y        | Y            | Y         | Y              | Y           | Y       | PASS    |
| HTTP `rateLimit` / `rateLimitPerMinute` | Y      | Y        | Y            | Y         | Y              | Y           | Y       | PASS    |
| HTTP `circuitBreaker.threshold`         | Y      | Y        | Y            | Y         | Y              | Y           | Y       | PASS    |
| HTTP `circuitBreaker.resetMs`           | Y      | Y        | Y            | Y         | Y              | Y           | Y       | PASS    |
| Sandbox `memoryMb`                      | Y      | Y        | Y            | Y         | Y              | Y           | N/A     | PASS    |
| Sandbox `timeout` / `timeoutMs`         | Y      | Y        | Y            | Y         | Y              | Y           | N/A     | PASS    |

## Concrete Values Traced

| Example                             | Expected path                                                                                    | Lock                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `{{config.HTTP_TIMEOUT_MS}}`        | Existing HTTP form -> visible `timeoutMs` input -> save payload `timeout` unchanged              | `apps/studio/src/__tests__/form-adapters-runtime-numeric.test.ts`                                                                         |
| `{{config.HTTP_RETRY_COUNT}}`       | Existing HTTP form -> visible retry input -> intentional save as template                        | `apps/studio/src/__tests__/form-adapters-runtime-numeric.test.ts`                                                                         |
| `{{config.HTTP_CB_RESET_MS}}`       | Existing HTTP circuit breaker -> visible review-safe config -> save payload preserved            | `apps/studio/src/__tests__/form-adapters-runtime-numeric.test.ts`, `apps/studio/src/components/tools/__tests__/HttpConfigForm.test.ts`    |
| `{{config.SANDBOX_MEMORY_MB}}`      | Existing Sandbox form -> visible memory input -> save payload unchanged or intentionally numeric | `apps/studio/src/__tests__/form-adapters-runtime-numeric.test.ts`, `apps/studio/src/components/tools/__tests__/SandboxConfigForm.test.ts` |
| `prefix-{{config.HTTP_TIMEOUT_MS}}` | UI validation rejects non-exact mixed expression                                                 | `apps/studio/src/components/tools/__tests__/HttpConfigForm.test.ts`                                                                       |
| `size-{{config.SANDBOX_MEMORY_MB}}` | UI validation rejects non-exact mixed expression                                                 | `apps/studio/src/components/tools/__tests__/SandboxConfigForm.test.ts`                                                                    |

## Parallel Paths

- Create page and modal create dialog both preserve placeholder strings when deciding whether to include non-default runtime numeric values.
- HTTP and Sandbox read/edit adapters use the same `RuntimeNumericValue` alias and nullish checks.
- Workflow runtime numeric placeholder handling was already implemented in an earlier slice and was not changed by this audit.

## Findings

No Slice 16 data-flow gaps remain open.

The audit did identify a pre-existing broader component-test issue outside this slice: `pnpm --filter @agent-platform/studio exec vitest src/__tests__/components` currently fails in `integration-auth-tab.test.tsx` and `list-page-shell-filter-consumers.test.tsx` due existing filter/dropdown test expectations. The focused Slice 16 locks, Studio build, and propagation audit lint pass.

## Verification

- PASS: `pnpm --filter @agent-platform/studio build`
- PASS: `pnpm --filter @agent-platform/studio exec vitest src/__tests__/form-adapters-runtime-numeric.test.ts src/components/tools/__tests__/HttpConfigForm.test.ts src/components/tools/__tests__/SandboxConfigForm.test.ts`
- PASS: `pnpm --filter @agent-platform/shared-kernel exec vitest run src/__tests__/propagation-audit-lint.test.ts src/__tests__/platform-propagation-audit-lint.test.ts`
- PASS: `git diff --check`
- PARTIAL: `pnpm --filter @agent-platform/studio exec vitest src/__tests__/components` has 109 passing files, 1 skipped file, and 2 unrelated failing files listed above.
