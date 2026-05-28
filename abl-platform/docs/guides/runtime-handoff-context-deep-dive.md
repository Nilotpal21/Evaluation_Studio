# ABL Runtime: Handoff, Context & Transfer — Deep Dive

> **Scope:** How messages flow through the runtime, how agents decide to transfer control, how context is managed across agents, and every path back to the caller.

---

## 1. Message Entry Points

Every user message enters the runtime through one of these surfaces, all of which converge on `RuntimeExecutor.executeMessage()`:

| Entry Point                                               | File                                                     | How it reaches executeMessage                                               |
| --------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| **HTTP Chat API** (`POST /api/v1/chat`)                   | `routes/chat.ts:2550`                                    | Via `ExecutionCoordinator.submit()` → `executor.executeMessage()` fallback  |
| **WebSocket (SDK)**                                       | `websocket/sdk-handler.ts` → `websocket/handler.ts:2820` | Direct `executor.executeMessage()`                                          |
| **Channel Pipeline** (WhatsApp, Twilio, AudioCodes, etc.) | `channels/pipeline/message-pipeline.ts:60`               | `executeAndPersist()` → `enqueueLLMRequest()` → `executor.executeMessage()` |
| **Voice (KoreVG, LiveKit, S2S)**                          | `services/voice/`                                        | Via voice pipeline → `executor.executeMessage()`                            |
| **Internal Chat** (`POST /api/internal/chat`)             | `routes/chat.ts:966`                                     | Same as HTTP Chat, service-auth gated                                       |
| **Resumption (async A2A)**                                | `services/execution/resumption-service.ts`               | Calls `executor.executeMessage()` to resume suspended sessions              |

### Convergence point

```
Any Channel → [auth + rate-limit + tenant] → ExecutionCoordinator.submit() or direct executeMessage()
                                                        ↓
                                              RuntimeExecutor.executeMessage(sessionId, userMessage, onChunk, onTraceEvent, options)
```

`ExecutionCoordinator` (`services/execution/execution-coordinator.ts`) adds deduplication, concurrency control, and queueing. If not available, the route falls back to direct `executeMessage()`.

---

## 2. The Session Model

Defined in `services/execution/types.ts:221`, `RuntimeSession` is the in-memory representation of an active conversation. Key structures:

### 2.1 Threading Model

Sessions use a **thread-based model** rather than spawning child sessions:

```
RuntimeSession {
  threads: AgentThread[]          // Array of agent activations
  activeThreadIndex: number       // Which thread is currently executing
  threadStack: number[]           // Stack of parent thread indices (for return)
  handoffStack: string[]          // Agent name stack for cycle detection
  delegateStack: string[]         // Delegate chain for depth/cycle limits
}
```

Each `AgentThread` (`types.ts:153`) contains:

| Field                    | Purpose                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| `agentName`              | Which agent owns this thread                                              |
| `agentIR`                | Compiled agent IR (instructions, tools, routing)                          |
| `conversationHistory`    | This thread's conversation (role + content)                               |
| `data: SessionDataStore` | Values collected (gathered fields, SET vars, tool results)                |
| `status`                 | `active`, `waiting`, `completed`, `escalated`, `suspended`, `human_agent` |
| `returnExpected`         | Whether parent is waiting for this thread to complete                     |
| `handoffFrom`            | Name of the agent that created this thread                                |
| `handoffContext`         | Data passed from parent at handoff time                                   |
| `handoffTimeoutMs`       | Timeout for EXPECT_RETURN handoffs                                        |
| `handoffTimeoutAction`   | What to do on timeout: `escalate`, `respond:<msg>`, `continue`            |
| `activationAuthContext`  | Per-thread auth context (credentials, scopes)                             |

### 2.2 Session Data Store

```typescript
interface SessionDataStore {
  values: Record<string, unknown>; // All key-value data
  gatheredKeys: Set<string>; // Which keys came from user input
}
```

Every thread has its own `data`, and the session has a top-level `data` that mirrors the active thread via `syncThreadToSession()`.

---

## 3. The Execution Loop: executeMessage()

