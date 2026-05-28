// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/testing-and-evaluation.mdx
// Regenerate: pnpm abl:docs:generate

export const DIAGNOSTICS_WORKFLOW_CARD = `## Diagnostics — Validation, Debugging, Health Checks

# Testing & Evaluation
- Agent Platform 2.
## Test in Studio Chat
Use the Studio test chat to validate agent behavior interactively before deploying to production.
### Start a Test Session
1. Open your project in Studio.
2. Select the agent you want to test from the project sidebar.
3. Click **Test** in the top-right toolbar to open the chat panel.
- Studio creates a test session that connects to the Runtime and executes your agent's compiled ABL definition in real time.
### Send Messages and Observe Behavior
- Type a message in the chat input and press **Enter**.
- Tool calls and their results
- Flow step transitions (for agents with \`FLOW\`)
- Handoffs to other agents (for supervisors)
- Guardrail checks on inputs and outputs
- Each message shows the agent's response along with metadata like which step executed, which tools were called, and the total response time.
### Inspect Traces
Click any message bubble to expand its trace details. The trace view shows:
- **Span tree** -- the hierarchy of execution spans (LLM calls, tool invocations, guardrail evaluations)
- **Decision points** -- why the agent chose a particular path, handoff, or completion
- **Timing** -- latency breakdown per span
### Reset Session State
If you need to restart the conversation from scratch (clearing memory and flow position):
1. Click the **Reset** button in the chat toolbar.
2. Confirm the reset.
This creates a fresh execution context while keeping the same session ID for comparison.
### Test with Different Entry Agents
- For multi-agent projects with a supervisor, Studio defaults to the project's entry agent.
1. Select the child agent in the project sidebar.
2. Click **Test** on that agent.
This bypasses the supervisor routing and sends messages directly to the selected agent.
### Test with Environment Variables
- If your agent references \`{{env.
### Troubleshooting
- **Agent not responding:** Verify the agent compiles without errors. Check the editor for red underlines or the **Problems** panel.
- **Tool calls failing:** Test tools return mock responses in Studio unless you have configured live tool bindings in project settings.
- **Stale behavior after edits:** Studio auto-compiles on save, but if behavior seems outdated, click **Rebuild** in the toolbar to force recompilation.
- **Session state persisting unexpectedly:** Click **Reset** to clear session memory and flow state.
## Create Test Personas & Scenarios
- Create personas and scenarios to define repeatable, automated test conversations that exercise your agents with diverse user behaviors and conversation paths.
### Create a Test Persona
- A persona represents a simulated user with a specific communication style, domain knowledge level, and behavioral traits.
1. Open your project in Studio.
2. Navigate to **Evals > Personas**.
3. Click **New Persona**.
4. Fill in the persona details:
| Field                   | Description                                   | Options                                              |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------- |`;
