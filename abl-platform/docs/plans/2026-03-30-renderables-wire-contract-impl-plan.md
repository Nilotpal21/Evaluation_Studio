# LLD: Cross-Channel RENDERABLES Wire Contract

**Feature Spec**: Partial coverage in `docs/features/sdk.md` and `docs/architecture/CHANNEL_SYSTEM_ARCHITECTURE.md`  
**HLD**: Partial coverage in `docs/specs/sdk.hld.md` and `docs/architecture/CHANNEL_SYSTEM_ARCHITECTURE.md`  
**Test Spec**: `docs/testing/sdk.md`, `docs/testing/channels.md`, `docs/testing/sub-features/sdk-rich-content-templates.md`  
**Status**: DRAFT  
**Date**: 2026-03-30

> **Prerequisite gap:** there is no dedicated feature spec or HLD yet for named external renderables. This draft plan anchors to the existing SDK and channel-contract docs and should be promoted into a dedicated feature spec + HLD before implementation starts.

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                                  | Rationale                                                                                                                                            | Alternatives Rejected                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| D-1 | Add `renderables[]` as a new wire field instead of overloading `richContent`                              | `richContent` is a fixed platform-owned schema today; custom named payloads need a stable external name and arbitrary payload body                   | Reusing unused template names as a runtime registry; stuffing arbitrary payloads under `richContent`       |
| D-2 | Keep template keys internal and renderable names external                                                 | `TEMPLATE(account_summary)` should remain a compile-time authoring alias, while `com.bank.account_summary.v1` becomes the public contract            | Making external clients depend on internal DSL template names                                              |
| D-3 | Treat Web SDK as a consumer of `sdk_websocket`, not as a separate runtime target                          | Keeps one transport contract for browser clients and avoids duplicating channel semantics                                                            | Adding a separate `web_sdk` runtime channel type                                                           |
| D-4 | Preserve `channel_output` for `http_async`, but add raw `voiceConfig`, `richContent`, and `renderables[]` | Existing webhook consumers may already depend on `channel_output`; additive raw fields enable richer external rendering without a destructive change | Replacing `channel_output` outright; forcing webhook consumers to derive structured payloads from text     |
| D-5 | Resolve renderables at compile time together with template/text resolution                                | Matches the existing template model and avoids late runtime lookup by template name                                                                  | Building a runtime template registry keyed by DSL template names                                           |
| D-6 | Require namespaced, versioned renderable names                                                            | Prevents collisions between teams and creates an explicit versioning story for external renderers                                                    | Unversioned short names such as `account_summary`                                                          |
| D-7 | Make empty-response checks aware of `renderables[]`                                                       | A response with no plain text but valid renderables should not degrade to an empty-response fallback                                                 | Keeping current empty-response logic keyed only to `response`, `richContent`, `actions`, and `voiceConfig` |
| D-8 | Extend existing Web SDK renderer registration instead of inventing a second client plugin system          | `TemplateRegistry` already matches a `Message` object; custom renderers can extract from `message.renderables` once the field exists                 | Building a parallel “renderable registry” API just for custom payloads                                     |

### Key Interfaces & Types

```typescript
// packages/core/src/types/agent-based.ts
interface RenderableDefinitionAST {
  name: string;
  targets?: string[];
  fallbackText?: string;
  payloadJson: string;
  schemaRef?: string;
}

interface TemplateDefinition {
  name: string;
  content: string;
  formats?: RichContentAST;
  actions?: ActionSetAST;
  renderables?: RenderableDefinitionAST[];
}

// packages/compiler/src/platform/ir/schema.ts
interface RenderableIR {
  name: string;
  targets?: string[];
  fallback_text?: string;
  payload: unknown;
  schema_ref?: string;
}

// apps/runtime + packages/web-sdk wire model
interface RenderablePayload {
  name: string;
  payload: unknown;
  targets?: string[];
  fallbackText?: string;
  schemaRef?: string;
}
```

