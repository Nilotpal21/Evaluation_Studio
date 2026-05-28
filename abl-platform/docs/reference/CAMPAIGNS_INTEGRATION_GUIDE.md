# Kore.ai Campaigns — Architecture & ABL Integration Guide

**Status:** Reference / Research notes
**Last updated:** 2026-04-21
**Scope:** How outbound voice/SMS campaigns work across `xocampaign-services`, `koreagentassist`, and `koreserver`, and how the ABL platform can trigger them.

Research was done by reading three codebases:

- `/Users/SrinivasaRao.Yasarla/Documents/projects/campaigns/xocampaign-services`
- `/Users/SrinivasaRao.Yasarla/Documents/projects/contactcenter/koreagentassist`
- `/Users/SrinivasaRao.Yasarla/Documents/projects/koreserver/koreserver`

File paths in this doc are relative to each repo's root unless otherwise noted.

---

## 1. The three codebases at a glance

| Codebase                                          | Role                                             | Campaign responsibility                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **koreserver** (monolith)                         | Platform authority: auth, tenancy, bots, gateway | Owns campaign CRUD + permissions + config; orchestrates campaign execution via internal HTTP + RabbitMQ to the runtime                                     |
| **xocampaign-services** (Node/Express, port 3032) | Dedicated campaign service                       | Campaign runtime engine: dialer, SAVG voice-gateway calls, scheduling, hopper                                                                              |
| **koreagentassist** (Contact Center backend)      | Agent desktop / contact center                   | Runs a **campaign-runtime process on port 3032** that mirrors/overlaps xocampaign-services; agent-campaign matching, Progressive/Preview/Agentless dialers |

**Important observation.** `koreagentassist/src/app_campaignRuntime.js` exposes the same route surface (`/api/v1/trigger/...`, `/api/v1/public/:botId/campaign/...`) on the same port (3032) as `xocampaign-services`. These are effectively the same runtime — either shared code or two builds of the same service. Neither calls the other; both are orchestrated by **koreserver**.

```
                                +-----------------+
                                |   koreserver    |
                                |  (auth, tenancy |
     ABL Platform ------------> |  CRUD, gateway) |
                                +--------+--------+
                                         |
                          internal HTTP  |  RabbitMQ (vhost: campaignService)
                                         v
                        +------------------------------------+
                        |  Campaign runtime (port 3032)      |
                        |   - xocampaign-services  OR        |
                        |   - koreagentassist campaign app   |
                        |  (dialer, hopper, SAVG calls)      |
                        +------------------------------------+
                                         |
                                         v
                                  SAVG Voice Gateway
                                  (outbound calls)
```

---

## 2. What a "campaign" actually is

### Channels

- **Outbound voice** with dialing modes: `Agentless` (IVR-only), `Preview`, `Progressive`, `Power`, `Predictive`
- **SMS** (simple template + experience-flow-driven)
- **Web campaigns** are a separate product surface owned by koreserver

### Core entities (MongoDB — same model names across xocampaign-services and koreagentassist)

| Model                 | File (xocampaign-services)                                          | Purpose                                                                            |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `campaignDetails`     | `src/models/campaignManagement/campaignDetails.model.js`            | Campaign definition — name, type, dialingMode, dialingStrategy, schedule, callerId |
| `campaignList`        | `src/models/campaignManagement/campaignList.model.js`               | Contact-list metadata (source = `localDrive` \| `apiIntegration` \| `passiveApi`)  |
| `campaignContactList` | `src/models/campaignManagement/campaignContactList.model.js`        | Individual contacts in a list                                                      |
| `campaignDialingList` | `src/models/campaignManagement/campaignDialingList.model.js`        | Runtime dialing state per contact (isDialed, outcome, retryCount)                  |
| `campaignInstance`    | `src/models/campaignManagement/runtime/campaignInstance.model.js`   | Per-execution state (totalContacts, totalCallsCompleted, status)                   |
| `campaignCallStatus`  | `src/models/campaignManagement/runtime/campaignCallStatus.model.js` | Call outcome tracking                                                              |
| `campaignSettings`    | `src/models/campaignManagement/campaignSettings.model.js`           | Org-level config (DNC, AMD timeouts, concurrent-call limits)                       |
| `campaignAgent`       | `src/models/campaignManagement/campaignAgent.model.js`              | Agent-campaign assignment                                                          |
| `campaignDialQueue`   | `src/models/campaignManagement/campaignDialQueue.model.js`          | CPS-limited dial queue                                                             |

Koreserver additionally owns web-campaign and SMS-template models: `WebCampaignDetailsModel`, `WebCampaignInstanceModel`, `SMSCampaignDetailsModel`, `SMSTemplateDetailsModel`.

