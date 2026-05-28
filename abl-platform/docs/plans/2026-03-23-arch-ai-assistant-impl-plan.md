# LLD + Implementation Plan: Arch AI Assistant

> **Feature**: Arch -- AI-Guided Project Lifecycle Assistant
> **Backlog Item**: #74
> **Status**: STABLE (Post-Implementation Documentation)
> **Last Updated**: 2026-03-23

---

## 1. Implementation Status

This LLD documents the completed implementation of the Arch AI Assistant. The feature was built across 6 phases and is at STABLE status. This document serves as a reference for future modifications, extensions, and onboarding.

## 2. Module-Level Design

### 2.1 Type System (`apps/studio/src/types/arch.ts`, ~700 lines)

The type system is the foundation. Key design decisions:

**Lifecycle types**:

- `LifecycleStage`: 7 stages (`ideate | design | build | test | deploy | evolve | edit`)
- `OnboardingPhase`: 7 phases (`welcome | interview | upload | generating | reveal | review | create`)
- `ArchMode`: `assisted | pro`

**Message types**:

- `ArchMessage`: Core message with optional payloads (diff, topology, brief updates, code blocks, plan/proposal data)
- `ArchMessageRole`: `arch | user`
- Message `type` discriminant: `message | error | plan | proposal | system`
- `PlanData` and `ProposalData` for structured messages

**Workflow types**:

- `WorkflowState`: 5 states (`idle | contextualizing | responding | confirming | executing`)
- `ArchAction`: Discriminated union (`confirm | reject | refine | send | none`)
- `ArchProposal`: Small-scope (section diffs) or large-scope (plan with steps)
- `ArchSectionDiff`: Per-section before/after with summary

**Domain types**:

- `TopologyNode`, `TopologyEdge`, `TopologyData`: SVG graph model
- `AgentSpec`: Complete behavioral specification (tools, gather, flow, constraints, routing)
- `ProjectBrief`: Domain, problem, use cases, users, channels, tone, constraints
- `OpenAPISpec`, `MockProjectBundle`: Generated artifact shapes

**API contracts**:

- `ArchChatRequest` / `ArchChatResponse`: Chat endpoint types
- `ArchGenerateRequest` / `ArchGenerateResponse`: Generation endpoint types
- `ArchWorkflowChatRequest` / `ArchWorkflowChatResponse`: Extended workflow types

### 2.2 Arch Store (`apps/studio/src/store/arch-store.ts`, ~815 lines)

**Persistence strategy**: Zustand `persist` middleware with version 2. Partializes to only persist `mode`, `conversations`, `activeConversationId`, and `context`. All workflow state, diffs, and edit context are ephemeral.

**Conversation management**:

- Keyed by `proj-{projectId}` (project-level) or `{projectId}/{agentId}` (agent-scoped)
- `MAX_PERSISTED_MESSAGES = 30`: Older messages compressed to summary preamble
- `MAX_PERSISTED_CONVERSATIONS = 10`: Stale conversations evicted by timestamp
- Heavy payload stripping: `topology`, `diff`, `briefUpdates`, `codeBlocks`, `isStreaming` removed before persist

**Server sync**:

- `SAVE_DEBOUNCE_MS = 2000`: Saves debounced after last message
- `loadFromServer(projectId)`: Loads from MongoDB, validates message shape, overwrites local
- `saveToServer()`: Schedules debounced save
- `deleteFromServer()`: Removes server-side conversation

**Workflow state machine**:

- `handleWorkflowResponse()`: Updates state, actions, and proposal in single atomic set
- `resetWorkflow()`: Returns to idle with `send` action, clears proposal
- Context change triggers workflow reset (agent or page navigation)

**Section suggestions**:

- 8 sections (IDENTITY, TOOLS, GATHER, FLOW, RULES, COORDINATION, LIFECYCLE) + DEFAULT
- Each section has 2-3 contextual suggestions with id, label, category, prompt, icon
- `getSuggestionsForSection()` resolves suggestions for active section

### 2.3 Lifecycle Store (`apps/studio/src/store/lifecycle-store.ts`, ~233 lines)

**Manages onboarding wizard state**:

- Phase transitions: `setOnboardingPhase(phase)`
- Brief accumulation: `updateBrief(partial)`
- Topology and agent storage: `setTopology()`, `setGeneratedAgents()`
- Spec results: OpenAPI, mock project, deploy result
- Review tab tracking: 3 tabs (agents, openapi, mocks) with `advanceReview()` / `goBackToTab()`
- Creation results: Per-agent status (pending, saving, success, failed, warning)
- Full reset via `reset()` method

**Selectors**:

- `selectBriefCompleteness`: Percentage (0-100) based on 6 fields filled
- `selectAllReviewed`: Boolean when all review tabs visited

### 2.4 Config Store (`apps/studio/src/store/arch-config-store.ts`, ~197 lines)

**No persistence** -- always fetches fresh from server.

**Managed state**:

- `ArchStatus`: `configured`, `model`, `provider`, `source` (tenant/platform/none)
- `ArchConfigData`: Full configuration with model, rate limits, hyper-parameters, version
- `ModelOption[]`: Available models with tier (fast/balanced/powerful), capabilities
- `KeyValidationResult`: `valid` (boolean|null), `message`

**Actions**:

- `fetchStatus()`: GET `/api/arch/status`
- `fetchConfig()`: GET `/api/arch/config`
- `fetchModels()`: GET `/api/arch/models`
- `updateConfig(updates)`: PUT `/api/arch/config`
- `validateApiKey(provider, apiKey)`: POST `/api/arch/validate-key`

### 2.5 Components

#### Arch Panel Components (`apps/studio/src/components/arch/`)

| File                      | Lines                                                                                                                                     | Key Behavior |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `ArchPanel.tsx`           | Panel shell with expand/collapse/minimize. Uses Framer Motion for animation. Renders ArchChat when open.                                  |
| `ArchChat.tsx`            | Message list with auto-scroll, input field, typing indicator. Handles send/workflow actions.                                              |
| `ArchMessage.tsx`         | Renders message bubble with markdown, code blocks, agent name, timestamp. Dispatches to PlanMessage/ProposalMessage for structured types. |
| `ArchDiffView.tsx`        | Side-by-side or inline diff rendering with Apply/Reject. Calls `applyDiff`/`rejectDiff` on store.                                         |
| `ArchSuggestionChips.tsx` | Horizontal chip bar with icons. Clicking sends chip's prompt to Arch.                                                                     |
| `ArchIcon.tsx`            | SVG geometric "A" logomark.                                                                                                               |
| `PlanMessage.tsx`         | Renders large-scope plans with summary and step list.                                                                                     |
| `ProposalMessage.tsx`     | Renders proposals with section diffs (small) or plan (large).                                                                             |
| `index.ts`                | Barrel export for all arch components.                                                                                                    |

#### Onboarding Components (`apps/studio/src/components/onboarding/`)

| File                  | Key Behavior                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `ArchOnboarding.tsx`  | Full-screen wizard shell. Routes to phase components based on lifecycle-store phase.     |
| `WelcomePhase.tsx`    | Welcome screen with "Quick Generate" input or template selection.                        |
| `InterviewPhase.tsx`  | Arch chat interface for requirement gathering. Updates brief as conversation progresses. |
| `UploadPhase.tsx`     | Drag-and-drop file upload with extraction status.                                        |
| `GeneratingPhase.tsx` | Multi-stage progress bar showing pipeline stages.                                        |
| `RevealPhase.tsx`     | Animated topology reveal with node-by-node entrance.                                     |
| `ReviewPhase.tsx`     | Tabbed review: Agents (ABL preview), API Spec (OpenAPI), Mock Data (file listing).       |
| `CreatePhase.tsx`     | Per-agent creation status with progress indicators.                                      |

### 2.6 Server-Side Modules

#### arch-llm.ts (`apps/studio/src/lib/arch-llm.ts`)

LLM integration layer:

- Constructs system prompt with platform knowledge, ABL syntax rules, and current context
- Manages tool definitions and tool call execution loop
- Handles streaming responses for chat
- Structured output mode for generation (topology, specs, agents, OpenAPI)

#### arch-tools.ts (`apps/studio/src/lib/arch-tools.ts`)

Tool definitions for the LLM agentic loop:

- `read_agent_dsl`: Reads current agent DSL from project data
- `compile_abl`: Validates ABL through the compiler package
- `propose_modification`: Returns structured modification proposal
- Additional tools for project/agent data access

#### arch-context-builder.ts (`apps/studio/src/lib/arch-context-builder.ts`)

