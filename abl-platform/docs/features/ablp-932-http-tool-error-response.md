# ABLP-932 — HTTP Tool Non-2xx Response Body

**Status:** ALPHA
**JIRA:** [ABLP-932](https://koreteam.atlassian.net/browse/ABLP-932)
**Type:** Bug Fix
**Implemented:** 2026-05-19
**Branch:** `fix/ABLP-932`

---

## Overview

HTTP tools previously threw a `TOOL_HTTP_ERROR` exception for any non-2xx HTTP status code, embedding a truncated (256-char) response body in the error message string. This prevented agents from accessing structured error responses that APIs return with meaningful error details (e.g. `{"error":{"status":404,"msg":"Can not find a tenant!"}}`).

---

## Problem

```
TOOL_HTTP_ERROR
Tool authenticate_resident failed: POST https://app-services.kore.ai: HTTP 404 —
{"error":{"status":404,"msg":"Can not find a tenant!"}}
```

The agent received an exception and could not access `error.msg` to reason about the failure or communicate it to the user.

---

## Solution

Non-2xx HTTP responses now return a structured tool result instead of throwing:

```json
{
  "statusCode": 404,
  "body": { "error": { "status": 404, "msg": "Can not find a tenant!" } },
  "is_error": true
}
```

The agent can inspect `statusCode`, `body`, and `is_error` and reason accordingly. The old throw behaviour is preserved as an explicit opt-out via `on_http_error: error` in the tool DSL.

---

## Functional Requirements

| ID   | Requirement                                                                | Status         |
| ---- | -------------------------------------------------------------------------- | -------------- |
| FR-1 | Non-2xx responses return `{ statusCode, body, is_error: true }` by default | ✅ Implemented |
| FR-2 | Full response body returned — no truncation                                | ✅ Implemented |
| FR-3 | `on_http_error: error` restores legacy throw behaviour per tool            | ✅ Implemented |
| FR-4 | SOAP fault handling (`on_soap_fault`) is unaffected                        | ✅ Unaffected  |
| FR-5 | Studio tool test shows distinct "HTTP Error Response" state (amber)        | ✅ Implemented |
| FR-6 | Studio tool test Response section shows real HTTP status (e.g. 400)        | ✅ Implemented |
| FR-7 | 429 / 5xx retryable error behaviour preserved when `on_http_error: error`  | ✅ Preserved   |

---

## Non-Goals

- Changing how `TOOL_NETWORK_ERROR` (socket/connection failures) is handled
- Changing SOAP fault (`on_soap_fault`) behaviour
- Adding `ToolResultContent.is_error` propagation to the LLM layer (separate ticket)
- Changing agent metrics / `recordToolCall` success flag (separate ticket)

---

## Key Implementation Files

| File                                                                        | Change                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | Core fix — returns `{ statusCode, body, is_error: true }` for non-2xx when `on_http_error !== 'error'` |
| `packages/compiler/src/platform/ir/schema.ts`                               | Added `on_http_error?: 'error' \| 'data'` to `HttpBindingIR`                                           |
| `packages/shared-kernel/src/types/project-tool-form.ts`                     | Added `onHttpError?: 'error' \| 'data'` to `HttpToolFormData`                                          |
| `packages/shared/src/validation/project-tool-schemas.ts`                    | Zod default changed to `'data'`                                                                        |
| `packages/shared/src/tools/dsl-property-parser.ts`                          | Parses `on_http_error` DSL prop into IR                                                                |
| `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`                   | Serializes `onHttpError: 'error'` to DSL (only writes when opt-out)                                    |
| `packages/shared/src/tools/parse-dsl-to-tool-form.ts`                       | Parses DSL `on_http_error` back to form field                                                          |
| `apps/studio/src/services/tool-test-service.ts`                             | Detects `is_error: true` result, sets `httpError: true`, fixes Response status display                 |
| `apps/studio/src/store/tool-store.ts`                                       | Added `httpError?: boolean` to `ToolTestResult`                                                        |
| `apps/studio/src/components/tools/TestToolDialog.tsx`                       | Renders amber "HTTP Error Response" state                                                              |
| `apps/studio/src/components/tools/ToolTestPanel.tsx`                        | Same amber state for tool panel                                                                        |
| `packages/i18n/locales/en/studio.json`                                      | Added `http_error_response` translation key                                                            |

---

## DSL Usage

```
# Default — returns body for non-2xx (no DSL change needed)
GET https://api.example.com/resource

# Opt out — restore legacy throw behaviour
GET https://api.example.com/resource
on_http_error: error
```

---

## Backwards Compatibility

- Tools with no retry config and no `on_error` DSL handlers are unaffected.
- **Retry behaviour preserved:** 429 and 5xx responses still trigger retries when `retry.count > 0`
  is configured. On the final attempt the structured body is returned instead of throwing.
- **Agent DSL `on_error` routing preserved:** the runtime recognises `is_error: true` results as
  errors, so `on_error.set` mappings fire correctly for non-2xx HTTP responses.
- Tools that explicitly need `TOOL_HTTP_ERROR` thrown on every non-2xx response (e.g. for
  upstream error-handler middleware that catches `ToolExecutionError`) can set `on_http_error: error`
  to restore the old behaviour.

---

## Gaps / Known Issues

| Gap                                                            | Severity | Notes                                                                                                                                           |
| -------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ToolResultContent.is_error` not set on LLM tool result block  | LOW      | LLM still sees the body and `is_error: true` field in content — can reason about it. Separate ticket for propagating to block-level `is_error`. |
| `recordToolCall({ success: true })` for non-2xx                | MEDIUM   | Monitoring shows false success for HTTP error responses. Separate ticket.                                                                       |
| ~~Workflow error-branching not triggered by `is_error: true`~~ | ~~LOW~~  | Fixed: `reasoning-executor` now recognises `is_error: true` and routes to `on_error.set`.                                                       |

---

## Testing & Validation

- ✅ Manually validated via Studio Tool Test UI against `https://problemdetails.io/problem` (returns 400 with structured JSON)
- ❌ No automated unit tests added (bug fix — executor logic change)
- ❌ No E2E tests added

**Status:** ALPHA — core happy path validated manually, no automated test coverage yet.
