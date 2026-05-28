# Arch Blueprint Runtime Construct Scenarios Audit

Date: 2026-05-12

Purpose: capture the runtime decision cases Arch must understand before we shift BUILD from free-form ABL generation to blueprint-driven construct modeling and deterministic rendering.

This is not a mandate that every generated agent must use every construct. The goal is the opposite: select only the constructs required by the use case, then make each selected construct runtime-valid.

## Source Grounding

This audit is grounded in current code and tests:

- `apps/studio/src/lib/arch-ai/handbook-reference.ts`
- `apps/studio/src/lib/arch-ai/abl-reference.ts`
- `apps/studio/src/lib/arch-ai/build-parallel-gen.ts`
- `apps/studio/src/lib/arch-ai/build-requirement-inference.ts`
- `packages/arch-ai/src/prompts/phases/build.ts`
- `packages/core/src/types/agent-based.ts`
- `packages/core/src/parser/agent-based-parser.ts`
- `packages/compiler/src/platform/ir/schema.ts`
- `packages/compiler/src/platform/ir/compiler.ts`
- `packages/compiler/src/platform/ir/validate-ir.ts`
- `packages/compiler/src/platform/runtimes/base-runtime.ts`
- `packages/compiler/src/platform/runtimes/digital-runtime.ts`
- `packages/compiler/src/platform/runtimes/workflow-runtime.ts`
- `packages/compiler/src/platform/constructs/types.ts`
- `packages/compiler/src/platform/constructs/executors/flow-executor.ts`
- `packages/compiler/src/platform/constructs/executors/gather-executor.ts`
- `packages/compiler/src/platform/constructs/executors/complete-executor.ts`
- `packages/compiler/src/platform/constructs/executors/handoff-executor.ts`
- `packages/compiler/src/platform/constructs/executors/delegate-executor.ts`
- `packages/compiler/src/platform/constructs/executors/constraint-executor.ts`
- `packages/compiler/src/__tests__/graph-extractor-integration.test.ts`
- `packages/compiler/src/__tests__/handoff-return-handlers-compilation.test.ts`
- `packages/compiler/src/__tests__/validate-coordination-config.test.ts`
- `packages/compiler/src/__tests__/constructs/cel-evaluator.test.ts`
- `packages/compiler/src/__tests__/template-resolution.test.ts`
- `packages/compiler/src/__tests__/await-attachment-compilation.test.ts`
- `packages/compiler/src/__tests__/error-handler-enhanced.test.ts`
- `packages/compiler/src/__tests__/validate-field-refs.test.ts`
- `packages/compiler/src/__tests__/validate-flow-runtime-semantics.test.ts`
- `packages/compiler/src/__tests__/ir/dsl-extensions-ir.test.ts`
- `packages/compiler/src/__tests__/remote-agent-coordination.test.ts`
- `packages/arch-ai/src/__tests__/diagnostics/semantic-validators.test.ts`

## Runtime Support Labels

Use these labels when turning the audit into blueprint schema, renderer rules, or eval fixtures:

- **Supported**: parser/compiler/IR/runtime or runtime executor evidence exists in code.
- **Compiler-supported**: parser/compiler/IR/validation evidence exists, but runtime behavior should be smoke-tested before Arch generates it broadly.
- **Diagnostic-supported**: Arch diagnostics validate the shape, but runtime implementation still needs an execution proof.
- **Caveat**: supported only for a narrow form, compatibility path, or with known runtime warnings.
- **Do not generate yet**: type or docs mention exists, but parser/runtime evidence is not enough for autonomous generation.

## Runtime Support Matrix

