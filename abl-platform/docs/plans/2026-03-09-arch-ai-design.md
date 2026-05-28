# Arch AI — Master Design Document

> Comprehensive design, architecture, and implementation reference for the Arch AI agentic system.
> Related: `2026-03-09-arch-command-bar-design.md` (floating command bar — separate feature)

**Date:** 2026-03-09 (enriched 2026-03-10)
**Feature:** Arch AI — AI-driven agentic project creation and in-project lifecycle management
**Branch:** feature/aiassistedjourney
**Ticket:** ABLP-42
**Status:** Implemented (home + in-project Tiers 1-3)

---

## Highlights

### What Is Arch AI?

An LLM-driven agentic system that replaces form-based workflows with conversational AI. Users describe what they want — Arch AI asks clarifying questions via interactive UI (Claude-style), generates agent topologies and ABL code, validates everything, and creates the project. Inside projects, the same system reads, modifies, analyzes, deploys, and manages agents through natural conversation.

### How It Was Built

| Phase                 | What                                | Approach                                                                  |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| **Planning**          | 4 brainstorming sessions            | `superpowers:brainstorm` skill — iterative design with user               |
| **Design docs**       | 3 docs → consolidated into 1 master | `superpowers:writing-plans` skill                                         |
| **Implementation**    | 42 tasks across 2 plans             | `superpowers:executing-plans` + `superpowers:subagent-driven-development` |
| **Code review**       | Per-task review + final audit       | `superpowers:requesting-code-review` + `ralph-loop` for iterative fixes   |
| **E2E testing**       | 10-project batch via Playwright     | Automated creation → validation → cleanup                                 |
| **Bug fixing**        | 10 critical bugs found and fixed    | `superpowers:systematic-debugging`                                        |
| **Doc consolidation** | 5 files deleted, 1 master           | Audit + merge + cleanup                                                   |

### By the Numbers

| Metric                  | Value                                               |
| ----------------------- | --------------------------------------------------- |
| New code                | 5,070+ lines across 67 files                        |
| Tool definitions        | 13 tools (5 home + 8 in-project)                    |
| Unit tests              | 168 passing across 19 test files (2,789 test lines) |
| E2E batch test          | 9/10 projects created successfully (Playwright)     |
| LLM providers supported | 15+ (Anthropic, OpenAI, Gemini, Azure, Groq, etc.)  |
| System prompt           | 4-layer, multi-model (~5,100 tokens)                |
| Decisions documented    | 24                                                  |
| Bugs found and fixed    | 10 (4 P0, 4 P1, 2 P2)                               |
| Design sessions         | 4 brainstorming sessions                            |
| Implementation sessions | 2 batch execution sessions                          |

### Skills and Tools Used During Development

| Skill / Tool                              | Where Used                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `superpowers:brainstorm`                  | 4 sessions: home chat UX, agentic architecture, in-project tools, RBAC |
| `superpowers:writing-plans`               | 2 implementation plans (21 tasks each)                                 |
| `superpowers:executing-plans`             | Batch execution of both plans in parallel sessions                     |
| `superpowers:subagent-driven-development` | Per-task dispatch with spec + code quality review                      |
| `superpowers:requesting-code-review`      | Post-implementation review against plan and standards                  |
| `superpowers:systematic-debugging`        | 10 critical bugs diagnosed and fixed                                   |
| `ralph-loop`                              | Iterative refinement cycles during implementation                      |
| `dev-diary-recorder`                      | Session tracking across all 4 planning sessions                        |
| Playwright                                | Batch E2E: 10 automated project creations with ABL validation          |
| Vitest + React Testing Library            | 168 unit + component tests with happy-dom                              |
| Context7 (MCP)                            | Vercel AI SDK documentation lookup for streaming + tool patterns       |
| Explore agents                            | Codebase research (ABL parser, RBAC, existing Arch, Studio structure)  |

### Technology Stack

| Layer             | Technology                                              | Version                    |
| ----------------- | ------------------------------------------------------- | -------------------------- |
| LLM Orchestration | Vercel AI SDK                                           | `ai` ^6.0.99               |
| LLM Providers     | `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` | Latest                     |
| Frontend Chat     | `@ai-sdk/react` (`useChat`, `DefaultChatTransport`)     | ^3.0.118                   |
| Schema Validation | Zod                                                     | ^3.23.8                    |
| ABL Parser        | `@abl/core` (`parseAgentBasedABL`)                      | Internal                   |
| ABL Compiler      | `@abl/compiler` (`compileABLtoIR`)                      | Internal                   |
| State Management  | Zustand (ephemeral, no persist)                         | Internal                   |
| UI                | React 19, Tailwind CSS, Lucide icons, Framer Motion     | Latest                     |
| Testing           | Vitest + React Testing Library (happy-dom)              | ^4.0.18                    |
| E2E Testing       | Playwright                                              | Batch automation           |
| Default model     | claude-sonnet-4-20250514                                | Configurable per workspace |

---

## At a Glance (Code Metrics)

| Metric          | Value                                                                            |
| --------------- | -------------------------------------------------------------------------------- |
| **Codebase**    | 5,070+ lines of new code (2,060 tools + 1,221 components + 1,789 infrastructure) |
| **Tools**       | 13 tool definitions across 2 contexts (5 home + 8 in-project)                    |
| **Tests**       | 168 passing (124 unit + 44 component), 19 test files, 2,789 test lines           |
| **E2E**         | 9/10 Playwright project creations successful (90%)                               |
| **API**         | Single streaming endpoint: `POST /api/arch-ai/chat`                              |
| **Streaming**   | Vercel AI SDK v6 `streamText` + `createUIMessageStream`                          |
| **LLM Support** | 15+ providers via `@agent-platform/llm` (Anthropic, OpenAI, Gemini, Azure, etc.) |
| **RBAC**        | Platform-native (admin/developer/viewer) + safety guards for destructive ops     |
| **Models**      | Default: claude-sonnet-4-20250514, configurable per workspace                    |

### Technology Stack

| Layer                 | Technology                                              | Purpose                                                          |
| --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| **LLM Orchestration** | Vercel AI SDK v6 (`ai` ^6.0.99)                         | `streamText`, `createUIMessageStream`, `tool()`, `stepCountIs()` |
| **LLM Providers**     | `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` | Multi-provider model access                                      |
| **Frontend Chat**     | `@ai-sdk/react` (`useChat`, `DefaultChatTransport`)     | Chat state, auto-resubmit, tool approval                         |
| **Schema Validation** | Zod ^3.23.8                                             | Tool input schemas, request validation                           |
| **ABL Parser**        | `@abl/core` (`parseAgentBasedABL`)                      | ABL syntax validation                                            |
| **ABL Compiler**      | `@abl/compiler` (`compileABLtoIR`)                      | IR compilation, semantic validation                              |
| **State Management**  | Zustand (ephemeral, no persist)                         | Artifact tabs, versions, prefill                                 |
| **UI Components**     | React 19, Tailwind CSS, Lucide icons                    | Interactive ask_user components                                  |
| **Animation**         | Framer Motion                                           | Panel slide-in, thinking indicator                               |
| **Testing**           | Vitest + React Testing Library                          | Unit + component tests                                           |
| **E2E Testing**       | Playwright                                              | Automated project creation flows                                 |

---

## 1. Problem Statement

| #   | Problem                          | Impact                                                     |
| --- | -------------------------------- | ---------------------------------------------------------- |
| 1   | No AI entry point on home page   | Users must create project manually before using Arch       |
| 2   | Rigid 5-step form onboarding     | Users with specs still click through all forms             |
| 3   | Frontend-orchestrated generation | Hardcoded pipeline, no streaming, no self-correction       |
| 4   | Limited in-project capabilities  | 9 text-only tools, no access to tools/KBs/deploy/analytics |

---

## 2. Solution

A new agentic system where the **LLM drives the conversation** via tool calls. Single streaming API route serves both project creation and in-project work.

```
POST /api/arch-ai/chat
  |
  +-- No projectId --> Home (create project)
  |     Tools: ask_user, collect_file, generate_topology, generate_agents, create_project
  |
  +-- With projectId --> In-project (edit, analyze, deploy)
        Tools: ask_user, collect_file, agent_ops, analyze, tools_ops, topology_ops,
               testing_ops, deployment_ops, knowledge_ops, analytics_ops
```

**Existing Arch untouched.** New system at separate route. Coexists indefinitely.

---

## 3. Agentic Design Intelligence

### 3.1 Core Principle: LLM Drives, Tools Provide

Unlike traditional form-based UIs where the frontend controls the flow, Arch AI inverts control:

```
TRADITIONAL (existing Arch):
  Frontend decides: "Show form 1" -> "Show form 2" -> "Call generate" -> "Show results"
  LLM is a service: called when needed, returns text

ARCH AI (new):
  LLM decides: "I need domain info" -> calls ask_user -> "I need channels" -> calls ask_user
               -> "I have enough" -> calls generate_topology -> "User should review"
               -> calls ask_user(confirmation) -> "Approved" -> calls generate_agents
  Frontend renders: whatever the LLM produces (text, UI components, artifacts)
```

The LLM is the orchestrator. Tools are its capabilities. The frontend is a renderer.

### 3.2 Conversation Flow — Project Creation (14 Steps)

**Step 0a: Projects Dashboard (Entry Point)**

```
+------------------------------------------------------------------+
|  Projects                                    [+ New Project v]    |
|                                                                   |
|  +--------------------------------------------------------------+|
|  |  A   Ask Arch anything...                              Cmd+K ||
|  +--------------------------------------------------------------+|
|                                                                   |
|  Pinned (2)                                                       |
|  +-----------+ +-----------+                                     |
|  | BankNexus | | Salud SA  |                                     |
|  +-----------+ +-----------+                                     |
|                                                                   |
|  All Projects                                                     |
|  +--------------+ +--------------+ +--------------+              |
|  | Customer     | | Telco NOC    | | HR Onboard   |              |
|  +--------------+ +--------------+ +--------------+              |
+------------------------------------------------------------------+
```

**Step 0b: Arch Bar Expanded — Handoff to Chat**

```
+--------------------------------------------------------------+
|  A   Search projects...                                 ESC  |
+--------------------------------------------------------------+
|  RECENT PROJECTS                                              |
|  [folder] Customer support                      [clock] Today |
|                                                               |
|  SUGGESTIONS                                                  |
|    [sparkle] Create a customer service bot                    |
|    [sparkle] Help me design a workflow                        |
|    [sparkle] Build an AI agent from scratch                   |
|                                                               |
|  up/dn Navigate    Enter Select    esc Close                  |
+--------------------------------------------------------------+

User clicks suggestion or types use case
  -> navigates to /chat?message={text}
  -> Chat page auto-sends as first message
```

**Steps 1-2: Chat Page — First Message + Arch Responds**

```
+----+----------------------------------------------------------+
| A  |  You                                                     |
| Fl |  | Create a customer service bot                        ||
|    |                                                          |
|    |  A  Arch                                                 |
|    |  | Great! Let me understand a few things:               ||
|    |  | **Who are the primary users** of this bot?           ||
|    |                                                          |
|    |  [Customers] [Agents] [Both]    <- suggestion chips      |
|    |                                                          |
|    |  +------------------------------------------------------+|
|    |  | Type a message...                                    ||
|    |  | [+]                       Default v             [->] ||
| [>]|  +------------------------------------------------------+|
+----+----------------------------------------------------------+
```

**Step 4: Arch Proposes Generation (Confirming State)**

```
+----+----------------------------------------------------------+
| A  |  A  Arch                                                 |
| Fl |  | I have a good understanding of your needs.           ||
|    |  | **Domain:** Customer Service                         ||
|    |  | **Problem:** Handle returns, exchanges, tracking     ||
|    |  | **Users:** Customers + Support Agents                ||
|    |  | **Channels:** Web Chat, Slack                        ||
|    |  | **Tone:** Professional, friendly                     ||
|    |  |                                                      ||
|    |  | Ready to generate your agent system?                 ||
|    |  |  [Generate]  [Refine]  [Cancel]                      ||
|    |                                                          |
|    |  (input disabled during confirmation)                    |
| [>]|                                                          |
+----+----------------------------------------------------------+
```

**Step 7: Split View — Artifacts Generated**

```
+----+-------------------------+--------------------------------+
| A  | Chat                    | Preview                        |
| Fl |                         | [Topology] [Agents] [API] [Mock|
|    | A: Your system is       |      O Triage Agent            |
|    |    ready! 4 agents with |        |                       |
|    |    routing, escalation. |        v                       |
|    |                         |      O Returns Agent           |
|    | Review the preview      |        |         |             |
|    | and let me know if      |        v         v             |
|    | you'd like changes.     |      O Orders  O Escalation   |
|    |                         |                                |
|    |                         |  Agents: 4  Tools: 7          |
|    | +--------------------+  |  [Export]  [Create Project]    |
|    | | Type a message...  |  |                                |
| [>]| +--------------------+  |                                |
+----+-------------------------+--------------------------------+
```

**Step 10: Project Creation with Per-Agent Status**

```
+----+-------------------------+--------------------------------+
| A  | Chat                    | Creating Project...            |
| Fl |                         |                                |
|    | A: Creating your        |  [check] Triage Agent   saved  |
|    |    project now...       |  [check] Returns Agent  saved  |
|    |                         |  [dot]   Orders Agent   saving |
|    |                         |  [ ]     Escalation    pending |
|    |                         |                                |
|    |                         |  [============------]  60%     |
|    | (input disabled)        |                                |
| [>]|                         |                                |
+----+-------------------------+--------------------------------+
```

**Step 11: Project Created — Auto-Navigate (5s countdown)**

```
+----+----------------------------------------------------------+
| A  |  +- Customer Service Bot -------------------------+     |
| Fl |  | Agents (4)  Tools (7)  Sessions (0)  Deploy     |     |
|  * |                                                          |
|    |  [Topology canvas with all 4 agents]                     |
|    |                                                          |
|    |  Project created successfully!                           |
|    |  [Open in Arch]  5 agents saved. Ready to test.         |
| [>]|                                                          |
+----+----------------------------------------------------------+
```

### 3.3 Interactive ask_user Components (Claude-Style)

The LLM calls `ask_user` with a `component` parameter. Frontend renders the interactive UI.

**Single Select** (numbered list with keyboard navigation):

```
+--------------------------------------------------+
| What kind of agents would you like to build?     |
|                                         1 of 2   |
| +----------------------------------------------+ |
| | 1  Customer Service                       ->  | |
| |    Handle support queries                    | |
| +----------------------------------------------+ |
| | 2  Sales Assistant                           | |
| |    Help with sales process                   | |
| +----------------------------------------------+ |
| | 3  HR Onboarding                             | |
| |    Guide new employees                       | |
| +----------------------------------------------+ |
| | [pen] Something else                   Skip  | |
| +----------------------------------------------+ |
| up/dn to navigate  Enter to select  Esc to skip |
+--------------------------------------------------+
```

**Multi Select** (checkboxes):

```
+--------------------------------------------------+
| What channels should your agents support?        |
|                                                   |
| [x] Web Chat                                     |
| [x] Slack                                         |
| [ ] Voice (Twilio)                                |
| [ ] Email                                          |
| [ ] WhatsApp                                       |
|                            [Confirm selections]   |
+--------------------------------------------------+
```

**Confirmation** (custom labels):

```
+--------------------------------------------------+
| Ready to generate your agent system?             |
|            [Generate]  [Let me adjust]           |
+--------------------------------------------------+
```

### 3.4 Dense Message Handling — The Movie Script Test

A key design goal: handle information-dense messages without forcing forms.

**User sends:**

> "I want movie script writing agents with writers, a review panel, and iterative revision cycles connected to WhatsApp"

**What Arch AI extracts automatically:**

| Field      | Extracted                                   | Source                                     |
| ---------- | ------------------------------------------- | ------------------------------------------ |
| Domain     | Creative Writing / Script Production        | "movie script writing"                     |
| Problem    | Collaborative multi-agent script production | "writers...review panel...revision cycles" |
| Users      | The user (writer/producer)                  | Implicit                                   |
| Channels   | WhatsApp                                    | "connect this to my WhatsApp"              |
| Complexity | High                                        | Multi-agent collaboration, iterative loops |
| Pattern    | Fan-out/fan-in with iterative review        | "review panel...revision cycles"           |

**What Arch AI asks (only 2-3 questions, not 5 forms):**

```
-> ask_user(single_select): "How many specialist writers?"
   [3-4 specialists] [2 specialists] [Let me decide]

-> ask_user(single_select): "How many revision rounds?"
   [3 rounds max] [5 rounds max] [Until all reviewers approve]
```

**What it generates:** Supervisor (loop controller) + 4 Writer agents + 3 Reviewer agents with RETURN: true handoffs and project-scoped MEMORY for shared draft.

This adaptive behavior is impossible with form-based onboarding.

### 3.5 In-Project Conversation Examples

