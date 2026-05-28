# ABLP-612 / ABLP-541 Transcript and DSL Test Cases

Date reviewed: 2026-04-27

## Executive Summary

ABLP-541 and ABLP-612 are related through the broader supervisor routing experience, but they are not the same defect.

ABLP-541 is about turn-by-turn supervisor re-triage after a child agent was invoked with `RETURN: true`. A fix was shipped in commit `50a15e24f` so a follow-up user turn can return to the parent supervisor before the active child/gather step consumes the input.

ABLP-559, which is linked from ABLP-612, fixed two button plumbing defects:

- Studio originally sent button clicks as plain text like `__action__:agent_a:agent_a`.
- Runtime later still failed to dispatch valid `action_submit` events when a flow step combined `RESPOND + ACTIONS + ON_ACTION + ON_INPUT`.

ABLP-612 is the remaining product gap: even when button events reach Runtime and `ON_ACTION` dispatch works, the action handler DSL only supports `SET`, `RESPOND`, `TRANSITION`, and `CONDITION`. It does not parse, compile, or execute `HANDOFF` or `DELEGATE` inside an `ON_ACTION` handler.

Current code evidence:

- `packages/core/src/parser/agent-based-parser.ts` `parseOnActionBlock()` only handles `RESPOND`, `TRANSITION`, `CONDITION`, and `SET`.
- `packages/core/src/types/agent-based.ts` `ActionHandlerAST` has no `handoff` or `delegate` field.
- `packages/compiler/src/platform/ir/schema.ts` `ActionHandlerIR` has no `handoff` or `delegate` field.
- `packages/compiler/src/platform/ir/compiler.ts` `compileActionHandlers()` maps only `action_id`, `condition`, `respond`, `voice_config`, `rich_content`, `set`, and `transition`.
- `apps/runtime/src/services/execution/flow-step-executor.ts` action handler execution applies `set`, emits `respond`, and handles `transition`; it does not call routing for handler-level `handoff` or `delegate`.

## Full Issue Transcript

### ABLP-612

Title: ON_ACTION handlers need HANDOFF/DELEGATE support for button-driven agent routing

Status: To Do

Reporter: Prakash Rochkari

Assignee: Prasanna Arikala

Created: 2026-04-27 12:44:01 +0530

Updated: 2026-04-27 12:45:05 +0530

Description:

```text
ON_ACTION handlers in flow steps cannot trigger HANDOFF or DELEGATE to other agents. This prevents a common multi-agent pattern where a supervisor presents buttons and routes to the selected agent based on the button click.

Customer use case:
A supervisor agent shows two buttons ("Agent A" and "Agent B"). When the user clicks a button, the supervisor should hand off to the corresponding agent. This is a standard routing pattern for multi-agent systems with guided navigation.

Current ON_ACTION capabilities:
- SET — assign variables
- RESPOND — send a message
- TRANSITION — move to another flow step
- CONDITION — conditional execution

Missing: HANDOFF, DELEGATE

All four approaches fail. The FLOW execution engine and the routing/coordination engine (HANDOFF/DELEGATE) are not connected — there is no bridge for a flow action to trigger a coordination action.

Root cause (code analysis):
- Parser (packages/core/src/parser/agent-based-parser.ts:6863) — ON_ACTION handler parser only accepts SET, RESPOND, TRANSITION, CONDITION in the switch statement. HANDOFF/DELEGATE keywords are silently ignored.
- AST Type (packages/core/src/types/agent-based.ts:228-236) — ActionHandlerAST has no handoff or delegate field:
interface ActionHandlerAST {
  actionId: string;
  condition?: string;
  respond?: string;
  set?: Record<string, string>;
  transition?: string;
  // Missing: handoff?: string; delegate?: string;
}
- IR Schema (packages/compiler/src/platform/ir/schema.ts:189-197) — ActionHandlerIR mirrors the same limitation — no handoff/delegate field.
- Runtime (apps/runtime/src/services/execution/flow-step-executor.ts:4994-5027) — Action handler execution only processes SET → RESPOND → TRANSITION. No code path exists to dispatch a handoff to the routing engine.

Proposed implementation:
- Parser — Add case 'HANDOFF': and case 'DELEGATE': to parseOnActionBlock() at line 6863
- Types — Add handoff?: string and delegate?: string to ActionHandlerAST and ActionHandlerIR
- Compiler — Map the new AST fields to IR during compilation
- Runtime — After the TRANSITION block in flow-step-executor (line 5019), add a HANDOFF execution path that returns { action: { type: 'handoff', target: handler.handoff } } to the routing engine

Expected DSL syntax after implementation:
ON_ACTION:
  agent_a:
    SET: selected_agent = "Agent_A"
    RESPOND: "Routing to Agent A..."
    HANDOFF: Agent_A
  agent_b:
    SET: selected_agent = "Agent_B"
    RESPOND: "Routing to Agent B..."
    HANDOFF: Agent_B

Impact:
Blocks button-driven multi-agent routing — a core pattern for guided supervisor UX. Customers building interactive agent selection flows cannot use buttons to trigger handoffs.
```

