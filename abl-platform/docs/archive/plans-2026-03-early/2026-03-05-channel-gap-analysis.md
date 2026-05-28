# Channel Implementation Gap Analysis: XO Platform vs ABL Agent Platform

**Date:** 2026-03-05
**Scope:** Every channel in XO Platform compared against ABL Agent Platform — gaps, improvements, and forward plan

---

## 1. Executive Summary

| Metric             | XO Platform                                                                | ABL Agent Platform                                                          |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Total channels** | 46+ (including generic channel handlers)                                   | 13 (focused, production-quality)                                            |
| **Architecture**   | Per-channel Adapter + Listener classes, RabbitMQ job queue, Redis pub/sub  | Manifest-driven registry, BullMQ queues, shared pipeline                    |
| **Code pattern**   | Each channel is a standalone file (200-2000+ lines), inconsistent patterns | `ChannelAdapter` interface, normalized messages, shared pipeline            |
| **Auth patterns**  | Per-channel bespoke verification, no shared abstraction                    | Shared auth per type (HMAC, JWT, token), centralized in manifest            |
| **Rich messages**  | Per-channel template rendering, duplicated logic                           | `transformOutput()` per adapter, actions mapped to platform-native controls |
| **Streaming**      | None (except RTM WebSocket)                                                | Slack, Teams, SDK WebSocket — all with stream buffers                       |
| **File handling**  | Per-channel download logic, scattered                                      | Unified media pipeline: download → multimodal-service → attachmentIds       |
| **Deduplication**  | Minimal (some event_id checks)                                             | 3-layer: BullMQ job ID, Redis SET NX, idempotency keys                      |

**Bottom line:** ABL has 13 channels built to a higher standard. XO has 46+ channels built over years with inconsistent quality. The question is: which XO channels must ABL add, and which are dead weight?

---

## 2. Channel-by-Channel Comparison

### 2.1 Channels Present in BOTH Platforms

| Channel                | XO Implementation                                                                                        | ABL Implementation                                                                                                                    | Verdict                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Web/SDK WebSocket**  | `rtm.js` — WebSocket via RTMServer, JWT session, full rich messages                                      | `sdk-handler.ts` — WebSocket with 2-step auth (API key → JWT), streaming, contact linking, voice support, proactive triggers          | **ABL is significantly better** — streaming, contact model, voice-in-SDK, rate limiting, lazy session creation |
| **Slack**              | `slack.js` — Events API, file download, markdown cleaning, thread support                                | `slack-adapter.ts` — Block Kit, streaming (`chat.startStream`), file download+multimodal, thread support, interactive callbacks       | **ABL is better** — streaming support, Block Kit rich output, better dedup                                     |
| **WhatsApp**           | `whatsapp.js` — Multi-vendor (Meta Cloud, Gupshup, Karix, Infobip, Netcore), interactive messages, media | `whatsapp-adapter.ts` — Meta Cloud API only, interactive buttons/lists, templates, media download+multimodal, verify token hash index | **XO has more vendors; ABL has better architecture**                                                           |
| **Facebook Messenger** | `fb.js` — Graph API, quick replies, postbacks, location, file attachments, typing                        | `messenger-adapter.ts` — Graph API, button templates, quick replies, media download+multimodal, dedup                                 | **Comparable** — ABL has better media pipeline, XO has location support                                        |
| **Microsoft Teams**    | `msTeams.js` — Bot Framework, Adaptive Cards, file download, `@mention` stripping, group chat            | `msteams-adapter.ts` — Bot Framework, Adaptive Cards 1.4, streaming, file download+multimodal, `@mention` stripping                   | **ABL is better** — streaming support, better auth (JWKS rotation)                                             |
| **Email**              | `email.js` — SMTP/Haraka, HTML email, threading, Graph API OAuth2, CC/BCC                                | `email-adapter.ts` — SMTP, nodemailer, RFC 5322 threading, plain text only                                                            | **XO has more features** — HTML email, Graph API, CC/BCC, CSAT forms                                           |
| **SMS**                | `sms.js` — Multi-gateway (Twilio, Cisco, SAP), status callbacks                                          | Not present as dedicated channel                                                                                                      | **Gap: ABL has no SMS channel**                                                                                |
| **Voice (Twilio)**     | `twiliovoice.js` — TwiML, SIP, DTMF, WebRTC, phone management                                            | `voice.ts` + `twilio-media-handler.ts` — Media Streams, Deepgram STT, ElevenLabs TTS, realtime mode                                   | **ABL is significantly better** — realtime voice pipeline, streaming STT/TTS                                   |
| **Voice (KoreVG)**     | `korevg.js` — HTTP+WebSocket, DTMF, TTS streaming, agentic response                                      | `korevg-adapter.ts` + `korevg-router.ts` — WebSocket, verb builder, ASR/TTS config                                                    | **Comparable** — different architectures but similar capability                                                |
| **Voice (AudioCodes)** | `audiocodes.js` — WebSocket server, DTMF/speech, audio conversion                                        | Not present as dedicated channel (AudioCodes protocol support planned in agent-transfer voice bridge)                                 | **Gap: ABL has no AudioCodes channel adapter**                                                                 |
| **Voice (VXML/IVR)**   | `ivrVoice.js` — VXML response generation, ASR metadata, sync HTTP                                        | `vxml-adapter.ts` — VXML 2.1 generation, bargein, retry, session lock                                                                 | **ABL is better** — proper VXML 2.1, distributed session lock, cleaner                                         |
| **Telegram**           | `telegram.js` — Bot API, inline keyboards, callback queries                                              | Not present                                                                                                                           | **Gap: ABL has no Telegram channel**                                                                           |
| **Zendesk**            | `zendesk.js` — Smooch/Sunshine API, switchboard, webhook auto-registration                               | Not present                                                                                                                           | **Gap: ABL has no Zendesk channel**                                                                            |

### 2.2 Channels Present in XO ONLY (Not in ABL)

#### Tier 1 — High Priority (Active Customer Usage)

| Channel                      | XO Files                                         | Complexity                         | Customer Impact                          | Recommendation                                                 |
| ---------------------------- | ------------------------------------------------ | ---------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| **Telegram**                 | `telegram.js`, `TelegramListener.js`             | Low — standard Bot API             | High — popular messaging platform        | **Build in ABL** — straightforward webhook adapter             |
| **SMS (Twilio)**             | `sms.js`, `SMSListener.js`                       | Medium — multi-gateway             | High — critical business channel         | **Build in ABL** — start with Twilio, extensible gateway model |
| **Line**                     | `line.js`, `LineListener.js`                     | Medium — postbacks, media download | High — dominant in Japan/Thailand/Taiwan | **Build in ABL** — important for APAC market                   |
| **Google Business Messages** | `googlebusiness.js`, `GoogleBusinessListener.js` | Medium — OAuth2 service account    | Medium — Google-integrated businesses    | **Build in ABL** — service account auth pattern                |
| **Instagram**                | `InstagramChannel.js` (generic handler)          | Low — reuses FB Graph API          | Medium — growing business channel        | **Build in ABL** — share Messenger adapter internals           |

#### Tier 2 — Medium Priority (Existing Customers, Declining or Niche)

| Channel                  | XO Files                  | Complexity                                     | Notes                                                  | Recommendation                                     |
| ------------------------ | ------------------------- | ---------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| **Zendesk Sunshine**     | `zendesk.js`              | Medium — Smooch API, switchboard               | Customer support integrations                          | **Build in ABL** — switchboard pattern is unique   |
| **Genesys (as channel)** | `genesys.js`              | Medium — OAuth2, bot connector                 | Genesys bot integration (separate from agent transfer) | **Build in ABL** — important for Genesys customers |
| **WeChat**               | `wechat.js`               | Medium — XML payloads, signature verification  | Critical for China market                              | **Build if APAC expansion needed**                 |
| **Cisco Webex (Spark)**  | `spark.js`                | Medium — Webhook + message fetch               | Enterprise collaboration                               | **Build if enterprise demand**                     |
| **Amazon Connect**       | `AmazonConnectChannel.js` | Medium — AWS cert validation, Redis cert cache | AWS contact center integration                         | **Build if AWS customer demand**                   |
| **Nice inContact**       | `NiceChannel.js`          | Medium — IVR-like sync protocol                | Contact center integration                             | **Build if NiceInContact customer demand**         |
| **Naver Works**          | `naverworks.js`           | Medium — OAuth2, group channels                | Korea market                                           | **Build if Korea expansion needed**                |
| **Mattermost**           | `mattermost.js`           | Low — webhook + WebSocket                      | Self-hosted Slack alternative                          | **Build if enterprise demand**                     |

#### Tier 3 — Low Priority (Deprecated, Retired, or Very Niche)

| Channel                   | Status                                           | Recommendation                                           |
| ------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| **Skype**                 | Listed as `retiredChannels` in XO config         | **Do not build** — Microsoft retired Skype               |
| **Skype for Business**    | Largely replaced by Teams                        | **Do not build** — EOL product                           |
| **Skype On-Prem**         | Legacy on-premise only                           | **Do not build**                                         |
| **Twitter**               | Volatile API, X rebranding, API pricing          | **Do not build** unless customer demand                  |
| **Yammer**                | Renamed to Viva Engage, low adoption             | **Do not build**                                         |
| **Jabber**                | Legacy XMPP, declining                           | **Do not build** unless enterprise demand                |
| **RingCentral Glip**      | Niche messaging                                  | **Do not build** unless customer demand                  |
| **RingCentral Engage**    | Niche CX platform                                | **Do not build**                                         |
| **Google Actions**        | Google sunset Conversational Actions (June 2023) | **Do not build** — deprecated by Google                  |
| **Google Hangouts Chat**  | Migrated to Google Chat                          | **Rebrand as Google Chat if building**                   |
| **Alexa**                 | Voice-only, skill platform                       | **Evaluate** — Alexa skill integration might be relevant |
| **Workplace by Facebook** | Meta shutting down Workplace (2025-2026)         | **Do not build** — being sunset                          |
| **Syniverse**             | SMS/WhatsApp via Syniverse SCG                   | **Do not build** — use native WhatsApp + SMS adapters    |
| **LivePerson**            | As a channel (not agent desktop)                 | **Evaluate** — may overlap with agent transfer           |
| **Unblu (as channel)**    | Legacy, minimal adoption                         | **Do not build**                                         |
| **Widget SDK**            | Ephemeral widget, no persistence                 | **Evaluate** — ABL's SDK WebSocket may cover this        |
| **Kore (Collaboration)**  | Internal Kore.ai platform channel                | **Do not build** — ABL has its own internal comms        |
| **SmartAssist**           | Internal channel for SmartAssist integration     | **Not needed** — covered by agent transfer design        |
| **AgentAssist**           | Internal channel for agent assist                | **Evaluate** — may need equivalent in ABL                |
| **Generic SMS**           | Multi-provider SMS abstraction                   | **Fold into SMS adapter** with provider plugins          |
| **Sinch**                 | SMS/messaging via Sinch                          | **Fold into SMS adapter** as a provider                  |

---

## 3. What ABL Does Better Than XO

### 3.1 Architecture

| Aspect                    | XO                                                                                              | ABL                                                                                                  | Why ABL is Better                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Channel registration**  | Each channel has its own Listener + Adapter files, manually wired in routes                     | `CHANNEL_MANIFEST` — single source of truth, auto-registration                                       | One place to add a channel, no forgotten routes                   |
| **Message normalization** | `BaseAdapter` exists but each channel has custom normalization, inconsistent field names        | `NormalizedIncomingMessage` / `NormalizedOutgoingMessage` — strict interface contract                | Every channel produces the same shape, no field-name surprises    |
| **Pipeline**              | RabbitMQ → Worker → per-channel response handling, lots of channel-specific branching in worker | BullMQ → `inbound-worker` → `executeAndPersist()` → adapter `transformOutput()`                      | Shared pipeline, channel-specific logic isolated to adapter       |
| **Session management**    | Redis keys per channel, no unified session model, `userId+streamId` string concatenation        | `ChannelSession` model → `runtimeSessionId` resolution, email thread linking, stale session recovery | Proper identity, no string concatenation keys, automatic recovery |
| **Credential storage**    | Config files, some in DB, inconsistent encryption                                               | `ChannelConnection` model with `encryptedCredentials`, tenant-scoped AES                             | Unified, encrypted, tenant-isolated                               |

### 3.2 Security

| Aspect                   | XO                                                         | ABL                                                                               | Why ABL is Better                                                           |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Webhook verification** | Per-channel, some channels skip verification entirely      | Centralized per auth type, `timingSafeEqual()`, replay protection with timestamps | Consistent security posture, timing-safe comparison prevents timing attacks |
| **Replay protection**    | Some channels (none consistently)                          | 5-minute timestamp validation on HMAC channels                                    | Prevents webhook replay attacks                                             |
| **Rate limiting**        | Some channels have Redis-based rate limiting, inconsistent | IP-based pre-auth + tenant+IP post-auth rate limiting on SDK, BullMQ backpressure | Multi-layer protection                                                      |
| **SSRF protection**      | None on callback URLs                                      | `assertAllowedCallbackUrl()` blocks RFC 1918, loopback, metadata endpoints        | Prevents SSRF via webhook subscriptions                                     |
| **Token storage**        | Mixed — some in config files, some in DB                   | All in `ChannelConnection.encryptedCredentials`, decrypted at use time            | No plaintext tokens in config                                               |
| **Verify token lookup**  | Iterate and decrypt all connections to find match          | SHA-256 hash indexed on `verifyTokenHash` field — O(1) lookup                     | Constant-time verification, no decryption loop                              |

### 3.3 Reliability

| Aspect                   | XO                                                       | ABL                                                                                      |
| ------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Deduplication**        | Minimal — some `event_id` checks per channel             | 3-layer: BullMQ job ID, Redis SET NX in worker, idempotency keys on delivery             |
| **Message ordering**     | `sequenceOrderedChannels` config-driven ordering service | Per-session lock (Redis SET NX) ensures one message processes at a time                  |
| **Retry**                | RabbitMQ DLQ, manual retry logic                         | BullMQ `attempts: 3/5` with exponential backoff, configurable per queue                  |
| **Graceful degradation** | If RabbitMQ dies, messages lost                          | If Redis dies, falls back to in-memory session store                                     |
| **Streaming resilience** | N/A                                                      | Slack/Teams stream buffers with fallback to non-streaming delivery if stream not started |

### 3.4 Features

