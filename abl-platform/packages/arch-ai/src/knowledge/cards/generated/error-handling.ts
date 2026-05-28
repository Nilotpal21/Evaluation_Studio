// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/lifecycle-and-hooks.mdx
// Regenerate: pnpm abl:docs:generate

export const ERROR_HANDLING_CARD = `## Error Handling — Resolution Chain & Recovery

## ON_ERROR handlers
- The \`ON_ERROR:\` block defines how the agent responds to specific error types.
### Syntax
\`\`\`abl
ON_ERROR:
  tool_timeout:
    RESPOND: "That system is responding slowly. Let me retry."
    RETRY: 2
    THEN: CONTINUE

  tool_error:
    RESPOND: "I hit an error accessing that service. Let me try again."
    RETRY: 1
    THEN: CONTINUE

  validation_error:
    RESPOND: "That value doesn't look right. Could you double-check?"
    THEN: CONTINUE

  llm_error:
    RESPOND: "I'm having trouble processing your request."
    RETRY: 1
    RETRY_BACKOFF: exponential
    RETRY_MAX_DELAY: 10000
    THEN: ESCALATE
\`\`\`
### Error types
| Error type          | When it occurs                                         |
| ------------------- | ------------------------------------------------------ |
| \`tool_timeout\`      | A tool call exceeds its timeout.                       |
| \`tool_error\`        | A tool call returns an error.                          |
| \`validation_error\`  | User input fails validation.                           |
| \`llm_error\`         | The LLM call fails (rate limit, model error, etc.).    |
| \`routing_failure\`   | The Supervisor cannot route a message.                 |
| \`agent_unavailable\` | A target agent for handoff or delegate is unavailable. |
| \`timeout\`           | A general timeout (session idle, async operation).     |
### Error handler properties
| Property          | Type       | Required | Default | Description                                                                   |
| ----------------- | ---------- | -------- | ------- | ----------------------------------------------------------------------------- |
| \`RESPOND\`         | \`string\`   | No       | --      | Message sent to the user when this error occurs.                              |
| \`VOICE\`           | \`object\`   | No       | --      | Voice-specific overrides for the response.                                    |
| \`RICH_CONTENT\`    | \`object\`   | No       | --      | Rich content format variants.                                                 |
| \`ACTIONS\`         | \`object\`   | No       | --      | Interactive actions.                                                          |
| \`RETRY\`           | \`number\`   | No       | --      | Number of retry attempts before executing \`THEN\`.                             |
| \`RETRY_DELAY\`     | \`number\`   | No       | --      | Delay in milliseconds between retries.                                        |
| \`RETRY_BACKOFF\`   | \`string\`   | No       | --      | Backoff strategy for retries. See [Retry strategies](#retry-strategies).      |
| \`RETRY_MAX_DELAY\` | \`number\`   | No       | --      | Maximum delay between retries in milliseconds.                                |
| \`THEN\`            | \`string\`   | No       | --      | Action after retries are exhausted. See [Then actions](#then-actions).        |
| \`BACKTRACK_TO\`    | \`string\`   | No       | --      | Target step for \`backtrack\` action.                                           |`;
