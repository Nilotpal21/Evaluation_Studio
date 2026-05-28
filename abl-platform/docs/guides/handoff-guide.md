# Handoff Guide — Agent-to-Agent Coordination in ABL

This guide explains every agent-to-agent coordination pattern available in
the ABL platform: **Handoff**, **Delegate**, **Escalate**, and **Fan-Out**.
Each pattern serves a different orchestration need. Pick the right one and
wire it correctly using the examples below.

---

## Quick Comparison

| Pattern  | Control Flow              | Returns? | Use Case                               |
| -------- | ------------------------- | -------- | -------------------------------------- |
| Handoff  | Transfer to another agent | Optional | Route user to a specialist             |
| Delegate | Sub-task execution        | Always   | Ask a sub-agent to compute something   |
| Escalate | Transfer to human         | No       | Hand over to a live agent              |
| Fan-Out  | Parallel execution        | Always   | Run multiple agents/tools concurrently |

---

## 1. Handoff (HANDOFF:)

A handoff transfers the conversation from one agent to another. The
supervisor (or any agent with a `HANDOFF:` section) decides **when** to
route based on conditions, and **what context** to pass along.

### 1a. Permanent Handoff (RETURN: false)

The parent agent is done. The target agent takes over the conversation
permanently. The parent thread is marked `completed`.

```yaml
SUPERVISOR: Support_Router

GOAL: 'Route users to the right support specialist'

HANDOFF:
  - TO: Billing_Agent
    WHEN: intent.category == "billing"
    CONTEXT:
      pass: [account_id, billing_history]
      summary: 'Customer has a billing question'
    RETURN: false
```

**What happens at runtime:**

1. The prompt builder generates a `handoff_to_Billing_Agent` tool with a
   typed input schema derived from the `PASS` fields and `MEMORY.session`
   declarations.
2. When the LLM calls the tool, the routing executor validates the target
   (exists, no self-handoff, no cycle), builds merged context from session
   metadata → LLM context → `PASS` fields (each layer overrides the
   previous), and creates a new thread.
3. The parent thread status becomes `completed` and its `endedAt` timestamp
   is set. The child thread becomes active and the user now talks directly
   to `Billing_Agent`.

### 1b. Temporary Handoff (RETURN: true)

The parent agent waits while the child handles a sub-conversation. When the
child completes or calls `__return_to_parent__`, control returns to the
parent. The alias `EXPECT_RETURN: true` is also accepted.

```yaml
SUPERVISOR: TravelDesk

HANDOFF:
  - TO: Authentication_Agent
    WHEN: user.is_authenticated == false AND intent.category == "manage_booking"
    CONTEXT:
      pass: [session_context, return_to]
      summary: 'User needs to authenticate before managing their booking'
    RETURN: true
    ON_RETURN: 'route_to_booking_manager'

  - TO: Welcome_Agent
    WHEN: intent.category == "greeting"
    CONTEXT:
      pass: [session_context]
      summary: 'User greeting'
    RETURN: true
    ON_RETURN: 'await_next_request'
```

**What happens at runtime:**

1. The parent thread status becomes `waiting` and its index is pushed onto
   the session's `threadStack`.
2. A new thread is created for the child agent. The child receives a
   `__return_to_parent__` tool described as "Return control to your
   supervisor ({parent_name}). Use ONLY when the user asks something
   outside your capabilities."
3. When the child completes or calls `__return_to_parent__`, the runtime
   pops the `threadStack`, resumes the parent thread, and runs the
   `ON_RETURN` handler. If `ON_RETURN` has a `MAP`, child session values
   are copied to the parent using the mapping. If no `MAP` is specified,
   **all** gathered data from the child merges back into the parent.

### 1c. Handoff with Priority

When multiple handoff rules could match, use `PRIORITY` to control
evaluation order. Lower number = evaluated first. The prompt builder sorts
tools by priority so the LLM sees higher-priority targets first.

```yaml
HANDOFF:
  - TO: Live_Agent_Transfer
    WHEN: intent.category == "escalation" OR user.frustration_detected == true
    PRIORITY: 1
    CONTEXT:
      pass: [user_id, conversation_summary]
      summary: 'User requests human help or is frustrated'
    RETURN: false

  - TO: Sales_Agent
    WHEN: intent.category == "new_booking"
    PRIORITY: 5
    CONTEXT:
      pass: [search_context, budget]
      summary: 'User looking to book travel'
    RETURN: false

  - TO: Fallback_Handler
    WHEN: intent.unclear == true
    PRIORITY: 10
    CONTEXT:
      pass: [last_message]
      summary: 'Need clarification on user intent'
    RETURN: true
```

### 1d. Handoff with ON_RETURN Handlers

`ON_RETURN` controls what happens when a child agent returns to the parent.
The runtime supports exactly two built-in actions: `continue` and
`resume_intent`. Any other string is treated as a named handler reference
(see section 1e).

**Simple string (named handler reference):**

```yaml
HANDOFF:
  - TO: Auth_Agent
    WHEN: needs_auth == true
    RETURN: true
    ON_RETURN: 'route_to_booking_manager'
```

**Action with data mapping:**

```yaml
HANDOFF:
  - TO: Specialist_Booking
    WHEN: intent == "booking"
    RETURN: true
    ON_RETURN:
      ACTION: continue
      MAP:
        confirmation_id: booking_ref
        total_price: price
```

The `MAP` takes values from the child's session and maps them into the
parent's session. The format is `child_key: parent_key` — the left side is
the variable name in the child, the right side is where it lands in the
parent.

