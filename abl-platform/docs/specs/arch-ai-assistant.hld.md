# High-Level Design: Arch AI Assistant

> **Feature**: Arch -- AI-Guided Project Lifecycle Assistant
> **Backlog Item**: #74
> **Status**: ALPHA (v0.3 rewrite — see `docs/arch/` for full v0.3 design docs)
> **Last Updated**: 2026-04-04
>
> **Post-Implementation Note**: This HLD was written for the v2 implementation. The v0.3 rewrite has a completely different architecture documented in `docs/arch/`. The v0.3 design docs (`docs/arch/00-index.md`) are the canonical reference. This HLD is retained for historical context only.

---

## 1. Overview

Arch is the AI-powered assistant embedded in the ABL Studio that guides users through the full agent project lifecycle: ideation, design, build, test, deploy, and evolve. It provides conversational AI capabilities for project creation, agent modification, debugging, and optimization -- all grounded in the platform's ABL DSL and compiler infrastructure.

### Architecture Diagram

```
                           ┌─────────────────────────────────────────────────────┐
                           │                    STUDIO (Next.js)                  │
                           │                                                     │
                           │  ┌───────────────┐  ┌──────────────────────────┐   │
                           │  │  Arch Panel    │  │  Onboarding Wizard       │   │
                           │  │  ArchChat      │  │  Interview → Topology →  │   │
                           │  │  ArchMessage   │  │  Review → Create         │   │
                           │  │  ArchDiffView  │  │                          │   │
                           │  │  Suggestions   │  │  LifecycleStore          │   │
                           │  └──────┬────────┘  └────────────┬─────────────┘   │
                           │         │                         │                  │
                           │  ┌──────▼─────────────────────────▼──────────────┐  │
                           │  │              Zustand Stores                    │  │
                           │  │  arch-store (panel, conv, workflow, diffs)     │  │
                           │  │  arch-config-store (models, keys, status)      │  │
                           │  │  lifecycle-store (brief, topology, agents)     │  │
                           │  └──────┬────────────────────────────────────────┘  │
                           │         │                                           │
                           │  ┌──────▼────────────────────────────────────────┐  │
                           │  │              API Client (api/arch.ts)          │  │
                           │  └──────┬────────────────────────────────────────┘  │
                           └─────────┼───────────────────────────────────────────┘
                                     │ HTTP
                           ┌─────────▼───────────────────────────────────────────┐
                           │            Studio API Routes (Next.js)               │
                           │                                                      │
                           │  /api/arch/chat      ──┐                             │
                           │  /api/arch/generate   ──┤                            │
                           │  /api/arch/config     ──┤── arch.service.ts          │
                           │  /api/arch/status     ──┤                            │
                           │  /api/arch/models     ──┤                            │
                           │  /api/arch/validate-key─┤                            │
                           │  /api/arch/deploy-mocks─┘                            │
                           │                                                      │
                           │  ┌─────────────────────────────────────────────┐    │
                           │  │          arch-llm.ts (LLM Integration)      │    │
                           │  │  ┌──────────────┐  ┌────────────────────┐   │    │
                           │  │  │ arch-tools.ts │  │arch-context-builder│   │    │
                           │  │  │ (tool defs)   │  │(IR extraction)     │   │    │
                           │  │  └──────────────┘  └────────────────────┘   │    │
                           │  └─────────────┬────────────────┬──────────────┘    │
                           └────────────────┼────────────────┼───────────────────┘
                                            │                │
                           ┌────────────────▼────┐  ┌───────▼────────────────────┐
                           │   LLM Provider       │  │   ABL Compiler             │
                           │   (OpenAI/Anthropic)  │  │   (packages/compiler)      │
                           │                       │  │   DSL → IR validation      │
                           └───────────────────────┘  └──────────────────────────┘
                                                             │
                                                      ┌──────▼────────┐
                                                      │   MongoDB      │
                                                      │   - Projects   │
                                                      │   - Agents     │
                                                      │   - Convos     │
                                                      └───────────────┘
```

## 2. Architectural Concerns

### 2.1 Resource Isolation

**Tenant isolation**: All Arch API endpoints operate within the authenticated tenant context. The Arch configuration (model, API key) is stored per-tenant. Cross-tenant access returns 404.

