// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/agent-declaration.mdx
// Regenerate: pnpm abl:docs:generate

export const BEHAVIOR_PROFILES_CARD = `## BEHAVIOR_PROFILE — Deployment-Time Overrides

# Agent declaration
- The agent declaration establishes the identity, metadata, goals, personality, and execution configuration of an ABL agent document.
## AGENT keyword
- The \`AGENT:\` keyword declares the agent's name.
\`\`\`abl
AGENT: Wire_Transfer_Specialist
\`\`\`
### Naming rules
- Use \`PascalCase\` with underscores to separate words
- Must start with a letter
- May contain letters, digits, and underscores
- Must be unique within the system
### Examples
\`\`\`abl
AGENT: Hotel_Search
AGENT: Payment_Processor
AGENT: Customer_Support
AGENT: Fraud_Detection
\`\`\`
## VERSION
- The \`VERSION:\` directive specifies the semantic version of the agent document.
\`\`\`abl
VERSION: "2.0.0"
\`\`\`
| Property  | Type              | Required | Default   | Description                                    |
| --------- | ----------------- | -------- | --------- | ---------------------------------------------- |
| \`VERSION\` | \`string\` (semver) | No       | \`"1.0.0"\` | Document version in \`major.minor.patch\` format |
- The version is stored in the document's metadata (\`meta.
### Example
\`\`\`abl
AGENT: Booking_Agent
VERSION: "3.1.0"
\`\`\`
## DESCRIPTION
- The \`DESCRIPTION:\` directive provides a human-readable summary of the agent's purpose.
\`\`\`abl
DESCRIPTION: "Handles flight booking and modifications"
\`\`\`
\`\`\`abl
DESCRIPTION: |
  Processes outbound wire transfers for retail and commercial banking
  customers. Handles domestic (Fedwire) and international (SWIFT)
  transfers with full regulatory compliance.
\`\`\`
| Property      | Type     | Required | Default | Description                                   |
| ------------- | -------- | -------- | ------- | --------------------------------------------- |
| \`DESCRIPTION\` | \`string\` | No       | _none_  | Human-readable summary of the agent's purpose |
## LANGUAGE
- The \`LANGUAGE:\` directive sets the primary language the agent operates in.
\`\`\`abl
LANGUAGE: "en"
\`\`\`
\`\`\`abl
LANGUAGE: "es-EC"
\`\`\`
| Property   | Type     | Required | Default | Description                                            |
| ---------- | -------- | -------- | ------- | ------------------------------------------------------ |
| \`LANGUAGE\` | \`string\` | No       | _none_  | BCP 47 language code (e.g., \`"en"\`, \`"es-EC"\`, \`"fr"\`) |
- The language directive influences the runtime's language-aware behavior including NLU processing, response generation, and entity recognition.
## Complete declaration property reference
The following table summarizes all agent declaration properties:
| Property      | Type              | Required | Default   | Description                                        |
| ------------- | ----------------- | -------- | --------- | -------------------------------------------------- |
| \`AGENT\`       | \`string\`          | **Yes**  | --        | Unique agent name in \`PascalCase_With_Underscores\` |
| \`VERSION\`     | \`string\` (semver) | No       | \`"1.0.0"\` | Document version                                   |
| \`DESCRIPTION\` | \`string\`          | No       | _none_    | Human-readable description                         |`;
