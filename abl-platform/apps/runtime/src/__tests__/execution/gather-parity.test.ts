import { describe, expect, test } from 'vitest';
import type {
  FlowGatherField,
  GatherField,
  LookupTableIR,
  ValidationRule,
} from '@abl/compiler/platform/ir/schema.js';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  type RuntimeSession,
} from '../../services/runtime-executor';
import {
  createTraceCollector,
  filterTraces,
  injectValidatingMockClient,
  type LLMCall,
  type ValidatingMockAnthropicClient,
} from '../helpers/history-validation';

const SCRIPTED_LOOKUP_AGENT = `
AGENT: Scripted_Lookup_Parity

GOAL: "Collect a departure airport"

GATHER:
  airport:
    prompt: "Which airport are you leaving from?"
    type: string
    required: true

FLOW:
  entry_point: collect_airport
  steps:
    - collect_airport
    - done

collect_airport:
  REASONING: false
  GATHER:
    - airport: required
  THEN: done

done:
  REASONING: false
  RESPOND: "Flying out of {{airport}}."
  THEN: COMPLETE
`;

const INLINE_LOOKUP_AGENT = `
AGENT: Inline_Lookup_Parity

GOAL: "Collect a departure airport"

PERSONA: "Travel assistant"

GATHER:
  airport:
    prompt: "Which airport are you leaving from?"
    type: string
    required: true
`;

const SCRIPTED_ENUM_AGENT = `
AGENT: Scripted_Enum_Parity

GOAL: "Collect a plan choice"

GATHER:
  plan:
    prompt: "Which plan do you want?"
    type: string
    required: true

FLOW:
  entry_point: collect_plan
  steps:
    - collect_plan
    - done

collect_plan:
  REASONING: false
  GATHER:
    - plan: required
  THEN: done

done:
  REASONING: false
  RESPOND: "Selected {{plan}}."
  THEN: COMPLETE
`;

const INLINE_ENUM_AGENT = `
AGENT: Inline_Enum_Parity

GOAL: "Collect a plan choice"

PERSONA: "Plan assistant"

GATHER:
  plan:
    prompt: "Which plan do you want?"
    type: string
    required: true
`;

type GatherFieldLike = GatherField | FlowGatherField;

function getTopLevelGatherFields(session: RuntimeSession): GatherField[] {
  return session.agentIR?.gather?.fields ?? [];
}

function getFlowGatherFields(session: RuntimeSession): FlowGatherField[] {
  const definitions = session.agentIR?.flow?.definitions;
  if (!definitions) {
    return [];
  }

  return Object.values(definitions).flatMap((step) => step.gather?.fields ?? []);
}

function getAllGatherFields(session: RuntimeSession): GatherFieldLike[] {
  return [...getTopLevelGatherFields(session), ...getFlowGatherFields(session)];
}

function patchGatherField(
  session: RuntimeSession,
  fieldName: string,
  patch: Partial<GatherFieldLike>,
): void {
  const matchingFields = getAllGatherFields(session).filter((field) => field.name === fieldName);
  expect(matchingFields.length).toBeGreaterThan(0);

  for (const field of matchingFields) {
    Object.assign(field, patch);
  }
}

function installLookupField(
  session: RuntimeSession,
  fieldName: string,
  tableName: string,
  values: string[],
): void {
  expect(session.agentIR).not.toBeNull();

  const table: LookupTableIR = {
    name: tableName,
    source: 'inline',
    values,
    case_sensitive: false,
    fuzzy_match: false,
    fuzzy_threshold: 0.85,
  };

  session.agentIR!.lookup_tables = {
    ...(session.agentIR!.lookup_tables ?? {}),
    [tableName]: table,
  };

  patchGatherField(session, fieldName, {
    semantics: { lookup: tableName },
  });
}

function installEnumValidation(
  session: RuntimeSession,
  fieldName: string,
  allowedValues: string[],
): void {
  const validation: ValidationRule = {
    type: 'enum',
    rule: allowedValues.join('|'),
    error_message: `Value must be one of: ${allowedValues.join(', ')}`,
  };

  patchGatherField(session, fieldName, { validation });
}

