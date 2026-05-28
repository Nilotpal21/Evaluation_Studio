/**
 * Full Pipeline Comparison — 3 Modes
 *
 * Mode A: BASELINE (current engine — all tools, full history, reason param)
 * Mode B: PIPELINE ONLY (classify + tool filter, no other changes)
 * Mode C: PIPELINE + ALL OPTIMIZATIONS (classify + tool filter + trimmed schemas +
 *         truncated history + few-shot handoff + no reason param + multi-turn classifier +
 *         compact history)
 *
 * Run: npx tsx apps/runtime/src/__tests__/pipeline-full-comparison.ts
 */

/* eslint-disable no-console */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o';

const QWEN_API_KEY = process.env.QWEN_API_KEY!;
const QWEN_URL = 'http://54.163.62.233:8000/v1/chat/completions';
const QWEN_MODEL = 'qwen3-a3b-30b-instruct';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  perTurnLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  llmCalls: number;
  qwenCalls: number;
  toolsCalled: string[];
  finalResponse: string;
  toolsSentToGpt: number;
  messagesInContext: number;
}

interface ScenarioResult {
  mode: string;
  scenario: string;
  turns: TurnResult[];
  totals: {
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    llmCalls: number;
    qwenCalls: number;
  };
}

// ─── Tools: BASELINE (with reason param on every tool) ────────────────────────

function makeTools(includeReason: boolean, includeFewShot: boolean): ToolDef[] {
  const reasonProp = includeReason
    ? {
        reason: {
          type: 'string',
          description: 'Brief reason for this action (used for tracing and debugging)',
        },
      }
    : {};
  const reasonRequired = includeReason ? ['reason'] : [];

  const handoffDesc = includeFewShot
    ? `Hand off the conversation to a specialist agent when the request requires specialized expertise you cannot provide.

Targets:
- billing_specialist: Complex billing disputes, payment processing errors, refund escalations
- technical_support: System bugs, outages, error messages, integration issues
- retention_specialist: Customer threatening to cancel, requesting discounts, expressing frustration
- account_security: Suspicious activity, unauthorized access, identity verification issues

Example usage:
{"target": "billing_specialist", "message": "Customer ABC-123 reports duplicate charge of $49.99 on Jan 15-16. Needs refund and investigation.", "context": {"account_id": "ABC-123", "issue": "duplicate_charge"}}`
    : `Hand off the conversation to a specialist agent.

Targets:
- billing_specialist: Complex billing disputes, payment processing errors
- technical_support: System bugs, outages, error messages
- retention_specialist: Customer threatening to cancel, requesting discounts
- account_security: Suspicious activity, unauthorized access`;

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
            ...reasonProp,
          },
          required: ['account_id', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['account_id', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['transaction_id', 'amount', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['account_id', 'action', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['target', 'message', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['account_id', 'template', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['query', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['account_id', 'category', 'priority', 'description', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['account_id', 'method', ...reasonRequired],
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
          properties: { account_id: { type: 'string' }, ...reasonProp },
          required: ['account_id', ...reasonRequired],
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
          properties: {
            account_id: { type: 'string' },
            discount_code: { type: 'string' },
            ...reasonProp,
          },
          required: ['account_id', 'discount_code', ...reasonRequired],
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
            ...reasonProp,
          },
          required: ['account_id', 'topic', ...reasonRequired],
        },
      },
    },
  ];
}

const SYSTEM_PROMPT = `You are a customer service agent for TechCo, a SaaS platform.

## Your Role
Help customers with billing, account, and subscription inquiries.

## Guidelines
- Always verify the customer's account before making changes
- Be concise and helpful
- Use tools to look up information before answering
- If a request is outside your expertise, hand off to a specialist

## Available Specialists (via handoff)
- billing_specialist: Complex billing disputes, payment processing errors
- technical_support: System bugs, outages, error messages
- retention_specialist: Customer threatening to cancel, requesting discounts
- account_security: Suspicious activity, unauthorized access

## Current Context
{}`;

// Optimized: shorter, no routing duplication, no empty context block, adds "do NOT repeat" instruction
const SYSTEM_PROMPT_OPTIMIZED = `You are a customer service agent for TechCo, a SaaS platform.

## Your Role
Help customers with billing, account, and subscription inquiries.

## Guidelines
- Always verify the customer's identity before accessing or modifying their account
- Be concise and helpful
- Use tools to look up information before answering
- Do NOT repeat actions you have already completed in this conversation
- If a request is outside your expertise, hand off to a specialist`;
// Note: no specialist list (that's in the __handoff__ tool description with few-shot), no empty context block

// ─── Tool Simulator ───────────────────────────────────────────────────────────

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
      JSON.stringify({ methods: [{ type: 'credit_card', last4: '4242', default: true }] }),
    __handoff__: () => JSON.stringify({ success: true, handed_off_to: args.target }),
  };
  return (results[toolName] ?? (() => JSON.stringify({ result: 'ok' })))();
}

