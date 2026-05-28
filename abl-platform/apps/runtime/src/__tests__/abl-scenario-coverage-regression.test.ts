import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  getActiveThread,
  type RuntimeSession,
} from '../services/runtime-executor';
import { injectValidatingMockClient } from './helpers/history-validation';
import { sendMessage } from './helpers/orchestration-harness';

const PRODUCT_AGENT = `
AGENT: ProductAgent

GOAL: "Handle product search requests"

FLOW:
  entry_point: detect
  steps:
    - detect
    - ask_type
    - ask_budget
    - ask_details
    - ask_product_details
    - complete_budget
    - complete_details
    - complete_query

detect:
  REASONING: false
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "hello"
      RESPOND: "Hello! I can help with product searches."
      THEN: COMPLETE
    - IF: input == "hi"
      RESPOND: "Hello! I can help with product searches."
      THEN: COMPLETE
    - IF: input == "hey"
      RESPOND: "Hello! I can help with product searches."
      THEN: COMPLETE
    - IF: input contains "casual wear under 500"
      SET: product_type = "casual wear"
      SET: budget = "under 500 AED"
      THEN: complete_budget
    - IF: input contains "formal shoes black under 800"
      SET: product_type = "formal shoes"
      SET: product_details = "black under 800 AED"
      THEN: complete_details
    - IF: input contains "something under 500"
      SET: budget = "under 500 AED"
      THEN: ask_type
    - IF: input contains "casual wear"
      SET: product_type = "casual wear"
      THEN: ask_budget
    - IF: input contains "formal shoes"
      SET: product_type = "formal shoes"
      THEN: ask_details
    - IF: input contains "clothing"
      THEN: ask_product_details
    - ELSE:
      THEN: ask_type

ask_type:
  REASONING: false
  GATHER: product_type
  PROMPT: "What type of product are you looking for?"
  THEN: ask_budget

ask_budget:
  REASONING: false
  GATHER: budget
  PROMPT: "What is your budget?"
  THEN: complete_budget

ask_details:
  REASONING: false
  GATHER: product_details
  PROMPT: "What color and budget do you prefer?"
  THEN: complete_details

ask_product_details:
  REASONING: false
  GATHER: product_details
  PROMPT: "What kind of product and budget do you have in mind?"
  THEN: complete_query

complete_budget:
  REASONING: false
  RESPOND: "Product options for {{product_type}} within {{budget}}."
  THEN: COMPLETE

complete_details:
  REASONING: false
  RESPOND: "Product options for {{product_type}} matching {{product_details}}."
  THEN: COMPLETE

complete_query:
  REASONING: false
  RESPOND: "Product options for {{product_details}}."
  THEN: COMPLETE
`;

const AUTOMOBILE_AGENT = `
AGENT: AutomobileAgent

GOAL: "Handle automobile search requests"

FLOW:
  entry_point: detect
  steps:
    - detect
    - ask_condition
    - ask_budget
    - ask_auto_details
    - complete_budget
    - complete_query

detect:
  REASONING: false
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "pre-owned toyota under 100k"
      SET: vehicle_condition = "pre-owned"
      SET: brand = "Toyota"
      SET: budget = "under 100K"
      THEN: complete_budget
    - IF: input contains "new toyota under 200k"
      SET: vehicle_condition = "new"
      SET: brand = "Toyota"
      SET: budget = "under 200K"
      THEN: complete_budget
    - IF: input contains "pre-owned toyota"
      SET: vehicle_condition = "pre-owned"
      SET: brand = "Toyota"
      THEN: ask_budget
    - IF: input contains "cars under 100k"
      SET: budget = "under 100K"
      THEN: ask_condition
    - IF: input contains "pre-owned cars"
      SET: vehicle_condition = "pre-owned"
      THEN: ask_budget
    - IF: input contains "new cars"
      SET: vehicle_condition = "new"
      THEN: ask_auto_details
    - IF: input contains "cars"
      THEN: ask_auto_details
    - ELSE:
      THEN: ask_auto_details

ask_condition:
  REASONING: false
  GATHER: vehicle_condition
  PROMPT: "Are you looking for new or pre-owned?"
  THEN: ask_budget

ask_budget:
  REASONING: false
  GATHER: budget
  PROMPT: "What is your budget?"
  THEN: complete_budget

ask_auto_details:
  REASONING: false
  GATHER: auto_request_details
  PROMPT: "Are you looking for new or pre-owned, and what brand or budget do you have in mind?"
  THEN: complete_query

complete_budget:
  REASONING: false
  RESPOND: "Automobile options for {{vehicle_condition}} cars within {{budget}}."
  THEN: COMPLETE

complete_query:
  REASONING: false
  RESPOND: "Automobile options for {{auto_request_details}}."
  THEN: COMPLETE
`;

