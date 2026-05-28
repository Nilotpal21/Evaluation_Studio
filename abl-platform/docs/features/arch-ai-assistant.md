# Feature Spec: Arch AI Assistant

> **Feature**: Arch -- AI-Guided Project Lifecycle Assistant
> **Backlog Item**: #74
> **Status**: BETA
> **Last Updated**: 2026-04-07

---

## 1. Problem Statement

Building multi-agent systems with ABL (Agent Blueprint Language) requires deep domain expertise. Users must understand agent execution modes (scripted, reasoning, hybrid), tool definitions, gather flows, constraints, handoff coordination, and the ABL DSL syntax. This creates a steep learning curve that blocks adoption, particularly for:

- **New users** who don't know where to start
- **Domain experts** who understand the business logic but not ABL syntax
- **Power users** who want faster iteration cycles

Without AI guidance, users spend significant time reading documentation, debugging compilation errors, and manually designing agent topologies -- tasks that an AI assistant with deep platform knowledge could accelerate by 5-10x.

## 2. Scope

### In Scope

| Area                                  | Description                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Arch AI Chat Panel**                | Persistent collapsible sidebar panel available on all project pages                             |
| **Two Modes**                         | Assisted (guided, default for new users) and Pro (direct editor, Arch in sidebar)               |
| **6 Lifecycle Stages**                | IDEATE, DESIGN, BUILD, TEST, DEPLOY, EVOLVE -- Arch guides through each                         |
| **AI-Guided Project Creation**        | Full-screen wizard: interview, topology generation, ABL generation, review, create              |
| **Conversational Agent Modification** | Natural language requests produce inline diffs with Apply/Reject                                |
| **Context Awareness**                 | Arch knows current page, agent, section, and adapts suggestions accordingly                     |
| **Proactive Suggestion Chips**        | Section-aware actionable suggestions (e.g., "Add error handling", "Add guardrail")              |
| **Workflow State Machine**            | 5-state machine (idle, contextualizing, responding, confirming, executing) for structured edits |
| **Conversation Persistence**          | Per-project conversations stored in localStorage (cache) and MongoDB (source of truth)          |
| **Configuration Management**          | Admin settings for LLM model selection, API keys, rate limits, hyper-parameters                 |
| **Quick Generate Pipeline**           | Multi-stage generation: topology, agent specs, agents, OpenAPI spec, mock project               |
| **Spec Generation & Review**          | Review tabs (Agents, API Spec, Mock Data) with approve/edit flow before project creation        |
| **Deploy Mocks**                      | Generate and deploy Vercel-compatible mock API servers from OpenAPI specs                       |

### Out of Scope

| Area                                   | Reason                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Voice/audio interaction with Arch      | Future enhancement -- text-only for now                                   |
| Multi-user collaborative Arch sessions | Single-user per session; collaborative editing is a separate feature      |
| Arch memory across projects            | Conversations are project-scoped; no cross-project learning               |
| Custom Arch personality/voice          | Fixed personality (expert, approachable, concise); customization deferred |
| Autonomous agent deployment            | Arch suggests but user confirms all changes; no auto-deploy               |

## 3. Requirements

### 3.1 Functional Requirements

#### FR-1: Arch Panel (Persistent Sidebar)

- FR-1.1: Collapsible side panel (320px expanded) available on all project pages
- FR-1.2: Collapsed state shows Arch icon rail; click to expand
- FR-1.3: Minimize and close actions with keyboard shortcut support
- FR-1.4: Panel state (open/closed, mode) persisted across sessions via Zustand + localStorage
- FR-1.5: Context-aware header showing current agent/page

#### FR-2: Assisted / Pro Mode

- FR-2.1: Toggle switch in header bar (pill-style with slide animation)
- FR-2.2: Assisted mode: Arch panel open by default, guides through stages sequentially
- FR-2.3: Pro mode: Arch panel collapsed to icon rail, stages navigable freely
- FR-2.4: Switching preserves all state -- only changes UI chrome
- FR-2.5: Mode preference persisted per user

#### FR-3: Project Creation Wizard