// ─── API Callers ──────────────────────────────────────────────────────────────

async function callGPT(
  messages: Message[],
  tools: ToolDef[],
): Promise<{ message: any; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const start = performance.now();
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, tools, temperature: 0.1 }),
  });
  const data = (await resp.json()) as any;
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  return {
    message: data.choices[0].message,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    latencyMs: Math.round(performance.now() - start),
  };
}

async function callQwen(
  systemPrompt: string,
  userContent: string,
  maxTokens = 100,
): Promise<{ content: string; promptTokens: number; completionTokens: number; latencyMs: number }> {
  const start = performance.now();
  const resp = await fetch(QWEN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${QWEN_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
  });
  const data = (await resp.json()) as any;
  return {
    content: data.choices[0].message.content,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    latencyMs: Math.round(performance.now() - start),
  };
}

// ─── Truncate old tool results (optimization) ─────────────────────────────────

function truncateOldToolResults(messages: Message[], keepLastN: number): Message[] {
  // Find tool_result messages and keep only the last N full, truncate older ones
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolResultIndices.push(i);
  }
  if (toolResultIndices.length <= keepLastN) return messages;

  const truncateUpTo = toolResultIndices[toolResultIndices.length - keepLastN];
  return messages.map((m, i) => {
    if (m.role === 'tool' && i < truncateUpTo) {
      return { ...m, content: '[Result truncated — tool executed successfully]' };
    }
    return m;
  });
}

// ─── Reasoning Loop ───────────────────────────────────────────────────────────

