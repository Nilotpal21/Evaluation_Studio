# Studio to Runtime Propagation Master Tracker

Date: 2026-05-06

Scope: Studio visual save, Studio DSL save, DB persistence, YAML/DSL parsing, compiler IR, runtime execution, channel delivery, persistence, traces, rehydration, and read surfaces.

Mode: Audit only. No production fixes are included in this document.

## Executive Summary

The previous slice-by-slice reviews fixed many concrete lossy-save and stale-readiness seams, but the remaining risk is broader: multiple runtime and Studio read paths still reconstruct assistant output payloads directly instead of using the canonical structured-content seams. That creates drift across `text`, `richContent`, `voiceConfig`, `actions`, localization/completion metadata, traces, and replay.

This pass found five confirmed remaining issues and two likely/contract-dependent risks. The highest-impact confirmed gap is that normal `FLOW`/branch actions are not interpolated with session values before they are attached to rendered responses, while action-handler responses do interpolate the same payload shape. The other confirmed gaps are mostly canonical-helper bypasses and read-surface fidelity issues.

## Legend

| Mark  | Meaning                                                  |
| ----- | -------------------------------------------------------- |
| `Y`   | Uses a canonical seam or has focused coverage.           |
| `P`   | Partial use or near-duplicate path with drift risk.      |
| `GAP` | Confirmed bug or confirmed contract break.               |
| `?`   | Needs product/contract decision or deeper dynamic proof. |
| `N/A` | Not applicable for this layer.                           |

## Canonical End-to-End Matrix

| Layer              | Text response | Rich content | Voice config | Actions | Retry metadata | Completion metadata | Hook metadata | PII registry/policy propagation |
| ------------------ | ------------- | ------------ | ------------ | ------- | -------------- | ------------------- | ------------- | ------------------------------- |
| Studio visual save | Y             | P            | P            | P       | Y              | Y                   | P             | P                               |
| Studio DSL save    | Y             | Y            | Y            | Y       | Y              | Y                   | Y             | Y                               |
| DB persistence     | Y             | Y            | Y            | Y       | N/A            | P                   | N/A           | Y                               |
| YAML parser        | Y             | Y            | Y            | Y       | Y              | Y                   | Y             | Y                               |
| DSL parser         | Y             | Y            | Y            | Y       | Y              | Y                   | Y             | Y                               |
| Compiler IR        | Y             | Y            | Y            | Y       | Y              | Y                   | Y             | Y                               |
| Runtime execution  | Y             | Y            | Y            | Y       | Y              | Y                   | Y             | Y                               |
| Channel delivery   | Y             | P            | P            | P       | N/A            | P                   | N/A           | Y                               |
| Persistence        | Y             | P            | P            | P       | N/A            | P                   | N/A           | Y                               |
| Traces             | P             | ?            | ?            | ?       | P              | P                   | P             | Y                               |
| Rehydration        | Y             | Y            | Y            | Y       | N/A            | P                   | N/A           | Y                               |
| Read surfaces      | P             | P            | P            | P       | N/A            | P                   | N/A           | Y                               |

## Canonical Helpers By Concern

| Concern                          | Canonical helper or seam                                                                                                                                            | Expected contract                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Structured assistant persistence | `apps/runtime/src/services/session/persisted-message-content.ts`                                                                                                    | Build one durable envelope for text, blocks, rich content, voice config, actions, localization, and metadata-bearing structured output. |
| Execution result envelope        | `apps/runtime/src/services/execution/types.ts`                                                                                                                      | Merge final response metadata and content envelope into the latest assistant message without losing structured payloads.                |
| Event-bus assistant payload      | `apps/runtime/src/services/event-bus/message-event-payload.ts`                                                                                                      | Emit trace/event payloads from the same structured-content contract used for persistence.                                               |
| Channel outcome rendering        | `apps/runtime/src/services/channel/outcome.ts`                                                                                                                      | Normalize channel-facing text and diagnostics without becoming an alternate persistence contract.                                       |
| PII/session protection           | `apps/runtime/src/services/message-persistence-queue.ts`, `apps/runtime/src/services/execution/session-output-protection.ts`, `apps/runtime/src/routes/sessions.ts` | Resolve project PII policy once, protect text and structured payloads consistently, and reveal only when caller scope allows it.        |
| Lifecycle serialization          | `apps/studio/src/lib/abl-serializers.ts`                                                                                                                            | Serialize dirty lifecycle sections without flattening `CALL WITH/AS`, hooks, completion handlers, or error handling.                    |
| Visual compatibility gates       | `apps/studio/src/lib/abl/*visual*compat*.ts`                                                                                                                        | Keep visual editors fail-closed when a section contains constructs they cannot round-trip.                                              |
| YAML flow contract               | `packages/core/src/parser/yaml-parser.ts`, `packages/language-service/src/serialize-yaml.ts`                                                                        | Parse and serialize `call_spec`, `on_input`, `on_result`, `digressions`, `sub_intents`, and `on_action` symmetrically.                  |
| DSL branch/runtime contract      | `packages/core/src/parser/agent-based-parser.ts`, `apps/runtime/src/services/execution/flow-step-executor.ts`                                                       | Compile and execute branch response blocks through one interpolation/protection/output path.                                            |

## Canonical Helper File Inventory

This inventory is intentionally linted. If a helper is renamed, removed, or split, update this table in the same change so the audit gate keeps a single source of truth.

| Concern                          | Canonical file                                                                |
| -------------------------------- | ----------------------------------------------------------------------------- |
| Structured assistant persistence | `apps/runtime/src/services/session/persisted-message-content.ts`              |
| Structured output protection     | `apps/runtime/src/services/execution/session-output-protection.ts`            |
| Session PII context              | `apps/runtime/src/services/pii/session-pii-context.ts`                        |
| Event-bus assistant payload      | `apps/runtime/src/services/event-bus/message-event-payload.ts`                |
| Channel outcome rendering        | `apps/runtime/src/services/channel/outcome.ts`                                |
| Channel manifest                 | `apps/runtime/src/channels/manifest.ts`                                       |
| Channel behavior contract        | `apps/runtime/src/channels/channel-behavior-contract.ts`                      |
| Channel message pipeline         | `apps/runtime/src/channels/pipeline/message-pipeline.ts`                      |
| Channel dispatcher               | `apps/runtime/src/services/execution/channel-dispatcher.ts`                   |
| Agent-transfer bridge            | `apps/runtime/src/services/agent-transfer/message-bridge.ts`                  |
| Agent-transfer transcript store  | `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`          |
| Lifecycle serialization          | `apps/studio/src/lib/abl-serializers.ts`                                      |
| Flow visual compatibility        | `apps/studio/src/lib/abl/flow-visual-editor-compat.ts`                        |
| Lifecycle visual compatibility   | `apps/studio/src/lib/abl/lifecycle-visual-editor-compat.ts`                   |
| DSL parser                       | `packages/core/src/parser/agent-based-parser.ts`                              |
| YAML parser                      | `packages/core/src/parser/yaml-parser.ts`                                     |
| Compiler action contract         | `packages/compiler/src/platform/ir/compiler.ts`                               |
| Runtime config IR contract       | `packages/compiler/src/platform/ir/project-runtime-config.ts`                 |
| YAML serializer                  | `packages/language-service/src/serialize-yaml.ts`                             |
| Runtime config route             | `apps/runtime/src/routes/project-runtime-config.ts`                           |
| Runtime config resolver          | `apps/runtime/src/services/config/project-runtime-config-resolver.ts`         |
| Runtime config write validation  | `apps/runtime/src/services/config/project-runtime-config-write-validation.ts` |
| Runtime config import validation | `packages/project-io/src/import/runtime-config-save-validation.ts`            |
| Import direct-apply orchestrator | `packages/project-io/src/import/core-direct-apply-orchestrator.ts`            |
| Project importer                 | `packages/project-io/src/import/project-importer-v2.ts`                       |
| Project exporter                 | `packages/project-io/src/export/project-exporter.ts`                          |
| Export materializer              | `packages/project-io/src/export/agent-export-materializer.ts`                 |

