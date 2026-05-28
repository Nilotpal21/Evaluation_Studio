# @abl/conversation-testing — Package Learnings

## Purpose

Dev-only workspace package for LLM-driven conversation testing against deployed agents.
Generates diverse scenarios via one LLM call and drives them as WebSocket persona conversations
to seed insights pipelines (sentiment, intent, quality, friction, etc.) with realistic data.

## Key Design Decisions

- **Hand-rolled LLM clients** rather than Vercel AI SDK — keeps deps minimal for a dev script.
- **Single LLM call for all scenarios** — ensures intent diversity across the batch.
- **Hand-rolled semaphore** (`makeLimit`) instead of `p-limit` — ~15 lines, no external dep.
- **`buildSdkWSProtocols` from `@agent-platform/shared/websocket-auth`** — preserves the
  runtime WS client guard test contract.
- **`createLogger` from `@agent-platform/shared-observability/logger`** — lighter import
  than `@abl/compiler/platform` which pulls in chevrotain and breaks tsx ESM resolution.
- **Welcome-message-only domain discovery** (Tier A) — no probe-based Tier B for phase 1.

## Design Doc

Full design: `docs/superpowers/specs/2026-04-19-conversation-testing-integration-design.md`

## Test Patterns

- All unit tests target pure functions only (prompt-builder, concurrency, presets).
- No `vi.mock()` of platform components per CLAUDE.md rules.
- Integration tests (real LLM) are gated behind `RUN_LIVE_LLM_TESTS=1`.

## Gotchas

- The `runtime-ws-client-guard.test.ts` scans `scripts/` for WS callers.
  `conversation-runner.ts` uses `new WebSocket(...)` + `/ws/sdk` pattern and
  `buildSdkWSProtocols`, so the guard test stays green. If you move the WS call
  or change the import, verify the guard test still passes.
- `outputs/` directory is gitignored via the root `.gitignore` `output/` pattern.
  Transcript output goes to `scripts/conversation-testing/outputs/<timestamp>/`.
- The entry script (`scripts/generate-insights-data.ts`) uses a relative import
  `./conversation-testing/src/index.js` instead of `@abl/conversation-testing` because
  tsx resolves workspace packages via tsconfig paths from the root, but `@abl/conversation-testing`
  has no path mapping in the root tsconfig. The relative import works because tsx resolves `.ts`
  files directly.
- Do NOT use `@abl/compiler/platform` for `createLogger` in this package — it pulls in
  chevrotain which has `ERR_PACKAGE_PATH_NOT_EXPORTED` under tsx/ESM. Use
  `@agent-platform/shared-observability/logger` instead.