const FAQ_AGENT = `
AGENT: FAQAgent

GOAL: "Answer FAQ and policy questions"

FLOW:
  entry_point: detect
  steps:
    - detect
    - return_policy
    - insurance_info
    - education_info
    - faq_default

detect:
  REASONING: false
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "return policy"
      THEN: return_policy
    - IF: input contains "insurance"
      THEN: insurance_info
    - IF: input contains "education"
      THEN: education_info
    - ELSE:
      THEN: faq_default

return_policy:
  REASONING: false
  RESPOND: "Marks & Spencer return policy information."
  THEN: COMPLETE

insurance_info:
  REASONING: false
  RESPOND: "Insurance knowledge base guidance."
  THEN: COMPLETE

education_info:
  REASONING: false
  RESPOND: "Education knowledge base guidance."
  THEN: COMPLETE

faq_default:
  REASONING: false
  RESPOND: "FAQ guidance."
  THEN: COMPLETE
`;

const STORE_GUIDE_AGENT = `
AGENT: StoreGuideAgent

GOAL: "Answer store guidance questions"

FLOW:
  entry_point: detect
  steps:
    - detect
    - store_locator
    - mall_info
    - store_default

detect:
  REASONING: false
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "near"
      THEN: store_locator
    - IF: input contains "mall"
      THEN: mall_info
    - ELSE:
      THEN: store_default

store_locator:
  REASONING: false
  RESPOND: "The nearest store option is near Dubai Mall."
  THEN: COMPLETE

mall_info:
  REASONING: false
  RESPOND: "Dubai Mall information and store guidance."
  THEN: COMPLETE

store_default:
  REASONING: false
  RESPOND: "Store guidance information."
  THEN: COMPLETE
`;

const RETAIL_SUPERVISOR = `
SUPERVISOR: RetailSupervisor
MODE: reasoning

GOAL: "Route retail requests to the right specialist"

PERSONA: "Retail routing supervisor"

HANDOFF:
  - TO: ProductAgent
    WHEN: intent.category == "product"
    CONTEXT:
      summary: "Product specialist"
    RETURN: false

  - TO: AutomobileAgent
    WHEN: intent.category == "automobile"
    CONTEXT:
      summary: "Automobile specialist"
    RETURN: false

  - TO: FAQAgent
    WHEN: intent.category == "faq"
    CONTEXT:
      summary: "FAQ specialist"
    RETURN: false

  - TO: StoreGuideAgent
    WHEN: intent.category == "store"
    CONTEXT:
      summary: "Store guide specialist"
    RETURN: false
`;

type MockResponse = {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: string;
  rawContent: Array<{ type: string; [key: string]: unknown }>;
};

const GENERIC_COMPLETION_RESPONSE = 'This conversation has been completed.';

function textResponse(text: string): MockResponse {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text }],
  };
}

function toolUseResponse(
  text: string,
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): MockResponse {
  return {
    text,
    toolCalls,
    stopReason: 'tool_use',
    rawContent: [
      { type: 'text', text },
      ...toolCalls.map((toolCall) => ({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      })),
    ],
  };
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') {
        return [];
      }
      if ((block as { type?: string }).type === 'text') {
        return [String((block as { text?: unknown }).text ?? '')];
      }
      return [];
    })
    .join('\n');
}

function getLatestUserText(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user') {
      continue;
    }
    const text = contentToText(message.content).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function getAssistantTexts(messages: Array<{ role: string; content: unknown }>): string[] {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') {
      continue;
    }
    const text = contentToText(message.content).trim();
    if (text) {
      texts.push(text);
    }
  }
  return texts;
}

function isGenericCompletionResponse(text: string): boolean {
  return text.trim() === GENERIC_COMPLETION_RESPONSE;
}