## Module Coverage Matrix

Each module row must stay present even when the current status is `P`, `GAP`, or `?`. The row is a regression-lock forcing function: new fixes should update the status and add the exact test lock rather than silently shrinking the audit scope.

| Module          | Primary seam                                                                                               | Current coverage status | Bypass scan family                                    | Regression lock status                                 | Fixed status                                |
| --------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| PII             | Session PII context, output protection, trace scrubbing, persistence redaction                             | P                       | PII registry/policy propagation, direct trace writes  | Added for structured child return/readback             | Open for direct trace and voice handoff PII |
| Project modules | Studio save, DB persistence, DSL/YAML parser, compiler IR, runtime project-scoped execution                | P                       | Lifecycle serializer, branch parsing, project scope   | Partial                                                | Open for visual parity/read surfaces        |
| Guardrails      | Input/output guardrail block, redact/fix/filter/escalate/reask, structured payload handling                | P                       | Direct assistant output, structured payload bypass    | Added for flow structured output guardrail replacement | Open for non-flow and broader branch parity |
| Voice           | Voice config execution, STT/TTS traces, local handoff prompts, voice channel persistence                   | P                       | Direct trace writes, direct assistant history writes  | Missing for trace scrubbing                            | Open                                        |
| Rich templates  | Rich content, actions, voice config, localization, channel templates, durable content envelopes            | P                       | Channel adapters and agent-transfer transcripts       | Partial                                                | Open for capability-boundary proof          |
| Omnichannel     | Channel delivery, AI4W/Slack/Line/voice adapter payload adaptation, channel outcome traces                 | P                       | Channel outcome rendering, structured flattening      | Missing capability lock                                | Open pending contract decisions             |
| Contact         | Contact-derived session identity, session principal, contact PII redaction, contact memory/audit readback  | P                       | PII policy propagation, session/contact read surfaces | Partial                                                | Open for readback parity                    |
| Sessions        | Session creation, active/persisted merge, rehydration, message history, session detail/read surfaces       | P                       | Cross-pod readback and legacy transcript fallbacks    | Partial                                                | Open for broader readback parity            |
| Traces          | TraceStore/EventStore writes, message.agent payloads, replay, observatory summaries, PII scrubbing         | P                       | Direct trace writes and channel outcome traces        | Partial                                                | Open for direct trace parity                |
| Runtime config  | Studio/API save, DB persistence, compiler IR options, runtime resolution, import validation, read surfaces | P                       | Runtime config route/resolver/import-save contract    | Partial                                                | Open for end-to-end parity                  |
| Import/export   | Project importer/exporter, direct apply, YAML/DSL/materialized agents, runtime config and rich payloads    | P                       | Import direct-apply/export materializer propagation   | Partial                                                | Open for matrix completeness                |

## Lifecycle And Navigation Structured Payload Matrix

This matrix is intentionally linted separately from the broad end-to-end table. These are the highest-risk authored execution surfaces for rich templates, so `richContent`, `voiceConfig`, and `actions` must stay visible as explicit audit targets.

| Lifecycle/navigation surface | richContent | voiceConfig | actions | Current source of truth                                                                     | Regression lock status                                |
| ---------------------------- | ----------- | ----------- | ------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| ON_START                     | Y           | Y           | Y       | Runtime ON_START interpolation plus protected history content-envelope construction         | Slice 10 content-envelope parity lock                 |
| ON_INPUT                     | Y           | Y           | Y       | `applyOnInputBranchResult(...)` protects and interpolates branch rich/voice/action payloads | Slice 4 action interpolation parity lock              |
| Navigation shortcut          | Y           | Y           | Y       | Navigation shortcut uses the ON_INPUT branch result lane                                    | Slice 4 shortcut action interpolation parity lock     |
| ON_RESULT                    | Y           | Y           | Y       | `matchedBranch` response path protects, interpolates, and persists branch structured output | Slice 10 structured-only content-envelope parity lock |

## Channel Surface Coverage Matrix

This matrix is intentionally linted against `apps/runtime/src/channels/manifest.ts`. Every channel recognized by the platform must stay visible here with its structured-output capability boundary and regression-lock status.

| Channel        | Native response surface     | richContent | voiceConfig | actions | Current source of truth                        | Regression lock status                              |
| -------------- | --------------------------- | ----------- | ----------- | ------- | ---------------------------------------------- | --------------------------------------------------- |
| http_async     | Async queue text            | PASS        | N/A         | N/A     | Channel behavior contract + dispatcher locks   | Structured pass-through capability boundary locked  |
| slack          | Blocks/streaming            | PASS        | N/A         | PASS    | Slack adapter + channel behavior contract      | Full rich/action capability family locked           |
| line           | Text/rich replies           | PASS        | N/A         | PASS    | LINE adapter + channel behavior contract       | Actions-only capability family locked               |
| msteams        | Adaptive cards/streaming    | PASS        | N/A         | PASS    | Teams adapter + channel behavior contract      | Full rich/action capability family locked           |
| whatsapp       | Interactive messages        | PASS        | N/A         | PASS    | WhatsApp adapter + channel behavior contract   | Full rich/action capability family locked           |
| messenger      | Template messages           | PASS        | N/A         | PASS    | Messenger adapter + channel behavior contract  | Full rich/action capability family locked           |
| instagram      | Text/media replies          | PASS        | N/A         | PASS    | Instagram adapter + channel behavior contract  | Full rich/action capability family locked           |
| twilio_sms     | SMS text                    | PASS        | N/A         | PASS    | Twilio SMS adapter + channel behavior contract | Text-only capability boundary locked                |
| zendesk        | Ticket/comment text         | PASS        | N/A         | PASS    | Zendesk adapter + channel behavior contract    | Actions-only capability family locked               |
| telegram       | Text/media replies          | PASS        | N/A         | PASS    | Telegram adapter + channel behavior contract   | Actions-only capability family locked               |
| genesys        | Voice/contact-center bridge | PASS        | PASS        | PASS    | Genesys adapter + channel behavior contract    | Actions-only rich boundary and voice profile locked |
| ai4w           | Streaming/transformed text  | PASS        | N/A         | PASS    | AI4W adapter/content transformer               | Explicit markdown-flattening boundary is locked     |
| email          | Email body/attachments      | PASS        | N/A         | PASS    | Email adapter + channel behavior contract      | Text-only capability boundary locked                |
| voice_vxml     | VXML/SSML                   | PASS        | PASS        | PASS    | VXML adapter + voice behavior profile          | Text/voice-only capability boundary locked          |
| korevg         | Voice gateway               | PASS        | PASS        | PASS    | KoreVG adapter + voice behavior profile        | Text/voice-only capability boundary locked          |
| audiocodes     | Voice gateway/websocket     | PASS        | PASS        | PASS    | AudioCodes adapter + voice behavior profile    | Text/voice-only capability boundary locked          |
| voice_pipeline | Runtime voice pipeline      | PASS        | PASS        | PASS    | Voice pipeline + channel behavior contract     | Text/voice-only capability boundary locked          |
| voice_realtime | Realtime voice              | PASS        | PASS        | PASS    | Realtime voice pipeline + behavior contract    | Text/voice-only capability boundary locked          |
| voice          | Generic voice               | PASS        | PASS        | PASS    | Voice service family + behavior contract       | Text/voice-only capability boundary locked          |
| voice_twilio   | Twilio media stream         | PASS        | PASS        | PASS    | Twilio media handler + voice behavior profile  | Text/voice-only capability boundary locked          |
| voice_livekit  | LiveKit data/transcript     | PASS        | PASS        | PASS    | LiveKit worker + voice behavior profile        | Text/voice-only capability boundary locked          |
| ag_ui          | AG-UI events                | PASS        | N/A         | PASS    | AG-UI adapter + channel behavior contract      | Structured pass-through capability boundary locked  |
| a2a            | Agent-to-agent protocol     | PASS        | PASS        | PASS    | A2A delivery + channel dispatcher locks        | Structured pass-through capability boundary locked  |
| sdk_websocket  | SDK websocket events        | PASS        | PASS        | PASS    | SDK websocket handler + behavior contract      | Full rich/action capability family locked           |
| web_debug      | Studio debug websocket      | PASS        | PASS        | PASS    | Debug websocket handler + behavior contract    | Full rich/action capability family locked           |
| web_chat       | Web chat                    | PASS        | PASS        | PASS    | Web chat route + behavior contract             | Full rich/action capability family locked           |
| api            | API response                | PASS        | PASS        | PASS    | HTTP chat/API routes + behavior contract       | Full rich/action capability family locked           |
| http           | HTTP response               | PASS        | PASS        | PASS    | HTTP chat/API routes + behavior contract       | Full rich/action capability family locked           |

