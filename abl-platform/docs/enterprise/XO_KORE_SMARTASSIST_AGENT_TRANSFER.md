# Kore SmartAssist Agent Transfer — XO Platform Reference

> Comprehensive reference of the agent transfer implementation in the legacy XO platform (`xo-platform` repo),
> covering the node structure, payloads, bidirectional messaging protocol, and error handling.
> Captured to inform the ABL platform's `packages/agent-transfer` implementation.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Agent Transfer Node — Structure & Definition](#2-agent-transfer-node--structure--definition)
3. [Transfer Payload](#3-transfer-payload)
4. [Protocol — Lifecycle Phases](#4-protocol--lifecycle-phases)
5. [Kore SmartAssist Integration — Deep Dive](#5-kore-smartassist-integration--deep-dive)
6. [Bidirectional Messaging Protocol](#6-bidirectional-messaging-protocol)
7. [Typing Indicators & Presence](#7-typing-indicators--presence)
8. [Session Termination](#8-session-termination)
9. [CSAT Survey (Post-Agent)](#9-csat-survey-post-agent)
10. [Error Handling](#10-error-handling)
11. [Key Files Reference](#11-key-files-reference)
12. [ABL Platform Gap Analysis](#12-abl-platform-gap-analysis)

---

## 1. Overview

The agent transfer system is a dialog/callflow node that **hands off conversations from an AI bot to a live human agent** on an external agent desktop. The XO platform supports multiple agent desktop integrations:

- **Kore SmartAssist / Live Chat** (native, primary)
- **Salesforce**
- **ServiceNow**
- **Genesys**
- **Unblu**
- **Zoom**
- **Zendesk**
- **Custom HTTP** (SDK/BotKit)

**Architecture (Kore SmartAssist path):**

```
┌──────────┐     HTTP POST      ┌─────────────────────┐
│ XO Bot   │ ──────────────────→ │ Kore Agent Platform  │
│ (Runtime)│                     │ (SmartAssist/LiveChat)│
│          │ ←────────────────── │                      │
└──────────┘   RabbitMQ Queue    └─────────────────────┘
     ↕                                    ↕
  Redis                           Agent Desktop UI
(session state)                   (human agent)
```

- **Outbound** (bot → agent): HTTP POST
- **Inbound** (agent → bot): RabbitMQ message queue
- **Session state**: Redis with TTL-based expiration

---

## 2. Agent Transfer Node — Structure & Definition

### Node Type Registration

Registered in `/db/dbModels/globals/Dialog.js` as one of the supported node types:

```
intent, entity, script, voiceBiometric, service, message, error,
dialogAct, agentTransfer, form, process, aiassist, dynamicIntent,
generativeai, searchai, ...
```

### MongoDB Dialog Document

```json
{
  "type": "agentTransfer",
  "containmentType": "agenttransfer",
  "taskid": "<node-id>",
  "taskDefinition": {
    "messageToUser": "<message-id>",
    "onErrorConfig": { "cfMessageId": "<error-message-id>" },
    "agentTransfer": {
      "overrideAgents": false,
      "skills": [],
      "overrideValues": []
    }
  }
}
```

### Callflow Step Definition (Experience Flows)

From `smartassistrepo/callflows/agentTransferCall.json`:

```json
{
  "taskName": "agenttransfer",
  "taskDefinition": {
    "messageToUser": "<message-id>",
    "onErrorConfig": { "cfMessageId": "<error-message-id>" },
    "agentTransfer": {
      "overrideAgents": false,
      "skills": [],
      "overrideValues": []
    }
  }
}
```

### Configuration Properties

| Property                | Type     | Description                                            |
| ----------------------- | -------- | ------------------------------------------------------ |
| `messageToUser`         | string   | Message shown while connecting ("Please hold...")      |
| `skills`                | string[] | Skill IDs for routing to specific agent queues         |
| `queue`                 | string   | Queue ID for agent routing                             |
| `overrideAgents`        | boolean  | Override default agent selection                       |
| `overrideValues`        | array    | Custom field mappings for agent desktop                |
| `agentDesktopMeta`      | object   | Metadata passed to the agent's desktop UI              |
| `inQueueFlowId`         | string   | Experience flow played while user waits in queue       |
| `waitingExperienceId`   | string   | IVR/messaging experience during wait                   |
| `postAgentConversation` | object   | Config for triggering a dialog after agent disconnects |

---

## 3. Transfer Payload

### Dialog Executor Payload

Built by `AgentTransferExecutor.execute()` when a dialog flow reaches an `agentTransfer` node:

```javascript
{
  // Identity
  botId, streamId, userId, universalBotId, linkedBotId,
  contextId, conversationSessionId,

  // Channel
  channel: {
    type: "rtm" | "voice" | "email" | "audiocode",
    handle: "<channel-handle>",
    botInfo: {},
    requestId: "<request-id>"
  },

  // Transfer flags
  isAgentTransfer: true,

  // Context
  context: {
    taskid: "<dialog-task-id>",
    currentNodeId: "<node-id>",
    session: { BotUserSession: {} }
  },
  responseOOB: {
    context: {},
    linkedBotId: "<linked-bot>",
    agentTransfer: true
  },

  // Routing
  skillIds: ["skill1", "skill2"],
  agentDesktopMeta: { /* desktop metadata */ },
  customFlowData: { /* custom data */ },

  // Analytics metadata
  agentTransferConfig: {
    lastIntentName: "<intent>",
    dialog_tone: [ /* sentiment analysis */ ]
  },

  botLanguage: "en",
  voiceChannelInfo: { /* voice-specific */ }
}
```

### Callflow Task Payload (Experience Flows)

```javascript
{
  message: "<agent-transfer-intent>",
  callflowAgentTransfer: true,
  isFromAutomationNode: boolean,
  executionType: "message" | "dialog",
  agentTransferConfig: {
    skillsIds: ["skill1"],
    queue: "<queue-id>",
    overrideAgents: false,
    overrideValues: [],
    inQueueFlowId: "<flow-id>",
    assistEvents: { startEvent: {}, endEvent: {} },
    lastIntentName: "<intent>",
    dialog_tone: []
  }
}
```

---

## 4. Protocol — Lifecycle Phases

### Phase 1: Initiation

1. Dialog flow reaches `agentTransfer` node → `AgentTransferExecutor.execute()` runs
2. Gathers: conversation history, user details, sentiment, form data
3. **PII detokenization** if `PIIMaskingDisabledForAgentTransfer` flag is enabled
4. Resolves agent integration config via `btUtil.getMappedAgentIntegrationConfig()`

### Phase 2: Job Queue Execution

```javascript
// Standard bots:
botsQ.startJobFlow({}, 'InitAgentTransfer', contextData, jobData);

// SmartAssist bots:
botsQ.startJobFlow({}, 'SmartAssistInitAgentTransfer', contextData, jobData);
```

The job handler (`Templates/services/agent_transfer.js`):

1. Validates session is still active (`botSessionModel.getSessionRecordById`)
2. Generates session ID: `"AgentTransfer:" + Base64(payload)`
3. Stores in Redis with channel-appropriate TTL
4. Logs analytics event (`type: "agentTransfer"`)
5. Calls `dialogService.executeNodeForJob()` → resolves executor → makes HTTP call

### Phase 3: Execution Chain

```
Templates/services/agent_transfer.js        (job handler)
    ↓
DialogExecutionService/ServiceExecution.js   (executeNodeForJob → executeNodeHelper)
    ↓
AgentTransferExecutor.execute()              (orchestrator — routing decision)
    ↓ ↓ ↓
    │  │  └── SDK subscription path → makeHttpCall() to sdkHostUri
    │  └── Named integration path → AgentHandlerService → {kore,salesforce,servicenow}Agent
    └── Channel-specific path → Genesys/Unblu/Zoom/Zendesk/Generic handlers
```

**AgentHandlerService** resolves the handler dynamically:

```javascript
agentName = agentDetails.name; // "kore", "salesforce", "servicenow"
filePath = __dirname + `/lib/${agentName}Agent/index.js`;
agentHandler = require(filePath).instance();
agentHandler.execute(context, stream, deliveryChannel, agentDetails, opts);
```

### Phase 4: Active Session — Bidirectional Messaging

See [Section 6](#6-bidirectional-messaging-protocol).

### Phase 5: Completion & Cleanup

See [Section 8](#8-session-termination).

---

## 5. Kore SmartAssist Integration — Deep Dive

### URL Resolution

```javascript
// SmartAssistUtils.getKoreAgentAssistUrl(streamId)
if (btStream.isDeflect) {
  return { koreAgentUrl: config.kore_live_agent.koreAgentV1Url }; // V1 Deflect
} else {
  return { koreAgentUrl: config.kore_live_agent.koreAgentUrl }; // Standard
}
```

### initChat() — HTTP Request

**File:** `koreserver/api/services/AgentExecutor/lib/koreAgent/index.js` (lines 3969–4563)

```
Method:  POST
URL:     {koreAgentUrl}/api/v1/conversations?streamId={botId}
         (URI template: {+koreAgentUrl}/api/v1/conversations/{?params*})

Headers:
  Accept: application/json
  Content-Type: application/json
  apikey: {config.internalAuth.apikey}
  + distributed tracing headers
```

### initChat() — Full Request Payload

```javascript
{
  // Identity & Scope
  orgId: "org-123",
  accountId: "acc-456",
  botId: "st-bot-789",
  userId: "u-user-001",

  // Channel & Session
  source: "rtm" | "voice" | "email" | "facebook" | "whatsapp" | "msteams" | "slack",
  botSessionId: "conv-session-id",
  conversationType: "livechat" | "messaging" | "email",
  language: "en",

  // Routing
  skills: ["billing", "technical"],
  skillsIds: ["sk-001", "sk-002"],
  queueId: "q-support-tier1",
  priority: 5,                          // 0-10
  subType: "campaign" | undefined,

  // User Metadata
  metaInfo: {
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    phoneNumber: "+1234567890",
    city: "Austin",
    country: "US",
    ipAddress: "10.0.0.1",
    customData: { /* from bot context */ },
    identities: [ /* linked identities */ ],
    profileInfo: { /* user profile */ },
    agentTransferConfig: {
      automationBotId: "st-auto-bot",
      inQueueFlowId: "flow-queue-music",
      waitingExperienceId: "exp-hold-msg",
      noAgentsFlowId: "flow-no-agents",
      outOfHoursFlowId: "flow-after-hours",
      lastIntentName: "Cancel Order",
      dialog_tone: [{ tone_name: "frustrated", level: 0.8 }]
    }
  },

  // Intent Context
  keyIntentName: "Cancel Order",
  keyIntentUserInput: "I want to cancel my order",
  userPreferredLanguage: "en",

  // Sentiment
  sentimentTone: {
    sentiment: "frustrated",
    emoji: "😤",
    strength: 80
  },

  // Agent Assist
  isProactiveAgentAssistEnabled: true,

  // Agent Desktop Metadata (custom fields shown to agent)
  agentDesktopMeta: { orderId: "ORD-999", tier: "premium" },

  // Device Info
  hostDomain: "example.com",
  os: "iOS",
  device: "mobile",

  // Email-specific (when source=email)
  email: {
    emailId: "customer@example.com",
    toEmailId: "support@company.com",
    subject: "Order Cancellation Request",
    cc: ["manager@company.com"]
  },

  // Campaign (outbound)
  campaignInfo: { /* campaign metadata */ },
  campaignUserInfo: { /* user-specific campaign data */ },

  // Survey Config
  surveyRequired: "YES" | "NO" | "ASK" | "REQUESTED"
}
```

### initChat() — Response

```javascript
{
  _id: "conv-abc-123",      // conversationId — key for all future operations
  botSessionId: "sess-xyz"
}
```

### Redis Session Storage (Post-Init)

Multiple keys are written for different lookup patterns:

```javascript
// Primary session (keyed by userId#botId)
SET "agent:u-user-001#st-bot-789" → {
  agent: "kore",
  userId, sessionId, botId, source,
  conversationId: "conv-abc-123",
  callId: uniqueCallId,
  accountId, orgId,
  surveyRequired: "YES",
  conversationType: "livechat",
  isProactiveAgentAssistEnabled: true,
  language: "en",
  metaInfo: { ... }
}

// Reverse lookup (keyed by conversationId)
SET "conv-abc-123" → {
  userId, botId, source, conversationType, sessionId, callId, ...
}

// Channel context (for restoring channel after session ends)
SET "AST:CHANNELCONTEXT:{botId}:{userId}:{source}" → {
  /* original channel data */
}

// CSAT tracking keys
SET "agent:CSAT#{userId}#{botId}"
SET "agent:SUBFLOWCSAT#{userId}#{botId}"
```

**TTL by channel type:**

| Channel         | TTL            | Config Key                                     |
| --------------- | -------------- | ---------------------------------------------- |
| Chat (RTM)      | 72 hr (3 days) | `config.kore_live_agent.agentSessionTTL`       |
| Email           | 30 days        | `config.AgentTransfer.agentSessionTTLForEmail` |
| Async Messaging | 48 hr (2 days) | `config.AgentTransfer.AsyncMessageTimeout`     |
| Voice           | No TTL         | —                                              |

---

## 6. Bidirectional Messaging Protocol

### User → Agent (HTTP POST)

**Function:** `KoreExecutor.prototype.sendMessage()` (lines 378–671)

When the user sends a message during an active agent session:

```javascript
// 1. Lookup agent session from Redis (HGET on IntAgentTransfer hash)
const sessionData = await redislib.hgetAgentCallIdSync(userId + "#" + agentConversationStreamId);

// 2. Build event payload
const apiPayload = {
  eventName: "start_kore_agent_chat_message_for_agent",
  payload: {
    conversationId: "conv-abc-123",
    author: { id: userId, type: "USER" },
    type: "text",
    value: "Where is my refund?",     // user's message
    event: "user_message",
    attachments: [ /* if any */ ],
    // ... 30+ context fields
  },
  queryFields: { sid: sessionId, cId: conversationId }
};

// 3. HTTP POST to agent desktop
POST {koreAgentUrl}/api/v1/internal/events/handle/?sid={sid}&cId={conversationId}
Headers: { apikey, Accept: "application/json", + tracing headers }
Body: apiPayload
```

**All event types sent via the same HTTP POST mechanism:**

| User Action      | `eventName`                               | `payload.event`      |
| ---------------- | ----------------------------------------- | -------------------- |
| Send message     | `start_kore_agent_chat_message_for_agent` | `user_message`       |
| Close chat       | `start_control_message_for_agent`         | `close_conversation` |
| Start typing     | `start_control_message_for_agent`         | `typing`             |
| Stop typing      | `start_control_message_for_agent`         | `stop_typing`        |
| SDK connected    | `start_control_message_for_agent`         | `rtm_connected`      |
| SDK disconnected | `start_control_message_for_agent`         | `rtm_disconnected`   |
| Read receipt     | `start_control_message_for_agent`         | `message_read`       |
| Delivery receipt | `start_control_message_for_agent`         | `message_delivered`  |
| WebRTC event     | `start_control_message_for_agent`         | `webrtc_event`       |

### Agent → User (RabbitMQ Message Queue)

**This is the critical inbound path. Not HTTP callback, not WebSocket, not polling — RabbitMQ.**

**Queue registration** (`koreAgent/index.js`, lines 1767–1776):

```javascript
agentDesktopQ.registerJobHandler('start_kore_agent_chat_message_for_user', function (job) {
  /* handler */
});
```

**Inbound message structure from agent desktop:**

```javascript
// job.data received from RabbitMQ:
{
  conversationId: "conv-abc-123",
  author: { id: "agent-007", type: "AGENT" },
  value: "I've processed your refund. You'll see it in 3-5 days.",
  event: "agent_message",
  attachments: [
    { fileId: "file-001", fileName: "receipt.pdf", fileType: "application/pdf" }
  ],
  translatedText: "...",       // if auto-translate enabled
  emailPayload: { /* for email channel */ }
}
```

**Processing pipeline (lines 1777–2195):**

```
Step 1: Redis lookup by conversationId
        → get userId, botId, source, channel context

Step 2: Construct message body
        {
          author: { id: "agent-007", type: "AGENT" },
          conversationId,
          conversationType,
          isKoreAgent: true,
          message: "I've processed your refund...",
          emailPayload: { /* for email */ },
          sessionId,
          // ... 15+ other fields
        }

Step 3: Channel-specific message transformation
        ┌──────────┬──────────────────────────────────────────────┐
        │ Channel  │ Format                                       │
        ├──────────┼──────────────────────────────────────────────┤
        │ RTM      │ { type: "template",                          │
        │ (SDK)    │   payload: { template_type: "live_agent",    │
        │          │             text: msg } }                     │
        │ WhatsApp │ Custom template with media URLs               │
        │ Facebook │ Attachment payload format                     │
        │ MSTeams  │ Shortened URLs                                │
        │ Email    │ Native email with CC/BCC/subject              │
        │ Others   │ Plain text                                    │
        └──────────┴──────────────────────────────────────────────┘

Step 4: _serviceInst.sendAgentReplyToBot(null, body, null, opts)
        → Injects into standard bot processing pipeline
        → Bot delivers to user's channel via normal delivery path

Step 5: Handle attachments (each sent as separate message)
        → botUtils.getFileUrl(attachment.fileId) for downloadable URL
        → Wrap in channel-specific media payload
        → Send via same sendAgentReplyToBot() path
```

`sendAgentReplyToBot()` feeds into the standard `process_incoming_messagev1` job queue — the same pipeline used for all bot-to-user messages.

### Full Message Flow Diagram

```
USER                    XO PLATFORM                KORE AGENT PLATFORM         HUMAN AGENT
 │                          │                              │                       │
 │── message ──────────────→│                              │                       │
 │                          │── HTTP POST ────────────────→│                       │
 │                          │   eventName: "start_kore_    │── show message ──────→│
 │                          │   agent_chat_message_for_    │                       │
 │                          │   agent"                     │                       │
 │                          │                              │                       │
 │                          │                              │←── agent types ───────│
 │                          │←── RabbitMQ ─────────────────│                       │
 │                          │   "start_kore_agent_chat_    │                       │
 │                          │   message_for_user"          │                       │
 │←── deliver via channel ──│                              │                       │
 │                          │                              │                       │
 │                          │                              │←── agent closes ──────│
 │                          │←── RabbitMQ (close) ─────────│                       │
 │←── CSAT survey ─────────│                              │                       │
 │                          │── cleanup Redis ─────────────│                       │
```

---

## 7. Typing Indicators & Presence

### User Typing → Agent

```javascript
// Sent via same HTTP POST to agentDesktopEventHandle
eventName: "start_control_message_for_agent"
payload.event: "typing"        // or "stop_typing"
```

### Agent Typing → User

Received via RabbitMQ with event type `typing` in the same `start_kore_agent_chat_message_for_user` handler. Forwarded to user's channel as a typing indicator through the standard delivery path.

---

## 8. Session Termination

### Agent Closes Session

Agent desktop publishes `close_conversation` event → RabbitMQ → XO handler:

1. Sends "agent disconnected" message to user
2. Checks `surveyRequired` flag:
   - **YES** → Triggers CSAT dialog via `triggerDialogFromAgent()`
   - **NO** → Proceeds to cleanup
   - **ASK** → Prompts user first
3. Cleanup

### User Closes Session

```javascript
// Sends to agent desktop via HTTP POST:
eventName: "start_control_message_for_agent"
payload.event: "close_conversation"
// Then local cleanup
```

### Timeout (Redis Key Expiration)

Redis keyspace notifications detect expired `AgentTransfer:*` keys:

```javascript
redisSub.on('pmessage', async function(pattern, redisKey, message) {
  if (message === 'expired' && redisKey.indexOf("AgentTransfer:") > -1) {
    // Send expiration event to agent desktop
    eventName: "start_control_message_for_agent"
    payload.event: "Agent Transfer Expired"
  }
});
```

### Cleanup — All Termination Paths

```javascript
// Delete all Redis keys for this session:
DEL "agent:{userId}#{botId}"                                       // primary session
DEL "agent:CSAT#{userId}#{botId}"                                  // CSAT tracking
DEL "agent:SUBFLOWCSAT#{userId}#{botId}"                           // subflow CSAT
DEL "AST:CHANNELCONTEXT:{botId}:{userId}:{source}"                 // channel context
DEL "{conversationId}"                                             // reverse lookup
DEL "ATCF:{sessionId}:{botId}:{userId}:{channel}"                 // callflow tracking
DEL "CF:AGENT_TRANSFER:{sessionId}:{botId}:{userId}:{channel}"    // transfer flag
DEL "POST_AGENT_DIALOG:{sessionId}:{botId}:{userId}:{channel}"    // post-agent flag

// Update analytics: mark session inactive
botAnalyticsModel.updateLog(
  { botId, userId, channel, isActive: 1 },
  { isActive: 0, lmodifiedOn: new Date() }
)

// Notify callflow engine (for experience flows)
callflowQ.startJobFlow({}, coordinatorQueue, {}, {
  sessionId, userId, botId,
  isAgentSessionClosed: true,
  request: { event: "agent_transfer_complete" }
})
```

---

## 9. CSAT Survey (Post-Agent)

When `surveyRequired === "YES"` and agent closes session:

**Function:** `triggerDialogFromAgent()` (lines 1397–1577)

```javascript
// 1. Fetch CSAT dialog from bot config
const csatDialogName = botConfig.csatDialogId;

// 2. Restore original channel context from Redis
const channelData = await redis.get('AST:CHANNELCONTEXT:...');

// 3. Inject CSAT intent
channelData.nlMeta = { intent: csatDialogName };

// 4. Push into bot processing as if user sent a message
botsQ.startJobFlow({}, 'process_incoming_messagev1', {}, channelData);
// Bot executes the CSAT dialog flow with the user
```

---

## 10. Error Handling

### Error Types

| Error                            | Code/Type                                           | Handling                                                             |
| -------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- |
| Session inactive                 | —                                                   | Cancel transfer silently, `return Promise.resolve()`                 |
| Duplicate session                | —                                                   | Log error, cancel (`"Duplicate conversation initiated"`)             |
| Missing context                  | `BadRequest("ERR_CONTEXT_IS_MISSING")`              | Reject with 400                                                      |
| No SDK URI                       | `SubscriptionNotFound()`                            | Reject with 404                                                      |
| No client app                    | `ClientAppNotFound()`                               | Reject with 404                                                      |
| SDK call fails                   | `ServiceUnavailable("ERR_SDK_AGENT_TRANSFER_CALL")` | Reject with 503, log to usage logs                                   |
| PII detokenization fails         | `ValidationError()`                                 | Reject, logged                                                       |
| Form data resolution fails       | `ValidationError("ERR_IN_RESOLVING_FORM_DATA")`     | Reject, logged                                                       |
| Transfer status: failed/declined | —                                                   | Fires error branch via `playErrorMessageAndHandleError()`            |
| Post-agent dialog fails          | —                                                   | Graceful fallback: completes step with `postAgentDialogFailed: true` |

### Session Validation

```javascript
// If session is inactive when job runs, cancel transfer
if (!activeSessionExists) {
  AppLogger.error(`Cancelling agent transfer, session closed`);
  return Promise.resolve();
}
```

### Duplicate Prevention

```javascript
// If Kore agent session already exists, prevent duplicate
if (isKoreAgentSessionCreated && voiceMailOpted !== true) {
  AppLogger.error('Duplicate conversation initiated in same session');
  return Promise.resolve();
}
```

### Transfer Failure Handling (Callflow)

```javascript
if (transferStatus.status === 'failed' || 'declined') {
  if (!transferStatus?.internalAgentTransfer) {
    // External failure → trigger error branch
    step.playErrorMessageAndHandleError({ name: 'transferStatus', message: transferStatus?.error });
  } else {
    // Internal failure → wait for retry
    step.setWaitStatus().onTaskWait();
  }
}
```

### Cleanup on Failure

```javascript
.catch(function(e) {
  AppLogger.error(`initAgentTransfer error: ${e}`)
  return redislib.deleteFromRedis(sid)
    .then(() => updateInactiveAgentSession(data))
    .then(() => Promise.reject(e))
})
```

---

## 11. Key Files Reference

### Core Implementation

| File                                                                                        | Lines | Purpose                                                            |
| ------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| `koreserver/api/services/AgentExecutor/lib/koreAgent/index.js`                              | 4,752 | Main Kore agent executor: initChat, sendMessage, event handling    |
| `koreserver/Templates/services/agent_transfer.js`                                           | 1,037 | Job handler: init, clear, update sessions; Redis; analytics        |
| `koreserver/api/services/DialogExecutionService/lib/NodeExecutors/AgentTransferExecutor.js` | 1,022 | Dialog node executor: context gathering, integration resolution    |
| `koreserver/callflows/engine/lib/callflow/tasks/AgentTransferTask.js`                       | 568   | Callflow task: message sending, status handling, post-agent dialog |
| `koreserver/callflows/engine/lib/callflow/tasks/AgentTransferTaskDefinition.js`             | 139   | Task config parsing: skills, queue, error config                   |

### Supporting Files

| File                                                                           | Purpose                                |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| `koreserver/api/services/SmartAssist/utils/index.js`                           | SmartAssist URL resolution             |
| `koreserver/api/services/AgentExecutor/AgentHandlerService.js`                 | Dynamic agent handler resolution       |
| `koreserver/api/services/AgentExecutor/lib/koreAgent/endAgentSession.js`       | Session closure logic                  |
| `koreserver/api/services/AgentExecutor/lib/koreAgent/csatUtils.js`             | CSAT survey utilities                  |
| `koreserver/api/services/AgentExecutor/lib/koreAgent/channelMetaInfoParser.js` | Channel metadata parsing               |
| `koreserver/api/services/DialogExecutionService/utils/sdkUtils.js`             | SDK/BotKit HTTP calls                  |
| `koreserver/Templates/BotsServices/agent_desktop_listener.js`                  | RabbitMQ job handler registration      |
| `koreserver/Templates/services/RequestAgent.js`                                | Shared HTTP abstraction layer          |
| `koreserver/db/dbModels/globals/Dialog.js`                                     | Node type schema, containmentType enum |
| `koreserver/api/services/ContainmentMetrics/lib/agentTransferMetrics.js`       | Transfer analytics aggregation         |

### Other Agent Desktop Integrations

| File                                                                 | Integration           |
| -------------------------------------------------------------------- | --------------------- |
| `koreserver/api/services/AgentExecutor/lib/salesforceAgent/index.js` | Salesforce Live Agent |
| `koreserver/api/services/AgentExecutor/lib/servicenowAgent/index.js` | ServiceNow            |

### Salesforce — HTTP Details

```
Step 1: POST {liveAgentUrl}/System/SessionId → { id, key, affinityToken }

Step 2: POST {liveAgentUrl}/Chasitor/ChasitorInit
Headers: X-Liveagent-Sequence, X-Liveagent-Affinity, X-Liveagent-Session-Key, X-Liveagent-Api-Version
Body: { organizationId, deploymentId, sessionId, buttonId, visitorName, prechatDetails, ... }
```

### ServiceNow — HTTP Details

**Basic Auth mode:**

```
POST {host}/api/now/chat/create_queue_entry?queue={queueId}
Headers: Authorization: Basic {base64(userId:password)}
Body: { message, userId }
```

**VAApi (Virtual Agent) mode:**

```
POST {host}{VAApi.urlPath}
Body: { message: { text }, userId: "now_awa_{streamId}_{userId}", clientVariables, contextVariables }
```

### SDK/BotKit Subscription (Custom)

```
POST {sdkHostUri}/sdk/bots/{streamId}/components/{componentId}/on_agent_transfer
Headers: token: JWT.encode({ appId, exp }, clientSecret)
Body: {
  taskId, nodeId, requestId, channel, context,
  callbackUrl, resetBotUrl, sendUserMessageUrl, sendBotMessageUrl, sendBotEventUrl, ...
}
```

Provides callback URLs so external BotKit can send messages back, reset the bot, or submit feedback.

---

## Comparison: XO Platform vs ABL Platform

| Aspect                   | XO Platform                                | ABL Platform (`packages/agent-transfer`)                         |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| **Transport (outbound)** | HTTP POST via RequestAgent                 | HTTP POST via SmartAssistClient with circuit breaker + retry     |
| **Transport (inbound)**  | RabbitMQ message queue                     | BullMQ (Redis-based) event queue + webhook                       |
| **Session store**        | Redis with manual key management           | Redis with atomic Lua scripts (CAS)                              |
| **Session recovery**     | Redis keyspace notifications for expiry    | SessionRecoveryService with pod heartbeat monitoring             |
| **Error handling**       | Promise.reject with error classes          | OperationResult envelope `{ success, error: { code, message } }` |
| **Auth**                 | Internal API key                           | Internal API key (same pattern)                                  |
| **Multi-provider**       | Dynamic file require (`/lib/{name}Agent/`) | Adapter registry pattern                                         |
| **Observability**        | AppLogger                                  | Structured logger + TraceEvent emission                          |
| **Post-agent**           | CSAT dialog injection via NLMeta           | CSAT survey + disposition capture                                |

---

## 12. ABL Platform Gap Analysis

> Assessed 2026-03-13 against the XO platform reference implementation.
> Full code review performed — **43 findings** (12 critical, 19 important, 8 moderate, 4 test gaps).
> ABL source: `packages/agent-transfer/` + `apps/runtime/src/services/agent-transfer/`
> Implementation plan: [`docs/plans/2026-03-13-agent-transfer-gap-closure.md`](plans/2026-03-13-agent-transfer-gap-closure.md)

### Summary Matrix

| #   | Capability                      | Status                  | Notes                                                                                          | Review Findings |
| --- | ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- | --------------- |
| 1   | Transfer initiation             | **BROKEN**              | Wrong URL (`/liveAgentUrl/{id}` vs `/message`), missing 15+ XO fields, wrong `accountId`       | C3, C4, C5      |
| 2   | Agent → User messaging          | **BROKEN**              | Event types not normalized in webhook path + double-delivery via two code paths                | C11, C12        |
| 3   | Agent events received (10/10)   | **IMPLEMENTED**         | Full `XO_EVENT_MAP` + 7 aliases; `conversation_updated` incorrectly maps to `agent:message`    | I7              |
| 4   | User → Agent message forwarding | **NOT IMPLEMENTED**     | `sendUserMessage()` only extends TTL; `agentDesktopEventHandle` API surface entirely missing   | C1, C2          |
| 5   | User → Agent control events     | **NOT IMPLEMENTED**     | Missing: `typing`, `stop_typing`, `close_agent_chat`, `message_read`, `message_delivered`      | C2              |
| 6   | Channel-specific transforms     | **PARTIAL (by design)** | Delegates to channel adapters + `renderFormAsText()`. Not a gap — cleaner architecture.        | —               |
| 7   | Session management              | **HAS BUGS**            | Key prefix mismatch, non-atomic TTL, unbounded active set, TOCTOU in `end()`, CROSSSLOT        | C6–C9, I8, I10  |
| 8   | Post-Agent / CSAT               | **HAS BUGS**            | Double session end in `completeCsat`, unguarded JSON.parse in disposition, zombie timeouts     | I13, I14, I15   |
| 9   | Attachments                     | **NOT IMPLEMENTED**     | Types exist (`MessageAttachment`), not wired in either direction                               | —               |
| 10  | Error handling                  | **HAS BUGS**            | Nonce drops retries (C10), rate limiter amplification (I12), `initPromise` stuck on fail (I18) | C10, I12, I18   |
| 11  | Authentication                  | **HAS BUGS**            | SSRF bypass via DNS failure (I16), settings route reads raw header not auth context (I19)      | I16, I19        |

### Architectural Differences (Intentional — Not Gaps)

| Concern            | XO Approach                                         | ABL Approach                                                     |
| ------------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| Inbound queue      | RabbitMQ (`start_kore_agent_chat_message_for_user`) | Webhook + BullMQ durable event queue (Redis-backed, persistent)  |
| Channel transforms | Inline in `koreAgent/index.js` (4,752 LOC)          | Delegated to channel adapters (separation of concerns)           |
| Session store      | Manual Redis key management                         | Atomic Lua scripts with compare-and-swap, field-level encryption |
| Pod crash recovery | Redis keyspace notifications only                   | `SessionRecoveryService` with heartbeat + pod set tracking       |
| Webhook security   | API key only                                        | API key + HMAC-SHA256 signature + nonce replay protection        |

### Gap 1: User → Agent Message Forwarding (CRITICAL)

**What XO does:** When a user sends a message during an active agent session, XO POSTs to SmartAssist's `agentDesktopEventHandle` endpoint so the human agent sees the message in their desktop UI.

**What ABL does:** `KoreAdapter.sendUserMessage()` (index.ts:156-164) only extends the Redis session TTL. It does **not** forward the message to SmartAssist. The human agent will NOT see user messages.

```typescript
// Current ABL code — only extends TTL, message is lost:
async sendUserMessage(sessionId: string, _message: UserMessage): Promise<void> {
  if (this.sessionStore) {
    await this.sessionStore.extendTTL(sessionId);
  }
}
```

**XO reference — what's needed:**

```
POST {koreAgentUrl}/api/v1/internal/events/handle/?sid={sid}&cId={conversationId}
eventName: "start_kore_agent_chat_message_for_agent"
payload: { conversationId, author: { id, type: "USER" }, type: "text", value: "<message>", event: "user_message" }
```

### Gap 2: User → Agent Control Events (MEDIUM)

XO sends these events to SmartAssist via the same `agentDesktopEventHandle` endpoint. None exist in ABL:

| Event            | XO `eventName`                    | XO `payload.event`   | ABL Status      |
| ---------------- | --------------------------------- | -------------------- | --------------- |
| Close chat       | `start_control_message_for_agent` | `close_conversation` | NOT IMPLEMENTED |
| Start typing     | `start_control_message_for_agent` | `typing`             | NOT IMPLEMENTED |
| Stop typing      | `start_control_message_for_agent` | `stop_typing`        | NOT IMPLEMENTED |
| Read receipt     | `start_control_message_for_agent` | `message_read`       | NOT IMPLEMENTED |
| Delivery receipt | `start_control_message_for_agent` | `message_delivered`  | NOT IMPLEMENTED |

### Gap 3: Attachment Handling (MEDIUM)

**Agent → User:** When a SmartAssist agent sends a file (with `fileId`), ABL does not resolve the download URL or transform it for the user's channel. XO does: `botUtils.getFileUrl(attachment.fileId)` → channel-specific media payload.

**User → Agent:** `KoreAdapter.capabilities.supportsFileUpload = false`. The `UserMessage.attachments` field exists in types but is never transmitted.

### Gap 4: `agent_exited` Event (LOW)

Mapped in `AgentEventType` but marked `TODO: wire XO mapping when SmartAssist exposes agent_exited event`. Note that `agent_disconnect` IS already mapped (event-handler.ts:43), which covers the primary case.

### ABL Files Referenced

| File                                                              | Purpose                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/agent-transfer/src/adapters/kore/index.ts`              | KoreAdapter: execute, sendUserMessage, handleInbound             |
| `packages/agent-transfer/src/adapters/kore/smartassist-client.ts` | SmartAssistClient: HTTP POST with retry + CB                     |
| `packages/agent-transfer/src/adapters/kore/event-handler.ts`      | XO → ABL event mapping (XO_EVENT_MAP)                            |
| `packages/agent-transfer/src/types.ts`                            | Core types: TransferPayload, UserMessage, AgentEvent             |
| `packages/agent-transfer/src/post-agent/csat-handler.ts`          | CsatHandler: post-agent lifecycle                                |
| `packages/agent-transfer/src/post-agent/disposition-handler.ts`   | Agent disposition capture                                        |
| `packages/agent-transfer/src/session/transfer-session-store.ts`   | Redis session store with Lua scripts                             |
| `apps/runtime/src/services/agent-transfer/message-bridge.ts`      | AgentTransferMessageBridge: route events to channels             |
| `apps/runtime/src/routes/agent-transfer-webhooks.ts`              | Webhook endpoint: POST /api/v1/agent-transfer/webhooks/:provider |
