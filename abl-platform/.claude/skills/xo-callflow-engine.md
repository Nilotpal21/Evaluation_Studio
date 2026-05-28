---
name: xo-callflow-engine
description: Use when working on ABL dialog/flow execution, understanding XO's callflow patterns for parity, implementing IVR/DTMF nodes, agent transfer tasks, OOB flags, flow navigation, or context/variable management.
---

# XO Callflow (Dialog Engine) Reference

The XO callflow engine is the dialog/conversation management system. It's the equivalent of ABL's compiler + runtime executor pipeline. This skill documents the engine for ABL parity reference.

## Engine Location

```
xo-platform/koreserver/callflows/engine/lib/
├── callflow/
│   ├── Callflow.js                    # Process/instance handler (62KB)
│   ├── CallflowDefinition.js          # Definition & metadata (14KB)
│   ├── CallflowExecutionContext.js     # Session context
│   ├── BaseStep.js                    # Step execution base (88KB)
│   ├── Resolver.js                    # Variable/template resolution (16KB)
│   ├── tasks/                         # 15+ task implementations
│   │   ├── BaseTask.js                # Task base class
│   │   ├── ConversationalTask.js      # NLU dialog (36KB)
│   │   ├── AutomationTask.js          # Child bot automation (72KB)
│   │   ├── UnifiedAutomationTask.js   # Agentic AI app (113KB)
│   │   ├── AgentTransferTask.js       # Human agent handoff (29KB)
│   │   ├── ServiceTask.js             # REST/HTTP calls (15KB)
│   │   ├── ScriptTask.js              # JS sandbox execution (21KB)
│   │   ├── IVRMenuTask.js             # DTMF menu (9KB)
│   │   ├── IVRDigitTask.js            # Single digit DTMF (10KB)
│   │   ├── CallTransferTask.js        # SIP/voice transfer (4KB)
│   │   ├── DeflectToChatTask.js       # Deflection (7KB)
│   │   ├── CheckBusinessHoursTask.js  # Hours check (2KB)
│   │   ├── CheckAgentAvailabilityTask.js  # Availability (3KB)
│   │   ├── SetQueueTask.js            # Queue assignment (5KB)
│   │   ├── GoToFlowTask.js            # Jump to flow (7KB)
│   │   ├── MessagePromptTask.js       # Message only (2KB)
│   │   └── gateways/                  # Flow control gateways
│   ├── transition/                    # Transition types
│   ├── event/                         # Event system
│   ├── executioncontext/              # Context management
│   └── schemas/                       # Definition schemas
└── runtime/
    ├── CallflowManager.js             # Lifecycle management (61KB)
    └── Coordinator.js                 # Flow coordination
```

## Node Types

### Task Nodes

| Node Type                    | File  | Purpose                                  | ABL Equivalent                        |
| ---------------------------- | ----- | ---------------------------------------- | ------------------------------------- |
| `ConversationalTask`         | 36KB  | NLU-based dialog with automation bot     | Reasoning agent step                  |
| `AutomationTask`             | 72KB  | Child bot invocation with intent routing | `delegate` construct                  |
| `UnifiedAutomationTask`      | 113KB | Agentic AI app integration               | `delegate` to reasoning agent         |
| `AgentTransferTask`          | 29KB  | Human agent handoff with skill routing   | `smartassist_transfer_to_agent` tool  |
| `ServiceTask`                | 15KB  | REST/HTTP service call (sync/async)      | `tool` construct (HTTP)               |
| `ScriptTask`                 | 21KB  | JS sandbox code execution                | `on_input` / `on_respond` hooks       |
| `IVRMenuTask`                | 9KB   | DTMF menu collection                     | `smartassist_ivr_menu` tool           |
| `IVRDigitTask`               | 10KB  | Multi-digit DTMF collection              | `smartassist_ivr_digit_input` tool    |
| `CallTransferTask`           | 4KB   | SIP/PSTN call transfer                   | `smartassist_call_transfer` tool      |
| `DeflectToChatTask`          | 7KB   | Deflection to chat                       | `smartassist_deflect_to_chat` tool    |
| `CheckBusinessHoursTask`     | 2KB   | Business hours validation                | `smartassist_check_hours` tool        |
| `CheckAgentAvailabilityTask` | 3KB   | Agent availability check                 | `smartassist_check_availability` tool |
| `SetQueueTask`               | 5KB   | Queue assignment                         | `smartassist_set_queue` tool          |
| `GoToFlowTask`               | 7KB   | Jump to another callflow                 | Flow transition in ABL                |
| `MessagePromptTask`          | 2KB   | Send message (no input)                  | `prompt` / `respond` construct        |

