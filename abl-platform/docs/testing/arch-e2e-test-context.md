# Arch AI E2E Test Context

**Purpose:** Context document for a new Claude Code session to run comprehensive Playwright E2E tests for Arch AI — 10 project creation tests + 50 in-project conversation tests.

**Branch:** `Archv03`
**Date:** 2026-04-04

---

## Environment

- **Studio:** PM2 production mode on port 5173 (`next start`)
- **Runtime:** port 3112
- **MongoDB:** `mongodb://abl_admin:abl_dev_password@localhost:27018/abl_platform?authSource=admin&directConnection=true`
- **Auth:** Dev Login button at `/auth/login` — click "Dev Login" to auto-authenticate
- **Feature flags:** `NEXT_PUBLIC_FEATURE_ARCH_AI=true`
- **Current project count:** 89

## Login Procedure

Every new browser session must login first:

```
1. Navigate to http://localhost:5173
2. If on /auth/login, click "Dev Login" button
3. Wait for redirect to / (projects dashboard)
```

## Architecture

### Project Creation (ONBOARDING mode)

- **Entry:** Click "New Project" on projects dashboard → opens Arch v0.3 creation modal
- **Alt Entry:** Navigate to `/arch` directly → Arch v3 standalone page
- **Flow:** INTERVIEW → BLUEPRINT → BUILD → CREATE phases
- **Session mode:** `ONBOARDING`
- **Route:** `apps/studio/src/app/api/arch-ai/message/route.ts` → `processMessage()` (existing, unchanged)

### In-Project Chat (IN_PROJECT mode)

- **Entry:** On any project page, click "Ask Arch" button (bottom right) → opens right-side overlay
- **Session mode:** `IN_PROJECT` — scoped by projectId
- **Route:** Same route file → `processInProjectMessage()` (new multi-turn executor)
- **Specialist routing:** Content-based via `routeByContent()` — routes to ABL Construct Expert, Multi-Agent Architect, Observability Analyst, or Testing Eval
- **Tool execution:** Multi-turn — LLM calls tools (health_check, read_agent, query_traces, compile_abl, etc.), executor runs them, feeds result back to LLM

### Key UI Elements

**Projects Dashboard (`/`):**

- Project cards: `*[class*="cursor-pointer"]` containing project name text
- "New Project" button
- "Ask Arch anything..." search bar

**Project Page (`/projects/:id`):**

- Left sidebar: Build (Arch AI, Overview, Agents, Workflows), Resources (Tools, KB, etc.)
- "Ask Arch" button: `button` containing text "Ask Arch"
- Overview shows: Agent count, Sessions count, Deploy status
- Agent list with agent names

**Arch Overlay (in-project):**

- Panel: `[class*="arch-panel"]`
- Input: `input[placeholder="Ask about this project..."]` (when idle)
- Input: `input[placeholder="Connecting..."]` (during init)
- Input: `input[placeholder="Waiting..."]` (during streaming/widget)
- Send button: `button` with text "Send"
- Widget inputs: various — `input[placeholder="Enter agent name"]`, option buttons, etc.
- Specialist badge: Shows above responses (e.g., "ABL Construct Expert")

**Arch Creation Page (`/arch`):**

- Full page Arch v3 chat interface
- Same SSE streaming as overlay but in ONBOARDING mode
- Phase progress shown in UI

## Known Behaviors

### Widget State

The LLM frequently uses `ask_user` tool to present interactive widgets (single-select, multi-select, text input). When a widget is active:

- Chat input shows "Waiting..." and is disabled
- User must interact with the widget (click an option or submit text)
- After widget submission, the chat continues with the user's answer

### Multi-Turn Tool Execution

When the LLM calls server-side tools (health_check, read_agent, etc.):

- The executor runs the tool
- Tool result is fed back to the LLM
- LLM generates a response based on the result
- This may take 2-3 LLM calls per user message (turnCount: 2-3)

### Session Lifecycle

- Session created on first overlay open per project
- State: IDLE → ACTIVE (during message) → IDLE (after response)
- One session per (tenantId, userId, mode, projectId)
- Messages persisted in session metadata

### Timing

- Init (session load/create): ~1-3 seconds
- First token: ~2-4 seconds after send
- Full response: ~5-15 seconds depending on tool calls
- Widget rendering: immediate after tool_call SSE event

## Test Strategy

### Part 1: Project Creation (10 tests)

Use the ONBOARDING flow to create 10 projects via Arch. For each:

1. Navigate to `/arch` or click "New Project"
2. Send an initial message describing the project (e.g., "I want to build a customer support chatbot")
3. Follow the INTERVIEW → BLUEPRINT → BUILD → CREATE phases
4. After creation, verify:
   - Redirect to project page (`/projects/:id`)
   - Project name in breadcrumb
   - Left nav shows correct project name
   - Agent count matches what was designed
   - Overview page loads properly

**10 Project Ideas:**

1. "Build a customer support bot with billing, tech support, and escalation agents"
2. "Create an HR onboarding assistant that handles new hire paperwork and training"
3. "Design an e-commerce product recommendation system"
4. "Build a healthcare triage system for patient intake"
5. "Create a financial advisory bot for investment planning"
6. "Design a travel booking assistant with flight, hotel, and car rental agents"
7. "Build an IT helpdesk system with ticket routing and resolution"
8. "Create a real estate agent for property search and mortgage calculation"
9. "Design a restaurant reservation and menu recommendation system"
10. "Build a legal document review assistant"

**Note:** The ONBOARDING flow is fully working (user verified). Each creation takes 3-5 minutes with LLM interaction. The test should be patient with timeouts.

### Part 2: In-Project Tests (50 tests)

After creation (or using existing projects), open the Arch overlay and test various conversation scenarios. Group by category:

**Category 1: Basic Chat (10 tests)**

- T1: Send "hello" → get greeting response
- T2: Send "what can you do" → get capabilities list
- T3: Send "help me" → get guidance
- T4: Send a long message (200+ chars) → response
- T5: Send emoji message → response
- T6: Close and reopen overlay → messages persist
- T7: Navigate away and back → session resumes
- T8: Send "thanks" → appropriate response
- T9: Ask follow-up to previous response → contextual answer
- T10: Ask same question twice → consistent response

**Category 2: Agent Queries (10 tests)**

- T11: "how many agents" → agent count
- T12: "list all agents" → agent names
- T13: "tell me about [specific agent]" → agent details
- T14: "what does [agent] do" → role description
- T15: "show me [agent] code" → read_agent tool fires
- T16: "what tools does [agent] have" → tool list
- T17: "compare agent A and agent B" → comparison
- T18: "which agent handles [topic]" → routing info
- T19: "is [agent] configured correctly" → validation
- T20: "what is the entry agent" → entry point info

**Category 3: Health & Diagnostics (10 tests)**

- T21: "check health of all agents" → health report
- T22: "are there any errors" → error summary
- T23: "show recent traces" → trace query
- T24: "any tool call failures" → diagnostic
- T25: "is the project ready for deployment" → readiness check
- T26: "what's the error rate" → analytics
- T27: "how many sessions" → session stats
- T28: "debug [agent]" → observability routing
- T29: "why did session X fail" → session diagnosis
- T30: "check if agents compile" → compile check

**Category 4: Topology & Architecture (10 tests)**

- T31: "what is the topology" → topology description
- T32: "how do handoffs work" → handoff explanation
- T33: "show me the agent flow" → flow description
- T34: "is the topology complete" → coverage analysis
- T35: "any orphan agents" → orphan detection
- T36: "how does delegation work" → delegation patterns
- T37: "what is the routing strategy" → routing explanation
- T38: "can you improve the topology" → recommendation
- T39: "add a handoff from A to B" → modification request (may trigger ask_user)
- T40: "explain the multi-agent architecture" → architecture overview

**Category 5: Widget & Tool Interaction (10 tests)**

- T41: Trigger ask_user widget → respond with option click → continue
- T42: Trigger text input widget → type answer → continue
- T43: Multi-turn: ask question → get widget → answer → get follow-up → answer again
- T44: health_check tool → LLM interprets result → meaningful response
- T45: read_agent tool → LLM shows agent details
- T46: query_traces tool → LLM summarizes traces
- T47: compile_abl tool → LLM reports compilation status
- T48: Tool error handling → graceful error message
- T49: Widget timeout → proper error/fallback
- T50: Multiple tool calls in one response → all results incorporated

## Test Helpers

### Sending a Message

```javascript
// Wait for idle
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const ph = await page.evaluate(() =>
    document.querySelector('[class*="arch-panel"] input')?.getAttribute('placeholder'),
  );
  if (ph === 'Ask about this project...') break;
}

// Type and send
const el = page.locator('[class*="arch-panel"] input[placeholder="Ask about this project..."]');
await el.click();
await el.pressSequentially('message text', { delay: 20 });
await page.waitForTimeout(300);
await page.evaluate(() => {
  const p = document.querySelector('[class*="arch-panel"]');
  for (const b of p?.querySelectorAll('button') || []) {
    if (b.textContent?.trim() === 'Send' && !b.disabled) b.click();
  }
});
```