function getVisibleResponse(
  session: RuntimeSession,
  result: { response: string; chunks: string[] },
): string {
  const activeThread = getActiveThread(session);
  const visibleCandidates = [
    result.response.trim(),
    activeThread?.pendingResponse?.trim() ?? '',
    session.pendingResponse?.trim() ?? '',
    ...result.chunks.map((chunk) => chunk.trim()),
    ...(activeThread ? getAssistantTexts(activeThread.conversationHistory) : []),
    ...getAssistantTexts(session.conversationHistory),
  ].filter((text) => text.length > 0);

  const visible = visibleCandidates.find((text) => !isGenericCompletionResponse(text));

  return visible ?? visibleCandidates[0] ?? '';
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function hasGreeting(text: string): boolean {
  return /\b(?:hello|hi|hey)\b/i.test(text);
}

function resolveProductResponse(message: string): string {
  if (message.includes('casual wear under 500')) {
    return 'Product options for casual wear within under 500 AED.';
  }
  if (message.includes('formal shoes black under 800')) {
    return 'Product options for formal shoes matching black under 800 AED.';
  }
  if (message.includes('something under 500')) {
    return 'What type of product are you looking for?';
  }
  if (message.includes('casual wear')) {
    return 'What is your budget?';
  }
  if (message.includes('formal shoes')) {
    return 'What color and budget do you prefer?';
  }
  if (message.includes('clothing')) {
    return 'What kind of product and budget do you have in mind?';
  }
  return 'What type of product are you looking for?';
}

function resolveAutomobileResponse(message: string): string {
  if (message.includes('pre-owned toyota under 100k')) {
    return 'Automobile options for pre-owned cars within under 100K.';
  }
  if (message.includes('new toyota under 200k')) {
    return 'Automobile options for new cars within under 200K.';
  }
  if (message.includes('toyota under 200k')) {
    return 'Automobile options for Toyota under 200K.';
  }
  if (message.includes('cars under 100k')) {
    return 'Are you looking for new or pre-owned?';
  }
  if (message.includes('pre-owned toyota')) {
    return 'What is your budget?';
  }
  if (message.includes('pre-owned cars')) {
    return 'What is your budget?';
  }
  if (message.includes('new cars') || message.includes('cars')) {
    return 'Please provide: auto_request_details';
  }
  return 'Please provide: auto_request_details';
}

function resolveFaqResponse(message: string): string {
  if (message.includes('insurance')) {
    return 'Insurance knowledge base guidance.';
  }
  if (message.includes('education')) {
    return 'Education knowledge base guidance.';
  }
  return 'Marks & Spencer return policy information.';
}

function resolveStoreResponse(message: string): string {
  if (message.includes('store') || message.includes('near')) {
    return 'The nearest store option is near Dubai Mall.';
  }
  if (message.includes('mall')) {
    return 'Dubai Mall information and store guidance.';
  }
  return 'Store guidance information.';
}

function synthesizeSpecialistResponse(toolCall: {
  name: string;
  input: Record<string, unknown>;
}): string {
  const target = toolCall.name.replace(/^handoff_to_/, '');
  const message = String(toolCall.input.message ?? '').toLowerCase();

  switch (target) {
    case 'ProductAgent':
      return resolveProductResponse(message);
    case 'AutomobileAgent':
      return resolveAutomobileResponse(message);
    case 'FAQAgent':
      return resolveFaqResponse(message);
    case 'StoreGuideAgent':
      return resolveStoreResponse(message);
    default:
      return '';
  }
}

function normalizeSupervisorTransfer(text: string): string {
  return text.replace(/^Transferring you to .*? One moment please\.?/, '');
}

function expectSupervisorClarification(text: string): void {
  const normalized = normalizeSupervisorTransfer(text);
  expect(normalized).toContain(
    'I need a little more detail to route that. Are you asking about structured metadata, or content inside the documents?',
  );
}

function expectAutomobileClarification(text: string): void {
  const normalized = normalizeSupervisorTransfer(text);
  expect(
    /auto_request_details|vehicle_condition|new or pre-owned|brand or budget/i.test(normalized),
    `Expected automobile clarification, got: ${text}`,
  ).toBe(true);
}

function expectProductTypeClarification(text: string): void {
  const normalized = normalizeSupervisorTransfer(text);
  expect(
    /type of product|please provide: product_type/i.test(normalized),
    `Expected product type clarification, got: ${text}`,
  ).toBe(true);
}

function expectBudgetClarification(text: string): void {
  const normalized = normalizeSupervisorTransfer(text);
  expect(
    /what is your budget|please provide: budget/i.test(normalized),
    `Expected budget clarification, got: ${text}`,
  ).toBe(true);
}

function expectProductDetailClarification(text: string): void {
  const normalized = normalizeSupervisorTransfer(text);
  expect(
    /color and budget|kind of product and budget|please provide: product_details/i.test(normalized),
    `Expected product detail clarification, got: ${text}`,
  ).toBe(true);
}

function expectConditionClarification(text: string): void {
  expect(
    /new or pre-owned|please provide: vehicle_condition/i.test(text),
    `Expected condition clarification, got: ${text}`,
  ).toBe(true);
}

function expectStoreLocatorResponse(text: string): void {
  expect(/nearest store option/i.test(text), `Expected store locator response, got: ${text}`).toBe(
    true,
  );
}

function getLatestFanOutResult(session: RuntimeSession): Array<{
  target: string;
  status: string;
  response?: string;
}> {
  const activeThread = getActiveThread(session);
  const raw = activeThread.data.values._last_fan_out;

  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results)) {
    return [];
  }

  return (raw as { results: Array<{ target: string; status: string; response?: string }> }).results;
}

