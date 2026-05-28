# LLD: ABLP-612 Studio-to-Runtime Action Handler Hardening

**Ticket**: ABLP-612
**Status**: IN PROGRESS - slices 1-3 implemented
**Date**: 2026-05-02

---

## 1. Design Decisions

| #   | Decision                                                                                                                                         | Rationale                                                                                                                                    | Alternatives Rejected                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| D-1 | Treat `ActionHandlerIR.do[]` as the canonical execution contract across parser, compiler, runtime, channels, docs, and examples.                 | Prevents future split-brain behavior where old sidecar fields work in one layer and canonical actions work in another.                       | Adding one-off `HANDOFF`/`DELEGATE` branches per layer without shared traversal.                     |
| D-2 | Preserve the full channel action envelope at ingress, then expose a read-only `_action` context to handler conditions and downstream forwarding. | Slack, Teams, SDK, and future rich clients carry more than `actionId/value`; losing `formData` or `source` blocks guided UX and diagnostics. | Keeping only `currentMessage` and `value`, which makes button submits look like empty chat messages. |
| D-3 | Make Studio save a draft operation with proactive diagnostics and source metadata, not a silent runtime-readiness claim.                         | Authors need drafts, but runtime/confidence surfaces need honest compile status, fresh `sourceHash`, and editor traceability.                | Reject every invalid draft on save, which would break incremental authoring.                         |
| D-4 | Fail closed for publishing/runtime strict compile, warn clearly in Studio target preview, and keep diagnostic filtering explicit.                | The same project must not be green in Studio and fail first during SDK session bootstrap.                                                    | Continuing target-only success semantics without project-level warnings.                             |
| D-5 | Add render/click correlation as a versioned protocol slice with telemetry-backed legacy compatibility.                                           | Prevents stale/replayed button clicks while keeping separately published SDK bundles working during rollout.                                 | Requiring a nonce immediately and breaking old clients.                                              |
| D-6 | YAML ABL must either support action constructs or emit diagnostics; silent omission is not acceptable.                                           | YAML auto-detection means missing YAML support is a production behavior gap, not a secondary parser feature.                                 | Leaving YAML unsupported without clear author feedback.                                              |

---

## 2. Module Boundaries

