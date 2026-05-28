# ABL Platform Feature Map

**Last Updated:** 2026-03-12
**Version:** CoWork/Builder (Arc Engine V2)
**Branch:** feature/arcbuilder

---

## Table of Contents

- [Project Navigation](#project-navigation)
- [Agent Editor Sections](#agent-editor-sections)
- [Arch AI Capabilities (In-Project)](#arch-ai-capabilities-in-project)
- [Knowledge & Search](#knowledge--search)
- [Connections & Integrations](#connections--integrations)
- [Testing & Quality](#testing--quality)
- [Operations & Monitoring](#operations--monitoring)
- [Analytics & Insights](#analytics--insights)
- [Governance & Security](#governance--security)
- [Feature Status Matrix](#feature-status-matrix)

---

## Project Navigation

### Main Menu (Project Sidebar)

#### **BUILD** Section

| Feature       | Route                     | Icon         | Status  | Description                                                        |
| ------------- | ------------------------- | ------------ | ------- | ------------------------------------------------------------------ |
| **Arch AI**   | `/projects/:id/arch-ai`   | ✨ Sparkles  | ✅ LIVE | AI-powered chat for project creation, agent modification, analysis |
| **Overview**  | `/projects/:id/overview`  | 📊 Dashboard | ✅ LIVE | Project dashboard with key metrics                                 |
| **Agents**    | `/projects/:id/agents`    | 🤖 Bot       | ✅ LIVE | Agent list, create, edit, test                                     |
| **Workflows** | `/projects/:id/workflows` | 🔄 Workflow  | ✅ LIVE | Workflow automation and approvals                                  |

#### **RESOURCES** Section

| Feature             | Route                       | Icon        | Status  | Description                                   |
| ------------------- | --------------------------- | ----------- | ------- | --------------------------------------------- |
| **Tools**           | `/projects/:id/tools`       | 🔧 Wrench   | ✅ LIVE | HTTP, MCP, Lambda, Sandbox tool definitions   |
| **Knowledge Bases** | `/projects/:id/search-ai`   | 📚 BookOpen | ✅ LIVE | RAG, vector search, document ingestion        |
| **Integrations**    | `/projects/:id/connections` | 🔌 Plug     | ✅ LIVE | External connectors (Salesforce, Slack, etc.) |

#### **EVALUATE** Group

| Feature         | Route                       | Icon            | Status     | Description                     |
| --------------- | --------------------------- | --------------- | ---------- | ------------------------------- |
| **Evals**       | `/projects/:id/evals`       | 🧪 FlaskConical | 🚧 PLANNED | Test scenarios, eval sets, runs |
| **Experiments** | `/projects/:id/experiments` | 🧪 FlaskConical | 🚧 PLANNED | A/B testing, versioning         |

#### **OPERATE** Group

| Feature         | Route                       | Icon             | Status     | Description                         |
| --------------- | --------------------------- | ---------------- | ---------- | ----------------------------------- |
| **Sessions**    | `/projects/:id/sessions`    | 💬 MessageSquare | ✅ LIVE    | Conversation history, traces, debug |
| **Deployments** | `/projects/:id/deployments` | 🚀 Rocket        | ✅ LIVE    | Deploy to dev/staging/production    |
| **Inbox**       | `/projects/:id/inbox`       | 📥 Inbox         | ✅ LIVE    | Workflow approvals                  |
| **Alerts**      | `/projects/:id/alerts`      | 🔔 Bell          | 🚧 PLANNED | Proactive notifications             |

#### **INSIGHTS** Group

| Feature               | Route                             | Icon          | Status     | Description                         |
| --------------------- | --------------------------------- | ------------- | ---------- | ----------------------------------- |
| **Dashboard**         | `/projects/:id/dashboard`         | 📈 TrendingUp | 🚧 PLANNED | Executive KPIs                      |
| **Agent Performance** | `/projects/:id/agent-performance` | ⚡ Activity   | 🚧 PLANNED | Per-agent diagnostics               |
| **Quality Monitor**   | `/projects/:id/quality-monitor`   | 👁️ Eye        | 🚧 PLANNED | Watchtower for quality issues       |
| **Customer Insights** | `/projects/:id/customer-insights` | ✨ Sparkles   | 🚧 PLANNED | Intent distribution, VoC, sentiment |

#### **GOVERN** Group

| Feature               | Route                             | Icon           | Status     | Description                |
| --------------------- | --------------------------------- | -------------- | ---------- | -------------------------- |
| **Guardrails Config** | `/projects/:id/guardrails-config` | 🛡️ ShieldAlert | 🚧 PLANNED | Guardrail policies         |
| **Governance**        | `/projects/:id/governance`        | 🏛️ Landmark    | 🚧 PLANNED | Agent registry, compliance |

#### **Bottom Section**

| Feature              | Route                    | Icon        | Status  | Description           |
| -------------------- | ------------------------ | ----------- | ------- | --------------------- |
| **Project Settings** | `/projects/:id/settings` | ⚙️ Settings | ✅ LIVE | Project configuration |

---

## Agent Editor Sections

### Available Sections (16 total)

| Section                  | Description                                   | Status  | Fields                                                |
| ------------------------ | --------------------------------------------- | ------- | ----------------------------------------------------- |
| **Identity**             | Name, description, personality                | ✅ LIVE | `name`, `description`, `personality`                  |
| **Execution**            | LLM model, temperature, max tokens            | ✅ LIVE | `model`, `temperature`, `maxTokens`, `stopSequences`  |
| **Tools**                | Tool definitions (HTTP, MCP, Sandbox, Lambda) | ✅ LIVE | Tool list with name, params, returns, binding         |
| **Gather**               | Input collection, form fields                 | ✅ LIVE | Field definitions, validation                         |
| **Memory**               | Context retention, memory config              | ✅ LIVE | Memory type, capacity, TTL                            |
| **Flow**                 | State machine, conversation flow              | ✅ LIVE | Flow graph editor                                     |
| **Constraints**          | Rules, policies, boundaries                   | ✅ LIVE | Constraint definitions                                |
| **Guardrails**           | Safety policies, content filters              | ✅ LIVE | PII masking, toxicity detection, hallucination checks |
| **Behavior**             | Response style, tone, guidelines              | ✅ LIVE | Behavior rules                                        |
| **Handoffs**             | Transfer to other agents                      | ✅ LIVE | Target agent, condition, context                      |
| **Delegates**            | Delegate subtasks                             | ✅ LIVE | Delegate agent, instructions                          |
| **Escalation**           | Escalation rules                              | ✅ LIVE | Escalation triggers, targets                          |
| **On Start**             | Initialization logic                          | ✅ LIVE | Startup scripts                                       |
| **Error Handling**       | Error recovery                                | ✅ LIVE | Retry policies, fallbacks                             |
| **Completion**           | End-of-conversation actions                   | ✅ LIVE | Completion handlers                                   |
| **Templates**            | Response templates                            | ✅ LIVE | Template definitions                                  |
| **Definition** (Raw DSL) | Full ABL DSL editor                           | ✅ LIVE | Monaco editor with syntax highlighting                |

### Tool Bindings Supported

- **HTTP** - REST API calls
- **MCP** - Model Context Protocol servers
- **Sandbox** - Isolated code execution
- **Lambda** - AWS Lambda functions

---

## Arch AI Capabilities (In-Project)

### 8 Tool Categories (30+ Operations)

#### 1. **Agent Operations** (`agent_ops`)

| Action    | Parameters                                  | Returns                   | Status  | Arch Tab     |
| --------- | ------------------------------------------- | ------------------------- | ------- | ------------ |
| `read`    | `agentName`                                 | Agent DSL content         | ✅ LIVE | `agent_code` |
| `list`    | -                                           | All agents in project     | ✅ LIVE | -            |
| `create`  | `agentName`, `content`                      | Success/validation errors | ✅ LIVE | `agent_code` |
| `modify`  | `agentName`, `content` OR `edits`, `dryRun` | Preview/diff/applied      | ✅ LIVE | `diff`       |
| `compile` | `agentName`                                 | Validation result         | ✅ LIVE | `agent_code` |
| `delete`  | `agentName`, `confirmed`                    | Success                   | ✅ LIVE | -            |

**Mandatory Workflow for Modify:**

1. Read current agent code
2. Call `modify` with `dryRun: true` → **diff tab** opens
3. LLM asks for confirmation via `ask_user`
4. User approves → Call `modify` with `dryRun: false`
5. Agent updated

#### 2. **Analysis** (`analyze`)

| Action         | Parameters                         | Returns                    | Status  | Arch Tab |
| -------------- | ---------------------------------- | -------------------------- | ------- | -------- |
| `explain`      | `agentName`                        | Explanation of agent logic | ✅ LIVE | -        |
| `suggest`      | `agentName`                        | Improvement suggestions    | ✅ LIVE | -        |
| `test`         | `agentName`                        | Test results               | ✅ LIVE | -        |
| `query_traces` | `sessionId`, `traceTypes`, `limit` | Trace events               | ✅ LIVE | `traces` |

#### 3. **Tools Management** (`tools_ops`)

| Action   | Parameters            | Returns              | Status  | Arch Tab      |
| -------- | --------------------- | -------------------- | ------- | ------------- |
| `list`   | -                     | All project tools    | ✅ LIVE | -             |
| `read`   | `toolId`              | Tool config          | ✅ LIVE | `tool_config` |
| `create` | `toolName`, `config`  | Created tool         | ✅ LIVE | `tool_config` |
| `update` | `toolId`, `config`    | Updated tool         | ✅ LIVE | `tool_config` |
| `test`   | `toolId`, `testInput` | Test output, latency | ✅ LIVE | `test_result` |
| `delete` | `toolId`, `confirmed` | Success              | ✅ LIVE | -             |

#### 4. **Topology Operations** (`topology_ops`)

| Action   | Parameters                                       | Returns                | Status   | Arch Tab   |
| -------- | ------------------------------------------------ | ---------------------- | -------- | ---------- |
| `read`   | -                                                | Agents + handoff edges | ✅ LIVE  | `topology` |
| `modify` | `changes` (add/remove agents/edges), `confirmed` | ❌ NOT_IMPL            | NOT_IMPL | -          |

**Note:** Topology `modify` returns `NOT_IMPLEMENTED`. Use `agent_ops` to modify HANDOFF/DELEGATE sections manually.

#### 5. **Testing** (`testing_ops`)

| Action        | Parameters                     | Returns                     | Status  | Arch Tab      |
| ------------- | ------------------------------ | --------------------------- | ------- | ------------- |
| `run_test`    | `agentName`, `testMessage`     | Response, sessionId, traces | ✅ LIVE | `test_result` |
| `create_eval` | `evalConfig` (name, scenarios) | Created eval set            | ✅ LIVE | -             |
| `list_evals`  | -                              | All eval sets               | ✅ LIVE | -             |

#### 6. **Deployment** (`deployment_ops`)

| Action              | Parameters                     | Returns             | Status  | Arch Tab |
| ------------------- | ------------------------------ | ------------------- | ------- | -------- |
| `list`              | -                              | All deployments     | ✅ LIVE | -        |
| `deploy`            | `environment`, `confirmed`     | Deployment result   | ✅ LIVE | -        |
| `promote`           | `deploymentId`, `environment`  | Promoted deployment | ✅ LIVE | -        |
| `list_channels`     | -                              | All channels        | ✅ LIVE | -        |
| `configure_channel` | `channelType`, `channelConfig` | Configured channel  | ✅ LIVE | -        |

#### 7. **Knowledge Bases** (`knowledge_ops`)

| Action         | Parameters                                 | Returns             | Status  | Arch Tab |
| -------------- | ------------------------------------------ | ------------------- | ------- | -------- |
| `list`         | -                                          | All knowledge bases | ✅ LIVE | -        |
| `create`       | `kbName`                                   | Created KB          | ✅ LIVE | -        |
| `add_document` | `kbId`, `documentUrl` OR `documentContent` | Document added      | ✅ LIVE | -        |
| `query`        | `kbId`, `queryText`                        | Query results       | ✅ LIVE | -        |
| `delete`       | `kbId`, `confirmed`                        | Success             | ✅ LIVE | -        |

#### 8. **Analytics** (`analytics_ops`)

| Action           | Parameters                          | Returns             | Status  | Arch Tab  |
| ---------------- | ----------------------------------- | ------------------- | ------- | --------- |
| `metrics`        | `timeRange`, `agentName` (optional) | Aggregate metrics   | ✅ LIVE | `metrics` |
| `intents`        | `timeRange`                         | Intent distribution | ✅ LIVE | `metrics` |
| `quality_scores` | `timeRange`, `agentName` (optional) | Quality metrics     | ✅ LIVE | `metrics` |
| `anomalies`      | `timeRange`                         | Detected anomalies  | ✅ LIVE | `metrics` |

### Arch Artifact Tabs

| Tab Type        | Content                                 | Triggered By                               | Status  |
| --------------- | --------------------------------------- | ------------------------------------------ | ------- |
| **agent_code**  | Monaco editor (ABL syntax) + validation | `agent_ops` (read/create/compile)          | ✅ LIVE |
| **diff**        | Line-level LCS diff (Bitbucket-style)   | `agent_ops` (modify dry run)               | ✅ LIVE |
| **topology**    | TopologyViewer (canvas/list toggle)     | `topology_ops` (read), `generate_topology` | ✅ LIVE |
| **traces**      | Timeline of trace events                | `analyze` (query_traces)                   | ✅ LIVE |
| **tool_config** | Monaco editor (JSON)                    | `tools_ops` (read/create/update)           | ✅ LIVE |
| **test_result** | Input, response, latency, logs          | `testing_ops` (run_test)                   | ✅ LIVE |
| **metrics**     | Analytics card grid                     | `analytics_ops` (any action)               | ✅ LIVE |

**Max 5 tabs** (evicts oldest). Same type+label replaces existing (increments version).

---

## Knowledge & Search

### SearchAI Features

| Feature                    | Description                            | Status  |
| -------------------------- | -------------------------------------- | ------- |
| **Knowledge Bases**        | Create RAG-enabled knowledge stores    | ✅ LIVE |
| **Document Ingestion**     | URL, text, file upload                 | ✅ LIVE |
| **Vector Search**          | Semantic search with BGE-M3 embeddings | ✅ LIVE |
| **Query Interface**        | Query KBs from Arch or agents          | ✅ LIVE |
| **Preprocessing Pipeline** | BullMQ-based document processing       | ✅ LIVE |
| **Vocabulary Management**  | Custom vocabulary for domain terms     | ✅ LIVE |
| **Knowledge Graph**        | Entity relationships (experimental)    | 🧪 BETA |

### Supported Connectors

- URL scraping
- Text/file upload
- Enterprise connectors (Salesforce, ServiceNow, etc.) via wizard

---

## Connections & Integrations

### MCP Servers

| Feature                   | Description                          | Status  |
| ------------------------- | ------------------------------------ | ------- |
| **MCP Server Management** | Add/configure/test MCP servers       | ✅ LIVE |
| **Tool Discovery**        | Auto-discover tools from MCP servers | ✅ LIVE |
| **Runtime Integration**   | MCP tools callable by agents         | ✅ LIVE |

### Channels

| Channel Type | Description                | Status  |
| ------------ | -------------------------- | ------- |
| **Web Chat** | Embedded chat widget       | ✅ LIVE |
| **Slack**    | Slack bot integration      | ✅ LIVE |
| **Voice**    | Twilio/LiveKit voice calls | ✅ LIVE |
| **Custom**   | Custom channel adapters    | ✅ LIVE |

---

## Testing & Quality

### Current Features

| Feature                | Description                             | Status  |
| ---------------------- | --------------------------------------- | ------- |
| **Session Replay**     | Replay conversation with traces         | ✅ LIVE |
| **Trace Viewer**       | Event timeline, latency, errors         | ✅ LIVE |
| **Test Conversations** | Run test messages via Arch              | ✅ LIVE |
| **Eval Sets**          | Create scenarios for regression testing | ✅ LIVE |

### Planned Features

| Feature         | Description                          | Status     |
| --------------- | ------------------------------------ | ---------- |
| **Eval Runs**   | Execute eval sets, measure pass rate | 🚧 PLANNED |
| **Personas**    | Simulate different user types        | 🚧 PLANNED |
| **Evaluators**  | Custom quality metrics               | 🚧 PLANNED |
| **A/B Testing** | Compare agent versions               | 🚧 PLANNED |

---

## Operations & Monitoring

### Deployments

| Feature                    | Description                      | Status  |
| -------------------------- | -------------------------------- | ------- |
| **Environment Management** | Dev, staging, production         | ✅ LIVE |
| **Version Manifests**      | Agent version pinning            | ✅ LIVE |
| **Promotion Flow**         | Promote deployments between envs | ✅ LIVE |
| **Rollback**               | Revert to previous deployment    | ✅ LIVE |

### Sessions & Traces

| Feature                  | Description                       | Status  |
| ------------------------ | --------------------------------- | ------- |
| **Conversation History** | All user sessions                 | ✅ LIVE |
| **Trace Storage**        | MongoDB trace events              | ✅ LIVE |
| **Filtering**            | By trace type, agent, time range  | ✅ LIVE |
| **Debug View**           | Inspect tool calls, LLM responses | ✅ LIVE |

---

## Analytics & Insights

### Current Analytics

| Metric            | Description         | Status  |
| ----------------- | ------------------- | ------- |
| **Session Count** | Total conversations | ✅ LIVE |
| **Agent Usage**   | Per-agent metrics   | ✅ LIVE |
| **Latency**       | Response times      | ✅ LIVE |
| **Error Rate**    | Failed sessions     | ✅ LIVE |

### Planned Analytics

| Feature                 | Description                   | Status     |
| ----------------------- | ----------------------------- | ---------- |
| **Intent Distribution** | Top user intents              | 🚧 PLANNED |
| **Quality Scores**      | Per-agent quality metrics     | 🚧 PLANNED |
| **Anomaly Detection**   | Unusual patterns              | 🚧 PLANNED |
| **Customer Insights**   | VoC, sentiment analysis       | 🚧 PLANNED |
| **Agent Performance**   | Per-agent diagnostics         | 🚧 PLANNED |
| **Quality Monitor**     | Watchtower for quality issues | 🚧 PLANNED |

---

## Governance & Security

### Guardrails

| Feature                  | Description              | Status  |
| ------------------------ | ------------------------ | ------- |
| **PII Masking**          | Auto-detect and mask PII | ✅ LIVE |
| **Toxicity Detection**   | Filter toxic content     | ✅ LIVE |
| **Hallucination Checks** | Verify factual accuracy  | ✅ LIVE |
| **Content Moderation**   | Policy-based filtering   | ✅ LIVE |

### Security

| Feature                 | Description                     | Status  |
| ----------------------- | ------------------------------- | ------- |
| **Tenant Isolation**    | Multi-tenant resource isolation | ✅ LIVE |
| **Project Permissions** | RBAC per project                | ✅ LIVE |
| **API Keys**            | Scoped API key management       | ✅ LIVE |
| **Secrets Management**  | KMS-encrypted secrets           | ✅ LIVE |
| **Audit Logging**       | All actions logged              | ✅ LIVE |

### Planned Governance

| Feature                  | Description                 | Status     |
| ------------------------ | --------------------------- | ---------- |
| **Agent Registry**       | Centralized agent catalog   | 🚧 PLANNED |
| **Compliance Dashboard** | Track compliance metrics    | 🚧 PLANNED |
| **Guardrail Policies**   | Top-level policy management | 🚧 PLANNED |

---

## Feature Status Matrix

### ✅ LIVE (Production-Ready)

- Arch AI chat (home + in-project)
- Agent editor (16 sections, all LIVE)
- All 8 Arch tool categories (except topology modify)
- 7 artifact tabs (all rendering)
- Sessions, traces, deployments
- Knowledge bases, MCP servers
- Tools management (HTTP, MCP, Lambda, Sandbox)
- Channels (web, Slack, voice)
- Guardrails (PII, toxicity, hallucination)
- Project settings

### 🧪 BETA (Experimental)

- Knowledge graph
- File upload for Arch chat

### 🚧 PLANNED (Roadmap)

- Evals & experiments
- Alerts & notifications
- Analytics dashboards (insights group)
- Governance (agent registry, compliance)
- Guardrails config (top-level)
- Topology modification

### ❌ KNOWN ISSUES

1. **Interactive widget (ask_user) stalls** - Plan mode asks for input, user submits, no follow-up LLM call
2. **Agents not persisting** - Created projects show "0 agents" (API expects `agentPath`, not `dslContent`)
3. **Topology modify** - Returns `NOT_IMPLEMENTED` (workaround: use `agent_ops` to modify HANDOFF sections)

---

## Admin Features

### Tenant-Level Settings

| Feature                   | Route                       | Status  |
| ------------------------- | --------------------------- | ------- |
| **Members**               | `/admin/members`            | ✅ LIVE |
| **Models**                | `/admin/models`             | ✅ LIVE |
| **Voice**                 | `/admin/voice`              | ✅ LIVE |
| **Security**              | `/admin/security`           | ✅ LIVE |
| **Secrets**               | `/admin/secrets`            | ✅ LIVE |
| **Billing**               | `/admin/billing`            | ✅ LIVE |
| **Arch Config**           | `/admin/arch`               | ✅ LIVE |
| **KMS**                   | `/admin/kms`                | ✅ LIVE |
| **Environment Variables** | `/admin/env-vars`           | ✅ LIVE |
| **Guardrails**            | `/admin/guardrails`         | ✅ LIVE |
| **Connectors**            | `/admin/connectors`         | ✅ LIVE |
| **Analytics Agents**      | `/admin/analytics-agents`   | ✅ LIVE |
| **Analytics Sessions**    | `/admin/analytics-sessions` | ✅ LIVE |
| **Analytics Traces**      | `/admin/analytics-traces`   | ✅ LIVE |

---

## Key Architecture Patterns

### Resource Isolation

- **Tenant**: Every query includes `tenantId`. Use `findOne({_id, tenantId})`, never `findById`.
- **Project**: Routes under `/api/projects/:projectId/...`. Verify `resource.projectId === req.params.projectId`.
- **User**: Filter by `createdBy`/`ownerId`. Users cannot access other users' resources.

### DSL Pipeline

```
@abl/core (parse) → @abl/compiler (compile) → AgentIR → Runtime
```

### Arch AI Flow

```
Studio → /api/arc/chat → ArcEngine → BaseAgent → LLM adapter → SSE → useArcEngine → Zustand
```

### Tool Execution

```
Agent → Runtime → ToolExecutor → HTTP/MCP/Lambda/Sandbox → Result
```

---

## References

- **System Prompt**: `apps/studio/src/lib/arch-ai/system-prompt.ts`
- **Tool Definitions**: `apps/studio/src/lib/arch-ai/tools/`
- **Navigation Store**: `apps/studio/src/store/navigation-store.ts`
- **Project Sidebar**: `apps/studio/src/components/navigation/ProjectSidebar.tsx`
- **Agent Editor**: `apps/studio/src/components/agent-editor/AgentEditor.tsx`
- **Arch Store**: `apps/studio/src/store/arch-ai-store.ts`
- **Memory**: `/Users/Sri.Harsha/.claude/projects/-Users-Sri-Harsha-abl-platform/memory/MEMORY.md`

---

**END OF DOCUMENT**
