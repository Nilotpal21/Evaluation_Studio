/**
 * Pipeline Model Comparison — GPT-4.1 primary + 4 pipeline model candidates
 *
 * Primary: GPT-4.1
 * Pipeline candidates: GPT-4.1-nano, Claude 3.5 Haiku, Gemini 2.0 Flash, Qwen3-30B-A3B (self-hosted)
 *
 * All run Mode D (parallel + optimized) on both simple and complex scenarios.
 * Reports: avg turn latency, max turn latency, token cost.
 *
 * Run: OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GOOGLE_AI_API_KEY=... QWEN_API_KEY=... npx tsx apps/runtime/src/__tests__/pipeline-model-comparison.ts
 */

/* eslint-disable no-console */

// ─── Config ──────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY!;
const QWEN_API_KEY = process.env.QWEN_API_KEY!;

// Primary model
const PRIMARY_MODEL = 'gpt-4.1';
const PRIMARY_URL = 'https://api.openai.com/v1/chat/completions';

// Pricing ($ per 1M tokens)
interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const PRICING: Record<string, ModelPricing> = {
  'gpt-4.1': { inputPer1M: 2.0, outputPer1M: 8.0 },
  'gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'qwen3-a3b-30b-instruct': { inputPer1M: 0, outputPer1M: 0 }, // self-hosted
};

// Pipeline model configs
interface PipelineModel {
  name: string;
  modelId: string;
  call: (systemPrompt: string, userContent: string, maxTokens: number) => Promise<LLMResult>;
}

interface LLMResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface TurnResult {
  turn: number;
  userMessage: string;
  latencyMs: number;
  primaryPromptTokens: number;
  primaryCompletionTokens: number;
  pipelinePromptTokens: number;
  pipelineCompletionTokens: number;
  primaryCalls: number;
  pipelineCalls: number;
  toolsCalled: string[];
  finalResponse: string;
  toolsSentToPrimary: number;
}

interface ScenarioResult {
  pipelineModel: string;
  scenario: string;
  turns: TurnResult[];
  totals: {
    latencyMs: number;
    primaryPromptTokens: number;
    primaryCompletionTokens: number;
    pipelinePromptTokens: number;
    pipelineCompletionTokens: number;
    primaryCalls: number;
    pipelineCalls: number;
  };
  avgTurnLatencyMs: number;
  maxTurnLatencyMs: number;
  costUSD: number;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

function makeTools(): ToolDef[] {
  const handoffDesc = `Hand off the conversation to a specialist agent when the request requires specialized expertise you cannot provide.

Targets:
- billing_specialist: Complex billing disputes, payment processing errors, refund escalations
- technical_support: System bugs, outages, error messages, integration issues
- retention_specialist: Customer threatening to cancel, requesting discounts, expressing frustration
- account_security: Suspicious activity, unauthorized access, identity verification issues

Example usage:
{"target": "billing_specialist", "message": "Customer ABC-123 reports duplicate charge of $49.99 on Jan 15-16. Needs refund and investigation.", "context": {"account_id": "ABC-123", "issue": "duplicate_charge"}}`;

  return [
    {
      type: 'function',
      function: {
        name: 'check_account_balance',
        description:
          'Look up current account balance, billing status, and subscription details for a customer account.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'The customer account ID (e.g. ABC-123)' },
          },
          required: ['account_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_transaction_history',
        description:
          'Retrieve recent transactions for a customer account. Returns last 30 days by default.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'The customer account ID' },
            days: { type: 'number', description: 'Number of days to look back (default: 30)' },
          },
          required: ['account_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'process_refund',
        description:
          'Issue a refund for a specific transaction. Requires transaction ID and amount.',
        parameters: {
          type: 'object',
          properties: {
            transaction_id: { type: 'string', description: 'The transaction ID to refund' },
            amount: { type: 'number', description: 'Refund amount in dollars' },
          },
          required: ['transaction_id', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_subscription',
        description: 'Change a customer subscription plan, billing cycle, or payment method.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string', description: 'The customer account ID' },
            action: {
              type: 'string',
              enum: ['upgrade', 'downgrade', 'cancel', 'pause'],
              description: 'Subscription action',
            },
            plan: { type: 'string', description: 'Target plan name' },
          },
          required: ['account_id', 'action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: '__handoff__',
        description: handoffDesc,
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: [
                'billing_specialist',
                'technical_support',
                'retention_specialist',
                'account_security',
              ],
              description: 'Target agent',
            },
            message: { type: 'string', description: 'Summary for the target agent' },
            context: { type: 'object', description: 'Relevant context to pass' },
          },
          required: ['target', 'message'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'send_email_notification',
        description:
          'Send an email notification to the customer about an action taken on their account.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string' },
            template: {
              type: 'string',
              enum: ['refund_confirmation', 'subscription_change', 'ticket_created', 'general'],
            },
            details: { type: 'string', description: 'Additional details to include' },
          },
          required: ['account_id', 'template'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'lookup_knowledge_base',
        description: 'Search the help center knowledge base for relevant articles and FAQs.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            category: { type: 'string', enum: ['billing', 'technical', 'account', 'general'] },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_support_ticket',
        description: 'Create a support ticket for issues that need follow-up investigation.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string' },
            category: {
              type: 'string',
              enum: ['billing', 'technical', 'account', 'feature_request'],
            },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            description: { type: 'string' },
          },
          required: ['account_id', 'category', 'priority', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'verify_identity',
        description: 'Verify customer identity via security questions or email verification.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string' },
            method: { type: 'string', enum: ['security_questions', 'email_otp', 'sms_otp'] },
          },
          required: ['account_id', 'method'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_payment_methods',
        description: 'List all saved payment methods for a customer account.',
        parameters: {
          type: 'object',
          properties: { account_id: { type: 'string' } },
          required: ['account_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'apply_discount_code',
        description: 'Apply a promotional discount code to a customer account.',
        parameters: {
          type: 'object',
          properties: { account_id: { type: 'string' }, discount_code: { type: 'string' } },
          required: ['account_id', 'discount_code'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_callback',
        description: 'Schedule a callback from the support team to the customer.',
        parameters: {
          type: 'object',
          properties: {
            account_id: { type: 'string' },
            preferred_time: { type: 'string', description: 'Preferred callback time (ISO format)' },
            topic: { type: 'string' },
          },
          required: ['account_id', 'topic'],
        },
      },
    },
  ];
}

const SYSTEM_PROMPT = `You are a customer service agent for TechCo, a SaaS platform.

## Your Role
Help customers with billing, account, and subscription inquiries.

## Guidelines
- Always verify the customer's identity before accessing or modifying their account
- Be concise and helpful
- Use tools to look up information before answering
- Do NOT repeat actions you have already completed in this conversation
- If a request is outside your expertise, hand off to a specialist`;

// ─── Tool Simulator ──────────────────────────────────────────────────────────

function simulateToolResult(toolName: string, args: Record<string, unknown>): string {
  const results: Record<string, () => string> = {
    check_account_balance: () =>
      JSON.stringify({
        account_id: args.account_id,
        balance: 0,
        subscription: {
          plan: 'Pro',
          status: 'active',
          monthly_cost: 49.99,
          next_billing: '2026-02-15',
        },
        payment_method: { type: 'credit_card', last4: '4242' },
      }),
    get_transaction_history: () =>
      JSON.stringify({
        transactions: [
          {
            id: 'TXN-001',
            date: '2026-01-15',
            amount: 49.99,
            description: 'Pro Plan - Monthly',
            status: 'completed',
          },
          {
            id: 'TXN-002',
            date: '2026-01-16',
            amount: 49.99,
            description: 'Pro Plan - Monthly',
            status: 'completed',
          },
          {
            id: 'TXN-003',
            date: '2025-12-15',
            amount: 49.99,
            description: 'Pro Plan - Monthly',
            status: 'completed',
          },
        ],
      }),
    process_refund: () =>
      JSON.stringify({
        success: true,
        refund_id: 'REF-789',
        amount: args.amount,
        estimated_days: 3,
      }),
    verify_identity: () => JSON.stringify({ verified: true, method: args.method }),
    create_support_ticket: () =>
      JSON.stringify({ ticket_id: 'ST-4521', status: 'open', priority: args.priority }),
    send_email_notification: () => JSON.stringify({ sent: true, template: args.template }),
    update_subscription: () =>
      JSON.stringify({
        success: true,
        new_plan: args.plan || 'Basic',
        effective_date: '2026-02-01',
      }),
    lookup_knowledge_base: () =>
      JSON.stringify({
        articles: [{ title: 'How to cancel subscription', url: '/help/cancel', relevance: 0.9 }],
      }),
    get_payment_methods: () =>
      JSON.stringify({
        methods: [
          { type: 'credit_card', last4: '4242', default: true },
          { type: 'credit_card', last4: '8888', default: false },
        ],
      }),
    apply_discount_code: () =>
      JSON.stringify({
        success: true,
        discount_code: args.discount_code,
        discount_percent: 20,
        new_monthly_cost: 39.99,
        applied_to_plan: 'Pro',
      }),
    schedule_callback: () =>
      JSON.stringify({
        success: true,
        callback_id: 'CB-1234',
        preferred_time: args.preferred_time,
        topic: args.topic,
      }),
    __handoff__: () => JSON.stringify({ success: true, handed_off_to: args.target }),
  };
  return (results[toolName] ?? (() => JSON.stringify({ result: 'ok' })))();
}

// ─── API Callers ─────────────────────────────────────────────────────────────

async function callPrimary(
  messages: Message[],
  tools: ToolDef[],
): Promise<{ message: any; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const start = performance.now();
  const resp = await fetch(PRIMARY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: PRIMARY_MODEL, messages, tools, temperature: 0.1 }),
  });
  const data = (await resp.json()) as any;
  if (data.error) throw new Error(`Primary (${PRIMARY_MODEL}): ${data.error.message}`);
  return {
    message: data.choices[0].message,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    latencyMs: Math.round(performance.now() - start),
  };
}