Comments:

```text
Prakash Rochkari, 2026-04-27 12:44:54 +0530
@Subash Mourougayane
```

Linked issue:

- ABLP-559: Buttons render, but click events are sent as plain text (`__action__:<id>:<value>`) instead of real `action_submit` events. Runtime treats them as normal input, so `ON_ACTION` never fires and flow falls into `ON_INPUT`/fallback.

### ABLP-541

Title: Supervisor Fails to Re-Triage on Follow-up

Status: To Do

Reporter: Prathyusha Gopavaram

Assignee: Prasanna Arikala

Created: 2026-04-23 19:47:35 +0530

Updated: 2026-04-27 13:53:36 +0530

Description:

```text
The Supervisor pattern is failing to re-evaluate agent selection on the second turn of a conversation. While the first interaction correctly routes to the DatabaseQueryAgent, the subsequent follow-up—which requires the DatabaseSearchAgent—incorrectly defaults to the previous agent or bypasses the Supervisor’s LLM decision logic entirely.

Current Behavior
- Turn 1: User asks a structured data question -> Supervisor correctly selects DatabaseQueryAgent -> Correct Response.
- Turn 2: User asks a document-based question -> System bypasses Supervisor LLM call -> System automatically triggers DatabaseQueryAgent again.

Expected Behavior
Every new user input should trigger the Supervisor Agent to perform a new triage step. The Supervisor should recognize the change in context and route the second query to the DatabaseSearchAgent.
```

Comment transcript:

```text
Prasanna Arikala, 2026-04-24 12:25:56 +0530

Shipped
- Runtime now runs the parent-supervisor reroute check before gather-field acceptance on active RETURN:true child threads.
- Added the exact two-turn API regression for the reported repro:
- i need help with my card payment
- search the database for invoice 42
- Pushed to develop as commit 50a15e24f.

Verification
- pnpm --filter @agent-platform/runtime build
- pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/execution/flow-step-executor-classifier-first.test.ts
- pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism src/__tests__/e2e/ablp-541-parent-reroute-before-gather.e2e.test.ts
- pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/execution/flow-gather-lock.test.ts src/__tests__/execution/flow-step-executor-trace-consistency.test.ts
- pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism src/__tests__/e2e/gather-interrupt-semantic-routing.e2e.test.ts
- pnpm studio:video:evidence -- --scenario ablp-runtime-regressions --issue ABLP-541
- Studio evidence passed: the second turn rerouted to the database child instead of being consumed as card_last4.

Remaining follow-up
- Attached evidence files: manifest.json, the Studio .mp4 capture, and the reroute outcome screenshot.
```

