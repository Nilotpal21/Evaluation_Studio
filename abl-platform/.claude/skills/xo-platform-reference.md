---
name: xo-platform-reference
description: Use when working on ABL features that need XO platform parity, understanding XO architecture, reviewing agent-transfer/callflow/channel implementations, or mapping XO concepts to ABL equivalents.
---

# XO Platform Codebase Reference

The XO platform (`/projects/xo-platform/`) is Kore.ai's legacy bot platform — a monolithic Node.js application. ABL is the ground-up rebuild. This skill documents XO's architecture for parity reference.

## Directory Structure

```
xo-platform/koreserver/
├── bootmodules/AppServer/       # Entry point (index.js → createServer.js)
├── api/
│   ├── rest/                    # 244 REST route files
│   ├── KoreApiRest/             # Kore public APIs
│   ├── services/                # 170+ API services
│   ├── middleware/               # Auth middleware stack
│   └── load_modules.js          # Route registry (160+ endpoints)
├── Templates/
│   ├── BotsServices/
│   │   ├── channels/            # 50 channel adapters (BaseAdapter pattern)
│   │   ├── receivers/           # 39 channel-specific receivers
│   │   ├── ServiceEngine/       # Message routing engine (68 subdirs)
│   │   ├── route_message_kora.js  # Main message router (368KB)
│   │   ├── response_handler.js    # Response processing
│   │   ├── prepare_response.js    # Response formatting (59KB)
│   │   ├── agent_transfer.js      # Agent transfer job handlers
│   │   └── utils.js               # Shared utilities (116KB)
│   ├── Adapters/                # 44 adapters (SmartAssistListener, KoreVGListener, etc.)
│   └── services/                # 63 core service categories
├── callflows/engine/lib/        # Dialog/callflow engine
├── processflows/engine/lib/     # Process flow engine
├── KoreVGServer/                # Voice gateway WebSocket server
├── db/
│   ├── DBManager.js             # Mongoose connection manager
│   └── dbModels/                # 430+ schema definitions
├── config/
│   ├── index.js                 # Convict-based config loader
│   └── configs/                 # 506 config JSON files
├── security/Authenticator.js    # Auth logic
└── utils/constants.js           # Shared constants & job type enums
```

## Architecture Pattern

```
HTTP Request → Middleware (Auth, CORS) → API Routes
    → Service Layer (Templates/services/, api/services/)
    → Channel Adapter (BaseAdapter subclass)
    → Data Layer (MongoDB via Mongoose)
    → Queue Layer (RabbitMQ via KoreQ)
```

**Core patterns:** Service Locator (`getInst()` singletons), Adapter pattern (channels), Observer pattern (RTM events), Queue pattern (KoreQ jobs).

## Message Processing Pipeline

```
Channel Input (Webhook/API/RTM)
    → Receiver (Templates/BotsServices/receivers/*)
    → route_message_kora.js (extract language, get bot, validate user, emit job)
    → Dialog Execution Engine (ChatScript / Callflow)
    → response_handler.js (format, markdown, persist)
    → prepare_response.js (template, widget, rich media)
    → Channel Adapter.sendMessage() (post back to channel)
```

## Channel System

**Base class:** `Templates/BotsServices/channels/BaseAdapter.js` (77KB)

**Required methods:**

- `getMessagePaths()` — message path keys to extract from payload
- `getChannelInfo(payload)` — extract channel metadata (from, to, streamId)
- `normalize(payload, options)` — convert webhook to standardized jobData
- `respond(data)` — send response back to channel (enqueue job)
- `prepare_response(response, request, data)` — format for channel delivery

**Registration:** `channels/load_modules.js` — 50 channels indexed by ID:

- Voice: Twilio, AudioCodes, Genesys, IVR, KoreVG (index 34)
- Messaging: Slack, Teams, Telegram, WhatsApp, Facebook
- Enterprise: RingCentral, Workplace, Zendesk, NaverWorks
- Other: Alexa, Google Actions, Mattermost, Email

## Database Layer

**9 database connections** via Mongoose:

- `masterdb` — primary application data
- `tenantdb` — shared tenant data
- `agentdesktopdb` — agent desktop data
- `iamdb` — identity & access management
- `piidb` — PII-sensitive data
- `rtdb` — real-time data
- `chatscriptdb` — dialog/script data
- `generativeaidb` — LLM/AI service data
- `analyticsdb` — analytics warehouse