## Agent Transfer Coverage Matrix

Agent transfer is a channel-adjacent propagation surface, not just an escalation feature. Human-agent messages and resumed bot responses must preserve transcript identity, channel capability boundaries, PII policy context, and structured-output decisions.

| Agent-transfer surface         | Structured payload boundary | Transcript persistence boundary                                     | Current source of truth                                              | Regression lock status                        |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| agent-transfer websocket       | P                           | Runtime session websocket transcript + bridge delivery              | `apps/runtime/src/services/agent-transfer/message-bridge.ts`         | Missing rich/action/voice handoff parity lock |
| agent-transfer channel_adapter | P                           | Channel adapter delivery + persisted transfer transcript            | `apps/runtime/src/services/agent-transfer/message-bridge.ts`         | Missing all-channel transfer parity lock      |
| agent-transfer voice_gateway   | P                           | Voice gateway delivery + voice transfer transcript/closeout records | `apps/runtime/src/services/agent-transfer/transcript-persistence.ts` | Missing voice transfer transcript parity lock |

## Platform Propagation Extension Matrix

This second matrix is intentionally broader than the structured-output map. It tracks adjacent propagation families that commonly lose fields at schema, route, worker, proxy, streaming, import/export, or readback boundaries. The matching lint is `pnpm audit:propagation:platform-lint`.