### Waiting for Response

```javascript
// Wait for panel text to grow (response streaming)
const before = await page.evaluate(
  () => (document.querySelector('[class*="arch-panel"]')?.innerText || '').length,
);
let responded = false;
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000);
  const len = await page.evaluate(
    () => (document.querySelector('[class*="arch-panel"]')?.innerText || '').length,
  );
  if (len > before + 50) {
    responded = true;
    break;
  }
}
```

### Handling Widgets

```javascript
// Check if a widget is active
const hasWidget = await page.evaluate(() => {
  const panel = document.querySelector('[class*="arch-panel"]');
  const ph = panel?.querySelector('input')?.placeholder;
  return ph === 'Waiting...' || ph?.includes('Enter');
});

// Click a widget option
await page.evaluate((optionText) => {
  const panel = document.querySelector('[class*="arch-panel"]');
  for (const b of panel?.querySelectorAll('button, [class*="option"]') || []) {
    if (b.textContent?.trim() === optionText) {
      b.click();
      return;
    }
  }
}, 'Check project health');

// Submit a text widget
const widgetInput = page.locator('[class*="arch-panel"] input[placeholder*="Enter"]');
await widgetInput.fill('answer text');
await page.evaluate(() => {
  const panel = document.querySelector('[class*="arch-panel"]');
  for (const b of panel?.querySelectorAll('button') || []) {
    if (b.textContent?.trim() === 'Submit') {
      b.click();
      return;
    }
  }
});
```

### Opening Arch Overlay

```javascript
await page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    if (b.textContent?.includes('Ask Arch')) {
      b.click();
      return;
    }
  }
});
// Wait for init
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  const ph = await page.evaluate(() =>
    document.querySelector('[class*="arch-panel"] input')?.getAttribute('placeholder'),
  );
  if (ph === 'Ask about this project...') break;
}
```

### Navigating to a Project

```javascript
// By name from dashboard
await page.goto('http://localhost:5173');
await page.waitForTimeout(3000);
await page.evaluate((name) => {
  for (const el of document.querySelectorAll('*[class*="cursor-pointer"]')) {
    if (el.textContent?.includes(name)) {
      el.click();
      return;
    }
  }
}, 'ProjectName');
await page.waitForTimeout(3000);
```

## Verification Checklist

After each project creation, verify:

- [ ] URL is `/projects/:id` (valid UUID)
- [ ] Breadcrumb shows project name
- [ ] Left sidebar shows project name
- [ ] "Overview" is selected in left nav
- [ ] Agent count displayed
- [ ] "Ask Arch" button visible

After each in-project message, verify:

- [ ] User message appears in panel
- [ ] Response text streams (panel length grows)
- [ ] Specialist badge shown above response
- [ ] Chat returns to idle after response (input enabled, "Ask about this project...")
- [ ] If widget triggered: widget renders, options clickable, submission works

## Files Reference

| File                                                         | Purpose                             |
| ------------------------------------------------------------ | ----------------------------------- |
| `apps/studio/src/components/arch-v3/overlay/ArchOverlay.tsx` | IN_PROJECT overlay component        |
| `apps/studio/src/hooks/useArchChat.ts`                       | Chat hook — session, messaging, SSE |
| `apps/studio/src/app/api/arch-ai/message/route.ts`           | Server route — processes messages   |
| `packages/arch-ai/src/executor/multi-turn-executor.ts`       | Multi-turn tool execution loop      |
| `packages/arch-ai/src/executor/specialist-executor.ts`       | LLM streaming + tool dispatch       |
| `packages/arch-ai/src/coordinator/content-router.ts`         | Specialist routing                  |
| `packages/arch-ai/src/session/session-service.ts`            | Session CRUD                        |
| `docs/testing/arch-in-project-phase-0a-testing.md`           | Previous testing log                |
| `docs/arch/04-dev-diary.md`                                  | Development history                 |

## Results File

Write all test results to: `docs/testing/arch-e2e-full-test-results.md`

Track:

- Test ID, category, description
- PASS/FAIL/SKIP
- Response preview (first 100 chars)
- Time taken
- Issues found
- Screenshots for failures
