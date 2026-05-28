# Feature: Quick Actions & Commands

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A (extends Arch AI Assistant interaction model)
**Status**: PLANNED
**Feature Area(s)**: `agent lifecycle`, `project lifecycle`
**Package(s)**: `apps/studio`, `packages/arch-ai`
**Owner(s)**: `Arch AI team`
**Testing Guide**: [../testing/quick-actions-commands.md](../testing/quick-actions-commands.md)
**Last Updated**: 2026-04-06

---

## 1. Introduction / Overview

### Problem Statement

Users type full natural-language sentences for simple, repetitive operations: "Can you compile the billing agent?", "Show me the topology", "What tools does the triage agent have?" Every action flows through LLM processing and specialist routing, adding 5-15 seconds of latency for operations that should be instant. Professional tools (Slack, Claude Code, VS Code, Linear) have instant command layers that bypass AI for common tasks. Arch has none — everything goes through the LLM.

Additionally, when users discuss multiple agents or tools in a single message, the LLM must infer which entities are being referenced from natural language. This is error-prone, especially with similarly named agents. There is no explicit mechanism for users to inject specific entity data into the conversation context.

### Goal Statement

Provide a speed layer of slash commands (`/compile`, `/topology`, `/health`) and explicit data references (`@billing_agent`, `@lookup_order`) that let users perform common operations instantly and inject precise entity context into conversations — reducing latency for routine tasks from seconds to milliseconds, while keeping the full LLM-powered conversation available for complex requests.

### Summary

This feature introduces two interaction accelerators for the Arch chat interface:

1. **Slash Commands (B57.1)**: Type `/` in the chat input to see a filtered, mode-aware command dropdown. Simple commands (navigate, open panel) execute client-side with zero latency. Complex commands (compile, health check) are sent to the backend as a structured `type: 'command'` message that skips LLM-based routing.

2. **@Mentions (B57.2)**: Type `@` to reference project entities inline. `@billing_agent` resolves to the agent's full ABL definition; `@lookup_order` resolves to a tool's schema. Resolved data is attached to the message request as a `mentions` field, injected into the specialist's system prompt as explicit context.

Future phases (B57.3-B57.5: widget quick actions, full entity references, inline autocomplete) are documented in the backlog but excluded from this spec's scope.

---

## 2. Scope

### Goals

- Provide instant execution for 10+ common Arch operations via slash commands
- Enable explicit entity referencing via @agent and @tool mentions
- Reduce latency for routine operations from 5-15s (LLM round-trip) to <100ms (client-side)
- Support both ONBOARDING and IN_PROJECT modes with phase-aware command filtering
- Maintain backward compatibility — natural language input continues to work as before

### Non-Goals (Out of Scope)

- B57.3: Widget quick actions (per-widget action buttons) — depends on B53
- B57.4: Full entity reference system (@trace, @constraint, @spec, @topology, etc.)
- B57.5: Inline autocomplete with fuzzy matching
- B28: Cmd+K command palette integration — slash commands will not appear in the existing CommandPalette.tsx
- Custom/user-defined slash commands
- Admin-facing or operator-facing commands (B57 targets agent designers only)
- Slash command history or frecency-based sorting

---

## 3. User Stories

1. As an **agent designer in BUILD phase**, I want to type `/compile billing_agent` and see instant compile results so that I don't wait for the LLM to interpret "please compile the billing agent."

2. As an **agent designer in IN_PROJECT mode**, I want to type `/health` and see a health check dashboard so that I can quickly assess agent status without explaining what I want.

3. As an **agent designer**, I want to type `@billing_agent` in my message so that the Arch specialist sees the full agent definition without me copy-pasting ABL code.

4. As an **agent designer in INTERVIEW phase**, I want to see only commands relevant to my current phase (e.g., `/help`, `/restart`) so that I'm not overwhelmed by inapplicable commands.

5. As an **agent designer**, I want to type `Can you add a retry tool to @billing_agent and make sure @triage_agent routes failures to it?` so that the specialist has both agents' definitions loaded without me switching context.

6. As an **agent designer**, I want `/ask-architect` to route directly to the Architect specialist so that I skip the coordinator's routing decision when I know which expert I need.

