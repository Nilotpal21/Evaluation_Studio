# Agent Transfer Parity — ABL Platform vs Koreserver

> **Status**: Reference / analysis document
> **Last Updated**: 2026-04-21
> **Scope**: Side-by-side comparison of Agent Transfer semantics, architecture, and surface area between the ABL Platform and the legacy Koreserver codebase (`/koreserver/koreserver`).
> **Purpose**: Identify parity gaps, overlapping concepts, and net-new ABL capabilities that have no Koreserver precedent — to inform migration, customer-facing narrative, and feature-completion planning.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Critical Semantic Finding](#2-critical-semantic-finding)
3. [Part 1 — Bot → Human Agent Transfer (direct parity)](#3-part-1--bot--human-agent-transfer-direct-parity)
4. [Part 2 — Multi-Agent Orchestration (AI → AI)](#4-part-2--multi-agent-orchestration-ai--ai)
5. [ABL File Reference](#5-abl-file-reference)
6. [Koreserver File Reference](#6-koreserver-file-reference)
7. [Gap Register & Action Items](#7-gap-register--action-items)
8. [Glossary](#8-glossary)
9. [Appendix A — Why ABL's multi-agent handoff has no Koreserver precedent](#appendix-a--why-abls-multi-agent-handoff-has-no-koreserver-precedent)
10. [Appendix B — Koreserver Callflow ↔ Contact Center Data Flow](#appendix-b--koreserver-callflow--contact-center-data-flow)
11. [Appendix C — ABL Equivalents Required for Parity](#appendix-c--abl-equivalents-required-for-parity)
12. [Appendix D — Bringing Callflow Experience to ABL (design direction)](#appendix-d--bringing-callflow-experience-to-abl-design-direction)

---

## 1. Executive Summary

- **Bot-to-Human Transfer**: ABL is architecturally cleaner than Koreserver (typed Zod config, single LLM-driven path, explicit state machine, dedicated package boundary, first-class tenant isolation, tracing, rate limiting). It carries **vendor coverage debt** — Koreserver ships **12 vendor adapters**, ABL ships **2** (Kore, Five9). ABL is also missing the **LLM conversation summary** step that Koreserver sends to the human agent at transfer time.
- **AI Agent-to-Agent Transfer**: ABL has a real multi-agent handoff model (`HANDOFF:` DSL, `__handoff__` system tool, typed context passing, cycle detection, return mapping, remote/async variants). **Koreserver has no equivalent.** The closest Koreserver analog is the **Universal Bot** (NLU intent routing), which is not a transfer mechanism.
- **Net Assessment**: Functional parity with Koreserver's customer surface requires completing 6 gaps (listed in §7). ABL's multi-agent orchestration is a net-new capability that should be positioned as a forward-looking advantage, not benchmarked against Koreserver.

---

## 2. Critical Semantic Finding

The term "Agent Transfer" means **different things** in each system. Conflating them causes confusion in migration discussions and feature mapping.

| Meaning                                             | ABL                                                                                       | Koreserver                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Bot → Human agent** (contact center escalation)   | `@agent-platform/agent-transfer` package, `transfer_to_agent` tool, `ESCALATE:` DSL block | `AgentTransferExecutor` (dialog engine) + `AgentTransferTask` (callflow engine) — **the** Agent Transfer feature    |
| **AI Agent → AI Agent** (multi-agent orchestration) | `HANDOFF:` DSL, `__handoff__` system tool, `HandoffExecutor`                              | ❌ **Does not exist.** Closest analog is **Universal Bot** (NLU `/ub/detectskill` routing) — not transfer semantics |
| **Synchronous sub-agent call** (returns a value)    | `DELEGATE:` DSL, `__delegate__` system tool                                               | ❌ Not a first-class concept (dialog `BotAction` / `dialogCall` is intra-bot only)                                  |

**Implication**: Direct parity comparison is only meaningful for **bot-to-human**. ABL's agent-to-agent handoff is a **new capability with no Koreserver precedent** and should be evaluated on its own merits rather than through a parity lens.

---

## 3. Part 1 — Bot → Human Agent Transfer (direct parity)

### 3.1 Feature-by-feature comparison

| Dimension                         | Koreserver                                                                                                                             | ABL Platform                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Entry points**                  | Two parallel engines: dialog node `agentTransfer` + callflow step `agenttransfer` (duplicated code paths)                              | Single path: LLM tool call `transfer_to_agent` (or compiled from `ESCALATE:` DSL)                                                                                                                                  |
| **Trigger decision**              | Deterministic — builder drops a node/step in authoring UI; no LLM decision at runtime                                                  | LLM decides at runtime via tool call; tool description gates availability                                                                                                                                          |
| **Vendor adapters**               | 12 vendor executors under `api/services/AgentExecutor/lib/` (Kore, Salesforce, Genesys, ServiceNow, Zendesk, Unblu, Zoom, …)           | `AdapterRegistry` pattern; shipped adapters: `KoreAdapter`, `Five9Adapter` (voice)                                                                                                                                 |
| **Authoring surface**             | Bot builder dialog editor + callflow authoring UI; nested Mongoose schema                                                              | Studio `AgentTransferSettingsPage.tsx` (tenant/project settings); routing in ABL source files                                                                                                                      |
| **Config schema**                 | `DialogComponentModel.js` + `CFStepDefinition.js` (untyped runtime)                                                                    | `AgentTransferConfigSchema` (Zod, typed) + `ProjectSettings.agentTransfer`                                                                                                                                         |
| **Session state store**           | Redis keys: `AgentTransfer:<hash>`, `CF:AGENT_TRANSFER:…`, `ATCF:…`, `POST_AGENT_DIALOG:…`                                             | Redis `TransferSessionStore` with typed `TransferSessionData` and state machine `pending → queued → active → post_agent → ended`                                                                                   |
| **Context passed to human agent** | `addConversationAndSessionDetails()` — userId, sentiment, intents, completed/failed tasks, chat history URL, LLM conversation summary  | `TransferPayload` — `conversationHistory[]`, contact, metadata; provider-specific formatting via `KoreHistoryStrategy` / `GenericHistoryStrategy`                                                                  |
| **LLM summary on transfer**       | ✅ `getConversationSummaryAgentTransfer` (feature-flagged, uses KoreXO GPT integration)                                                | ⚠️ **Missing** — history is passed raw; no dedicated summary step                                                                                                                                                  |
| **Post-agent action**             | `postAgentConversation.action: returnToFlow \| triggerDialog` (only for some vendors: Genesys, Salesforce, ServiceNow)                 | `postAgentAction: return \| end` at payload level                                                                                                                                                                  |
| **PII handling**                  | Feature flag `PIIMaskingDisabledForAgentTransfer` controls de-tokenization                                                             | First-class PII handling section in Zod config                                                                                                                                                                     |
| **Trace / observability**         | `botanalytics` record `type:"agentTransfer"`, WebSocket `Agent_Session_Start/End`, `usageLogType:'agent_transfer'`, OpenTelemetry span | `TransferTraceEvent` discriminated union (6 variants: initiated, completed, failed, agent-connected, agent-disconnected, csat-completed), OTel counter `agent_transfer.events`, bridged into platform `TraceStore` |
| **Rate limiting**                 | Not evident                                                                                                                            | Redis sliding-window limiter in `TransferToolExecutor`                                                                                                                                                             |
| **Tenant isolation**              | Implicit via per-bot session keys                                                                                                      | Explicit tests (`tenant-isolation.test.ts`); `tenantId` on all session records                                                                                                                                     |
| **Bidirectional messaging**       | Provider-specific; SDK webhook path at `/sdk/bots/:id/components/:id/on_agent_transfer`                                                | Inbound webhooks at `POST /api/v1/agent-transfer/webhooks/:provider` bridged to user channel                                                                                                                       |
| **CSAT / disposition**            | Handled per-vendor in individual agent executors                                                                                       | `CsatHandler`, `DispositionHandler` classes exist; runtime wiring "Partial" per feature spec (FR-10)                                                                                                               |
| **Surface area**                  | ~20 core files + 12 vendor dirs, ≈ 3–4k LOC of agent-transfer-specific code                                                            | `@agent-platform/agent-transfer` package + 45 test files + Studio UI + runtime integration                                                                                                                         |

### 3.2 Runtime execution flow (side-by-side)

**Koreserver — Dialog Engine Path**

1. Dialog engine encounters `agentTransfer` node (`ServiceExecution.js:519`)
2. Invokes `AgentTransferExecutor.execute()` (line 587) — main dispatcher
3. Checks channel type (Genesys, Unblu, Zoom, Zendesk, generic) for channel-native handoff
4. Dynamically loads vendor executor via `AgentHandlerService.executeHandOff()`
5. BotKit SDK path: HTTP POST to SDK URI with JWT auth
6. Writes `agentTransferConfig` to Redis via `BotsSessionStore`; emits analytics record

**Koreserver — Callflow Engine Path**

1. Callflow hits `agenttransfer` step
2. `TaskDefinitionFactory.getTaskDefinition('agenttransfer')` creates `AgentTransferTaskDefinition`
3. `AgentTransferTask.start()` → `performAgentTransfer()` (line 113)
4. Sends message, calls `executeAgentTransfer()` (line 239), builds `agentTransferProps`
5. `getAgentTransferPromise(payload)` triggers `invokeParentBot()` pipeline
6. Waits for `agent_transfer_complete` event (routed via `Coordinator.agentTransferComplete()` line 2394)

**ABL — Unified Path**

1. LLM calls `transfer_to_agent` tool (compiled from `ESCALATE:` or exposed natively)
2. `TransferToolExecutor` routes the call and checks Redis sliding-window rate limit
3. `TransferToAgentTool.execute()` validates Zod input, looks up adapter in `AdapterRegistry`
4. Builds `TransferPayload` (conversation history, contact, metadata) and calls `adapter.execute(payload)`
5. Adapter creates session in `TransferSessionStore`, calls vendor API, returns `TransferResult`
6. Session enters state machine (`pending → queued → active → post_agent → ended`)
7. Bidirectional messaging: user messages forwarded via `adapter.sendUserMessage()`; agent messages arrive via vendor webhooks

### 3.3 Parity verdict — bot-to-human

- ✅ **ABL matches or exceeds Koreserver** on: typed config (Zod), session state machine, tracing discipline, tenant isolation, rate limiting, test coverage, dedicated package boundary, unified authoring path.
- ⚠️ **Vendor coverage gap**: 10 vendors missing (Salesforce, Genesys, ServiceNow, Zendesk, Unblu, Zoom, and others).
- ⚠️ **Missing feature**: LLM conversation summary at transfer time.
- ⚠️ **Partial wiring** (per ABL feature specs): `dispositionCode` / `wrapUpNotes` write path missing; project-persisted TTLs not enforced at session creation; CSAT/disposition runtime wiring incomplete; NFR-03 (1000 concurrent sessions) untested; `agent:exited` XO mapping TODO.
- ✅ **Authoring model simpler**: ABL's single LLM-driven path vs Koreserver's dual dialog+callflow duplication.

---

## 4. Part 2 — Multi-Agent Orchestration (AI → AI)

**No direct parity exists.** ABL has a genuine multi-agent handoff feature; Koreserver has only NLU-routed Universal Bots, which are orchestration-by-intent-classification rather than explicit transfer.

### 4.1 Capability comparison

| Capability                                   | ABL (`HANDOFF:` / `__handoff__`)                                                                                                    | Koreserver (Universal Bot)                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Routing decision**                         | LLM tool call with structured target argument                                                                                       | ML intent classifier endpoint `/ub/detectskill`                   |
| **Target selection**                         | Per-agent `coordination.handoffs[].to` allowlist, enforced at IR validation                                                         | Linked-bot array `configuredBots` on `BTStream`                   |
| **Context passing**                          | `context.pass` (typed fields with schemas), `summary`, `grant_memory`, `history` strategies (`none / full / summary_only / last_n`) | Intent + entity values forwarded to linked bot; no typed contract |
| **Cycle prevention**                         | `session.handoffStack` explicit cycle detection (A→B→A blocked)                                                                     | N/A — intent-based routing has no explicit call graph             |
| **Return semantics**                         | `return`, `on_return`, `HandoffReturnMapping` (structured result mapping from child keys to parent keys)                            | Linked bot completes or hands back via bot-level dialog flow      |
| **Synchronous delegation** (returns a value) | ✅ Separate `DELEGATE:` / `__delegate__` construct                                                                                  | ❌ Not a concept                                                  |
| **Remote / cross-process agents**            | ✅ `remote: true`, `async`, `asyncTimeout`, `SuspensionReason.remote_handoff`                                                       | ❌ Not supported                                                  |
| **Trace events**                             | `'handoff'`, `'agent_switch'`, `'handoff_condition_check'`, `'guardrail_handoff_blocked'`, `'handoff_progress'`                     | N/A                                                               |

### 4.2 ABL multi-agent execution flow

1. Compiler emits `__handoff__` tool with allowed targets (`packages/compiler/src/platform/ir/compiler.ts:888-908`)
2. LLM calls `__handoff__({ target: "AgentName" })`
3. `HandoffExecutor.validate()` runs 5 checks (`packages/compiler/src/platform/constructs/executors/handoff-executor.ts:67-139`):
   - Routing/handoff config exists on current agent
   - Self-handoff prevention (`currentThread.agentName === targetAgent`)
   - Cycle detection via `session.handoffStack`
   - Target exists in agent registry
   - Target is in IR-defined allowed targets (`coordination.handoffs[].to` + `routing.rules[].to`)
4. Push target onto `handoffStack`; resolve `context.pass` from session memory; apply `HistoryStrategy`; recursive `executeMessage` on child
5. On return, apply `on_return` mapping to parent session state

### 4.3 Known gaps in ABL multi-agent

- **No configurable max-depth guard** — only cycle detection. Deep non-cyclic chains (A→B→C→D→…) are unbounded.
- **`HandoffExecutor` in strangler migration** — shadow-mode replacement for inline `RoutingExecutor.handleHandoff()`; migration incomplete per executor doc comment.

---

## 5. ABL File Reference

### 5.1 Multi-agent handoff (AI → AI)

| File                                                                             | Role                                                                                   |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts:1428-1446`                          | `HandoffConfig` IR type                                                                |
| `packages/compiler/src/platform/ir/schema.ts:1384`                               | `CoordinationConfig` (delegates[], handoffs[], escalation)                             |
| `packages/compiler/src/platform/ir/schema.ts:2180`                               | `RoutingRule`                                                                          |
| `packages/compiler/src/platform/ir/schema.ts:2309`                               | `AgentConnection` (type: 'handoff' \| 'delegate')                                      |
| `packages/compiler/src/platform/ir/compiler.ts:888-908`                          | `__handoff__` tool emission                                                            |
| `packages/compiler/src/platform/constants.ts:56`                                 | `SYSTEM_TOOL_HANDOFF = '__handoff__'`                                                  |
| `packages/compiler/src/platform/constructs/executors/handoff-executor.ts:67-139` | `HandoffExecutor.validate()` 5-check pipeline                                          |
| `packages/core/src/types/agent-based.ts:980-991`                                 | Parser source type for HANDOFF: block                                                  |
| `packages/core/src/parser/agent-based-parser.ts`                                 | DSL parser for `HANDOFF:`                                                              |
| `packages/execution/src/types.ts:103,117,123`                                    | `SuspensionReason.remote_handoff`, `human_agent_transfer`; `ResumeData.handoff_result` |
| `packages/execution/src/suspension.ts:105`                                       | `SuspensionPoint.remote_handoff_result`                                                |

### 5.2 Bot → Human transfer

| File                                                                                     | Role                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------- |
| `packages/agent-transfer/src/types.ts:19-38`                                             | `TransferPayload` type                   |
| `packages/agent-transfer/src/session/types.ts:23-49`                                     | `TransferSessionData` + state machine    |
| `packages/agent-transfer/src/config/schema.ts:107-132`                                   | `AgentTransferConfigSchema` (Zod)        |
| `packages/agent-transfer/src/tools/transfer-to-agent.ts:69-188`                          | `TransferToAgentTool.execute()`          |
| `packages/agent-transfer/src/observability/trace-events.ts`                              | `TransferTraceEvent` discriminated union |
| `packages/agent-transfer/src/observability/metrics.ts:58`                                | OTel counter `agent_transfer.events`     |
| `packages/database/src/models/project-settings.model.ts:52,71`                           | `ProjectSettings.agentTransfer` field    |
| `packages/database/src/models/session.model.ts:111,273`                                  | Session `handoffCount`                   |
| `apps/runtime/src/services/execution/transfer-tool-executor.ts:63`                       | Rate-limited routing                     |
| `apps/studio/src/components/settings/AgentTransferSettingsPage.tsx`                      | Settings UI                              |
| `apps/studio/src/hooks/useAgentTransferSettings.ts`                                      | SWR data hook (TTL s ↔ min conversion)   |
| `apps/studio/src/api/agent-transfer.ts`                                                  | Studio API client                        |
| `apps/studio/src/app/api/projects/[id]/agent-transfer/sessions/route.ts`                 | List sessions proxy                      |
| `apps/studio/src/app/api/projects/[id]/agent-transfer/sessions/[sessionId]/end/route.ts` | End session proxy                        |

### 5.3 Tests

| File                                                                           | Role                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `packages/agent-transfer/src/__tests__/unit/`                                  | 30+ unit tests (tenant isolation, rate limiter, CSAT, trace events, SSRF guard, session store) |
| `packages/agent-transfer/src/__tests__/integration/kore-transfer-flow.test.ts` | Integration                                                                                    |
| `packages/agent-transfer/src/__tests__/integration/session-lifecycle.test.ts`  | Integration                                                                                    |
| `packages/agent-transfer/src/__tests__/integration/voice-transfer.test.ts`     | Voice                                                                                          |
| `packages/agent-transfer/src/__tests__/integration/backward-compat.test.ts`    | Back-compat                                                                                    |
| `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`                   | E2E                                                                                            |
| `packages/compiler/src/__tests__/handoff-expect-return.test.ts`                | Handoff return                                                                                 |
| `packages/compiler/src/__tests__/validate-cross-agent.test.ts`                 | Cross-agent validation                                                                         |
| `packages/compiler/src/__tests__/e2e/supervisor-composition.test.ts`           | Supervisor E2E                                                                                 |
| `packages/compiler/src/__tests__/remote-agent-coordination.test.ts`            | Remote coordination                                                                            |
| `apps/runtime/src/__tests__/transfer-tool-executor.test.ts`                    | Runtime                                                                                        |
| `apps/studio/src/__tests__/agent-transfer-ui.test.ts`                          | UI                                                                                             |
| `examples/banknexus/agents/BankNexus_Supervisor.agent.abl`                     | Fixture with multi-target HANDOFF: block                                                       |

---

## 6. Koreserver File Reference

| File                                                                             | Role                                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Templates/services/agent_transfer.js`                                           | Session lifecycle: init, start, clear, update, check; `SmartAssistInitAgentTransfer` |
| `api/services/DialogExecutionService/lib/NodeExecutors/AgentTransferExecutor.js` | Dialog engine executor (vendor dispatch, conversation summary)                       |
| `api/services/DialogExecutionService/lib/ServiceExecution.js:519`                | Dialog engine — recognizes `agentTransfer` node type                                 |
| `callflows/engine/lib/callflow/tasks/AgentTransferTask.js:113,239`               | Callflow step execution (`performAgentTransfer`, `executeAgentTransfer`)             |
| `callflows/engine/lib/callflow/tasks/AgentTransferTaskDefinition.js`             | Callflow step schema                                                                 |
| `callflows/engine/lib/callflow/tasks/TaskDefinitionFactory.js`                   | `'agenttransfer' → AgentTransferTaskDefinition`                                      |
| `callflows/engine/lib/runtime/Coordinator.js:2394`                               | Routes `agent_transfer_complete` event                                               |
| `api/services/AgentExecutor/AgentHandlerService.js`                              | Dynamic vendor executor loader                                                       |
| `api/services/AgentExecutor/lib/BaseAgentExecutor.js`                            | Base class for vendor integrations                                                   |
| `api/services/AgentExecutor/lib/` (12 vendor dirs)                               | Per-vendor executors                                                                 |
| `db/dbModels/CFStepDefinition.js:788-862,1003`                                   | Callflow agent-transfer step schema + type enum                                      |
| `db/dbModels/botAnalytics.js:31`                                                 | Analytics `type: "agentTransfer"`                                                    |
| `models/DialogComponentModel.js:87`                                              | Dialog node type `agentTransfer`                                                     |
| `models/BTStreamModel.js`                                                        | `configuredBots`, `sdkSubscription.subscribedFor: 'onAgentTransfer'`                 |
| `config/configs/agentExecutor.json`                                              | Agent executor configuration                                                         |
| `config/configs/dialogAndComps.json:480`                                         | Default `agentTransfer` node template                                                |

---

## 7. Gap Register & Action Items

The following gaps must close to reach functional parity with Koreserver's customer-facing surface for bot-to-human transfer.

| #   | Gap                                                                                         | Severity | Current State                                                              | Action                                                                                                           |
| --- | ------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | **Vendor adapter coverage** — Salesforce, Genesys, ServiceNow, Zendesk, Unblu, Zoom missing | HIGH     | 2 of 12 shipped (Kore, Five9)                                              | Per-vendor adapter implementation using existing `AdapterRegistry` pattern                                       |
| 2   | **LLM conversation summary** at transfer time                                               | MEDIUM   | Not implemented                                                            | Add summary step in `TransferToAgentTool.execute()` before payload build; reuse existing summarization utilities |
| 3   | **Disposition write path** (`dispositionCode`, `wrapUpNotes`)                               | HIGH     | Schema fields exist; runtime write path missing                            | Wire disposition capture before session cleanup; tracked in Session Timeout & Disposition Unification            |
| 4   | **Project-persisted TTLs** enforced at session creation                                     | MEDIUM   | Defaults/env only                                                          | Read from `ProjectSettings.agentTransfer` on session init                                                        |
| 5   | **CSAT / disposition runtime wiring**                                                       | HIGH     | `CsatHandler`, `DispositionHandler` classes exist; E2E "Partial" per FR-10 | Complete E2E integration and tests                                                                               |
| 6   | **NFR-03 load test** — 1000 concurrent sessions                                             | MEDIUM   | Untested                                                                   | Add load test scenario to `agent-transfer` E2E suite                                                             |
| 7   | **`agent:exited` XO mapping**                                                               | LOW      | TODO in `types.ts:85`                                                      | Wire when SmartAssist exposes `agent_exited` event                                                               |
| 8   | **Multi-agent max-depth guard** (AI→AI)                                                     | LOW      | Cycle detection only                                                       | Add configurable `maxDepth` to `HandoffExecutor`                                                                 |
| 9   | **`HandoffExecutor` strangler migration**                                                   | LOW      | Shadow mode                                                                | Complete migration from inline `RoutingExecutor.handleHandoff()`                                                 |

---

## 8. Glossary

| Term                                   | Definition                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Agent Transfer (ABL, bot-to-human)** | `transfer_to_agent` tool / `ESCALATE:` DSL → hands conversation to contact center human agent                                     |
| **Agent Transfer (Koreserver)**        | Dialog node or callflow step that hands conversation to a human agent via vendor integration                                      |
| **HANDOFF (ABL)**                      | DSL keyword + `__handoff__` system tool for AI-to-AI agent routing with typed context passing                                     |
| **DELEGATE (ABL)**                     | DSL keyword + `__delegate__` system tool for synchronous sub-agent calls that return a structured value                           |
| **Universal Bot (Koreserver)**         | Orchestrator bot that routes user messages to one of several linked bots via NLU intent classification — NOT a transfer mechanism |
| **BotKit SDK (Koreserver)**            | Vendor SDK webhook path for agent-transfer callbacks                                                                              |
| **AgentAI (Koreserver)**               | Real-time assistance product for human agents — unrelated to agent transfer                                                       |
| **KoreXO / SmartAssist**               | Kore's contact-center / agent-desktop surface                                                                                     |
| **Adapter (ABL)**                      | Vendor-specific implementation of `TransferAdapter` interface; registered in `AdapterRegistry`                                    |
| **Handoff Stack (ABL)**                | Session-level stack of active agent contexts; used for cycle detection and return routing                                         |
| **Transfer Session (ABL)**             | Redis-backed state machine record (`pending → queued → active → post_agent → ended`)                                              |

---

## Appendix A — Why ABL's multi-agent handoff has no Koreserver precedent

Koreserver's Universal Bot design predates the era of LLM tool-calling. Its orchestration model is:

1. User message arrives at Universal Bot
2. Universal Bot runs an ML intent classifier over all configured linked bots' intent catalogs
3. Highest-scoring linked bot "wins"; message is forwarded
4. Conversation continues in the linked bot until it ends; control may return to the Universal Bot for the next user message

There is no explicit "transfer" call, no typed context contract, no cycle detection, no return mapping, no remote/async variants. It is intent-classification-driven routing, not call-graph orchestration.

ABL's `HANDOFF:` / `DELEGATE:` model is closer in spirit to OpenAI's Swarm / Anthropic's agent-to-agent handoff patterns than to anything in Koreserver. Positioning this as a "parity" feature understates the advance; it should be positioned as a net-new platform capability.

---

## Appendix B — Koreserver Callflow ↔ Contact Center Data Flow

This appendix captures wire-level detail of how data moves between Koreserver's callflow/dialog engine and third-party contact centers, and how the agent's reply is delivered back to the end user. Understanding this flow is a prerequisite for designing the ABL equivalent.

### B.1 Outbound — Koreserver → Contact Center

#### B.1.1 Trigger paths (two, non-unified)

| Path                     | Entry                                                                                                         | Location                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **SmartAssist/Callflow** | `AgentTransferTask.performAgentTransfer()` → `executeAgentTransfer()` → `getAgentTransferPromise()` → RMQ job | `callflows/engine/lib/callflow/tasks/AgentTransferTask.js:113,173,340`                       |
| **Dialog engine**        | `AgentTransferExecutor.execute()` dispatches by `deliveryChannel.channelInfos.type`                           | `api/services/DialogExecutionService/lib/NodeExecutors/AgentTransferExecutor.js:587,650-776` |

The callflow path enqueues an RMQ job that is consumed by `SmartAssistInitAgentTransfer()` in `Templates/services/agent_transfer.js:364`, which calls `serviceInst.executeSmartAssistNodeForJob()`. That eventually joins the dialog engine's dispatch chain.

The dialog dispatcher selects a transport per channel type:

- `"genesys"` → Redis pub/sub back to the Genesys channel listener
- `"unblu"`, `"zendesk"`, `"zoom"` → direct calls to respective executors
- Generic channels from `config.channels.genericChannels` → `handoffToAgent(deliveryChannel)`
- Fallback → resolves `agentDetails` from `SmartAssistBotSettings` / `BTAgentIntegration`, calls `AgentHandlerService.executeHandOff()` (`api/services/AgentExecutor/AgentHandlerService.js:49`) which dynamically loads the vendor executor

#### B.1.2 Payload assembly — `addConversationAndSessionDetails()`

`AgentTransferExecutor.js:194-319` builds `metaInfoToAgent`:

```js
var metaInfoToAgent = {
  userId: userId,
  callId: '',
  sessionStartTime: '',
  agentHandOffTime: '',
  userDetails: {}, // firstName, lastName from User model
  currentTask: '', // last dialog task name
  sentimentAnalysis: {}, // messageTone + dialogTone from ConversationContext
  conversationDetails: [], // per-channel array of conversationFlow
};
```

`addConversationDetailsFromSession()` (`AgentTransferExecutor.js:86-192`) populates each channel's `conversationInfo`:

| Field                                        | Source                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sessionTags`, `userTags`                    | MetaTags model                                                                             |
| `identifiedIntents`, `unidentifiedIntents`   | BotAnalytics (`successintent` / `failintent`)                                              |
| `completedTasks`, `failedTasks`              | BotAnalytics (`success` / `failtask`)                                                      |
| `sentimentAnalysis.messageTone / dialogTone` | `agentTransfer` analytics metadata or ConversationContext Redis (`CC:<userId>:<streamId>`) |
| `currentTask`                                | `lastIntentName` from analytics, fallback `DialogTask.lname`                               |
| `conversationFlow[]`                         | Array of `{ status, userInput, taskName, messageStoreId, failureDetails }`                 |

#### B.1.3 LLM conversation summary

When `config.AgentTransfer.conversationSummaryFeatureFlag.enabled` AND the node's `conversationSummary.enabled` flag is set:

1. `getConversationSummaryAgentTransfer()` (`AgentTransferExecutor.js:509`) fetches transcript from MessageStore
2. `prepareConversationTranscript()` (line 482) formats as plain text: `"USER:<text> BOT:<text>"`
3. Calls `PublicService.callSummaryConversation()` → KoreXO GPT integration
4. Result placed in `metaInfoToAgent.conversationSummaryForAgentTransfer`

#### B.1.4 Initial message assembly (concatenated plain text)

`BaseAgentExecutor.initialMessageToAgent()` (`api/services/AgentExecutor/lib/BaseAgentExecutor.js:31-37`):

```js
msg = 'INITIAL_AGENT_MESSAGE' + metaInfo.chatHistoryUrl;
if (metaInfo.conversationSummaryForAgentTransfer) {
  msg += '\n' + 'CONVERSATION_SUMMARY_FOR_AGENT_TRANSFER' + conversationSummaryForAgentTransfer;
}
```

Chat history URL is a shortened URL encoding `{ streamId, userId, sessionId, channelType, isAgentTransfer: true, forChatHistory: true }` (lines 910-917). This is a plain text blob — **not** a structured field — which means the agent desktop has to parse it.

#### B.1.5 PII handling

`PIICheckForAgentTranfer()` (`AgentTransferExecutor.js:402`) reads `btStream.sdkSubscription.PIIMaskingDisabledForAgentTransfer`:

- `true` → PII tokens (`#*#<token>#*#`) are **de-tokenized** (unmasked) before sending to the agent
- `false` → tokens pass through masked

`resolveFormDataAndDetokenizeSecureFormData()` (line 459) applies the same to form data.

#### B.1.6 Custom flow data / custom variables

| Field                 | Source                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `customFlowData`      | `this.cf.getCFContext()?.getCustomFlowData()` (`AgentTransferTask.js:319`)                                                                  |
| `customMetaInfo`      | `context.session.BotUserSession._metaInfo` (line 921)                                                                                       |
| `agentTransferConfig` | Contains `skillIds`, `queue`, `overrideAgents`, `overrideValues`, `automationBotId`, `lastIntentName`, `dialog_tone`, `waitingExperienceId` |

#### B.1.7 Wire protocol

Per-vendor. No universal contract. Most use **HTTP REST** via `RequestAgent.request()`. Authentication varies:

| Vendor                | Transport                   | Auth                                              |
| --------------------- | --------------------------- | ------------------------------------------------- |
| Genesys WebChat       | HTTP POST → WebSocket       | Guest API, unauthenticated                        |
| Genesys Web Messaging | WebSocket (no HTTP prelude) | `token` in `configureSession` action              |
| Salesforce            | HTTP + long polling         | `X-LIVEAGENT-AFFINITY`, `X-LIVEAGENT-SESSION-KEY` |
| ServiceNow            | HTTP REST                   | OAuth bearer token                                |
| Zendesk               | HTTP REST + webhook         | API token                                         |
| Unblu                 | HTTP REST                   | API key                                           |

#### B.1.8 Response handling

`AgentHandlerService.executeHandOff()` awaits vendor executor. On success: `publishAgentTransferStatusToCallflow(sessionId, 'success')` sends RMQ job with `transferStatus.status = "transferred"`. On failure: `publishAgentTransferStatusToCallflow(sessionId, 'failed', error)` from the catch in `SmartAssistInitAgentTransfer()` (`agent_transfer.js:508`).

---

### B.2 Inbound — Contact Center → Koreserver

#### B.2.1 Transport — varies per vendor

| Vendor                    | Transport                                                                | Koreserver side                                                                                        |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Genesys WebChat**       | Persistent WebSocket to `session.eventStreamUri`                         | `GenesysService.webSocketHandle` (`api/services/AgentExecutor/lib/genesysAgent/GenesysService.js:139`) |
| **Genesys Web Messaging** | WebSocket + Redis pub/sub channel `webMessageApiGenesysAgentUserMessage` | `GenesysWebMessageService.js:175,242`                                                                  |
| **Salesforce**            | Long polling via recurring KoreQ job `poll_salesforce`                   | `salesforceAgent/index.js:192,359` — GET `/System/Messages` with session headers                       |
| **Kore Agent**            | Redis pub/sub + REST callbacks                                           | `KoreAgentService`                                                                                     |
| **BotKit SDK**            | HTTP POST callbacks to SDK-defined URL                                   | JWT-signed                                                                                             |

#### B.2.2 Event types handled

**Genesys WebChat** (`GenesysService.js:139`):

- `metadata.type == 'message'` + `sender.id != memberId` → **agent message** → `sendAgentReplyToBot(callId, { message: body }, false, opts)` (line 208)
- `bodyType == 'member-leave'` first occurrence → **agent joined** → sends `agentConnectedMessage`
- `member.state == 'DISCONNECTED'` → **session ended** → sends `{ eventType: "CLOSE", message: agentSessionEndMessage }`, cleans Redis, closes WS

**Genesys Web Messaging** (`GenesysWebMessageService.js:271-424`):

```js
// Line 284 -- agent text
if (body.type === 'Text' && direction === 'Outbound' && !Array.isArray(body.content)) {
  return sendAgentReplyToBot(callId, { message: body.text }, false, opts);
}
// Line 292 -- agent disconnect
else if (
  body.type === 'Event' &&
  events[0].eventType === 'Presence' &&
  events[0].presence.type === 'Disconnect'
) {
  body.eventType = 'CLOSE';
  body.message = agentSessionEndMessage;
  ws.close();
  await cleanupAgentSession(sessionObject);
  return sendAgentReplyToBot(callId, body, false, opts);
}
```

Additional events: `PresignedUrlResponse` (file upload, line 302), `UploadSuccessEvent` (line 353), `StructuredMessage` with content array (agent attachment, line 373), `SessionResponse.readOnly = true` (session read-only, line 390).

**Salesforce** (`salesforceAgent/index.js:192`):

- `ChatEstablished` → agent joined (records `chasitorIdleTimeout`)
- `ChatMessage` → agent text → `sendAgentReplyToBot`
- `ChatEnded` → session end + closure
- `ChatRequestFail` → no agent available → fallback message + closure

#### B.2.3 Correlation — vendor session ID → Koreserver callId

| Vendor                | Lookup                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Genesys WebChat       | `conversation.id` → `redislib.getAgentCallIdSync("genesys:" + conversationId)` → `sessionObject { userId, botId, callId }` |
| Genesys Web Messaging | `sessionData.tokenId` (format `<streamId>_<userId>_<uuid>`) → `redislib.getAgentCallIdSync("genesys:" + tokenId)`          |
| Salesforce            | `data.userId` carried by polling job directly                                                                              |

The universal `opts` passed to `sendAgentReplyToBot` includes `key: "agent:<userId>"` mapping to a Redis hash storing `callId` (original dialog execution call ID).

#### B.2.4 Error / disconnect handling

- **WebSocket `onerror`** (`GenesysWebMessageService.js:428`) → `cleanupAgentSession()` deletes all Redis keys (`genesys:<tokenId>`, hset key, WS connection object)
- **Salesforce catch** (line 310) → `updateErrorCount(userId)`; after threshold → `clearLongPollingAgent`

---

### B.3 Resolution — Agent Message → End User

#### B.3.1 Channel lookup

`sendAgentReplyToBot()` (`ServiceExecution.js:2499`):

1. Redis GET `"agent:<userId>"` → `{ callId }`
2. Redis GET `callId` → full call-ID data: `channel`, `streamId`, `universalBotId`
3. `agentService.checkForAgentSession()` verifies still active
4. For Genesys + SDK subscription → `'route_response_to_sdk'` job (line 2841)
5. Otherwise → `botsQ.startJobFlow('process_response', data)` (line 2843)
6. `process_response` enters the **same pipeline as bot messages** — the channel handler (WebSDK / WhatsApp / Voice / Teams / Audiocodes) delivers to the user

#### B.3.2 Channel translation for rich content

Agent attachments detected via `body.isAgentAttachment` (line 2603) → `channelHandler.prepareAttachment(body.attachmentInfo)` produces `overrideMessagePayload`. Each channel handler owns its own translation (card → text fallback for SMS, media URL pass-through for WhatsApp, etc.).

#### B.3.3 Message type / store code

Agent transfer initiation recorded in MessageStore with `ms: 5` (`agent_transfer.js:786`). Subsequent agent replies flow through standard `process_response` — stored alongside bot messages with no distinct message-type code.

#### B.3.4 System messages

| Event                | Source                                                           | Behaviour                                                |
| -------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| "Agent connected"    | `config.genesys_live_agent.agentConnectedMessage`                | Sent via `sendAgentReplyToBot`                           |
| Typing / stop-typing | `eventUtils.sendCustomWebSocketEvent("events", ...)` (line 2830) | Only for RTM channels when `data.agent_transfer == true` |
| "Agent session end"  | `agentSessionEndMessage` from config                             | Delivered as final agent message                         |

#### B.3.5 State machine (Redis keys during active phase)

| Key                                                           | Purpose                                                                       | TTL                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `AgentTransfer:<base64(botId+userId+channel)>`                | Session existence flag                                                        | `config.AgentTransfer.defaultTimeout`, refreshed via `update_agent_expire` on each agent message |
| `agent:<userId>`                                              | Maps to `callId` for routing                                                  | —                                                                                                |
| `<agentName>:<conversationId\|tokenId>`                       | Vendor session data (memberId, JWT, webSocketUrl)                             | —                                                                                                |
| `<agentName>` hash                                            | Maps `<hostname>_<conversationId>` to session data (server failover recovery) | —                                                                                                |
| `CF:AGENT_TRANSFER:<sessionId>:<streamId>:<userId>:<channel>` | Callflow coordination flag                                                    | —                                                                                                |
| `ATCF:<sessionId>:<streamId>:<userId>:<channel>`              | Set when `executionType === 'dialog'`                                         | —                                                                                                |
| `<userId>#<streamId>`                                         | Kore agent session key                                                        | —                                                                                                |

---

### B.4 Post-Agent Phase

#### B.4.1 Disconnect detection — three paths

1. **WebSocket event** — Genesys `member-change/state: DISCONNECTED` (WebChat) or `Presence.Disconnect` (WebMessaging)
2. **Polling response** — Salesforce `ChatEnded` event
3. **Explicit API** — Kore agent or BotKit sends `eventType: "CLOSE"` via `sendAgentReplyToBot`

All converge on `clearAgentSession()` (`Templates/services/agent_transfer.js:867`).

#### B.4.2 `clearAgentSession()` sequence (line 867)

1. Delete `AgentTransfer:<hash>` from Redis
2. Send `data.onAgentSessionClose = true` to `ChatScriptClientService.sendMessage(data)` (notifies bot framework)
3. Update analytics record → `isActive: 0`
4. Fire `Agent_Session_End` WebSocket event for RTM channels
5. **Post-agent dialog trigger** (lines 917-960): if `config.callflow.enablePostAgentConversationDialog` enabled AND `POST_AGENT_DIALOG:<sessionId>:...` Redis key exists with `triggerDialog: true` → fire `agent_transfer_complete` event to callflow with `isAgentSessionClosed: true`
6. Clean up Redis: `<userId>#<streamId>`, `CSAT#...`, `ATCF:...`, `CF:AGENT_TRANSFER:...`

#### B.4.3 Post-agent dialog decision

`AgentTransferTask.agentTransferCompleted()` (`AgentTransferTask.js:516`) receives the event:

- If `postAgentConversation.action === 'triggerDialog'` AND integration type is in `config.callflow.supportedPostAgentIntegrations` → invoke configured dialog via `invokeParentBot(payload)` with `isPostAgentDialog: true`
- User messages during this phase → `handleUserRequest()` (line 371)
- Dialog completion → `handleAsyncSuccessFailureResponse()` (line 424) — either re-invokes transfer (if dialog triggered another) or completes with `postAgentDialogCompleted: true`
- No post-agent dialog → step completes with `transferStatus: 'transferred'`

#### B.4.4 Preserved context

| What                              | Where                     | TTL                                                   |
| --------------------------------- | ------------------------- | ----------------------------------------------------- |
| Transcript, disposition, duration | BotAnalytics records      | persistent                                            |
| `customFlowData`                  | `BotUserSession` Redis    | 1800s (set during `SmartAssistInitAgentTransfer:407`) |
| Step results                      | `CFContext.context.steps` | session lifetime                                      |

---

### B.5 Worked Example — Genesys

Genesys has the most surface area in Koreserver: **1,136 lines across 4 files**.

| File                                                                      | LOC | Role                      |
| ------------------------------------------------------------------------- | --- | ------------------------- |
| `api/services/AgentExecutor/lib/genesysAgent/index.js`                    | 335 | Executor                  |
| `api/services/AgentExecutor/lib/genesysAgent/GenesysService.js`           | 324 | WebChat API service       |
| `api/services/AgentExecutor/lib/genesysAgent/GenesysWebMessageService.js` | 450 | Web Messaging API service |

#### B.5.1 Outbound request — WebChat API

`initChat()` (`index.js:33-88`):

```js
// POST to Genesys Guest API - no auth required
var url = liveAgentUrl + '/api/v2/webchat/guest/conversations';
var body = {
  organizationId: agentInfo.organizationId,
  deploymentId: agentInfo.deploymentId,
  routingTarget: {
    targetType: 'QUEUE',
    targetAddress: agentInfo.queueName,
  },
  memberInfo: {
    displayName: 'Web User',
    customFields: { firstName: 'Web', lastName: 'User' },
  },
};
// memberInfo overridden from BotUserSession._metaInfo.memberInfo if present
```

Response: `{ id, member: { id }, eventStreamUri, jwt }`. Stored in three Redis keys (lines 278-280); WebSocket opened to `eventStreamUri`.

#### B.5.2 Outbound request — Web Messaging API

No HTTP prelude. Opens WebSocket directly to `agentInfo.webSocketURL + "?deploymentId=" + deploymentId`, sends `configureSession`:

```js
// GenesysWebMessageService.js:70-83
ws.send(
  JSON.stringify({
    action: 'configureSession',
    deploymentId: sessionData.deploymentId,
    token: sessionData.tokenId,
  }),
);
```

Then initial user message:

```js
// Line 51-68
{
    "action": "onMessage",
    "token": sessionData.tokenId,
    "message": { "type": "Text", "text": message }
    // Optional: message.channel.metadata.customAttributes from GenesysMetaData
}
```

#### B.5.3 Resolution path — agent text back to user

`sendAgentReplyToBot(callId, body, false, { key: "agent:<userId>", agent: "genesys" })` in `ServiceExecution.js:2499`:

1. Redis lookup `"agent:<userId>"` → `{ callId }`
2. Redis lookup `callId` → full call-ID data with `channel`, `streamId`, `userId`
3. `agentService.checkForAgentSession()` — confirms still active
4. Genesys + SDK subscription → enqueue `route_response_to_sdk` job (line 2840)
5. Otherwise → enqueue `process_response` job — standard bot response pipeline
6. Channel handler delivers to user through the same adapter used for bot messages
7. `update_agent_expire` refreshes `AgentTransfer:<hash>` TTL

---

## Appendix C — ABL Equivalents Required for Parity

To replicate Koreserver's callflow ↔ contact-center surface in ABL, these capabilities are required. Reference these when designing the ABL flow runtime (Option B from the "callflow experience" discussion).

### C.1 Outbound payload assembly

| Koreserver behaviour                                                            | ABL equivalent needed                                                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `addConversationAndSessionDetails()` — collects sentiment, intents, tasks, tags | A `TransferPayloadEnricher` in `@agent-platform/agent-transfer` that pulls from trace events, session memory, and analytics |
| Conversation summary via KoreXO GPT                                             | LLM summarization step (gap #2 in §7); use existing ABL summarization utilities                                             |
| PII de-tokenization flag per bot                                                | Already supported in Zod config — need runtime wire-through                                                                 |
| Custom flow data pass-through                                                   | Session memory → payload metadata mapping in adapter builder                                                                |
| Initial message as concatenated plain text                                      | ABL should send **structured fields** instead; adapter translates if vendor requires plain text                             |

### C.2 Transport & correlation

| Koreserver                                                          | ABL equivalent                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Per-vendor WS / polling / pub-sub                                   | Adapter interface must support: `initiate()`, `sendUserMessage()`, `onAgentMessage()`, `onDisconnect()` (already present) |
| Redis `AgentTransfer:<hash>`, `agent:<userId>`, vendor session keys | `TransferSessionStore` (already present); add vendor-specific session-ID ↔ `callId` mapping                               |
| `sendAgentReplyToBot` universal entry                               | Webhook `POST /api/v1/agent-transfer/webhooks/:provider` (already present); needs per-vendor event parser                 |
| Long-polling via KoreQ job                                          | Adapter-level polling scheduler for vendors without push                                                                  |

### C.3 Resolution to user

| Koreserver                                                       | ABL equivalent                                                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `process_response` pipeline reuses bot message path              | ABL should route agent messages through the **same channel adapter** as agent responses — no separate agent-message path |
| Typing indicators as custom WS events for RTM only               | ABL needs channel capability flags: which channels support typing, attachments, cards                                    |
| `ms: 5` message type for transfer initiation                     | ABL trace event + conversation-history entry with `role: 'system'` variant                                               |
| Agent attachment handling via `channelHandler.prepareAttachment` | Extend ABL channel adapters with `prepareAgentAttachment()` hook                                                         |

### C.4 Post-agent phase

| Koreserver                                                       | ABL equivalent                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `clearAgentSession()` multi-step cleanup                         | `TransferSessionStore.end()` must mirror: status, traces, disposition write, post-agent routing         |
| `POST_AGENT_DIALOG:...` Redis flag + config-gated dialog trigger | `postAgentAction: 'return' \| 'end' \| 'invoke_flow'` — add `invoke_flow` to resume a specific ABL flow |
| `supportedPostAgentIntegrations` allowlist                       | Adapter capability flag `supportsPostAgentFlow: boolean`                                                |
| `customFlowData` preserved across phases                         | Session memory TTL guarantees (already present)                                                         |

### C.5 Required new work (summary)

1. **`TransferPayloadEnricher`** — pulls trace/memory/analytics into structured payload (parity with `addConversationAndSessionDetails`)
2. **LLM summary step** — gap #2; wire existing summarization utility into `TransferToAgentTool.execute()`
3. **Adapter capability flags** — `supportsTyping`, `supportsAttachments`, `supportsPostAgentFlow`, `transport: 'websocket' \| 'polling' \| 'webhook'`
4. **Channel adapter `prepareAgentAttachment()` hook** — per-channel translation of vendor attachment payloads
5. **`postAgentAction: 'invoke_flow'`** — third option alongside `return` / `end`; resumes a specific ABL flow after agent disconnect
6. **Per-vendor adapter implementations** — Salesforce, Genesys, ServiceNow, Zendesk, Unblu, Zoom (gap #1)
7. **Vendor event-parser mini-framework** — unified dispatcher for inbound webhooks, WS events, and polling results that emits `TransferEvent` discriminated union

### C.6 What ABL does _not_ need to replicate

- **Dual dialog+callflow duplication** — ABL has a single LLM-driven path; keep it
- **Plain-text concatenated initial message** — ABL should send structured fields to vendors that accept them; concat only as adapter-level fallback
- **Redis key sprawl** (`AgentTransfer:`, `CF:AGENT_TRANSFER:`, `ATCF:`, `POST_AGENT_DIALOG:`, `<userId>#<streamId>`) — ABL's single `TransferSessionStore` with typed state machine is superior; keep it
- **RMQ-job indirection** for status publishing — ABL's synchronous trace events are more observable; keep that model

---

## Appendix D — Bringing Callflow Experience to ABL (design direction)

> **Status**: Design proposal — open for review. Not yet ratified by HLD. Intended as input for a future `/hld` run.
> **Assumption**: Green-field redesign — **no** requirement to import Koreserver callflow JSON exports. Free to design for the LLM-first era.

### D.1 Problem framing

Koreserver's callflow engine exists because a class of conversation logic is **inherently deterministic and latency-sensitive**:

- IVR menus and digit collection in voice
- Structured slot filling ("Please say your account number")
- Branching on vendor / channel / tenant rules
- Routing to queues based on business hours
- Post-agent dispositions and wrap-up flows

These paths do not benefit from LLM reasoning — they benefit from **predictability, sub-100ms response, deterministic branching, and visual authorability**. LLM-driven agents are the right tool for open-ended conversations; they are the wrong tool for "press 1 for sales".

ABL today has agents + tools + HANDOFF/DELEGATE/ESCALATE. It does not have a deterministic flow construct. Closing that gap is what "bringing callflow to ABL" means.

### D.2 Three options considered

| Option                                                | Description                                                                                                | Tradeoff                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **A — Visual layer over existing ABL**                | Studio graph UI that renders existing HANDOFF/DELEGATE/ESCALATE as nodes, round-trips to ABL text          | Zero engine work; wins chat builders; **does not solve voice/IVR** (LLM latency + non-determinism are wrong for voice) |
| **B — First-class `FLOW:` construct** _(recommended)_ | New ABL DSL block + deterministic state-machine executor; agents can invoke flows, flows can invoke agents | Full callflow parity; voice IVR works; ~6–12 weeks; significant new surface (IR, executor, tracing, Studio)            |
| **C — Separate voice orchestrator**                   | Keep ABL pure; build a separate voice/flow service that calls ABL agents for LLM portions                  | Faster than B; two runtimes; state/trace span two systems; harder customer narrative                                   |

**Recommendation: Option B**, green-field. Koreserver's split between dialog engine and callflow engine was accidental historical accumulation — we should not replicate it. A single unified `FLOW:` + agent runtime with one tracing model is the right end state.

### D.3 Open decision — first-release shape

Both sub-shapes converge on the same end state; the order determines which customers v1 wins.

| Sub-shape              | v1 ships                                                                                                                                         | v2 adds           | Wins                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ---------------------------------------------------------------------------------- |
| **D.3.a Voice-first**  | Deterministic flow executor + voice primitives (`say`, `gather`, `menu`, `digit_input`, `sip_transfer`, `record`, `hangup`). DSL-only authoring. | Visual editor.    | Voice / IVR customers. Migration from Koreserver callflow for telephony use cases. |
| **D.3.b Visual-first** | Studio visual editor + minimal step vocabulary (`say`, `ask`, `branch`, `call_agent`, `transfer`).                                               | Voice primitives. | Chat builders. Low-code segment. Competitive with Voiceflow / Botpress builder UX. |

**Decision needed**: which sub-shape drives v1? The rest of this appendix assumes the vocabulary and architecture are the same regardless of order.

### D.4 Proposed `FLOW:` construct — design sketch

#### D.4.1 DSL grammar (illustrative)

```abl
FLOW: AccountLookup
  input:
    - name: account_id
      type: string
  output:
    - name: account_data
      type: object
  steps:
    - ask: "Please say your account ID."
      gather: digits
      min_length: 6
      max_length: 10
      retries: 3
      save_to: account_id
      on_no_input: goto: transfer_to_agent
      on_no_match: goto: transfer_to_agent

    - call_tool: lookup_account
      args:
        id: $account_id
      save_to: account_data
      on_error:
        goto: transfer_to_agent

    - branch:
        - when: $account_data.status == "active"
          goto: account_active
        - when: $account_data.status == "suspended"
          goto: account_suspended
        - default:
          goto: transfer_to_agent

    - label: account_active
      call_agent: BillingAssistant
      context:
        account: $account_data
      return: $result

    - label: transfer_to_agent
      escalate:
        queue: billing
        skills: [account-recovery]
```

#### D.4.2 Step vocabulary (minimal, extensible)

| Step           | Purpose                                                                 | Channel          |
| -------------- | ----------------------------------------------------------------------- | ---------------- |
| `say`          | Output text/SSML to user                                                | chat + voice     |
| `ask`          | Prompt + wait for input                                                 | chat + voice     |
| `gather`       | Collect typed input (digits, speech, text, choice)                      | voice-emphasized |
| `menu`         | Enumerated options with DTMF / speech / quick-replies                   | chat + voice     |
| `digit_input`  | Collect N-digit input with timeout                                      | voice            |
| `branch`       | Conditional routing by expression                                       | all              |
| `call_tool`    | Invoke a registered ABL tool                                            | all              |
| `call_agent`   | Hand to an LLM agent; agent returns a structured result                 | all              |
| `call_flow`    | Invoke a sub-flow                                                       | all              |
| `escalate`     | Hand to human agent (reuses existing `ESCALATE:` / `transfer_to_agent`) | all              |
| `record`       | Start/stop call recording                                               | voice            |
| `sip_transfer` | Bridge / refer the SIP leg                                              | voice            |
| `hangup`       | End call                                                                | voice            |
| `set` / `eval` | Assign / compute expression into flow memory                            | all              |
| `wait`         | Pause N ms (rate-limited, bounded)                                      | all              |

Explicitly **excluded** at v1 (add later only with evidence): HTTP client step, DB step, loops, try/catch. Keep v1 vocabulary small — push HTTP/DB into tools and agents where they already live.

#### D.4.3 Integration with existing ABL constructs

| From → To                     | Mechanism                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `FLOW:` calls an agent        | `call_agent` step — passes typed input, receives structured output; uses same execution context as HANDOFF returns |
| Agent calls a `FLOW:`         | Exposed as a synthetic tool `__flow__` on the agent (analogous to `__handoff__`); LLM tool-calls the flow          |
| `FLOW:` calls another `FLOW:` | `call_flow` step — synchronous sub-flow invocation with return value                                               |
| `FLOW:` escalates to human    | `escalate` step compiles to existing `transfer_to_agent` tool path; no new human-transfer code                     |
| Tracing                       | Flow steps emit `TraceEvent` kind `'flow_step'` with `{ flow_name, step_name, step_type, duration_ms, outcome }`   |

#### D.4.4 State / context model

- **Flow memory**: scoped to a flow invocation; declared via `input` / `output` / `local` blocks; typed
- **Session memory**: the existing ABL session memory; flows can read/write via explicit `session.*` references
- **Agent memory**: unchanged; flows cannot reach into agent internals
- **Flow stack**: `session.flowStack[]` — mirrors `handoffStack`; enables cycle detection and return routing
- **Return semantics**: `output` block declares what flow returns; caller receives a typed value

#### D.4.5 Compilation & runtime

- Parser adds `FLOW:` to `packages/core/src/parser/agent-based-parser.ts`
- Compiler emits `FlowIR` alongside `AgentIR` — shared IR envelope
- New executor `packages/compiler/src/platform/constructs/executors/flow-executor.ts`
- Flow state-machine is fully synchronous and deterministic — no LLM in the hot path unless a step explicitly calls one
- Voice-specific steps delegate to a **voice-gateway adapter** (same package boundary as `@agent-platform/agent-transfer` uses for vendor adapters)

#### D.4.6 Studio authoring surface

Two authoring modes, bidirectional:

1. **Text DSL** — the `.flow.abl` (or embedded `FLOW:` block within `.agent.abl`) is the source of truth
2. **Visual editor** — graph editor in Studio renders the flow; user can drag nodes, wire connections, edit per-step forms. Save → emits canonical DSL. Open DSL → re-renders graph.

The visual layer must never hold state the DSL cannot express. Round-tripping discipline prevents "it renders but it won't save" bugs.

#### D.4.7 Tracing / observability

- New `TraceEvent` kinds: `flow_started`, `flow_step_entered`, `flow_step_exited`, `flow_branch_taken`, `flow_completed`, `flow_failed`
- OTel span per flow invocation; child spans per step
- Flow + agent + transfer traces render in a **single unified timeline** in Observatory (not separate views)

### D.5 Conceptual mapping — Koreserver → ABL `FLOW:`

Even though this is green-field, the mapping is useful for customer-facing narrative.

| Koreserver concept                  | ABL `FLOW:` equivalent                                      |
| ----------------------------------- | ----------------------------------------------------------- |
| Callflow step `message`             | `say` step                                                  |
| Callflow step `userInput`           | `ask` + `gather`                                            |
| Callflow step `agentTransfer`       | `escalate` step                                             |
| Callflow step `botAction`           | `call_tool` / `call_flow`                                   |
| Callflow step `script`              | ❌ not supported — push logic into tools                    |
| Callflow step `webhook`             | `call_tool` (tool implements HTTP)                          |
| Callflow step `condition`           | `branch`                                                    |
| Callflow `CFContext.customFlowData` | flow `local` variables + session memory                     |
| Universal Bot intent routing        | LLM agent with `HANDOFF:`                                   |
| Post-agent dialog trigger           | `escalate` with `postAgentAction: invoke_flow` (gap C.5 #5) |

### D.6 Phased delivery plan

Assumes Option B + green-field. Phase boundaries are independent enough to ship value incrementally.

| Phase                                                           | Scope                                                                                                                             | Exit criteria                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **P0 — Design**                                                 | HLD (addresses 12 architectural concerns), LLD with phased implementation plan, feature spec, test spec                           | All 4 artefacts reviewed, `phase-auditor` + `lld-reviewer` findings resolved                          |
| **P1 — Core runtime**                                           | FlowIR types, parser, executor, minimal step vocabulary (`say`, `ask`, `branch`, `call_tool`, `call_agent`), flow memory, tracing | E2E test: a flow can drive a chat conversation end-to-end; calls an agent and receives a return value |
| **P2 — Voice primitives** _(if voice-first)_                    | `gather`, `menu`, `digit_input`, `sip_transfer`, `record`, `hangup`; voice gateway adapter interface                              | E2E test: IVR menu collects account ID via DTMF and routes to queue                                   |
| **P2 — Visual editor** _(if visual-first)_                      | Studio graph editor, round-trip to DSL, form-based step configuration                                                             | E2E test: builder creates a 5-step flow visually, it runs unchanged                                   |
| **P3 — The other P2**                                           | Whichever P2 shipped first gets the other                                                                                         | Both authoring + both step sets shipped                                                               |
| **P4 — `call_flow` + `escalate`**                               | Sub-flow invocation; `escalate` step wired into existing `transfer_to_agent` path with `postAgentAction: invoke_flow`             | E2E test: flow calls flow calls agent calls human, returns cleanly                                    |
| **P5 — Vendor adapter expansion**                               | Close gap #1 in §7 — Salesforce, Genesys, ServiceNow, Zendesk adapters                                                            | Parity checklist per vendor                                                                           |
| **P6 — Migration tooling** _(optional, only if demand appears)_ | One-shot converter for Koreserver callflow JSON → ABL `FLOW:` DSL                                                                 | Convertible test corpus passes round-trip                                                             |

### D.7 Non-goals (explicit)

- **Not** rebuilding Koreserver's callflow engine feature-for-feature. 40+ node types become ~12.
- **Not** supporting XO11/Koreserver callflow JSON import in v1. Green-field.
- **Not** replacing LLM agents — flows complement agents; each owns what it's best at.
- **Not** adding a new tracing system — reuse existing `TraceStore`.
- **Not** building a separate voice service (Option C). Single unified runtime.

### D.8 Open design questions

These need answers before HLD:

1. **Flow authoring file format**: standalone `.flow.abl` files, or `FLOW:` blocks embedded in `.agent.abl`? Mixed?
2. **Flow versioning**: same model as agents (immutable compiled artefact per version) or different?
3. **Flow testability**: do we need a "flow test" DSL analogous to agent tests, or is it covered by E2E?
4. **Barge-in / interruption semantics for voice**: at `say` / `ask` step level? Global config? Per-step override?
5. **Channel capability matrix**: how does the executor know which steps are valid on which channels? Static check at compile time, or runtime fallback?
6. **Parallelism**: is any concurrent execution (e.g., `parallel` step) worth having in v1? Recommend no — add only if a concrete use case demands it.
7. **Expression language**: reuse ABL's existing expression engine (likely CEL per `docs/reference/CEL_MIGRATION_GUIDE.md`), or simpler subset?

### D.9 Success criteria

v1 ships when:

- A builder can author a deterministic flow in DSL (and visual editor, if visual-first)
- The flow executes with <50ms per-step overhead (excluding step work itself)
- Flows can call agents and vice versa with typed, traceable boundaries
- All flow executions appear in Observatory timeline alongside agent and transfer traces
- At least one voice IVR reference example runs end-to-end in an E2E test
- Koreserver-to-ABL narrative: "this is your callflow — but typed, tested, traced, and unified with your LLM agents"