**resume_intent — replay the user's last message:**

```yaml
HANDOFF:
  - TO: Fallback_Handler
    WHEN: intent.confidence < 0.5
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent
```

After the child returns, the parent re-processes the user's original message
with updated context. This is useful for auth gates (authenticate, then
resume the original request) and clarification flows. The runtime enforces a
maximum continuation depth to prevent infinite re-routing loops.

**HANDLER reference inside ON_RETURN block:**

```yaml
HANDOFF:
  - TO: Auth_Agent
    WHEN: needs_auth == true
    RETURN: true
    ON_RETURN:
      HANDLER: route_to_booking_manager
```

### 1e. Named Return Handlers (RETURN_HANDLERS:)

For complex post-return logic, define named handlers at the agent level:

```yaml
RETURN_HANDLERS:
  route_to_booking_manager:
    RESPOND: "Great, you're authenticated. Let me connect you with booking."
    CLEAR: [auth_token_temp]
    RESUME_INTENT: true

  await_next_request:
    RESPOND: 'Is there anything else I can help with?'
    CONTINUE: true

  reclassify_intent:
    CLEAR: [intent]
    RESUME_INTENT: true
```

Then reference them in your handoff:

```yaml
HANDOFF:
  - TO: Auth_Agent
    WHEN: needs_auth == true
    RETURN: true
    ON_RETURN: 'route_to_booking_manager'
```

The runtime resolves the handler name by looking up
`coordination.return_handlers[name]` on the parent agent's compiled IR.

**Handler properties:**
| Property | Type | Description |
|----------------|---------|------------------------------------------------|
| RESPOND | string | Message to send to the user on return |
| CLEAR | list | Session variables to clear before resuming |
| CONTINUE | bool | Wait for next user turn (default behavior) |
| RESUME_INTENT | bool | Replay the user's last message through the parent |

### 1f. Handoff ON_FAILURE

When a handoff fails (target not found, auth requirements not met, guardrail
blocked), the `ON_FAILURE` property controls recovery. The default is
`continue` (silently proceed).

```yaml
HANDOFF:
  - TO: Specialist_Agent
    WHEN: intent.category == "specialist"
    ON_FAILURE: respond
    CONTEXT:
      summary: 'Specialist request'
    RETURN: false
```

**Handoff ON_FAILURE actions:**

| Action     | Description                                            |
| ---------- | ------------------------------------------------------ |
| `continue` | (Default) Silently continue — the parent keeps talking |
| `respond`  | Send a failure message to the user and continue        |
| `escalate` | Trigger escalation to a human agent                    |

Note: `retry` is only available on `DELEGATE`, not on `HANDOFF`.

---

## 2. Handoff Context (CONTEXT:)

Every handoff carries context to the target agent. The `CONTEXT` block
controls exactly what data flows across the boundary.

### Context Merge Priority

The runtime builds merged context in this order (each layer overrides the
previous):

1. **Session metadata** (lowest) — auto-propagated fields like
   `conversationSummary`, `user`, `gender`, `location` flow from parent to
   child without explicit `PASS` config.
2. **LLM-provided context** — values the LLM includes when calling the
   handoff tool (extracted from user message).
3. **PASS fields** (highest) — explicitly declared fields resolved from
   the parent's session data. These **always win** over LLM-provided values,
   ensuring data integrity for security-sensitive fields.

### PASS — explicit field forwarding

```yaml
CONTEXT:
  pass: [user_id, booking_context, auth_token]
  summary: 'Authenticated user managing their reservation'
```

`PASS` fields are resolved from the parent agent's session data at handoff
time. Each field is also exposed in the handoff tool's input schema, typed
using the corresponding `MEMORY.session` declaration if one exists.

### SUMMARY — natural language context

The `summary` is interpolated with session variables using `{{var}}`
syntax and passed as `_handoff_summary` to the target agent:

```yaml
CONTEXT:
  pass: [booking_id]
  summary: 'User wants to modify booking {{booking_id}} — calculate fees'
```

### HISTORY — conversation history strategy

Controls how much conversation history the target agent receives:

```yaml
CONTEXT:
  history: full # Send entire conversation history
```

| Mode           | Description                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`         | (Default) Uses `summary_only` if a summary is provided and the target supports it, otherwise falls back to `last_n` with a platform-configured count |
| `none`         | No history — fresh start                                                                                                                             |
| `summary_only` | Only the SUMMARY text, no message history                                                                                                            |
| `full`         | Entire conversation history                                                                                                                          |
| `last_n`       | Last N messages (use object form to specify count)                                                                                                   |

**Object form for last_n:**

```yaml
CONTEXT:
  history:
    mode: last_n
    count: 10
```

**Legacy shorthand:** `history: last_5` (the `last_N` format is auto-parsed).

### MEMORY_GRANTS — shared memory access

Grant the child agent read or read/write access to specific persistent
memory paths:

```yaml
CONTEXT:
  pass: [user_id]
  summary: 'Check user preferences'
  memory_grants:
    - path: user.preferences
      access: read
    - path: user.language
      access: readwrite
```

Granted memory values are resolved from the parent's memory store and
injected into the child's merged context. Write-back (`readwrite`) grants
allow the child to persist changes via the `__set_context__` tool.

---

## 3. Remote Handoff (A2A Protocol)

Hand off to an agent running on a different server using the A2A
(Agent-to-Agent) protocol.

```yaml
SUPERVISOR: Appointment_Desk