Extracts structured context from compiled IR for injection into LLM prompts:

- Parses compiled IR to extract: agent metadata, constraints, tools, gather fields, flow steps, coordination (handoffs, delegates, escalation), behavior profiles
- Reports compile errors and warnings
- Produces `ArchAgentContext` shape consumed by arch-llm.ts

#### arch-workflow.ts (`apps/studio/src/lib/arch-workflow.ts`)

Workflow state machine logic:

- Determines valid state transitions based on current state and LLM response
- `stageUsesWorkflow()` gates which lifecycle stages use the state machine
- Manages proposal lifecycle (create, confirm, reject, refine)
- Validation gate after execution (compilation check)

#### arch.service.ts (`apps/studio/src/services/arch.service.ts`)

Orchestration service:

- Routes chat requests to appropriate handler based on stage
- Coordinates between LLM integration, context builder, and compiler
- Manages conversation persistence (load, save, delete)
- Handles config CRUD with encryption

### 2.7 API Routes (`apps/studio/src/app/api/arch/`)

| Route File              | Method  | Handler Logic                                                                     |
| ----------------------- | ------- | --------------------------------------------------------------------------------- |
| `chat/route.ts`         | POST    | Validates request, calls arch.service chat handler, returns ArchChatResponse      |
| `generate/route.ts`     | POST    | Validates request, calls arch.service generate handler by type, returns artifacts |
| `config/route.ts`       | GET/PUT | Reads or updates tenant Arch configuration                                        |
| `status/route.ts`       | GET     | Lightweight check: is Arch configured for this tenant?                            |
| `models/route.ts`       | GET     | Returns static model catalog (recommended + other)                                |
| `validate-key/route.ts` | POST    | Calls provider API to validate key, returns result                                |
| `deploy-mocks/route.ts` | POST    | Deploys mock project bundle to Vercel                                             |

## 3. Implementation Phases (Completed)

### Phase 1: Foundation (MVP)

**Exit Criteria**: Panel renders, chat works, mode toggle persists.

| Item                            | Status | Files                             |
| ------------------------------- | ------ | --------------------------------- |
| ArchPanel component             | Done   | `components/arch/ArchPanel.tsx`   |
| ArchChat with message rendering | Done   | `components/arch/ArchChat.tsx`    |
| ArchMessage with markdown/code  | Done   | `components/arch/ArchMessage.tsx` |
| Assisted/Pro mode toggle        | Done   | `store/arch-store.ts`             |
| Zustand store with persist      | Done   | `store/arch-store.ts`             |
| Chat API endpoint               | Done   | `app/api/arch/chat/route.ts`      |
| Basic LLM integration           | Done   | `lib/arch-llm.ts`                 |
| Type definitions                | Done   | `types/arch.ts`                   |

### Phase 2: Project Creation Wizard

**Exit Criteria**: User can go from idea to created project through Arch-guided wizard.

| Item                 | Status | Files                                        |
| -------------------- | ------ | -------------------------------------------- |
| NewProjectDropdown   | Done   | `components/creation/NewProjectDropdown.tsx` |
| ArchOnboarding shell | Done   | `components/onboarding/ArchOnboarding.tsx`   |
| WelcomePhase         | Done   | `components/onboarding/WelcomePhase.tsx`     |
| InterviewPhase       | Done   | `components/onboarding/InterviewPhase.tsx`   |
| UploadPhase          | Done   | `components/onboarding/UploadPhase.tsx`      |
| GeneratingPhase      | Done   | `components/onboarding/GeneratingPhase.tsx`  |
| RevealPhase          | Done   | `components/onboarding/RevealPhase.tsx`      |
| ReviewPhase          | Done   | `components/onboarding/ReviewPhase.tsx`      |
| CreatePhase          | Done   | `components/onboarding/CreatePhase.tsx`      |
| Lifecycle store      | Done   | `store/lifecycle-store.ts`                   |
| Topology generation  | Done   | `app/api/arch/generate/route.ts`             |
| ABL generation       | Done   | `app/api/arch/generate/route.ts`             |
| TopologyCanvas       | Done   | `components/topology/TopologyCanvas.tsx`     |

### Phase 3: Build Integration

**Exit Criteria**: Arch modifies agents conversationally with diff preview and apply.