function createScriptedHarness(
  dsl: string,
  agentName: string,
): {
  executor: RuntimeExecutor;
  session: RuntimeSession;
  mockClient: ValidatingMockAnthropicClient;
} {
  const executor = new RuntimeExecutor();
  const mockClient = injectValidatingMockClient(executor);
  const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], agentName));

  return { executor, session, mockClient };
}

function createInlineGatherHarness(
  dsl: string,
  agentName: string,
): {
  executor: RuntimeExecutor;
  session: RuntimeSession;
  mockClient: ValidatingMockAnthropicClient;
} {
  const executor = new RuntimeExecutor();
  const mockClient = injectValidatingMockClient(executor);
  const session = executor.createSessionFromResolved(compileToResolvedAgent([dsl], agentName));

  expect(session.agentIR).not.toBeNull();
  session.agentIR!.execution = {
    ...(session.agentIR!.execution ?? {}),
    inline_gather: true,
  };

  return { executor, session, mockClient };
}

function buildExtractToolUseResponse(input: Record<string, unknown>) {
  return {
    text: '',
    toolCalls: [{ id: 'extract-1', name: '_extract_entities', input }],
    stopReason: 'tool_use',
    rawContent: [{ type: 'tool_use', id: 'extract-1', name: '_extract_entities', input }],
  };
}

function buildTextResponse(text: string) {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    rawContent: [{ type: 'text', text }],
  };
}

function findExtractionCall(calls: LLMCall[]): LLMCall | undefined {
  return calls.find((call) =>
    call.tools.some(
      (tool) =>
        typeof tool === 'object' &&
        tool !== null &&
        'name' in tool &&
        (tool as { name?: unknown }).name === '_extract_entities',
    ),
  );
}

function extractFieldSchema(call: LLMCall, fieldName: string): Record<string, unknown> | undefined {
  const extractionTool = call.tools.find(
    (tool) =>
      typeof tool === 'object' &&
      tool !== null &&
      'name' in tool &&
      (tool as { name?: unknown }).name === '_extract_entities',
  ) as { input_schema?: { properties?: Record<string, Record<string, unknown>> } } | undefined;

  return extractionTool?.input_schema?.properties?.[fieldName];
}

