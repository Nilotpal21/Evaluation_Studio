// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/multi-agent-and-supervisor.mdx
// Regenerate: pnpm abl:docs:generate

export const EXTERNAL_AGENTS_CARD = `## External Agent Registry — Remote A2A Handoffs

## Remote Agent
- A **remote agent** is an A2A-compatible agent that lives outside the platform and is reached over HTTP using the Agent-to-Agent (A2A) protocol.
### LOCATION
- \`LOCATION: remote\` flips a HANDOFF target from an in-project ABL agent to an externally registered A2A endpoint.
### ENDPOINT
- \`ENDPOINT:\` is **optional in the ABL DSL** for remote handoffs.
### PROTOCOL
- \`PROTOCOL: a2a | rest\`.
### Auth via registry
- Authentication for a remote agent NEVER lives in the ABL agent file.
### CONTEXT.pass typing
- \`CONTEXT: pass: [.
\`\`\`abl
HANDOFF:
  - TO: SalesforceAgent
    WHEN: intent.category == "billing_escalation"
    LOCATION: remote
    PROTOCOL: a2a
    CONTEXT:
      pass: [user_id, conversation_summary]
\`\`\`
---
## External Agent Registry + arch-ai workflow
- The **External Agent Registry** is the project-level catalog of A2A endpoints an ABL agent can hand off to.
### What is an external agent?
- An A2A-compatible agent registered in the project's \`external_agent_configs\` collection.
### Tool: \`external_agent_ops\`
Seven actions, each gated by the standard arch-ai secret-flow + dangerous-action checks:
- \`list\` — list all registered external agents in the project.
- \`read\` — fetch one entry by id, including the cached agent card.
- \`discover_preview\` — dry-run fetch of \`/.well-known/agent-card.json\` for a URL the user provides.
- \`create\` — register a new external agent (returns \`requiredSecrets\` until secrets are collected).
- \`update\` — patch an existing entry (endpoint, auth, display metadata).
- \`delete\` — remove an entry from the registry.
- \`test_connection\` — fetch the agent card with the stored credentials and report status + latency.
### Discovery-first pattern
- When a user provides a URL, **always start with \`discover_preview\`** before \`create\`.
### Secret-flow
\`create\` and \`update\` follow the platform's standard secret-collection contract:
- 1.
2. For each entry in \`requiredSecrets\`, call \`collect_secret\` with the same \`flowId\`.
- 3.
- Never ask for tokens via plain \`ask_user\`.
### Wiring HANDOFF
After \`test_connection\` succeeds, wire the calling agent in five steps:
1. \`read_agent\` on the caller to get the current ABL document.
- 2.
3. \`propose_modification\` showing the diff.
4. \`Confirmation\` widget for the user.
5. On approval: \`apply_modification\` → \`compile_abl\`.
- \`ENDPOINT:\` and \`PROTOCOL:\` are intentionally **omitted from the DSL** — the registry resolves them at runtime, so rotating endpoints does not require an ABL edit.
### HANDOFF remote DSL form (golden)
The canonical shape arch should produce:
\`\`\`abl
HANDOFF:
  - TO: SalesforceAgent
    WHEN: intent.category == "billing_escalation"
    LOCATION: remote
    CONTEXT:
      pass: [user_id, conversation_summary]
\`\`\`
---`;