**File:** `services/runtime-executor.ts:2789`

```
executeMessage(sessionId, userMessage, onChunk, onTraceEvent, options)
  │
  ├── 1. Session lookup/rehydration
  │     └── In-memory map → Redis rehydration → stale-check refresh
  │
  ├── 2. Escalation pause check
  │     └── If session.isEscalated + has active suspension → reject message
  │
  ├── 3. Context preparation
  │     ├── Interaction context resolution (language, locale, timezone)
  │     ├── PII redaction of user message
  │     ├── Filler message setup
  │     └── Streaming guardrail wiring
  │
  ├── 4. Agent-Transfer intercept
  │     └── If session.transferInitiated → route to human agent bridge
  │
  ├── 5. Deterministic handoff check
  │     └── If IR has auto-handoff conditions → evaluate before LLM
  │
  ├── 6. EXECUTION (two paths)
  │     ├── A) Scripted Agent (has flow) → FlowStepExecutor
  │     └── B) Reasoning Agent → LLM call with tools
  │
  ├── 7. POST-TURN actions
  │     ├── return_to_parent handling
  │     ├── Runtime-evaluated completion (Option C)
  │     ├── resume_intent dispatch after thread return
  │     └── Intent queue surfacing
  │
  └── 8. Persist + cleanup
```

### Two Execution Modes

**Scripted (Flow) Agents** — step-by-step execution via `FlowStepExecutor`:

- Walk through defined steps (COLLECT, CALL, SET, RESPOND, COMPLETE, HANDOFF)
- GATHER fields from user with entity extraction
- ON_INPUT branching, intent detection, corrections
- Deterministic control flow with optional LLM extraction

**Reasoning Agents** — LLM-driven via the reasoning engine:

- System prompt built from IR (`buildSystemPrompt()`)
- Tools built from IR (`buildTools()`)
- LLM generates response + optional tool calls
- Tool calls dispatched → results fed back → next reasoning turn
- Multi-turn until: response without tools, complete, handoff, escalate, or return

---

## 4. How Handoff Decisions Are Made

### 4.1 Per-Agent Routing Tools

**File:** `services/execution/prompt-builder.ts:1395`

The LLM does **not** see a generic `__handoff__` tool with an enum of targets. Instead, each handoff target becomes its own tool:

```
IR routing rules / handoff config
  ↓
buildPerAgentTools()
  ↓
Tools presented to LLM:
  - handoff_to_Sales_Agent      ← from ROUTING rules
  - handoff_to_Billing_Agent    ← from HANDOFF coordination config
  - delegate_to_Fee_Calculator  ← from DELEGATE coordination config
  - __escalate_to_human__       ← from ESCALATION config
  - __return_to_parent__        ← only if thread.returnExpected
```

Each tool has:

- **Name:** `handoff_to_{agentName}` — gives the LLM a strong routing signal
- **Description:** Rule description + WHEN condition + return behavior
- **Input schema:** `message` (required), `reason`, plus any PASS field overrides
- **WHEN pre-evaluation:** Conditions are evaluated at prompt-build time; tools whose conditions are `false` are removed from the list

### 4.2 Decision Sources

| Decision Source                      | When It Triggers                                              | File                                  |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------- |
| **LLM tool call** (`handoff_to_X`)   | LLM decides during reasoning                                  | `runtime-executor.ts` action dispatch |
| **Deterministic auto-handoff**       | IR `auto_handoff` conditions evaluate to true before LLM runs | `runtime-executor.ts` pre-LLM check   |
| **Flow THEN: handoff**               | Scripted step transitions to HANDOFF                          | `flow-step-executor.ts`               |
| **Flow THEN: COMPLETE** with routing | Completion triggers a routing rule                            | `routing-executor.ts`                 |
| **Constraint violation**             | Guardrail triggers escalation/handoff                         | `constraint-checker.ts`               |
| **Handoff timeout**                  | Child agent exceeds timeout                                   | `types.ts:tryThreadReturn`            |
| **Intent detection** (flow)          | ON_INPUT intent matches a routing rule                        | `flow-step-executor.ts`               |

