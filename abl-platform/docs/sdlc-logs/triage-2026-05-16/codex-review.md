# Codex Independent Review - Triage 2026-05-16

### ABLP-1058

Verdict: CONCERN
Root cause:

- Agree on the core defect: runtime `ChatResult.rawContent` is closed to `TextContent | ToolUseContent`, the conversion paths only add text/tool_use blocks, and the reasoning executor reuses that lossy content on the next LLM call (`apps/runtime/src/services/llm/session-llm-client.ts:101`, `apps/runtime/src/services/llm/session-llm-client.ts:535`, `apps/runtime/src/services/llm/session-llm-client.ts:947`, `apps/runtime/src/services/execution/reasoning-executor.ts:2949`).

Solution:

- Sound direction, but it must update both runtime LLM result typing and the compiler executor path that currently rebuilds assistant content from `result.toolCalls` only (`packages/compiler/src/platform/constructs/executors/reasoning-executor.ts:343`).

Test:

- Directionally useful, but it is a compiler-layer proxy that asserts text preservation, not an OpenAI Responses/runtime repro of missing reasoning items (`packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-set-context.repro.test.ts:65`, `packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-set-context.repro.test.ts:123`).

Risks the author missed:

- Streaming has the same lossy `rawContent` construction and must be fixed with non-streaming conversion (`apps/runtime/src/services/llm/session-llm-client.ts:535`).
- Compiler executor has no `rawContent` result path today, so "rawContent includes reasoning" alone will not fix that package (`packages/compiler/src/platform/constructs/executors/reasoning-executor.ts:344`).

### ABLP-986

Verdict: CONCERN
Root cause:

- Agree: auto-transition clears `currentMessage`, then the reasoning-zone guard parks without running reasoning when no `PRESENT` is defined (`apps/runtime/src/services/execution/flow-step-executor.ts:8603`, `apps/runtime/src/services/execution/flow-step-executor.ts:8618`).

Solution:

- Mostly sound; prefer an explicit "entered by transition" input contract over removing the guard, because the current guard also prevents reasoning-zone startup without tool schemas (`apps/runtime/src/services/execution/flow-step-executor.ts:8612`).

Test:

- Weak: the only behavior test is skipped, and the unskipped test just re-states the boolean condition instead of exercising `FlowStepExecutor` (`packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-auto-advance.repro.test.ts:54`, `packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-auto-advance.repro.test.ts:95`).

Risks the author missed:

- A `PRESENT` step avoids an empty response but still parks and skips reasoning, so tests need both "no output" and "wrongly parked" cases (`apps/runtime/src/services/execution/flow-step-executor.ts:8622`).

### ABLP-1031

Verdict: PASS
Root cause:

- Agree: DELEGATE only accepts `- AGENT:` while HANDOFF accepts `- TO:`, and their AST/IR shapes are separate (`packages/core/src/parser/agent-based-parser.ts:4311`, `packages/core/src/parser/agent-based-parser.ts:4350`, `packages/core/src/parser/agent-based-parser.ts:4489`, `packages/core/src/types/agent-based.ts:1148`, `packages/core/src/types/agent-based.ts:1220`).

Solution:

- Sound: parser-level aliases can normalize into the existing AST/IR without forcing an immediate schema migration (`packages/compiler/src/platform/ir/schema.ts:1657`, `packages/compiler/src/platform/ir/schema.ts:1708`).

Test:

- Good parser-layer repro: it covers `TO`, `PASS`, `SUMMARY`, and backward-compatible `AGENT` (`packages/core/src/__tests__/handoff-delegate-symmetry.repro.test.ts:16`, `packages/core/src/__tests__/handoff-delegate-symmetry.repro.test.ts:68`, `packages/core/src/__tests__/handoff-delegate-symmetry.repro.test.ts:94`, `packages/core/src/__tests__/handoff-delegate-symmetry.repro.test.ts:141`).

Risks the author missed:

- None.

### ABLP-1032

Verdict: CONCERN
Root cause:

- Agree: most top-level sections assign directly, while only `TEMPLATES` accumulates (`packages/core/src/parser/agent-based-parser.ts:417`, `packages/core/src/parser/agent-based-parser.ts:438`, `packages/core/src/parser/agent-based-parser.ts:463`).

Solution:

- Directionally sound, but the registry must define merge semantics per section; blindly accumulating `TOOLS` can preserve duplicate tool names into IR compilation (`packages/compiler/src/platform/ir/compiler.ts:1020`).

Test:

- Reproduces overwrite for several arrays, but it does not actually allow the "or DuplicateSectionError" alternative it documents because assertions require accumulation (`packages/core/src/__tests__/duplicate-sections.repro.test.ts:6`, `packages/core/src/__tests__/duplicate-sections.repro.test.ts:44`).

Risks the author missed:

- Singleton duplicates such as `GOAL`, `EXECUTION`, and `LANGUAGE` are not covered by the repro even though the proposed registry depends on singleton behavior (`packages/core/src/parser/agent-based-parser.ts:454`, `packages/core/src/__tests__/duplicate-sections.repro.test.ts:16`).

### ABLP-1059

Verdict: CONCERN
Root cause:

- Agree: async, streaming, and sync selection is scattered; `ASYNC:true` silently falls through when `asyncInfra` is missing, and push capability is not checked at the decision point (`apps/runtime/src/services/execution/routing-executor.ts:2010`, `apps/runtime/src/services/execution/routing-executor.ts:2031`, `apps/runtime/src/services/execution/routing-executor.ts:2059`).

Solution:

- Sound direction: a pure resolver plus trace reason is the right chokepoint, but integration must fetch/validate the agent card before the async branch rather than after it (`apps/runtime/src/services/execution/routing-executor.ts:2010`, `apps/runtime/src/services/execution/routing-executor.ts:2032`).

Test:

- Useful future contract, but it fails by importing a missing module rather than exercising current routing behavior (`packages/a2a/src/__tests__/a2a-handoff-mode.repro.test.ts:23`, `packages/a2a/src/__tests__/a2a-handoff-mode.repro.test.ts:27`).

Risks the author missed:

- Streaming is currently gated on `onChunk`, so REST callers cannot use streaming even when the remote card supports it; the resolver needs that policy explicit (`apps/runtime/src/services/execution/routing-executor.ts:2031`).

### ABLP-974

Verdict: DISAGREE
Root cause:

- Partially agree: taskId, trace contextId, discovery taskId leak, metadata gap, and protocol limitation are visible in code, but the "server-generated contextId" claim conflicts with the existing adapter contract that maps client-supplied contextId to a platform session (`apps/runtime/src/services/execution/routing-executor.ts:1964`, `apps/runtime/src/services/execution/routing-executor.ts:1970`, `apps/runtime/src/services/execution/routing-executor.ts:1984`, `packages/a2a/src/application/discover-agent.ts:53`, `packages/a2a/src/infrastructure/agent-executor-adapter.ts:484`).

Solution:

- A session-bound outbound `A2ATurnContext` is sound for issues 2/4/5/6; I would not make inbound contextId server-generated without a compatibility decision, accepting the trade-off that clients own correlation IDs while the server enforces tenant-scoped mapping (`packages/a2a/src/infrastructure/agent-executor-adapter.ts:501`, `packages/a2a/src/infrastructure/agent-executor-adapter.ts:529`).

Test:

- Wrong as written: the fake server exposes `/.well-known/agent.json` while discovery defaults to `agent-card.json`, and the taskId carryover test manually injects the remote taskId instead of testing routing storage (`packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:46`, `packages/a2a/src/application/discover-agent.ts:16`, `packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:214`).

Risks the author missed:

- The current failing A2A turn-context test can fail before reaching issue 2/6 assertions because `sendTask` delegates to SDK card discovery first (`packages/a2a/src/application/send-task.ts:82`, `packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:166`).
- Issue 4 needs DSL, AST, IR, and runtime propagation; current `HandoffConfig` has no metadata field in AST (`packages/core/src/types/agent-based.ts:1220`).

### ABLP-900

Verdict: PASS
Root cause:

- Agree: `buildTools` exposes `__return_to_parent__` from transient thread flags only, and the realtime Google tool superset builder spreads the active thread into temp sessions for other agents (`apps/runtime/src/services/execution/prompt-builder.ts:1268`, `apps/runtime/src/services/voice/korevg/realtime-tool-definitions.ts:34`).

Solution:

- Sound: add the `threadStack.length > 0` guard and stop copying child return flags into non-child temp threads; the runtime execution guard already uses the same parent-stack invariant (`apps/runtime/src/services/execution/routing-executor.ts:4621`).

Test:

- Good repro: it simulates root with leaked `returnExpected` and empty stack, plus a legitimate child-stack control (`apps/runtime/src/__tests__/execution/supervisor-tools.repro.test.ts:138`, `apps/runtime/src/__tests__/execution/supervisor-tools.repro.test.ts:169`).

Risks the author missed:

- None.

### ABLP-1100

Verdict: DISAGREE
Root cause:

- Agree on the feature gap: `ToolParameter` has no `hidden/defaultSource`, runtime schema generation includes every param, and execution only has the fixed session-context injection allowlist (`packages/compiler/src/platform/ir/schema.ts:1095`, `apps/runtime/src/services/execution/prompt-builder.ts:1162`, `apps/runtime/src/services/execution/prompt-builder.ts:1194`, `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts:393`).

Solution:

- Directionally sound only if Phase 1 starts with an explicit resolvable-path allowlist; generic `session.X` would break the current three-key allowlist model (`packages/compiler/src/platform/contracts/contract-source-data.ts:29`).

Test:

- Does not reproduce the bug: it uses `@ts-expect-error`, then asserts that hidden params are present and required, so the test currently passes while documenting the bad state (`packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts:33`, `packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts:122`).

Risks the author missed:

- The test must be inverted before landing; otherwise Phase 1 can appear "covered" while no executable assertion requires filtering (`packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts:133`).
- Realtime adapters consume already-built schemas, so hidden filtering belongs before both standard and realtime conversion paths (`apps/runtime/src/services/voice/korevg/realtime-tool-definitions.ts:57`, `packages/compiler/src/platform/llm/realtime/ultravox-realtime.ts:390`).

### ABLP-1066

Verdict: CONCERN
Root cause:

- Agree on the diagnostic collapse: the resolver filters/returns null for many cases and then throws one generic tenant-scoped message (`packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:117`, `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:165`, `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:190`, `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:220`, `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:274`).

Solution:

- Typed failures are sound; I would be cautious about a platform-default fallback because it can turn a tenant configuration failure into a warning instead of preserving the current fail-fast preflight behavior (`packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts:183`).

Test:

- Useful direction but weak: it can silently return early when MongoMemoryServer is unavailable, and the "valid config should pass" path may be testing model/mongoose setup rather than the reported UI diagnostic collapse (`packages/pipeline-engine/src/__tests__/evals-pipeline-health.repro.test.ts:214`, `packages/pipeline-engine/src/__tests__/evals-pipeline-health.repro.test.ts:215`).

Risks the author missed:

- User-visible preflight messages currently include the raw tenant ID from the resolver, which conflicts with runtime error sanitization expectations (`packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:118`, `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts:187`).
- The provider/key mismatch check is downgraded to warning when credential resolution fails, so the UI cannot distinguish "not checked" from "checked but risky" without a structured status (`packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts:190`).

### ABLP-905

Verdict: CONCERN
Root cause:

- Agree: import schemas reject the actual eval model/export shapes for `personaModel`, `expectedMilestones`, `version`, `goals`, and `constraints` (`packages/project-io/src/import/entity-schemas.ts:392`, `packages/project-io/src/import/entity-schemas.ts:411`, `packages/project-io/src/import/entity-schemas.ts:413`, `packages/project-io/src/import/entity-schemas.ts:426`, `packages/project-io/src/import/entity-schemas.ts:724`, `packages/database/src/models/eval-set.model.ts:83`, `packages/database/src/models/eval-scenario.model.ts:74`, `packages/database/src/models/eval-persona.model.ts:71`).

Solution:

- Minimum schema alignment is sound; apply it to both file-level and staged-record schemas (`packages/project-io/src/import/entity-schemas.ts:381`, `packages/project-io/src/import/entity-schemas.ts:713`).

Test:

- Good import-layer repro using disassembler plus staged-record validation (`packages/project-io/src/__tests__/eval-artifact-roundtrip.repro.test.ts:96`, `packages/project-io/src/__tests__/eval-artifact-roundtrip.repro.test.ts:101`, `packages/project-io/src/__tests__/eval-artifact-roundtrip.repro.test.ts:128`, `packages/project-io/src/__tests__/eval-artifact-roundtrip.repro.test.ts:156`).

Risks the author missed:

- The TypeScript model still says `personaModel?: string` while the Mongoose default is `null`; update the type or the drift remains at compile-time boundaries (`packages/database/src/models/eval-set.model.ts:41`, `packages/database/src/models/eval-set.model.ts:83`).

### ABLP-1010

Verdict: CONCERN
Root cause:

- Agree: publish diagnostics are flattened in project-io, wrapped as generic build errors in Studio, and then sanitized/truncated for modal display (`packages/project-io/src/module-release/build-module-release.ts:267`, `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:451`, `apps/studio/src/components/modules/PublishModuleDialog.tsx:153`, `apps/studio/src/lib/sanitize-error.ts:59`).

Solution:

