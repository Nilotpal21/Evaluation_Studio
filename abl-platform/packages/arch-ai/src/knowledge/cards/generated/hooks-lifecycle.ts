// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/lifecycle-and-hooks.mdx
// Regenerate: pnpm abl:docs:generate

export const HOOKS_LIFECYCLE_CARD = `## HOOKS, ACTION_HANDLERS, RETURN_HANDLERS, MESSAGES, COMPLETE

# Lifecycle and hooks
- ABL provides lifecycle handlers and hooks that execute at specific points in an agent's execution cycle.
## Overview
| Handler    | When it fires                                           |
| ---------- | ------------------------------------------------------- |
| \`ON_START\` | Once per session, before any user input.                |
| \`HOOKS\`    | At defined lifecycle points (before/after agent, turn). |
| \`ON_ERROR\` | When a specific error type occurs during execution.     |
## ON_START handler
- The \`ON_START\` handler executes once when a new session initializes, before the agent processes any user input.
### Syntax
\`\`\`abl
ON_START:
  SET:
    session_initialized = true
    transfer_status = "pending"
    retry_count = 0
  CALL: check_returning_user()
  RESPOND: |
    Welcome to Wire Transfer Services. I can help you send
    a domestic or international wire transfer.
    Which account would you like to send from?
\`\`\`
### ON_START properties
| Property       | Type                    | Required | Default | Description                                                                                    |
| -------------- | ----------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------- |
| \`SET\`          | \`Record<string,string>\` | No       | --      | Variable assignments executed at session start.                                                |
| \`CALL\`         | \`string\`                | No       | --      | Tool to call during initialization.                                                            |
| \`DELEGATE\`     | \`string\`                | No       | --      | Agent to delegate to during initialization.                                                    |
| \`RESPOND\`      | \`string\`                | No       | --      | Greeting or welcome message sent to the user.                                                  |
| \`VOICE\`        | \`object\`                | No       | --      | Voice-specific overrides for the response. See [Rich Content](./rich-content-and-expressions). |
| \`RICH_CONTENT\` | \`object\`                | No       | --      | Rich content format variants. See [Rich Content](./rich-content-and-expressions).              |
| \`ACTIONS\`      | \`object\`                | No       | --      | Interactive actions attached to the response.                                                  |
### Template references in ON_START
You can reference named templates in the RESPOND value:
\`\`\`abl
ON_START:
  RESPOND: TEMPLATE(welcome)
\`\`\`
This renders the template named \`welcome\` from the agent's \`TEMPLATES:\` block.
### ON_START with tool call
\`\`\`abl
ON_START:
  CALL: check_cut_off_times(transfer_type = "all")
  SET:
    sanctions_clear = false
    fraud_score = 0
  RESPOND: "Welcome. Let me check today's processing windows."
\`\`\`
- The tool call executes first, and its result is available in the session context when the RESPOND message is rendered.
## HOOKS
- The \`HOOKS:\` block defines actions that run at four lifecycle points.
### Syntax
\`\`\`abl
HOOKS:`;