**Key models:** AccountModel, BotModel, StreamModel, DialogModel, TaskModel, UserModel, SessionModel, MessageModel

## Job Queue System (KoreQ / RabbitMQ)

```javascript
const botsQ = createKoreQ('bots'); // Bot processing
const flowsQ = createKoreQ('flows'); // Flow execution
const callflowQ = createKoreQ('callflow'); // Callflow jobs
```

**Key job types:** `InitAgentTransfer`, `SmartAssistInitAgentTransfer`, `clearAgentSession`, `update_agent_expire`, `BOT`, `PUBLISH_BOT`, `DIALOG`, `PROCESSFLOW`, `BATCH_TESTING`, `KG_EXPORT`, `ML_UTTERANCE`

**Interface:** `koreQ.emit(routingKey, jobData, cb)` / `koreQ.on(exchanges, listener)`

## Authentication

**Middleware stack** (`api/middleware/`):

| Middleware               | Method           | Header                  |
| ------------------------ | ---------------- | ----------------------- |
| `InternalAuthMiddleware` | API key          | `apikey` or `mpkey`     |
| `JwtAuthMiddleware`      | JWT token        | `Authorization: Bearer` |
| `PublicAuthMiddleware`   | Public API auth  | varies                  |
| `BotSDKAuthMiddleware`   | SDK auth         | SDK token               |
| `ScopeMiddleware`        | Permission/scope | (after auth)            |

**Critical for ABL parity:** XO's internal APIs expect `apikey` header (lowercase), NOT `x-api-key`.

## Redis Usage

- **Session storage:** `bot_session:{userId}:{botId}` — user-bot session caching
- **Pub/sub channels:** `bot_context_update_rtm`, `flow_context_update_rtm`, `KOREVG_OBSERVER`
- **Agent transfer:** `AgentTransfer:{botId}:{userId}:{channel}` — transfer session state
- **KoreVG sessions:** `kvg:{callSid}` — voice session metadata
- **Cache:** `RedisMemCache` — hybrid memory + Redis caching

## Configuration

**Load order (highest precedence first):**

1. Environment variables
2. `KoreConfig.json` (encrypted, AES-256-CTR)
3. `config/configs/*.json` (506 schema files)
4. `MasterKoreConfig.json` (defaults)
5. `appOverrides.json` (app-specific)

**Key config objects:** `config.app`, `config.db`, `config.rabbitmq`, `config.redis`, `config.internalAuth`, `config.bot_korevg`, `config.bot_smartassist`

## Agent Transfer Flow

```
User → Bot → agent_transfer.js:initAgentTransfer()
    → Create Redis session (AgentTransfer:{botId}:{userId}:{channel})
    → Emit SmartAssistInitAgentTransfer job
    → SmartAssist webhook events back
    → Agent Desktop receives/accepts
    → Agent messages routed to user via channel
    → Agent closes → clearAgentSession job
    → Post-agent: triggerDialog | returnToFlow | endConversation
```

**Session TTLs:** chat 1800s, messaging 172800s (48h), email 2592000s (30d)

## XO → ABL Concept Mapping

| XO Concept                 | ABL Equivalent                      |
| -------------------------- | ----------------------------------- |
| `streamId` / `botId`       | `agentId` / `projectId`             |
| `userId`                   | `contactId`                         |
| `accountId` / `orgId`      | `tenantId`                          |
| `BaseAdapter` (channel)    | `ChannelAdapter` interface          |
| `KoreQ` (RabbitMQ)         | BullMQ / direct execution           |
| `Templates/services/`      | `packages/*/src/services/`          |
| `BotsSessionStore` (Redis) | `TransferSessionStore` (Redis)      |
| `route_message_kora.js`    | RuntimeExecutor pipeline            |
| `callflows/engine/`        | `packages/compiler/` (ABL DSL → IR) |
| `ChatScript`               | LLM reasoning engine                |
| `responseOOB` flags        | `OOBFlags` in event-handler.ts      |
| `InternalAuthMiddleware`   | `createUnifiedAuthMiddleware`       |

## Key Anti-Patterns to Avoid (Lessons from XO)

1. **368KB router file** — ABL uses route-per-file pattern instead
2. **77KB base class** — ABL uses composition over inheritance
3. **Global singletons** (`getInst()`) — ABL uses dependency injection
4. **Inline SQL/queries in routes** — ABL separates data access via services
5. **Callback-heavy async** — ABL uses async/await throughout
6. **No TypeScript** — ABL is fully typed
