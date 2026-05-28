// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/flow.mdx
// Regenerate: pnpm abl:docs:generate

export const FLOW_PATTERNS_CARD = `## FLOW — Step Shapes, Branching, Transitions

# FLOW (structured execution steps)
- The \`FLOW:\` section adds structured execution steps to any agent.
- Agents operate in reasoning mode by default, where the LLM autonomously decides actions based on the goal.
## Flow structure
### Basic syntax
\`\`\`abl
FLOW:
  entry_point: start

  steps:
    - start
    - collect_info
    - process
    - complete

  start:
    REASONING: false
    SET:
      status = "pending"
    RESPOND: "Welcome! Let me help you get started."
    THEN: collect_info

  collect_info:
    REASONING: false
    GATHER:
      - name: required
        prompt: "What is your name?"
    THEN: process

  process:
    REASONING: false
    CALL: process_request
      WITH:
        name: name
      AS: result
    RESPOND: "Done! Your request has been processed."
    THEN: complete

  complete:
    REASONING: false
    RESPOND: "Thank you for using our service. Goodbye!"
\`\`\`
### Entry point
The \`entry_point:\` property declares which step the flow begins at:
\`\`\`abl
FLOW:
  entry_point: greeting
\`\`\`
| Property      | Type     | Required | Default                        | Description                          |
| ------------- | -------- | -------- | ------------------------------ | ------------------------------------ |
| \`entry_point\` | \`string\` | No       | First step in the \`steps\` list | The step name where execution begins |
If omitted, execution starts at the first step listed in the \`steps\` array.
### Step list
- The \`steps:\` array declares the ordered list of step names.
\`\`\`abl
FLOW:
  steps:
    - greeting
    - collect_account
    - verify
    - process
    - complete
\`\`\`
### Step definitions
Each step is defined as a named block under \`FLOW:\` with its properties indented:
\`\`\`abl
FLOW:
  greeting:
    REASONING: false
    RESPOND: "Hello! How can I help you today?"
    THEN: collect_account
\`\`\`
### Per-step REASONING toggle
- Every step in a \`FLOW:\` section **must** declare \`REASONING: true\` or \`REASONING: false\`.
\`\`\`abl
FLOW:
  analyze_request:
    REASONING: true
    GOAL: "Analyze the customer's request and determine the best course of action"
    AVAILABLE_TOOLS: [search_knowledge, classify_intent]
    EXIT_WHEN: intent_classified == true
    MAX_TURNS: 5
    THEN: route_request

  route_request:
    REASONING: false
    CHECK: intent == "billing"
    ON_FAIL: general_support
    THEN: billing_flow
\`\`\`
| Property    | Type      | Required | Default | Description                                                          |
| ----------- | --------- | -------- | ------- | -------------------------------------------------------------------- |
| \`REASONING\` | \`boolean\` | **Yes**  | --      | \`true\` for LLM-driven reasoning, \`false\` for deterministic execution |
#### Reasoning step properties
When \`REASONING: true\`, the following additional properties are available:
| Property           | Type       | Required | Default             | Description                                                   |
| ------------------ | ---------- | -------- | ------------------- | ------------------------------------------------------------- |`;