### Lifecycle states

```
Preparing --> Ready --> Active --> Completed
                 |          |
                 |          +--> Paused --> Active (resume)
                 |          |
                 |          +--> Stopped
                 |
                 +--> Scheduled --> Active (at schedule time)
                 |
                 +--> Rescheduled
```

Statuses: `Active | Completed | Ready | Paused | Preparing | Stopped | Scheduled | Rescheduled` (`campaignDetails.model.js:538`).

Campaign-instance statuses: `Active | Completed | Ready | Paused | Stopped | System_Stopped` (`campaignInstance.model.js:36`).

Dialing outcomes: `completed | failed | invalid | busy | no-answer | timezone_skip | in-progress | retry-cancelled | waitingForDisposition | machine_detected` (`campaignDialingList.model.js:61`).

### Execution engine

- **Redis** hopper (master + prefetch + active-call sets) for in-flight contacts
- **Agenda** (Mongo-backed) for schedules and operational hours
- **node-cron** for CPS rate-limiting in the dialer
- **Redlock** for distributed locks
- Outbound voice calls go to **SAVG**: `POST {savgHost}/api/v1/Accounts/{accountSid}/Calls`
- Call-status webhooks land at `/api/v1/trigger/callStatus`

### Event flow (koreserver <-> runtime)

RabbitMQ vhost `campaignService` carries: `cm_dial_process`, `cm_replenish_hopper`, `cm_update_master_hopper`, `cm_master_hopper_updated`, `cm_check_outcome`, `cm_end_campaign`, `campaign_runtime`.

HTTP sidecar: `POST /api/v1/internal/events/handle` (runtime side, called by koreserver).

---

## 3. Tenancy model

Koreserver uses a hierarchical multi-tenancy model:

- **`accountId`** — top-level enterprise account. Passed as `accountid` HTTP header.
- **`orgId`** — organization within the account. Derived from user context / token (`userContext.orgId`).
- **`streamId` / `iId` / `botId`** — XO bot instance. Passed as `iid` HTTP header and URL `:botId` parameter.
- **`userId`** — acting user, from token.

Every campaign call requires **at minimum** `accountId` + `iId` headers and either a JWT bearer token or an accepted apiKey.

---

## 4. Authentication — three mechanisms, one shared secret

### 4.1 User JWT (end-user / OAuth)

- **Endpoint:** `POST {KORE_HOST}/oAuth/token/jwtgrant` (`api/rest/oAuth.rest.js:323-334`)
- **Grant type:** `urn:ietf:params:oauth:grant-type:jwt-bearer`
- **Input:** a JWT `assertion` signed with a registered client app's `clientSecret`.
- **Output:** `{ authorization: { accessToken, token_type: 'bearer', expiresDate }, userInfo: { userId, accountId, orgId, ... } }`
- **Scopes for campaigns:** `campaign_management`, `campaign_integration` (see `uxo_SeedData.json:1936-1948`).
- **Used on:** public-facing routes (`/api/public/*`, `/api/v1.1/rest`), most user-initiated koreserver routes, and runtime public routes `/api/v1/public/:botId/campaign/*` (where the token is forwarded to koreserver for validation).

### 4.2 Internal shared-secret apiKey

Single cluster-wide shared secret, env var `INTERNAL_AUTH_KEY`. Referenced in code as:

- `config.internal_apikey` (xocampaign-services, koreagentassist)
- `config.internalAuth.apikey` (koreserver)

Transported in header `apikey` (koreserver also accepts `mpkey`; see the JWT bypass below for `xo-api-key`).

**Middlewares:**

| Service             | Middleware                                                                         | File                                                                           |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| koreserver          | `InternalAuthMiddleware` (default + `isValidAPIKeyMiddleware` lightweight variant) | `api/middleware/InternalAuthMiddleware/index.js:15-154`                        |
| xocampaign-services | `internalAuth`                                                                     | `src/middlewares/internalAuth.js:17` (key from `src/config/config.js:1052`)    |
| koreagentassist     | `internalAuth`                                                                     | `src/middlewares/internalAuth.js:14-51` (key from `src/config/config.js:1513`) |

Koreserver mounts `internalAuthMW()` at specific routes plus a **catch-all at `bootmodules/AppServer/boot.js:444`**: `app.use('/api/internal', internalAuthMW())`. This means **every** `/api/internal/*` route is protected unless a route-specific override removes it.

**Caveat on xocampaign / koreagentassist:** three internal routes have no middleware at all — they rely on network isolation (see §6.2).