- FR-3.1: Three entry points: "Start with Arch" (recommended), "Blank Project", "From Template"
- FR-3.2: "Start with Arch" launches full-screen wizard with IDEATE and DESIGN stages
- FR-3.3: IDEATE: Arch interviews user (3-5 questions), auto-populates Project Brief
- FR-3.4: Brief fields: domain, problem statement, use cases, target users, channels, tone, constraints
- FR-3.5: Document upload support (PDF, MD, JSON, YAML, TXT, DOCX) with extraction
- FR-3.6: DESIGN: Arch proposes topology from brief; live canvas rendering
- FR-3.7: Review & Create: Summary view with project name, description, topology, agents, tools
- FR-3.8: On create: project saved to DB, ABL files generated, compiled to IR, navigate to workspace
- FR-3.9: Template-based creation with 5 pre-built domain starters (Healthcare, Banking, Telecom, Retail, IT Support)

#### FR-4: Conversational Agent Modification

- FR-4.1: Natural language requests produce structured changes (not raw text replacement)
- FR-4.2: Changes shown as inline diffs with Apply/Reject buttons
- FR-4.3: Diffs show added (green), removed (red), unchanged (gray) lines
- FR-4.4: Applied diffs persist to agent DSL via PUT API
- FR-4.5: Multi-agent modifications: Arch can update supervisor routing when adding a new agent

#### FR-5: Workflow State Machine

- FR-5.1: 5 states: idle, contextualizing, responding, confirming, executing
- FR-5.2: In BUILD/EVOLVE/EDIT stages, LLM decides via `propose_modification` tool call
- FR-5.3: CONTEXTUALIZING: Arch reads agent IR to build structured context
- FR-5.4: CONFIRMING: Shows proposal with section diffs for small-scope or plan for large-scope
- FR-5.5: EXECUTING: Applies changes and validates via compilation
- FR-5.6: User actions: confirm, reject, refine (with feedback text), send

#### FR-6: Context Awareness

- FR-6.1: Arch tracks current page, project, agent, and section being viewed
- FR-6.2: Section-specific suggestion chips (IDENTITY, TOOLS, GATHER, FLOW, RULES, COORDINATION, LIFECYCLE)
- FR-6.3: Agent-scoped conversations: switching agents switches conversation history
- FR-6.4: Context resets workflow state on navigation
- FR-6.5: Edit context includes sibling data (mode, goal, tool names, gather fields, flow steps)

#### FR-7: Suggestion Chips

- FR-7.1: Section-aware chips rendered below chat (e.g., TOOLS section shows "Add a tool", "Configure auth", "Add error handling")
- FR-7.2: Clicking a chip sends the associated prompt to Arch
- FR-7.3: Default suggestions for non-section contexts ("Improve this agent", "Review my config", "What's missing?")
- FR-7.4: Suggestions update based on LLM response
- FR-7.5: Chips have category, icon, and description for rich rendering

#### FR-8: Conversation Persistence

- FR-8.1: Dual storage: localStorage (offline cache) and MongoDB (source of truth)
- FR-8.2: Max 30 messages per conversation; older messages compressed to summary preamble
- FR-8.3: Max 10 conversations retained; stale conversations evicted by timestamp
- FR-8.4: Heavy payloads (topology, diff, code blocks) stripped before persistence
- FR-8.5: Server save debounced at 2 seconds after last message
- FR-8.6: Load from server overwrites local state on project switch

#### FR-9: Configuration & Admin

- FR-9.1: LLM model selection from supported providers (OpenAI, Anthropic, etc.)
- FR-9.2: API key management with validation endpoint
- FR-9.3: Hyper-parameter configuration (temperature, max tokens, rate limits)
- FR-9.4: Credential source resolution: tenant-specific or platform-level
- FR-9.5: Status endpoint reporting configured/unconfigured state

#### FR-10: Quick Generate Pipeline

- FR-10.1: 5-stage pipeline: topology, agent_specs, agents, openapi, mock_project
- FR-10.2: Each stage takes output of previous stage as input
- FR-10.3: Progress tracking per stage (pending, running, complete, error)
- FR-10.4: Review phase with tabs: Agents, API Spec, Mock Data
- FR-10.5: Edit history tracking per stage with timestamps and summaries

### 3.2 Non-Functional Requirements

