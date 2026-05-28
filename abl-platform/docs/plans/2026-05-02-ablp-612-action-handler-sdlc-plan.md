# ABLP-612 Action Handler Routing Hardening Plan

**Status**: In progress
**Date**: 2026-05-02
**Ticket**: ABLP-612

## Problem

`ON_ACTION` now supports coordination actions such as `HANDOFF` and `DELEGATE`, but the full path from Studio authoring to database storage, DSL import, runtime compilation, SDK rendering, channel action submit, and child-agent execution still has drift risks. The highest-risk class is not one missing switch statement; it is split behavior across compile modes, parser formats, rich response resolution, action event context, and channel transports.

## Design Goals

- Make `ActionHandlerIR.do[]` the canonical action-handler contract for parser, compiler, validators, runtime, docs, and examples.
- Keep legacy handler sidecar fields as compatibility mirrors only.
- Validate target agents, tool calls, terminal actions, template references, and reserved action payload fields before runtime where possible.
- Preserve rich content and action payloads across terminal actions with explicit semantics.
- Treat SDK, Slack, Teams, and future channels as transport adapters over the same canonical action event envelope.
- Lock every behavior with a failing test before implementation, then keep the test as regression coverage.

## Future-Ready Architecture

### 1. Canonical Project Compile Service

Create a shared project compile path used by Studio, Arch AI, import preview/apply, deployment versioning, and runtime working-copy session bootstrap.

Compile modes:

- `draft-save`: permissive, returns all diagnostics, never pretends runtime readiness.
- `target-preview`: target-agent focused diagnostics, explicitly labels non-target project issues.
- `project-readiness`: strict enough for publishing and deployment.
- `runtime-strict`: fail closed for SDK/channel/session bootstrap.

The output must include unfiltered diagnostics, target-filtered diagnostics, resolved entry agent, resolved tool/profile/template dependencies, and a stable compile hash that includes entry-agent selection.

### 2. Canonical Action Event Envelope

Normalize all channel submits into:

```ts
interface ActionEventEnvelope {
  actionId: string;
  value?: string;
  label?: string;
  formData?: Record<string, unknown>;
  renderId?: string;
  source: 'sdk' | 'slack' | 'teams' | 'telegram' | 'voice' | 'api';
}
```

Runtime action matching and handler conditions should receive a reserved read-only context such as `_action.id`, `_action.value`, `_action.form`, and `_action.source`. Values should not be persisted unless the author explicitly uses `SET`.

### 3. Rich Payload Semantics

`RESPOND` before terminal actions must be delivered as an intermediate channel payload, not silently dropped. Terminal actions (`HANDOFF`, `DELEGATE`, `GOTO`, `COMPLETE`) must return a final `ExecutionResult` that preserves response text, rich content, actions, voice config, and trace IDs in a channel-neutral envelope.

### 4. Transport Integrity

Every rendered action payload should include a server-issued render id or nonce. New clients must send it back on `action_submit`; old clients use a narrow compatibility path with telemetry. This prevents stale clicks from binding to the wrong waiting step when action IDs repeat.

### 5. Format and Import Parity

YAML and legacy ABL must either support the same `ACTIONS` and `ON_ACTION DO` features or produce clear compile diagnostics. Import, Studio save, and runtime compile should use the same feature capability matrix.

## Slice-by-Slice Test Locking

### Slice 0: Black-Box SDK Button Handoff E2E

Lock a public API flow that:

1. Creates a real project and imports a supervisor plus child agent.
2. Starts a real SDK session through `/ws/sdk`.
3. Receives the supervisor's rendered action payload from `ON_START`.
4. Renders the SDK button with the Web SDK rich-message renderer.
5. Clicks the rendered button.
6. Proves the child agent response returns over the SDK WebSocket.

Exit criteria:

- Test fails if SDK action submit does not bridge to runtime `ON_ACTION`.
- Test fails if handoff target does not execute.
- Test uses HTTP/WebSocket only for server interaction.

### Slice 1: Compile Strictness and Studio Runtime Parity

Add tests proving Studio target preview cannot mark a project runtime-ready when runtime-strict compilation would fail. Implement the shared compile service or an adapter facade if a full extraction is too broad for the first pass.

### Slice 2: Rich Template and Terminal Payload Retention

Add compiler and runtime tests for `ON_ACTION DO -> RESPOND: TEMPLATE(...) -> HANDOFF/GOTO/COMPLETE`. Preserve rich payloads in intermediate chunks and final channel-neutral execution output.

### Slice 3: Action Event Conditions and Forwarding

Add tests where `ON_ACTION` conditions depend on `_action.id`, `_action.value`, and form data. Ensure `HANDOFF` and `DELEGATE` forward a deterministic payload source, with traces naming the selected source.

### Slice 4: Transport Nonce Compatibility

Add SDK tests for render id round-trip, stale click rejection, and a temporary legacy compatibility branch. Mirror the same contract for Slack/Teams adapters where channel callback IDs can be replayed.

### Slice 5: YAML and Import Capability Parity

Add parser/import tests for YAML `actions` and `on_action`. If full YAML parity is deferred, add explicit diagnostics that prevent silent feature loss.

### Slice 6: Versioning, Tool Schema, Docs, and Examples

Add schema parity tests for tool snapshot entries, including `searchai`. Update language service docs, ABL spec, Arch AI examples, and SDK examples so agent developers see the canonical `DO` block form.

## Acceptance Criteria

- A single black-box SDK E2E proves rendered button click to child-agent WebSocket response.
- Compile diagnostics are consistent from Studio through runtime strict execution.
- Rich content survives terminal action flows by contract, not accident.
- Channel adapters submit the same canonical action envelope.
- Parser/compiler/runtime/docs all treat `do[]` as the canonical action-handler surface.
- Every slice includes test-first evidence and scoped verification.