7. As an **agent designer**, I want to type `/` and see a dropdown of available commands filtered by what I'm typing, so that I can discover commands without memorizing them.

---

## 4. Functional Requirements

1. **FR-1**: The system must display a command dropdown when the user types `/` at the start of the chat input, showing all available commands filtered by the current `ArchMode` and `ArchPhase`.

2. **FR-2**: The system must filter the command dropdown in real-time as the user types after `/` (e.g., `/com` shows only `/compile`).

3. **FR-3**: The system must support keyboard navigation in the command dropdown: Arrow Up/Down to select, Enter to execute, Escape to dismiss.

4. **FR-4**: The system must execute frontend-only commands (navigate, open panel) without any network request, completing in <100ms.

5. **FR-5**: The system must send backend-routed commands as `type: 'command'` messages in the `MessageRequest` discriminated union, with structured `command` and `args` fields.

6. **FR-6**: The system must support specialist-direct commands (`/ask-architect`, `/ask-governance`, `/ask-voice`) that route to a named specialist ID (see command-to-specialist mapping in section 7), bypassing the coordinator's content-based routing. The target specialist ID must vary by current `ArchMode`.

7. **FR-7**: The system must parse `@agent_name` and `@tool_name` references in the chat input text before sending the message.

8. **FR-8**: The system must resolve @mentions client-side from Zustand stores (`arch-ai-store.filePanelFiles` for ONBOARDING, project store for IN_PROJECT) and attach resolved data as a `mentions` array field on the `type: 'message'` variant of `MessageRequest`.

9. **FR-9**: The backend must inject resolved mention data into the specialist's system prompt as a `## Referenced Entities` section, placed AFTER the existing `## Current Context` section. The format must be: one `### <type>: <name>` sub-heading per mention, followed by the resolved data (ABL content for agents, tool schema for tools). Maximum injected context: 4000 tokens across all mentions. See concrete format in section 7.

10. **FR-10**: The system must render @mentions as visually distinct styled chips (highlighted text) in both the input field and sent message bubbles.

11. **FR-11**: The command registry must define a `when` predicate per command: `(mode: ArchMode, phase: ArchPhase) => boolean`, and only display commands that pass the predicate.

12. **FR-12**: The system must support at least 10 commands at launch, covering: `/compile`, `/compile all`, `/topology`, `/health`, `/help`, `/history`, `/diff`, `/agent [name]`, `/traces`, `/ask-architect`.

13. **FR-13**: The system must not break existing natural-language input. Messages that do not start with `/` and do not contain `@` references must be sent as `type: 'message'` with no changes.

14. **FR-14**: The `MessageRequestSchema` must be extended with a 6th discriminated union variant: `type: 'command'` with fields `command: string`, `args?: Record<string, unknown>`, and `mentions?: MentionSchema[]`.

15. **FR-15**: The system must display a "no matching commands" state when the user's `/` query matches nothing.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                       |
| -------------------------- | ------------ | ----------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Commands like /export, /history operate on project scope    |
| Agent lifecycle            | PRIMARY      | /compile, /diff, /health, @agent mentions are agent-centric |
| Customer experience        | NONE         | No end-user-facing changes                                  |
| Integrations / channels    | NONE         | Not channel-aware                                           |
| Observability / tracing    | SECONDARY    | /traces command provides quick access to trace viewer       |
| Governance / controls      | SECONDARY    | /ask-governance routes to governance specialist             |
| Enterprise / compliance    | NONE         | No compliance implications                                  |
| Admin / operator workflows | NONE         | Agent designer persona only                                 |

### Related Feature Integration Matrix

| Related Feature                                           | Relationship Type | Why It Matters                                                      | Key Touchpoints                           | Current State |
| --------------------------------------------------------- | ----------------- | ------------------------------------------------------------------- | ----------------------------------------- | ------------- |
| [Arch AI Assistant](arch-ai-assistant.md)                 | extends           | B57 adds a command layer on top of the existing chat interface      | ArchChat, useArchChat, message route      | BETA          |
| [Page Context Awareness](page-context-awareness.md)       | shares data with  | @mentions are "page context made explicit" — same injection pattern | buildPageContext, system prompt injection | ALPHA         |
| [Live Thinking Visibility](live-thinking-visibility.md)   | emits into        | Backend commands trigger activity feed events                       | ActivityEmitter, SSE protocol             | ALPHA         |
| [Agent Development (Studio)](agent-development-studio.md) | depends on        | Compile, topology, agent data are Studio capabilities               | Agent store, compile API, topology store  | STABLE        |

