# Arch AI — Full Coverage Gap Analysis

> **Generated**: 2026-05-04
> **Goal**: Arch AI should be able to do everything the user can do manually in these menu areas: **Channels & Integrations**, **Agents**, **Auth**, **Tools**, **Knowledge**.
> **Method**: Walk every UI component, sub-tab, and action button in the Studio menu. Map each to Arch AI's current tools. Identify what's missing.

---

## 1. Agents — Current: NEAR-FULL, Target: FULL

### What the UI exposes

**Agent List Page** (`AgentListPage`)

- View all agents in list or topology canvas
- Create new agent
- Delete agent
- Duplicate agent
- Import agent (from ABL file)
- Filter/search agents

**Agent Editor Page** (`AgentEditorPage`) — 17 sections:

- Identity, Execution, Tools, Gather, Memory, Flow, Constraints, Guardrails, Behavior, Handoffs, Delegates, Escalation, OnStart, Error Handling, Completion, Templates, Definition (raw ABL)

**Agent Chat** (`ChatWithDebugPanel`)

- Send test messages to agent
- View debug pane (traces, tool calls, LLM reasoning)
- Session management (clear, restart)

### Current Arch AI Coverage

| Action                 | Arch Tool                                                 | Status                                                   |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| List agents            | `read_agent` (single), `platform_context`                 | **GAP** — no `list_agents` tool                          |
| Create new agent       | `propose_modification(isNew:true)` + `apply_modification` | COVERED                                                  |
| Edit all 17 sections   | `propose_modification(sections)` + `compile_abl`          | COVERED (16/17 FULL, Templates PARTIAL)                  |
| Delete agent           | —                                                         | **GAP** — no `delete_agent` tool                         |
| Duplicate agent        | —                                                         | **GAP** — no `duplicate_agent` tool                      |
| Import agent from file | `collect_file` + `compile_abl`                            | PARTIAL — can process file but no import-to-project tool |
| View topology          | `read_topology`                                           | COVERED                                                  |
| Send test message      | —                                                         | **GAP** — no `send_test_message` tool                    |
| View session debug     | `session_ops`, `query_traces`, `trace_diagnosis`          | COVERED                                                  |
| Clear/restart session  | —                                                         | **GAP** — no session reset tool                          |

### New Tools Needed

| Tool                             | Description                                                                  | Priority |
| -------------------------------- | ---------------------------------------------------------------------------- | -------- |
| `agent_ops(action: "list")`      | List all agents in project with summary (name, role, execution mode, health) | HIGH     |
| `agent_ops(action: "delete")`    | Delete an agent by name (with confirmation via `ask_user`)                   | HIGH     |
| `agent_ops(action: "duplicate")` | Duplicate an agent with new name                                             | MEDIUM   |
| `agent_ops(action: "import")`    | Import agent from uploaded ABL file into project                             | MEDIUM   |
| `chat_ops(action: "send")`       | Send a test message to an agent and return the response + trace              | HIGH     |
| `chat_ops(action: "reset")`      | Clear/restart a test session                                                 | MEDIUM   |

---

## 2. Channels & Deployments — Current: AWARENESS, Target: FULL

### What the UI exposes

**Deployments Page** (`DeploymentsPage`) — 3 tabs:

**Tab 1: Environments** (`EnvironmentsTab`)

- View 3 environments (dev, staging, production) with active deployment
- Create new deployment (snapshot current agents + config)
- Promote deployment (dev → staging → production)
- Retire deployment
- Rollback to previous deployment
- View deployment history
- Compare deployment variable snapshots
- Manage per-environment variables

**Tab 2: Channels** (`ChannelsTab`) — 3-level navigation:

- **Level 1 — Channel Catalog** (`ChannelCatalog`): Grid of 22 channel types organized by category
  - Messaging: Slack, Line, MS Teams, Email, WhatsApp, Messenger, Twilio SMS, Telegram, Zendesk, Instagram
  - SDK: Web SDK, Mobile SDK, API SDK
  - Webhook: HTTP Async
  - Voice: Voice Realtime (S2S), Voice Pipeline, Voice VXML, AudioCodes
  - Protocol: AG-UI, A2A, AI4W
- **Level 2 — Instance List** (`ChannelInstanceList`): List of connections/instances for a channel type
  - Create new instance
  - View status (active, inactive, error, paused)
  - Pause/resume instance
- **Level 3 — Instance Config** (`ChannelInstanceConfig`): 6 tabs per instance
  - **Overview**: Display name, status, environment binding, external identifier
  - **Credentials**: Channel-specific credential fields (bot tokens, signing secrets, API keys)
  - **Configuration**: Channel-specific settings (webhook URLs, widget config, identity verification)
  - **Deployment**: Environment assignment, follow-environment toggle
  - **Testing**: Send test message, verify webhook
  - **Activity**: Recent delivery log

**Tab 3: API Keys** (`ApiKeysTab`)

- Create/revoke project API keys

### Current Arch AI Coverage

| Action                        | Arch Tool | Status  |
| ----------------------------- | --------- | ------- |
| List deployments              | —         | **GAP** |
| Create deployment             | —         | **GAP** |
| Promote deployment            | —         | **GAP** |
| Retire deployment             | —         | **GAP** |
| Rollback deployment           | —         | **GAP** |
| Compare deployment snapshots  | —         | **GAP** |
| List channel types            | —         | **GAP** |
| List channel instances        | —         | **GAP** |
| Create channel instance       | —         | **GAP** |
| Configure channel credentials | —         | **GAP** |
| Configure channel settings    | —         | **GAP** |
| Bind channel to environment   | —         | **GAP** |
| Pause/resume channel          | —         | **GAP** |
| Test channel                  | —         | **GAP** |
| View channel activity         | —         | **GAP** |

### New Tools Needed

| Tool                                      | Description                                          | Priority |
| ----------------------------------------- | ---------------------------------------------------- | -------- |
| `deployment_ops(action: "list")`          | List deployments with environment/status filters     | HIGH     |
| `deployment_ops(action: "create")`        | Create deployment snapshot for an environment        | HIGH     |
| `deployment_ops(action: "promote")`       | Promote deployment to next environment               | HIGH     |
| `deployment_ops(action: "retire")`        | Retire active deployment                             | MEDIUM   |
| `deployment_ops(action: "rollback")`      | Rollback to previous deployment                      | MEDIUM   |
| `deployment_ops(action: "diff")`          | Compare variable snapshots between deployments       | LOW      |
| `channel_ops(action: "list_types")`       | List available channel types with capabilities       | HIGH     |
| `channel_ops(action: "list_instances")`   | List channel instances for a type                    | HIGH     |
| `channel_ops(action: "create")`           | Create new channel instance (SDK/connection/webhook) | HIGH     |
| `channel_ops(action: "configure")`        | Update channel credentials, settings, display name   | HIGH     |
| `channel_ops(action: "bind_environment")` | Bind channel to a deployment environment             | MEDIUM   |
| `channel_ops(action: "pause" / "resume")` | Pause or resume a channel instance                   | MEDIUM   |
| `channel_ops(action: "test")`             | Send test message through channel                    | MEDIUM   |
| `channel_ops(action: "delete")`           | Delete channel instance                              | MEDIUM   |
| `channel_ops(action: "activity")`         | View recent delivery activity                        | LOW      |

### Backend APIs Already Available

All the runtime APIs already exist — Arch just needs to call them:

- `GET/POST /api/projects/:pid/deployments` — list/create
- `POST /api/projects/:pid/deployments/:id/promote` — promote
- `POST /api/projects/:pid/deployments/:id/retire` — retire
- `POST /api/projects/:pid/deployments/:id/rollback` — rollback
- `GET/POST /api/projects/:pid/sdk-channels` — list/create SDK channels
- `PATCH/DELETE /api/projects/:pid/sdk-channels/:id` — update/delete
- `GET/POST /api/projects/:pid/channel-connections` — list/create connections
- `PATCH/DELETE /api/projects/:pid/channel-connections/:id` — update/delete

---

## 3. Auth Profiles — Current: PARTIAL, Target: FULL

### What the UI exposes

**Auth Profiles Page** (`AuthProfilesPage`) — 2 tabs:

**Tab 1: Auth Profiles** (main table)

- List all auth profiles with type, status, environment, consumer count
- Create new profile (7 auth types: none, api_key, bearer, oauth2_app, oauth2_token, oauth2_client_credentials, azure_ad)
- Edit profile in slide-over panel
- Delete profile
- Revoke profile (invalidate tokens)
- Bulk operations (delete multiple)
- View consumers (which tools/connections use this profile)
- Filter by type, status, environment

**Tab 2: Integration Auth** (`IntegrationAuthTab`)

- Pre-built provider integrations (e.g., Google, Microsoft, Salesforce)
- Guided OAuth flow for providers
- Provider-specific credential fields

**Auth Profile Slide-Over** (`AuthProfileSlideOver`)

- Name, description, environment
- Auth type configuration:
  - API Key: key name, key value, header/query placement
  - Bearer: static token
  - OAuth2 App: client ID, client secret, auth URL, token URL, scopes
  - OAuth2 Token: access token, refresh token, expiry
  - OAuth2 Client Credentials: client ID, client secret, token URL, scopes
  - Azure AD: tenant ID, client ID, client secret, scope
- Test connection
- View token status

### Current Arch AI Coverage

| Action                         | Arch Tool  | Status                       |
| ------------------------------ | ---------- | ---------------------------- |
| List auth profiles             | `auth_ops` | NEED TO VERIFY exact actions |
| Create auth profile            | `auth_ops` | NEED TO VERIFY               |
| Edit auth profile              | `auth_ops` | NEED TO VERIFY               |
| Delete auth profile            | —          | **LIKELY GAP**               |
| Revoke auth profile            | —          | **GAP**                      |
| Bulk operations                | —          | **GAP**                      |
| View consumers                 | —          | **GAP**                      |
| Integration auth (OAuth flows) | —          | **GAP**                      |
| Test connection                | —          | **GAP**                      |

### Verified auth_ops Implementation (`apps/studio/src/lib/arch-ai/tools/auth-ops.ts`)

`auth_ops` already supports **6 actions**: `list`, `read`, `create`, `update`, `delete`, `validate`

| UI Action                                                                        | auth_ops action | Status                                                                                   |
| -------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| List auth profiles                                                               | `list`          | **COVERED**                                                                              |
| Read single profile                                                              | `read`          | **COVERED**                                                                              |
| Create profile (4 types: api_key, bearer, oauth2_app, oauth2_client_credentials) | `create`        | **COVERED** (uses `collect_secret` flow for credentials)                                 |
| Update profile                                                                   | `update`        | **COVERED**                                                                              |
| Delete profile                                                                   | `delete`        | **COVERED** (with confirmation guard)                                                    |
| Validate/test profile                                                            | `validate`      | **COVERED** (calls `/auth-profiles/:id/validate`)                                        |
| Revoke profile                                                                   | —               | **GAP** — no revoke action                                                               |
| View consumers                                                                   | —               | **GAP** — no consumers query                                                             |
| Bulk operations                                                                  | —               | **GAP** — single-item only                                                               |
| OAuth2 Token type                                                                | —               | **GAP** — only 4 of 7 auth types supported (missing: `oauth2_token`, `azure_ad`, `none`) |
| Integration Auth (provider catalog)                                              | —               | **GAP** — no provider-guided OAuth flow                                                  |