| Platform surface                          | Definition | Transform | Presentation | Persistence | Consumption | Wiring | Regression lock                                                                                                                                                                                                                              |
| ----------------------------------------- | ---------- | --------- | ------------ | ----------- | ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ON_SUCCESS                                | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `flow-authored-output-pii.test.ts` locks ON_SUCCESS structured action payload interpolation, PII protection, delivery, and content-envelope history                                                                                          |
| ON_FAILURE                                | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `flow-authored-output-pii.test.ts` locks ON_FAILURE structured action payload interpolation, PII protection, delivery, and content-envelope history                                                                                          |
| ON_ERROR                                  | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `flow-authored-output-pii.test.ts` locks default handler structured continue fallback                                                                                                                                                        |
| COMPLETE                                  | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `flow-authored-output-pii.test.ts` locks terminal and structured-only child return envelopes                                                                                                                                                 |
| HOOKS                                     | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `apps/runtime/src/__tests__/hooks-lifecycle.e2e.test.ts` locks hook rich content, voice config, action payload delivery, returned results, emitted assistant history content envelopes, and trace ordering                                   |
| Reask/no-match/default                    | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `flow-authored-output-pii.test.ts` locks ELSE fallback and default error structured payloads                                                                                                                                                 |
| Tool calls                                | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `tool-invocations-api.e2e.test.ts` locks API tool calls, auth binding, trace, and dispatch                                                                                                                                                   |
| Tool results                              | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `tool-result-compressor.test.ts` locks structured compression metadata/readback shape                                                                                                                                                        |
| Tool confirmation prompts                 | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `tool-confirmation.test.ts` and tool invocation E2E lock prompt/action/resume linkage                                                                                                                                                        |
| Dynamic tool forms                        | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `project-tool-form-dsl-parity.test.ts` locks form schema/DSL/runtime numeric parity                                                                                                                                                          |
| MCP/tool binding                          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `load-project-tools-as-ir.test.ts` and Studio tool-test locks MCP identity/header namespaces                                                                                                                                                 |
| Session attachments                       | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `attachment-tool-executor.test.ts` and runtime session proxy tests lock scoped read/write                                                                                                                                                    |
| Channel media downloaders/processors      | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | Channel media processor tests and `attachment-trace-utils.test.ts` lock trace/readback shape                                                                                                                                                 |
| Email attachments                         | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `email-attachment-processor.test.ts` locks inbound email upload metadata and traces                                                                                                                                                          |
| A2A attachments                           | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `a2a-attachment-ingestor.test.ts` locks inline/data-URI provenance and tenant/project upload                                                                                                                                                 |
| Attachment traces                         | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `attachment-trace-utils.test.ts` and Studio replay tests lock sanitized attachment traces                                                                                                                                                    |
| WebSocket chunks                          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `session-store-endstreaming.test.ts` locks transient chunks to final envelope commit                                                                                                                                                         |
| SDK typed interrupts                      | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `chat-client-status.test.ts` locks typed interrupt send and structured response resume                                                                                                                                                       |
| Async callback streaming                  | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `websocket-events.test.ts` and session store finalization locks async response_end envelope                                                                                                                                                  |
| Filler/status messages                    | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `pipeline-filler.test.ts` and `chat-client-status.test.ts` lock transient status handling                                                                                                                                                    |
| Voice realtime transcript deltas          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `voice-realtime-trace.test.ts` and LiveKit tests lock realtime trace timing/readback events                                                                                                                                                  |
| Studio SSE/Arch-AI stream                 | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `stream-observer.test.ts` locks partial/final/error SSE event and audit ordering                                                                                                                                                             |
| Studio localization assets                | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `localization-routes.test.ts` locks project/tenant scoped locale save/read and fallback metadata                                                                                                                                             |
| Runtime locale resolution                 | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `resolve-locale.test.ts` locks session/channel Accept-Language precedence and fallback matching                                                                                                                                              |
| Import/export locale files                | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `locale-files.test.ts` and project-io direct-apply/export tests lock path/config-key round-trip                                                                                                                                              |
| Channel/template localization             | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `escalation-channel-templates.test.ts` locks localized variables through channel template output                                                                                                                                             |
| Auth profiles                             | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `auth-profile-propagation.test.ts` and tool invocation E2E lock refs, consent metadata, and scope                                                                                                                                            |
| Credentials/secrets redaction             | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `secret-redaction.test.ts`, Studio route tests, and platform model tests lock redacted readback                                                                                                                                              |
| Tool auth binding                         | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `auth-profile-tool-executor-integration.test.ts` and Studio tool-test locks shared resolver shape                                                                                                                                            |
| Model resolution                          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `model-resolution-versioning.test.ts` locks full user scope vs settings-only reasoning cache                                                                                                                                                 |
| Tenant model policy                       | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `tenant-llm-policy.test.ts` and tenant model route tests lock policy update/cache invalidation                                                                                                                                               |
| Session memory                            | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `memory-scope-integration.test.ts` and memory API contract tests lock scoped read/write/readback                                                                                                                                             |
| Tool memory bridge                        | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `tool-memory-bridge.test.ts` locks tool memory scope routing and agent/session provenance                                                                                                                                                    |
| Omnichannel recall                        | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `memory-omnichannel-recall.test.ts` locks contact identity recall instead of workspace user id                                                                                                                                               |
| Contact memory                            | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `cascade-delete-contact-memory-erasure.test.ts` locks user fact erasure and cross-tenant isolation                                                                                                                                           |
| Context window/readback                   | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `compaction-engine.test.ts` locks active-window structured envelope reference preservation                                                                                                                                                   |
| Import manifest validation                | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `import-validators.test.ts`, `core-direct-apply.test.ts`, and route locks cover manifest-to-apply                                                                                                                                            |
| Layer assemblers                          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | Layer assembler tests plus `public-barrels.test.ts` lock export assembler reachability                                                                                                                                                       |
| Layer disassemblers                       | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `layer-disassemblers.test.ts` plus `public-barrels.test.ts` lock import disassembler reachability                                                                                                                                            |
| Direct apply                              | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `core-direct-apply.test.ts`, orchestrator tests, and Studio route validation lock DB/runtime parity                                                                                                                                          |
| Preview/revert                            | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `core-direct-apply-orchestrator.test.ts` and import revert route tests lock preview/revert parity                                                                                                                                            |
| Export workers/jobs                       | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `export-job-processor.test.ts` and async export route tests lock worker materialization                                                                                                                                                      |
| Post-import validation                    | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `post-import-validator.test.ts` and import doctor route tests lock validation/readback                                                                                                                                                       |
| Runtime proxy                             | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `proxy-production-wiring.test.ts` and runtime proxy tests lock tenant-scoped forwarding                                                                                                                                                      |
| SDK channel proxy                         | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `sdk-runtime-channel-proxy.test.ts` locks SDK proxy project/tenant scope                                                                                                                                                                     |
| Web SDK core client                       | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `sdk-golden-propagation.test.tsx` and `default-transport.test.ts` lock envelope normalization                                                                                                                                                |
| Web SDK React package                     | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `sdk-golden-propagation.test.tsx` locks React renderer/action parity from shared golden fixture                                                                                                                                              |
| Web SDK vanilla embed                     | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `sdk-golden-propagation.test.tsx` locks vanilla DOM renderer parity from the same normalized shape                                                                                                                                           |
| Studio preview runtime                    | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `preview-chat-utils.test.ts` locks hosted preview content-envelope normalization                                                                                                                                                             |
| SDK preview share                         | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `share-preview-link.test.ts`, `preview-reconnect.test.ts`, and SDK preview/share E2E cover parity                                                                                                                                            |
| Local handoff return structured output    | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `routing-executor.ts` now appends structured child return envelopes to parent history via `buildStructuredHandoffAssistantMessage`; locked by `apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts`                   |
| Remote A2A handoff return structured data | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `extractA2AResponseOutput` preserves text plus data-part `richContent`/`actions`/`responseMetadata`; locked by `apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts`                                                  |
| Streaming remote A2A multipart return     | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | Streaming remote handoff uses the shared extractor so multipart text and artifact fallback stay intact; locked by `apps/runtime/src/__tests__/execution/a2a-structured-handoff-return.test.ts`                                               |
| Lifecycle action-set serializer fidelity  | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | Studio lifecycle serializer/parser/compiler round-trips lifecycle action sets with submit controls, inputs, placeholders, required flags, render IDs, and option descriptions; locked by `apps/studio/src/__tests__/abl-serializers.test.ts` |
| Session attachments proxy                 | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `runtime-session-attachments-proxy.test.ts` locks project-scoped attachment proxy readback                                                                                                                                                   |
| Trace/session read routes                 | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | Studio trace/session tests and `proxy-production-wiring.test.ts` lock read route helper reachability                                                                                                                                         |
| Governance proxy                          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | Governance proxy route tests and shared route helper locks cover API-only scoped forwarding                                                                                                                                                  |
| Runtime route mounting                    | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `production-wiring.test.ts` locks production `project-io` route mounting                                                                                                                                                                     |
| Studio route handler helpers              | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `route-handler-rbac.test.ts` and `proxy-production-wiring.test.ts` lock helper scope propagation                                                                                                                                             |
| Package barrels                           | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `public-barrels.test.ts` locks root/subpath package export reachability                                                                                                                                                                      |
| Background workers/jobs                   | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `production-wiring.test.ts` locks runtime worker lifecycle registration                                                                                                                                                                      |
| Queue processors                          | PASS       | PASS      | PASS         | PASS        | PASS        | PASS   | `channel-queue-lifecycle.test.ts` and `production-wiring.test.ts` lock processor lifecycle wiring                                                                                                                                            |

## Platform Source Inventory

This inventory is intentionally linted by `audit:propagation:platform-lint`. It records representative source-of-truth files for the broader platform propagation map; implementation slices should add more files here when a row splits into deeper sub-matrices.

| Platform concern                         | Representative source files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools and forms                          | `apps/runtime/src/services/execution/tool-confirmation.ts`, `apps/runtime/src/services/execution/tool-result-compressor.ts`, `apps/runtime/src/tools/load-project-tools-as-ir.ts`, `packages/shared/src/tools/serialize-tool-form-to-dsl.ts`, `packages/shared/src/tools/parse-dsl-to-tool-form.ts`, `packages/shared/src/tools/project-tool-persistence.ts`, `packages/shared/src/types/project-tool-form.ts`                                                                                                                                                                                                                                                                                                      |
| Attachments and media                    | `apps/runtime/src/tools/attachment-tool-executor.ts`, `apps/runtime/src/tools/attachment-param-validator.ts`, `apps/runtime/src/services/a2a/attachment-ingestor.ts`, `apps/runtime/src/channels/adapters/attachment-trace-utils.ts`, `apps/studio/src/app/api/runtime/sessions/[id]/attachments/route.ts`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Streaming and realtime                   | `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, `apps/runtime/src/websocket/twilio-media-handler.ts`, `apps/runtime/src/services/filler/pipeline-filler.ts`, `apps/runtime/src/services/voice/livekit/agent-worker.ts`, `apps/studio/src/lib/arch-ai/sse-stream.ts`, `apps/studio/src/lib/arch-ai/stream-observer.ts`                                                                                                                                                                                                                                                                                                                                                         |
| Localization                             | `packages/project-io/src/locale-files.ts`, `packages/i18n/src/resolve-locale.ts`, `apps/studio/src/api/localization.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Auth/model/tool binding                  | `packages/shared-auth-profile/src/apply-auth.ts`, `packages/shared-auth-profile/src/redact.ts`, `apps/runtime/src/services/auth-profile/resolve-tool-auth.ts`, `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`, `apps/runtime/src/services/llm/model-resolution.ts`, `apps/runtime/src/routes/tenant-llm-policy.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| Memory and recall                        | `apps/runtime/src/services/execution/memory-integration.ts`, `apps/runtime/src/services/execution/tool-memory-bridge.ts`, `apps/runtime/src/services/execution/memory-executor.ts`, `apps/runtime/src/services/omnichannel/recall-service.ts`, `apps/runtime/src/routes/memory-api.ts`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Import/export internals                  | `packages/project-io/src/import/manifest-validator.ts`, `packages/project-io/src/import/post-import-validator.ts`, `packages/project-io/src/import/core-direct-apply.ts`, `packages/project-io/src/import/core-import-preview.ts`, `packages/project-io/src/export/layer-assemblers/index.ts`, `packages/project-io/src/import/layer-disassemblers/index.ts`, `apps/studio/src/services/export-job-processor.ts`, `apps/studio/src/services/export-worker.ts`                                                                                                                                                                                                                                                       |
| Studio proxies and read APIs             | `apps/studio/src/lib/runtime-proxy.ts`, `apps/studio/src/lib/sdk-runtime-channel-proxy.ts`, `apps/studio/src/lib/route-handler.ts`, `apps/studio/src/lib/safe-proxy.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Web SDK and preview surfaces             | `packages/web-sdk/src/index.ts`, `packages/web-sdk/src/core/AgentSDK.ts`, `packages/web-sdk/src/chat/ChatClient.ts`, `packages/web-sdk/src/transport/DefaultTransport.ts`, `packages/web-sdk/src/ui/ChatWidget.ts`, `packages/web-sdk/src/ui/UnifiedWidget.ts`, `packages/web-sdk/src/react/index.ts`, `packages/web-sdk/src/react/AgentProvider.tsx`, `packages/web-sdk/src/react/components/ChatWidget.tsx`, `packages/web-sdk/src/templates/registry.ts`, `packages/web-sdk/examples/vanilla-html/index.html`, `apps/studio/src/app/preview/[projectId]/page.tsx`, `apps/studio/src/app/api/sdk/preview-token/route.ts`, `apps/studio/src/lib/share-preview-link.ts`, `apps/studio/src/lib/preview-reconnect.ts` |
| Handoff returns and lifecycle serializer | `apps/runtime/src/services/execution/routing-executor.ts`, `apps/studio/src/lib/abl-serializers.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Production wiring and queue workers      | `apps/runtime/src/server.ts`, `apps/runtime/src/services/queues/index.ts`, `packages/project-io/src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Bypass Scan Source Coverage

