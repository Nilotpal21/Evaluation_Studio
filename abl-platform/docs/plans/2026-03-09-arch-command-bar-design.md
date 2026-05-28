# Arch Command Bar — Design Document

**Date:** 2026-03-09
**Branch:** feature/aiassistedjourney
**Status:** Approved
**Wireframes:** [docs/plans/wireframes/arch-command-bar-wireframes.html](wireframes/arch-command-bar-wireframes.html)

## Summary

A persistent, compact command bar at the bottom of every page that combines smart search + mini Arch AI chat with page-aware context. Two distinct journeys: home (project creation) and in-project (operating/debugging). The bar serves as the primary surface for quick interactions while the full Arch AI view (left nav menu item) handles complex multi-artifact flows.

## Goals

1. Reduce navigation friction — find any entity or page in 2 keystrokes
2. Surface Arch AI capabilities contextually — users discover what's possible on each page
3. Keep users in flow — simple questions answered inline, heavy work redirected to full view
4. Teach the product — rotating hints double as capability discovery

## Non-Goals

- Replace the full Arch AI chat page (that stays as the left nav menu item)
- Vector-based FAQ/embeddings (future addition, not v1)
- Server-side search index (client-side fuzzy search is sufficient for v1)

---

## Architecture

### Three Layers

**Layer 1 — Instant Search (zero latency)**
Client-side fuzzy search across project entities. Data sourced from existing Zustand stores + lightweight SWR fetches. No server calls on keystroke.

Searchable entities:

- Agents (name, description)
- Tools (name, type, description)
- Sessions (ID, agent name, status) — recent 50
- Workflows (name)
- Knowledge Bases (name)
- Evals (set name)
- Pages/Menus (static list from navigation-store)
- ABL Sections (from agentDetailStore when on agent page)
- Keyboard Shortcuts (static registry)

Matching: Fuzzy match via lightweight lib (fuse.js or custom). Weighted: entity name (high), description (medium), type (low). Grouped by category, max 3 per group. Recent items boosted.

**Layer 2 — Context-Aware Quick Actions (three tiers)**

Tier 1 — Prefetched on page load (instant):

- Agent detail: `/api/abl/diagnostics` -> if errors, show "Fix N compile errors"
- Sessions: `/api/runtime/analytics?endpoint=anomalies&timeRange=24h` -> show anomaly count
- Analytics: quality endpoint -> show quality delta per agent
- Cache in command bar store, refresh on page navigation

Tier 2 — On-demand via Arch AI (LLM-powered):

- `suggest_improvements`, `explain_dsl`, trace analysis
- Quick action button pre-fills and auto-sends to Arch chat
- Response streams inline in mini bar

Tier 3 — Static (hardcoded):

- Navigation shortcuts ("Jump to Guardrails Config")
- Keyboard shortcuts reference
- Tool page actions (until tool diagnostics API exists)

**Layer 3 — Mini Arch AI Chat (LLM-powered)**
Streams responses from existing `/api/arch-ai/chat` route. Injects ArchContext (page, projectId, agentName, sessionId, current section) automatically. Smart routing determines inline vs redirect.

---

## UI States

### Collapsed (Resting)

- Fixed bottom of content area, full width with 16px margin
- 44px height, pill-shaped (border-radius: 22px)
- Arch logo + rotating placeholder text + context badge (if on entity) + Cmd+K badge
- Click or Cmd+K to expand
- Hover shows accent border glow

### Focused (Search + Quick Actions)

- Expands upward from collapsed position, max-height 60vh
- Search input at top with context badge
- Quick actions section (page-aware, Tier 1-3)
- Search results (grouped by entity type, live-filtered)
- Footer with keyboard shortcut hints
- Backdrop: subtle shadow, no blur on page content

### Active Chat

- Same container as focused, switches to chat layout
- Header: Arch logo + "Arch AI" title + context badge + expand/close buttons
- Message area: scrollable, user + arch messages
- Compact artifact cards for simple outputs (diffs, compile results)
- Redirect banner for heavy flows
- Input area: text input + send button
- Rolling buffer: last 5 exchanges preserved across page navigation

---

## Smart Routing Rules

