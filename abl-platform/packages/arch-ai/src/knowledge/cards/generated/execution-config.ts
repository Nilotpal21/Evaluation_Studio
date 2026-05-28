// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/agent-declaration.mdx
// Regenerate: pnpm abl:docs:generate

export const EXECUTION_CONFIG_CARD = `## EXECUTION — Model, Reasoning, Timeouts, Compaction

## Execution Configuration
- The \`EXECUTION:\` section configures runtime behavior for the agent, including LLM model selection, temperature, token limits, timeouts, extended thinking, and per-operation model routing.
### Syntax
\`\`\`abl
EXECUTION:
  model: "claude-sonnet-4-5-20250929"
  temperature: 0.3
  max_tokens: 4096
  tool_timeout: 30000
  fallback_model: "claude-haiku-4-5-20251001"
\`\`\`
All properties are optional. When omitted, the platform applies its built-in defaults.
### Configuration properties
| Property                   | Type      | Required | Default          | Description                                                                                         |
| -------------------------- | --------- | -------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| \`model\`                    | \`string\`  | No       | Platform default | Primary LLM model identifier                                                                        |
| \`temperature\`              | \`number\`  | No       | Platform default | Sampling temperature (0.0--1.0). Lower values produce more deterministic output.                    |
| \`max_tokens\`               | \`number\`  | No       | Platform default | Maximum tokens in LLM response                                                                      |
| \`tool_timeout\`             | \`number\`  | No       | Platform default | Timeout in milliseconds for tool execution                                                          |
| \`llm_timeout\`              | \`number\`  | No       | Platform default | Timeout in milliseconds for LLM inference calls                                                     |
| \`session_idle_timeout\`     | \`number\`  | No       | Platform default | Timeout in milliseconds before an idle session expires                                              |
| \`max_reasoning_iterations\` | \`number\`  | No       | Platform default | Maximum reasoning loop iterations for agents without a flow                                         |
| \`max_flow_iterations\`      | \`number\`  | No       | Platform default | Maximum step transitions in a flow before forced exit                                               |
| \`voice_latency_target\`     | \`number\`  | No       | Platform default | Target latency in milliseconds for voice channel responses                                          |
| \`fallback_model\`           | \`string\`  | No       | _none_           | Model to use when the primary model is unavailable or errors                                        |
| \`enable_thinking\`          | \`boolean\` | No       | \`false\`          | Enable extended thinking (Anthropic Claude models)                                                  |
| \`thinking_budget\`          | \`number\`  | No       | Platform default | Token budget allocated to extended thinking                                                         |
| \`compaction_threshold\`     | \`number\`  | No       | Platform default | Context-usage ratio (0.0--1.0) that triggers auto-compaction                                        |`;