const QWEN_URL = 'http://54.163.62.233:8000/v1/chat/completions';
const QWEN_MODEL = 'qwen3-a3b-30b-instruct';

async function callQwenReasoning(
  messages: Message[],
  tools: ToolDef[],
): Promise<{ message: any; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const start = performance.now();
  const resp = await fetch(QWEN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: QWEN_MODEL, messages, tools, temperature: 0.1 }),
  });
  const data = (await resp.json()) as any;
  if (data.error) throw new Error(`Qwen reasoning: ${data.error.message}`);
  return {
    message: data.choices[0].message,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    latencyMs: Math.round(performance.now() - start),
  };
}

// OpenAI-compatible caller (for GPT-4.1-nano, Qwen)
function makeOpenAICaller(url: string, apiKey: string, model: string): PipelineModel['call'] {
  return async (
    systemPrompt: string,
    userContent: string,
    maxTokens: number,
  ): Promise<LLMResult> => {
    const start = performance.now();
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
      }),
    });
    const data = (await resp.json()) as any;
    if (data.error) throw new Error(`${model}: ${data.error.message}`);
    return {
      content: data.choices[0].message.content,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      latencyMs: Math.round(performance.now() - start),
    };
  };
}

// Anthropic Messages API caller
function makeAnthropicCaller(model: string): PipelineModel['call'] {
  return async (
    systemPrompt: string,
    userContent: string,
    maxTokens: number,
  ): Promise<LLMResult> => {
    const start = performance.now();
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
        max_tokens: maxTokens,
        temperature: 0.1,
      }),
    });
    const data = (await resp.json()) as any;
    if (data.error) throw new Error(`Anthropic ${model}: ${data.error.message}`);
    const content = data.content?.[0]?.text ?? '';
    return {
      content,
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      latencyMs: Math.round(performance.now() - start),
    };
  };
}

// Google Gemini caller (native generateContent API)
function makeGeminiCaller(model: string): PipelineModel['call'] {
  return async (
    systemPrompt: string,
    userContent: string,
    maxTokens: number,
  ): Promise<LLMResult> => {
    const start = performance.now();
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_AI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userContent }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
        }),
      },
    );
    const data = (await resp.json()) as any;
    if (data.error) throw new Error(`Gemini ${model}: ${data.error.message}`);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
    return {
      content: text,
      promptTokens,
      completionTokens,
      latencyMs: Math.round(performance.now() - start),
    };
  };
}

// ─── Pipeline Models ─────────────────────────────────────────────────────────

const PIPELINE_MODELS: PipelineModel[] = [
  {
    name: 'GPT-4.1-nano',
    modelId: 'gpt-4.1-nano',
    call: makeOpenAICaller(
      'https://api.openai.com/v1/chat/completions',
      OPENAI_API_KEY,
      'gpt-4.1-nano',
    ),
  },
  {
    name: 'Claude Haiku 4.5',
    modelId: 'claude-haiku-4-5-20251001',
    call: makeAnthropicCaller('claude-haiku-4-5-20251001'),
  },
  {
    name: 'Gemini 2.5 Flash',
    modelId: 'gemini-2.5-flash',
    call: makeGeminiCaller('gemini-2.5-flash'),
  },
  {
    name: 'Qwen3-30B (self-hosted)',
    modelId: 'qwen3-a3b-30b-instruct',
    call: makeOpenAICaller(
      'http://54.163.62.233:8000/v1/chat/completions',
      QWEN_API_KEY,
      'qwen3-a3b-30b-instruct',
    ),
  },
];

