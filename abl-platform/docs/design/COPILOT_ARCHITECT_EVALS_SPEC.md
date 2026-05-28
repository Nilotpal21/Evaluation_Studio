# ABL Platform — Copilot, Architect & Evals

**Status:** Draft Spec v2 — North Star Experience
**Author:** Auto-generated from Santhosh Kumar Myadam's prototype (Loom, Feb 13 2026)
**Date:** 2026-02-13

---

## Design Philosophy

### The Problem with "Fill This Form"

Most dev tools treat creation as form-filling. The user stares at empty fields, context-switches between documentation and the UI, and manually wires things together. This is backwards. The system knows more than the user at every step — it has the DSL spec, the project's agents, the compiled IR, the execution traces. **The system should lead. The user should steer.**

### Five Principles

| #   | Principle                             | What it means                                                                                                                                                                                |
| --- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **AI proposes, human disposes**       | Never show an empty form. Always show a pre-filled suggestion. The user edits, not creates from scratch.                                                                                     |
| 2   | **Visual first, code on demand**      | Every interaction starts with a visual representation (topology, flow, heat map). Code/DSL is one click deeper.                                                                              |
| 3   | **Live preview, not submit-and-wait** | Changes preview instantly — topology redraws, flows animate, scores estimate — before the user commits.                                                                                      |
| 4   | **Progressive disclosure**            | Surface layer: visual + natural language. Middle layer: structured config. Deep layer: raw DSL/JSON. Each click goes one level deeper.                                                       |
| 5   | **Connected journey**                 | Copilot → Architect → Evals are one continuous flow. Creating a project seeds the Architect context. Architect changes trigger Eval suggestions. Eval failures link back to Architect fixes. |

