# Testing Guide: Quick Actions & Commands (B57)

**Feature**: [Quick Actions & Commands](../features/quick-actions-commands.md)
**Status**: PLANNED
**Last Updated**: 2026-04-06
**Package(s)**: `apps/studio`, `packages/arch-ai`

---

## Current State

Feature is PLANNED. No tests exist yet. This guide covers B57.1 (Slash Commands) and B57.2 (@Mentions) scope only.

---

## Health Dashboard

| Category    | Status  | Notes                                   |
| ----------- | ------- | --------------------------------------- |
| Unit Tests  | PLANNED | Command registry, mention parser        |
| Integration | PLANNED | Component tests, hook tests             |
| E2E         | PLANNED | Full flow: input -> backend -> response |
| Manual      | PLANNED | Keyboard nav, dropdown UX               |

---

## Coverage Matrix

| FR    | Requirement                                         | Unit    | Integration | E2E     | Manual  |
| ----- | --------------------------------------------------- | ------- | ----------- | ------- | ------- |
| FR-1  | Command dropdown on `/` input                       |         | PLANNED     |         | PLANNED |
| FR-2  | Real-time filtering as user types                   |         | PLANNED     |         |         |
| FR-3  | Keyboard navigation (arrows, Enter, Esc)            |         | PLANNED     |         | PLANNED |
| FR-4  | Client-only command execution <100ms                |         | PLANNED     |         |         |
| FR-5  | Backend `type: 'command'` message dispatch          | PLANNED | PLANNED     | PLANNED |         |
| FR-6  | Specialist-direct commands (/ask-architect)         | PLANNED |             | PLANNED |         |
| FR-7  | Parse @agent_name and @tool_name references         | PLANNED | PLANNED     |         |         |
| FR-8  | Client-side mention resolution from stores          | PLANNED | PLANNED     |         |         |
| FR-9  | Backend mention injection into system prompt        | PLANNED |             | PLANNED |         |
| FR-10 | Mention chips in input and message bubbles          |         | PLANNED     |         | PLANNED |
| FR-11 | Phase-aware command filtering via `when` predicates | PLANNED | PLANNED     |         |         |
| FR-12 | 10+ commands at launch                              | PLANNED |             |         |         |
| FR-13 | Natural language input unaffected                   |         | PLANNED     | PLANNED |         |
| FR-14 | MessageRequest `type: 'command'` schema extension   | PLANNED |             |         |         |
| FR-15 | "No matching commands" state in dropdown            |         | PLANNED     |         |         |

---

## E2E Test Scenarios (minimum 5)

### E2E-1: Slash Command Compile Flow

**Scenario**: User types `/compile billing_agent`, system sends `type: 'command'`, backend executes compile, returns result via SSE.
**Preconditions**: Active Arch session in BUILD phase, billing_agent exists.
**Steps**:

1. POST `/api/arch-ai/message` with `{ type: 'command', command: 'compile', args: { agent: 'billing_agent' } }`
2. Verify SSE stream returns `activity` events and `compile_result` widget
   **Expected**: Compile result returned without LLM routing. Response time < 2s.

### E2E-2: @Mention Resolution and Context Injection

**Scenario**: User sends message with `@billing_agent`, backend receives resolved mention data, injects into specialist prompt.
**Preconditions**: Active session, billing_agent file in session metadata.
**Steps**:

1. POST `/api/arch-ai/message` with `{ type: 'message', text: 'What tools does @billing_agent have?', mentions: [{ type: 'agent', name: 'billing_agent', resolvedData: { ... } }] }`
2. Verify specialist response references billing_agent's actual tools
   **Expected**: Specialist sees agent definition without additional tool calls.

### E2E-3: Invalid Command Rejection

**Scenario**: User sends unknown slash command.
**Steps**:

1. POST `/api/arch-ai/message` with `{ type: 'command', command: 'nonexistent' }`
2. Verify error response
   **Expected**: SSE error event with "Unknown command: nonexistent" message.

### E2E-4: Phase-Filtered Commands