- Sound: a structured `PublishDiagnostic[]` contract should cross package, API, and UI boundaries instead of relying on `errors: string[]` (`packages/project-io/src/module-release/module-publish-safety.ts:27`, `apps/studio/src/app/api/projects/[id]/module/releases/route.ts:448`).

Test:

- Reproduces the builder contract only, but violates the stated repo rule by mocking `@abl/compiler/platform` (`packages/project-io/src/__tests__/module-publish-diagnostics.repro.test.ts:16`, `packages/project-io/src/__tests__/module-publish-diagnostics.repro.test.ts:79`).

Risks the author missed:

- The UI collapse also happens in the API client path that joins multiple errors into one sanitized server error (`apps/studio/src/api/project-io.ts:463`, `apps/studio/src/api/project-io.ts:470`).
- The repro does not cover the Studio route or modal rendering, so the two downstream flattening layers could remain broken after a builder-only fix (`apps/studio/src/app/api/projects/[id]/module/releases/route.ts:451`, `apps/studio/src/components/modules/PublishModuleDialog.tsx:153`).

### ABLP-1019

Verdict: DISAGREE
Root cause:

- Disagree with the "shipped slice verified" claim: current `chat.ts` has no `debug` request field and still returns `state`, `traceEvents`, and `traceContext` unconditionally on several response paths (`docs/sdlc-logs/triage-2026-05-16/SUMMARY.md:97`, `apps/runtime/src/routes/chat.ts:1403`, `apps/runtime/src/routes/chat.ts:2587`, `apps/runtime/src/routes/chat.ts:2941`, `apps/runtime/src/routes/chat.ts:2991`).

Solution:

- Curl metadata fix is fine, but the heavy-payload/debug-gating fix is still required in this tree; attachments should remain separate (`apps/studio/src/components/deployments/channels/sdk-chat-curl.ts:10`, `apps/runtime/src/routes/chat.ts:1407`).

Test:

- The curl helper test reproduces only the metadata/interactionContext discoverability gap; it does not cover debug payload gating, and the attachment test is intentionally skipped (`apps/studio/src/__tests__/components/copy-as-curl-metadata.repro.test.tsx:21`, `apps/studio/src/__tests__/components/copy-as-curl-metadata.repro.test.tsx:27`, `apps/runtime/src/__tests__/sessions/chat-attachments.repro.test.ts:16`).

Risks the author missed:

- `buildSdkChatExamplePayload` currently returns `Record<string, string>`, which will need widening when adding object-valued `metadata` and `interactionContext` placeholders (`apps/studio/src/components/deployments/channels/sdk-chat-curl.ts:9`, `apps/studio/src/components/deployments/channels/sdk-chat-curl.ts:10`).
- API schema already accepts `metadata` and `interactionContext`, so this is a documentation/UI gap, not a runtime validation gap (`apps/runtime/src/routes/chat.ts:1408`, `apps/runtime/src/routes/chat.ts:1409`).

## Overall Plan Critique

- The suggested order is mostly sensible for independent low-risk fixes, but it assumes ABLP-1019 debug gating is already landed; in this tree it should move to the top with the curl fix (`docs/sdlc-logs/triage-2026-05-16/SUMMARY.md:103`, `docs/sdlc-logs/triage-2026-05-16/SUMMARY.md:105`, `apps/runtime/src/routes/chat.ts:2941`).
- I would keep ABLP-905 early, then ABLP-1019 full API-channel cleanup, ABLP-900, ABLP-1032, ABLP-1031, ABLP-1058, ABLP-986, ABLP-1059, ABLP-974 split pieces, ABLP-1066, ABLP-1010, ABLP-1100 (`docs/sdlc-logs/triage-2026-05-16/SUMMARY.md:104`, `docs/sdlc-logs/triage-2026-05-16/SUMMARY.md:115`).
- True blockers: ABLP-1059 should land before any ABLP-974 mode-mismatch work because the 974 test already cross-references the resolver gap (`packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:24`, `packages/a2a/src/__tests__/a2a-handoff-mode.repro.test.ts:27`).
- True blockers: ABLP-1032 should land before ABLP-1031 if both touch parser dispatch, to avoid mixing duplicate-section semantics with syntax migration in the same parser branch (`packages/core/src/parser/agent-based-parser.ts:417`, `packages/core/src/parser/agent-based-parser.ts:4311`).
- ABLP-1058 and ABLP-986 should stay separate; one is message content preservation, the other is flow-step entry gating (`apps/runtime/src/services/execution/reasoning-executor.ts:2949`, `apps/runtime/src/services/execution/flow-step-executor.ts:8618`).
- ABLP-974 should be split. Keep discovery trace leak, trace contextId, outbound task/metadata state, inbound contextId policy, and protocol-version transport as separate units; they hit different files and different compatibility surfaces (`packages/a2a/src/application/discover-agent.ts:53`, `packages/a2a/src/domain/ports.ts:11`, `apps/runtime/src/services/execution/routing-executor.ts:1964`, `packages/a2a/src/infrastructure/client-factory.ts:14`).
- ABLP-1019 should remain split: debug payload gating and curl example belong together; multipart attachment upload is a separate storage/security feature (`apps/runtime/src/routes/chat.ts:1407`, `apps/runtime/src/__tests__/sessions/chat-attachments.repro.test.ts:8`).
- ABLP-1100 must be split by phase, with Phase 1 blocked on allowlist design and a real failing test (`packages/compiler/src/platform/contracts/contract-source-data.ts:29`, `packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts:122`).

