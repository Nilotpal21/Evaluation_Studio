# Arch AI Agent Intelligence Pattern Audit

> Package: `@agent-platform/arch-ai`
> Status: Design audit for the next generation-quality slice
> Last reviewed: 2026-05-13

This audit focuses on whether Arch AI chooses the right agent intelligence pattern for a
given requirement. Compile success is necessary, but it is not enough. A production-ready
agent must also choose the right orchestration shape, execution mode, tool usage, flow
structure, handoff semantics, and exit behavior for the actual scenario.

The key finding is that current blueprint-based generation is structurally safer than the
older flow, but still too often collapses different use cases into one generic pattern:

```text
router -> specialists -> gather fields -> complete
```

That shape is valid for simple triage and intake, but it is not enough for tool-backed,
transactional, approval-gated, long-running, regulated, or state-machine workflows.

## Repo-Grounded Findings

### What already exists

- `blueprint/v2-schema.ts` captures high-level topology, per-agent roles, tools, gather fields,
  constraints, guardrails, handoffs, and completion.
- `planning/agent-architecture-planner.ts` computes deterministic topology-aware plans:
  archetype, supervisor vs agent, gather hints, completion hints, handoff targets, return hints,
  and simple complexity hints.
- `planning/construct-plan.ts` defines the right internal shape for richer runtime planning:
  gathers, tools, tool calls, state, flow, handoffs, delegates, escalations, completion, and
  unsupported construct notes.
- `knowledge/cards/runtime-construct-decision.ts` gives good guidance for choosing between
  `GATHER`, `CALL`, `HANDOFF`, `DELEGATE`, `ESCALATE`, result aliases, `SET`, completion, and CEL.
- `knowledge/platform-limits.ts` correctly warns that execution mode is derived from structure,
  `RETURN: true` requires a valid completion path, `human_approval` should not be generated, and
  CEL references are flat.

### Where intelligence is lost today

- `BlueprintV2TopologySchema.pattern` only supports `single_agent`, `triage`, `pipeline`,
  `hub_spoke`, and `mesh`. Those are graph shapes, not runtime behavior patterns.
- `deriveAgentConstructPlan()` currently sets `toolCalls: []` and `flow: []` for derived plans.
  The schema can hold intelligent behavior, but the derivation usually does not populate it.
- `renderAgentDslFromBlueprint()` renders baseline sections only. It does not render construct-plan
  `FLOW`, `CALL WITH/AS`, `SET`, `ON_RESULT`, `ON_SUCCESS`, `ON_FAILURE`, `DELEGATE`, `ESCALATE`,
  or return handlers.
- Knowledge cards are reactive. They are selected when the prompt mentions constructs, but normal
  users describe business goals, not `ON_RESULT` or `CALL WITH AS`.
- The current scoring can show compile health while missing actual execution capability. In the
  20-project run, most scenarios had good topology but almost no generated tool calls or flow steps.

## Agent Intelligence Dimensions

Arch AI should make separate decisions for each agent instead of relying on one topology label.

| Dimension        | Question                                                                  | Why it matters                                                         |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Ownership        | Does this agent answer, route, collect, transact, monitor, or escalate?   | Prevents generic specialists for transactional work.                   |
| Execution mode   | Should the runtime be reasoning, scripted, or hybrid?                     | Execution mode is derived from structure, not declared text.           |
| Tool authority   | Can a tool retrieve, verify, calculate, create, or update the value?      | Avoids asking users for data the platform should fetch.                |
| Statefulness     | Does the task span turns, days, roles, or external callbacks?             | Requires memory/session fields and resumable flow state.               |
| Control transfer | Should parent stop, resume, delegate, or escalate?                        | Prevents wrong `RETURN` and missing completion contracts.              |
| Branching        | Are there policy, eligibility, risk, status, or approval branches?        | Requires CEL, result aliases, `SET`, and ordered `ON_RESULT` branches. |
| Risk level       | Does the action affect money, health, legal, security, or regulated data? | Requires confirmation, audit, constraints, and human escalation.       |
| Channel shape    | Is this web chat, voice, API, Slack, SMS, WhatsApp, or multimodal?        | Changes prompts, response forms, attachments, and channel setup.       |

## Pattern Catalog