| ID     | Requirement                               | Target                                           |
| ------ | ----------------------------------------- | ------------------------------------------------ |
| NFR-1  | Chat response latency (first token)       | < 2 seconds                                      |
| NFR-2  | Topology generation time                  | < 10 seconds                                     |
| NFR-3  | ABL generation per agent                  | < 15 seconds                                     |
| NFR-4  | Panel expand/collapse animation           | < 200ms                                          |
| NFR-5  | Conversation load from MongoDB            | < 500ms                                          |
| NFR-6  | Max concurrent Arch sessions per tenant   | 10 (rate limited)                                |
| NFR-7  | Max conversation history size (persisted) | 30 messages per conversation                     |
| NFR-8  | LLM token budget per chat turn            | Configurable (default 4096 output)               |
| NFR-9  | Offline resilience                        | localStorage cache serves previous conversations |
| NFR-10 | Accessibility                             | WCAG 2.1 AA for chat interface                   |

## 4. User Stories

### US-1: New User Onboarding

> As a **new user**, I want Arch to guide me through creating my first agent project so that I can go from idea to working agents without reading documentation.

**Acceptance Criteria:**

- Arch asks 3-5 domain-specific questions
- Project Brief auto-populates from conversation
- Topology is proposed and rendered visually
- ABL is generated for all agents
- Project is created with one click after review

### US-2: Conversational Agent Modification

> As a **developer**, I want to describe changes in natural language (e.g., "Add a cancellation flow") so that Arch generates the ABL diff and I can review before applying.

**Acceptance Criteria:**

- Describe change in chat
- Arch shows inline diff with exact lines changed
- Apply persists to agent DSL
- Reject discards without side effects
- Compilation validation runs after apply

### US-3: Context-Aware Suggestions

> As a **developer** editing an agent's TOOLS section, I want Arch to show relevant suggestions like "Add error handling" or "Configure auth" so that I don't miss important patterns.

**Acceptance Criteria:**

- Suggestions change based on active section
- Clicking a chip sends the prompt and opens Arch panel
- Suggestions are actionable (not vague advice)

### US-4: Session Debugging

> As a **developer** reviewing a failed session, I want to ask Arch "What went wrong?" so that it analyzes the trace and suggests specific fixes.

**Acceptance Criteria:**

- Arch reads session traces
- Identifies root cause (e.g., tool timeout, missing error handler)
- Proposes fix options with diffs

### US-5: Mode Switching

> As a **power user**, I want to switch to Pro mode so that I can edit ABL directly while still having Arch available in the sidebar for quick questions.

**Acceptance Criteria:**

- Toggle preserves all state
- Pro mode collapses Arch to icon rail
- Arch panel expands on click
- All conversational features work in Pro mode

### US-6: Admin Configuration

> As a **tenant admin**, I want to configure which LLM model Arch uses and manage API keys so that I control costs and model selection.

**Acceptance Criteria:**

- Model picker with recommended/other tiers
- API key validation before save
- Rate limit configuration (RPM, RPH)
- Status shows configured/unconfigured

## 5. Technical Architecture Overview

> **v0.3 rewrite** — Complete rewrite from `Archv03` branch. All v2 code discarded. See `docs/arch/` for full design docs.

### Core Engine — `packages/arch-ai` (surface-agnostic)

```
packages/arch-ai/src/
  coordinator/
    phase-machine.ts             # Phase lifecycle (INTERVIEW → BLUEPRINT → BUILD → CREATE)
    scope-classifier.ts          # LARGE vs SMALL mutation classification
    session-state-machine.ts     # Session states (IDLE → ACTIVE → GATE_PENDING → COMPLETE → ARCHIVED)
    loop-detection.ts            # Prevents infinite specialist invocation loops
    content-router.ts            # IN_PROJECT specialist routing by keyword
  executor/
    specialist-executor.ts       # Single-turn LLM call with tool handling
    multi-turn-executor.ts       # Multi-turn loop: LLM → tool → re-invoke
    executor-guards.ts           # Timeout, stall, loop, maxTurns guards
    tool-validator.ts            # Zod-based tool input validation
  session/
    session-service.ts           # CRUD + lifecycle for ArchSession (MongoDB)
    resume-summary.ts            # Progress descriptions for Resume dialog
  journal/
    journal-service.ts           # Append-only journal (CC-F01)
  streaming/
    sse-serializer.ts            # ArchSSEEvent → wire format
    sse-parser.ts                # Wire format → ArchSSEEvent
  prompts/
    base.ts + phases/ + specialists/  # System prompt composition (incl. analyst.ts for read_insights)
  tools/
    definitions.ts               # LLM tool JSON schemas (INTERVIEW phase)
    schemas/in-project-schemas.ts  # Zod schemas for IN_PROJECT tools (17 tools incl. read_insights)
  mock-server/
    tool-extractor.ts            # ABL parser → tool metadata
    mock-project-generator.ts    # Vercel-deployable mock API generator
  types/
    session.ts, specification.ts, blueprint.ts, sse-events.ts,
    message-request.ts, tools.ts, errors.ts, execution.ts,
    auth-context.ts, chain-context.ts, constants.ts
```