## Systemic Patterns

- Boundary contracts are not centralized: DSL sections are parsed by ad-hoc dispatch, A2A mode/turn state is scattered through routing, eval import schemas drift from Mongoose, and publish diagnostics are flattened at package/API/UI boundaries (`packages/core/src/parser/agent-based-parser.ts:417`, `apps/runtime/src/services/execution/routing-executor.ts:2010`, `packages/project-io/src/import/entity-schemas.ts:392`, `packages/project-io/src/module-release/build-module-release.ts:267`).
- Tests often document desired behavior without exercising the production layer: skipped runtime repros, future-API imports, manual injection of missing fields, and internal package mocks all reduce confidence (`packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-auto-advance.repro.test.ts:54`, `packages/a2a/src/__tests__/a2a-handoff-mode.repro.test.ts:27`, `packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:214`, `packages/project-io/src/__tests__/module-publish-diagnostics.repro.test.ts:16`).
- User-facing diagnostic paths repeatedly lose structured data: LLM credential failures collapse to one string, publish diagnostics collapse to strings, and API-channel debug payloads leak internals by default (`packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:117`, `apps/studio/src/lib/sanitize-error.ts:103`, `apps/runtime/src/routes/chat.ts:2941`).

## Top 3 Things To Fix Before Landing Any Of These

- Fix the repro tests so they are executable, failing for the right reason, and policy-compliant: unskip or replace ABLP-986, invert ABLP-1100 assertions, fix ABLP-974 agent-card/test layering, and remove the ABLP-1010 `@abl/*` mock (`packages/compiler/src/platform/constructs/executors/__tests__/reasoning-executor-auto-advance.repro.test.ts:54`, `packages/compiler/src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts:122`, `packages/a2a/src/__tests__/a2a-turn-context.repro.test.ts:46`, `packages/project-io/src/__tests__/module-publish-diagnostics.repro.test.ts:16`).
- Define the typed contracts before patching call sites: `PublishDiagnostic`, `A2AModeResolver`, `A2ATurnContext`, hidden-param source allowlist, and eval schema/model alignment (`packages/project-io/src/module-release/module-publish-safety.ts:27`, `packages/a2a/src/__tests__/a2a-handoff-mode.repro.test.ts:27`, `packages/a2a/src/domain/ports.ts:11`, `packages/compiler/src/platform/contracts/contract-source-data.ts:29`, `packages/database/src/models/eval-scenario.model.ts:74`).
- Sanitize and gate user-visible surfaces first: ABLP-1019 debug payloads, ABLP-1066 tenant-bearing messages, and ABLP-1010 raw diagnostic strings all expose implementation detail to users (`apps/runtime/src/routes/chat.ts:2587`, `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts:118`, `packages/project-io/src/module-release/build-module-release.ts:267`).

## Verification Notes

- Ran `pnpm build --filter=@abl/compiler --filter=@abl/core --filter=@agent-platform/a2a --filter=@agent-platform/runtime --filter=@agent-platform/pipeline-engine --filter=@agent-platform/project-io --filter=@agent-platform/studio --dry-run`; it completed, but the root build script executed prerequisite builds/tests before Turbo dry-run.
- Ran `pnpm --filter @abl/compiler test -- src/platform/llm/__tests__/tool-schema-hidden-params.repro.test.ts`; it passed, confirming ABLP-1100's repro is not currently failing.
- Ran `pnpm --filter @agent-platform/a2a test -- src/__tests__/a2a-turn-context.repro.test.ts src/__tests__/a2a-handoff-mode.repro.test.ts`; it failed, but ABLP-974 issue 2/6 failed on agent-card discovery setup before the intended assertions, while ABLP-1059 failed on the missing resolver import.