| Feature                       | XO                                              | ABL                                                                                           |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **LLM streaming to channels** | Not supported — all responses buffered          | Slack (`chat.startStream`), Teams (Bot Framework streaming), SDK WebSocket (`response_chunk`) |
| **Voice in SDK**              | Separate voice channels only                    | SDK WebSocket supports `startVoiceTurn` with realtime STT/TTS (OpenAI Realtime, Gemini Live)  |
| **Media processing**          | Per-channel file download, no unified pipeline  | Unified: download → multimodal-service upload → `attachmentIds` for LLM context               |
| **Contact linking**           | `userId` per channel, no cross-channel identity | `Contact` model with email/phone/externalId, cross-channel identity resolution                |
| **Proactive messaging**       | Limited — per-channel implementation            | `ON_START` trigger on SDK connect, webhook subscription model for HTTP async                  |
| **AG-UI protocol**            | Not supported                                   | `ag-ui-adapter.ts` — SSE event stream for frontend agent UIs                                  |
| **A2A protocol**              | Not supported                                   | `a2a` channel type — agent-to-agent communication                                             |

---

## 4. What XO Does That ABL Doesn't (Yet)

### 4.1 Channel Coverage Gaps

| Gap                              | Impact                                             | Effort to Build                                     | Priority                            |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| **SMS (Twilio + multi-gateway)** | Can't serve SMS-only customers                     | Medium (2-3 days for Twilio, extensible for others) | **P0** — critical business channel  |
| **Telegram**                     | Can't serve Telegram-bot customers                 | Low (1-2 days, standard Bot API)                    | **P0** — high demand, easy to build |
| **Line**                         | Can't serve APAC markets (Japan, Thailand, Taiwan) | Medium (2-3 days)                                   | **P1** — market-dependent           |
| **Instagram**                    | Can't serve Instagram DM automation                | Low (1-2 days, reuses Messenger Graph API)          | **P1** — growing demand             |
| **Google Business Messages**     | Can't serve Google-integrated businesses           | Medium (2 days, OAuth2 service account)             | **P1**                              |
| **AudioCodes voice**             | Can't serve AudioCodes voice gateway customers     | Medium (3-4 days, activity-based protocol)          | **P1** — voice customers            |
| **Zendesk Sunshine**             | Can't serve Zendesk chat customers                 | Medium (3 days, Smooch API + switchboard)           | **P2**                              |
| **Genesys (as channel)**         | Can't serve Genesys bot connector use case         | Medium (3 days, OAuth2 + bot schema)                | **P2**                              |
| **WeChat**                       | Can't serve China market                           | Medium (3 days, XML payloads)                       | **P2** — market-dependent           |
| **Cisco Webex**                  | Can't serve Webex enterprise customers             | Low-Medium (2 days)                                 | **P3**                              |
| **Amazon Connect**               | Can't serve AWS Connect customers                  | Medium (3 days, AWS cert verification)              | **P3**                              |

### 4.2 Feature Gaps Within Existing Channels

| Channel                | XO Feature Missing in ABL                               | Impact                                            | Effort                          |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| **WhatsApp**           | Multi-vendor support (Gupshup, Karix, Infobip, Netcore) | Customers on non-Meta vendors can't migrate       | Medium per vendor (2 days each) |
| **WhatsApp**           | Location sharing ingest                                 | Can't process location messages                   | Low (1 day)                     |
| **WhatsApp**           | Contact card messages                                   | Can't process shared contacts                     | Low (1 day)                     |
| **WhatsApp**           | Reaction messages                                       | Can't process emoji reactions                     | Low (0.5 day)                   |
| **Email**              | HTML email rendering                                    | Responses are plain text only                     | Medium (2 days)                 |
| **Email**              | Microsoft Graph API send                                | Can't use OAuth2 email (only SMTP)                | Medium (2-3 days)               |
| **Email**              | CC/BCC handling                                         | Can't preserve email threading with CC/BCC        | Low (1 day)                     |
| **Email**              | CSAT form in email body                                 | No survey forms in email                          | Low (1 day)                     |
| **Facebook Messenger** | Location sharing ingest                                 | Can't process location messages                   | Low (0.5 day)                   |
| **Facebook Messenger** | Carousel templates                                      | Can't send multi-card carousels                   | Medium (1-2 days)               |
| **Slack**              | Slash command handling                                  | Can't register custom `/commands`                 | Low (1 day)                     |
| **SDK WebSocket**      | Full rich-message template library                      | Limited to markdown + actions, no carousels/forms | Medium (3-4 days)               |

### 4.3 Cross-Cutting Gaps

| Gap                              | XO Has                                                                           | ABL Doesn't Have                                                 | Impact                                                            |
| -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Proactive notifications**      | Per-channel push (WhatsApp templates, FB one-time notification, Teams proactive) | Only HTTP async webhook subscription                             | Can't send unsolicited messages on messaging platforms            |
| **Typing indicators (outbound)** | `sender_action: typing_on` for FB, `chat.meMessage` for Slack                    | Not implemented in adapters                                      | Users don't see "bot is typing"                                   |
| **Generic channel framework**    | `GenericListener.js` + `ChannelHandlers/` — add new channels with minimal code   | `CHANNEL_MANIFEST` is extensible but requires adapter code       | XO's generic handler is more plug-and-play for simple channels    |
| **Channel analytics**            | Per-channel message counts, latency tracking, delivery status                    | `TraceEvent` system but no channel-specific analytics            | No channel performance dashboards                                 |
| **Multi-language welcome**       | Per-channel welcome event detection and language routing                         | `ON_START` trigger exists but no language detection from channel | Can't auto-detect user language from platform locale              |
| **Sequence ordering**            | `sequenceOrderedChannels` for platforms that deliver out of order                | Per-session lock (simpler)                                       | May miss edge cases where multiple messages arrive simultaneously |

---

## 5. What's Improved in ABL and Should Stay

These ABL improvements should NOT be reverted to XO patterns when adding new channels:

### 5.1 Keep: Manifest-Driven Channel Registration

```typescript
// ABL: CHANNEL_MANIFEST — single source of truth
export const CHANNEL_MANIFEST: Record<ChannelType, ChannelManifestEntry> = {
  slack: {
    ingress: 'webhook',
    delivery: 'async_queue',
    authMode: 'hmac',
    streamingSupport: true,
    isConnectionEligible: true,
    // ...
  },
  // Adding a new channel = one manifest entry + one adapter file
};
```

XO's approach of separate Listener + Adapter + Config + Route files per channel is fragile. ABL's manifest is the correct pattern — keep it.

### 5.2 Keep: Unified Media Pipeline

```
XO: Each channel downloads files differently, stores them differently
ABL: download → multimodal-service → attachmentIds → LLM context
```

Every new channel adapter should use `downloadAndProcess()` from the shared media pipeline. No per-channel file handling.

### 5.3 Keep: 3-Layer Deduplication

XO has sporadic dedup. ABL's 3-layer approach (BullMQ job ID, Redis SET NX, idempotency keys) should be the standard for all channels.

### 5.4 Keep: Streaming First

ABL's streaming support (Slack, Teams, SDK) should be the default for all new channels that support it. XO never had streaming — this is a competitive advantage.

### 5.5 Keep: Contact Model Integration

ABL's `Contact` model with cross-channel identity resolution is far superior to XO's per-channel `userId`. Every new channel should integrate with `sdk-handler-contact-linking.ts` pattern.

### 5.6 Keep: Encrypted Credential Storage

ABL's `ChannelConnection.encryptedCredentials` with tenant-scoped AES is the correct pattern. No plaintext tokens in config files (XO stores many tokens in config JSON).

---

## 6. Forward Plan — What Should Be Done

### Phase 1: Critical Channel Gaps (Weeks 1-3)

| #   | Channel              | Effort   | Adapter Pattern                                                             | Notes                                                                        |
| --- | -------------------- | -------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | **SMS (Twilio)**     | 3 days   | Webhook adapter, Twilio message API delivery                                | Start with Twilio provider. Gateway plugin architecture for future providers |
| 2   | **Telegram**         | 2 days   | Webhook adapter (auto-register via `setWebhook`), Bot API delivery          | Inline keyboards as actions, callback query handling                         |
| 3   | **Instagram**        | 1.5 days | Share Messenger adapter internals (same Graph API), separate manifest entry | `is_echo` filtering, page-scoped user identity                               |
| 4   | **AudioCodes voice** | 3 days   | WebSocket adapter (activity-based protocol)                                 | Reuse voice pipeline, DTMF/speech handling                                   |

**Deliverables:**

- 4 new adapter files in `apps/runtime/src/channels/adapters/`
- 4 new manifest entries
- 4 new route registrations
- Unit tests per adapter (auth verification, message normalization, output transform)
- Integration tests (full message flow with mocked external APIs)

### Phase 2: Market Expansion Channels (Weeks 4-6)

| #   | Channel                      | Effort | Notes                                                        |
| --- | ---------------------------- | ------ | ------------------------------------------------------------ |
| 5   | **Line**                     | 3 days | Postback data, media download via content API, APAC market   |
| 6   | **Google Business Messages** | 2 days | OAuth2 service account, suggestion responses                 |
| 7   | **Zendesk Sunshine**         | 3 days | Smooch v2 API, switchboard control for bot/agent handoff     |
| 8   | **Genesys (as bot channel)** | 3 days | OAuth2, bot connector schema publishing, structured messages |

### Phase 3: Feature Enrichment for Existing Channels (Weeks 7-9)

| #   | Feature                        | Channel(s)          | Effort        | Notes                                                                                  |
| --- | ------------------------------ | ------------------- | ------------- | -------------------------------------------------------------------------------------- |
| 9   | **WhatsApp multi-vendor**      | WhatsApp            | 2 days/vendor | Gupshup first (most common), then Infobip, Netcore. Each as a delivery provider plugin |
| 10  | **Email HTML rendering**       | Email               | 2 days        | HTML template engine for outbound, Graph API send option                               |
| 11  | **Email CC/BCC + Graph API**   | Email               | 2 days        | Microsoft Graph API OAuth2 for send, CC/BCC preservation                               |
| 12  | **Location message ingest**    | WhatsApp, Messenger | 1 day         | Add `location` to `NormalizedIncomingMessage`, pass as context                         |
| 13  | **Carousel/rich templates**    | Messenger, SDK      | 3 days        | Carousel output type in `transformOutput()`, SDK rich message types                    |
| 14  | **Outbound typing indicators** | All applicable      | 1 day         | Add `sendTypingIndicator()` to `ChannelAdapter` interface                              |
| 15  | **Slash commands**             | Slack               | 1 day         | Route registration for `/command` endpoint, message normalization                      |

### Phase 4: Cross-Cutting Improvements (Weeks 10-12)

| #   | Feature                             | Effort | Notes                                                                                                                                                                                 |
| --- | ----------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | **Proactive messaging framework**   | 5 days | Unified `sendProactiveMessage(contactId, channelType, message)` API. Per-channel rules (WhatsApp: templates only, Messenger: 24hr window). Store outreach windows in `ChannelSession` |
| 17  | **Channel analytics pipeline**      | 3 days | Per-channel `TraceEvent` types: `channel_message_received`, `channel_delivery_success/failure`, `channel_latency`. Aggregate in ClickHouse                                            |
| 18  | **Generic channel SDK**             | 4 days | Like XO's `GenericListener` but ABL-native: define a channel via JSON config (auth mode, message path, reply URL template), no adapter code needed for simple channels                |
| 19  | **Multi-language detection**        | 2 days | Extract locale from channel payload (WhatsApp: profile language, Teams: locale claim, Slack: user.locale). Set as session context for LLM                                             |
| 20  | **SMS gateway plugin architecture** | 2 days | `SMSProvider` interface with Twilio, Sinch, Vonage implementations. Same adapter, switchable provider                                                                                 |

### Phase 5: Evaluate and Decide (Ongoing)

These channels need customer-demand evaluation before building:

| Channel            | Build Trigger                           |
| ------------------ | --------------------------------------- |
| **WeChat**         | China market expansion confirmed        |
| **Cisco Webex**    | Enterprise customer request (3+)        |
| **Amazon Connect** | AWS customer request (3+)               |
| **Nice inContact** | Contact center customer request         |
| **Naver Works**    | Korea market expansion                  |
| **Mattermost**     | Enterprise self-hosted customer request |
| **Alexa**          | Voice skill use case validated          |

---

## 7. Channel Addition Checklist

When building any new channel adapter for ABL, follow this checklist:

### Files to Create/Modify

- [ ] `apps/runtime/src/channels/adapters/{channel}-adapter.ts` — implements `ChannelAdapter`
- [ ] `apps/runtime/src/channels/manifest.ts` — add entry to `CHANNEL_MANIFEST`
- [ ] `apps/runtime/src/routes/channel-{channel}.ts` — webhook route (if webhook ingress)
- [ ] `apps/runtime/src/routes/index.ts` — register route
- [ ] `apps/runtime/src/__tests__/{channel}-adapter.test.ts` — unit tests
- [ ] `packages/database/src/models/channel-connection.model.ts` — add channel type to enum (if not already)

### Adapter Implementation Requirements

- [ ] `verifyRequest(req)` — HMAC, JWT, or token verification (never skip)
- [ ] `buildNormalizedMessage(req)` — produce `NormalizedIncomingMessage` with all fields
- [ ] `transformOutput(text, actions)` — map to platform-native format (buttons, lists, cards)
- [ ] `sendResponse(connection, output)` — deliver to platform API
- [ ] `shouldProcess(req)` — filter bot echoes, stale events, non-message events
- [ ] `extractEventId(req)` — for deduplication
- [ ] `extractExternalSessionKey(req)` — for session continuity
- [ ] `resolveIdentifier(req)` — for connection lookup

### Tests Required

- [ ] Auth verification (valid signature → pass, invalid → reject, replay → reject)
- [ ] Message normalization (text, media, interactive callbacks, postbacks)
- [ ] Output transformation (plain text, buttons, selects, rich content)
- [ ] Deduplication (same event_id → skip)
- [ ] Error handling (platform API down, auth expired, rate limited)
- [ ] Full flow integration test (webhook → normalize → execute → transform → deliver)

### Security Requirements

- [ ] Timing-safe comparison for HMAC/token verification
- [ ] Replay protection (timestamp within 5 minutes)
- [ ] SSRF protection on any callback URL configuration
- [ ] No plaintext credentials in logs
- [ ] Tenant isolation — channel connection scoped to tenant

---

## 8. Summary: XO → ABL Channel Migration Priority Matrix