| Action                        | Render Location | Reason                              |
| ----------------------------- | --------------- | ----------------------------------- |
| explain, suggest improvements | Mini bar        | Text-only response                  |
| compile, test agent           | Mini bar        | Short result card                   |
| read agent DSL                | Mini bar        | Collapsible code block              |
| query traces                  | Mini bar        | Summary + "View full" link          |
| modify agent (dry-run diff)   | Mini bar        | Compact diff card with Apply/Reject |
| generate topology             | Full chat       | Needs topology canvas               |
| generate agents (multi)       | Full chat       | Multi-artifact flow                 |
| create project                | Full chat       | Multi-step wizard                   |
| analytics (charts)            | Full chat       | Needs visualization space           |
| deployment ops                | Full chat       | Confirmation-heavy                  |

Detection: Based on which Arch AI tool is invoked in the streaming response. The `generate_topology`, `generate_agents`, `create_project`, and `deployment_ops` (deploy/promote) tools trigger redirect.

---

## Rotating Placeholder Phrases

### Two Journey Sets

**Home / Project Creation (15 phrases)**
Tone: Inspirational, use-case driven, action verbs

1. Build a customer support bot
2. Design a multi-agent workflow
3. Create an AI sales assistant
4. Automate your returns process
5. Search your existing projects
6. Start from a template
7. Describe your use case
8. Build an onboarding agent
9. Create a knowledge base assistant
10. Design an appointment scheduler
11. Automate order tracking
12. Build a feedback collection bot
13. Create a lead qualification agent
14. Design an internal helpdesk
15. What problem are you solving?

**In-Project Generic (15 phrases)**
Tone: Operational, capability driven, debugging verbs

1. Search agents, tools, sessions...
2. Explain how this agent works
3. Find recent failed sessions
4. Jump to any page or setting
5. Suggest improvements for an agent
6. Run a quick test conversation
7. Check deployment status
8. Query traces from the last hour
9. Which tools does this agent use?
10. Compile and validate all agents
11. Analyze session quality trends
12. Add error handling to a flow
13. Search the knowledge base
14. Show keyboard shortcuts
15. What changed since last deploy?

### Page-Specific Overrides (first 5 swap)

**Agent Detail:**

1. Explain {agent}'s flow
2. Suggest improvements for this agent
3. Add error handling to lifecycle
4. What tools does {agent} use?
5. Run a test conversation

**Session Detail:**

1. Why did this session fail?
2. Show trace events
3. Explain the agent's decisions
4. What constraints were triggered?
5. Replay with different input

**Deployments:**

1. Deploy all agents to staging
2. Promote to production
3. Configure a Slack channel
4. Compare staging vs production
5. Rollback last deployment

**Tools:**

1. Test {tool} with sample input
2. Create a new HTTP tool
3. Which agents use this tool?
4. Check tool latency stats
5. Add authentication headers

**Analytics:**

1. Show quality scores for today
2. Which agent has most errors?
3. Detect anomalies in last 7 days
4. Top user intents this week
5. Compare agent performance

**Knowledge Bases:**

1. Search across all documents
2. Add a new document
3. Check ingestion status
4. How many chunks indexed?
5. Test a retrieval query

### Phrase Selection Logic

1. Detect journey: `projectId ? 'in-project' : 'home'`
2. Load base phrase set (15 phrases)
3. If in-project and on entity page, swap first 5 with page-specific overrides
4. Inject `{agentName}` / `{toolName}` into templates from navigation store
5. Cycle at 3.5s per phrase, smooth vertical slide transition

---

## State Management

```
archCommandBarStore (new Zustand store):
  // UI state
  isOpen: boolean
  mode: 'collapsed' | 'search' | 'chat'
  searchQuery: string

  // Search
  searchResults: SearchResult[]          // computed from stores + SWR cache
  searchIndex: SearchIndex | null        // built on mount, refreshed on data change

  // Quick actions
  quickActions: QuickAction[]            // computed from page context + diagnostics
  diagnosticCache: Record<string, any>   // prefetched diagnostics per page

  // Chat
  chatBuffer: ArchMessage[] (max 5)      // rolling conversation
  isStreaming: boolean
  pendingRedirect: { tool: string, message: string } | null

  // Actions
  open(): void
  close(): void
  setMode(mode): void
  search(query: string): void
  sendMessage(content: string): void
  transferToFullChat(): void
  clearBuffer(): void
```