### Gateway Nodes (Flow Control)

| Gateway                    | Purpose            | ABL Equivalent               |
| -------------------------- | ------------------ | ---------------------------- |
| `ConditionalGateway`       | Conditional split  | `transition` with conditions |
| `ParallelGateway`          | Fork execution     | Not directly supported       |
| `SimpleMergeGateway`       | Merge branches     | Implicit in flow             |
| `SynchronizationGateway`   | Join parallel      | Not directly supported       |
| `SimpleMergeExpireGateway` | Merge with timeout | Not directly supported       |

## Step Execution Model

### Step Status States

```javascript
ACTIVE; // Node is executing
WAIT; // Waiting for user input
COMPLETE; // Node completed
FAIL; // Node failed
ASSIGNEEWAIT; // Waiting for assignee
REASSIGN; // Reassignment
DEACTIVATE; // Deactivated
DELAY; // Delayed execution
DEFLECT; // Deflection in progress
```

### Transition Branches

```javascript
SUCCESS; // Normal success path
FAILURE; // Failure path
ONERROR; // Error handler
NOINPUT; // No user input (timeout)
NOMATCH; // Input not recognized
AGENT_TRANSFER; // Route to agent
DEFLECT_AUTOMATION; // Deflect to automation bot
DEFLECT_AGENT_TRANSFER; // Deflect to agent
ON_DEFLECTION; // Post-deflection
ON_RETURN_AUTOMATION; // Return from automation
AUTOMATION; // Route to automation
LOOPDETECTED; // Infinite loop detected
COMPLETE; // Flow complete
WAIT; // Flow waiting
```

### Execution Flow

```
1. start()              → Task initialization
2. Task-specific logic  → API call, NLU, DTMF, etc.
3. setWaitStatus()      → Wait for user input (if needed)
4. User responds        → handleUserRequest()
5. setCompleteStatus()  → Mark complete
6. setNextBranch()      → Determine next node
7. Transition fires     → Queue next step(s)
```

## Context & Session Management

### CallflowExecutionContext (complete)

```javascript
{
  // Identifiers
  cfProcessId,            // Callflow process ID
  cfId,                   // Callflow definition ID
  sessionId,              // Conversation session ID
  streamId,               // Bot ID
  userId,                 // End user
  accountId,              // Tenant

  // Flow State
  steps: {},              // Step execution contexts (by step ID)
  activeSteps: [],        // Currently active steps
  data: {},               // Field groups (Vars, etc.)
  forms: {},              // Form data
  processVariables,       // Custom variables

  // Agent Transfer
  queue,                  // Queue assignment
  skills: [],             // Required skills
  namedAgentIds,          // Specific agents
  agentMatchingConditions,

  // Automation
  automationBotId,        // Child bot ID
  automationAgentTransfer, // AT from child bot

  // Flow Variants
  callDisconnectionFlowId,  // On call drop
  noAgentsFlowId,           // No agents available
  outOfHoursFlowId,         // Outside hours
  inQueueFlowId,            // In-queue experience
  waitingExperienceId,      // Waiting experience

  // Voice/IVR
  sipTransferNumber,        // SIP target
  sipTransferURI,
  voiceTransferType,
  callerId,

  // Language
  botLanguage,
  userPreferredLanguage,
  languagePreferencesType,  // 'perSession' | 'perBot'

  // Tracking
  priority,
  externalAgentTranscribe,
  externalAgentRecordingControl,
  isFirstMessageDelivered
}
```

### Variable Resolution (Resolver.js)

Variables are resolved from multiple scopes:

- `context.data.Vars` — custom variables
- `context.data.{FieldGroup}` — named field groups
- `context.originator` — user/originator info
- `context.steps.{stepName}` — previous step results
- Standard: `today`, `now`, `StartDateAndTimeOfTheCurrentDay`

### Redis Session Keys

```
CFRequest:{cfId}:{cfProcessId}:{sessionId}    → Request metadata (TTL: 3 days)
CFInfo:Session:{sessionId}                    → Session details (TTL: 30 min)
CFInfo:Step:{cfId}:{cfProcessId}:{sessionId}  → Step cache (TTL: 30 min)
{userId}:{streamId}                           → Language context
```

## OOB (Out-of-Band) Flags

OOB flags are control signals in `responseOOB` object on bot responses:

```javascript
responseOOB = {
  // Agent Transfer
  isAgentTransfer: boolean, // Trigger agent transfer
  agentTransfer: boolean, // Alternate flag

  // Deflection
  isDeflection: boolean, // Deflect to chat
  isDeflectionAutomation: boolean, // Deflect to automation
  isDeflectionAgentTransfer: boolean, // Deflect to agent
  isOfferChatOptions: boolean, // Offer chat options

  // Dialog Control
  endDialog: boolean, // End conversation
  endReason: string, // 'Fulfilled', 'Failed', etc.

  // Intent & Context
  detectedIntentName: string, // Last detected intent
  userInput: string, // User's message
  dialog_tone: string, // Detected sentiment

  // References
  dialogRefId: string, // Dialog reference ID
  dialogId: string, // Linked dialog ID

  context: {
    lastIntentName: string,
    lastIntentuserInput: string,
  },
};
```

**OOB routing in AutomationTask:**

- `isAgentTransfer` → branch = `AGENT_TRANSFER`
- `isDeflection` → branch = `DEFLECT_AUTOMATION`
- `isDeflectionAgentTransfer` → branch = `DEFLECT_AGENT_TRANSFER`
- `endDialog` with noMatch/timeout → branch = `NOINPUT` / `NOMATCH`

## Flow Navigation

### Transition Types

| Type                        | Purpose                    |
| --------------------------- | -------------------------- |
| `SimpleTransition`          | Direct node-to-node        |
| `ConditionalTransition`     | Branch based on variables  |
| `ExclusiveORTransition`     | Single branch selection    |
| `MultiChoiceTransition`     | Multiple parallel branches |
| `ParallelTransition`        | Fork execution             |
| `SynchronizationTransition` | Join/merge parallel        |

### Conditional Logic

```javascript
{
  lExp: 'context.data.Vars.amount',  // Left operand
  rExp: 100,                          // Right operand
  op: '>=',                           // ==, >=, <=, >, <, &&, ||
  outcome: 'highValue',               // Branch name if true
  type: 'conditional'                 // 'conditional' or 'default'
}
```

### Flow Execution Sequence

```
1. Trigger received (HTTP/event)
2. CFProcess created via CallflowManager.newCFProcess()
3. CFDefinition loaded from database
4. ExecutionContext initialized with trigger data
5. Initial step queued (start_call_flow command)
6. Worker: fetch step → create task → task.start()
7. On WAIT: save context → wait for user input
8. On user input: resume step → process → evaluate transitions
9. Queue next step(s) → repeat from 6
10. On COMPLETE/FAIL: cleanup, fire events
```

### Direct Execution Optimization

```javascript
// config.callflow.directExecution = true
// Bypasses RabbitMQ queue for start_call_flow events
// Reduces latency for immediate step processing
```

## Event System

### Callflow-Level Events (CFEvents/)

```
CFTriggerStartEvent          — Execution started
CFTriggerCompleteEvent       — Execution completed
CFStepStartEvent             — Step started
CFStepCompleteEvent          — Step completed
CFStepFailureEvent           — Step failed
CFStepWaitEvent              — Step waiting for input
CFTaskWorkItemAssignEvent    — Work item assigned
CFTaskWorkItemCompleteEvent  — Work item completed
```

### Step-Level Events (CFStepEvents/)