async function reasoningLoop(
  messages: Message[],
  tools: ToolDef[],
  opts: { truncateResults?: boolean; maxIterations?: number } = {},
): Promise<{
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  toolsCalled: string[];
  finalResponse: string;
}> {
  const maxIter = opts.maxIterations ?? 10;
  let llmCalls = 0,
    promptTokens = 0,
    completionTokens = 0,
    latencyMs = 0;
  const toolsCalled: string[] = [];
  let finalResponse = '';

  for (let i = 0; i < maxIter; i++) {
    // Apply truncation before each call if enabled
    const callMessages = opts.truncateResults ? truncateOldToolResults(messages, 2) : messages;

    const r = await callGPT([...callMessages], tools);
    llmCalls++;
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
            llmCalls,
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
  return { llmCalls, promptTokens, completionTokens, latencyMs, toolsCalled, finalResponse };
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

async function classify(
  userMessage: string,
  multiTurnContext?: string,
): Promise<{
  needsHandoff: boolean;
  target: string | null;
  confidence: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}> {
  const contextBlock = multiTurnContext
    ? `\n\nRecent conversation context (use this to understand if the general agent is already handling the issue):\n${multiTurnContext}`
    : '';

  const r = await callQwen(
    `You are a routing classifier. Determine if the user message needs a specialist or if a general customer service agent can handle it. Output ONLY JSON: {"needs_handoff": bool, "target": string|null, "confidence": 0-1, "reasoning": string}.

Specialists (ONLY route here for complex cases the general agent cannot handle):
- billing_specialist: Complex billing disputes, payment processing ERRORS, refund ESCALATIONS
- technical_support: System bugs, outages, error messages
- retention_specialist: Customer threatening to cancel, requesting special discounts
- account_security: Suspicious activity, unauthorized access

The general agent CAN handle: account lookups, simple refunds, subscription changes, sending emails, creating tickets. Do NOT route these to specialists.${contextBlock}`,
    userMessage,
    100,
  );
  try {
    const p = JSON.parse(r.content);
    return {
      needsHandoff: p.needs_handoff,
      target: p.target,
      confidence: p.confidence,
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    };
  } catch {
    return {
      needsHandoff: false,
      target: null,
      confidence: 0,
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    };
  }
}

async function filterTools(
  context: string,
  allTools: ToolDef[],
): Promise<{
  tools: ToolDef[];
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
}> {
  const toolList = allTools
    .map((t) => `- ${t.function.name}: ${t.function.description.split('.')[0]}`)
    .join('\n');
  const r = await callQwen(
    `Select 2-5 most relevant tools for the next agent step. If no tools are needed (e.g. farewell, thanks), return {"tools": []}. Return ONLY JSON: {"tools": ["name1", "name2"]}\n\nAvailable:\n${toolList}`,
    context,
    80,
  );
  try {
    const p = JSON.parse(r.content);
    if (p.tools.length === 0)
      return {
        tools: [],
        latencyMs: r.latencyMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
      };
    const names = new Set(p.tools as string[]);
    const filtered = allTools.filter((t) => names.has(t.function.name));
    return {
      tools: filtered.length >= 2 ? filtered : allTools,
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    };
  } catch {
    return {
      tools: allTools,
      latencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
    };
  }
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

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
    name: 'Complex: Duplicate Charge + Refund + Prevention + Downgrade (5 turns)',
    turns: [
      'I was charged twice for my subscription last month. My account is ABC-123.',
      'Yes I verified via email. Can you refund the duplicate charge?',
      'Can you also make sure this does not happen again? And send me a confirmation email.',
      "Actually I'm so frustrated with these billing issues. I want to downgrade to the Basic plan.",
      "Yes, downgrade me to Basic. I've already verified my identity.",
    ],
  },
];

// ─── Mode A: BASELINE ─────────────────────────────────────────────────────────

async function runBaseline(scenario: Scenario): Promise<ScenarioResult> {
  const tools = makeTools(true, false); // with reason, no few-shot
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnResult[] = [];
  const totals = { latencyMs: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0, qwenCalls: 0 };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });
    const msgCount = messages.length;

    const r = await reasoningLoop([...messages], tools);
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      perTurnLatencyMs: r.latencyMs,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      llmCalls: r.llmCalls,
      qwenCalls: 0,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToGpt: tools.length,
      messagesInContext: msgCount,
    });
    totals.latencyMs += r.latencyMs;
    totals.promptTokens += r.promptTokens;
    totals.completionTokens += r.completionTokens;
    totals.llmCalls += r.llmCalls;
  }
  return { mode: 'A: BASELINE', scenario: scenario.name, turns, totals };
}

// ─── Mode B: PIPELINE ONLY ───────────────────────────────────────────────────