// ─── Scenarios ───────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  turns: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Simple: Account Balance Check (4 turns)',
    turns: [
      'Hi, can you check the balance on my account ABC-123?',
      "Sure, let's do email verification.",
      'What subscription plan am I on?',
      "Thanks, that's all I needed.",
    ],
  },
  {
    name: 'Complex: Billing Dispute + Downgrade (5 turns)',
    turns: [
      'I was charged twice for my subscription last month. My account is ABC-123.',
      'Yes I verified via email. Can you refund the duplicate charge?',
      'Can you also make sure this does not happen again? And send me a confirmation email.',
      "Actually I'm so frustrated with these billing issues. I want to downgrade to the Basic plan.",
      "Yes, downgrade me to Basic. I've already verified my identity.",
    ],
  },
  // ── Stress-test scenarios ──
  {
    name: 'Stress 1: Multi-Step Reasoning (6 turns)',
    // Tests: conditional refund logic, partial refund calculation, cross-referencing transaction data
    turns: [
      'My account is XYZ-789. I verified via email. I see three charges on my account last month — can you pull my transaction history and tell me which ones look like duplicates?',
      'Ok, so TXN-001 and TXN-002 are both $49.99 on consecutive days — that looks like a duplicate. But only refund the second one, TXN-002. And before you process it, check my current balance first so I know what to expect after the refund.',
      "Good. Now here's the tricky part: I also want to downgrade from Pro to Basic, but ONLY if my next billing date is more than 7 days away. If it's within 7 days, just pause my subscription instead. Can you check and decide?",
      'Actually wait — before you do that subscription change, apply discount code SAVE20 first. If the discount applies successfully, then cancel the downgrade and keep me on Pro. If it fails, proceed with whatever you decided in the last step.',
      'Ok one more thing — create a high priority support ticket summarizing everything we did today: the duplicate refund for TXN-002, the discount code attempt, and whatever happened with my subscription. Then email me a confirmation.',
      'Perfect, thanks for handling all of that.',
    ],
  },
  {
    name: 'Stress 2: Complex Tool Arguments (5 turns)',
    // Tests: constructing detailed tool arguments, correct enum values, nested context objects
    turns: [
      "I'm account DEF-456, verified via SMS. I need you to do several things in sequence: first check my payment methods, then look up my transaction history for the last 90 days, not the default 30.",
      "Now I need a support ticket created — category should be 'billing', priority 'critical', and the description should reference the specific transaction IDs you just found and explain that I'm disputing all charges over $40 in the last 90 days.",
      'Hand this off to billing_specialist. In the handoff message, include a detailed summary: my account ID, the transaction IDs in dispute, the total disputed amount, and that a critical ticket ST-4521 was already created. Pass the ticket ID and disputed transactions in the context object.',
      "Wait actually one more thing before the handoff — schedule a callback for me. Topic should be 'Follow-up on billing dispute DEF-456, ticket ST-4521, disputing TXN-001 TXN-002 TXN-003'. Preferred time tomorrow at 2pm EST, so 2026-03-07T14:00:00-05:00.",
      'Ok now do the handoff with all that info including the callback reference.',
    ],
  },
  {
    name: 'Stress 3: Ambiguous Intent + Edge Cases (6 turns)',
    // Tests: handling ambiguity, contradictions, implicit requests, unclear references
    turns: [
      "Hey, something weird is happening with my account. Not sure if it's a billing thing or a technical thing. Account GHI-012, verified already.",
      "I think I'm being charged for features I don't have access to? Or maybe my plan was changed without me knowing. Can you figure out what's going on?",
      'Hmm ok so it says Pro plan at $49.99 but I definitely signed up for Basic at $19.99. I never authorized an upgrade. Is this something you can fix or do I need to talk to someone else?',
      "Actually you know what, I don't want to deal with this over chat. Can you have someone call me? But also file a ticket in case the callback doesn't happen. Oh and I want both billing AND account_security to know about this since it might be unauthorized access.",
      'Hold on — can you also check if there are any knowledge base articles about unauthorized plan changes? I want to understand my rights before the callback.',
      'Ok thanks. To confirm: you created the ticket, scheduled the callback, looked up the KB, and will hand off to security? Did I miss anything?',
    ],
  },
  {
    name: 'Stress 4: Long Context Window (8 turns)',
    // Tests: maintaining coherence over many turns, referencing earlier conversation details accurately
    turns: [
      "Account JKL-345, verified via email. First, what's my current balance and subscription status?",
      'Ok. Now pull my last 30 days of transactions. I want to review each one.',
      'I see TXN-001 for $49.99 and TXN-002 for $49.99. Let me check my payment methods too — I want to make sure the charges went to the right card.',
      'Alright, now refund TXN-002 specifically — amount $49.99, transaction ID TXN-002. And email me a refund confirmation.',
      'Now I want to upgrade to... actually no, let me think. What was my current plan again? And what was the refund ID you just got?',
      "Right, Pro plan at $49.99. Ok, I'll stay on Pro for now. But apply discount code LOYALTY50 to my account.",
      'Now create a ticket documenting everything we discussed today. In the description, mention: my original balance check, the duplicate TXN-002 refund (include the refund ID from earlier), the discount code application, and that I decided to stay on Pro. Priority medium, category billing.',
      'Great. One last thing — what was the estimated refund processing time you mentioned earlier? And what card is it going back to?',
    ],
  },
];

// ─── Truncation ──────────────────────────────────────────────────────────────

function truncateOldToolResults(messages: Message[], keepLastN: number): Message[] {
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolResultIndices.push(i);
  }
  if (toolResultIndices.length <= keepLastN) return messages;
  const truncateUpTo = toolResultIndices[toolResultIndices.length - keepLastN];
  return messages.map((m, i) => {
    if (m.role === 'tool' && i < truncateUpTo)
      return { ...m, content: '[Result truncated — tool executed successfully]' };
    return m;
  });
}

// ─── Pipeline Helpers ────────────────────────────────────────────────────────

async function classify(
  pipelineCall: PipelineModel['call'],
  userMessage: string,
  multiTurnContext: string,
): Promise<{ needsHandoff: boolean; target: string | null; confidence: number } & LLMResult> {
  const r = await pipelineCall(
    `You are a routing classifier. Determine if the user message needs a specialist or if a general customer service agent can handle it. Output ONLY valid JSON, no other text: {"needs_handoff": bool, "target": string|null, "confidence": 0-1, "reasoning": string}.

Specialists (ONLY route here for complex cases the general agent cannot handle):
- billing_specialist: Complex billing disputes, payment processing ERRORS, refund ESCALATIONS
- technical_support: System bugs, outages, error messages
- retention_specialist: Customer threatening to cancel, requesting special discounts
- account_security: Suspicious activity, unauthorized access

The general agent CAN handle: account lookups, simple refunds, subscription changes, sending emails, creating tickets. Do NOT route these to specialists.

Recent conversation context:
${multiTurnContext}`,
    userMessage,
    150,
  );
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = r.content.match(/\{[\s\S]*\}/);
    const p = JSON.parse(jsonMatch ? jsonMatch[0] : r.content);
    return { needsHandoff: p.needs_handoff, target: p.target, confidence: p.confidence, ...r };
  } catch {
    return { needsHandoff: false, target: null, confidence: 0, ...r };
  }
}

async function filterTools(
  pipelineCall: PipelineModel['call'],
  context: string,
  allTools: ToolDef[],
): Promise<{ tools: ToolDef[] } & LLMResult> {
  const toolList = allTools
    .map((t) => `- ${t.function.name}: ${t.function.description.split('.')[0]}`)
    .join('\n');
  const r = await pipelineCall(
    `Select 2-5 most relevant tools for the next agent step. If no tools are needed (e.g. farewell, thanks), return {"tools": []}. Return ONLY valid JSON, no other text: {"tools": ["name1", "name2"]}\n\nAvailable:\n${toolList}`,
    context,
    100,
  );
  try {
    const jsonMatch = r.content.match(/\{[\s\S]*\}/);
    const p = JSON.parse(jsonMatch ? jsonMatch[0] : r.content);
    if (p.tools.length === 0) return { tools: [], ...r };
    const names = new Set(p.tools as string[]);
    const filtered = allTools.filter((t) => names.has(t.function.name));
    return { tools: filtered.length >= 2 ? filtered : allTools, ...r };
  } catch {
    return { tools: allTools, ...r };
  }
}

// ─── Reasoning Loop ──────────────────────────────────────────────────────────

async function reasoningLoop(
  messages: Message[],
  tools: ToolDef[],
): Promise<{
  primaryCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolsCalled: string[];
  finalResponse: string;
}> {
  let primaryCalls = 0,
    promptTokens = 0,
    completionTokens = 0,
    latencyMs = 0;
  const toolsCalled: string[] = [];
  let finalResponse = '';

  for (let i = 0; i < 10; i++) {
    const callMessages = truncateOldToolResults(messages, 2);
    const r = await callPrimary([...callMessages], tools);
    primaryCalls++;
    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    latencyMs += r.latencyMs;

    if (r.message.tool_calls?.length > 0) {
      messages.push(r.message);
      for (const tc of r.message.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        toolsCalled.push(tc.function.name);
        const result = simulateToolResult(tc.function.name, args);
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
        if (tc.function.name === '__handoff__') {
          finalResponse = `[Handed off to ${args.target}]: ${args.message ?? ''}`;
          return {
            primaryCalls,
            promptTokens,
            completionTokens,
            latencyMs,
            toolsCalled,
            finalResponse,
          };
        }
      }
    } else {
      finalResponse = r.message.content ?? '';
      break;
    }
  }
  return { primaryCalls, promptTokens, completionTokens, latencyMs, toolsCalled, finalResponse };
}

// ─── Run Mode D (Parallel + Optimized) ──────────────────────────────────────

