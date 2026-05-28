# Agent Details Redesign — Single Scrollable Page with Arch AI

## Goal

Replace the current 5-tab text-editor-centric Agent Detail view with a single scrollable page of collapsible section cards, each providing a structured editor for one ABL concept. Arch AI is contextually embedded — always aware of the active section, able to edit any section through natural language.

## Architecture

Single scrollable page with 7 collapsible section cards parsed from the agent's compiled IR. Sections auto-hide when empty. Scripted agents show a Flow section with an auto-generated read-only flow graph. Arch AI panel sits on the right edge, contextually wired to whichever section is expanded. DSL editor, Chat, and Versions are persistent header actions (slide-over/overlay), not tabs.

## Key Decisions

| Decision           | Choice                         | Rationale                                                                                         |
| ------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Layout pattern     | Single scrollable page         | Avoids tab overload; shows everything at a glance; progressive disclosure via collapse/expand     |
| Edit interaction   | Inline expand                  | Section expands in place, other sections push down. No navigation change, no modal                |
| Save model         | Auto-save to working copy      | Debounced auto-save on edit. Explicit "Create Version" for snapshots. No per-section save buttons |
| Flow visualization | Read-only auto-generated graph | From compiled IR. Not a drag-and-drop canvas. Click node to scroll to step editor                 |
| AI integration     | Arch contextually embedded     | Arch panel tracks active section, adjusts suggestions, uses surgical edit API                     |

## Competitive Context

Sierra uses "natural language journeys" — no visual flow editor, no code editor. Decagon uses "Agent Operating Procedures" — NL that compiles to code. Both explicitly reject drag-and-drop canvases.

ABL's advantage: a real programming language (typed tools, dual execution modes, constraints, gather, flow, multi-agent coordination). This design makes every ABL concept visually editable through structured forms while keeping the DSL editor as a power-user escape hatch and Arch AI as the natural language interface.

---

## Page Layout

### Header

```
┌──────────────────────────────────────────────────────────────┐
│ ← Agents    [Booking_Agent]  ✏️         [Create Version ▾]  │
│             [Help customers book hotels] ✏️                  │
│             reasoning · Claude 4 Sonnet · v3 active          │
│                                                              │
│                              [Versions]  [DSL]  [Chat]       │
└──────────────────────────────────────────────────────────────┘
```

- Agent name and description: inline-editable (click to edit, blur to save)
- Metadata line: execution mode badge, model name, active version indicator
- Persistent header actions:
  - **[Versions]** — slide-over with version table, promote, diff
  - **[DSL]** — full-viewport Monaco editor overlay (escape hatch)
  - **[Chat]** — slide-over test panel with debug toggle

### Section Card Pattern

**Collapsed (default):**

```
┌─ Section Name (count) ────────────── [✦] [▾] ─┐
│ Compact summary: key facts, badges, preview     │
└─────────────────────────────────────────────────┘
```

**Expanded (on click):**

```
┌─ Section Name (count) ────────────── [✦] [▴] ─┐
│                                                  │
│  [Full inline editor: form fields, tables, etc.] │
│                                                  │
│  Auto-saving...  ✓ Saved                         │
└──────────────────────────────────────────────────┘
```

- `[✦]` opens Arch pre-focused on that section
- `[▾/▴]` toggles expand/collapse
- Empty sections auto-hide (with optional Arch prompt: "No tools defined. [Ask Arch to suggest →]")

---

## Section Inventory

### 1. Identity (always visible)

**Collapsed:** Mode badge, model name, goal text preview, persona first line

**Expanded editor:**

- Goal: textarea
- Persona: rich text / multiline textarea
- Limitations: tag-style list with add/remove
- Mode: dropdown (Reasoning / Scripted)
- Model: dropdown (project models), temperature slider with override toggle, max_tokens input with override toggle
- Messages: collapsible sub-section for configurable platform messages

**ABL sections patched:** AGENT, MODE, GOAL, PERSONA, LIMITATIONS, MESSAGES

### 2. Tools (visible when tools defined)

**Collapsed:** Tool count, tool name chips with binding type badges (HTTP / MCP / Lambda / Sandbox)

