/**
 * Pipeline Comparison Test
 *
 * Compares GPT-4o reasoning agent behavior WITH and WITHOUT the operation pipeline.
 * Measures: token usage, latency, LLM call count, tool accuracy.
 *
 * Run: npx tsx apps/runtime/src/__tests__/pipeline-comparison.test.ts
 */

/* eslint-disable no-console */

// ─── Config ───────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4o';

const QWEN_API_KEY = process.env.QWEN_API_KEY!;
const QWEN_URL = 'http://54.163.62.233:8000/v1/chat/completions';
const QWEN_MODEL = 'qwen3-a3b-30b-instruct';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
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

interface CallMetrics {
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface TurnMetrics {
  turn: number;
  userMessage: string;
  llmCalls: number;
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  toolsCalled: string[];
  finalResponse: string;
  pipelineOverhead?: {
    classifyMs?: number;
    extractMs?: number;
    toolFilterMs?: number;
    classifyTokens?: number;
    extractTokens?: number;
    toolFilterTokens?: number;
  };
}

interface ConversationResult {
  mode: string;
  scenario: string;
  turns: TurnMetrics[];
  totalLlmCalls: number;
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

// ─── Tools (simulating a customer service agent with 12 tools) ────────────────

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
        'Hand off the conversation to a specialist agent. Use when the request is outside your expertise.\n\nTargets:\n- billing_specialist: Complex billing disputes, payment processing errors\n- technical_support: System bugs, outages, error messages\n- retention_specialist: Customer threatening to cancel, requesting discounts\n- account_security: Suspicious activity, unauthorized access, identity verification',
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
          details: { type: 'string', description: 'Additional details to include in the email' },
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
        properties: {
          account_id: { type: 'string' },
          reason: { type: 'string' },
        },
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
{}

## Recalled Memory
[]`;

// ─── Tool Result Simulator ────────────────────────────────────────────────────

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
        articles: [
          { title: 'How to cancel subscription', url: '/help/cancel', relevance: 0.9 },
          { title: 'Refund policy', url: '/help/refunds', relevance: 0.85 },
        ],
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
): Promise<{ message: Message; metrics: CallMetrics }> {
  const start = performance.now();
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, tools, temperature: 0.1 }),
  });
  const data = (await resp.json()) as any;
  const elapsed = Math.round(performance.now() - start);

  if (data.error) throw new Error(`OpenAI error: ${data.error.message}`);

  return {
    message: data.choices[0].message,
    metrics: {
      latencyMs: elapsed,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}

async function callQwen(
  systemPrompt: string,
  userContent: string,
  maxTokens = 100,
): Promise<{
  content: string;
  metrics: CallMetrics;
}> {
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
  const elapsed = Math.round(performance.now() - start);

  return {
    content: data.choices[0].message.content,
    metrics: {
      latencyMs: elapsed,
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}

// ─── Pipeline Stages ──────────────────────────────────────────────────────────

async function classifyRouting(userMessage: string): Promise<{
  target: string | null;
  confidence: number;
  metrics: CallMetrics;
}> {
  const result = await callQwen(
    'You are a routing classifier. Determine if the user message should be handed off to a specialist. Output ONLY JSON: {"needs_handoff": bool, "target": string|null, "confidence": 0-1, "reasoning": string}.\n\nSpecialists:\n- billing_specialist: Complex billing disputes, payment processing errors\n- technical_support: System bugs, outages, error messages\n- retention_specialist: Cancellation threats, discount requests\n- account_security: Suspicious activity, unauthorized access\n\nIf the general agent can handle it, set needs_handoff: false.',
    userMessage,
    100,
  );
  try {
    const parsed = JSON.parse(result.content);
    return {
      target: parsed.needs_handoff ? parsed.target : null,
      confidence: parsed.confidence,
      metrics: result.metrics,
    };
  } catch {
    return { target: null, confidence: 0, metrics: result.metrics };
  }
}

async function filterTools(
  conversationContext: string,
  allTools: ToolDef[],
): Promise<{ filteredTools: ToolDef[]; metrics: CallMetrics }> {
  const toolList = allTools
    .map((t) => `- ${t.function.name}: ${t.function.description.split('.')[0]}`)
    .join('\n');
  const result = await callQwen(
    `Select 3-5 most relevant tools for the next step. Return ONLY JSON: {"tools": ["name1", "name2"]}\n\nAvailable tools:\n${toolList}`,
    conversationContext,
    80,
  );
  try {
    const parsed = JSON.parse(result.content);
    const names = new Set(parsed.tools as string[]);
    const filtered = allTools.filter((t) => names.has(t.function.name));
    // Always include at least the selected tools, fall back to all if parsing failed
    return { filteredTools: filtered.length >= 2 ? filtered : allTools, metrics: result.metrics };
  } catch {
    return { filteredTools: allTools, metrics: result.metrics };
  }
}

// ─── Reasoning Loop ───────────────────────────────────────────────────────────

async function runReasoningLoop(
  messages: Message[],
  tools: ToolDef[],
  maxIterations = 10,
): Promise<{
  llmCalls: number;
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  toolsCalled: string[];
  finalResponse: string;
}> {
  let llmCalls = 0;
  let totalLatencyMs = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  const toolsCalled: string[] = [];
  let finalResponse = '';

  for (let i = 0; i < maxIterations; i++) {
    const { message, metrics } = await callOpenAI(messages, tools);
    llmCalls++;
    totalLatencyMs += metrics.latencyMs;
    totalPromptTokens += metrics.promptTokens;
    totalCompletionTokens += metrics.completionTokens;
    totalTokens += metrics.totalTokens;

    if (message.tool_calls && message.tool_calls.length > 0) {
      // Add assistant message with tool calls
      messages.push(message);

      // Execute each tool call and add results
      for (const tc of message.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        toolsCalled.push(tc.function.name);
        const result = simulateToolResult(tc.function.name, args);
        messages.push({ role: 'tool', content: result, tool_call_id: tc.id });

        // Break on handoff
        if (tc.function.name === '__handoff__') {
          finalResponse = `[Handed off to ${args.target}]`;
          return {
            llmCalls,
            totalLatencyMs,
            totalPromptTokens,
            totalCompletionTokens,
            totalTokens,
            toolsCalled,
            finalResponse,
          };
        }
      }
    } else {
      finalResponse = message.content ?? '';
      break;
    }
  }

  return {
    llmCalls,
    totalLatencyMs,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    toolsCalled,
    finalResponse,
  };
}

// ─── Scenarios ────────────────────────────────────────────────────────────────

interface Scenario {
  name: string;
  complexity: 'simple' | 'complex';
  turns: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: 'Simple: Account Balance Check',
    complexity: 'simple',
    turns: [
      'Hi, can you check the balance on my account ABC-123?',
      'What subscription plan am I on?',
      "Thanks, that's all I needed.",
    ],
  },
  {
    name: 'Complex: Duplicate Charge + Refund + Prevention',
    complexity: 'complex',
    turns: [
      'I was charged twice for my subscription last month. My account is ABC-123.',
      'Yes, can you refund the duplicate charge?',
      'Can you also make sure this does not happen again? And send me a confirmation email.',
      "Actually I'm so frustrated with these billing issues. I want to downgrade to the Basic plan.",
    ],
  },
];

// ─── Run Comparison ───────────────────────────────────────────────────────────

async function runWithoutPipeline(scenario: Scenario): Promise<ConversationResult> {
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnMetrics[] = [];
  let totalLlmCalls = 0;
  let totalLatencyMs = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });

    const result = await runReasoningLoop([...messages], ALL_TOOLS);

    // Add final assistant response to history
    if (!result.finalResponse.startsWith('[Handed off')) {
      messages.push({ role: 'assistant', content: result.finalResponse });
    }

    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      ...result,
    });

    totalLlmCalls += result.llmCalls;
    totalLatencyMs += result.totalLatencyMs;
    totalPromptTokens += result.totalPromptTokens;
    totalCompletionTokens += result.totalCompletionTokens;
    totalTokens += result.totalTokens;
  }

  return {
    mode: 'WITHOUT Pipeline',
    scenario: scenario.name,
    turns,
    totalLlmCalls,
    totalLatencyMs,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
  };
}

async function runWithPipeline(scenario: Scenario): Promise<ConversationResult> {
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const turns: TurnMetrics[] = [];
  let totalLlmCalls = 0;
  let totalLatencyMs = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (let i = 0; i < scenario.turns.length; i++) {
    const userMsg = scenario.turns[i];
    messages.push({ role: 'user', content: userMsg });

    const pipelineOverhead: TurnMetrics['pipelineOverhead'] = {};

    // Stage 1: CLASSIFY — check if handoff needed
    const classify = await classifyRouting(userMsg);
    pipelineOverhead.classifyMs = classify.metrics.latencyMs;
    pipelineOverhead.classifyTokens = classify.metrics.totalTokens;
    totalLatencyMs += classify.metrics.latencyMs;
    totalPromptTokens += classify.metrics.promptTokens;
    totalCompletionTokens += classify.metrics.completionTokens;
    totalTokens += classify.metrics.totalTokens;
    totalLlmCalls++;

    // Short-circuit if high-confidence handoff
    if (classify.target && classify.confidence >= 0.85) {
      const turnResult: TurnMetrics = {
        turn: i + 1,
        userMessage: userMsg,
        llmCalls: 1,
        totalLatencyMs: classify.metrics.latencyMs,
        totalPromptTokens: classify.metrics.promptTokens,
        totalCompletionTokens: classify.metrics.completionTokens,
        totalTokens: classify.metrics.totalTokens,
        toolsCalled: ['__handoff__ (short-circuited)'],
        finalResponse: `[Short-circuit handoff to ${classify.target}]`,
        pipelineOverhead,
      };
      turns.push(turnResult);
      continue;
    }

    // Stage 2: TOOL FILTER — select relevant tools
    const recentContext = messages
      .slice(-4)
      .map(
        (m) => `[${m.role}]: ${typeof m.content === 'string' ? m.content?.substring(0, 200) : ''}`,
      )
      .join('\n');
    const toolFilter = await filterTools(recentContext, ALL_TOOLS);
    pipelineOverhead.toolFilterMs = toolFilter.metrics.latencyMs;
    pipelineOverhead.toolFilterTokens = toolFilter.metrics.totalTokens;
    totalLatencyMs += toolFilter.metrics.latencyMs;
    totalPromptTokens += toolFilter.metrics.promptTokens;
    totalCompletionTokens += toolFilter.metrics.completionTokens;
    totalTokens += toolFilter.metrics.totalTokens;
    totalLlmCalls++;

    // Stage 3: REASON with filtered tools
    const result = await runReasoningLoop([...messages], toolFilter.filteredTools);

    if (!result.finalResponse.startsWith('[Handed off')) {
      messages.push({ role: 'assistant', content: result.finalResponse });
    }

    turns.push({
      turn: i + 1,
      userMessage: userMsg,
      llmCalls: result.llmCalls + 2, // +2 for classify + tool_filter
      totalLatencyMs:
        result.totalLatencyMs + classify.metrics.latencyMs + toolFilter.metrics.latencyMs,
      totalPromptTokens:
        result.totalPromptTokens + classify.metrics.promptTokens + toolFilter.metrics.promptTokens,
      totalCompletionTokens:
        result.totalCompletionTokens +
        classify.metrics.completionTokens +
        toolFilter.metrics.completionTokens,
      totalTokens:
        result.totalTokens + classify.metrics.totalTokens + toolFilter.metrics.totalTokens,
      toolsCalled: result.toolsCalled,
      finalResponse: result.finalResponse,
      pipelineOverhead,
    });

    totalLlmCalls += result.llmCalls;
    totalLatencyMs += result.totalLatencyMs;
    totalPromptTokens += result.totalPromptTokens;
    totalCompletionTokens += result.totalCompletionTokens;
    totalTokens += result.totalTokens;
  }

  return {
    mode: 'WITH Pipeline',
    scenario: scenario.name,
    turns,
    totalLlmCalls,
    totalLatencyMs,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
  };
}

// ─── Reporting ────────────────────────────────────────────────────────────────

function printResult(result: ConversationResult) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  ${result.mode} | ${result.scenario}`);
  console.log(`${'═'.repeat(80)}`);

