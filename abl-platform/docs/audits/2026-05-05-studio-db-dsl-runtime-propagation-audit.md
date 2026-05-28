# Studio -> DB -> DSL -> Runtime Propagation Audit

**Date**: 2026-05-05
**Mode**: Exhaustive inventory first, no fixes in this pass
**Scope**: Studio authoring/readiness, DB persistence, Project IO export/import, DSL/YAML materialization, compiler IR, runtime execution, WebSocket/channel delivery, persistence, and rehydration/read surfaces.

## Canonical Matrix

| Seam                         | Draft Readiness                                 | Runtime Config                    | YAML/IR Materialization                      | Rich Content | Voice Config     | Actions  | Metadata/Trace                    | PII Context        |
| ---------------------------- | ----------------------------------------------- | --------------------------------- | -------------------------------------------- | ------------ | ---------------- | -------- | --------------------------------- | ------------------ |
| Studio visual save           | Partial                                         | N/A                               | Partial                                      | Partial      | Partial          | Partial  | Unknown                           | Unknown            |
| Studio DSL save              | Uses diagnostics metadata                       | N/A                               | Partial                                      | Partial      | Partial          | Partial  | Unknown                           | Unknown            |
| DB persistence               | Stores `dslValidationStatus` / `dslDiagnostics` | Stores `ProjectRuntimeConfig`     | Stores source DSL and compiled versions      | Partial      | Partial          | Partial  | Partial                           | Partial            |
| Project IO export/bundle/git | Uses export readiness                           | Uses export readiness             | GAP: materializer lacks runtime config/tools | Likely       | Likely           | Likely   | Unknown                           | Unknown            |
| YAML/DSL parser              | N/A                                             | N/A                               | Partial                                      | Partial      | Partial          | Partial  | N/A                               | N/A                |
| Compiler IR                  | N/A                                             | Supports `project_runtime_config` | Canonical when options are passed            | Supports     | Supports         | Supports | N/A                               | N/A                |
| Runtime session compile      | Uses centralized readiness gate                 | Uses strict resolver              | Uses runtime compiler options                | Supports     | Supports         | Supports | Emits                             | Refreshes          |
| Channel delivery             | N/A                                             | N/A                               | N/A                                          | Partial      | GAP in cross-pod | Partial  | GAP in cross-pod handoff progress | Depends on session |
| Persistence/read surfaces    | N/A                                             | N/A                               | N/A                                          | Partial      | Partial          | Partial  | Partial                           | Partial            |
| Rehydration                  | N/A                                             | N/A                               | N/A                                          | Partial      | Partial          | Partial  | Partial                           | Partial            |

## Canonical Helpers

| Concern                             | Canonical Helper/Boundary                                                             | Current Status                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Project execution readiness         | `evaluateProjectExecutionReadiness()` and `compileProjectWorkingCopy()`               | Mostly centralized after latest runtime slice                          |
| Export readiness                    | `getProjectExportReadinessIssues()`                                                   | Used by export/bundle/git/module release paths                         |
| Runtime config execution resolution | `resolveProjectRuntimeConfig()`                                                       | Strict for runtime initialization after latest slice                   |
| Studio compiler options             | `buildStudioCompilerOptions()`                                                        | GAP: maps DB runtime config directly                                   |
| YAML materialization                | `materializeProjectAgentExports()`                                                    | GAP: accepts only config variables                                     |
| Structured output protection        | `protectStructuredOutputForUser()` / `emitProtectedExecutionResult()`                 | Used in primary execution, bypasses remain in return/persistence seams |
| Response persistence envelope       | `buildExecutionResultContentEnvelope()` / `persistMessage(... structuredContent ...)` | Used in major chat/WS paths, not in channel dispatcher                 |

## Confirmed Issue Register