async function runModeD(pipelineModel: PipelineModel, scenario: Scenario): Promise<ScenarioResult> {
  const tools = makeTools();
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnResult[] = [];
  const totals = {
    latencyMs: 0,
    primaryPromptTokens: 0,
    primaryCompletionTokens: 0,
    pipelinePromptTokens: 0,
    pipelineCompletionTokens: 0,
    primaryCalls: 0,
    pipelineCalls: 0,
  };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });

    const multiTurnCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 150)}`)
      .join('\n');
    const filterCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');

    // PARALLEL: classify + tool filter
    const parallelStart = performance.now();
    const [c, f] = await Promise.all([
      classify(pipelineModel.call, userMsg, multiTurnCtx),
      filterTools(pipelineModel.call, filterCtx, tools),
    ]);
    const parallelLatency = Math.round(performance.now() - parallelStart);

    totals.pipelinePromptTokens += c.promptTokens + f.promptTokens;
    totals.pipelineCompletionTokens += c.completionTokens + f.completionTokens;
    totals.pipelineCalls += 2;

    if (c.needsHandoff && c.confidence >= 0.85) {
      totals.latencyMs += parallelLatency;
      messages.push({ role: 'assistant', content: `[Handed off to ${c.target}]` });
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        latencyMs: parallelLatency,
        primaryPromptTokens: 0,
        primaryCompletionTokens: 0,
        pipelinePromptTokens: c.promptTokens + f.promptTokens,
        pipelineCompletionTokens: c.completionTokens + f.completionTokens,
        primaryCalls: 0,
        pipelineCalls: 2,
        toolsCalled: ['__handoff__ (short-circuit)'],
        finalResponse: `[Short-circuit → ${c.target}]`,
        toolsSentToPrimary: 0,
      });
      continue;
    }

    const useTools = f.tools.length > 0 ? f.tools : tools;
    const r = await reasoningLoop([...messages], useTools);
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    const turnLatency = parallelLatency + r.latencyMs;
    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      latencyMs: turnLatency,
      primaryPromptTokens: r.promptTokens,
      primaryCompletionTokens: r.completionTokens,
      pipelinePromptTokens: c.promptTokens + f.promptTokens,
      pipelineCompletionTokens: c.completionTokens + f.completionTokens,
      primaryCalls: r.primaryCalls,
      pipelineCalls: 2,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToPrimary: useTools.length,
    });
    totals.latencyMs += turnLatency;
    totals.primaryPromptTokens += r.promptTokens;
    totals.primaryCompletionTokens += r.completionTokens;
    totals.primaryCalls += r.primaryCalls;
  }

  // Compute cost
  const primaryPricing = PRICING[PRIMARY_MODEL];
  const pipelinePricing = PRICING[pipelineModel.modelId];
  const costUSD =
    (totals.primaryPromptTokens / 1_000_000) * primaryPricing.inputPer1M +
    (totals.primaryCompletionTokens / 1_000_000) * primaryPricing.outputPer1M +
    (totals.pipelinePromptTokens / 1_000_000) * pipelinePricing.inputPer1M +
    (totals.pipelineCompletionTokens / 1_000_000) * pipelinePricing.outputPer1M;

  const turnLatencies = turns.map((t) => t.latencyMs);
  const avgTurnLatencyMs = Math.round(
    turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length,
  );
  const maxTurnLatencyMs = Math.max(...turnLatencies);

  return {
    pipelineModel: pipelineModel.name,
    scenario: scenario.name,
    turns,
    totals,
    avgTurnLatencyMs,
    maxTurnLatencyMs,
    costUSD,
  };
}

// ─── Baseline (no pipeline) ──────────────────────────────────────────────────

async function runBaseline(scenario: Scenario): Promise<ScenarioResult> {
  const tools = makeTools();
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnResult[] = [];
  const totals = {
    latencyMs: 0,
    primaryPromptTokens: 0,
    primaryCompletionTokens: 0,
    pipelinePromptTokens: 0,
    pipelineCompletionTokens: 0,
    primaryCalls: 0,
    pipelineCalls: 0,
  };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });

    const r = await reasoningLoop([...messages], tools);
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      latencyMs: r.latencyMs,
      primaryPromptTokens: r.promptTokens,
      primaryCompletionTokens: r.completionTokens,
      pipelinePromptTokens: 0,
      pipelineCompletionTokens: 0,
      primaryCalls: r.primaryCalls,
      pipelineCalls: 0,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToPrimary: tools.length,
    });
    totals.latencyMs += r.latencyMs;
    totals.primaryPromptTokens += r.promptTokens;
    totals.primaryCompletionTokens += r.completionTokens;
    totals.primaryCalls += r.primaryCalls;
  }

  const primaryPricing = PRICING[PRIMARY_MODEL];
  const costUSD =
    (totals.primaryPromptTokens / 1_000_000) * primaryPricing.inputPer1M +
    (totals.primaryCompletionTokens / 1_000_000) * primaryPricing.outputPer1M;

  const turnLatencies = turns.map((t) => t.latencyMs);
  const avgTurnLatencyMs = Math.round(
    turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length,
  );
  const maxTurnLatencyMs = Math.max(...turnLatencies);

  return {
    pipelineModel: 'NONE (Baseline)',
    scenario: scenario.name,
    turns,
    totals,
    avgTurnLatencyMs,
    maxTurnLatencyMs,
    costUSD,
  };
}

// ─── Qwen Full (Qwen for pipeline + reasoning) ─────────────────────────────

function reasoningLoopQwen(
  messages: Message[],
  tools: ToolDef[],
): Promise<{
  primaryCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolsCalled: string[];
  finalResponse: string;
}> {
  return (async () => {
    let primaryCalls = 0,
      promptTokens = 0,
      completionTokens = 0,
      latencyMs = 0;
    const toolsCalled: string[] = [];
    let finalResponse = '';

    for (let i = 0; i < 10; i++) {
      const callMessages = truncateOldToolResults(messages, 2);
      const r = await callQwenReasoning([...callMessages], tools);
      primaryCalls++;
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
      latencyMs += r.latencyMs;

      if (r.message.tool_calls?.length > 0) {
        messages.push(r.message);
        for (const tc of r.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments);
          toolsCalled.push(tc.function.name);
          const result = simulateToolResult(tc.function.name, args);
          messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
          if (tc.function.name === '__handoff__') {
            finalResponse = `[Handed off to ${args.target}]: ${args.message ?? ''}`;
            return {
              primaryCalls,
              promptTokens,
              completionTokens,
              latencyMs,
              toolsCalled,
              finalResponse,
            };
          }
        }
      } else {
        finalResponse = r.message.content ?? '';
        break;
      }
    }
    return { primaryCalls, promptTokens, completionTokens, latencyMs, toolsCalled, finalResponse };
  })();
}

async function runQwenFull(scenario: Scenario): Promise<ScenarioResult> {
  const qwenPipeline = PIPELINE_MODELS.find((m) => m.modelId === QWEN_MODEL)!;
  const tools = makeTools();
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnResult[] = [];
  const totals = {
    latencyMs: 0,
    primaryPromptTokens: 0,
    primaryCompletionTokens: 0,
    pipelinePromptTokens: 0,
    pipelineCompletionTokens: 0,
    primaryCalls: 0,
    pipelineCalls: 0,
  };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });

    const multiTurnCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 150)}`)
      .join('\n');
    const filterCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');

    // PARALLEL: classify + tool filter (Qwen)
    const parallelStart = performance.now();
    const [c, f] = await Promise.all([
      classify(qwenPipeline.call, userMsg, multiTurnCtx),
      filterTools(qwenPipeline.call, filterCtx, tools),
    ]);
    const parallelLatency = Math.round(performance.now() - parallelStart);

    totals.pipelinePromptTokens += c.promptTokens + f.promptTokens;
    totals.pipelineCompletionTokens += c.completionTokens + f.completionTokens;
    totals.pipelineCalls += 2;

    if (c.needsHandoff && c.confidence >= 0.85) {
      totals.latencyMs += parallelLatency;
      messages.push({ role: 'assistant', content: `[Handed off to ${c.target}]` });
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        latencyMs: parallelLatency,
        primaryPromptTokens: 0,
        primaryCompletionTokens: 0,
        pipelinePromptTokens: c.promptTokens + f.promptTokens,
        pipelineCompletionTokens: c.completionTokens + f.completionTokens,
        primaryCalls: 0,
        pipelineCalls: 2,
        toolsCalled: ['__handoff__ (short-circuit)'],
        finalResponse: `[Short-circuit → ${c.target}]`,
        toolsSentToPrimary: 0,
      });
      continue;
    }

    // REASONING: Qwen (not GPT-4.1)
    const useTools = f.tools.length > 0 ? f.tools : tools;
    const r = await reasoningLoopQwen([...messages], useTools);
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    const turnLatency = parallelLatency + r.latencyMs;
    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      latencyMs: turnLatency,
      primaryPromptTokens: r.promptTokens,
      primaryCompletionTokens: r.completionTokens,
      pipelinePromptTokens: c.promptTokens + f.promptTokens,
      pipelineCompletionTokens: c.completionTokens + f.completionTokens,
      primaryCalls: r.primaryCalls,
      pipelineCalls: 2,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToPrimary: useTools.length,
    });
    totals.latencyMs += turnLatency;
    totals.primaryPromptTokens += r.promptTokens;
    totals.primaryCompletionTokens += r.completionTokens;
    totals.primaryCalls += r.primaryCalls;
  }

  // Cost: Qwen for everything = $0 (self-hosted)
  const costUSD = 0;
  const turnLatencies = turns.map((t) => t.latencyMs);
  const avgTurnLatencyMs = Math.round(
    turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length,
  );
  const maxTurnLatencyMs = Math.max(...turnLatencies);

  return {
    pipelineModel: 'Qwen3-30B FULL (pipeline+reasoning)',
    scenario: scenario.name,
    turns,
    totals,
    avgTurnLatencyMs,
    maxTurnLatencyMs,
    costUSD,
  };
}