HANDOFF:
  - TO: Appointment_Scheduling_Agent
    WHEN: true
    LOCATION: REMOTE
    ENDPOINT: '{{config.APPOINTMENT_AGENT_URL}}'
    PROTOCOL: A2A
    CONTEXT:
      summary: 'User wants to manage appointments.'
      history: full
    RETURN: true
```

**Remote-specific ABL properties:**

| Property | Values            | Description                                                              |
| -------- | ----------------- | ------------------------------------------------------------------------ |
| LOCATION | `REMOTE`          | Marks this as a remote agent                                             |
| ENDPOINT | URL string        | The A2A endpoint (supports `{{config.*}}` and `{{env.*}}` interpolation) |
| PROTOCOL | `A2A` or `REST`   | Communication protocol                                                   |
| ASYNC    | `true`/`false`    | Use async dispatch with push notification barriers                       |
| TIMEOUT  | integer (seconds) | Timeout for the remote call                                              |

**Authentication for remote agents** is not configured in ABL syntax.
Instead, credentials are managed through the **External Agent Registry** in
Studio (Project Settings → Agent Transfer). The runtime's
`enrichWithRegistryAuth` method looks up the target agent name in the
registry at dispatch time and attaches `bearer` or `api_key` credentials
from encrypted storage. This keeps secrets out of ABL files.

**What happens at runtime:**

1. The runtime resolves the remote endpoint (with SSRF validation), builds
   an A2A `sendTask` request with the user message and context.
2. History is serialized into `message.metadata.history` based on the
   configured strategy.
3. For `RETURN: true`, the runtime creates a tracking thread and waits for
   the remote agent's response.
4. For `ASYNC: true`, the runtime uses barrier-based coordination with push
   notifications.

---

## 4. Delegate (DELEGATE:)

A delegate is a **structured sub-task**. Unlike handoff, the child agent
never talks to the user directly. The parent sends specific input, the child
returns structured output, and the parent uses the result.

```yaml
AGENT: Booking_Manager

DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: action_type == "modify"
    PURPOSE: 'Calculate modification fees'
    INPUT:
      booking_id: booking_id
      changes: change_details
    RETURNS:
      total_fee: number
      breakdown: object[]
    USE_RESULT: 'Show fee breakdown to user'
    TIMEOUT: 10s
    ON_FAILURE: RESPOND "Unable to calculate fees"
```

**How delegate differs from handoff:**

| Aspect               | Handoff                     | Delegate                           |
| -------------------- | --------------------------- | ---------------------------------- |
| User interaction     | Child talks to user         | Parent talks to user               |
| Data flow            | Context + conversation      | Structured INPUT → RETURNS         |
| Conversation history | Configurable via HISTORY    | Not forwarded                      |
| Tool name            | `handoff_to_X`              | `delegate_to_X`                    |
| Return behavior      | Optional (RETURN flag)      | Always returns                     |
| ON_FAILURE options   | continue, respond, escalate | continue, respond, escalate, retry |
| Use case             | Route conversation          | Execute a sub-task                 |

The `INPUT` mapping uses dot-path resolution only (e.g., `user.name`). CEL
expressions are not supported in INPUT sources. If transformation is needed,
use `SET` before the DELEGATE to compute derived values, then reference those
in INPUT.

### Delegate with Failure Handling

```yaml
DELEGATE:
  - AGENT: Payment_Processor
    WHEN: payment_ready == true
    PURPOSE: 'Process the payment'
    INPUT:
      amount: total_amount
      method: payment_method
    RETURNS:
      transaction_id: string
      status: string
    USE_RESULT: 'Confirm payment to user'
    TIMEOUT: 30s
    ON_FAILURE:
      type: respond
      message: 'Payment processing is temporarily unavailable. Please try again.'
```

**Delegate ON_FAILURE actions:**

| Action                                | Description                          |
| ------------------------------------- | ------------------------------------ |
| `RESPOND "message"`                   | Send a message and continue          |
| `{ type: 'respond', message: '...' }` | Same as above, structured form       |
| `{ type: 'continue' }`                | Silently continue without the result |
| `{ type: 'escalate' }`                | Trigger escalation to human agent    |
| `{ type: 'retry', count: N }`         | Retry N times before failing         |

### Remote Delegate

Delegates also support `LOCATION`, `ENDPOINT`, and `PROTOCOL` for remote
execution via A2A:

```yaml
DELEGATE:
  - AGENT: External_Pricing_Engine
    WHEN: needs_pricing == true
    PURPOSE: 'Get real-time pricing from external service'
    LOCATION: REMOTE
    ENDPOINT: '{{config.PRICING_ENGINE_URL}}'
    PROTOCOL: A2A
    INPUT:
      product_id: selected_product
    RETURNS:
      price: number
      currency: string
    USE_RESULT: 'Show price to user'
    TIMEOUT: 15s
```

---

## 5. Escalate (ESCALATE:)

Escalation transfers the conversation to a human agent. It is triggered by
conditions you define and includes context to help the human agent.

```yaml
ESCALATE:
  triggers:
    - WHEN: routing_failures >= 3
      REASON: 'Multiple routing failures — system issue'
      PRIORITY: high

    - WHEN: user.frustration_detected == true
      REASON: 'User showing signs of frustration'
      PRIORITY: high
      TAGS: [sentiment, retention]

    - WHEN: intent.category == "complaint"
      REASON: 'Customer complaint requires immediate attention'
      PRIORITY: critical
      TAGS: [complaint]

  context_for_human:
    - user_id
    - conversation_history
    - routing_history

  on_human_complete:
    - IF human.resolved == true: COMPLETE
    - IF human.needs_agent == true: HANDOFF to specified_agent
