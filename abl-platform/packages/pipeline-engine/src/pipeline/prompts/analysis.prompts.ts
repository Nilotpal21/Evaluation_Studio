/**
 * Analysis Prompts — Sentiment, Intent, and Mention extraction prompts.
 *
 * Extracted from compute-sentiment.service.ts, compute-intent.service.ts,
 * and compute-mentions.service.ts to centralize all LLM prompt text.
 */

// ---------------------------------------------------------------------------
// Sentiment
// ---------------------------------------------------------------------------

export const SENTIMENT_SYSTEM_PROMPT = `You are a sentiment analysis engine for customer service conversations.

For each message, assign a sentiment_score between -1.0 (very negative) and 1.0 (very positive), a sentiment_label (one of: very_negative, negative, neutral, positive, very_positive), and detect frustration signals.

Respond in JSON format:
{
  "scores": [
    {
      "index": 0,
      "sentiment_score": 0.5,
      "sentiment_label": "positive",
      "frustration_detected": false,
      "frustration_signals": []
    }
  ]
}

Frustration signals include: repeated questions, expressions of confusion, escalation requests, timeouts, explicit complaints, ALL CAPS, excessive punctuation, sarcasm.

Only score user and assistant messages. Skip system and tool messages.`;

export function buildSentimentUserPrompt(
  scorableMessages: Array<{ role: string; content: string }>,
): string {
  const messageList = scorableMessages.map((m, i) => `[${i}] ${m.role}: ${m.content}`).join('\n');
  return `Score the sentiment of each message in this conversation:\n\n${messageList}`;
}

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

export const INTENT_SYSTEM_PROMPT = `You are an intent classification engine for customer service conversations.

Given the user messages from a conversation, classify the primary intent. If multiple intents are present, identify the primary (most confident) intent and list secondary intents.

Respond in JSON format:
{
  "intent": "billing_refund",
  "intent_display": "Billing - Refund Request",
  "confidence": 0.92,
  "secondary_intents": [
    { "intent": "account_status", "confidence": 0.3 }
  ],
  "reasoning": "Brief explanation of why this intent was chosen"
}

Rules:
- intent should be a snake_case machine-readable label
- intent_display should be a human-readable name
- confidence is 0.0 to 1.0
- If the conversation doesn't clearly match any intent, use intent "unknown" with low confidence
- secondary_intents should only include intents with confidence > 0.2`;

export interface TaxonomyCategory {
  name?: string;
  category?: string;
  description?: string;
  intents?: string[];
  displayName?: string;
  examples?: string[];
  subCategories?: Array<{
    name: string;
    description?: string;
    displayName?: string;
  }>;
}

export function buildTaxonomyPrompt(taxonomy: TaxonomyCategory[]): string {
  const lines = taxonomy.map((cat) => {
    // Support both formats: { name, description } and { category, intents }
    const label = cat.name ?? cat.category ?? 'unknown';
    const detail = cat.description ?? (cat.intents ? cat.intents.join(', ') : '');
    let line = `- ${label}: ${detail}`;
    if (cat.examples && cat.examples.length > 0) {
      line += `\n  Examples: ${cat.examples.join('; ')}`;
    }
    if (cat.subCategories && cat.subCategories.length > 0) {
      const subs = cat.subCategories.map((s) => `${s.name} (${s.description ?? ''})`).join(', ');
      line += `\n  Sub-categories: ${subs}`;
    }
    return line;
  });

  return `\nClassify into one of these categories:\n${lines.join('\n')}\n\nIf the conversation does not match any category, use intent "other" or "unknown".`;
}

export function buildIntentUserPrompt(
  inputMessages: Array<{ role: string; content: string }>,
): string {
  const messageList = inputMessages.map((m, i) => `[${i}] ${m.role}: ${m.content}`).join('\n');
  return `Classify the intent of this conversation:\n\n${messageList}`;
}

// ---------------------------------------------------------------------------
// Intent Resolution
// ---------------------------------------------------------------------------

export const RESOLUTION_SYSTEM_PROMPT = `You are an intent resolution evaluator for customer service conversations.

Determine whether the user's primary intent was resolved by the end of the conversation.

Resolution status definitions:
- "resolved": The intent was fully satisfied. The user received a complete answer, confirmed solution, or a successful action was taken. Signals: agent explicitly confirms resolution, user acknowledges the problem is solved, outcome is clear and final.
- "partial": The intent was acknowledged and meaningful progress was made, but resolution is pending or incomplete. Signals: escalated to a specialist, callback or follow-up promised, ticket or case created, processing time given ("5-7 business days"), partial information provided without full closure.
- "unresolved": The intent was not meaningfully addressed. Signals: agent was unable to help, user repeated the same question multiple times with no useful answer, session ended abruptly without progress, user expressed ongoing frustration with no resolution.

Evaluation rules:
- Evaluate from the USER's perspective — was their actual need met?
- A polite conversation ending does not imply resolved. Check the substance, not the tone.
- "I will look into it" or "someone will call you back" = partial, not resolved.
- If uncertain between resolved and partial, prefer partial.
- If uncertain between partial and unresolved, prefer partial.

Respond with a single valid JSON object only — no markdown fences, no extra text:
{
  "resolution_status": "resolved" | "partial" | "unresolved",
  "resolution_confidence": <0.0 to 1.0>,
  "resolution_reason": "<one sentence, max 20 words>"
}`;

export function buildResolutionUserPrompt(
  messages: Array<{ role: string; content: string }>,
  primaryIntent: string,
  intentDisplay: string,
): string {
  const transcript = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role}]: ${m.content}`)
    .join('\n');

  return `Primary intent detected: ${primaryIntent} (${intentDisplay})\n\nFull conversation transcript:\n${transcript}\n\nEvaluate the resolution status of this primary intent.`;
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

export const MENTION_SYSTEM_PROMPT = `You are an analyst extracting structured mentions from customer conversations.
For each mention found, return a JSON array of objects with:
- type: one of "competitor", "feature_request", "bug_report", "channel_switch"
- text: the relevant quote or entity name (e.g. competitor name, feature name)
- detail: a brief description of what was requested, reported, or mentioned
- confidence: 0.0-1.0

Return only valid JSON. If no mentions found, return [].`;

export function buildMentionUserPrompt(
  conversationText: string,
  options?: { companyName?: string; competitors?: string[] },
): string {
  const parts: string[] = [`Analyze this conversation for mentions:\n\n${conversationText}`];

  if (options?.companyName) {
    parts.push(
      `\nIMPORTANT: "${options.companyName}" is the user's own company — do NOT flag it as a competitor.`,
    );
  }

  if (options?.competitors && options.competitors.length > 0) {
    parts.push(
      `\nKnown competitors to watch for: ${options.competitors.join(', ')}. Also detect any other competitors not in this list.`,
    );
  }

  return parts.join('');
}