### 4.3 Validation Chain

When `handleHandoff()` is called (`routing-executor.ts:856`):

```
1. Resolve routing capabilities from active IR
2. Validate target is in valid handoff targets (IR-defined)
3. Prevent self-handoff (A → A)
4. Prevent recursion cycles (A → B → A) via handoffStack
5. Look up target in AgentRegistryStore (local) or synthesize remote entry
6. Validate via HandoffExecutor (compiler-level)
7. Evaluate handoff guardrails (Tier 1-3)
8. Validate auth requirements for target agent
9. Proceed to local or remote handoff
```

---

## 5. Context Transfer During Handoff

### 5.1 Context Assembly (routing-executor.ts:1022-1061)

When a handoff executes, context flows through these layers (last wins):

```
1. Session-level metadata (extractSessionMetadata)     ← lowest priority
   Copies parent thread values excluding:
   - Internal keys (prefixed with _)
   - Handoff tracking keys (handoff_from)
   - Gathered field keys
   - Null/empty values

2. LLM-provided context (input.context)                ← overrides metadata

3. PASS fields (handoffConfig.context.pass)            ← overrides LLM context
   Explicitly declared fields from parent data

4. SUMMARY (handoffConfig.context.summary)             ← interpolated template → _handoff_summary

5. Memory grants (memory_grants config)                ← read/readwrite access to declared memory paths
   Sources: thread values → user fact store → project fact store → execution tree
```

### 5.2 History Strategy

Controlled by `HISTORY` in the handoff config:

| Strategy       | Behavior                                  |
| -------------- | ----------------------------------------- |
| `full`         | Copy entire parent conversation history   |
| `last_n: N`    | Copy last N messages from parent          |
| `summary_only` | No history; summary in `_handoff_summary` |
| `none`         | No history, no summary                    |

Default: `summary_only` (configurable via `DEFAULT_HANDOFF_HISTORY_STRATEGY`).

### 5.3 Thread Creation vs Resume

At handoff time, the system checks for an existing **waiting** thread for the target agent:

```
Existing waiting thread found?
  YES → RESUME: reactivate thread, merge new context, preserve conversation history
  NO  → CREATE: new thread with history strategy + initial data from merged context
```

This means agents can be **re-entered** with their full prior state intact.

---

## 6. All Routing Actions & Their Return Paths

### 6.1 HANDOFF (Agent-to-Agent Transfer)

**File:** `routing-executor.ts:856`

Two variants based on `RETURN` config:

#### Permanent Handoff (RETURN: false — default)

```
Parent[active] → handoff_to_Child
  Parent.status = 'completed'
  Child thread created → becomes active
  Session continues with Child as the new owner
  Parent is done — no return path
```

#### Return Handoff (RETURN: true)

```
Parent[active] → handoff_to_Child
  Parent.status = 'waiting'
  threadStack.push(parent index)
  Child thread created → becomes active
  Child streams directly to user (onChunk forwarded)

  When child completes (__complete__ or __return_to_parent__):
    threadStack.pop() → parent index
    Parent.status = 'active'
    Data merged back (ON_RETURN.MAP or all gathered keys)
    Child response added to parent history as [ChildName]: response

    ON_RETURN actions:
      - continue: parent resumes naturally
      - resume_intent: replay original user message through parent
```

#### Return Data Mapping

```yaml
# In handoff config
ON_RETURN:
  MAP:
    child_field_a: parent_field_x # Structured mapping
    child_field_b: parent_field_y
```

If no MAP is specified, ALL gathered keys from child merge into parent.

### 6.2 DELEGATE (Synchronous Sub-Call)

**File:** `routing-executor.ts:3316`

```
Parent[active] → delegate_to_Worker
  Creates ephemeral child session (session.id + "__delegate__" + executionId)
  Executes child synchronously with timeout
  Child response stored in parent's data as use_result key
  Child thread cleaned up
  Parent continues with result

  Safety guards:
    - Self-delegation blocked
    - Cycle detection (delegateStack)
    - Max depth: MAX_DELEGATE_DEPTH
    - Timeout with AbortController
```