```
                    High Customer Impact
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         │   P0: BUILD     │   P1: BUILD     │
         │   IMMEDIATELY   │   NEXT          │
         │                 │                 │
         │  • SMS (Twilio) │  • Line         │
         │  • Telegram     │  • Instagram    │
         │                 │  • AudioCodes   │
         │                 │  • Google Biz   │
    Low  ─┼─────────────────┼─────────────────┼─ High
   Effort │                 │                 │  Effort
         │   P2: BUILD     │   P3: EVALUATE  │
         │   WHEN NEEDED   │   ON DEMAND     │
         │                 │                 │
         │  • Zendesk      │  • WeChat       │
         │  • Genesys      │  • Webex        │
         │  • Email HTML   │  • Amazon Conn  │
         │  • WA vendors   │  • Nice         │
         │                 │  • Alexa        │
         └─────────────────┼─────────────────┘
                           │
                    Low Customer Impact
```

**Do NOT build:** Skype, Skype for Business, Twitter, Yammer, Google Actions, Workplace FB, Jabber, RingCentral (Glip/Engage), Syniverse, Kore Collaboration, SmartAssist/AgentAssist channels — all deprecated, sunset, or superseded.

---

_End of Gap Analysis_

---

## Implementation Plan

_Merged from `2026-03-05-channel-gaps-implementation-plan.md`._

## 1. Feature Inventory — What We're Building

### 1.1 New Channels (9)

| #   | Channel                      | Priority | Effort   | XO Source Reference                                           |
| --- | ---------------------------- | -------- | -------- | ------------------------------------------------------------- |
| 1   | **SMS (Twilio)**             | P0       | 3 days   | `sms.js`, `SMSListener.js`                                    |
| 2   | **Telegram**                 | P0       | 2 days   | `telegram.js`, `TelegramListener.js`                          |
| 3   | **Instagram**                | P1       | 1.5 days | `InstagramChannel.js` (generic handler)                       |
| 4   | **AudioCodes voice**         | P1       | 3 days   | `audiocodes.js`, `AudioCodesListener.js`, `AudioCodesServer/` |
| 5   | **Line**                     | P1       | 3 days   | `line.js`, `LineListener.js`                                  |
| 6   | **Google Business Messages** | P1       | 2 days   | `googlebusiness.js`, `GoogleBusinessListener.js`              |
| 7   | **Zendesk Sunshine**         | P2       | 3 days   | `zendesk.js`, `ZendeskListener.js`                            |
| 8   | **Genesys (as bot channel)** | P2       | 3 days   | `genesys.js`, `GenesysListener.js`                            |
| 9   | **WeChat**                   | P2       | 3 days   | `wechat.js`, `WeChatListener.js`                              |

### 1.2 WhatsApp Multi-Vendor (5 vendors)

| #   | Vendor                        | Priority | Effort   | XO Source Reference                                |
| --- | ----------------------------- | -------- | -------- | -------------------------------------------------- |
| 10  | **Meta Cloud API** (existing) | Done     | —        | Already in ABL                                     |
| 11  | **Gupshup**                   | P0       | 2.5 days | `Whatsapp_GupsupListener.js`, `normalizeGupshup()` |
| 12  | **Infobip**                   | P0       | 2 days   | `WhatsappListener.js`, `normalizeInfobip()`        |
| 13  | **Karix**                     | P1       | 2 days   | `WhatsappKarixListener.js`, `normalizeKarix()`     |
| 14  | **Netcore**                   | P1       | 2 days   | `WhatsappNetcoreListener.js`, `normalizeNetcore()` |

### 1.3 Email Enhancements (4 features)

| #   | Feature                             | Priority | Effort   | XO Source Reference                                  |
| --- | ----------------------------------- | -------- | -------- | ---------------------------------------------------- |
| 15  | **HTML email rendering (outbound)** | P0       | 2 days   | `email.js` respond(), `htmlVersion` field            |
| 16  | **Microsoft Graph API send**        | P0       | 2.5 days | `customEmail.js`, `SendMailUtil.js`, Graph OAuth2    |
| 17  | **CC/BCC handling**                 | P0       | 1 day    | `email.js` lines 666-721                             |
| 18  | **Email header/footer templates**   | P1       | 1 day    | `enableTD` config, `channel.header`/`channel.footer` |

### 1.4 Cross-Cutting Features (4 features)

| #   | Feature                           | Priority | Effort | Scope                   |
| --- | --------------------------------- | -------- | ------ | ----------------------- |
| 19  | **Outbound typing indicators**    | P0       | 2 days | All applicable channels |
| 20  | **Proactive messaging framework** | P0       | 5 days | All channels            |
| 21  | **Channel analytics pipeline**    | P1       | 3 days | All channels            |
| 22  | **Location message ingest**       | P1       | 1 day  | WhatsApp, Messenger     |
| 23  | **Carousel/rich templates**       | P1       | 3 days | Messenger, SDK          |
| 24  | **Slack slash commands**          | P2       | 1 day  | Slack                   |

**Total: 24 work items across 4 categories**

---

## 2. WhatsApp Multi-Vendor Architecture

### 2.1 Design: Vendor-Pluggable Adapter

ABL currently has a single `WhatsAppAdapter` that speaks Meta Cloud API only. XO's approach is a monolithic `whatsapp.js` with vendor-specific `normalize*()` functions — 5 different payload shapes crammed into one file.

**ABL approach: vendor provider interface.** The `WhatsAppAdapter` becomes a coordinator that delegates vendor-specific concerns to a `WhatsAppVendorProvider`.

```typescript
// apps/runtime/src/channels/adapters/whatsapp/vendor-interface.ts

export interface WhatsAppVendorProvider {
  readonly vendorName: string;

  // Inbound: webhook → normalized message
  extractExternalIdentifier(body: unknown): string | null;
  extractEventId(body: unknown): string | null;
  shouldProcess(body: unknown): boolean;
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage;

  // Inbound: webhook verification
  verifyRequest(
    headers: Record<string, string>,
    body: unknown,
    rawBody?: Buffer | string,
    connection?: ResolvedConnection | null,
  ): Promise<boolean>;
  handleWebhookVerification?(
    query: Record<string, string>,
    connection?: ResolvedConnection | null,
  ): string | null;

  // Inbound: media
  extractMediaReferences(body: unknown): WhatsAppMediaReference[];
  downloadMedia(
    ref: WhatsAppMediaReference,
    credentials: ChannelCredentials,
  ): Promise<WhatsAppMediaDownloadResult>;

  // Outbound: send response
  sendMessage(
    to: string,
    output: ChannelOutput,
    credentials: ChannelCredentials,
    config: Record<string, unknown>,
  ): Promise<SendResult>;

  // Outbound: typing indicator
  sendTypingIndicator?(to: string, credentials: ChannelCredentials): Promise<void>;
}
```

**Vendor provider implementations:**

```
apps/runtime/src/channels/adapters/whatsapp/
├── vendor-interface.ts         # Interface above
├── vendor-registry.ts          # Map<vendorName, WhatsAppVendorProvider>
├── vendors/
│   ├── meta-cloud.ts           # Existing logic, extracted from whatsapp-adapter.ts
│   ├── gupshup.ts
│   ├── infobip.ts
│   ├── karix.ts
│   └── netcore.ts
├── whatsapp-adapter.ts         # Coordinator — delegates to vendor provider
├── whatsapp-media-downloader.ts  # Existing (Meta-specific) + vendor dispatch
├── whatsapp-media-processor.ts   # Existing (unchanged — vendor-agnostic)
└── voice-transcription.ts        # AssemblyAI integration for voice messages
```

**Vendor selection:** The vendor is stored on the `ChannelConnection.config.vendor` field. When a webhook arrives, the adapter resolves the connection first (by `externalIdentifier`), then looks up the vendor provider from the config.