### 4.3 `xo-api-key` — JWT bypass in koreserver

Koreserver's JWT middleware explicitly accepts the internal apiKey as a full JWT bypass.

- **File:** `api/middleware/JwtAuthMiddleware/util.js:54-58`
- **Behavior:** If `req.headers['xo-api-key'] === config.internalAuth.apikey`, the middleware calls `next()` and skips JWT verification.
- **Consequence:** Any koreserver route in the JWT auth chain is callable with just `xo-api-key: <INTERNAL_AUTH_KEY>` — no bearer token, no user context.

### 4.4 `publicAPIAuth` — does NOT accept an apiKey from external callers

`publicAPIAuth` (on both xocampaign-services `src/middlewares/publicAPIAuth.js` and koreagentassist `src/middlewares/publicAPIAuth.js`) requires the caller to present a JWT-style auth header. It then POSTs to koreserver's `/api/1.1/internal/agentassist/auth/validate/publicAPI/{botId}/smartassist` with:

```js
headers: {
  apikey: config.internal_apikey,   // authenticates THIS service to koreserver
  ...reqHeaders,                    // includes the caller's bearer token
}
```

The `apikey` authenticates the calling service to koreserver — it is **not** an alternative to the user JWT on the public surface.

### 4.5 Cross-platform SSO (existing pattern)

Koreserver has a `CrossPlatformAuthService` at `api/services/CrossPlatformAuthService/index.js` with config `config/configs/authIdtoken.json`. It exchanges short-lived (120s), JTI-protected `id_token`s between `urn:kore:xo` and `urn:kore:agentic`. ABL can model its integration on this pattern if an SSO-style exchange is preferred over client-credentials.

---

## 5. Public API surface (runtime, port 3032)

Base: `POST /api/v1/public/:botId/campaign/...`
Guard: `publicAPIAuth(['campaign_management'])` or `publicAPIAuth(['campaign_integration'])`.
Headers required on every call: `Authorization: Bearer <token>`, `accountid: <accountId>`, `iid: <botId>`.

### 5.1 Campaign CRUD

| Method | Path                                                                    | Purpose                                                         |
| ------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| POST   | `/:botId/campaign?campaignType=voice\|sms`                              | Create campaign                                                 |
| POST   | `/:botId/campaign/getAllCampaignDetails`                                | List campaigns (body: `{type, limit, page, filters?, sortBy?}`) |
| GET    | `/:botId/campaign/:campId`                                              | Get campaign                                                    |
| PUT    | `/:botId/campaign/:campId?campaignType=...`                             | Update campaign                                                 |
| DELETE | `/:botId/campaign/:campId?campaignType=...`                             | Delete campaign                                                 |
| POST   | `/:botId/campaign/:campId/status?view=status\|contacts`                 | Get campaign status                                             |
| POST   | `/:botId/campaign/schedule?enableSchedule=true\|false&campaignName=...` | Schedule / unschedule                                           |

### 5.2 Contact lists

| Method | Path                                                  | Purpose                                                  |
| ------ | ----------------------------------------------------- | -------------------------------------------------------- |
| POST   | `/:botId/campaign/contactList/createContactList`      | Create contact list (`source=passiveApi` for push-style) |
| GET    | `/:botId/campaign/contactList/getAllListDetails`      | List all contact lists                                   |
| GET    | `/:botId/campaign/contactList/:listId`                | Get list                                                 |
| PUT    | `/:botId/campaign/contactList/:listId`                | Update list                                              |
| DELETE | `/:botId/campaign/contactList/:listId`                | Delete list                                              |
| GET    | `/:botId/campaign/contactList/:listId/getAllContacts` | Get contacts in a list                                   |

**Gap:** xocampaign-services exposes no public `addContacts` endpoint — contact push for `passiveApi` lists lives in **koreserver** (see §6.1).

### 5.3 Campaign trigger (start / stop)

| Method | Path                                                                  | Purpose                                           |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------- |
| POST   | `/:botId/campaign/:campId?trigger=play\|stop&campaignType=voice\|sms` | Start or stop a campaign                          |
| POST   | `/:botId/campaign/:campId/dispositions`                               | Submit dispositions (scope `campaign_management`) |
| POST   | `/:botId/campaign/agents/:agentId/info`                               | Agent info (scope `campaign_integration`)         |
| POST   | `/:botId/campaign/agents/:agentId/status`                             | Agent availability (scope `campaign_integration`) |

---

## 6. Internal API surface

### 6.1 koreserver — `/api/internal/campaignmanagement/campaign/*`