| Area                          | Status                 | Arch generation stance                                                                                                                                |
| ----------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reasoning-only agent          | Supported              | Use for simple conversational agents with no required deterministic sequencing.                                                                       |
| `FLOW` scripted agent         | Supported              | Use when order, branching, tool calls, or completion must be deterministic.                                                                           |
| Reasoning zone in `FLOW`      | Supported with caveat  | Use only when a step genuinely needs LLM reasoning; every step still needs `REASONING: true/false`. Avoid post-step mutations unless timing is clear. |
| Top-level `GATHER`            | Supported              | Use for reusable agent-level facts.                                                                                                                   |
| Flow-step `GATHER`            | Supported              | Use for step-scoped collection. Avoid mixing with `ON_INPUT` unless order is deliberate.                                                              |
| `GATHER` activation/depends   | Supported              | Use for optional/progressive fields; all activation expressions need declared variables.                                                              |
| `GATHER` validation/PII       | Supported              | Use field-level validation, retry prompts, sensitive display, and PII type hints when required.                                                       |
| Attachments top-level         | Supported              | Use when file/media is an agent requirement.                                                                                                          |
| `AWAIT_ATTACHMENT` in `FLOW`  | Compiler-supported     | Parser/compiler/validation exist; use only with a runtime smoke test for the target channel.                                                          |
| Tool contracts                | Supported              | Agent DSL can declare tool signatures; concrete bindings are project tools or tool files.                                                             |
| Tool bindings                 | Supported              | HTTP/MCP/lambda/sandbox/workflow/searchai/async webhook surfaces exist; generate only bindings that the project can provision.                        |
| `CALL WITH/AS`                | Supported              | Preferred renderer form for new generation.                                                                                                           |
| `CALL: tool(args)`            | Supported/compat       | Existing tests compile it; prefer `WITH`/`AS` for clarity.                                                                                            |
| `ON_SUCCESS`/`ON_FAIL`        | Supported              | Use for binary call success/failure paths.                                                                                                            |
| `ON_RESULT` flow branches     | Compiler-supported     | IR and graph validation exist; use when multi-way branching is needed, then smoke-test runtime behavior.                                              |
| Tool `ON_RESULT`/`ON_ERROR`   | Compiler-supported     | Tool-file parser and compiler preserve mappings; verify runtime executor applies them before broad generation.                                        |
| `SET`/`CLEAR`                 | Supported              | Use for explicit session/context state mutation; every target should be declared or known.                                                            |
| `TRANSFORM`                   | Supported              | Use for array filter/map/sort/limit when results need deterministic reshaping.                                                                        |
| `RESPOND`                     | Supported              | Use for visible user text; use `RESPOND: ""` for intentional silent completion.                                                                       |
| `TEMPLATE(name)`              | Supported              | Compile-time inlining exists. Template `{{}}` interpolation is runtime behavior; variable availability must be validated.                             |
| Rich content/actions          | Supported              | Use for buttons, forms, cards, tables, and channel payloads when the UX needs structured interaction.                                                 |
| `ON_ACTION`/`ACTION_HANDLERS` | Supported              | Use for interactive action callbacks; terminal actions must be last.                                                                                  |
| `ON_INPUT`                    | Supported/legacy       | Use sparingly for rigid user-input branches; prefer gather/intent handling when semantic extraction is needed.                                        |
| Digressions/sub-intents       | Supported              | Use for cancel/help/correction escapes inside a flow step.                                                                                            |
| `COMPLETE`                    | Supported              | Use for explicit end/return conditions; first matching condition wins.                                                                                |
| `COMPLETE_WHEN` step field    | Supported with warning | Prefer explicit `THEN: COMPLETE`; validator warns because early termination can surprise authors.                                                     |
| `HANDOFF` local               | Supported              | Use for conversational control transfer to another agent.                                                                                             |
| `HANDOFF RETURN: true`        | Supported              | Target must have reachable `COMPLETE`; child must not hand off back to parent to simulate return.                                                     |
| `RETURN_HANDLERS`             | Supported              | Use structured `ON_RETURN: { handler/map/action }`; avoid legacy inline string except compatibility.                                                  |
| Handoff history strategies    | Supported              | `auto`, `none`, `summary_only`, `full`, and last-N forms exist.                                                                                       |
| Handoff memory grants         | Supported              | Use for declared persistent paths only; `readwrite` is valid only for `execution_tree` scope.                                                         |
| Remote handoff/delegate       | Compiler-supported     | Parser/compiler/validation exist; use conservative defaults and smoke-test runtime path, especially return/async behavior.                            |
| `DELEGATE`                    | Supported              | Use for sub-agent work where parent keeps control; `INPUT` is dot-path mapping, not CEL.                                                              |
| `ESCALATE`                    | Supported              | Use for human transfer or human-handling system handoff; packet fields must be safe.                                                                  |
| `CONSTRAINTS`                 | Supported              | Use for deterministic preconditions. Constraint guard semantics treat positive existence checks as preconditions in AND chains.                       |
| `GUARDRAILS`                  | Supported              | Use for safety/compliance checks across input/output/tool/handoff scopes.                                                                             |
| CEL/legacy expressions        | Supported              | Dual evaluator accepts CEL and legacy ABL; new generation should be consistent and parse-checked.                                                     |
| `ON_ERROR`                    | Supported              | Agent-level and step-level handlers parse/compile; use for tool timeout, tool error, invalid input, retry/backtrack/escalate/complete cases.          |
| `MEMORY.session`              | Supported              | Use for session state read by flow, routing, templates, and handoffs.                                                                                 |
| `MEMORY.persistent`           | Supported              | Use when durable user/project/execution-tree memory is required.                                                                                      |
| `REMEMBER`/`RECALL`           | Supported with caveats | Recall events are validated; pre-tool recall is blocked. Use canonical lifecycle event names.                                                         |
| `HOOKS` lifecycle             | Compiler-supported     | Parser/compiler/IR exist; smoke-test before Arch emits complex hook behavior.                                                                         |
| `ON_START` lifecycle          | Supported              | Use for greeting, initialization, startup calls, and initial state.                                                                                   |
| NLU/intents/entities          | Supported              | Use when routing/extraction depends on explicit intent/category/entity vocabularies.                                                                  |
| Multi-intent                  | Supported in IR        | Use only when project runtime supports the strategy; otherwise keep scope narrow.                                                                     |
| Behavior profiles             | Compiler-supported     | Use for channel/context-specific adaptations after smoke tests for profile activation.                                                                |
| Conversation behavior/voice   | Compiler-supported     | Use for voice/channel response contracts; keep chat agents simple unless channel-specific behavior is requested.                                      |
| Destinations                  | Compiler-supported     | Use only when outbound targets are actually provisioned.                                                                                              |
| Omnichannel policy            | Compiler-supported     | Use for cross-channel continuity only when product flow needs it.                                                                                     |
| Human approval                | Do not generate yet    | `HumanApprovalIR` exists, but parser/runtime authoring evidence is insufficient in this audit. Use workflow/human escalation instead for now.         |

## Core Principle

Arch should reason in two layers:

1. Semantic construct model: what runtime behavior is required.
2. ABL renderer: how that behavior is expressed in valid syntax.

The LLM should make use-case decisions and fill domain-specific content. The renderer should own syntax for `GATHER`, `FLOW`, `CALL`, `ON_SUCCESS`, `ON_FAIL`, `ON_RESULT`, `ON_INPUT`, `ON_ACTION`, `ON_ERROR`, `HANDOFF`, `DELEGATE`, `ESCALATE`, `CONTEXT`, `ON_RETURN`, `COMPLETE`, `RESPOND`, `TEMPLATES`, CEL expressions, memory, lifecycle hooks, and tool signatures.

## Construct Selection Matrix

| Need                                   | Prefer                                                            | Avoid                                                    |
| -------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Ask user for missing facts             | `GATHER`                                                          | Tool call if the system cannot know the value            |
| Derive/fetch known facts from systems  | `TOOLS` + `FLOW CALL`                                             | Asking the user for data the platform/tool can fetch     |
| Deterministic multi-step workflow      | `FLOW`                                                            | Reasoning-only agent with vague instructions             |
| Route to another project agent         | `HANDOFF`                                                         | Fake tool call or natural-language "send to..."          |
| Invoke child work and return to parent | `HANDOFF RETURN: true` or `DELEGATE` depending runtime contract   | Child handoff back to parent to simulate return          |
| Escalate to human/external owner       | `ESCALATE` or handoff to escalation desk                          | Catch-all self-handoff                                   |
| Carry state into child                 | `CONTEXT.pass` for declared fields, `CONTEXT.summary` for brief   | Assuming gathered state crosses boundaries automatically |
| Bring child results back               | Default same-name return merge or `ON_RETURN.map`                 | Mapping fields the child never gathers/sets              |
| Branch or complete on state            | CEL-compatible boolean expressions                                | Prose conditions or undeclared variable names            |
| Write user-facing text                 | `RESPOND` with declared variables or `TEMPLATE(name)`             | Referencing unavailable values or internal state         |
| Collect file/media                     | Top-level attachments or `AWAIT_ATTACHMENT` with smoke test       | Asking user to paste binary/file data into chat          |
| Handle interactive UI controls         | `ACTIONS`, `ON_ACTION`, or agent-level `ACTION_HANDLERS`          | Treating button clicks as normal free text               |
| Handle user digressions/corrections    | `DIGRESSIONS`, `SUB_INTENTS`, `CLEAR`, or correction-aware gather | Ignoring cancel/help/correction paths                    |
| Store durable state                    | `MEMORY.persistent` + `REMEMBER`/`RECALL`                         | Writing all transient state to persistent memory         |
| Adapt to channel/context               | Behavior profiles or conversation behavior                        | Duplicating whole agents for tiny tone/channel changes   |
| End agent cleanly                      | `COMPLETE` with reachable condition                               | Natural-language completion phrases                      |
| Handle tool failure                    | `ON_FAIL`, `ON_ERROR`, fallback step                              | Silent retry loops                                       |

## Runtime Scenarios

### 1. User-Fact Collection

