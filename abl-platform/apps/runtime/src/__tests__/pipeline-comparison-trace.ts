/**
 * Pipeline Comparison — Full Trace Output
 *
 * Run: npx tsx apps/runtime/src/__tests__/pipeline-comparison-trace.ts
 */

/* eslint-disable no-console */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o';

const QWEN_API_KEY = process.env.QWEN_API_KEY!;
const QWEN_URL = 'http://54.163.62.233:8000/v1/chat/completions';
const QWEN_MODEL = 'qwen3-a3b-30b-instruct';

// ─── Types ────────────────────────────────────────────────────────────────────

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

interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

// ─── Trace Logger ─────────────────────────────────────────────────────────────

let traceIndent = 0;

function trace(icon: string, label: string, detail?: string) {
  const indent = '  '.repeat(traceIndent);
  const detailStr = detail ? ` — ${detail}` : '';
  console.log(`${indent}${icon} ${label}${detailStr}`);
}

function traceSection(title: string) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(80)}`);
}

// ─── Tools ────────────────────────────────────────────────────────────────────

const ALL_TOOLS: ToolDef[] = [
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
          reason: {
            type: 'string',
            description: 'Brief reason for this action (used for tracing)',
          },
        },
        required: ['account_id', 'reason'],
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
          reason: {
            type: 'string',
            description: 'Brief reason for this action (used for tracing)',
          },
        },
        required: ['account_id', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'process_refund',
      description: 'Issue a refund for a specific transaction. Requires transaction ID and amount.',
      parameters: {
        type: 'object',
        properties: {
          transaction_id: { type: 'string', description: 'The transaction ID to refund' },
          amount: { type: 'number', description: 'Refund amount in dollars' },
          reason: { type: 'string', description: 'Reason for refund' },
        },
        required: ['transaction_id', 'amount', 'reason'],
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
          reason: { type: 'string', description: 'Brief reason for this action' },
        },
        required: ['account_id', 'action', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: '__handoff__',
      description:
        'Hand off the conversation to a specialist agent.\n\nTargets:\n- billing_specialist: Complex billing disputes, payment processing errors\n- technical_support: System bugs, outages, error messages\n- retention_specialist: Customer threatening to cancel, requesting discounts\n- account_security: Suspicious activity, unauthorized access',
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
          reason: { type: 'string', description: 'Brief reason for handoff' },
        },
        required: ['target', 'message', 'reason'],
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
          reason: { type: 'string' },
        },
        required: ['account_id', 'template', 'reason'],
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
          reason: { type: 'string' },
        },
        required: ['query', 'reason'],
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
          reason: { type: 'string' },
        },
        required: ['account_id', 'category', 'priority', 'description', 'reason'],
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
          reason: { type: 'string' },
        },
        required: ['account_id', 'method', 'reason'],
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
        properties: { account_id: { type: 'string' }, reason: { type: 'string' } },
        required: ['account_id', 'reason'],
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
          reason: { type: 'string' },
        },
        required: ['account_id', 'discount_code', 'reason'],
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
          reason: { type: 'string' },
        },
        required: ['account_id', 'topic', 'reason'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a customer service agent for TechCo, a SaaS platform.

## Your Role
Help customers with billing, account, and subscription inquiries. You have access to tools to look up accounts, process refunds, manage subscriptions, and more.

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

// ─── Tool Simulator ───────────────────────────────────────────────────────────

function simulateToolResult(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'check_account_balance':
      return JSON.stringify({
        account_id: args.account_id,
        balance: 0,
        subscription: {
          plan: 'Pro',
          status: 'active',
          monthly_cost: 49.99,
          next_billing: '2026-02-15',
        },
        payment_method: { type: 'credit_card', last4: '4242' },
      });
    case 'get_transaction_history':
      return JSON.stringify({
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
      });
    case 'process_refund':
      return JSON.stringify({
        success: true,
        refund_id: 'REF-789',
        amount: args.amount,
        estimated_days: 3,
      });
    case 'verify_identity':
      return JSON.stringify({ verified: true, method: args.method });
    case 'create_support_ticket':
      return JSON.stringify({ ticket_id: 'ST-4521', status: 'open', priority: args.priority });
    case 'send_email_notification':
      return JSON.stringify({ sent: true, template: args.template });
    case 'update_subscription':
      return JSON.stringify({
        success: true,
        new_plan: args.plan || 'Basic',
        effective_date: '2026-02-01',
      });
    case 'lookup_knowledge_base':
      return JSON.stringify({
        articles: [{ title: 'How to cancel subscription', url: '/help/cancel', relevance: 0.9 }],
      });
    case 'get_payment_methods':
      return JSON.stringify({ methods: [{ type: 'credit_card', last4: '4242', default: true }] });
    case '__handoff__':
      return JSON.stringify({ success: true, handed_off_to: args.target });
    default:
      return JSON.stringify({ result: 'ok' });
  }
}

// ─── API Callers ──────────────────────────────────────────────────────────────

async function callOpenAI(
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
  const latencyMs = Math.round(performance.now() - start);
  if (data.error) throw new Error(`OpenAI: ${data.error.message}`);
  return {
    message: data.choices[0].message,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    latencyMs,
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
  const latencyMs = Math.round(performance.now() - start);
  return {
    content: data.choices[0].message.content,
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    latencyMs,
  };
}

// ─── Traced Reasoning Loop ────────────────────────────────────────────────────

interface LoopStats {
  llmCalls: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

async function tracedReasoningLoop(
  messages: Message[],
  tools: ToolDef[],
  label: string,
): Promise<{ stats: LoopStats; finalResponse: string }> {
  const stats: LoopStats = { llmCalls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  let finalResponse = '';

  trace('🔄', `Reasoning loop start`, `${tools.length} tools, ${messages.length} messages`);
  traceIndent++;

  for (let iter = 0; iter < 10; iter++) {
    trace('📤', `LLM call #${iter + 1}`, `sending ${messages.length} messages`);
    const { message, promptTokens, completionTokens, latencyMs } = await callOpenAI(
      messages,
      tools,
    );
    stats.llmCalls++;
    stats.promptTokens += promptTokens;
    stats.completionTokens += completionTokens;
    stats.latencyMs += latencyMs;

    trace(
      '📥',
      `LLM response`,
      `${latencyMs}ms, ${promptTokens} prompt tok, ${completionTokens} compl tok`,
    );

    if (message.tool_calls && message.tool_calls.length > 0) {
      messages.push(message);
      for (const tc of message.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        const argsStr = Object.entries(args)
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(', ');
        trace('🔧', `Tool call: ${tc.function.name}`, argsStr.substring(0, 120));

        const result = simulateToolResult(tc.function.name, args);
        trace('📋', `Tool result`, result.substring(0, 120));
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id });

        if (tc.function.name === '__handoff__') {
          finalResponse = `[Handed off to ${args.target}]: ${args.message}`;
          trace('🔀', `HANDOFF`, `→ ${args.target}`);
          traceIndent--;
          return { stats, finalResponse };
        }
      }
    } else {
      finalResponse = message.content ?? '';
      trace('💬', `Final response`, finalResponse.substring(0, 120));
      break;
    }
  }

  traceIndent--;
  return { stats, finalResponse };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'Simple: Account Balance Check (3 turns)',
    turns: [
      'Hi, can you check the balance on my account ABC-123?',
      'What subscription plan am I on?',
      "Thanks, that's all I needed.",
    ],
  },
  {
    name: 'Complex: Duplicate Charge + Refund + Prevention + Downgrade (4 turns)',
    turns: [
      'I was charged twice for my subscription last month. My account is ABC-123.',
      'Yes, can you refund the duplicate charge?',
      'Can you also make sure this does not happen again? And send me a confirmation email.',
      "Actually I'm so frustrated with these billing issues. I want to downgrade to the Basic plan.",
    ],
  },
];

