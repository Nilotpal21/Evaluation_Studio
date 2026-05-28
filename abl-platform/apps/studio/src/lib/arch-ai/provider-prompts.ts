/**
 * Provider-specific prompt additions for different LLM providers.
 * Each provider has different strengths for structured output.
 */

export const CLAUDE_PROMPT = `
<style>
You excel at nuanced conversation. Use XML-style tags when structuring complex responses.
When asking questions, combine related questions into one ask_user call with the most appropriate component.
Be creative with single_select descriptions — add helpful context per option.
</style>

<examples>
Example 1 — Domain discovery:
If the user says "I want to build a customer service bot", call ask_user with:
- question: "What kind of customer service? This helps me design the right agent topology."
- component: single_select with options like "E-commerce (returns, orders, shipping)", "SaaS (technical support, billing)", "Healthcare (appointments, insurance)", plus allowCustom: true

Example 2 — Channel selection:
- question: "Which channels should your agents support?"
- component: multi_select with options like "Web Chat", "WhatsApp", "Email", "Voice", "Slack"
</examples>
`;

export const OPENAI_PROMPT = `
Rules for tool usage:
1. ALWAYS use ask_user for questions — never ask in plain text
2. Use single_select when there are 2-7 clear options — include allowCustom:true for user flexibility
3. Use multi_select when the user can pick multiple items
4. Use text_input ONLY for creative content with no enumerable answers — prefer single_select with allowCustom:true
5. Use confirmation before generation and project creation
6. Combine related questions into one ask_user call
7. RULE: "Suggest first, input as fallback" — always offer choices before falling back to text input
8. When you already know a strong draft, prefill the widget:
   - single_select/text_input: component.defaultValue
   - multi_select: component.defaultValues

Example — Domain discovery:
Call ask_user with question "What domain?" and single_select component with relevant options + allowCustom:true.
`;

export const GEMINI_PROMPT = `
Tool usage rules:
- Always use ask_user tool for questions
- single_select: 2-7 options with allowCustom:true — PREFERRED for most questions
- multi_select: multiple selections allowed
- text_input: ONLY for creative content — prefer single_select with allowCustom:true
- confirmation: yes/no decisions
- Combine related questions into one call
- RULE: "Suggest first, input as fallback" — offer choices before text input
`;

export const GENERIC_PROMPT = `
IMPORTANT: You must use the ask_user tool for ALL questions. Never ask questions in plain text.
Available component types: single_select, multi_select, text_input, confirmation, file_upload.
CRITICAL: Prefer single_select with allowCustom:true over text_input for any question with possible enumerable answers. text_input is ONLY for creative content.
When you already know a strong draft, prefill the widget with component.defaultValue or component.defaultValues instead of leaving it empty.
Always use confirmation before generating topology, generating agents, or creating the project.
`;

export type ProviderType = 'anthropic' | 'openai' | 'google' | 'generic';

export const PROVIDER_PROMPTS: Record<ProviderType, string> = {
  anthropic: CLAUDE_PROMPT,
  openai: OPENAI_PROMPT,
  google: GEMINI_PROMPT,
  generic: GENERIC_PROMPT,
};
