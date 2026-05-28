# Arch AI UX V2 — Design Document

**Date:** 2026-03-10
**Feature:** Arch AI chat + artifact panel UX overhaul for general users
**Branch:** feature/aiassistedjourney
**Status:** Design complete
**Approach:** Parallel v2 components — zero changes to existing v1

---

## 1. Problem Statement

The current Arch AI chat experience has 7 UX gaps that make it hard for non-technical users to understand what's being built:

1. **Questions disappear** — only "Answered: E-commerce" chips remain, question text is lost
2. **Connections use IDs** — `supervisor_001 -> agent_002` instead of real agent names
3. **Topology is text-only** — flat list, no visual graph
4. **Agent code is plain `<pre>`** — no Monaco, no syntax highlighting worthy of a demo
5. **Empty tabs clutter** — API/Mocks tabs visible even when no data
6. **No auto-tab-switch** — stays on Topology while agents generate
7. **No visual flow** — chat feels like plain text, not an AI building something

---

## 2. Architecture: Parallel V2

```
V1 (untouched):                         V2 (new):
─────────────────                        ──────────────────
ArchAIChatPanel.tsx                      ArchChatPanelV2.tsx
ArtifactPanel.tsx                        ArtifactPanelV2.tsx
  ArtifactTopologyTab.tsx                  TopologyGraphTab.tsx
  ArtifactAgentsTab.tsx                    AgentCodeTab.tsx
ChatPage.tsx                             ChatPageV2.tsx
ProjectArchAIPage.tsx                    ProjectArchAIPageV2.tsx
```

**Switch mechanism:**

```typescript
// store or feature flag
const ARCH_V2 = true;

// AppShell: one-line swap for each page
case 'arch-ai':
  return ARCH_V2 ? <ProjectArchAIPageV2 /> : <ProjectArchAIPage />;
```

**Shared (no duplication):**

- `/api/arch-ai/chat` route
- All tool executors (guards, context, 8 tools)
- `arch-ai-store.ts`, ask-user renderers
- Existing `ProjectCanvas`, `AgentNode`, `ABLEditor` — imported by v2

---

## 3. Chat Panel V2 — Conversation History

### 3.1 Question + Answer Cards

Current: Question text lost, only `Answered: E-commerce` chip.

V2: Show complete Q&A as a cohesive card:

```
┌──────────────────────────────────────────────────┐
│  Q: What kind of customer service?               │
│                                                  │
│  ● E-commerce                            [chip]  │
│    Returns, orders, shipping                     │
└──────────────────────────────────────────────────┘
```

Implementation: When `ask_user` tool result is rendered, show:

1. The question text (from `input.question`)
2. The selected answer(s) as styled chips
3. Collapsed by default after answered, expandable on click

### 3.2 Conversation Flow Indicators

Between Q&A blocks, show subtle progress markers:

```
User: "Build a customer service bot"

  Q: What domain?
  ● E-commerce

  Q: What use cases?
  ● Order tracking  ● Returns  ● Complaints

  Q: What channels?
  ● Web Chat  ● Email

  Q: What tone?
  ● Friendly & Conversational

──── Generating architecture ────────────────

  [Topology card: 6 agents, 12 connections]

──── Generating agent code ──────────────────

  [Agents card: 5/6 valid]

Arch: "Your project is ready!"
```

### 3.3 Message Deduplication

Current issue: LLM text repeats "I'll help you build..." before every ask_user.
V2: Strip duplicate prefix text when it matches the previous assistant message.

---

## 4. Artifact Panel V2

### 4.1 Smart Tab Bar

Only show tabs that have data:

| State                   | Visible Tabs                                |
| ----------------------- | ------------------------------------------- |
| Initial (no generation) | None — panel hidden                         |
| After topology          | `Topology`                                  |
| During agent generation | `Topology` `Agents` (auto-switch to Agents) |
| After agents complete   | `Topology` `Agents`                         |
| After create project    | `Topology` `Agents` + `Open Project` button |

API and Mocks tabs removed from v2. They add noise and rarely contain useful preview data.

### 4.2 Topology Tab — Visual Graph

Replace text list with the existing `ProjectCanvas` (XyFlow):

```
┌─────────────────────────────────────────────┐
│  [Topology]  [Agents]                       │
├─────────────────────────────────────────────┤
│                                             │
│        ┌─────────────────┐                  │
│        │  🤖 Supervisor   │                  │
│        │  Customer Svc    │                  │
│        └──┬──┬──┬──┬──┬──┘                  │
│           │  │  │  │  │                     │
│     ┌─────┘  │  │  │  └─────┐              │
│     ▼        ▼  ▼  ▼        ▼              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐      │
│  │Order │ │Return│ │Compl.│ │Acct. │      │
│  │Track │ │Refund│ │Escal.│ │Login │      │
│  └──────┘ └──────┘ └──────┘ └──────┘      │
│           ↘     ↗                          │
│        ┌──────────┐                        │
│        │  Human   │                        │
│        │ Escalate │                        │
│        └──────────┘                        │
│                                             │
│  6 agents  ·  12 connections  ·  escalation │
├─────────────────────────────────────────────┤
│                    [Create Project]          │
└─────────────────────────────────────────────┘
```

Implementation:

- Reuse `ProjectCanvas` in read-only mode (no drag-to-connect, no editing)
- Map topology nodes/edges to XyFlow format using existing `transform.ts`
- Use existing `AgentNode` component (shows name, type, tool count)
- Auto-fit view after nodes load
- Background: dots pattern (matches existing canvas)

**Agent names in connections:** The `transform.ts` already maps `node.id` → `node.name`. The issue is the topology generator returns `supervisor_001` as IDs. Fix: use `node.name` (e.g., "Customer_Service_Supervisor") as both ID and label.

### 4.3 Agents Tab — Monaco Editor

Replace `<pre>` code block with read-only Monaco editor:

```
┌─────────────────────────────────────────────┐
│  [Topology]  [Agents]                       │
├─────────────────────────────────────────────┤
│  ┌─ Customer_Service_Supervisor ──────────┐ │
│  │  ✅ valid  ·  reasoning  ·  3 tools    │ │
│  └────────────────────────────────────────┘ │
│  ┌─ Order_Tracking_Agent ─────── [▶ open] ┐ │
│  │  ✅ valid  ·  reasoning  ·  4 tools    │ │
│  │                                        │ │
│  │  AGENT: Order_Tracking_Agent           │ │
│  │  MODE: reasoning                       │ │
│  │                                        │ │
│  │  PERSONA: |                            │ │
│  │    You are a friendly...               │ │
│  │                                        │ │
│  │  GOAL: "Help customers track..."       │ │
│  │  ...                                   │ │
│  └────────────────────────────────────────┘ │
│  ┌─ Returns_And_Refunds_Agent ────────────┐ │
│  │  ✅ valid  ·  reasoning  ·  5 tools    │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

Implementation:

- Accordion list of agents with status badges
- Click to expand → shows read-only Monaco editor with ABL syntax highlighting
- Reuse existing `ABLEditor` in read-only mode (set `readOnly: true`)
- Dark theme (matches existing agent editor page)
- Auto-expand first agent
- Progress: show spinner next to agent name while generating, checkmark when done

### 4.4 Auto-Tab Behavior

| Event                         | Action                                   |
| ----------------------------- | ---------------------------------------- |
| `generate_topology` starts    | Show panel, switch to Topology tab       |
| `generate_topology` completes | Stay on Topology, show graph             |
| `generate_agents` starts      | Switch to Agents tab                     |
| Agent generated (each)        | Update agent card: spinner → checkmark   |
| `generate_agents` completes   | Stay on Agents tab, show summary         |
| `create_project` completes    | Show "Open Project" button in action bar |

---

## 5. Topology Generator Fix — Real Names

The topology tool currently generates IDs like `supervisor_001`, `agent_002`. Fix in the `generate_topology` tool response mapping:

```typescript
// In generate-topology.ts result mapping:
// Use node.name (e.g., "Customer_Service_Supervisor") as the ID
// instead of the generated numeric ID
nodes: topology.nodes.map(n => ({
  id: n.name,  // was: n.id (numeric)
  name: n.name,
  ...
}))
```

And in edges:

```typescript
edges: topology.edges.map(e => ({
  from: resolveNodeName(e.from, topology.nodes),
  to: resolveNodeName(e.to, topology.nodes),
  ...
}))
```

---

## 6. File Plan

### New files (~8):

```
apps/studio/src/
  components/arch-ai/
    ArchChatPanelV2.tsx         — Chat panel with Q&A history
    ArtifactPanelV2.tsx         — Smart tabs + visual topology + Monaco
    TopologyGraphTab.tsx        — XyFlow canvas (reuses ProjectCanvas)
    AgentCodeTab.tsx            — Monaco accordion (reuses ABLEditor)
    QACard.tsx                  — Question + answer card component
    ConversationDivider.tsx     — Phase separator ("Generating architecture")
  components/chat/
    ChatPageV2.tsx              — Home chat v2 layout
    ProjectArchAIPageV2.tsx     — In-project v2 layout
```

### Modified files (~2):

```
  components/navigation/AppShell.tsx  — Add V2 lazy import + flag switch
  lib/arch-ai/constants.ts           — Add ARCH_V2_ENABLED flag
```

### Zero changes to:

All v1 components, route, tools, guards, store, system prompt.

---

## 7. Implementation Priority

| Task | What                                 | Risk                            |
| ---- | ------------------------------------ | ------------------------------- |
| 1    | `QACard` + `ConversationDivider`     | Low — pure UI                   |
| 2    | `ArchChatPanelV2` with Q&A history   | Medium — message parsing        |
| 3    | `TopologyGraphTab` with XyFlow       | Low — reuses existing canvas    |
| 4    | `AgentCodeTab` with Monaco           | Low — reuses existing ABLEditor |
| 5    | `ArtifactPanelV2` with smart tabs    | Low — state logic               |
| 6    | Fix topology names in generator      | Low — mapping fix               |
| 7    | `ChatPageV2` + `ProjectArchAIPageV2` | Low — layout wrappers           |
| 8    | AppShell flag switch                 | Trivial — one boolean           |

---

## 8. What We Do NOT Build

- Custom XyFlow editor (drag-to-create agents) — reuse existing read-only canvas
- Real-time collaboration — future
- Chat history persistence — future
- Custom Monaco theme — reuse existing ABL theme
- Mocks/API tabs — removed from v2, not useful for demo
