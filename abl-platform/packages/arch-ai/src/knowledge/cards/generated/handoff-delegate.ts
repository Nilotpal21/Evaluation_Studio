// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/multi-agent-and-supervisor.mdx, guides/agent-collaboration-and-handoff.mdx
// Regenerate: pnpm abl:docs:generate

export const HANDOFF_DELEGATE_CARD = `## HANDOFF vs DELEGATE — Agent-to-Agent Control Transfer

## HANDOFF
- HANDOFF transfers conversational control from the current agent to another **machine agent** in a machine-to-machine flow, passing context and optionally expecting a return.
### Syntax
\`\`\`abl
RETURN_HANDLERS:
  resume_if_cleared:
    RESPOND: "Compliance review completed. Let's continue."
    CLEAR: [sanctions_match_score, compliance_review_notes]
    CONTINUE: true

HANDOFF:
  - TO: Compliance_Officer
    WHEN: sanctions_clear == false
    CONTEXT:
      pass: [customer_id, beneficiary_name, amount, sanctions_match_score]
      summary: "Wire flagged during sanctions screening (score: {{sanctions_match_score}})."
      history: auto
      memory_grants:
        - path: workflow.case_context
          access: readwrite
        - path: user.compliance_notes
          access: read
    RETURN: true
    ON_RETURN:
      handler: resume_if_cleared
      map:
        compliance_decision: sanctions_clear
        review_notes: compliance_review_notes
\`\`\`
### Properties
| Property    | Type                 | Required | Default         | Description                                                                                                                                                                |
| ----------- | -------------------- | -------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| \`TO\`        | \`string\`             | Yes      | --              | Target machine agent name.                                                                                                                                                 |
| \`WHEN\`      | \`string\`             | Yes      | --              | Condition that triggers the handoff.                                                                                                                                       |
| \`CONTEXT\`   | \`object\`             | Yes      | --              | Context to pass to the target agent. See [Context](#handoff-context).                                                                                                      |
| \`RETURN\`    | \`boolean\`            | Yes      | --              | Whether control should return to this agent after the target completes.                                                                                                    |
| \`ON_RETURN\` | \`object\`             | No       | --              | Structured post-return behavior. Use \`action:\` for built-ins (\`continue\`, \`resume_intent\`) or \`handler:\` for a named \`RETURN_HANDLERS\` definition, with optional \`map:\`.   |

### Canonical ABL Coordination Contract

- \`history: auto | none | summary_only | full | { mode: last_n, count }\` — When no explicit history strategy is declared, handoffs default to \`auto\`. Use \`auto\` by default; when summary-only would be lossy, the runtime falls back to bounded raw history (default last 10 messages).
- \`memory_grants: [{ path, access }]\`
- \`RETURN_HANDLERS: <name>: { RESPOND?, CLEAR?, CONTINUE?, RESUME_INTENT? }\``;