### The Experience Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 0: Glance         Visual topology, status dots, scores   │
│  ───────────────────────────────────────────────────────────────│
│  Layer 1: Interact       Click nodes, hover edges, drag panels  │
│  ───────────────────────────────────────────────────────────────│
│  Layer 2: Configure      Structured forms, dropdowns, sliders   │
│  ───────────────────────────────────────────────────────────────│
│  Layer 3: Code           Raw DSL, JSON, API calls               │
└─────────────────────────────────────────────────────────────────┘
```

Every feature in this spec exists at all four layers. A first-time user never leaves Layer 0-1. A power user lives in Layer 2-3. Most users float between 1-2.

---

## Overview

| Module        | One-liner                                                                | North Star                                                                              |
| ------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Copilot**   | AI-guided project creation with live topology preview                    | "Describe what you want → watch agents appear on a canvas → refine → ship"              |
| **Architect** | AI assistant + live topology for inspecting, modifying, debugging agents | "See your entire project as a living diagram. Talk to it. Change it by pointing."       |
| **Evals**     | Matrix evaluation: Personas × Scenarios × Evaluators with visual scoring | "One click generates a full test suite. Results show as a heat map, not a spreadsheet." |

---

## 1. Copilot — From Intent to Running Project

### 1.1 North Star Experience

> The user types "I need a customer support system for a bank that handles card issues, account inquiries, and loan questions." As they type, a live topology diagram materializes on the right side of the screen — nodes appear, connect, rearrange. By the time they finish typing, they're looking at a 4-agent system with a supervisor, three specialists, and the routing rules already sketched in. They drag-drop a PDF of their SOP. The topology enriches — new GATHER fields appear on nodes, tool badges light up. They click "Generate" and watch each agent's DSL stream into existence. Sixty seconds later, they have a working project.

### 1.2 Entry Point

**Projects Dashboard** → "New Project" button with smart dropdown:

```
┌──────────────────┐
│  + New Project    │
├──────────────────┤
│  ✦ AI Wizard     │ ← recommended, opens Copilot
│  ◻ Blank Project │ ← existing simple modal
│  📋 From Template │ ← pre-built domain starters (new)
└──────────────────┘
```

"From Template" shows domain cards (Banking, Telecom, Healthcare, Retail, IT Support) that pre-seed the wizard with domain-specific descriptions, sample agents, and tool suggestions.

### 1.3 Wizard Steps — 5-Step Flow with Live Canvas

The wizard is a **persistent split layout**: left side is the wizard steps, right side is a **live topology canvas** that evolves as the user progresses. The canvas isn't a static image — it's the same `AgentFlowGraph` / Dagre-based component used in the Architect, seeded with the AI's evolving plan.

```
┌──────────────────────────────────────┬──────────────────────────────────┐
│  WIZARD PANEL (left, ~45%)           │  LIVE CANVAS (right, ~55%)       │
│                                      │                                  │
│  Step indicator: ① ② ③ ④ ⑤         │  ┌─────────┐                    │
│                                      │  │Supervisor│ ← appears as      │
│  [Current step content]              │  └────┬────┘   user types       │
│                                      │   ┌───┼───┐                     │
│                                      │   ▼   ▼   ▼                     │
│                                      │  ┌──┐┌──┐┌──┐                   │
│                                      │  │CS││PQ││OI│ ← nodes grow      │
│                                      │  └──┘└──┘└──┘   with detail     │
│                                      │                                  │
│                                      │  Zoom · Fit · Legend             │
└──────────────────────────────────────┴──────────────────────────────────┘
```

The canvas uses Framer Motion for smooth node entrance animations (fade-in-scale + spring easing). Nodes start as small circles and expand into full cards as more detail is known.

---

**Step 1 — Describe: "What are you building?"**

Left panel:

- Large textarea with character counter (max 2000)
- **Template chips** for quick-start: `[Customer Support]` `[Sales Assistant]` `[IT Helpdesk]` `[Onboarding Guide]`
- Clicking a chip fills the textarea AND immediately populates the canvas with a domain-appropriate starter topology

Right panel (canvas):

- **Live topology generation** — as the user types (debounced 800ms), the AI analyzes the text and:
  - Identifies probable agents (nodes appear with fade-in animation)
  - Infers routing relationships (edges draw with path animation)
  - Suggests entry point (node gets green glow)
  - Shows confidence indicators (solid nodes = high confidence, dashed = tentative)
- Each canvas node shows: agent name + inferred role tag
- This is a lightweight "sketch" — full detail comes in later steps

```
┌─────────────────────────────────────┬──────────────────────────────────┐
│  Step 1 of 5 — Describe             │                                  │
│                                      │        ┌──────────────┐         │
│  What are you building?              │        │  Supervisor   │         │
│  ┌─────────────────────────────┐    │        │  (entry)      │         │
│  │ I want to build a customer  │    │        └──────┬───────┘         │
│  │ support system for a bank   │    │       ┌───────┼───────┐        │
│  │ that handles card issues,   │    │       ▼       ▼       ▼        │
│  │ account inquiries, and      │    │   ┌───────┐┌───────┐┌──────┐  │
│  │ loan questions.             │    │   │ Card  ││Account││ Loan │  │
│  │                             │    │   │ Agent ││ Agent ││Agent │  │
│  └─────────────────────────────┘    │   └───────┘└───────┘└──────┘  │
│  156 / 2000                          │                                  │
│                                      │  ✦ 4 agents detected             │
│  Quick start:                        │  ◆ 1 supervisor · 3 specialists  │
│  [Banking] [Telecom] [Retail] [IT]  │  ─▶ 3 routing rules inferred     │
│                                      │                                  │
│                        [→ Continue]  │  [Zoom] [Fit] [Toggle labels]   │
└─────────────────────────────────────┴──────────────────────────────────┘
```

---

**Step 2 — Upload Documents (optional)**

Left panel:

- Heading: "Upload Documents (optional)"
- Subheading: "Upload SOPs, API specs, or conversation logs. The AI will extract workflows, entities, and tool requirements."
- Drag-and-drop zone: "Drag & drop files, or click to browse"
- Constraints: PDF, DOCX, TXT, MD — up to 10MB each — max 5 files
- **After upload: Document Insights cards** — the AI processes each document and shows extracted intelligence:

```
┌─────────────────────────────────────┬──────────────────────────────────┐
│  Step 2 of 5 — Upload                │                                  │
│                                      │  [Canvas now shows enriched      │
│  Upload Documents (optional)         │   topology — new GATHER fields   │
│  Upload SOPs, API specs, or conv.    │   appear on nodes, tool badges   │
│  logs. AI extracts workflows.        │   light up, edges get labels]    │
│                                      │                                  │
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐   │   ┌──────────────┐              │
│  │  📄 Drag & drop files       │   │   │  Supervisor   │              │
│  │     or click to browse      │   │   │  routes: 3    │              │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘   │   └──────┬───────┘              │
│  PDF, DOCX, TXT, MD · 10MB · 5 max │       ┌──┼───┐                  │
│                                      │       ▼  ▼   ▼                  │
│  ✅ card-support-sop.pdf             │   ┌──────┐┌──────┐┌──────┐     │
│  ┌─ Document Insights ─────────┐    │   │ Card  ││Acct  ││ Loan │     │
│  │ 📋 3 workflows detected     │    │   │ ──── ││ ──── ││ ──── │     │
│  │ 🏷️ 8 entities: card_number, │    │   │ 3    ││ 2    ││ 4    │     │
│  │    account_id, loan_id...   │    │   │ tools ││tools ││tools │     │
│  │ 🔧 5 API endpoints found    │    │   └──────┘└──────┘└──────┘     │
│  │ 💬 12 sample utterances     │    │                                  │
│  └─────────────────────────────┘    │  ✦ +8 entities from documents    │
│                                      │  🔧 +5 tool suggestions          │
│  [← Back]       [Skip] [→ Continue] │                                  │
└─────────────────────────────────────┴──────────────────────────────────┘
```

**Key UX detail:** When documents are processed, the canvas animates — new GATHER fields appear inside node cards, tool badges increment, new edges appear if document analysis reveals handoff patterns. The user literally watches their documents enrich the topology.

---

**Step 3 — Clarify: "AI Clarification"**

Left panel:

- AI-powered chat interface
- The AI incorporates context from Step 1 description + Step 2 documents
- AI suggests a project name, asks 2-3 targeted clarifying questions
- User types answers; AI refines the plan
- Three navigation buttons: "← Back", "Skip to Generate", "→ Generate"

Right panel (canvas):

- Canvas continues to evolve with each chat exchange
- When AI says "I'll add warranty handling to CardAgent", the CardAgent node visually updates — a brief pulse animation + updated tool count
- **Change indicators**: nodes that changed since last chat message get a subtle glow ring

```
┌─────────────────────────────────────┬──────────────────────────────────┐
│  Step 3 of 5 — Clarify              │                                  │
│                                      │  [Canvas with change indicators] │
│  AI Clarification                    │                                  │
│  ┌─────────────────────────────┐    │   ┌──────────────┐              │
│  │ 🤖 Based on your SOP, I     │    │   │  Supervisor   │              │
│  │ suggest "BankingSupport" as │    │   └──────┬───────┘              │
│  │ project name. The card SOP  │    │       ┌──┼───┐                  │
│  │ mentions fraud detection —  │    │       ▼  ▼   ▼                  │
│  │ should CardAgent handle     │    │   ┌──────┐┌──────┐┌──────┐     │
│  │ fraud alerts too?           │    │   │ Card ✨││ Acct ││ Loan │     │
│  │                             │    │   │ ────  ││ ──── ││ ──── │     │
│  │ 👤 Yes, and also temporary  │    │   │4 tools││2tools││4tools│     │
│  │ card blocks.                │    │   └──────┘└──────┘└──────┘     │
│  │                             │    │                                  │
│  │ 🤖 Got it. I'll add fraud   │    │  ✨ = changed this turn          │
│  │ detection + temp block to   │    │                                  │
│  │ CardAgent. Updated topology │    │  Latest: +fraud_detection tool   │
│  │ on the right. →             │    │          +temp_block tool        │
│  └─────────────────────────────┘    │          +fraud_alert GATHER     │
│  ┌──────────────────────┐ [Send]    │                                  │
│  │ Type your answer...   │           │                                  │
│  └──────────────────────┘           │                                  │
│                                      │                                  │
│  [← Back]  [Skip to Generate] [→ Generate]                             │
└─────────────────────────────────────┴──────────────────────────────────┘
```

---

**Step 4 — Review: "Edit Agents"**

The canvas now becomes the **primary view** (full width), with agent detail as a slide-over panel.

- **Canvas**: Full interactive topology — click any agent node to open its detail panel
- **Agent cards on canvas**: Each node now shows name, type badge (AUTONOMOUS), tool count, GATHER field count
- **Detail slide-over (right)**: When an agent is selected, shows:
  - Agent name + type badge
  - Generated DSL in Monaco editor (editable)
  - GATHER fields list, TOOLS list, HANDOFF targets — as visual tags
- **"↻ Regenerate" button**: Per-agent (in slide-over) or all agents (in toolbar)
- **Validation indicator**: "✓ DSL is valid" / "✗ 2 errors" shown per agent

```
┌─────────────────────────────────────────────────────────────────────┐
│  Step 4 of 5 — Review                                    [Create →] │
│  ┌───────────────────────────────────────┬──────────────────────┐   │
│  │            TOPOLOGY CANVAS            │  CustomerService      │   │
│  │                                       │  AUTONOMOUS · 2 tools │   │
│  │        ┌──────────────┐              │                       │   │
│  │        │  Supervisor   │              │  GATHER: customer_id, │   │
│  │        │  ◆ entry      │              │  issue_type            │   │
│  │        └──────┬───────┘              │                       │   │
│  │       ┌───────┼───────┐              │  TOOLS: route_intent,  │   │
│  │       ▼       ▼       ▼              │  get_customer          │   │
│  │   ┌──────┐┌──────┐┌──────┐          │                       │   │
│  │   │▶Card ││ Acct ││ Loan │          │  ┌─ DSL ──────────┐   │   │
│  │   │ 4t   ││ 2t   ││ 4t   │          │  │ AGENT: Customer │   │   │
│  │   └──────┘└──────┘└──────┘          │  │ ROLE: "Main..." │   │   │
│  │                                       │  │ DOMAIN: "bank"  │   │   │
│  │   ▶ = selected                        │  │ ...             │   │   │
│  │                                       │  └─────────────────┘   │   │
│  │   ✓ All 4 agents valid                │  ✓ Valid               │   │
│  │                                       │  [↻ Regenerate]        │   │
│  └───────────────────────────────────────┴──────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