### New Tools / Extensions Needed

| Tool                             | Description                                                      | Priority                                 |
| -------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| `auth_ops(action: "revoke")`     | Revoke/invalidate profile tokens                                 | MEDIUM                                   |
| `auth_ops(action: "consumers")`  | List tools/connections using this profile                        | MEDIUM                                   |
| Auth type expansion              | Add `oauth2_token`, `azure_ad`, `none` to `SUPPORTED_AUTH_TYPES` | HIGH                                     |
| `auth_ops(action: "oauth_flow")` | Initiate OAuth flow for provider integrations                    | LOW — complex, requires browser redirect |

---

## 4. Tools — Current: FULL (mostly), Target: FULL

### What the UI exposes

**Tools List Page** (`ToolsListPage`) — tabbed:

- **HTTP Tools tab**: List/create/edit HTTP API tools
- **Function Tools tab**: List/create/edit function tools
- **KB Tools tab**: List KB-linked tools
- **MCP Tools tab**: List MCP-imported tools + MCP server management

**Tool Detail Page** (`ToolDetailPage`)

- Edit name, description
- Configure endpoint URL (with env variable substitution)
- HTTP method, headers, body template
- Auth profile binding
- Input/output schema
- Test execution with sample parameters
- View invocation history

**Tool Create Page** (`ToolCreatePage`)

- Wizard for new tool (type selection → configuration → test)

**MCP Server Detail** (`McpServerDetailPage`)

- Configure MCP server URL, auth
- Discover tools from server
- Import discovered tools into project
- Test connection

### Current Arch AI Coverage

| Action                  | Arch Tool                            | Status                                 |
| ----------------------- | ------------------------------------ | -------------------------------------- |
| List tools              | `tools_ops(action: "list")`          | COVERED                                |
| Create tool             | `tools_ops(action: "create")`        | COVERED                                |
| Edit tool               | `tools_ops(action: "update")`        | COVERED                                |
| Delete tool             | `tools_ops(action: "delete")`        | COVERED                                |
| Bind auth profile       | `auth_ops` + `tools_ops`             | COVERED                                |
| Test tool execution     | `tools_ops(action: "test")`          | **COVERED** — verified in tools-ops.ts |
| View invocation history | —                                    | **GAP** — no tool invocation log query |
| MCP server CRUD         | `mcp_server_ops`                     | COVERED                                |
| MCP discover            | `mcp_server_ops(action: "discover")` | COVERED                                |
| MCP import              | `mcp_server_ops(action: "import")`   | COVERED                                |
| MCP test                | `mcp_server_ops(action: "test")`     | COVERED                                |

### Verified tools_ops Implementation

`tools_ops` supports **6 actions**: `read`, `list`, `create`, `update`, `test`, `delete` — all core CRUD + test is covered.

### Remaining Gaps

| Tool                               | Description                                | Priority |
| ---------------------------------- | ------------------------------------------ | -------- |
| `tools_ops(action: "invocations")` | Query recent invocation history for a tool | MEDIUM   |

---

## 5. Knowledge Bases — Current: PARTIAL, Target: FULL

### What the UI exposes

**KB Dashboard** (`KnowledgeBaseDashboardPage`)

- List all knowledge bases with health status
- Create new KB (name, description, embedding model)
- Delete KB

**KB Detail** (`KnowledgeBaseDetailPage`) — 4 sections:

**Section 1: Home** (`KBOverviewTab`)

- Overview stats (document count, chunk count, last sync)
- Source list with sync status
- Quick actions

**Section 2: Data** — Sub-components:

- **Sources**: Add/remove data sources (file upload, crawl, connector)
- **Chunk Explorer** (`ChunkExplorer`): Browse chunks, view content, metadata
- **Structured Data Schema** (`StructuredDataSchemaDialog`): Define custom fields
- **Vocabulary** (`VocabularyTab`): Custom vocabulary entries, synonyms, test panel
- **Connector Management**: Add enterprise connectors (SharePoint, Google Drive, etc.)
- **Crawl Configuration** (`CrawlJobForm`): Configure web crawl sources, domains, schedules
- **Bulk Import** (`BulkImportForm`): Mass document upload