| ID       | Severity | Seam                                         | Status    | Evidence                                                                                                                                                                                                                                                                       | Impact                                                                                                                                                                       | Regression Lock                                                                                                                            |
| -------- | -------- | -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| CONF-001 | P1       | Studio compile/runtime config                | Confirmed | `apps/studio/src/lib/abl/studio-compiler-options.ts:28-38` loads `ProjectRuntimeConfig` and calls `mapProjectRuntimeConfigDocumentToIR()` directly, catching failures as warnings.                                                                                             | Studio compile/diagnostics/draft metadata can continue with invalid saved runtime config while export/runtime now fail closed.                                               | Add Studio compiler-options test: invalid persisted runtime config returns blocking error, not warning/default.                            |
| CONF-002 | P1       | Project IO YAML export materialization       | Confirmed | `packages/project-io/src/export/layer-assemblers/core-assembler.ts:344-356` passes only agents/config variables; `packages/project-io/src/export/agent-export-materializer.ts:23-28` has no runtime config/tool field; compile uses only `config_variables` at lines 176-180.  | `dsl_format=yaml` export/bundle/git can produce YAML from an IR that does not match runtime compiler inputs, especially for runtime-config-driven behavior.                  | Add project-io export test with runtime config that changes IR; assert YAML export uses the same `project_runtime_config`.                 |
| CONF-003 | P1       | Module release IR materialization            | Confirmed | `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:337` compiles release IR without compiler options; line 392 repeats that in `compileFn`.                                                                                                                       | Module release artifact can pass readiness but embed precompiled IR that omits runtime config/tool resolution, diverging from deployed/runtime behavior.                     | Add module release route test with runtime config/tool-dependent IR and assert release precompiled IR includes canonical compiler options. |
| CONF-004 | P2       | Cross-pod WebSocket delivery                 | Confirmed | `channel-dispatcher.ts:56-66` includes `voiceConfig`; publish includes `handoffProgress` at lines 211-218; subscriber in `websocket/handler.ts:1024-1051` reads response/richContent/actions/metadata but passes `undefined` for voiceConfig and never emits handoff progress. | Same-pod and pending reconnect can preserve voice config, but cross-pod live delivery drops voice output and handoff progress.                                               | Add WebSocket pubsub delivery test covering voiceConfig and handoffProgress.                                                               |
| CONF-005 | P2       | Channel dispatcher -> DB message persistence | Confirmed | `channel-dispatcher.ts:92-100` `MessagePersister` accepts metadata only; `channel-dispatcher.ts:163-170` persists `result.response` and `responseMetadata` but no structured content envelope.                                                                                 | Async channel results with rich content/actions/voice are delivered live/pending, but DB history/read surfaces lose the structured payload.                                  | Add channel-dispatcher test asserting `persistMessage` receives structured envelope for richContent/actions/voiceConfig.                   |
| CONF-006 | P2       | Thread return/read surfaces                  | Confirmed | `tryThreadReturn()` only accepts `response: string` at `execution/types.ts:1557-1560`; callers pass `result.response` only; parent history push at lines 1667-1672 stores text only.                                                                                           | Child-agent returns with rich content/actions/voice preserve delivery in some paths but lose structured payload in parent conversation history and rehydrated read surfaces. | Add handoff/thread-return test with child structured result and assert parent history content envelope survives.                           |

## Likely/Needs-Deeper Inventory

| ID         | Severity | Seam                                        | Evidence                                                                                                                                        | Why Not Confirmed Yet                                                                        | Next Check                                                                                           |
| ---------- | -------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| LIKELY-001 | P2       | Arch AI compile helpers                     | `rg compileABLtoIR` shows several `apps/studio/src/lib/arch-ai/tools/*` compile paths that do not obviously use `buildStudioCompilerOptions()`. | Arch AI may be design-time only, and some paths may intentionally compile isolated snippets. | Classify each Arch AI compile caller as isolated lint versus project-runtime-affecting write path.   |
| LIKELY-002 | P2       | Studio topology/dependency read surfaces    | `apps/studio/src/app/api/projects/[id]/topology/route.ts` and dependency routes parse/compile stored DSL separately.                            | These are read/visual surfaces, not execution, and may not need runtime config.              | Decide whether visual topology must reflect runtime-config/tool-aware compiler semantics.            |
| LIKELY-003 | P3       | Cross-channel behavior contract enforcement | Channel adapters advertise rich/voice/action support in `channel-behavior-contract.ts`, but delivery adapters transform independently.          | This audit did not yet prove a specific adapter violates its declared contract.              | Build adapter-by-adapter table for `transformOutput(text, actions, richContent)` and voice handling. |

