# Multidimensional Runtime Contract Coverage Matrix

Date: 2026-05-05

Scope: Studio authoring, DSL/YAML/import/export, compiler lowering, runtime execution, channel delivery, persistence, and rehydration for response/action/control-flow contracts. This complements `docs/audit/2026-05-05-project-tool-contract-coverage-matrix.md`, which tracks reusable tool field propagation.

The previous 2D matrix was useful for field propagation, but it mostly answered: "does this field survive the happy path?" This matrix answers the harder question: "does this contract survive every authoring surface, mutation path, execution lane, payload shape, control-flow mode, runtime seam, and readback path?"

## Status Legend

| Status      | Meaning                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| PASS        | Covered by source inspection and at least one deterministic test, or an explicit compatibility block prevents lossy mutation. |
| FAIL        | Confirmed gap, type drift, lossy path, or unsafe fallback behavior.                                                           |
| NOT COVERED | Code exists or appears intentional, but no deterministic end-to-end test proves this cell.                                    |
| N/A         | The contract intentionally does not apply to this seam.                                                                       |

## Verification Legend

| Tag       | Meaning                                                         |
| --------- | --------------------------------------------------------------- |
| TESTED    | Deterministic unit/integration/E2E test found.                  |
| INSPECTED | Source inspected, but no deterministic test found.              |
| BLOCKED   | Visual editor or compatibility guard blocks save to avoid loss. |
| TYPEFAIL  | Current build/typecheck failure proves drift.                   |

## Axes

### Execution Lanes

| Lane                      | Meaning                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `init`                    | `ON_START` / initialization responses.                           |
| `normal_turn`             | User message through normal runtime turn.                        |
| `auto_advance`            | Flow continuation without a fresh user message.                  |
| `terminal_step`           | Completion/terminal response.                                    |
| `retry_fallback`          | Tool error, retry, default handler, fallback response.           |
| `handoff_delegate_return` | Handoff, delegate, return, failed transfer, forwarding payloads. |
| `async_resume`            | Pending delivery after reconnect / cross-pod resume.             |
| `hook_triggered`          | Before/after agent/turn hooks.                                   |
| `background_persistence`  | Queue/DB/history writes outside live response streaming.         |

### Payload Shapes

| Shape                 | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `text`                | Plain assistant response text.                                          |
| `rich_content`        | Cards, carousel, markdown, forms, media, KPI, table, etc.               |
| `voice_config`        | Voice/plain text/audio rendering config.                                |
| `actions`             | Buttons/forms/action sets and action render IDs.                        |
| `metadata_envelope`   | Response metadata, localization, content envelopes, raw content blocks. |
| `localized_template`  | Template-derived/localized responses and fallback variants.             |
| `history_vs_delivery` | Protected/tokenized history form versus user-delivery form.             |

### Authoring Surfaces

| Surface            | Meaning                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `studio_visual`    | Sectioned visual editor and read-only/editor mutation paths.      |
| `studio_dsl`       | Raw DSL editor path.                                              |
| `yaml_import`      | YAML import/parser path.                                          |
| `import_export`    | Project/package import/export and language-service serialization. |
| `saved_ir_reload`  | Existing/saved IR loaded back into editor/runtime.                |
| `readonly_display` | Preview/interactions/chat display without mutation.               |

### Mutation Types

| Mutation             | Meaning                                                     |
| -------------------- | ----------------------------------------------------------- |
| `create`             | New agent/tool/flow creation.                               |
| `edit_existing`      | Intentional edit of existing structured contract.           |
| `partial_edit`       | Editing another section while preserving unsupported data.  |
| `add_remove_reorder` | Ordered lists such as actions, handlers, buttons, branches. |
| `noop_save`          | Save with no semantic changes.                              |
| `toggle`             | Enable/disable feature or mode switch.                      |
| `default_injection`  | Runtime/compiler injects fallback/default behavior.         |

### Runtime Seams