// ─── Approach A: Response Verification Loop ─────────────────────────────────

// Action verbs that indicate the user wants in-agent execution, not routing
const ACTION_VERBS = [
  'create',
  'file',
  'schedule',
  'apply',
  'refund',
  'send',
  'email',
  'check',
  'look up',
  'pull',
  'update',
  'downgrade',
  'upgrade',
  'cancel',
  'pause',
];

// Detect tool hallucination: response claims action but no tool calls
function detectToolHallucination(
  responseText: string,
  toolsCalled: string[],
  availableTools: ToolDef[],
): { detected: boolean; claimedActions: string[] } {
  const claimedActions: string[] = [];
  const actionPatterns = [
    /I(?:'ve| have) (?:applied|processed|created|scheduled|sent|refunded|updated|canceled|paused|upgraded|downgraded)\b/gi,
    /(?:has been|was) (?:applied|processed|created|scheduled|sent|refunded|updated|canceled|paused)\b/gi,
    /(?:successfully|already) (?:applied|processed|created|scheduled|sent|refunded|updated)\b/gi,
  ];
  for (const pat of actionPatterns) {
    const matches = responseText.match(pat);
    if (matches) claimedActions.push(...matches);
  }
  // If response claims actions but no tools were called, that's hallucination
  if (claimedActions.length > 0 && toolsCalled.length === 0) {
    return { detected: true, claimedActions };
  }
  // Also check: claims specific tool outcomes without calling the tool
  const toolActionMap: Record<string, RegExp[]> = {
    apply_discount_code: [
      /discount.*applied/i,
      /code.*applied/i,
      /applied.*discount/i,
      /applied.*code/i,
    ],
    create_support_ticket: [/ticket.*created/i, /created.*ticket/i, /filed.*ticket/i],
    process_refund: [/refund.*processed/i, /processed.*refund/i, /issued.*refund/i],
    schedule_callback: [/callback.*scheduled/i, /scheduled.*callback/i, /call.*scheduled/i],
    send_email_notification: [/email.*sent/i, /sent.*email/i, /notification.*sent/i],
    update_subscription: [
      /subscription.*updated/i,
      /downgraded/i,
      /upgraded/i,
      /paused.*subscription/i,
    ],
  };
  for (const [toolName, patterns] of Object.entries(toolActionMap)) {
    if (!toolsCalled.includes(toolName)) {
      for (const pat of patterns) {
        if (pat.test(responseText)) {
          claimedActions.push(`Claims ${toolName} without calling it`);
          return { detected: true, claimedActions };
        }
      }
    }
  }
  return { detected: false, claimedActions: [] };
}

// Detect over-routing: classifier wants to route but user explicitly requests in-agent action
function detectOverRouting(
  userMessage: string,
  classifierResult: { needsHandoff: boolean; target: string | null; confidence: number },
  availableTools: ToolDef[],
): boolean {
  if (!classifierResult.needsHandoff) return false;
  const lowerMsg = userMessage.toLowerCase();
  // Check if user explicitly requests an action that maps to a tool
  const toolKeywords: Record<string, string[]> = {
    create_support_ticket: ['create a ticket', 'file a ticket', 'open a ticket', 'support ticket'],
    schedule_callback: ['schedule a callback', 'have someone call', 'call me back'],
    process_refund: ['refund', 'process the refund', 'issue a refund'],
    apply_discount_code: ['apply discount', 'apply code', 'discount code'],
    send_email_notification: ['send me an email', 'email me', 'send a confirmation'],
    update_subscription: ['downgrade', 'upgrade', 'cancel my', 'pause my'],
    lookup_knowledge_base: ['knowledge base', 'kb articles', 'help articles'],
  };
  for (const [_toolName, keywords] of Object.entries(toolKeywords)) {
    for (const kw of keywords) {
      if (lowerMsg.includes(kw)) return true; // User wants in-agent action, don't route
    }
  }
  return false;
}

// Build correction prompt for retry
function buildCorrectionPrompt(
  issue: 'hallucination' | 'conditional_logic',
  details: string,
): string {
  if (issue === 'hallucination') {
    return `IMPORTANT CORRECTION: You described completing an action in your previous response, but you did NOT actually call the required tool. You MUST call the appropriate tool function to execute actions — do not just describe what you would do. Specifically: ${details}. Please try again and actually call the tool(s).`;
  }
  return `IMPORTANT CORRECTION: The user's request contains conditional logic that you did not fully handle. ${details}. Please re-read the user's message carefully and execute ALL required tool calls based on the conditions.`;
}

// Detect missed conditional logic: user says "only if X" / "but first" / "before you do"
function detectConditionalLanguage(userMessage: string): boolean {
  const patterns = [
    /\bonly if\b/i,
    /\bbut first\b/i,
    /\bbefore you\b/i,
    /\bif it (?:fails|succeeds|works|applies|doesn't)\b/i,
    /\bif the\b.*\bthen\b/i,
    /\binstead\b/i,
    /\bcancel the\b.*\bkeep\b/i,
    /\bproceed with\b/i,
  ];
  return patterns.some((p) => p.test(userMessage));
}

// Reasoning loop with verification + retry
async function reasoningLoopQwenVerified(
  messages: Message[],
  tools: ToolDef[],
  userMessage: string,
): Promise<{
  primaryCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolsCalled: string[];
  finalResponse: string;
  retries: number;
  issuesDetected: string[];
}> {
  let primaryCalls = 0,
    promptTokens = 0,
    completionTokens = 0,
    latencyMs = 0;
  const toolsCalled: string[] = [];
  let finalResponse = '';
  let retries = 0;
  const issuesDetected: string[] = [];
  const maxRetries = 2;
  const hasConditional = detectConditionalLanguage(userMessage);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Reset for this attempt (keep cumulative tokens/latency)
    const attemptTools: string[] = [];
    let attemptResponse = '';

    for (let i = 0; i < 10; i++) {
      const callMessages = truncateOldToolResults(messages, 2);
      const r = await callQwenReasoning([...callMessages], tools);
      primaryCalls++;
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
      latencyMs += r.latencyMs;

      if (r.message.tool_calls?.length > 0) {
        messages.push(r.message);
        for (const tc of r.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments);
          attemptTools.push(tc.function.name);
          const result = simulateToolResult(tc.function.name, args);
          messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
          if (tc.function.name === '__handoff__') {
            attemptResponse = `[Handed off to ${args.target}]: ${args.message ?? ''}`;
            toolsCalled.push(...attemptTools);
            return {
              primaryCalls,
              promptTokens,
              completionTokens,
              latencyMs,
              toolsCalled,
              finalResponse: attemptResponse,
              retries,
              issuesDetected,
            };
          }
        }
      } else {
        attemptResponse = r.message.content ?? '';
        break;
      }
    }

    // VERIFICATION: Check for tool hallucination
    const hallucination = detectToolHallucination(attemptResponse, attemptTools, tools);
    if (hallucination.detected && attempt < maxRetries) {
      retries++;
      issuesDetected.push(`hallucination: ${hallucination.claimedActions.join(', ')}`);
      const correction = buildCorrectionPrompt(
        'hallucination',
        hallucination.claimedActions.join('; '),
      );
      // Remove the bad response, inject correction
      messages.push({ role: 'assistant', content: attemptResponse });
      messages.push({ role: 'user', content: correction });
      continue; // Retry
    }

    // VERIFICATION: Check for missed conditional logic (only on first attempt with conditional language)
    if (hasConditional && attemptTools.length === 0 && attempt < maxRetries) {
      retries++;
      issuesDetected.push('missed_conditional: no tools called despite conditional language');
      const correction = buildCorrectionPrompt(
        'conditional_logic',
        'The user asked you to perform conditional actions that require tool calls.',
      );
      messages.push({ role: 'assistant', content: attemptResponse });
      messages.push({ role: 'user', content: correction });
      continue;
    }

    // Passed verification or out of retries
    toolsCalled.push(...attemptTools);
    finalResponse = attemptResponse;
    break;
  }

  return {
    primaryCalls,
    promptTokens,
    completionTokens,
    latencyMs,
    toolsCalled,
    finalResponse,
    retries,
    issuesDetected,
  };
}