These are the practical patterns Arch AI should recognize. They can compose; a project can contain
multiple patterns.

### 1. Reasoning answer agent

Use for FAQ, explanation, product education, policy interpretation, and advisory responses where no
external action is required.

Expected shape:

- `reasoning` mode.
- No `FLOW` unless the response must follow a fixed script.
- Optional tools for SearchAI, KB, or document retrieval.
- `COMPLETE` can be simple if the agent is a returnable child.
- Guardrails and limitations matter more than tool sequencing.

Failure mode to catch:

- Creating many specialists when one reasoning agent with KB/search would be clearer.

### 2. Structured intake agent

Use when the agent must collect user-provided fields before producing a summary, case packet, or
handoff.

Expected shape:

- `scripted` or `hybrid`.
- `GATHER` for fields only the user can provide.
- Optional `FLOW` when fields have ordering, dependencies, or confirmation.
- `COMPLETE` only after required fields and summary variables exist.

Failure mode to catch:

- Asking for values that should come from tools, such as order status, eligibility, policy details,
  account profile, or current inventory.

### 3. Tool lookup agent

Use when a tool should retrieve information before answering: order status, appointment availability,
claim status, ticket status, formulary status, account details, technician availability, inventory,
or profile data.

Expected shape:

- Usually `scripted` for deterministic lookup and response.
- `GATHER` only for lookup keys the user must provide.
- `CALL` with `WITH` and `AS`.
- `ON_SUCCESS` / `ON_FAILURE` for simple success/fail.
- `SET` any durable values later used in `RESPOND`, `COMPLETE`, handoff conditions, or return mapping.

Failure mode to catch:

- Tool declared in blueprint/project but never called in ABL.
- Response references tool output without a result alias or state assignment.

### 4. Transactional action agent

Use for create/update actions: create claim, book appointment, apply credit, generate RMA, invite
teammate, open case, submit application, send notification, schedule callback, or update milestone.

Expected shape:

- Usually `scripted`.
- Required field collection.
- Explicit user confirmation before high-impact action.
- `CALL` with `WITH` and `AS`.
- `ON_SUCCESS` sets confirmation IDs/status.
- `ON_FAILURE` gives recovery path or escalates.
- `COMPLETE` when transaction result exists or safe failure path is delivered.

Failure mode to catch:

- Reasoning-only agent promises an action without any tool call.
- Missing confirmation for irreversible or high-impact operations.

### 5. Policy and eligibility decision agent

Use when the system applies business policy: refund eligibility, fraud threshold, clinical criteria,
benefit qualification, credit policy, KYC/AML risk, SLA breach, or regulatory timing.

Expected shape:

- `scripted` for deterministic rules, or `hybrid` if reasoning classifies inputs before rules.
- Tool result aliases for scores, policy outcomes, or rule-engine responses.
- `ON_RESULT` when branching depends on returned fields.
- CEL conditions on declared/gathered/set variables only.
- Branch order must put specific conditions before fallback/else.

Failure mode to catch:

- Handoff conditions like `fraud_risk == "high"` when `fraud_risk` is never gathered, set, or returned.
- Using invented namespaces like `input.amount` or `memory.case.status`.

### 6. Router or supervisor agent

Use when one entry agent routes users to specialized owners.

Expected shape:

- `SUPERVISOR` or entry router.
- `hybrid` if it normalizes intent/entities before handoff.
- Minimal gather for routing only if intent cannot be inferred.
- Handoff conditions should use intrinsic runtime fields or declared/set variables.
- Catch-all fallback target should be explicit.

Failure mode to catch:

- Router relies on undeclared variables like `incident`, `known_issue`, `faq_or_howto`, or
  `shipping_issue`.
- Router becomes the only smart agent while specialists are thin gather shells.

### 7. Returnable child specialist

Use when a parent must resume after a child completes a subtask.

Expected shape:

- Parent uses `HANDOFF RETURN: true` or `DELEGATE` depending on ownership.
- Child has reachable `COMPLETE`.
- Child returns or default-merges specific gathered/set fields.
- Parent has a post-return path or at least a clear continuation behavior.

Failure mode to catch:

- `RETURN: true` to a child without `COMPLETE`.
- Parent expects fields that child never gathers or sets.
- Using handoff when delegate is more semantically correct.

