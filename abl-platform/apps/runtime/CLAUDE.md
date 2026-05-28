# apps/runtime — Claude rules

These rules apply only when working in `apps/runtime/`. Root-wide rules live in `/CLAUDE.md`.

## Model Resolution Contract

When changing runtime model selection, `AgentIR` hashing, or any LLM cache key:

1. `ModelResolutionService.resolve()` is **user-scoped** (credential-bearing, budget-aware). Its cache key MUST include `userId`.
2. `ModelResolutionService.resolveReasoningSettings()` is **settings-only** (for prompt-builder / thinking pre-resolution). It stops before credential policy and budget reservation.
3. **Reasoning-settings caches must NOT key on `userId`** — key on tenant/project/agent + versioned reasoning snapshot (`settingsVersionId`, deployment overrides, resolution-relevant `AgentIR.execution` fields).
4. `SessionService.computeIRHash()` / `session.configHash` are whole-agent identity — broader than model-resolution hashes. Don't use as model-resolution invalidation keys unless the resolver actually reads that field.
5. When this contract changes, update `docs/guides/model-resolution-cache-versioning.md` AND `apps/runtime/src/__tests__/model-resolution-versioning.test.ts` in the same change.

## User-Facing Runtime Error Sanitization

When surfacing runtime / model-config failures: **logs keep raw context** (tenant IDs, model IDs, provider names, remediation detail belong in server logs and traces). **User-visible surfaces** (chat banners, API errors, execution diagnostics, session health/config messages) MUST go through the shared sanitizer helpers — no tenant IDs, model IDs, credential hints, or internal remediation text. **Fix downstream formatters too**: sanitizing only the throw site doesn't help if a later classifier/presenter reuses the raw message; patch the rendering surface and add regression coverage there.

## Debugging Runtime Issues

For runtime bugs (empty response, agent error, unexpected behavior), use MCP debug tools FIRST — before reading source. Sequence: `debug_connect` (local: `localhost:3112`) → `debug_diagnose` (config + execution + traces) → `debug_inspect` (model chain, credentials, tools) → `debug_get_errors`.

| Symptom              | First Tool              | Look For                                                         |
| -------------------- | ----------------------- | ---------------------------------------------------------------- |
| Empty response       | `debug_diagnose`        | Model not configured, credential missing, all reasoning disabled |
| Agent init error     | `debug_inspect`         | Model chain resolution, credential availability                  |
| Wrong agent responds | `debug_analyze_session` | Handoff routing, decision logs                                   |
| Session hangs        | `debug_analyze_session` | Gather stalls, loop detection, tool timeouts                     |
| Tool call fails      | `debug_get_errors`      | Tool binding errors, HTTP failures, schema mismatches            |

Full guidance: `runtime-debugging` skill.
