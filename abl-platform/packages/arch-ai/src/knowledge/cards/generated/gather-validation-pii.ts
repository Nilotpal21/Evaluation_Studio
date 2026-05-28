// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/gather.mdx
// Regenerate: pnpm abl:docs:generate

export const GATHER_VALIDATION_PII_CARD = `## GATHER — Validation Modes & PII Handling

## Validation
The \`validate\` property defines a validation expression that the collected value must satisfy:
\`\`\`abl
GATHER:
  amount:
    prompt: "How much?"
    type: number
    required: true
    validate: min(1)

  email:
    prompt: "Your email address?"
    type: string
    required: true
    validate: email()

  transfer_type:
    prompt: "Domestic or international?"
    type: string
    required: true
    validate: enum(domestic, international)
\`\`\`
### Validation expressions
| Expression       | Description                      | Example                                   |
| ---------------- | -------------------------------- | ----------------------------------------- |
| \`min(n)\`         | Minimum numeric value            | \`validate: min(1)\`                        |
| \`max(n)\`         | Maximum numeric value            | \`validate: max(10000)\`                    |
| \`enum(a, b, c)\`  | Must be one of the listed values | \`validate: enum(domestic, international)\` |
| \`email()\`        | Must be a valid email format     | \`validate: email()\`                       |
| \`pattern(regex)\` | Must match a regex pattern       | \`validate: pattern(^\\d{9}\$)\`              |
### Validation process
The \`validation_process\` property controls how validation is executed:
| Value   | Description                                 |
| ------- | ------------------------------------------- |
| \`REGEX\` | Validate using a regular expression pattern |
| \`CODE\`  | Validate using a code expression            |
| \`LLM\`   | Validate using LLM judgment                 |
\`\`\`abl
GATHER:
  routing_number:
    prompt: "What is the ABA routing number?"
    type: string
    required: true
    validate: pattern(^\\d{9}\$)
    validation_process: REGEX
    retry_prompt: "That doesn't look like a valid 9-digit routing number. Please re-enter."
    max_retries: 3
\`\`\`
## Transient and sensitive fields
### Sensitive fields
Fields marked \`sensitive: true\` carry PII and receive special handling:
\`\`\`abl
GATHER:
  ssn_last4:
    prompt: "Last 4 digits of your Social Security Number?"
    type: string
    required: true
    sensitive: true
    sensitive_display: mask
    mask_config:
      showFirst: 0
      showLast: 4
      char: "*"
\`\`\`
### Sensitive display modes
| Mode      | Description                                | Example output |
| --------- | ------------------------------------------ | -------------- |
| \`redact\`  | Replace entire value with placeholder      | \`[REDACTED]\`   |
| \`mask\`    | Show partial value with masking characters | \`****1234\`     |
| \`replace\` | Replace with a generic description         | \`[SSN]\`        |
### Mask configuration
| Property    | Type     | Default | Description                               |
| ----------- | -------- | ------- | ----------------------------------------- |
| \`showFirst\` | \`number\` | \`0\`     | Number of characters to show at the start |
| \`showLast\`  | \`number\` | \`4\`     | Number of characters to show at the end   |
| \`char\`      | \`string\` | \`"*"\`   | Masking character                         |
### Transient fields`;
