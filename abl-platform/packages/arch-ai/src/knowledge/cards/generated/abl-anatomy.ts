// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/language-overview.mdx, abl-reference/agent-declaration.mdx
// Regenerate: pnpm abl:docs:generate

export const ABL_ANATOMY_CARD = `## ABL Anatomy — All Sections at a Glance

# ABL language overview
- Agent Blueprint Language (ABL) is the enterprise control plane for agentic AI — a schema-driven language purpose-built for multi-agent orchestration where deterministic governance meets autonomous reasoning.
## File structure
- An ABL document is a plain-text file composed of top-level **sections**, each introduced by an uppercase keyword followed by a colon.
\`\`\`abl
AGENT: Customer_Support

GOAL: |
  Help customers resolve billing questions.

PERSONA: |
  Friendly, patient support representative.

TOOLS:
  lookup_account(account_id: string) -> {name: string, balance: number}
    description: "Retrieve account details"
    type: http
    endpoint: "/api/accounts/lookup"
    method: POST

GATHER:
  account_id:
    prompt: "What is your account number?"
    type: string
    required: true
\`\`\`
### File extensions
| Extension     | Contents                                                                   |
| ------------- | -------------------------------------------------------------------------- |
| \`.agent.abl\`  | Agent definition (most common)                                             |
| \`.tools.abl\`  | Reusable tool library (see [Tool file imports](./tools#tool-file-imports)) |
| \`.agent.yaml\` | Agent definition in YAML format                                            |
### Required sections
Every agent document must contain:
- \`AGENT:\` -- the agent name
- \`GOAL:\` -- the agent's objective
- All other sections are optional.
### Recognized top-level sections
| Section          | Purpose                           | Reference                                                          |
| ---------------- | --------------------------------- | ------------------------------------------------------------------ |
| \`AGENT:\`         | Agent name declaration            | [Agent declaration](./agent-declaration)                           |
| \`VERSION:\`       | Semantic version                  | [Agent declaration](./agent-declaration#version)                   |
| \`DESCRIPTION:\`   | Human-readable description        | [Agent declaration](./agent-declaration#description)               |
| \`LANGUAGE:\`      | Agent language code               | [Agent declaration](./agent-declaration#language)                  |
| \`GOAL:\`          | Agent objective                   | [Agent declaration](./agent-declaration#goal)                      |
| \`PERSONA:\`       | Agent personality description     | [Agent declaration](./agent-declaration#persona)                   |
| \`LIMITATIONS:\`   | Prompt-level boundaries           | [Agent declaration](./agent-declaration#limitations)               |
| \`IDENTITY:\`      | Combined identity block           | [Agent declaration](./agent-declaration#identity)                  |
| \`INSTRUCTIONS:\`  | Operational instructions          | [Agent declaration](./agent-declaration#instructions)              |
| \`EXECUTION:\`     | Model and runtime configuration   | [Agent declaration](./agent-declaration#execution-configuration)   |`;