| Seam                     | Meaning                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `stream_to_client`       | `response_start`, `response_chunk`, `response_end`, SDK/websocket payloads. |
| `assistant_history`      | In-memory conversation history used for LLM/session continuity.             |
| `db_persistence`         | Message queue, `contentEnvelope`, structured content storage.               |
| `trace_emission`         | Trace/observability events and provenance metadata.                         |
| `rehydration_read_api`   | Resume, replay, Studio readback, interactions tab.                          |
| `channel_adaptation`     | Web, SDK, A2A, Slack, WhatsApp, voice, HTTP async transformations.          |
| `pending_async_delivery` | Offline/cross-pod pending result storage and delivery.                      |

## Contract Item Matrix

| Contract item                 | Authoring surface                                                                 | Parser/import path                      | Compiler lowering                | Runtime executor seam                                                                             | Channel delivery                                                            | Persistence                                                                      | Readback/rehydration                     | Verification       |
| ----------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ------------------ |
| `respond`                     | PASS for DSL/YAML; PASS for visual simple responses                               | PASS                                    | PASS                             | PASS across `init`, `normal_turn`, `terminal_step`; NOT COVERED for every retry/fallback shortcut | PASS for web/debug and SDK; NOT COVERED for all adapters                    | PASS                                                                             | PASS                                     | TESTED + INSPECTED |
| `rich_content`                | PASS/BLOCKED: DSL/YAML supported; visual editor blocks many unsupported mutations | PASS                                    | PASS                             | PASS for main/action/hook/init; FAIL in output-guardrail replacement path                         | NOT COVERED across channel families; PASS for web/debug                     | PASS                                                                             | PASS for Studio chat/replay/interactions | TESTED + INSPECTED |
| `voice_config`                | PASS/BLOCKED: DSL/YAML supported; visual editor blocks many unsupported mutations | PASS                                    | PASS                             | PASS for main/action/hook/init; FAIL in output-guardrail replacement path                         | PASS for web/debug; NOT COVERED for most voice/channel adapters             | PASS                                                                             | PASS for Studio chat/replay/interactions | TESTED + INSPECTED |
| `actions`                     | PASS/BLOCKED: DSL/YAML supported; visual editor blocks lossy advanced paths       | PASS                                    | PASS                             | PASS for normal/action handler; FAIL in output-guardrail replacement path                         | PASS for web/debug; NOT COVERED for adapters with `actions_only` transforms | PASS                                                                             | PASS for Studio session store/chat       | TESTED + INSPECTED |
| `store`                       | NOT COVERED for visual mutation; PASS for DSL/YAML completion/constraints         | PASS for language-service serialization | PASS                             | PASS for flow state writes; NOT COVERED for every fallback/default path                           | N/A                                                                         | PASS as session data, not assistant message content                              | NOT COVERED for replay/read APIs         | INSPECTED          |
| `default_handler`             | PASS/BLOCKED for lifecycle visual editor; DSL/YAML supported                      | PASS                                    | PASS                             | PASS for tool-error `continue` handler response and structured payload remembering                | PASS when returned through normal response path                             | PASS for `continue` handler envelope; NOT COVERED for all handler shapes         | NOT COVERED                              | TESTED + INSPECTED |
| `call_spec.with/as`           | PASS/BLOCKED: visual editor blocks structured `with` payloads it cannot preserve  | PASS                                    | PASS                             | PASS for flow/hook/action handlers; NOT COVERED for all retry/fallback shortcuts                  | N/A                                                                         | State result persisted only indirectly                                           | NOT COVERED                              | TESTED + INSPECTED |
| `delegate/handoff/escalate`   | PASS for DSL/YAML; visual editor partial                                          | PASS                                    | PASS                             | PASS for action handler forwarding and failure; NOT COVERED for all return/resume shapes          | PASS for web/debug handoff progress; NOT COVERED cross-channel              | PARTIAL: metrics/handoff counts persist; structured return payload coverage thin | NOT COVERED for full return rehydration  | TESTED + INSPECTED |
| PII registry / policy context | N/A authoring for most surfaces                                                   | N/A                                     | PASS for session/runtime context | PASS for output protection calls; NOT COVERED for every shortcut path                             | NOT COVERED by channel family                                               | PASS through content-envelope sanitization path; NOT COVERED for all adapters    | NOT COVERED                              | INSPECTED          |
| `metadata/contentEnvelope`    | PASS for read-only display; visual authoring N/A                                  | PASS for saved/replay payloads          | PASS                             | PASS for web/debug, runtime executor finalization, hook responses                                 | PASS web/debug; NOT COVERED all channel families                            | PASS                                                                             | PASS Studio chat/replay/interactions     | TESTED + INSPECTED |