**Expanded editor:**

- Card per tool showing: name, description, typed parameters table (name, type, required, default), return type
- Binding config per card: endpoint/method/auth for HTTP, server/tool for MCP, function/runtime for Lambda, entrypoint/timeout for Sandbox
- Tool hints: cacheable, latency, side_effects toggles
- [+ Add Tool] button with two paths: manual form OR "Describe what you need" (routes to Arch)
- Import tools: file picker for .tools.abl shared tool files

**ABL sections patched:** TOOLS

### 3. Gather Fields (visible when gather defined)

**Collapsed:** Field count, field name pills (filled = required, outlined = optional)

**Expanded editor:**

- Table with columns: Field name, Type dropdown (string/number/boolean/date/enum/array), Required toggle, Prompt text, Default value
- Expandable row detail: validation rules, extraction hints, infer toggle, corrections config
- [+ Add Field] inline row
- Drag to reorder fields

**ABL sections patched:** GATHER

### 4. Flow (visible for scripted mode only)

**Collapsed:** Step count + **mini flow graph** (auto-generated from IR)

**Expanded editor:**

- **Read-only flow graph** at top (rendered from IR `flowConfig.steps` + transitions via ReactFlow or similar)
  - Nodes = steps, edges = THEN transitions + ON_INPUT/ON_RESULT branches
  - Click a node to scroll to its step editor below
  - Digressions shown as dashed edges
- **Step list** below graph:
  - Per step: name, prompt/RESPOND text, GATHER (inline field refs), CALL actions, THEN transition dropdown
  - ON_INPUT branches: condition → action pairs
  - ON_RESULT branches: condition → THEN pairs
  - Sub-intents list
  - Step-level digressions
- [+ Add Step] button
- Global digressions section at bottom

**ABL sections patched:** FLOW

### 5. Rules (visible when constraints or guardrails defined)

**Collapsed:** Constraint count + guardrail count

**Expanded editor:**

- **Constraints sub-section:**
  - Per constraint: phase dropdown, condition expression, ON_FAIL action (respond/handoff/escalate/block)
  - [+ Add Constraint]
- **Guardrails sub-section:**
  - Per guardrail: scope (input/output/both), rule text, action (block/warn/redact/escalate), priority number
  - [+ Add Guardrail]

**ABL sections patched:** CONSTRAINTS

### 6. Coordination (visible when handoffs, delegation, or escalation defined)

**Collapsed:** Counts per type with target agent names

**Expanded editor:**

- **Handoffs:** target agent dropdown (from project agents), WHEN condition, context fields, history strategy (none/summary/full/last_N), RETURN toggle + ON_RETURN mapping
- **Delegation:** target agent, INPUT mapping, RETURNS mapping, timeout, ON_FAILURE action
- **Escalation:** priority dropdown (low/medium/high/critical), queue/skill_tags, context template, ON_HUMAN_COMPLETE actions
- [+ Add] button for each type

**ABL sections patched:** HANDOFF, DELEGATE, ESCALATE

### 7. Lifecycle (visible when hooks, completion, or memory defined)

**Collapsed:** Hook count, completion condition preview

**Expanded editor:**

- **ON_START:** ordered action list (greet, set variables, call tools, delegate)
- **ON_ERROR:** per-error-type rows with retry count, delay, then-transition
- **COMPLETE:** when-condition expression, response template, memory store instructions
- **Memory:** session variables list, persistent memory paths, remember triggers with TTL, recall instructions
- **Hooks:** before_agent, after_agent, before_turn, after_turn

**ABL sections patched:** ON_START, ON_ERROR, COMPLETE, MEMORY

---

## Arch AI Integration

### Placement

Arch lives as a persistent right-edge floating pill. Clicking opens the slide-over panel alongside the scrollable page. The panel stays open during section editing.