Use when the agent needs facts that only the user can provide: order number, symptom description, desired outcome, consent, callback preference.

Required model fields:

- `gather.fields[].name`
- `type`
- `required`
- `prompt`
- optional validation/enum/entity/sensitive metadata
- optional activation: `required`, `optional`, `progressive`, or `{ when }`
- optional `depends_on`
- optional `prompt_mode`: `ask` or `extract_only`
- consumer references: completion, flow, tool args, context pass, or constraints

Validation gates:

- Every gather field must be used by at least one runtime consumer.
- Every completion condition that references a user fact must reference a declared gather field or session variable.
- Do not create a standalone `validation` gather field. Validation belongs under the real field.
- `prompt_mode: extract_only` must have a non-user-facing population path and should not be the only way to collect a required user-only fact.
- Sensitive fields need `sensitive`, `sensitive_display`, and `pii_type` where applicable.
- Progressive/data-driven activation expressions must reference declared state.
- Do not ask for secrets.

Bad pattern:

```yaml
GATHER:
  validation:
    type: string
    prompt: 'Use YYYY-MM-DD'
```

Good pattern:

```yaml
GATHER:
  followup_date:
    type: date
    required: true
    prompt: 'What date should we follow up?'
    validation:
      type: pattern
      rule: "^\\d{4}-\\d{2}-\\d{2}$"
```

### 2. Tool Instead Of Asking User

Use a tool when the system should know the answer or needs authoritative data: order status, billing history, availability, account eligibility, fraud score.

Decision rule:

- If the user can provide the value and no system authority is needed, use `GATHER`.
- If the platform/system is authoritative, gather only lookup keys and call a tool.
- If the tool has side effects, require an explicit confirmation policy.

Required model fields:

- tool name and purpose
- signature with parameter descriptions
- confirm policy
- required input sources for each arg
- result schema
- `ON_SUCCESS` or `ON_RESULT` mappings
- `ON_FAIL` or `ON_ERROR` behavior

Validation gates:

- Every tool arg must map from a known field, memory variable, runtime variable, or prior tool result.
- Every result field used later must be assigned into declared state.
- Side-effect tools must have explicit confirmation behavior.
- Tool result variables cannot appear in `COMPLETE`, `HANDOFF WHEN`, or later `CALL` args unless they have a population path.

Preferred flow shape for new generated ABL:

```yaml
FLOW:
  entry_point: lookup
  steps:
    - lookup
    - success
    - failure

  lookup:
    REASONING: false
    CALL: get_order_status
      WITH:
        order_number: order_number
      AS: order_status_result
    ON_SUCCESS:
      THEN: success
    ON_FAIL:
      RESPOND: "I could not retrieve the order status."
      THEN: failure
```

Runtime note:

- Existing tests also compile `CALL: tool(args)`, but the current Arch handbook says new generation should prefer `CALL: tool_name` with nested `WITH:` and optional `AS:`. The construct model should represent both as one canonical semantic form, then renderer should output the preferred syntax for the active ABL version.

### 3. Setting Variables After Tool Calls

Use when a tool response drives routing, completion, downstream tool args, or response text.

Required model fields:

- `call.resultAlias`
- `resultMappings[]`
- source path, for example `status_result.status`
- target variable
- target variable declaration
- optional transform/coerce rule

Validation gates:

- Target variable must be declared in session memory or a typed state model.
- Source path must exist in the tool result schema.
- If a mapped variable drives `COMPLETE`, completion must not be reachable before mapping runs.
- If a mapped variable is passed to a child, the handoff step must occur after mapping.
- Do not rely on `result` outside the immediate result branch unless it has been stored via `AS`, `SET`, or a tool-level `ON_RESULT`/`ON_ERROR` mapping.
- Tool-level `ON_RESULT`/`ON_ERROR` mappings are compiler-supported in this audit; verify runtime application before relying on them for critical routing.

Preferred ABL pattern:

```yaml
FLOW:
  lookup:
    REASONING: false
    CALL: lookup_order
      WITH:
        order_number: order_number
      AS: order_result
    ON_SUCCESS:
      SET:
        order_status: order_result.status
        delivery_eta: order_result.eta
      THEN: present_status
    ON_FAIL:
      SET:
        lookup_failed: true
      THEN: lookup_failure
```

### 4. FLOW Step Selection

Use `FLOW` when ordering matters, especially for transactional, scripted, or hybrid agents.

Use cases:

- collect -> validate -> tool call -> branch -> respond -> complete
- confirm -> side-effect tool -> audit -> complete
- triage -> delegate -> post-child callback -> complete
- upload -> await attachment -> process -> summarize -> complete
- reason -> set/transform -> deterministic route -> complete

Avoid `FLOW` for simple reasoning responders where no deterministic sequence is needed.

Required model fields:

- ordered steps
- step kind: `respond`, `gather`, `await_attachment`, `call`, `set`, `clear`, `transform`, `branch`, `handoff`, `delegate`, `complete`, `error_handler`
- allowed tools per reasoning step if needed
- next step on success/failure
- terminal behavior

Validation gates:

- Every step named in the step list must have a matching definition.
- Every step must do real work: respond, call, set, clear, transform, gather, await attachment, branch, handoff, delegate, error handling, or complete.
- Branch targets must exist or be `COMPLETE`.
- Cycles need an exit path.
- GATHER mixed with `ON_INPUT` needs explicit ordering so user input is not ambiguously consumed.
- `COMPLETE_WHEN` is supported but warning-prone; prefer explicit branches to `THEN: COMPLETE`.
- Reasoning steps with `SET`, `CLEAR`, or `TRANSFORM` are supported but timing-sensitive; prefer mutation in a deterministic follow-up step.

### 5. Completion Logic

Use `COMPLETE` when the agent needs a runtime exit condition. It is especially required when a parent used `RETURN: true` and is waiting for the child to finish.

Completion may be unnecessary for a pure supervisor/router that routes indefinitely.

Required model fields:

- completion conditions
- response behavior, often `RESPOND: ""` for silent return
- required state sources
- whether parent is waiting

Validation gates:

- Every `COMPLETE WHEN` must be reachable.
- Completion must be driven by gathered fields, flow-set variables, tool result mappings, declared session variables, or returned child state.
- If `COMPLETE` exists but no `GATHER` or `FLOW` can populate its condition, flag as blocking.
- Do not use prose like `WHEN: issue resolved`.

Good return-target pattern:

```yaml
GATHER:
  issue_summary:
    type: string
    required: true
    prompt: 'Can you describe the issue?'
  resolution_confirmed:
    type: boolean
    required: true
    prompt: 'Has this been resolved?'

COMPLETE:
  - WHEN: issue_summary != null AND resolution_confirmed == true
    RESPOND: ''
```

### 6. Handoff Routing

Use `HANDOFF` when an agent routes control to another agent.

Required model fields:

- source agent
- target agent
- local or remote target
- condition
- return expectation
- context pass/summary/history
- failure action