// Approach B: Enhanced classifier with structured output
async function classifyStructured(
  pipelineCall: PipelineModel['call'],
  userMessage: string,
  multiTurnContext: string,
  availableTools: ToolDef[],
): Promise<
  {
    needsHandoff: boolean;
    target: string | null;
    confidence: number;
    shouldExecuteInAgent: boolean;
    matchedTools: string[];
  } & LLMResult
> {
  const toolList = availableTools.map((t) => t.function.name).join(', ');
  const r = await pipelineCall(
    `You are a routing classifier. Analyze the user message and determine the correct action.

Output ONLY valid JSON:
{
  "needs_handoff": bool,
  "target": string|null,
  "confidence": 0-1,
  "should_execute_in_agent": bool,
  "matched_tools": ["tool_name1", "tool_name2"],
  "reasoning": string
}

CRITICAL RULES:
1. If the user explicitly asks you to DO something (create a ticket, schedule a callback, apply a discount, process a refund, send an email, check something), set "should_execute_in_agent": true and list the required tools in "matched_tools".
2. ONLY set "needs_handoff": true when the request genuinely requires specialist expertise that the available tools cannot handle.
3. "needs_handoff" and "should_execute_in_agent" can both be true — e.g., "create a ticket AND hand off to billing" means execute the ticket creation first, then hand off.
4. If the user says "hand off" or "transfer me", that's an explicit handoff request — "needs_handoff": true.

Available tools: ${toolList}

Specialists (ONLY for cases the general agent cannot handle):
- billing_specialist: Complex billing disputes, payment processing ERRORS
- technical_support: System bugs, outages, error messages
- retention_specialist: Customer threatening to cancel
- account_security: Suspicious activity, unauthorized access

Recent conversation context:
${multiTurnContext}`,
    userMessage,
    200,
  );
  try {
    const jsonMatch = r.content.match(/\{[\s\S]*\}/);
    const p = JSON.parse(jsonMatch ? jsonMatch[0] : r.content);
    return {
      needsHandoff: p.needs_handoff && !p.should_execute_in_agent, // Don't route if agent should execute first
      target: p.target,
      confidence: p.confidence,
      shouldExecuteInAgent: p.should_execute_in_agent ?? false,
      matchedTools: p.matched_tools ?? [],
      ...r,
    };
  } catch {
    return {
      needsHandoff: false,
      target: null,
      confidence: 0,
      shouldExecuteInAgent: true,
      matchedTools: [],
      ...r,
    };
  }
}

// ─── Input Complexity Scoring ────────────────────────────────────────────────

function computeComplexityScore(
  userMessage: string,
  availableTools: ToolDef[],
): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;
  const lower = userMessage.toLowerCase();

  // 1. Conditional language (+2)
  if (
    /\bonly if\b|\bbut first\b|\bbefore you\b|\bif it (?:fails|succeeds|works|applies|doesn't)\b|\bif the\b.*\bthen\b|\binstead\b|\bcancel the\b.*\bkeep\b|\bproceed with\b/i.test(
      userMessage,
    )
  ) {
    score += 2;
    signals.push('conditional');
  }

  // 2. Multi-action: count distinct action verbs (+1 per action beyond first)
  const actionVerbs = [
    'create',
    'file',
    'schedule',
    'apply',
    'refund',
    'send',
    'email',
    'update',
    'downgrade',
    'upgrade',
    'cancel',
    'pause',
    'check',
    'look up',
    'pull',
    'hand off',
    'transfer',
  ];
  const matchedVerbs = new Set<string>();
  for (const verb of actionVerbs) {
    if (lower.includes(verb)) matchedVerbs.add(verb);
  }
  if (matchedVerbs.size >= 2) {
    score += matchedVerbs.size - 1;
    signals.push(`multi-action(${matchedVerbs.size})`);
  }

  // 3. Context references (+1)
  if (
    /\bfrom earlier\b|\byou mentioned\b|\bfrom before\b|\bthe refund (?:id|reference)\b|\bwhat was\b.*\bearlier\b|\byou (?:just|already)\b/i.test(
      userMessage,
    )
  ) {
    score += 1;
    signals.push('context-ref');
  }

  // 4. Mind-change markers (+2)
  if (
    /\bactually wait\b|\bactually no\b|\bcancel that\b|\bnever mind\b|\bhold on\b|\bwait —\b|\bwait,\b/i.test(
      userMessage,
    )
  ) {
    score += 2;
    signals.push('mind-change');
  }

  // 5. Message length (>150 chars = +1)
  if (userMessage.length > 150) {
    score += 1;
    signals.push(`long(${userMessage.length})`);
  }

  return { score, signals };
}

// Run Qwen FULL with score-gated verification + structured classifier
async function runQwenFullImproved(scenario: Scenario): Promise<
  ScenarioResult & {
    verificationStats: {
      retries: number;
      issuesDetected: string[];
      complexityScore: number;
      signals: string[];
      verified: boolean;
    }[];
  }