| Item                      | Status | Files                                       |
| ------------------------- | ------ | ------------------------------------------- |
| ArchDiffView              | Done   | `components/arch/ArchDiffView.tsx`          |
| ArchSuggestionChips       | Done   | `components/arch/ArchSuggestionChips.tsx`   |
| Context awareness         | Done   | `store/arch-store.ts` (setContext)          |
| Section-aware suggestions | Done   | `store/arch-store.ts` (SECTION_SUGGESTIONS) |
| ABL modification from NL  | Done   | `lib/arch-tools.ts`                         |
| Diff application to DSL   | Done   | `store/arch-store.ts` (applyDiff)           |

### Phase 4: Configuration & Admin

**Exit Criteria**: Admin can configure LLM model, API key, and rate limits.

| Item              | Status | Files                                |
| ----------------- | ------ | ------------------------------------ |
| Config store      | Done   | `store/arch-config-store.ts`         |
| Config API routes | Done   | `app/api/arch/config/route.ts`       |
| Status endpoint   | Done   | `app/api/arch/status/route.ts`       |
| Models endpoint   | Done   | `app/api/arch/models/route.ts`       |
| Key validation    | Done   | `app/api/arch/validate-key/route.ts` |
| Settings page     | Done   | (admin UI)                           |

### Phase 5: Quick Generate Pipeline

**Exit Criteria**: Full pipeline from brief to deployable mocks.

| Item                    | Status | Files                                |
| ----------------------- | ------ | ------------------------------------ |
| Topology generation     | Done   | `app/api/arch/generate/route.ts`     |
| Agent spec generation   | Done   | `app/api/arch/generate/route.ts`     |
| ABL generation          | Done   | `app/api/arch/generate/route.ts`     |
| OpenAPI generation      | Done   | `app/api/arch/generate/route.ts`     |
| Mock project generation | Done   | `app/api/arch/generate/route.ts`     |
| Deploy mocks            | Done   | `app/api/arch/deploy-mocks/route.ts` |

### Phase 6: Edit UX & Workflow

**Exit Criteria**: 5-state workflow machine, section-scoped chat, IR context extraction.

| Item                               | Status | Files                                             |
| ---------------------------------- | ------ | ------------------------------------------------- |
| Workflow state machine             | Done   | `lib/arch-workflow.ts`, `store/arch-store.ts`     |
| IR context builder                 | Done   | `lib/arch-context-builder.ts`                     |
| Edit context types                 | Done   | `types/arch.ts` (ArchEditContext, AgentSectionId) |
| PlanMessage component              | Done   | `components/arch/PlanMessage.tsx`                 |
| ProposalMessage component          | Done   | `components/arch/ProposalMessage.tsx`             |
| Section-scoped chat                | Done   | `lib/arch-tools.ts`, `store/arch-store.ts`        |
| Conversation persistence (MongoDB) | Done   | `api/arch.ts`, `services/arch.service.ts`         |

## 4. Wiring Checklist

### Component Wiring

| Source              | Target            | Wire                                     | Status |
| ------------------- | ----------------- | ---------------------------------------- | ------ |
| ArchPanel           | arch-store        | `useArchStore` hook                      | Wired  |
| ArchChat            | arch-store        | Messages, typing, send                   | Wired  |
| ArchChat            | API               | `POST /api/arch/chat`                    | Wired  |
| ArchDiffView        | arch-store        | `applyDiff`, `rejectDiff`                | Wired  |
| ArchSuggestionChips | arch-store        | `getSuggestionsForSection`               | Wired  |
| ArchOnboarding      | lifecycle-store   | Phase, brief, topology                   | Wired  |
| ReviewPhase         | lifecycle-store   | specResults, advanceReview               | Wired  |
| CreatePhase         | lifecycle-store   | creationResults                          | Wired  |
| Config page         | arch-config-store | fetchConfig, updateConfig                | Wired  |
| Mode toggle         | arch-store        | `setMode`                                | Wired  |
| Context tracking    | arch-store        | `setContext` on page navigation          | Wired  |
| Agent editor        | arch-store        | `setEditContext` on section focus        | Wired  |
| Diff apply          | Agent DSL API     | `PUT /api/projects/:id/agents/:name/dsl` | Wired  |

### Data Flow Wiring