**Section 3: Intelligence** — Sub-components:

- **Knowledge Graph** (`KnowledgeGraphTab`): Enable/configure KG, view force graph, taxonomy
- **Embedding Model** (`EmbeddingModelSection`): Select/change embedding model
- **Query Pipeline LLM** (`QueryPipelineLLMSection`): Configure LLM for query augmentation
- **Custom Domain Generator** (`CustomDomainGenerator`): Generate domain-specific vocabulary
- **Organization Profile** (`OrgProfileGenerator`): Auto-generate org context

**Section 4: Search & Test** — Sub-components:

- **Query Playground** (`QueryPlaygroundTab`): Test queries against KB, see retrieved chunks
- **Feedback Review** (`feedback/`): Review search quality feedback

### Current Arch AI Coverage

| Action                       | Arch Tool      | Status                                         |
| ---------------------------- | -------------- | ---------------------------------------------- |
| List KBs                     | `kb_manage`    | COVERED                                        |
| Create KB                    | `kb_manage`    | COVERED                                        |
| Delete KB                    | `kb_manage`    | NEED TO VERIFY                                 |
| View KB health               | `kb_health`    | COVERED                                        |
| Add sources                  | `kb_ingest`    | COVERED                                        |
| Remove sources               | —              | **GAP**                                        |
| Browse chunks                | `kb_documents` | PARTIAL — may not support pagination/filtering |
| Configure structured schema  | —              | **GAP**                                        |
| Manage vocabulary            | —              | **GAP**                                        |
| Add connector                | `kb_connector` | COVERED                                        |
| Configure crawl              | —              | **GAP**                                        |
| Bulk import                  | `kb_ingest`    | PARTIAL — single ingest, not bulk              |
| Enable/configure KG          | —              | **GAP**                                        |
| Change embedding model       | —              | **GAP**                                        |
| Configure query pipeline LLM | —              | **GAP**                                        |
| Test query                   | `kb_search`    | COVERED                                        |
| Review feedback              | —              | **GAP**                                        |

### New Tools / Extensions Needed

| Tool                                   | Description                                              | Priority                           |
| -------------------------------------- | -------------------------------------------------------- | ---------------------------------- |
| `kb_manage(action: "delete")`          | Delete a knowledge base                                  | HIGH — verify if already supported |
| `kb_manage(action: "configure")`       | Update KB settings (embedding model, query pipeline LLM) | HIGH                               |
| `kb_ingest(action: "remove_source")`   | Remove a data source from KB                             | HIGH                               |
| `kb_ingest(action: "bulk_upload")`     | Bulk import documents                                    | MEDIUM                             |
| `kb_ingest(action: "configure_crawl")` | Set up web crawl with domain/schedule config             | MEDIUM                             |
| `kb_documents(action: "browse")`       | Paginated chunk browsing with filters                    | MEDIUM                             |
| `kb_manage(action: "schema")`          | Define/update structured data schema fields              | MEDIUM                             |
| `kb_manage(action: "vocabulary")`      | Add/edit vocabulary entries and synonyms                 | MEDIUM                             |
| `kb_manage(action: "knowledge_graph")` | Enable KG, configure taxonomy, models                    | LOW — complex feature              |
| `kb_manage(action: "feedback")`        | Query search quality feedback                            | LOW                                |

---

## 6. Integrations / Connections — Current: PARTIAL, Target: FULL

### What the UI exposes

**Connections Page** (`ConnectionsPage`) — 2 tabs:

**Tab 1: My Connections**

- List active connections with status (healthy, error, expired)
- Expand inline to see details
- Edit connection credentials
- Test connection
- Delete connection