**Step 5 — Create: "Generating..."**

- Full-screen canvas with agents generating one by one
- Each agent node transitions from "pending" (gray, dashed) → "generating" (pulsing accent glow) → "ready" (solid, green checkmark)
- Progress bar: "Creating project... Generating CardAgent (2/4)... Compiling..."
- DSL streams into each node as it's generated (visible if node is expanded)
- On completion: smooth transition to the project's Architect page (canvas persists — same topology, new context)

### 1.4 Backend Requirements

| Endpoint                     | Method | Purpose                                                                    |
| ---------------------------- | ------ | -------------------------------------------------------------------------- |
| `POST /api/copilot/analyze`  | POST   | Streaming — analyze description, return topology sketch as structured JSON |
| `POST /api/copilot/upload`   | POST   | Multipart upload → extract text → return document insights                 |
| `POST /api/copilot/clarify`  | POST   | Streaming SSE — chat turn with topology diff in response                   |
| `POST /api/copilot/generate` | POST   | Streaming SSE — generate DSL per agent with progress events                |
| `POST /api/copilot/create`   | POST   | Create project + agents + compile (returns project ID)                     |

**Key API design**: The `/analyze` and `/clarify` endpoints return **topology diffs** alongside chat text:

```typescript
interface CopilotStreamEvent {
  type: 'text_delta' | 'topology_update' | 'insight' | 'done' | 'error';
  // text_delta: streaming chat text
  delta?: string;
  // topology_update: incremental graph changes for live canvas
  topology?: {
    addNodes?: Array<{ name: string; role?: string; tools?: string[]; gatherFields?: string[] }>;
    removeNodes?: string[];
    addEdges?: Array<{ from: string; to: string; type: string; label?: string }>;
    updateNodes?: Array<{ name: string; changes: Partial<NodeData> }>;
  };
  // insight: extracted info from documents
  insight?: { type: 'workflow' | 'entity' | 'endpoint' | 'utterance'; data: unknown };
}
```

**Document processing pipeline:**

1. Upload → validate type (PDF/DOCX/TXT/MD) + size (≤10MB) → store temporarily
2. Extract text: `pdf-parse` (PDF), `mammoth` (DOCX), direct read (TXT/MD)
3. AI analysis: extract workflows, entities, API endpoints, sample utterances
4. Return structured insights + topology diffs
5. Persist extracted text in `CopilotSession.documents` for use in Steps 3-4

### 1.5 Data Model

```prisma
model CopilotSession {
  id         String   @id @default(cuid())
  projectId  String?
  tenantId   String
  userId     String
  messages   String   // JSON: conversation messages
  plan       String?  // JSON: structured topology plan
  documents  String?  // JSON: uploaded document metadata + extracted insights
  topology   String?  // JSON: current topology state (nodes + edges)
  status     String   @default("in_progress") // in_progress | completed | abandoned
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}
```

---

## 2. Architect — The Living Project Diagram

### 2.1 North Star Experience

> The user opens Architect and sees their entire project as an interactive topology — agents as nodes, handoffs as edges, the supervisor at the top. Each node pulses gently if it has active sessions. They click "CardAgent" and its DSL appears in a side panel. They type "add a fraud_alert GATHER field to CardAgent" in the chat. The AI responds with a diff. On the canvas, the CardAgent node highlights and shows a preview badge "+1 field". They click "Accept" and the canvas smoothly updates. They run a health check — nodes turn green/yellow/red. They click a yellow node — the AI explains "AccountAgent has no error handling for the get_balance tool timeout."

### 2.2 Layout — Canvas + Chat + Context

The Architect is a **three-zone layout**: topology canvas (main), chat bar (bottom), and context panel (right). The four tabs (General, Modify, Debug, Health Check) change the canvas overlay and chat behavior, not the entire layout.

```
┌────────────────────────────────────────────────┬───────────────────┐
│               TOPOLOGY CANVAS                   │  CONTEXT PANEL    │
│                                                 │                   │
│  ┌──────────┬──────────┬────────┬────────────┐ │  AGENTS           │
│  │ General  │ Modify   │ Debug  │Health Check│ │  ● CardAgent    ✓ │
│  └──────────┴──────────┴────────┴────────────┘ │  ● AccountAgent ✓ │
│                                                 │  ● LoanAgent    ✓ │
│         ┌──────────────┐                       │  ● Supervisor   ✓ │
│         │  Supervisor   │                       │                   │
│         │  ◆ entry      │                       │  CHANGES (0)      │
│         └──────┬───────┘                       │                   │
│        ┌───────┼───────┐                       │  SESSIONS         │
│        ▼       ▼       ▼                       │  3 active         │
│    ┌──────┐┌──────┐┌──────┐                   │                   │
│    │ Card ││ Acct ││ Loan │                   │  HEALTH           │
│    │  ●●  ││  ●   ││      │                   │  ● 3/4 healthy    │
│    └──────┘└──────┘└──────┘                   │  ▲ 1 warning      │
│                                                 │                   │
│  [Zoom] [Fit] [Auto-layout] [Minimap]          │                   │
├────────────────────────────────────────────────┤                   │
│  💬 Ask anything about your project...  [Send] │                   │
│  [✧ Health Check] [⟩ Load Session] [⊕ Add Agent]                  │
└────────────────────────────────────────────────┴───────────────────┘
```

**Canvas nodes** show contextual detail based on active tab:

- **General**: name, type badge, tool count, active session dots (●● = 2 active sessions)
- **Modify**: name + change preview badges ("+1 field", "modified")
- **Debug**: name + session flow arrows (animated dots moving along edges showing message routing)
- **Health Check**: name + red/yellow/green status dot + issue count

### 2.3 Tab Behaviors

#### General Tab (default)

**Canvas**: Full interactive topology

- Click node → opens detail in context panel (DSL preview, GATHER fields, tools, handoff targets, constraint summary)
- Double-click node → opens full DSL editor (existing `ABLEditor` page)
- Hover edge → shows routing rule tooltip
- Click edge → shows PASS/ON_RETURN mapping in context panel
- Right-click node → context menu: Open Editor, Chat About, Run Health Check, View Sessions

**Chat bar**: General-purpose AI assistant

- "What does CardAgent do?" → AI explains the agent's purpose based on DSL
- "How is routing configured?" → AI describes supervisor rules
- "What tools does LoanAgent use?" → AI lists and explains tools
- When AI references an agent, that node pulses on the canvas