**Webhook URL pattern:** Each vendor gets its own webhook path (matching XO's pattern where each vendor has a separate listener):

```
POST /api/v1/channels/whatsapp/webhook                          # Meta Cloud API (existing)
POST /api/v1/channels/whatsapp/webhook/:identifier              # Meta Cloud API with identifier
POST /api/v1/channels/whatsapp-gupshup/webhook/:identifier      # Gupshup
POST /api/v1/channels/whatsapp-infobip/webhook/:identifier      # Infobip
POST /api/v1/channels/whatsapp-karix/webhook/:identifier        # Karix
POST /api/v1/channels/whatsapp-netcore/webhook/:identifier      # Netcore
```

**Alternative (simpler):** Single URL with vendor resolved from connection config post-lookup. But this requires the `externalIdentifier` extraction to be vendor-aware before the vendor is known. Since each vendor has a completely different payload shape, separate URL prefixes are cleaner.

**Decision: Separate webhook URL paths per vendor** (same as XO), but all sharing the same `WhatsAppAdapter` coordinator and the same `ChannelType = 'whatsapp'`.

### 2.2 Vendor Implementations

#### Meta Cloud API (`meta-cloud.ts`) — Extract from Existing

Extract the current `WhatsAppAdapter` logic into a `MetaCloudProvider` class. No behavior change — just code organization.

**Payload shape:**

```
entry[0].changes[0].value.messages[0].text.body
entry[0].changes[0].value.metadata.phone_number_id  → externalIdentifier
entry[0].changes[0].value.messages[0].from           → user phone
```

**Auth:** HMAC-SHA256 on `x-hub-signature-256` using `app_secret`
**Media:** Two-step: GET metadata → GET binary (Bearer token)
**Sending:** POST `graph.facebook.com/{version}/{phone_number_id}/messages`

#### Gupshup (`gupshup.ts`)

**Payload shape (from XO audit):**

```
body.text              → message text
body.mobile            → from phone
body.phone             → to phone
body.type              → message type (text, image, video, document, audio, voice, location, interactive, button, contacts)
```

**Auth:** JWT token verification (XO: `botInfo.isSecure` flag)
**Media:** Direct URL from payload (`body[body.type].url` + `body[body.type].signature`)
**Voice:** Download audio → AssemblyAI transcription → text
**Sending:** Gupshup API (`https://api.gupshup.io/sm/api/v1/msg`)
**Unique:** Contact card messages, payment status templates, `reference_id` delimiter

**Tests:**
| Test | Validates |
|------|----------|
| `normalizes text message` | `body.text` → `NormalizedIncomingMessage.text` |
| `normalizes interactive list_reply` | `body.interactive.list_reply.id` → `ActionEvent` |
| `normalizes voice with transcription` | Audio download → AssemblyAI → text result |
| `extracts media references` | image/video/document → `WhatsAppMediaReference[]` |
| `sends message via Gupshup API` | POST to correct endpoint with correct payload |
| `verifies JWT token` | Valid JWT → pass, invalid → reject |

#### Infobip (`infobip.ts`)

**Payload shape (from XO audit):**

```
body.results[0].message.text     → message text
body.results[0].from             → from phone
body.results[0].to               → to phone
body.results[0].message.type     → LOCATION, IMAGE, DOCUMENT, etc. (UPPERCASE)
```

**Auth:** Basic auth for media downloads (username:password, supports encrypted password)
**Media:** Direct URL with Basic auth header
**Sending:** Infobip API (`https://{baseUrl}/whatsapp/1/message/text`)
**Unique:** Uppercase type names, `filterKey/filterValue` for result array filtering, `pushMsgToRedis` for payment/contact types

**Tests:**
| Test | Validates |
|------|----------|
| `normalizes text message` | `results[0].message.text` → message |
| `normalizes LOCATION (uppercase)` | `{latitude, longitude, address}` parsing |
| `downloads media with Basic auth` | Username:password base64 encoding |
| `handles encrypted password` | Decryption → Basic auth |
| `filters results array` | `filterKey/filterValue` selects correct result |

#### Karix (`karix.ts`)

**Payload shape (from XO audit):**

```
body.eventContent.message.text.body   → message text
body.eventContent.message.from        → from phone
body.eventContent.message.to          → to phone
body.eventContent.message.contentType → text, location, interactive, etc.
body.eventContent.message.attachmentType → image, video, document, audio
```

**Auth:** Bearer token (`accountKey`) for media downloads
**Media:** `fileLink` URL with Bearer auth
**Voice:** Download → AssemblyAI transcription
**Sending:** Karix API

**Tests:**
| Test | Validates |
|------|----------|
| `normalizes text from contentType field` | `eventContent.message.text.body` → message |
| `handles attachmentType for media` | `attachmentType: 'image'` → media reference |
| `transcribes voice via AssemblyAI` | Audio download → transcription → text |

#### Netcore (`netcore.ts`)

**Payload shape (from XO audit):**

```
body.incoming_message[0].text_type.text                    → message text
body.incoming_message[0].from                              → from phone
body.incoming_message[0].to                                → to phone
body.incoming_message[0].message_type                      → TEXT, IMAGE, AUDIO, etc. (UPPERCASE)
body.incoming_message[0].interactive_type.button_reply.id  → interactive callback
body.incoming_message[0].interactive_type.list_reply.id    → list callback
```

**Auth:** Bearer token (`apiKey`) for media downloads
**Media:** `mediaAPIUrl/{id}` with Bearer auth
**Voice:** Download → AssemblyAI transcription (reuses gupshup config keys per XO)
**Sending:** Netcore API

### 2.3 Voice Transcription Service

Three XO vendors (Gupshup, Karix, Netcore) support voice messages that need transcription. XO uses AssemblyAI with a poll loop. ABL should abstract this.

```typescript
// apps/runtime/src/channels/adapters/whatsapp/voice-transcription.ts

export interface TranscriptionProvider {
  transcribe(audioStream: Readable, mimeType: string): Promise<string>;
}

export class AssemblyAITranscriptionProvider implements TranscriptionProvider {
  constructor(private apiKey: string) {}

  async transcribe(audioStream: Readable, mimeType: string): Promise<string> {
    // 1. Upload audio to AssemblyAI /upload endpoint
    // 2. Submit transcription job to /transcript
    // 3. Poll /transcript/:id (5s interval, max 30 attempts — XO uses 5 attempts)
    // 4. Return .text
    // Uses circuit breaker (AssemblyAI can be slow/down)
  }
}
```

**Config addition to `ChannelConnection.config`:**

```typescript
{
  vendor: 'gupshup',
  transcription?: {
    provider: 'assemblyai',
    apiKey: string,            // encrypted in connection config
  }
}
```

### 2.4 Manifest & Registry Changes

Add vendor-specific webhook paths to `CHANNEL_MANIFEST`:

```typescript
// manifest.ts additions
whatsapp_gupshup: {
  displayName: 'WhatsApp (Gupshup)',
  ingress: 'webhook',
  delivery: 'async_queue',
  authMode: 'jwt',          // Gupshup uses JWT
  responseFormat: 'interactive',
  webhookPathPattern: '/api/v1/channels/whatsapp-gupshup/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['api_key', 'app_name'],
  // Maps to channelType: 'whatsapp' internally (shared session, output transform)
  canonicalChannelType: 'whatsapp',
},
// ... similar for infobip, karix, netcore
```

**`ChannelType` union addition:**

```typescript
export type ChannelType =
  | ... existing ...
  | 'whatsapp_gupshup' | 'whatsapp_infobip' | 'whatsapp_karix' | 'whatsapp_netcore';
```

**Alternative: keep `channelType: 'whatsapp'` for all vendors** and differentiate by `config.vendor`. This avoids type explosion but makes webhook routing harder.

**Decision: Add vendor-specific channel types with `canonicalChannelType` mapping.** Webhook routes use the specific type for routing. Internally, session resolution and output transformation use `canonicalChannelType: 'whatsapp'` for shared behavior.

### 2.5 WhatsApp Tests

| Test                                     | Scope       | Validates                                                |
| ---------------------------------------- | ----------- | -------------------------------------------------------- |
| `meta cloud: existing tests pass`        | Regression  | Extraction into MetaCloudProvider doesn't break existing |
| `vendor registry loads all 5 vendors`    | Boot        | `getVendorProvider('meta_cloud')` returns provider       |
| `gupshup: full inbound flow`             | Integration | Webhook → normalize → execute → send                     |
| `infobip: Basic auth media download`     | Unit        | Correct Authorization header                             |
| `karix: voice transcription`             | Integration | Audio → AssemblyAI → text                                |
| `netcore: interactive callback`          | Unit        | `button_reply.id` → `ActionEvent`                        |
| `vendor mismatch returns 404`            | Error       | Wrong vendor webhook → no connection found               |
| `shared output transform across vendors` | Unit        | Same `transformOutput()` for all vendors                 |

---

## 3. Email Enhancements

### 3.1 HTML Email Rendering (Outbound)

ABL's `EmailAdapter.transformOutput()` currently returns `{ kind: 'text', text }` — plain text only. XO sends HTML emails with the `htmlVersion` field, header/footer templates, and CC/BCC.

**New `ChannelOutput` variant:**

```typescript
// Add to types.ts ChannelOutput union
| { kind: 'email'; subject: string; text: string; html?: string; cc?: string[]; bcc?: string[];
    inReplyTo?: string; references?: string[]; attachments?: EmailAttachment[] }
```

**`EmailAdapter.transformOutput()` enhancement:**

```typescript
transformOutput(text: string, actions?: ActionSetIR, richContent?: RichContentIR): ChannelOutput {
  // If richContent.email is present, use it for HTML rendering
  const html = richContent?.email?.html
    ?? this.markdownToHtml(text);  // Default: convert markdown to HTML

  return {
    kind: 'email',
    subject: '',  // Populated from session metadata in sendResponse
    text,
    html,
  };
}
```

**Markdown-to-HTML conversion:** Use `marked` (already in many Node ecosystems) or a lightweight converter. XO uses raw HTML passthrough (`htmlVersion` field) — ABL should support both:

1. Agent response is markdown → convert to HTML for email
2. Agent returns `richContent.email.html` → use as-is

**Email output configuration (per connection):**

```typescript
// ChannelConnection.config for email
{
  outbound: {
    format: 'html' | 'text',           // default: 'html'
    header?: string,                    // HTML header template (XO's enableTD)
    footer?: string,                    // HTML footer template
    loopPreventionHeader?: string,      // e.g., 'X-Kore-Source: abl-platform'
  }
}
```

### 3.2 Microsoft Graph API Send

XO supports sending email via Microsoft Graph API (OAuth2 client credentials) in addition to SMTP. ABL currently only has SMTP via `nodemailer`.

**Design: pluggable email transport**

```typescript
// apps/runtime/src/channels/adapters/email/transport-interface.ts

export interface EmailTransport {
  sendReply(params: EmailSendParams): Promise<{ messageId: string }>;
}

export interface EmailSendParams {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | Readable;
  contentType: string;
}
```

**Two implementations:**

```typescript
// email/smtp-transport.ts
export class SmtpTransport implements EmailTransport {
  // Uses nodemailer (existing pattern from createEmailSenderFromEnv)
  constructor(config: SmtpConfig) {}
  async sendReply(params: EmailSendParams): Promise<{ messageId: string }> { ... }
}

// email/graph-transport.ts
export class MicrosoftGraphTransport implements EmailTransport {
  // OAuth2 client credentials → Graph API sendMail
  constructor(config: GraphConfig) {}

  private async getAccessToken(): Promise<string> {
    // POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
    // scope: https://graph.microsoft.com/.default
    // grant_type: client_credentials
    // Token cached with TTL (typically 3600s)
  }

  async sendReply(params: EmailSendParams): Promise<{ messageId: string }> {
    const token = await this.getAccessToken();
    // POST https://graph.microsoft.com/v1.0/users/{from}/sendMail
    // Authorization: Bearer {token}
    // Body: { message: { subject, body: { contentType: 'HTML', content }, toRecipients, ccRecipients, ... } }
  }
}
```

**Transport selection:** From `ChannelConnection.config.outbound.transport`:

```typescript
{
  outbound: {
    transport: 'smtp' | 'graph',    // default: 'smtp'
    smtp?: {
      host: string, port: number, secure: boolean,
      auth?: { user: string, pass: string },
    },
    graph?: {
      tenantId: string,
      clientId: string,
      clientSecret: string,         // encrypted in credentials
      senderAddress: string,        // mailbox to send from
    },
  }
}
```

### 3.3 CC/BCC Handling

**Inbound:** Already partially supported — ABL's email adapter reads `from` from the inbound email. Add CC/BCC extraction:

```typescript
// In email inbound processing (SMTP server or session-resolver)
buildNormalizedMessage(emailPayload) {
  return {
    text: emailPayload.text,
    externalSessionKey: ...,
    externalMessageId: emailPayload.messageId,
    metadata: {
      from: emailPayload.from[0].address,
      to: emailPayload.to.map(r => r.address),
      cc: emailPayload.cc?.map(r => r.address) ?? [],
      bcc: emailPayload.bcc?.map(r => r.address) ?? [],
      subject: emailPayload.subject,
      inReplyTo: emailPayload.headers['in-reply-to'],
      references: emailPayload.headers['references'],
      messageId: emailPayload.headers['message-id'],
      htmlBody: emailPayload.html,     // Preserve HTML inbound for context
    },
  };
}
```

**Outbound:** `sendResponse()` reads CC/BCC from session metadata (carried through from inbound) or from agent tool output:

```typescript
async sendResponse(message, connection) {
  const metadata = message.metadata;
  const transport = this.getTransport(connection);

  await transport.sendReply({
    to: metadata.from,            // Reply to sender
    from: connection.config.outbound.senderAddress,
    subject: `Re: ${metadata.subject}`,
    text: message.text,
    html: this.renderHtml(message, connection),
    cc: metadata.cc,              // Preserve CC list
    bcc: metadata.bcc,            // Preserve BCC list
    inReplyTo: metadata.messageId,
    references: [...(metadata.references ?? []), metadata.messageId],
  });
}
```

### 3.4 Email Tests

| Test                                      | Validates                                            |
| ----------------------------------------- | ---------------------------------------------------- |
| `HTML email rendered from markdown`       | markdown → HTML conversion                           |
| `richContent.email.html used as-is`       | Passthrough HTML                                     |
| `header/footer templates injected`        | Config templates wrap HTML body                      |
| `Graph API transport: token acquisition`  | OAuth2 client credentials → access token             |
| `Graph API transport: send with CC/BCC`   | Graph sendMail payload structure                     |
| `SMTP transport: CC/BCC preserved`        | nodemailer options include cc, bcc arrays            |
| `inbound CC/BCC extracted to metadata`    | Email headers → `NormalizedIncomingMessage.metadata` |
| `reply threading: inReplyTo + references` | Correct RFC 5322 headers                             |
| `loop prevention header injected`         | Custom header in outbound email                      |
| `Graph token cached`                      | Second send reuses cached token                      |

---

## 4. New Channel Adapters

Each new channel follows ABL's established pattern: manifest entry + adapter file + route registration + tests.

### 4.1 SMS (Twilio)

**Files:**

- `apps/runtime/src/channels/adapters/sms-adapter.ts`
- `apps/runtime/src/routes/channel-sms.ts`

**Manifest entry:**

```typescript
sms: {
  displayName: 'SMS',
  ingress: 'webhook',
  delivery: 'async_queue',
  authMode: 'hmac',            // Twilio request signature
  responseFormat: 'text',
  webhookPathPattern: '/api/v1/channels/sms/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['account_sid', 'auth_token', 'phone_number'],
  supportsRichOutput: false,
  supportsMedia: false,
  supportsThreading: false,
  supportsStreaming: false,
}
```

**Inbound:**

- Twilio sends `application/x-www-form-urlencoded` (not JSON)
- Fields: `Body` (message text), `From` (sender phone), `To` (Twilio number), `MessageSid` (event ID)
- Auth: `X-Twilio-Signature` HMAC-SHA1 of URL + sorted params using `auth_token`
- `externalIdentifier`: the Twilio phone number (`To`)
- `externalSessionKey`: `sms:{To}:{From}` (phone-pair based session)

**Outbound:**

- POST `https://api.twilio.com/2010-04-01/Accounts/{accountSid}/Messages.json`
- Basic auth: `accountSid:authToken`
- Body: `{ To: userPhone, From: twilioPhone, Body: text }`
- Status callback: `POST /api/v1/channels/sms/webhook/:identifier/status` (delivery receipts)

**XO parity notes:**

- Strip Twilio trial prefix: `text.replace('Sent from your Twilio trial account - ', '')`
- Status callback route for delivery tracking
- Stream lookup by phone number (ABL: `externalIdentifier` = Twilio phone number)

**Future: SMS gateway plugin architecture** (same vendor-pluggable pattern as WhatsApp):

```typescript
interface SMSGatewayProvider {
  sendMessage(to: string, text: string, credentials: ChannelCredentials): Promise<SendResult>;
  verifyRequest(headers, body, rawBody, credentials): Promise<boolean>;
  buildNormalizedMessage(body: unknown): NormalizedIncomingMessage;
}
// Implementations: TwilioSMSProvider, VonageSMSProvider, SinchSMSProvider
```

### 4.2 Telegram

**Files:**

- `apps/runtime/src/channels/adapters/telegram-adapter.ts`
- `apps/runtime/src/routes/channel-telegram.ts`

**Manifest entry:**

```typescript
telegram: {
  displayName: 'Telegram',
  ingress: 'webhook',
  delivery: 'async_queue',
  authMode: 'token',           // Secret token in URL path (Telegram convention)
  responseFormat: 'text',
  webhookPathPattern: '/api/v1/channels/telegram/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['bot_token'],
  supportsRichOutput: true,    // Inline keyboards
  supportsMedia: true,
  supportsThreading: false,
  supportsStreaming: false,
}
```

**Inbound:**

- Telegram sends JSON webhook with `update_id`, `message`, or `callback_query`
- Message text: `body.message.text` or `body.callback_query.data`
- User ID: `body.message.from.id` or `body.callback_query.from.id`
- `externalIdentifier`: bot token hash (set during webhook registration)
- `externalSessionKey`: `telegram:{botId}:{chatId}`

**Outbound:**

- POST `https://api.telegram.org/bot{token}/sendMessage`
- Body: `{ chat_id, text, reply_markup?: { inline_keyboard } }`

**Rich output: inline keyboards**

```typescript
transformOutput(text, actions?) {
  if (!actions?.length) return { kind: 'text', text };

  const keyboard = actions.map(a => [{
    text: a.label,
    callback_data: a.actionId,
  }]);

  return {
    kind: 'telegram_keyboard',
    text,
    replyMarkup: { inline_keyboard: keyboard },
  };
}
```

**Webhook auto-registration:** On connection creation, call `POST /bot{token}/setWebhook` with the platform's webhook URL. On deletion, call `POST /bot{token}/deleteWebhook`. (Matches XO pattern.)

**Special handling:**

- `/start` command → detect as welcome event, fire `ON_START` trigger
- Group/supergroup: `body.message.chat.type !== 'private'` → set `metadata.isGroup = true`
- `callback_query` → `ActionEvent` with `actionId = data`, send `answerCallbackQuery` to dismiss loading state

### 4.3 Instagram

**Files:**

- `apps/runtime/src/channels/adapters/instagram-adapter.ts`

**Shares 90% of Messenger adapter internals** — same Graph API, same HMAC verification, same webhook payload structure (with minor differences).

**Differences from Messenger:**

- Different `externalIdentifier` field: Instagram Professional Account ID (not page ID)
- `is_echo` filtering — Instagram sends echo events for bot responses
- Different Graph API send URL: `https://graph.facebook.com/{version}/me/messages` (same as Messenger, but different token scope)
- No `postback` events — Instagram uses `quick_reply` only

**Implementation:** Extract shared Meta adapter logic into a base class, then specialize:

```typescript
// apps/runtime/src/channels/adapters/meta-base-adapter.ts
abstract class MetaBaseAdapter implements ChannelAdapter {
  // Shared: HMAC verification, webhook verification challenge, media download
  abstract get channelType(): ChannelType;
  abstract extractExternalIdentifier(body: unknown): string | null;
  abstract extractSenderId(entry: unknown): string;
}

class MessengerAdapter extends MetaBaseAdapter { ... }
class InstagramAdapter extends MetaBaseAdapter { ... }
```

### 4.4 AudioCodes Voice

**Files:**

- `apps/runtime/src/channels/adapters/audiocodes-adapter.ts`
- `apps/runtime/src/services/voice/audiocodes/audiocodes-session.ts`
- `apps/runtime/src/services/voice/audiocodes/activity-builder.ts`

**Manifest entry:**

```typescript
audiocodes: {
  displayName: 'AudioCodes',
  ingress: 'websocket',
  delivery: 'websocket',
  authMode: 'token',
  responseFormat: 'voice_plain',
  isConnectionEligible: true,
  isVoice: true,
  requiredCredentials: ['inbound_auth_token'],
}
```

**Protocol:** AudioCodes uses an activity-based WebSocket protocol (from XO audit):

```typescript
// Inbound activities:
{ type: "message", text: "user speech" }
{ type: "event", name: "dtmf", value: "1" }
{ type: "event", name: "hangup" }

// Outbound activities:
{ type: "message", text: "TTS text" }
{ type: "event", name: "transfer", activityParams: { transferTarget, transferSipHeaders } }
{ type: "event", name: "playUrl", activityParams: { mediaUrl } }
{ type: "event", name: "hangup" }
{ type: "event", name: "config", activityParams: { ... } }  // STT/TTS config
```

**Reuses ABL's voice pipeline** (STT → LLM → TTS) but with AudioCodes-specific activity framing instead of KoreVG verb-based commands.

### 4.5 Line

**Manifest entry:**

```typescript
line: {
  displayName: 'LINE',
  ingress: 'webhook',
  delivery: 'async_queue',
  authMode: 'hmac',              // HMAC-SHA256 of body with channel secret
  responseFormat: 'text',
  webhookPathPattern: '/api/v1/channels/line/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['channel_access_token', 'channel_secret'],
  supportsRichOutput: true,
  supportsMedia: true,
}
```

**Inbound:**

- Events: `message` (text, image, video, audio, file, location, sticker), `postback` (button callback)
- Auth: HMAC-SHA256 of raw body using `channel_secret` in `x-line-signature` header
- User ID: `event.source.userId`
- `externalSessionKey`: `line:{channelId}:{userId}`

**Media:** Fetch content from `https://api-data.line.me/v2/bot/message/{messageId}/content` with Bearer token

**Outbound:**

- POST `https://api.line.me/v2/bot/message/reply` (with `replyToken`)
- Or POST `https://api.line.me/v2/bot/message/push` (proactive)
- Rich: quick replies, Flex Messages (LINE's rich template system)

### 4.6 Google Business Messages

**Manifest entry:**

```typescript
google_business: {
  displayName: 'Google Business Messages',
  ingress: 'webhook',
  delivery: 'async_queue',
  authMode: 'none',             // Webhook verification via Google's own mechanism
  responseFormat: 'text',
  webhookPathPattern: '/api/v1/channels/google-business/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['service_account_json'],
  supportsRichOutput: true,
}
```

**Auth:** Service account OAuth2 (JWT signed with private key, scope: `https://www.googleapis.com/auth/businessmessages`)

**Inbound:** `body.message.text`, user ID = `body.conversationId`

**Outbound:** POST `https://businessmessages.googleapis.com/v1/conversations/{conversationId}/messages`

**Rich:** Suggestion chips, rich cards, carousels

### 4.7 Zendesk Sunshine

**Manifest entry:**

```typescript
zendesk: {
  displayName: 'Zendesk',
  ingress: 'webhook',
  delivery: 'async_queue',
  authMode: 'hmac',
  webhookPathPattern: '/api/v1/channels/zendesk/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['app_id', 'key_id', 'key_secret'],
  supportsRichOutput: true,
  supportsMedia: true,
}
```

**Key feature: Switchboard integration** — bot/agent handoff via `switchboard:passControl` event. This overlaps with the agent transfer design but operates at the channel level.

**Webhook triggers:** `conversation:message`, `conversation:postback`, `switchboard:passControl`, `conversation:message:delivery:failure`

**Auto-registration:** On connection creation, call Smooch v2 API to create webhook subscription.

### 4.8 Genesys (Bot Channel)

This is Genesys as a _bot connector channel_ (not agent transfer). Genesys sends customer messages to ABL as a bot, ABL responds.

**Manifest entry:**

```typescript
genesys: {
  displayName: 'Genesys',
  ingress: 'webhook',
  delivery: 'sync_response',     // Genesys expects synchronous response
  authMode: 'token',
  webhookPathPattern: '/api/v1/channels/genesys/webhook/:identifier',
  isConnectionEligible: true,
  requiredCredentials: ['client_id', 'client_secret', 'region'],
}
```

**Sync response model:** Genesys bot connector expects a response in the same HTTP request (like VXML). Response via Redis pub/sub with timeout (matching XO's `subscriptionChannel: genesys.response.complete`).

**Bot schema publishing:** On connection creation, publish ABL agent capabilities to Genesys via `PUT /api/v2/integrations/botconnector/{integrationId}/bots`.

---

## 5. Outbound Typing Indicators

### 5.1 Design

Add `sendTypingIndicator` to the `ChannelAdapter` interface:

```typescript
// types.ts — addition to ChannelAdapter
interface ChannelAdapter {
  // ... existing methods ...

  sendTypingIndicator?(
    sessionMetadata: Record<string, unknown>,
    connection: ResolvedConnection,
    state: 'typing_on' | 'typing_off',
  ): Promise<void>;
}
```

**When to fire:** At the start of LLM execution (before first response chunk). The `inbound-worker.ts` calls `sendTypingIndicator('typing_on')` after session resolution and before `executeAndPersist()`. For streaming channels, `typing_off` is implicit when the first chunk arrives.

**Per-channel implementation:**

| Channel           | API Call                                                                | Notes                                                                           |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Slack**         | POST `chat.postMessage` with `"type": "typing"` or use `chat.meMessage` | Slack doesn't have a dedicated typing API; use workspace-level RTM or just skip |
| **WhatsApp**      | Not supported by API                                                    | WhatsApp has no typing indicator API for businesses                             |
| **Messenger**     | POST `/me/messages` with `{ sender_action: 'typing_on' }`               | Standard Graph API                                                              |
| **MS Teams**      | POST activity with `{ type: 'typing' }`                                 | Bot Framework standard                                                          |
| **Telegram**      | POST `/bot{token}/sendChatAction` with `{ action: 'typing' }`           | Standard Bot API                                                                |
| **Line**          | Not supported                                                           | LINE has no typing indicator API                                                |
| **Instagram**     | POST `/me/messages` with `{ sender_action: 'typing_on' }`               | Same as Messenger                                                               |
| **SMS**           | N/A                                                                     | SMS has no typing concept                                                       |
| **Email**         | N/A                                                                     | Email has no typing concept                                                     |
| **SDK WebSocket** | Send `{ type: 'typing' }` event                                         | Custom protocol event                                                           |

**Implementation in `inbound-worker.ts`:**

```typescript
// After session resolution, before execution
const adapter = getChannelRegistry().get(channelType);
if (adapter?.sendTypingIndicator) {
  // Fire-and-forget — typing indicator failure should never block message processing
  adapter
    .sendTypingIndicator(message.metadata ?? {}, resolvedConnection, 'typing_on')
    .catch((err) => logger.warn('typing indicator failed', { channelType, err: err.message }));
}
```

### 5.2 Tests

| Test                                          | Validates                                             |
| --------------------------------------------- | ----------------------------------------------------- |
| `Messenger: sends typing_on before execution` | POST `/me/messages` with `sender_action: 'typing_on'` |
| `Teams: sends typing activity`                | POST typing activity to service URL                   |
| `Telegram: sends sendChatAction`              | POST `/sendChatAction` with `action: 'typing'`        |
| `WhatsApp: no-op (not supported)`             | No HTTP call made                                     |
| `typing failure does not block execution`     | Error in typing → message still processed             |
| `SDK WebSocket: typing event sent`            | `{ type: 'typing' }` event on WebSocket               |

---

## 6. Proactive Messaging Framework

### 6.1 Design

Proactive messaging = sending messages to users without them sending a message first. This is critical for:

- **WhatsApp templates** (24-hour window rule — can only send templates outside window)
- **Messenger one-time notifications** (user opts in)
- **SMS outbound campaigns**
- **Email outbound**
- **Line push messages**
- **Teams proactive messages**
- **Slack direct messages**

**API endpoint:**

```typescript
// POST /api/v1/channels/proactive/send
// Auth: API key (tenant-scoped)
{
  channelType: ChannelType,
  connectionId: string,          // Which channel connection to use
  recipientId: string,           // Platform-specific user ID (phone number, chat ID, etc.)
  message: {
    text?: string,               // Plain text
    richContent?: {
      whatsapp?: WhatsAppTemplatePayload,  // WhatsApp template
      // ... other platform-specific rich content
    },
  },
  metadata?: Record<string, unknown>,  // Custom metadata
  idempotencyKey?: string,        // Prevent duplicate sends
}
```

**Response:**

```typescript
{
  success: boolean,
  deliveryId: string,
  error?: { code: string, message: string },
}
```

### 6.2 Platform-Specific Rules

| Channel       | Proactive Rules                                                                            | ABL Implementation                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **WhatsApp**  | Must use approved templates outside 24h window. Free-form within 24h of last user message. | Check `ChannelSession.lastMessageAt` — if >24h, require `richContent.whatsapp` template. If ≤24h, allow free-form text.           |
| **Messenger** | 24-hour standard messaging window. One-time notification token for out-of-window.          | Check last user message timestamp. One-time notification token stored in `ChannelSession.metadata`.                               |
| **SMS**       | No time window — always allowed. Carrier-level opt-in/opt-out.                             | Always send. Track opt-out via webhook status callbacks (STOP keyword).                                                           |
| **Email**     | Always allowed (SMTP is fire-and-forget).                                                  | Always send via configured transport (SMTP or Graph).                                                                             |
| **Telegram**  | Always allowed — bots can message any user who has started a chat.                         | Always send via `/bot{token}/sendMessage`.                                                                                        |
| **Line**      | Push API — always allowed for users who added the bot as friend.                           | POST `https://api.line.me/v2/bot/message/push`. Requires `userId`.                                                                |
| **MS Teams**  | Proactive requires `conversationReference` stored from prior interaction.                  | Store `serviceUrl`, `conversationId`, `channelId` in `ChannelSession.metadata`. Use Bot Framework `continueConversation` pattern. |
| **Slack**     | Always allowed — bot can message any user in workspace.                                    | POST `chat.postMessage` with `channel: userId` (DM).                                                                              |

### 6.3 Architecture

```
Client → POST /api/v1/channels/proactive/send
  → Auth middleware (API key)
  → Validate payload (Zod schema)
  → resolveConnectionById(connectionId) → credentials
  → Platform rules check (24h window, template requirement)
  → Idempotency check (Redis SET NX)
  → BullMQ enqueue to `proactive-delivery` queue
  → Return { success: true, deliveryId }

proactive-delivery worker:
  → resolveConnectionById
  → adapter.sendProactiveMessage(recipientId, output, connection)
  → Track delivery status
  → Retry on 5xx (same as webhook-delivery pattern)
```

**New queue:** `proactive-delivery` (separate from `webhook-delivery` to avoid interference with reactive message delivery).

**Adapter interface addition:**

```typescript
interface ChannelAdapter {
  // ... existing ...

  sendProactiveMessage?(
    recipientId: string,
    output: ChannelOutput,
    connection: ResolvedConnection,
  ): Promise<SendResult>;
}
```

### 6.4 Proactive Tests

| Test                                           | Validates                                 |
| ---------------------------------------------- | ----------------------------------------- |
| `WhatsApp: template sent outside 24h window`   | Template payload sent, not free-form text |
| `WhatsApp: free-form text within 24h window`   | Plain text allowed                        |
| `WhatsApp: rejects free-form outside 24h`      | Error: `TEMPLATE_REQUIRED`                |
| `Messenger: rejects outside 24h without token` | Error: `MESSAGING_WINDOW_CLOSED`          |
| `SMS: always sends`                            | No time window check                      |
| `Telegram: sends to chat_id`                   | `/sendMessage` with `chat_id`             |
| `Teams: uses conversationReference`            | `continueConversation` pattern            |
| `idempotency prevents duplicate sends`         | Same key → skip                           |
| `5xx from platform retries`                    | BullMQ retry with backoff                 |
| `4xx from platform fails permanently`          | No retry                                  |

---

## 7. Channel Analytics Pipeline

### 7.1 Design

Emit `TraceEvent`s for channel-level operations. Uses ABL's existing `TraceStore` (ClickHouse).

**New trace event types:**

```typescript
type ChannelTraceType =
  | 'channel:message_received' // Inbound message from platform
  | 'channel:message_delivered' // Outbound message to platform
  | 'channel:delivery_failed' // Outbound delivery error
  | 'channel:typing_sent' // Typing indicator sent
  | 'channel:proactive_sent' // Proactive message sent
  | 'channel:proactive_failed' // Proactive delivery error
  | 'channel:media_processed' // Media attachment processed
  | 'channel:media_failed' // Media processing error
  | 'channel:session_created' // New channel session
  | 'channel:session_ended'; // Channel session ended
```

**Trace event structure:**

```typescript
{
  type: 'channel:message_delivered',
  timestamp: Date,
  tenantId: string,
  projectId: string,
  sessionId: string,
  data: {
    channelType: 'whatsapp',
    vendor?: 'gupshup',          // For multi-vendor channels
    messageId: string,
    latencyMs: number,           // Time from execution complete to platform delivery
    statusCode?: number,         // Platform API response status
    outputKind: 'text' | 'whatsapp_interactive' | ...,
  }
}
```

**Integration points:**

- `inbound-worker.ts`: Emit `channel:message_received` at job start, `channel:message_delivered` after `sendResponse()`
- `delivery-worker.ts`: Emit `channel:delivery_failed` on permanent failure
- `proactive-delivery` worker: Emit `channel:proactive_sent` / `channel:proactive_failed`
- Media processors: Emit `channel:media_processed` / `channel:media_failed`

### 7.2 ClickHouse Table

```sql
CREATE TABLE channel_events (
  tenant_id    String,
  project_id   String,
  session_id   String,
  event_type   LowCardinality(String),
  channel_type LowCardinality(String),
  vendor       LowCardinality(String),
  message_id   String,
  latency_ms   UInt32,
  status_code  UInt16,
  output_kind  LowCardinality(String),
  error_code   LowCardinality(String),
  timestamp    DateTime64(3),
) ENGINE = MergeTree()
ORDER BY (tenant_id, channel_type, timestamp)
TTL timestamp + INTERVAL 90 DAY;
```

---

## 8. Additional Feature Implementations

### 8.1 Location Message Ingest (WhatsApp, Messenger)

**Add to `NormalizedIncomingMessage`:**

```typescript
interface NormalizedIncomingMessage {
  // ... existing ...
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
    name?: string;
  };
}
```

**WhatsApp:** Already has location in XO normalizer — `message.location.latitude/longitude/address`. Add to `buildNormalizedMessage()` when `messageType === 'location'`.

**Messenger:** `attachments[0].type === 'location'` → `attachments[0].payload.coordinates.lat/long`.

Location is passed to LLM as context (formatted as `"User shared location: {address} ({lat}, {lng})"` in the message text, or as structured metadata for tool use).

### 8.2 Carousel/Rich Templates (Messenger, SDK)

**New `ChannelOutput` variant:**

```typescript
| { kind: 'messenger_generic_template'; elements: MessengerGenericElement[]; text: string }
```

Where `MessengerGenericElement`:

```typescript
{
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action?: { type: 'web_url'; url: string };
  buttons?: MessengerButton[];  // max 3
}
```

**Messenger `transformOutput()`:** When `richContent.carousel` is present, map to `generic_template` with elements.

**SDK WebSocket:** Add `richContent.carousel` pass-through in `response_end` event. SDK renders natively.

### 8.3 Slack Slash Commands

**Route addition:**

```
POST /api/v1/channels/slack/slash/:identifier
```

Slash commands arrive as `application/x-www-form-urlencoded` with `command`, `text`, `user_id`, `team_id`. Normalize as a regular message with `metadata.isSlashCommand = true` and `text = command + ' ' + text`.

---

## 9. Implementation Schedule

### Phase 1: WhatsApp Multi-Vendor + Email (Weeks 1-3)

| Week | Work Items                                                                      | Deliverables |
| ---- | ------------------------------------------------------------------------------- | ------------ |
| 1    | WhatsApp vendor interface, extract MetaCloudProvider, Gupshup provider          | Items #10-11 |
| 2    | Infobip provider, Karix provider, Netcore provider, voice transcription service | Items #12-14 |
| 3    | Email HTML rendering, Graph API transport, CC/BCC, header/footer templates      | Items #15-18 |

### Phase 2: Typing Indicators + Proactive Messaging (Weeks 4-5)

| Week | Work Items                                                                                                | Deliverables       |
| ---- | --------------------------------------------------------------------------------------------------------- | ------------------ |
| 4    | Typing indicators for all channels, proactive messaging API + queue + workers                             | Items #19-20       |
| 5    | Proactive per-channel implementations (WhatsApp templates, Messenger window, Teams conversationReference) | Item #20 continued |

### Phase 3: New Channels — P0 (Weeks 6-7)

| Week | Work Items                  | Deliverables |
| ---- | --------------------------- | ------------ |
| 6    | SMS (Twilio), Telegram      | Items #1-2   |
| 7    | Instagram, AudioCodes voice | Items #3-4   |

### Phase 4: New Channels — P1 + Analytics (Weeks 8-10)

| Week | Work Items                                    | Deliverables |
| ---- | --------------------------------------------- | ------------ |
| 8    | Line, Google Business Messages                | Items #5-6   |
| 9    | Channel analytics pipeline, location ingest   | Items #21-22 |
| 10   | Carousel/rich templates, Slack slash commands | Items #23-24 |

### Phase 5: New Channels — P2 (Weeks 11-13)

| Week | Work Items                                    | Deliverables |
| ---- | --------------------------------------------- | ------------ |
| 11   | Zendesk Sunshine (with switchboard)           | Item #7      |
| 12   | Genesys (bot channel, sync response model)    | Item #8      |
| 13   | WeChat (XML payloads, signature verification) | Item #9      |

---

## 10. Test Strategy

### 10.1 Test Pyramid

```
         ┌──────────────┐
         │   E2E (4)     │  Against real platform sandboxes (Twilio, Telegram, Meta)
         │               │  CI nightly only
         ├───────────────┤
         │Integration(12)│  Full message flow with nock + mock Redis
         │               │  Run on every PR
         ├───────────────┤
         │  Unit (50+)   │  Each adapter method, each vendor, each transport
         │               │  Run on every commit
         └───────────────┘
```

### 10.2 Per-Channel Test Requirements

Every channel adapter MUST have:

1. **Auth verification tests** (2-3 tests)
   - Valid signature → pass
   - Invalid signature → reject (401)
   - Replay (stale timestamp) → reject

2. **Message normalization tests** (3-5 tests)
   - Plain text → `NormalizedIncomingMessage`
   - Interactive callback → `ActionEvent`
   - Media message → media references extracted
   - Edge cases (empty text, missing fields)

3. **Output transformation tests** (2-4 tests)
   - Plain text → platform-native text
   - Actions (buttons) → platform-native buttons/keyboards
   - Rich content → platform-specific rich output
   - Fallback when actions exceed platform limits

4. **Send response tests** (2-3 tests)
   - Successful delivery → `{ success: true, deliveryId }`
   - Platform API error → `{ success: false, error }`
   - Auth token expired → refresh and retry

5. **Integration test** (1 per channel)
   - Webhook → normalize → execute (mocked) → transform → send (nocked)
   - Full BullMQ job lifecycle

### 10.3 Backward Compatibility Tests (WhatsApp)

| Test                                        | Validates                                              |
| ------------------------------------------- | ------------------------------------------------------ |
| `Meta Cloud: existing tests pass unchanged` | No regression from vendor extraction                   |
| `Meta Cloud: same webhook URL works`        | `/api/v1/channels/whatsapp/webhook` unchanged          |
| `Meta Cloud: same ChannelConnection config` | No migration needed for existing connections           |
| `Meta Cloud: same output format`            | `whatsapp_interactive` output unchanged                |
| `vendor field defaults to meta_cloud`       | Existing connections without vendor field → Meta Cloud |

### 10.4 Mock Patterns

**nock for platform APIs:**

```typescript
import nock from 'nock';

function mockMetaGraphAPI() {
  return {
    sendMessage: (phoneNumberId: string) =>
      nock('https://graph.facebook.com')
        .post(`/v21.0/${phoneNumberId}/messages`)
        .reply(200, { messages: [{ id: 'wamid.xxx' }] }),
    sendMessageFail: (phoneNumberId: string) =>
      nock('https://graph.facebook.com')
        .post(`/v21.0/${phoneNumberId}/messages`)
        .reply(400, { error: { message: 'Invalid phone number' } }),
  };
}

function mockTwilioAPI(accountSid: string) {
  return {
    sendSMS: () =>
      nock('https://api.twilio.com')
        .post(`/2010-04-01/Accounts/${accountSid}/Messages.json`)
        .reply(201, { sid: 'SM123', status: 'queued' }),
  };
}

function mockTelegramBotAPI(token: string) {
  return {
    sendMessage: () =>
      nock('https://api.telegram.org')
        .post(`/bot${token}/sendMessage`)
        .reply(200, { ok: true, result: { message_id: 1 } }),
    sendChatAction: () =>
      nock('https://api.telegram.org').post(`/bot${token}/sendChatAction`).reply(200, { ok: true }),
  };
}
```

---

## 11. Configuration Reference

### 11.1 New ChannelConnection Configs

**SMS (Twilio):**

```json
{
  "channelType": "sms",
  "externalIdentifier": "+15551234567",
  "credentials": {
    "account_sid": "AC...",
    "auth_token": "xxx",
    "phone_number": "+15551234567"
  },
  "config": {
    "statusCallbackEnabled": true,
    "stripTrialPrefix": true
  }
}
```

**Telegram:**

```json
{
  "channelType": "telegram",
  "externalIdentifier": "telegram:123456789",
  "credentials": {
    "bot_token": "123456:ABC-DEF..."
  },
  "config": {
    "autoRegisterWebhook": true,
    "welcomeCommand": "/start"
  }
}
```

**WhatsApp (Gupshup):**

```json
{
  "channelType": "whatsapp_gupshup",
  "externalIdentifier": "gupshup:+15551234567",
  "credentials": {
    "api_key": "xxx",
    "app_name": "my-bot"
  },
  "config": {
    "vendor": "gupshup",
    "transcription": {
      "provider": "assemblyai",
      "apiKey": "xxx"
    }
  }
}
```

**Email (Graph API):**

```json
{
  "channelType": "email",
  "externalIdentifier": "support@company.com",
  "credentials": {
    "graph_tenant_id": "xxx",
    "graph_client_id": "xxx",
    "graph_client_secret": "xxx"
  },
  "config": {
    "outbound": {
      "transport": "graph",
      "format": "html",
      "senderAddress": "support@company.com",
      "header": "<div style='...'>Company Header</div>",
      "footer": "<div style='...'>Powered by ABL</div>",
      "loopPreventionHeader": "X-ABL-Source"
    }
  }
}
```

### 11.2 New Environment Variables

| Variable                         | Default | Purpose                                                   |
| -------------------------------- | ------- | --------------------------------------------------------- |
| `ASSEMBLYAI_API_KEY`             | —       | Voice transcription for WhatsApp vendors                  |
| `PROACTIVE_QUEUE_CONCURRENCY`    | 10      | Proactive delivery worker concurrency                     |
| `PROACTIVE_QUEUE_ATTEMPTS`       | 5       | Max retry attempts for proactive delivery                 |
| `CHANNEL_TYPING_ENABLED`         | true    | Global toggle for outbound typing indicators              |
| `WHATSAPP_TEMPLATE_WINDOW_HOURS` | 24      | Hours after last user message before template is required |

### 11.3 Database Model Changes

**`ChannelConnection.channelType` enum additions:**

```
sms, telegram, instagram, audiocodes, line, google_business, zendesk, genesys, wechat,
whatsapp_gupshup, whatsapp_infobip, whatsapp_karix, whatsapp_netcore
```

**`ChannelSession` additions:**

- `lastMessageAt` index (for proactive messaging window checks)
- `metadata.conversationReference` (for Teams proactive)
- `metadata.onetimeNotificationToken` (for Messenger proactive)

---

## 12. Files Changed / Created Summary

### New Files (per channel/feature)

| Category                   | Files                                                                                                                          | Count  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| **WhatsApp vendors**       | `vendor-interface.ts`, `vendor-registry.ts`, `vendors/{meta-cloud,gupshup,infobip,karix,netcore}.ts`, `voice-transcription.ts` | 8      |
| **Email enhancements**     | `email/transport-interface.ts`, `email/smtp-transport.ts`, `email/graph-transport.ts`                                          | 3      |
| **SMS**                    | `sms-adapter.ts`, `routes/channel-sms.ts`                                                                                      | 2      |
| **Telegram**               | `telegram-adapter.ts`, `routes/channel-telegram.ts`                                                                            | 2      |
| **Instagram**              | `instagram-adapter.ts`, `meta-base-adapter.ts`                                                                                 | 2      |
| **AudioCodes**             | `audiocodes-adapter.ts`, `voice/audiocodes/{session,activity-builder}.ts`                                                      | 3      |
| **Line**                   | `line-adapter.ts`, `routes/channel-line.ts`                                                                                    | 2      |
| **Google Business**        | `google-business-adapter.ts`, `routes/channel-google-business.ts`                                                              | 2      |
| **Zendesk**                | `zendesk-adapter.ts`, `routes/channel-zendesk.ts`                                                                              | 2      |
| **Genesys**                | `genesys-adapter.ts`, `routes/channel-genesys.ts`                                                                              | 2      |
| **WeChat**                 | `wechat-adapter.ts`, `routes/channel-wechat.ts`                                                                                | 2      |
| **Typing indicators**      | Changes to existing adapters (no new files)                                                                                    | 0      |
| **Proactive messaging**    | `routes/proactive.ts`, `services/queues/proactive-worker.ts`                                                                   | 2      |
| **Analytics**              | `services/channel-analytics.ts`                                                                                                | 1      |
| **Tests**                  | ~50 test files across all features                                                                                             | ~50    |
| **Total new source files** |                                                                                                                                | **31** |

### Modified Files

| File                                                       | Change                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `channels/types.ts`                                        | New `ChannelType` values, new `ChannelOutput` variants, typing indicator on `ChannelAdapter` |
| `channels/manifest.ts`                                     | 13 new manifest entries                                                                      |
| `channels/registry.ts`                                     | Register new adapters                                                                        |
| `routes/channel-webhooks.ts`                               | Add new channel types to allowed set                                                         |
| `services/queues/channel-queues.ts`                        | Add `proactive-delivery` queue                                                               |
| `services/queues/inbound-worker.ts`                        | Add typing indicator call, new media processors                                              |
| `channels/adapters/whatsapp-adapter.ts`                    | Refactor to coordinator pattern (delegates to vendor)                                        |
| `channels/adapters/messenger-adapter.ts`                   | Extract to `MetaBaseAdapter`                                                                 |
| `channels/adapters/email-adapter.ts`                       | HTML output, pluggable transport, CC/BCC                                                     |
| `channels/session-resolver.ts`                             | Add `extractCallerContextFromChannel` for new channels                                       |
| `packages/database/src/models/channel-connection.model.ts` | New channel type enum values                                                                 |

---

## 13. Cross-Cutting: Resilience, Observability & Operations

These improvements apply to the **entire channel system and runtime**, not just the new channels. They address gaps found by auditing the existing ABL channel infrastructure against the same standards designed for agent transfer (see `2026-03-04-callflow-agent-desktop-design.md` Section 15). Many of these gaps exist in the current production code and should be prioritized alongside new channel development.

---

### 13.1 CRITICAL — Inbound Webhook Rate Limiting

**Current state:** `channel-webhooks.ts` has **no rate limiting middleware**. Slack, WhatsApp, Messenger, and all other webhook-based channels are completely unprotected. By contrast, `sdk-channels.ts` and `http-async-channel.ts` both use `tenantRateLimit('request')`.

**Problem:** A misconfigured or malicious webhook source can flood the `channel-inbound` BullMQ queue, consuming Redis memory and starving legitimate messages. WhatsApp Cloud API can deliver 1,000+ webhooks/second at scale.

**Resolution — two-tier rate limiting:**

```typescript
// apps/runtime/src/routes/channel-webhooks.ts

// Tier 1: Global IP-based rate limit (before any processing)
// Protects against DDoS before we even resolve the tenant
const webhookGlobalLimit = rateLimit({
  windowMs: 60_000,
  max: 1000, // 1000 requests per minute per IP
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    webhookRateLimitRejections.add(1, { tier: 'global', ip: req.ip });
    res.status(429).json({ error: 'Rate limit exceeded' });
  },
});

// Tier 2: Per-connection rate limit (after connection resolution)
// Applied inside the POST handler, after resolveConnectionByIdentifier
async function checkPerConnectionRateLimit(
  redis: Redis,
  connectionId: string,
  channelType: ChannelType,
): Promise<boolean> {
  const limits: Record<string, number> = {
    whatsapp: 500, // 500 messages/minute per WhatsApp number
    slack: 300, // Slack's own limit is 1/sec per channel
    messenger: 500,
    msteams: 300,
    telegram: 200,
    email: 100,
    default: 300,
  };
  const maxPerMinute = limits[channelType] ?? limits.default;
  const key = `ch_rl:${connectionId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= maxPerMinute;
}

// Wire into router
router.use(webhookGlobalLimit);

// Inside POST handler, after connection is resolved:
const withinLimit = await checkPerConnectionRateLimit(redis, connection._id, channelType);
if (!withinLimit) {
  webhookRateLimitRejections.add(1, { tier: 'connection', channelType });
  return res.status(429).json({ error: 'Channel rate limit exceeded' });
}
```

**Files changed:**

- `apps/runtime/src/routes/channel-webhooks.ts` — add rate limiting middleware + per-connection check
- `apps/runtime/src/observability/metrics.ts` — add `webhook_rate_limit.rejections` counter

---

### 13.2 CRITICAL — Outbound Send Circuit Breaker & Timeout

**Current state:** Channel adapter `sendResponse()` calls (WhatsApp Graph API, Slack API, etc.) have no `AbortSignal.timeout()`, no circuit breaker, and no per-provider rate limiting. A hung Meta API connection blocks the BullMQ worker thread for up to 2 minutes (Node.js default socket timeout).

**Resolution — wrap all outbound sends with circuit breaker + timeout:**

```typescript
// apps/runtime/src/channels/adapters/send-with-resilience.ts

import { HybridCircuitBreakerRegistry } from '@agent-platform/circuit-breaker';

const cbRegistry = getCircuitBreakerRegistry();

interface SendOptions {
  channelType: ChannelType;
  providerName: string; // e.g., 'meta_graph_api', 'slack_api', 'smtp'
  tenantId: string;
  timeoutMs?: number; // Default: 15_000
}

async function sendWithResilience<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: SendOptions,
): Promise<T> {
  const breakerKey = `channel:${opts.providerName}:${opts.tenantId}`;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return cbRegistry.execute(breakerKey, async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  });
}
```

**Applied to every adapter:**

```typescript
// whatsapp-adapter.ts — sendResponse() becomes:
async sendResponse(connection, output, metadata): Promise<SendResult> {
  return sendWithResilience(
    async (signal) => {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, ... },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) throw new Error(`WhatsApp API error: ${resp.status}`);
      return { success: true, messageId: (await resp.json()).messages?.[0]?.id };
    },
    {
      channelType: 'whatsapp',
      providerName: 'meta_graph_api',
      tenantId: metadata.tenantId,
      timeoutMs: 15_000,
    },
  );
}
```

**Circuit breaker defaults per provider:**

| Provider                                          | Failure Threshold | Reset Timeout | Half-Open Max |
| ------------------------------------------------- | ----------------- | ------------- | ------------- |
| `meta_graph_api` (WhatsApp, Messenger, Instagram) | 10                | 60s           | 3             |
| `slack_api`                                       | 5                 | 30s           | 3             |
| `smtp` (email)                                    | 5                 | 60s           | 2             |
| `telegram_api`                                    | 5                 | 30s           | 3             |
| `msteams_api`                                     | 5                 | 30s           | 3             |
| `twilio_api` (SMS)                                | 5                 | 30s           | 3             |
| Others                                            | 5                 | 30s           | 3             |

**Meta API per-WABA rate limiting:**

```typescript
// WhatsApp-specific: enforce Meta's rate limits before sending
const wabaRateLimiter = new Map<string, { count: number; resetAt: number }>();

