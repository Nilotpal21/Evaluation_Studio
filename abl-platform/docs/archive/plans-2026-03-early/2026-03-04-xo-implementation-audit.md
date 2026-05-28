# XO Platform Call Flow & Agent Transfer — Comprehensive Code Audit

**Date:** 2026-03-04
**Scope:** Line-by-line analysis of every XO implementation file for payload handling, protocol handling, special considerations, and implicit logic
**Purpose:** Inform the ABL Agent Platform agent-as-flow architecture design

---

## Table of Contents

1. [Files Reviewed](#1-files-reviewed)
2. [Core Architecture: How XO Routes Agent Transfers](#2-core-architecture)
3. [BaseTask — The Foundation](#3-basetask)
4. [AgentTransferTask — Complete Transfer Lifecycle](#4-agenttransfertask)
5. [Contact Center Nodes (Queue, Availability, Hours)](#5-contact-center-nodes)
6. [IVR/DTMF Tasks](#6-ivr-dtmf-tasks)
7. [Kore Agent Executor (4,752 lines)](#7-kore-agent-executor)
8. [Genesys Agent Executor (Dual API)](#8-genesys-agent-executor)
9. [All Other Agent Executors (12 providers)](#9-all-other-executors)
10. [Agent Transfer Service — Session Lifecycle](#10-agent-transfer-service)
11. [Voice Channel Executors](#11-voice-channel-executors)
12. [Callflow Execution Context](#12-callflow-execution-context)
13. [Redis Key Patterns — Complete Map](#13-redis-key-patterns)
14. [Configuration Dependencies](#14-configuration-dependencies)
15. [Implicit Logic & Hidden Behaviors](#15-implicit-logic)
16. [Critical Gaps & Anti-Patterns](#16-critical-gaps)
17. [Requirements Matrix for ABL](#17-requirements-matrix)

---

## 1. Files Reviewed

| File                                                                         | Lines  | Category               |
| ---------------------------------------------------------------------------- | ------ | ---------------------- |
| `callflows/engine/lib/callflow/tasks/BaseTask.js`                            | ~750   | Foundation class       |
| `callflows/engine/lib/callflow/tasks/AgentTransferTask.js`                   | 567    | Agent transfer         |
| `callflows/engine/lib/callflow/tasks/AgentTransferTaskDefinition.js`         | 139    | Task config model      |
| `callflows/engine/lib/callflow/tasks/CheckAgentAvailabilityTask.js`          | 84     | Contact center node    |
| `callflows/engine/lib/callflow/tasks/CheckBusinessHoursTask.js`              | 60     | Contact center node    |
| `callflows/engine/lib/callflow/tasks/setQueueTask.js`                        | 162    | Contact center node    |
| `callflows/engine/lib/callflow/tasks/IVRMenuTask.js`                         | 239    | IVR/DTMF               |
| `callflows/engine/lib/callflow/tasks/IVRDigitTask.js`                        | 251    | IVR/DTMF               |
| `callflows/engine/lib/callflow/executioncontext/CallflowExecutionContext.js` | 1,124  | State container        |
| `callflows/api/services/CallflowService.js`                                  | 267    | API routing            |
| `api/services/AgentExecutor/lib/koreAgent/index.js`                          | 4,752  | Kore native agent      |
| `api/services/AgentExecutor/lib/koreAgent/csatUtils.js`                      | ~200   | CSAT scheduling        |
| `api/services/AgentExecutor/lib/koreAgent/endAgentSession.js`                | ~150   | Session cleanup        |
| `api/services/AgentExecutor/lib/koreAgent/channelMetaInfoParser.js`          | ~100   | Channel metadata       |
| `api/services/AgentExecutor/lib/genesysAgent/index.js`                       | ~400   | Genesys executor       |
| `api/services/AgentExecutor/lib/genesysAgent/GenesysService.js`              | ~500   | WebChat API WS         |
| `api/services/AgentExecutor/lib/genesysAgent/GenesysWebMessageService.js`    | ~400   | WebMessaging API WS    |
| `api/services/AgentExecutor/lib/genesysAgent/supportedMimeTypes.js`          | ~50    | File types             |
| `api/services/AgentExecutor/lib/salesforceAgent/index.js`                    | ~600   | Salesforce Live Agent  |
| `api/services/AgentExecutor/lib/salesforcemiawAgent/index.js`                | ~800   | Salesforce MIAW        |
| `api/services/AgentExecutor/lib/servicenowAgent/index.js`                    | ~500   | ServiceNow             |
| `api/services/AgentExecutor/lib/niceincontactAgent/index.js`                 | ~400   | NiceInContact          |
| `api/services/AgentExecutor/lib/niceincontactuserhubAgent/index.js`          | ~500   | NiceInContact CXone    |
| `api/services/AgentExecutor/lib/livepersonAgent/index.js`                    | ~600   | LivePerson             |
| `api/services/AgentExecutor/lib/livepersonAgent/LivePersonService.js`        | ~400   | LivePerson auth        |
| `api/services/AgentExecutor/lib/intercomAgent/index.js`                      | ~300   | Intercom               |
| `api/services/AgentExecutor/lib/driftAgent/index.js`                         | ~200   | Drift                  |
| `api/services/AgentExecutor/lib/helpshiftAgent/index.js`                     | ~300   | Helpshift              |
| `api/services/AgentExecutor/lib/zendeskAgent.js`                             | ~400   | Zendesk Switchboard    |
| `api/services/AgentExecutor/lib/zoomAgent.js`                                | ~80    | Zoom                   |
| `api/services/AgentExecutor/lib/unbluAgent.js`                               | ~80    | Unblu                  |
| `api/services/AgentExecutor/lib/genericAgent.js`                             | ~50    | Generic/custom         |
| `api/services/AgentExecutor/lib/BaseAgentExecutor.js`                        | 50     | Base class             |
| `Templates/services/agent_transfer.js`                                       | 1,037  | Session lifecycle      |
| `Templates/BotsServices/agent_transfer.js`                                   | 29     | Job handler wrapper    |
| `Templates/services/VoiceAgentExecutor/lib/koreVoiceAgent.js`                | 3,700  | Kore voice agent       |
| `Templates/services/VoiceAgentExecutor/lib/customVoiceAgent.js`              | 787    | Multi-channel voice    |
| `api/services/BuilderService/utils/index.js`                                 | ~6,300 | Integration config     |
| `api/services/BuilderService/lib/BTAgentIntegrationService.js`               | ~250   | Agent integration CRUD |
| `config/configs/kore_live_agent.json`                                        | ~100   | SmartAssist config     |
| `config/configs/callflow.json`                                               | ~200   | Callflow config        |

**Total: ~24,000+ lines reviewed across 40+ files**

---

## 2. Core Architecture: How XO Routes Agent Transfers

### The Routing Decision Tree

```
AgentTransferTask.performAgentTransfer()
  │
  ├─ getAgentTransferPromise()
  │   ├─ IF botType === 'universalbot' → invokeAgentTransfer()
  │   ├─ ELSE IF appType === 'unified' AND NOT isSmartassistMigrated → invokeAgentTransfer()
  │   └─ ELSE → invokeParentBot()
  │
  ├─ invokeAgentTransfer()
  │   ├─ setChannelContextInRedis()  [ONLY for Kore agent]
  │   ├─ IF voice channel → sendMessage with isAgentTransfer:true
  │   └─ ELSE → KoreQ job 'SmartAssistInitAgentTransfer'
  │
  └─ invokeParentBot()
      ├─ Voice channel info: language, ASR, TTS, dialect, AMD, SIP headers
      ├─ Redis flag: returnControlToExpFlow
      ├─ KoreQ job: 'route_message_to_bot'
      └─ Flow re-entry: returnControlToExpFlow for post-agent dialog
```

### Two Transfer Pathways

**Path A — Direct to SmartAssist** (invokeAgentTransfer):

- For universal bots and unified apps not yet migrated
- SmartAssist routes to configured agent desktop (Kore or third-party)
- Channel context stored in Redis for Kore agent only

**Path B — Via Bot Engine** (invokeParentBot):

- For migrated unified apps and standard apps
- Routes through the bot engine which then delegates to SmartAssist
- Carries full voice channel metadata (language, dialect, SIP headers)

---

## 3. BaseTask — The Foundation

**File:** `callflows/engine/lib/callflow/tasks/BaseTask.js` (lines 250-750)

### 3.1 invokeAgentDesktopNodes(payload) — Lines 650-716

**Protocol:** HTTP POST to `{koreAgentUrl}/api/v1/internal/flows/nodes/{nodeType}`

**Auth:** Internal API key via `config.internalAuth.apikey` header

**Pre-processing:**

1. Language mapping via `config.bot_smartassist.languageMapping` before EVERY SmartAssist call
2. Node type resolution: `config.callflow.agentNodeResolver[taskName]`
3. Tracing context serialized to HTTP headers

**Error handling:** Wraps HTTP errors in `TCPError` class

**Implicit behavior:**

- Language code is remapped (e.g., 'en-US' → 'en') before any SmartAssist API call
- This is a GLOBAL transform, not per-task

### 3.2 getAgentTransferPromise() — Lines 288-302

**Routing decision factors:**

1. `botType === 'universalbot'`
2. `appType === 'unified'`
3. `isSmartassistMigrated` flag
4. `skipATIntentToCS` config

**Implicit behavior:**

- Sets `automationBotId` from cfContext if missing from payload
- This is the **only** decision point for transfer routing — everything downstream depends on this

### 3.3 invokeAgentTransfer() — Lines 329-370

**Voice path:** `sendMessage({ isAgentTransfer: true, skipStoringResponse: true })`

- Message goes through the voice channel SDK, which detects `isAgentTransfer` flag

**Chat path:** KoreQ job `SmartAssistInitAgentTransfer`

- Job queued with full context payload

**Pre-requisite:** Always calls `setChannelContextInRedis()` first

**Tracing:** Creates span with `startJobFlow` tracing context

### 3.4 setChannelContextInRedis() — Lines ~230-286

**Condition:** Only for Kore agent (checks `voiceAgent.name === 'koreAgent'` or `chatAgent.name === 'kore'`)

**Redis key:** `AST:CHANNELCONTEXT:{botId}:{userId}:{channel}`
**TTL:** 86400 seconds (1 day) from `config.kore_live_agent.agentChannelContextTTL`

**Stored data:** Minimal — botId, userId, channel type, metadata

**Critical insight:** Third-party agent desktops do NOT get channel context stored in Redis — only Kore native

### 3.5 invokeParentBot() — Lines 372-624

**The most complex method in BaseTask.** Handles:

1. **Voice channel info collection:**
   - ASR language, vendor, dialect preferences
   - TTS voice, language, dialect
   - AMD (Answering Machine Detection) settings
   - SIP headers (resolved from templates)
   - Voice channel type (korevg, audiocodes, etc.)

2. **Dialect resolution:**
   - Calls SmartAssist service to resolve dialect preferences
   - Stores resolved dialect in `voiceChannelInfo`

3. **SIP header resolution:**
   - Template variable substitution (e.g., `{{context.field}}`)
   - Resolved before passing to SmartAssist

4. **Flow re-entry:**
   - Sets Redis flag `returnControlToExpFlow` for post-agent dialog
   - On agent session end, flow resumes from this flag

5. **Custom flow data propagation:**
   - `customFlowData` passes arbitrary JSON through transfer
   - Cleaned: `isAgentTransferredTriggered` flag removed

6. **PII detokenization:**
   - If payload contains tokenized PII, de-tokenizes before transfer

---

## 4. AgentTransferTask — Complete Transfer Lifecycle

**File:** `callflows/engine/lib/callflow/tasks/AgentTransferTask.js` (567 lines)

### 4.1 Constructor — Lines 29-76

**Data collection from ALL previous steps:**

```
detected intent ← last user intent
user input ← last user message
dialog tone ← accumulated tone across conversation
automation node ← flag from automation step
UXO universal bot ← flag
skills ← ACCUMULATED from ALL step results (not just current node)
queue ← from config OR flow context (cfContext.getQueue())
waiting experience ID ← from config
post-agent conversation ← return-to-bot or end
response OOB ← out-of-band context
```

**Skill accumulation logic (lines 70-72):**

```javascript
// Skills are gathered from previous step results that had agentTransferConfig
this.skills = accumulatedSkillsFromAllPreviousSteps;
```

**This is critical:** Skills aren't just from the current Agent Transfer node — they're collected from every prior step that set skills.

### 4.2 performAgentTransfer() — Lines 113-331

**Step-by-step flow:**

1. **VoiceChat language reload** (line 117-119): Reloads language for voice chat sessions
2. **Skip message for dialog executionType** (line 126): If transfer triggered from dialog (not flow), skip sending message to user
3. **Redis flag for non-migrated** (lines 136-141): `CF:AGENT_TRANSFER:{sessionId}:{botId}:{userId}:{channel}`
4. **Voice disabling bot no-input** (line 145): `disableBotNoInput: true` prevents bot from timing out while agent connects
5. **automationBotId resolution** (lines 182-214): Scans ALL previous steps backward to find automation/conversationalivr/uxoautomation tasks
6. **Intent resolution** (lines 216-221):
   - Unified + dialog: `usecaseName`
   - Otherwise: `presetDialogs.agentTransfer`
7. **Dialog executionType**: Stores `ATCF:` Redis key for post-agent flow re-entry
8. **agentDesktopMeta**: Passed through from upstream steps

**Voice vs Chat divergence at end:**

| Aspect       | Voice                                           | Chat                                             |
| ------------ | ----------------------------------------------- | ------------------------------------------------ |
| Step state   | `setWaitStatus().onTaskWait()` — holds the call | `setCompleteStatus().onCFComplete()` — flow ends |
| What happens | Call is held, waiting for agent                 | Flow terminates, SmartAssist takes over          |
| Post-agent   | Step stays in wait, re-enters on callback       | Unless post-agent dialog configured              |

**Post-agent dialog (chat only):**

1. `fetchAgentIntegrationType()` — checks if provider supports it (only genesys currently)
2. Sets `agentIntegrationType` in step context
3. Sets Redis key `POST_AGENT_DIALOG:{sessionId}:{botId}:{userId}:{channel}`
4. Changes to `setWaitStatus()` instead of complete

### 4.3 handleUserRequest() — Lines 341-379

**During post-agent dialog:** Forwards user message to bot via `invokeParentBot()`
**Otherwise:** Re-invokes `performAgentTransfer()` — this is the re-entry for voice (user speaks during wait)

### 4.4 handleDTMFRequest() — Line 381

Simply calls `performAgentTransfer()` — DTMF during voice wait triggers re-transfer

### 4.5 handleAsyncSuccessFailureResponse() — Lines 394-432

**Post-agent dialog completion handler. Two outcomes:**

1. Dialog triggered another agent transfer → re-invoke
2. Normal completion → complete step

### 4.6 handleTransferStatus() — Lines 434-476

**Four branches:**
| Status | Internal? | Action |
|--------|-----------|--------|
| failed/declined | No | Error message, complete step |
| failed/declined | Yes (internalAgentTransfer) | Keep waiting |
| triggerDialog configured | — | Keep waiting |
| success | — | Complete step |

### 4.7 agentTransferCompleted() — Lines 484-562

**Called on agent session end. Two sources:**

1. `AgentTransferExecutor` — IGNORE for agenttransfer tasks (it's for dialog-level transfers)
2. `clearAgentSession` — PROCEED

**For chat + supported integration:**

- Trigger post-agent dialog via `invokeParentBot()` with `skipSmartAssistChannel = true`

**CRITICAL:** Must call `onTaskWait()` not `Promise.resolve()` to prevent queue stuck in inProgress

---

## 5. Contact Center Nodes

### 5.1 CheckAgentAvailabilityTask (84 lines)

**Payload sent to SmartAssist:**

```javascript
{
    orgId, accountId, userId, botId, source, botSessionId, language,
    queueId: cfContext.getQueue(),
    metaInfo: {
        agentTransferConfig: {
            skillsIds: skills,
            overrideAgents: specificAgents,
            overrideValues: specificAgentValues
        }
    }
}
```

**Response:** `{ agentAvailability: boolean }` → SUCCESS or FAILURE branch

### 5.2 CheckBusinessHoursTask (60 lines)

**Payload:** `{ id: hoursOfOperationId, botId }`
**Response:** `{ isValid: boolean }` → SUCCESS or FAILURE branch

### 5.3 SetQueueTask (162 lines)

**Two modes:**

1. **Static:** `queueId` from task definition
2. **Script-based:** `hasScript: true` → lodash template execution → extract queue from resolved context

**Priority handling:**

- Range: 0-10, default 5
- Validated with min/max bounds from config
- Priority stored in flow context: `cfContext.setValueInContext('priority', priority)`

**Queue validation:** `invokeAgentDesktopNodes({ queueId, botId })` → `{ isValid: boolean }`

---

## 6. IVR/DTMF Tasks

### 6.1 IVRMenuTask (239 lines)

**Purpose:** Single DTMF digit selection from predefined menu

**State machine:**

```
start() → send prompt → setWaitStatus()
  → handleDTMFRequest() → parse single digit → isValidInput()
  → Valid: SUCCESS branch
  → Invalid: retry with escalating messages (up to maxRetries)
  → Max retries exceeded: NOMATCH branch
```

**Prompt payload:**

```javascript
{
    message, isPrompt: true, timeout: timeoutMS,
    retries: maxRetries, timeoutMessages: [msg1, msg2, ...],
    bargeIn: false, sendDTMF: true, language, flowName
}
```

### 6.2 IVRDigitTask (251 lines)

**Purpose:** Collect variable-length digit sequences

**Parameters:**

- `dtmfCollectMaxDigits` — Maximum digits
- `dtmfCollectInterDigitTimeoutMS` — Timeout between digits (default 2000ms)
- `dtmfCollectSubmitDigit` — Ending key (default `$`)

**Prompt payload includes:**

```javascript
{
    dtmfCollect: true,
    dtmfCollectMaxDigits,
    dtmfCollectInterDigitTimeoutMS,
    dtmfCollectSubmitDigit,
    enableSpeechInput: false
}
```

---

## 7. Kore Agent Executor (4,752 lines)

**File:** `api/services/AgentExecutor/lib/koreAgent/index.js`

### 7.1 execute() — Lines 4573-4752+

**Entry point for Kore native agent transfer.**

**Flow:**

1. Check for existing conversation (UUID format: `c-{6-8 hex}-{4}-{4}-{4}-{12}`, 37 chars)
2. If exists → `updateChat()` (PUT to SmartAssist)
3. If new → `initChat()` (POST to SmartAssist)

**initChat() constructs a massive payload:**

```javascript
{
    botId, userId, orgId, accountId, source, language,
    botSessionId, queue, skills, priority,
    conversationType,  // livechat, messaging, email
    metaInfo: {
        agentTransferConfig: {
            automationBotId, skillsIds, overrideAgents, overrideValues,
            inQueueFlowId, waitingExperienceId, noAgentsFlowId, outOfHoursFlowId
        },
        userInfo, fullName, device
    },
    customFlowData,
    // Channel-specific fields:
    email: { emailId, subject, toEmailId, cc },  // email channels
    phoneNumber,  // SMS channels
    campaignId, campaignName, campInstanceId,  // campaign channels
    SA: 'cm_sms_...',  // SMS sub-type
    surveyRequired: 'NO'  // SMS CSAT override
}
```

**Post-initChat storage (7+ Redis keys):**

```
conversationId → data
userId#botId → data (with channel-specific TTL)
userId#CSAT#botId → data
CSAT#userId#botId → data (if survey required)
SUBFLOWCSAT#userId#botId → data (if subflow CSAT)
```

**TTL by channel:**
| Channel | TTL Source |
|---------|-----------|
| Chat | `agentSessionTTL` |
| Messaging | `AsyncMessageTimeout` |
| Email | `EmailChannelSessionTimeOut` |
| Voice | `koreVoiceAgentSessionTTL` |

### 7.2 sendMessage() — Lines 378-916

**Handles user messages TO agent during active session.**

**Key behaviors:**

- Retrieves session from Redis via `hgetAgentCallIdSync(userId#botId)`
- Extracts message from various payload structures (WebSDK body, channel body, JSON)
- **Proactive Agent Assist:** If enabled, routes user message through AI for smart suggestions
- **Email specifics:** Extracts from/cc/to, preserves originalEmailRecipients
- **Attachments:** File ID + extension + name, sent to agent desktop
- **Translation:** MSTeams HTML content conversion, URL shortening

**Agent Desktop HTTP call:**

```
POST {koreAgentUrl}/agentDesktopEventHandle/{streamId}
Headers: apikey, content-type, x-trace-id
Body: {
    eventName: "start_kore_agent_chat_message_for_agent",
    payload: { conversationId, author, botId, value, event, experience, ... },
    queryFields: { sid, cId, mId }
}
```

### 7.3 start_kore_agent_chat_message_for_user — Lines 1767-3396

**KoreQ job handler for events FROM agent TO user.**

**Event types handled (18+):**

| Event                                | Action                             |
| ------------------------------------ | ---------------------------------- |
| `agent_message`                      | Send text/template to user via SDK |
| `form_message`                       | Send form with template payload    |
| `typing` / `stop_typing`             | Typing indicator                   |
| `message_delivered` / `message_read` | Read receipts                      |
| `agent_accepted`                     | Agent connected system message     |
| `auto_agent_accepted`                | Auto-accept with optional message  |
| `auto_agent_accepted_form`           | Auto-accept with form              |
| `agent_joined_conversation`          | Agent joined event                 |
| `agent_exited_conversation`          | Agent left event                   |
| `conversation_transfer`              | Transfer notification              |
| `closed`                             | Session end (may trigger CSAT)     |
| `closed_in_flow`                     | Close in callflow context          |
| `case_created`                       | Salesforce case notification       |
| `conversation_queued`                | Queue position notification        |
| `proactive_agentassist`              | Toggle agent assist                |
| `override_user_input`                | Toggle input override              |
| `aa_copilot_mode`                    | Toggle agentic mode                |
| `disposition_submitted`              | Disposition for BotKit             |

**SDK-specific message formatting:**

| SDK          | Format                                 |
| ------------ | -------------------------------------- |
| RTM (WebSDK) | Template payload with custom rendering |
| WhatsApp     | Media endpoints (infobip vs standard)  |
| Facebook     | Attachment type with payload           |
| MS Teams     | URL shortening + adaptive cards        |
| Email        | Actual file attachments, CC/BCC        |
| Voice        | Voice-specific TTS/audio               |

### 7.4 notifyCallStatus() — Lines 1184-1322

**Voice call disconnect handler.**

Events: `agent_hangup`, `user_hangup`, `no-answer`, `busy`, `failed`

**Actions:**

- Updates bot session with `callDisconnectDetails`
- Saves meta tags for analytics
- AudioCodes: Fetches CDR, triggers `store_call_record` job
- Transfer failure: Full session cleanup with error status

### 7.5 Redis Pub/Sub — Key Expiration Handler (Lines 63-122)

**Pattern:** `__keyspace*__:AgentTransfer:*`
**Event:** Key expiration (TTL timeout)
**Action:** Sends "Agent Transfer Expired" control message to Agent Desktop

---

## 8. Genesys Agent Executor (Dual API)

### 8.1 Architecture: Two API Modes

**WebChat API (Legacy):**

- REST init → JWT → WebSocket for events
- Direct HTTP for sending messages
- Session identified by `conversationId`

**WebMessaging API (Modern):**

- WebSocket for everything
- Redis PubSub for message distribution
- Session identified by `tokenId`
- Presigned URL flow for file uploads

### 8.2 Initialization Flow

**WebChat API:**

```
POST /api/v2/webchat/guest/conversations
  → { organizationId, deploymentId, routingTarget: { targetType: "QUEUE", targetAddress }, memberInfo }
  ← { id, member.id, jwt, eventStreamUri }
  → Connect WebSocket to eventStreamUri
  → 3-second delay
  → Send initial message via HTTP
```

**WebMessaging API:**

```
Connect WebSocket to webSocketUrl?deploymentId=...
  → { action: "configureSession", deploymentId, token: tokenId }
  → 2-second delay
  → { action: "onMessage", token, message: { type: "Text", text: "..." } }
  → Redis PubSub bridge for subsequent messages
```

### 8.3 Key Features

**Language translation (voice chat):**

- Bidirectional: User→Agent and Agent→User
- Triggered when `voiceChatAgentLang !== voiceChatUserLang`
- Provider: Google or Azure (configurable)

**File upload (WebMessaging API):**

1. Request presigned URL from Genesys
2. Download file from Kore into memory (max 25MB)
3. PUT to presigned URL
4. Genesys sends `UploadSuccessEvent`
5. Send structured message with attachment ID

**Multi-region support:**

- Template-based URL substitution: `{regionSpecificHost}`
- Agent config `baseURL` determines region

**Server recovery (onLoad):**

- On restart, iterates all Redis hash entries
- Detects dead servers via `SERVER_GENESYS_{hostname}` key
- Migrates sessions to new server, reconnects WebSockets

### 8.4 Bot Variable Resolution

Genesys config fields support environment variables:

```javascript
config.organizationId = '{{env.GENESYS_ORG_ID}}';
// Resolved at runtime via BotVariablesModel + decryption
```

### 8.5 Redis Storage (3 keys per session)

```
agent:{userId}                           → User lookup
agent:genesys:{conversationId|tokenId}   → Conversation lookup
genesys[{hostname}_{id}]                 → Host-specific recovery (hash)
```

---

## 9. All Other Agent Executors (12 Providers)

### 9.1 Authentication Patterns

| Provider            | Auth Type                 | Token Management          |
| ------------------- | ------------------------- | ------------------------- |
| Salesforce          | Session header            | Per-call fetch            |
| Salesforce MIAW     | OAuth2                    | RequestAgent auto-refresh |
| ServiceNow          | Basic OR OAuth2           | RequestAgent              |
| NiceInContact       | OAuth2 client credentials | Per-call                  |
| NiceInContact CXone | OIDC + password grant     | JWT tenant extraction     |
| LivePerson          | Dual JWT (App + Consumer) | Redis TTL cache (55min)   |
| Zendesk             | Basic OR Bearer (IDP)     | Via StreamUserConnection  |
| Intercom            | Bearer API key            | Config                    |
| Drift               | Bearer token              | Config                    |
| Helpshift           | Basic (API key base64)    | Per-call                  |
| Zoom                | Bearer app_token          | Config                    |
| Unblu               | Basic OR header           | Config                    |
| Generic             | None                      | Redis event publish       |

### 9.2 Message Transport Patterns

| Pattern            | Providers                                                 | How It Works                        |
| ------------------ | --------------------------------------------------------- | ----------------------------------- |
| **Long-polling**   | Salesforce, NiceInContact, NiceInContact CXone, Helpshift | Periodic GET for new messages       |
| **Webhook**        | ServiceNow, LivePerson, Intercom, Drift                   | Callback URL receives events        |
| **WebSocket**      | Genesys                                                   | Persistent bidirectional connection |
| **Direct handoff** | Zendesk, Zoom, Unblu                                      | Single API call, no ongoing session |
| **Redis event**    | Generic                                                   | Pub/sub event publishing            |

### 9.3 Conversation History Passing

| Provider                            | Method                                       |
| ----------------------------------- | -------------------------------------------- |
| Salesforce                          | Optional initial message                     |
| NiceInContact/CXone                 | HTML-formatted initial message               |
| LivePerson                          | User profile SDEs (Structured Data Entities) |
| Zendesk                             | First message ID in metadata                 |
| Genesys                             | ChatHistoryUrl in initial message            |
| ServiceNow                          | contextVariables                             |
| Intercom/Drift/Helpshift/Zoom/Unblu | Not passed                                   |

### 9.4 Common Interface (BaseAgentExecutor)

```javascript
// All providers implement:
execute(context, stream, deliveryChannel, agentDetails, opts); // Initialize handoff
sendMessage(data, sessionFromRedis, message); // User → Agent
agentResponse(callId, body, skipMessage, opts); // Agent → User (webhook)
getPendingMessages(data); // Agent → User (polling)
endChat(data); // Terminate session
initialMessageToAgent(); // First message with history
handoffToAgent(); // Direct handoff (no session)
```

### 9.5 Provider-Specific Notable Features

**LivePerson:** Complex multi-step auth (App JWT → Consumer JWT via IDP), service discovery for regional endpoints, domain caching with 5min TTL

**ServiceNow:** Dual API support (Queue-based legacy vs Virtual Agent API), region-specific routing, "no agents available" special handling

**Zendesk:** Switchboard integration (pass control), post-session-closure handoff, custom tag preparation (user/message/session scoped)

**Salesforce MIAW:** Modern async/await patterns, dynamic UUID generation, BotUserSession context updates

**NiceInContact CXone:** Dynamic tenant endpoint resolution from JWT, OpenID Connect flow, region-aware API routing

---

## 10. Agent Transfer Service — Session Lifecycle

**File:** `Templates/services/agent_transfer.js` (1,037 lines)

### 10.1 Session ID Format

```javascript
getSessionId(data) → "AgentTransfer:" + base64({ botId, userId, channel })
```

### 10.2 Session Lifecycle

```
CREATION: initAgentTransfer() / SmartAssistInitAgentTransfer()
  → Create AgentTransfer:* in Redis
  → Store agentTransferConfig in BotsSessionStore (TTL: 1800s)
  → Log analytics
  → Set session TTL by channel type

MAINTENANCE: updateAgentSession()
  → Extend TTL on every incoming message
  → Also refreshes AST:CHANNELCONTEXT:* key
  → TTL adjustments: email > messaging > default

TERMINATION: clearAgentSession()
  → Delete ALL related Redis keys (7+ operations):
    - AgentTransfer:* (session marker)
    - userId#botId (Kore agent)
    - CSAT#userId#botId, SUBFLOWCSAT#userId#botId
    - ATCF:* (callflow agent context)
    - CF:AGENT_TRANSFER:* (CF agent transfer state)
    - POST_AGENT_DIALOG:* (post-agent trigger)
  → Send WebSocket event to RTM channels
  → Fire agent_transfer_complete event to callflow
  → Update analytics (isActive: 0)
```

### 10.3 SmartAssistInitAgentTransfer vs initAgentTransfer

| Aspect  | SmartAssistInitAgentTransfer    | initAgentTransfer     |
| ------- | ------------------------------- | --------------------- |
| Source  | Chat path (KoreQ job)           | Dialog-level transfer |
| Context | Stores in BotsSessionStore      | Executes dialog node  |
| Timeout | Channel-aware (messaging/email) | Default               |
| Dialog  | skipDialog: true                | Executes node         |

### 10.4 Analytics Logging (createLog)

- Dialog tone averaging across conversation
- Last intent name extraction
- Meta tags for timeline messages
- Session metrics with containment classification
- Conversation type tracking

---

## 11. Voice Channel Executors

### 11.1 customVoiceAgent.js (787 lines)

**Supported channels:** AudioCodes, KoreVG (Jambonz), Twilio Voice, Legacy IVR

**Transfer target resolution (priority order):**

1. `cfContext.sipTransferURI` / `cfContext.sipTransferNumber`
2. `botUserSession._metaInfo.sipTransferURI`
3. `childBotUserSession._metaInfo.sipTransferURI`
4. `agentConfig.sipTransferId` / `phoneNumber`

**Transfer types:**

- `invite` — SIP INVITE (default for KoreVG)
- `refer` — SIP REFER
- `bye` — SIP BYE

**SIP headers constructed:**

```
User-to-User: UUI metadata (hex-encoded JSON)
X-KoreReason: Transfer reason
X-NotifyEvent-URL: Callback for transfer status
X-CALLID: Audit trail
X-Vendor: Provider identifier
+ Custom headers from opts.customMetaInfo
```

**AudioCodes vs KoreVG divergence:**

- AudioCodes: Activity-based protocol (transfer, hangup, message activities)
- KoreVG: Jambonz WebhookResponse commands (dial, redirect, gather)

### 11.2 koreVoiceAgent.js (3,700 lines)

**Architecture patterns:**

- `SavgCommand` class for Jambonz commands (dial, redirect, transcribe, kill, dtmf)
- `AudiocodesActivity` class for AudioCodes protocol (transfer, hangup, message, config, playUrl)
- Redis Pub/Sub subscribers for async events

**Redis event subscriptions:**

```
recording_controls         → handleRecordingControlEvent()
waiting_message_controls   → handleWaitingMessageEvent()
siprec_controls           → handleSiprecControlEvent()
conference_transcribe     → handleConferenceTranscribeControlEvent()
start_transcribe_event    → sendTranscribeEvent()
```

**Bot language resolution priority:**

```
1. CFContext.botLanguage (flow script node)
2. CFContext.processVariables.botLanguage
3. instanceBotContext._metaInfo.botLanguage
4. childBotContext._metaInfo.botLanguage
5. currentLanguage from current message
6. Default: "en"
```

**Recording check:** `AST:recording:{botId}` — defaults to `true` (fail-safe)

**Response builder supports:**

- Voice-to-text (TTS message)
- Audio file playback (wav → playUrl, other → SSML audio)
- Abort prompts
- Hangup with reason
- SIP transfer
- Config updates (barge-in, DTMF, speech input)
- Voicemail recording (listen with transcription)

---

## 12. Callflow Execution Context

**File:** `CallflowExecutionContext.js` (1,124 lines)

### Agent-Related Fields

```javascript
voiceTransferType; // SIP transfer method (invite/refer/bye)
sipTransferNumber; // Phone number target
sipTransferURI; // SIP URI target
referredBy; // SIP referred-by header
sipTransferId; // Transfer ID
automationAgentTransfer; // Agent transfer config
externalAgentTranscribe; // Recording preferences
externalAgentRecordingControl; // Recording control options
callerId; // Outgoing caller ID
skills; // Agent routing skills
userInfo; // User metadata
priority; // Queue priority
```

### Flow Execution Fields

```javascript
activeSteps; // Currently executing steps
processVariables; // Dynamic variables
data; // Form/trigger data
trigger; // Trigger configuration
invokedBy; // Invocation metadata
activeGotoSteps; // GoTo target queue
conversationType; // livechat | messaging | email
inQueueFlowId; // Waiting experience
waitingExperienceId; // UI experience ID
queue; // Agent queue
customFlowData; // Custom metadata
conversationSessionId; // Call session ID
```

### Serialization

All fields serialized for checkpointing execution state to database. Used for flow recovery after crashes.

---

## 13. Redis Key Patterns — Complete Map

### Session Management

| Key Pattern                                    | TTL                                         | Purpose                 | Set By             |
| ---------------------------------------------- | ------------------------------------------- | ----------------------- | ------------------ |
| `AgentTransfer:{base64(botId,userId,channel)}` | 30min / email-specific / messaging-specific | Main session marker     | agent_transfer.js  |
| `{userId}#{botId}`                             | Channel-specific                            | Kore agent session data | koreAgent/index.js |
| `{conversationId}`                             | Channel-specific                            | Conversation lookup     | koreAgent/index.js |
| `CSAT#{userId}#{botId}`                        | Channel-specific                            | CSAT survey tracking    | koreAgent/index.js |
| `{userId}#CSAT#{botId}`                        | Channel-specific                            | CSAT variant            | koreAgent/index.js |
| `SUBFLOWCSAT#{userId}#{botId}`                 | Channel-specific                            | Subflow CSAT            | koreAgent/index.js |
| `AgentCSAT:{botId}:{userId}:{channel}`         | `agentCSATKeyTTL` (300s)                    | CSAT expiry             | csatUtils.js       |

### Callflow Integration

| Key Pattern                                                | TTL         | Purpose                 | Set By            |
| ---------------------------------------------------------- | ----------- | ----------------------- | ----------------- |
| `CF:AGENT_TRANSFER:{sessionId}:{botId}:{userId}:{channel}` | Session TTL | CF agent transfer state | AgentTransferTask |
| `ATCF:{sessionId}:{botId}:{userId}:{channel}`              | Session TTL | Callflow agent context  | AgentTransferTask |
| `POST_AGENT_DIALOG:{sessionId}:{botId}:{userId}:{channel}` | Session TTL | Post-agent trigger      | AgentTransferTask |
| `CFRequest:PREFIX:{cfId}:{cfProcessId}:{sessionId}`        | Variable    | Callflow request info   | CallflowService   |

### Channel Context

| Key Pattern                                     | TTL                | Purpose                      | Set By         |
| ----------------------------------------------- | ------------------ | ---------------------------- | -------------- |
| `AST:CHANNELCONTEXT:{botId}:{userId}:{channel}` | 86400s (1 day)     | Channel metadata (Kore only) | BaseTask       |
| `AST:ENFORCESINGLE:{token}`                     | Transfer check TTL | Transfer uniqueness          | koreAgent      |
| `AST:CCAIMetaInfo-BotKit-Conversation:{convId}` | Variable           | BotKit metadata              | koreAgent      |
| `AST:recording:{botId}`                         | Variable           | Recording flag               | koreVoiceAgent |

### Genesys-Specific

| Key Pattern                               | TTL      | Purpose                | Set By                   |
| ----------------------------------------- | -------- | ---------------------- | ------------------------ |
| `agent:genesys:{conversationId\|tokenId}` | Default  | Genesys session        | genesysAgent             |
| `genesys[{hostname}_{id}]` (hash)         | None     | Host-specific recovery | GenesysService           |
| `genesys:{tokenId}`                       | Variable | Uploaded file URL      | GenesysWebMessageService |
| `SERVER_GENESYS_{hostname}`               | Variable | Server liveness        | GenesysService           |

### Voice-Specific

| Key Pattern            | TTL              | Purpose             | Set By         |
| ---------------------- | ---------------- | ------------------- | -------------- |
| `kvg:{botId}:{convId}` | `sessionTimeout` | KoreVG session data | koreVoiceAgent |

---

## 14. Configuration Dependencies

### Core Config Keys

```
config.kore_live_agent.koreAgentUrl                    // SmartAssist base URL (port 5080)
config.kore_live_agent.agentDesktopNodeUrl             // Node validation endpoint
config.kore_live_agent.liveAgentUrl                    // Agent transfer endpoint
config.kore_live_agent.agentDesktopEventHandle         // Event push endpoint
config.kore_live_agent.agentSessionTTL                 // Default session TTL
config.kore_live_agent.koreVoiceAgentSessionTTL        // Voice session TTL
config.kore_live_agent.agentSessionTTLForEmail         // Email session TTL
config.kore_live_agent.agentChannelContextTTL          // Channel context TTL (86400)
config.kore_live_agent.agentCSATKeyTTL                 // CSAT survey window (300s)
config.kore_live_agent.KAAInternalServiceTimeout       // SmartAssist call timeout (5000ms)
config.internalAuth.apikey                             // Internal API auth key
```

### Callflow Config

```
config.callflow.agentNodeResolver                      // Node type → SmartAssist API mapping
config.callflow.supportedPostAgentIntegrations         // ["genesys"]
config.callflow.enablePostAgentConversationDialog      // Feature flag (default: false)
config.callflow.CONVERSATION_PRIORITY                  // { MIN: 0, MAX: 10, DEFAULT: 5 }
```

### Feature Flags

```
config.callflow.enablePostAgentConversationDialog      // Post-agent dialog master switch
config.bot_smartassist.shouldValidateSession           // Session validation safety check
config.campaign.isCSATenabledForGenericSmsChannel      // SMS CSAT override
config.kore_live_agent.invokeNewAAService              // Route to new Agent Assist service
```

### Preference Hierarchies (Priority Arrays)

```
config.kore_live_agent.queuePreference                 // Queue source priority
config.kore_live_agent.setUserInfoPreference           // User info source priority
config.kore_live_agent.setBotLanguagePreference        // Language source priority
config.kore_live_agent.setKeyIntentNamePreference      // Intent name source priority
config.kore_live_agent.setNamedAgentsPreference        // Named agents source priority
config.kore_live_agent.setInQueueFlowPreference        // In-queue flow source priority
config.kore_live_agent.setWaitingExperienceIdPreference
config.kore_live_agent.setNoAgentsFlowPreference
config.kore_live_agent.setOutOfHoursFlowPreference
config.kore_live_agent.setAgentMatchingConditionsPreference
```

---

## 15. Implicit Logic & Hidden Behaviors

### 15.1 Skill Accumulation

Skills are NOT just from the Agent Transfer node — they accumulate from ALL prior step results that had `agentTransferConfig.skillIds`. This means nodes earlier in the flow can contribute skills.

### 15.2 automationBotId Backward Scan

The `automationBotId` is found by scanning ALL previous steps backward looking for `automation`, `conversationalivr`, or `uxoautomation` task types. Not from the current step config.

### 15.3 Channel Context Only for Kore Agent

`setChannelContextInRedis()` checks `voiceAgent.name === 'koreAgent'` or `chatAgent.name === 'kore'` — third-party agents never get channel context stored in Redis.

### 15.4 Language Mapping Before Every SmartAssist Call

`config.bot_smartassist.languageMapping` transforms language codes before every call to SmartAssist. This is a global pre-processing step, not per-task.

### 15.5 Voice vs Chat at Transfer Completion

Voice transfers hold the call (`setWaitStatus().onTaskWait()`), while chat transfers end the flow (`setCompleteStatus().onCFComplete()`) — unless post-agent dialog is configured.

### 15.6 Queue Deadlock Prevention

`agentTransferCompleted()` MUST call `onTaskWait()` not `Promise.resolve()` to prevent the queue from getting stuck in `inProgress` state. This is a subtle but critical behavioral requirement.

### 15.7 Dialog executionType vs Message executionType

Different `executionType` values change the entire transfer flow behavior:

- Dialog: Stores `ATCF:` Redis key, skips user message
- Message: Standard flow

### 15.8 handleUserRequest Re-Entry

During voice wait, `handleUserRequest()` re-triggers the entire `performAgentTransfer()` — this is how voice handles user speaking during hold.

### 15.9 CSAT Dialog Selection

Multiple CSAT dialogs may exist — selection filters by `surveyType` (csat vs nps). Falls back to first match if type not found.

### 15.10 Session Closure Skip Conditions

Session closure is NOT triggered if: CSAT requested AND survey required (YES/REQUESTED) AND not drop-off AND not voicemail AND not force close AND not voice/campaign/audiocodes source.

### 15.11 Genesys 3-Second Init Delay

Both WebChat and WebMessaging APIs have hardcoded delays (3s and 2s respectively) before sending initial messages — allows WebSocket stabilization.

### 15.12 Genesys Server Recovery

On server restart, Genesys sessions are recovered by iterating Redis hash entries, detecting dead servers via liveness keys, and reconnecting WebSockets on the new server.

### 15.13 Custom Flow Data Cleanup

`customFlowData` is propagated through transfer BUT `isAgentTransferredTriggered` flag is explicitly deleted to prevent re-triggering.

### 15.14 PII De-tokenization

If payload contains PII tokens matching `config.regex.piiTokenizedPattern`, they are de-tokenized before passing to SmartAssist.

### 15.15 Consult Call Metadata Transformation

When `isConsultCall` is true, all Redis keys are prefixed with `consult_` to preserve consultant info separate from primary session.

---

## 16. Critical Gaps & Anti-Patterns

### 16.1 No Distributed Transactions

Session cleanup in `clearAgentSession()` performs 7+ Redis deletes in a `finally()` block. If any delete fails, session keys orphan with TTL. Should use Redis MULTI/EXEC.

### 16.2 Silent Error Swallowing

Many catch blocks log but resolve (don't propagate):

```javascript
.catch(err => { AppLogger.error(...); return Promise.resolve(); })
```

### 16.3 No Circuit Breaker

No circuit breaker for external agent desktop API calls. If SmartAssist is down, every transfer fails with full timeout.

### 16.4 Hardcoded Delays

Genesys init delays (3s, 2s) are hardcoded, not configurable. Should be config-driven.

### 16.5 No Message Truncation Feedback

Genesys silently truncates messages exceeding `msgMaxLength`. User gets no feedback.

### 16.6 No JWT Refresh (Genesys)

If Genesys WebChat API JWT expires during conversation, messages will fail. No refresh mechanism exists.

### 16.7 Single Attachment Per Message

Genesys handles only `attachments[0]` — if multiple attachments sent, all but first are silently dropped.

### 16.8 Session TTL Without Explicit Expiry Handling

No Redis keyspace notification listener for session TTL expiration (except the `AgentTransfer:*` pattern in koreAgent). Other keys just disappear.

### 16.9 Missing Input Validation

Agent config structures are used without validation. Missing fields (phoneNumber, sipTransferId) silently fail.

---

## 17. Requirements Matrix for ABL

Based on the comprehensive audit, here's what ABL agent-as-flow architecture must replicate:

### Must Have (P0)

| Capability                            | XO Source                                  | ABL Implementation                                 |
| ------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Queue validation (dynamic)            | `invokeAgentDesktopNodes({queueId,botId})` | Tool: `check_queue` → SmartAssist API              |
| Agent availability check (dynamic)    | `invokeAgentDesktopNodes(payload)`         | Tool: `check_agent_availability` → SmartAssist API |
| Business hours check (dynamic)        | `invokeAgentDesktopNodes({id,botId})`      | Tool: `check_business_hours` → SmartAssist API     |
| Kore native agent transfer            | `execute()` in koreAgent/index.js          | Provider: `kore` in adapter layer                  |
| Genesys agent transfer (both APIs)    | genesysAgent/\*                            | Provider: `genesys` in adapter layer               |
| Voice vs Chat divergence              | `setWaitStatus` vs `setCompleteStatus`     | Runtime behavior per channel                       |
| Skill-based routing                   | `agentTransferConfig.skillIds`             | Tool parameter                                     |
| Queue priority (0-10)                 | `setConversationPriorityInContext`         | Tool parameter                                     |
| DTMF menu (voice)                     | IVRMenuTask                                | Tool: `ivr_menu`                                   |
| DTMF digit collection (voice)         | IVRDigitTask                               | Tool: `ivr_digit_input`                            |
| Post-agent dialog (CSAT)              | `handleAsyncSuccessFailureResponse`        | Agent lifecycle event                              |
| Session lifecycle (create/extend/end) | `agent_transfer.js`                        | Redis-backed session store                         |
| Channel context for Kore agent        | `setChannelContextInRedis`                 | Adapter responsibility                             |
| Transfer status handling              | `handleTransferStatus` 4 branches          | Event-driven state machine                         |

### Should Have (P1)

| Capability                              | XO Source                         | ABL Implementation                 |
| --------------------------------------- | --------------------------------- | ---------------------------------- |
| All 15 agent executors                  | AgentExecutor/lib/\*              | Adapter plugins per provider       |
| Proactive Agent Assist                  | koreAgent sendMessage (PAA)       | Optional agent assist integration  |
| Language translation (voice chat)       | Genesys bidirectional translate   | Translation service integration    |
| File upload/download                    | Genesys presigned URL flow        | File proxy service                 |
| Server recovery for WebSocket sessions  | GenesysService.onLoad()           | WebSocket manager with Redis state |
| Voice transfer types (INVITE/REFER/BYE) | customVoiceAgent.js               | SIP abstraction layer              |
| SIP header construction                 | customVoiceAgent.js               | Voice channel config               |
| Recording control                       | koreVoiceAgent.js                 | Recording service integration      |
| Custom flow data propagation            | `customFlowData` through transfer | Agent context metadata             |
| PII de-tokenization                     | `piiTokenizedPattern` regex       | PII service integration            |
| Email channel specifics                 | Extended TTL, CC/BCC, subject     | Email adapter                      |
| SMS/Campaign specifics                  | Campaign direction, CSAT override | Campaign adapter                   |

### Nice to Have (P2)

| Capability                                     | XO Source                       | ABL Implementation            |
| ---------------------------------------------- | ------------------------------- | ----------------------------- |
| Preference hierarchies (queue, language, etc.) | Config-driven priority arrays   | Configurable resolution order |
| Consult call metadata transformation           | `consult_` prefix pattern       | Advanced transfer features    |
| CSAT survey scheduling                         | csatUtils.js + Agenda scheduler | Workflow engine feature       |
| BotKit event forwarding                        | disposition_submitted event     | SDK integration               |
| Multi-message delivery (auto-accept + form)    | `additionalMessages` pattern    | Rich message pipeline         |
| AudioCodes-specific protocol                   | AudiocodesActivity class        | Voice gateway plugin          |
| Session closure containment metrics            | `updateSessionClosureMetrics`   | Analytics pipeline            |

---

_End of Comprehensive Code Audit_