Key difference from handoff: **delegate does NOT stream to user**. The parent agent gets the result and synthesizes the final response.

### 6.3 FAN-OUT (Parallel Delegation)

**File:** `routing-executor.ts` (fan-out section)

```
Parent → fan_out([Agent_A, Agent_B, Tool_C])
  Creates parallel execution units
  Each unit runs independently (agent delegate or tool call)
  Results collected and formatted as structured summary
  Parent LLM synthesizes a single cohesive response

  Deduplication: same target+type merged
  Concurrency: controlled by CountingSemaphore
```

### 6.4 ESCALATE (Human Agent Transfer)

**File:** `routing-executor.ts:3619`

```
Agent → __escalate_to_human__(reason, priority)
  1. Validate escalation config exists in IR
  2. Validate reason length (min/max)
  3. session.isEscalated = true
  4. Create HumanTask record in DB
  5. If agent-transfer configured:
     └── Build transfer envelope (routing context, contact, voice data)
     └── Execute via AdapterRegistry (SmartAssist/Five9)
     └── Create transfer session in Redis
  6. Suspension record created if ON_HUMAN_COMPLETE handlers exist
  7. Session paused — subsequent messages blocked until resolution
```

### 6.5 COMPLETE (Conversation End)

**File:** `routing-executor.ts:5856`

```
Agent → complete(message?, store?)
  session.isComplete = true
  session.state.conversationPhase = 'complete'
  Optional: store collected data under key
  If child thread with returnExpected → tryThreadReturn()
```

### 6.6 RETURN_TO_PARENT (Child → Parent Digression)

**File:** Tool defined in `prompt-builder.ts:1271`, handled in `runtime-executor.ts:4189`

```
Child agent calls __return_to_parent__(reason, message)
  → Sets action.type = 'return_to_parent'
  → handleReturnToParentResult():
      threadStack.pop() → parent index
      Parent.status = 'active'
      Forward message to parent for re-routing
      Parent re-executes with forwarded message
```

This is how a specialist can say "this is outside my scope" and send the user back to the supervisor.

---

## 7. The Agent-Transfer Subsystem (Human Escalation)

**File:** `services/agent-transfer/index.ts`

A separate subsystem for routing conversations to **live human agents** via external contact center platforms.

### 7.1 Architecture

```
Escalation trigger (from RoutingExecutor)
  ↓
TransferToolExecutor (services/execution/transfer-tool-executor.ts)
  ↓
AdapterRegistry → [SmartAssist (Kore), Five9, ...]
  ↓
TransferSessionStore (Redis)          ← encrypted session state
  ↓
MessageBridge (cross-pod relay)       ← routes agent events to user channel
  ↓
Session Recovery Service              ← handles pod failures
```

### 7.2 Transfer Tools

Defined in `transfer-tool-executor.ts:33`:

| Tool                 | Purpose                              |
| -------------------- | ------------------------------------ |
| `transfer_to_agent`  | Initiate transfer to human agent     |
| `check_hours`        | Check contact center business hours  |
| `check_availability` | Check agent availability             |
| `set_queue`          | Set the target queue before transfer |
| `ivr_menu`           | Voice-only: present IVR menu         |
| `ivr_digit_input`    | Voice-only: collect DTMF input       |
| `call_transfer`      | Voice-only: blind/warm call transfer |
| `deflect_to_chat`    | Voice-only: deflect caller to chat   |

### 7.3 Transfer Session Lifecycle

```
1. INITIATE
   └── Build transfer envelope (contact, routing, context snapshot)
   └── Create encrypted Redis session
   └── Execute via adapter (SmartAssist API / Five9 API)

2. ACTIVE
   └── agent:connected event → update session state
   └── agent:message events → route to user via MessageBridge
   └── Cross-pod relay via Redis pub/sub

3. COMPLETE
   └── agent:disconnected event
   └── Clear runtime session transfer flags
   └── Optional: CSAT survey (voice)
   └── Session timeout cleanup (BullMQ)

4. CLEANUP
   └── Redis keyspace expiry notification → SREM from active set
   └── Session recovery on pod restart
```