```

**Escalation properties:**

| Property            | Description                                        |
| ------------------- | -------------------------------------------------- |
| `triggers`          | List of conditions with reason, priority, and tags |
| `context_for_human` | Data fields to pass to the human agent desktop     |
| `routing`           | Optional ITSM/ticketing integration config         |
| `on_human_complete` | Actions after the human finishes                   |
| `connectorAction`   | ITSM connector action name for ticket creation     |

**Priority levels:** `low`, `medium`, `high`, `critical` (or numeric)

### Escalation via ON_ERROR

Escalation is commonly used as a fallback in error handling:

```yaml
ON_ERROR:
  routing_failure:
    RESPOND: "I'm having trouble understanding your request."
    RETRY: 1
    THEN: ESCALATE

  agent_unavailable:
    RESPOND: 'That service is temporarily unavailable.'
    RETRY: 2
    THEN: ESCALATE
```

---

## 6. Fan-Out (Parallel Execution)

Fan-out runs multiple agents or tools concurrently, collects results, and
synthesizes a combined response. This is handled by the runtime's
orchestration layer when a supervisor identifies multiple independent
sub-tasks.

Fan-out creates child threads for each branch, uses a barrier for
coordination, and collects results into the parent thread. It supports
mixed local and remote agents, with a configurable concurrency semaphore.

For async fan-out (when branches include remote agents), the runtime creates
a barrier in Redis with a total branch count, dispatches all branches, and
waits for all branches to complete or timeout before synthesizing.

---

## 7. Handoff Safety & Guardrails

The runtime enforces several safety mechanisms during handoff:

### Cycle Detection

The runtime maintains a `handoffStack` to prevent A → B → A cycles:

```
Handoff cycle detected: Sales_Agent → Auth_Agent → Sales_Agent
```

### Self-Handoff Prevention

An agent cannot hand off to itself:

```
Cannot hand off to yourself (Sales_Agent). Either help the user directly
or choose a different target.
```

### Target Validation

Only agents listed in the `HANDOFF:` section (or supervisor `ROUTING` rules)
are valid targets. The LLM cannot route to arbitrary agents. Invalid targets
produce an error listing the valid options:

```
Invalid handoff target: "Unknown_Agent". Valid targets are: Sales_Agent,
Support_Agent, Billing_Agent. Do NOT hand off to yourself.
```

### WHEN Pre-Evaluation

If a `WHEN` condition evaluates to deterministically `false` given the
current session state, the corresponding `handoff_to_X` tool is excluded
from the LLM's tool list entirely. The LLM never sees routing options that
cannot apply.

### Handoff Guardrails

Apply guardrails specifically to handoff context using the `handoff` kind:

```yaml
GUARDRAILS:
  - NAME: pii_in_handoff
    KIND: handoff
    CHECK: 'Context must not contain raw PII'
    ACTION: redact
```

The guardrail pipeline evaluates the merged context before it reaches the
target agent. It can block, redact, or warn. Guardrail failures are
fail-open by default — errors in the guardrail pipeline log a warning but do
not block the handoff.

### Auth Preflight

Before a local handoff, the runtime validates that the target agent's
required auth profiles (OAuth connectors, API credentials) are satisfied. If
not, the handoff is blocked:

```
Cannot hand off to CRM_Agent until required auth profiles are authorized:
salesforce_oauth (user_oauth)
```

### SSRF Protection

Remote handoff endpoints are validated against SSRF rules before dispatch.
Internal/private IP ranges are blocked unless explicitly allowed in dev mode.

---

## 8. Scenario: IT Assistant (Knowledge + Tickets)

This section walks through a realistic multi-agent IT support system that
combines knowledge search (via SearchAI), ticket creation, and ticket status
lookups in one unified assistant. It demonstrates how all the handoff
patterns work together in a real enterprise scenario.

### Architecture Overview

```
┌─────────────────────────────────────────────┐
│           IT_Support_Supervisor             │
│  Routes by intent, manages auth gates       │
├─────────┬──────────┬──────────┬─────────────┤
│         │          │          │             │
▼         ▼          ▼          ▼             ▼
Knowledge  Ticket     Ticket     Live_Agent   Password
_Search    _Creator   _Status    _Transfer    _Reset
(SearchAI) (HTTP)     (HTTP)     (Escalation) (HTTP)
```

### 8a. The Supervisor — IT_Support_Supervisor

```yaml
SUPERVISOR: IT_Support_Supervisor
VERSION: "1.0"
DESCRIPTION: "Enterprise IT help desk that routes users to knowledge base, ticket management, or live support"
GOAL: "Resolve IT issues quickly by searching knowledge first, creating tickets when needed, and escalating to humans for complex problems"

PERSONA: |
  Friendly and efficient IT support assistant. Always tries to find an answer
  from the knowledge base before suggesting a ticket. Uses clear, non-technical
  language. Acknowledges frustration and acts quickly.

EXECUTION:
  temperature: 0.3
  max_tokens: 1500
  max_iterations: 5
  inline_gather: true
  pipeline:
    enabled: true
    mode: sequential

LIMITATIONS:
  - "Cannot access production systems or make configuration changes directly"
  - "Cannot reset passwords without identity verification"
  - "Cannot view or modify other users' tickets"

ON_START:
  RESPOND: |
    Hi! I'm your IT support assistant. I can help you with:
    - Searching our knowledge base for solutions
    - Creating or checking the status of support tickets
    - Connecting you with a live IT specialist

    What can I help you with today?