  for (const turn of result.turns) {
    console.log(`\n  Turn ${turn.turn}: "${turn.userMessage.substring(0, 60)}..."`);
    console.log(`    LLM calls:      ${turn.llmCalls}`);
    console.log(`    Latency:        ${turn.totalLatencyMs}ms`);
    console.log(`    Prompt tokens:  ${turn.totalPromptTokens}`);
    console.log(`    Compl. tokens:  ${turn.totalCompletionTokens}`);
    console.log(`    Total tokens:   ${turn.totalTokens}`);
    console.log(`    Tools called:   [${turn.toolsCalled.join(', ')}]`);
    if (turn.pipelineOverhead) {
      const po = turn.pipelineOverhead;
      console.log(
        `    Pipeline:       classify=${po.classifyMs}ms(${po.classifyTokens}tok) toolFilter=${po.toolFilterMs ?? '-'}ms(${po.toolFilterTokens ?? '-'}tok)`,
      );
    }
    console.log(`    Response:       ${turn.finalResponse.substring(0, 120)}...`);
  }

  console.log(`\n  ─── TOTALS ───`);
  console.log(`    Total LLM calls:      ${result.totalLlmCalls}`);
  console.log(
    `    Total latency:        ${result.totalLatencyMs}ms (${(result.totalLatencyMs / 1000).toFixed(1)}s)`,
  );
  console.log(`    Total prompt tokens:  ${result.totalPromptTokens}`);
  console.log(`    Total compl. tokens:  ${result.totalCompletionTokens}`);
  console.log(`    Total tokens:         ${result.totalTokens}`);
}