function expectFanOutTargets(session: RuntimeSession, expectedTargets: string[]): void {
  expect(
    getLatestFanOutResult(session)
      .map((result) => result.target)
      .sort(),
  ).toEqual([...expectedTargets].sort());
}

function expectCompletedFanOutResponse(
  session: RuntimeSession,
  target: string,
  expectedResponse: string,
): void {
  const result = getLatestFanOutResult(session).find((item) => item.target === target);

  expect(result, `Expected fan-out result for ${target}`).toBeDefined();
  expect(result?.status).toBe('completed');
  expect(result?.response ?? '').toContain(expectedResponse);
}

function buildProductMessage(message: string): string {
  if (message.includes('casual wear under 500')) return 'casual wear under 500 AED';
  if (message.includes('formal shoes black under 800')) return 'formal shoes black under 800 AED';
  if (message.includes('something under 500')) return 'something under 500 AED';
  if (message.includes('casual wear')) return 'casual wear';
  if (message.includes('formal shoes')) return 'formal shoes';
  if (message.includes('clothing')) return 'clothing';
  return 'product request';
}

function buildAutomobileMessage(message: string): string {
  if (message.includes('pre-owned toyota under 100k')) return 'pre-owned toyota under 100k';
  if (message.includes('new toyota under 200k')) return 'new toyota under 200k';
  if (message.includes('toyota under 200k')) return 'toyota under 200k';
  if (message.includes('pre-owned toyota')) return 'pre-owned toyota';
  if (message.includes('cars under 100k')) return 'cars under 100k';
  if (message.includes('pre-owned cars')) return 'pre-owned cars';
  if (message.includes('new cars')) return 'new cars';
  if (message.includes('cars')) return 'cars';
  return 'automobile request';
}

function buildFaqMessage(message: string): string {
  if (message.includes('insurance')) return 'share insurance information';
  if (message.includes('education')) return 'share education information';
  return 'what is the return policy';
}

function buildStoreMessage(message: string): string {
  if (message.includes('store') || message.includes('near')) return 'find a store near Dubai Mall';
  if (message.includes('mall')) return 'tell me about the mall';
  return 'find a store near me';
}

function createHandoffCall(
  target: string,
  message: string,
): { id: string; name: string; input: Record<string, unknown> } {
  return {
    id: `handoff-${target}`,
    name: `handoff_to_${target}`,
    input: {
      reason: `Route to ${target}`,
      message,
    },
  };
}