---

## 6. Design Considerations

### Slash Command Dropdown

- **Position**: Fixed panel above the chat input (Slack-style), not cursor-anchored
- **Trigger**: `/` typed at position 0 of the input (or after only whitespace)
- **Filtering**: Real-time fuzzy match as user types after `/`
- **Grouping**: Commands grouped by category (Build, Test, View, Navigate, Specialist, Project)
- **Dismissal**: Escape key, clicking outside, or backspacing past `/`

### @Mention Chips

- **Trigger**: `@` followed by entity name characters
- **Resolution**: Client-side from Zustand stores
- **Display**: Highlighted inline text in the input; styled chip in sent messages
- **Autocomplete**: Deferred to B57.5 — for B57.2, users must type the full entity name

### Wireframe Reference

See `docs/arch/backlogs/B57-quick-actions-commands.md` lines 17-35 (command dropdown) and lines 55-70 (@mention inline).

---

## 7. Technical Considerations

### MessageRequest Schema Extension

```typescript
// New 6th variant added to MessageRequestSchema discriminated union
z.object({
  sessionId: z.string().min(1),
  type: z.literal('command'),
  command: z.string().min(1), // e.g., 'compile', 'health', 'ask-architect'
  args: z.record(z.unknown()).optional(),
  mentions: z.array(MentionSchema).optional(),
});

// MentionSchema (new type)
const MentionSchema = z.object({
  type: z.enum(['agent', 'tool']),
  name: z.string().min(1),
  resolvedData: z.record(z.unknown()).optional(),
});
```

The `mentions` field is also added as optional to the existing `type: 'message'` variant.

### Referenced Entities Prompt Format

When `mentions` are present, the backend builds a `## Referenced Entities` section injected into the specialist system prompt AFTER `## Current Context` (from B02 page context). Format:

````markdown
## Referenced Entities

### Agent: billing_agent

```yaml
AGENT: billing_agent
GOAL: Handle billing inquiries and refund processing
PERSONA: Professional and empathetic billing specialist
TOOLS:
  - lookup_order
  - process_refund
  - check_balance
...
```
````

### Tool: lookup_order

```yaml
name: lookup_order
description: Look up order details by order ID
parameters:
  - name: order_id
    type: string
    required: true
```

````

**Token budget**: Maximum 4000 tokens across all resolved mentions. If total exceeds 4000, truncate the least-recently-mentioned entity's data. This budget is independent of the page context budget.

### Command-to-Specialist Mapping

Specialist-direct commands map to different specialist IDs based on the current `ArchMode`:

| Command            | ONBOARDING Specialist ID   | IN_PROJECT Specialist ID |
| ------------------ | -------------------------- | ------------------------ |
| `/ask-architect`   | `multi-agent-architect`    | `project-architect`      |
| `/ask-governance`  | `governance`               | `quality-engineer`       |
| `/ask-voice`       | `channel-voice`            | `platform-guide`         |

Source: `packages/arch-ai/src/types/constants.ts` — `SPECIALIST_IDS` (lines 12-22) and `IN_PROJECT_SPECIALIST_IDS` (lines 24-30).

**Type note**: `SpecialistId` covers ONBOARDING only. `InProjectSpecialistId` is separate. Command routing must use `AnySpecialistId` (union of both) for mode-dependent dispatch.

### Command-to-Tool Mapping

Backend commands that invoke tools directly (skipping LLM routing) use this in-memory mapping constant:

```typescript
// In packages/arch-ai/src/types/slash-command.ts
const COMMAND_TOOL_MAP: Record<string, { tool: string; defaultArgs?: Record<string, unknown> }> = {
  compile:     { tool: 'compile_abl' },
  'compile-all': { tool: 'compile_abl', defaultArgs: { target: 'all' } },
  health:      { tool: 'health_check' },
  // diff and fix require new tools — see GAP-006
};
````

Not all commands have tool mappings. Navigation commands (`/topology`, `/traces`, `/agent`) execute client-side. Specialist commands (`/ask-*`) route to specialists, not tools.

### Command Registry Architecture

```typescript
interface SlashCommand {
  id: string;
  command: string; // e.g., 'compile'
  label: string; // e.g., '/compile [agent]'
  description: string; // e.g., 'Compile an agent or all agents'
  category: 'build' | 'test' | 'view' | 'navigate' | 'specialist' | 'project';
  execution: 'client' | 'backend' | 'specialist';
  when: (mode: ArchMode, phase: ArchPhase) => boolean;
  handler?: (args: Record<string, unknown>) => void; // client-only commands
  specialistId?: string; // specialist-direct commands
}
```

### Execution Flow

```
User types: "/compile @billing_agent"
    |
Input Parser (client-side)
  |- Detects "/" prefix -> slash command mode
  |- Detects "@billing_agent" -> resolve mention from arch-ai-store
  |- Command = "compile", args = { agent: "billing_agent" }
    |
Command Router (client-side)
  |- "compile" -> execution: 'backend'
  |- Send: { type: 'command', command: 'compile', args, mentions }
    |
Backend (message/route.ts)
  |- case 'command': dispatch to command handler
  |- Skip coordinator LLM routing
  |- Execute compile_abl tool directly
    |
SSE Response
  |- activity events + compile_result widget
