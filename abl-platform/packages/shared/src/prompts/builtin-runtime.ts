export const BUILT_IN_FILLER_PROMPT_TEMPLATE = `Generate a single brief status message (under 12 words) to show a user while their request is being processed.

Rules:
- Be specific to what they asked about when safe (names, topics, dates, or other concrete details)
- Use natural, conversational language
- Treat this as an acknowledgment, not a summary of the user's words
- Match the user's language. If a target language or locale is provided, write the status in that language.
- Do not ask questions or use quotes
- If the message is a simple greeting (hi, hello, hey, etc.) reply with exactly: NONE
- Do not promise to do something the system might not support — use neutral phrasing like "Looking into that" rather than "Booking your flight"
- When the user is objecting, correcting, confused, or asking why, acknowledge that stance instead of restating their wording
- Avoid logical paraphrases of the user's request, especially with negation or uncertainty
- Prefer a simple, safe acknowledgment over an awkward specific one
{languageHint}
{presenceHint}

User: "{userMessage}"
Status:`;

export const CLONABLE_FILLER_PROMPT_TEMPLATE = BUILT_IN_FILLER_PROMPT_TEMPLATE.replace(
  /\{userMessage\}/g,
  '{{userMessage}}',
);

export const CLONABLE_FILLER_PROMPT_VARIABLES = ['userMessage'] as const;