## Runtime Seam Matrix

| Contract item               | `stream_to_client`            | `assistant_history`                                | `db_persistence`                   | `trace_emission`                                | `rehydration_read_api`    | `channel_adaptation`           | `pending_async_delivery` |
| --------------------------- | ----------------------------- | -------------------------------------------------- | ---------------------------------- | ----------------------------------------------- | ------------------------- | ------------------------------ | ------------------------ |
| `respond`                   | PASS                          | PASS                                               | PASS                               | PASS                                            | PASS                      | NOT COVERED all adapters       | PASS                     |
| `rich_content`              | PASS web/debug                | PASS via content envelope                          | PASS                               | PARTIAL trace only flags presence in some paths | PASS Studio               | NOT COVERED all adapters       | PASS                     |
| `voice_config`              | PASS on response_end          | PASS via content envelope                          | PASS                               | PARTIAL trace only flags presence in some paths | PASS Studio               | NOT COVERED all voice adapters | PASS                     |
| `actions`                   | PASS chunk/end web/debug      | PASS via content envelope and pending action state | PASS                               | PARTIAL action handler trace                    | PASS Studio               | NOT COVERED adapters/forms     | PASS                     |
| `store`                     | N/A                           | PASS session data                                  | NOT COVERED session data read APIs | PASS for some trace events                      | NOT COVERED               | N/A                            | N/A                      |
| `default_handler`           | PASS text/structured continue | PASS text/structured continue handler envelope     | PASS for continue handler envelope | PASS error-handler trace                        | NOT COVERED               | NOT COVERED                    | NOT COVERED              |
| `call_spec.with/as`         | N/A                           | PASS result binding                                | PASS only if state later persisted | PASS tool/action traces                         | NOT COVERED               | N/A                            | N/A                      |
| `delegate/handoff/escalate` | PASS web/debug                | PASS state/action result                           | PARTIAL metrics/message            | PASS handoff progress/counts                    | NOT COVERED return-resume | NOT COVERED all adapters       | PARTIAL                  |
| PII policy context          | N/A                           | PASS protected history helpers                     | PASS envelope path                 | NOT COVERED all events                          | NOT COVERED               | NOT COVERED                    | NOT COVERED              |
| `metadata/contentEnvelope`  | PASS web/debug                | PASS                                               | PASS                               | PASS provenance                                 | PASS Studio               | NOT COVERED all channels       | PASS                     |

## Control-Flow Coverage Matrix