**Scenario**: During INTERVIEW phase, only phase-appropriate commands are available.
**Steps**:

1. Create session in INTERVIEW phase
2. Query available commands for mode=ONBOARDING, phase=INTERVIEW
3. Verify /compile, /health are NOT in the list
4. Verify /help, /restart ARE in the list
   **Expected**: Command registry filtering respects phase predicates.

### E2E-5: Specialist-Direct Command Routing

**Scenario**: `/ask-architect` routes directly to the project-architect specialist.
**Steps**:

1. POST `/api/arch-ai/message` with `{ type: 'command', command: 'ask-architect', args: { query: 'Should I add a guardrail?' } }`
2. Verify response comes from the architect specialist (check specialist SSE event)
   **Expected**: No coordinator routing decision. Direct specialist invocation.

### E2E-6: Natural Language Regression

**Scenario**: Regular message without `/` or `@` is unaffected.
**Steps**:

1. POST `/api/arch-ai/message` with `{ type: 'message', text: 'Help me design a billing agent' }`
2. Verify normal coordinator routing and specialist response
   **Expected**: Identical behavior to pre-B57 message handling.

### E2E-7: Multiple @Mentions in Single Message

**Scenario**: Message references two agents.
**Steps**:

1. POST with `{ type: 'message', text: 'Compare @billing_agent and @triage_agent', mentions: [{...}, {...}] }`
2. Verify both agents' data injected into specialist context
   **Expected**: Specialist response demonstrates awareness of both agents' definitions.

---

## Integration Test Scenarios (minimum 5)

### INT-1: Command Registry Filtering

**Test**: Command registry returns correct commands per mode/phase combination.
**Approach**: Unit test all `when` predicates with every (mode, phase) combination.
**Verify**: INTERVIEW shows only help/restart. BUILD shows compile/topology/help. IN_PROJECT shows all.

### INT-2: Mention Parser

**Test**: Parse @references from arbitrary text input.
**Cases**: Single mention, multiple mentions, @mention at end of text, @mention mid-word (should NOT match), non-existent agent.
**Verify**: Correct extraction of entity names.

### INT-3: Mention Resolver from Stores

**Test**: Resolve parsed @agent_name against arch-ai-store.filePanelFiles.
**Approach**: Set up Zustand store with test fixture agent data, resolve @billing_agent.
**Verify**: Resolved data contains agent ABL content and compile status.

### INT-4: SlashCommandDropdown Component

**Test**: Component renders, filters, and handles keyboard navigation.
**Approach**: Render component with mock command list, simulate keystrokes.
**Verify**: Arrow keys change selection, Enter triggers command, Escape closes dropdown.

### INT-5: ChatInputBar Command Interception

**Test**: ChatInputBar detects `/` prefix and shows dropdown instead of sending message.
**Approach**: Render ChatInputBar, type `/com`, verify dropdown appears and filters to /compile.
**Verify**: Enter selects command, not sends message.

### INT-6: Backend Command Handler

**Test**: message/route.ts dispatches `type: 'command'` to correct handler.
**Approach**: POST with `type: 'command'` payload (with auth: tenantId + projectId + userId), verify tool execution without LLM routing.
**Verify**: Compile tool invoked, activity events emitted.

### INT-7: Cross-Tenant Command Isolation

**Test**: Command execution with a session owned by tenant A cannot be accessed by tenant B.
**Preconditions**: Two tenant contexts, session created under tenant A.
**Steps**:

1. POST `/api/arch-ai/message` with `{ type: 'command', command: 'health' }` using tenant B auth but tenant A's sessionId
2. Verify 404 response (not 403)
   **Expected**: Cross-tenant access returns 404.

### INT-8: Cross-Project @Mention Resolution

**Test**: @mention resolution MUST NOT resolve agents from a different project.
**Preconditions**: Two projects (A and B), billing_agent exists only in project A.
**Steps**:

1. In project B context, attempt to resolve @billing_agent
2. Verify resolution returns empty (not project A's agent)
   **Expected**: Agent from project A is not visible to project B.

---

## Status: PLANNED