// ─── Run ──────────────────────────────────────────────────────────────────────

async function runWithoutPipeline(scenario: (typeof SCENARIOS)[0]) {
  traceSection(`WITHOUT PIPELINE — ${scenario.name}`);

  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  let totalStats: LoopStats = { llmCalls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    console.log(`\n  ▸ TURN ${i + 1}: "${userMsg}"`);
    console.log();

    messages.push({ role: 'user', content: userMsg });
    traceIndent = 2;

    const { stats, finalResponse } = await tracedReasoningLoop(
      [...messages],
      ALL_TOOLS,
      `turn-${i + 1}`,
    );
    if (!finalResponse.startsWith('[Handed off')) {
      messages.push({ role: 'assistant', content: finalResponse });
    }

    totalStats.llmCalls += stats.llmCalls;
    totalStats.promptTokens += stats.promptTokens;
    totalStats.completionTokens += stats.completionTokens;
    totalStats.latencyMs += stats.latencyMs;

    traceIndent = 2;
    trace(
      '📊',
      `Turn ${i + 1} totals`,
      `${stats.llmCalls} calls, ${stats.promptTokens} prompt tok, ${stats.latencyMs}ms`,
    );
  }

  console.log(`\n  ═══ SCENARIO TOTALS (WITHOUT PIPELINE) ═══`);
  console.log(`    LLM calls:     ${totalStats.llmCalls}`);
  console.log(`    Prompt tokens: ${totalStats.promptTokens}`);
  console.log(`    Compl tokens:  ${totalStats.completionTokens}`);
  console.log(`    Total tokens:  ${totalStats.promptTokens + totalStats.completionTokens}`);
  console.log(
    `    Latency:       ${totalStats.latencyMs}ms (${(totalStats.latencyMs / 1000).toFixed(1)}s)`,
  );

  return totalStats;
}

