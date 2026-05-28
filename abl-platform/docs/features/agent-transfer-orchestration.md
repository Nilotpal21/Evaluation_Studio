# Feature: Agent Transfer & Multi-Agent Orchestration

**Doc Type**: HUB
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `agent lifecycle`, `customer experience`, `integrations`, `observability`
**Package(s)**: `apps/runtime`, `packages/agent-transfer`, `packages/a2a`, `packages/compiler`, `packages/execution`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/agent-transfer-orchestration.md](../testing/agent-transfer-orchestration.md)
**Last Updated**: 2026-03-21

---

## 1. Introduction / Overview

### Problem Statement

The platform’s coordination surface spans several related but distinct capabilities: local multi-agent orchestration, human-agent transfer, remote A2A handoff, and multi-agent session/thread management. Without an overview hub, it is easy to blur those features together and lose clarity about which subsystem owns which lifecycle, storage model, failure mode, or test surface.

### Goal Statement

The goal of this hub is to explain how the coordination family fits together at a platform level while preserving dedicated docs for each major feature module. It should help readers navigate the system without turning back into a bundled mega-doc that hides the important boundaries between orchestration, transfer, A2A, and session management.

### Summary

The coordination family supports five major execution patterns:

- local handoff between agents
- delegation to a child agent
- fan-out/gather across agents and tools
- escalation to a human agent desktop
- remote collaboration through the A2A protocol

Those patterns do not all belong to one implementation surface. Multi-Agent Orchestration owns routing logic, thread creation, delegation, fan-out, completion, and condition evaluation. Multi-Agent Session Management owns the session and thread model. Agent Transfer owns the human-handoff lifecycle after an escalation is chosen. A2A Integration owns the protocol-specific inbound/outbound remote agent surface. This hub keeps that map explicit.

---

## 2. Scope

### Goals

- Show the boundary between orchestration, transfer, A2A, and session-management responsibilities.
- Summarize the shared coordination patterns, runtime touchpoints, and key data flows across the family.
- Point readers to the dedicated feature and testing docs that own the details.

### Non-Goals (Out of Scope)

- This hub does not replace the dedicated docs for [Multi-Agent Orchestration](multi-agent-orchestration.md), [Agent Transfer](agent-transfer.md), [Multi-Agent Session Management](multi-agent-session-management.md), or [A2A Integration](a2a-integration.md).
- This hub does not serve as the source of truth for full API inventories, exhaustive implementation-file catalogs, or detailed testing logs.
- This hub does not collapse the split coordination features back into one implementation doc.

---

## 3. User Stories

1. As a platform engineer, I want to understand which subsystem owns handoff, escalation, A2A, and thread/session behavior so that I can debug or extend the right layer.
2. As a docs reader, I want an overview that links the coordination features together so that I can navigate the detailed docs without conflating them.
3. As an operator, I want to know which coordination paths affect channels, tracing, and recovery so that I can reason about runtime incidents.

---

## 4. Functional Requirements

1. **FR-1**: The coordination family must support local handoff, delegation, fan-out/gather, escalation, and completion behavior within runtime execution.
2. **FR-2**: The coordination family must support human-agent transfer after an escalation decision is made.
3. **FR-3**: The coordination family must support remote agent collaboration through A2A for inbound or outbound multi-agent flows.
4. **FR-4**: The coordination family must preserve session/thread continuity, return paths, and context/history propagation across handoffs and delegates.
5. **FR-5**: The documentation hub must keep these responsibilities split and cross-linked rather than re-bundled into a single feature implementation narrative.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                               |
| -------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Projects configure defaults, routing, and connection surfaces used by coordination features.        |
| Agent lifecycle            | PRIMARY      | Coordination determines how execution moves between local agents, remote agents, and humans.        |
| Customer experience        | PRIMARY      | End users can experience agent switches, escalation, and remote agent participation directly.       |
| Integrations / channels    | PRIMARY      | A2A, voice, WebSocket, and other channels intersect with coordination behavior.                     |
| Observability / tracing    | PRIMARY      | Trace events, lifecycle logs, and transfer/session visibility are core operational requirements.    |
| Governance / controls      | SECONDARY    | Guardrails, auth propagation, SSRF protection, and tenant boundaries all matter here.               |
| Enterprise / compliance    | SECONDARY    | Redis-backed recovery, encryption, and durable async handling affect enterprise readiness.          |
| Admin / operator workflows | SECONDARY    | Operators manage connection surfaces, settings, and active sessions across the coordination family. |