**Context panel**: Shows selected node/edge detail, or project summary when nothing is selected:

- Total agents, connections, active sessions
- Entry agent, deployment status per environment
- Model configuration summary

#### Modify Tab

**Canvas**: Same topology + change preview overlays

- Nodes with pending changes show a colored ring (blue = added, orange = modified)
- Preview badges show what would change ("+1 field", "-1 tool", "new")

**Chat bar**: Modification-focused AI

- "Add a fraud_alert field to CardAgent" → AI proposes DSL change
- "Connect LoanAgent to a new EscalationAgent" → AI creates new agent + edge

**When AI proposes a change**: the **Modify modal** overlays the canvas:

```
┌─────────────────────────────────────────────────────────────┐
│  Proposed changes to CardAgent                               │
│  Modify existing agent                                       │
│                                                              │
│  🤖 "Added fraud_alert as a required GATHER field and       │
│  integrated the check_fraud tool in the FLOW section."      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  GATHER:                                              │   │
│  │    - card_number: REQUIRED                            │   │
│  │ +  - fraud_alert: REQUIRED                            │   │
│  │                                                      │   │
│  │  FLOW:                                               │   │
│  │    STEP verify_card:                                  │   │
│  │      CALL get_card_info(card_number)                  │   │
│  │ +  STEP check_fraud:                                  │   │
│  │ +    CALL check_fraud(card_number, fraud_alert)       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ✓ DSL is valid          Preview on canvas: CardAgent +1    │
│                                                              │
│  [Cancel]              [Reject]         [Accept & Apply]     │
└─────────────────────────────────────────────────────────────┘
```

After accepting, the canvas smoothly animates: node updates, edge count changes, CHANGES counter increments.

#### Debug Tab

**Canvas**: Topology + session flow visualization

- **Animated message flow**: Dots travel along edges showing which agent handled which turn
- Color-coded: green (successful), red (error), yellow (warning/timeout)
- Click a node → shows that agent's conversation snippet in context panel

**Chat bar**: Debug-focused AI

- "Load session abc123" → Loads session, replays flow on canvas
- "Why did the handoff to LoanAgent fail?" → AI analyzes trace events, highlights the problematic edge in red
- "Show me the last 5 errors" → AI lists errors, each linked to a canvas node

**Context panel**: Session detail when a session is loaded:

- Conversation transcript
- Trace event timeline (reuses `EventTimeline` component)
- State snapshots at each turn
- Constraint evaluation results

#### Health Check Tab

**Canvas**: Topology + health overlay

- Each node gets a status indicator: 🟢 healthy, 🟡 warning, 🔴 error
- Hover shows issue summary tooltip
- Click → AI explains the issue and suggests a fix

**Health checks performed:**

- Compilation status (can all agents compile?)
- Routing coverage (does every intent reach an agent?)
- Tool connectivity (are all referenced tools defined?)
- Constraint consistency (conflicting or unreachable constraints?)
- GATHER completeness (are required fields ever collected?)
- Dead code detection (unreachable flow steps?)
- Error handling coverage (do all agents have ON_ERROR?)

**Chat bar**: "Run health check" triggers analysis; AI narrates findings:

> "3 of 4 agents are healthy. AccountAgent has 1 warning: the get_balance tool is referenced in FLOW but not defined in TOOLS section. Recommendation: add get_balance to the TOOLS section or remove the CALL step."

**Visual report in context panel:**

```
Health Check Results
━━━━━━━━━━━━━━━━━━
✅ CardAgent        4/4 checks passed
✅ LoanAgent        4/4 checks passed
⚠️ AccountAgent     3/4 — missing tool definition
✅ Supervisor        4/4 checks passed

Overall: 15/16 passed · 1 warning · 0 errors
```

### 2.4 Backend Requirements

| Endpoint                                           | Method | Purpose                                                   |
| -------------------------------------------------- | ------ | --------------------------------------------------------- |
| `POST /api/projects/:projectId/architect/chat`     | POST   | Streaming SSE — AI chat with topology annotations         |
| `POST /api/projects/:projectId/architect/modify`   | POST   | Apply accepted modification to agent DSL                  |
| `POST /api/projects/:projectId/architect/validate` | POST   | Compile DSL and return validation result                  |
| `GET /api/projects/:projectId/architect/context`   | GET    | Load full project context (agents, compilation, topology) |
| `GET /api/projects/:projectId/architect/topology`  | GET    | Returns topology graph from compiled IR                   |
| `POST /api/projects/:projectId/architect/health`   | POST   | Run health check diagnostics                              |
| `POST /api/projects/:projectId/architect/debug`    | POST   | Analyze session traces                                    |

**Topology endpoint** (extracted from compiled IR):

```typescript
interface ProjectTopology {
  nodes: Array<{
    name: string;
    type: 'agent' | 'supervisor';
    isEntry: boolean;
    location: 'local' | 'remote';
    gatherFields: Array<{ name: string; required: boolean }>;
    tools: string[];
    handoffTargets: string[];
    escalationTargets: string[];
    constraintCount: number;
    flowStepCount: number;
    hasActiveVersion: boolean;
    activeSessions?: number;
    healthStatus?: 'healthy' | 'warning' | 'error';
    healthIssues?: string[];
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: 'handoff' | 'escalation' | 'routing' | 'a2a';
    condition?: string;
    passFields?: string[];
  }>;
}
```

**Chat response includes topology annotations:**

```typescript
interface ArchitectStreamEvent {
  type: 'text_delta' | 'node_highlight' | 'edge_highlight' | 'topology_change' | 'done';
  delta?: string;
  highlight?: { target: string; style: 'pulse' | 'glow' | 'error' | 'success' };
  change?: { type: 'add_node' | 'update_node' | 'add_edge' | 'remove_edge'; data: unknown };
}
```

### 2.5 Technology Choices

| Concern        | Recommendation                                           | Rationale                                          |
| -------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Canvas         | Dagre.js layout + custom SVG (extend `StateMachineView`) | Already built, proven, supports zoom/pan/drag      |
| Node rendering | Custom React SVG components with Framer Motion           | Smooth animations, consistent with existing design |
| Diff view      | Existing `DiffViewer` component                          | Already in the codebase                            |
| Chat UI        | Extend `ChatPanel` with topology annotation support      | Reuse existing chat infrastructure                 |
| AI backend     | `SessionLLMClient` with `operationType: 'architect'`     | Tenant-scoped, audited                             |

---

## 3. Evals — Visual Matrix Evaluation

### 3.1 North Star Experience

> The user opens Evals on a new project. Instead of empty tabs, the AI has already pre-generated 3 personas and 5 scenarios based on the agents' GATHER fields, FLOW steps, and HANDOFF patterns. The Personas tab shows cards like "FrustratedCustomer" and "FirstTimeUser" with personality radar charts. The Scenarios tab shows a flow-annotated list — each scenario has a mini topology showing which agents it exercises. The user clicks "Quick Eval" → the system auto-creates an eval set from all personas × all scenarios × a default "TaskCompletion" evaluator, runs it, and shows results as a color-coded heat map. Red cells jump out — the user clicks one → sees the full conversation + the judge's reasoning + a "Fix in Architect" button.