async function checkWhatsAppRateLimit(phoneNumberId: string): Promise<boolean> {
  const now = Date.now();
  const entry = wabaRateLimiter.get(phoneNumberId);
  if (!entry || now > entry.resetAt) {
    wabaRateLimiter.set(phoneNumberId, { count: 1, resetAt: now + 1000 }); // 1 second window
    return true;
  }
  entry.count++;
  return entry.count <= 80; // Meta limit: 80 messages/second per phone number
}
```

**Files changed:**

- New: `apps/runtime/src/channels/adapters/send-with-resilience.ts`
- Modified: `whatsapp-adapter.ts`, `slack-adapter.ts`, `messenger-adapter.ts`, `msteams-adapter.ts`, `email-adapter.ts` — wrap `sendResponse()` with `sendWithResilience()`
- All new adapters (SMS, Telegram, Instagram, etc.) use `sendWithResilience()` from the start

---

### 13.3 HIGH — Channel OTEL Metrics

**Current state:** Zero OTEL metrics anywhere in `apps/runtime/src/channels/` or `apps/runtime/src/services/queues/`. The only observability is structured logging.

**Resolution — new metrics module for the channel pipeline:**

```typescript
// apps/runtime/src/channels/observability/channel-metrics.ts

import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('channels');

// Inbound pipeline
export const inboundLatency = meter.createHistogram('channel.inbound.latency', {
  description: 'Time from webhook receipt to BullMQ enqueue',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500] },
});