### Module Boundaries

| Module                                                                     | Responsibility                                                                                            | Depends On                               |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/core/src/parser/agent-based-parser.ts`                           | Parse draft `RENDERABLES:` blocks on `RESPOND` and `TEMPLATES`                                            | `packages/core/src/types/agent-based.ts` |
| `packages/core/src/types/agent-based.ts`                                   | AST definitions for template-level and response-level renderables                                         | `rich-content-ast.ts` patterns           |
| `packages/compiler/src/platform/ir/compiler.ts`                            | Compile AST renderables, inline template references, propagate renderables onto response-bearing IR nodes | `schema.ts`, `agent-based.ts`            |
| `packages/compiler/src/platform/ir/schema.ts`                              | IR and output schema for `RenderableIR`                                                                   | Compiler + runtime consumers             |
| `apps/runtime/src/services/execution/value-resolution.ts`                  | Interpolate string fields inside renderable payloads                                                      | `@abl/compiler` IR types                 |
| `apps/runtime/src/services/execution/types.ts`                             | Carry renderables on `ExecutionResult`                                                                    | Compiler IR                              |
| `apps/runtime/src/services/channel/outcome.ts`                             | Include renderables in outcome and empty-response logic                                                   | ExecutionResult                          |
| `apps/runtime/src/routes/chat.ts`                                          | Return renderables on sync API responses and OpenAPI schema                                               | Channel outcome                          |
| `apps/runtime/src/websocket/events.ts` + `apps/runtime/src/types/index.ts` | Extend `response_end` payload with renderables                                                            | Runtime execution path                   |
| `apps/runtime/src/services/queues/inbound-worker.ts`                       | Include raw structured payloads in `http_async` webhook deliveries                                        | Channel outcome + adapter output         |
| `packages/web-sdk/src/core/types.ts` + transport/chat/UI files             | Add `renderables` to `Message`, transport mapping, render gating, and registry extract path               | Runtime websocket contract               |

---

## 2. File-Level Change Map

### New Files

| File                                                                 | Purpose                                                                      | LOC Estimate |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------ |
| `packages/compiler/src/__tests__/ir/renderables-compilation.test.ts` | Compiler coverage for template/renderable compilation and `W602` interaction | 180          |
| `apps/runtime/src/__tests__/renderables-transport.test.ts`           | API + websocket + `http_async` payload parity tests                          | 220          |
| `packages/web-sdk/src/__tests__/renderables-sdk.test.ts`             | SDK transport, message-model, and custom renderer extraction tests           | 200          |

### Modified Files

| File                                                      | Change Description                                                                                                      | Risk |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| `packages/core/src/types/agent-based.ts`                  | Add AST definitions for renderables on template and response-bearing nodes                                              | Med  |
| `packages/core/src/parser/agent-based-parser.ts`          | Parse `RENDERABLES:` blocks and carry them through AST nodes                                                            | High |
| `packages/compiler/src/platform/ir/schema.ts`             | Add `RenderableIR` plus `renderables?: RenderableIR[]` to response-bearing IR surfaces and compilation output schema    | Med  |
| `packages/compiler/src/platform/ir/compiler.ts`           | Compile renderables, resolve template-attached renderables, keep `W602` semantics tied to `TEMPLATE(name)` usage        | High |
| `apps/runtime/src/services/execution/value-resolution.ts` | Add renderable payload interpolation helper                                                                             | Med  |
| `apps/runtime/src/services/execution/types.ts`            | Extend `ExecutionResult` with `renderables`                                                                             | Low  |
| `apps/runtime/src/services/channel/outcome.ts`            | Preserve renderables in `ChannelOutcome` and count them as renderable payload                                           | Med  |
| `apps/runtime/src/routes/chat.ts`                         | Return `renderables` and document them in OpenAPI response schema                                                       | Med  |
| `apps/runtime/src/websocket/events.ts`                    | Add `renderables` to `response_end`                                                                                     | Low  |
| `apps/runtime/src/types/index.ts`                         | Update websocket server message union                                                                                   | Low  |
| `apps/runtime/src/services/queues/inbound-worker.ts`      | Add `voiceConfig`, `richContent`, and `renderables` to `http_async` webhook payloads                                    | High |
| `apps/runtime/src/channels/channel-behavior-contract.ts`  | Align `http_async` structured-passthrough claim with actual payload behavior after rollout                              | Low  |
| `packages/web-sdk/src/core/types.ts`                      | Add `RenderablePayload` and `Message.renderables?`                                                                      | Low  |
| `packages/web-sdk/src/transport/types.ts`                 | Extend transport `response_end` message shape                                                                           | Low  |
| `packages/web-sdk/src/transport/DefaultTransport.ts`      | Map websocket `renderables` into SDK transport messages                                                                 | Low  |
| `packages/web-sdk/src/chat/ChatClient.ts`                 | Treat renderables as valid assistant payload and store them on `Message`                                                | Med  |
| `packages/web-sdk/src/react/components/MessageList.tsx`   | Render rich output when `renderables` exist even if `richContent` is absent                                             | Med  |
| `packages/web-sdk/src/ui/rich-renderer.ts`                | Treat renderables as renderable content in DOM widgets                                                                  | Med  |
| `packages/web-sdk/src/ui/ChatWidget.ts`                   | Inherit updated render gating for structured responses                                                                  | Low  |
| `packages/web-sdk/src/ui/UnifiedWidget.ts`                | Inherit updated render gating for structured responses                                                                  | Low  |
| `packages/web-sdk/src/react/RichMessage.tsx`              | Inherit updated `hasRichContent()` gating for backwards-compatible component                                            | Low  |
| `packages/web-sdk/src/react/components/RichContent.tsx`   | Existing registry path should render custom matches once `Message.renderables` exists; validate no extra gating remains | Low  |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: AST and IR Modeling

**Goal**: Define renderables in the DSL/AST/IR so the compiler can carry named external payloads without changing runtime delivery yet.

**Tasks**:

1.1. Add `RenderableDefinitionAST` to `packages/core/src/types/agent-based.ts`.

1.2. Extend `TemplateDefinition` to support `renderables?: RenderableDefinitionAST[]`.

1.3. Add renderable support to response-bearing AST nodes that already support `voiceConfig`, `richContent`, and `actions`.

1.4. Extend `packages/core/src/parser/agent-based-parser.ts` to parse a draft `RENDERABLES:` block on `RESPOND` and `TEMPLATES`.

1.5. Add `RenderableIR` and `renderables?: RenderableIR[]` to compiler IR response types in `packages/compiler/src/platform/ir/schema.ts`.

1.6. Add compiler tests for AST→IR mapping and draft syntax validation.

**Files Touched**:

- `packages/core/src/types/agent-based.ts` — add AST renderable types
- `packages/core/src/parser/agent-based-parser.ts` — parse `RENDERABLES:`
- `packages/compiler/src/platform/ir/schema.ts` — add `RenderableIR`
- `packages/compiler/src/__tests__/ir/renderables-compilation.test.ts` — new coverage

**Exit Criteria**:

- [ ] Parser accepts draft `RENDERABLES:` syntax on both `RESPOND` and `TEMPLATES`
- [ ] Compiler IR types include `renderables?: RenderableIR[]`
- [ ] Invalid renderable blocks fail deterministically with parse or compile diagnostics
- [ ] `pnpm build --filter=@abl/core --filter=@abl/compiler` succeeds with 0 errors
- [ ] New compiler tests pass

**Test Strategy**:

- Unit: parser and compiler tests for valid/invalid syntax
- Integration: AST→IR snapshots for renderables attached directly and via templates

**Rollback**: Revert AST/IR type additions and parser branches; renderable syntax becomes unsupported again.

---

### Phase 2: Template Resolution and Runtime Execution

**Goal**: Inline template-attached renderables into execution-bearing nodes and preserve them through interpolation and outcome shaping.

**Tasks**:

2.1. Extend template compilation in `packages/compiler/src/platform/ir/compiler.ts` to compile renderables alongside `DEFAULT` and `formats`.

2.2. When `RESPOND: TEMPLATE(name)` resolves, copy template renderables onto the target IR node when the node does not already define explicit renderables.

2.3. Preserve current `W602` semantics: a template is “used” when `TEMPLATE(name)` is referenced, not when a consumer later switches on external renderable names.

2.4. Add recursive interpolation for renderable payload string leaves in `apps/runtime/src/services/execution/value-resolution.ts`.

2.5. Extend `ExecutionResult` and `ChannelOutcome` with `renderables`.

2.6. Make empty-response logic treat `renderables` as a valid structured response.

**Files Touched**:

- `packages/compiler/src/platform/ir/compiler.ts` — compile + resolve renderables
- `apps/runtime/src/services/execution/value-resolution.ts` — interpolate renderable payloads
- `apps/runtime/src/services/execution/types.ts` — carry renderables
- `apps/runtime/src/services/channel/outcome.ts` — preserve and validate renderables
- `packages/compiler/src/__tests__/ir/renderables-compilation.test.ts` — extend coverage

**Exit Criteria**:

- [ ] `RESPOND: TEMPLATE(name)` can produce resolved `renderables[]`
- [ ] Explicit response-level renderables override template-attached renderables deterministically
- [ ] `W602` continues to fire only for template keys never referenced by `TEMPLATE(name)`
- [ ] A response with only `renderables` no longer degrades to `EMPTY_RESPONSE`
- [ ] `pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime` succeeds with 0 errors

**Test Strategy**:

- Unit: compiler resolution and value interpolation
- Integration: runtime outcome builder with renderable-only responses

**Rollback**: Leave AST/IR fields in place but stop compiler propagation and runtime interpolation so the new payload never surfaces externally.

---

### Phase 3: Transport Surfaces and `http_async` Parity

**Goal**: Deliver the same raw renderable payloads across sync API, websocket, and async webhook surfaces.

**Tasks**:

3.1. Extend sync API response schema and serialization in `apps/runtime/src/routes/chat.ts` with `renderables`.

3.2. Extend websocket `response_end` serialization in `apps/runtime/src/websocket/events.ts` and `apps/runtime/src/types/index.ts`.

3.3. Update `apps/runtime/src/services/queues/inbound-worker.ts` so `http_async` webhook deliveries include `voiceConfig`, `richContent`, and `renderables` alongside existing `response`, `actions`, `channel_output`, and `outcome`.

3.4. Reconcile `apps/runtime/src/channels/channel-behavior-contract.ts` with the actual `http_async` payload behavior after the raw structured fields land.

3.5. Add parity tests that assert the same renderable payload survives across API, websocket, and `http_async`.

**Files Touched**:

- `apps/runtime/src/routes/chat.ts` — API envelope
- `apps/runtime/src/websocket/events.ts` — websocket envelope
- `apps/runtime/src/types/index.ts` — server message union
- `apps/runtime/src/services/queues/inbound-worker.ts` — async webhook envelope
- `apps/runtime/src/channels/channel-behavior-contract.ts` — behavior contract accuracy
- `apps/runtime/src/__tests__/renderables-transport.test.ts` — new transport parity coverage

**Exit Criteria**:

- [ ] Sync API responses include `renderables` when present
- [ ] Websocket `response_end` includes `renderables` when present
- [ ] `http_async` webhook payload includes raw `richContent`, `voiceConfig`, and `renderables`
- [ ] Existing `channel_output` remains present for backwards compatibility
- [ ] Transport parity tests pass for all three surfaces

**Test Strategy**:

- Integration: chat route response contract
- Runtime transport E2E: websocket `response_end`
- Integration/E2E: async webhook payload creation

**Rollback**: Remove the additive fields from the outward-facing envelopes while keeping compiler/runtime internals intact.

---

### Phase 4: Web SDK Message Model and Custom Renderer Path

**Goal**: Let SDK consumers receive renderables on `Message` and render them through the existing registry model.

**Tasks**:

4.1. Add `RenderablePayload` and `Message.renderables?` to `packages/web-sdk/src/core/types.ts`.

4.2. Extend `packages/web-sdk/src/transport/types.ts` and `packages/web-sdk/src/transport/DefaultTransport.ts` to pass `renderables` through from websocket frames.

4.3. Update `packages/web-sdk/src/chat/ChatClient.ts` so renderable-only assistant responses are accepted and stored.

4.4. Update `packages/web-sdk/src/ui/rich-renderer.ts`, `packages/web-sdk/src/react/components/MessageList.tsx`, `packages/web-sdk/src/ui/ChatWidget.ts`, `packages/web-sdk/src/ui/UnifiedWidget.ts`, and `packages/web-sdk/src/react/RichMessage.tsx` so renderables count as renderable content even when `richContent` is absent.

4.5. Add SDK tests that register a custom renderer matching `message.renderables[].name` and verify both DOM and React rendering paths.

**Files Touched**:

- `packages/web-sdk/src/core/types.ts` — add `RenderablePayload` and `Message.renderables`
- `packages/web-sdk/src/transport/types.ts` — extend transport server message
- `packages/web-sdk/src/transport/DefaultTransport.ts` — map `renderables`
- `packages/web-sdk/src/chat/ChatClient.ts` — accept renderable-only messages
- `packages/web-sdk/src/react/components/MessageList.tsx` — render gating
- `packages/web-sdk/src/ui/rich-renderer.ts` — render gating
- `packages/web-sdk/src/ui/ChatWidget.ts` — widget rendering path
- `packages/web-sdk/src/ui/UnifiedWidget.ts` — widget rendering path
- `packages/web-sdk/src/react/RichMessage.tsx` — backwards-compatible rendering path
- `packages/web-sdk/src/__tests__/renderables-sdk.test.ts` — new SDK coverage

**Exit Criteria**:

- [ ] `Message` instances can carry `renderables[]`
- [ ] A websocket message with no `richContent` and no text but with `renderables[]` does not produce an empty-response error
- [ ] Custom renderer registration can render a payload keyed by `name`
- [ ] DOM widget path and React component path both render custom matches
- [ ] `pnpm build --filter=@agent-platform/web-sdk` succeeds with 0 errors
- [ ] SDK renderables tests pass

**Test Strategy**:

- Unit: transport mapping and `hasRichContent()` behavior
- Integration: custom renderer extraction + DOM/React rendering

**Rollback**: Keep runtime transport additive fields, but stop surfacing them on SDK `Message` objects and rendering paths.

---

### Phase 5: Docs, Contracts, and Rollout Hardening

**Goal**: Align reference docs, contract docs, and test guides with the shipped behavior and document the migration path.

**Tasks**:

5.1. Update `docs/reference/ABL_SPEC.md` and `docs/reference/ABL_QUICK_REFERENCE.md` with current compile-time template semantics plus the draft `RENDERABLES` syntax.

5.2. Update `docs/architecture/CHANNEL_SYSTEM_ARCHITECTURE.md` to document `renderables[]` as the external named payload contract.

5.3. Update `packages/web-sdk/README.md` and `apps/docs-internal/content/guides/channels.mdx` with API / websocket / Web SDK / `http_async` examples.

5.4. Update `docs/testing/sdk.md`, `docs/testing/channels.md`, and `docs/testing/sub-features/sdk-rich-content-templates.md` with new renderables scenarios before implementation lands.

5.5. Reconcile OpenAPI / manifest wording where the API surface already returns structured payloads but legacy metadata still describes it as text-only.

**Files Touched**:

- `docs/reference/ABL_SPEC.md`
- `docs/reference/ABL_QUICK_REFERENCE.md`
- `docs/architecture/CHANNEL_SYSTEM_ARCHITECTURE.md`
- `packages/web-sdk/README.md`
- `apps/docs-internal/content/guides/channels.mdx`
- `docs/testing/sdk.md`
- `docs/testing/channels.md`
- `docs/testing/sub-features/sdk-rich-content-templates.md`
- `apps/runtime/src/channels/manifest.ts`

**Exit Criteria**:

- [ ] Canonical docs clearly distinguish current behavior from draft `RENDERABLES`
- [ ] Testing guides include planned coverage for API, websocket, Web SDK, and `http_async`
- [ ] Manifest / contract wording no longer contradict the actual structured API response
- [ ] `npx prettier --check` passes on all edited Markdown and MDX files

**Test Strategy**:

- Documentation review only
- Optional lightweight contract tests if manifest wording changes affect code assertions

**Rollback**: Revert docs and manifest wording independently of the implementation phases.

---

## 4. Wiring Checklist

- [ ] Parser changes are wired into all response-bearing AST parse paths, not just one `RESPOND` variant
- [ ] Compiler exports any new IR types from package entry points used by runtime
- [ ] Runtime execution paths copy `renderables` from compiled IR into `ExecutionResult`
- [ ] API routes expose `renderables` in OpenAPI schemas and actual JSON responses
- [ ] Websocket `response_end` production and SDK transport consumption stay in lockstep
- [ ] `http_async` delivery payload includes the new fields before docs claim structured passthrough
- [ ] Web SDK `Message` model, render gating, and registry extraction all recognize renderables
- [ ] New tests are registered in the correct package test runners
- [ ] Public docs and docs-site content are updated together

---

## 5. Cross-Phase Concerns

### Database Migrations

None expected. This feature is a compile/runtime transport contract change.

### Feature Flags

Prefer no feature flag for API and websocket because the change is additive. For `http_async`, evaluate whether additive fields are sufficient or whether strict webhook consumers require an opt-in payload version. If unresolved, treat webhook versioning as an open question before Phase 3 starts.

### Configuration Changes

None expected for core transport. Optional future addition: subscription-level `payloadVersion` or `structuredDeliveryMode` for `http_async` if rollout risk is higher than expected.

### Backward Compatibility

- `richContent` remains unchanged and continues to represent platform-owned fixed schema fields.
- Existing clients that ignore unknown fields should continue to work.
- `channel_output` remains present on `http_async` webhook deliveries.
- `W602` should not be weakened just because templates can now emit external renderables; it still measures whether a DSL template key affects execution.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] ABL can define draft `RENDERABLES:` blocks and compile them into IR
- [ ] `RESPOND: TEMPLATE(name)` can emit `renderables[]` on resolved execution output
- [ ] Sync API returns `renderables[]` inline
- [ ] `sdk_websocket` returns `renderables[]` on `response_end`
- [ ] Web SDK can render a custom payload matched by `renderables[].name`
- [ ] `http_async` webhook deliveries include raw `richContent`, `voiceConfig`, and `renderables[]`
- [ ] Empty-response fallback does not trigger for renderable-only messages
- [ ] Existing built-in `richContent` renderers continue to work unchanged
- [ ] Docs clearly distinguish shipped behavior from draft/planned semantics during rollout

---

## 7. Open Questions

1. Should `RENDERABLES:` be allowed only inside `TEMPLATES:`, or also directly on any `RESPOND:` block in phase 1?
2. Should `http_async` receive additive fields immediately, or should webhook subscribers opt into a versioned payload contract?
3. Do we want `schemaRef` in the first version, or is namespaced `name` plus version suffix sufficient?
4. Should renderable payload interpolation support only string leaves, or also structured expression evaluation beyond `{{...}}` substitution?
5. Do we need a hard validation rule for renderable names (for example `reverse.dns.name.vN`) at compile time?