**Agent Modification Flow:**

```
User: "Add retry logic to the payment tool error handler"

LLM: -> agent_ops({ action: 'read', agentName: 'Booking_Agent' })
     Panel: [Booking_Agent ABL] tab opens

LLM: "I see the current ON_ERROR section. I'll add retry logic."
LLM: -> agent_ops({ action: 'modify', edits: [{section: 'ON_ERROR', content: '...'}], dryRun: true })
     Panel: [Proposed Changes] tab shows diff

LLM: "Here's the change:" [shows inline diff]
LLM: -> ask_user({ type: 'confirmation', confirmLabel: 'Apply', denyLabel: 'Cancel' })
User: clicks "Apply"

LLM: -> agent_ops({ action: 'modify', edits: [...], dryRun: false })
     Panel: [Booking_Agent ABL] tab updates
LLM: "Done! Added retry logic for payment errors."
```

**Session Debugging Flow:**

```
User: "The bot failed during my last session"

LLM: -> analyze({ action: 'query_traces', sessionId: 'latest', traceTypes: ['error','tool_call'] })
     Panel: [Session Traces] tab opens

LLM: "I found 3 errors:
  1. lookup_order tool timed out at 15s
  2. constraint_check failed: empty order_id
  3. escalation triggered but no target"

LLM: -> tools_ops({ action: 'read', toolName: 'lookup_order' })
     Panel: [lookup_order Config] tab opens

LLM: "The tool has 15s timeout. I recommend increasing to 30s and adding retry."
LLM: -> ask_user({ type: 'single_select', options: [
    { label: 'Fix both', description: 'Timeout + retry' },
    { label: 'Fix timeout only' },
    { label: 'Let me decide' }
  ]})
```

### 3.6 Thinking / Progress Indicator

During tool execution, the frontend shows what's happening:

```
+------------------------------------------+
| [lightning] Generating...                |
|   +- Analyzing requirements         [check] |
|   +- Building topology              [check] |
|   +- Triage Agent                   [check] |
|   +- Returns Agent                  [spinner]|
|   +- Orders Agent                   [pending]|
|   +- Escalation Agent              [pending]|
+------------------------------------------+
```

Events come from `experimental_onToolCallStart/Finish` callbacks. Each tool fires a `data-tool-progress` custom event that `ThinkingIndicator` renders.

### 3.7 Playwright E2E: Batch 10-Project Generation Test

Automated validation that the full agentic pipeline works end-to-end:

| #   | Use Case                | Agents | ABL Valid        | Result          |
| --- | ----------------------- | ------ | ---------------- | --------------- |
| 1   | Restaurant Reservations | 2      | All valid        | SUCCESS         |
| 2   | Gym Fitness Bot         | 5      | 4 valid + 1 stub | SUCCESS         |
| 3   | Library Assistant       | 2      | All valid        | SUCCESS         |
| 4   | Dentist Booking         | 2      | All valid        | SUCCESS         |
| 5   | Car Rental              | -      | -                | TIMEOUT (4 min) |
| 6   | Flower Shop             | 2      | All valid        | SUCCESS         |
| 7   | Hotel Concierge         | 2      | All valid        | SUCCESS         |
| 8   | Tech Support            | 6      | All valid        | SUCCESS         |
| 9   | Travel Planner          | 2      | All valid        | SUCCESS         |
| 10  | Bakery Bot              | 2      | All valid        | SUCCESS         |

**Methodology:** Each test sends a single use-case message, waits for the LLM to ask questions via `ask_user`, auto-responds, waits for topology + agent generation, approves project creation, then validates: project exists, agents have non-empty ABL, ABL parses successfully (`wasRebuilt: false`).

**Significance:** Proves the agentic loop works end-to-end with real LLM calls. The 1 timeout (Car Rental) was an LLM latency issue, not a system bug. All 9 successful projects had LLM-generated ABL, not stubs.

---

## 4. Architecture

### 3.1 Hybrid Deterministic + Agentic

- **Deterministic:** Tool availability controlled by context (home vs project, page, role)
- **Agentic:** LLM decides what to ask, when to generate, how to handle failures within available tools

### 3.2 Vercel AI SDK Integration

| Pattern         | SDK Feature                                                          | How We Use It                              |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| Agentic loop    | `streamText` + `stopWhen: stepCountIs(20)`                           | LLM calls tools in sequence, max 20 steps  |
| Interactive UI  | Client-side tools (no `execute`)                                     | `ask_user` renders UI, returns user choice |
| User approval   | `needsApproval: true`                                                | `create_project` pauses for confirmation   |
| Streaming       | `result.textStream`                                                  | Token-by-token chat bubbles                |
| Progress events | `createUIMessageStream` + `writer.write()`                           | Tool start/finish indicators               |
| Auto-resubmit   | `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` | Continues after client-side tool response  |
| Chat state      | `useChat` + `DefaultChatTransport`                                   | Frontend manages messages + auth headers   |

### 3.3 Request Shape

```typescript
POST /api/arch-ai/chat
{
  messages: UIMessage[],
  context?: {
    projectId?: string,       // Present = in-project mode
    page?: string,            // agents | sessions | deployments | tools | kb
    agentId?: string,         // Focused agent
    agentName?: string,
    sessionId?: string,       // Session being analyzed
    section?: string,         // Agent section being edited
  }
}
```

### 3.4 System Prompt (4-Layer, Multi-Model)

```
Layer 1: Base persona (PromptCatalog.arch.shared.base_persona)          ~500 tokens
Layer 2: Context prompt (HOME_CONTEXT or PROJECT_CONTEXT + injections)  ~400 tokens
Layer 3: ABL syntax reference (valid sections, rules, patterns)         ~4,000 tokens
Layer 4: Provider style (Claude: XML+examples, OpenAI: rules, Gemini: lists)  ~200 tokens
                                                                Total: ~5,100 tokens
```

Provider detected via `detectProvider(modelId)`:

| Model Contains              | Provider  | Style                              |
| --------------------------- | --------- | ---------------------------------- |
| `claude`, `anthropic`       | anthropic | XML tags, 2 examples, nuanced      |
| `gpt`, `o1`, `o3`, `openai` | openai    | Explicit numbered rules, 1 example |
| `gemini`, `google`          | google    | Short lists, 1 example             |
| anything else               | generic   | Minimal, most explicit             |

---

## 5. Tool Definitions

### 4.1 Home Context (Project Creation) — 5 Tools

| Tool                | Type           | Lines            | Purpose                                                                            |
| ------------------- | -------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `ask_user`          | Client-side    | 57               | Interactive UI: single_select, multi_select, text_input, confirmation, file_upload |
| `collect_file`      | Client-side    | (in ask-user.ts) | File upload (.pdf, .md, .json, .yaml, .yml, .txt, .docx)                           |
| `generate_topology` | Auto-execute   | 116              | Topology DAG + completeness analysis + retry + stub fallback                       |
| `generate_agents`   | Auto-execute   | 189              | Parallel ABL generation + parse/compile validation + retry                         |
| `create_project`    | Needs approval | 184              | Validate all + create project + per-agent DSL save                                 |

### 4.2 In-Project Context — 8 Grouped Tools (+ ask_user, collect_file)

| Tool             | Actions                                                 | Lines | Key Capabilities                                                  |
| ---------------- | ------------------------------------------------------- | ----- | ----------------------------------------------------------------- |
| `agent_ops`      | read, list, create, modify, compile, delete             | 396   | Section edits via `spliceSections`, dry-run diffs, ABL validation |
| `analyze`        | explain, suggest, test, query_traces                    | 164   | ABL analysis proxy, Runtime trace queries (50+ event types)       |
| `tools_ops`      | read, list, create, update, test, delete                | 196   | HTTP/Sandbox/MCP/Lambda tool configuration                        |
| `topology_ops`   | read, modify (stub)                                     | 143   | Builds topology from agent DSLs, extracts handoff/delegate edges  |
| `testing_ops`    | run_test, create_eval, list_evals                       | 156   | Runtime chat proxy for test conversations                         |
| `deployment_ops` | list, deploy, promote, configure_channel, list_channels | 157   | Environment promotion, channel management                         |
| `knowledge_ops`  | list, create, add_document, query, delete               | 168   | SearchAI KB management proxy                                      |
| `analytics_ops`  | metrics, intents, quality_scores, anomalies             | 130   | Runtime analytics endpoint proxy                                  |

**Total tool code: 2,060 lines across 14 files.**

---

## 6. Security Architecture

### 5.1 Three Security Layers