export const inboundProcessingLatency = meter.createHistogram(
  'channel.inbound.processing_latency',
  {
    description: 'Time from BullMQ dequeue to execution complete',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2500, 5000, 10000] },
  },
);

export const inboundCount = meter.createCounter('channel.inbound.count', {
  description: 'Inbound messages by channel type and tenant',
});

export const inboundErrors = meter.createCounter('channel.inbound.errors', {
  description: 'Inbound processing failures',
});

export const dedupHits = meter.createCounter('channel.inbound.dedup_hits', {
  description: 'Messages rejected by deduplication',
});

// Outbound delivery
export const outboundLatency = meter.createHistogram('channel.outbound.latency', {
  description: 'Time from delivery enqueue to provider API response',
  unit: 'ms',
  advice: { explicitBucketBoundaries: [50, 100, 250, 500, 1000, 2500, 5000] },
});

export const outboundCount = meter.createCounter('channel.outbound.count', {
  description: 'Outbound messages by channel type and status',
});

export const outboundErrors = meter.createCounter('channel.outbound.errors', {
  description: 'Outbound delivery failures by channel type and error type',
});

// Queue depth (observable gauge, polled every 15s by OTEL)
export const queueDepth = meter.createObservableGauge('channel.queue.depth', {
  description: 'BullMQ queue depth by queue name and state',
});

