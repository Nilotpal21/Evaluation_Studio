# Test Spec — ABLP-932: HTTP Tool Non-2xx Response Body

**Status:** IN PROGRESS
**Feature:** [ablp-932-http-tool-error-response.md](../features/ablp-932-http-tool-error-response.md)
**Last Updated:** 2026-05-19

---

## Coverage Matrix

| Functional Requirement                                       | Unit | Integration | E2E | Notes                          |
| ------------------------------------------------------------ | ---- | ----------- | --- | ------------------------------ |
| FR-1: Non-2xx returns `{ statusCode, body, is_error: true }` | ❌   | ❌          | ❌  | Manually validated             |
| FR-2: Full body returned (no truncation)                     | ❌   | ❌          | ❌  | Manually validated             |
| FR-3: `on_http_error: error` restores throw                  | ❌   | ❌          | ❌  | Code review only               |
| FR-4: SOAP fault unaffected                                  | ❌   | ❌          | ❌  | Existing SOAP tests cover this |
| FR-5: Studio shows amber "HTTP Error Response"               | ❌   | ❌          | ❌  | Manually validated in browser  |
| FR-6: Studio Response section shows real HTTP status         | ❌   | ❌          | ❌  | Manually validated in browser  |
| FR-7: 429/5xx retry preserved with opt-out                   | ❌   | ❌          | ❌  | Code review only               |

---

## Planned Test Scenarios

### Unit Tests (needed — not yet written)

| ID  | Scenario                                                                                | File                                                               |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| U-1 | `executeWithRetry` returns `{ statusCode: 400, body, is_error: true }` for 400 response | `packages/compiler/src/__tests__/http-tool-executor.test.ts`       |
| U-2 | `executeWithRetry` returns `{ statusCode: 404, body, is_error: true }` for 404 response | same                                                               |
| U-3 | `executeWithRetry` throws `TOOL_HTTP_ERROR` when `on_http_error: 'error'`               | same                                                               |
| U-4 | `executeWithRetry` throws `TOOL_RATE_LIMITED` for 429 when `on_http_error: 'error'`     | same                                                               |
| U-5 | `buildHttpBindingFromProps` parses `on_http_error: error` from DSL                      | `packages/shared/src/__tests__/dsl-property-parser.test.ts`        |
| U-6 | `serialize-tool-form-to-dsl` emits `on_http_error: error` only when set                 | `packages/shared/src/__tests__/serialize-tool-form-to-dsl.test.ts` |
| U-7 | `parse-dsl-to-tool-form` reads `on_http_error` back to `onHttpError`                    | `packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`     |

### Integration Tests (needed — not yet written)

| ID  | Scenario                                                                | File                                                                      |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| I-1 | HTTP tool returning 400 JSON: agent receives structured body            | `apps/runtime/src/__tests__/http-tool-error-response.integration.test.ts` |
| I-2 | HTTP tool returning 422 JSON: full body in tool result, not truncated   | same                                                                      |
| I-3 | HTTP tool with `on_http_error: error` and 400: throws, agent sees error | same                                                                      |
| I-4 | Studio tool test API: 400 response yields `httpError: true` in output   | `apps/studio/src/__tests__/tool-test-service.test.ts`                     |
| I-5 | Studio tool test API: Response status reflects real HTTP status         | same                                                                      |

### E2E Tests (needed — not yet written)

| ID  | Scenario                                                                 |
| --- | ------------------------------------------------------------------------ |
| E-1 | Tool test via Studio UI: 400 response shows amber label + body in Output |
| E-2 | Tool test via Studio UI: 200 response still shows green Success          |
| E-3 | Tool test via Studio UI: network error still shows red Execution Error   |

---

## Test File Mapping

| Test File                                                          | Status         | Scenarios Covered |
| ------------------------------------------------------------------ | -------------- | ----------------- |
| `packages/compiler/src/__tests__/http-tool-executor.test.ts`       | ❌ Not written | U-1 to U-4        |
| `packages/shared/src/__tests__/dsl-property-parser.test.ts`        | ❌ Not written | U-5               |
| `packages/shared/src/__tests__/serialize-tool-form-to-dsl.test.ts` | ❌ Not written | U-6               |
| `packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`     | ❌ Not written | U-7               |
| `apps/studio/src/__tests__/tool-test-service.test.ts`              | ❌ Not written | I-4, I-5          |

---

## Manual Validation Record

| Date       | Tester             | Scenario                                                                 | Result  |
| ---------- | ------------------ | ------------------------------------------------------------------------ | ------- |
| 2026-05-19 | karthikeya.andhoju | GET https://problemdetails.io/problem → 400 JSON body returned in Output | ✅ Pass |
| 2026-05-19 | karthikeya.andhoju | Studio shows amber "HTTP Error Response" label                           | ✅ Pass |
| 2026-05-19 | karthikeya.andhoju | Studio Response section shows "400 Bad Request"                          | ✅ Pass |