Mount prefix `/api` (from `APIURL_PREFIX` in `api/load_modules.js`) + getMappings key `/internal/campaignmanagement` + nested `/campaign`.
Auth: `InternalAuthMiddleware` via catch-all at `bootmodules/AppServer/boot.js:444`.
File: `api/rest/campaignManagement.Internal.rest.js`.

| Method | Path (full)                                                         | Handler                                 | Purpose                          |
| ------ | ------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| GET    | `/api/internal/campaignmanagement/campaign/callFlows`               | `getCFDetails`                          | Callflow details by IDs          |
| GET    | `/api/internal/campaignmanagement/campaign/voiceAppDetails`         | `getVoiceAppDetails`                    | Voice app config                 |
| POST   | `/api/internal/campaignmanagement/campaign/getFileData`             | `getFileDataById`                       | Contact-list file data           |
| POST   | `/api/internal/campaignmanagement/campaign/action`                  | `campaignAction`                        | **Start / pause campaign**       |
| POST   | `/api/internal/campaignmanagement/campaign/runtime`                 | `campaignRuntime`                       | **Runtime event handling**       |
| POST   | `/api/internal/campaignmanagement/campaign/schedule/trigger`        | `webCampaignTrigger`                    | **Trigger a web campaign**       |
| POST   | `/api/internal/campaignmanagement/campaign/updateFeature`           | `updateFeatureFlag`                     | SmartAssist feature flags        |
| POST   | `/api/internal/campaignmanagement/campaign/contactTracker/delete`   | `deleteActiveCallContacts`              | Purge active-call tracker        |
| POST   | `/api/internal/campaignmanagement/campaign/createBotsessionWithCDR` | `createBotsessionWithCDR`               | Bot session for preview campaign |
| POST   | `/api/internal/campaignmanagement/campaign/handleSkipConversation`  | `handleAgentSkippedPreviewConversation` | Agent skip handling              |
| POST   | `/api/internal/campaignmanagement/campaign/connectUserAndAgent`     | `connectUserAndAgent`                   | Power-campaign bridge            |
| GET    | `/api/internal/campaignmanagement/campaign/dockStatus`              | `getDockStatusByJobTypeAndIId`          | Dock/job status                  |
| POST   | `/api/internal/campaignmanagement/campaign/callflow/voiceDetails`   | `getCallflowsVoiceDetails`              | Voice details per callflow       |
| POST   | `/api/internal/campaignmanagement/campaign/sms`                     | `createSMSCampaign`                     | Create SMS campaign              |
| PUT    | `/api/internal/campaignmanagement/campaign/sms/:campaignId`         | `updateSMSCampaign`                     | Update SMS campaign              |
| DELETE | `/api/internal/campaignmanagement/campaign/sms/:campaignId`         | `deleteSMSCampaign`                     | Delete SMS campaign              |
| POST   | `/api/internal/campaignmanagement/campaign/sms/trigger/:campaignId` | `startStopSMSCampaign`                  | Start/stop SMS campaign          |
| POST   | `/api/internal/campaignmanagement/campaign/sms/callflows`           | `getCallflowsAndNumbers`                | SMS callflow lookup              |
| POST   | `/api/internal/campaignmanagement/campaign/sms/getAllCampaigns`     | `getFilteredSMSCampaignsList`           | List SMS campaigns               |

Plus two campaign-adjacent internal routes under agentassist (`api/rest/AgentAssist.rest.js`):

| Method | Path                                                             | Handler                                   | Purpose                            |
| ------ | ---------------------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| GET    | `/api/internal/agentassist/campaign/callFlows`                   | `getCFDetails` (line 3025)                | Callflow details                   |
| POST   | `/api/internal/agentassist/campaign/updateAllWebCampaignDetails` | `updateAllWebCampaignDetails` (line 3037) | Sync active web campaigns to Redis |

Single public-auth campaign route in koreserver (this is what covers the contact-push gap):

| Method | Path                                                     | Handler                  | Auth                                                                                       |
| ------ | -------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| POST   | `/api/public/:streamId/campaign/contactList/addContacts` | `addContactToPublicList` | `publicApiAuthMW()` scope `campaign_management` (file `api/rest/PublicAPIs.rest.js:10169`) |

### 6.2 xocampaign-services — `/api/v1/internal/*` and `/api/v1/trigger/*`

Mount: `src/app.js` via `cmV1/index.js`.
Guard: `src/middlewares/internalAuth.js` (`req.headers.apikey === config.internal_apikey`).

