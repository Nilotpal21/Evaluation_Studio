// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/multi-agent-and-supervisor.mdx, guides/multi-agent-orchestration.mdx
// Regenerate: pnpm abl:docs:generate

export const ROUTING_INTENTS_CARD = `## Routing & Intent Classification — Supervisor Patterns

## SUPERVISOR Declaration
- A Supervisor is a top-level orchestrator that routes user messages to the appropriate child agent based on intent, context, and declarative rules.
### Overview
- While agents handle domain-specific tasks, the Supervisor decides which agent should handle each user message.
\`\`\`abl
SUPERVISOR: Travel_Supervisor
VERSION: "2.0"
DESCRIPTION: "Routes customers to booking, support, or sales specialists"
GOAL: "Route requests to the right specialist with full context preservation"

PERSONA: |
  Professional travel booking assistant. Friendly, efficient, and helpful.
  Routes requests quickly and transparently.
\`\`\`
### Agent references
- The Supervisor routes to project agents by naming them in \`HANDOFF:\` targets.
### Routing rules
- Routing rules define conditional logic for directing messages to agents.
#### Syntax
\`\`\`abl
HANDOFF:
  - TO: Sales_Agent
    WHEN: intent.category == "new_booking"
    CONTEXT:
      pass: [search_context, user_preferences, budget]
      summary: "User looking to book new travel"
    RETURN: false
\`\`\`
#### Routing rule properties
| Property  | Type      | Required | Default | Description                                                        |
| --------- | --------- | -------- | ------- | ------------------------------------------------------------------ |
| \`TO\`      | \`string\`  | Yes      | --      | Target project agent name.                                         |
| \`WHEN\`    | \`string\`  | Yes      | --      | Condition expression that must be true for this handoff.           |
| \`CONTEXT\` | \`object\`  | No       | --      | Data, summary, history, and memory grants passed to the target.    |
| \`RETURN\`  | \`boolean\` | No       | \`false\` | Whether control should return to the calling agent after complete. |
#### Conditional routing (WHEN clauses)
- WHEN clauses use the same expression syntax as [Expressions & functions](.
\`\`\`abl
# Intent-based
WHEN: intent.category == "complaint"

# State-based
WHEN: user.is_authenticated == true AND intent.category == "manage_booking"

# Negation
WHEN: NOT intent.has_specific_request

# Compound
WHEN: intent.unclear == true OR intent.confidence < 0.5

# Variable check
WHEN: handoff_count >= 4
\`\`\`
#### Routing constraints
- Use the \`WHEN\` expression and, when needed, agent-level \`CONSTRAINTS:\` to limit when a handoff applies.
### State schema
The Supervisor can declare a state schema that defines typed variables organized by namespace.
\`\`\`abl
STATE:
  user:
    is_authenticated:
      type: boolean
      required: false
      default: false
      description: "Whether the user has been authenticated"
    language:
      type: string
      required: false
      source: user
  system:
    routing_failures:
      type: number
      required: false
      default: 0
      source: system
\`\`\`
- State variables follow the same [VariableDefinition](.
#### State variable properties
| Property      | Type                                         | Required | Default | Description                                          |`;