MEMORY:
  session:
    - user_email
      TYPE: string
      DESCRIPTION: "The user's corporate email for ticket operations"
    - user_department
      TYPE: string
      DESCRIPTION: "User's department for ticket routing"
    - issue_category
      TYPE: string
      DESCRIPTION: "Classified IT issue category (network, software, hardware, access, email)"
    - issue_description
      TYPE: string
      DESCRIPTION: "Natural language description of the user's IT problem"
    - ticket_id
      TYPE: string
      DESCRIPTION: "Ticket ID when user asks about an existing ticket"
    - kb_search_attempted
      TYPE: boolean
      DESCRIPTION: "Whether knowledge base was already searched for this issue"
    - kb_answer_found
      TYPE: boolean
      DESCRIPTION: "Whether the knowledge base had a relevant answer"
    - conversation_summary
      TYPE: string
      DESCRIPTION: "Running summary for handoff context"
    - escalation_reason
      TYPE: string
      DESCRIPTION: "Why the user is being transferred to a human"

HANDOFF:
  # P1 — Immediate escalation (frustration, explicit request for human)
  - TO: Live_Agent_Transfer
    WHEN: intent.category == "escalation" OR user.frustration_detected == true
    PRIORITY: 1
    CONTEXT:
      pass: [user_email, issue_category, issue_description, conversation_summary]
      summary: "User requesting human IT support — {{escalation_reason}}"
    RETURN: false

  # P2 — Password reset (requires identity verification first)
  - TO: Password_Reset_Agent
    WHEN: intent.category == "password_reset"
    PRIORITY: 2
    CONTEXT:
      pass: [user_email]
      summary: "User needs password reset"
    RETURN: true
    ON_RETURN: "post_password_reset"

  # P3 — Check existing ticket status
  - TO: Ticket_Status_Agent
    WHEN: intent.category == "ticket_status" OR ticket_id IS SET
    PRIORITY: 3
    CONTEXT:
      pass: [user_email, ticket_id]
      summary: "User checking on support ticket {{ticket_id}}"
      history: summary_only
    RETURN: true
    ON_RETURN:
      ACTION: continue

  # P4 — Knowledge base search (first attempt at solving the problem)
  - TO: Knowledge_Search_Agent
    WHEN: intent.category == "troubleshoot" AND kb_search_attempted != true
    PRIORITY: 4
    CONTEXT:
      pass: [issue_category, issue_description]
      summary: "Search knowledge base for: {{issue_description}}"
      history: none
    RETURN: true
    ON_RETURN: "post_kb_search"

  # P5 — Create ticket (KB searched but no answer, or user explicitly asks)
  - TO: Ticket_Creator_Agent
    WHEN: (kb_search_attempted == true AND kb_answer_found != true) OR intent.category == "create_ticket"
    PRIORITY: 5
    CONTEXT:
      pass: [user_email, user_department, issue_category, issue_description, conversation_summary]
      summary: "Create support ticket for: {{issue_description}}"
      history: summary_only
    RETURN: true
    ON_RETURN:
      ACTION: continue
      MAP:
        created_ticket_id: ticket_id

  # P6 — Fallback (unclear intent)
  - TO: Knowledge_Search_Agent
    WHEN: intent.unclear == true
    PRIORITY: 6
    CONTEXT:
      pass: [issue_description]
      summary: "Unclear request — try knowledge base first"
      history: none
    RETURN: true
    ON_RETURN: "post_kb_search"

RETURN_HANDLERS:
  post_kb_search:
    RESPOND: |
      I searched our knowledge base for your issue.
      Would you like me to create a support ticket if this didn't resolve your problem?
    CONTINUE: true

  post_password_reset:
    RESPOND: "Your password has been handled. Is there anything else I can help with?"
    CLEAR: [issue_category, issue_description]
    CONTINUE: true

ESCALATE:
  triggers:
    - WHEN: routing_failures >= 3
      REASON: "Multiple routing failures — system issue"
      PRIORITY: high
    - WHEN: user.frustration_detected == true
      REASON: "User frustration detected"
      PRIORITY: high
      TAGS: [sentiment]
    - WHEN: handoff_count >= 4
      REASON: "User bounced between too many agents"
      PRIORITY: high
      TAGS: [ux_failure]

  context_for_human:
    - user_email
    - issue_category
    - issue_description
    - conversation_history

  on_human_complete:
    - IF human.resolved == true: COMPLETE
    - IF human.needs_agent == true: HANDOFF to specified_agent

ON_ERROR:
  routing_failure:
    RESPOND: "I'm having trouble routing your request. Let me try again."
    RETRY: 1
    THEN: ESCALATE

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "I've connected you with the right resource."
  - WHEN: user.session_ended == true
    RESPOND: "Thanks for contacting IT support. Have a great day!"
```

### 8b. Knowledge_Search_Agent — SearchAI Knowledge Lookup

This agent uses a `searchai` tool type to query the organization's knowledge
base. It returns with its findings so the supervisor can decide next steps.

```yaml
AGENT: Knowledge_Search_Agent
GOAL: "Search the IT knowledge base and provide solutions to common IT problems"

PERSONA: |
  Knowledgeable IT specialist. Searches the company knowledge base thoroughly
  before answering. Always cites the source article when providing solutions.
  If the knowledge base doesn't have an answer, says so clearly — never
  guesses or fabricates solutions.

EXECUTION:
  temperature: 0.2
  max_tokens: 2000

LIMITATIONS:
  - "Must only provide answers found in the knowledge base — never fabricate solutions"
  - "Cannot make system changes — only provide instructions"
  - "Must cite the source article for every solution"

