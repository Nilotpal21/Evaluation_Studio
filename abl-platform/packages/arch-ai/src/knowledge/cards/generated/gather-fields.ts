// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/gather.mdx, guides/data-collection-with-gather.mdx
// Regenerate: pnpm abl:docs:generate

export const GATHER_FIELDS_CARD = `## GATHER — Field Declaration & Extraction Pipeline

# GATHER (information collection)
- The \`GATHER:\` section defines structured information that the agent needs to collect from the user during a conversation.
## Syntax
At the top level of an agent document, \`GATHER:\` defines fields as named blocks:
\`\`\`abl
GATHER:
  source_account:
    prompt: "Which account would you like to use?"
    type: string
    required: true

  amount:
    prompt: "How much would you like to transfer?"
    type: number
    required: true
    validate: min(1)

  currency:
    prompt: "What currency?"
    type: string
    required: true
    default: "USD"
    infer: true
\`\`\`
- Within a \`FLOW:\` step, gather uses a different syntax.
## Field properties
| Property             | Type                                  | Required | Default      | Description                                                             |
| -------------------- | ------------------------------------- | -------- | ------------ | ----------------------------------------------------------------------- |
| \`prompt\`             | \`string\`                              | Yes      | --           | The question or instruction shown to the user to collect this field     |
| \`type\`               | \`string\`                              | No       | \`"string"\`   | Data type for the field value                                           |
| \`required\`           | \`boolean\`                             | No       | \`true\`       | Whether the field must be collected before proceeding                   |
| \`default\`            | \`any\`                                 | No       | _none_       | Default value used if the user does not provide one                     |
| \`validate\`           | \`string\`                              | No       | _none_       | Validation expression (see [Validation](#validation))                   |
| \`validation_process\` | \`"REGEX"\` \\| \`"CODE"\` \\| \`"LLM"\`      | No       | _none_       | How validation is performed                                             |
| \`retry_prompt\`       | \`string\`                              | No       | _none_       | Custom prompt shown when validation fails                               |
| \`max_retries\`        | \`number\`                              | No       | _none_       | Maximum validation retry attempts                                       |
| \`infer\`              | \`boolean\`                             | No       | \`false\`      | Allow the LLM to infer the value from context                           |
| \`infer_confidence\`   | \`number\`                              | No       | \`0.8\`        | Minimum confidence threshold for accepting inferred values (0.0--1.0)   |

### 4-Tier Extraction Pipeline
When a user message arrives during GATHER:
1. **Trivial-input skip** — "hi", "ok", single-char messages are short-circuited (saves ~1500 tokens).
2. **JS libs** — chrono-node, libphonenumber-js for dates, phones, currency.
3. **NLU sidecar** — embeddings-based entity resolver (enterprise only).
4. **LLM tool-call** — \`_extract_entities\` function call (~\$0.003/turn).
5. **Regex fallback** — fields with \`PATTERN:\` declaration.`;
