// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/multi-agent-and-supervisor.mdx
// Regenerate: pnpm abl:docs:generate

export const ESCALATE_A2A_CARD = `## ESCALATE & A2A — Human Handoff & Cross-Service Communication

## ESCALATE
- ESCALATE transfers the conversation to a human operator or human-handling system.
### Syntax
\`\`\`abl
ESCALATE:
  triggers:
    - WHEN: sanctions_screening_unavailable == true AND retry_count >= 2
      REASON: "Sanctions screening service down. Compliance check cannot be bypassed."
      PRIORITY: critical
      TAGS: [compliance, service_outage]

    - WHEN: user.requests_human == true
      REASON: "Customer requesting human specialist."
      PRIORITY: medium
      TAGS: [human_request]

  context_for_human:
    - customer_id
    - customer_name
    - amount
    - conversation_history

  routing:
    queue: "wire_operations_l2"
    skill_tags: [wire_transfer, compliance]
    priority_boost: 1

  on_human_complete:
    - IF human.resolved == true: COMPLETE
    - IF human.needs_agent == true: HANDOFF to specified_agent
\`\`\`
### Trigger properties
| Property   | Type       | Required | Default | Description                                                   |
| ---------- | ---------- | -------- | ------- | ------------------------------------------------------------- |
| \`WHEN\`     | \`string\`   | Yes      | --      | Condition that triggers escalation.                           |
| \`REASON\`   | \`string\`   | Yes      | --      | Human-readable reason for the escalation.                     |
| \`PRIORITY\` | \`string\`   | Yes      | --      | Priority level: \`low\`, \`medium\`, \`high\`, or \`critical\`.       |
| \`TAGS\`     | \`string[]\` | No       | --      | Tags for routing and categorization in the human agent queue. |
### Priority levels
| Level      | Use case                                                           |
| ---------- | ------------------------------------------------------------------ |
| \`low\`      | Non-urgent requests (e.g., general feedback).                      |
| \`medium\`   | Standard requests (e.g., customer asks to speak with a human).     |
| \`high\`     | Urgent issues (e.g., service outages, repeated failures).          |
| \`critical\` | Immediate attention required (e.g., compliance violations, fraud). |
### Context for human
- The \`context_for_human\` block lists session variable names to include in the escalation package.
\`\`\`abl
context_for_human:
  - customer_id
  - customer_name
  - source_account
  - amount
  - fraud_score
  - conversation_history
\`\`\`
You can also use structured context items with templates:
\`\`\`abl
context_for_human:
  - NAME: case_summary
    TEMPLATE: "Customer {{customer_name}} requesting wire of {{amount}} {{currency}}"
    INCLUDE: [fraud_score, sanctions_match_score]
\`\`\`
### Routing configuration
The \`routing\` block controls how the escalation is routed in the human agent system.
| Property         | Type       | Required | Default | Description                                           |
| ---------------- | ---------- | -------- | ------- | ----------------------------------------------------- |
| \`queue\`          | \`string\`   | No       | --      | Target queue name in the human agent system.          |`;