function printComparison(without: ConversationResult, withPipeline: ConversationResult) {
  console.log(`\n${'━'.repeat(80)}`);
  console.log(`  COMPARISON: ${without.scenario}`);
  console.log(`${'━'.repeat(80)}`);

  const pct = (a: number, b: number) => {
    const diff = ((b - a) / a) * 100;
    return diff > 0 ? `+${diff.toFixed(1)}%` : `${diff.toFixed(1)}%`;
  };

  console.log(
    `\n  ${'Metric'.padEnd(25)} ${'WITHOUT'.padStart(12)} ${'WITH'.padStart(12)} ${'Change'.padStart(10)}`,
  );
  console.log(`  ${'─'.repeat(60)}`);
  console.log(
    `  ${'LLM Calls (primary)'.padEnd(25)} ${String(without.totalLlmCalls).padStart(12)} ${String(withPipeline.totalLlmCalls).padStart(12)} ${pct(without.totalLlmCalls, withPipeline.totalLlmCalls).padStart(10)}`,
  );
  console.log(
    `  ${'Latency (ms)'.padEnd(25)} ${String(without.totalLatencyMs).padStart(12)} ${String(withPipeline.totalLatencyMs).padStart(12)} ${pct(without.totalLatencyMs, withPipeline.totalLatencyMs).padStart(10)}`,
  );
  console.log(
    `  ${'Prompt Tokens'.padEnd(25)} ${String(without.totalPromptTokens).padStart(12)} ${String(withPipeline.totalPromptTokens).padStart(12)} ${pct(without.totalPromptTokens, withPipeline.totalPromptTokens).padStart(10)}`,
  );
  console.log(
    `  ${'Completion Tokens'.padEnd(25)} ${String(without.totalCompletionTokens).padStart(12)} ${String(withPipeline.totalCompletionTokens).padStart(12)} ${pct(without.totalCompletionTokens, withPipeline.totalCompletionTokens).padStart(10)}`,
  );
  console.log(
    `  ${'Total Tokens'.padEnd(25)} ${String(without.totalTokens).padStart(12)} ${String(withPipeline.totalTokens).padStart(12)} ${pct(without.totalTokens, withPipeline.totalTokens).padStart(10)}`,
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Pipeline Comparison Test — GPT-4o WITH vs WITHOUT Operation Pipeline');
  console.log(`Primary model: ${OPENAI_MODEL}`);
  console.log(`Pipeline model: ${QWEN_MODEL}`);
  console.log(`Tools: ${ALL_TOOLS.length} total`);
  console.log();

  for (const scenario of SCENARIOS) {
    console.log(`\n▶ Running scenario: ${scenario.name}`);

    console.log('  Running WITHOUT pipeline...');
    const without = await runWithoutPipeline(scenario);
    printResult(without);

    console.log('\n  Running WITH pipeline...');
    const withPipeline = await runWithPipeline(scenario);
    printResult(withPipeline);

    printComparison(without, withPipeline);
  }
}

main().catch(console.error);