```
CFStepResumeEvent            — Resume after input
CFMessageStartEvent          — Message sending started
CFAnalyzingInputEvent        — Analyzing user input
CFMessageCompleteEvent       — Message sent
```

### Event Properties

```javascript
{
  (eventTimestamp,
    cfProcessId,
    cfId,
    stepId,
    stepName,
    stepType,
    debugTitle,
    debugMessage,
    debugDetail,
    botId,
    userId,
    channel,
    xTraceId); // Distributed trace ID
}
```

## Callflow Definition Schema

```javascript
{
  name, description, id, cfVersionId,
  accountId, orgId,
  state: 'published' | 'draft',
  flowType: 'DEFAULT' | 'CALL_DISCONNECTION' | 'OUT_OF_HOURS' | 'IN_QUEUE',

  // Flow Variants
  callDisconnectionFlowId,
  noAgentsFlowId,
  outOfHoursFlowId,

  // Voice/IVR Config
  voicePreference, asrPreference, ttsPreference, dialectPreference,
  sttModel, ttsModel,
  backgroundStreamingEnabled,
  continuousGatherEnabled,
  amd: { enabled, ... },                // Answering machine detection

  // Agentic AI
  isFullAutonomous: boolean,
  agenticAiApp: { realtimeApiEnabled: boolean, ... },

  // Structure
  triggers: [TriggerDefinition],         // Entry points
  steps: [StepDefinition],              // Nodes
  connections: [Connection],             // Edges (transitions)
  data: [FieldGroupDefinition],          // Variables/fields
  dependencies: {
    messages: [MessageGroupDefinition],  // Message templates
    forms: [FormDefinition]
  }
}
```

## Error Handling & Timeouts

**IVR timeout (noInput):** `config.callflow.defaultTimeout` seconds
**Service timeout:** Per-task configuration
**Retry logic:** Max retries configurable per node

**Error branches:**

- `ONERROR` — generic error handler
- `FAILURE` — task failure path
- `NOMATCH` — DTMF/input not recognized
- `NOINPUT` — no user input within timeout
- `LOOPDETECTED` — prevents infinite loops (`endAsLoopDetected`)

## XO → ABL Callflow Mapping

| XO Concept                 | ABL Equivalent                       |
| -------------------------- | ------------------------------------ |
| `Callflow` (process)       | Agent execution session              |
| `CallflowDefinition`       | ABL DSL source + compiled IR         |
| `BaseStep` / tasks         | Flow steps in ABL DSL                |
| `ConversationalTask`       | Reasoning agent with NLU             |
| `AutomationTask`           | `delegate` to child agent            |
| `ServiceTask`              | `tool` construct (HTTP)              |
| `ScriptTask`               | `on_input` / `on_respond` hooks      |
| `AgentTransferTask`        | `smartassist_transfer_to_agent` tool |
| `IVRMenuTask`              | `smartassist_ivr_menu` tool          |
| `ConditionalGateway`       | `transition` with conditions         |
| `CallflowExecutionContext` | Runtime context + Redis session      |
| `Resolver` (variables)     | Template variables in ABL            |
| `responseOOB`              | `OOBFlags` in event-handler.ts       |
| `CFEvents`                 | `TraceEvent`s via TraceStore         |
| `KoreQ` (RabbitMQ)         | BullMQ or direct execution           |

## Key Parity Gaps (ABL Missing)

1. **Parallel gateways** — ABL doesn't support fork/join in flow execution
2. **Process variables** — ABL has context but no named field groups with scoped resolution
3. **Flow variants** (CALL_DISCONNECTION, OUT_OF_HOURS, IN_QUEUE) — ABL has tools but no automatic flow switching
4. **Script sandbox** — ABL uses `on_input`/`on_respond` hooks but no arbitrary JS execution
5. **Loop detection** — ABL doesn't have automatic infinite loop prevention in flow steps
6. **Message templates** — XO has `dependencies.messages` with per-channel formatting; ABL uses inline prompts
7. **AMD** (Answering Machine Detection) — Not in ABL's voice layer
8. **Direct execution optimization** — ABL always runs in-process (no queue bypass needed)