async function runPipelineOnly(scenario: Scenario): Promise<ScenarioResult> {
  const tools = makeTools(true, false); // with reason, no few-shot (same as baseline)
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnResult[] = [];
  const totals = { latencyMs: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0, qwenCalls: 0 };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });
    const msgCount = messages.length;

    // Classify (single message, no multi-turn context)
    const c = await classify(userMsg);
    totals.latencyMs += c.latencyMs;
    totals.promptTokens += c.promptTokens;
    totals.completionTokens += c.completionTokens;
    totals.qwenCalls++;

    if (c.needsHandoff && c.confidence >= 0.85) {
      messages.push({ role: 'assistant', content: `[Handed off to ${c.target}]` });
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        perTurnLatencyMs: c.latencyMs,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
        llmCalls: 0,
        qwenCalls: 1,
        toolsCalled: ['__handoff__ (short-circuit)'],
        finalResponse: `[Short-circuit → ${c.target}]`,
        toolsSentToGpt: 0,
        messagesInContext: msgCount,
      });
      continue;
    }

    // Tool filter
    const ctx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');
    const f = await filterTools(ctx, tools);
    totals.latencyMs += f.latencyMs;
    totals.promptTokens += f.promptTokens;
    totals.completionTokens += f.completionTokens;
    totals.qwenCalls++;

    const useTools = f.tools.length > 0 ? f.tools : tools;
    const r = await reasoningLoop([...messages], useTools);
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      perTurnLatencyMs: c.latencyMs + f.latencyMs + r.latencyMs,
      promptTokens: c.promptTokens + f.promptTokens + r.promptTokens,
      completionTokens: c.completionTokens + f.completionTokens + r.completionTokens,
      llmCalls: r.llmCalls,
      qwenCalls: 2,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToGpt: useTools.length,
      messagesInContext: msgCount,
    });
    totals.latencyMs += r.latencyMs;
    totals.promptTokens += r.promptTokens;
    totals.completionTokens += r.completionTokens;
    totals.llmCalls += r.llmCalls;
  }
  return { mode: 'B: PIPELINE ONLY', scenario: scenario.name, turns, totals };
}

// ─── Mode C: PIPELINE + ALL OPTIMIZATIONS ─────────────────────────────────────