```
┌─────────────── Page ──────────────┬──── Arch Panel ────┐
│                                   │                     │
│  ┌─ Tools (expanded) ──────┐      │  Context: ✦ Tools  │
│  │ search_hotels   HTTP    │      │                     │
│  │ verify_id       MCP     │      │  "You have 3 tools. │
│  │ [+ Add Tool]            │      │   Want me to add    │
│  └─────────────────────────┘      │   error handling?"  │
│                                   │                     │
│  ┌─ Gather (collapsed) ───┐       │  [Add ON_ERROR]     │
│  │ name ● email ● dates   │       │  [Add retry config] │
│  └─────────────────────────┘      │  [Add a tool]       │
│                                   │                     │
│                                   │  > ____________     │
│                                   │                     │
└───────────────────────────────────┴─────────────────────┘
```

### Context Awareness

Arch tracks which section is expanded via `arch-store.editContext`:

```typescript
interface ArchEditContext {
  section: 'IDENTITY' | 'TOOLS' | 'GATHER' | 'FLOW' | 'RULES' | 'COORDINATION' | 'LIFECYCLE' | null;
  agentId: string;
  currentContent: unknown; // IR data for active section
  siblingContext: {
    // summary of other sections for cross-references
    mode: string;
    goal: string;
    toolNames: string[];
    gatherFieldNames: string[];
    flowStepNames: string[];
  };
}
```

When a section expands, the store updates. Arch's system prompt includes the section context so its suggestions are relevant.

### Per-Section Suggestion Chips

| Active Section | Chips                                                       |
| -------------- | ----------------------------------------------------------- |
| Identity       | "Refine persona", "Add limitations", "Switch to scripted"   |
| Tools          | "Add a tool", "Configure auth", "Add error handling"        |
| Gather         | "Add a field", "Make all required", "Add validation"        |
| Flow           | "Add a step", "Add digression", "Add ON_INPUT handler"      |
| Rules          | "Add guardrail", "Add constraint", "Tighten rules"          |
| Coordination   | "Add handoff", "Configure escalation", "Add delegation"     |
| Lifecycle      | "Add greeting", "Configure memory", "Add error handler"     |
| None (page)    | "Improve this agent", "Review my config", "What's missing?" |

### Arch Actions on Sections

Arch uses the **plan-then-execute** pattern:

1. User asks Arch: "add a cancel_booking tool that calls POST /api/cancel"
2. Arch shows proposal message with structured plan
3. Inline diff preview in the section (using ArchDiffView)
4. User clicks Accept → surgical edit API fires → section re-renders
5. Multi-section proposals supported (e.g., add tool + update flow step + add constraint)

### Arch Entry Points

- **Persistent panel pill** on right edge (always available)
- **Section header [✦] button** — opens Arch pre-focused on that section
- **Empty section prompt** — "No constraints defined. [Ask Arch to suggest rules →]"
- **[+ Add] button alternative** — every "Add Tool", "Add Field" etc. offers "Describe what you need" path to Arch

---

## Data Flow

### Section → DSL Sync

```
User edits section form field
        │
        ▼
Debounce (500ms)
        │
        ▼
Generate ABL section text from form state (section serializer)
        │
        ▼
PATCH /api/projects/:id/agents/:agentId/edit
  body: { edits: [{ section: "TOOLS", content: "..." }] }
        │
        ▼
Server patches working copy DSL, returns full DSL + diff
        │
        ▼
Re-compile IR (compileABLtoIR)
        │
        ▼
Update all section summaries from fresh IR
Update flow graph from fresh IR (if scripted)
Update Arch editContext
Show "✓ Saved" indicator
```

### DSL → Section Sync (initial load + DSL editor changes)

```
Load agent detail page
        │
        ▼
Fetch working copy DSL
        │
        ▼
Compile to IR (compileABLtoIR)
        │
        ▼
Parse IR into section view models:
  - identity: { mode, goal, persona, limitations, model, messages }
  - tools: ToolDefinition[]
  - gather: GatherField[]
  - flow: { steps[], graph: { nodes[], edges[] } }
  - rules: { constraints[], guardrails[] }
  - coordination: { handoffs[], delegations[], escalations[] }
  - lifecycle: { onStart, onError, complete, memory, hooks }
        │
        ▼
Render sections (collapsed by default, hide empty ones)
```

### Section-to-ABL Serializers

Each section needs a serializer that converts form state back to ABL text. These are pure functions:

```
serializeIdentity(identity: IdentityFormState) → string   // AGENT + MODE + GOAL + PERSONA + ...
serializeTools(tools: ToolFormState[]) → string            // TOOLS: block
serializeGather(fields: GatherFieldFormState[]) → string   // GATHER: block
serializeFlow(steps: FlowStepFormState[]) → string         // FLOW: block
serializeRules(rules: RulesFormState) → string             // CONSTRAINTS: block
serializeCoordination(coord: CoordFormState) → string      // HANDOFF + DELEGATE + ESCALATE blocks
serializeLifecycle(lc: LifecycleFormState) → string        // ON_START + ON_ERROR + COMPLETE + MEMORY
```

These are the inverse of the IR parsing — the IR gives us structured data, serializers give us ABL text.

---

## What This Replaces

| Current View                      | New Equivalent                                         |
| --------------------------------- | ------------------------------------------------------ |
| Overview tab (read-only metadata) | Header (inline-editable) + collapsed section summaries |
| DSL Editor tab                    | [DSL] header button → full-viewport overlay            |
| Model tab                         | Folded into Identity section                           |
| Chat tab                          | [Chat] header button → slide-over panel                |
| Versions tab                      | [Versions] header button → slide-over panel            |

## What Reuses Existing Code

| Component                        | Status | Reuse                          |
| -------------------------------- | ------ | ------------------------------ |
| ArchPanel, ArchChat, ArchMessage | Exists | Add editContext wiring         |
| ArchSuggestionChips              | Exists | Add per-section chip sets      |
| ArchDiffView                     | Exists | Reuse for inline section diffs |
| arch-store                       | Exists | Add editContext field          |
| Surgical edit API (`/edit`)      | Exists | Used by all section saves      |
| Monaco editor (DslEditorTab)     | Exists | Moved to overlay, no changes   |
| Chat panel                       | Exists | Moved to slide-over            |
| Version list + promote + diff    | Exists | Moved to slide-over            |
| TopologyCanvas / ReactFlow       | Exists | Reuse for flow mini-graph      |
| compileABLtoIR                   | Exists | Powers IR → section parsing    |

## What's New

| Component                      | Description                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| AgentDetailPage (rewrite)      | Single scrollable page with section cards                                                                      |
| Section card components (7)    | IdentitySection, ToolsSection, GatherSection, FlowSection, RulesSection, CoordinationSection, LifecycleSection |
| Section form editors (7)       | Inline expanded editors for each section                                                                       |
| Section serializers (7)        | Form state → ABL text pure functions                                                                           |
| IR → section view model parser | Compiled IR → structured section data                                                                          |
| Flow mini-graph                | Read-only ReactFlow graph from IR flow config                                                                  |
| agent-detail-store             | Zustand store for section states, expand/collapse, dirty tracking                                              |
| Arch context wiring            | editContext tracking, per-section chips, section [✦] buttons                                                   |

---

## Gap Analysis vs Sierra

| Sierra                                        | ABL Studio (this design)                                    | Gap?                      |
| --------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| Journey editor (NL behavior)                  | Arch AI edits any section via NL + structured forms         | No                        |
| Simulations (AI personas at scale)            | Chat panel with debug                                       | Yes — future              |
| Knowledge (RAG + gap detection)               | Search AI (separate page, already built)                    | No                        |
| Branding & Controls (persona/tone/guardrails) | Identity + Rules sections                                   | No                        |
| Content & Settings (dynamic data)             | Tools section (ABL uses tools for dynamic data)             | N/A                       |
| Workspaces (Git-style branching)              | Version promotion + diff                                    | Partial — no branch/merge |
| Integration Library                           | Tools section with binding config (HTTP/MCP/Lambda/Sandbox) | No                        |
| Side-by-side building + testing               | Arch panel + Chat slide-over simultaneously                 | No                        |
| A/B version testing                           | Not yet                                                     | Yes — future              |

## Out of Scope

- Drag-and-drop flow canvas (explicitly rejected — read-only graph only)
- AI simulation framework (future work, separate design)
- Git-style workspace branching/merging (future work)
- A/B version testing (future work)
- Collaborative real-time editing (future work)