async function runWithPipeline(scenario: (typeof SCENARIOS)[0]) {
  traceSection(`WITH PIPELINE — ${scenario.name}`);

  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  let totalStats: LoopStats = { llmCalls: 0, promptTokens: 0, completionTokens: 0, latencyMs: 0 };

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    console.log(`\n  ▸ TURN ${i + 1}: "${userMsg}"`);
    console.log();

    messages.push({ role: 'user', content: userMsg });
    traceIndent = 2;

    // Stage 1: CLASSIFY
    trace('🏷️', 'CLASSIFY stage');
    traceIndent++;
    const classify = await callQwen(
      'You are a routing classifier. Determine if the user message should be handed off to a specialist. Output ONLY JSON: {"needs_handoff": bool, "target": string|null, "confidence": 0-1, "reasoning": string}.\n\nSpecialists:\n- billing_specialist: Complex billing disputes, payment processing errors\n- technical_support: System bugs, outages, error messages\n- retention_specialist: Cancellation threats, discount requests\n- account_security: Suspicious activity, unauthorized access\n\nIf the general agent can handle it (simple lookups, basic questions), set needs_handoff: false.',
      userMsg,
      100,
    );
    trace(
      '📥',
      `Qwen response`,
      `${classify.latencyMs}ms, ${classify.promptTokens + classify.completionTokens} tok`,
    );
    trace('📋', `Result`, classify.content.substring(0, 200));
    totalStats.llmCalls++;
    totalStats.promptTokens += classify.promptTokens;
    totalStats.completionTokens += classify.completionTokens;
    totalStats.latencyMs += classify.latencyMs;

    let parsed: any = {};
    try {
      parsed = JSON.parse(classify.content);
    } catch {
      /* noop */
    }
    traceIndent--;

    // Short-circuit if high-confidence handoff
    if (parsed.needs_handoff && parsed.confidence >= 0.85) {
      trace('⚡', `SHORT-CIRCUIT`, `→ ${parsed.target} (confidence: ${parsed.confidence})`);
      messages.push({ role: 'assistant', content: `[Handed off to ${parsed.target}]` });

      traceIndent = 2;
      trace(
        '📊',
        `Turn ${i + 1} totals`,
        `1 Qwen call (classify only), ${classify.promptTokens + classify.completionTokens} tok, ${classify.latencyMs}ms — SKIPPED primary model entirely`,
      );
      continue;
    }

    trace(
      '✅',
      `No short-circuit`,
      `confidence=${parsed.confidence ?? '?'}, proceeding to tool filter + reasoning`,
    );

    // Stage 2: TOOL FILTER
    trace('🔍', 'TOOL FILTER stage');
    traceIndent++;
    const recentContext = messages
      .slice(-4)
      .map((m) => `[${m.role}]: ${(m.content ?? '').substring(0, 200)}`)
      .join('\n');
    const toolList = ALL_TOOLS.map(
      (t) => `- ${t.function.name}: ${t.function.description.split('.')[0]}`,
    ).join('\n');
    const filter = await callQwen(
      `Select 3-5 most relevant tools for the next step. Return ONLY JSON: {"tools": ["name1", "name2"]}\n\nAvailable tools:\n${toolList}`,
      recentContext,
      80,
    );
    trace(
      '📥',
      `Qwen response`,
      `${filter.latencyMs}ms, ${filter.promptTokens + filter.completionTokens} tok`,
    );
    trace('📋', `Result`, filter.content.substring(0, 200));
    totalStats.llmCalls++;
    totalStats.promptTokens += filter.promptTokens;
    totalStats.completionTokens += filter.completionTokens;
    totalStats.latencyMs += filter.latencyMs;

    let filteredTools = ALL_TOOLS;
    try {
      const filterParsed = JSON.parse(filter.content);
      const names = new Set(filterParsed.tools as string[]);
      const matched = ALL_TOOLS.filter((t) => names.has(t.function.name));
      if (matched.length >= 2) filteredTools = matched;
    } catch {
      /* fallback to all */
    }

    trace(
      '✅',
      `Filtered`,
      `${ALL_TOOLS.length} → ${filteredTools.length} tools: [${filteredTools.map((t) => t.function.name).join(', ')}]`,
    );
    traceIndent--;

    // Stage 3: REASON
    trace('🧠', 'REASON stage (primary model)');
    const { stats, finalResponse } = await tracedReasoningLoop(
      [...messages],
      filteredTools,
      `turn-${i + 1}`,
    );
    if (!finalResponse.startsWith('[Handed off')) {
      messages.push({ role: 'assistant', content: finalResponse });
    }

    totalStats.llmCalls += stats.llmCalls;
    totalStats.promptTokens += stats.promptTokens;
    totalStats.completionTokens += stats.completionTokens;
    totalStats.latencyMs += stats.latencyMs;

    traceIndent = 2;
    const pipelineOverhead = classify.latencyMs + filter.latencyMs;
    trace(
      '📊',
      `Turn ${i + 1} totals`,
      `${stats.llmCalls} primary + 2 Qwen = ${stats.llmCalls + 2} calls, ${stats.promptTokens + classify.promptTokens + filter.promptTokens} prompt tok, ${stats.latencyMs + pipelineOverhead}ms (pipeline overhead: ${pipelineOverhead}ms)`,
    );
  }

  console.log(`\n  ═══ SCENARIO TOTALS (WITH PIPELINE) ═══`);
  console.log(`    LLM calls:     ${totalStats.llmCalls}`);
  console.log(`    Prompt tokens: ${totalStats.promptTokens}`);
  console.log(`    Compl tokens:  ${totalStats.completionTokens}`);
  console.log(`    Total tokens:  ${totalStats.promptTokens + totalStats.completionTokens}`);
  console.log(
    `    Latency:       ${totalStats.latencyMs}ms (${(totalStats.latencyMs / 1000).toFixed(1)}s)`,
  );

  return totalStats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('  Pipeline Comparison — FULL TRACE');
  console.log(`  Primary: ${OPENAI_MODEL} | Pipeline: ${QWEN_MODEL} | Tools: ${ALL_TOOLS.length}`);
  console.log('═══════════════════════════════════════════════════════════════════════');

  for (const scenario of SCENARIOS) {
    const without = await runWithoutPipeline(scenario);
    const withP = await runWithPipeline(scenario);

    console.log(`\n  ━━━ COMPARISON: ${scenario.name} ━━━`);
    console.log(
      `  ${'Metric'.padEnd(20)} ${'WITHOUT'.padStart(10)} ${'WITH'.padStart(10)} ${'Savings'.padStart(10)}`,
    );
    console.log(`  ${'─'.repeat(52)}`);
    const pct = (a: number, b: number) => `${(((a - b) / a) * 100).toFixed(0)}%`;
    console.log(
      `  ${'LLM Calls'.padEnd(20)} ${String(without.llmCalls).padStart(10)} ${String(withP.llmCalls).padStart(10)} ${pct(without.llmCalls, withP.llmCalls).padStart(10)}`,
    );
    console.log(
      `  ${'Prompt Tokens'.padEnd(20)} ${String(without.promptTokens).padStart(10)} ${String(withP.promptTokens).padStart(10)} ${pct(without.promptTokens, withP.promptTokens).padStart(10)}`,
    );
    console.log(
      `  ${'Total Tokens'.padEnd(20)} ${String(without.promptTokens + without.completionTokens).padStart(10)} ${String(withP.promptTokens + withP.completionTokens).padStart(10)} ${pct(without.promptTokens + without.completionTokens, withP.promptTokens + withP.completionTokens).padStart(10)}`,
    );
    console.log(
      `  ${'Latency (ms)'.padEnd(20)} ${String(without.latencyMs).padStart(10)} ${String(withP.latencyMs).padStart(10)} ${pct(without.latencyMs, withP.latencyMs).padStart(10)}`,
    );
  }
}

main().catch(console.error);