// Session metrics
export const activeSessions = meter.createUpDownCounter('channel.sessions.active', {
  description: 'Active channel sessions by channel type',
});

export const sessionLockContention = meter.createCounter('channel.sessions.lock_contention', {
  description: 'Session lock acquisition failures',
});

// Webhook rate limiting
export const webhookRateLimitRejections = meter.createCounter(
  'channel.webhook.rate_limit_rejections',
  {
    description: 'Webhook requests rejected by rate limiter',
  },
);

// Provider circuit breaker (per-channel, supplements the existing generic CB gauge)
export const channelCircuitBreakerTrips = meter.createCounter('channel.circuit_breaker.trips', {
  description: 'Circuit breaker transitions to OPEN state',
});
```

**Instrumentation points:**

```typescript
// In channel-webhooks.ts POST handler:
const webhookReceivedAt = Date.now();
// ... resolve connection, verify, normalize ...
inboundLatency.record(Date.now() - webhookReceivedAt, { channelType, tenantId });
inboundCount.add(1, { channelType, tenantId });

// In inbound-worker.ts job processor:
const jobStartedAt = Date.now();
// ... process message ...
inboundProcessingLatency.record(Date.now() - jobStartedAt, { channelType, tenantId });

// Dedup check in inbound-worker.ts:
if (isDuplicate) {
  dedupHits.add(1, { channelType, tenantId });
  return; // Skip processing
}

// In each adapter sendResponse():
outboundCount.add(1, { channelType, tenantId, status: result.success ? 'success' : 'failure' });
if (!result.success) {
  outboundErrors.add(1, { channelType, tenantId, errorType: classifyError(result.error) });
}
```

**Queue depth polling (register once at startup):**

```typescript
// In channel-queues.ts or a shared metrics init
queueDepth.addCallback(async (result) => {
  for (const [name, queue] of [
    ['channel-inbound', inboundQueue],
    ['webhook-delivery', deliveryQueue],
    ['proactive-delivery', proactiveQueue],
  ]) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, count] of Object.entries(counts)) {
      result.observe(count, { queue: name, state });
    }
  }
});
```

**Files changed:**

- New: `apps/runtime/src/channels/observability/channel-metrics.ts`
- Modified: `channel-webhooks.ts`, `inbound-worker.ts`, `delivery-worker.ts`, `channel-queues.ts`, all adapters

---

### 13.4 HIGH — BullMQ Queue Hardening (Stall Detection, Dead Letter, QueueEvents)

**Current state:** No `QueueEvents` listeners. No stall detection configuration. Inbound messages that fail all 3 attempts are silently dropped (only logged). Delivery failures are written to `WebhookDelivery` collection but have no replay mechanism.

**Resolution:**

#### 13.4.1 QueueEvents + Stall Detection

```typescript
// apps/runtime/src/services/queues/queue-monitor.ts

import { QueueEvents } from 'bullmq';

class ChannelQueueMonitor {
  private events: QueueEvents[] = [];

  async start(redis: Redis): Promise<void> {
    for (const queueName of ['channel-inbound', 'webhook-delivery', 'proactive-delivery']) {
      const queueEvents = new QueueEvents(queueName, { connection: redis });

      queueEvents.on('stalled', ({ jobId }) => {
        log.warn('BullMQ job stalled', { queue: queueName, jobId });
        inboundErrors.add(1, { errorType: 'stalled', queue: queueName });
      });

      queueEvents.on('failed', ({ jobId, failedReason, prev }) => {
        if (prev === 'active') {
          // Terminal failure — job exhausted all retries
          log.error('BullMQ job permanently failed', { queue: queueName, jobId, failedReason });
        }
      });

      this.events.push(queueEvents);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.events.map((e) => e.close()));
  }
}
```

#### 13.4.2 Stall Configuration on Workers

```typescript
// In inbound-worker.ts — add stall settings
const worker = new Worker('channel-inbound', processor, {
  connection: redis,
  concurrency: 5,
  stalledInterval: 30_000, // Check for stalled jobs every 30s
  maxStalledCount: 2, // Mark as failed after 2 stalls
  lockDuration: 60_000, // Job lock held for 60s (must be > longest job)
});
```

#### 13.4.3 Inbound Dead Letter Store

For inbound messages that exhaust all 3 retry attempts — store for replay:

```typescript
// In inbound-worker.ts — terminal failure handler
worker.on('failed', async (job, err) => {
  if (!job || job.attemptsMade < 3) return;

  log.error('Inbound message permanently failed', {
    jobId: job.id,
    channelType: job.data.channelType,
    tenantId: job.data.tenantId,
    externalMessageId: job.data.message?.externalMessageId,
    attempts: job.attemptsMade,
    error: err instanceof Error ? err.message : String(err),
  });

  // Write to dead letter collection
  await DeadLetter.create({
    queue: 'channel-inbound',
    jobId: job.id,
    jobName: job.name,
    data: {
      channelType: job.data.channelType,
      tenantId: job.data.tenantId,
      connectionId: job.data.connectionId,
      externalMessageId: job.data.message?.externalMessageId,
      // Do NOT store full message body (may contain PII)
      // Store enough to identify and replay
    },
    error: err instanceof Error ? err.message : String(err),
    failedAt: new Date(),
    tenantId: job.data.tenantId,
  });
});
```

#### 13.4.4 Webhook Subscription Auto-Deactivation

```typescript
// In delivery-worker.ts — after incrementing failureCount
const DEACTIVATION_THRESHOLD = 100; // 100 consecutive failures

if (subscription.failureCount >= DEACTIVATION_THRESHOLD) {
  log.warn('Deactivating webhook subscription due to persistent failures', {
    subscriptionId: subscription._id,
    tenantId: subscription.tenantId,
    failureCount: subscription.failureCount,
  });

  await WebhookSubscription.findOneAndUpdate(
    { _id: subscription._id, tenantId: subscription.tenantId },
    { $set: { active: false, deactivatedReason: 'persistent_failure', deactivatedAt: new Date() } },
  );
}
```

**Files changed:**

- New: `apps/runtime/src/services/queues/queue-monitor.ts`
- Modified: `inbound-worker.ts` (stall config + dead letter handler), `delivery-worker.ts` (auto-deactivation), `channel-queues.ts` (queue monitor lifecycle)
- Modified: `server.ts` shutdown sequence — add `queueMonitor.stop()` before `stopChannelQueues()`

---

### 13.5 HIGH — Channel Adapter Health Check Interface

**Current state:** `ChannelAdapter` interface has no `healthCheck()` method. No way to determine if WhatsApp credentials are valid, Slack token is revoked, or SMTP is reachable.

**Resolution — add optional `checkHealth()` to adapter interface:**

```typescript
// apps/runtime/src/channels/types.ts — extend ChannelAdapter

interface ChannelAdapter {
  // ... existing methods ...

  /**
   * Optional health check for this channel's external provider.
   * Returns true if the provider API is reachable and credentials are valid.
   * Implementations should be fast (< 5s) and not modify state.
   */
  checkHealth?(connection: ResolvedConnection): Promise<ChannelHealthResult>;
}

interface ChannelHealthResult {
  healthy: boolean;
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}
```

**Per-adapter implementations:**

| Adapter       | Health Check Method                                            |
| ------------- | -------------------------------------------------------------- |
| WhatsApp      | `GET /{phoneNumberId}` — validates access token + phone number |
| Slack         | `POST auth.test` — validates bot token                         |
| Email (SMTP)  | `transporter.verify()` — validates SMTP connection             |
| Email (Graph) | `GET /me` — validates OAuth token                              |
| Messenger     | `GET /me?access_token=...` — validates page token              |
| MSTeams       | Teams doesn't expose a simple health endpoint — skip           |
| Telegram      | `GET /getMe` — validates bot token                             |
| SMS (Twilio)  | `GET /2010-04-01/Accounts/{sid}` — validates credentials       |

**Aggregated into runtime health check:**

```typescript
// In apps/runtime/src/health/service-registry.ts — add channel health

{
  id: 'channels',
  name: 'Channel Providers',
  group: 'runtime',
  checkMethod: 'custom',
  check: async () => {
    const registry = getChannelRegistry();
    const connections = await ChannelConnection.find({ active: true }).lean();

    const results: Record<string, ChannelHealthResult> = {};
    let healthy = 0, degraded = 0;

    // Sample up to 5 connections per channel type (don't health-check all 1000)
    const sampled = sampleConnectionsByType(connections, 5);

    for (const conn of sampled) {
      const adapter = registry.get(conn.channelType);
      if (!adapter?.checkHealth) continue;

      try {
        const resolved = await resolveChannelConnection(conn._id, conn.tenantId);
        const result = await adapter.checkHealth(resolved);
        results[`${conn.channelType}:${conn._id}`] = result;
        result.healthy ? healthy++ : degraded++;
      } catch (err) {
        results[`${conn.channelType}:${conn._id}`] = {
          healthy: false,
          latencyMs: -1,
          error: err instanceof Error ? err.message : String(err),
        };
        degraded++;
      }
    }

    return {
      status: degraded === 0 ? 'healthy' : healthy === 0 ? 'down' : 'degraded',
      details: { healthy, degraded, results },
    };
  },
}
```

**Files changed:**

- Modified: `apps/runtime/src/channels/types.ts` — add `checkHealth?()` to `ChannelAdapter`
- Modified: `whatsapp-adapter.ts`, `slack-adapter.ts`, `email-adapter.ts`, `messenger-adapter.ts` — implement `checkHealth()`
- All new adapters implement `checkHealth()` from the start
- Modified: `apps/runtime/src/health/service-registry.ts` — add channel health check group

---

### 13.6 HIGH — WebSocket Server Heartbeat & Mid-Stream Recovery

**Current state:** No server-initiated heartbeat/ping. If a client's network drops silently (no TCP RST), the server holds the connection open indefinitely. Mid-LLM-stream pod crashes lose partial responses with no resume.

**Resolution:**

#### 13.6.1 Server-Initiated Heartbeat

```typescript
// apps/runtime/src/websocket/handler.ts — add heartbeat

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const HEARTBEAT_TIMEOUT = 10_000; // 10 seconds to respond