Validation gates:

- Target must exist for local handoff.
- No self-handoff.
- `WHEN` must be a runtime expression, not prose.
- Variables in `WHEN` must be declared/populated or runtime-provided.
- Supervisors should have a final catch-all handoff when they are responsible for routing unmatched intents.

Good pattern:

```yaml
HANDOFF:
  - TO: BillingAgent
    WHEN: intent.category == "billing"
    CONTEXT:
      pass: []
      summary: 'Customer needs billing support.'
    RETURN: true
  - TO: GeneralSupportAgent
    WHEN: true
    CONTEXT:
      pass: []
      summary: 'General support fallback.'
    RETURN: true
```

### 7. Context Passing Into Child Agents

Runtime state does not automatically cross agent boundaries.

Use `CONTEXT.pass` when the child must immediately read specific structured fields. Use `CONTEXT.summary` when the child mainly needs a concise brief. Use history controls deliberately.

Required model fields:

- pass fields and their source ownership
- summary template
- history strategy: auto, summary_only, bounded/raw as supported
- memory grants for persistent paths only

Validation gates:

- Every `CONTEXT.pass` field must exist in source `GATHER` or `MEMORY.session` and be populated before handoff.
- `summary_only` without a `CONTEXT.summary` is a warning.
- Do not use memory grants as a substitute for pass/summary.
- Do not pass guessed IDs or summaries without a declared population path.

Good pattern:

```yaml
HANDOFF:
  - TO: BillingAgent
    WHEN: intent.category == "billing"
    CONTEXT:
      pass: [customer_id, invoice_id]
      summary: 'Customer has a billing issue for invoice {{invoice_id}}.'
      history: auto
    RETURN: true
```

### 8. Child Return And Parent Post-Child Behavior

When `RETURN: true`, runtime returns through the parent stack after child `COMPLETE`. The child should not hand off back to the parent to simulate return.

Use default return merge when child gathered fields should merge back by same name. Use `ON_RETURN.map` only for renaming, selective mapping, or non-gather outputs.

Required model fields:

- child completion contract
- returned fields
- default merge vs explicit map
- optional return handler
- optional parent continuation behavior

Validation gates:

- `ON_RETURN` requires `RETURN: true`.
- `ON_RETURN.map` can only reference fields child gathers or populates.
- Parent completion conditions depending on child non-gather state need `ON_RETURN.map`.
- Legacy inline `ON_RETURN: "handler"` is compatibility-only and should not be generated.

Current compiler-backed example:

```yaml
RETURN_HANDLERS:
  await_next_request:
    RESPOND: 'What else can I help with?'
    CONTINUE: true

HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist == true
    RETURN: true
    ON_RETURN:
      HANDLER: await_next_request
    CONTEXT:
      pass: [customer_id]
      summary: 'Route to specialist'
```

### 9. Handoff Failure

Use `ON_FAILURE` when handoff failure should produce a controlled response or alternate path.

Validation gates:

- Only supported failure actions should be rendered.
- Unsupported actions like `ON_FAILURE: RETRY 3` are compiler errors in current tests.
- Handoff `ON_FAILURE` supports `respond`, `continue`, and `escalate`; retry is not supported.
- Remote handoffs compile with `RETURN: true`, but Arch should smoke-test remote return before using it as the default. Prefer `RETURN: false` for remote transfer unless the target runtime is verified.

Example:

```yaml
HANDOFF:
  - TO: SpecialistAgent
    WHEN: needs_specialist == true
    ON_FAILURE: RESPOND "Specialist handoff failed"
    CONTEXT:
      pass: []
      summary: 'Route to specialist.'
    RETURN: true
```

### 10. Escalation

Use escalation when automation cannot safely finish or policy requires human review.

Escalation choices:

- `ESCALATE` construct for direct runtime escalation.
- Dedicated human escalation desk agent when a structured handoff packet and audit trail are needed.

Required model fields:

- trigger condition
- reason
- priority/severity
- packet fields
- audit fields
- user-facing response

Validation gates:

- Trigger variables must be declared/populated.
- Escalation packet must not include secrets.
- If escalation is a child agent, it needs a valid completion/return contract when parent waits.

### 11. Constraints And Guardrails

Use constraints for preconditions that block or redirect behavior. Use guardrails for safety/compliance checks.

Validation gates:

- Constraint variables must be declared/populated.
- Do not use invented runtime variables like `user_authenticated`.
- `ON_FAIL` must use supported actions.
- Sensitive/compliance flows should prefer explicit constraints and confirmations over implicit persona text.
- Constraint positive existence checks (`IS SET`, `has(...)`, or guarded `!= null`) can act as preconditions in AND chains; do not confuse this with general completion logic.
- Guardrail checks use violation semantics for local CEL checks: a true check means the violation was detected.

### 12. Persistent Memory And Audit

Use persistent memory only when the use case needs durable state: audit trail, case context, user profile, long-running workflow.

Validation gates:

- `MEMORY.remember[].STORE.target` must be a declared persistent path.
- Cross-agent persistent access must use explicit memory grants.
- Recall must use canonical events such as `session:start`, `session:end`, `agent:<name>:before/after`, `tool:<name>:after`, `tool:*:after`, `entity:<field>:extracted`, `step:enter:<name>`, or `step:exit:<name>`.
- Pre-tool recall is blocked because it can mutate context that tool dispatch is about to use.
- Audit entries should minimize PII and redact secrets.
- Do not write transient tool outputs to persistent memory unless required.

### 13. CEL Expressions And Runtime Conditions

Use CEL-compatible expressions anywhere the runtime evaluates a condition or computed value: `HANDOFF WHEN`, `DELEGATE WHEN`, `COMPLETE WHEN`, `FLOW ON_INPUT`, `ON_RESULT`, `ON_SUCCESS`/`ON_FAIL` branches, `success_when`, `CHECK`, constraints, guardrails, `SET`, behavior profiles, action handlers, digressions, and gather activation.

Expression decision rules:

- Prefer one operator style per expression. CEL-style `&&`, `||`, and `!` are clearer for new generated code; legacy `AND`, `OR`, and `IS SET` may be accepted but should not be mixed casually.
- Use explicit null/existence checks before accessing optional fields.
- Use `field != null` for declared flat fields.
- The dual evaluator preprocesses bare `has(field)` to `field != null`, but new generated code should still prefer `field != null` for flat fields and `has(obj.field)` for member access.
- Use string/list methods intentionally: `.contains()`, `.startsWith()`, `.endsWith()`, `.matches()`, `size(items)`.
- Use `abl.*` helpers only when they improve correctness or readability, for example `abl.lower(channel) == "email"` or `abl.mask(account_id, "last4")`.
- Keep delegate `INPUT` mappings as dot-path mappings only; do not place CEL expressions there.

Required model fields:

- expression purpose: route, complete, branch, constraint, set value, success condition
- expression text
- variables referenced
- expected result type: boolean, string, number, object
- population path for each referenced variable
- fallback behavior when expression cannot be evaluated

Validation gates:

- Every referenced identifier must be a declared gather field, session variable, tool result mapping, return mapping, context pass, or allowed runtime variable.
- Parse and type-check CEL before render where possible; do not rely only on runtime evaluation failures.
- Conditions must evaluate to boolean when used in `WHEN`, constraints, and branches.
- Expressions must not reference prompt-only concepts such as `matching intent`, `user seems angry`, or `known_issue` unless those are explicit variables populated by NLU, tools, or flow.
- Numeric literals should be compatible with CEL number behavior. Prefer context-provided numeric values over mixing integer literals into arithmetic if type ambiguity is possible.

Good pattern:

```yaml
HANDOFF:
  - TO: IncidentSpecialist
    WHEN: triage_category == "incident" && urgency in ["P1", "P2"]
    CONTEXT:
      pass: [triage_category, urgency]
      summary: 'Incident triage requested.'
    RETURN: true
  - TO: KBAnswerSpecialist
    WHEN: triage_category == "faq" && article_match_score >= 0.7
    CONTEXT:
      pass: [triage_category]
      summary: 'Likely FAQ request.'
    RETURN: true
  - TO: HumanEscalationDesk
    WHEN: urgency == "P1" || customer_tier == "enterprise"
    CONTEXT:
      pass: [urgency, customer_tier]
      summary: 'Priority escalation.'
    RETURN: true
```

Bad pattern:

```yaml
HANDOFF:
  - TO: IncidentSpecialist
    WHEN: user has a known urgent problem
```

### 14. Responses, Templates, And Variable Availability

Use `RESPOND` for user-facing output and `TEMPLATES` when response text is reused, long, localized later, or needs a stable named contract.

Response decision rules:

- Keep chat responses short when the detailed artifact already exists in Blueprint, Topology, or agent detail tabs.
- Put major details in the artifact; put only summary, decision, and next action in chat.
- Use variables only when they are available at that point in the flow.
- Use `RESPOND: ""` for explicit silent completion when the agent already answered or is only returning control to a parent.
- Do not omit `RESPOND` in completion if silence is intended; the runtime may fall back to a generic completion message.
- Never expose internal-only fields, secrets, auth tokens, raw stack traces, or hidden routing/debug state in a response template.

Required model fields:

- response purpose: ask, acknowledge, summarize, branch result, tool success, tool failure, handoff intro, completion
- response text or template reference
- variables referenced by the response
- whether response is visible or intentionally silent
- source step where each referenced variable becomes available
- redaction policy for sensitive variables

Validation gates:

- Every `{{variable}}` reference must be available before the response step executes.
- Object variables should either be summarized intentionally or rendered through a safe field path, not dumped blindly.
- A template referenced by `TEMPLATE(name)` must exist.
- Unused templates are warnings, not blockers, but repeated unused templates usually indicate a drifted generated plan.
- Responses after side-effect tool calls must reflect tool evidence, not persona assumptions.
- Failure responses should be helpful and next-step oriented; they should not pretend the requested action succeeded.

Good pattern:

```yaml
TEMPLATES:
  return_submitted: |
    Your return request has been submitted.
    - RMA ID: {{rma_id}}
    - Return label: {{label_url}}
    - Refund estimate: {{refund_estimate}}

FLOW:
  submit_return:
    REASONING: false
    CALL: create_return
      WITH:
        order_number: order_number
        items_to_return: items_to_return
        reason_code: reason_code
      AS: create_return_result
    ON_SUCCESS:
      SET:
        rma_id: create_return_result.rma_id
        label_url: create_return_result.label_url
        refund_estimate: create_return_result.refund_estimate
      RESPOND: TEMPLATE(return_submitted)
      THEN: COMPLETE
    ON_FAIL:
      RESPOND: 'I could not submit the return yet. Please confirm the order number and items, or I can route this to a support specialist.'
      THEN: COMPLETE
```

Bad pattern:

```yaml
RESPOND: 'Your return {{rma_id}} was created.'
```

when `rma_id` is never mapped from the tool result.

### 15. Tool Result Branching: `ON_SUCCESS`, `ON_FAIL`, `ON_RESULT`

Use `ON_SUCCESS`/`ON_FAIL` for binary success/failure paths. Use `ON_RESULT` only when a successful call needs multiple deterministic branches, or when a no-call deterministic gate is intentionally using session/input variables.

Support status:

- `ON_SUCCESS`/`ON_FAIL`: supported.
- Flow-step `ON_RESULT`: compiler-supported and graph-validated; smoke-test runtime before relying on it for critical project generation.
- Tool-definition `ON_RESULT`/`ON_ERROR`: parser/compiler preserve mappings and session-variable population analysis understands them; smoke-test runtime executor application before critical routing depends on them.

Validation gates:

- `ON_RESULT` branches must have valid `THEN` targets.
- Branch conditions must reference available state. If using a tool result, bind it with `AS` or map it first.
- `ELSE`/default branch should exist when no branch match would otherwise black out the flow.
- Branch-local `SET` variables become available only after that branch runs.

Preferred pattern:

```yaml
FLOW:
  check_status:
    REASONING: false
    CALL: lookup_ticket
      WITH:
        ticket_id: ticket_id
      AS: ticket_result
    ON_SUCCESS:
      - IF: ticket_result.status == "resolved"
        RESPOND: "This ticket is already resolved."
        THEN: COMPLETE
      - ELSE:
        THEN: summarize_ticket
    ON_FAIL:
      RESPOND: "I could not find that ticket. Please check the ticket ID."
      THEN: COMPLETE
```

### 16. `SET`, `CLEAR`, And Computed State

Use `SET` for explicit state assignments and derived values. Use `CLEAR` when a correction, retry, or changed answer invalidates previously collected state.

Support status: supported.

Validation gates:

- Target paths should be declared session variables or known writable execution context paths.
- Expressions must be CEL/legacy-compatible and reference available variables.
- Use `SET` before `DELEGATE` when a delegate input needs a transformed value; delegate `INPUT` itself is dot-path mapping only.
- Use `CLEAR` when stale dependent values would otherwise survive a correction.
- Avoid `SET` after a reasoning zone in the same step unless timing is intentional; validators warn because reasoning reads pre-mutation state.

Example:

```yaml
FLOW:
  normalize:
    REASONING: false
    SET:
      normalized_channel: abl.lower(channel)
      retry_count: retry_count + 1
    THEN: route
```

### 17. `TRANSFORM` Array Pipeline

Use `TRANSFORM` when a tool returns an array and the agent needs deterministic filtering, mapping, sorting, or limiting before response or routing.

Support status: supported in schema/compiler surfaces; include runtime smoke tests for generated projects that rely on it.

Validation gates:

- Source must be an array-valued state path.
- `item_var` must be explicit.
- Filter/map expressions must reference the item variable or other available state.
- Target variable must be declared if later used in response, handoff, completion, or tool args.

Example semantic shape:

```yaml
FLOW:
  filter_options:
    REASONING: false
    TRANSFORM:
      source: search_result.items
      AS: item
      INTO: eligible_items
      FILTER: item.available == true
      LIMIT: 5
    THEN: present_options
```

### 18. Attachments And `AWAIT_ATTACHMENT`

Use attachments when the user must provide a file/media artifact: screenshot, invoice PDF, ID image, HAR file, audio clip.

Support status:

- Top-level attachment fields: supported.
- Flow-step `AWAIT_ATTACHMENT`: parser/compiler/validation supported; runtime behavior must be smoke-tested for the intended channel.

Validation gates:

- Attachment variable must be non-empty and have no spaces.
- Prompt must be non-empty.
- Category must be `image`, `document`, `audio`, or `video` when specified.
- Timeout must be positive when specified.
- `on_timeout` target must exist.
- Do not ask the user to paste binary data into normal text fields.

Example:

```yaml
FLOW:
  collect_screenshot:
    REASONING: false
    AWAIT_ATTACHMENT:
      name: error_screenshot
      prompt: 'Upload a screenshot of the error.'
      category: image
      required: false
      timeout: 300
      on_timeout: continue_without_screenshot
    THEN: summarize_issue
```

### 19. Interactive Actions And Action Handlers

Use rich actions when the user should click/select/submit rather than type: confirmation buttons, selection lists, quick replies, structured forms.

Support status: supported.

Runtime surfaces:

- `ACTIONS` on `RESPOND`.
- Step-level `ON_ACTION`.
- Agent-level `ACTION_HANDLERS`.
- Ordered `DO` actions with `respond`, `set`, `clear`, `call`, `handoff`, `delegate`, `goto`, and `complete`.

Validation gates:

- Action IDs must be stable and unique within the response/action surface.
- Terminal actions (`GOTO`, `HANDOFF`, non-returning `DELEGATE`, `COMPLETE`) must be last in an ordered `DO` block.
- If a rich response is immediately followed by terminal routing, the terminal target should own required channel-specific content.
- Handoff/delegate targets used in action handlers must also be declared in coordination config.
- Do not rely on free-text fallback when a button action is required for safety confirmation.

### 20. `ON_INPUT`, Digressions, Sub-Intents, And Corrections

Use these when the user can deviate from the happy path.

Support status: supported.

Decision rules:

- Use `ON_INPUT` for rigid text/condition branches in a deterministic step.
- Use `DIGRESSIONS` for cross-cutting escape intents like cancel, help, agent request, or change topic.
- Use `SUB_INTENTS` for scoped step-level intents.
- Use `CLEAR` when correction invalidates old values.
- Prefer gather correction support for natural “actually…” corrections during collection.

Validation gates:

- Every `GOTO`/`THEN` target must exist or be terminal.
- Duplicate digression intents are invalid.
- Mixed `GATHER` + `ON_INPUT` needs deliberate ordering.
- Regex/matches conditions that set `match.*` should only be used in the step that evaluates them.

### 21. Error Handling

Use `ON_ERROR` for runtime failures that are not normal business branches: tool timeout, tool error, invalid input, validation failure, provider/model errors, or unexpected execution errors.

Support status: supported at agent and flow-step level.

Supported behavior surfaces:

- `respond`
- `retry`, `retry_delay`, `retry_backoff`, `retry_max_delay`
- `then: continue | escalate | handoff | complete | backtrack | retry_step`
- `handoff_target`
- `backtrack_to`
- rich content/actions/voice response fields

Validation gates:

- Retry counts and backoff must be bounded.
- Backtrack targets must exist.
- Handoff targets must be declared.
- User-facing error text must be sanitized and should not leak tenant/model/internal details.
- Do not use `ON_ERROR` as a normal decision branch; use `ON_SUCCESS`/`ON_FAIL`/`ON_RESULT` for expected tool outcomes.

### 22. `CHECK` And Constraint Phases

Use `CHECK` in a flow step when the step needs to run a named constraint phase before continuing.

Support status: supported.

Validation gates:

- The named constraint phase must exist.
- `ON_FAIL` must target an existing step or a supported action depending surface.
- Constraint `BEFORE` clauses should target supported checkpoints: tool call or response.
- Constraint conditions with missing data should use explicit guards.

### 23. Guardrail Tiers And Safety Actions

Use guardrails for safety, compliance, PII, harmful content, tool input/output, and handoff boundary checks.

Support status: supported.

Runtime scopes:

- `input`
- `output`
- `tool_input`
- `tool_output`
- `handoff`

Validation gates:

- Tier/action combinations must be supported by the guardrail pipeline.
- Local CEL guardrail checks use violation semantics: true means a violation was detected.
- Redaction/fix/reask/filter actions must not create incoherent or empty user-visible output.
- Streaming guardrails should be used only when channel/runtime supports streaming evaluation.

### 24. Lifecycle: `ON_START`, `HOOKS`, `MESSAGES`

Use lifecycle constructs for initialization, greetings, pre/post turn behavior, and custom fallback messages.

Support status:

- `ON_START`: supported.
- `MESSAGES`: supported.
- `HOOKS`: compiler-supported; smoke-test complex hook behavior before broad generation.

Validation gates:

- `ON_START` calls need declared tools and valid args.
- Hook failures should be non-critical unless aborting the turn is required.
- `MESSAGES.conversation_complete` affects default completion text when completion action has no message.
- If silence is intended, use explicit `RESPOND: ""` in the matching completion condition.

### 25. NLU, Intents, Entities, And Multi-Intent

Use NLU when routing or extraction depends on stable semantic categories.

Support status: supported in parser/compiler/IR/runtime NLU engine wiring.

Decision rules:

- Use `INTENTS`/`NLU.categories` when supervisor routes depend on named categories.
- Use `ENTITIES` or `NLU.entities` when gather fields need synonyms, enums, or extraction patterns.
- Use `ENTITY_REF` when a gather field should inherit entity definition.
- Use multi-intent only when the product flow truly supports multiple simultaneous intents.

Validation gates:

- Intent categories used in `WHEN` should be declared when explicit `INTENTS` are present.
- Entity definitions must not conflict between `ENTITIES` and `NLU.entities`.
- Gather field type and NLU entity type must match.
- Regex entity patterns must pass regex safety validation.

### 26. Behavior Profiles And Conversation Behavior

Use behavior profiles for context/channel-specific behavior changes without cloning the entire agent.

Support status: compiler-supported.

Use cases:

- Voice vs chat response style.
- Channel-specific rich-content limits.
- Different constraints or gather overrides for authenticated vs unauthenticated contexts.
- Contextual tool availability.

Validation gates:

- Profile `WHEN` must be a valid expression.
- Priority must be explicit and non-negative.
- Flow modifications should not orphan or bypass required safety steps.
- Use behavior profiles for variants, not for core business logic that should be visible in the base blueprint.

### 27. Tool Bindings, Auth, Secrets, And Placeholders

Use tool bindings when Arch also provisions or references concrete integrations.

Support status: supported, but generation must match provisioned project tool capabilities.

Supported binding categories in types/runtime executors include HTTP, MCP, lambda, sandbox, async webhook, workflow, connector/searchai-style executor paths.

Validation gates:

- Agent ABL should not embed raw secrets or auth tokens.
- HTTP templates may use supported placeholder namespaces such as `{{secrets.KEY}}`, `{{env.KEY}}`, `{{config.KEY}}`, `{{input.X}}`, `{{_context.X}}`, and `{{session.X}}`.
- Tool args should be explicit and type-compatible.
- Side-effecting tools need confirmation or a deterministic precondition.
- Tool result compaction should preserve fields that later responses/routes need.

### 28. Remote Agents, Async Handoff, And External A2A

Use remote coordination when a target agent is outside the current project/runtime.

Support status: compiler-supported; runtime path must be verified for the chosen protocol and return behavior.

Validation gates:

- Endpoint is optional when resolved from external-agent registry, but malformed explicit endpoints are invalid.
- Protocol must match the remote target capability (`a2a` or `rest` where supported).
- Timeout syntax must use supported units.
- Use `RETURN: false` by default for remote transfer unless return behavior is verified.
- Async remote handoff should be generated only after runtime support is proven for the target channel.

### 29. Escalation And Human Handling

Use `ESCALATE` when automation cannot safely proceed or policy demands human involvement.

Support status: supported.

Validation gates:

- Trigger conditions must reference declared state.
- Context for human must include only safe, necessary fields.
- Routing queue/skills/priority should match actual human operations.
- `on_human_complete` actions are a contract; verify runtime integration before depending on automatic post-human continuation.
- For now, prefer `ESCALATE` or a dedicated escalation desk agent over `human_approval`, because `HumanApprovalIR` lacks enough parser/runtime evidence in this audit.

### 30. Execution Config, Timeouts, Concurrency, And Compaction

Use execution config only when the use case needs runtime tuning.

Support status: supported in IR/runtime config.

Validation gates:

- Tool and LLM timeouts should be bounded and realistic.
- Reasoning iteration limits and flow iteration limits should prevent loops.
- Parallel/preemptive concurrency should only be used when session state mutation is safe.
- Compaction must preserve fields used by later tool calls, responses, and routing.
- Model/reasoning settings should follow the repo’s user-scoped model-resolution contract.

### 31. Lookup Tables, Destinations, And Omnichannel Policy

Use these only when a project requires them.

Support status: compiler-supported.

Use cases:

- Lookup tables: validating enum/reference values from inline lists, collections, or APIs.
- Destinations: outbound webhooks/API targets.
- Omnichannel policy: cross-channel recall and verified identity continuity.

Validation gates:

- Lookup table names referenced by gather semantics must exist.
- API lookup/destination endpoints must be tenant/project safe and authenticated.
- Omnichannel recall must not expose one end-user’s session data to another end-user.
- Cross-channel identity needs explicit verification requirements.

### 32. Unsupported Or High-Risk Generation Areas

Do not put these in the default Arch generation lane until runtime proof is added:

- `human_approval` authored DSL: IR type/preflight evidence exists, but parser/runtime execution evidence is insufficient here.
- Remote async return flows: compile surfaces exist, but runtime return semantics need proof for each protocol.
- Complex hook chains that mutate state before tool dispatch: recall validation explicitly blocks pre-tool recall for this class of risk.
- Tool-definition `ON_RESULT`/`ON_ERROR` as the only population path for critical routing until executor behavior is smoke-tested.
- Generated raw URLs/auth secrets inside agent ABL. Use project tools/auth profiles instead.

## Runtime-Proofed Authoring Defaults

Until broader runtime evidence is added, Arch should default to these safer forms:

- Prefer `CALL: tool_name` + nested `WITH:` + `AS:` over inline `CALL: tool(args)` for new generated code.
- Prefer explicit `SET` from `AS` result variables before response/handoff/completion.
- Prefer `ON_SUCCESS`/`ON_FAIL` over `ON_RESULT` unless true multi-way result branching is required.
- Prefer explicit `THEN: COMPLETE` over `COMPLETE_WHEN`.
- Prefer `HANDOFF RETURN: true` only for local agents with reachable `COMPLETE`.
- Prefer `DELEGATE` for parent-owned subwork with dot-path inputs and bounded failure behavior.
- Prefer `ESCALATE` or escalation desk agents over `human_approval`.
- Prefer `field != null` for flat existence checks and `has(obj.field)` for object member existence.
- Prefer short chat summaries with detailed artifacts in Blueprint/Topology/agent tabs.

## Blueprint Construct Model Requirements

To support these scenarios without free-form DSL guessing, the blueprint/build model should carry these optional blocks:

```ts
interface AgentConstructPlan {
  identity: {
    name: string;
    role: string;
    goal: string;
    persona: string;
    limitations?: string[];
  };
  state?: {
    variables: Array<{
      name: string;
      type: string;
      owner: 'gather' | 'tool_result' | 'flow_set' | 'context_pass' | 'runtime' | 'return_map';
      requiredFor?: string[];
      sensitive?: boolean;
    }>;
  };
  gather?: {
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      prompt: string;
      validation?: unknown;
      usedBy: string[];
    }>;
  };
  tools?: {
    contracts: Array<{
      name: string;
      signature: string;
      description: string;
      confirm: 'never' | 'always' | 'when_side_effects';
      args: Array<{ name: string; source: string }>;
      resultSchema: Record<string, string>;
    }>;
  };
  flow?: {
    steps: Array<{
      name: string;
      kind:
        | 'respond'
        | 'gather'
        | 'await_attachment'
        | 'call'
        | 'set'
        | 'clear'
        | 'transform'
        | 'branch'
        | 'handoff'
        | 'delegate'
        | 'complete'
        | 'error_handler';
      reads?: string[];
      writes?: string[];
      call?: {
        tool: string;
        args: Record<string, string>;
        resultAlias?: string;
        onSuccess?: string;
        onFail?: string;
        resultMappings?: Array<{ from: string; to: string }>;
      };
      next?: string;
    }>;
    digressions?: Array<{
      intent: string;
      condition?: string;
      action: 'respond' | 'goto' | 'delegate' | 'call' | 'resume' | 'complete';
    }>;
  };
  routing?: {
    handoffs?: Array<HandoffPlan>;
    delegates?: Array<HandoffPlan>;
    escalations?: Array<EscalationPlan>;
  };
  interaction?: {
    actions?: Array<{
      id: string;
      type: 'button' | 'select' | 'input';
      label: string;
      handler: string;
    }>;
  };
  lifecycle?: {
    onStart?: { respond?: string; call?: string; set?: Record<string, string> };
    hooks?: Array<{
      event: 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn';
      critical: boolean;
    }>;
  };
  memory?: {
    session?: Array<{ name: string; type?: string; initialValue?: unknown }>;
    persistent?: Array<{
      path: string;
      scope: 'user' | 'project' | 'execution_tree';
      access: 'read' | 'write' | 'readwrite';
    }>;
    remember?: Array<{ when: string; value: string; target: string }>;
    recall?: Array<{
      event: string;
      action: 'inject_context' | 'load_memory' | 'prompt_llm';
      paths?: string[];
    }>;
  };
  expressions?: Array<{
    id: string;
    purpose: 'route' | 'complete' | 'branch' | 'constraint' | 'set' | 'success_condition';
    text: string;
    reads: string[];
    resultType: 'boolean' | 'string' | 'number' | 'object';
  }>;
  responses?: Array<{
    id: string;
    purpose:
      | 'ask'
      | 'acknowledge'
      | 'summarize'
      | 'tool_success'
      | 'tool_failure'
      | 'handoff_intro'
      | 'complete';
    templateName?: string;
    text?: string;
    variables: string[];
    visible: boolean;
    redaction?: 'none' | 'mask_sensitive' | 'exclude_sensitive';
  }>;
  completion?: {
    required: boolean;
    conditions: Array<{ when: string; respond: string }>;
  };
}
```