| Control-flow mode      | `respond` | `rich_content` | `voice_config` | `actions`   | `metadata/contentEnvelope` | Notes                                                                                                |
| ---------------------- | --------- | -------------- | -------------- | ----------- | -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mainline`             | PASS      | PASS           | PASS           | PASS        | PASS                       | Strongest coverage.                                                                                  |
| `branch_match`         | PASS      | PASS           | PASS           | PASS        | PASS                       | `ON_INPUT` and `ON_RESULT` branch payloads now append protected history content envelopes.           |
| `ELSE/fallback`        | PASS      | PASS           | PASS           | PASS        | PASS                       | ELSE fallback structured-only branches now append protected history content envelopes.               |
| `guardrail_violation`  | PASS      | FAIL           | FAIL           | FAIL        | NOT COVERED                | Output guardrail text replacement can leave original structured payload attached.                    |
| `constraint_violation` | PASS      | NOT COVERED    | NOT COVERED    | NOT COVERED | NOT COVERED                | Constraint collect/goto/escalate paths are text/state-heavy.                                         |
| `tool_error`           | PASS      | PASS           | PASS           | PASS        | PASS                       | Default `ON_ERROR` continue handlers now return raw structured fields into the protected final seam. |
| `completion_path`      | PASS      | PASS           | PASS           | PASS        | PASS                       | Completion conditions serialize structured fields; runtime proof still narrower than mainline.       |
| `navigation_shortcut`  | PASS      | PASS           | PASS           | PASS        | PASS                       | Goto/auto-advance shortcuts reuse the branch result lane and preserve protected history envelopes.   |
| `fail_open`            | PASS      | NOT COVERED    | NOT COVERED    | NOT COVERED | NOT COVERED                | Hook/guardrail fail-open paths usually suppress structured output.                                   |
| `fail_closed`          | PASS      | NOT COVERED    | NOT COVERED    | NOT COVERED | NOT COVERED                | Error responses are text-safe; structured payload semantics not verified.                            |

## Authoring And Mutation Matrix

| Surface / mutation                 | `respond`   | `rich_content` | `voice_config` | `actions`    | `call_spec.with/as`            | `default_handler`    | Notes                                                                          |
| ---------------------------------- | ----------- | -------------- | -------------- | ------------ | ------------------------------ | -------------------- | ------------------------------------------------------------------------------ |
| Studio visual `create`             | PASS simple | NOT COVERED    | NOT COVERED    | NOT COVERED  | PASS simple                    | NOT COVERED          | Visual editor is intentionally narrow.                                         |
| Studio visual `edit_existing`      | PASS simple | BLOCKED/PASS   | BLOCKED/PASS   | BLOCKED/PASS | BLOCKED/PASS structured `with` | BLOCKED/PASS         | Compatibility analyzers prevent many lossy saves.                              |
| Studio visual `partial_edit`       | PASS        | PASS/BLOCKED   | PASS/BLOCKED   | PASS/BLOCKED | PASS/BLOCKED                   | PASS/BLOCKED         | This is safer than full edit because unsupported sections block save.          |
| Studio visual `add_remove_reorder` | PASS simple | NOT COVERED    | NOT COVERED    | NOT COVERED  | NOT COVERED                    | NOT COVERED          | Ordered action/handler mutation is high risk.                                  |
| Studio DSL editor                  | PASS        | PASS           | PASS           | PASS         | PASS                           | PASS                 | Best authoring surface for advanced contracts.                                 |
| YAML import                        | PASS        | PASS           | PASS           | PASS         | PASS                           | PASS                 | Parser tests cover structured payloads and action handlers.                    |
| Import/export                      | PASS        | PASS           | PASS           | PASS         | PASS                           | PASS                 | Language-service serialization tests cover broad structured payload roundtrip. |
| Saved IR reload                    | PASS        | PASS display   | PASS display   | PASS display | NOT COVERED mutation           | NOT COVERED mutation | Readback is stronger than mutation.                                            |
| No-op save                         | PASS        | BLOCKED/PASS   | BLOCKED/PASS   | BLOCKED/PASS | BLOCKED/PASS                   | BLOCKED/PASS         | Needs no-op save regression per surface.                                       |
| Toggle/default injection           | PASS        | NOT COVERED    | NOT COVERED    | NOT COVERED  | NOT COVERED                    | NOT COVERED          | Defaults are a common hidden drift point.                                      |

## Confirmed Gaps

| ID       | Severity | Area                                          | Evidence                                                                                                                                                                                                                             | Impact                                                                                                                                                         |
| -------- | -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MDRC-001 | P1       | Output guardrail structured payloads          | Fixed in Slice 1: `apps/runtime/src/services/execution/flow-step-executor.ts` clears pre-guardrail `interpolatedRichContent`, `interpolatedVoiceConfig`, and `stepActions` whenever guardrails replace or modify flow-authored text. | Regression locked for blocked and modified flow guardrail output so replacement text cannot deliver or persist the original rich content/actions/voice config. |
| MDRC-002 | P1       | Async channel dispatcher type drift           | Fixed/confirmed in Slice 12: `pnpm --filter @agent-platform/runtime build` is clean, and `channel-dispatcher.test.ts` locks `DispatchableResult` rich/actions/voice persistence, including structured-only payloads.                 | Async delivery/persistence now uses the canonical structured-content contract for this seam.                                                                   |
| MDRC-003 | P2       | Default/error handler structured history      | Fixed for `THEN: CONTINUE` in Slice 11: the error-handler path now passes raw authored structured fields into the final protected response seam and locks delivery/history envelope parity in `flow-authored-output-pii.test.ts`.    | Remaining non-continue handler actions still need separate handler-shape coverage.                                                                             |
| MDRC-004 | P2       | Channel adapter structured payload parity     | Slice 13 adds deterministic rich-content capability family locks for every manifest channel in `channel-behavior-contract.test.ts`; adapter-specific rendering tests are still needed for each native family.                        | Capability boundaries are explicit, but "works in Studio" can still fail or degrade differently in individual Slack/Line/voice/A2A/async HTTP adapters.        |
| MDRC-005 | P2       | Visual editor ordered advanced mutation       | Slice 6 adds mutation locks for lifecycle completion/error visual edits: visible-field edits preserve hidden structured/retry/store siblings and remove operations intentionally delete only selected items.                         | Lifecycle payloads are now locked against accidental visual partial-edit loss; broader action-set/action-handler visual ordering remains product backlog.      |
| MDRC-006 | P2       | Shortcut/fallback structured payload coverage | Navigation shortcut and ELSE fallback structured-only branches are now locked in `flow-authored-output-pii.test.ts`; constraint violation, fail-open, and fail-closed modes still need deterministic structured-payload coverage.    | Bugs can still appear in the remaining non-mainline paths even after happy-path payloads pass.                                                                 |

## High-Value Test Backlog

| ID        | Test target                                                                      | Contract axes                                                                 | Expected assertion                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MDRC-T001 | Flow output guardrail block with `rich_content`, `voice_config`, and `actions`   | `normal_turn`, `guardrail_violation`, structured payloads                     | Covered by `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`; guardrail replacement and modified-content responses clear original structured payloads before result/history/pending persistence.       |
| MDRC-T002 | Tool error `default_handler` with `rich_content`, `voice_config`, and `actions`  | `retry_fallback`, `default_handler`, persistence/readback                     | Covered for `THEN: CONTINUE` by `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`; broader non-continue handler shapes remain in backlog.                                                              |
| MDRC-T003 | Action handler `respond -> delegate/handoff -> return` with actions and metadata | `handoff_delegate_return`, `actions`, `metadata_envelope`                     | Forwarded payload, return result, trace events, and persisted content envelope preserve the intended history/delivery split.                                                                                                 |
| MDRC-T004 | Pending async delivery for structured payload after reconnect                    | `async_resume`, `pending_async_delivery`, `rich_content/actions/voice_config` | Partially covered by `apps/runtime/src/__tests__/execution/channel-dispatcher.test.ts` for websocket delivery, cross-pod payload shape, A2A structured parts, and DB persistence; reconnect cleanup remains broader backlog. |
| MDRC-T005 | YAML import/export/no-op save with ordered actions                               | `yaml_import`, `import_export`, `noop_save`, `add_remove_reorder`             | Serialized YAML roundtrips action order and nested `call_spec.with/as` exactly.                                                                                                                                              |
| MDRC-T006 | Channel behavior family contract tests                                           | `channel_adaptation`, `rich_content`, `voice_config`, `actions`               | Each family matches `CHANNEL_BEHAVIOR_CONTRACT` for full/actions-only/text-only/plain-text modes.                                                                                                                            |
| MDRC-T007 | Visual partial-edit preservation                                                 | `studio_visual`, `partial_edit`, `saved_ir_reload`                            | Editing an unrelated section either preserves unsupported advanced payloads byte-for-byte or blocks save with a clear reason.                                                                                                |
| MDRC-T008 | Hook-triggered structured response persistence                                   | `hook_triggered`, `terminal_step`, `background_persistence`                   | Hook response stream, DB content envelope, and session replay preserve text plus structured payload.                                                                                                                         |

## Audit Operating Rule

Future findings should map to this matrix before implementation starts:

1. Name the contract item.
2. Name the execution lane.
3. Name the payload shape.
4. Name the mutation type or authoring surface.
5. Name the runtime seam.
6. Mark `PASS`, `FAIL`, `NOT COVERED`, or `N/A`.
7. Add or update a deterministic test before closing the cell.

This keeps "we audited it" from meaning "we audited only the happy-path text response."
