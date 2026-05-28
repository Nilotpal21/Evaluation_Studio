# LLD + Implementation Plan: Arch AI v0.3

**Feature**: Arch AI v0.3 -- AI-assisted agent design and project creation
**Feature Spec**: [docs/features/arch-ai-assistant.md](../features/arch-ai-assistant.md)
**HLD**: [docs/specs/arch-ai-v03.hld.md](../specs/arch-ai-v03.hld.md)
**Test Spec**: [docs/testing/arch-ai-assistant.md](../testing/arch-ai-assistant.md)
**Status**: APPROVED
**Last Updated**: 2026-04-06
**Type**: HYBRID retroactive LLD -- documents existing implementation + plans remaining work

---

## 0. Problem Statement

Arch AI v0.3 replaces a failed v0.2 prototype that suffered from unpredictable LLM-driven phase transitions, session lifecycle bugs, and a monolithic architecture that couldn't be extended to new surfaces. The core problems this implementation plan addresses:

1. **Unpredictable flow**: v0.2 let the LLM decide when to advance phases, causing skipped steps and inconsistent outcomes. v0.3 introduces a deterministic phase machine with typed exit criteria.
2. **Session instability**: Users frequently got stuck in ACTIVE state with no recovery path. v0.3 adds `forceArchiveStuck` and the ACTIVE→IDLE transition.
3. **Surface coupling**: All logic was embedded in the Next.js route handler. v0.3 extracts a surface-agnostic `packages/arch-ai` engine so the same logic can serve Studio, MCP, and CLI.
4. **Missing in-project mode**: v0.2 only supported project creation. v0.3 adds IN_PROJECT mode for conversational agent modification with propose-review-apply workflow.

This LLD documents the as-built state (85%+ implemented) and plans the remaining delta to reach BETA maturity.

## 1. Design Decisions

### 1.1 Decision Log

| #    | Decision                                | Choice                                                           | Rationale                                                                                                                              | Oracle Ref |
| ---- | --------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D-1  | Hybrid retroactive + forward LLD        | Document existing code as-built, plan only remaining gaps        | 85%+ of Arch AI v0.3 is implemented. A pure greenfield LLD would be fiction. This doc maps reality then plans the delta.               | --         |
| D-2  | Engine package is surface-agnostic      | All tool execution lives in Studio route, not engine             | Engine (`packages/arch-ai`) owns types, prompts, coordination, and session logic. Tool execution is surface-specific (Next.js routes). | OQ-3       |
| D-3  | One specialist per turn, sequential     | No parallel specialist execution                                 | Simplicity. The LLM sees one system prompt per turn. Parallel specialists would require multi-head streaming.                          | --         |
| D-4  | Deterministic phase transitions         | LLM never decides when to advance phases                         | Root cause of v0.2 failures: LLM skipping phases. Phase machine evaluates typed exit criteria, not LLM judgment.                       | --         |
| D-5  | SSE over HTTP POST, no WebSockets       | POST /message returns SSE stream per request                     | Stateless. Each message is a new HTTP request. No persistent connection management. Compatible with Next.js edge/serverless.           | --         |
| D-6  | Message array capped at 200, LLM sees 8 | `MAX_STORED_MESSAGES: 200`, sliding window of 8 for LLM          | Full history for UI scroll-back. Sliding window controls token cost. Resume summary bridges context gaps.                              | --         |
| D-7  | Session-per-mode uniqueness             | One non-terminal session per (tenantId, userId, mode, projectId) | Prevents duplicate sessions. Force-archive resolves stuck sessions.                                                                    | OQ-5       |
| D-8  | Priority: stuck sessions first          | R1 before all other remaining work                               | User-blocking bug. Users cannot start new sessions when old one is stuck ACTIVE. develop PR prerequisite.                              | OQ-5       |
| D-9  | Rate limiting before TraceEvent         | R5.2 (rate limiting) before R5.1 (TraceEvent)                    | Production prerequisite. DoS protection matters more than observability for launch.                                                    | OQ-4       |
| D-10 | Route extraction enables MCP surface    | R4 must complete before MCP surface work can begin               | 3,093-line message route cannot be reused by an MCP surface. Extraction to handler modules is prerequisite.                            | OQ-3       |

### 1.2 Key Interfaces and Types

```typescript
// packages/arch-ai/src/types/session.ts

type ArchPhase = 'INTERVIEW' | 'BLUEPRINT' | 'BUILD' | 'CREATE';
type ArchMode = 'ONBOARDING' | 'IN_PROJECT';
type SessionState = 'IDLE' | 'ACTIVE' | 'GATE_PENDING' | 'COMPLETE' | 'ARCHIVED';

interface SessionMetadata {
  phase: ArchPhase;
  mode: ArchMode;
  specification: Specification;
  pendingInteraction: PendingInteraction | null;
  messages: StoredMessage[];
  projectId?: string;
  topology?: Record<string, unknown>;
  blueprintOutput?: Record<string, unknown>;
  topologyApproved?: boolean;
  files?: Record<string, unknown>;
  mockServer?: {
    projectName: string;
    endpointCount: number;
    files: Array<{ path: string; content: string }>;
  } | null;
  activeSpecialist?: string; // IN_PROJECT: currently active specialist
  pendingMutation?: {
    // IN_PROJECT: mutation awaiting approval
    tool: string;
    target: string;
    scope: 'SMALL' | 'MEDIUM' | 'LARGE';
    before?: unknown;
    after?: unknown;
  };
}

interface ArchSession {
  id: string;
  tenantId: string;
  userId: string;
  state: SessionState;
  metadata: SessionMetadata;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

```typescript
// packages/arch-ai/src/types/message-request.ts

type MessageRequest =
  | {
      sessionId: string;
      type: 'message';
      text: string;
      files?: FileAttachment[];
      fileRefs?: { blobId: string }[];
      pageContext?: PageContext;
    }
  | { sessionId: string; type: 'tool_answer'; toolCallId: string; answer: unknown }
  | {
      sessionId: string;
      type: 'gate_response';
      gateId: string;
      action: 'accept' | 'modify' | 'reject';
      feedback?: string;
    }
  | { sessionId: string; type: 'continue' }
  | { sessionId: string; type: 'create' };
```

```typescript
// packages/arch-ai/src/types/sse-events.ts (16 event types)

type ArchSSEEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName?: string;
      result: unknown;
      isError?: boolean;
    }
  | { type: 'specialist'; name: string; icon: string }
  | { type: 'phase_transition'; from: string; to: string }
  | { type: 'journal_entry'; entryType: string; summary: string; description?: string }
  | { type: 'file_changed'; path: string; action: 'create' | 'update' | 'delete'; content?: string }
  | {
      type: 'compile_result';
      agent: string;
      status: 'pass' | 'fail';
      errors?: string[];
      warnings?: string[];
    }
  | { type: 'gate_request'; gateType: string; data: Record<string, unknown> }
  | { type: 'progress'; step: number; total: number; label: string }
  | { type: 'done'; suggestions?: Suggestion[] }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | {
      type: 'activity';
      id: string;
      status: string;
      label: string;
      group?: string;
      groupLabel?: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: 'file_processed';
      blobId: string;
      name: string;
      mediaType: string;
      size: number;
      tokenCost: number;
      metadata: Record<string, unknown>;
    }
  | {
      type: 'file_error';
      fileName: string;
      error: { code: string; message: string };
      recovery: string[];
    }
  | {
      type: 'file_context_change';
      blobId: string;
      change: string;
      contextBudget?: { used: number; total: number };
    };
```

```typescript
// packages/arch-ai/src/types/constants.ts