| Method | Path                                                            | Auth                    | Purpose                                             |
| ------ | --------------------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| POST   | `/api/v1/internal/events/handle`                                | **NONE**                | Receive dialer state-machine events from koreserver |
| GET    | `/api/v1/internal/campaign/details`                             | **NONE**                | Campaign lookup                                     |
| GET    | `/api/v1/internal/campaign/keysInfo`                            | **NONE**                | Redis key lookup                                    |
| POST   | `/api/v1/internal/campaigns/active/status`                      | `internalAuth`          | Active-campaign check per queue                     |
| POST   | `/api/v1/internal/web/scheduler`                                | `internalAuth`          | Create web campaign schedule                        |
| POST   | `/api/v1/internal/web/agenda`                                   | `internalAuth`          | Update operational-hours agenda                     |
| POST   | `/api/v1/internal/campaigns/agents/status-change`               | `internalAuth`          | Agent status change                                 |
| POST   | `/api/v1/internal/campaign/removeAgentFromCampaignConversation` | `internalAuth`          | Release agent dial lock                             |
| POST   | `/api/v1/internal/:botId/campaign/:campId/dispositions`         | `internalAuth`          | Disposition creation                                |
| POST   | `/api/v1/internal/campaigns/handle/pause`                       | `internalAuth`          | Pause on error                                      |
| POST   | `/api/v1/internal/:agentId/campaigns/previewConversation`       | `internalAuth`          | Preview-mode conversation bootstrap                 |
| POST   | `/api/v1/internal/campaigns/experienceflow/update`              | `internalAuth`          | Sync experience flow to Redis                       |
| POST   | `/api/v1/internal/campaigns/agentConversationKey/update`        | `internalAuth`          | Sync agent conversation key to Redis                |
| POST   | `/api/v1/internal/agendaBGEnvSwitch`                            | `internalAuth`          | Blue/green switch                                   |
| GET    | `/api/v1/trigger/:campId?trigger=play\|pause\|stop\|resume`     | user JWT                | UI-facing trigger                                   |
| POST   | `/api/v1/trigger/callStatus`                                    | **NONE** (SAVG webhook) | Call status callback                                |
| POST   | `/api/v1/trigger/agent/callStatus`                              | **NONE** (SAVG webhook) | Agent call status callback                          |

XOCC app (`src/app_XOCC.js`) additionally exposes:

| Method | Path                                                   | Auth           | Purpose                     |
| ------ | ------------------------------------------------------ | -------------- | --------------------------- |
| GET    | `/api/v1/internal/campaigns/agents`                    | `internalAuth` | Agents for campaigns        |
| GET    | `/api/v1/internal/campaigns/agents/count`              | `internalAuth` | Total agents count          |
| GET    | `/api/v1/internal/campaigns/agents/:aId/online-status` | `internalAuth` | Agent online status         |
| POST   | `/api/v1/internal/campaigns/conversations/close`       | `internalAuth` | Close campaign conversation |

### 6.3 koreagentassist — campaign runtime (`src/app_campaignRuntime.js`)

Effectively the same route surface as xocampaign-services (same deployment shape). Differences noted:

- Does not expose `agendaBGEnvSwitch`
- Does not expose `previewConversation`
- Does not expose `agentConversationKey/update`

Everything else mirrors §6.2, including the three unauthenticated endpoints and the unauthenticated SAVG webhook.

### 6.4 Unauthenticated endpoints — risk summary

The following endpoints have **no auth middleware** and rely entirely on network isolation:

- `POST /api/v1/internal/events/handle` (xocampaign + koreagentassist)
- `GET /api/v1/internal/campaign/details` (xocampaign + koreagentassist)
- `GET /api/v1/internal/campaign/keysInfo` (xocampaign + koreagentassist; validation only)
- `POST /api/v1/trigger/callStatus` (xocampaign + koreagentassist — SAVG webhook)
- `POST /api/v1/trigger/agent/callStatus` (xocampaign — SAVG webhook)

Do **not** expose these beyond the cluster boundary. If ABL replicates any of this surface, add an apiKey or signed-webhook check.

---

## 7. RabbitMQ / KoreQ campaign job definitions

Directory: `koreserver/services/KoreQ/jobFlows/campaignService/` — 32 jobs.

Voice:
`campaign_creation`, `campaign_runtime`, `campaign_conversation_logs`, `campaign_conversation_logs_download`, `campaign_DNC_enrollment`, `cm_dial_process`, `cm_check_outcome`, `cm_resume_dialing`, `cm_replenish_hopper`, `cm_update_master_hopper`, `cm_master_hopper_updated`, `cm_contact_list_creation_api`, `cm_cancel_fetch_contacts_from_api`, `cm_download_external_api_audit_logs`, `cm_download_runtime_audit_logs`, `contact_list_creation`, `add_contacts_to_public_list`, `delete_contact_call_tracker`.