### 7.4 Transfer Routing Context

**File:** `services/agent-transfer/transfer-routing-context.ts`

Builds a rich envelope for the human agent:

```typescript
RuntimeTransferEnvelope {
  contactId       // Resolved from caller context, session values, or session ID
  contact         // Name, email, phone, customerId
  routing         // runtimeSessionId, channel, voice SIP data
  contextSnapshot // Identity hints, interaction context, session context
  language        // Resolved language
  voiceData       // Call SID, SIP call ID for voice transfers
}
```

---

## 8. Complete Decision Tree — All Possible Outcomes

```
User Message Arrives
  │
  ├── Session escalated? → BLOCKED (return escalation_blocked)
  │
  ├── Transfer active? → Route to human agent bridge
  │
  ├── Deterministic auto-handoff? → HANDOFF (skip LLM)
  │
  ├── Scripted (Flow) Agent?
  │     ├── GATHER step → extract entities → validate → ask for missing
  │     ├── CALL step → execute tool → ON_SUCCESS/ON_FAILURE branching
  │     ├── SET step → compute values
  │     ├── RESPOND step → emit response
  │     ├── THEN: COMPLETE → COMPLETE action
  │     ├── THEN: handoff_to_X → HANDOFF action
  │     ├── Intent detected → ON_INPUT routing
  │     ├── Constraint violation → escalate / backtrack / respond
  │     └── Digression → delegate or handoff
  │
  └── Reasoning Agent?
        ├── LLM call with tools
        │     ├── Text response only → CONTINUE (respond to user)
        │     ├── handoff_to_X tool → HANDOFF
        │     ├── delegate_to_X tool → DELEGATE (sync sub-call)
        │     ├── __escalate_to_human__ tool → ESCALATE
        │     ├── __return_to_parent__ tool → RETURN_TO_PARENT
        │     ├── __fan_out__ tool → FAN_OUT (parallel)
        │     ├── __set_context__ tool → SET session vars, continue
        │     ├── Regular tool call → execute → feed result back → next turn
        │     └── transfer_to_agent tool → HUMAN AGENT TRANSFER
        │
        └── POST-TURN checks
              ├── return_to_parent? → pop stack, re-route via parent
              ├── Completion conditions met? → COMPLETE + tryThreadReturn
              └── resume_intent? → replay original message through parent
```

---

## 9. Scenarios

### Scenario 1: Simple Supervisor → Specialist Handoff (Permanent)

```
User: "I want to check my billing"

Supervisor (active thread 0):
  LLM sees: handoff_to_Billing_Agent tool
  LLM calls: handoff_to_Billing_Agent(message="check billing", reason="billing query")

  handleHandoff():
    thread[0].status = 'completed'
    thread[1] = createThread(Billing_Agent, IR, context={handoff_from: "Supervisor"})
    session.activeThreadIndex = 1
    executeMessage(sessionId, "check billing") → Billing_Agent responds

User: "What about my plan details?"
  → Billing_Agent handles directly (it's now the permanent active agent)
```

### Scenario 2: Return Handoff with Data Mapping

```
User: "Book me a flight to NYC"

Travel_Agent (thread 0):
  LLM calls: handoff_to_Booking_Agent(message="book flight to NYC")
  HANDOFF config: RETURN: true, ON_RETURN: { MAP: { booking_ref: confirmation_id } }

  handleHandoff():
    thread[0].status = 'waiting'
    threadStack = [0]
    thread[1] = createThread(Booking_Agent)

  Booking_Agent (thread 1):
    Gathers: destination, date, class
    Calls book_flight tool → gets booking_ref="ABC123"
    Calls __complete__(message="Flight booked: ABC123")

  tryThreadReturn():
    thread[1].status = 'completed'
    threadStack.pop() → 0
    thread[0].status = 'active'
    Data merge: thread[0].data.values.confirmation_id = "ABC123"  (via MAP)

  Travel_Agent continues with booking confirmation in context
```

