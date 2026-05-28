// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/memory-and-constraints.mdx, guides/memory-and-state.mdx
// Regenerate: pnpm abl:docs:generate

export const MEMORY_FULL_CARD = `## MEMORY — Four Sub-Blocks for Agent State

## MEMORY
- Memory in ABL defines how an agent stores, retrieves, and persists information across conversation turns, sessions, users, projects, or one execution tree.
### Overview
Every agent has access to a memory configuration that controls data lifecycle:
- **Session variables** exist for the duration of a single conversation session.
- **Persistent variables** survive across sessions, scoped to a user, project, or one execution tree.
- **Remember triggers** automatically store values when conditions are met.
- **Recall instructions** load stored facts at specific lifecycle events.
- **Projected context** combines session memory and granted durable memory before each LLM turn so reasoning, prompts, and tool gating all see the same state.
\`\`\`abl
MEMORY:
  session:
    - customer_id
    - order_total
      TYPE: number
      DESCRIPTION: "Running total for the current order"
      INITIAL: 0
      RESET: per_session
  persistent:
    - user.preferred_language
    - user.loyalty_tier
      SCOPE: user
    - workflow.default_account_id
      SCOPE: execution_tree
      ACCESS: readwrite
  remember:
    - WHEN: user_language IS SET
      STORE: user_language -> user.language
      TTL: "90d"
  recall:
    - ON: session:start
      ACTION: inject_context
      PATHS: [user.preferred_language, user.loyalty_tier]
\`\`\`
### Session variables
- Session variables hold data that is relevant only during a single conversation.
#### Syntax
\`\`\`abl
MEMORY:
  session:
    - variable_name
    - variable_name
      TYPE: string
      DESCRIPTION: "Human-readable description"
      INITIAL: "default_value"
      RESET: per_session
\`\`\`
You can declare a session variable with a bare name (minimal form) or with additional metadata.
#### Properties
| Property      | Type          | Required   | Default   | Description                                           |
| ------------- | ------------- | ---------- | --------- | ----------------------------------------------------- | ------------- | ------------------------------------------------------------------ | --- | --- | ------------------------------------------------------- |
| \`name\`        | \`string\`      | Yes        | --        | Variable name, used as the key in session context.    |
| \`TYPE\`        | \`string\`      | \`number\`   | \`boolean\` | \`date\`                                                | \`array\`       | \`object\`                                                           | No  | --  | Value type for runtime validation and field resolution. |
| \`DESCRIPTION\` | \`string\`      | No         | --        | Human-readable description of the variable's purpose. |
| \`INITIAL\`     | any           | No         | \`null\`    | Initial value assigned when the session starts.       |
| \`RESET\`       | \`per_session\` | \`per_step\` | \`never\`   | No                                                    | \`per_session\` | When to reset the variable. See [Reset behavior](#reset-behavior). |
#### Reset behavior

### Canonical ABL Memory Contract

- \`MEMORY: persistent: - PATH: <name> / SCOPE: execution_tree\`
- \`ON: session:start | agent:*:after | ...\``;