**Tab 2: Connector Catalog**

- Grid of available connectors organized by category:
  - Agent Desktop: Five9, Kore, Genesys (agent transfer adapters)
  - CRM: Salesforce, HubSpot, etc.
  - Storage: Google Drive, SharePoint, Dropbox, Box
  - Communication: Slack, Teams, Email
  - Ticketing: Zendesk, ServiceNow, Jira
- "Connect" button launches creation modal

**Create Connection Modal** (`CreateConnectionModal`)

- Select connector type
- Enter credentials (OAuth or API key)
- Test connection
- Name and save

**External Agents Page** (`ExternalAgentsPage`)

- Register external A2A/REST agent endpoints
- Test connection to external agent
- Edit configuration
- Delete registration

### Current Arch AI Coverage

### Verified integration_ops Implementation (`apps/studio/src/lib/arch-ai/tools/integration-ops.ts`)

**`integration_ops` is NOT a connections CRUD tool.** It manages "integration drafts" — Arch AI's internal workflow state for multi-step integration setup flows. Actions: `start`, `get_active`, `list`, `update`, `run_tool_test`, `complete`, `archive`.

This means **ALL connection/connector CRUD is a gap** — `integration_ops` orchestrates the Arch-side flow but doesn't call the runtime connections API.

| UI Action               | Current Tool | Status                              |
| ----------------------- | ------------ | ----------------------------------- |
| List connections        | —            | **GAP** — no connections API client |
| Create connection       | —            | **GAP**                             |
| Edit connection         | —            | **GAP**                             |
| Test connection         | —            | **GAP**                             |
| Delete connection       | —            | **GAP**                             |
| List connectors catalog | —            | **GAP**                             |
| Register external agent | —            | **GAP**                             |
| Test external agent     | —            | **GAP**                             |
| Edit external agent     | —            | **GAP**                             |
| Delete external agent   | —            | **GAP**                             |

### New Tools Needed

| Tool                                     | Description                                | Priority |
| ---------------------------------------- | ------------------------------------------ | -------- |
| `connection_ops(action: "list")`         | List active connections with status        | HIGH     |
| `connection_ops(action: "create")`       | Create connection with credentials         | HIGH     |
| `connection_ops(action: "read")`         | Get connection details                     | HIGH     |
| `connection_ops(action: "update")`       | Update connection credentials/config       | HIGH     |
| `connection_ops(action: "test")`         | Test connection health                     | HIGH     |
| `connection_ops(action: "delete")`       | Delete connection                          | HIGH     |
| `connection_ops(action: "catalog")`      | List available connector types by category | MEDIUM   |
| `external_agent_ops(action: "list")`     | List registered external agents            | HIGH     |
| `external_agent_ops(action: "register")` | Register new external A2A/REST agent       | HIGH     |
| `external_agent_ops(action: "test")`     | Test connection to external agent          | HIGH     |
| `external_agent_ops(action: "update")`   | Update external agent config               | MEDIUM   |
| `external_agent_ops(action: "delete")`   | Delete external agent registration         | MEDIUM   |

### Backend APIs Already Available

- `GET/POST /api/projects/:pid/connections` — list/create
- `GET/PUT/DELETE /api/projects/:pid/connections/:id` — read/update/delete
- `POST /api/projects/:pid/connections/:id/test` — test connection
- `GET/POST /api/projects/:pid/external-agents` — list/register
- `GET/PATCH/DELETE /api/projects/:pid/external-agents/:id` — read/update/delete
- `POST /api/projects/:pid/external-agents/:id/test-connection` — test

---

## Summary — Verified Gap List (Post Source Audit)

### What's Already Covered (no work needed)

