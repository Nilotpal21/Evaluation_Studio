# Agent Transfer: End-to-End Flow (Koreserver ↔ AgentAssist)

> Step-by-step reference for the Agent Transfer flow between Koreserver
> (`/projects/koreserver/koreserver`) and AgentAssist (`/projects/contactcenter/koreagentassist`).
> Covers every step from bot decision to session closure, including all API interactions,
> message routing, callflow definitions, Redis session management, and Socket.IO events.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Step 1 — Bot Decides to Transfer](#2-step-1--bot-decides-to-transfer)
3. [Step 2 — RabbitMQ Worker Picks Up the Job](#3-step-2--rabbitmq-worker-picks-up-the-job)
4. [Step 3 — Agent Handler Dispatches to Correct Executor](#4-step-3--agent-handler-dispatches-to-correct-executor)
5. [Step 4 — KoreExecutor Creates Conversation on AgentAssist](#5-step-4--koreexecutor-creates-conversation-on-agentassist)
6. [Step 5 — AgentAssist Receives and Routes the Conversation](#6-step-5--agentassist-receives-and-routes-the-conversation)
7. [Step 6 — User Messages During Active Transfer](#7-step-6--user-messages-during-active-transfer)
8. [Step 7 — Agent Messages Back to User](#8-step-7--agent-messages-back-to-user)
9. [Step 8 — Call Flow Definitions at Runtime](#9-step-8--call-flow-definitions-at-runtime)
10. [Step 9 — Session Closure](#10-step-9--session-closure)
11. [Event Dispatch Table (AgentAssist)](#11-event-dispatch-table-agentassist)
12. [API Endpoint Reference](#12-api-endpoint-reference)
13. [Redis Key Patterns](#13-redis-key-patterns)
14. [RabbitMQ (KoreQ) Job Flows](#14-rabbitmq-koreq-job-flows)
15. [Socket.IO Events (AgentAssist)](#15-socketio-events-agentassist)
16. [Sequence Diagram](#16-sequence-diagram)
17. [Key Source Files Reference](#17-key-source-files-reference)

---

## 1. Architecture Overview

```
┌─────────┐     ┌──────────────────────┐     ┌─────────────────────────┐     ┌───────────┐
│  User    │◄───►│  Koreserver (:3000)  │◄───►│ AgentAssist (:5080)     │◄───►│   Agent   │
│(Channel) │     │  (Bot Platform)      │     │ (koreagentassist)       │     │ (Desktop) │
└─────────┘     └──────────────────────┘     └─────────────────────────┘     └───────────┘
                  HTTP + RabbitMQ(KoreQ)        HTTP + Socket.IO + Redis
```

**Authentication between systems:** Shared `apikey` header (`config.internalAuth.apikey` on Koreserver / `INTERNAL_AUTH_KEY` env var on AgentAssist).

### Configuration (Koreserver)

**File:** `config/configs/kore_live_agent.json`

| Key                                | Default                                                    | Purpose                      |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| `koreAgentUrl`                     | `http://localhost:5080`                                    | Primary AgentAssist URL      |
| `koreAgentV1Url`                   | `http://localhost:5079`                                    | Deflect bot AgentAssist URL  |
| `liveAgentUrl`                     | `{+koreAgentUrl}/api/v1/conversations/{?params*}`          | Create conversation endpoint |
| `agentDesktopEventHandle`          | `{+koreAgentUrl}/api/v1/internal/events/handle/{?params*}` | Event handling endpoint      |
| `botNotificationsURL`              | `{+koreAgentUrl}/api/v1/internal/events/bots/handle`       | Bot lifecycle notifications  |
| `agentDesktopFlowEventListenerUrl` | `{+koreAgentUrl}/api/v1/internal/events/flows/handle`      | Experience flow callbacks    |
| `agentassistAsyncBotResponseUrl`   | `{+koreAgentUrl}/api/v1/internal/aaresponse`               | Async AA bot responses       |
| `agentCreationUrl`                 | `{+koreAgentUrl}/api/v1/internal/agents`                   | Agent creation               |
| `updateConversationUrl`            | `{+koreAgentUrl}/api/v1/conversations/{conversationId}`    | Update conversation          |
| `agentSessionTTL`                  | `259200` (3 days)                                          | Redis session TTL in seconds |
| `agentAuthTTL`                     | `900` (15 min)                                             | Auth TTL in seconds          |
| `agentCSATKeyTTL`                  | `300` (5 min)                                              | CSAT key TTL in seconds      |

### Configuration (AgentAssist)

**File:** `src/config/config.js`

| Key                      | Env Var                          | Purpose                         |
| ------------------------ | -------------------------------- | ------------------------------- |
| `config.kore.host`       | `KORE_HOST`                      | Koreserver base URL             |
| `config.kore.uxoHost`    | `UNIFIED_XO_HOST` or `KORE_HOST` | UXO host                        |
| `config.internal_apikey` | `INTERNAL_AUTH_KEY`              | Auth key for internal API calls |

### Webhook Endpoints

**SmartAssist channel** (`config/configs/bot_smartassist.json`):

- `/hooks/smartassist/:streamId`
- `/hooks/smartassist/v2/webhook/:streamId`
- `/hooks/smartassist/:streamId/hookInstance/:instanceId`

**AgentAssist channel** (`config/configs/bot_agentassist.json`):

- `/hooks/agentassist/:streamId`
- `/hooks/agentassist/v2/webhook/:streamId`
- `/hooks/agentassist/:streamId/hookInstance/:instanceId`

---

## 2. Step 1 — Bot Decides to Transfer

Two paths lead to an agent transfer:

### Path A — Dialog Flow (XO Platform)

When the bot dialog reaches an **Agent Transfer Node**, the executor fires.

**File:** `api/services/DialogExecutionService/lib/NodeExecutors/AgentTransferExecutor.js`

1. Gathers context: session tags, user tags, sentiment analysis, completed/failed tasks
2. Performs PII check and de-tokenization before passing data to agents
3. Generates chat history URL
4. Prepares SDK callback URI (`on_agent_transfer` endpoint)
5. Dispatches a RabbitMQ job: `InitAgentTransfer` or `SmartAssistInitAgentTransfer` on the `bots` queue

### Path B — Callflow (Experience Flow)

When the callflow engine reaches an Agent Transfer Task.

**File:** `callflows/engine/lib/callflow/tasks/AgentTransferTask.js`

1. `performAgentTransfer()` (line 113) sends a message to the user
2. Calls `executeAgentTransfer()` (line 239)
3. Builds transfer properties: skills, queue, override agents, automation bot ID, intent
4. Dispatches via `getAgentTransferPromise()`
5. Sets callflow step to "wait" status

**Task Definition:** `callflows/engine/lib/callflow/tasks/AgentTransferTaskDefinition.js`

| Definition Class                        | Fields                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentTransferDefinition` (line 7)      | skills, override agents, override values, refId, usecaseName, usecaseType                                                                 |
| `AgentAssistEventsDefinition` (line 63) | start/end events for AgentAssist                                                                                                          |
| `AgentTransferTaskDefinition` (line 86) | messageToUser, queueId, inQueueFlowId, agentTransfer config, agentAssistEvents, onErrorConfig, waitingExperienceId, postAgentConversation |

---

## 3. Step 2 — RabbitMQ Worker Picks Up the Job

**File:** `Templates/BotsServices/agent_transfer.js` (lines 1–29)

Registered handlers on the `bots` queue:

| Job Name                                 | Handler                                       | Purpose                  |
| ---------------------------------------- | --------------------------------------------- | ------------------------ |
| `InitAgentTransfer` (line 5)             | `agentService.initAgentTransfer()`            | Standard bot transfer    |
| `SmartAssistInitAgentTransfer` (line 11) | `agentService.SmartAssistInitAgentTransfer()` | SmartAssist bot transfer |
| `clearAgentSession` (line 17)            | `agentService.clearAgentSession()`            | Session cleanup          |
| `update_agent_expire` (line 24)          | `agentService.updateAgentSession()`           | Extend session TTL       |

### Core Transfer Logic

**File:** `Templates/services/agent_transfer.js`

**`initAgentTransfer()` (line 147):**

1. Creates Redis session key: `AgentTransfer:<base64(JSON({botId, userId, channel}))>`
2. Validates bot session is still active
3. Logs analytics event
4. Calls `serviceInst.executeNodeForJob()` to execute the agent transfer dialog node

**`SmartAssistInitAgentTransfer()` (line 364):**

1. Similar to above but for SmartAssist bots
2. Stores `agentTransferConfig` in BotUserSession via `BotsSessionStore`
3. Gets conversation type
4. Executes the dialog node

### Session Helper Functions

| Function                       | Line | Purpose                                      | Redis Key Pattern        |
| ------------------------------ | ---- | -------------------------------------------- | ------------------------ |
| `checkForAgentSession()`       | 34   | Check for active agent session               | `AgentTransfer:<base64>` |
| `checkForAgentAssistSession()` | 45   | Check if session is from smartassist channel | —                        |
| `checkForKoreAgentSession()`   | 97   | Check for Kore Agent session                 | `userId#streamId`        |

---

## 4. Step 3 — Agent Handler Dispatches to Correct Executor

**File:** `api/services/AgentExecutor/AgentHandlerService.js`

**`executeHandOff()` (line 18):**

1. Reads `agentDetails.name` from the transfer configuration
2. Dynamically requires `<agentName>Agent/index.js`
3. Calls `agentHandler.execute()`

### Supported Agent Executors

| Agent Name   | File Path                      | Integration                          |
| ------------ | ------------------------------ | ------------------------------------ |
| `kore`       | `lib/koreAgent/index.js`       | Kore.ai native Agent Desktop         |
| `salesforce` | `lib/salesforceAgent/index.js` | Salesforce Live Agent                |
| `genesys`    | `lib/genesysAgent/`            | Genesys (+ GenesysWebMessageService) |
| `servicenow` | `lib/servicenowAgent/index.js` | ServiceNow                           |

**Base class:** `lib/BaseAgentExecutor.js` — provides `execute`, `sendMessage`, `endChat`, `agentResponse`, `initialMessageToAgent`, `handoffToAgent` methods.

### Other Key Methods on AgentHandlerService

| Method                                   | Line | Purpose                                                               |
| ---------------------------------------- | ---- | --------------------------------------------------------------------- |
| `sendMessage()`                          | 156  | Routes user messages during agent transfer to the correct executor    |
| `agentResponse()`                        | 184  | Handles responses coming from agents                                  |
| `publishAgentTransferStatusToCallflow()` | 97   | Publishes success/failure status back to callflow engine via RabbitMQ |

---

## 5. Step 4 — KoreExecutor Creates Conversation on AgentAssist

**File:** `api/services/AgentExecutor/lib/koreAgent/index.js`

`KoreExecutor.prototype.execute()` (line 4675) → calls `initChat()` (line 4033), a ~630-line function.

### 5.1 Gather Context

1. Collects user context, session data, bot session, channel info
2. Resolves AgentAssist URL via `SmartAssistUtils.getKoreAgentAssistUrl()` (uses `koreAgentUrl` or `koreAgentV1Url` based on deflect bot status)
3. Gets callflow process context, language, skills, queues, named agents

### 5.2 Build Payload

Constructs a comprehensive `data` payload:

```javascript
{
  orgId,
  userId,
  accountId,
  botId,
  source,              // channel source
  botSessionId,
  metaInfo: {
    agentTransferConfig: {
      automationBotId,      // Bot ID for automation
      overrideAgents,       // Force specific agents (boolean)
      overrideAgentIds,     // Array of agent IDs
      skillsIds,            // Skill IDs for routing
      inQueueFlowId,        // Experience flow while in queue
      outOfHoursFlowId,     // Out-of-hours flow
      noAgentsFlowId,       // No-agents-available flow
      queue,                // Target queue name/ID
      namedAgentOptions,    // Named agent routing config
      waitingExperienceId,  // Waiting experience ID
      assistEvents: {       // AgentAssist event triggers
        startEvent: { isEnabled, dialogRefId, botId }
      }
    }
  },
  skills,
  conversationType,
  sentimentTone,
  keyIntentName,
  customFlowData
}
```

### 5.3 HTTP POST to AgentAssist

```
POST {koreAgentUrl}/api/v1/conversations/?streamId={botId}
Headers: {
  Content-Type: application/json,
  apikey: config.internalAuth.apikey
}
Body: <payload above>
```

(Lines 4599–4636 in `koreAgent/index.js`)

### 5.4 Store Session in Redis

| Redis Key                | Value                | Purpose                            |
| ------------------------ | -------------------- | ---------------------------------- |
| `agent:userId#botId`     | Session data         | Agent session lookup               |
| `userId#botId`           | Conversation mapping | Conversation ID resolution         |
| `conversationId`         | Identity mapping     | Reverse lookup                     |
| `AgentTransfer:<base64>` | Session flag         | Transfer state tracking (with TTL) |

Also creates identity mappings (`iDToAccount`) and stream instances.

### 5.5 URL Resolution

**File:** `api/services/SmartAssist/utils/index.js`

`getKoreAgentAssistUrl()` (line 15): Determines whether to use `koreAgentUrl` or `koreAgentV1Url` based on whether the bot is a "deflect" bot.

### 5.6 HTTP Request Utility

**File:** `api/services/AgentAssistService.js`

`makeHttpRequest()` (line 3734): Generic HTTP call method using `RequestAgent`, with tracing context propagation. Sends `apikey` in headers, uses JSON content type.

---

## 6. Step 5 — AgentAssist Receives and Routes the Conversation

### 6.1 Conversation Creation

**File (AgentAssist):** `src/routes/v1/internalAPIs.route.js`

The conversation creation hits:

```
POST /internal/session → internalAPIController.createConversation() (line 169)
```

### 6.2 Agent Routing

**File:** `src/agentHandler/agentRouterv2.js` (line 2562)

`routeUserToAgent(data, type, settings)`:

1. Determines the active queue from `agentTransferConfig.queue`
2. Checks experience flows:
   - `outOfHoursFlowId` → triggers out-of-hours experience flow
   - `noAgentsFlowId` → triggers no-agents-available flow
   - `inQueueFlowId` → triggers in-queue waiting experience
3. Validates business hours via `isHoursOfOperationValid()`
4. Gets available agents via `getAvailableAgents()`
5. Filters by skills, language, voice/chat capability
6. Calculates agent scores via `pointScoreCalculator.calculateScore()`
7. Pushes to agent queue via `queueManager.pushUserToAgentsQ(agentScores)`

### 6.3 Transfer Types

| Type                             | Description                  |
| -------------------------------- | ---------------------------- |
| `NEW`                            | New conversation routing     |
| `TRANSFER_TO_QUEUE`              | Transfer to a specific queue |
| `TRANSFER_TO_AGENT`              | Transfer to a specific agent |
| `ADD_TO_QUEUE`                   | Add to queue after hours     |
| `WORKBIN`                        | Route from workbin           |
| `AGENT_OFFLINE_TRANFER_TO_QUEUE` | Agent went offline fallback  |

### 6.4 Agent Notification

Agent receives `new_conversation` Socket.IO event via `src/services/socket.service.js` (lines 41–53).

Agent accepts via `conversation_accept` Socket.IO event (`src/socket.js` line 11978).

---

## 7. Step 6 — User Messages During Active Transfer

```
User → Channel → Koreserver → AgentAssist → Agent Desktop
```

### 7.1 Koreserver Intercepts User Message

**File:** `Templates/BotsServices/route_message_kora.js` (lines 6245–6299)

Before NLP processing, the routing function runs parallel checks:

```javascript
Promise.all([
  getAwaitingMessage(...),
  checkForAgentSession(data),       // Redis: "AgentTransfer:<base64>"
  checkForAgentCSATSession(data),
  checkForKoreAgentSession(data),   // Redis: "userId#streamId"
  checkForExpFlowFlag(data)
])
```

If an agent session exists → message is **NOT sent to NLP/CS**. Sets `msgStatus: 1, errorCode: 1` (blocks NLP pipeline). Routes to `AgentHandlerService.sendMessage()`.

**Additional checks in:**

- `Templates/BotsServices/validate_user.js` (lines 565–573, 819)
- `Templates/BotsServices/channels/rtm.js` (line 1431) — RTM channel checks both kore agent and regular agent sessions

### 7.2 Koreserver Forwards to AgentAssist

**File:** `api/services/AgentExecutor/lib/koreAgent/index.js`

`KoreExecutor.prototype.sendMessage()` (line 438):

1. Gets session from Redis (`userId#streamId`)
2. Extracts message from incoming data
3. Constructs payload:

```javascript
{
  conversationId,
  author: { /* user details */ },
  botId,
  orgId,
  iId,
  accountId,
  value: "<message text>",
  event: "user_message"
}
```

4. Handles special event types:

| Event               | Description                 |
| ------------------- | --------------------------- |
| `user_message`      | Standard user message       |
| `close_agent_chat`  | User requests session close |
| `typing`            | User is typing indicator    |
| `stop_typing`       | User stopped typing         |
| `message_delivered` | Delivery receipt            |
| `message_read`      | Read receipt                |
| `rtm_disconnected`  | RTM channel disconnected    |
| `rtm_connected`     | RTM channel connected       |

5. **HTTP POST to AgentAssist:**

```
POST {koreAgentUrl}/api/v1/internal/events/handle/
Headers: { apikey: config.internalAuth.apikey }
Body: {
  eventName: "start_kore_agent_chat_message_for_agent",
  payload: { conversationId, author, botId, orgId, value, event, ... }
}
```

(Lines 652, 695 in `koreAgent/index.js`)

### 7.3 AgentAssist Delivers to Agent

**File (AgentAssist):** `src/controllers/internalAPIs.controller.js` (line 488)

`handleKoreServerEvents` dispatches based on `eventName`:

- `start_kore_agent_chat_message_for_agent` → `socketServer.handleUserMessage(body)` (line 557–558)

**File:** `src/socket.js` (~line 440+)

1. Emits Socket.IO event to agent desktop:
   ```javascript
   ioClient.to(conversationId).emit('user_message', message);
   ```
2. Also forwards to AA bot namespace:
   ```javascript
   ioClient.of('/koreagentassist').to(conversationId).emit('user_message', message);
   ```

---

## 8. Step 7 — Agent Messages Back to User

```
Agent Desktop → AgentAssist → Koreserver → Channel → User
```

### 8.1 Agent Sends Message via Socket.IO

**File (AgentAssist):** `src/socket.js` (line 11992)

Agent desktop emits `agent_message` socket event → `handleAgentMessage` handler processes it (line 627+).

### 8.2 AgentAssist Calls Koreserver

**File:** `src/services/socket.service.js` (line 1029)

`sendKoreEvent()` — the primary outbound call:

```
POST {config.kore.host}/api/1.1/internal/agentassist/events/handle
Headers: { apikey: config.internal_apikey }
Body: {
  eventName: "start_kore_agent_chat_message_for_user",
  payload: { conversationId, message, author, ... }
}
```

### 8.3 Koreserver Delivers to User

**File:** `api/services/AgentExecutor/lib/koreAgent/index.js` (line 1881)

RabbitMQ handler `start_kore_agent_chat_message_for_user` on the `agentdesktop` queue:

1. Looks up session from Redis by `conversationId` (line 1891)
2. Determines source channel (rtm, whatsapp, facebook, msteams, email, amb)
3. For `agent_message` events (line 1962):
   - Wraps message in `live_agent` template for SDK channels
   - Handles file attachments
   - Handles email forwarding
4. Delivers via the appropriate channel adapter

---

## 9. Step 8 — Call Flow Definitions at Runtime

### 9.1 Callflow JSON Definitions (Koreserver)

Stored in the SmartAssist repo within Koreserver:

| File                                               | Purpose                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `smartassistrepo/callflows/agentTransferCall.json` | Agent transfer call flow                          |
| `smartassistrepo/callflows/welcomeChatFlow.json`   | Welcome chat flow (contains agent transfer steps) |
| `smartassistrepo/callflows/welcomeVoiceFlow.json`  | Welcome voice flow                                |

### 9.2 Runtime Loading (Koreserver)

| File                                               | Purpose                                                          |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `api/services/Callflow/lib/CFStepDefinition.js`    | Manages callflow step definitions including agent transfer steps |
| `api/services/Callflow/lib/CallflowApplication.js` | Callflow application loading                                     |
| `api/services/Callflow/utils/stepSchema.js`        | Step schema definitions                                          |

**Callflow coordination config:** `config/configs/callflow.json` — strategy (RabbitMQ/KoreQ), queue names, worker settings.

### 9.3 AgentAssist Fetches and Caches Experience Flows

**File (AgentAssist):** `src/services/experienceflow.service.js`

- Cached in Redis with key pattern: `{campaignRedisPrefix}:{botId}:EXPERIENCE_FLOW`
- Stores `{vendor, language}` per flow ID
- Fetches details from Koreserver via `getCallflowVoiceDetailsFromKS()`

### 9.4 Experience Flow Triggers at Runtime

**File:** `src/agentHandler/agentRouterv2.js`

| Config Field                                    | When Triggered           | Line       |
| ----------------------------------------------- | ------------------------ | ---------- |
| `metaInfo.agentTransferConfig.inQueueFlowId`    | User is waiting in queue | 2635       |
| `metaInfo.agentTransferConfig.outOfHoursFlowId` | Outside business hours   | 3685, 3779 |
| `metaInfo.agentTransferConfig.noAgentsFlowId`   | No agents available      | 3846, 3892 |

### 9.5 Flow Completion Callback

When an experience flow completes, AgentAssist receives a callback:

```
POST /internal/events/flows/handle
```

**File:** `src/controllers/flowEventsHandler.controller.js` → calls `handleConversationEndedInExperienceFlows()` from agentRouterv2.

### 9.6 Dialog Triggering from AgentAssist

Dialogs are triggered via the `trigger_dialog_from_agent` event sent through `socketService.sendKoreEvent()`. Used for:

- CSAT surveys after conversation close
- No-agent-available automation flows
- Start events on conversation assignment (`metaInfo.agentTransferConfig.assistEvents.startEvent`)

---

## 10. Step 9 — Session Closure

### 10.1 Agent Closes Conversation

**File (AgentAssist):** `src/socket.js` (line 11982)

Agent emits `conversation_closed` Socket.IO event → conversation status updated to `CLOSED` / `AGENT_CLOSED` / `DROPOFF`.

### 10.2 AgentAssist Notifies Koreserver

```javascript
socketService.sendKoreEvent({
  eventName: 'start_kore_agent_chat_message_for_user',
  payload: { conversationId, closeStatus, ... }
})
```

### 10.3 Koreserver Cleans Up Session

**File:** `api/services/AgentExecutor/lib/koreAgent/endAgentSession.js`

`closeAgentSessionFromFlow()` (line 7):

- Cleans up Redis keys
- Calls `clearAgentSession()`
- Handles CSAT key cleanup

**File:** `api/services/AgentExecutor/lib/koreAgent/index.js`

`initiateAgentTransferSessionClosure()` (line 66):

1. Cleans all Redis keys: `AST:CHANNELCONTEXT:*`, `AgentTransfer:*`, `userId#botId`
2. Loads bot session
3. Initiates `SessionClosureService`

### 10.4 CSAT Survey (Optional)

If CSAT is configured, AgentAssist triggers `trigger_dialog_from_agent` event to Koreserver, which launches the CSAT dialog flow.

### 10.5 TTL-Based Session Cleanup

**File:** `api/services/AgentExecutor/lib/koreAgent/index.js` (line 123)

Subscribes to Redis keyspace notifications: `__keyspace*__:AgentTransfer:*`

On key expiry, sends a `start_control_message_for_agent` event to AgentAssist to handle timeout-based session cleanup.

---

## 11. Event Dispatch Table (AgentAssist)

**File:** `src/controllers/internalAPIs.controller.js` (line 488) — `handleKoreServerEvents`

### Primary Events

| eventName                                 | Handler                                   | Description                     |
| ----------------------------------------- | ----------------------------------------- | ------------------------------- |
| `set_offline_status`                      | `setAgentStatusOfflineOnLogout`           | Agent logout                    |
| `reload_chat_history`                     | `sendReloadChatHistoryEventToAgent`       | Reload chat history             |
| `update_last_message_in_email`            | Direct DB update                          | Email message update            |
| `start_control_message_for_agent`         | Multiple sub-handlers                     | User control events (see below) |
| `handle_sip_refer_for_agent`              | `handleSIPRefer`                          | SIP transfer                    |
| `start_kore_agent_chat_message_for_agent` | `socketServer.handleUserMessage`          | User messages to agent          |
| `start_form_message_for_agent`            | `socketServer.handleFormMessage`          | Form messages from user         |
| `start_external_transcript_message`       | `koreAgentAssistServer.handleUserMessage` | External transcripts            |
| `post_intent_detection_response`          | `handlePostCallAnalysis`                  | Post-call analysis              |
| `post_topic_modeling_response`            | `handlePostCallAnalysis`                  | Topic modeling results          |
| `process_sentiment_response`              | `handleACEventsWithWidgetSettings`        | Sentiment analysis              |
| `process_adherence_response`              | `handleACEventsWithWidgetSettings`        | Adherence check                 |
| `conference_join_status`                  | `socketServer.handleConferenceJoinStatus` | Conference join                 |
| `consult_join_status`                     | Respective handler                        | Consult call join               |
| `consult_exit_status`                     | Respective handler                        | Consult call exit               |
| `agentassist_savg_session_metadata`       | `updateConversationVoiceMeta`             | Voice metadata                  |

### Sub-Events Under `start_control_message_for_agent`

| Sub-event            | Description              |
| -------------------- | ------------------------ |
| `close_conversation` | Close the conversation   |
| `message_delivered`  | Message delivery receipt |
| `message_read`       | Message read receipt     |
| `rtm_disconnected`   | RTM channel disconnected |
| `rtm_connected`      | RTM channel connected    |
| `typing`             | User typing indicator    |
| `stop_typing`        | User stopped typing      |
| `webrtc_event`       | WebRTC event             |

---

## 12. API Endpoint Reference

### Koreserver → AgentAssist

| Endpoint                                     | Method | Purpose                                 |
| -------------------------------------------- | ------ | --------------------------------------- |
| `/api/v1/conversations/?streamId={botId}`    | POST   | Create conversation (initiate transfer) |
| `/api/v1/conversations/{conversationId}`     | PUT    | Update conversation                     |
| `/api/v1/internal/events/handle/`            | POST   | Forward user messages, control events   |
| `/api/v1/internal/events/flows/handle`       | POST   | Experience flow event callbacks         |
| `/api/v1/internal/events/bots/handle`        | POST   | Bot lifecycle notifications             |
| `/api/v1/internal/aaresponse`                | POST   | Async AA bot responses                  |
| `/api/v1/internal/agents`                    | POST   | Create agent                            |
| `/api/v1/internal/aai/events/handle`         | POST   | Agent AI events                         |
| `/internal/flows/nodes/agentsAvailability`   | POST   | Check agent availability                |
| `/internal/flows/nodes/businessHours`        | POST   | Check business hours                    |
| `/internal/flows/nodes/queueAvailability`    | POST   | Check queue availability                |
| `/internal/session`                          | POST   | Create session/conversation             |
| `/internal/aaevents`                         | POST   | V2 AgentAssist events                   |
| `/internal/agentassist/v1/sendResponse`      | POST   | AgentAssist v1 response relay           |
| `/internal/events/bots/voiceChannels/handle` | POST   | Voice channel changes                   |

### AgentAssist → Koreserver

| Endpoint                                                            | Method | Purpose                                                    |
| ------------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
| `/api/1.1/internal/agentassist/events/handle`                       | POST   | **Primary**: agent messages, close events, transfer status |
| `/api/1.1/internal/agentassist/bots/{botId}/agenttransfer`          | POST   | Bot-to-agent transfer initiation                           |
| `/api/1.1/internal/agentassist/users/{userId}/bots/{botId}/skills`  | GET    | Fetch skills for routing                                   |
| `/api/1.1/internal/agentassist/{botId}/savemessageforaa`            | POST   | Save messages for AA                                       |
| `/api/1.1/internal/agentassist/{botId}/getAgentAssistToken`         | POST   | Get JWT token                                              |
| `/api/1.1/internal/agentassist/bots/{botId}`                        | GET    | Get bot details                                            |
| `/api/1.1/internal/agentassist/bots/{botId}/users/{userId}/resolve` | POST   | Resolve payload context                                    |
| `/api/1.1/internal/agentassist/user`                                | POST   | Create AA user                                             |
| `/api/1.1/internal/agentassist/accounts/getAccountIdByBotId`        | POST   | Account lookup                                             |
| `/api/1.1/internal/agentassist/{botId}/redactUserMessage`           | POST   | Redact user messages                                       |
| `/api/1.1/internal/agentassist/siprefer`                            | POST   | SIP REFER notification                                     |
| `/api/1.1/internal/agentassist/{botId}/translateWidgetResponse`     | POST   | Translation                                                |
| `/api/1.1/internal/agentassist/campaign/createBotSession`           | POST   | Campaign bot session                                       |
| `/hooks/agentassist/{botId}`                                        | POST   | AA bot webhook invocation                                  |
| `/chatbot/hooks/{botId}`                                            | POST   | Chatbot channel webhook                                    |

### Koreserver REST APIs (AgentAssist.rest.js)

| Method                        | Line | Purpose                            |
| ----------------------------- | ---- | ---------------------------------- |
| `createAgent`                 | 50   | Create agent record                |
| `getConversationMessageCount` | 55   | Get message count for conversation |
| `getAgentDetailsByEmailIds`   | 76   | Lookup agents by email             |
| `getAgentDetailsByUserIds`    | 82   | Lookup agents by user ID           |
| `getAgentDetailsByOrgId`      | 92   | Lookup agents by org               |
| `getSessionsByBotIdAndUserId` | 98   | Get sessions for bot+user          |

---

## 13. Redis Key Patterns

| Key Pattern                                     | Owner       | Purpose                    | TTL                         |
| ----------------------------------------------- | ----------- | -------------------------- | --------------------------- |
| `AgentTransfer:<base64(JSON)>`                  | Koreserver  | Transfer session flag      | `agentSessionTTL` (259200s) |
| `agent:userId#botId`                            | Koreserver  | Agent session data         | —                           |
| `userId#botId`                                  | Koreserver  | Conversation ID mapping    | —                           |
| `AST:CHANNELCONTEXT:*`                          | Koreserver  | Channel context            | —                           |
| `BOT_TO_AGENT_TRANSFER:{botSessionId}`          | AgentAssist | Bot-to-agent transfer data | —                           |
| `{campaignRedisPrefix}:{botId}:EXPERIENCE_FLOW` | AgentAssist | Cached experience flows    | —                           |

**Session ID format:** `AgentTransfer:<base64(JSON({botId, userId, channel}))>` (lines 21–29 in `Templates/services/agent_transfer.js`)

---

## 14. RabbitMQ (KoreQ) Job Flows

### Koreserver Queues

| Queue          | Job Name                                 | Handler                                     | Direction          |
| -------------- | ---------------------------------------- | ------------------------------------------- | ------------------ |
| `bots`         | `InitAgentTransfer`                      | `agentService.initAgentTransfer`            | Internal           |
| `bots`         | `SmartAssistInitAgentTransfer`           | `agentService.SmartAssistInitAgentTransfer` | Internal           |
| `bots`         | `clearAgentSession`                      | `agentService.clearAgentSession`            | Internal           |
| `bots`         | `update_agent_expire`                    | `agentService.updateAgentSession`           | Internal           |
| `agentdesktop` | `start_kore_agent_chat_message_for_user` | KoreExecutor handler                        | AgentAssist → User |
| `callflow`     | Agent transfer status                    | Callflow coordination                       | Internal           |

**Job definition files:**

- `services/KoreQ/jobFlows/bots/smartassist_init_agent_transfer.json`
- `services/KoreQ/jobFlows/agentdesktop/start_kore_agent_chat_message_for_user.json`

---

## 15. Socket.IO Events (AgentAssist)

**File:** `src/socket.js` (lines 11966–12069) — 60+ registered events

### Agent Transfer Events

| Event                                 | Line  | Description              |
| ------------------------------------- | ----- | ------------------------ |
| `conversation_transfer`               | 11985 | Agent-initiated transfer |
| `bulk_conversation_transfer`          | 11986 | Bulk transfer            |
| `validate_bulk_conversation_transfer` | 11987 | Validate bulk transfer   |
| `bot_conversation_transfer`           | 11988 | Bot-to-agent transfer    |

### Conversation Lifecycle Events

| Event                     | Line  | Description                |
| ------------------------- | ----- | -------------------------- |
| `conversation_accept`     | 11978 | Agent accepts conversation |
| `conversation_closed`     | 11982 | Agent closes conversation  |
| `conversation_terminated` | 11984 | Conversation terminated    |
| `conversation_join`       | 11996 | Join conversation          |
| `conversation_exit`       | 11997 | Exit conversation          |

### Message Events

| Event                   | Line  | Description                  |
| ----------------------- | ----- | ---------------------------- |
| `agent_message`         | 11992 | Agent sends message          |
| `agent_assist_request`  | 12008 | Agent requests AA suggestion |
| `proactive_agentassist` | 12009 | Proactive AA suggestion      |

### Bot-to-Agent Transfer Flow (AgentAssist)

**File:** `src/socket.js` — `handleBotConversationTransfer` (line 3852):

1. Stores transfer data in Redis: `BOT_TO_AGENT_TRANSFER:{botSessionId}`
2. POSTs to `{KORE_HOST}/api/1.1/internal/agentassist/bots/{botId}/agenttransfer` with `{botSessionId}`

### Additional WebSocket Server

**File:** `src/websocketServer.js`

Native WebSocket server at `/headless/api/v1/chat` for headless API clients. Uses `validatePublicAPIAuthorizationWithInstanceBotId` for auth.

### AgentAssist Transport Namespace

**File:** `src/agentAssistTransport.js`

Emits events to the `/koreagentassist` Socket.IO namespace for AA bot communication:

```javascript
ioClient.of('/koreagentassist').to(conversationId).emit(eventName, payload);
```

### Internal Event Emitters

**File:** `src/eventEmitter/`

| Emitter Type        | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `NodeEventEmitter`  | In-process events (e.g., `notify_agent` in agentRouter.js:519) |
| `RedisEventEmitter` | Cross-process Redis pub/sub                                    |
| `WFMEventEmitter`   | Workforce management events                                    |

---

## 16. Sequence Diagram

```
    User          Channel        Koreserver                    AgentAssist              Agent Desktop
     │               │               │                             │                        │
     │──message──►   │               │                             │                        │
     │               │──webhook──►   │                             │                        │
     │               │               │                             │                        │
     │               │               │  [Bot NLP processes]        │                        │
     │               │               │  [Dialog hits AgentTransfer │                        │
     │               │               │   node]                     │                        │
     │               │               │                             │                        │
     │               │               │──RabbitMQ: InitAgentTransfer│                        │
     │               │               │  [Worker picks up job]      │                        │
     │               │               │  [Creates Redis session]    │                        │
     │               │               │  [AgentHandlerService       │                        │
     │               │               │   .executeHandOff()]        │                        │
     │               │               │                             │                        │
     │               │               │──POST /api/v1/conversations/│                        │
     │               │               │  ?streamId={botId}──────►   │                        │
     │               │               │                             │  [routeUserToAgent()]   │
     │               │               │                             │  [Check skills, queue,  │
     │               │               │                             │   business hours]       │
     │               │               │                             │  [Calculate scores]     │
     │               │               │                             │──Socket.IO:─────────►   │
     │               │               │                             │  new_conversation       │
     │               │               │                             │                        │
     │               │               │                             │◄──Socket.IO:────────   │
     │               │               │                             │  conversation_accept    │
     │               │               │                             │                        │
     ═══════════════════════ CONVERSATION IN PROGRESS ══════════════════════════════════════
     │               │               │                             │                        │
     │──message──►   │               │                             │                        │
     │               │──webhook──►   │                             │                        │
     │               │               │  [checkForAgentSession()    │                        │
     │               │               │   → blocks NLP]             │                        │
     │               │               │──POST /internal/events/     │                        │
     │               │               │  handle (user_message)──►   │                        │
     │               │               │                             │──Socket.IO:─────────►   │
     │               │               │                             │  user_message           │
     │               │               │                             │                        │
     │               │               │                             │◄──Socket.IO:────────   │
     │               │               │                             │  agent_message          │
     │               │               │◄──POST /api/1.1/internal/   │                        │
     │               │               │  agentassist/events/handle──│                        │
     │               │               │  (agent_message_for_user)   │                        │
     │               │               │                             │                        │
     │   ◄──channel──│◄──response──  │                             │                        │
     │               │               │                             │                        │
     ═══════════════════════ SESSION CLOSURE ═══════════════════════════════════════════════
     │               │               │                             │                        │
     │               │               │                             │◄──Socket.IO:────────   │
     │               │               │                             │  conversation_closed    │
     │               │               │◄──POST events/handle────────│                        │
     │               │               │  (close status)             │                        │
     │               │               │  [Clean Redis keys]         │                        │
     │               │               │  [SessionClosureService]    │                        │
     │               │               │                             │                        │
     │               │               │  [Optional: CSAT dialog]    │                        │
     │   ◄──CSAT──   │◄──response──  │                             │                        │
     │               │               │                             │                        │
```

---

## 17. Key Source Files Reference

### Koreserver

| File                                                                               | Purpose                                                    |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `api/services/DialogExecutionService/lib/NodeExecutors/AgentTransferExecutor.js`   | Dialog-level agent transfer node                           |
| `callflows/engine/lib/callflow/tasks/AgentTransferTask.js`                         | Callflow-level agent transfer task                         |
| `callflows/engine/lib/callflow/tasks/AgentTransferTaskDefinition.js`               | Task definition schema                                     |
| `Templates/BotsServices/agent_transfer.js`                                         | RabbitMQ job registration                                  |
| `Templates/services/agent_transfer.js`                                             | Core transfer service logic                                |
| `api/services/AgentExecutor/AgentHandlerService.js`                                | Agent executor dispatcher                                  |
| `api/services/AgentExecutor/lib/koreAgent/index.js`                                | Kore agent executor (conversation creation, message relay) |
| `api/services/AgentExecutor/lib/koreAgent/endAgentSession.js`                      | Session cleanup                                            |
| `api/services/AgentExecutor/lib/BaseAgentExecutor.js`                              | Base class for all executors                               |
| `api/services/AgentAssistService.js`                                               | HTTP request utility for AgentAssist calls                 |
| `api/services/SmartAssist/utils/index.js`                                          | URL resolution (`getKoreAgentAssistUrl`)                   |
| `api/rest/AgentAssist.rest.js`                                                     | REST API endpoints                                         |
| `Templates/BotsServices/route_message_kora.js`                                     | Message routing with agent session check                   |
| `Templates/BotsServices/validate_user.js`                                          | User validation with agent session check                   |
| `Templates/BotsServices/channels/rtm.js`                                           | RTM channel agent session check                            |
| `config/configs/kore_live_agent.json`                                              | AgentAssist configuration                                  |
| `config/configs/agentExecutor.json`                                                | Agent executor configuration                               |
| `config/configs/bot_smartassist.json`                                              | SmartAssist channel config                                 |
| `config/configs/bot_agentassist.json`                                              | AgentAssist channel config                                 |
| `config/configs/callflow.json`                                                     | Callflow coordination config                               |
| `smartassistrepo/callflows/agentTransferCall.json`                                 | Agent transfer call flow definition                        |
| `smartassistrepo/callflows/welcomeChatFlow.json`                                   | Welcome chat flow definition                               |
| `smartassistrepo/callflows/welcomeVoiceFlow.json`                                  | Welcome voice flow definition                              |
| `api/services/Callflow/lib/CFStepDefinition.js`                                    | Callflow step definitions                                  |
| `api/services/Callflow/lib/CallflowApplication.js`                                 | Callflow application loading                               |
| `services/KoreQ/jobFlows/bots/smartassist_init_agent_transfer.json`                | RabbitMQ job definition                                    |
| `services/KoreQ/jobFlows/agentdesktop/start_kore_agent_chat_message_for_user.json` | RabbitMQ job definition                                    |

### AgentAssist (koreagentassist)

| File                                              | Purpose                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| `src/routes/v1/internalAPIs.route.js`             | Internal API route definitions                      |
| `src/controllers/internalAPIs.controller.js`      | Event dispatch from Koreserver                      |
| `src/controllers/flowEventsHandler.controller.js` | Experience flow event handling                      |
| `src/socket.js`                                   | Socket.IO server (60+ events, 11000+ lines)         |
| `src/services/socket.service.js`                  | `sendKoreEvent()` — outbound calls to Koreserver    |
| `src/services/experienceflow.service.js`          | Experience flow caching and fetching                |
| `src/services/agentassist.service.js`             | AgentAssist service (tokens, bot details, webhooks) |
| `src/agentHandler/agentRouterv2.js`               | Agent routing algorithm                             |
| `src/websocketServer.js`                          | Native WebSocket server for headless API            |
| `src/agentAssistTransport.js`                     | Socket.IO namespace for AA bot                      |
| `src/config/config.js`                            | Configuration (Koreserver URLs, auth keys)          |
| `src/middlewares/internalAuth.js`                 | Internal API authentication                         |
| `src/eventEmitter/`                               | Event emitter implementations (Node, Redis, WFM)    |
| `src/routes/v1/callflow.rest.js`                  | Callflow CRUD routes                                |
| `src/routes/v1/callflow.messages.rest.js`         | Callflow messages CRUD                              |