The static propagation lint scans for high-risk source patterns and requires every matching production file to appear below. A listed file is not automatically a bug; this table records whether it uses the canonical seam, partially wraps it, bypasses it, or needs deeper proof.

| Scan family                               | Source file                                                            | Classification      | Module coverage                 |
| ----------------------------------------- | ---------------------------------------------------------------------- | ------------------- | ------------------------------- |
| Structured assistant content constructors | `apps/runtime/src/routes/chat.ts`                                      | Uses canonical seam | Rich templates, sessions        |
| Structured assistant content constructors | `apps/runtime/src/websocket/handler.ts`                                | Uses canonical seam | Rich templates, sessions        |
| Structured assistant content constructors | `apps/runtime/src/websocket/sdk-handler.ts`                            | Uses canonical seam | Rich templates, sessions        |
| Direct assistant history writes           | `apps/runtime/src/routes/chat.ts`                                      | Partial/bypass      | Sessions, rich templates        |
| Direct assistant history writes           | `apps/runtime/src/services/agent-transfer/transcript-persistence.ts`   | Unknown             | Omnichannel, sessions           |
| Direct assistant history writes           | `apps/runtime/src/services/execution/flow-step-executor.ts`            | Partial/bypass      | Guardrails, rich templates      |
| Direct assistant history writes           | `apps/runtime/src/services/execution/hook-executor.ts`                 | Uses canonical seam | Guardrails, sessions            |
| Direct assistant history writes           | `apps/runtime/src/services/execution/reasoning-executor.ts`            | Uses canonical seam | Guardrails, sessions            |
| Direct assistant history writes           | `apps/runtime/src/services/execution/routing-executor.ts`              | Partial             | Voice, omnichannel              |
| Direct assistant history writes           | `apps/runtime/src/services/execution/session-output-protection.ts`     | Uses canonical seam | PII, sessions                   |
| Direct assistant history writes           | `apps/runtime/src/services/execution/types.ts`                         | Uses canonical seam | Sessions                        |
| Direct assistant history writes           | `apps/runtime/src/services/runtime-executor.ts`                        | Partial/bypass      | Guardrails, sessions            |
| Direct assistant history writes           | `apps/runtime/src/services/test-session.ts`                            | Unknown             | Sessions                        |
| Direct assistant history writes           | `apps/runtime/src/services/voice/korevg/korevg-router.ts`              | Partial/bypass      | Voice, traces                   |
| Direct assistant history writes           | `apps/runtime/src/services/voice/korevg/s2s-google-event-handler.ts`   | Unknown             | Voice                           |
| Direct assistant history writes           | `apps/runtime/src/websocket/sdk-handler.ts`                            | Partial/bypass      | Rich templates, sessions        |
| Direct trace event writes                 | `apps/runtime/src/routes/chat.ts`                                      | Partial/bypass      | Traces, sessions                |
| Direct trace event writes                 | `apps/runtime/src/routes/feedback.ts`                                  | Unknown             | Traces                          |
| Direct trace event writes                 | `apps/runtime/src/services/channel-trace-utils.ts`                     | Unknown             | Omnichannel, traces             |
| Direct trace event writes                 | `apps/runtime/src/services/execution/resumption-service.ts`            | Unknown             | Sessions, traces                |
| Direct trace event writes                 | `apps/runtime/src/services/execution/trace-forwarder.ts`               | Unknown             | Traces                          |
| Direct trace event writes                 | `apps/runtime/src/services/feedback/feedback-service.ts`               | Uses canonical seam | PII, traces                     |
| Direct trace event writes                 | `apps/runtime/src/services/llm/llm-queue.ts`                           | Unknown             | Traces                          |
| Direct trace event writes                 | `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`                | Unknown             | Auth/model/tool binding, traces |
| Direct trace event writes                 | `apps/runtime/src/services/runtime-executor.ts`                        | Partial/bypass      | Guardrails, traces              |
| Direct trace event writes                 | `apps/runtime/src/services/trace-emitter.ts`                           | Uses canonical seam | PII, traces                     |
| Direct trace event writes                 | `apps/runtime/src/services/tracing/write-pipeline.ts`                  | Uses canonical seam | PII, traces                     |
| Direct trace event writes                 | `apps/runtime/src/services/voice/korevg/korevg-router.ts`              | Bypass              | Voice, traces                   |
| Direct trace event writes                 | `apps/runtime/src/services/voice/korevg/korevg-session.ts`             | Bypass              | Voice, traces                   |
| Direct trace event writes                 | `apps/runtime/src/services/agent-transfer/eventstore-trace-adapter.ts` | Uses canonical seam | Agent transfer, traces          |
| Direct trace event writes                 | `apps/runtime/src/services/voice/korevg/voice-trace-scrubbing.ts`      | Uses canonical seam | Voice, traces, PII              |
| Direct trace event writes                 | `apps/runtime/src/websocket/handler.ts`                                | Partial/bypass      | Sessions, traces                |
| Direct trace event writes                 | `apps/runtime/src/websocket/sdk-handler.ts`                            | Partial/bypass      | Sessions, traces                |
| Branch action parsing/execution paths     | `apps/runtime/src/services/execution/flow-step-executor.ts`            | Fixed/covered       | Guardrails, rich templates      |
| Branch action parsing/execution paths     | `packages/compiler/src/platform/ir/compiler.ts`                        | Uses canonical seam | Project modules, rich templates |
| Branch action parsing/execution paths     | `packages/core/src/parser/agent-based-parser.ts`                       | Uses canonical seam | Project modules, rich templates |