### 3.2 Proactive Seeding — "Never Empty"

When the user first visits Evals, or when agents change significantly, the system **proactively generates** suggested content:

**Auto-generated Personas** (from agent GATHER fields and DOMAIN):

- If the agent handles banking → suggest "FrustratedCustomer", "SeniorCitizen", "TechSavvyUser"
- If the agent has ESCALATE → suggest personas that trigger escalation (aggressive, edge-case)
- Each auto-persona is tagged `[AI-suggested]` and can be accepted, edited, or dismissed

**Auto-generated Scenarios** (from agent FLOW steps and HANDOFF targets):

- For each FLOW path → generate a scenario that exercises it
- For each HANDOFF → generate a scenario that triggers the handoff
- For each CONSTRAINT → generate a scenario that tests the constraint boundary
- Tagged `[AI-suggested]` with a mini flow diagram showing which path is tested

**Default Evaluators** (built-in, always available):

- "Task Completion" — did the agent achieve the scenario's expected outcome?
- "Response Quality" — clarity, accuracy, helpfulness
- "Safety" — no harmful content, no data leakage
- Users can customize these or add their own

```
┌─────────────────────────────────────────────────────────────────────┐
│  Evals — Evaluate agent performance                                  │
│                                                                      │
│  ✦ AI has pre-generated 3 personas and 5 scenarios from your         │
│    agents. Review and customize them, or run Quick Eval now.         │
│                                                       [▶ Quick Eval] │
├───────────┬───────────┬────────────┬────────────┬───────────────────┤
│  Personas │ Scenarios │ Evaluators │ Eval Sets  │ Runs              │
└───────────┴───────────┴────────────┴────────────┴───────────────────┘
```

**"Quick Eval" button** (top-right, always visible): One-click evaluation that:

1. Uses all personas × all scenarios × default evaluators
2. Creates a transient eval set named "Quick Eval — {timestamp}"
3. Runs immediately with default settings (3 variants)
4. Shows results inline — no navigation required

### 3.3 Tab 1: Personas

**Card layout** (not a table) — each persona is a visual card:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Personas                                           [+ New Persona] │
│                                                                      │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌────────────┐  │
│  │  FrustratedCustomer  │  │  FirstTimeUser       │  │  TechExpert│  │
│  │  [AI-suggested]      │  │  [AI-suggested]      │  │  [custom]  │  │
│  │                      │  │                      │  │            │  │
│  │  ╭─╮                │  │  ╭─╮                │  │  ╭─╮      │  │
│  │  │ │ Casual          │  │  │ │ Formal          │  │  │ │ Tech │  │
│  │  │▓│ Beginner        │  │  │▓│ Beginner        │  │  │▓│Expert│  │
│  │  │ │ Impatient       │  │  │ │ Cautious        │  │  │ │Direct│  │
│  │  ╰─╯                │  │  ╰─╯                │  │  ╰─╯      │  │
│  │                      │  │                      │  │            │  │
│  │  "Already frustrated │  │  "First time using  │  │  "Knows   │  │
│  │   wants quick fix"   │  │   the service"       │  │   systems"│  │
│  │                      │  │                      │  │            │  │
│  │  Used in: 2 eval sets│  │  Used in: 1 eval set │  │  Not used │  │
│  │  [Edit] [Duplicate]  │  │  [Edit] [Duplicate]  │  │  [Edit]   │  │
│  └─────────────────────┘  └─────────────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**The trait bar** (the `╭─╮` element) is a compact visual summary:

- Mini horizontal bar chart showing Communication Style, Domain Knowledge, and primary Behavior Trait
- Instantly distinguishes personas without reading descriptions

**New Persona Modal** — AI-assisted, never fully empty:

```
┌─────────────────────────────────────────────────────────────┐
│  New Persona                                                 │
│                                                              │
│  [From Template ▾]  [✦ AI Suggest]                          │
│                                                              │
│  Name*              ┌────────────────────────────────┐      │
│                     │ FrustratedCustomer              │      │
│                     └────────────────────────────────┘      │
│                                                              │
│  Description        ┌────────────────────────────────┐      │
│                     │ Customer who is already         │      │
│                     │ frustrated and wants quick fix  │      │
│                     └────────────────────────────────┘      │
│                                                              │
│  Communication Style     Domain Knowledge                    │
│  ┌───────────────┐      ┌───────────────┐                   │
│  │ Casual      ▾ │      │ Beginner    ▾ │                   │
│  └───────────────┘      └───────────────┘                   │
│                                                              │
│  Behavior Traits (comma-separated)                           │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ impatient, detail-oriented, verbose                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Goals              ┌────────────────────────────────┐      │
│                     │ Quick resolution, no transfers  │      │
│                     └────────────────────────────────┘      │
│                                                              │
│  Constraints        ┌────────────────────────────────┐      │
│                     │ Won't repeat info already given │      │
│                     └────────────────────────────────┘      │
│                                                              │
│  [Cancel]                                [Create Persona]    │
└─────────────────────────────────────────────────────────────┘
```

**"✦ AI Suggest" button**: Based on the project's agents and existing personas, the AI suggests a complementary persona (e.g., if all existing personas are beginners, suggest an expert). Pre-fills all fields.

### 3.4 Tab 2: Scenarios