```
Layer 1: AUTH (route-level)
  requireTenantAuth(req)          --> 401 if no valid token
  requireProjectAccess(projectId) --> 404 if no project membership

Layer 2: RBAC (tool-level, platform-native)
  checkToolPermission(tool, action, ctx) --> maps to resource:operation
  checkAgentPermission()                 --> agent-level ownership + grants
  hasPermission() with wildcard matching --> admin (*:*), developer (agent:*), viewer (read-only)

Layer 3: SAFETY (Arch AI-specific)
  DANGEROUS_ACTIONS check      --> delete, rollback require confirmed: true
  System prompt rules          --> "always confirm before mutating"
  ask_user(confirmation)       --> explicit user consent for destructive ops
```

### 5.2 Permission Mapping

| Tool           | Action              | Platform Permission | Dangerous?             |
| -------------- | ------------------- | ------------------- | ---------------------- |
| agent_ops      | read, list, compile | `agent:read`        | No                     |
| agent_ops      | create, modify      | `agent:update`      | No (but dry-run first) |
| agent_ops      | **delete**          | `agent:delete`      | **Yes**                |
| tools_ops      | read, list          | `tool:read`         | No                     |
| tools_ops      | create, update      | `tool:write`        | No                     |
| tools_ops      | **delete**          | `tool:delete`       | **Yes**                |
| deployment_ops | **deploy, promote** | `deployment:create` | **Yes**                |
| knowledge_ops  | **delete**          | `tool:delete`       | **Yes**                |

### 5.3 Input Validation

| Boundary         | Validation                           | Method                                      |
| ---------------- | ------------------------------------ | ------------------------------------------- |
| Route entry      | Message array length, structure      | Manual check + `MAX_MESSAGES=100`           |
| Tool inputs      | Every parameter typed                | Zod schemas enforced by Vercel SDK          |
| ABL generation   | Syntax + semantics                   | `parseAgentBasedABL()` + `compileABLtoIR()` |
| Project creation | All agents validated before save     | Compile check per agent                     |
| LLM timeout      | 30s per call, 60s max route duration | `AbortSignal` + `maxDuration`               |
| Tool abuse       | Max 20 steps per conversation        | `stopWhen: stepCountIs(20)`                 |

### 5.4 Security Audit Status

| Check                                              | Status                  |
| -------------------------------------------------- | ----------------------- |
| `requireTenantAuth` on route                       | PASS                    |
| `requireProjectAccess` for project context         | PASS                    |
| Zod validation on all tool inputs                  | PASS                    |
| `createLogger('arch-ai:*')` in all files           | PASS (13/13 tool files) |
| No `console.log` in server code                    | PASS                    |
| `err instanceof Error ? err.message : String(err)` | PASS                    |
| No `.catch(() => {})`                              | PASS                    |
| Rate limiter per tenant                            | **TODO**                |
| Explicit trace event emission                      | **TODO**                |

---

## 7. Streaming and Events

### 6.1 Stream Flow

```
Server (streamText)                    Frontend (useChat)
  |                                      |
  |-- text-delta tokens              --> Chat bubble (streaming)
  |-- tool-call: ask_user            --> Render interactive UI
  |     (pause, wait for user)
  |                      <-- tool result: user's choice
  |-- text-delta tokens              --> Chat bubble
  |-- tool-call: generate_topology   --> ThinkingIndicator: "Generating..."
  |     (auto-execute on server)
  |-- data-tool-progress: complete   --> ThinkingIndicator: checkmark
  |-- tool-result: topology          --> InlineTopologyPreview card
  |-- tool-call: ask_user(confirm)   --> "Looks good?" [Yes] [Adjust]
```

### 6.2 Limitation

Custom events only fire at tool start/finish (`experimental_onToolCallStart/Finish`). Mid-execution sub-step progress not possible — writer not accessible inside `tool.execute()`. Phase 2 enhancement: break into sub-tools.

---

## 8. Artifact Display

### 7.1 Home Context — Fixed Tabs

Split view: chat left, artifact panel right (slides in on first generation).
Tabs: Topology | Agents | API | Mocks. Version selector per artifact.

### 7.2 In-Project — Dynamic Tabs

Tabs created from tool results. Max 5, LRU eviction.

| Tool Result               | Tab Type      | What Renders                                           |
| ------------------------- | ------------- | ------------------------------------------------------ |
| agent_ops(read)           | `agent_code`  | Syntax-highlighted ABL, line numbers, keyword colors   |
| agent_ops(modify, dryRun) | `diff`        | Section diff: green(+), red(-), apply/reject buttons   |
| analyze(query_traces)     | `traces`      | Chronological timeline, type badges, expandable events |
| topology_ops(read)        | `topology`    | Agent graph (JSON view, XyFlow integration TODO)       |
| tools_ops(read)           | `tool_config` | Tool type badge, config fields, test button            |
| testing_ops(run_test)     | `test_result` | User/agent messages, latency, trace summary            |
| analytics_ops(metrics)    | `metrics`     | Metric cards, time range filter, raw data              |

---

## 9. UI Access Points

### 8.1 Home — Chat Page (`/chat`)

**Entry:** Arch Bar on Projects dashboard -> suggestion click or typed use case -> `/chat?message={text}`
**Layout:** Sidebar (icon rail + project list) | Chat Panel | Artifact Panel (conditional)

**UX Flow (14 steps):** Dashboard -> Arch Bar -> handoff -> chat with clarifying questions (ask_user components) -> confirm generation -> topology preview (split view) -> agent preview -> refine via chat -> create project (approval + 5s countdown) -> navigate to project.

**Edge cases handled:** File upload in input, generation failure with retry, partial agent validation, Arch not configured state.

### 8.2 In-Project — Left Menu Item

**Entry:** Left sidebar "Arch AI" menu item (Sparkles icon) in project navigation
**Route:** Rendered via AppShell SPA router (page type `arch-ai`)
**Context:** Agent name, page, section from navigation store auto-injected into system prompt

### 8.3 Arch Command Bar (Designed, Not Yet Built)

Persistent command bar at bottom of every page. Search + mini chat + quick actions.
**Full design:** `docs/plans/2026-03-09-arch-command-bar-design.md`
**Integration:** Calls same `/api/arch-ai/chat` route. Smart routing: simple ops inline, complex ops redirect to full view.

---

## 10. Retry and Fallback

| Tool                          | Retries                     | Fallback                                                   | Threshold                |
| ----------------------------- | --------------------------- | ---------------------------------------------------------- | ------------------------ |
| `generate_topology`           | 1 retry with error context  | `generateTopologyStub()` — 1 supervisor + 1 agent/use case | Always valid             |
| `generate_agents` (per agent) | 1 retry with compile errors | `abl-builder.ts` — deterministic ABL from metadata         | 50% agents must be valid |
| `create_project`              | 1 transient retry           | Return errors for LLM to self-correct                      | N/A                      |

**ABL Builder** (`abl-builder.ts`, 172 lines): Deterministic ABL generator from topology node metadata. Produces syntactically valid ABL that always passes parser. Generates: AGENT/SUPERVISOR header, PERSONA, GOAL, TOOLS, GATHER, HANDOFF, ESCALATE, COMPLETE, FLOW (scripted mode).

**Constants:** `LLM_TIMEOUT=30s, TOOL_TIMEOUT=60s, MAX_STEPS=20, MIN_VALID_AGENTS=50%`

---

## 11. Platform Principle Compliance

| Principle                 | How We Comply                                                                              | Status                               |
| ------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| **Resource Isolation**    | `requireTenantAuth` + `requireProjectAccess`. All tools scoped by tenantId. No `findById`. | PASS                                 |
| **Centralized Auth**      | Uses existing `requireTenantAuth`. No custom token logic.                                  | PASS                                 |
| **Stateless Distributed** | No server-side conversation state. Messages from client each request.                      | PASS                                 |
| **Full Traceability**     | Stream events + `onStepFinish`. Tool calls logged via `createLogger`.                      | PARTIAL (explicit trace events TODO) |
| **Compliance**            | No PII stored (ephemeral). File uploads in-memory only.                                    | PASS                                 |
| **Performance**           | Streaming for fast first token. Parallel agent gen. Stub fallbacks.                        | PASS                                 |

---

## 12. Tough Questions and Key Decisions

### 11.1 Questions We Had to Resolve