### Scenario 3: Return-to-Parent (Out-of-Scope Digression)

```
User: "What's the weather in NYC?"

Supervisor → Billing_Agent (RETURN: true)

Billing_Agent (thread 1):
  LLM sees __return_to_parent__ tool (because returnExpected=true)
  LLM calls: __return_to_parent__(reason="weather is outside billing scope", message="What's the weather in NYC?")

  handleReturnToParentResult():
    threadStack.pop() → 0 (Supervisor)
    thread[0].status = 'active'
    Forward "What's the weather in NYC?" to Supervisor
    Supervisor re-routes → handoff_to_Weather_Agent
```

### Scenario 4: Escalation to Human Agent

```
User: "I need to speak to a real person"

Agent (thread 0):
  LLM calls: __escalate_to_human__(reason="customer requests human", priority="high")

  handleEscalate():
    session.isEscalated = true
    Create HumanTask in DB
    If agent-transfer configured:
      Build transfer envelope (contact: {name, email, phone}, routing: {channel, sessionId})
      KoreAdapter.execute() → SmartAssist API creates agent session
      TransferSessionStore.create() → Redis hash with encrypted fields
      MessageBridge wired → human agent messages relay to user

    Session paused. User messages blocked until:
      POST /:id/escalation/resolve → resume session
      OR agent:disconnected event → clear transfer flags
```

### Scenario 5: Fan-Out (Parallel Agent Execution)

```
User: "Compare flight prices and hotel availability for NYC next week"

Supervisor (thread 0):
  LLM calls: __fan_out__([
    {target: "Flight_Agent", intent: "price check NYC", type: "agent"},
    {target: "Hotel_Agent", intent: "availability NYC next week", type: "agent"}
  ])

  executeFanOut():
    Create parallel execution units
    Flight_Agent → delegate child session → "Flights: $300-$500"
    Hotel_Agent → delegate child session → "Hotels: 15 available from $120/night"

    Results formatted:
      [Flight_Agent] SUCCESS: "Flights: $300-$500"
      [Hotel_Agent] SUCCESS: "Hotels: 15 available from $120/night"

    Supervisor LLM synthesizes: "For NYC next week, flights range $300-$500 and there are 15 hotels starting at $120/night."
```

### Scenario 6: Handoff Timeout with Escalation

```
Supervisor → handoff_to_Slow_Agent (RETURN: true, TIMEOUT: 30s, ON_TIMEOUT: escalate)

thread[0].handoffTimeoutMs = 30000
thread[0].handoffStartedAt = Date.now()

... Slow_Agent takes 45 seconds ...

tryThreadReturn() fires:
  elapsed (45s) > timeout (30s)
  action = 'escalate'
  session.isEscalated = true
  session.escalationReason = "Handoff to Slow_Agent timed out after 45000ms"
```

### Scenario 7: Resume Intent After Child Return

```
User: "Transfer $500 to my savings account"

Banking_Agent (thread 0, IR has ON_RETURN: resume_intent for Auth_Agent):
  LLM calls: handoff_to_Auth_Agent(message="verify identity for transfer")

  Auth_Agent (thread 1, RETURN: true):
    Collects: PIN, security question
    Verifies identity
    __complete__(message="Identity verified")

  Returns to Banking_Agent (thread 0):
    ON_RETURN: resume_intent detected
    Replay original message: "Transfer $500 to my savings account"
    Banking_Agent now processes the transfer with auth context available
```

### Scenario 8: Remote Agent Handoff (A2A Protocol)

```
Supervisor → handoff_to_External_CRM_Agent (remote, URL-based)

handleRemoteHandoff():
  1. Discover agent via A2A protocol (AgentCard)
  2. SSRF validation on remote URL
  3. Build A2A Task with message + context
  4. sendTask() or sendTaskAsync()
  5. Map remote response back to session

  If RETURN: true + async:
    Create suspension record
    When remote agent responds:
      ResumptionService picks up → executeMessage() to resume
```

### Scenario 9: Voice Channel Transfer