async function runFullyOptimized(scenario: Scenario): Promise<ScenarioResult> {
  const tools = makeTools(false, true); // NO reason param, WITH few-shot handoff
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT_OPTIMIZED }];
  const turns: TurnResult[] = [];
  const totals = { latencyMs: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0, qwenCalls: 0 };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });
    const msgCount = messages.length;

    // Classify WITH multi-turn context (last 3 messages for context)
    const multiTurnCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 150)}`)
      .join('\n');
    const c = await classify(userMsg, multiTurnCtx);
    totals.latencyMs += c.latencyMs;
    totals.promptTokens += c.promptTokens;
    totals.completionTokens += c.completionTokens;
    totals.qwenCalls++;

    if (c.needsHandoff && c.confidence >= 0.85) {
      messages.push({ role: 'assistant', content: `[Handed off to ${c.target}]` });
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        perTurnLatencyMs: c.latencyMs,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
        llmCalls: 0,
        qwenCalls: 1,
        toolsCalled: ['__handoff__ (short-circuit)'],
        finalResponse: `[Short-circuit → ${c.target}]`,
        toolsSentToGpt: 0,
        messagesInContext: msgCount,
      });
      continue;
    }

    // Tool filter with "no tools needed" support
    const ctx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');
    const f = await filterTools(ctx, tools);
    totals.latencyMs += f.latencyMs;
    totals.promptTokens += f.promptTokens;
    totals.completionTokens += f.completionTokens;
    totals.qwenCalls++;

    // If tool filter says no tools needed, call GPT without tools
    const useTools = f.tools.length > 0 ? f.tools : tools;

    // Reasoning loop with truncated old tool results
    const r = await reasoningLoop([...messages], useTools, { truncateResults: true });
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      perTurnLatencyMs: c.latencyMs + f.latencyMs + r.latencyMs,
      promptTokens: c.promptTokens + f.promptTokens + r.promptTokens,
      completionTokens: c.completionTokens + f.completionTokens + r.completionTokens,
      llmCalls: r.llmCalls,
      qwenCalls: 2,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToGpt: useTools.length,
      messagesInContext: msgCount,
    });
    totals.latencyMs += r.latencyMs;
    totals.promptTokens += r.promptTokens;
    totals.completionTokens += r.completionTokens;
    totals.llmCalls += r.llmCalls;
  }
  return { mode: 'C: FULLY OPTIMIZED', scenario: scenario.name, turns, totals };
}

// ─── Mode D: PIPELINE (PARALLEL) + ALL OPTIMIZATIONS ────────────────────────

async function runParallelOptimized(scenario: Scenario): Promise<ScenarioResult> {
  const tools = makeTools(false, true); // NO reason param, WITH few-shot handoff
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT_OPTIMIZED }];
  const turns: TurnResult[] = [];
  const totals = { latencyMs: 0, promptTokens: 0, completionTokens: 0, llmCalls: 0, qwenCalls: 0 };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });
    const msgCount = messages.length;

    // Run classify AND tool filter IN PARALLEL
    const multiTurnCtx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 150)}`)
      .join('\n');
    const ctx = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');

    const parallelStart = performance.now();
    const [c, f] = await Promise.all([classify(userMsg, multiTurnCtx), filterTools(ctx, tools)]);
    const parallelLatency = Math.round(performance.now() - parallelStart);

    // Parallel latency = max(classify, filter), not sum
    totals.promptTokens += c.promptTokens + f.promptTokens;
    totals.completionTokens += c.completionTokens + f.completionTokens;
    totals.qwenCalls += 2;

    if (c.needsHandoff && c.confidence >= 0.85) {
      totals.latencyMs += parallelLatency;
      messages.push({ role: 'assistant', content: `[Handed off to ${c.target}]` });
      turns.push({
        turn: i + 1,
        userMessage: userMsg,
        perTurnLatencyMs: parallelLatency,
        promptTokens: c.promptTokens + f.promptTokens,
        completionTokens: c.completionTokens + f.completionTokens,
        llmCalls: 0,
        qwenCalls: 2,
        toolsCalled: ['__handoff__ (short-circuit)'],
        finalResponse: `[Short-circuit → ${c.target}]`,
        toolsSentToGpt: 0,
        messagesInContext: msgCount,
      });
      continue;
    }

    const useTools = f.tools.length > 0 ? f.tools : tools;
    const r = await reasoningLoop([...messages], useTools, { truncateResults: true });
    if (!r.finalResponse.startsWith('[Handed off'))
      messages.push({ role: 'assistant', content: r.finalResponse });

    const turnLatency = parallelLatency + r.latencyMs;
    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      perTurnLatencyMs: turnLatency,
      promptTokens: c.promptTokens + f.promptTokens + r.promptTokens,
      completionTokens: c.completionTokens + f.completionTokens + r.completionTokens,
      llmCalls: r.llmCalls,
      qwenCalls: 2,
      toolsCalled: r.toolsCalled,
      finalResponse: r.finalResponse,
      toolsSentToGpt: useTools.length,
      messagesInContext: msgCount,
    });
    totals.latencyMs += turnLatency;
    totals.promptTokens += r.promptTokens;
    totals.completionTokens += r.completionTokens;
    totals.llmCalls += r.llmCalls;
  }
  return { mode: 'D: PARALLEL+OPTIMIZED', scenario: scenario.name, turns, totals };
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printTurnTable(results: ScenarioResult[], scenario: Scenario) {
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  PER-TURN COMPARISON — ${scenario.name}`);
  console.log(`${'═'.repeat(120)}\n`);

  for (let t = 0; t < scenario.turns.length; t++) {
    const msg = scenario.turns[t];
    console.log(`  Turn ${t + 1}: "${msg}"`);
    console.log(`  ${'─'.repeat(110)}`);
    console.log(
      `  ${'Mode'.padEnd(25)} ${'Latency'.padStart(10)} ${'Prompt Tok'.padStart(12)} ${'GPT Calls'.padStart(10)} ${'Qwen Calls'.padStart(11)} ${'Tools→GPT'.padStart(10)} ${'Msgs'.padStart(6)}  Tools Called`,
    );
    console.log(`  ${'─'.repeat(110)}`);

    for (const r of results) {
      const turn = r.turns[t];
      console.log(
        `  ${r.mode.padEnd(25)} ${(turn.perTurnLatencyMs + 'ms').padStart(10)} ${String(turn.promptTokens).padStart(12)} ${String(turn.llmCalls).padStart(10)} ${String(turn.qwenCalls).padStart(11)} ${String(turn.toolsSentToGpt).padStart(10)} ${String(turn.messagesInContext).padStart(6)}  [${turn.toolsCalled.join(', ')}]`,
      );
    }

    // Show best
    const latencies = results.map((r) => r.turns[t].perTurnLatencyMs);
    const best = Math.min(...latencies);
    const worst = Math.max(...latencies);
    if (best !== worst) {
      const bestMode = results[latencies.indexOf(best)].mode;
      const saving = Math.round(((worst - best) / worst) * 100);
      console.log(`  → Winner: ${bestMode} (${saving}% faster than worst)`);
    }

    // Show response from each mode
    for (const r of results) {
      console.log(
        `  ${r.mode.split(':')[0].trim()} Response: ${r.turns[t].finalResponse.substring(0, 100)}${r.turns[t].finalResponse.length > 100 ? '...' : ''}`,
      );
    }
    console.log();
  }
}

function printTotals(results: ScenarioResult[], scenario: Scenario) {
  console.log(`${'═'.repeat(100)}`);
  console.log(`  TOTALS — ${scenario.name}`);
  console.log(`${'═'.repeat(100)}`);
  console.log(
    `  ${'Mode'.padEnd(25)} ${'Latency'.padStart(10)} ${'Prompt Tok'.padStart(12)} ${'Total Tok'.padStart(12)} ${'GPT Calls'.padStart(10)} ${'Qwen Calls'.padStart(11)}`,
  );
  console.log(`  ${'─'.repeat(82)}`);

  for (const r of results) {
    const total = r.totals.promptTokens + r.totals.completionTokens;
    console.log(
      `  ${r.mode.padEnd(25)} ${(r.totals.latencyMs + 'ms').padStart(10)} ${String(r.totals.promptTokens).padStart(12)} ${String(total).padStart(12)} ${String(r.totals.llmCalls).padStart(10)} ${String(r.totals.qwenCalls).padStart(11)}`,
    );
  }

  // Savings vs baseline
  const baseline = results[0];
  console.log(`\n  Savings vs Baseline:`);
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const latSave = Math.round(
      ((baseline.totals.latencyMs - r.totals.latencyMs) / baseline.totals.latencyMs) * 100,
    );
    const tokSave = Math.round(
      ((baseline.totals.promptTokens - r.totals.promptTokens) / baseline.totals.promptTokens) * 100,
    );
    const totalBaseline = baseline.totals.promptTokens + baseline.totals.completionTokens;
    const totalR = r.totals.promptTokens + r.totals.completionTokens;
    const totalSave = Math.round(((totalBaseline - totalR) / totalBaseline) * 100);
    console.log(
      `  ${r.mode}: latency ${latSave >= 0 ? '-' : '+'}${Math.abs(latSave)}%, prompt tokens ${tokSave >= 0 ? '-' : '+'}${Math.abs(tokSave)}%, total tokens ${totalSave >= 0 ? '-' : '+'}${Math.abs(totalSave)}%`,
    );
  }
}

function printLatencyBars(results: ScenarioResult[], scenario: Scenario) {
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  PER-TURN LATENCY VISUALIZATION — ${scenario.name}`);
  console.log(`${'═'.repeat(100)}\n`);

  const maxMs = Math.max(...results.flatMap((r) => r.turns.map((t) => t.perTurnLatencyMs)));
  const barWidth = 60;

  for (let t = 0; t < scenario.turns.length; t++) {
    console.log(
      `  Turn ${t + 1}: "${scenario.turns[t].substring(0, 50)}${scenario.turns[t].length > 50 ? '...' : ''}"`,
    );
    for (const r of results) {
      const ms = r.turns[t].perTurnLatencyMs;
      const barLen = Math.max(1, Math.round((ms / maxMs) * barWidth));
      const bar = '█'.repeat(barLen);
      const label = r.mode.split(':')[0].trim();
      console.log(`    ${label.padEnd(3)} ${bar} ${ms}ms`);
    }
    console.log();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  4-Mode Pipeline Comparison — Simple + Complex Scenarios');
  console.log(`  Primary: ${OPENAI_MODEL} | Pipeline: ${QWEN_MODEL} | Tools: 12`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log();
  console.log('  Mode A: BASELINE — current engine (all tools, reason param, full history)');
  console.log('  Mode B: PIPELINE ONLY — sequential classify + tool filter (no other changes)');
  console.log('  Mode C: FULLY OPTIMIZED — sequential pipeline + all prompt/schema optimizations');
  console.log('  Mode D: PARALLEL+OPTIMIZED — parallel classify+filter + all optimizations');
  console.log();
  console.log('  Optimizations in C & D:');
  console.log('    - classify with multi-turn context + 0.85 threshold');
  console.log('    - tool filter with "no tools needed" support');
  console.log('    - reason param removed from all tool schemas');
  console.log('    - few-shot examples on __handoff__ tool');
  console.log('    - optimized system prompt (shorter, no routing duplication)');
  console.log('    - tool result truncation after 2 iterations');
  console.log('    - "do not repeat actions" instruction in system prompt');
  console.log('  Mode D additionally:');
  console.log('    - classify and tool filter run in PARALLEL (Promise.all)');
  console.log('    - pipeline overhead = max(classify, filter) instead of sum');

  const allResults: Array<{ scenario: Scenario; results: ScenarioResult[] }> = [];

  for (const scenario of SCENARIOS) {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`  SCENARIO: ${scenario.name}`);
    console.log(`${'─'.repeat(80)}`);

    console.log('  Running Mode A (BASELINE)...');
    const a = await runBaseline(scenario);
    console.log('  Running Mode B (PIPELINE ONLY)...');
    const b = await runPipelineOnly(scenario);
    console.log('  Running Mode C (FULLY OPTIMIZED)...');
    const c = await runFullyOptimized(scenario);
    console.log('  Running Mode D (PARALLEL+OPTIMIZED)...');
    const d = await runParallelOptimized(scenario);

    allResults.push({ scenario, results: [a, b, c, d] });

    printTurnTable([a, b, c, d], scenario);
    printTotals([a, b, c, d], scenario);
    printLatencyBars([a, b, c, d], scenario);
  }

  // Quality comparison
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`  QUALITY COMPARISON — Response Analysis`);
  console.log(`${'═'.repeat(120)}\n`);

  for (const { scenario, results } of allResults) {
    console.log(`  SCENARIO: ${scenario.name}`);
    console.log(`  ${'─'.repeat(110)}\n`);

    for (let t = 0; t < scenario.turns.length; t++) {
      console.log(`  Turn ${t + 1}: "${scenario.turns[t]}"`);
      for (const r of results) {
        const turn = r.turns[t];
        const label = r.mode;
        const tools = turn.toolsCalled.length > 0 ? turn.toolsCalled.join(' → ') : '(no tools)';
        console.log(`    ${label}:`);
        console.log(`      Tools: ${tools}`);
        console.log(
          `      Response: ${turn.finalResponse.substring(0, 150)}${turn.finalResponse.length > 150 ? '...' : ''}`,
        );
      }
      console.log();
    }
  }

  // Cross-scenario summary
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  CROSS-SCENARIO SUMMARY`);
  console.log(`${'═'.repeat(100)}\n`);
  console.log(
    `  ${'Scenario'.padEnd(55)} ${'Mode'.padEnd(25)} ${'Latency'.padStart(10)} ${'Prompt Tok'.padStart(12)} ${'GPT Calls'.padStart(10)} ${'Qwen Calls'.padStart(11)}`,
  );
  console.log(`  ${'─'.repeat(125)}`);
  for (const { scenario, results } of allResults) {
    for (const r of results) {
      const total = r.totals.promptTokens + r.totals.completionTokens;
      console.log(
        `  ${scenario.name.substring(0, 53).padEnd(55)} ${r.mode.padEnd(25)} ${(r.totals.latencyMs + 'ms').padStart(10)} ${String(r.totals.promptTokens).padStart(12)} ${String(r.totals.llmCalls).padStart(10)} ${String(r.totals.qwenCalls).padStart(11)}`,
      );
    }
    console.log(`  ${'─'.repeat(125)}`);
  }
}

main().catch(console.error);
