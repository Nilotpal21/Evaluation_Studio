// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/guardrails.mdx, guides/safety-and-guardrails.mdx
// Regenerate: pnpm abl:docs:generate

export const GUARDRAILS_TIERS_CARD = `## GUARDRAILS — Three-Tier Safety System

# Guardrails
- Guardrails are safety checks that evaluate agent inputs and outputs to detect harmful, non-compliant, or malformed content.
## Overview
ABL guardrails use a three-tier evaluation model:
1. **CEL-based** (Tier 1) -- fast, deterministic expression checks.
2. **Model-based** (Tier 2) -- pre-trained safety classification models (e.g., OpenAI moderation).
3. **LLM-based** (Tier 3) -- natural language checks evaluated by an LLM.
- Each guardrail specifies an application point (when to check), exactly one executable rule (\`check\`, \`provider\`, or \`llm_check\`), and an action to take when that rule detects a violation.
\`\`\`abl
GUARDRAILS:
  profanity_filter:
    kind: input
    check: abl.matches_pattern(abl.lower(input), "(abusive|profane)")
    action: block
    message: "Your message was blocked. Please keep the conversation respectful."
    priority: 1

  pii_output_prevention:
    kind: output
    check: abl.contains_pii(output)
    action: redact
    message: "Sensitive information has been redacted."
    priority: 0
\`\`\`
## Application points
- The \`kind\` property determines when the guardrail is evaluated during the agent's processing pipeline.
| Kind          | Evaluation point                                                           |
| ------------- | -------------------------------------------------------------------------- |
| \`input\`       | Before the user's message reaches the LLM.                                 |
| \`output\`      | After the LLM generates a response, before it is sent to the user.         |
| \`both\`        | Evaluated on both input and output.                                        |
| \`tool_input\`  | Before parameters are sent to a tool call.                                 |
| \`tool_output\` | After a tool returns its result, before the result enters the LLM context. |
| \`handoff\`     | Before context is passed to another agent during a handoff.                |
## Guardrail properties
| Property             | Type      | Required | Default | Description                                                                                                                  |
| -------------------- | --------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| \`name\`               | \`string\`  | Yes      | --      | Unique identifier for the guardrail (the YAML key).                                                                          |
| \`kind\`               | \`string\`  | Yes      | --      | Application point. See [Application points](#application-points).                                                            |
| \`check\`              | \`string\`  | No       | --      | CEL violation predicate to evaluate locally. When it returns \`true\`, the guardrail fires. Omit for model-based or LLM-based. |
| \`action\`             | \`string\`  | Yes      | --      | Action when the guardrail fires. See [Actions](#actions).                                                                    |`;