**Table with visual annotations** — each scenario has a mini flow indicator showing which agents/paths it exercises:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Scenarios                                       [+ Create Scenario] │
│                                                  [✦ AI Generate]     │
│  [All Categories ▾]  [All Difficulties ▾]  [All Agents ▾]          │
│                                                                      │
│  NAME                     │ PATH           │ DIFF  │ TURNS │ TAGS   │
│  ─────────────────────────┼────────────────┼───────┼───────┼────────│
│  Card Block Request       │ Sup→Card       │ easy  │ 8     │ smoke  │
│  Appointment Modification │ Sup→Acct       │ med   │ 10    │        │
│  Fraud Alert Escalation   │ Sup→Card→Esc   │ hard  │ 15    │ edge   │
│  Unknown Intent           │ Sup→???        │ med   │ 5     │ routing│
│  Multi-Agent Flow         │ Sup→Card→Acct  │ hard  │ 20    │ e2e    │
│                                                                      │
│  PATH column: mini agent flow (Sup→Card = Supervisor routes to Card) │
└─────────────────────────────────────────────────────────────────────┘
```

**"✦ AI Generate" button**: Analyzes all agents' FLOW/HANDOFF/CONSTRAINT definitions and generates scenarios that cover:

- Each handoff path at least once
- Each constraint boundary condition
- At least one "unknown intent" / fallback scenario
- At least one multi-agent (2+ handoffs) scenario

Shows coverage estimation: "These 5 scenarios cover 85% of your agent paths. Add 2 more for full coverage."

**Create Scenario Modal** — same fields as in the prototype:

- Name\*, Description, Category, Difficulty (Easy/Medium/Hard)
- Entry Agent (optional), Initial Message (optional)
- Expected Outcome, Max Turns (default: 10), Tags

### 3.5 Tab 3: Evaluators

**Card layout** with visual type indicators:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Evaluators                                     [+ New Evaluator]    │
│                                                                      │
│  ── Built-in ──                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ 🎯 Task          │  │ ✍️ Response       │  │ 🛡️ Safety        │  │
│  │ Completion       │  │ Quality          │  │                   │  │
│  │ LLM Judge · 1-5  │  │ LLM Judge · 1-5  │  │ LLM Judge · P/F  │  │
│  │ [Customize]      │  │ [Customize]      │  │ [Customize]      │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                      │
│  ── Custom ──                                                        │
│  ┌──────────────────┐  ┌──────────────────┐                         │
│  │ 💚 Emotion       │  │ ⚡ Efficiency     │                         │
│  │ Management       │  │                   │                         │
│  │ LLM Judge · 1-5  │  │ LLM Judge · 1-5  │                         │
│  │ [Edit] [Delete]  │  │ [Edit] [Delete]  │                         │
│  └──────────────────┘  └──────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

**New Evaluator Modal** — same as prototype:

- Name\*, Description, Type (LLM Judge / Rule-based)
- Category (quality, safety, efficiency)
- **LLM Judge Configuration**: Judge Model, Judge Prompt, Chain of Thought (checkbox), Temperature, Scoring Rubric, Scale Type
- "From Template" dropdown with presets

### 3.6 Tab 4: Eval Sets — Visual Matrix Builder

Instead of a flat list, the Eval Set builder is a **visual matrix preview**:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Eval Sets                                      [+ Create Eval Set] │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  CardUnblockFlow                                  1P × 1S × 2E │ │
│  │                                                                │ │
│  │  Matrix Preview:                                               │ │
│  │            │ EmotionMgmt │ TaskCompletion │                    │ │
│  │  ──────────┼─────────────┼────────────────│                    │ │
│  │  Frustrated│  ◻          │  ◻             │  = 2 evals         │ │
│  │  × CardBlk │             │                │  × 3 variants      │ │
│  │            │             │                │  = 6 total          │ │
│  │                                                                │ │
│  │  Last run: 2h ago · Avg: 4.2/5           [▶ Run] [✎] [📊]    │ │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Full Regression                                  3P × 5S × 3E │ │
│  │                                                                │ │
│  │  Matrix Preview:                                               │ │
│  │            │ TaskComp │ EmotionMgmt │ Safety │                 │ │
│  │  ──────────┼──────────┼─────────────┼────────│                 │ │
│  │  Frustr×Card│ —       │ —           │ —      │                 │ │
│  │  Frustr×Appt│ —       │ —           │ —      │  = 45 evals     │ │
│  │  Frustr×Fraud│—       │ —           │ —      │  × 3 variants   │ │
│  │  First×Card │ —       │ —           │ —      │  = 135 total    │ │
│  │  First×Appt │ —       │ —           │ —      │                 │ │
│  │  ...8 more  │         │             │        │                 │ │
│  │                                                                │ │
│  │  Never run                                  [▶ Run] [✎] [📊]  │ │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Create Eval Set** — drag-and-drop or multi-select:

- Name, Description
- Select Personas (multi-select chips from project's personas)
- Select Scenarios (multi-select chips from project's scenarios)
- Select Evaluators (multi-select chips from project's evaluators)
- **Live matrix preview**: shows NP × NS × NE calculation with total conversations and evaluations
- Variants slider (default: 3) — "More variants = more reliable scores, more LLM cost"

### 3.7 Tab 5: Runs — Heat Map Results

**New Evaluation Run** — same as prototype:

- Select Eval Set (dropdown showing matrix dimensions)
- Optional Run Name, Notes
- Run Summary: "Test conversations: N, Evaluations: N, Matrix: NP × NS × Nvar × NE"
- [Cancel] [▶ Start Run]

**Run Results — Heat Map View (the north star):**

Instead of a table, results show as a **color-coded heat map matrix**:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Run: CardUnblockFlow #3                         2 min ago · 45s    │
│  Status: ✅ Completed · 6 evaluations · Avg: 4.1/5                  │
│                                                                      │
│  HEAT MAP                                                            │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Persona × Scenario     │ EmotionMgmt │ TaskCompletion │ Avg  │ │
│  │  ────────────────────────┼─────────────┼────────────────┼──────│ │
│  │  Frustrated × CardBlock  │  ██ 4.3     │  ██ 4.7        │ 4.5  │ │
│  │  Frustrated × FraudAlert │  ░░ 2.1     │  ██ 4.5        │ 3.3  │ │
│  │  FirstTime × CardBlock   │  ██ 4.8     │  ██ 4.9        │ 4.8  │ │
│  │  FirstTime × FraudAlert  │  ▓▓ 3.5     │  ██ 4.2        │ 3.8  │ │
│  │  ────────────────────────┼─────────────┼────────────────┼──────│ │
│  │  Evaluator Average       │  3.7        │  4.6           │ 4.1  │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  Legend: ██ 4-5 (green)  ▓▓ 3-4 (yellow)  ░░ 1-3 (red)            │
│                                                                      │
│  🔴 Worst cell: Frustrated × FraudAlert → EmotionMgmt (2.1/5)      │
│     Click to view conversation + judge reasoning                     │
│                                                                      │
│  [Re-run] [Compare with...] [Export] [Fix in Architect →]           │
└─────────────────────────────────────────────────────────────────────┘
```

**Color scale**: Cells use background color from red (1.0) through yellow (3.0) to green (5.0), similar to the existing trace event color system.

**Click a cell** → expands to show:

- Full conversation transcript (Persona ↔ Agent)
- Judge's reasoning (CoT output)
- Score breakdown
- Tool calls and state changes
- **"Fix in Architect →" button**: Opens Architect with the problematic agent pre-selected and the eval context pre-loaded in chat: "The FrustratedCustomer persona scored 2.1/5 on EmotionManagement in the FraudAlert scenario. Here's the conversation: [...]"

**Run History:**