```
User (on phone): "Connect me to support"

Voice Agent → escalate:
  resolveRuntimeTransferVoiceData():
    Get active voice session
    Extract: callSid, sipCallId

  buildRuntimeTransferEnvelope():
    voiceData: { callSid: "CA123", sipCallId: "sip-456" }
    routing: { voice: { callSid, sipCallId, gateway: "voice_twilio" } }

  KoreAdapter.execute():
    SmartAssist creates agent session with SIP routing

  agent:connected event:
    voiceData updated with agentSipURI
    SIP call bridged to human agent

  After call:
    CSAT survey via voice (DTMF collection)
    csatHandler.handleAgentClosed() → submitRating()
```

### Scenario 10: Scripted Flow with Handoff

```
# Agent IR (flow mode):
STEPS:
  greeting:
    RESPOND: "Welcome! How can I help?"
    ON_INPUT:
      billing_intent: THEN: handoff_to_Billing
      support_intent: THEN: handoff_to_Support

User: "I have a billing question"

FlowStepExecutor:
  Step 'greeting' → detect intent → billing_intent matched
  THEN: handoff_to_Billing

  routing.handleHandoff(session, { target: "Billing", message: "billing question" })
  → Same handoff flow as reasoning agents
```

---

## 10. Key Invariants

1. **One active thread at a time** — `session.activeThreadIndex` always points to exactly one active thread.
2. **threadStack mirrors threadStack** — every `push` during RETURN:true handoff has a corresponding `pop` on return.
3. **handoffStack prevents cycles** — A → B → A is blocked before any execution occurs.
4. **delegateStack has max depth** — prevents unbounded recursion in delegate chains.
5. **Context flows down, data flows up** — parent passes context to child; child's gathered data merges back to parent on return.
6. **Streaming is always direct** — even in RETURN:true handoffs, the child streams directly to the user (onChunk is forwarded). The parent thread only controls lifecycle.
7. **Transfer flags gate messages** — when `session.isEscalated` or `session.transferInitiated` is true, normal message processing is blocked.
8. **Thread resume preserves state** — if a waiting thread exists for the target agent, it's reactivated with its full conversation history intact.

---

## 11. Key Source Files Reference

| Component                                                     | Path                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime executor (main loop)                                  | `apps/runtime/src/services/runtime-executor.ts`                        |
| Routing executor (handoff/delegate/escalate/complete/fan-out) | `apps/runtime/src/services/execution/routing-executor.ts`              |
| Flow step executor (scripted agents)                          | `apps/runtime/src/services/execution/flow-step-executor.ts`            |
| Execution types + tryThreadReturn                             | `apps/runtime/src/services/execution/types.ts`                         |
| Prompt & tool builder                                         | `apps/runtime/src/services/execution/prompt-builder.ts`                |
| Agent registry                                                | `apps/runtime/src/services/execution/agent-registry.ts`                |
| Transfer tool executor                                        | `apps/runtime/src/services/execution/transfer-tool-executor.ts`        |
| Agent-transfer boot/lifecycle                                 | `apps/runtime/src/services/agent-transfer/index.ts`                    |
| Transfer routing context                                      | `apps/runtime/src/services/agent-transfer/transfer-routing-context.ts` |
| Message bridge (cross-pod relay)                              | `apps/runtime/src/services/agent-transfer/message-bridge.ts`           |
| Execution coordinator                                         | `apps/runtime/src/services/execution/execution-coordinator.ts`         |
| Channel message pipeline                                      | `apps/runtime/src/channels/pipeline/message-pipeline.ts`               |
| Chat routes                                                   | `apps/runtime/src/routes/chat.ts`                                      |
| WebSocket handler                                             | `apps/runtime/src/websocket/handler.ts`                                |
| Turn engine (arch-ai)                                         | `packages/arch-ai/src/engine/turn-engine.ts`                           |
| Routing capabilities                                          | `apps/runtime/src/services/execution/routing-capabilities.ts`          |
| Agent activation context                                      | `apps/runtime/src/services/execution/agent-activation-context.ts`      |