### Studio — `apps/studio/src/`

```
  components/arch-ai/
    ArchAIChatPanel.tsx          # Main chat panel (1,194 lines)
    ArtifactPanel.tsx            # Side panel for artifacts
    DynamicTabRenderer.tsx       # Tab content rendering
    TopologyViewer.tsx           # Topology visualization
    CreateProjectApproval.tsx    # Project creation approval
    CodeBlockView.tsx            # ABL code display
    QACard.tsx                   # Q&A display card
    ThinkingIndicator.tsx        # Tool execution status
    ConversationDivider.tsx      # Phase dividers
    InlineTopologyPreview.tsx    # Inline topology preview
    InlineAgentsPreview.tsx      # Inline agents preview
    ask-user/                    # 5 widget types: SingleSelect, MultiSelect, TextInput, Confirmation, FileUpload
  store/
    arch-ai-store.ts             # v0.3 store: tabs, files, journal, artifacts
    arch-store.ts                # v2 compat store (panel, conversation)
    arch-config-store.ts         # Admin config
  lib/
    arch-llm.ts                  # LLM client resolution (4-tier: Model Hub → tenant key → platform env → none)
    arch-tools.ts                # Vercel AI SDK tool definitions
    tools/insight-queries.ts     # ClickHouse query helpers for read_insights (6 queries)
    arch-context-builder.ts      # Context injection for LLM calls
    arch-workflow.ts             # Workflow state machine
  app/api/arch-ai/
    message/route.ts             # POST /api/arch-ai/message — SSE streaming (1,743 lines)
    chat/route.ts                # POST /api/arch-ai/chat — Vercel AI SDK streamText
    sessions/route.ts            # POST — Create session
    sessions/current/route.ts    # GET — Current active session
    sessions/[id]/route.ts       # GET/DELETE — Session by ID
    sessions/[id]/archive/route.ts  # POST — Archive session
    sessions/[id]/journal/route.ts  # GET — Journal entries
```

### API Endpoints (v0.3)

| Endpoint                            | Method | Purpose                                  |
| ----------------------------------- | ------ | ---------------------------------------- |
| `/api/arch-ai/message`              | POST   | Send message, get SSE stream back        |
| `/api/arch-ai/chat`                 | POST   | Vercel AI SDK streamText (legacy compat) |
| `/api/arch-ai/sessions`             | POST   | Create new session                       |
| `/api/arch-ai/sessions/current`     | GET    | Get current active session               |
| `/api/arch-ai/sessions/:id`         | GET    | Get session by ID                        |
| `/api/arch-ai/sessions/:id`         | DELETE | Delete session with cascade              |
| `/api/arch-ai/sessions/:id/archive` | POST   | Archive session                          |
| `/api/arch-ai/sessions/:id/journal` | GET    | Get journal entries (filterable)         |

### State Management (v0.3)

- **arch-ai-store.ts**: Zustand. Artifact panel, dynamic tabs (max 8), IDE file panel, journal entries, session preservation, project creation state.
- **arch-store.ts**: Legacy v2 compat. Panel visibility, conversation state.
- **arch-config-store.ts**: Admin config (models, keys, status).

## 6. Design Principles

1. **Arch is opinionated, not prescriptive** -- proposes best practices but users can override
2. **Show, don't tell** -- topology renders live, diffs show exact changes, flow diagrams update in real-time
3. **Progressive disclosure** -- simple questions first, complexity later
4. **Escape hatches everywhere** -- switch to Pro mode, edit ABL directly, or close Arch at any time
5. **Context is king** -- Arch always knows what you're looking at
6. **Diffs, not replacements** -- Arch never silently replaces code
7. **Conversation is persistent** -- chat history preserved per-project
8. **Suggestions are actionable** -- every chip does something when clicked

## 7. Dependencies

