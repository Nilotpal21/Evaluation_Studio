/**
 * Architect Prompts
 *
 * LLM prompts for architecture analysis and Agent Platform prompt parsing.
 */

import type { ApiDescription } from './types.js';

// =============================================================================
// ARCHITECTURE ANALYSIS PROMPT
// =============================================================================

export function buildArchitectPrompt(
  useCase: string,
  existingApis?: ApiDescription[],
  constraints?: string,
): string {
  const apiSection =
    existingApis && existingApis.length > 0
      ? `
## Existing APIs/Services

The user has these existing backend services that should be mapped to ABL TOOLS:

${existingApis
  .map(
    (api) => `### ${api.name}${api.baseUrl ? ` (${api.baseUrl})` : ''}
${api.endpoints.map((ep) => `- ${ep.method} ${ep.path}: ${ep.description}${ep.params ? ` | Params: ${JSON.stringify(ep.params)}` : ''}${ep.returns ? ` | Returns: ${ep.returns}` : ''}`).join('\n')}`,
  )
  .join('\n\n')}
`
      : '';

  const constraintSection = constraints ? `\n## User Constraints\n${constraints}\n` : '';

  return `You are an expert ABL (Agent-Based Language) architect. Analyze the following use case and design a multi-agent architecture.

## Use Case
${useCase}
${apiSection}${constraintSection}
## ABL Architecture Patterns

Choose ONE of these patterns:

### 1. Single Agent
- One agent handles everything
- Use for: simple use cases, single domain, <3 intents
- Structure: AGENT with GOAL, PERSONA, TOOLS, GATHER, FLOW

### 2. Multi-Agent Supervisor
- Central SUPERVISOR routes to specialist agents using HANDOFF rules
- Supervisor delegates to agents, agents report back
- Use for: complex multi-domain systems needing centralized orchestration
- Supervisor uses: HANDOFF with WHEN conditions, RETURN: true/false
- Agents use: TOOLS, GATHER, FLOW, CONSTRAINTS

### 3. Adaptive Agent Network
- Agents hand off to each other peer-to-peer (no central supervisor)
- Each agent has HANDOFF rules to other agents
- Use for: organic workflows where control flows naturally between specialists
- Key: HANDOFF with RETURN: true (round-trip) or RETURN: false (permanent transfer)

## ABL Syntax Reference

### Agent Declaration
\`\`\`
AGENT: agent_name
MODE: reasoning | scripted
GOAL: "description"
PERSONA: |
  Multi-line description
LIMITATIONS:
  - "limitation 1"
  - "limitation 2"
\`\`\`

### Supervisor Declaration
\`\`\`
SUPERVISOR: supervisor_name
MODE: reasoning
GOAL: "orchestration description"
HANDOFF:
  - TO: agent_name
    WHEN: condition
    CONTEXT:
      pass: [field1, field2]
      summary: "context description"
    RETURN: true | false
    ON_RETURN: "action"
\`\`\`

### Tools (map existing APIs here)
\`\`\`
TOOLS:
  tool_name(param: type, param2: type = default) -> {field: type, field2: type}
\`\`\`

### Gather
\`\`\`
GATHER:
  field_name:
    prompt: "Question to ask"
    type: string | number | date | email | phone
    required: true | false
\`\`\`

### Memory
\`\`\`
MEMORY:
  session:
    - variable_name
  persistent:
    - path.to.data
\`\`\`

### Constraints
\`\`\`
CONSTRAINTS:
  phase_name:
    - REQUIRE condition
      ON_FAIL: "message or action"
\`\`\`

### Guardrails
\`\`\`
GUARDRAILS:
  guardrail_name:
    kind: input | output | both
    check: "expression"
    action: block | warn | redact | escalate
    message: "message when triggered"
\`\`\`

### Flow (scripted mode)
\`\`\`
FLOW:
  step1 -> step2 -> step3

  step1:
    GATHER: field1, field2
    THEN: step2

  step2:
    CALL: tool_name
    RESPOND: "Result: ..."
    THEN: step3
\`\`\`

### Interactive Actions

FLOW steps can include interactive elements that render as buttons, selects, or inputs on supported channels:

\`\`\`
  step_name:
    RESPOND: "Choose an option"
      ACTIONS:
        - BUTTON: "Option A" -> option_a
        - BUTTON: "Option B" -> option_b
        - SELECT: "Pick a color"
          OPTIONS:
            - "Red" -> color_red
            - "Blue" -> color_blue
    ON_ACTION:
      option_a:
        RESPOND: "You chose A!"
        TRANSITION: next_step
      option_b:
        RESPOND: "You chose B!"
        TRANSITION: other_step
\`\`\`

ACTIONS is nested under RESPOND (indented). ON_ACTION is a step-level property (same indent as RESPOND).
Button syntax: BUTTON: "Label" -> action_id
URL buttons: BUTTON: "Label" followed by URL: "https://..." on next line
Selects have an OPTIONS sub-block with arrow syntax items.

### Carousel Templates

Rich multi-card carousels for product browsing, search results, recommendations:

\`\`\`
  step_name:
    RESPOND: "Browse our products"
      CAROUSEL:
        - TITLE: "Product Name"
          SUBTITLE: "Price or description"
          IMAGE: "https://example.com/image.jpg"
          BUTTONS:
            - BUTTON: "Buy Now" -> buy_product
            - BUTTON: "Details"
              URL: "https://example.com/details"
    ON_ACTION:
      buy_product:
        RESPOND: "Added to cart!"
        TRANSITION: checkout
\`\`\`

CAROUSEL is nested under RESPOND (indented). Max 10 cards, max 3 buttons per card.
Card fields: TITLE (required), SUBTITLE, IMAGE, DEFAULT_ACTION, BUTTONS.
Template variables work in card fields: TITLE: "{{product.name}}"

### Delegate
\`\`\`
DELEGATE:
  - AGENT: sub_agent
    WHEN: condition
    PURPOSE: "why delegating"
    INPUT: {field: value}
    RETURNS: {field: type}
    USE_RESULT: "how to use result"
\`\`\`

### Error Handling
\`\`\`
ON_ERROR:
  error_type:
    RESPOND: "message"
    RETRY: count
    THEN: action
\`\`\`

### Escalation
\`\`\`
ESCALATE:
  triggers:
    - WHEN: condition
      REASON: "description"
      PRIORITY: low | medium | high | critical
\`\`\`

### Completion
\`\`\`
COMPLETE:
  - WHEN: condition
    RESPOND: "message"
\`\`\`

### Lifecycle
\`\`\`
ON_START:
  respond: "greeting"
  call: init_tool
\`\`\`

## Few-Shot Example: Travel Booking Supervisor

Input: "Multi-agent travel booking system with hotel search, flight search, deals, and support"

Output:
\`\`\`json
{
  "projectName": "travel-booking",
  "description": "Multi-agent travel booking system with specialized agents for hotels, flights, deals, and support",
  "topology": "supervisor",
  "supervisor": {
    "name": "Travel_Supervisor",
    "goal": "Route user requests to the appropriate travel specialist agent",
    "persona": "Friendly travel assistant that quickly understands what the user needs and connects them with the right specialist.",
    "limitations": ["Cannot handle bookings directly - must delegate to specialist agents"],
    "memory": { "session": ["current_intent"], "persistent": [] },
    "handoff": [
      { "to": "Hotel_Search", "when": "intent contains \\"hotel\\" OR intent contains \\"stay\\"", "pass": ["destination", "checkin", "checkout"], "summary": "User needs hotel booking", "return": true },
      { "to": "Flight_Search", "when": "intent contains \\"flight\\" OR intent contains \\"fly\\"", "pass": ["destination", "date"], "summary": "User needs flight booking", "return": true },
      { "to": "Deals_Advisor", "when": "intent contains \\"deal\\" OR intent contains \\"discount\\"", "pass": ["budget", "destination"], "summary": "User looking for deals", "return": true },
      { "to": "Support_Agent", "when": "intent contains \\"help\\" OR intent contains \\"problem\\"", "pass": ["issue_description"], "summary": "User needs support", "return": false }
    ],
    "escalation": { "triggers": [{ "when": "routing_failures >= 3", "reason": "Multiple routing failures", "priority": "high" }], "contextForHuman": ["conversation_history"] },
    "errorHandlers": [{ "type": "routing_failure", "respond": "Let me try to help you differently.", "retry": 1, "then": "ESCALATE" }],
    "complete": [{ "when": "handoff.completed == true", "respond": "Is there anything else I can help with?" }]
  },
  "agents": [
    {
      "name": "Hotel_Search",
      "mode": "reasoning",
      "goal": "Help users find and book hotels",
      "persona": "Expert hotel advisor with deep knowledge of destinations.",
      "limitations": ["Cannot process payments directly"],
      "tools": [
        { "name": "search_hotels", "description": "Search for available hotels", "parameters": [{"name": "destination", "type": "string", "required": true}, {"name": "checkin", "type": "date", "required": true}], "returns": "{hotels: object[], count: number}" }
      ],
      "gather": [
        { "name": "destination", "prompt": "Where would you like to stay?", "type": "string", "required": true },
        { "name": "checkin", "prompt": "Check-in date?", "type": "date", "required": true }
      ],
      "memory": { "session": ["search_results"], "persistent": [] },
      "constraints": [],
      "guardrails": [],
      "delegate": [],
      "handoff": [],
      "errorHandlers": [{ "type": "tool_error", "respond": "Having trouble searching. Let me try again.", "retry": 2 }],
      "complete": [{ "when": "booking_confirmed == true", "respond": "Your hotel is booked!" }]
    }
  ],
  "gapReport": { "gaps": [], "overallCoverage": 100 }
}
\`\`\`

## Your Task

Analyze the use case above and respond with a JSON object matching this TypeScript interface:

\`\`\`typescript
interface ArchitectureSpec {
  projectName: string;          // kebab-case project name
  description: string;          // 1-2 sentence description
  topology: "single-agent" | "supervisor" | "adaptive-network";

  // For single-agent:
  agent?: AgentSpec;

  // For supervisor:
  supervisor?: SupervisorSpec;
  agents?: AgentSpec[];

  // For adaptive-network:
  entryAgent?: string;
  networkAgents?: AgentSpec[];

  gapReport: {
    gaps: Array<{
      requirement: string;
      ablLimitation: string;
      alternatives: Array<{ approach: string; tradeoffs: string; dslPattern: string }>;
      severity: "minor" | "moderate" | "significant";
    }>;
    overallCoverage: number;  // 0-100
  };
}
\`\`\`

Rules:
1. Choose the simplest topology that fits the use case
2. Map existing APIs to TOOLS with proper parameter types and return types
3. Identify ALL ABL gaps and provide alternatives
4. Use snake_case for agent names and tool names
5. Every agent MUST have: name, mode, goal, persona, limitations, tools, gather, memory, constraints, guardrails, delegate, handoff, errorHandlers, complete
6. Tools must have: name, description, parameters (with name, type, required), returns (as ABL syntax string)
7. If the use case requires loops, timers, file handling, etc. — add them to gapReport

Respond with ONLY the JSON object, no markdown fencing, no explanation.`;
}