describe('Gather parity coverage', () => {
  test('inline_gather injects inline lookup values into the _extract_entities schema', async () => {
    const { executor, session, mockClient } = createInlineGatherHarness(
      INLINE_LOOKUP_AGENT,
      'Inline_Lookup_Parity',
    );
    installLookupField(session, 'airport', 'airports', ['LAX', 'JFK']);

    let extractionRequested = false;
    mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      const hasExtractionTool = tools.some(
        (tool) =>
          typeof tool === 'object' &&
          tool !== null &&
          'name' in tool &&
          (tool as { name?: unknown }).name === '_extract_entities',
      );

      if (hasExtractionTool && !extractionRequested) {
        extractionRequested = true;
        return buildExtractToolUseResponse({ airport: 'LAX' });
      }

      return buildTextResponse('Airport captured.');
    });

    await executor.executeMessage(session.id, 'Leaving from LAX');

    const extractionCall = findExtractionCall(mockClient.calls);
    expect(extractionCall).toBeDefined();

    const airportSchema = extractFieldSchema(extractionCall!, 'airport');
    expect(airportSchema?.enum).toEqual(['LAX', 'JFK']);
  });

  test('scripted gather and inline_gather both canonicalize lookup values before storing them', async () => {
    const scripted = createScriptedHarness(SCRIPTED_LOOKUP_AGENT, 'Scripted_Lookup_Parity');
    installLookupField(scripted.session, 'airport', 'airports', ['LAX', 'JFK']);
    scripted.mockClient.setEntityExtractionResponse({ airport: 'lax' });

    await scripted.executor.initializeSession(scripted.session.id);
    await scripted.executor.executeMessage(scripted.session.id, 'I am leaving from lax');

    const inline = createInlineGatherHarness(INLINE_LOOKUP_AGENT, 'Inline_Lookup_Parity');
    installLookupField(inline.session, 'airport', 'airports', ['LAX', 'JFK']);

    let extractionRequested = false;
    inline.mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      const hasExtractionTool = tools.some(
        (tool) =>
          typeof tool === 'object' &&
          tool !== null &&
          'name' in tool &&
          (tool as { name?: unknown }).name === '_extract_entities',
      );

      if (hasExtractionTool && !extractionRequested) {
        extractionRequested = true;
        return buildExtractToolUseResponse({ airport: 'lax' });
      }

      return buildTextResponse('Airport captured.');
    });

    const inlineTraceCollector = createTraceCollector();
    await inline.executor.executeMessage(
      inline.session.id,
      'I am leaving from lax',
      undefined,
      inlineTraceCollector.callback,
    );

    expect(scripted.session.data.values.airport).toBe('LAX');
    expect(inline.session.data.values.airport).toBe('LAX');

    const inlineCollect = filterTraces(inlineTraceCollector.traces, 'dsl_collect').find(
      (trace) => trace.data.mode === 'inline_gather',
    );
    expect(inlineCollect).toBeDefined();
  });

  test('scripted gather and inline_gather both reject invalid enum values without storing them', async () => {
    const allowedPlans = ['basic', 'pro', 'enterprise'];

    const scripted = createScriptedHarness(SCRIPTED_ENUM_AGENT, 'Scripted_Enum_Parity');
    installEnumValidation(scripted.session, 'plan', allowedPlans);
    scripted.mockClient.setEntityExtractionResponse({ plan: 'premium' });

    await scripted.executor.initializeSession(scripted.session.id);
    await scripted.executor.executeMessage(scripted.session.id, 'I want the premium tier');

    const inline = createInlineGatherHarness(INLINE_ENUM_AGENT, 'Inline_Enum_Parity');
    installEnumValidation(inline.session, 'plan', allowedPlans);

    let extractionRequested = false;
    inline.mockClient.setResponseHandler((systemPrompt, messages, tools) => {
      const hasExtractionTool = tools.some(
        (tool) =>
          typeof tool === 'object' &&
          tool !== null &&
          'name' in tool &&
          (tool as { name?: unknown }).name === '_extract_entities',
      );

      if (hasExtractionTool && !extractionRequested) {
        extractionRequested = true;
        return buildExtractToolUseResponse({ plan: 'premium' });
      }

      return buildTextResponse('Please choose basic, pro, or enterprise.');
    });

    await inline.executor.executeMessage(inline.session.id, 'I want the premium tier');

    expect(scripted.session.data.values.plan).toBeUndefined();
    expect(inline.session.data.values.plan).toBeUndefined();

    const scriptedRetries = scripted.session.data.values._validation_retries as
      | Record<string, number>
      | undefined;
    const inlineRetries = inline.session.data.values._validation_retries as
      | Record<string, number>
      | undefined;
    expect(scriptedRetries?.plan).toBe(1);
    expect(inlineRetries?.plan).toBe(1);
  });

  test('inline_gather fallback applies lookup canonicalization before persisting extracted values', async () => {
    const { executor, session, mockClient } = createInlineGatherHarness(
      INLINE_LOOKUP_AGENT,
      'Inline_Lookup_Parity',
    );
    installLookupField(session, 'airport', 'airports', ['LAX', 'JFK']);

    mockClient.setResponseHandler((systemPrompt, messages, tools, operationType) => {
      if (operationType === 'extraction') {
        return buildExtractToolUseResponse({ airport: 'lax' });
      }

      return buildTextResponse('Tell me a little more about your trip.');
    });

    const traceCollector = createTraceCollector();
    await executor.executeMessage(
      session.id,
      'I am leaving from lax',
      undefined,
      traceCollector.callback,
    );

    expect(session.data.values.airport).toBe('LAX');

    const fallbackTrace = filterTraces(traceCollector.traces, 'dsl_collect').find(
      (trace) => trace.data.mode === 'inline_gather_fallback',
    );
    expect(fallbackTrace).toBeDefined();
    expect(fallbackTrace!.data.extracted).toEqual({ airport: 'LAX' });
  });
});