const SPECIALIST_IDS = [
  'onboarding',
  'multi-agent-architect',
  'abl-construct-expert',
  'governance',
  'channel-voice',
  'entity-collection',
  'integration-methodologist',
  'observability-analyst',
  'testing-eval',
] as const;

const IN_PROJECT_SPECIALIST_IDS = [
  'project-architect',
  'diagnostician',
  'analyst',
  'quality-engineer',
  'platform-guide',
] as const;
```

### 1.3 Specialist Wiring Status

| Specialist                  | Mode       | Prompt | Engine Route | Studio Tools | Status          |
| --------------------------- | ---------- | ------ | ------------ | ------------ | --------------- |
| `onboarding`                | ONBOARDING | Yes    | Yes          | Yes          | Fully wired     |
| `multi-agent-architect`     | ONBOARDING | Yes    | Yes          | Yes          | Fully wired     |
| `abl-construct-expert`      | ONBOARDING | Yes    | Yes          | Yes          | Fully wired     |
| `governance`                | ONBOARDING | No     | No           | No           | Defined only    |
| `channel-voice`             | ONBOARDING | Yes    | No           | No           | Prompt only     |
| `entity-collection`         | ONBOARDING | Yes    | No           | No           | Prompt only     |
| `integration-methodologist` | ONBOARDING | Yes    | Partial      | Partial      | Partially wired |
| `observability-analyst`     | ONBOARDING | Yes    | Partial      | Partial      | Partially wired |
| `testing-eval`              | ONBOARDING | Yes    | No           | No           | Prompt only     |
| `project-architect`         | IN_PROJECT | No     | Yes          | Yes          | Partially wired |
| `diagnostician`             | IN_PROJECT | No     | Yes          | Yes          | Partially wired |
| `analyst`                   | IN_PROJECT | Yes    | Yes          | Yes          | Fully wired     |
| `quality-engineer`          | IN_PROJECT | No     | Yes          | Yes          | Partially wired |
| `platform-guide`            | IN_PROJECT | No     | Yes          | Yes          | Partially wired |

**Fully wired (5)**: onboarding, multi-agent-architect, abl-construct-expert, content-router for IN_PROJECT, **analyst** (dedicated prompt + read_insights tool + content routing).
**Partially wired (5)**: integration-methodologist, observability-analyst (have prompts, partial tool wiring); 4 IN_PROJECT specialists (have display config + content routing, no dedicated prompts -- use base + IN_PROJECT phase prompt).
**Prompt only (3)**: channel-voice, entity-collection, testing-eval (prompts exist, no route-level wiring).
**Defined only (1)**: governance (constant defined, nothing else).

### 1.4 Tool Inventory (17 tools in 4 groups)

| Group      | Tool                   | Phase(s)          | Type        | Wired |
| ---------- | ---------------------- | ----------------- | ----------- | ----- |
| Interview  | `ask_user`             | ALL               | client-side | Yes   |
| Interview  | `collect_file`         | ALL except CREATE | client-side | Yes   |
| Interview  | `update_specification` | INTERVIEW         | server-side | Yes   |
| Blueprint  | `generate_topology`    | BLUEPRINT         | server-side | Yes   |
| Blueprint  | `suggest_guardrails`   | BLUEPRINT         | server-side | Yes   |
| Build      | `generate_agent`       | BUILD, IN_PROJECT | server-side | Yes   |
| Build      | `compile_abl`          | BUILD, IN_PROJECT | server-side | Yes   |
| Build      | `propose_modification` | BUILD, IN_PROJECT | server-side | Yes   |
| IN_PROJECT | `query_traces`         | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `run_test`             | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `health_check`         | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `read_agent`           | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `read_topology`        | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `recommend_model`      | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `analyze_constraints`  | IN_PROJECT        | server-side | Yes   |
| IN_PROJECT | `read_insights`        | IN_PROJECT        | server-side | Yes   |
| Create     | `create_project`       | CREATE            | server-side | Yes   |

---

## FR Implementation Status

| FR    | Name                     | Status      | Evidence                                                                                                     |
| ----- | ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| FR-1  | Arch Panel               | IMPLEMENTED | ArchShell.tsx, useArchChat.ts                                                                                |
| FR-2  | Assisted/Pro Mode        | IMPLEMENTED | arch-ai-store.ts mode field                                                                                  |
| FR-3  | Project Creation Wizard  | IMPLEMENTED | Phase machine, 4-phase ONBOARDING flow                                                                       |
| FR-4  | Agent Modification       | IMPLEMENTED | propose_modification + apply_modification tools                                                              |
| FR-5  | Workflow State Machine   | IMPLEMENTED | useArchChat hook client-side states                                                                          |
| FR-6  | Context Awareness        | IMPLEMENTED | B02 Page Context, specialist routing                                                                         |
| FR-7  | Suggestion Chips         | IMPLEMENTED | generateSuggestions(), done SSE event                                                                        |
| FR-8  | Conversation Persistence | IMPLEMENTED | SessionService, 200 message cap. Note: FR-8.2 says 30 messages but actual is 200 -- update in post-impl-sync |
| FR-9  | Configuration & Admin    | IMPLEMENTED | ArchWorkspaceConfig, 4-tier LLM resolution                                                                   |
| FR-10 | Quick Generate Pipeline  | IMPLEMENTED | 5-stage pipeline in BUILD phase                                                                              |

---

## 2. File-Level Change Map

### 2.1 Engine Package (`packages/arch-ai/src/`)

Total: 55 source files, ~5,565 lines (excluding tests).

#### 2.1.1 `coordinator/` -- Deterministic flow control (6 files)

| File                       | Lines | Purpose                                                               |
| -------------------------- | ----- | --------------------------------------------------------------------- |
| `index.ts`                 | 24    | Barrel exports                                                        |
| `phase-machine.ts`         | ~130  | Phase lifecycle: PHASE_CONFIG, transitionPhase, exit criteria         |
| `session-state-machine.ts` | 72    | Session state transitions: IDLE/ACTIVE/GATE_PENDING/COMPLETE/ARCHIVED |
| `scope-classifier.ts`      | ~80   | Mutation scope classification (SMALL/MEDIUM/LARGE)                    |
| `loop-detection.ts`        | ~60   | SHA-256 input hash, threshold=3 per turn                              |
| `content-router.ts`        | ~90   | IN_PROJECT keyword-based specialist routing                           |

#### 2.1.2 `executor/` -- LLM execution (6 files)

| File                        | Lines | Purpose                                                         |
| --------------------------- | ----- | --------------------------------------------------------------- |
| `index.ts`                  | 24    | Barrel exports                                                  |
| `specialist-executor.ts`    | ~200  | Single-turn LLM execution with SSE streaming                    |
| `multi-turn-executor.ts`    | ~180  | Multi-turn tool loop (execute tool -> feed result -> repeat)    |
| `executor-guards.ts`        | ~120  | Pre/post execution guards (rate limit placeholders, validation) |
| `tool-validator.ts`         | ~40   | Validates tool calls against phase-allowed set                  |
| `content-block-resolver.ts` | ~220  | B03: resolve file refs to provider-format content blocks        |

#### 2.1.3 `session/` -- Session persistence (5 files)

| File                    | Lines | Purpose                                                     |
| ----------------------- | ----- | ----------------------------------------------------------- |
| `index.ts`              | ~10   | Barrel exports                                              |
| `session-service.ts`    | ~200  | CRUD operations, getOrCreate, append message, $slice window |
| `file-store-service.ts` | ~180  | B03: file blob storage with SHA-256 dedup                   |
| `project-summary.ts`    | ~100  | Generate project summary for IN_PROJECT resume              |
| `resume-summary.ts`     | ~120  | Compress conversation history for session resume            |

#### 2.1.4 `journal/` -- Append-only audit log (3 files)

| File                 | Lines | Purpose                                      |
| -------------------- | ----- | -------------------------------------------- |
| `index.ts`           | ~5    | Barrel exports                               |
| `journal-service.ts` | ~100  | Append journal entry, query by session/phase |
| `types.ts`           | ~30   | JournalEntry type, entry categories          |

#### 2.1.5 `streaming/` -- SSE protocol (4 files)

| File                  | Lines | Purpose                                         |
| --------------------- | ----- | ----------------------------------------------- |
| `index.ts`            | ~10   | Barrel exports                                  |
| `sse-serializer.ts`   | ~60   | Encode ArchSSEEvent to `data: {...}\n\n` format |
| `sse-parser.ts`       | ~80   | Parse SSE stream back to ArchSSEEvent (client)  |
| `activity-emitter.ts` | ~90   | Higher-level activity event builder with groups |

#### 2.1.6 `prompts/` -- System prompt composition (13 files)

| File                                       | Lines | Purpose                                                           |
| ------------------------------------------ | ----- | ----------------------------------------------------------------- |
| `index.ts`                                 | 145   | composeSystemPrompt, composeInProjectPrompt, formatContextSection |
| `base.ts`                                  | ~200  | Base prompt (ABL platform context)                                |
| `phases/interview.ts`                      | ~80   | Interview phase instructions                                      |
| `phases/blueprint.ts`                      | ~80   | Blueprint phase instructions                                      |
| `phases/build.ts`                          | ~80   | Build phase instructions                                          |
| `phases/create.ts`                         | ~60   | Create phase instructions                                         |
| `phases/in-project.ts`                     | ~80   | IN_PROJECT mode instructions                                      |
| `specialists/onboarding.ts`                | ~120  | Onboarding specialist persona                                     |
| `specialists/multi-agent-architect.ts`     | ~150  | Architecture specialist persona                                   |
| `specialists/abl-construct-expert.ts`      | ~150  | ABL code generation specialist persona                            |
| `specialists/observability-analyst.ts`     | ~100  | Observability specialist persona                                  |
| `specialists/testing-eval.ts`              | ~100  | Testing specialist persona                                        |
| `specialists/channel-voice.ts`             | ~80   | Channel specialist persona                                        |
| `specialists/entity-collection.ts`         | ~80   | Entity specialist persona                                         |
| `specialists/integration-methodologist.ts` | ~100  | Integration specialist persona                                    |

#### 2.1.7 `tools/` -- Tool contract definitions (3 files)

| File                            | Lines | Purpose                                         |
| ------------------------------- | ----- | ----------------------------------------------- |
| `index.ts`                      | ~5    | Barrel exports                                  |
| `definitions.ts`                | ~400  | LLMToolDefinition JSON Schemas for all 16 tools |
| `schemas/in-project-schemas.ts` | ~120  | Zod schemas for IN_PROJECT tool inputs          |

#### 2.1.8 `mock-server/` -- Mock API generation (3 files)

| File                        | Lines | Purpose                                          |
| --------------------------- | ----- | ------------------------------------------------ |
| `index.ts`                  | ~5    | Barrel exports                                   |
| `mock-project-generator.ts` | ~200  | Generate Vercel-deployable mock server project   |
| `tool-extractor.ts`         | ~150  | Extract tool endpoints from agent YAML for mocks |

#### 2.1.9 `types/` -- Shared types (15 files)

| File                        | Lines | Purpose                                                                                                                                                                                                                                                             |
| --------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                  | 71    | Barrel re-exports                                                                                                                                                                                                                                                   |
| `session.ts`                | 95    | ArchSession, SessionMetadata, StoredMessage                                                                                                                                                                                                                         |
| `specification.ts`          | 88    | Specification schema, canExitInterview                                                                                                                                                                                                                              |
| `sse-events.ts`             | 189   | 16 SSE event Zod schemas + discriminated union                                                                                                                                                                                                                      |
| `message-request.ts`        | 58    | MessageRequest discriminated union (5 types)                                                                                                                                                                                                                        |
| `constants.ts`              | 44    | ARCH_PHASES, ARCH_MODES, SESSION_STATES, SPECIALIST_IDS, MESSAGE_LIMITS                                                                                                                                                                                             |
| `tools.ts`                  | 84    | ToolName, PhaseToolMap, PHASE_TOOL_MAP, IN_PROJECT_TOOLS                                                                                                                                                                                                            |
| `errors.ts`                 | 103   | 11 typed error classes (InvalidTransitionError, ExitCriteriaNotMetError, SessionBusyError, SessionNotFoundError, SessionArchivedError, SessionAlreadyExistsError, LoopDetectedError, FileNotFoundError, FileTooLargeError, FileCorruptError, SessionFileQuotaError) |
| `blueprint.ts`              | 215   | TopologyOutput, BlueprintOutput, computeBuildOrder, validateBlueprintOutput                                                                                                                                                                                         |
| `execution.ts`              | 25    | ExecutionResult, ExecutionStatus                                                                                                                                                                                                                                    |
| `content-blocks.ts`         | ~120  | ArchContentBlock, normalizeContent, extractContentBlocks                                                                                                                                                                                                            |
| `page-context.ts`           | ~60   | PageContext, PageContextEntity Zod schemas                                                                                                                                                                                                                          |
| `in-project-specialists.ts` | 13    | IN_PROJECT_SPECIALIST_DISPLAY map                                                                                                                                                                                                                                   |
| `auth-context.ts`           | ~20   | AuthContext type for route handlers                                                                                                                                                                                                                                 |
| `chain-context.ts`          | ~30   | ChainContext for multi-turn execution                                                                                                                                                                                                                               |

### 2.2 Studio Routes (`apps/studio/src/app/api/arch-ai/`)

Total: 11 route files, ~3,979 lines.

| Route Path                                | File Lines | Purpose                                                      |
| ----------------------------------------- | ---------- | ------------------------------------------------------------ |
| `POST /api/arch-ai/message`               | 3,093      | Main message handler (SSE streaming). **Extraction target.** |
| `POST /api/arch-ai/chat`                  | 222        | Lightweight chat endpoint (non-streaming)                    |
| `POST /api/arch-ai/files`                 | 176        | B03: file upload endpoint                                    |
| `GET /api/arch-ai/files/[blobId]/content` | 82         | B03: file content retrieval                                  |
| `GET /api/arch-ai/project-health`         | 89         | Project health check data                                    |
| `GET /api/arch-ai/project-summary`        | 58         | Project summary for IN_PROJECT                               |
| `POST /api/arch-ai/sessions`              | 51         | Create new session                                           |
| `GET /api/arch-ai/sessions/current`       | 59         | Get current non-terminal session                             |
| `GET /api/arch-ai/sessions/[id]`          | 61         | Get session by ID                                            |
| `POST /api/arch-ai/sessions/[id]/archive` | 50         | Archive a session                                            |
| `GET /api/arch-ai/sessions/[id]/journal`  | 38         | Get journal entries for session                              |

### 2.3 Studio Components (`apps/studio/src/components/arch-ai/`)

> **Note**: Two component directories exist: `components/arch-ai/` (legacy, still referenced by tests) and `components/arch-v3/` (active, imported by `page.tsx`). The table below covers `arch-ai/`. When modifying components, check both directories for the canonical location.

Total: 20 component files, ~3,744 lines.

| Component                      | Lines | Purpose                                          |
| ------------------------------ | ----- | ------------------------------------------------ |
| `ArchAIChatPanel.tsx`          | 1,194 | Main chat panel (message list, input, streaming) |
| `tabs/DynamicTabRenderer.tsx`  | 555   | Artifact panel tab routing                       |
| `CreateProjectApproval.tsx`    | 279   | CREATE phase approval gate UI                    |
| `CodeBlockView.tsx`            | 258   | Syntax-highlighted code display                  |
| `ask-user/MultiSelect.tsx`     | 188   | Multi-select widget for ask_user tool            |
| `TopologyViewer.tsx`           | 177   | Topology graph visualization                     |
| `ask-user/SingleSelect.tsx`    | 135   | Single-select widget for ask_user tool           |
| `AgentCodeTab.tsx`             | 130   | Agent YAML code tab                              |
| `ArtifactPanel.tsx`            | 123   | Right-side artifact panel container              |
| `ask-user/FileUpload.tsx`      | 99    | File upload widget for collect_file tool         |
| `ThinkingIndicator.tsx`        | 89    | Streaming/thinking animation                     |
| `ArchAIChatPage.tsx`           | 83    | Full-page chat layout (panel + artifacts)        |
| `QACard.tsx`                   | 73    | Question-answer conversation card                |
| `ask-user/AskUserRenderer.tsx` | 73    | Widget type dispatcher                           |
| `InlineAgentsPreview.tsx`      | 68    | Inline agent preview in chat                     |
| `InlineTopologyPreview.tsx`    | 60    | Inline topology preview in chat                  |
| `ask-user/TextInput.tsx`       | 59    | Text input widget for ask_user tool              |
| `ask-user/Confirmation.tsx`    | 42    | Yes/no confirmation widget                       |
| `TopologyGraphTab.tsx`         | 36    | Topology tab in artifact panel                   |
| `ConversationDivider.tsx`      | 23    | Phase transition divider in chat                 |

### 2.4 Studio Lib/Hooks/Services

Total: ~40 files, ~6,760 lines (lib) + ~3,180 lines (services) + ~1,320 lines (stores).

#### 2.4.1 Services

| File                      | Lines | Purpose                                                                        |
| ------------------------- | ----- | ------------------------------------------------------------------------------ |
| `arch.service.ts`         | 3,092 | Main service: LLM calls, tool dispatch, state management. **~42 `any` types.** |
| `arch-project-service.ts` | 88    | Project creation service                                                       |

#### 2.4.2 Stores (Zustand)

| File                   | Lines | Purpose                                           |
| ---------------------- | ----- | ------------------------------------------------- |
| `arch-store.ts`        | 816   | Main Arch AI Zustand store (v0.2 legacy)          |
| `arch-ai-store.ts`     | 307   | v0.3 Zustand store (session, messages, streaming) |
| `arch-config-store.ts` | 197   | Configuration store (LLM settings)                |

#### 2.4.3 Lib (`lib/arch-ai/`)

| File                                      | Lines | Purpose                                 |
| ----------------------------------------- | ----- | --------------------------------------- |
| `system-prompt.ts`                        | 153   | Studio-side system prompt builder       |
| `context.ts`                              | ~100  | Context provider                        |
| `guards.ts`                               | ~80   | Client-side guard utilities             |
| `constants.ts`                            | ~40   | Client-side constants                   |
| `suggestions.ts`                          | ~60   | Suggestion chip generation              |
| `retry.ts`                                | ~30   | Retry utilities                         |
| `types.ts`                                | ~80   | Studio-specific types                   |
| `abl-builder.ts`                          | 194   | ABL YAML generation. **4 `any` types.** |
| `topology-helpers.ts`                     | ~60   | Topology data helpers                   |
| `topology-patterns.ts`                    | ~80   | Topology pattern catalog                |
| `construct-catalog.ts`                    | ~150  | ABL construct catalog                   |
| `abl-reference.ts`                        | ~200  | ABL reference documentation             |
| `provider-prompts.ts`                     | ~80   | Provider-specific prompt fragments      |
| `cross-agent-validator.ts`                | ~80   | Cross-agent validation                  |
| `build-page-context.ts`                   | ~60   | Build PageContext from Studio state     |
| `helpers/classify-data-sensitivity.ts`    | ~40   | Data sensitivity classifier             |
| `helpers/compile-and-fix.ts`              | ~80   | Compile + auto-fix loop                 |
| `helpers/constraint-coverage-analyzer.ts` | ~60   | Constraint coverage analysis            |
| `helpers/generate-constraints.ts`         | ~60   | Constraint generation from spec         |
| `helpers/get-model-recommendation.ts`     | ~60   | Model recommendation logic              |
| `helpers/get-relevant-constructs.ts`      | ~40   | Construct relevance filter              |

#### 2.4.4 Lib (top-level `lib/`)

| File                      | Lines | Purpose                                    |
| ------------------------- | ----- | ------------------------------------------ |
| `arch-llm.ts`             | 622   | LLM provider abstraction (Vercel AI SDK)   |
| `arch-tools.ts`           | 1,210 | Tool registration and execution            |
| `arch-workflow.ts`        | 226   | Workflow state machine (client-side)       |
| `arch-context-builder.ts` | ~80   | Context builder for page context injection |
| `arch/upload-files.ts`    | 254   | B03: file upload client utilities          |

#### 2.4.5 Tool Implementations (`lib/arch-ai/tools/`)

| File                       | Lines | Purpose                                                  |
| -------------------------- | ----- | -------------------------------------------------------- |
| `agent-ops.ts`             | 514   | Agent CRUD operations (read, modify, generate)           |
| `generate-agents.ts`       | 475   | Agent YAML generation from blueprint. **7 `any` types.** |
| `health-check.ts`          | 455   | Project health assessment                                |
| `create-project.ts`        | 248   | ABL project creation via Runtime API                     |
| `platform-context.ts`      | 245   | Platform state context provider                          |
| `session-ops.ts`           | 247   | Session management operations                            |
| `deployment-ops.ts`        | 222   | Deployment operations                                    |
| `generate-topology.ts`     | 195   | Topology generation from specification                   |
| `analytics-ops.ts`         | 196   | Analytics operations                                     |
| `analyze.ts`               | 177   | Constraint analysis tool                                 |
| `knowledge-ops.ts`         | 173   | Knowledge base operations                                |
| `testing-ops.ts`           | 162   | Test execution operations                                |
| `tools-ops.ts`             | 196   | Tool management operations                               |
| `topology-ops.ts`          | 143   | Topology read/modify operations                          |
| `cache.ts`                 | 91    | Tool result cache                                        |
| `ask-user.ts`              | 58    | ask_user client-side tool handler                        |
| `get-topology-patterns.ts` | 49    | Topology pattern lookup                                  |

### 2.5 Database Models (`packages/database/src/models/`)

| Model                            | Collection               | Purpose                                           |
| -------------------------------- | ------------------------ | ------------------------------------------------- |
| `arch-session.model.ts`          | `arch_sessions`          | Session state, metadata, messages (capped at 200) |
| `arch-journal.model.ts`          | `arch_journal`           | Append-only journal entries (sequenced)           |
| `session-file.model.ts`          | `arch_session_files`     | B03: file blob storage with dedup + 30-day TTL    |
| `arch-workspace-config.model.ts` | `arch_workspace_configs` | Workspace-level Arch AI configuration             |
| `arch-conversation.model.ts`     | `arch_conversations`     | Conversation history (legacy, being replaced)     |

### 2.6 Test Files

#### 2.6.1 Engine Unit Tests (`packages/arch-ai/src/__tests__/`) -- 32 files

```
b03-content-resolver.integration.test.ts    loop-detection.test.ts
b03-multimodality-integration.test.ts       message-request.test.ts
b03-sse-events.test.ts                      mock-project-generator.test.ts
b03-sse-parser.integration.test.ts          multi-turn-executor.test.ts
blueprint.test.ts                           phase-machine.test.ts
build-exit-criteria-subphase.test.ts        project-summary.test.ts
content-blocks.test.ts                      prompts.test.ts
content-router-tool-lifecycle.test.ts       resume-summary.test.ts
content-router.test.ts                      scope-classifier.test.ts
coverage-gaps.test.ts                       session-state-machine.test.ts
errors.test.ts                              specialist-executor.test.ts
executor-guards-extended.test.ts            specification.test.ts
executor-guards.test.ts                     sse-events.test.ts
in-project-types.test.ts                    sse-streaming.test.ts
tool-definitions.test.ts                    tool-extractor.test.ts
tool-validator.test.ts                      tools.test.ts
```

#### 2.6.2 Studio Unit/Integration Tests (`apps/studio/src/__tests__/arch-ai/`) -- 60 files

Covers: message route, sessions (CRUD, archive, current, journal), tools (12 tool files), store, context, components (chat panel, topology viewer, QA card, thinking indicator, conversation divider, ask-user widgets, project creation flow), streaming, guards, LLM resolution, system prompt, page context, constraint coaching, model recommendation, workflow, config API/store, edit context, section chat/wiring, settings page, OpenAPI generation.

#### 2.6.3 E2E Tests (API-level) (`apps/studio/src/__tests__/e2e/`) -- 5 files

```
arch-ai-constraint-coaching.e2e.test.ts
arch-ai-message-streaming.e2e.test.ts
arch-ai-multimodality.e2e.test.ts
arch-ai-page-context.e2e.test.ts
arch-ai-sessions.e2e.test.ts
```

#### 2.6.4 Playwright E2E Tests (`apps/studio/e2e/`) -- 6 files

```
arch-ai.spec.ts
arch-ai-api-batch.spec.ts
arch-ai-batch-creation.spec.ts
arch-b02-b20-b23.spec.ts
arch-tool-lifecycle.spec.ts
arch-v3-ux-polish.spec.ts
```

---

## 3. Implementation Phases (Remaining Work)

### Phase R1: Session Reliability (P0 -- develop PR prerequisite)

**Goal**: Eliminate stuck session lockout. Users cannot be blocked from using Arch AI because a previous session is stuck in ACTIVE state.

**Estimated effort**: 1 day

#### Task 1.1: Force-archive stuck ACTIVE sessions in POST /sessions

**File**: `apps/studio/src/app/api/arch-ai/sessions/route.ts`

Before creating a new session, call `sessionService.forceArchiveStuck()` to check for ACTIVE sessions older than 10 minutes for the same (tenantId, userId, mode). If found, write a journal entry FIRST, then force-transition to ARCHIVED with `archivedAt: new Date()`. If the journal write fails, leave the session as-is (do not archive without an audit trail).

Add a new method to `SessionService`:

```typescript
// packages/arch-ai/src/session/session-service.ts
interface SessionContext {
  tenantId: string;
  userId: string;
  mode: ArchMode;
}