### Integration Points

- **Reads:** navigationStore, projectStore, archStore, agentDetailStore, sessionStore
- **Writes:** archAIStore.setPrefill() when transferring to full chat
- **Calls:** `/api/arch-ai/chat` with ArchContext injected
- **Prefetch:** `/api/abl/diagnostics`, `/api/runtime/analytics` on page mount

---

## Conversation Buffer (Hybrid Model)

- Mini bar maintains rolling buffer of last 5 exchanges
- Buffer preserved across page navigation (context badge updates, buffer stays)
- On expand to full view: buffer transferred to full chat via archAIStore.setPrefill()
- After transfer: mini bar buffer clears
- On Esc: bar collapses, buffer preserved
- Buffer is ephemeral (lost on browser refresh — acceptable for v1)

---

## Keyboard Shortcuts

| Shortcut    | Action                                     |
| ----------- | ------------------------------------------ |
| Cmd+K       | Open / focus command bar                   |
| Esc         | Close to collapsed (preserves chat buffer) |
| Up/Down     | Navigate search results / quick actions    |
| Enter       | Select result / send message               |
| Tab         | Switch from search to "Ask Arch" mode      |
| Cmd+Shift+K | Open full Arch AI view directly            |

---

## Available Diagnostic APIs (for dynamic quick actions)

| Page            | API                                               | Returns                                        |
| --------------- | ------------------------------------------------- | ---------------------------------------------- |
| Agent Detail    | `POST /api/abl/analysis` (explain, suggest, test) | Diagnostics, missing constraints, unused tools |
| Agent Detail    | `POST /api/abl/diagnostics`                       | Parse/compile errors with line numbers         |
| Sessions        | `GET /api/runtime/sessions/:id/traces`            | Trace events                                   |
| Sessions        | `/api/runtime/analytics?endpoint=anomalies`       | Anomaly detection                              |
| Analytics       | `/api/runtime/analytics?endpoint=quality`         | Quality scores per agent                       |
| Analytics       | `/api/runtime/analytics?endpoint=intents`         | Intent distribution                            |
| Analytics       | `/api/runtime/analytics?endpoint=aggregate`       | Metrics by time range                          |
| Deployments     | `deployment_ops.list`                             | Deployment status + channels                   |
| Knowledge Bases | `knowledge_ops.list` + `query`                    | KB count, doc count                            |
| Evals           | `POST /api/projects/:id/evals/quick`              | Auto-generated personas + scenarios            |

### Gaps (static fallback for v1)

- Tools page: no diagnostic/health API
- Topology: modify is stubbed (NOT_IMPLEMENTED)
- Deployments: no staging vs production diff
- Sessions: no "failure reason" summary (traces + LLM interpretation needed)

---

## Component Structure

```
components/
  arch-command-bar/
    ArchCommandBar.tsx          — Root component, state machine
    CommandBarCollapsed.tsx      — Resting pill with rotating text
    CommandBarFocused.tsx        — Search + quick actions panel
    CommandBarChat.tsx           — Mini chat with streaming
    SearchResults.tsx            — Grouped, highlighted results
    QuickActions.tsx             — Page-aware action list
    ArtifactCard.tsx             — Compact diff/result cards
    RedirectBanner.tsx           — Smart route redirect CTA
    RotatingPlaceholder.tsx      — Animated phrase cycler
    useSearchIndex.ts            — Client-side fuzzy search hook
    useQuickActions.ts           — Page-aware action computation
    useDiagnosticPrefetch.ts    — Prefetch diagnostics on page mount
    constants.ts                — Phrase sets, shortcut registry, route rules
```

---

## Mobile Considerations

- Sidebar hidden, bar takes full width with 12px margins
- Cmd+K badge hidden (no keyboard on mobile)
- Shorter rotating phrases (truncated variants)
- Max chat height: 340px (vs 420px desktop)
- Touch: tap to open (no hover state)