| Flow                     | Components                                                | Status |
| ------------------------ | --------------------------------------------------------- | ------ |
| Chat message round-trip  | ArchChat -> API -> LLM -> Response -> ArchChat            | Wired  |
| Conversation persistence | arch-store -> scheduleSave -> MongoDB                     | Wired  |
| Conversation load        | Project switch -> loadFromServer -> arch-store            | Wired  |
| Topology generation      | Brief -> generate API -> lifecycle-store -> RevealPhase   | Wired  |
| Agent creation           | CreatePhase -> project API -> per-agent status            | Wired  |
| Config update            | Settings page -> config-store -> config API               | Wired  |
| Diff lifecycle           | LLM propose -> pendingDiffs -> Apply/Reject -> DSL update | Wired  |
| Workflow state           | Chat response -> handleWorkflowResponse -> UI actions     | Wired  |

## 5. Testing Strategy

### Existing Tests (13 arch-specific test files)

| Test File                       | Type        | Focus                      |
| ------------------------------- | ----------- | -------------------------- |
| `arch-components.test.tsx`      | Unit        | Component rendering, state |
| `arch-config-api.test.ts`       | Integration | Config API behavior        |
| `arch-config-store.test.ts`     | Unit        | Config store actions       |
| `arch-context-profiles.test.ts` | Unit        | IR context extraction      |
| `arch-edit-context.test.ts`     | Integration | Edit context propagation   |
| `arch-edit-ux-types.test.ts`    | Unit        | Type shape validation      |
| `arch-generate-openapi.test.ts` | Unit        | OpenAPI generation         |
| `arch-llm.test.ts`              | Unit        | LLM integration            |
| `arch-onboarding-store.test.ts` | Unit        | Lifecycle store            |
| `arch-section-chat.test.ts`     | Integration | Section-scoped chat        |
| `arch-section-wiring.test.tsx`  | Integration | Suggestion chip wiring     |
| `arch-settings-page.test.tsx`   | Unit        | Settings page rendering    |
| `arch-workflow.test.ts`         | Unit        | Workflow state machine     |

### Recommended Future Tests

| Priority | Test                               | Type        | Gap                             |
| -------- | ---------------------------------- | ----------- | ------------------------------- |
| P1       | Full chat round-trip with LLM      | E2E         | Real LLM response validation    |
| P1       | Conversation MongoDB persistence   | E2E         | Save/load/delete cycle          |
| P1       | Quick Generate pipeline end-to-end | E2E         | Multi-stage artifact generation |
| P2       | Deploy mocks endpoint              | E2E         | Vercel deployment smoke test    |
| P2       | Rate limiting enforcement          | Integration | Per-tenant limits               |
| P2       | Error recovery (LLM timeout)       | Integration | Graceful degradation            |
| P3       | Accessibility audit                | E2E         | WCAG 2.1 AA compliance          |

## 6. Known Issues & Technical Debt

| Issue                              | Severity | Description                                                                            |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `console.error` in arch-store      | Low      | Three `console.error` calls for persistence failures; should migrate to `createLogger` |
| No i18n for suggestion chips       | Low      | Chip labels are hardcoded English strings                                              |
| `as any` in handleWorkflowResponse | Low      | Type assertion for partial state update; could use proper typing                       |
| Static model catalog               | Low      | Models list is hardcoded; should be fetched from provider APIs                         |
| No retry for LLM failures          | Medium   | Chat fails silently on LLM timeout; should add retry with backoff                      |

## 7. Extension Points

| Extension                  | Where to Modify                                                  | Notes                                           |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| Add new lifecycle stage    | `types/arch.ts` (LifecycleStage), `LIFECYCLE_STAGES`             | Add to both the type union and the stages array |
| Add new suggestion section | `store/arch-store.ts` (SECTION_SUGGESTIONS)                      | Add new key with ArchSuggestion[]               |
| Add new tool to LLM        | `lib/arch-tools.ts`                                              | Define tool schema and handler                  |
| Add new generate type      | `types/arch.ts` (SpecGenStage), `app/api/arch/generate/route.ts` | Add type and handler                            |
| Add new onboarding phase   | `types/arch.ts` (OnboardingPhase), `components/onboarding/`      | Add phase type and component                    |
| Add new model provider     | `app/api/arch/models/route.ts`, `arch-config-store.ts`           | Add to catalog and config                       |

---

_LLD generated 2026-03-23. Grounded in implementation at `apps/studio/src/`. All phases completed and at STABLE status._