### Related Feature Integration Matrix

| Related Feature                                                     | Relationship Type | Why It Matters                                                                               | Key Touchpoints                                                     | Current State |
| ------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| [Multi-Agent Orchestration](multi-agent-orchestration.md)           | primary module    | Owns routing logic, handoff/delegate/fan-out/completion, and decision execution.             | `RoutingExecutor`, orchestration trace events, condition evaluation | Dedicated doc |
| [Multi-Agent Session Management](multi-agent-session-management.md) | primary module    | Owns thread/session model, return paths, active-agent state, and continuity.                 | `RuntimeSession`, `AgentThread`, thread stack, session persistence  | Dedicated doc |
| [Agent Transfer](agent-transfer.md)                                 | primary module    | Owns human-agent session lifecycle, provider adapters, and bridge delivery after escalation. | Redis transfer sessions, provider webhooks, message bridge          | Dedicated doc |
| [A2A Integration](a2a-integration.md)                               | primary module    | Owns protocol-specific remote agent discovery, invocation, streaming, and task handling.     | A2A JSON-RPC, agent cards, session resolver, async callbacks        | Dedicated doc |

---

## 6. Design Considerations (Optional)

- Coordination patterns share runtime context and traces, but they do not share a single persistence model.
- Thread-based orchestration intentionally avoids session sprawl by keeping multiple agent activations in one runtime session.
- Human transfer and A2A are integration surfaces, not just orchestration branches; each has its own storage, operational risks, and testing needs.

---

## 7. Technical Considerations (Optional)

- Local orchestration logic is runtime-native and IR-driven.
- Human transfer state is Redis-backed and provider-adapter-driven.
- A2A uses protocol-specific handlers, session resolvers, task stores, and callback infrastructure.
- Async flows across the family depend on Redis-backed coordination and, in some cases, BullMQ or similar resume/callback infrastructure.

---

## 8. How to Consume

### Studio UI

- Use the ABL DSL/editor and Observatory for orchestration behavior and traces.
- Use transfer settings and transfer session views for human-agent escalation operations.
- Use channel connection and deployment surfaces for A2A entry points and related connection-level config.

### API (Runtime)

| Method | Path                                        | Purpose                                                     |
| ------ | ------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/projects/:projectId/chat`             | Triggers orchestration during normal message execution      |
| WS     | `/ws`                                       | Streams orchestration events and runtime activity           |
| POST   | `/a2a/:connectionId`                        | Accepts inbound A2A requests                                |
| POST   | `/api/v1/agent-transfer/webhooks/:provider` | Accepts provider webhook callbacks for human-agent transfer |

### API (Studio)

| Method    | Path                                                  | Purpose                                                       |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| GET       | `/api/projects/:projectId/sessions/:sessionId/traces` | Reads orchestration traces                                    |
| GET / PUT | `/api/projects/:id/agent-transfer/settings`           | Reads and writes transfer settings                            |
| GET       | `/api/channel-connections`                            | Lists connection surfaces including A2A-related configuration |

### Admin Portal

There is no single admin-only “coordination console.” Operators manage different parts of the family through project settings, channel connections, runtime environment configuration, and trace/operational views.

### Channel / SDK / Voice / A2A / MCP Integration

| Surface                    | Coordination Role                                                   |
| -------------------------- | ------------------------------------------------------------------- |
| Digital / WebSocket / REST | Full orchestration support with trace visibility                    |
| Voice                      | Full orchestration plus transfer-specific voice tooling             |
| A2A                        | Inbound and outbound remote-agent collaboration                     |
| SDK                        | Can experience orchestration behavior through runtime session flows |

---

## 9. Data Model

### Collections / Tables

At the family level, coordination spans multiple storage models rather than one shared collection:

```text
Runtime session / thread model
  RuntimeSession:
    threads: AgentThread[]
    activeThreadIndex
    threadStack
    handoffStack
    delegateStack
    handoffReturnInfo
