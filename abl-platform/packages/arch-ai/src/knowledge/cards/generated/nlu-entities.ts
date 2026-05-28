// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/nlu.mdx
// Regenerate: pnpm abl:docs:generate

export const NLU_ENTITIES_CARD = `## NLU, ENTITIES, MULTI_INTENT, LOOKUP_TABLES

# NLU (Natural Language Understanding)
- The \`NLU:\` block configures how the agent classifies user intent, extracts entities, resolves synonyms, and matches utterances.
## Overview
ABL's NLU configuration supports:
- **Intent classification** with keyword patterns and example utterances.
- **Entity extraction** with typed extractors (enum, pattern, location, date, number, free text).
- **Synonyms** for normalizing variant expressions to canonical values.
- **Embeddings-based matching** for semantic similarity when keyword patterns are insufficient.
- **Multi-language support** with per-language model configuration.
- **A glossary** for domain-specific terminology.
\`\`\`abl
NLU:
  intents:
    - NAME: send_wire
      PATTERNS: ["wire transfer", "send money", "wire funds"]
      EXAMPLES: ["I need to wire \$50,000 to Germany", "Can I send a domestic wire?"]

  entities:
    - NAME: currency_code
      TYPE: enum
      VALUES: [USD, EUR, GBP, JPY]
      SYNONYMS:
        USD: [dollars, usd, bucks]
        EUR: [euros, eur]

  glossary:
    - "SWIFT/BIC -- Code identifying a bank globally"
    - "Fedwire -- Federal Reserve real-time settlement system"
\`\`\`
## Intent classification
- Intents represent categories of user messages.
### Syntax
\`\`\`abl
NLU:
  intents:
    - NAME: book_flight
      PATTERNS: ["book flight", "find flights", "search flights", "fly to"]
      EXAMPLES:
        - "I want to fly to Paris next Tuesday"
        - "Find me a round trip to London"
        - "Book two seats on the morning flight to NYC"
      ENTITIES: [destination, travel_date, passenger_count]
\`\`\`
### Intent properties
| Property        | Type       | Required | Default | Description                                                                |
| --------------- | ---------- | -------- | ------- | -------------------------------------------------------------------------- |
| \`NAME\`          | \`string\`   | Yes      | --      | Unique intent identifier.                                                  |
| \`PATTERNS\`      | \`string[]\` | Yes      | --      | Keyword patterns for quick substring matching.                             |
| \`EXAMPLES\`      | \`string[]\` | No       | --      | Full example utterances for model-based classification. Improves accuracy. |
| \`EXAMPLES_FILE\` | \`string\`   | No       | --      | Path to an external file containing example utterances (one per line).     |
| \`ENTITIES\`      | \`string[]\` | No       | --      | Entity types expected to co-occur with this intent.                        |
### Pattern matching
- Patterns are matched as case-insensitive substrings against the user's message.
### Example-based classification
- When \`EXAMPLES\` are provided, the runtime uses an LLM or embedding model to classify messages based on semantic similarity to the examples.
### Intent with external examples file
For intents with many examples, reference an external file:
\`\`\`abl
NLU:
  intents:
    - NAME: product_inquiry
      PATTERNS: ["tell me about", "what is", "describe"]
      EXAMPLES_FILE: "./nlu/product_inquiry_examples.txt"
\`\`\`
## Entity extraction`;