## Future-Ready Implementation Plan

### Slice 1: Canonical Studio Compiler Options

Test first:

- Add failing tests for `buildStudioCompilerOptions()` with invalid persisted runtime config.
- Add failing tests that Studio diagnostics/draft metadata treat runtime config validation as blocking.

Implementation:

- Move Studio compiler options to a shared runtime-config validation/resolution helper, or expose a project-io-safe validator that returns either canonical `ProjectRuntimeConfigIR` or blocking diagnostics.
- Preserve DB outage/no-record behavior separately from invalid saved config.

Exit:

- Studio compile/diagnostics/export/runtime all agree on invalid runtime config.

### Slice 2: Export/Module Release IR Parity

Test first:

- Add project-io YAML materialization test proving runtime config reaches `compileABLtoIR()`.
- Add module release route/service test proving precompiled IR uses canonical compiler options.

Implementation:

- Extend `ProjectAwareAgentExportMaterializationInput` with `compilerOptions` or `runtimeConfigIR` plus resolved tool implementations.
- Extract module release compilation into a shared helper that uses the same compiler option builder as export/runtime.

Exit:

- YAML export, module releases, Studio compile, and runtime compile consume the same runtime config/tool context.

### Slice 3: Cross-Pod Structured Delivery

Test first:

- Add WebSocket Redis pubsub test for `voiceConfig` and `handoffProgress`.
- Add pending/live parity assertions so same-pod, cross-pod, and reconnect use the same envelope.

Implementation:

- Parse and forward `voiceConfig` in `setRedisPubSub()`.
- Emit `handoff_progress` before response frames when pubsub message contains handoff progress.
- Prefer a shared `deliverStructuredWsResult()` helper for local, pubsub, and pending paths.

Exit:

- Cross-pod Studio debug/SDK delivery preserves text, rich content, actions, voice config, response metadata, and handoff progress.

### Slice 4: Structured Persistence and Thread Return

Test first:

- Add channel dispatcher persistence test for structured envelope.
- Add thread return test for child rich content/actions/voice in parent history.

Implementation:

- Widen `MessagePersister.persistMessage()` to accept structured content and response metadata separately.
- Build content envelopes in `ChannelDispatcher` using the canonical helper.
- Change `tryThreadReturn()` to accept a structured result object, not just response text, and merge protected content envelopes into parent history.

Exit:

- Rehydration/read surfaces preserve structured output across async delivery and child-thread returns.

## Audit Commands Used

- `rg "compileProjectWorkingCopy|compileWebDebugWorkingCopy|buildProjectWorkingCopyAgentSources|evaluateProjectExecutionReadiness|getProjectExportReadinessIssues|dslValidationStatus|dslDiagnostics|ProjectRuntimeConfig|mapProjectRuntimeConfigDocumentToIR|runtimeConfig"`
- `rg "mapProjectRuntimeConfigDocumentToIR|resolveProjectRuntimeConfig|ProjectRuntimeConfig.findOne|ProjectRuntimeConfig.findOneAndUpdate|ProjectRuntimeConfig.create|ProjectRuntimeConfig.updateOne"`
- `rg "compileABLtoIR|parseAgentBasedABL|yaml"`
- `rg "protectSessionOutputForUser|richContent|voiceConfig|actions"`
- `rg "persistMessage|conversationHistory|tryThreadReturn|pendingDeliveryStore|ws:deliver"`