```text
Prathyusha Gopavaram, 2026-04-27 13:49:07 +0530

@Prasanna Arikala
I have revalidate in dev and the experience still seems to be the same.

DSL
SUPERVISOR: ContractTriage
VERSION: "1.0"
DESCRIPTION: "First-contact triage — routes contract queries to DocumentSearchAgent (content) or DatabaseQueryAgent (metadata only)"
GOAL: "Greet users, understand their contract-related query, and route to the right specialist. DocumentSearchAgent handles anything about the content, language, clauses, terms, obligations, or summarization of contracts — including queries that reference a specific contract or party by name. DatabaseQueryAgent handles ONLY pure structured metadata lookups (counts, dates, status lists, totals) where the user is NOT asking about anything inside the document. Escalate to HumanEscalationAgent when ambiguous, sensitive, or unclassifiable."

PERSONA: |
  You are ContractAssist, a professional contracts assistant on Web Chat and Voice.
  You understand whether the user wants contract content (clauses, terms, summaries)
  or contract metadata (dates, parties, and statuses), and you route
  to the right specialist. You never answer contract questions yourself.

LIMITATIONS:
  - "Cannot answer contract questions directly — always delegates to a specialist"
  - "Cannot override escalation to a human agent once triggered"

GUARDRAILS:
  content_safety:
    kind: input
    tier: 1
    check: "Block harmful, abusive, or legally threatening content"
    action: block
    threshold: 0.8

MEMORY:
  session:
    - user_query
    - detected_intent
    - routing_attempts

ON_START:
  - RESPOND: "Hello! I'm ContractAssist. I can search contract documents for specific clauses, terms, or summaries, or look up structured contract metadata like dates, parties, and statuses. What would you like to know?"

# Routing is resolved by the LLM via per-agent handoff tools. Priority = array order.
# Duplicate handoffs to the same target are deduplicated (first wins), so each agent
# appears exactly once with a complete, self-contained WHEN description.
HANDOFF:
  - TO: DocumentSearchAgent
    WHEN: user asks about ANY content inside a contract document — clauses, terms, obligations, liability caps, indemnification, warranties, payment terms, definitions, renewal/termination language — OR asks to summarise, analyse, review, or explain one or more contracts. Applies even when the user names a specific contract or party as a filter, and even when the request implies first listing contracts and then summarising them (DocumentSearchAgent can retrieve and summarise in one step).
    CONTEXT:
      summary: "Search contract document content for clauses, terms, obligations, or summaries. Accepts a party or contract name as a filter directly — no database pre-lookup needed."
    RETURN: true
    ON_RETURN:
      action : resume_intent

  - TO: DatabaseQueryAgent
    WHEN: user asks ONLY about structured metadata — counts of contracts, lists of contract IDs/names, effective/expiry/renewal dates, party names, total values, or status — and is NOT asking about any language, clause, obligation, or other content inside the document, and is NOT asking for a summary or analysis.
    CONTEXT:
      summary: "Query structured contract metadata only (dates, parties, values, statuses, counts). Do NOT use when the question touches content inside a document."
    RETURN: true
    ON_RETURN:
      action : resume_intent

  - TO: HumanEscalationAgent
    WHEN: user is frustrated, query is ambiguous or sensitive, involves legal disputes, or cannot be confidently classified
    CONTEXT:
      summary: "Escalating to human agent"
    RETURN: false

ESCALATE:
  triggers:
    - WHEN: user.is_frustrated == true OR user.requests_human == true
      REASON: "User requested human assistance or is showing signs of frustration"
      PRIORITY: 1
      TAGS: [human_request, sentiment]
    - WHEN: routing_attempts >= 3
      REASON: "Multiple routing failures — unable to classify request automatically"
      PRIORITY: 1
      TAGS: [routing_failure]

ON_ERROR:
  routing_failure:
    RESPOND: "I'm having trouble routing your request. Let me try once more — otherwise I'll connect you with someone who can help directly."
    RETRY: 1
    THEN: ESCALATE
  agent_unavailable:
    RESPOND: "That specialist service is temporarily unavailable. Please try again in a moment."
    RETRY: 2
    THEN: ESCALATE
  timeout:
    RESPOND: "This is taking longer than expected. Let me try again."
    RETRY: 1
    THEN: CONTINUE

COMPLETE:
  - WHEN: true
    RESPOND: "Is there anything else I can help you with regarding your contracts?"
```

### ABLP-559 Linked Context

ABLP-559 matters because it explains why button routing failed before ABLP-612:

1. Studio sent fake text messages for clicks instead of typed `action_submit`.
2. Runtime did not arm `ON_ACTION` correctly when `ON_INPUT` fallback existed on the same prompt step.
3. Both were later marked fixed with commits `7d404127f` and `178ff0039`.

The final shipped summary on ABLP-559 says the current button plumbing should now pass:

```text
Root cause: ABLP-559 had two layers: the original Studio transport bug sent legacy plain-text __action__ messages instead of action_submit, and Prakash later found a Runtime partial-fix gap where valid action_submit events still fell through to ON_INPUT fallback because the RESPOND + ACTIONS + ON_ACTION + ON_INPUT step was not armed as waiting_for_action.

Fix: Studio sends first-class action_submit websocket frames, and Runtime now arms/dispatches interactive ON_ACTION handlers even when the same step also has an ON_INPUT fallback. Matching action handlers win, set selected_agent, transition to selection_result, and clear the fallback wait markers.

Review comment coverage: Covered Prakash Rochkari review comment from 2026-04-25: the HandoffTest DSL now clicks Agent A and renders Selected: Agent_A instead of re-prompting Please click Agent A or Agent B.
```

## What Is Going On

There are three layers, and each layer has a different failure mode.

1. Button event transport: fixed by ABLP-559.
   Studio should send a real WebSocket `action_submit` frame with `actionId` and `value`, not a user text message containing `__action__`.

2. Flow action dispatch: fixed by ABLP-559.
   Runtime should enter the matching `ON_ACTION` handler even if the same step also has `ON_INPUT` fallback.

3. Coordination from an action handler: still missing in ABLP-612.
   A matching `ON_ACTION` handler can do local flow operations, but it cannot call the coordination/routing engine with `HANDOFF` or `DELEGATE`.

ABLP-541 is adjacent because it is also supervisor routing, but its core bug is different: the active child thread/gather state could swallow a follow-up before the parent supervisor had a chance to re-triage. The shipped ABLP-541 fix handles one class of active-child reroute. The dev revalidation DSL should be tested as a contract triage scenario, because it may expose either a deployment gap, classifier/routing ambiguity, or a different child-return/resume-intent behavior than the original card/invoice regression.

## DSL-Based Test Cases

### Test Case 1: ABLP-612 Parser Preserves `HANDOFF` in `ON_ACTION`

Purpose: prove the DSL parser no longer silently drops `HANDOFF` inside `ON_ACTION`.

DSL:

```abl
SUPERVISOR: ButtonRouter
GOAL: "Route to a selected specialist by button click."

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose a specialist."
    ACTIONS:
      - BUTTON: "Agent A" -> agent_a
      - BUTTON: "Agent B" -> agent_b

  ON_ACTION:
    agent_a:
      SET: selected_agent = "Agent_A"
      RESPOND: "Routing to Agent A..."
      HANDOFF: Agent_A
    agent_b:
      SET: selected_agent = "Agent_B"
      RESPOND: "Routing to Agent B..."
      HANDOFF: Agent_B
```

Expected assertions:

- Parsed `ActionHandlerAST` for `agent_a` includes `handoff: "Agent_A"`.
- Parsed `ActionHandlerAST` for `agent_b` includes `handoff: "Agent_B"`.
- Existing fields still parse: `set`, `respond`.
- No warning-only silent drop of `HANDOFF`.

Suggested test location:

- `packages/core/src/__tests__/parser/actions-carousel-parsing.test.ts`, or a new focused parser test near existing `ON_ACTION` parser coverage.

### Test Case 2: ABLP-612 Compiler Emits `handoff` in `ActionHandlerIR`

Purpose: prove the AST-to-IR bridge carries handler-level coordination fields.

Use the same DSL as Test Case 1.

Expected assertions:

- `agent.flow.steps.menu.on_action[0].action_id === "agent_a"`.
- `agent.flow.steps.menu.on_action[0].handoff === "Agent_A"`.
- `agent.flow.steps.menu.on_action[1].handoff === "Agent_B"`.
- Existing fields still compile: `set`, `respond`.

Suggested test location:

- `packages/compiler/src/__tests__/ir/actions-carousel-compilation.test.ts`.

### Test Case 3: ABLP-612 Runtime Executes Button `HANDOFF`

Purpose: prove a real `action_submit` event can drive a handoff from a flow action handler.

DSL:

```abl
SUPERVISOR: ButtonRouter
GOAL: "Route to a selected specialist by button click."

HANDOFF:
  - TO: Agent_A
    WHEN: user selected Agent A
    CONTEXT:
      summary: "User selected Agent A from a button menu."
    RETURN: false
  - TO: Agent_B
    WHEN: user selected Agent B
    CONTEXT:
      summary: "User selected Agent B from a button menu."
    RETURN: false

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose a specialist."
    ACTIONS:
      - BUTTON: "Agent A" -> agent_a
      - BUTTON: "Agent B" -> agent_b

  ON_ACTION:
    agent_a:
      SET: selected_agent = "Agent_A"
      RESPOND: "Routing to Agent A..."
      HANDOFF: Agent_A
    agent_b:
      SET: selected_agent = "Agent_B"
      RESPOND: "Routing to Agent B..."
      HANDOFF: Agent_B

AGENT: Agent_A
GOAL: "Handle Agent A requests."
PERSONA: "Agent A"
ON_START:
  - RESPOND: "Agent A is now handling this."
COMPLETE:
  - WHEN: true
    RESPOND: "Agent A done."

AGENT: Agent_B
GOAL: "Handle Agent B requests."
PERSONA: "Agent B"
ON_START:
  - RESPOND: "Agent B is now handling this."
COMPLETE:
  - WHEN: true
    RESPOND: "Agent B done."
```

Execution:

1. Initialize session with `ButtonRouter`.
2. Assert initial result action is `waiting_for_action` and buttons include `agent_a` and `agent_b`.
3. Send `actionEvent: { actionId: "agent_a", value: "agent_a" }`.

Expected assertions:

- `selected_agent` becomes `"Agent_A"` or resolved `Agent_A` depending on existing SET expression semantics.
- Result action is `handoff` with target `Agent_A`, or the session active thread is `Agent_A` after routing execution.
- Trace includes `action_handler_executed` for `agent_a`.
- Trace includes `handoff` from `ButtonRouter` to `Agent_A`.
- No `ON_INPUT` fallback prompt appears.

Suggested test location:

- `apps/runtime/src/__tests__/action-handlers.e2e.test.ts`, near the existing step-level `ON_ACTION` regression guard.

### Test Case 4: ABLP-612 Runtime Executes Button `DELEGATE`

Purpose: prove handler-level `DELEGATE` takes the same bridge as handoff/delegation coordination.

DSL:

```abl
SUPERVISOR: ButtonDelegateRouter
GOAL: "Delegate to a selected specialist by button click."

DELEGATE:
  - AGENT: Agent_A
    WHEN: user selected Agent A
    PURPOSE: "Let Agent A process the selected option."
    INPUT:
      selected_agent: selected_agent
    RETURNS:
      result: string
    USE_RESULT: true

FLOW:
  entry_point: menu
  steps:
    - menu
    - done

menu:
  REASONING: false
  RESPOND: "Choose a specialist."
    ACTIONS:
      - BUTTON: "Agent A" -> agent_a

  ON_ACTION:
    agent_a:
      SET: selected_agent = "Agent_A"
      RESPOND: "Delegating to Agent A..."
      DELEGATE: Agent_A
      TRANSITION: done

done:
  REASONING: false
  RESPOND: "Delegation result: {{result}}"
  THEN: COMPLETE

AGENT: Agent_A
GOAL: "Return a delegate result."
PERSONA: "Agent A"
COMPLETE:
  - WHEN: true
    RESPOND: "Agent A delegate result."
```

Expected assertions:

- Parsed and compiled handler contains `delegate: "Agent_A"`.
- Runtime action handler invokes the delegate path.
- Parent receives/continues with delegate output according to existing `DELEGATE` result semantics.
- Existing `SET` and `RESPOND` still execute before coordination.

