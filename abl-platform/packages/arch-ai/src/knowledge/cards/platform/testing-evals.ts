// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: guides/testing-and-evaluation.mdx
// Regenerate: pnpm abl:docs:generate

export const TESTING_EVALS_CARD = `## Testing & Evaluation — Personas, Scenarios, Judges, Batches

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
| ----------------------- | --------------------------------------------- | ---------------------------------------------------- |
| **Name**                | Unique name within the project                | e.g., "Impatient Business Traveler"                  |
| **Communication style** | How the persona phrases messages              | \`casual\`, \`formal\`, \`technical\`, \`terse\`, \`verbose\`  |
| **Domain knowledge**    | How much the persona knows about the topic    | \`beginner\`, \`intermediate\`, \`expert\`                 |
| **Behavior traits**     | Specific behaviors the persona exhibits       | Free-text tags, e.g., "asks follow-ups", "impatient" |
| **Goals**               | What the persona is trying to accomplish      | Free text                                            |
| **Constraints**         | Rules the persona follows during conversation | Free text                                            |
5. Click **Save**.
### Use AI-Generated Personas
- Instead of defining every persona manually, select **Generate with AI** to have the platform create personas based on your agent's goal and domain.
### Create Adversarial Personas
To test agent safety and robustness, create adversarial personas:
1. Toggle **Adversarial** on when creating a persona.
2. Select the adversarial type:
| Type                 | Tests for                                  |
| -------------------- | ------------------------------------------ |
| \`prompt_injection\`   | Attempts to override agent instructions    |
| \`social_engineering\` | Tries to extract sensitive information     |
| \`off_topic\`          | Steers conversation away from agent's goal |
| \`abusive\`            | Uses hostile or inappropriate language     |
| \`edge_case\`          | Sends unusual inputs (empty, very long)    |
### Create a Test Scenario
- A scenario defines a conversation flow to test, including the expected outcome, entry point, and success milestones.
1. Navigate to **Evals > Scenarios**.
2. Click **New Scenario**.
3. Fill in the scenario details:
| Field                   | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| **Name**                | Unique name within the project                           |
| **Category**            | Grouping label (e.g., "booking", "returns", "auth")      |
| **Difficulty**          | \`easy\`, \`medium\`, or \`hard\`                              |
| **Entry agent**         | Which agent starts the conversation (optional)           |
| **Initial message**     | The first user message that kicks off the scenario       |
| **Expected outcome**    | Description of what a successful conversation looks like |
| **Max turns**           | Maximum conversation turns before timeout                |
| **Expected milestones** | Key checkpoints the conversation should hit              |
| **Agent path**          | Expected sequence of agents (for multi-agent projects)   |
4. Click **Save**.
### Example Scenario
\`\`\`
Name: Flight rebooking after cancellation
Category: booking
Difficulty: medium
Initial message: "My flight was cancelled and I need to rebook for tomorrow"
Expected outcome: "Agent identifies the cancelled booking, offers alternatives, and confirms a new flight"
Max turns: 15
Expected milestones:
  - "Identify cancelled flight"
  - "Present rebooking options"
  - "Confirm new booking"
Agent path: ["Supervisor", "Booking_Manager"]
\`\`\`
### Bulk Import Personas and Scenarios
Use the API to create multiple personas or scenarios programmatically:
\`\`\`bash
curl -X POST /api/projects/:projectId/eval-personas \\
  -H "Authorization: Bearer \$TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Confused First-Time User",
    "communicationStyle": "verbose",
    "domainKnowledge": "beginner",
    "behaviorTraits": ["asks for clarification", "repeats questions"],
    "goals": "Complete a simple booking",
    "constraints": "Never provides information upfront"
  }'
\`\`\`
### Tag Scenarios for Filtering
- Use the \`tags\` field on scenarios to organize them by feature area, regression suite, or priority.
### Troubleshooting
- **Duplicate name error:** Persona and scenario names must be unique within a project. Choose a more specific name or delete the existing one.
- **Persona not behaving as expected in evals:** Refine the \`goals\` and \`constraints\` fields -- these are used as system prompt instructions for the simulated user LLM.
- **Scenario timing out:** Increase the \`maxTurns\` value or simplify the expected conversation path.
## Build LLM Judge Evaluators
- Create evaluators that automatically score agent conversations using LLM judges, code-based scorers, or trajectory analysis.
### Create an LLM Judge Evaluator
- An LLM judge evaluator uses a separate LLM to assess the quality of agent responses based on a scoring rubric you define.
1. Open your project in Studio.
2. Navigate to **Evals > Evaluators**.
3. Click **New Evaluator**.
4. Set the evaluator type to **LLM Judge**.
5. Configure the evaluator:
| Field                | Description                                                                   |
| -------------------- | ----------------------------------------------------------------------------- |
| **Name**             | Unique name (e.g., "Response Quality Judge")                                  |
| **Category**         | \`quality\`, \`safety\`, \`efficiency\`, \`empathy\`, \`tool_correctness\`, or \`custom\` |
| **Judge model**      | Which LLM to use as the judge (e.g., \`gpt-4o\`, \`claude-sonnet-4-5-20250929\`)  |
| **Judge prompt**     | Instructions telling the judge what to evaluate                               |
| **Chain of thought** | Whether the judge should explain its reasoning before scoring                 |
| **Temperature**      | LLM temperature for the judge (lower = more consistent scores)                |
6. Define a **scoring rubric**.
7. Click **Save**.
### Define a Scoring Rubric
The rubric tells the judge how to assign scores. Choose between two scale types:
**1-5 scale** -- Define criteria for each score level:
\`\`\`
Scale type: 1-5
Points:
  5 - Excellent: Fully addresses the user's request with accurate, complete information
  4 - Good: Addresses the request with minor omissions
  3 - Adequate: Partially addresses the request but misses key details
  2 - Poor: Mostly misses the request or provides inaccurate information
  1 - Failing: Completely fails to address the request or provides harmful information
\`\`\`
**Pass-fail** -- Define binary criteria:
\`\`\`
Scale type: pass-fail
Points:
  1 - Pass: Agent completes the task within the expected flow
  0 - Fail: Agent fails to complete the task or deviates from expected behavior
\`\`\`
### Write Effective Judge Prompts
- The judge prompt is the most important part of an evaluator.
\`\`\``;