function createRetailSupervisorHandler() {
  let pendingResponses: string[] = [];

  return (
    _systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    _tools: unknown[],
    operationType?: string,
  ): MockResponse => {
    if (operationType === 'extraction') {
      return textResponse('{}');
    }

    if (pendingResponses.length > 0) {
      const response = pendingResponses.join(' ');
      pendingResponses = [];
      return textResponse(response);
    }

    const userMessage = getLatestUserText(messages).toLowerCase();
    if (!userMessage) {
      return textResponse('How can I help with retail questions today?');
    }

    if (hasGreeting(userMessage)) {
      return textResponse('Hello! How can I help with retail questions today?');
    }

    if (hasAny(userMessage, ['flight booking', 'weather', 'jokes', 'cooking'])) {
      return textResponse(
        'I can help with retail products, automobiles, policies, and store guidance.',
      );
    }

    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    const wantsProduct = hasAny(userMessage, [
      'casual wear',
      'formal shoes',
      'clothing',
      'something under 500',
    ]);
    const wantsAutomobile = hasAny(userMessage, ['cars', 'pre-owned', 'toyota', 'new cars']);
    const wantsFaq = hasAny(userMessage, ['return policy', 'insurance', 'education']);
    const wantsStore = hasAny(userMessage, ['store', 'mall']);

    if (wantsProduct) {
      toolCalls.push(createHandoffCall('ProductAgent', buildProductMessage(userMessage)));
    }
    if (wantsAutomobile) {
      toolCalls.push(createHandoffCall('AutomobileAgent', buildAutomobileMessage(userMessage)));
    }
    if (wantsFaq) {
      toolCalls.push(createHandoffCall('FAQAgent', buildFaqMessage(userMessage)));
    }
    if (wantsStore) {
      toolCalls.push(createHandoffCall('StoreGuideAgent', buildStoreMessage(userMessage)));
    }

    if (toolCalls.length === 0) {
      return textResponse(
        'I can help with retail products, automobiles, policies, and store guidance.',
      );
    }

    pendingResponses = toolCalls
      .map((toolCall) => synthesizeSpecialistResponse(toolCall))
      .filter((response) => response.length > 0);

    return toolUseResponse('Routing to the right specialists.', toolCalls);
  };
}

function buildResolvedRetailAgents() {
  return compileToResolvedAgent(
    [RETAIL_SUPERVISOR, PRODUCT_AGENT, AUTOMOBILE_AGENT, FAQ_AGENT, STORE_GUIDE_AGENT],
    'RetailSupervisor',
  );
}

function createStandaloneSession(
  executor: RuntimeExecutor,
  dsl: string,
  name: string,
): RuntimeSession {
  return executor.createSessionFromResolved(compileToResolvedAgent([dsl], name));
}

function createRetailSupervisorSession(executor: RuntimeExecutor): RuntimeSession {
  const session = executor.createSessionFromResolved(buildResolvedRetailAgents());
  const projectRuntimeConfig = {
    extraction_strategy: 'auto' as const,
    multi_intent: {
      enabled: true,
      strategy: 'parallel' as const,
      max_intents: 4,
      confidence_threshold: 0.6,
      queue_max_age_ms: 300_000,
    },
    inference: {
      confidence: 0.8,
      confirm: true,
      model_tier: 'fast' as const,
      max_fields_per_pass: 3,
    },
    conversion: { currency_mode: 'static' as const },
    lookup_tables: [],
  };

  session._projectRuntimeConfig = projectRuntimeConfig;
  if (session.agentIR) {
    session.agentIR.project_runtime_config = projectRuntimeConfig;
  }

  return session;
}

function getWaitingFanOutChildren(session: RuntimeSession): RuntimeSession['threads'] {
  return session.threads.filter(
    (thread) => thread.data.values._fan_out_child === true && thread.status === 'waiting',
  );
}