async forceArchiveStuck(ctx: SessionContext, thresholdMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMs);
  const stuckSessions = await ArchSession.find({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    'metadata.mode': ctx.mode,
    state: 'ACTIVE',
    updatedAt: { $lt: cutoff },
  });

  let archived = 0;
  for (const stuck of stuckSessions) {
    // Journal FIRST — if this fails, leave session as-is
    // Note: SessionService will need JournalService injected as a constructor dependency.
    await this.journalService.append(
      { tenantId: ctx.tenantId, userId: stuck.userId },
      {
        sessionId: stuck._id,
        type: 'analysis',
        content: { reason: 'force-archived-stuck', stuckSinceMs: Date.now() - stuck.updatedAt.getTime() },
        specialist: 'system',
        phase: stuck.metadata.phase ?? 'INTERVIEW',
      }
    );
    // Then transition
    await ArchSession.updateOne(
      { _id: stuck._id, tenantId: ctx.tenantId },
      { $set: { state: 'ARCHIVED', archivedAt: new Date() } },
    );
    archived++;
  }
  return archived;
}
```

Route calls `sessionService.forceArchiveStuck(ctx, 10 * 60 * 1000)` before `create()`:

```typescript
// apps/studio/src/app/api/arch-ai/sessions/route.ts
await sessionService.forceArchiveStuck({ tenantId, userId, mode }, 10 * 60 * 1000);
const session = await sessionService.create({ tenantId, userId, mode });
```

**Risk**: LOW -- additive behavior. Existing sessions continue to work normally. Only affects sessions stuck for >10 minutes.

#### Task 1.2: Add request-level AbortSignal to message route

**File**: `apps/studio/src/app/api/arch-ai/message/route.ts`

When the client disconnects (browser tab closed, navigation), the SSE stream should abort the in-flight LLM call and transition the session back to IDLE. Currently, the session stays ACTIVE until the LLM call times out.

```typescript
// In POST handler, early in the function:
const abortController = new AbortController();
req.signal.addEventListener('abort', () => {
  abortController.abort();
  // Transition session back to IDLE
});