| Dependency                         | Type     | Description                                               |
| ---------------------------------- | -------- | --------------------------------------------------------- |
| LLM Provider (OpenAI/Anthropic)    | External | Powers Arch's conversational and generative capabilities  |
| ABL Compiler (`packages/compiler`) | Internal | Validates generated ABL, extracts IR for context building |
| MongoDB                            | Internal | Stores conversations, project data, agent DSL             |
| Zustand                            | Library  | Client-side state management                              |
| Framer Motion                      | Library  | Panel animations, message entrance, topology transitions  |
| Vercel API                         | External | Mock project deployment (optional)                        |

## 8. Success Metrics

| Metric                                        | Target           | Measurement                                               |
| --------------------------------------------- | ---------------- | --------------------------------------------------------- |
| Project creation time (Arch-guided vs manual) | 50% reduction    | Time from "New Project" to first compiled agent           |
| Agent modification turnaround                 | < 30 seconds     | Time from request to applied diff                         |
| Compilation error rate post-Arch-edit         | < 5%             | Percentage of Arch-applied diffs that fail compilation    |
| Suggestion chip engagement                    | > 30%            | Percentage of sessions where at least one chip is clicked |
| New user retention (day 7)                    | +20% vs baseline | Users who return after first project creation             |
| Arch chat sessions per project                | > 5 avg          | Average chat interactions per project lifecycle           |

## 9. Alternatives / Options Considered

| Approach                                       | Pros                                                                                       | Cons                                                                                        | Decision                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Code-generation IDE plugin** (Copilot-style) | Familiar UX; inline suggestions                                                            | No lifecycle guidance; ignores ABL semantics; no project structure                          | Rejected — ABL is a domain-specific language that requires deep platform understanding, not generic code completion   |
| **Template gallery with manual customization** | Simple; no LLM cost; deterministic output                                                  | Inflexible; requires users to learn ABL syntax anyway; no iterative refinement              | Rejected — templates don't adapt to unique business requirements and still require DSL expertise                      |
| **Conversational AI assistant (chosen)**       | Guides full lifecycle; adapts to user intent; produces validated ABL via compilation gates | LLM cost; latency; hallucination risk                                                       | Chosen — the interview-to-deployment flow with deterministic phase gates balances AI flexibility with ABL correctness |
| **Visual drag-and-drop builder**               | Zero DSL learning curve; visual topology design                                            | Limited expressiveness; hard to represent ABL constructs like CONSTRAINTS, GATHER, FALLBACK | Deferred to future — could complement Arch AI as a secondary surface for topology design                              |

## 10. Migration Path

Arch AI is a new capability with no predecessor to migrate from. The v0.2 → v0.3 rewrite was internal and users had no production dependency on v0.2.

- **Feature flag**: `NEXT_PUBLIC_FEATURE_ARCH_AI=true` in Studio `.env.local` controls visibility
- **Data migration**: None required — Arch sessions use a dedicated MongoDB collection (`arch_sessions`) with no schema overlap with existing models
- **Rollback**: Disable the feature flag; existing projects are unaffected since Arch AI creates standard `ProjectAgent` records via the same APIs as the manual editor
- **Backward compatibility**: Projects created by Arch AI are fully editable in the standard ABL editor — no lock-in

## 11. Risks & Mitigations

| Risk                                     | Impact | Likelihood | Mitigation                                                       |
| ---------------------------------------- | ------ | ---------- | ---------------------------------------------------------------- |
| LLM hallucination produces invalid ABL   | High   | Medium     | Compilation validation gate; diffs require user approval         |
| LLM latency degrades UX                  | Medium | Medium     | Streaming responses; optimistic UI updates                       |
| Context window limits for large projects | Medium | Low        | Conversation compaction; selective IR extraction                 |
| API key exposure                         | High   | Low        | Server-side key storage; encrypted at rest; never sent to client |
| Rate limit exhaustion                    | Medium | Medium     | Per-tenant rate limits; graceful degradation message             |
| Cost overrun from excessive LLM usage    | Medium | Medium     | Token budgets per turn; admin-configurable limits                |

## 12. Feature Status & Maturity

> **v0.3 rewrite** — Status reflects the new contract-driven implementation, not the deprecated v2.