```

```text
Transfer session model
  Redis keys for human-agent handoff state, provider reverse lookup, pod ownership, and recovery
```

```text
A2A session/task model
  Redis keys for contextId -> sessionId, task state, callback config, and context-task indexes
```

### Key Relationships

- Orchestration creates or switches threads within a runtime session.
- Agent Transfer attaches human-handoff state to the same broader user/session journey after escalation.
- A2A maps remote protocol context into runtime session continuity when remote agents participate.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                      | Purpose                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `apps/runtime/src/services/execution/routing-executor.ts` | Core orchestration engine for handoff, delegation, fan-out, escalation, and completion |
| `apps/runtime/src/services/execution/types.ts`            | Runtime session/thread and coordination helper types                                   |
| `packages/compiler/src/platform/ir/schema.ts`             | Coordination IR types                                                                  |

### Routes / Handlers

| File                                                  | Purpose                             |
| ----------------------------------------------------- | ----------------------------------- |
| `apps/runtime/src/routes/agent-transfer-webhooks.ts`  | Human-agent transfer webhook intake |
| `packages/a2a/src/infrastructure/express-handlers.ts` | Inbound A2A protocol handling       |
| `apps/runtime/src/services/a2a/agent-card-builder.ts` | A2A identity surface construction   |

### UI Components

| File                                                   | Purpose                            |
| ------------------------------------------------------ | ---------------------------------- |
| `apps/studio/src/components/observatory/SpanTree.tsx`  | Displays coordination trace events |
| `apps/studio/src/components/observatory/DebugTabs.tsx` | Shows coordination decision logs   |

### Jobs / Workers / Background Processes

| File                                                                | Purpose                       |
| ------------------------------------------------------------------- | ----------------------------- |
| `apps/runtime/src/services/agent-transfer/index.ts`                 | Transfer boot/recovery wiring |
| `apps/runtime/src/services/agent-transfer/timeout-queue-factory.ts` | Transfer timeout handling     |
| `packages/a2a/src/infrastructure/lazy-task-store.ts`                | A2A task-store upgrade path   |

### Tests

| File                                                            | Type        | Coverage Focus                 |
| --------------------------------------------------------------- | ----------- | ------------------------------ |
| `apps/runtime/src/__tests__/routing-remote-handoff.test.ts`     | unit        | Remote handoff behavior        |
| `apps/runtime/src/__tests__/escalation-negative.test.ts`        | unit        | Escalation edge cases          |
| `packages/agent-transfer/src/__tests__/e2e/kore-e2e.test.ts`    | e2e         | Human-agent transfer lifecycle |
| `packages/a2a/src/__tests__/task-lifecycle-integration.test.ts` | integration | A2A task lifecycle             |

---

## 11. Configuration

### Environment Variables

| Variable                       | Default   | Description                       |
| ------------------------------ | --------- | --------------------------------- |
| `MAX_CONCURRENT_FAN_OUT_CALLS` | `10`      | Fan-out concurrency guard         |
| `MAX_ASYNC_TIMEOUT_SEC`        | `2592000` | Async handoff timeout cap         |
| `AGENT_TRANSFER_ENABLED`       | `false`   | Enables transfer subsystem wiring |

### Runtime Configuration

- Coordination defaults live in runtime configuration and project settings.
- Transfer has its own provider/session/voice configuration.
- A2A has its own session/task/callback configuration and async upgrade path.

### DSL / Agent IR / Schema

Coordination behavior is primarily configured through the `COORDINATION` block in the ABL DSL, while A2A and transfer setup use connection and settings surfaces outside the DSL.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                           |
| ----------------- | ----------------------------------------------------------------------------------- |
| Project isolation | Project-scoped settings and connections must not bleed across projects.             |
| Tenant isolation  | Session stores, transfer keys, and A2A mappings must remain tenant-scoped.          |
| User isolation    | User/session routing must return events to the correct active conversation context. |

### Security & Compliance

- Guardrails, auth propagation, SSRF protection, webhook verification, and tenant-scoped session data are central to the family.

### Performance & Scalability

- Fan-out concurrency, Redis-backed state, debounced persistence, and async resume flows are the main performance/scaling levers.

### Reliability & Failure Modes

- The family has a mix of deterministic local runtime flows and integration-heavy async paths that depend on Redis, callbacks, and provider infrastructure.

### Observability

- Coordination emits rich trace events across handoff, delegation, escalation, fan-out, transfer, and A2A execution.

### Data Lifecycle

- Coordination state is mostly session-bounded or TTL-bound rather than permanently stored as a new domain collection.

---

## 13. Delivery Plan / Work Breakdown

1. Family-level hardening
   1.1 Add missing end-to-end coverage for thread resume, ON_RETURN mapping, and history strategies.
   1.2 Expand async remote handoff and async fan-out verification.
2. Cross-feature verification
   2.1 Execute cross-tenant A2A E2E coverage with a second-tenant setup.
   2.2 Add end-to-end escalation flows that continue through provider webhook return paths.
3. Documentation hygiene
   3.1 Keep this hub overview-focused.
   3.2 Push low-level implementation and test detail into the dedicated feature/testing docs when it grows deeper.

---

## 14. Success Metrics

| Metric                            | Baseline                                             | Target                                  | How Measured                              |
| --------------------------------- | ---------------------------------------------------- | --------------------------------------- | ----------------------------------------- |
| Coordination-family doc clarity   | Previously bundled in one mixed document             | Split docs plus a clean hub             | Reader navigation and doc structure audit |
| Cross-feature coverage confidence | Strong core-path coverage, weaker async/remote edges | Key async and cross-tenant gaps covered | Test inventory across split docs          |

---

## 15. Open Questions

1. Which missing async orchestration cases should be prioritized first: poll fallback, async fan-out barriers, or thread resume?
2. Should the platform eventually expose a more unified operator view across transfer, A2A, and orchestration traces?
3. How much of the auth propagation chain needs dedicated integration proof versus unit-level confidence?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                             | Severity | Status    |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | Remote A2A streaming still uses a degraded sync+forward path because of an SDK generator issue                          | Medium   | Open      |
| GAP-002 | Cross-tenant A2A end-to-end isolation is not fully executed                                                             | Medium   | Open      |
| GAP-003 | Several orchestration-family async and return-path cases remain only partially verified                                 | Medium   | Open      |
| GAP-004 | The coordination family spans multiple storage and integration models, which makes end-to-end verification more complex | Medium   | By design |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                          | Coverage Type      | Status               | Test File / Note                                                                               |
| --- | --------------------------------- | ------------------ | -------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Core orchestration paths          | unit / integration | PASS                 | See [docs/testing/agent-transfer-orchestration.md](../testing/agent-transfer-orchestration.md) |
| 2   | Human-agent transfer lifecycle    | integration / e2e  | PASS                 | See [docs/testing/agent-transfer.md](../testing/agent-transfer.md)                             |
| 3   | A2A protocol behavior             | integration / e2e  | PASS / PARTIAL       | See [docs/testing/a2a-integration.md](../testing/a2a-integration.md)                           |
| 4   | Async and cross-tenant edge cases | e2e                | PARTIAL / NOT TESTED | Open gaps remain                                                                               |

### Testing Notes

This hub intentionally summarizes the family-level confidence picture. Detailed testing evidence now lives in the dedicated testing guides for A2A, Agent Transfer, Multi-Agent Orchestration, and Multi-Agent Session Management.

> Full testing details: [docs/testing/agent-transfer-orchestration.md](../testing/agent-transfer-orchestration.md)

---

## 18. References

- Related features: [A2A Integration](a2a-integration.md), [Agent Transfer](agent-transfer.md), [Multi-Agent Orchestration](multi-agent-orchestration.md), [Multi-Agent Session Management](multi-agent-session-management.md)
- IR schema: `packages/compiler/src/platform/ir/schema.ts`
- Compiler constructs: `packages/compiler/src/platform/constructs/types.ts`