```
┌─────────────────────────────────────────────────────────────────────┐
│  Run History                                                         │
│                                                                      │
│  RUN              │ EVAL SET         │ STATUS │ AVG SCORE │ WHEN    │
│  ─────────────────┼──────────────────┼────────┼───────────┼─────────│
│  #3               │ CardUnblockFlow  │ ✅     │ 4.1/5     │ 2m ago  │
│  #2               │ CardUnblockFlow  │ ✅     │ 3.8/5     │ 1d ago  │
│  #1 (baseline)    │ Full Regression  │ ✅     │ 3.5/5     │ 3d ago  │
│                                                                      │
│  Score trend: 3.5 → 3.8 → 4.1 📈                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Compare Runs** — side-by-side heat maps with delta indicators:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Compare: Run #2 → Run #3                                           │
│                                                                      │
│  Persona × Scenario     │ EmotionMgmt      │ TaskCompletion         │
│  ────────────────────────┼──────────────────┼────────────────────────│
│  Frustrated × CardBlock  │ 3.8 → 4.3 (+0.5)│ 4.5 → 4.7 (+0.2)    │
│  Frustrated × FraudAlert │ 1.8 → 2.1 (+0.3)│ 4.3 → 4.5 (+0.2)    │
│                                                                      │
│  Overall: 3.8 → 4.1 (+0.3) 📈  No regressions detected            │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.8 Evaluation Execution Flow

```
1. User clicks "▶ Start Run" (or "▶ Quick Eval")
2. Resolve matrix: Personas × Scenarios × Variants
3. For each (Persona, Scenario, variant):
   a. Create fresh RuntimeSession targeting scenario.entryAgent
   b. Construct persona LLM prompt from persona config
   c. Generate first message from scenario context (or use initialMessage)
   d. Loop up to maxTurns:
      - Send persona message → agent responds
      - LLM generates next persona message (in character)
      - Break if agent reaches COMPLETE or conversation naturally ends
   e. Record EvalConversationResult with transcript + traces
4. For each conversation × each evaluator:
   a. Send transcript + rubric + expectedOutcome to judge model
   b. If chainOfThought: extract reasoning then score
   c. Record EvalScore
5. Compute aggregates → update EvalRun → emit SSE "done"
6. UI animates heat map cells filling in as scores arrive
```

### 3.9 Backend Requirements

#### New Prisma Models

```prisma
model EvalPersona {
  id                 String   @id @default(cuid())
  projectId          String
  tenantId           String
  name               String
  description        String?
  communicationStyle String?  // Casual, Formal, Technical, Terse, Verbose
  domainKnowledge    String?  // Beginner, Intermediate, Expert
  behaviorTraits     String?  // JSON array of traits
  goals              String?
  constraints        String?
  templateSource     String?  // built-in template or 'ai-generated' or 'custom'
  createdBy          String
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  evalSetPersonas    EvalSetPersona[]
  project            Project  @relation(fields: [projectId], references: [id])
  @@unique([projectId, name])
  @@index([projectId, tenantId])
}

model EvalScenario {
  id              String   @id @default(cuid())
  projectId       String
  tenantId        String
  name            String
  description     String?
  category        String?
  difficulty      String?  // easy, medium, hard
  entryAgent      String?
  initialMessage  String?
  expectedOutcome String?
  maxTurns        Int      @default(10)
  tags            String   @default("[]") // JSON array
  agentPath       String?  // JSON: ordered list of agents this scenario exercises
  createdBy       String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  evalSetScenarios EvalSetScenario[]
  project          Project  @relation(fields: [projectId], references: [id])
  @@unique([projectId, name])
  @@index([projectId, tenantId])
}

model EvalEvaluator {
  id              String   @id @default(cuid())
  projectId       String
  tenantId        String
  name            String
  description     String?
  type            String   @default("llm_judge") // llm_judge, rule_based
  category        String?  // quality, safety, efficiency
  judgeModel      String?
  judgePrompt     String?
  chainOfThought  Boolean  @default(true)
  temperature     Float    @default(0)
  scoringRubric   String?
  scaleType       String?  // "1-5", "1-10", "pass/fail"
  templateSource  String?
  isBuiltIn       Boolean  @default(false)
  createdBy       String
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  evalSetEvaluators EvalSetEvaluator[]
  project           Project  @relation(fields: [projectId], references: [id])
  @@unique([projectId, name])
  @@index([projectId, tenantId])
}

model EvalSet {
  id          String   @id @default(cuid())
  projectId   String
  tenantId    String
  name        String
  description String?
  variants    Int      @default(3)
  createdBy   String
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  personas    EvalSetPersona[]
  scenarios   EvalSetScenario[]
  evaluators  EvalSetEvaluator[]
  runs        EvalRun[]
  project     Project  @relation(fields: [projectId], references: [id])
  @@unique([projectId, name])
  @@index([projectId, tenantId])
}

model EvalSetPersona {
  id         String      @id @default(cuid())
  evalSetId  String
  personaId  String
  evalSet    EvalSet     @relation(fields: [evalSetId], references: [id], onDelete: Cascade)
  persona    EvalPersona @relation(fields: [personaId], references: [id], onDelete: Cascade)
  @@unique([evalSetId, personaId])
}

model EvalSetScenario {
  id          String       @id @default(cuid())
  evalSetId   String
  scenarioId  String
  evalSet     EvalSet      @relation(fields: [evalSetId], references: [id], onDelete: Cascade)
  scenario    EvalScenario @relation(fields: [scenarioId], references: [id], onDelete: Cascade)
  @@unique([evalSetId, scenarioId])
}

model EvalSetEvaluator {
  id           String        @id @default(cuid())
  evalSetId    String
  evaluatorId  String
  evalSet      EvalSet       @relation(fields: [evalSetId], references: [id], onDelete: Cascade)
  evaluator    EvalEvaluator @relation(fields: [evaluatorId], references: [id], onDelete: Cascade)
  @@unique([evalSetId, evaluatorId])
}

model EvalRun {
  id           String    @id @default(cuid())
  evalSetId    String
  tenantId     String
  projectId    String
  name         String?
  notes        String?
  triggeredBy  String
  status       String    @default("pending")
  agentVersion Int?
  deploymentId String?
  summary      String?   // JSON: { totalConversations, totalEvaluations, avgScores, duration_ms }
  startedAt    DateTime?
  completedAt  DateTime?
  createdAt    DateTime  @default(now())

  evalSet      EvalSet   @relation(fields: [evalSetId], references: [id], onDelete: Cascade)
  results      EvalConversationResult[]
  @@index([evalSetId, createdAt])
  @@index([projectId, tenantId])
}

model EvalConversationResult {
  id            String    @id @default(cuid())
  runId         String
  personaId     String
  scenarioId    String
  variantIndex  Int
  conversation  String    // JSON: full transcript
  traceEvents   String    @default("[]")
  toolCalls     String    @default("[]")
  stateSnapshot String?
  turnCount     Int?
  durationMs    Int?
  tokenUsage    String?
  errorMessage  String?
  createdAt     DateTime  @default(now())

  run           EvalRun   @relation(fields: [runId], references: [id], onDelete: Cascade)
  scores        EvalScore[]
  @@index([runId])
}