| Component                            | Status | Tests                           | Notes                                                          |
| ------------------------------------ | ------ | ------------------------------- | -------------------------------------------------------------- |
| **Core Engine (`packages/arch-ai`)** |        |                                 |                                                                |
| Phase machine (coordinator)          | ALPHA  | 760 unit tests, 99.3% stmts     | All 4 phases, transitions, exit criteria                       |
| Session state machine                | ALPHA  | ✅ Unit + E2E                   | 5 states, all transitions                                      |
| Specialist executor                  | ALPHA  | ✅ Unit                         | Single-turn + multi-turn with guards                           |
| Session service (MongoDB)            | ALPHA  | ✅ E2E (35 tests)               | CRUD, archive, cascade, tenant isolation                       |
| Journal service                      | ALPHA  | ✅ E2E                          | Append, query, filter, archive                                 |
| SSE streaming                        | ALPHA  | ✅ Unit                         | Serializer, parser, roundtrip, stream                          |
| Mock server generator                | ALPHA  | ✅ Unit                         | Tool extraction, OpenAPI, Vercel project                       |
| **Studio Routes**                    |        |                                 |                                                                |
| POST /api/arch-ai/message            | ALPHA  | ✅ E2E (13 tests with mock LLM) | SSE streaming, ONBOARDING + IN_PROJECT                         |
| Session CRUD routes (5)              | ALPHA  | ✅ E2E (35 tests)               | Full lifecycle verified                                        |
| POST /api/arch-ai/chat               | ALPHA  | ✅ Unit                         | Vercel AI SDK streamText                                       |
| **Studio Components**                |        |                                 |                                                                |
| Ask-user widgets (5 types)           | ALPHA  | ✅ 36 component tests           | SingleSelect, MultiSelect, TextInput, Confirmation, FileUpload |
| QACard, ThinkingIndicator            | ALPHA  | ✅ 15 component tests           | All states, answer types                                       |
| ArchAIChatPanel                      | ALPHA  | 2 tests (event listener only)   | Needs more coverage                                            |
| arch-ai-store                        | ALPHA  | ✅ 38 store tests               | Tabs, files, journal, artifacts, reset                         |
| **LLM Resolution**                   | ALPHA  | ✅ 15 integration tests         | All 4 tiers, error handling                                    |

### Test Coverage Summary

| Metric                 | Value                                                          |
| ---------------------- | -------------------------------------------------------------- |
| Total tests            | 1100+ (engine) + 822+ (studio)                                 |
| Core engine statements | 99.3%                                                          |
| Core engine functions  | 100%                                                           |
| E2E route coverage     | 33% (82-92% for session routes, 29% for message route)         |
| Full report            | [`docs/arch/14-test-coverage.md`](../arch/14-test-coverage.md) |

### Status: BETA

Meets ALPHA criteria:

- ✅ Implementation phases complete (core engine + routes + components)
- ✅ Core happy path works (create session → interview → message → archive)
- ✅ E2E tests passing (48 tests with real MongoDB)
- ✅ 760+ unit tests with 99.3% coverage

Does NOT yet meet STABLE:

- ❌ Message route streaming coverage at 29% (tool execute callbacks untested in E2E)
- ❌ ArchAIChatPanel has minimal test coverage
- ❌ IN_PROJECT multi-turn executor path has Vite SSR import issue in E2E
- ❌ `read_insights` tool needs integration tests with real ClickHouse
- ❌ Analyst specialist needs E2E test verifying closed-loop (read_insights → propose_modification)

### Recent Changes (2026-04-07)

**Insights → Agent Improvement Pipeline** — Bridges ClickHouse analytics into Arch AI IN_PROJECT mode:

- New `read_insights` tool (17th tool) with 6 ClickHouse query actions: overview, quality, outcomes, agent_performance, sentiment, tool_performance
- New `analyst` specialist with dedicated prompt — first IN_PROJECT specialist with its own prompt (others use base + phase prompt only)
- Content router widened to `AnySpecialistId` — enables IN_PROJECT specialists in routing (was previously ONBOARDING-only type)
- Closed-loop flow: analyst reads insights → reads agent DSL → proposes ABL modification
- Queries 6 existing ClickHouse tables: insight_results, quality_evaluations, conversation_outcomes, platform_events_agent_hourly_dest, conversation_sentiment, platform_events_tool_daily_dest

---

_Feature spec updated 2026-04-07. v0.3 rewrite on `features/arch-ai` branch. See `docs/arch/` for full design docs._