TOOLS:
  it_kb_search(query: string, category: string = "") -> {results: object[], answer: string}
    description: "Search the IT knowledge base for solutions and articles"
    type: searchai

GATHER:
  issue_description:
    prompt: "Can you describe the IT issue you're experiencing?"
    type: string
    required: true

COMPLETE:
  - WHEN: it_kb_search.results != null AND it_kb_search.answer != ""
    RESPOND: |
      Here's what I found in our knowledge base:

      {{it_kb_search.answer}}

      Source: {{it_kb_search.results[0].title}}
  - WHEN: it_kb_search.results == null OR it_kb_search.answer == ""
    RESPOND: "I wasn't able to find a solution in our knowledge base for this issue."
```

### 8c. Ticket_Creator_Agent — Create Support Tickets

This agent creates ITSM tickets via an HTTP tool and returns the ticket ID
to the supervisor.

```yaml
AGENT: Ticket_Creator_Agent
GOAL: "Create IT support tickets with proper categorization and all required details"

PERSONA: |
  Efficient ticket creation specialist. Gathers all necessary information,
  categorizes correctly, and confirms the ticket details before submitting.

EXECUTION:
  temperature: 0.2
  max_tokens: 1000

TOOLS:
  create_ticket(title: string, description: string, category: string, priority: string, requester_email: string, department: string) -> {ticket_id: string, status: string, url: string}
    description: "Create a new IT support ticket in the ticketing system"
    type: http
    endpoint: "{{env.ITSM_API_URL}}/api/tickets"
    method: POST
    auth: bearer

GATHER:
  issue_description:
    prompt: "Please describe the issue in detail."
    type: string
    required: true

  priority:
    prompt: "How urgent is this? (low, medium, high, critical)"
    type: string
    required: true
    validation: "Must be one of: low, medium, high, critical"

MEMORY:
  session:
    - created_ticket_id
      TYPE: string
      DESCRIPTION: "The ID of the newly created ticket"

COMPLETE:
  - WHEN: create_ticket.ticket_id IS SET
    RESPOND: |
      Your support ticket has been created:
      - Ticket ID: {{create_ticket.ticket_id}}
      - Status: {{create_ticket.status}}
      - You can track it at: {{create_ticket.url}}

      A support engineer will be assigned shortly.
```

### 8d. Ticket_Status_Agent — Check Ticket Status

This agent looks up existing tickets and returns status to the supervisor.
It uses `RETURN: true` so the user stays with the supervisor afterward.

```yaml
AGENT: Ticket_Status_Agent
GOAL: "Look up the status and details of existing IT support tickets"

PERSONA: |
  Helpful status checker. Retrieves ticket information quickly and presents
  it clearly. If the ticket isn't found, suggests checking the ticket ID.

EXECUTION:
  temperature: 0.1
  max_tokens: 1000

TOOLS:
  get_ticket(ticket_id: string) -> {ticket_id: string, title: string, status: string, assigned_to: string, priority: string, created_at: string, updated_at: string, comments: object[]}
    description: "Retrieve details of an IT support ticket"
    type: http
    endpoint: "{{env.ITSM_API_URL}}/api/tickets/{{input.ticket_id}}"
    method: GET
    auth: bearer

  list_my_tickets(email: string, status: string = "open") -> {tickets: object[], total: number}
    description: "List all tickets for a specific user"
    type: http
    endpoint: "{{env.ITSM_API_URL}}/api/tickets?requester={{input.email}}&status={{input.status}}"
    method: GET
    auth: bearer

GATHER:
  ticket_id:
    prompt: "What's your ticket ID? (e.g., INC-12345) Or I can look up all your open tickets."
    type: string
    required: false

COMPLETE:
  - WHEN: get_ticket.ticket_id IS SET
    RESPOND: |
      Here's the status of your ticket:
      - Ticket: {{get_ticket.ticket_id}} — {{get_ticket.title}}
      - Status: {{get_ticket.status}}
      - Priority: {{get_ticket.priority}}
      - Assigned to: {{get_ticket.assigned_to}}
      - Last updated: {{get_ticket.updated_at}}
  - WHEN: list_my_tickets.total > 0
    RESPOND: "I found {{list_my_tickets.total}} open ticket(s) for your account."
```

### 8e. Conversation Flow Examples

**Scenario 1: KB search resolves the issue**

```
User: "My VPN keeps disconnecting every 10 minutes"
  → Supervisor routes to Knowledge_Search_Agent (P4: troubleshoot, kb not yet searched)
  → KB agent searches, finds article "VPN Timeout Fix — Increase Keep-Alive"
  → KB agent returns with solution
  → Supervisor runs post_kb_search handler, asks if resolved
User: "That fixed it, thanks!"
  → Supervisor completes
```

**Scenario 2: KB search fails → ticket creation**

```
User: "My laptop screen flickers when connected to the dock"
  → Supervisor routes to Knowledge_Search_Agent (P4)
  → KB agent searches, no results
  → KB agent returns, kb_answer_found=false
  → Supervisor runs post_kb_search handler
User: "Yes, please create a ticket"
  → Supervisor routes to Ticket_Creator_Agent (P5: kb searched, no answer)
  → Ticket agent gathers priority, creates ticket INC-34567
  → Ticket agent returns, MAP copies created_ticket_id → ticket_id
  → Supervisor confirms ticket to user
```

**Scenario 3: Direct ticket status check**

```
User: "What's the status of INC-12345?"
  → Supervisor routes to Ticket_Status_Agent (P3: ticket_id detected)
  → Status agent calls get_ticket, returns details
  → Supervisor receives data back via ON_RETURN: continue