### 8. Terminal transfer or human escalation

Use when control should leave automation: human handoff, supervisor callback, caseworker queue,
licensed advisor, nurse line, on-call analyst, HRBP, senior counsel, manual fraud review.

Expected shape:

- Usually `scripted`.
- Collect a concise escalation packet.
- Use `ESCALATE` when supported by project/runtime path, otherwise a terminal handoff agent that
  creates the packet and completes.
- No indefinite return contract unless a real callback/return path is modeled.
- Do not generate `human_approval` unless runtime support is proven.

Failure mode to catch:

- Escalation agent with `GATHER` but no `COMPLETE`.
- Vague "handoff to human" text without packet fields or audit trail.

### 9. Pipeline workflow

Use when work must pass through ordered stages: claims, mortgage origination, contract review,
prior authorization, onboarding, AML case creation, incident response.

Expected shape:

- Multiple scripted or hybrid stages.
- Each stage has explicit input requirements, outputs, completion, and next edge.
- Parent coordinator owns progress state if the user can pause/resume.
- Stage transitions should be data-dependent only where needed.

Failure mode to catch:

- Representing a pipeline as a router with independent specialists and no state machine.
- No durable "current stage" / "completed stages" / "next required action" state.

### 10. Approval-gated workflow

Use when action requires user, admin, clinician, analyst, or supervisor confirmation.

Expected shape:

- `GATHER` or `RESPOND` asks for explicit approval.
- Confirmation variable is stored.
- Tool action only runs after confirmation.
- Failure or refusal path is explicit.
- Escalation/human review for high-risk or ambiguous cases.

Failure mode to catch:

- Tool executes before consent/approval.
- Confirmation gathered but not referenced by flow/CEL.

### 11. Long-running resumable workflow

Use for multi-day onboarding, mortgage, government benefits, HR reviews, real-estate closing,
incident/postmortem, or any flow with external waiting.

Expected shape:

- Session or persistent memory for workflow state.
- State fields like current stage, completed stage list, pending external action, last reminder, due date.
- Flow can resume without restarting interview.
- Handoffs/delegates pass the minimal state needed.

Failure mode to catch:

- Blueprint says "persists across days" but ABL only gathers fields in one turn.
- No memory/state fields for resume.

### 12. Event/API-triggered workflow

Use for webhook/API-driven systems: SIEM alert, transaction stream, API prior auth, iOS API meal plan,
status update, or integration callbacks.

Expected shape:

- Channel/API setup must be represented outside ABL creation.
- Agent should expect structured payload fields or a parsing tool.
- Flow should parse/normalize payload before routing.
- User-facing chat assumptions should be avoided for pure API entry points.

Failure mode to catch:

- Generating chat-style questions for an API-only event stream.
- No channel connection or deployment-addressable entry point.

### 13. Multimodal/document workflow

Use for photos, PDFs, DOCX, screenshots, HAR files, claim evidence, medical images, contracts,
proof documents, or IDs.

Expected shape:

- Attachment or upload fields.
- Tool call for parsing/extraction/classification if available.
- Safety/compliance limitations for sensitive domains.
- Fallback path if artifact missing or unreadable.

Failure mode to catch:

- Asking the user to paste all document contents manually.
- Claiming extraction happened without a tool or attachment contract.

### 14. Multilingual and channel-adaptive workflow

Use for voice, SMS, WhatsApp, Slack, multilingual support, regional routing, accessibility, and
plain-language requirements.

Expected shape:

- Language detection or explicit language gather.
- Channel-specific response constraints.
- Handoff summaries preserve language/context.
- Voice flows avoid long walls of text and sensitive readouts.

Failure mode to catch:

- Topology includes languages/channels but no tool, state, or routing behavior uses them.
- Region/language routing creates invalid target names or catch-all placeholders.

### 15. Observer/audit sidecar

Use for audit logs, status updates, timeline capture, analytics, compliance logging, WORM stores,
deadline tracking, or post-mortem timeline.

Expected shape:

- Usually scripted sidecar/worker.
- Tool call records event or state.
- Should not become the user-facing router unless the use case demands it.
- May be called by parent stages after meaningful events.

Failure mode to catch:

- "Audit trail" appears only in persona/limitations and never calls a logging tool.

## Scenario Coverage Gaps From Battle Fixtures

The current 20-scenario suite stresses many of the right cases, but the generated outputs expose
important gaps:

| Scenario family          | Required intelligence                                                                | Current risk                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Insurance claims         | Intake, evidence upload, fraud score, adjuster assignment, supervisor threshold      | Tool hints disappear; fraud and assignment become gather/complete shells.     |
| Telco billing dispute    | Voice auth, billing lookup, credit thresholds, callback scheduling                   | Auth and credit application need scripted flow and tool result branches.      |
| Medical triage           | Multimodal intake, urgency classification, appointment booking, emergency escalation | Must avoid diagnosis while still using classification/booking tools.          |
| SaaS onboarding          | Multi-day state machine, SSO/OAuth, integrations, invites, kickoff                   | Needs resumable stage state, not independent specialists only.                |
| Travel booking           | Parallel search, pricing, policy comparison, booking confirmation                    | Needs hub plus tool-backed specialists and result aggregation.                |
| Financial advisor        | KYC, AML, suitability, education-only, audit log, licensed handoff                   | Requires compliance gates and audit sidecar; no product advice.               |
| Legal review             | Document parse, clause extraction, risk scoring, redline export                      | Requires document pipeline and tool-backed extraction.                        |
| EdTech tutoring          | Diagnostic, adaptive plan, mastery tracking, parental consent                        | Needs state and mastery update loop.                                          |
| Field dispatch           | Issue classification, tech/parts lookup, booking, ETA, SLA escalation                | Needs transactional flow and SLA branch.                                      |
| Mortgage                 | Credit authorization, document chase, disclosures, preapproval                       | Needs consent gates, regulatory timing, and stateful pipeline.                |
| Returns/fraud            | Reason classification, fraud score, policy branch, RMA/label, manual review          | Needs `ON_RESULT` and policy branches, not only handoff.                      |
| Prior auth               | Formulary lookup, criteria check, clinical info, decision, P2P                       | Needs rule-engine/tool result branching and audit.                            |
| Government benefits      | Multilingual intake, proof upload, scoring, submission                               | Needs language routing plus document upload/tool decisions.                   |
| Cybersec/DevOps incident | Alert parse, severity, page, status page, timeline, postmortem                       | Needs API/event entry, sidecar logging, approvals for containment.            |
| Real estate closing      | Milestone state machine, reminders, appointments, deadline alerts                    | Needs long-running workflow state.                                            |
| HR review cycle          | Multi-role feedback, reminders, aggregation, comp calc                               | Needs role-aware state and sensitive data guardrails.                         |
| Multilingual support     | Language detect, regional/off-hours route, translation, sentiment escalation         | Needs language/region/time-zone variables and valid dynamic routing strategy. |
| Meal planning            | Profile, plan, grocery aggregation, swaps, macros                                    | Needs generated plan plus deterministic grocery/macro tool calls.             |
| Crypto AML               | Stream ingest, pattern detection, sanctions, case, SAR, deadlines                    | Needs event workflow, analyst queue, audit/deadline sidecars.                 |

## Validation Rules We Need

These should become hard errors or high-severity warnings before deterministic rendering:

1. **Tool-required scenario without tool calls**
   - If spec mentions lookup, search, book, create, update, send, score, upload, parse, classify,
     schedule, submit, approve, deny, invite, connect, or export, at least one matching tool call
     must appear unless the blueprint explicitly marks it as future/unconfigured.

2. **Scripted or hybrid agent without flow**
   - If an agent is selected as `scripted`, it should have `FLOW`.
   - If an agent is selected as `hybrid`, it should have either `FLOW` with reasoning zones or a
     clear reason why reasoning-only is sufficient.

3. **Tool output used without alias/state**
   - Any response, completion, handoff, delegate, or CEL condition that depends on tool output must
     have a `CALL ... AS` alias and/or a `SET` assignment.

4. **Gather where tool should be used**
   - Asking the user for order status, policy result, fraud score, eligibility result, appointment
     availability, or account state should be flagged if a matching tool exists.

5. **Return contract mismatch**
   - `RETURN: true` target must have reachable completion and declared/set/gathered return values.