```

### Migration Path

No breaking changes. The `type: 'command'` variant is additive to the discriminated union. Existing `type: 'message'` requests are unaffected. The `mentions` field is optional on `type: 'message'`.

---

## 8. How to Consume

### Studio UI

- **Chat input**: Type `/` to open command dropdown; type `@` to reference entities
- **Command dropdown**: Appears above the `ChatInputBar` component when `/` is typed
- **Mention chips**: Rendered inline in input and in sent message bubbles
- **Navigation commands**: `/topology`, `/traces`, `/agent [name]` navigate to corresponding Studio pages

### API (Runtime)

N/A — This feature does not affect the Runtime API. Commands operate within the Studio/Arch context.

### API (Studio)

| Method | Path                   | Purpose                                      |
| ------ | ---------------------- | -------------------------------------------- |
| POST   | `/api/arch-ai/message` | Extended to accept `type: 'command'` variant |

Command discovery is entirely client-side — no new API endpoint needed. The command registry is a static TypeScript constant shipped with the Studio bundle.

### Admin Portal

N/A — Agent designer feature only.

### Channel / SDK / Voice / A2A / MCP Integration

N/A — This feature is Studio-only and not channel-aware.

---

## 9. Data Model

### Collections / Tables

No new collections. The feature uses existing data:

- **Session metadata** (`arch_sessions` collection): Contains agent files, topology, and tools — used for @mention resolution in IN_PROJECT mode.
- **In-memory stores**: `arch-ai-store.filePanelFiles` holds agent files during ONBOARDING — used for @mention resolution.

### Key Relationships

- **Mention resolution**: @agent_name maps to `filePanelFiles[agentName]` (ONBOARDING) or project agent store (IN_PROJECT)
- **Mention resolution**: @tool_name maps to TOOLS section within agent ABL YAML content
- **Command dispatch**: `type: 'command'` messages map to tool invocations via a server-side command-to-tool mapping

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                            | Purpose                                             |
| ----------------------------------------------- | --------------------------------------------------- |
| `packages/arch-ai/src/types/message-request.ts` | Add `type: 'command'` variant + MentionSchema       |
| `packages/arch-ai/src/types/mention.ts`         | New file: MentionSchema Zod type definition         |
| `packages/arch-ai/src/types/slash-command.ts`   | New file: SlashCommand interface + command registry |

### Routes / Handlers

| File                                               | Purpose                              |
| -------------------------------------------------- | ------------------------------------ |
| `apps/studio/src/app/api/arch-ai/message/route.ts` | Add `case 'command':` handler branch |

### UI Components

| File                                                       | Purpose                                             |
| ---------------------------------------------------------- | --------------------------------------------------- |
| `apps/studio/src/components/arch/SlashCommandDropdown.tsx` | New: command dropdown above chat input              |
| `apps/studio/src/components/arch/MentionChip.tsx`          | New: styled inline mention chip                     |
| `apps/studio/src/components/chat/ChatInputBar.tsx`         | Modified: integrate slash command + mention parsing |
| `apps/studio/src/hooks/useSlashCommands.ts`                | New: command registry, filtering, keyboard nav      |
| `apps/studio/src/hooks/useMentionResolver.ts`              | New: resolve @mentions from stores                  |
| `apps/studio/src/hooks/useArchChat.ts`                     | Modified: parse commands/mentions before send       |

### Jobs / Workers / Background Processes

N/A — No background processing needed.

### Tests

| File                                                       | Type        | Coverage Focus                               |
| ---------------------------------------------------------- | ----------- | -------------------------------------------- |
| `packages/arch-ai/src/__tests__/slash-command.test.ts`     | unit        | Command registry, filtering, when predicates |
| `packages/arch-ai/src/__tests__/mention-resolver.test.ts`  | unit        | @mention parsing and resolution              |
| `apps/studio/src/__tests__/arch-ai/slash-commands.test.ts` | integration | Command execution flow, SSE responses        |

---

## 11. Configuration

### Environment Variables

No new environment variables required. The feature uses existing Arch AI configuration.

### Runtime Configuration

| Setting            | Default | Description                                         |
| ------------------ | ------- | --------------------------------------------------- |
| Feature flag: none | N/A     | No feature flag — slash commands are always enabled |

Slash commands are a UX layer on top of existing capabilities. No toggle needed — they don't change behavior, only access patterns.

### DSL / Agent IR / Schema

N/A — No DSL or IR changes.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every backend command handler query MUST include `projectId` in the filter. @mention resolution MUST NOT resolve entities from other projects. Cross-project command execution MUST return 404 (not 403). |
| Tenant isolation  | Every backend command handler query MUST include `tenantId` in the filter. @mention resolution MUST NOT resolve entities from other tenants. Cross-tenant command execution MUST return 404 (not 403).    |
| User isolation    | Backend command handlers MUST verify the session belongs to the requesting user. Commands MUST execute within the user's own session. Cross-user session access MUST return 404.                          |

### Security & Compliance

- **Input validation**: Slash commands are validated against the command registry — unknown commands are rejected before reaching the backend.
- **Argument sanitization**: Command arguments are validated by Zod schemas before execution.
- **@mention injection safety**: Mention names are resolved against the entity registry — arbitrary strings do not bypass validation.
- **No new auth surface**: Commands use the same session auth as regular messages.

### Performance & Scalability

- **Client-only commands**: <100ms execution — no network round-trip.
- **Backend commands**: Same latency as regular tool invocations (skip LLM routing, ~200-500ms).
- **Mention resolution**: Sub-millisecond — reads from in-memory Zustand stores.
- **Command dropdown rendering**: <16ms — static list filtered client-side.

### Reliability & Failure Modes

- **Unknown command**: Display "Unknown command" message in chat. Do not send to backend.
- **Failed mention resolution**: If `@agent_name` doesn't match any known agent, send the raw text as-is (no resolution). The specialist will handle it as natural language.
- **Backend command failure**: Standard SSE error event. Same error handling as regular messages.

### Observability

- **Journal entries**: Backend commands emit `journal_entry` events with `entryType: 'command'` for traceability.
- **Activity feed**: Backend commands emit `activity` SSE events via ActivityEmitter (B05 integration).

### Data Lifecycle

No new persistent data. Commands are ephemeral. @mention resolution is per-request.

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Slash Commands (B57.1)

1. **Command Registry & Types**
   1.1 Create `packages/arch-ai/src/types/slash-command.ts` — `SlashCommand` interface, command registry
   1.2 Define 12 initial commands with `when` predicates, categories, execution types
   1.3 Add `type: 'command'` variant to `MessageRequestSchema` in `message-request.ts`
   1.4 Unit tests for command registry filtering and `when` predicate logic

2. **Frontend: SlashCommandDropdown Component**
   2.1 Create `SlashCommandDropdown.tsx` — positioned above chat input, grouped by category
   2.2 Create `useSlashCommands.ts` hook — manages dropdown state, filtering, keyboard navigation
   2.3 Integrate into `ChatInputBar.tsx` — detect `/` prefix, show/hide dropdown, intercept Enter
   2.4 Implement client-only command execution (navigate, open panel)

3. **Backend: Command Handler**
   3.1 Add `case 'command':` branch in `message/route.ts`
   3.2 Implement command-to-tool mapping (compile -> compile_abl, health -> health_check)
   3.3 Implement specialist-direct routing for `/ask-*` commands
   3.4 Emit activity + journal events for command execution

4. **Integration & Polish**
   4.1 Wire SSE response rendering for command results (reuse existing tool_call/widget rendering)
   4.2 Handle edge cases: empty args, invalid agent names, commands during streaming
   4.3 Verify commands disabled during active streaming (isWorkflowBusy)

5. **Phase 1 E2E & Integration Tests**
   5.1 E2E test: `/compile billing_agent` sends `type: 'command'` and returns compile result
   5.2 E2E test: Invalid command returns error message
   5.3 E2E test: Phase-filtered commands — `/compile` hidden during INTERVIEW
   5.4 E2E test: `/ask-architect` routes directly to project-architect specialist
   5.5 Integration tests: command registry filtering, backend dispatch, isolation (cross-tenant 404)

### Phase 2: @Mentions (B57.2)

6. **Mention Types & Resolution**
   6.1 Create `packages/arch-ai/src/types/mention.ts` — `MentionSchema`, `ResolvedMention` type
   6.2 Add optional `mentions` field to `type: 'message'` variant in `MessageRequestSchema`
   6.3 Create `useMentionResolver.ts` — parse @references, resolve from stores
   6.4 Unit tests for mention parsing (edge cases: @name at end, multiple @mentions, non-matching @text)

7. **Frontend: Mention Chips**
   7.1 Create `MentionChip.tsx` — styled inline chip for rendered mentions
   7.2 Integrate mention parsing into `ChatInputBar.tsx` — detect `@` prefix, resolve on send
   7.3 Render mention chips in sent message bubbles (ArchMessageBubble or equivalent)

8. **Backend: Mention Injection**
   8.1 Parse `mentions` from the request in `message/route.ts`
   8.2 Build `## Referenced Entities` section from resolved mention data (see format in section 7)
   8.3 Inject into specialist system prompt AFTER `## Current Context`, enforce 4000-token budget