// Pass abortController.signal to LLM client
```

**Risk**: MEDIUM -- must ensure session state is consistent on abort. Needs careful handling of partial tool results.

#### Task 1.3: Tests for stuck session recovery

**Files**:

- `apps/studio/src/__tests__/arch-ai/arch-ai-sessions-stuck-recovery.test.ts` (new)
- `apps/studio/src/__tests__/e2e/arch-ai-stuck-sessions.e2e.test.ts` (new)

Tests:

1. Session stuck ACTIVE for >10min is force-archived on next POST /sessions
2. Session stuck ACTIVE for <10min is NOT force-archived
3. Force-archived session creates journal entry
4. New session can be created after force-archive
5. AbortSignal transitions session to IDLE on disconnect

**Exit criteria**:

- [ ] Stuck sessions auto-recover after 10 minutes
- [ ] No user lockout scenario possible
- [ ] Journal entry documents every force-archive
- [ ] Client disconnect aborts in-flight LLM call
- [ ] After abort, session state is IDLE with consistent metadata (no partial tool state or dangling pendingInteraction)
- [ ] All tests pass

---

### Phase R2: Schema Hardening (P1)

**Goal**: Eliminate unsafe casts (`as unknown as Record<string, unknown>`) in phase-machine.ts and message route by adding missing fields to the Mongoose schema and TypeScript interfaces.

**Estimated effort**: 0.5 day

#### Task 2.1: Add missing fields to Mongoose schema

**File**: `packages/database/src/models/arch-session.model.ts`

Add to the `metadata` sub-schema:

- `buildSubPhase`: `{ type: String, enum: ['AGENTS', 'TOOLS', 'COMPLETE'], default: null }`
- `activeSpecialist`: `{ type: String, default: null }`
- `pendingMutation`: `{ type: Schema.Types.Mixed, default: null }`

Also update the `IArchSession` interface in the same model file to include `buildSubPhase?: 'AGENTS' | 'TOOLS' | 'COMPLETE'`, `activeSpecialist?: string`, and `pendingMutation?: { tool: string; target: string; scope: 'SMALL' | 'LARGE'; before?: string; after?: string } | null`.

**Risk**: LOW -- additive fields with defaults. No migration needed for existing documents (Mongoose handles missing fields via defaults).

#### Task 2.2: Update SessionMetadata TypeScript interface

**File**: `packages/arch-ai/src/types/session.ts`

Add typed fields:

```typescript
/** Build sub-phase tracking */
buildSubPhase?: 'AGENTS' | 'TOOLS' | 'COMPLETE';
```

The `activeSpecialist` and `pendingMutation` fields already exist in the interface. `buildSubPhase` is the missing one.

#### Task 2.3: Remove unsafe casts in phase-machine.ts

**File**: `packages/arch-ai/src/coordinator/phase-machine.ts`

Replace the 2 instances of `as unknown as Record<string, unknown>` in BUILD exit criteria with direct typed access via `session.metadata.files`, `session.metadata.topology`, etc.

**Exit criteria**:

- [ ] Zero `as unknown as` casts in `phase-machine.ts`
- [ ] `buildSubPhase` field typed in SessionMetadata
- [ ] Mongoose schema matches TypeScript interface for all metadata fields
- [ ] `pnpm build --filter=@abl/arch-ai --filter=@abl/database` passes

---

### Phase R3: Type Safety (P1)

**Goal**: Eliminate `any` types in production Arch AI code. Tests excluded.

**Estimated effort**: 1.5 days

#### Task 3.1: Replace ~42 `any` types in arch.service.ts

**File**: `apps/studio/src/services/arch.service.ts` (3,092 lines)

Major categories of `any` to replace:

- Tool result types: `any` -> `TopologyOutput | AgentSpec | CompileResult | ...` (discriminated union by tool name)
- Metadata access: `any` -> `SessionMetadata`
- LLM response parsing: `any` -> Vercel AI SDK types (`StreamTextResult`, `ToolCallPart`, etc.)
- Project brief data: `any` -> `Specification`

**Risk**: MEDIUM -- this is a large file. Must be done incrementally (one category of `any` per commit, build after each).

#### Task 3.2: Replace `any` in generate-agents.ts and abl-builder.ts

**Files**:

- `apps/studio/src/lib/arch-ai/tools/generate-agents.ts` (7 `any` types)
- `apps/studio/src/lib/arch-ai/abl-builder.ts` (4 `any` types)

Replace with `TopologyAgent`, `AgentSpec`, `Record<string, unknown>` (for YAML serialization), etc.

**Risk**: LOW -- smaller files, well-scoped.

#### Task 3.3: Replace `any` in message route

**File**: `apps/studio/src/app/api/arch-ai/message/route.ts` (4 `any` types)

**Risk**: LOW -- minimal `any` usage.

**Exit criteria**:

- [ ] Zero `any` in `arch.service.ts`, `generate-agents.ts`, `abl-builder.ts`, `message/route.ts`
- [ ] `pnpm build --filter=studio` passes
- [ ] No runtime behavior changes (pure type refactor)

---

### Phase R4: Route Extraction (P2 -- prerequisite for MCP surface)

**Goal**: Break the 3,093-line message route into focused handler modules. Target: message route < 300 lines (orchestration only).

**Estimated effort**: 3 days

The message route contains 6 extractable blocks. Order of extraction is LOW risk first, HIGH risk last.

#### Task 4.1: Extract LLM adapter class

**Source**: `message/route.ts` lines ~144-296
**Target**: `apps/studio/src/lib/arch-ai/vercel-llm-adapter.ts` (new)
**Risk**: LOW

Extract the Vercel AI SDK wrapper that converts between engine types and Vercel-specific types. Pure data transformation, no side effects.

#### Task 4.2: Extract journal helpers

**Source**: `message/route.ts` lines ~70-142
**Target**: `apps/studio/src/lib/arch-ai/journal-helpers.ts` (new)
**Risk**: LOW

Extract journal entry creation and formatting helpers.

#### Task 4.3: Extract specialist display to engine types

**Source**: `message/route.ts` lines ~425-433
**Target**: Already partially done in `packages/arch-ai/src/types/in-project-specialists.ts`
**Risk**: LOW

Move remaining specialist display config to the engine package.

#### Task 4.4: Extract tool builders to per-phase modules

**Source**: `message/route.ts` lines ~437-1632
**Target**: `apps/studio/src/lib/arch-ai/tools/` (extend existing directory, one file per phase group)
**Risk**: MEDIUM

The tool builder functions construct LLM tool definitions with closures over route-local state (session, auth context). Must extract as factory functions that accept these dependencies.

Files to create/extend:

- `tools/interview-tools.ts` -- ask_user, collect_file, update_specification builders
- `tools/blueprint-tools.ts` -- generate_topology, suggest_guardrails builders
- `tools/build-tools.ts` -- generate_agent, compile_abl, propose_modification builders
- `tools/in-project-tools.ts` -- all IN_PROJECT tool builders

#### Task 4.5: Extract IN_PROJECT handler

**Source**: `message/route.ts` lines ~1637-1928
**Target**: `apps/studio/src/lib/arch-ai/handlers/in-project-handler.ts` (new)
**Risk**: MEDIUM

Extract the IN_PROJECT message handling logic (specialist routing, tool execution, streaming).

#### Task 4.6: Extract ONBOARDING handler

**Source**: `message/route.ts` lines ~1932-3093
**Target**: `apps/studio/src/lib/arch-ai/handlers/onboarding-handler.ts` (new)
**Risk**: HIGH

The largest block. Contains phase-specific logic for all 4 phases (INTERVIEW, BLUEPRINT, BUILD, CREATE). Must preserve:

- Phase transition logic
- Multi-turn tool loops
- Gate request handling
- Build sub-phase state machine
- CREATE phase project creation flow

Strategy: Extract as a single module first, then consider further decomposition by phase if the module is still >500 lines.

**Exit criteria**:

- [ ] `message/route.ts` < 300 lines (orchestration: parse request, auth, dispatch to handler, error handling)
- [ ] All existing tests pass without modification (behavioral parity)
- [ ] No new `any` types introduced during extraction
- [ ] Each extracted module has explicit dependencies (no implicit closures)
- [ ] `pnpm build --filter=studio` passes

---

### Phase R5: Observability & Performance (P2-P3)

**Goal**: Production readiness: rate limiting, TraceEvent integration, gzip compression.

**Estimated effort**: 2 days

#### Task 5.1: Rate limiting on /message endpoint (P1)

**File**: `apps/studio/src/app/api/arch-ai/message/route.ts` (or extracted handler)

Apply rate limiting: 10 requests per minute per user per session. Use the Studio `checkRateLimit` helper (Redis sliding window counter). Rate limiter runs AFTER body parsing since `sessionId` comes from the parsed body.

```typescript
// Studio rate-limit pattern (runs after body parsing)
import { checkRateLimit } from '@/lib/rate-limit';