6. **Escalation without packet or exit**
   - Escalation agents need packet fields and a terminal path.

7. **Pipeline without state**
   - Multi-stage, resumable, or long-running workflows need workflow state fields.

8. **High-impact action without confirmation**
   - Money, booking, medical escalation, credit pull, containment, legal export, application submit,
     or regulatory filing should require confirmation unless the user request is already the
     confirmation and context is explicit.

9. **Channel declared but not addressable**
   - Project creation should create/link at least one channel connection or report a clear setup task.

10. **Language/channel requirement unused**
    - Multilingual/voice/SMS/Slack/WhatsApp/API requirements should appear in plan and runtime setup,
      not only in blueprint prose.

11. **Compliance only in persona**
    - Audit, PII, HIPAA, PCI, KYC, AML, COPPA, FERPA, GDPR, TILA/RESPA, SOC2, or WORM requirements
      should map to constraints, guardrails, logging tools, minimization, or escalation.

12. **Unsupported construct hallucination**
    - Reject `MODE`, `STATE`, `FOR_EACH`, `WHILE`, `PARALLEL`, `human_approval`, and unsupported
      namespaces. Use runtime-supported alternatives from `platform-limits.ts`.

## Required Planning Additions

### 1. OrchestrationPatternPlan

Add a project-level runtime pattern plan separate from topology shape.

```ts
interface OrchestrationPatternPlan {
  primaryPattern:
    | 'single_responder'
    | 'triage_router'
    | 'tool_lookup'
    | 'transactional_action'
    | 'policy_decision'
    | 'pipeline_workflow'
    | 'approval_gated'
    | 'long_running_state_machine'
    | 'event_api_workflow'
    | 'document_pipeline'
    | 'multilingual_channel_router'
    | 'human_escalation'
    | 'observer_audit_sidecar';
  secondaryPatterns: string[];
  requiredRuntimeCapabilities: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'regulated';
  rationale: string[];
}
```

### 2. AgentBehaviorProfile

Each agent needs a behavior profile before ABL render.

```ts
interface AgentBehaviorProfile {
  agentName: string;
  responsibility:
    | 'answer'
    | 'route'
    | 'collect'
    | 'lookup'
    | 'transact'
    | 'decide'
    | 'observe'
    | 'escalate'
    | 'coordinate';
  executionMode: 'reasoning' | 'scripted' | 'hybrid';
  mustUseFlow: boolean;
  mustUseTool: boolean;
  mustConfirmAction: boolean;
  mustReturnToParent: boolean;
  mustMaintainState: boolean;
  mustCreateAuditTrail: boolean;
  unsupportedNotes: string[];
}
```

### 3. Construct completeness score

Add a score that measures whether generated constructs match scenario requirements:

- topology fit
- mode fit
- tool-call fit
- flow fit
- state/resume fit
- handoff/delegate/return fit
- escalation fit
- compliance fit
- channel fit
- unsupported construct avoidance

This score should be visible in eval output and build diagnostics.

## Practical Implementation Order

1. Add heuristic classifier from spec text plus blueprint to `OrchestrationPatternPlan`.
2. Derive `AgentBehaviorProfile` for every agent.
3. Add intelligence validators to fail obvious under-specified agents before render.
4. Extend `AgentConstructPlan` derivation for deterministic defaults:
   - terminal escalation completion
   - simple tool lookup flow
   - transactional call with confirmation
   - policy branch from tool result
   - returnable child completion
5. Extend renderer to emit construct-plan `FLOW`, `CALL`, `SET`, `DELEGATE`, and `ESCALATE`.
6. Only after deterministic coverage exists, add optional per-agent structured LLM planning for
   complex cases.
7. Re-run 20 project creations and mutation flows with construct completeness scoring.

## Design Principle

Arch AI should not generate every possible ABL construct. It should generate the smallest supported
construct set that satisfies the business requirement.

The target is not "more complex agents." The target is correct intelligence:

- reasoning when judgment/explanation is the work,
- scripted flow when sequence/action/validation is the work,
- hybrid when judgment and deterministic action both matter,
- handoff when another agent owns the conversation,
- delegate when the parent owns the workflow and needs a result,
- escalate when automation should stop or package a human-review case,
- complete when the agent has fulfilled its contract.
