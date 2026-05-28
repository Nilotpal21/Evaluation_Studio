# Studio -> DB -> DSL -> Runtime Hidden Issues Audit, Pass 3

Date: 2026-05-06

Scope: follow-up path-discovery audit after the current structured-output and cross-tenant model-routing fixes. This pass focuses on seams that still reconstruct project model policy, live response payloads, or replay messages manually instead of using the latest canonical contracts.

Mode: audit only. No fixes were applied in this pass.

## Summary

| Finding                                                                                      | Severity | Status                |
| -------------------------------------------------------------------------------------------- | -------- | --------------------- |
| PASS3-001: Exported project model configs are ignored by layered Studio import               | P1       | Confirmed             |
| PASS3-002: Layered import mutation/revert accounting excludes project model configs          | P2       | Confirmed coupled gap |
| PASS3-003: Structured-only `message.agent` traces are skipped during Studio replay synthesis | P2       | Confirmed             |
| PASS3-004: Live response surfaces omit localization/content-envelope ownership metadata      | P2       | Confirmed             |

## PASS3-001: Exported Project Model Configs Are Ignored By Layered Studio Import

Severity: P1

Status: Confirmed

Seam: Studio export/import -> DB model configs -> runtime model resolution

Source files:

- `packages/project-io/src/export/layer-assemblers/core-assembler.ts`
- `packages/project-io/src/import/layer-disassemblers/core-disassembler.ts`
- `apps/studio/src/lib/project-import/layered-import-support.ts`

Evidence:

- Core export writes project model configs to `config/project-model-configs/<name>.model-config.json`.
- Studio layered import uses `CoreDisassembler` through `createStudioLayeredImportDeps(...)`.
- `CoreDisassembler` handles `config/runtime-config.json`, `config/llm-config.json`, and `config/agent-model-configs/*.model-config.json`, but has no branch for `config/project-model-configs/*.model-config.json`.
- Therefore a project export that contains a voice model config such as `GPT-4o Realtime Preview (2025-06-03)` can include the file, but layered import will produce no `model_configs` record from it.

Impact:

- Cross-tenant project import can appear successful while silently dropping project model pool configs.
- Runtime model resolution that depends on the imported project model config can later fail or fall back, especially for project-scoped filler models and voice/realtime defaults.
- This is particularly risky because runtime config validation can only validate project model IDs against destination `ModelConfig` records that actually exist.

Fix direction:

- Add a `CoreDisassembler` branch for `config/project-model-configs/*.model-config.json`.
- Stage those records into the `model_configs` collection with ownership injection and tenant-local credential/binding fields stripped or resolved.
- Add API-level import preview/apply tests that prove a project export containing `config/project-model-configs/gpt-4o-realtime-preview.model-config.json` creates/updates `ModelConfig` in the destination tenant.

## PASS3-002: Layered Import Mutation/Revert Accounting Excludes Project Model Configs

Severity: P2

Status: Confirmed coupled gap

Seam: Studio import apply/revert -> runtime model cache invalidation

Source file: `apps/studio/src/lib/project-import/layered-import-support.ts`

Evidence:

- `countRuntimeConfigMutationFiles(...)` counts `config/runtime-config.json`, `config/llm-config.json`, and `config/agent-model-configs/*.model-config.json`.
- It does not count `config/project-model-configs/*.model-config.json`.
- `MODEL_POLICY_COLLECTIONS` includes `project_runtime_configs`, `project_llm_configs`, and `agent_model_configs`, but not `model_configs`.
- The import route calls `notifyRuntimeModelConfigChanged(...)` only when `modelPoliciesUpserted + modelPoliciesDeleted > 0`.

Impact:

- Once PASS3-001 is fixed, project-model-only imports can still fail to trigger runtime model-cache invalidation.
- Import/revert UI counts can underreport model policy changes, making rollback and operator evidence misleading.

Fix direction:

- Include `config/project-model-configs/*.model-config.json` in mutation-file counting.
- Include `model_configs` in model-policy rollback mutation accounting.
- Add tests for import apply and revert counts plus runtime cache invalidation on project-model-only imports.

## PASS3-003: Structured-Only `message.agent` Traces Are Skipped During Studio Replay Synthesis

Severity: P2

Status: Confirmed

Seam: runtime trace -> Studio replay -> session message synthesis/readback

Source file: `apps/studio/src/utils/replay-trace-events.ts`

Evidence:

- `collectAssistantTraceCandidates(...)` normalizes `message.agent.sent` to `agent_response`, extracts text, then skips the candidate when `!content.trim()`.
- `augmentSessionMessagesWithTraceEvents(...)` repeats the same text gate before synthesizing an assistant message.
- Both branches build `contentEnvelope` only after the text gate.
- A structured-only trace with `contentEnvelope.actions` or `structuredContent.actions` but empty `contentEnvelope.text` is therefore discarded before Studio can synthesize or enrich a replay message.

Impact:

- Runtime can emit and persist structured-only assistant output, but trace-only replay paths still lose it when no persisted assistant message is available.
- This affects historical/debug replay and any read surface that reconstructs sessions from trace events instead of DB messages.

Fix direction:

- Introduce a replay renderability helper that treats a trace as renderable when it has non-empty text or a structured envelope with blocks, rich content, actions, voice config, or localization.
- Build the content envelope before applying the skip gate.
- Use a safe fallback display text for structured-only messages, matching `InteractionsTab` behavior.
- Add regression locks for `message.agent.sent` with empty text plus actions-only and rich-content-only envelopes.

## PASS3-004: Live Response Surfaces Omit Localization/Content-Envelope Ownership Metadata

Severity: P2

Status: Confirmed

Seam: runtime execution -> live WebSocket/API response -> Studio/Web SDK clients

Source files:

- `apps/runtime/src/websocket/events.ts`
- `apps/runtime/src/types/index.ts`
- `apps/runtime/src/routes/chat.ts`
- `apps/studio/src/utils/response-end-message.ts`

Evidence:

- `buildExecutionOutcome(...)` carries `localization` from `ExecutionResult`.
- Persistence helpers include `localization` in the structured message envelope.
- `ServerMessages.responseEnd(...)` sends `voiceConfig`, `richContent`, `actions`, `executionId`, and `metadata`, but not `localization` or a canonical `contentEnvelope`.
- The `ServerMessage` TypeScript contract for `response_end` also omits both fields.
- Public REST chat returns `voiceConfig`, `richContent`, `actions`, and `outcome`, but omits `localization` and `contentEnvelope`.
- Studio `ResponseEndMessagePayload` cannot accept `localization` or an incoming `contentEnvelope`, so even if runtime adds those fields later, the current client boundary would drop them.

Impact:

- Durable DB readback can preserve ownership/localization metadata while live Studio/Web SDK consumers cannot see the same canonical response payload.
- Clients that need to distinguish project-owned localized text from platform fallback text must wait for a later session-read round trip.

Fix direction:

- Add optional `localization` and `contentEnvelope` to the runtime `response_end` server contract.
- Prefer a canonical `contentEnvelope` when available; keep `fullText`, `voiceConfig`, `richContent`, and `actions` for backward compatibility.
- Add the same additive fields to public REST chat response.
- Update Studio `ResponseEndMessagePayload` and WebSocket normalization to preserve these fields.
- Add backwards-compatible contract tests asserting old clients can still read `fullText`, `voiceConfig`, `richContent`, and `actions`.