**Project isolation**: Conversations are keyed by `projectId`. The `/api/arch/chat` and `/api/arch/generate` endpoints require a `projectId` context (except during onboarding's pre-project phase). Agent modifications are scoped to the project's agents.

**User isolation**: Conversation persistence is per-user-per-project. The localStorage cache uses the Zustand `persist` key `kore-arch-storage`. Server-side conversations are stored with user ownership context.

### 2.2 Authentication & Authorization

Arch API routes use the platform's `createUnifiedAuthMiddleware` / `requireAuth`. No custom token verification.

- **Chat/Generate**: Requires authenticated user with project access
- **Config**: Requires tenant admin permission for write; read available to all authenticated users
- **Status/Models**: Read-only, requires authentication
- **Validate-Key**: Requires tenant admin (handles sensitive API keys)

API keys for LLM providers are stored server-side with encryption at rest. They are never sent to the client -- the `hasApiKey: boolean` flag indicates presence without exposing the value.

### 2.3 Stateless Distributed Design

Arch is stateless at the server level:

- **No in-memory conversation state**: Each chat request includes the full message history. The server processes the request and returns a response without maintaining session state.
- **LLM calls are stateless**: Each request constructs the full prompt from the provided messages and context.
- **Conversation persistence**: MongoDB is the source of truth. localStorage is a local cache that gets overwritten on project load.
- **Configuration**: Stored in MongoDB, fetched fresh by the config store (no `persist` middleware).

This enables horizontal scaling of Studio instances without sticky sessions.

### 2.4 Traceability

- **LLM calls**: The `toolsUsed` field in responses tracks which tools were invoked during the agentic loop (e.g., `read_agent_dsl`, `compile_abl`)
- **Workflow state**: Client-side state machine transitions are deterministic and logged through the store
- **Conversation history**: Full conversation history is persisted with timestamps per message
- **Configuration changes**: Config updates include a version counter (`_v`) for optimistic concurrency

### 2.5 Compliance

- **API key encryption**: LLM provider API keys stored encrypted at rest in MongoDB
- **Data minimization**: Conversations compacted to 30 messages max; heavy payloads stripped before persistence
- **TTL on conversations**: Max 10 conversations retained per user; oldest evicted automatically
- **No PII in prompts**: User messages are sent to the LLM but no PII is extracted or stored separately
- **Right to erasure**: `deleteArchConversation` removes server-side conversation data; `clearConversation` removes local cache

### 2.6 Performance

| Operation           | Strategy                               | Target           |
| ------------------- | -------------------------------------- | ---------------- |
| Chat response       | Streaming (first token < 2s)           | < 2s first token |
| Generate (topology) | Single LLM call with structured output | < 10s            |
| Generate (agents)   | Parallel per-agent generation          | < 15s per agent  |
| Panel animation     | CSS/Framer Motion (GPU-accelerated)    | < 200ms          |
| Conversation load   | Single MongoDB query by projectId      | < 500ms          |
| Conversation save   | Debounced (2s) with compaction         | Background       |
| Payload stripping   | In-memory before persist               | < 1ms            |

**Compaction strategy**: Messages exceeding the 30-message window are compressed into a summary preamble containing the last 5 user topic excerpts. Heavy payloads (topology JSON, diff lines, code blocks) are stripped before both localStorage and MongoDB persistence.

**Conversation eviction**: Only the 10 most recently active conversations are retained (sorted by last message timestamp).

## 3. Component Architecture

### 3.1 Client-Side Components

#### Arch Panel Layer

| Component             | Responsibility                                    | Key Props/State                                 |
| --------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `ArchPanel`           | Collapsible sidebar shell (320px)                 | `isOpen`, `isMinimized`, `mode` from arch-store |
| `ArchChat`            | Message list, input field, scroll management      | `messages`, `isTyping`, `sendMessage`           |
| `ArchMessage`         | Individual bubble with markdown, code, agent name | `message: ArchMessage`                          |
| `ArchDiffView`        | Inline diff with Apply/Reject buttons             | `diff: ArchDiff`, `onApply`, `onReject`         |
| `ArchSuggestionChips` | Section-aware action chip bar                     | `suggestions: ArchSuggestion[]`, `onSelect`     |
| `ArchIcon`            | Geometric "A" logomark SVG                        | Size, color props                               |
| `PlanMessage`         | Large-scope plan rendering (summary + steps)      | `planData: PlanData`                            |
| `ProposalMessage`     | Proposal with section diffs                       | `proposalData: ProposalData`                    |

#### Onboarding Wizard Layer

| Component         | Responsibility                                        | Phase        |
| ----------------- | ----------------------------------------------------- | ------------ |
| `ArchOnboarding`  | Full-screen wizard shell, phase routing               | All          |
| `WelcomePhase`    | Welcome screen with quick-start or template selection | `welcome`    |
| `InterviewPhase`  | Arch conversation + auto-populating brief             | `interview`  |
| `UploadPhase`     | Document drag-and-drop with extraction                | `upload`     |
| `GeneratingPhase` | Pipeline progress visualization                       | `generating` |
| `RevealPhase`     | Animated topology reveal                              | `reveal`     |
| `ReviewPhase`     | Tabbed review (Agents, API Spec, Mock Data)           | `review`     |
| `CreatePhase`     | Project creation with per-agent status                | `create`     |

### 3.2 State Management

Three Zustand stores with clear separation of concerns:

**arch-store.ts** (persisted via localStorage):

- Panel state: `isOpen`, `isMinimized`
- Mode: `assisted` / `pro`
- Conversations: `Record<string, ArchMessage[]>` keyed by `proj-{projectId}` or `{projectId}/{agentId}`
- Workflow: `workflowState`, `currentProposal`, `allowedActions`
- Context: `page`, `projectId`, `agentId`, `agentName`, `currentAbl`
- Pending diffs, suggestions, edit context, prefill message

**arch-config-store.ts** (not persisted -- fetched fresh):

- Status: `configured`, `model`, `provider`, `source`
- Config: `modelId`, `provider`, rate limits, hyper-parameters
- Models: `recommended[]`, `other[]`
- Key validation state

**lifecycle-store.ts** (not persisted -- ephemeral wizard state):

- Onboarding phase, interview answers
- Project brief
- Topology, generated agents
- Spec results (OpenAPI, mock project, deploy result)
- Review tab tracking, creation results

### 3.3 Server-Side Services

**arch.service.ts**: Orchestrates between LLM integration, compiler, and MongoDB.

**arch-llm.ts**: Constructs prompts, manages tool definitions, handles streaming responses. Uses platform's LLM provider infrastructure.

**arch-tools.ts**: Defines tools available to the LLM during the agentic loop:

- `read_agent_dsl`: Read current agent DSL from project
- `compile_abl`: Validate ABL through the compiler
- `propose_modification`: Structured modification proposal (diff or plan)
- Project data access tools

**arch-context-builder.ts**: Extracts structured context from compiled IR:

- Agent metadata (name, mode, goal, persona)
- Constraints, tools, gather fields, flow steps
- Coordination (handoffs, delegates, escalation)
- Behavior profiles
- Compile errors and warnings

**arch-workflow.ts**: Server-side workflow state machine logic. Determines valid transitions and actions based on current state and LLM response.

### 3.4 API Route Design

All routes follow the standard response envelope: `{ success: true/false, data/error: { code, message } }`.

| Route                         | Auth                  | Rate Limit     | Notes                                          |
| ----------------------------- | --------------------- | -------------- | ---------------------------------------------- |
| `POST /api/arch/chat`         | User + project access | Per-tenant RPM | Main chat endpoint; handles all stages         |
| `POST /api/arch/generate`     | User + project access | Per-tenant RPM | Artifact generation pipeline                   |
| `GET /api/arch/config`        | User (read)           | None           | Read config                                    |
| `PUT /api/arch/config`        | Admin                 | None           | Update config (includes encrypted key storage) |
| `GET /api/arch/status`        | User                  | None           | Lightweight configured check                   |
| `GET /api/arch/models`        | User                  | None           | Static model catalog                           |
| `POST /api/arch/validate-key` | Admin                 | Burst-limited  | Calls provider API to validate                 |
| `POST /api/arch/deploy-mocks` | User + project access | Burst-limited  | Vercel deployment                              |

## 4. Data Model

### 4.1 Arch Configuration (MongoDB)

```typescript
interface ArchConfig {
  tenantId: string; // Tenant isolation
  modelId: string; // e.g., "gpt-4o"
  provider: string; // e.g., "openai"
  tenantModelId?: string; // Reference to tenant's model config
  usePlatformCredits: boolean;
  apiKey?: string; // Encrypted at rest
  endpoint?: string; // Custom endpoint URL
  authType: string; // "api_key" | "oauth" | "custom"
  customHeaders?: Record<string, string>;
  hyperParameters: Record<string, unknown>;
  maxTokensChat: number;
  maxTokensGenerate: number;
  temperature: number;
  rateLimitRpm: number;
  rateLimitRph: number;
  lastValidatedAt?: Date;
  _v: number; // Optimistic concurrency version
}
```

### 4.2 Arch Conversation (MongoDB)

```typescript
interface ArchConversation {
  tenantId: string;
  projectId: string;
  userId: string;
  messages: ArchMessage[]; // Compacted (max 30, payloads stripped)
  updatedAt: Date;
}
```

### 4.3 Client-Side Message Shape

```typescript
interface ArchMessage {
  id: string;
  role: 'arch' | 'user';
  content: string;
  timestamp: string;
  type?: 'message' | 'error' | 'plan' | 'proposal' | 'system';
  agentName?: string;
  diff?: ArchDiff;
  topology?: TopologyData;
  briefUpdates?: Partial<ProjectBrief>;
  codeBlocks?: { language: string; code: string }[];
  isStreaming?: boolean;
  planData?: PlanData;
  proposalData?: ProposalData;
}
```

## 5. Key Flows

### 5.1 Chat Request Flow

```
User types message
  → ArchChat sends to arch-store
  → arch-store adds user message to conversation
  → API call to POST /api/arch/chat
  → Server: arch.service.ts
    → arch-context-builder extracts IR context (if agent scoped)
    → arch-llm.ts constructs prompt with messages + context + tools
    → LLM provider call (streaming)
    → If tool calls: execute tools (read_agent_dsl, compile_abl, etc.)
    → Build ArchChatResponse
  → Client receives response
  → arch-store adds arch message to conversation
  → If workflow response: handleWorkflowResponse updates state machine
  → If suggestions: update suggestion chips
  → If diff: add to pendingDiffs
  → scheduleSave debounces MongoDB persistence
```

### 5.2 Quick Generate Pipeline Flow

```
User enters domain + problem statement in onboarding
  → lifecycle-store triggers generation
  → POST /api/arch/generate { type: "topology", brief }
    → LLM generates topology (nodes + edges)
  → POST /api/arch/generate { type: "agent_specs", brief, topology }
    → LLM generates detailed specs per agent
  → POST /api/arch/generate { type: "agents", brief, topology, agentSpecs }
    → LLM generates ABL content per agent
  → POST /api/arch/generate { type: "openapi", brief, agents }
    → LLM generates OpenAPI spec from agent tools
  → POST /api/arch/generate { type: "mock_project", brief, openapi }
    → LLM generates Vercel-deployable mock server
  → Results stored in lifecycle-store
  → User reviews in tabbed UI
  → On create: agents saved to project DB
```

### 5.3 Workflow State Machine Flow

```
State: IDLE
  User sends message → CONTEXTUALIZING
    → Server reads agent IR, builds ArchAgentContext
  → RESPONDING
    → LLM processes request with full context
    → If modification needed: LLM calls propose_modification tool
  → CONFIRMING
    → Proposal displayed (small: section diffs; large: plan with steps)
    → User: confirm → EXECUTING
    → User: reject → IDLE
    → User: refine → RESPONDING (with feedback)
  → EXECUTING
    → Changes applied to DSL
    → Compilation validation
    → If valid → IDLE (success)
    → If invalid → IDLE (with error message)
```

## 6. Alternatives Considered

### 6.1 Server-Side Conversation State vs. Stateless

**Chosen**: Stateless (full message history in each request).

**Alternative**: Server-side session with message history stored in Redis.

**Why stateless**: Simpler scaling (no sticky sessions), no Redis dependency for Arch, message history is small enough to include in requests. The 30-message compaction keeps payloads manageable.

### 6.2 Real-Time Streaming vs. Request-Response

**Chosen**: Hybrid -- streaming for chat responses, request-response for generate.

**Alternative**: Full request-response for everything.

**Why hybrid**: Chat requires perceived low latency (first token < 2s). Generation is inherently batch (topology, specs, agents) and users expect to wait for complete results.

### 6.3 Single Store vs. Three Stores

**Chosen**: Three Zustand stores (arch, config, lifecycle).

**Alternative**: Single monolithic store.

**Why three**: Different persistence strategies (arch: persist with compaction; config: no persist; lifecycle: ephemeral). Different lifecycles (arch: long-lived across sessions; lifecycle: wizard-only; config: admin-only).

### 6.4 Workflow State Machine Location

**Chosen**: Server drives state, client echoes.

**Alternative**: Client-side state machine with server as stateless oracle.

**Why server-driven**: The server knows when to transition (e.g., LLM calls `propose_modification` tool), which tools were invoked, and whether compilation succeeded. Client just renders the state and actions.

## 7. Security Considerations

| Concern                            | Mitigation                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| LLM API key exposure               | Server-side storage with encryption at rest; client only sees `hasApiKey: boolean` |
| Prompt injection via user messages | LLM system prompt includes safety boundaries; ABL compiler validates output        |
| Cross-tenant conversation access   | All queries scoped by `tenantId`; 404 for cross-tenant                             |
| Rate limit abuse                   | Per-tenant RPM/RPH limits; configurable by admin                                   |
| Generated ABL security             | All generated ABL runs through compiler validation before deployment               |
| PII in conversations               | Conversations compacted and TTLed; right to erasure supported                      |

## 8. Observability

| Signal                   | Implementation                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| LLM latency              | `toolsUsed` field tracks tool invocations and can be correlated with response times        |
| Error rates              | API routes return structured error envelopes; `type: "error"` messages rendered distinctly |
| Conversation volume      | MongoDB conversation count per tenant/project                                              |
| Configuration health     | `/api/arch/status` endpoint for monitoring                                                 |
| Workflow completion rate | Client-side tracking of state machine completions vs. abandonments                         |

## 9. Scalability

| Dimension         | Current Design                       | Growth Path                                                     |
| ----------------- | ------------------------------------ | --------------------------------------------------------------- |
| Concurrent users  | Stateless server; horizontal scaling | Add Redis caching for config lookups                            |
| Conversation size | 30-message window with compaction    | Move to server-side sliding window with full history in MongoDB |
| LLM throughput    | Per-tenant rate limits               | Queue-based with priority (real-time chat > batch generate)     |
| Model catalog     | Static in-code list                  | Dynamic from provider APIs with caching                         |
| Multi-region      | Single region                        | Conversation replication via MongoDB Atlas                      |

## 10. Migration & Rollout

The Arch AI Assistant is already at STABLE status. No migration is needed -- the feature was built incrementally:

1. **Phase 1**: Foundation (panel, chat, mode toggle, basic LLM integration)
2. **Phase 2**: Onboarding wizard (8-phase flow, topology generation, ABL generation)
3. **Phase 3**: Build integration (diffs, suggestions, context awareness, workflow state machine)
4. **Phase 4**: Configuration (admin settings, model selection, key validation)
5. **Phase 5**: Quick Generate pipeline (topology -> specs -> agents -> OpenAPI -> mocks)
6. **Phase 6**: Edit UX (section-scoped chat, IR context extraction, proposal/plan messages)

Feature is gated by LLM configuration -- tenants without configured LLM credentials see Arch as unconfigured.

## 11. Cross-Cutting Concerns

### Error Handling

- LLM failures return `type: "error"` messages with user-friendly text
- Network errors are caught by the API client and surfaced in the store's `error` field
- Compilation failures after diff application are reported with specific error details
- Config store uses `err instanceof Error ? err.message : String(err)` pattern

### Logging

- Server-side uses `createLogger('arch')` (not `console.log`)
- Client-side `console.error` only for critical persistence failures (save/load/delete)

### Internationalization

- All user-facing strings in suggestion chips are in English (i18n ready but not yet externalized)
- Message content is LLM-generated and language-dependent on model configuration

---

_HLD generated 2026-03-23. Grounded in implementation at `apps/studio/src/`._