## Caller Classification

| Caller                                                         | Classification                    | Notes                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/channels/pipeline/message-pipeline.ts`       | Uses canonical seam               | Calls `buildPersistedMessageStructuredContent()`.                                                                                |
| `apps/runtime/src/services/execution/channel-dispatcher.ts`    | Uses canonical seam               | Calls `buildPersistedMessageStructuredContent()`.                                                                                |
| `apps/runtime/src/services/event-bus/message-event-payload.ts` | Uses canonical seam               | Builds `contentEnvelope` and `structuredContent` centrally for `message.agent` payloads.                                         |
| `apps/runtime/src/services/voice/livekit/agent-worker.ts`      | Uses canonical seam               | Persists voice channel assistant structured output via the shared helper.                                                        |
| `apps/runtime/src/services/voice/korevg/korevg-session.ts`     | Uses canonical seam               | Persists voice channel assistant structured output via the shared helper.                                                        |
| `apps/runtime/src/services/runtime-executor.ts`                | Uses canonical seam               | Builds execution result content envelopes and merges into assistant history.                                                     |
| `apps/runtime/src/websocket/handler.ts`                        | Uses canonical seam               | Direct WebSocket persistence now calls `buildPersistedAssistantStructuredContent()`.                                             |
| `apps/runtime/src/websocket/sdk-handler.ts`                    | Uses canonical seam               | SDK normal, action, typed-interrupt, and on-start persistence now call `buildPersistedAssistantStructuredContent()`.             |
| `apps/runtime/src/routes/chat.ts`                              | Uses canonical seam               | HTTP chat persistence now calls `buildPersistedAssistantStructuredContent()` while keeping the public response payload separate. |
| `apps/runtime/src/routes/ai4w-channel.ts`                      | Documented boundary               | AI4W intentionally flattens structured output to markdown text and exposes no structured sideband.                               |
| `apps/runtime/src/routes/sessions.ts`                          | Fixed/covered                     | Live/persisted merge now keeps the richer equivalent message when assistant text matches.                                        |
| `apps/studio/src/utils/replay-trace-events.ts`                 | Fixed/covered                     | Trace-only assistant synthesis now consumes structured `message.agent` payloads before text-only fallbacks.                      |
| `apps/studio/src/utils/observatory-event-presentation.ts`      | Fixed/covered                     | `dsl_respond` summaries now read `data.rendered` before legacy `message`/`text`.                                                 |
| `apps/studio/src/lib/abl-serializers.ts`                       | Uses canonical seam, partial risk | Current dirty-section callers avoid previous lifecycle flattening; full serializer remains a high-risk API if reused casually.   |
| `packages/core/src/parser/yaml-parser.ts`                      | Uses canonical seam               | Current parser covers advanced flow constructs.                                                                                  |
| `packages/language-service/src/serialize-yaml.ts`              | Uses canonical seam               | Current serializer covers advanced flow constructs.                                                                              |

## Master Issue Register

### MTR-001: Flow and branch actions are not interpolated in the normal response path

| Field                  | Value                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Severity               | P1                                                                                                                          |
| Status                 | Confirmed                                                                                                                   |
| Fixed status           | Closed in Slice 4                                                                                                           |
| Regression lock status | Added                                                                                                                       |
| Seam                   | Runtime execution, actions                                                                                                  |
| Source file            | `apps/runtime/src/services/execution/flow-step-executor.ts`                                                                 |
| Affected path          | `FLOW` step responses, `ON_INPUT`, `ON_RESULT`, branch response blocks, channel delivery, persistence, traces/read surfaces |

Evidence: `flow-step-executor.ts` now interpolates `stepActions` in the same response-normalization block as `stepVoiceConfig` and `stepRichContent`, and branch helpers now pass interpolated action sets into pending delivery. The action-handler path still uses the same `interpolateActionSet()` contract.

Impact: Action payload labels, descriptions, and hidden values containing `{{session.customer_id}}` now resolve before user delivery, pending response storage, and durable content envelopes across normal flow and branch lanes.

Regression lock: `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts` covers direct flow actions, normal `ON_INPUT`, navigation-command `ON_INPUT`, `ON_RESULT`, `ON_SUCCESS`, `ON_FAILURE`, and existing action-handler interpolation behavior.

### MTR-002: WebSocket, SDK, and HTTP chat paths still hand-roll structured assistant content

| Field                  | Value                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Severity               | P2                                                                                                                      |
| Status                 | Confirmed                                                                                                               |
| Fixed status           | Fixed                                                                                                                   |
| Regression lock status | Added                                                                                                                   |
| Seam                   | Structured assistant persistence and channel delivery                                                                   |
| Source files           | `apps/runtime/src/websocket/handler.ts`, `apps/runtime/src/websocket/sdk-handler.ts`, `apps/runtime/src/routes/chat.ts` |
| Affected path          | WebSocket chat, SDK WebSocket chat, typed interrupts, on-start response persistence, HTTP chat                          |

Evidence: `apps/runtime/src/routes/chat.ts`, `apps/runtime/src/websocket/handler.ts`, and `apps/runtime/src/websocket/sdk-handler.ts` now build persisted assistant structured content through `buildPersistedAssistantStructuredContent()`, a thin route-friendly adapter that delegates to `buildPersistedMessageStructuredContent()`. The SDK normal, SDK action, SDK typed-interrupt, SDK on-start, WebSocket normal, WebSocket action, WebSocket on-start, and HTTP chat persistence paths now share the same durable structured-content construction.

Impact: Direct WebSocket, SDK WebSocket, and HTTP chat persistence now preserve the canonical rich content, actions, voice config, and non-fallback localization behavior. Public response payloads remain separate from durable persistence construction.

Regression lock: `apps/runtime/src/services/session/__tests__/persisted-message-content.test.ts` asserts direct assistant helper parity with `buildPersistedMessageStructuredContent()`, fallback localization stripping, and empty-payload omission. `pnpm --filter @agent-platform/runtime build` verifies the WebSocket, SDK WebSocket, typed-interrupt, on-start, and HTTP chat call sites compile against that helper.

### MTR-003: Trace-only replay synthesizes text-only assistant messages

| Field                  | Value                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Severity               | P2                                                                                    |
| Status                 | Confirmed                                                                             |
| Fixed status           | Fixed                                                                                 |
| Regression lock status | Added                                                                                 |
| Seam                   | Traces, rehydration, read surfaces                                                    |
| Source file            | `apps/studio/src/utils/replay-trace-events.ts`                                        |
| Affected path          | Studio session replay, trace augmentation, observatory/interactions history synthesis |

Evidence: `collectAssistantTraceCandidates()` and trace-only augmentation now handle normalized `agent_response`/`message.agent.sent` payloads. When traces include `contentEnvelope` or `structuredContent`, Studio reconstructs `contentEnvelope`, derives `rawContent` from envelope blocks, and carries response metadata onto synthesized assistant messages.

Impact: If durable messages are missing, late, truncated, or intentionally reconstructed from traces, Studio can still show the structured assistant transcript emitted by runtime trace/event payloads.

Regression lock: `apps/studio/src/__tests__/replay-trace-events.test.ts` covers trace-only `message.agent.sent` synthesis with `contentEnvelope`, `rawContent`, `richContent`, `voiceConfig`, `actions`, and response provenance.

### MTR-004: Session detail live/persisted merge can prefer stale structured content when text matches

| Field                  | Value                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Severity               | P2                                                                                  |
| Status                 | Confirmed                                                                           |
| Fixed status           | Fixed                                                                               |
| Regression lock status | Added                                                                               |
| Seam                   | Rehydration and read surfaces                                                       |
| Source file            | `apps/runtime/src/routes/sessions.ts`                                               |
| Affected path          | Session detail responses that merge active runtime messages with persisted messages |

Evidence: `mergeActiveSessionMessages()` now scores equivalent persisted/runtime messages for structured richness and keeps the richer equivalent message in common-prefix and overlap merges. `contentEnvelope`, envelope blocks, rich content, actions, voice config, localization, raw content, and metadata all contribute to the preference.

Impact: During live sessions, if persistence lags or an older row has only text while the active message has a content envelope, the read surface keeps the richer active representation instead of collapsing to text-only content.

Regression lock: `apps/runtime/src/routes/__tests__/session-message-merge.test.ts` covers identical assistant text where persisted history is text-only and active runtime history carries a structured content envelope.

### MTR-005: Observatory summaries read the wrong `dsl_respond` field

| Field                  | Value                                                     |
| ---------------------- | --------------------------------------------------------- |
| Severity               | P3                                                        |
| Status                 | Confirmed                                                 |
| Fixed status           | Fixed                                                     |
| Regression lock status | Added                                                     |
| Seam                   | Trace read surfaces                                       |
| Source file            | `apps/studio/src/utils/observatory-event-presentation.ts` |
| Affected path          | Observatory event summaries for `dsl_respond`             |

Evidence: `getObservatoryEventSummary()` now reads `data.rendered` before legacy `message`/`text` for `dsl_respond` events.

Impact: Debugging views now summarize the actual rendered DSL response when it is present.

Regression lock: `apps/studio/src/__tests__/observatory-event-presentation.test.ts` asserts rendered response text wins over legacy fallback fields.

### MTR-006: Channel outcome traces do not carry successful structured output

| Field                  | Value                                                       |
| ---------------------- | ----------------------------------------------------------- |
| Severity               | P2                                                          |
| Status                 | Confirmed                                                   |
| Fixed status           | Fixed                                                       |
| Regression lock status | Added                                                       |
| Seam                   | Channel delivery and traces                                 |
| Source file            | `apps/runtime/src/services/channel/outcome.ts`              |
| Affected path          | Voice/channel adapters that call `buildOutcomeTraceEvent()` |

Evidence: `buildOutcomeTraceEvent()` remains a diagnostic trace helper, not an alternate successful-message replay contract. Successful structured outcomes are persisted through durable message envelopes; `buildOutcomeTraceEvent()` emits only warning/error outcome diagnostics.

Impact: Successful structured channel replay must use durable messages or explicit `message.agent` event payloads, not synthetic outcome diagnostics. This avoids a second partial persistence contract in channel outcome traces.

Regression lock: `apps/runtime/src/services/channel/__tests__/outcome.test.ts` asserts successful structured channel outcomes do not create diagnostic trace events.

### MTR-007: AI4W channel delivery flattens structured output to transformed text

| Field                  | Value                                       |
| ---------------------- | ------------------------------------------- |
| Severity               | P2                                          |
| Status                 | Confirmed                                   |
| Fixed status           | Fixed                                       |
| Regression lock status | Added                                       |
| Seam                   | Channel delivery and read surfaces          |
| Source file            | `apps/runtime/src/routes/ai4w-channel.ts`   |
| Affected path          | AI4W streaming and async callback responses |

Evidence: AI4W is now explicitly recorded as a markdown text boundary: `CHANNEL_BEHAVIOR_CONTRACT.ai4w.richContent` is `text_only`, `CHANNEL_MANIFEST.ai4w.supportsRichOutput` is `false`, and `transformAI4WOutput()` flattens rich content/actions into markdown text without sideband `richContent` or `actions` fields.

Impact: AI4W clients should treat structured output as markdown-rendered text. SDK/WebSocket and other structured-capable paths remain responsible for sideband structured UI payloads.

Regression lock: `apps/runtime/src/__tests__/channels/channel-behavior-contract.test.ts` locks the AI4W manifest/behavior contract, and `apps/runtime/src/__tests__/channels/ai4w-capability-contract.test.ts` locks deterministic markdown flattening.

### MTR-008: session-ws-registry emits a diagnostic trace event on WebSocket displacement

| Field                  | Value                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Severity               | P3                                                                                              |
| Status                 | Confirmed                                                                                       |
| Fixed status           | N/A                                                                                             |
| Regression lock status | Present — ownership guard test in agent-transfer-bridge.test.ts                                 |
| Seam                   | Traces, operational audit                                                                       |
| Source file            | `apps/runtime/src/services/agent-transfer/session-ws-registry.ts`                               |
| Affected path          | WS contact-ID collision detection; emits `warning` event with `ws_contact_id_superseded` reason |

Evidence: `registerSessionWebSocket()` writes a single `warning`-type trace event when a live WebSocket is displaced by a newer connection on the same session key. This is a deliberate audit write — it carries no structured output payload and does not bypass any content-propagation seam. The calling code is guarded inside a try/catch so it degrades silently in environments where the trace store is not initialised.

Impact: None for content propagation. The write is intentional and diagnostic-only.

Recommended test lock: Already present — the close-handler ownership guard test in `agent-transfer-bridge.test.ts` covers the displacement path.

### MTR-009: redis-session-store emits diagnostic trace events on null-tenant and corrupt-field guards

| Field                  | Value                                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Severity               | P3                                                                                                                                                    |
| Status                 | Confirmed                                                                                                                                             |
| Fixed status           | N/A                                                                                                                                                   |
| Regression lock status | Present — tenantId guard test in agent-transfer-bridge.test.ts                                                                                        |
| Seam                   | Traces, operational audit                                                                                                                             |
| Source file            | `apps/runtime/src/services/session/redis-session-store.ts`                                                                                            |
| Affected path          | `appendMessages()` null-tenant guard (reason `append_messages_tenant_unresolved`); field-decrypt corrupt-field guard (reason `session_field_corrupt`) |

Evidence: `redis-session-store.ts` writes `warning`-type trace events in two strictly defensive positions: (1) when `appendMessages()` is called but `tenantId` cannot be resolved, and (2) when a session field fails to decrypt. Both writes carry only diagnostic metadata (reason, sessionId, dropped count or field name), contain no structured output payload, and are wrapped in try/catch so they degrade silently if the trace store is absent.

Impact: None for content propagation. Both writes are intentional guard rails that satisfy Core Invariant #4 (every execution path emits TraceEvents).

Recommended test lock: Already covered by the tenantId guard regression test added in fix/agent-transfer-audit-findings.

### MTR-010: SDK HTTP runtime output needs persisted session readback parity

| Field                  | Value                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Severity               | P2                                                                                                                     |
| Status                 | Confirmed                                                                                                              |
| Fixed status           | Fixed for representative SDK HTTP chat -> session read API lane                                                        |
| Regression lock status | Added                                                                                                                  |
| Seam                   | Runtime result, SDK HTTP delivery, persistence, and session read surfaces                                              |
| Source file            | `apps/runtime/src/__tests__/channels/channels-sdk-runtime.e2e.test.ts`                                                 |
| Affected path          | SDK `/api/v1/chat/agent` delivery and `GET /api/projects/:projectId/sessions/:sessionId` structured assistant readback |

Evidence: The SDK runtime E2E now creates a project through public APIs, imports an agent with `RESPOND`, `VOICE`, `FORMATS.MARKDOWN`, and `ACTIONS`, starts an SDK session with a public key, sends a chat turn through `/api/v1/chat/agent`, and then reads the resulting session through the project-scoped session detail API using SDK auth headers.

Impact: The representative SDK HTTP lane now proves that the delivered response and persisted readback agree for `response`, `richContent`, `voiceConfig`, `actions`, and `contentEnvelope`. This complements the Slice 8 Studio trace/replay read-surface locks rather than replacing broader channel-specific replay follow-ups.

Regression lock: `apps/runtime/src/__tests__/channels/channels-sdk-runtime.e2e.test.ts` test `preserves structured SDK chat output through persisted session readback`.

### MTR-011: Structured PII readback must use project recognizers inside content envelopes

| Field                  | Value                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| Severity               | P2                                                                                               |
| Status                 | Confirmed                                                                                        |
| Fixed status           | Fixed for structured child return/readback lanes                                                 |
| Regression lock status | Added                                                                                            |
| Seam                   | Session PII context, structured output protection, stored-session rehydration, and read surfaces |
| Source file            | `apps/runtime/src/services/pii/runtime-pii-boundary-service.ts`                                  |
| Affected path          | Structured assistant `contentEnvelope` readback for raw and tokenized project-defined PII        |

Evidence: Structured child returns already route through `protectSessionOutputForUser(...)` and `protectStructuredOutputForUser(...)`, producing redacted delivery payloads plus tokenized durable history envelopes. Slice 15 adds read-surface locks proving `renderSessionMessagesForUserSurface(...)` applies the project PII context to `contentEnvelope.text`, `richContent`, `voiceConfig`, and `actions`, and that `buildStoredPIIReadSurfaceContext(...)` rehydrates serialized vault data before structured envelope readback.

Impact: Project-defined PII no longer relies on built-in-only scrubbers when structured envelopes are read back from active or stored sessions. Raw custom PII and durable `{{PII:...}}` markers are rendered for the normal session-read consumer without exposing originals.

Regression lock: `apps/runtime/src/__tests__/pii/runtime-pii-boundary-service.test.ts`, `apps/runtime/src/__tests__/pii/session-pii-context.test.ts`, and `apps/runtime/src/__tests__/execution/flow-authored-output-pii.test.ts`.

## Fixed Or Covered Items Kept In The Tracker

| Area                                      | Status                              | Evidence                                                                                                                                               |
| ----------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| YAML advanced flow constructs             | Fixed/covered                       | `parseFlowStep()` now reads `call_spec`, `on_input`, `on_result`, `digressions`, `sub_intents`, and `on_action`; serializer emits the same constructs. |
| Lifecycle visual save collateral rewrites | Fixed/covered                       | Current editor save path serializes dirty lifecycle sections independently and avoids rewriting `HOOKS` during `ON_START`-only saves.                  |
| Structured message persistence helper     | Fixed/covered for canonical callers | Pipeline, channel dispatcher, event-bus payloads, LiveKit, and KoreVG use `buildPersistedMessageStructuredContent()`.                                  |
| Session repo content envelope read/write  | Fixed/covered                       | Repository tests cover canonical `contentEnvelope` storage and cursor pagination.                                                                      |
| PII structured persistence protection     | Fixed/covered for persistence queue | Persistence queue tests cover redaction inside `contentEnvelope`.                                                                                      |

## Recommended Implementation Slices

### Slice 1: Runtime action interpolation parity

Goal: Make `ACTIONS` interpolation identical across normal `FLOW` responses, branch responses, lifecycle responses, and action handlers.

Test first:

| Test                                                               | Expected lock                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `FLOW` step emits interpolated action payload                      | DONE: `{{session.*}}` values are resolved in result, content envelope, and pending data. |
| `ON_INPUT` or `ON_RESULT` branch emits interpolated action payload | DONE: Branch actions resolve identically to direct step actions.                         |
| Action-handler action payload still resolves                       | DONE: Existing action-handler behavior remains unchanged.                                |

Implementation:

| Change                                                                                                                                                   | File                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Apply `interpolateActionSet(stepActions, session.data.values)` in the same response-normalization block that already interpolates rich and voice config. | DONE: `apps/runtime/src/services/execution/flow-step-executor.ts` |
| Keep PII protection after interpolation.                                                                                                                 | `apps/runtime/src/services/execution/flow-step-executor.ts`       |

### Slice 2: Canonicalize structured assistant persistence constructors

Goal: Remove or wrap direct `assistantStructuredContent` object reconstruction in WebSocket, SDK, and HTTP chat paths.

Test first:

| Test                                  | Expected lock                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| WebSocket normal chat parity          | Manual path output matches `buildPersistedMessageStructuredContent()`.             |
| SDK normal and typed interrupt parity | SDK path preserves rich, voice, actions, localization, and future envelope fields. |
| HTTP chat parity                      | HTTP chat persists/emits the same structured payload as the canonical helper.      |

Implementation:

| Change                                                                                                                                        | File                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Replace manual structured-content constructors with `buildPersistedMessageStructuredContent()` or a thin shared adapter that delegates to it. | `apps/runtime/src/websocket/handler.ts`     |
| Same canonicalization for SDK handler.                                                                                                        | `apps/runtime/src/websocket/sdk-handler.ts` |
| Same canonicalization for HTTP chat route.                                                                                                    | `apps/runtime/src/routes/chat.ts`           |

### Slice 3: Rehydration and read-surface structured parity

Goal: Ensure session detail and Studio replay prefer the richest available assistant message representation.

Test first:

| Test                                                             | Expected lock                                                                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Active/persisted merge with same text and richer active envelope | Merged session detail keeps active `contentEnvelope`.                                                                       |
| Trace-only `message.agent` replay                                | Studio synthesized assistant message includes `contentEnvelope`, `rawContent`, `richContent`, `voiceConfig`, and `actions`. |
| `dsl_respond.rendered` summary                                   | Observatory summary displays the rendered DSL response.                                                                     |

Implementation:

| Change                                                                                                                                                 | File                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Compare `contentEnvelope` and response metadata in session detail equivalence, or prefer the message with richer structured payload when text matches. | `apps/runtime/src/routes/sessions.ts`                     |
| Teach trace replay to consume structured `message.agent` payloads before falling back to text-only `dsl_respond` synthesis.                            | `apps/studio/src/utils/replay-trace-events.ts`            |
| Read `data.rendered` before legacy `message`/`text` fields for `dsl_respond` summaries.                                                                | `apps/studio/src/utils/observatory-event-presentation.ts` |

### Slice 4: Channel trace and AI4W contract decision

Goal: Convert the two likely findings into either explicit non-issues or fixed contract gaps.

Test first:

| Test                             | Expected lock                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Channel outcome trace contract   | Either successful structured outcomes are trace-rehydratable, or tests document durable messages as the only source of truth. |
| AI4W channel capability contract | Either structured sideband is emitted, or tests document text-only delivery with deliberate flattening.                       |

Implementation:

| Decision                                                                                                    | File                                           |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| If trace-rehydratable: extend `buildOutcomeTraceEvent()` to include successful structured outcome payloads. | `apps/runtime/src/services/channel/outcome.ts` |
| If text-only AI4W is intentional: add channel capability documentation and regression tests.                | `apps/runtime/src/routes/ai4w-channel.ts`      |

## Audit Closure Criteria

This inventory should be considered closed for implementation planning when:

| Criterion                                                                                   | Status                   |
| ------------------------------------------------------------------------------------------- | ------------------------ |
| Every row/column gap is mapped to a canonical seam or explicit channel capability boundary. | Partial                  |
| Every confirmed issue has a regression test planned before code changes.                    | Complete in this tracker |
| Every likely issue has an owner decision: fix, document as intended, or deprioritize.       | Pending                  |
| New implementation slices start with failing tests and land one seam at a time.             | Pending                  |