function startHeartbeat(ws: WebSocket): NodeJS.Timer {
  let alive = true;

  ws.on('pong', () => {
    alive = true;
  });

  const timer = setInterval(() => {
    if (!alive) {
      log.warn('WebSocket client failed heartbeat, terminating', {
        sessionId: ws._sessionId,
      });
      ws.terminate(); // Hard close — no close frame
      return;
    }
    alive = false;
    ws.ping(); // Send ping, wait for pong
  }, HEARTBEAT_INTERVAL);

  timer.unref();
  return timer;
}

// In the connection handler:
wss.on('connection', (ws) => {
  const heartbeatTimer = startHeartbeat(ws);
  ws.on('close', () => clearInterval(heartbeatTimer));
});
```

#### 13.6.2 Mid-Stream Checkpoint

When the LLM is streaming tokens, periodically checkpoint the partial response to Redis so a reconnecting client can resume:

```typescript
// In runtime executor, during LLM streaming:
let tokenBuffer = '';
let lastCheckpointAt = Date.now();
const CHECKPOINT_INTERVAL = 5_000; // 5 seconds

for await (const token of llmStream) {
  tokenBuffer += token;
  sendToWebSocket(ws, token);

  // Checkpoint every 5 seconds during streaming
  if (Date.now() - lastCheckpointAt > CHECKPOINT_INTERVAL) {
    await redis.set(
      `stream_checkpoint:${sessionId}`,
      tokenBuffer,
      'EX',
      300, // 5 min TTL
    );
    lastCheckpointAt = Date.now();
  }
}

// Clean up checkpoint after stream completes
await redis.del(`stream_checkpoint:${sessionId}`);
```

**On client reconnect (`resume_session`):**

```typescript
// In handleResumeSession():
const checkpoint = await redis.get(`stream_checkpoint:${sessionId}`);
if (checkpoint) {
  // Send the partial response accumulated so far
  ws.send(
    JSON.stringify({
      type: 'stream_resume',
      partialResponse: checkpoint,
    }),
  );
  await redis.del(`stream_checkpoint:${sessionId}`);
}
```

**Files changed:**

- Modified: `apps/runtime/src/websocket/handler.ts` — add heartbeat + checkpoint resume
- Modified: `apps/runtime/src/websocket/sdk-handler.ts` — same heartbeat pattern

---

### 13.7 MEDIUM — Graceful Shutdown Improvements

**Current state:** BullMQ workers compete with 30-second force timer. No `server.closeAllConnections()`. WebSocket close is fire-and-forget.

**Resolution — three fixes:**

```typescript
// Fix 1: Move BullMQ worker drain earlier in shutdown sequence
// Currently step 19 — move to step 5 (right after WebSocket close)
// This gives workers the full 25+ seconds to drain instead of ~2s

// Fix 2: Close idle keep-alive connections
// After server.close(), close connections that aren't processing a request
if (typeof server.closeIdleConnections === 'function') {
  server.closeIdleConnections(); // Node 18.2+
}

// Fix 3: WebSocket graceful drain — wait for streaming to complete
async function drainWebSockets(wss: WebSocketServer, timeoutMs: number): Promise<void> {
  const drainPromises: Promise<void>[] = [];

  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      drainPromises.push(
        new Promise<void>((resolve) => {
          // Send shutdown notice so client can reconnect to another pod
          ws.send(JSON.stringify({ type: 'server_shutdown', reconnect: true }));

          // Give 3 seconds for in-flight messages to complete
          setTimeout(() => {
            ws.close(1001, 'Server shutting down');
            resolve();
          }, 3000);
        }),
      );
    }
  }

  // Wait for all WS drains (bounded by timeoutMs)
  await Promise.race([
    Promise.all(drainPromises),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
```

**Revised shutdown order:**

```
1. Set isShuttingDown flag
2. 30s force-exit timer
3. HTTP server.close() + closeIdleConnections()     (release port)
4. drainWebSockets(wss, 3000) + drainWebSockets(wssSDK, 3000)  (3s drain)
5. stopChannelQueues() — drain BullMQ workers       (moved from step 19)
6. stopAgentTransferQueues() — drain AT workers
7. ... rest of cleanup (KMS, Kafka, ClickHouse, DB, Redis)
```

**Files changed:**

- Modified: `apps/runtime/src/server.ts` — reorder shutdown, add `closeIdleConnections()`, add `drainWebSockets()`

---

### 13.8 MEDIUM — Channel Session TTL & Orphan Detection

**Current state:** `ChannelSession` MongoDB documents have no TTL index. Sessions accumulate indefinitely. If a pod crashes with a session lock held, the lock expires via Redis TTL but there's no monitoring.

**Resolution:**

#### 13.8.1 MongoDB TTL Index on ChannelSession

```typescript
// packages/database/src/models/channel-session.model.ts

// Add TTL index — sessions inactive for 7 days are auto-deleted
ChannelSessionSchema.index(
  { lastMessageAt: 1 },
  { expireAfterSeconds: 604800 }, // 7 days
);
```

**Why 7 days:** Channel sessions need to persist longer than Redis runtime sessions (30 min) because a customer might return to the same WhatsApp conversation days later. 7 days is a balance between data retention and accumulation.

#### 13.8.2 Orphaned Session Background Scanner

```typescript
// apps/runtime/src/services/session/orphan-scanner.ts

class OrphanedSessionScanner {
  private timer: NodeJS.Timer | null = null;

  start(interval: number = 300_000): void {
    // Every 5 minutes
    this.timer = setInterval(() => this.scan(), interval);
    this.timer.unref();
  }

  private async scan(): Promise<void> {
    // Find ChannelSessions with no activity in 2x the session TTL
    const staleThreshold = new Date(Date.now() - 2 * 30 * 60 * 1000); // 1 hour

    const staleSessions = await ChannelSession.find({
      lastMessageAt: { $lt: staleThreshold },
      status: { $ne: 'ended' },
    })
      .limit(100)
      .lean();

    for (const session of staleSessions) {
      // Check if runtime session exists in Redis
      const exists = await redis.exists(`session:${session.runtimeSessionId}`);
      if (!exists) {
        log.info('Orphaned channel session detected, marking ended', {
          channelSessionId: session._id,
          channelType: session.channelType,
          tenantId: session.tenantId,
          lastMessageAt: session.lastMessageAt,
        });

        await ChannelSession.findOneAndUpdate(
          { _id: session._id, tenantId: session.tenantId },
          { $set: { status: 'ended', endedAt: new Date(), endReason: 'orphan_cleanup' } },
        );

        activeSessions.add(-1, { channelType: session.channelType });
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

**Files changed:**

- Modified: `packages/database/src/models/channel-session.model.ts` — add TTL index
- New: `apps/runtime/src/services/session/orphan-scanner.ts`
- Modified: `server.ts` — start/stop orphan scanner

---

### 13.9 MEDIUM — Config Hot Reload for Channel Connections

**Current state:** Channel connections are read live from MongoDB on every inbound message (no cache). This is correct for hot reload but has two issues: (1) `resolveConnectionById` uses `findById` without `tenantId` (tenant isolation violation), (2) outbound sends use credentials from the BullMQ job payload, which may be stale.

**Resolution:**

#### Fix 1: Tenant-scoped connection lookup

```typescript
// apps/runtime/src/channels/connection-resolver.ts

// BEFORE (line 109):
const connection = await ChannelConnection.findById(connectionId).lean();

// AFTER:
const connection = await ChannelConnection.findOne({
  _id: connectionId,
  tenantId,
}).lean();
```

#### Fix 2: Credential refresh for outbound sends

For outbound messages that are queued in BullMQ (e.g., streaming responses, delivery webhooks), the credentials in the job payload may be stale if rotated after the job was enqueued. The delivery worker should re-resolve credentials for long-queued jobs:

```typescript
// In inbound-worker.ts, before calling adapter.sendResponse():
const jobAge = Date.now() - job.timestamp;
const CREDENTIAL_STALE_THRESHOLD = 60_000; // 1 minute

let connection = job.data.resolvedConnection;
if (jobAge > CREDENTIAL_STALE_THRESHOLD) {
  // Re-resolve to get fresh credentials
  connection = await resolveChannelConnection(job.data.connectionId, job.data.tenantId);
}
```

**Files changed:**

- Modified: `apps/runtime/src/channels/connection-resolver.ts` — tenant-scoped `findOne`
- Modified: `apps/runtime/src/services/queues/inbound-worker.ts` — credential refresh for stale jobs

---

### 13.10 MEDIUM — Delivery Replay & Failure Dashboard

**Current state:** Failed webhook deliveries are recorded in `WebhookDelivery` collection as `status: 'failed'` but there's no mechanism to replay them after a downstream outage resolves. Failed inbound messages are only logged.

**Resolution — admin API for replay + tenant-facing failure visibility:**

```typescript
// Admin API: replay failed deliveries for a tenant
// POST /api/platform/admin/channels/deliveries/replay
router.post(
  '/api/platform/admin/channels/deliveries/replay',
  requireAuth,
  requirePermission('platform:admin'),
  async (req, res) => {
    const { tenantId, since, channelType } = req.body;

    const failedDeliveries = await WebhookDelivery.find({
      tenantId,
      status: 'failed',
      failedAt: { $gte: new Date(since) },
      ...(channelType ? { channelType } : {}),
    })
      .limit(1000)
      .lean();

    let replayed = 0;
    for (const delivery of failedDeliveries) {
      await deliveryQueue.add('webhook-delivery', {
        deliveryId: delivery._id,
        tenantId: delivery.tenantId,
        url: delivery.url,
        payload: delivery.payload,
        headers: delivery.headers,
        isReplay: true,
      });
      replayed++;
    }

    res.json({ success: true, replayed });
  },
);

// Admin API: view dead letters (inbound + delivery)
// GET /api/platform/admin/channels/dead-letters?tenantId=...&queue=...&since=...
router.get(
  '/api/platform/admin/channels/dead-letters',
  requireAuth,
  requirePermission('platform:admin'),
  async (req, res) => {
    const { tenantId, queue, since } = req.query;
    const deadLetters = await DeadLetter.find({
      ...(tenantId ? { tenantId } : {}),
      ...(queue ? { queue } : {}),
      ...(since ? { failedAt: { $gte: new Date(since as string) } } : {}),
      resolvedAt: null,
    })
      .sort({ failedAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, data: deadLetters });
  },
);
```

**Files changed:**

- New: `apps/runtime/src/routes/platform-admin-channels.ts` — admin API for dead letters, replay, subscription management
- Modified: `apps/runtime/src/server.ts` — mount admin routes

---

### 13.11 Alerting Thresholds (Channels + Runtime)

Consolidated alerting rules for all channel and runtime metrics:

| Metric                                                     | Warning          | Critical         |
| ---------------------------------------------------------- | ---------------- | ---------------- |
| `channel.queue.depth{queue=channel-inbound,state=waiting}` | > 200 for 2 min  | > 1000 for 1 min |
| `channel.queue.depth{queue=webhook-delivery,state=failed}` | > 20 for 5 min   | > 100 for 2 min  |
| `channel.outbound.errors` rate per provider                | > 5% for 5 min   | > 20% for 2 min  |
| `channel.circuit_breaker.trips`                            | > 0              | > 3 in 10 min    |
| `channel.webhook.rate_limit_rejections`                    | > 100/min        | > 500/min        |
| `channel.inbound.dedup_hits` rate                          | > 10% of inbound | > 30% of inbound |
| `channel.sessions.lock_contention`                         | > 10/min         | > 50/min         |
| `channel.inbound.processing_latency{quantile=0.95}`        | > 5s             | > 15s            |
| `channel.outbound.latency{quantile=0.95}`                  | > 3s             | > 10s            |
| BullMQ stalled jobs (any queue)                            | > 0              | > 5 in 10 min    |
| Dead letters (any queue)                                   | > 0              | > 10 in 1 hour   |
| `ChannelSession` orphan cleanup count                      | > 100/scan       | > 500/scan       |

---

### 13.12 Implementation Priority

These cross-cutting improvements should be interleaved with new channel development:

| Priority          | Item                                            | When                    | Effort   |
| ----------------- | ----------------------------------------------- | ----------------------- | -------- |
| **P0 — do first** | 13.1 Webhook rate limiting                      | Before any new channels | 1 day    |
| **P0 — do first** | 13.2 Outbound circuit breaker + timeout         | Before any new channels | 2 days   |
| **P0 — do first** | 13.9 Fix `findById` tenant isolation            | Immediately             | 0.5 day  |
| **P1 — Phase 1**  | 13.3 Channel OTEL metrics                       | Week 1-2                | 3 days   |
| **P1 — Phase 1**  | 13.4 BullMQ hardening (stall, DLQ, QueueEvents) | Week 1-2                | 2 days   |
| **P1 — Phase 2**  | 13.5 Adapter health check interface             | Week 3-4                | 2 days   |
| **P1 — Phase 2**  | 13.6 WebSocket heartbeat                        | Week 3-4                | 1 day    |
| **P2 — Phase 3**  | 13.7 Graceful shutdown improvements             | Week 5-6                | 1 day    |
| **P2 — Phase 3**  | 13.8 Channel session TTL + orphan scanner       | Week 5-6                | 1.5 days |
| **P2 — Phase 4**  | 13.10 Delivery replay + admin dashboard         | Week 7-8                | 2 days   |

**Total additional effort: ~16 days (3.2 weeks)** spread across the 13-week channel implementation schedule.

**Updated channel schedule:** 13 weeks → **~15 weeks** with cross-cutting hardening interleaved.

---

_End of Design & Implementation Plan_