> {
  const qwenPipeline = PIPELINE_MODELS.find((m) => m.modelId === QWEN_MODEL)!;
  const tools = makeTools();
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnResult[] = [];
  const totals = {
    latencyMs: 0,
    primaryPromptTokens: 0,
    primaryCompletionTokens: 0,
    pipelinePromptTokens: 0,
    pipelineCompletionTokens: 0,
    primaryCalls: 0,
    pipelineCalls: 0,
  };
  const COMPLEXITY_THRESHOLD = 2; // Only verify when score >= 2
  const verificationStats: {
    retries: number;
    issuesDetected: string[];
    complexityScore: number;
    signals: string[];
    verified: boolean;
  }[] = [];

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });

    // Compute complexity score BEFORE any LLM calls (~0ms)
    const complexity = computeComplexityScore(userMsg, tools);
    const shouldVerify = complexity.score >= COMPLEXITY_THRESHOLD;

    const multiTurnCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 150)}`)
      .join('\n');
    const filterCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');

    // PARALLEL: structured classify (Approach B) + tool filter
    const parallelStart = performance.now();
    const [c, f] = await Promise.all([
      classifyStructured(qwenPipeline.call, userMsg, multiTurnCtx, tools),
      filterTools(qwenPipeline.call, filterCtx, tools),
    ]);
    const parallelLatency = Math.round(performance.now() - parallelStart);

    totals.pipelinePromptTokens += c.promptTokens + f.promptTokens;
    totals.pipelineCompletionTokens += c.completionTokens + f.completionTokens;
    totals.pipelineCalls += 2;

    // Approach B: structured classifier prevents over-routing
    // + keyword veto (Option C): even if classifier says route, veto if user explicitly requests an in-agent action
    if (c.needsHandoff && c.confidence >= 0.85 && !c.shouldExecuteInAgent) {
      const overRouting = detectOverRouting(userMsg, c, tools);
      if (!overRouting) {
        totals.latencyMs += parallelLatency;
        messages.push({ role: 'assistant', content: `[Handed off to ${c.target}]` });
        turns.push({
          turn: i + 1,
          userMessage: userMsg,
          latencyMs: parallelLatency,
          primaryPromptTokens: 0,
          primaryCompletionTokens: 0,
          pipelinePromptTokens: c.promptTokens + f.promptTokens,
          pipelineCompletionTokens: c.completionTokens + f.completionTokens,
          primaryCalls: 0,
          pipelineCalls: 2,
          toolsCalled: ['__handoff__ (short-circuit)'],
          finalResponse: `[Short-circuit → ${c.target}]`,
          toolsSentToPrimary: 0,
        });
        verificationStats.push({
          retries: 0,
          issuesDetected: [],
          complexityScore: complexity.score,
          signals: complexity.signals,
          verified: false,
        });
        continue;
      }
    }

    const useTools = f.tools.length > 0 ? f.tools : tools;

    if (shouldVerify) {
      // High complexity: use verified reasoning loop (Approach A)
      const r = await reasoningLoopQwenVerified([...messages], useTools, userMsg);
      if (!r.finalResponse.startsWith('[Handed off'))
        messages.push({ role: 'assistant', content: r.finalResponse });

      const turnLatency = parallelLatency + r.latencyMs;
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        latencyMs: turnLatency,
        primaryPromptTokens: r.promptTokens,
        primaryCompletionTokens: r.completionTokens,
        pipelinePromptTokens: c.promptTokens + f.promptTokens,
        pipelineCompletionTokens: c.completionTokens + f.completionTokens,
        primaryCalls: r.primaryCalls,
        pipelineCalls: 2,
        toolsCalled: r.toolsCalled,
        finalResponse: r.finalResponse,
        toolsSentToPrimary: useTools.length,
      });
      verificationStats.push({
        retries: r.retries,
        issuesDetected: r.issuesDetected,
        complexityScore: complexity.score,
        signals: complexity.signals,
        verified: true,
      });
      totals.latencyMs += turnLatency;
      totals.primaryPromptTokens += r.promptTokens;
      totals.primaryCompletionTokens += r.completionTokens;
      totals.primaryCalls += r.primaryCalls;
    } else {
      // Low complexity: standard reasoning loop (no verification overhead)
      const r = await reasoningLoopQwen([...messages], useTools);
      if (!r.finalResponse.startsWith('[Handed off'))
        messages.push({ role: 'assistant', content: r.finalResponse });

      const turnLatency = parallelLatency + r.latencyMs;
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        latencyMs: turnLatency,
        primaryPromptTokens: r.promptTokens,
        primaryCompletionTokens: r.completionTokens,
        pipelinePromptTokens: c.promptTokens + f.promptTokens,
        pipelineCompletionTokens: c.completionTokens + f.completionTokens,
        primaryCalls: r.primaryCalls,
        pipelineCalls: 2,
        toolsCalled: r.toolsCalled,
        finalResponse: r.finalResponse,
        toolsSentToPrimary: useTools.length,
      });
      verificationStats.push({
        retries: 0,
        issuesDetected: [],
        complexityScore: complexity.score,
        signals: complexity.signals,
        verified: false,
      });
      totals.latencyMs += turnLatency;
      totals.primaryPromptTokens += r.promptTokens;
      totals.primaryCompletionTokens += r.completionTokens;
      totals.primaryCalls += r.primaryCalls;
    }
  }

  const costUSD = 0;
  const turnLatencies = turns.map((t) => t.latencyMs);
  const avgTurnLatencyMs = Math.round(
    turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length,
  );
  const maxTurnLatencyMs = Math.max(...turnLatencies);

  return {
    pipelineModel: 'Qwen3-30B IMPROVED (A+B)',
    scenario: scenario.name,
    turns,
    totals,
    avgTurnLatencyMs,
    maxTurnLatencyMs,
    costUSD,
    verificationStats,
  };
}

// ─── Report ──────────────────────────────────────────────────────────────────

function printScenarioResults(scenario: Scenario, results: ScenarioResult[]) {
  console.log(`\n${'═'.repeat(130)}`);
  console.log(`  ${scenario.name}`);
  console.log(`${'═'.repeat(130)}\n`);

  // Per-turn table
  for (let t = 0; t < scenario.turns.length; t++) {
    console.log(
      `  Turn ${t + 1}: "${scenario.turns[t].substring(0, 80)}${scenario.turns[t].length > 80 ? '...' : ''}"`,
    );
    console.log(`  ${'─'.repeat(125)}`);
    console.log(
      `  ${'Pipeline Model'.padEnd(28)} ${'Latency'.padStart(10)} ${'GPT-4.1'.padStart(10)} ${'Pipeline'.padStart(10)} ${'Tools→GPT'.padStart(10)}  Tools Called`,
    );
    console.log(`  ${'─'.repeat(125)}`);

    for (const r of results) {
      const turn = r.turns[t];
      console.log(
        `  ${r.pipelineModel.padEnd(28)} ${(turn.latencyMs + 'ms').padStart(10)} ${(turn.primaryCalls + ' calls').padStart(10)} ${(turn.pipelineCalls + ' calls').padStart(10)} ${String(turn.toolsSentToPrimary).padStart(10)}  [${turn.toolsCalled.join(', ')}]`,
      );
    }

    const latencies = results.map((r) => r.turns[t].latencyMs);
    const best = Math.min(...latencies);
    const worst = Math.max(...latencies);
    if (best !== worst) {
      const bestIdx = latencies.indexOf(best);
      console.log(
        `  → Winner: ${results[bestIdx].pipelineModel} (${Math.round(((worst - best) / worst) * 100)}% faster)`,
      );
    }
    console.log();
  }

  // Summary table
  console.log(`  ${'─'.repeat(125)}`);
  console.log(
    `  ${'Pipeline Model'.padEnd(28)} ${'Avg Turn'.padStart(10)} ${'Max Turn'.padStart(10)} ${'Total'.padStart(10)} ${'GPT-4.1 Tok'.padStart(12)} ${'Pipeline Tok'.padStart(12)} ${'Cost (USD)'.padStart(12)} ${'Quality'.padStart(10)}`,
  );
  console.log(`  ${'─'.repeat(125)}`);

  for (const r of results) {
    const primaryTok = r.totals.primaryPromptTokens + r.totals.primaryCompletionTokens;
    const pipelineTok = r.totals.pipelinePromptTokens + r.totals.pipelineCompletionTokens;
    // Quick quality check: did Turn 3 (complex) use create_support_ticket?
    const complexT3 = r.turns.length >= 3 ? r.turns[2] : null;
    const quality = complexT3
      ? complexT3.toolsCalled.includes('create_support_ticket')
        ? 'PASS'
        : complexT3.toolsCalled.includes('__handoff__ (short-circuit)')
          ? 'ROUTED'
          : 'FAIL'
      : 'N/A';
    console.log(
      `  ${r.pipelineModel.padEnd(28)} ${(r.avgTurnLatencyMs + 'ms').padStart(10)} ${(r.maxTurnLatencyMs + 'ms').padStart(10)} ${(r.totals.latencyMs + 'ms').padStart(10)} ${String(primaryTok).padStart(12)} ${String(pipelineTok).padStart(12)} ${('$' + r.costUSD.toFixed(4)).padStart(12)} ${quality.padStart(10)}`,
    );
  }

  // Latency bars
  console.log(`\n  Avg Turn Latency:`);
  const maxAvg = Math.max(...results.map((r) => r.avgTurnLatencyMs));
  for (const r of results) {
    const barLen = Math.max(1, Math.round((r.avgTurnLatencyMs / maxAvg) * 50));
    console.log(`    ${r.pipelineModel.padEnd(28)} ${'█'.repeat(barLen)} ${r.avgTurnLatencyMs}ms`);
  }

  console.log(`\n  Max Turn Latency:`);
  const maxMax = Math.max(...results.map((r) => r.maxTurnLatencyMs));
  for (const r of results) {
    const barLen = Math.max(1, Math.round((r.maxTurnLatencyMs / maxMax) * 50));
    console.log(`    ${r.pipelineModel.padEnd(28)} ${'█'.repeat(barLen)} ${r.maxTurnLatencyMs}ms`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Pipeline Model Comparison');
  console.log(`  Primary: ${PRIMARY_MODEL} | Mode: D (Parallel + Optimized)`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();
  console.log('  Pipeline candidates:');
  for (const m of PIPELINE_MODELS) {
    const p = PRICING[m.modelId];
    console.log(
      `    ${m.name.padEnd(25)} $${p.inputPer1M.toFixed(2)}/$${p.outputPer1M.toFixed(2)} per 1M tokens ${p.inputPer1M === 0 ? '(self-hosted)' : ''}`,
    );
  }
  console.log(
    `\n  Primary (${PRIMARY_MODEL}): $${PRICING[PRIMARY_MODEL].inputPer1M.toFixed(2)}/$${PRICING[PRIMARY_MODEL].outputPer1M.toFixed(2)} per 1M tokens`,
  );

  // Warmup: quick test each pipeline model
  console.log('\n  Warming up pipeline models...');
  for (const m of PIPELINE_MODELS) {
    try {
      const r = await m.call('Return JSON: {"ok": true}', 'test', 20);
      console.log(`    ${m.name.padEnd(25)} OK (${r.latencyMs}ms)`);
    } catch (e: unknown) {
      console.log(`    ${m.name.padEnd(25)} FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const allRuns: ScenarioResult[] = [];
  const stressOnly = process.argv.includes('--stress-only');
  const qwenPipeline = PIPELINE_MODELS.find((m) => m.modelId === QWEN_MODEL);

  for (const scenario of SCENARIOS) {
    const isStress = scenario.name.startsWith('Stress');

    // In stress-only mode, skip non-stress scenarios
    if (stressOnly && !isStress) continue;

    console.log(`\n${'━'.repeat(130)}`);
    console.log(`  Running: ${scenario.name}`);
    console.log(`${'━'.repeat(130)}`);

    // For stress scenarios, only run Baseline, Qwen pipeline+GPT-4.1, and Qwen FULL
    if (isStress) {
      console.log('  Running baseline (GPT-4.1 only)...');
      const baseline = await runBaseline(scenario);
      allRuns.push(baseline);

      const stressResults: ScenarioResult[] = [baseline];

      if (qwenPipeline) {
        console.log('  Running with Qwen3-30B FULL (pipeline + reasoning)...');
        try {
          const qf = await runQwenFull(scenario);
          allRuns.push(qf);
          stressResults.push(qf);
        } catch (e: unknown) {
          console.log(`    FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }

        console.log('  Running with Qwen3-30B IMPROVED (Approach A+B)...');
        try {
          const qi = await runQwenFullImproved(scenario);
          allRuns.push(qi);
          stressResults.push(qi);

          // Print verification stats with complexity scores
          console.log(`\n  ── Complexity Scoring + Verification ──`);
          for (let t = 0; t < qi.verificationStats.length; t++) {
            const vs = qi.verificationStats[t];
            const verifyLabel = vs.verified ? 'VERIFIED' : 'skipped';
            const issueLabel =
              vs.retries > 0 ? ` → ${vs.retries} retries [${vs.issuesDetected.join(', ')}]` : '';
            console.log(
              `    T${t + 1}: score=${vs.complexityScore} [${vs.signals.join(', ') || 'none'}] → ${verifyLabel}${issueLabel}`,
            );
          }
        } catch (e: unknown) {
          console.log(`    FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      printScenarioResults(scenario, stressResults);

      // Print quality comparison: tool calls + responses per turn
      console.log(`\n  ── Quality Detail ──`);
      for (let t = 0; t < scenario.turns.length; t++) {
        console.log(
          `\n  Turn ${t + 1}: "${scenario.turns[t].substring(0, 90)}${scenario.turns[t].length > 90 ? '...' : ''}"`,
        );
        for (const r of stressResults) {
          const turn = r.turns[t];
          if (!turn) continue;
          console.log(`    [${r.pipelineModel}]`);
          console.log(
            `      Tools: ${turn.toolsCalled.length > 0 ? turn.toolsCalled.join(' → ') : '(none)'}`,
          );
          const resp = turn.finalResponse.substring(0, 200);
          console.log(`      Response: ${resp}${turn.finalResponse.length > 200 ? '...' : ''}`);
        }
      }
      continue;
    }

    // Non-stress: run all pipeline models
    console.log('  Running baseline (no pipeline)...');
    const baseline = await runBaseline(scenario);
    allRuns.push(baseline);

    const pipelineResults: ScenarioResult[] = [];
    for (const m of PIPELINE_MODELS) {
      console.log(`  Running with ${m.name}...`);
      try {
        const r = await runModeD(m, scenario);
        pipelineResults.push(r);
        allRuns.push(r);
      } catch (e: unknown) {
        console.log(`    FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Qwen-full mode
    let qwenFull: ScenarioResult | null = null;
    if (qwenPipeline) {
      console.log('  Running with Qwen3-30B FULL (pipeline + reasoning)...');
      try {
        qwenFull = await runQwenFull(scenario);
        allRuns.push(qwenFull);
      } catch (e: unknown) {
        console.log(`    FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    printScenarioResults(scenario, [baseline, ...pipelineResults, ...(qwenFull ? [qwenFull] : [])]);
  }

  // Final cross-scenario summary
  console.log(`\n${'═'.repeat(140)}`);
  console.log(`  FINAL SUMMARY — All Models x All Scenarios`);
  console.log(`${'═'.repeat(140)}\n`);
  console.log(
    `  ${'Pipeline Model'.padEnd(28)} ${'Scenario'.padEnd(48)} ${'Avg Turn'.padStart(10)} ${'Max Turn'.padStart(10)} ${'Cost'.padStart(10)} ${'Quality'.padStart(10)}`,
  );
  console.log(`  ${'─'.repeat(120)}`);
  for (const r of allRuns) {
    const complexT3 = r.turns.length >= 3 ? r.turns[2] : null;
    const quality = complexT3
      ? complexT3.toolsCalled.includes('create_support_ticket')
        ? 'PASS'
        : complexT3.toolsCalled.includes('__handoff__ (short-circuit)')
          ? 'ROUTED'
          : 'FAIL'
      : 'N/A';
    console.log(
      `  ${r.pipelineModel.padEnd(28)} ${r.scenario.substring(0, 46).padEnd(48)} ${(r.avgTurnLatencyMs + 'ms').padStart(10)} ${(r.maxTurnLatencyMs + 'ms').padStart(10)} ${('$' + r.costUSD.toFixed(4)).padStart(10)} ${quality.padStart(10)}`,
    );
  }

  // Cost comparison
  console.log(`\n  Token Cost Breakdown (per 1M tokens):`);
  console.log(`  ${'─'.repeat(80)}`);
  console.log(
    `  ${'Model'.padEnd(28)} ${'Input'.padStart(10)} ${'Output'.padStart(10)} ${'Role'.padStart(15)}`,
  );
  console.log(`  ${'─'.repeat(80)}`);
  console.log(
    `  ${PRIMARY_MODEL.padEnd(28)} ${('$' + PRICING[PRIMARY_MODEL].inputPer1M.toFixed(2)).padStart(10)} ${('$' + PRICING[PRIMARY_MODEL].outputPer1M.toFixed(2)).padStart(10)} ${'Primary'.padStart(15)}`,
  );
  for (const m of PIPELINE_MODELS) {
    const p = PRICING[m.modelId];
    console.log(
      `  ${m.name.padEnd(28)} ${('$' + p.inputPer1M.toFixed(2)).padStart(10)} ${('$' + p.outputPer1M.toFixed(2)).padStart(10)} ${'Pipeline'.padStart(15)}`,
    );
  }
}

main().catch(console.error);