const body = MessageRequestSchema.parse(await req.json());
const rl = await checkRateLimit(`arch-msg:${auth.id}:${body.sessionId}`, 10, 60_000);
if (!rl.allowed) return errorJson('Rate limited', 429, 'RATE_LIMITED');
```

Default: 10 req/min. Follow-up: read `rateLimitRpm` from `ArchWorkspaceConfig` for per-tenant overrides.

**Risk**: LOW -- well-established pattern. `checkRateLimit` is already used in Studio Next.js API routes.

#### Task 5.2: TraceEvent adapter (journal -> TraceStore bridge) (P3)

**File**: `packages/arch-ai/src/journal/trace-adapter.ts` (new)

Bridge journal entries to the platform TraceStore. Each journal entry emits a TraceEvent with:

- `traceId`: session ID
- `spanId`: journal entry ID
- `eventType`: mapped from journal entry type (see table below)
- `metadata`: journal content

**Journal Type to TraceEventType mapping**:

| Journal Type   | TraceEventType     | Notes                                    |
| -------------- | ------------------ | ---------------------------------------- |
| `decision`     | `decision`         | Phase transitions, specialist selection  |
| `mutation`     | `tool_call`        | Agent modifications, project creation    |
| `validation`   | `constraint_check` | Compilation results, constraint analysis |
| `consultation` | `llm_call`         | LLM interactions, specialist responses   |
| `analysis`     | `engine_decision`  | Coverage analysis, health checks         |

> **Note**: All 5 mapped TraceEventType values (`decision`, `tool_call`, `constraint_check`, `llm_call`, `engine_decision`) already exist in `packages/observatory/src/schema/trace-events.ts`. No additions needed.

**Risk**: LOW -- additive. No changes to existing journal flow.

#### Task 5.3: gzip compression for stored file content (P3)

**File**: `packages/arch-ai/src/session/file-store-service.ts`

Compress file content before storing in MongoDB (async gzip per platform invariant). Decompress on read. Estimated 60-80% size reduction for text files (YAML, JSON, Markdown).

```typescript
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
```

**Risk**: LOW -- additive. Existing uncompressed files continue to work (check for gzip magic bytes on read).

#### Task 5.4: Production monitoring (Tier 1 metrics) (P3)

**Files**: Add Prometheus counters/histograms to message route.

Tier 1 metrics:

- `arch_message_total` (counter): total messages by phase, mode, specialist
- `arch_message_duration_seconds` (histogram): end-to-end message processing time
- `arch_session_total` (counter): sessions created, by mode
- `arch_session_stuck_archived_total` (counter): force-archived stuck sessions
- `arch_tool_call_total` (counter): tool calls by tool name, success/failure
- `arch_llm_tokens_total` (counter): tokens used by model

**Risk**: LOW -- additive observability.

**Exit criteria**:

- [ ] Rate limiting enforced on /message (10 req/min/user/session)
- [ ] TraceEvents emitted for journal entries (visible in Observatory)
- [ ] gzip compression active for new file uploads (backward-compatible read)
- [ ] Tier 1 metrics exposed at /metrics endpoint
- [ ] All tests pass

---

## 4. Wiring Checklist

This section documents existing wiring (retroactive). All items below are already implemented.

### 4.1 Engine Package Wiring

| Wiring Point                                       | Status | Notes                                     |
| -------------------------------------------------- | ------ | ----------------------------------------- |
| `composeSystemPrompt()` called in message route    | DONE   | specialist + phase + pageContext          |
| `composeInProjectPrompt()` for IN_PROJECT mode     | DONE   | specialist + pageContext                  |
| `PHASE_TOOL_MAP` hard-filters tools per phase      | DONE   | LLM never sees tools outside its phase    |
| `IN_PROJECT_TOOLS` filters IN_PROJECT tools        | DONE   | 12 tools available                        |
| `validateStateTransition()` on every state change  | DONE   | Throws InvalidTransitionError             |
| `transitionPhase()` checks exit criteria           | DONE   | Throws ExitCriteriaNotMetError            |
| `LoopDetector.check()` before every tool call      | DONE   | Threshold=3, SHA-256 input hash           |
| `routeByContent()` for IN_PROJECT specialist       | DONE   | Keyword-based routing                     |
| `classifyMutationScope()` for propose_modification | DONE   | SMALL/MEDIUM/LARGE classification         |
| `resolveContentBlocks()` for B03 multimodal        | DONE   | File refs -> provider content blocks      |
| `executeSpecialistTurn()` for single-turn          | DONE   | SSE streaming to client                   |
| `executeMultiTurn()` for tool loops                | DONE   | Tool result -> LLM -> tool call -> repeat |

### 4.2 Studio Route Wiring

| Wiring Point                                 | Status | Notes                                           |
| -------------------------------------------- | ------ | ----------------------------------------------- |
| `requireTenantAuth` middleware on all routes | DONE   | Centralized auth via `@abl/shared-auth`         |
| `tenantId` filter on all DB queries          | DONE   | Tenant isolation enforced                       |
| `userId` filter on session queries           | DONE   | User isolation for sessions                     |
| SSE response headers (`text/event-stream`)   | DONE   | Correct headers for streaming                   |
| MessageRequest Zod validation                | DONE   | Discriminated union parse at route entry        |
| Error -> ArchSSEEvent mapping                | DONE   | All errors emit `error` SSE event               |
| Journal entry creation on tool calls         | DONE   | decision/consultation/mutation/validation types |
| Suggestion generation on `done` event        | DONE   | Phase-aware suggestion chips                    |
| File upload with dedup (SHA-256)             | DONE   | B03: same content reuses existing blob          |
| Page context injection from client           | DONE   | Client sends PageContext, injected into prompt  |

### 4.3 Frontend Wiring

| Wiring Point                               | Status | Notes                                                          |
| ------------------------------------------ | ------ | -------------------------------------------------------------- |
| SSE parser in ArchAIChatPanel              | DONE   | Parses all 16 event types                                      |
| Phase transition UI (ConversationDivider)  | DONE   | Visual divider on phase change                                 |
| ask_user widget rendering (5 widget types) | DONE   | SingleSelect, MultiSelect, TextInput, Confirmation, FileUpload |
| Topology visualization (TopologyViewer)    | DONE   | Graph rendering from topology data                             |
| Agent code preview (AgentCodeTab)          | DONE   | Syntax-highlighted YAML                                        |
| Create project approval gate               | DONE   | Accept/modify/reject flow                                      |
| Suggestion chips in done event             | DONE   | Clickable chips insert prompt                                  |
| Activity feed (ThinkingIndicator)          | DONE   | Semantic labels, elapsed time, delayed collapse                |
| File upload dropzone                       | DONE   | B03: drag-and-drop + click                                     |
| Dynamic tab renderer                       | DONE   | Artifact panel tab routing                                     |

---

## 5. Cross-Phase Concerns

### 5.1 Database

**Collections**: 5 MongoDB collections (arch_sessions, arch_journal, arch_session_files, arch_workspace_configs, arch_conversations).

**Known issue (OQ-6)**: The `content` field in `StoredMessageSchema` uses `Schema.Types.Mixed` to support both `string` (pre-B03) and `ArchContentBlock[]` (B03). This is correct behavior but means Mongoose cannot validate the content field at the schema level. The `normalizeContent()` helper handles both types at read time.

> **Note**: Implementation also uses `arch_workspace_configs` (FR-9 admin config) and `arch_conversations` (legacy persistence). These are not in the HLD data model -- flag for HLD update during post-impl-sync.

**Migration needed**: `buildSubPhase` field addition (Phase R2). No data migration required -- Mongoose defaults handle missing fields. For the `content` Mixed-type field, a backfill migration to normalize all `string` content to `[{ type: 'text', text: content }]` is P1 but can be deferred until after R1.

**Indexes**: All collections have tenant isolation indexes. `arch_sessions` has a unique compound index on `(tenantId, userId, metadata.mode, metadata.projectId)` with `partialFilterExpression: { state: { $in: ['IDLE', 'ACTIVE', 'GATE_PENDING'] } }` for the one-active-session-per-mode constraint (terminal sessions are excluded from uniqueness). `arch_session_files` has a TTL index on `createdAt` for 30-day cleanup.

### 5.2 Feature Flag

All Arch AI functionality is gated behind `NEXT_PUBLIC_FEATURE_ARCH_AI=true` in `apps/studio/.env.local`. This is a single boolean flag -- no per-phase or per-specialist toggles.

The flag controls:

- AppShell rendering of the Arch AI panel entry point
- API route availability (routes exist but return 404 when flag is off)
- Navigation menu visibility

### 5.3 Monitoring (3-Tier Plan)

| Tier   | Metrics                                                                                                       | Phase  |
| ------ | ------------------------------------------------------------------------------------------------------------- | ------ |
| Tier 1 | message_total, message_duration, session_total, tool_call_total, llm_tokens_total, stuck_archived_total       | R5     |
| Tier 2 | phase_transition_total, specialist_routing_distribution, exit_criteria_check_duration, file_upload_size_bytes | Future |
| Tier 3 | per-specialist quality scores, user satisfaction proxy (session length), topology complexity distribution     | Future |

### 5.4 LLM Credential Resolution (4-tier)

Already implemented in `apps/studio/src/lib/arch-llm.ts`. Resolution order (matches actual code):

1. **Model Hub credential**: `tenantModelId` -> `TenantModel` -> `LLMCredential` (managed via Model Hub admin UI)
2. **Tenant API key**: from `ArchWorkspaceConfig` (decrypted at resolution time)
3. **Platform env key**: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars
4. **Structured error**: No silent fallback -- returns an error if no credential resolves

Default model: `claude-sonnet-4-20250514`

### 5.5 Message Route Extraction Strategy (R4)

The 3,093-line message route is the single largest technical debt item. The extraction plan in Phase R4 follows this dependency order:

```
1. LLM adapter (no deps)           -> vercel-llm-adapter.ts
2. Journal helpers (no deps)        -> journal-helpers.ts
3. Specialist display (no deps)     -> engine types (already partial)
4. Tool builders (depends on 1)     -> tools/ per-phase files
5. IN_PROJECT handler (depends on 1,2,3,4) -> in-project-handler.ts
6. ONBOARDING handler (depends on 1,2,3,4) -> onboarding-handler.ts
```

After extraction, the message route becomes:

```typescript
// ~250 lines: parse request, auth, dispatch
export async function POST(req: NextRequest) {
  const { tenantId, userId } = requireTenantAuth(req);
  const body = MessageRequestSchema.parse(await req.json());
  const session = await getSession(body.sessionId, tenantId);

  if (session.metadata.mode === 'IN_PROJECT') {
    return handleInProjectMessage(session, body, { tenantId, userId });
  }
  return handleOnboardingMessage(session, body, { tenantId, userId });
}
```

---

## 6. Acceptance Criteria

### 6.1 Phase Gates

| Phase | Gate Condition                                                     | Blocking For     |
| ----- | ------------------------------------------------------------------ | ---------------- |
| R1    | Stuck sessions auto-recover, no user lockout, abort on disconnect  | develop PR       |
| R2    | Zero unsafe casts for metadata fields, schema matches TS interface | R3               |
| R3    | Zero `any` in production Arch AI code                              | R4               |
| R4    | message route < 300 lines, all tests pass                          | MCP surface work |
| R5    | Rate limiting enforced, TraceEvents visible, gzip active           | BETA promotion   |

### 6.2 Test Spec Scenario Mapping

| Test Spec Scenario            | Status      | Evidence                              |
| ----------------------------- | ----------- | ------------------------------------- |
| E2E-1: Chat round-trip        | COVERED     | arch-ai-message-streaming.e2e.test.ts |
| E2E-2: Workflow state machine | COVERED     | arch-ai-sessions.e2e.test.ts          |
| E2E-3: Context suggestions    | PARTIAL     | --                                    |
| E2E-4: Quick generate         | NOT COVERED | --                                    |
| E2E-5: Persistence            | COVERED     | arch-ai-sessions.e2e.test.ts          |
| E2E-6: Admin config           | NOT COVERED | --                                    |
| E2E-7: Deploy mocks           | NOT COVERED | --                                    |

### 6.3 Overall Acceptance

- [ ] All R1 tasks complete (develop PR gate)
- [ ] 1,087+ tests passing across arch-ai and studio (current baseline)
- [ ] `pnpm build` succeeds for all affected packages
- [ ] Feature spec updated with implementation status
- [ ] No `any` types in production code (R3)
- [ ] Message route < 300 lines (R4)
- [ ] Rate limiting enforced (R5)
- [ ] TraceEvents emitted (R5)

---

## 7. Open Questions

| #    | Question                                                                                  | Status   | Decision / Notes                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-1 | Should R4 (route extraction) be done before or after MCP surface work?                    | DECIDED  | Before. The 3,093-line route cannot be reused by MCP. Extraction is prerequisite.                                                                                  |
| OQ-2 | What is the threshold for ALPHA -> BETA promotion?                                        | DECIDED  | All R1-R3 complete, 90%+ test pass rate, 1-week soak in staging with no P0 bugs. See feature spec Status section.                                                  |
| OQ-3 | Should the content field migration (string -> ArchContentBlock[]) be mandatory?           | DECIDED  | No. `normalizeContent()` handles both types. Migration is P1 nice-to-have, not blocking.                                                                           |
| OQ-4 | Should IN_PROJECT specialists get dedicated prompts?                                      | DEFERRED | Currently they use base + IN_PROJECT phase prompt. Dedicated prompts would improve quality but are not blocking.                                                   |
| OQ-5 | Should the force-archive threshold be configurable?                                       | DECIDED  | No. 10 minutes is a reasonable default. Configuration adds complexity without clear benefit.                                                                       |
| OQ-6 | Should `create_project` tool be gated by phase at the LLM level (not just phase machine)? | DECIDED  | Already done. `PHASE_TOOL_MAP` hard-filters tools. LLM never sees `create_project` outside CREATE.                                                                 |
| OQ-7 | CREATE phase partial failure rollback                                                     | DEFERRED | Current mitigation: user retries from same session; operator cleans up via admin API. Saga pattern with cleanup endpoint planned for BETA promotion. See HLD OQ-2. |

---

## Appendix A: Dependency Graph

```
packages/arch-ai (engine)
  ├── types/        ← no internal deps
  ├── coordinator/  ← depends on types/
  ├── executor/     ← depends on types/, coordinator/
  ├── session/      ← depends on types/
  ├── journal/      ← depends on types/
  ├── streaming/    ← depends on types/
  ├── prompts/      ← depends on types/
  ├── tools/        ← depends on types/
  └── mock-server/  ← depends on types/, tools/

apps/studio
  ├── app/api/arch-ai/  ← depends on engine, database, lib/arch-ai
  ├── components/arch-ai/ ← depends on store, types
  ├── lib/arch-ai/       ← depends on engine types, arch-llm, arch-tools
  ├── services/          ← depends on engine, database, lib
  └── store/             ← depends on types
```

## Appendix B: Message Route Block Map (for R4)

```
Line Range   | Block                  | Extract To                     | Risk
-------------|------------------------|--------------------------------|------
1-69         | Imports + auth         | Keep in route.ts               | --
70-142       | Journal helpers        | journal-helpers.ts             | LOW
144-296      | LLM adapter            | vercel-llm-adapter.ts          | LOW
297-424      | Session helpers        | Keep in route.ts (small)       | --
425-433      | Specialist display     | engine types                   | LOW
437-1632     | Tool builders          | tools/ (per-phase)             | MEDIUM
1637-1928    | IN_PROJECT handler     | in-project-handler.ts          | MEDIUM
1932-3093    | ONBOARDING handler     | onboarding-handler.ts          | HIGH
```
