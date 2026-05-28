// Auto-generated from docs-internal MDX. Do not edit manually.
// Sources: abl-reference/rich-content-and-expressions.mdx
// Regenerate: pnpm abl:docs:generate

export const TOOL_TEMPLATES_CARD = `## Tool Templates — Placeholder Namespaces & Secrets Resolution

# Rich Content & Expressions
- This page documents two core ABL capabilities: rich content output formats (voice, cards, carousels, interactive actions, templates) and the expression language (operators, functions, template interpolation).
---
## Rich Content
- ABL supports multi-format output for delivering responses across different channels (web, mobile, voice, messaging platforms).
### Overview
A single response can include:
- **Plain text** -- the default \`RESPOND\` string.
- **Voice configuration** -- SSML markup or natural language voice instructions.
- **Rich content** -- Markdown, Adaptive Cards, HTML, Slack Block Kit, WhatsApp, or AG-UI.
- **Carousels** -- scrollable card collections with images and buttons.
- **Interactive actions** -- buttons, select menus, and input fields.
- **Templates** -- reusable named response definitions with interpolation.
The runtime selects the appropriate format based on the delivery channel.
### Voice configuration
- Voice configuration provides channel-specific voice output.
#### Syntax
\`\`\`abl
RESPOND: "Your booking is confirmed for December 15th."
VOICE:
  ssml: |
    <speak>
      Your booking is confirmed for <say-as interpret-as="date" format="mdy">12/15/2025</say-as>.
    </speak>
  instructions: "Speak in a warm, congratulatory tone"
  plain_text: "Your booking is confirmed for December fifteenth."
\`\`\`
#### Voice properties
| Property       | Type     | Required | Default | Description                                                                      |
| -------------- | -------- | -------- | ------- | -------------------------------------------------------------------------------- |
| \`ssml\`         | \`string\` | No       | --      | W3C SSML markup for TTS engines (Google, Azure, Amazon Polly).                   |
| \`instructions\` | \`string\` | No       | --      | Natural language voice style instructions (OpenAI Realtime, Gemini Live).        |
| \`plain_text\`   | \`string\` | No       | --      | Voice-optimized plaintext. Used by ElevenLabs and as a fallback for all engines. |
#### SSML example
\`\`\`abl
VOICE:
  ssml: |
    <speak>
      <prosody rate="slow" pitch="+2st">
        Your wire transfer of <say-as interpret-as="currency">\$50,000 USD</say-as>
        has been executed.
      </prosody>
      <break time="500ms"/>
      The confirmation number is
      <say-as interpret-as="characters">WR-2024-88431</say-as>.
    </speak>
\`\`\`
#### Natural language instructions
For voice platforms that accept style instructions rather than SSML:
\`\`\`abl
VOICE:
  instructions: "Speak slowly and clearly, emphasizing the confirmation number. Use a professional but warm tone."
\`\`\`
### Rich content formats
- The \`RICH_CONTENT:\` block provides format-specific variants of a response.
#### Syntax
\`\`\`abl
RESPOND: "Here are your flight options."
RICH_CONTENT:
  MARKDOWN: |
    ## Flight Options
    | Flight | Departure | Arrival | Price |
    |--------|-----------|---------|-------|
    | AA 142 | 8:00 AM   | 11:30 AM | \$349 |
    | UA 891 | 10:15 AM  | 1:45 PM  | \$289 |

  ADAPTIVE_CARD: |
    {
      "type": "AdaptiveCard",`;