| Question                                      | Why It Mattered                                          | Answer                                                                  | Impact                                           |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Can ABL express loops?                        | Movie script use case needs write->review->revise cycles | No native loops. Use supervisor with `RETURN: true` as loop controller. | System prompt teaches this pattern               |
| Can agents share context?                     | Multi-agent collaboration needs shared state             | Yes: PASS fields, project-scoped FactStore, history strategies          | ABL generation must include MEMORY + PASS config |
| Can we stream progress during tool execution? | Users wait 5-15s with no feedback                        | Yes via `experimental_onToolCallStart/Finish` (not mid-tool)            | Start/finish events for ThinkingIndicator        |
| Should we modify existing Arch or build new?  | Existing is 2,910 lines, different architecture          | Build new. Different pattern (sync vs streaming, forms vs tools).       | Coexist at separate routes                       |
| Single LLM with 31 tools or grouped?          | 31 tools degrades LLM selection accuracy                 | 9 grouped tools with `action` parameter                                 | Each tool dispatches internally                  |
| Custom RBAC or platform?                      | We proposed custom roles initially                       | Platform already has admin/developer/viewer with wildcards              | Reuse `checkAgentPermission` + `hasPermission`   |
| `convertToModelMessages()` sync or async?     | Broke ALL requests when called without await             | Async (returns Promise). Must `await`.                                  | P0 bug found during implementation               |
| How does the SPA router work?                 | `app/chat/page.tsx` was never loaded                     | AppShell uses custom SPA router, not Next.js file-based                 | Updated AppShell dynamic imports                 |

### 11.2 Key Design Decisions (24)

| #   | Decision                   | Chosen                                   | Why                                                |
| --- | -------------------------- | ---------------------------------------- | -------------------------------------------------- |
| 1   | Chat page layout           | Dedicated page (Perplexity-style)        | Space for chat + artifacts + sidebar               |
| 2   | Artifact review            | Split view (Claude-style)                | Chat left, preview right                           |
| 3   | How LLM renders UI         | Tool-based (ask_user client-side)        | Native Vercel SDK pattern, extensible              |
| 4   | Architecture               | Hybrid deterministic + agentic           | Tool availability by context, LLM decisions within |
| 5   | Streaming                  | Full streaming via `streamText`          | Fast first token, native SDK                       |
| 6   | Agent generation           | Parallel per agent (`Promise.all`)       | 3s vs 20s total                                    |
| 7   | RBAC                       | Reuse platform roles                     | Don't reinvent permissions                         |
| 8   | Tool permissions           | Check inside execute (not filter)        | LLM sees all tools, denied as tool result          |
| 9   | Retry strategy             | Tool retry + LLM self-correction + stubs | 1 retry, then deterministic fallback               |
| 10  | Conversation persistence   | Ephemeral (no storage)                   | Simplifies Phase 1                                 |
| 11  | In-project access          | Left menu item (Arch AI)                 | Full chat experience, not cramped panel            |
| 12  | Artifact display (project) | Dynamic tabs from tool results           | Contextual, max 5                                  |
| 13  | Post-create experience     | Auto-navigate with 5s countdown          | No jarring manual switch                           |
| 14  | Context passing            | Route parameter (not in messages)        | Messages stay clean                                |

---

## 13. Implementation Status

### 12.1 Code Statistics

| Category             | Files  | Lines      | Key Components                                                                                                                                                              |
| -------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool executors       | 14     | 2,060      | ask_user, generate_topology, generate_agents, create_project, agent_ops, analyze, tools_ops, topology_ops, testing_ops, deployment_ops, knowledge_ops, analytics_ops, index |
| Infrastructure       | 7      | 570        | types, constants, system-prompt, provider-prompts, abl-reference, retry, guards                                                                                             |
| ABL Builder          | 1      | 172        | Deterministic ABL from metadata                                                                                                                                             |
| Context routing      | 1      | 237        | Tool selection + system prompt switching                                                                                                                                    |
| API Route            | 1      | 153        | Streaming endpoint                                                                                                                                                          |
| Frontend (Arch AI)   | 12     | 1,221      | Chat panel (806), page, approval, thinking, previews, ask-user (6 components)                                                                                               |
| Frontend (Artifacts) | 11     | ~800       | Panel, tabs (code, diff, traces, config, test, metrics), topology, agents                                                                                                   |
| Store                | 1      | 150        | Ephemeral state, dynamic tabs, artifact versions                                                                                                                            |
| Tests                | 19     | 2,789      | 168 tests (124 unit + 44 component)                                                                                                                                         |
| **Total**            | **67** | **~8,152** |                                                                                                                                                                             |

### 12.2 Test Coverage

| Area             | Tests | What's Covered                                                                                        |
| ---------------- | ----- | ----------------------------------------------------------------------------------------------------- |
| System prompt    | 8     | Provider detection, prompt assembly, token budget                                                     |
| Tool schemas     | 6     | ask_user Zod validation, client-side tool shape                                                       |
| Home tools       | 17    | generate_topology (retry+stub), generate_agents (parallel+validation), create_project (approval+save) |
| ABL builder      | 4     | Deterministic ABL from metadata                                                                       |
| Use case E2E     | 4     | Dense message extraction, multi-step Q&A, file context                                                |
| Route            | 3     | Auth guard, config check, streaming response                                                          |
| Guards (RBAC)    | 15    | Permission mapping, wildcards, dangerous actions                                                      |
| agent_ops        | 10    | CRUD, section edits, dryRun, compile, delete confirmation                                             |
| analyze          | 8     | Explain, suggest, test, traces, RBAC                                                                  |
| Context routing  | 3     | Home tools, project tools, tool presence                                                              |
| tools_ops        | 9     | CRUD, test execution, delete confirmation                                                             |
| topology_ops     | 4     | Read (build from agents), modify stub, RBAC                                                           |
| testing_ops      | 4     | Run test, evals, RBAC                                                                                 |
| deployment_ops   | 6     | Deploy/promote confirmation, channels, RBAC                                                           |
| knowledge_ops    | 6     | KB CRUD, delete confirmation, RBAC                                                                    |
| analytics_ops    | 6     | Metrics, filters, time ranges, RBAC                                                                   |
| Artifact viewers | 36    | Code viewer, diff viewer, trace timeline, tool config, test result, metrics                           |
| Dynamic tabs     | 8     | Add, remove, max 5 eviction, version tracking                                                         |

### 12.3 E2E Results (Playwright)

| #   | Project                 | Agents | ABL Valid        | Status          |
| --- | ----------------------- | ------ | ---------------- | --------------- |
| 1   | Restaurant Reservations | 2      | All valid        | SUCCESS         |
| 2   | Gym Fitness Bot         | 5      | 4 valid + 1 stub | SUCCESS         |
| 3   | Library Assistant       | 2      | All valid        | SUCCESS         |
| 4   | Dentist Booking         | 2      | All valid        | SUCCESS         |
| 5   | Car Rental              | -      | -                | TIMEOUT (4 min) |
| 6   | Flower Shop             | 2      | All valid        | SUCCESS         |
| 7   | Hotel Concierge         | 2      | All valid        | SUCCESS         |
| 8   | Tech Support            | 6      | All valid        | SUCCESS         |
| 9   | Travel Planner          | 2      | All valid        | SUCCESS         |
| 10  | Bakery Bot              | 2      | All valid        | SUCCESS         |

**9/10 successful.** All saved agents have LLM-generated ABL (`wasRebuilt: false`).

### 12.4 Deviations from Design

| Deviation                 | Description                                                         | Status  |
| ------------------------- | ------------------------------------------------------------------- | ------- |
| topology_ops.modify       | Stub only — full modification deferred                              | TODO    |
| Topology tab              | JSON display, not XyFlow canvas                                     | TODO    |
| Context-aware empty state | Added `useProjectSuggestions` hook (not in design)                  | Shipped |
| ABL builder               | Added `abl-builder.ts` (not in design) — deterministic fallback     | Shipped |
| Vercel model resolver     | Added `resolveArchVercelModel()` — returns `LanguageModel` directly | Shipped |
| Auto-navigate             | 5s countdown instead of manual button                               | Shipped |

### 12.5 Critical Bugs Found During Implementation