// =============================================================================
// AGENT PLATFORM PROMPT PARSING
// =============================================================================

export function buildPromptParsingPrompt(agentName: string, promptText: string): string {
  return `You are parsing an agent prompt from Kore.ai Agent Platform v12 into structured ABL flow steps.

## Agent Name: ${agentName}

## Original Prompt Text:
${promptText}

## Task

Parse this prompt into a structured JSON representing ABL FLOW steps. The prompt often contains numbered steps (1., 2., 3., etc.) or described procedures.

Extract:
1. Goal: A single sentence describing what this agent does
2. Persona: A brief personality description
3. Flow steps: Each numbered step or procedure becomes a FLOW step with:
   - name: snake_case step name
   - action: what happens (gather, call_tool, respond, check_condition)
   - gather_fields: any information to collect from user
   - tool_calls: any tools/functions to call
   - respond_text: any messages to send
   - next_step: what comes next
4. Constraints: Any rules or limitations mentioned
5. Limitations: Things the agent cannot do

Respond with ONLY a JSON object:
\`\`\`typescript
{
  goal: string;
  persona: string;
  limitations: string[];
  flowSteps: Array<{
    name: string;
    gather?: Array<{ name: string; prompt: string; type: string; required: boolean }>;
    call?: string;
    respond?: string;
    then?: string;
    condition?: string;
  }>;
  constraints: Array<{ phase: string; condition: string; onFail: string }>;
}
\`\`\`

Respond with ONLY the JSON object, no markdown fencing.`;
}

// =============================================================================
// SUPERVISOR ROUTING PARSING
// =============================================================================

export function buildRoutingParsingPrompt(orchestrationText: string, agentNames: string[]): string {
  return `You are parsing a supervisor orchestration prompt from Kore.ai Agent Platform v12 into ABL HANDOFF routing rules.

## Orchestration Prompt:
${orchestrationText}

## Available Agents:
${agentNames.map((n) => `- ${n}`).join('\n')}

## Task

Parse the orchestration prompt into HANDOFF routing rules. The prompt typically contains a multi-level decision tree for routing user requests to the correct agent.

For each routing rule, extract:
1. Target agent name (must match one of the available agents)
2. WHEN condition (the condition that triggers this routing)
3. Context to pass
4. Whether to return after delegation

Respond with ONLY a JSON array:
\`\`\`typescript
Array<{
  to: string;         // Agent name
  when: string;       // ABL condition expression
  pass: string[];     // Context fields to pass
  summary: string;    // Brief description of why
  return: boolean;    // Whether control returns to supervisor
}>
\`\`\`

Respond with ONLY the JSON array, no markdown fencing.`;
}