All blocks are optional and should be selected by agent complexity and use-case need.

## Pre-Render Validation Checklist

Before rendering ABL:

- [ ] Every referenced variable is declared.
- [ ] Every declared variable has a population source or explicit runtime source.
- [ ] Every gather field has at least one consumer.
- [ ] Every gather activation and `depends_on` chain is acyclic and references known fields.
- [ ] Sensitive gather fields have safe display policy and are not echoed in responses without masking.
- [ ] Every tool arg source exists.
- [ ] Every tool result mapping references a result field and target variable.
- [ ] Every side-effect tool has an explicit confirm policy.
- [ ] Every `CALL` uses preferred `WITH`/`AS` syntax unless compatibility syntax is intentionally selected.
- [ ] Every `ON_SUCCESS`, `ON_FAIL`, and `ON_RESULT` branch has a valid target or terminal action.
- [ ] Every flow step target exists or is `COMPLETE`.
- [ ] Every flow cycle has an exit path.
- [ ] No `COMPLETE_WHEN` is generated unless the early-completion warning is accepted.
- [ ] Reasoning-zone steps with `SET`, `CLEAR`, or `TRANSFORM` have explicit timing rationale.
- [ ] Every `AWAIT_ATTACHMENT` variable/prompt/category/timeout/target validates.
- [ ] Every `ON_ACTION` ordered block has terminal actions last.
- [ ] Every action handler handoff/delegate target is declared in coordination.
- [ ] Every digression/sub-intent target exists and duplicate digression intents are rejected.
- [ ] Every handoff target exists or is explicitly remote.
- [ ] No self-handoff.
- [ ] Every handoff `WHEN` is runtime-actionable and references valid state.
- [ ] Remote handoff/delegate return or async behavior is not generated unless smoke-tested.
- [ ] Every CEL expression parses and has the expected result type.
- [ ] Every expression identifier resolves to declared state, populated tool output, return output, context pass, or an allowed runtime variable.
- [ ] Delegate `INPUT` mappings are dot paths, not CEL expressions.
- [ ] `has()` is used only for object member checks, not as a generated shortcut for bare fields.
- [ ] Every `RESPOND` variable is available before the response executes.
- [ ] Every `TEMPLATE(name)` reference resolves to a declared template.
- [ ] Response templates do not expose secrets, internal errors, raw debug state, or unredacted sensitive values.
- [ ] Silent completion uses explicit `RESPOND: ""` where needed.
- [ ] Every `CONTEXT.pass` field is populated before handoff.
- [ ] `history: summary_only` has `CONTEXT.summary`.
- [ ] `RETURN: true` target has reachable completion.
- [ ] `ON_RETURN.map` references child-produced fields.
- [ ] Parent completion depending on child non-gather output has return mapping.
- [ ] `COMPLETE` conditions are reachable from gather, flow, tool mappings, context pass, or return mapping.
- [ ] Escalation packet excludes secrets and has a clear trigger.
- [ ] Persistent memory writes target declared persistent paths.
- [ ] Recall events use canonical event names and avoid blocked pre-tool mutation patterns.
- [ ] Constraints and guardrails use supported actions and scopes.
- [ ] Error handlers have bounded retry/backoff and valid handoff/backtrack targets.
- [ ] Behavior profiles do not orphan required base-flow safety steps.
- [ ] Tool bindings do not embed raw secrets and all placeholders use supported namespaces.
- [ ] Generated constructs marked compiler-supported have a battle-test/smoke-test fixture before being enabled in default BUILD.

## Open Questions To Resolve Before Implementation

1. Canonical `CALL` renderer syntax: choose one supported syntax for new generation and keep compatibility tests for legacy forms.
2. `DELEGATE` vs `HANDOFF RETURN: true`: document exact runtime difference and when Arch should choose each.
3. `ON_RESULT` vs `ON_SUCCESS` naming: align blueprint model with compiler/runtime accepted syntax.
4. Tool confirmation policy model: define when side effects are inferred versus explicitly declared.
5. Remote handoff return support: keep `RETURN: false` until runtime support is verified.
6. Runtime-provided variables: publish an allowlist so validators do not reject real runtime fields or accept hallucinated ones.
7. Complex child callback events: decide whether return handlers are enough or whether a richer post-child event model is needed.
8. CEL parse-only validator: expose a validator separate from runtime evaluation so Arch can reject invalid conditions without needing real runtime values.
9. Response variable scope map: publish exactly which variables are available in `RESPOND`, `TEMPLATE`, `CONTEXT.summary`, tool args, `SET`, and completion conditions at each step.
10. Runtime proof matrix: for every compiler-supported construct, add one CLI project fixture that exercises the construct end-to-end.
11. Human approval lane: either wire parser/runtime evidence for authored `human_approval` or keep it out of Arch generation.
12. Tool-level `ON_RESULT`/`ON_ERROR`: confirm executor application order relative to flow-step `ON_SUCCESS`/`ON_FAIL`.
13. Remote return/async handoff: verify protocol-specific runtime semantics before letting blueprint generation select it automatically.

## Recommendation

Proceed with blueprint-driven deterministic BUILD only after this construct model is made explicit. The system can still be smart and adaptive, but the LLM should decide the semantic plan, not freehand final ABL syntax.

The next design artifact should be a low-level construct model spec that turns this audit into:

- Zod schemas.
- validators.
- renderer contracts.
- fixture scenarios.
- golden evals for simple, medium, and complex agents.