User: "Can you also check INC-12346?"
  → Supervisor routes to Ticket_Status_Agent again (P3)
  → Status agent returns with second ticket's details
```

**Scenario 4: Password reset with auth gate**

```
User: "I need to reset my Active Directory password"
  → Supervisor routes to Password_Reset_Agent (P2)
  → Password agent verifies identity (security questions, MFA)
  → Password agent processes reset, returns
  → Supervisor runs post_password_reset handler, clears issue context
User: "Actually, I also can't connect to WiFi"
  → Supervisor routes to Knowledge_Search_Agent (P4: new issue)
```

**Scenario 5: Frustration → human escalation**

```
User: "This is the third time I'm asking about this! Nothing works!"
  → Supervisor detects frustration, routes to Live_Agent_Transfer (P1)
  → Full conversation_summary passed to human agent
  → Human resolves or re-routes
```

**Scenario 6: Unclear intent → KB fallback**

```
User: "Teams is being weird"
  → Supervisor can't classify intent clearly
  → Routes to Knowledge_Search_Agent (P6: unclear, try KB)
  → KB agent searches "Microsoft Teams issues", finds common fixes
  → Returns to supervisor with results
```

---

## 9. Complete Example — Multi-Agent Travel System

Here is a full supervisor with multiple handoff patterns:

```yaml
SUPERVISOR: TravelDesk_Supervisor
GOAL: "Route customers to the right specialist with full context"

PERSONA: |
  Professional travel booking assistant.
  Routes requests quickly and transparently.

MEMORY:
  session:
    - current_intent
      TYPE: string
    - user_id
      TYPE: string
    - booking_context
      TYPE: object
    - conversation_summary
      TYPE: string
    - search_context
      TYPE: object

HANDOFF:
  # Priority 1 — Human escalation
  - TO: Live_Agent_Transfer
    WHEN: intent.category == "escalation" OR user.frustration_detected == true
    PRIORITY: 1
    CONTEXT:
      pass: [user_id, conversation_summary, booking_context]
      summary: "User requests human help or is frustrated"
    RETURN: false

  # Priority 2 — Auth gate before booking management
  - TO: Authentication_Agent
    WHEN: user.is_authenticated == false AND intent.category == "manage_booking"
    PRIORITY: 2
    CONTEXT:
      pass: [session_context]
      summary: "Authenticate before accessing booking"
    RETURN: true
    ON_RETURN: "route_to_booking"

  # Priority 3 — Booking management (post-auth)
  - TO: Booking_Manager
    WHEN: user.is_authenticated == true AND intent.category == "manage_booking"
    PRIORITY: 3
    CONTEXT:
      pass: [user_id, booking_context]
      summary: "User managing their reservation"
    RETURN: false

  # Priority 4 — New travel search
  - TO: Sales_Agent
    WHEN: intent.category == "new_booking" OR intent.category == "travel_search"
    PRIORITY: 4
    CONTEXT:
      pass: [search_context]
      summary: "User looking to book new travel"
    RETURN: false

  # Priority 5 — Fallback
  - TO: Fallback_Handler
    WHEN: intent.unclear == true
    PRIORITY: 5
    CONTEXT:
      pass: [conversation_summary]
      summary: "Need clarification"
    RETURN: true
    ON_RETURN:
      ACTION: resume_intent

RETURN_HANDLERS:
  route_to_booking:
    RESPOND: "You're verified! Connecting you with booking management."
    CLEAR: [auth_temp_token]
    RESUME_INTENT: true

ESCALATE:
  triggers:
    - WHEN: routing_failures >= 3
      REASON: "Multiple routing failures"
      PRIORITY: high
    - WHEN: handoff_count >= 5
      REASON: "Too many agent transfers"
      PRIORITY: high

  context_for_human:
    - user_id
    - conversation_history
    - routing_history

DELEGATE:
  - AGENT: Fee_Calculator
    WHEN: calculate_fees == true
    PURPOSE: "Calculate modification fees"
    INPUT:
      booking_id: booking_id
      changes: requested_changes
    RETURNS:
      total_fee: number
      breakdown: object[]
    USE_RESULT: "Present fee breakdown to user"

ON_ERROR:
  routing_failure:
    RESPOND: "I'm having difficulty. Let me try again."
    RETRY: 1
    THEN: ESCALATE

COMPLETE:
  - WHEN: handoff_successful == true
    RESPOND: "Connected you with the right specialist."
  - WHEN: user.session_ended == true
    RESPOND: "Thank you for using our service. Have a great trip!"
