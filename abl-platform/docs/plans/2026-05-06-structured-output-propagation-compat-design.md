# Structured Output Propagation Compatibility Design

## Goal

Close the remaining Studio -> DB -> DSL/YAML -> compiler -> runtime -> channel -> readback gaps where assistant output is incorrectly treated as text-only. The design keeps all existing text fields and response shapes backward compatible while adding structured payload preservation for `richContent`, `actions`, `voiceConfig`, and canonical `contentEnvelope`.

## Compatibility Contract

- Text remains the primary legacy field: existing clients can continue reading `response`, `responseText`, `output[0].content`, Slack text fallback, Teams text fallback, and Studio message `content`.
- Structured payloads are additive: new fields are emitted only when present, and no existing text-only response shape is removed.
- Renderability is canonical: a response is renderable when it has non-empty text or any supported structured payload.
- Channel adapters must either render native structured output or explicitly preserve it as a structured passthrough. They must not silently drop payloads while advertising `richContent: "full"`.
- Cross-tenant import/export model routing remains portable: tenant-specific model IDs are represented by portable refs, and `voice` remains a valid routing tier only for realtime voice operations.

## Implementation Slices

1. Runtime lazy initialization
   - Test: first `executeMessage()` on an uninitialized session returns structured-only `ON_START`/`before_agent` output instead of continuing into the user turn.
   - Fix: reuse the renderability predicate for lazy init, not `response` truthiness.

2. Runtime event emission
   - Test: structured-only flow output emits `message.agent` with `structuredContent` and `contentEnvelope`.
   - Fix: already partially present in the dirty tree; keep the predicate as the single runtime event gate.

3. Channel adapters
   - Test: Slack and MS Teams transform markdown/native payloads even when no actions exist.
   - Fix: preserve existing text/actions behavior, then add native rendering for `richContent.slack`, `richContent.adaptive_card`, markdown/html text, and structured passthrough fallback.

4. Agent Assist V1 facade
   - Test: sync/SSE/async envelope builders preserve structured fields without changing `output[0].type === "text"`.
   - Fix: carry structured result fields from `executeTurn()` into `buildV1Envelope()` and `V1SSEEmitter.emitFinal()`.

5. Studio readback
   - Test: Interactions readback enriches actions-only and non-markdown structured assistant messages.
   - Fix: export a small renderability helper that returns fallback labels for actions/media/table/card payloads while attaching the original `contentEnvelope`.

## Rollout

- Safe to deploy incrementally because all new fields are additive.
- Existing text-only clients ignore the new structured fields.
- Native channel rendering is opt-in per adapter and falls back to prior text/action behavior when structured fields are absent or invalid.
