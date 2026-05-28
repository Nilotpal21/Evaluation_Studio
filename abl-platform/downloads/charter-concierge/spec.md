# Charter Concierge Spec Notes

This file explains why `charter-concierge` is structured the way it is and how the example maps to the ABL execution model for a Charter Communications style telecom assistant.

For the fuller ported teaching set, use the files in [docs/](./docs/). This spec stays focused on the compact construct map.

## 1. What This Example Covers

The example is intentionally broad enough to answer six recurring questions about ABL:

1. How does multi-agent orchestration work in practice?
2. What are the key constructs?
3. Why are those constructs not collapsed into one generic abstraction?
4. How is ABL observability different from graph, crew, or workflow systems?
5. How do deterministic controls such as constraints, guardrails, and entity collection work?
6. How do deterministic and reasoning-heavy orchestration coexist without fighting each other?

## 2. Domain Scope

This example is about Charter Communications as a telecom and connectivity company.

The modeled surface is:

- internet plus WiFi plus mobile bundle guidance
- account verification and billing care
- setup and activation readiness
- service and troubleshooting context
- policy explanation
- live support routing

## 3. Construct Map

| Construct                   | Purpose in ABL                                                              | Where this example uses it                                                                                                                            | Why it matters                                                                                    |
| --------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SUPERVISOR`                | Own the top-level conversational router                                     | [agents/charter_concierge_supervisor.agent.abl](./agents/charter_concierge_supervisor.agent.abl)                                                      | Makes routing an explicit authored surface instead of hidden prompt logic                         |
| `HANDOFF`                   | Transfer ownership of the conversation to another specialist                | supervisor, connectivity advisor, policy advisor, intake                                                                                              | Preserves who is speaking now and why                                                             |
| `DELEGATE`                  | Invoke a bounded specialist subroutine without changing the visible speaker | [agents/charter_intake.agent.abl](./agents/charter_intake.agent.abl) delegating to [agents/quote_analyst.agent.abl](./agents/quote_analyst.agent.abl) | Lets a reasoning agent call deterministic pricing without losing UX continuity                    |
| `FLOW`                      | Define replayable step order                                                | recommendation analyst, setup readiness collector, authentication agent, billing care, live support transfer                                          | Gives deterministic execution and clear trace checkpoints                                         |
| `CALL`                      | Invoke a tool inside a deterministic step                                   | recommendation analyst, setup readiness collector, live support transfer                                                                              | Separates tool effects from conversational wording                                                |
| `GATHER`                    | Collect committed state from the user                                       | intake, policy advisor, connectivity advisor, authentication, billing care, deterministic flows                                                       | Distinguishes state collection from raw observation                                               |
| `ENTITIES` and `ENTITY_REF` | Normalize fuzzy setup language into explicit operational values             | setup readiness collector                                                                                                                             | Makes phrases like "address is verified" or "need equipment shipped" map into stable state values |
| `CONSTRAINTS`               | Enforce deterministic business invariants                                   | intake, recommendation analyst, setup readiness collector, billing care                                                                               | Blocks invalid transitions with a stable rule surface                                             |
| `GUARDRAILS`                | Enforce safety and fraud boundaries on input or output                      | intake, billing care                                                                                                                                  | Keeps sensitive account-change requests from being processed like normal service guidance         |

## 4. Why These Constructs Are Separate

### `HANDOFF` is not `DELEGATE`

`HANDOFF` means the active specialist changes.

- The visible owner of the conversation changes.
- Trace semantics should show an agent switch.
- Return behavior matters.
- The child agent may continue the interaction directly.

`DELEGATE` means the active specialist stays the same.

- The user still experiences the parent agent as the speaker.
- The child is a subroutine, not a new owner.
- Return values are structured outputs, not a conversational transfer.

If these are merged into a generic "call another agent" primitive, you lose an important distinction in UX, traceability, and runtime policy.

### `ENTITIES` are not `GATHER`

`ENTITIES` answer "what did the user say that the system can recognize?"

`GATHER` answers "what values do we care enough to collect, validate, and commit into state?"

This example uses that split directly:

- "address is verified" is an observed signal that normalizes to `ADDR_VERIFIED`
- `address_status` becomes a gathered field only because the setup flow chooses to commit and act on it
- `credit_amount` becomes a gathered billing field only because the billing flow is ready to evaluate an actual policy over it

That separation aligns with the repo design notes in [docs/superpowers/specs/2026-04-07-abl-semantic-constructs-design.md](../../docs/superpowers/specs/2026-04-07-abl-semantic-constructs-design.md).

### `CONSTRAINTS` are not `GUARDRAILS`

`CONSTRAINTS` are business and orchestration invariants.

- "line count must stay within self-service bounds"
- "a selected offer must exist before recommendation pricing"
- "setup readiness needs address verification before passing"

`GUARDRAILS` are safety and fraud boundaries.

- bypass identity requests
- unauthorized SIM or port changes
- stolen-device style requests

If those are merged, business validity and safety policy become one blurry layer.

### `FLOW` is not reasoning

`FLOW` is for work we want to replay, validate, and audit step-by-step.

Reasoning is for work where the phrasing, explanation style, or local judgment can vary.

This example keeps both:

- recommendation pricing is deterministic
- recommendation explanation is reasoning-driven
- setup readiness is deterministic
- policy explanation is reasoning-driven

That hybrid shape is the point, not a compromise.

## 5. How Multi-Agent Orchestration Works Here

The orchestration pattern is:

1. The supervisor identifies the lane.
2. A specialist owns the local business conversation.
3. Specialists either:
   - answer directly,
   - hand off to a better owner,
   - or delegate hidden subroutines for bounded work.
4. Deterministic flows anchor the critical transitions.

### Concrete examples in this bundle

- New service path:
  supervisor `HANDOFF` -> intake `DELEGATE` -> recommendation analyst `FLOW` + `CALL`
- Setup path:
  supervisor `HANDOFF` -> setup readiness collector `ENTITIES` + `FLOW`
- Billing path:
  supervisor `HANDOFF` with `RETURN: true` -> authentication `FLOW` -> supervisor -> billing care `FLOW` + `CONSTRAINTS`
- Policy path:
  supervisor `HANDOFF` -> policy advisor `TOOLS` + explanation
- Support path:
  intake `HANDOFF` -> live support transfer `FLOW` + callback tool

This is close to the runtime orchestration model described in [docs/features/multi-agent-orchestration.md](../../docs/features/multi-agent-orchestration.md), where trace events include `handoff`, `agent_switch`, `delegate_start`, `delegate_complete`, `completion_check`, and `return_to_parent`.

## 6. Observability Difference

The important unit of observability in ABL is the semantic decision, not just the model call.

For this example, the interesting events are:

- "supervisor handed off to intake"
- "intake delegated structured pricing"
- "setup entity resolved to `MODEM_NEEDS_SHIPMENT`"
- "authentication returned control to the supervisor"
- "billing credit hit the self-service ceiling"
- "constraint blocked setup readiness"
- "live support callback ticket was created"

That is different from merely logging prompts, tool invocations, or generic node execution.

## 7. Deterministic and Reasoning Orchestration Together

This example deliberately alternates between deterministic and reasoning-heavy work.

### Deterministic segments

- `Offer_Analyst.build_recommendation`
- `Setup_Readiness_Collector.validate_readiness`
- `Authentication_Agent.verify_code`
- `Billing_Care_Agent.apply_small_credit`
- `Human_Support_Transfer.create_callback`

### Reasoning segments

- supervisor routing language
- intake clarification and offer explanation
- recommendation explanation after pricing
- bill explanation after deterministic bill loading
- policy explanation
- connectivity advice

### Why that mix is better

- deterministic steps keep pricing, fraud-sensitive boundaries, and readiness rules stable
- reasoning steps keep the experience natural and adaptive
- the authored boundary between them is explicit in the ABL source

Without that boundary, systems often end up either:

- over-deterministic and robotic, or
- over-agentic and hard to audit

## 8. Comparison With Other Systems

These comparisons are not about declaring a winner. They highlight where the center of gravity differs.

### LangGraph

LangGraph presents itself as a low-level orchestration framework and runtime for long-running, stateful agents, with durable execution, persistence, streaming, and human-in-the-loop support. Its docs also explicitly distinguish workflows with predetermined code paths from agents with dynamic tool-using loops. citeturn1view0turn1search1

ABL differs in emphasis:

- LangGraph gives you graph primitives.
- ABL gives you authored semantic constructs like `HANDOFF`, `DELEGATE`, `CONSTRAINTS`, and `ENTITIES`.
- In LangGraph, you often encode these semantics in graph code and runtime glue.
- In ABL, they are first-class in the language and therefore first-class in review and tracing.

### CrewAI

CrewAI describes Flows as structured, event-driven workflows with shared state, while Crews organize agents and tasks through sequential or hierarchical processes. CrewAI also provides built-in tracing for Crews and Flows and supports OpenTelemetry-oriented observability integrations. citeturn0search2turn0search3turn3search0turn3search2

ABL differs in emphasis:

- CrewAI separates orchestration across flows, crews, tasks, and agents.
- ABL tries to keep the authored orchestration model inside one language surface.
- ABL does less with generic event wiring and more with agent-native semantics.

### n8n

n8n is a workflow automation system where an execution is a run of a workflow, and users inspect node-level inputs, outputs, and execution history. Its AI docs distinguish agents from basic chains, noting that the Basic LLM Chain does not support memory or tools. citeturn2search1turn2search7turn2search0turn2search8

ABL differs in emphasis:

- n8n is workflow-first and node-first.
- ABL is agent-language-first.
- n8n observability centers on workflow runs and node data flow.
- ABL observability centers on semantic orchestration decisions like handoff, delegate, completion, and constraint enforcement.

## 9. Charter Context

Charter says it connects customers with Spectrum Internet, Mobile, Video, and Voice, serves customers in 41 states through the Spectrum brand, and positions converged connectivity offerings like Spectrum One around Internet, Advanced WiFi, and Unlimited Mobile. citeturn1view0turn1view1turn1view2

That is why this example centers on:

- bundled service recommendation
- setup readiness
- mobile-sensitive policy boundaries
- troubleshooting context
- live support transfer