```

---

## 10. How It Works at Runtime

When the runtime processes a turn for an agent with handoffs:

1. **Tool generation** — The prompt builder creates per-agent tools
   (`handoff_to_Sales_Agent`, `delegate_to_Fee_Calculator`) from the
   `HANDOFF:` and `DELEGATE:` sections. Each tool has a typed input schema
   derived from the `PASS` fields and the agent's `MEMORY.session`
   declarations. Tools are sorted by `PRIORITY` so the LLM sees
   higher-priority targets first.

2. **WHEN pre-evaluation** — If a `WHEN` condition is deterministically
   false given current session state (all referenced variables are present
   and the condition evaluates to false), that tool is excluded from the
   LLM's tool list entirely. This means the LLM never even sees routing
   options that don't apply.

3. **LLM decision** — The LLM decides which tool to call based on the
   user's message, tool descriptions (which include the `WHEN` condition
   as guidance text and the `SUMMARY` as context), and schema.

4. **Validation** — The routing executor validates:
   - Target agent exists in the registry or is synthesized from remote config
   - No self-handoff (agent cannot route to itself)
   - No handoff cycle (A → B → A detected via `handoffStack`)
   - Target has valid compiled IR (for local agents)
   - Auth profile requirements are satisfied (for agents with OAuth/connectors)
   - SSRF preflight passes (for remote agents)

5. **Context building** — Merged context is assembled in this priority
   order (each layer overrides the previous):
   1. Session metadata (auto-propagated: conversationSummary, user info)
   2. LLM-provided context (from tool call parameters)
   3. PASS fields (from parent's session data — highest priority)
   4. SUMMARY (interpolated with parent's session variables, set as `_handoff_summary`)
   5. Memory grants (resolved from persistent memory store)

6. **Guardrail check** — If guardrails with `KIND: handoff` are configured,
   the merged context is evaluated before transfer. The pipeline can block,
   redact, or warn. Guardrail failures are fail-open (errors log but don't
   block).

7. **Thread management** —
   - `RETURN: false` → parent thread `completed`, child becomes active.
   - `RETURN: true` → parent thread `waiting`, pushed to `threadStack`.
     Handoff timeout tracking starts if `TIMEOUT` is configured.

8. **Execution** — For local agents, a new thread is created with the
   merged context and the child agent processes normally. For remote agents,
   an A2A `sendTask` request is dispatched with history serialized into
   `message.metadata.history`.

9. **Return** (if applicable) — On child completion or
   `__return_to_parent__` call:
   - The runtime pops the `threadStack` and resumes the parent thread.
   - If `ON_RETURN.MAP` is configured, mapped values copy from child to
     parent. Otherwise, **all** gathered data merges back.
   - `ON_RETURN.CLEAR` removes specified variables from both thread and
     session data.
   - `ON_RETURN.RESPOND` sends a message to the user.
   - `ON_RETURN.ACTION: resume_intent` replays the user's original message
     through the parent (with depth-limiting to prevent infinite loops).

---

## 11. Choosing the Right Pattern

| Scenario                                 | Pattern                             | Key Config                                                      |
| ---------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| User needs to talk to a different agent  | Handoff (permanent)                 | `RETURN: false`                                                 |
| Verify/authenticate, then come back      | Handoff with return                 | `RETURN: true` + `ON_RETURN: resume_intent`                     |
| Compute a value without user interaction | Delegate                            | `INPUT` + `RETURNS` + `USE_RESULT`                              |
| Run multiple things in parallel          | Fan-Out                             | Supervisor reasoning (automatic)                                |
| Transfer to a human                      | Escalate                            | `ESCALATE:` with triggers                                       |
| Route to an external service             | Remote Handoff                      | `LOCATION: REMOTE` + `ENDPOINT` + `PROTOCOL: A2A`               |
| Search knowledge base first, then decide | Handoff with return + named handler | `RETURN: true` + `ON_RETURN: "post_search"`                     |
| Create ticket after KB fails             | Conditional handoff                 | `WHEN: kb_search_attempted == true AND kb_answer_found != true` |
| Look up data silently for the parent     | Delegate to status agent            | `delegate_to_X` with `RETURNS`                                  |

---

## 12. ABL Property Reference

### HANDOFF entry properties

| Property        | Required | Default         | Description                                           |
| --------------- | -------- | --------------- | ----------------------------------------------------- |
| `TO`            | Yes      | —               | Target agent name (single word, matches agent file)   |
| `WHEN`          | Yes      | —               | Condition for this handoff (CEL-like expression)      |
| `PRIORITY`      | No       | insertion order | Evaluation/display priority (lower = first)           |
| `RETURN`        | No       | `false`         | Whether the parent waits for the child                |
| `EXPECT_RETURN` | No       | —               | Alias for `RETURN`                                    |
| `ON_RETURN`     | No       | merge all data  | Post-return behavior (string or block)                |
| `ON_FAILURE`    | No       | `continue`      | What to do if handoff fails                           |
| `CONTEXT`       | No       | empty           | Context block (pass, summary, history, memory_grants) |
| `LOCATION`      | No       | local           | `REMOTE` for A2A agents                               |
| `ENDPOINT`      | No       | —               | URL for remote agents                                 |
| `PROTOCOL`      | No       | —               | `A2A` or `REST`                                       |
| `ASYNC`         | No       | `false`         | Use async dispatch for remote agents                  |
| `TIMEOUT`       | No       | —               | Timeout in seconds for remote/async                   |

### DELEGATE entry properties

| Property     | Required | Default | Description                                         |
| ------------ | -------- | ------- | --------------------------------------------------- |
| `AGENT`      | Yes      | —       | Target agent name                                   |
| `WHEN`       | Yes      | —       | Condition for this delegation                       |
| `PURPOSE`    | Yes      | —       | Description of the sub-task                         |
| `INPUT`      | Yes      | —       | Key-value mapping (parent var → child input)        |
| `RETURNS`    | Yes      | —       | Expected return schema (name: type)                 |
| `USE_RESULT` | Yes      | —       | How the parent should use the result                |
| `TIMEOUT`    | No       | —       | Timeout string (e.g., `10s`, `30s`)                 |
| `ON_FAILURE` | No       | —       | Failure action (respond, continue, escalate, retry) |
| `LOCATION`   | No       | local   | `REMOTE` for A2A delegates                          |
| `ENDPOINT`   | No       | —       | URL for remote delegates                            |
| `PROTOCOL`   | No       | —       | `A2A` or `REST`                                     |