| #   | Bug                                 | Sev | Root Cause                                      | Fix                             |
| --- | ----------------------------------- | --- | ----------------------------------------------- | ------------------------------- |
| 1   | `convertToModelMessages()` is async | P0  | Returns Promise, called without await           | `await` the call                |
| 2   | Tool parts are `tool-<name>`        | P0  | SDK v6 sends typed parts, not `dynamic-tool`    | `part.type.startsWith('tool-')` |
| 3   | SPA router bypasses file routing    | P0  | AppShell uses custom router                     | Updated AppShell imports        |
| 4   | Missing `sendAutomaticallyWhen`     | P1  | useChat doesn't auto-resubmit                   | Added config flag               |
| 5   | Auth headers not sent               | P0  | DefaultChatTransport needs credentials          | `headers: () => authHeaders()`  |
| 6   | Case-sensitive agent name lookup    | P1  | `findProjectAgent` lowercased path              | Look up by `agent.name`         |
| 7   | Stubs with invalid `DOMAIN:`        | P1  | ABL parser rejects `DOMAIN:`                    | Removed from templates          |
| 8   | DiffViewer crash on undefined       | P1  | agent_ops returned `diff.summary` not full diff | Return full diff + null check   |
| 9   | `<thought>` tags visible            | P2  | Raw LLM thinking leaked                         | Regex strip in renderer         |
| 10  | Transport recreated on render       | P2  | Not memoized                                    | `useMemo`                       |

### 12.6 Key Learnings

1. **Always check SDK function signatures** — `convertToModelMessages` being async was not obvious
2. **Test tool part types empirically** — don't guess, log actual types from the SDK
3. **SPA routers bypass file-based routing** — check `AppShell` before assuming route files work
4. **Auth flows are per-application** — Bearer tokens from Zustand, not cookies
5. **Validate data at every boundary** — ABL stubs had `DOMAIN:` that the parser itself rejects

---

## 14. Resolved Technical Questions

| #   | Question                            | Answer                                                                                      | Reference                                                              |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | ABL loop/cycle support              | No native loops. Use supervisor with `RETURN: true` as loop controller                      | handoff-executor.ts cycle detection                                    |
| 2   | Shared context across agents        | PASS fields + project-scoped FactStore + history strategies (full/last_n/summary_only/none) | ABL MEMORY + HANDOFF CONTEXT sections                                  |
| 3   | Custom events during tool execution | Yes via `experimental_onToolCallStart/Finish` (not mid-tool)                                | Vercel AI SDK source, `create-ui-message-stream.ts`                    |
| 4   | Multi-model prompt support          | `detectProvider(modelId)` routes to Claude/OpenAI/Gemini/Generic styles                     | system-prompt.ts + provider-prompts.ts                                 |
| 5   | RBAC approach                       | Reuse platform (`admin/developer/viewer`), check inside tool execute                        | `checkAgentPermission` + `hasPermission` from `@agent-platform/shared` |

---

## 15. Backlog

### P1 — Next Priority

| Item                                | Type     | Notes                                                  |
| ----------------------------------- | -------- | ------------------------------------------------------ |
| Rate limiter on `/api/arch-ai/chat` | Security | Reuse from existing arch routes                        |
| `topology_ops.modify` (full)        | Feature  | Add/remove agents, update handoff sections across DSLs |
| Topology tab XyFlow integration     | UI       | Currently JSON display, need interactive canvas        |
| Conversation persistence            | Feature  | MongoDB + localStorage for resuming conversations      |
| Structured logging audit            | Quality  | Verify `createLogger` usage, explicit trace events     |

### P2 — Enhancements

| Item                            | Type    | Notes                                                                       |
| ------------------------------- | ------- | --------------------------------------------------------------------------- |
| Arch Command Bar                | Feature | Designed (`arch-command-bar-design.md`). Search + mini chat + quick actions |
| Image upload (PNG, JPG, SVG)    | Feature | Multimodal-service exists, Arch AI path not wired                           |
| Model selector dropdown         | UI      | arch-config-store has model list, need dropdown                             |
| Streaming sub-step events       | UX      | Break tools into sub-tools for mid-execution progress                       |
| Chats section in sidebar        | Feature | Requires persistence                                                        |
| Chat rename + tombstone entries | Feature | Requires persistence                                                        |

### P3 — Future Vision

| Item                       | Type         | Notes                                                          |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| Universal search + FAQ bar | Feature      | Separate feature, shares command bar surface                   |
| Arch engine extraction     | Architecture | `@agent-platform/arch-engine` with DI interfaces for CLI reuse |
| Full markdown library      | UI           | Replace custom parser with react-markdown                      |
| Voice input in chat        | Feature      | Future                                                         |
| Multi-user collaboration   | Feature      | Shared conversations, team review                              |
| Real-time agent hot-reload | DX           | Live preview after modification                                |

---

## 16. File Structure

```
apps/studio/src/
  app/api/arch-ai/chat/route.ts                    <- Streaming endpoint (153 lines)

  lib/arch-ai/
    types.ts (102)                                   <- Tool result types, stream events
    constants.ts (28)                                <- Retry limits, timeouts, thresholds
    system-prompt.ts (99)                            <- Multi-model prompt builder
    provider-prompts.ts (62)                          <- Claude/OpenAI/Gemini/Generic styles
    abl-reference.ts (43)                            <- ABL syntax reference for LLM
    abl-builder.ts (172)                             <- Deterministic ABL fallback builder
    retry.ts (33)                                    <- Retry wrapper + error collection
    guards.ts (103)                                  <- RBAC mapping + safety guards
    context.ts (237)                                 <- Tool selection + context injection
    tools/
      index.ts (4)                                   <- Registry exports
      ask-user.ts (57)                               <- Client-side: ask_user + collect_file
      generate-topology.ts (116)                     <- Home: topology gen + validation
      generate-agents.ts (189)                       <- Home: parallel agent gen + ABL validation
      create-project.ts (184)                        <- Home: project creation + approval
      agent-ops.ts (396)                             <- Project: agent CRUD + section edits
      analyze.ts (164)                               <- Project: explain/suggest/test/traces
      tools-ops.ts (196)                             <- Project: tool config management
      topology-ops.ts (143)                          <- Project: topology read (modify stub)
      testing-ops.ts (156)                           <- Project: test conversations + evals
      deployment-ops.ts (157)                        <- Project: deploy/promote/channels
      knowledge-ops.ts (168)                         <- Project: KB management
      analytics-ops.ts (130)                         <- Project: metrics/insights

  components/arch-ai/
    ArchAIChatPage.tsx (72)                           <- Home chat page wrapper
    ArchAIChatPanel.tsx (806)                         <- Core: useChat + messages + tools + suggestions
    ThinkingIndicator.tsx (73)                        <- Tool progress spinner/checkmark
    InlineTopologyPreview.tsx (56)                    <- Compact topology card in chat
    InlineAgentsPreview.tsx (64)                      <- Compact agent card in chat
    CreateProjectApproval.tsx (150)                   <- Green banner + 5s countdown
    ask-user/
      AskUserRenderer.tsx                            <- Component dispatcher
      SingleSelect.tsx                               <- Numbered list, keyboard nav
      MultiSelect.tsx                                <- Checkbox selection
      TextInput.tsx                                  <- Free text input
      Confirmation.tsx                               <- Yes/no buttons
      FileUpload.tsx                                 <- Drag-drop file upload

  components/chat/
    ChatPage.tsx                                     <- Home layout (sidebar + split view)
    ProjectArchAIPage.tsx                             <- In-project (dynamic tabs)
    ArtifactPanel.tsx                                <- Right panel (home: fixed tabs)
    artifact-tabs/
      AgentCodeViewer.tsx                            <- Syntax-highlighted ABL
      DiffViewer.tsx                                 <- Section diffs, apply/reject
      TraceTimeline.tsx                              <- Trace events, filters
      ToolConfigViewer.tsx                           <- Tool config display
      TestResultViewer.tsx                           <- Test conversation viewer
      MetricsViewer.tsx                              <- Metric cards + raw data

  store/arch-ai-store.ts (150)                       <- Ephemeral: tabs, versions, prefill
```

---

## 17. Existing Arch vs Arch AI