Note: this test may need adjustment after confirming the runtime's exact `DELEGATE` execution helper signature. Read the source before wiring the implementation.

### Test Case 5: ABLP-612 Button Handoff With `ON_INPUT` Fallback

Purpose: lock the ABLP-559 fix together with the new ABLP-612 behavior.

DSL:

```abl
SUPERVISOR: ButtonRouterWithFallback
GOAL: "Route only button clicks; re-prompt typed input."

HANDOFF:
  - TO: Agent_A
    WHEN: user selected Agent A
    CONTEXT:
      summary: "User selected Agent A."
    RETURN: false

FLOW:
  entry_point: menu
  steps:
    - menu

menu:
  REASONING: false
  RESPOND: "Choose a specialist."
    ACTIONS:
      - BUTTON: "Agent A" -> agent_a

  ON_ACTION:
    agent_a:
      RESPOND: "Routing to Agent A..."
      HANDOFF: Agent_A

  ON_INPUT:
    - ELSE:
        RESPOND: "Please click Agent A."
        THEN: menu

AGENT: Agent_A
GOAL: "Handle Agent A requests."
PERSONA: "Agent A"
COMPLETE:
  - WHEN: true
    RESPOND: "Agent A done."
```

Expected assertions:

- Initial prompt returns `waiting_for_action`.
- Text input like `"hello"` triggers `ON_INPUT` fallback.
- `actionEvent: { actionId: "agent_a" }` triggers `ON_ACTION` and handoff.
- The fallback response `"Please click Agent A."` is not emitted on button click.

### Test Case 6: ABLP-541 Contract Triage Re-Routes on Follow-Up

Purpose: reproduce Prathyusha's dev revalidation report with the actual contract-domain DSL shape, not the earlier card/invoice surrogate.

Supervisor DSL:

```abl
SUPERVISOR: ContractTriage
VERSION: "1.0"
DESCRIPTION: "First-contact triage — routes contract queries to DocumentSearchAgent (content) or DatabaseQueryAgent (metadata only)"
GOAL: "Greet users, understand their contract-related query, and route to the right specialist. DocumentSearchAgent handles anything about the content, language, clauses, terms, obligations, or summarization of contracts — including queries that reference a specific contract or party by name. DatabaseQueryAgent handles ONLY pure structured metadata lookups (counts, dates, status lists, totals) where the user is NOT asking about anything inside the document. Escalate to HumanEscalationAgent when ambiguous, sensitive, or unclassifiable."

PERSONA: |
  You are ContractAssist, a professional contracts assistant on Web Chat and Voice.
  You understand whether the user wants contract content (clauses, terms, summaries)
  or contract metadata (dates, parties, values, statuses, counts), and you route
  to the right specialist. You never answer contract questions yourself.

MEMORY:
  session:
    - user_query
    - detected_intent
    - routing_attempts

ON_START:
  - RESPOND: "Hello! I'm ContractAssist. What would you like to know?"

HANDOFF:
  - TO: DocumentSearchAgent
    WHEN: user asks about ANY content inside a contract document — clauses, terms, obligations, liability caps, indemnification, warranties, payment terms, definitions, renewal/termination language — OR asks to summarise, analyse, review, or explain one or more contracts. Applies even when the user names a specific contract or party as a filter.
    CONTEXT:
      summary: "Search contract document content for clauses, terms, obligations, or summaries."
    RETURN: true
    ON_RETURN:
      action: resume_intent

  - TO: DatabaseQueryAgent
    WHEN: user asks ONLY about structured metadata — counts of contracts, lists of contract IDs/names, effective/expiry/renewal dates, party names, total values, or status — and is NOT asking about any language, clause, obligation, or other content inside the document, and is NOT asking for a summary or analysis.
    CONTEXT:
      summary: "Query structured contract metadata only."
    RETURN: true
    ON_RETURN:
      action: resume_intent

  - TO: HumanEscalationAgent
    WHEN: user is frustrated, query is ambiguous or sensitive, involves legal disputes, or cannot be confidently classified
    CONTEXT:
      summary: "Escalating to human agent"
    RETURN: false

COMPLETE:
  - WHEN: true
    RESPOND: "Is there anything else I can help you with regarding your contracts?"
```