SMS:
`sms_campaign_creation`, `sms_campaign_runtime`, `sms_cm_dial_process`, `sms_cm_check_outcome`, `sms_cm_resume_dialing`, `sms_cm_calling_hours_completed`, `sms_update_dialing_queue`.

Web / misc:
`export_web_campaigns`, `import_web_campaigns`, `update_cdl_session`, `pwe_response_rtm`, `pwe_time_trends`, `health_check`, `job_error`.

Config: `config/configs/rabbitmq.json:541` (vhost `campaignService`), `config/configs/koreq.json:383` (worker config).

---

## 8. Service discovery / config

**koreserver config file:** `config/configs/campaign_service.json`

```json
{
  "campaignServiceUrl": "http://localhost:3032",
  "customerEngagementServiceUrl": "http://localhost:3033"
}
```

Resolved via `config.campaign_service.campaignServiceUrl` and used as a URI template base. No dynamic service registry — static config with env-overlay.

**xocampaign outbound calls to koreserver** (sample files that embed `apikey: config.internal_apikey`):

- `src/services/user.platform.service.js` (15+ calls)
- `src/services/reports.service.js:1207, 1225, 1242, 1260`
- `src/services/email.service.js:42`
- `src/services/queueAgents.service.js:179`
- `src/services/postcallanalysis.service.js:25`
- `src/services/pcdefaultsettings.service.js:190`
- `src/services/aaWidgetHistory.service.js:13`
- `src/services/queueMonitorAgents.service.js:244`
- `src/dialer/httpKoreAgentConnector.js`, `src/dialer/lib/power.js`, `src/dialer/lib/preview.js`, `src/dialer/lib/baseAgentDialer.js`

**koreserver outbound calls to the runtime** (sample callsites):

- `api/services/CampaignManagementService/web/WebCampaignService.js:30-34`
- `api/services/campaigns/campaignRuntimeForRMQ.js:87-91`
- `Templates/services/CampaignManagement/campaignExternalApiService.js:473-477`
- `api/services/AgentAssistService.js:5887-5891`
- `api/services/KoreVGListener.js:7981-7986`

---

## 9. Integration options for ABL platform

### Option 1 — Trusted cluster peer (internal apiKey)

Use the shared `INTERNAL_AUTH_KEY` directly.

- `apikey: <INTERNAL_AUTH_KEY>` for any `/api/internal/*` route on koreserver or runtime.
- `xo-api-key: <INTERNAL_AUTH_KEY>` to bypass JWT on any JWT-protected koreserver route.
- Always send `accountid` + `iid` headers for tenant/bot scoping.

Trade-offs:

- Simplest wiring: one env var, one header.
- No per-tenant, per-user, or per-scope restriction — the key is cluster-admin.
- Only safe if ABL runs inside the Kore cluster / shared trust boundary.
- Not auditable per caller.

### Option 2 — JWT-assertion grant (client app)

Register ABL as a client app with scopes `campaign_management` + `campaign_integration`. For every operation:

1. Sign a JWT with the client's `clientSecret`.
2. `POST {KORE_HOST}/oAuth/token/jwtgrant` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<signed-jwt>` to obtain an access token.
3. Use the bearer token + `accountid` + `iid` headers on public APIs.

Trade-offs:

- Correct pattern for external systems — per-tenant scoping, audit trail, scope limits.
- More moving parts (client-app registration, token refresh).
- Use this when ABL sits outside the Kore cluster or serves multiple tenants.

### Option 3 — Cross-platform SSO (mirror of XO <-> Agentic)

Reuse the design of `CrossPlatformAuthService` (`config/configs/authIdtoken.json`) to exchange short-lived JTI-protected `id_token`s between ABL and koreserver. Good when ABL needs user-originated sessions rather than M2M.

### Option 4 — Hybrid (most practical)

- Option 2 for user-originated actions (create campaign, list campaigns — bearer token).
- Option 1 for back-office / batch / coordination (`/api/internal/campaignmanagement/campaign/*` routes) where no user is in the loop.

---

## 10. Concrete: trigger a voice campaign from ABL end-to-end

Assume ABL has a service-account JWT (Option 2) or the cluster-internal apiKey (Option 1). Replace `$AUTH_HEADERS` below with either:

- Option 2: `Authorization: Bearer $TOKEN`, `accountid: $ACCOUNT_ID`, `iid: $BOT_ID`
- Option 1: `xo-api-key: $INTERNAL_AUTH_KEY`, `accountid: $ACCOUNT_ID`, `iid: $BOT_ID` (on koreserver JWT-gated routes); or `apikey: $INTERNAL_AUTH_KEY` (on `/api/internal/*`)

### Prerequisites

- A configured caller-ID phone number in SAVG
- A published experience-flow name (Agentless) or a queue name (agent-based modes)
- For agent modes: campaign agents assigned via `/api/v1/public/:botId/campaign/agents/:agentId/info`

### Step 1. Create a contact list (`passiveApi` source)

```
POST {CAMPAIGN_HOST}/api/v1/public/{botId}/campaign/contactList/createContactList
$AUTH_HEADERS
{
  "name": "abl-outreach-2026-04-21",
  "source": "passiveApi",
  "allowDuplicates": false
}
```

Response returns `listId` (prefix `cl-`).

### Step 2. Push contacts — via koreserver

Runtime services do not expose a public `addContacts` endpoint. Use koreserver's:

```
POST {KORE_HOST}/api/public/{streamId}/campaign/contactList/addContacts
$AUTH_HEADERS
{
  "listId": "<cl-...>",
  "contacts": [
    { "phoneNumber": "+1XXXXXXXXXX", "firstName": "Jane", "lastName": "Doe" }
  ]
}
```

Alternative: set list `source=apiIntegration` and have xocampaign pull contacts from an ABL webhook.

### Step 3. Create the campaign

```
POST {CAMPAIGN_HOST}/api/v1/public/{botId}/campaign?campaignType=voice
$AUTH_HEADERS
{
  "name": "abl-campaign-1",
  "contactLists": ["abl-outreach-2026-04-21"],
  "dncLists": { "name": "Global DNC List" },
  "campaignType": "voice",
  "dialingMode": "Agentless",
  "dialingStrategy": {
    "callerId": { "phoneNumber": "+1XXXXXXXXXX" },
    "dialingOrder": "FIFO",
    "maxAttemptsPerRecord": 1,
    "maxRingTime": 30,
    "callingHours": {
      "frequency": "WEEKLY",
      "timezone": "America/New_York",
      "days": [{ "day": "MO", "start": "9:00 AM", "end": "6:00 PM" }]
    }
  },
  "experienceFlowName": "my-ivr-flow"
}
```

Response returns campaign `id` (prefix `cd-`).

### Step 4. Start it

```
POST {CAMPAIGN_HOST}/api/v1/public/{botId}/campaign/{campId}?trigger=play&campaignType=voice
$AUTH_HEADERS
{}
```

Response: `{ status, campaignInstanceId, totalCallsCompleted }`.

Use `trigger=stop|pause|resume` for lifecycle transitions. For scheduling instead of immediate start:

```
POST {CAMPAIGN_HOST}/api/v1/public/{botId}/campaign/schedule?enableSchedule=true&campaignName=abl-campaign-1
$AUTH_HEADERS
{
  "startDateTime": "2026-04-22 14:00:00",
  "endDateTime":   "2026-04-22 18:00:00",
  "timezone": "America/New_York"
}
```

### Step 5. Observe

- Poll: `POST /api/v1/public/{botId}/campaign/{campId}/status?view=status` (or `?view=contacts`).
- Or subscribe: have koreserver forward campaign lifecycle events to an ABL webhook (mirror of the SAVG-callback pattern at `/api/v1/trigger/callStatus`).

### Internal alternative (Option 1 only, inside the cluster)

Same outcome achievable via:

```
POST {KORE_HOST}/api/internal/campaignmanagement/campaign/action
apikey: $INTERNAL_AUTH_KEY
accountid: $ACCOUNT_ID
iid: $BOT_ID
{ "campaignId": "<cd-...>", "action": "play" }
```

and

```
POST {KORE_HOST}/api/internal/campaignmanagement/campaign/runtime
apikey: $INTERNAL_AUTH_KEY
...
```

These are the same verbs koreserver itself uses when coordinating with the runtime.

---

## 11. Decision summary / recommendation

1. **Preferred external path:** Option 2 (JWT-assertion grant) with scopes `campaign_management` + `campaign_integration`. Call `/api/v1/public/:botId/campaign/*` on the runtime for CRUD + trigger; call `/api/public/:streamId/campaign/contactList/addContacts` on koreserver for bulk contact ingestion.
2. **Preferred in-cluster path:** Option 1 (`xo-api-key` / `apikey`) against koreserver's `/api/internal/campaignmanagement/campaign/*`. Shortest wire, best for back-office coordination.
3. **Never expose:** the three unauthenticated internal endpoints on xocampaign / koreagentassist (`/api/v1/internal/events/handle`, `/api/v1/internal/campaign/details`, `/api/v1/internal/campaign/keysInfo`) or the SAVG webhooks. They rely on network isolation.
4. **Transparency:** `koreagentassist` does not need to appear in ABL's mental model — it's the runtime. ABL talks to koreserver (and optionally the runtime's public API).
5. **Config to request from the platform team:**
   - `KORE_HOST`, `CAMPAIGN_HOST` (or the combined `campaignServiceUrl`)
   - Either a client-app `clientId`/`clientSecret` (Option 2) or `INTERNAL_AUTH_KEY` (Option 1)
   - A SAVG-registered caller-ID phone number
   - A published experience-flow name (Agentless) or queue name (agent modes)

---

## 12. Open questions before designing the ABL integration

- **Trust boundary.** Is ABL inside the Kore cluster (Option 1 viable) or a separate platform (Option 2 required)?
- **Tenancy.** Does ABL serve a single Kore account or many? The answer drives client-app registration strategy.
- **SMS scope.** Are SMS campaigns in scope? `campaignType=sms` changes the create body and SMS templates live in koreserver's `SMSTemplateDetailsModel`.
- **Callbacks.** Does ABL want per-contact outcome webhooks (SAVG-style) or is polling `/status?view=contacts` acceptable?
- **Auth exchange.** If ABL adopts Option 2, does it register as a standalone client app or reuse the `CrossPlatformAuthService` XO <-> Agentic exchange design?
- **Contact ingestion shape.** Bulk push via koreserver `addContacts`, or have the runtime pull via `apiIntegration` + ABL webhook?

---

## 13. Key files / line references (quick index)

**xocampaign-services**

- `src/app.js`, `src/app_XOCC.js` — app mounts
- `src/routes/public/campaign.public.route.js` — public CRUD
- `src/routes/public/campaign.v1.public.runtime.route.js` — public start/stop
- `src/controllers/campaignManagement/campaign.public.controller.js` — public controllers
- `src/validations/campaignManagement/campaign.public.validator.js` — Joi schemas
- `src/middlewares/publicAPIAuth.js` — public auth (forwards to koreserver)
- `src/middlewares/internalAuth.js` — internal apiKey check
- `src/services/platformServices/publicAPIAuthValidation.service.js` — upstream call to koreserver validator
- `src/services/campaignManagement/campaignTrigger.service.js` — trigger logic
- `src/services/platformServices/campaign.platform.service.js` — koreserver integration calls
- `src/models/campaignManagement/*.js` — MongoDB models
- `src/dialer/` — dialer implementations (agentless, preview, progressive, power)

**koreagentassist**

- `src/index_campaignRuntime.js`, `src/app_campaignRuntime.js` — campaign runtime process
- `src/routes/cmV1/campaignInternalAPIs.routes.js` — internal routes
- `src/routes/cmV1/campaignTrigger.route.js` — trigger
- `src/routes/cmV1/campaignAgent.route.js` — agent routes
- `src/routes/public/campaign.public.runtime.route.js` — public routes
- `src/middlewares/internalAuth.js`, `src/middlewares/publicAPIAuth.js`, `src/middlewares/auth.js`
- `src/services/campaignManagement/campaignInternalAPIs.services.js` — core dialer state machine
- `src/services/platformServices/campaign.platform.service.js` — koreserver integration calls
- `src/schedulers/campaignManagement/*` — Agenda handlers

**koreserver**

- `api/rest/CampaignManagement.rest.js` — public-facing CRUD
- `api/rest/campaignManagement.Internal.rest.js` — internal routes (§6.1)
- `api/rest/PublicAPIs.rest.js:10168-10191` — `addContacts` public endpoint
- `api/rest/oAuth.rest.js:323-334` — JWT-assertion grant
- `api/middleware/InternalAuthMiddleware/index.js` — internal apiKey
- `api/middleware/JwtAuthMiddleware/util.js:54-58` — `xo-api-key` bypass
- `bootmodules/AppServer/boot.js:428-444` — where internal-auth is mounted
- `api/services/Oauth2Service.js:24-33` — token structure
- `api/services/CrossPlatformAuthService/index.js` + `config/configs/authIdtoken.json` — SSO pattern
- `api/services/CampaignManagementService/web/WebCampaignService.js` — web campaign service
- `api/services/CampaignInternalService.js` — internal campaign service
- `api/services/campaigns/campaignRuntimeForRMQ.js` — runtime via RabbitMQ
- `services/KoreQ/jobFlows/campaignService/` — 32 job definitions
- `config/configs/campaign_service.json` — service URL
- `config/configs/rabbitmq.json:541`, `config/configs/koreq.json:383` — queue config