9. **Phase 2 E2E & Integration Tests**
   9.1 E2E test: Message with `@billing_agent` resolves and injects context
   9.2 E2E test: Multiple @mentions in one message all resolve correctly
   9.3 E2E test: Natural language messages unaffected (regression)
   9.4 Integration tests: mention resolution from stores, cross-project mention returns empty
   9.5 Isolation test: Cross-tenant @mention resolution MUST NOT resolve entities from other tenants

---

## 14. Success Metrics

| Metric                          | Baseline          | Target           | How Measured                                    |
| ------------------------------- | ----------------- | ---------------- | ----------------------------------------------- |
| Latency for compile action      | 5-15s (LLM route) | <500ms           | Time from Enter to first SSE event              |
| Latency for navigation commands | 5-15s (LLM route) | <100ms           | Time from Enter to navigation complete          |
| Slash command adoption          | 0%                | 30%+ of actions  | Ratio of `type: 'command'` to `type: 'message'` |
| @mention usage                  | 0%                | 15%+ of messages | Messages with non-empty `mentions` field        |
| User satisfaction with speed    | N/A (qualitative) | Positive         | User feedback during testing                    |

---

## 15. Open Questions

1. Should `/compile` with no argument compile the "current" agent (from page context) or all agents? The backlog suggests both (`/compile [agent]` and `/compile all`).
2. Should failed @mention resolution show a warning to the user before sending, or silently send as raw text?
3. What is the maximum number of @mentions per message before context injection exceeds a reasonable token budget?
4. Should the command dropdown show recently used commands at the top (frecency), or maintain a fixed category order?
5. Should the backend validate that a `type: 'command'` message contains a known command, or allow unknown commands through for forward compatibility?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                       | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No @mention autocomplete — users must type full entity names until B57.5                          | Medium   | Open   |
| GAP-002 | No Cmd+K integration — slash commands are not discoverable via existing CommandPalette (B28)      | Medium   | Open   |
| GAP-003 | @tool mentions require parsing ABL YAML content to extract tool names — no dedicated index        | Low      | Open   |
| GAP-004 | IN_PROJECT @mention resolution may need API call if agent data isn't in Zustand stores            | Medium   | Open   |
| GAP-005 | Widget quick actions (B57.3) are not included — review gates lack quick action buttons            | Medium   | Open   |
| GAP-006 | `/diff` and `/fix` commands require new tools (`show_diff`, `fix_agent`) not yet in ToolName type | Medium   | Open   |
| GAP-007 | IN_PROJECT has no voice-specific specialist — `/ask-voice` falls back to `platform-guide`         | Low      | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                | Coverage Type | Status     | Test File / Note                                       |
| --- | ----------------------------------------------------------------------- | ------------- | ---------- | ------------------------------------------------------ |
| 1   | `/compile billing_agent` sends `type: 'command'` (auth: tenant+project) | E2E           | NOT TESTED | Requires running Studio + Arch AI backend              |
| 2   | Phase-filtered commands: INTERVIEW shows only /help, /restart           | Integration   | NOT TESTED | Command registry with `when` predicates                |
| 3   | @billing_agent resolves to agent ABL content                            | Integration   | NOT TESTED | Mention resolver + arch-ai-store                       |
| 4   | Command dropdown keyboard navigation (arrow keys, Enter, Esc)           | Integration   | NOT TESTED | SlashCommandDropdown component test                    |
| 5   | Backend `type: 'command'` handler dispatches compile tool               | E2E           | NOT TESTED | Message route command handler                          |
| 6   | Frontend-only commands (/topology) navigate without API call            | Integration   | NOT TESTED | Client-side command execution                          |
| 7   | Multiple @mentions in one message all resolve and inject                | Integration   | NOT TESTED | Mention resolver with multiple entities                |
| 8   | Invalid slash command shows error in chat                               | Integration   | NOT TESTED | Command validation                                     |
| 9   | /ask-architect routes to project-architect (IN_PROJECT mode)            | E2E           | NOT TESTED | Specialist-direct command routing                      |
| 10  | Natural language messages unaffected (no /prefix, no @mentions)         | Integration   | NOT TESTED | Regression test for existing message flow              |
| 11  | Cross-tenant command execution returns 404                              | E2E           | NOT TESTED | Isolation: tenant A's session, tenant B's request      |
| 12  | Cross-project @mention resolution returns empty                         | E2E           | NOT TESTED | Isolation: project A's agents not visible to project B |

### Testing Notes

All scenarios are currently NOT TESTED (feature is PLANNED). E2E tests require a running Studio instance with Arch AI backend. Integration tests can run against the command registry and mention resolver in isolation.

> Full testing details: [../testing/quick-actions-commands.md](../testing/quick-actions-commands.md)

---

## 18. References

- Backlog spec: [`docs/arch/backlogs/B57-quick-actions-commands.md`](../arch/backlogs/B57-quick-actions-commands.md)
- Related feature: [`docs/features/page-context-awareness.md`](page-context-awareness.md) (B02 — @mentions extend page context)
- Related feature: [`docs/features/live-thinking-visibility.md`](live-thinking-visibility.md) (B05 — activity events for commands)
- Related feature: [`docs/features/arch-ai-assistant.md`](arch-ai-assistant.md) (parent Arch AI feature)
- MessageRequest schema: `packages/arch-ai/src/types/message-request.ts`
- Existing command palette: `apps/studio/src/components/CommandPalette.tsx`
- Backlog index: [`docs/arch/backlogs/00-index.md`](../arch/backlogs/00-index.md)