| Domain               | Tool                                                                               | Actions Available                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Auth**             | `auth_ops`                                                                         | `list`, `read`, `create`, `update`, `delete`, `validate`                                                       |
| **Tools**            | `tools_ops`                                                                        | `list`, `read`, `create`, `update`, `test`, `delete`                                                           |
| **MCP**              | `mcp_server_ops`                                                                   | `create`, `update`, `test`, `discover`, `import`                                                               |
| **KB Core**          | `kb_manage`, `kb_ingest`, `kb_search`, `kb_health`, `kb_connector`, `kb_documents` | Core CRUD, ingest, search, health, connectors                                                                  |
| **Variables**        | `variable_ops`                                                                     | CRUD for config vars                                                                                           |
| **Integration Flow** | `integration_ops`                                                                  | Draft workflow orchestration (`start`, `get_active`, `list`, `update`, `run_tool_test`, `complete`, `archive`) |

### HIGH Priority — New Tools Required for Full Coverage

| #   | Tool                                     | Domain       | What it enables                                           | Backend API exists?                                                                     |
| --- | ---------------------------------------- | ------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `agent_ops(action: "list")`              | Agents       | List all agents with name, role, mode, health             | Yes — `GET /api/projects/:pid/agents`                                                   |
| 2   | `agent_ops(action: "delete")`            | Agents       | Delete agent by name                                      | Yes — `DELETE /api/projects/:pid/agents/:name`                                          |
| 3   | `chat_ops(action: "send")`               | Agents       | Send test message to agent, get response + trace          | Yes — WebSocket or `POST /api/projects/:pid/chat`                                       |
| 4   | `deployment_ops(action: "list")`         | Deploy       | List deployments by environment/status                    | Yes — `GET /api/projects/:pid/deployments`                                              |
| 5   | `deployment_ops(action: "create")`       | Deploy       | Snapshot current config into deployment                   | Yes — `POST /api/projects/:pid/deployments`                                             |
| 6   | `deployment_ops(action: "promote")`      | Deploy       | Promote deployment to next environment                    | Yes — `POST .../deployments/:id/promote`                                                |
| 7   | `channel_ops(action: "list_types")`      | Channels     | List 22 channel types with capabilities                   | No API needed — derive from `CHANNEL_REGISTRY`                                          |
| 8   | `channel_ops(action: "list_instances")`  | Channels     | List instances for a channel type                         | Yes — `GET /api/projects/:pid/sdk-channels` + `/channel-connections`                    |
| 9   | `channel_ops(action: "create")`          | Channels     | Create SDK channel or connection                          | Yes — `POST` on respective endpoints                                                    |
| 10  | `channel_ops(action: "configure")`       | Channels     | Update credentials, settings, display name                | Yes — `PATCH` on respective endpoints                                                   |
| 11  | `connection_ops(action: "list")`         | Integrations | List active connections with status                       | Yes — `GET /api/projects/:pid/connections`                                              |
| 12  | `connection_ops(action: "create")`       | Integrations | Create connector connection                               | Yes — `POST /api/projects/:pid/connections`                                             |
| 13  | `connection_ops(action: "test")`         | Integrations | Test connection health                                    | Yes — `POST .../connections/:id/test`                                                   |
| 14  | `connection_ops(action: "delete")`       | Integrations | Delete connection                                         | Yes — `DELETE .../connections/:id`                                                      |
| 15  | `external_agent_ops(action: "list")`     | Integrations | List registered external A2A/REST agents                  | Yes — `GET /api/projects/:pid/external-agents`                                          |
| 16  | `external_agent_ops(action: "register")` | Integrations | Register external agent endpoint                          | Yes — `POST /api/projects/:pid/external-agents`                                         |
| 17  | `external_agent_ops(action: "test")`     | Integrations | Test external agent connection                            | Yes — `POST .../external-agents/:id/test-connection`                                    |
| 18  | `auth_ops` type expansion                | Auth         | Add `oauth2_token`, `azure_ad`, `none` to supported types | Auth profile API supports all types — just `SUPPORTED_AUTH_TYPES` array needs expanding |
| 19  | `kb_manage(action: "configure")`         | Knowledge    | Update KB settings (embedding model, query LLM)           | Yes — SearchAI API                                                                      |
| 20  | `kb_ingest(action: "remove_source")`     | Knowledge    | Remove a data source from KB                              | Yes — SearchAI API                                                                      |