model EvalScore {
  id                     String                  @id @default(cuid())
  conversationResultId   String
  evaluatorId            String
  score                  Float?
  reasoning              String?
  rawResponse            String?
  passed                 Boolean?
  durationMs             Int?
  errorMessage           String?
  createdAt              DateTime                @default(now())

  conversationResult     EvalConversationResult  @relation(fields: [conversationResultId], references: [id], onDelete: Cascade)
  @@index([conversationResultId])
  @@index([evaluatorId])
}
```

#### API Routes

**Personas:** GET/POST `/api/projects/:projectId/evals/personas`, GET/PUT/DELETE `.../:id`, GET `.../templates`
**Scenarios:** GET/POST `/api/projects/:projectId/evals/scenarios`, GET/PUT/DELETE `.../:id`
**Evaluators:** GET/POST `/api/projects/:projectId/evals/evaluators`, GET/PUT/DELETE `.../:id`, GET `.../templates`
**Eval Sets:** GET/POST `/api/projects/:projectId/evals/sets`, GET/PUT/DELETE `.../:id`
**Runs:** GET/POST `/api/projects/:projectId/evals/runs`, GET `.../:id`, POST `.../:id/cancel`, GET `.../compare?baseline=X&current=Y`

**AI Generation:**
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/projects/:projectId/evals/generate/personas` | POST | AI-generate personas from agent analysis |
| `POST /api/projects/:projectId/evals/generate/scenarios` | POST | AI-generate scenarios from flow/handoff analysis |
| `POST /api/projects/:projectId/evals/quick` | POST | One-click: create eval set + run immediately |
| `GET /api/projects/:projectId/evals/coverage` | GET | Coverage analysis: which paths are tested |

---

## Cross-Cutting: The Connected Journey

### Copilot → Architect → Evals Loop

The three modules are not silos. They form a continuous improvement loop:

```
                ┌──────────┐
          ┌────▶│  Copilot  │─────┐
          │     │  Create   │     │
          │     └──────────┘     │
          │                       ▼
   ┌──────────┐           ┌──────────┐
   │  Evals   │◀─────────│ Architect │
   │  Measure  │           │  Improve  │
   └──────────┘           └──────────┘
          │                       ▲
          └───────────────────────┘
           "Fix in Architect →"
```

**Concrete connection points:**

1. **Copilot → Architect**: After project creation, the Architect opens with the same topology canvas. No context is lost.

2. **Architect → Evals**: When an agent is modified in Architect, the system suggests: "You changed CardAgent. Run the CardUnblockFlow eval set to verify?" (toast notification with action button)

3. **Evals → Architect**: Every eval score cell has a "Fix in Architect →" button that opens Architect with:
   - The failing agent pre-selected
   - The conversation transcript pre-loaded
   - The AI pre-prompted: "The FrustratedCustomer persona scored 2.1/5 on EmotionManagement. Analyze this conversation and suggest improvements."

4. **Evals → Copilot**: If multiple evaluators consistently fail across agents, suggest: "Consider restructuring. Open Copilot to redesign the agent topology?"

### Navigation Updates

```
Current sidebar:          New sidebar:
  Agents                    Agents
  Sessions                  Sessions
  Deployments               Deployments
  Contacts                  Architect    ← NEW (with topology icon)
  Workflows                 Evals        ← NEW (with chart icon)
  Observability             Contacts
  Settings                  Workflows
                            Observability
                            Settings
```

### Permissions

| Role        | Copilot         | Architect                         | Evals                                 |
| ----------- | --------------- | --------------------------------- | ------------------------------------- |
| Viewer      | —               | View topology, browse context     | View results, view personas/scenarios |
| Operator    | Create projects | Chat, propose changes (not apply) | Create personas/scenarios, run evals  |
| Admin/Owner | Full access     | Full access (apply changes)       | Full CRUD, delete runs                |

### Shared Components (from existing codebase)

| Component                   | Used By                                   | Notes                           |
| --------------------------- | ----------------------------------------- | ------------------------------- |
| `AgentFlowGraph` + Dagre    | Copilot canvas, Architect canvas          | Extend for interactive nodes    |
| `StateMachineView`          | Architect Debug tab                       | Session flow replay             |
| `ChatPanel` + `MessageList` | Copilot Step 3, Architect chat            | Reuse with topology annotations |
| `ABLEditor` / Monaco        | Copilot Step 4, Architect General         | Code preview + editing          |
| `DiffViewer`                | Architect Modify modal                    | Change visualization            |
| `EventTimeline`             | Architect Debug, Eval conversation detail | Trace events                    |
| `ConstraintMonitor`         | Architect Health Check                    | Constraint status               |
| Framer Motion               | All modules                               | Node animations, transitions    |
| `react-resizable-panels`    | All modules                               | Split pane layouts              |

---

## Implementation Phases

### Phase 1 — Canvas Foundation (2 sprints)

- Extend `AgentFlowGraph` into reusable interactive topology component with:
  - Clickable nodes, hoverable edges, zoom/pan/fit
  - Framer Motion enter/exit animations
  - Multiple overlay modes (default, health, debug)
- Architect: General tab with topology + context panel + basic chat
- Evals: Prisma schema migration + Personas/Scenarios CRUD + basic UI

### Phase 2 — Copilot + Architect Core (3 sprints)

- Copilot: Steps 1-3 with live canvas (topology diffs from streaming API)
- Copilot: Step 4 (Review) with interactive topology + agent detail slide-over
- Architect: Modify tab with diff modal + DSL validation + Accept/Reject
- Evals: Evaluators CRUD + Eval Sets visual matrix builder

### Phase 3 — Eval Engine + AI Generation (2 sprints)

- Eval Runner service: persona simulation + LLM judge scoring
- Eval: Run execution with SSE progress + heat map results view
- Evals: AI auto-generation of personas + scenarios from agent analysis
- Evals: Quick Eval one-click workflow

### Phase 4 — Polish + Connected Journey (2 sprints)

- Copilot: Document upload with insight extraction + canvas enrichment
- Copilot: Step 5 with animated node generation
- Architect: Debug tab with session flow replay on topology
- Architect: Health Check tab with visual diagnostic overlay
- Cross-module links: "Fix in Architect", post-modify eval suggestions
- Run comparison with delta heat map

### Phase 5 — Advanced (1 sprint)

- Copilot: "From Template" with domain starter packs
- Evals: Coverage analysis ("85% of paths tested")
- Evals: Score trend charts across runs
- Architect: A2A remote agent visualization
- All: Proactive seeding ("never empty" experience)

---

## Open Questions

1. **Canvas performance**: With 20+ agents, Dagre layout + Framer Motion animations may lag. Should we set a threshold (e.g., >15 nodes) where animations are simplified?
2. **Eval cost estimation**: Before running, should we show estimated LLM cost? (conversations × turns × tokens + judge calls). Useful for preventing accidental expensive runs.
3. **Persona simulation model**: Should persona simulation use a different model from the agent's model to avoid self-reinforcing biases? Recommend using a different model family.
4. **Architect conversation persistence**: Per-user per-project? Scoped to session? Persistent conversations allow building context over time but consume storage.
5. **Eval scheduling**: Should we support scheduled/recurring runs (e.g., nightly regression after each deploy)?
6. **Offline/cached topology**: Should the topology cache in the browser so the canvas renders instantly on page load, then hydrates with live data?