| Aspect            | Existing Arch                         | Arch AI                                                |
| ----------------- | ------------------------------------- | ------------------------------------------------------ |
| API               | `/api/arch/chat` (sync JSON)          | `/api/arch-ai/chat` (streaming)                        |
| LLM calls         | `llm.chat()` text + `chatWithTools()` | `streamText` with tools for everything                 |
| Streaming         | None                                  | Native token streaming + custom events                 |
| UI interaction    | Frontend-driven (forms, 5-state FSM)  | LLM-driven (tool calls render UI)                      |
| Generation        | Hardcoded sequential pipeline         | LLM decides when to generate                           |
| Validation        | Post-hoc (generate then parse)        | Built into tool (generate + validate + retry)          |
| Human-in-the-loop | Custom workflow state machine         | Native SDK `needsApproval`                             |
| Data collection   | 5 sequential form screens             | Adaptive (asks only what's missing)                    |
| Error handling    | Stub fallback, no retry               | Tool retry + LLM self-correction + stubs               |
| Extensibility     | Modify 2,910-line service file        | Add a tool definition                                  |
| Agent generation  | Single LLM call for all               | Parallel per agent (3s vs 20s)                         |
| In-project scope  | 9 tools (agents + traces only)        | 9 grouped tools (agents, tools, KB, deploy, analytics) |
| Code size         | ~2,910 lines (single service file)    | ~5,070 lines (67 focused files)                        |
| Tests             | 49 tests                              | 168 tests                                              |

---

## 18. Security Audit Findings

Audit conducted 2026-03-10 against Arch AI implementation. 8 issues found.

### 18.1 Critical Issues

| #   | Issue                                                                                                                | File                             | Risk                                                                                                      | Fix                                                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Wildcard permission fallback** — empty `user.permissions` gets `['*:*']` superadmin access                         | `route.ts:109-110`               | Any user in tenant without configured roles gets full destructive access                                  | Remove `['*:*']` fallback. Default to empty `[]`. Deny by default.                                                                                           |
| 2   | **LLM can override `confirmed` parameter** — no server-side proof user actually saw and approved the confirmation UI | `agent-ops.ts:39`, all ops tools | Prompt injection can instruct LLM to set `confirmed: true`, bypassing user confirmation for delete/deploy | Implement confirmation token: track that `ask_user(confirmation)` was called before accepting `confirmed: true`. Server-side validation, not just a boolean. |

### 18.2 High Issues

| #   | Issue                                                                      | File                | Risk                                                                                | Fix                                                                                      |
| --- | -------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 3   | **No rate limiting** on `/api/arch-ai/chat`                                | `route.ts`          | Cost exhaustion (LLM token burn), DoS via rapid requests, 20 tool calls per request | Add `checkRateLimit('arch-ai:{userId}', 20, 60)` — 20 requests/min/user                  |
| 4   | **No server-side file validation** — `collect_file` is client-side only    | `ask-user.ts:49-57` | Malicious uploads bypass client validation (ZIP bombs, scripts disguised as PDFs)   | Add server-side upload endpoint with magic-byte validation, size check, malware scan     |
| 5   | **Stack traces in error messages** — error handler may leak internal paths | `route.ts:134-136`  | Information disclosure aids reconnaissance                                          | Sanitize error messages before client. Log full error server-side, send generic message. |

### 18.3 Medium Issues

| #   | Issue                                                                                                         | File                    | Risk                                                                              | Fix                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 6   | **ABL injection via `any` types** — user input (agent name, description) embedded in ABL without sanitization | `abl-builder.ts:42,134` | Injected ABL keywords (e.g., `GOAL: "malicious"\nTOOLS:`) override agent behavior | Replace `any` with typed interfaces. Sanitize user strings before ABL embedding.       |
| 7   | **Dangerous actions list incomplete** — `deploy`, `promote`, `topology.modify` not marked dangerous           | `guards.ts:62-67`       | Production deploy or topology change without user confirmation                    | Add: `deployment_ops: ['deploy', 'promote', 'rollback']`, `topology_ops: ['modify']`   |
| 8   | **Session ID passed to Runtime** — regex allows hyphens that could be crafted into NoSQL operators            | `analyze.ts:124`        | If Runtime uses raw queries, potential NoSQL injection                            | Verify Runtime uses parameterized queries. Add comment documenting the trust boundary. |

### 18.4 Remediation Priority

| Priority                           | Issues                                                     | Effort   | Status |
| ---------------------------------- | ---------------------------------------------------------- | -------- | ------ |
| **Immediate** (before next deploy) | #1 wildcard, #3 rate limiter, #7 dangerous actions         | ~1 hour  | TODO   |
| **This sprint**                    | #2 confirmation tokens, #5 error sanitization              | ~3 hours | TODO   |
| **Next sprint**                    | #4 file validation, #6 ABL sanitization, #8 verify Runtime | ~3 hours | TODO   |

### 18.5 Code Quality Audit (Against Platform Standards)

**Overall: Exceptionally clean.** 24 files reviewed, 2 issues found.

| Check                                                                | Status                                 |
| -------------------------------------------------------------------- | -------------------------------------- |
| No `console.log` in server code                                      | PASS (all 13 files use `createLogger`) |
| No `.catch(() => {})`                                                | PASS                                   |
| Error extraction: `err instanceof Error ? err.message : String(err)` | PASS                                   |
| No `findById` (uses tenant-scoped queries)                           | PASS                                   |
| Route under 300 LOC                                                  | PASS (153 lines)                       |
| Zod validation on all tool inputs                                    | PASS                                   |
| No XSS vectors (React auto-escaping)                                 | PASS                                   |
| Named constants (no magic numbers)                                   | PASS (1 exception — see below)         |
| Structured logging with context                                      | PASS                                   |
| `{ success, data?, error?: { code, message } }` return pattern       | PASS                                   |
| No methods over 100 lines                                            | PASS (longest ~90 in agent-ops.ts)     |
| Proper async/await (no dangling promises)                            | PASS                                   |
| No `any` where typed interfaces exist                                | **FAIL** (2 locations)                 |
| No inline prompt strings in engine code                              | PASS (prompts in dedicated files)      |
| No in-memory Maps without max size/TTL                               | PASS (no Maps in arch-ai)              |
| No duplicate code patterns across tools                              | PASS                                   |

**Code quality issues to fix:**

| #    | Issue                                  | File:Line                                          | Severity  | Fix                                                                                |
| ---- | -------------------------------------- | -------------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| CQ-1 | `any` types for topology nodes/edges   | `abl-builder.ts:134`, `generate-agents.ts:114,125` | Important | Replace with `TopologyData`, `GeneratedAgent` typed interfaces from `@/types/arch` |
| CQ-2 | Magic number `200` in session ID regex | `analyze.ts:124`                                   | Important | Add `MAX_SESSION_ID_LENGTH: 200` to `constants.ts`, reference in regex             |

### 18.6 Prompt Quality Issues (Found via Playwright Testing)

Playwright batch testing (Session 5 — Pizza Delivery Bot) revealed that the ABL reference taught to the LLM contains invalid syntax that passes the parser but fails at compilation.

| #    | Issue                                         | Severity     | Root Cause                                                                                                                                        | Impact                                                      |
| ---- | --------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| PQ-1 | **`MODE:` keyword in ABL reference**          | **CRITICAL** | `abl-reference.ts:14` teaches `MODE: reasoning` but the compiler rejects it — "MODE is no longer supported. Use REASONING: true/false per step."  | Every LLM-generated agent uses `MODE:` and fails in project |
| PQ-2 | **Validation gap — false "valid" report**     | **CRITICAL** | `generate-agents.ts` calls `parseAgentBasedABL()` + `compileABLtoIR()` and reports "6/6 valid", but agents fail when loaded in the project editor | Users believe agents are valid when they are not            |
| PQ-3 | **No auto-navigation after project creation** | **HIGH**     | `CreateProjectApproval.tsx` has 5s countdown but navigation doesn't trigger — user stuck on /chat                                                 | UX broken at final step                                     |
| PQ-4 | **No navigate tool for LLM**                  | **HIGH**     | LLM says "I don't have a tool to navigate" when user asks to go to project                                                                        | LLM has no way to redirect user                             |
| PQ-5 | **False supervisor stub warning**             | **MEDIUM**   | LLM warns "supervisor is minimal stub" even when supervisor has full HANDOFF rules                                                                | Confuses users about generation quality                     |

**Remediation priority:**

| Priority        | Issues                                                                    | Effort   |
| --------------- | ------------------------------------------------------------------------- | -------- |
| **Immediate**   | PQ-1 (remove MODE from reference), PQ-2 (fix validation)                  | ~2 hours |
| **This sprint** | PQ-3 (auto-nav), PQ-4 (navigate tool or URL in response)                  | ~1 hour  |
| **Next sprint** | PQ-5 (stub detection logic), CQ-1 (typed interfaces), CQ-2 (magic number) | ~1 hour  |

---

## 19. Platform Capability Roadmap

### 19.1 Current vs Available

Arch AI currently uses **12 tool groups with ~35 actions** across **~15 API endpoints**. The platform has **74+ Runtime routes, 301+ Studio routes, and 130 database models** that Arch AI could leverage.

### 19.2 User-Requested Features (10 Items)

| #   | Feature                                        | Current State                                   | What Exists in Platform                                          | What's Missing                                                                                    |
| --- | ---------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | **Conversation persistence + shareable links** | Ephemeral only                                  | No persistence model                                             | New MongoDB model, CRUD routes, expirable link generation, pre-project collaboration              |
| 2   | **Test cases + reports**                       | Partial (`testing_ops.run_test`, `create_eval`) | Full eval suite: evaluators, personas, scenarios, runs, compare  | Eval runner integration, batch execution, report generation, comparison views                     |
| 3   | **Trace debugging + diagnostics**              | Partial (`analyze.query_traces`)                | 50+ trace event types, ClickHouse analytics                      | Deep-dive viewer in artifact panel, automated root-cause analysis, diagnostic reports             |
| 4   | **Workflow tool creation**                     | Not built                                       | Full workflow engine (Restate-backed), approval queues, triggers | `workflow_ops` tool: create, execute, list, archive                                               |
| 5   | **Workspace analytics + account scope**        | Project-scoped only (`analytics_ops`)           | Cross-project analytics routes, ROI metrics, usage metrics       | Workspace-level aggregation, account scoping (careful: needs role gating)                         |
| 6   | **Marketplace templates**                      | Not built                                       | Import/Export APIs, project cloning                              | Template catalog model, community sharing, one-click scaffolding                                  |
| 7   | **Audit reports**                              | Not built                                       | `audit-log` model, audit routes exist                            | `audit_ops` tool: query_changes, who_changed, generate_compliance_report                          |
| 8   | **Deployments (enhanced)**                     | Partial (`deployment_ops`)                      | Version history, rollback routes                                 | Staging vs prod comparison, rollback with confirmation, deployment health                         |
| 9   | **Env management + where-used**                | Not built                                       | `env_var` routes, `tool-secrets` CRUD                            | `env_ops` tool: list_vars, set_var, where_used impact analysis (heavy user pain point)            |
| 10  | **Evaluation metrics**                         | Partial (`analytics_ops`)                       | Quality scores, intent distribution, anomaly detection           | Evaluation dashboard in artifact panel, trend analysis, agent comparison, automated quality gates |

### 19.3 Platform Capabilities Discovered (Additional)

| #   | Capability                     | Platform APIs Available                                              | Proposed Tool                                                       | Priority |
| --- | ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| 11  | **Guardrails config**          | `guardrail-policies` CRUD, `guardrail-providers`                     | `guardrail_ops`: create_policy, configure_pii, test_guardrail       | P1       |
| 12  | **Git sync**                   | `project-io` git operations, webhooks                                | `git_ops`: connect_repo, push, pull, resolve_conflicts, auto_deploy | P2       |
| 13  | **Connector discovery**        | 500+ connectors, schema discovery, recommender                       | `connector_ops`: recommend, configure, test_connection              | P2       |
| 14  | **Per-agent model config**     | `agent-model-config`, model catalog, cost data                       | `model_ops`: recommend_model, compare_costs, set_agent_tier         | P2       |
| 15  | **Agent versioning**           | `agent-version`, rollback routes                                     | agent_ops enhancement: `list_versions`, `rollback_version`          | P1       |
| 16  | **Voice/channel setup**        | Twilio, LiveKit, Jambonz, Deepgram, ElevenLabs                       | channel_ops enhancement: `setup_voice`, `configure_stt_tts`         | P2       |
| 17  | **Secrets management**         | `tool-secrets` encrypted CRUD, KMS                                   | `secrets_ops`: set_secret, rotate_key, list_secrets                 | P2       |
| 18  | **Contact management**         | Contact CRUD, merge, identity verification                           | `contact_ops`: search, merge_duplicates, verify_identity            | P3       |
| 19  | **Circuit breaker monitoring** | Full circuit breaker API, health endpoints                           | `health_ops`: check_health, list_breakers, warn_degraded            | P3       |
| 20  | **Experiment/A-B testing**     | `experiments` CRUD                                                   | `experiment_ops`: create_experiment, view_results                   | P3       |
| 21  | **Analytics pipelines**        | 14 pipeline types (sentiment, intent, quality, anomaly, drift, etc.) | `pipeline_ops`: enable_pipeline, configure, view_runs               | P3       |
| 22  | **Human tasks/approvals**      | `human-tasks`, `approval-queue`                                      | workflow_ops enhancement: `create_approval`, `list_pending`         | P2       |

### 19.4 Role-Based Access Vision

| Capability                | admin | developer (editor) | viewer (tester)       |
| ------------------------- | ----- | ------------------ | --------------------- |
| Chat with Arch AI         | Full  | Full               | Read-only suggestions |
| Read agents/tools/KB      | Yes   | Yes                | Yes                   |
| Modify agents             | Yes   | Yes                | No                    |
| Delete agents/tools       | Yes   | No                 | No                    |
| Deploy/promote            | Yes   | No                 | No                    |
| Run tests                 | Yes   | Yes                | Yes                   |
| View analytics            | Yes   | Yes                | Yes                   |
| View audit reports        | Yes   | Yes                | Yes                   |
| Create eval sets          | Yes   | Yes                | No                    |
| Share conversation links  | Yes   | Yes                | Yes (view-only)       |
| Manage env variables      | Yes   | Yes                | No                    |
| Workspace-level analytics | Yes   | No                 | No                    |
| Configure guardrails      | Yes   | Yes                | No                    |
| Manage secrets            | Yes   | No                 | No                    |

### 19.5 Expanded Tool Inventory (Current + Future)

| Tool Group                 | Current Actions                             | Proposed New Actions                                                      | Priority |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| `agent_ops`                | read, list, create, modify, compile, delete | + list_versions, rollback_version, manage_lookup_data                     | P1       |
| `analyze`                  | explain, suggest, test, query_traces        | + deep_diagnostics, generate_report, root_cause_analysis                  | P1       |
| `topology_ops`             | read, modify (stub)                         | + modify (FULL implementation), visualize                                 | P1       |
| `testing_ops`              | run_test, create_eval, list_evals           | + run_eval_set, compare_runs, generate_personas, batch_test               | P1       |
| `deployment_ops`           | list, deploy, promote, channels             | + rollback, compare_versions, deployment_health                           | P1       |
| `analytics_ops`            | metrics, intents, quality_scores, anomalies | + trends, agent_comparison, cost_analysis, ROI                            | P2       |
| `tools_ops`                | read, list, create, update, test, delete    | + recommend_connectors, configure_connector                               | P2       |
| `knowledge_ops`            | list, create, add_document, query, delete   | + crawl_status, reindex, test_retrieval                                   | P2       |
| **NEW `eval_ops`**         | —                                           | create_evaluator, create_persona, create_scenario, run_eval, compare_runs | P1       |
| **NEW `guardrail_ops`**    | —                                           | create_policy, add_rule, configure_pii, test_guardrail                    | P1       |
| **NEW `workflow_ops`**     | —                                           | create_workflow, execute, list_pending_approvals                          | P2       |
| **NEW `git_ops`**          | —                                           | connect_repo, push, pull, resolve_conflicts, setup_auto_deploy            | P2       |
| **NEW `env_ops`**          | —                                           | list_vars, set_var, where_used, compare_environments                      | P2       |
| **NEW `audit_ops`**        | —                                           | query_changes, generate_report, compliance_check                          | P2       |
| **NEW `conversation_ops`** | —                                           | save, load, share_link, list_history                                      | P2       |
| **NEW `health_ops`**       | —                                           | check_health, list_breakers, warn_degraded                                | P3       |
| **NEW `model_ops`**        | —                                           | recommend_model, compare_costs, set_agent_model                           | P3       |
| **NEW `template_ops`**     | —                                           | browse_templates, clone_template, publish_template                        | P3       |
| **NEW `secrets_ops`**      | —                                           | set_secret, rotate_key, list_secrets                                      | P2       |
| **NEW `connector_ops`**    | —                                           | recommend, configure, test_connection, list_available                     | P2       |
| **NEW `experiment_ops`**   | —                                           | create_experiment, view_results, compare_variants                         | P3       |

**Current: 12 tool groups, ~35 actions. Future: 23 tool groups, ~95+ actions.**

### 19.6 Implementation Phases

| Phase       | Tools                                                               | New APIs Needed                                   | Priority |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------- | -------- |
| **Phase 4** | eval_ops, guardrail_ops, agent versioning, topology.modify (full)   | Minimal (APIs exist)                              | P1       |
| **Phase 5** | workflow_ops, git_ops, env_ops, conversation_ops, secrets_ops       | conversation persistence (new model)              | P2       |
| **Phase 6** | connector_ops, model_ops, enhanced analytics, deployment comparison | Where-used analysis (new), template catalog (new) | P2       |
| **Phase 7** | health_ops, experiment_ops, template_ops, audit_ops, pipeline_ops   | Template marketplace (new)                        | P3       |