### MEDIUM Priority — Better Coverage

| #   | Tool                                   | Domain       | What it enables                          |
| --- | -------------------------------------- | ------------ | ---------------------------------------- |
| 21  | `agent_ops(action: "duplicate")`       | Agents       | Duplicate agent with new name            |
| 22  | `agent_ops(action: "import")`          | Agents       | Import agent from uploaded ABL file      |
| 23  | `chat_ops(action: "reset")`            | Agents       | Clear/restart test session               |
| 24  | `deployment_ops(action: "retire")`     | Deploy       | Retire active deployment                 |
| 25  | `deployment_ops(action: "rollback")`   | Deploy       | Rollback to previous deployment          |
| 26  | `channel_ops(action: "bind_env")`      | Channels     | Bind channel to deployment environment   |
| 27  | `channel_ops(action: "pause/resume")`  | Channels     | Pause/resume channel instance            |
| 28  | `channel_ops(action: "test")`          | Channels     | Test message through channel             |
| 29  | `channel_ops(action: "delete")`        | Channels     | Delete channel instance                  |
| 30  | `auth_ops(action: "revoke")`           | Auth         | Revoke/invalidate profile tokens         |
| 31  | `auth_ops(action: "consumers")`        | Auth         | Which tools/connections use this profile |
| 32  | `tools_ops(action: "invocations")`     | Tools        | Recent invocation history                |
| 33  | `kb_ingest(action: "bulk_upload")`     | Knowledge    | Mass document import                     |
| 34  | `kb_ingest(action: "configure_crawl")` | Knowledge    | Web crawl source config                  |
| 35  | `kb_documents(action: "browse")`       | Knowledge    | Paginated chunk browsing with filters    |
| 36  | `kb_manage(action: "schema")`          | Knowledge    | Structured data schema management        |
| 37  | `kb_manage(action: "vocabulary")`      | Knowledge    | Custom vocabulary + synonyms             |
| 38  | `connection_ops(action: "catalog")`    | Integrations | List available connector types           |
| 39  | `external_agent_ops(action: "update")` | Integrations | Update external agent config             |
| 40  | `external_agent_ops(action: "delete")` | Integrations | Delete external agent                    |

### LOW Priority

| #   | Tool                                   | Domain                              |
| --- | -------------------------------------- | ----------------------------------- |
| 41  | `deployment_ops(action: "diff")`       | Deploy — compare variable snapshots |
| 42  | `channel_ops(action: "activity")`      | Channels — delivery log             |
| 43  | `auth_ops(action: "oauth_flow")`       | Auth — browser-redirect OAuth       |
| 44  | `kb_manage(action: "knowledge_graph")` | KB — KG enable/configure            |
| 45  | `kb_manage(action: "feedback")`        | KB — search quality feedback        |

---

## Implementation Approach

1. **Verify existing tool schemas** — Check what `auth_ops` and `integration_ops` already support before building new.
2. **Group by backend API** — Most tools call the same runtime REST APIs the Studio UI calls. The tool executor just needs HTTP client wiring.
3. **Specialist routing** — New tools need to be added to the appropriate specialist tool maps in `packages/arch-ai/src/types/tools.ts`.
4. **Confirmation patterns** — Destructive actions (delete, revoke, retire) must go through `ask_user(widgetType:"Confirmation")` before executing.
5. **Page context integration** — When user is on Deployments page, Arch should automatically have deployment context. When on Channels, channel context. The `PageContext` entity types already support `'connection'` but need additions for `'deployment'`, `'channel_instance'`.