Child agent fixtures:

```abl
AGENT: DatabaseQueryAgent
GOAL: "Answer structured contract metadata questions only."
PERSONA: "Metadata specialist."

FLOW:
  entry_point: answer
  steps:
    - answer

answer:
  REASONING: false
  RESPOND: "DatabaseQueryAgent handled metadata."
  THEN: COMPLETE
```

```abl
AGENT: DocumentSearchAgent
GOAL: "Answer contract document content questions only."
PERSONA: "Document search specialist."

FLOW:
  entry_point: answer
  steps:
    - answer

answer:
  REASONING: false
  RESPOND: "DocumentSearchAgent handled document content."
  THEN: COMPLETE
```

```abl
AGENT: HumanEscalationAgent
GOAL: "Escalate ambiguous or sensitive requests."
PERSONA: "Human escalation."
COMPLETE:
  - WHEN: true
    RESPOND: "Escalating to a human."
```

Execution:

1. Turn 1 user message: `"List active contracts expiring next quarter."`
2. Expected turn 1 route: `DatabaseQueryAgent`.
3. Turn 2 user message in the same session: `"Summarize the liability clause in the Acme contract."`
4. Expected turn 2 route: `DocumentSearchAgent`.

Expected assertions:

- Turn 2 produces a new supervisor routing decision rather than staying pinned to `DatabaseQueryAgent`.
- Trace includes a parent/supervisor reroute or handoff decision targeting `DocumentSearchAgent`.
- Turn 2 does not execute a DatabaseQueryAgent flow response.
- If the classifier chooses incorrectly, trace should expose classifier categories/scores for diagnosis.

### Test Case 7: ABLP-541 Same Target Follow-Up Does Not Over-Reroute

Purpose: make sure the reroute fix does not break normal multi-turn continuity when the second user turn still belongs to the same child agent.

Execution:

1. Turn 1: `"List active contracts expiring next quarter."`
2. Expected route: `DatabaseQueryAgent`.
3. Turn 2: `"Also include the total contract value by party."`
4. Expected route: `DatabaseQueryAgent`.

Expected assertions:

- Turn 2 may re-triage, but final target remains `DatabaseQueryAgent`.
- No false escalation to `DocumentSearchAgent`.
- No duplicate/looping `resume_intent` replay.

### Test Case 8: ABLP-541 Content Query With Named Party Goes Directly to Document Search

Purpose: cover the important WHEN text in the reported DSL: naming a party or contract should not force a metadata pre-lookup if the user asks about document content.

Execution:

1. Turn 1: `"For the Acme agreement, explain the renewal terms."`

Expected assertions:

- Route target is `DocumentSearchAgent`.
- Route target is not `DatabaseQueryAgent`.
- Trace/category reason mentions content/terms/renewal, not metadata lookup.

## Recommended Implementation Order

1. Add parser/compiler tests for `ON_ACTION` `HANDOFF` and `DELEGATE`; they should fail today and define the contract.
2. Add runtime E2E for button `HANDOFF` without `ON_INPUT` fallback.
3. Add runtime E2E for button `HANDOFF` with `ON_INPUT` fallback.
4. Add or adapt the ABLP-541 contract-triage E2E using Prathyusha's DSL shape.
5. Implement ABLP-612 through parser, AST, IR, compiler, and runtime coordination dispatch.
6. Re-run existing ABLP-559 and ABLP-541 tests to guard against regressions.

Suggested verification commands after implementation:

```bash
pnpm build --filter=@abl/core --filter=@abl/compiler --filter=@agent-platform/runtime
pnpm --filter @abl/core test -- src/__tests__/parser/actions-carousel-parsing.test.ts
pnpm --filter @abl/compiler test -- src/__tests__/ir/actions-carousel-compilation.test.ts
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts --maxWorkers=1 src/__tests__/action-handlers.e2e.test.ts
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.e2e.config.ts --maxWorkers=1 --no-file-parallelism src/__tests__/e2e/ablp-541-parent-reroute-before-gather.e2e.test.ts
```