| Module              | Responsibility                                                                                                             | Depends On                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/core`     | Parse legacy ABL and YAML ABL into the same action/action-handler AST.                                                     | AST types only.                                    |
| `packages/compiler` | Lower canonical action handlers, validate target agents/tool refs/terminal order, resolve templates.                       | Core AST, IR schema.                               |
| `apps/studio`       | Persist drafts with diagnostics, fresh hashes, and editor metadata; surface project-readiness honestly.                    | Core parser/compiler, DB models, project repos.    |
| `apps/runtime`      | Preserve channel action event envelope, evaluate handler conditions with `_action`, execute terminal actions, emit traces. | Compiler IR, channel adapters, execution services. |
| `packages/web-sdk`  | Render actions and return canonical submit payloads; later include render id compatibility.                                | SDK transport contract.                            |
| Channel adapters    | Normalize Slack/Teams/etc. callbacks into the canonical action event envelope.                                             | Runtime channel types.                             |

---

## 3. Implementation Phases

### Phase 1: Parser and YAML Parity

**Goal**: Make YAML flow steps support the same `actions` and `on_action` constructs as legacy ABL for the action-handler subset.

**Tasks**:

1. Add failing YAML parser tests for buttons, hidden values, `on_action.do`, `handoff`, `delegate`, `call_spec`, `clear`, `goto`, and `complete`.
2. Add YAML parser helpers for action sets, action handler blocks, and ordered handler actions.
3. Keep unsupported rich formats diagnostic-based in a later slice rather than silently mis-parsing them.

**Exit Criteria**:

- [x] YAML tests fail before parser changes.
- [x] YAML and legacy ABL produce equivalent AST shapes for supported action constructs.
- [x] `pnpm --filter @abl/core exec vitest run src/__tests__/yaml-flow-parser.test.ts -t "flow step actions"` passes.

### Phase 2: Canonical Action Event Envelope

**Goal**: Preserve transport action metadata from SDK/Slack/Teams through executor and expose `_action` to handler conditions.

**Tasks**:

1. Broaden `ExecuteMessageOptions.actionEvent` to the shared `ActionEvent` type.
2. Forward `formData` and `source` from inbound worker and SDK handler when present.
3. Store a canonical `_action_event` payload and evaluate handler conditions against `_action`.
4. Add runtime tests for `_action.value`, `_action.form.*`, and `_action.source` conditions.

**Exit Criteria**:

- [x] Runtime tests fail before envelope preservation.
- [x] Handler conditions can route based on full action payload.
- [ ] Existing SDK button E2E continues to pass.

### Phase 3: Studio Draft Save Diagnostics and Metadata

**Goal**: Make raw DSL saves traceable and honest about runtime readiness.

**Tasks**:

1. Compute and persist `sourceHash`, `lastEditedBy`, and `lastEditedAt` when Studio/Arch AI saves agent DSL.
2. Parse and project-aware compile saved DSL in draft mode, returning diagnostics without blocking draft persistence.
3. Explicitly include project-level warnings when target preview hides non-target strict errors.
4. Scope ProjectAgent reads/writes by `tenantId` wherever the model supports it.

**Exit Criteria**:

- [x] Route/repo tests fail before metadata/diagnostic changes.
- [x] Saved DSL updates refresh source metadata.
- [x] Studio response distinguishes `saved` from runtime readiness via `diagnostics.status`.

### Phase 4: Runtime Strictness and Entry-Agent Safety

**Goal**: Remove silent runtime behavior changes during session bootstrap.

**Tasks**:

1. Add a strict entry-agent resolver for runtime/deployment paths.
2. Keep draft/debug fallback explicit and traced.
3. Ensure runtime working-copy loads ProjectAgent rows by `{ tenantId, projectId }`.

**Exit Criteria**:

- [ ] Invalid configured entry agent fails strict runtime readiness.
- [ ] Debug fallback paths emit traceable warnings.
- [ ] Tenant/project isolation tests cover direct ProjectAgent reads.

### Phase 5: Render/Click Correlation

**Goal**: Prevent stale or replayed clicks from binding to the wrong waiting step.

**Tasks**:

1. Add server-issued `renderId` to action payloads in runtime result metadata.
2. Update SDK/Web SDK submit paths to echo `renderId`.
3. Accept legacy submits through a narrow compatibility branch with traces.
4. Reject stale render ids once client support is available.

**Exit Criteria**:

- [ ] New SDK tests cover fresh, stale, and legacy submits.
- [ ] Legacy path emits telemetry for rollout measurement.
- [ ] Protocol docs identify deprecation/removal criteria.

### Phase 6: Docs, Examples, and Regression Matrix

**Goal**: Align agent-developer guidance with the canonical action surface.

**Tasks**:

1. Update ABL spec, language-service docs, and Arch AI examples to use `DO`.
2. Add channel examples for SDK, Slack, and Teams payload handling.
3. Update SDLC/testing docs with the black-box E2E and remaining matrix.

**Exit Criteria**:

- [x] Docs no longer describe the old SET/RESPOND/TRANSITION-only contract.
- [x] Examples include rich payload and terminal action guidance.
- [ ] Test matrix distinguishes current coverage from target coverage.

---

## 4. Wiring Checklist

- [x] YAML parser helpers are reachable through `parseYamlABL()` and `parseAgentBasedABL()` auto-detection.
- [x] Runtime executor accepts the shared `ActionEvent` type.
- [x] Channel worker forwards full action events into `executeMessage()`.
- [x] Flow executor evaluates conditions with `_action`.
- [x] Studio DSL save route persists source metadata and returns diagnostics.
- [x] ProjectAgent repo functions explicitly scope tenant-supported queries by `tenantId`.
- [ ] SDK/Web SDK action submit remains backward compatible while gaining render correlation.
- [ ] Docs and examples reference canonical `DO` blocks.

---

## 5. Acceptance Criteria

- [ ] Black-box SDK E2E proves render/click/child-agent response over WebSocket.
- [x] YAML and legacy ABL action-handler authoring do not silently diverge for supported constructs.
- [x] Full action event envelopes survive channel ingress to handler conditions.
- [x] Studio saves are traceable and expose runtime-readiness diagnostics.
- [ ] Runtime strict compile and Studio diagnostics no longer disagree silently.
- [ ] Render/click correlation has a versioned rollout path.
- [ ] Focused `@abl/core`, `@abl/compiler`, `@agent-platform/runtime`, and affected Studio tests pass.