describe('ABL scenario coverage regressions', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  afterEach(() => {
    executor.stopStaleReaper();
  });

  describe('Single-agent scenarios', () => {
    test('1.0 Single Intent — Product Search complete data', async () => {
      const session = createStandaloneSession(executor, PRODUCT_AGENT, 'ProductAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'casual wear under 500');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Product options for casual wear within under 500 AED.');
      expect(session.isComplete).toBe(true);
    });

    test('2.0 Single Intent — Product Search missing type asks a clarification', async () => {
      const session = createStandaloneSession(executor, PRODUCT_AGENT, 'ProductAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'something under 500');
      const output = getVisibleResponse(session, result);

      expectProductTypeClarification(output);
      expect(session.isComplete).toBe(false);
    });

    test('3.0 Single Intent — Product Search missing budget asks a clarification', async () => {
      const session = createStandaloneSession(executor, PRODUCT_AGENT, 'ProductAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'casual wear');
      const output = getVisibleResponse(session, result);

      expectBudgetClarification(output);
      expect(session.isComplete).toBe(false);
    });

    test('4.0 Single Intent — Automobile Search complete data', async () => {
      const session = createStandaloneSession(executor, AUTOMOBILE_AGENT, 'AutomobileAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'pre-owned toyota under 100k');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Automobile options for pre-owned cars within under 100K.');
      expect(session.isComplete).toBe(true);
    });

    test('5.0 Single Intent — Automobile Search missing condition asks a clarification', async () => {
      const session = createStandaloneSession(executor, AUTOMOBILE_AGENT, 'AutomobileAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'cars under 100k');
      const output = getVisibleResponse(session, result);

      expectConditionClarification(output);
      expect(session.isComplete).toBe(false);
    });

    test('6.0 Single Intent — Automobile Search missing budget asks a clarification', async () => {
      const session = createStandaloneSession(executor, AUTOMOBILE_AGENT, 'AutomobileAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'pre-owned toyota');
      const output = getVisibleResponse(session, result);

      expectBudgetClarification(output);
      expect(session.isComplete).toBe(false);
    });

    test('7.0 Single Intent — FAQ / Policy return policy query', async () => {
      const session = createStandaloneSession(executor, FAQ_AGENT, 'FAQAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'return policy');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Marks & Spencer return policy information.');
      expect(session.isComplete).toBe(true);
    });

    test('8.0 Single Intent — FAQ / Policy insurance query', async () => {
      const session = createStandaloneSession(executor, FAQ_AGENT, 'FAQAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'insurance');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Insurance knowledge base guidance.');
      expect(session.isComplete).toBe(true);
    });

    test('9.0 Single Intent — FAQ / Policy education query', async () => {
      const session = createStandaloneSession(executor, FAQ_AGENT, 'FAQAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'education');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Education knowledge base guidance.');
      expect(session.isComplete).toBe(true);
    });

    test('10.0 Single Intent — Store Guide store locator query', async () => {
      const session = createStandaloneSession(executor, STORE_GUIDE_AGENT, 'StoreGuideAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'store near');
      const output = getVisibleResponse(session, result);

      expectStoreLocatorResponse(output);
      expect(session.isComplete).toBe(true);
    });

    test('11.0 Single Intent — Store Guide mall info query', async () => {
      const session = createStandaloneSession(executor, STORE_GUIDE_AGENT, 'StoreGuideAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'mall');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Dubai Mall information and store guidance.');
      expect(session.isComplete).toBe(true);
    });

    test('12.0 Greeting on ProductAgent', async () => {
      const session = createStandaloneSession(executor, PRODUCT_AGENT, 'ProductAgent');
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'hello');
      const output = getVisibleResponse(session, result);

      expect(output).toContain('Hello! I can help with product searches.');
      expect(session.isComplete).toBe(true);
    });

    test('25.0 Iterative Product — budget follow-up', async () => {
      const session = createStandaloneSession(executor, PRODUCT_AGENT, 'ProductAgent');
      await executor.initializeSession(session.id);

      const firstTurn = await sendMessage(executor, session.id, 'casual wear');
      expectBudgetClarification(getVisibleResponse(session, firstTurn));
      expect(session.isComplete).toBe(false);

      const secondTurn = await sendMessage(executor, session.id, 'under 500 AED');
      expect(getVisibleResponse(session, secondTurn)).toContain(
        'Product options for casual wear within under 500 AED.',
      );
      expect(session.isComplete).toBe(true);
    });

    test('26.0 Iterative Product — color + budget follow-up', async () => {
      const session = createStandaloneSession(executor, PRODUCT_AGENT, 'ProductAgent');
      await executor.initializeSession(session.id);

      const firstTurn = await sendMessage(executor, session.id, 'formal shoes');
      expectProductDetailClarification(getVisibleResponse(session, firstTurn));
      expect(session.isComplete).toBe(false);

      const secondTurn = await sendMessage(executor, session.id, 'black under 800 AED');
      expect(getVisibleResponse(session, secondTurn)).toContain(
        'Product options for formal shoes matching black under 800 AED.',
      );
      expect(session.isComplete).toBe(true);
    });

    test('27.0 Iterative Automobile — budget follow-up', async () => {
      const session = createStandaloneSession(executor, AUTOMOBILE_AGENT, 'AutomobileAgent');
      await executor.initializeSession(session.id);

      const firstTurn = await sendMessage(executor, session.id, 'pre-owned cars');
      expectBudgetClarification(getVisibleResponse(session, firstTurn));
      expect(session.isComplete).toBe(false);

      const secondTurn = await sendMessage(executor, session.id, 'under 100K');
      expect(getVisibleResponse(session, secondTurn)).toContain(
        'Automobile options for pre-owned cars within under 100K.',
      );
      expect(session.isComplete).toBe(true);
    });

    test('28.0 Iterative Automobile — brand + budget follow-up', async () => {
      const session = createStandaloneSession(executor, AUTOMOBILE_AGENT, 'AutomobileAgent');
      await executor.initializeSession(session.id);

      const firstTurn = await sendMessage(executor, session.id, 'new cars');
      expectAutomobileClarification(getVisibleResponse(session, firstTurn));
      expect(session.isComplete).toBe(false);

      const secondTurn = await sendMessage(executor, session.id, 'Toyota under 200K');
      expect(getVisibleResponse(session, secondTurn)).toContain(
        'Automobile options for Toyota under 200K.',
      );
      expect(session.isComplete).toBe(true);
    });
  });

  describe('Supervisor and multi-agent scenarios', () => {
    beforeEach(() => {
      const mockClient = injectValidatingMockClient(executor);
      mockClient.setResponseHandler(createRetailSupervisorHandler());
    });

    test('13.0 Out-of-domain request is handled by the supervisor directly', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'tell me a weather joke');
      const output = getVisibleResponse(session, result);

      expectSupervisorClarification(output);
      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
    });

    test('14.0 Product + FAQ both complete', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(
        executor,
        session.id,
        'casual wear under 500 and return policy',
      );
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['FAQAgent', 'ProductAgent']);
      expectCompletedFanOutResponse(
        session,
        'ProductAgent',
        'Product options for casual wear within under 500 AED.',
      );
      expectCompletedFanOutResponse(
        session,
        'FAQAgent',
        'Marks & Spencer return policy information.',
      );
      expect(output).toContain('Product options for casual wear within under 500 AED.');
      expect(output).toContain('Marks & Spencer return policy information.');
    });

    test('14.0 lifecycle contract prunes FAQ child after completion', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      await sendMessage(executor, session.id, 'casual wear under 500 and return policy');

      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
    });

    test('15.0 Automobile + StoreGuide both complete', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(
        executor,
        session.id,
        'pre-owned toyota under 100k and store near mall',
      );
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['AutomobileAgent', 'StoreGuideAgent']);
      expectCompletedFanOutResponse(
        session,
        'AutomobileAgent',
        'Automobile options for pre-owned cars within under 100K.',
      );
      expectCompletedFanOutResponse(
        session,
        'StoreGuideAgent',
        'The nearest store option is near Dubai Mall.',
      );
      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
    });

    test('16.0 Product + Automobile both complete', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(
        executor,
        session.id,
        'casual wear under 500 and pre-owned toyota under 100k',
      );
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['AutomobileAgent', 'ProductAgent']);
      expectCompletedFanOutResponse(
        session,
        'ProductAgent',
        'Product options for casual wear within under 500 AED.',
      );
      expectCompletedFanOutResponse(
        session,
        'AutomobileAgent',
        'Automobile options for pre-owned cars within under 100K.',
      );
      expect(output).toContain('Product options for casual wear within under 500 AED.');
      expect(output).toContain('Automobile options for pre-owned cars within under 100K.');
      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
    });

    test('17.0 Three agents parallel all complete', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(
        executor,
        session.id,
        'casual wear under 500, return policy, and store near mall',
      );
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['FAQAgent', 'ProductAgent', 'StoreGuideAgent']);
      expectCompletedFanOutResponse(
        session,
        'ProductAgent',
        'Product options for casual wear within under 500 AED.',
      );
      expectCompletedFanOutResponse(
        session,
        'FAQAgent',
        'Marks & Spencer return policy information.',
      );
      expectCompletedFanOutResponse(
        session,
        'StoreGuideAgent',
        'The nearest store option is near Dubai Mall.',
      );
    });

    test('17.0 lifecycle contract prunes FAQ child in three-agent complete fan-out', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      await sendMessage(
        executor,
        session.id,
        'casual wear under 500, return policy, and store near mall',
      );

      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
    });

    test('18.0 Automobile + FAQ both complete', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(
        executor,
        session.id,
        'pre-owned toyota under 100k and insurance',
      );
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['AutomobileAgent', 'FAQAgent']);
      expectCompletedFanOutResponse(
        session,
        'AutomobileAgent',
        'Automobile options for pre-owned cars within under 100K.',
      );
      expectCompletedFanOutResponse(session, 'FAQAgent', 'Insurance knowledge base guidance.');
      expect(output).toContain('Automobile options for pre-owned cars within under 100K.');
      expect(output).toContain('Insurance knowledge base guidance.');
    });

    test('18.0 lifecycle contract prunes FAQ child after auto + FAQ completion', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      await sendMessage(executor, session.id, 'pre-owned toyota under 100k and insurance');

      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
    });

    test('19.0 Multi-Intent — both agents need data', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'clothing and cars');
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['AutomobileAgent', 'ProductAgent']);
      expectProductDetailClarification(output);
      expectAutomobileClarification(output);
      expect(
        getWaitingFanOutChildren(session)
          .map((thread) => thread.agentName)
          .sort(),
      ).toEqual(['AutomobileAgent', 'ProductAgent']);
    });

    test('20.0 Multi-Intent — FAQ complete and Product missing', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'return policy and casual wear');
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['FAQAgent', 'ProductAgent']);
      expect(output).toContain('What is your budget?');
      expect(output).toContain('Marks & Spencer return policy information.');
      expect(getWaitingFanOutChildren(session).map((thread) => thread.agentName)).toContain(
        'ProductAgent',
      );
    });

    test('20.0 lifecycle contract keeps only ProductAgent waiting after FAQ completes', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      await sendMessage(executor, session.id, 'return policy and casual wear');

      expect(getWaitingFanOutChildren(session).map((thread) => thread.agentName)).toEqual([
        'ProductAgent',
      ]);
    });

    test('21.0 Multi-Intent — Product complete and Auto missing', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'casual wear under 500 and new cars');
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['AutomobileAgent', 'ProductAgent']);
      expectCompletedFanOutResponse(
        session,
        'ProductAgent',
        'Product options for casual wear within under 500 AED.',
      );
      expect(output).toContain('Product options for casual wear within under 500 AED.');
      expectAutomobileClarification(output);
      expect(getWaitingFanOutChildren(session).map((thread) => thread.agentName)).toEqual([
        'AutomobileAgent',
      ]);
    });

    test('22.0 Multi-Intent — StoreGuide complete and Product missing', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const result = await sendMessage(executor, session.id, 'store near mall and casual wear');
      const output = getVisibleResponse(session, result);

      expectFanOutTargets(session, ['ProductAgent', 'StoreGuideAgent']);
      expect(output).toContain('The nearest store option is near Dubai Mall.');
      expect(output).toContain('What is your budget?');
      expect(getWaitingFanOutChildren(session).map((thread) => thread.agentName)).toEqual([
        'ProductAgent',
      ]);
    });

    test('23.0 Multi-agent follow-up Turn 2 resumes waiting fan-out children', async () => {
      const session = createRetailSupervisorSession(executor);
      await executor.initializeSession(session.id);

      const firstTurn = await sendMessage(executor, session.id, 'clothing and cars');
      const firstOutput = getVisibleResponse(session, firstTurn);
      expectFanOutTargets(session, ['AutomobileAgent', 'ProductAgent']);
      expectProductDetailClarification(firstOutput);
      expectAutomobileClarification(firstOutput);
      expect(
        getWaitingFanOutChildren(session)
          .map((thread) => thread.agentName)
          .sort(),
      ).toEqual(['AutomobileAgent', 'ProductAgent']);

      const secondTurn = await sendMessage(
        executor,
        session.id,
        'casual wear under 500 and pre-owned toyota under 100k',
      );
      const secondOutput = getVisibleResponse(session, secondTurn);

      expectFanOutTargets(session, ['AutomobileAgent', 'ProductAgent']);
      expectCompletedFanOutResponse(
        session,
        'ProductAgent',
        'Product options for casual wear within under 500 AED.',
      );
      expectCompletedFanOutResponse(
        session,
        'AutomobileAgent',
        'Automobile options for pre-owned cars within under 100K.',
      );
      expect(secondOutput).toContain('Product options for casual wear within under 500 AED.');
      expect(secondOutput).toContain('Automobile options for pre-owned cars within under 100K.');
      expect(getWaitingFanOutChildren(session)).toHaveLength(0);
      expect(
        session.threads.filter(
          (thread) => thread.agentName === 'ProductAgent' && thread.status === 'waiting',
        ),
      ).toHaveLength(0);
      expect(
        session.threads.filter(
          (thread) => thread.agentName === 'AutomobileAgent' && thread.status === 'waiting',
        ),
      ).toHaveLength(0);
    });
  });
});
