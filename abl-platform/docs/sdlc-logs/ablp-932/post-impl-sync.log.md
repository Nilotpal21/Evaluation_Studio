# Post-Impl Sync Log — ABLP-932

**Date:** 2026-05-19
**Feature:** HTTP Tool Non-2xx Response Body
**Branch:** `fix/ABLP-932`
**Commits:** `96b037823`, `212afed0f`

---

## What Was Updated

| Document                                             | Change                                   |
| ---------------------------------------------------- | ---------------------------------------- |
| `docs/features/ablp-932-http-tool-error-response.md` | Created (ALPHA)                          |
| `docs/testing/ablp-932-http-tool-error-response.md`  | Created (IN PROGRESS)                    |
| `docs/testing/README.md`                             | Added entry to Live Testing Status table |

---

## Coverage Delta

| Type              | Before | After       |
| ----------------- | ------ | ----------- |
| Unit tests        | 0      | 0           |
| Integration tests | 0      | 0           |
| E2E tests         | 0      | 0           |
| Manual validation | 0      | 3 scenarios |

---

## Deviations from Plan

No formal SDLC pipeline (feature spec → test spec → HLD → LLD → impl) was run for this ticket — it was a targeted bug fix implemented directly.

Key design decisions made during implementation:

1. **Default changed to `data`** — Initial implementation made `data` opt-in. Revised after user feedback: `data` is now the default (all tools return body for non-2xx), `error` is the explicit opt-out. This better matches the ticket intent.

2. **`on_http_error` follows `on_soap_fault` pattern** — Added as an optional field on `HttpBindingIR`, parsed through the full DSL pipeline (parser → serializer → form type → Zod schema).

3. **Studio display layer updated** — Added a third UI state "HTTP Error Response" (amber/warning) alongside existing "Success" (green) and "Execution Error" (red). The Response section now shows the real HTTP status code.

4. **`tool-test-service.ts` loads from `@abl/compiler` dist** — Studio loads `ToolBindingExecutor` via `await import('@abl/compiler/platform/studio-exports.js')` at runtime (serverExternalPackages). Source changes to `http-tool-executor.ts` require a package rebuild + Studio restart to take effect — not just Studio restart.

---

## Remaining Work

- Add unit tests for `http-tool-executor.ts` non-2xx path
- Add unit tests for DSL parser/serializer round-trip of `on_http_error`
- Add integration tests for Studio tool test service
- Propagate `is_error: true` to `ToolResultContent.is_error` for LLM layer (separate ticket)
- Fix `recordToolCall({ success })` for monitoring accuracy (separate ticket)
- Fix workflow error-branching for `is_error: true` results (separate ticket)
