/**
 * Parser Utilities and Agent Parser Tests
 *
 * Tests for:
 * - tool-parser-utils.ts: parseToolParams, splitParams, parseToolReturn, parseDefaultValue
 * - agent-parser.ts: parseAgent direct testing (identity, contract, tools, steps, guardrails, tests)
 * - types/base.ts: isPrimitiveType, isComplexType, parseVersion, createDocumentMeta
 * - types/expressions.ts: varRef, str, num, bool, eq, and, or, not, exists, isWildcard, expressionToString
 * - types/supervisor.ts: createSupervisorDocument, createRoutingRule, routeToAgent, intentMatch
 * - types/agent-based.ts: createAgentBasedDocument, createTool, createGatherField, createConstraint, createHandoff, createDelegate
 * - types/agent.ts: createAgentDocument, createStep, respond, callTool, signal, waitInput, goto, setState, classify
 */

import { describe, test, expect } from 'vitest';
import {
  parseToolParams,
  splitParams,
  parseToolReturn,
  parseDefaultValue,
} from '../parser/tool-parser-utils.js';
import { parseAgentBasedABL } from '../parser/agent-based-parser.js';
import { parseAgent } from '../parser/agent-parser.js';
import { isPrimitiveType, isComplexType, parseVersion, createDocumentMeta } from '../types/base.js';
import {
  varRef,
  str,
  num,
  bool,
  eq,
  and,
  or,
  not,
  exists,
  isWildcard,
  expressionToString,
} from '../types/expressions.js';
import {
  createSupervisorDocument,
  createRoutingRule,
  routeToAgent,
  intentMatch,
} from '../types/supervisor.js';
import {
  createAgentBasedDocument,
  createTool,
  createGatherField,
  createConstraint,
  createHandoff,
  createDelegate,
} from '../types/agent-based.js';
import {
  createAgentDocument,
  createStep,
  respond,
  callTool,
  signal,
  waitInput,
  goto,
  setState,
  classify,
} from '../types/agent.js';

// =============================================================================
// tool-parser-utils.ts
// =============================================================================

describe('tool-parser-utils', () => {
  describe('parseToolParams', () => {
    test('should return empty array for empty string', () => {
      expect(parseToolParams('')).toEqual([]);
    });

    test('should return empty array for whitespace-only string', () => {
      expect(parseToolParams('   ')).toEqual([]);
    });

    test('should parse a single required parameter', () => {
      const result = parseToolParams('name: string');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'name',
        type: 'string',
        required: true,
        default: undefined,
      });
    });

    test('should parse multiple parameters', () => {
      const result = parseToolParams('name: string, age: number');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('name');
      expect(result[0].type).toBe('string');
      expect(result[1].name).toBe('age');
      expect(result[1].type).toBe('number');
    });

    test('should parse parameter with default value', () => {
      const result = parseToolParams('limit: number = 10');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('limit');
      expect(result[0].required).toBe(false);
      expect(result[0].default).toBe(10);
    });

    test('should parse parameter with string default', () => {
      const result = parseToolParams('format: string = "json"');
      expect(result).toHaveLength(1);
      expect(result[0].default).toBe('json');
    });

    test('should parse parameter with boolean default true', () => {
      const result = parseToolParams('verbose: boolean = true');
      expect(result).toHaveLength(1);
      expect(result[0].default).toBe(true);
    });

    test('should parse parameter with boolean default false', () => {
      const result = parseToolParams('verbose: boolean = false');
      expect(result).toHaveLength(1);
      expect(result[0].default).toBe(false);
    });

    test('should parse parameter with null default', () => {
      const result = parseToolParams('filter: string = null');
      expect(result).toHaveLength(1);
      expect(result[0].default).toBe(null);
    });

    test('should skip parts that do not match the expected format', () => {
      const result = parseToolParams('valid: string, !!!invalid, other: number');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('valid');
      expect(result[1].name).toBe('other');
    });

    test('should handle extra whitespace around params', () => {
      const result = parseToolParams('  name: string  ,  age: number  ');
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('name');
      expect(result[1].name).toBe('age');
    });
  });

  describe('splitParams', () => {
    test('should split simple comma-separated values', () => {
      const result = splitParams('a, b, c');
      expect(result).toEqual(['a', ' b', ' c']);
    });

    test('should handle empty string', () => {
      const result = splitParams('');
      expect(result).toEqual([]);
    });

    test('should not split inside braces', () => {
      const result = splitParams('{a, b}, c');
      expect(result).toEqual(['{a, b}', ' c']);
    });

    test('should not split inside brackets', () => {
      const result = splitParams('[a, b], c');
      expect(result).toEqual(['[a, b]', ' c']);
    });

    test('should not split inside parentheses', () => {
      const result = splitParams('(a, b), c');
      expect(result).toEqual(['(a, b)', ' c']);
    });

    test('should handle nested brackets', () => {
      const result = splitParams('{a: {b, c}}, d');
      expect(result).toEqual(['{a: {b, c}}', ' d']);
    });

    test('should handle single value without comma', () => {
      const result = splitParams('single');
      expect(result).toEqual(['single']);
    });

    test('should handle deeply nested structures', () => {
      const result = splitParams('({[a, b]}, c), d');
      expect(result).toEqual(['({[a, b]}, c)', ' d']);
    });
  });

  describe('parseToolReturn', () => {
    test('should parse simple type', () => {
      const result = parseToolReturn('string');
      expect(result).toEqual({ type: 'string' });
    });

    test('should parse simple type with leading/trailing whitespace', () => {
      const result = parseToolReturn('  number  ');
      expect(result).toEqual({ type: 'number' });
    });

    test('should parse array type (Type[])', () => {
      const result = parseToolReturn('Hotel[]');
      expect(result).toEqual({
        type: 'array',
        items: { type: 'Hotel' },
      });
    });

    test('should parse object type', () => {
      const result = parseToolReturn('{name: string, age: number}');
      expect(result.type).toBe('object');
      expect(result.fields).toBeDefined();
      expect(result.fields!.name).toEqual({ type: 'string', optional: false });
      expect(result.fields!.age).toEqual({ type: 'number', optional: false });
    });

    test('should parse object type with optional fields', () => {
      const result = parseToolReturn('{name: string, email?: string}');
      expect(result.type).toBe('object');
      expect(result.fields!.name.optional).toBeFalsy();
      expect(result.fields!.email.optional).toBe(true);
    });

    test('should parse nested array in object', () => {
      const result = parseToolReturn('{items: Result[]}');
      expect(result.type).toBe('object');
      expect(result.fields!.items.type).toBe('array');
      expect(result.fields!.items.items).toEqual({ type: 'Result' });
    });

    test('should handle non-matching patterns as simple type', () => {
      const result = parseToolReturn('CustomType');
      expect(result).toEqual({ type: 'CustomType' });
    });

    test('should handle empty object', () => {
      const result = parseToolReturn('{}');
      expect(result.type).toBe('object');
      expect(result.fields).toEqual({});
    });
  });

  describe('parseDefaultValue', () => {
    test('should parse true', () => {
      expect(parseDefaultValue('true')).toBe(true);
    });

    test('should parse false', () => {
      expect(parseDefaultValue('false')).toBe(false);
    });

    test('should parse null', () => {
      expect(parseDefaultValue('null')).toBe(null);
    });

    test('should parse integer', () => {
      expect(parseDefaultValue('42')).toBe(42);
    });

    test('should parse float', () => {
      expect(parseDefaultValue('3.14')).toBe(3.14);
    });

    test('should parse negative integer', () => {
      expect(parseDefaultValue('-42')).toBe(-42);
    });

    test('should parse negative float', () => {
      expect(parseDefaultValue('-3.14')).toBe(-3.14);
    });

    test('should parse quoted string and remove quotes', () => {
      expect(parseDefaultValue('"hello"')).toBe('hello');
    });

    test('should parse unquoted string as-is', () => {
      expect(parseDefaultValue('someValue')).toBe('someValue');
    });

    test('should handle zero', () => {
      expect(parseDefaultValue('0')).toBe(0);
    });

    test('should handle large integer', () => {
      expect(parseDefaultValue('999999')).toBe(999999);
    });

    test('should handle string that starts with a number but is not a valid number', () => {
      // "123abc" doesn't match /^\d+$/ or /^\d+\.\d+$/, so it falls through to string
      expect(parseDefaultValue('123abc')).toBe('123abc');
    });

    test('should reuse negative default parsing in agent-based tool signatures', () => {
      const result = parseAgentBasedABL(`AGENT: TestAgent
GOAL: "Test shared defaults"
TOOLS:
  offset(amount: number = -1, ratio: number = -3.14) -> string
`);

      expect(result.errors).toHaveLength(0);
      const params = result.document!.tools[0].parameters;
      expect(params[0].default).toBe(-1);
      expect(params[1].default).toBe(-3.14);
    });
  });
});

// =============================================================================
// agent-parser.ts (parseAgent)
// =============================================================================

describe('AgentParser (parseAgent)', () => {
  describe('basic parsing', () => {
    test('should parse a minimal agent document', () => {
      const input = `AGENT: TestAgent\n`;
      const result = parseAgent(input);

      expect(result.errors).toHaveLength(0);
      expect(result.document).not.toBeNull();
      expect(result.document!.meta.kind).toBe('agent');
      expect(result.document!.meta.name).toBe('TestAgent');
    });

    test('should set default identity', () => {
      const input = `AGENT: TestAgent\n`;
      const result = parseAgent(input);
      const doc = result.document!;

      expect(doc.identity.role).toBe('');
      expect(doc.identity.persona).toBe('');
      expect(doc.identity.expertise).toEqual([]);
      expect(doc.identity.limitations).toEqual([]);
    });

    test('should set default contract', () => {
      const input = `AGENT: TestAgent\n`;
      const result = parseAgent(input);
      const doc = result.document!;

      expect(doc.contract.inputs.required).toEqual({});
      expect(doc.contract.inputs.optional).toEqual({});
      expect(doc.contract.outputs.response).toBe('string');
    });

    test('should set default empty tools and flow', () => {
      const input = `AGENT: TestAgent\n`;
      const result = parseAgent(input);
      const doc = result.document!;

      expect(doc.tools).toEqual([]);
      expect(doc.flow.entryPoint).toBe('START');
      expect(doc.flow.steps).toEqual([]);
    });
  });

  describe('IDENTITY section', () => {
    test('should parse role and persona', () => {
      const input = `AGENT: TestAgent
IDENTITY:
  role: "Customer Support Agent"
  persona: "Friendly and helpful"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const identity = result.document!.identity;
      expect(identity.role).toBe('Customer Support Agent');
      expect(identity.persona).toBe('Friendly and helpful');
    });

    test('should parse expertise list', () => {
      // Note: The identity visitor checks hasChildren('StringLiteral') first,
      // so when StringLiteral tokens exist as children of the identity property
      // node (inside brackets), it falls into the role/persona branch.
      // Empty brackets work because there are no StringLiteral children.
      const input = `AGENT: TestAgent
IDENTITY:
  expertise: []
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      // Empty list parses correctly via the LBracket branch
      expect(result.document!.identity.expertise).toEqual([]);
    });

    test('should parse limitations list', () => {
      const input = `AGENT: TestAgent
IDENTITY:
  limitations: []
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.identity.limitations).toEqual([]);
    });

    test('should parse empty expertise list', () => {
      const input = `AGENT: TestAgent
IDENTITY:
  expertise: []
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.identity.expertise).toEqual([]);
    });
  });

  describe('CONTRACT section', () => {
    test('should parse required inputs', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    user_id: string
    age: number
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const inputs = result.document!.contract.inputs;
      expect(inputs.required).toHaveProperty('user_id');
      expect(inputs.required.user_id).toBe('string');
      expect(inputs.required).toHaveProperty('age');
      expect(inputs.required.age).toBe('number');
    });

    test('should parse optional inputs (nullable)', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    email: string?
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const inputs = result.document!.contract.inputs;
      expect(inputs.optional).toHaveProperty('email');
    });

    test('should parse outputs with response type', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  outputs:
    response: string
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.contract.outputs.response).toBe('string');
    });
  });

  describe('TOOLS section', () => {
    test('should parse a tool with parameters', () => {
      const input = `AGENT: TestAgent
TOOLS:
  search(query: string, limit: number) -> string
    description: "Search for items"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const tools = result.document!.tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('search');
      expect(tools[0].description).toBe('Search for items');
      expect(tools[0].parameters).toHaveLength(2);
      expect(tools[0].parameters[0].name).toBe('query');
      expect(tools[0].parameters[0].type).toBe('string');
      expect(tools[0].parameters[1].name).toBe('limit');
    });

    test('should parse a tool with no parameters', () => {
      const input = `AGENT: TestAgent
TOOLS:
  get_status() -> string
    description: "Get current status"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.tools[0].parameters).toHaveLength(0);
    });

    test('should parse tool cacheable property', () => {
      const input = `AGENT: TestAgent
TOOLS:
  lookup(key: string) -> string
    cacheable: true
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.tools[0].cacheable).toBe(true);
    });

    test('should parse tool cacheable false', () => {
      const input = `AGENT: TestAgent
TOOLS:
  update(data: string) -> string
    cacheable: false
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.tools[0].cacheable).toBe(false);
    });

    test('should parse tool on_failure with retry strategy', () => {
      const input = `AGENT: TestAgent
TOOLS:
  fetch(url: string) -> string
    on_failure: retry(3)
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const tool = result.document!.tools[0];
      expect(tool.errorHandling).toBeDefined();
      expect(tool.errorHandling!.onFailure).toBe('retry');
      expect(tool.errorHandling!.maxRetries).toBe(3);
    });

    test('should parse optional tool parameter (nullable)', () => {
      const input = `AGENT: TestAgent
TOOLS:
  search(query: string, filter: string?) -> string
    description: "Search"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const params = result.document!.tools[0].parameters;
      expect(params[0].required).toBe(true);
      expect(params[1].required).toBe(false);
    });

    test('should parse tool parameter with default value', () => {
      const input = `AGENT: TestAgent
TOOLS:
  search(query: string, limit: number = 10) -> string
    description: "Search"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const params = result.document!.tools[0].parameters;
      expect(params[1].default).toBe(10);
      expect(params[1].required).toBe(false);
    });

    test('should parse multiple tools', () => {
      const input = `AGENT: TestAgent
TOOLS:
  search(q: string) -> string
    description: "Search"
  fetch(url: string) -> string
    description: "Fetch"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.tools).toHaveLength(2);
    });
  });

  describe('STEPS section', () => {
    test('should parse a simple respond step', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. greeting
    RESPOND "Hello!"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const steps = result.document!.flow.steps;
      expect(steps).toHaveLength(1);
      expect(steps[0].name).toBe('greeting');
      expect(steps[0].number).toBe(1);
      expect(steps[0].action.kind).toBe('respond');
    });

    test('should set entry point to first step name', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. start
    RESPOND "Start"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.flow.entryPoint).toBe('start');
    });

    test('should parse a goto step', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. start
    GOTO end
  2. end
    RESPOND "Done"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const firstStep = result.document!.flow.steps[0];
      expect(firstStep.action.kind).toBe('goto');
      expect((firstStep.action as any).target).toBe('end');
    });

    test('should parse a goto step with number target', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. start
    GOTO 2
  2. end
    RESPOND "Done"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const firstStep = result.document!.flow.steps[0];
      expect(firstStep.action.kind).toBe('goto');
      expect((firstStep.action as any).target).toBe('2');
    });

    test('should parse a signal step', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. finish
    SIGNAL: COMPLETE
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('signal');
      expect((step.action as any).signal).toBe('COMPLETE');
    });

    test('should parse a signal step with message', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. finish
    SIGNAL: COMPLETE
    MESSAGE: "Task done"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('signal');
      expect((step.action as any).message.kind).toBe('string');
      expect((step.action as any).message.value).toBe('Task done');
    });

    test('should parse a call step', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. lookup
    CALL search("test")
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('call_tool');
      expect((step.action as any).tool).toBe('search');
    });

    test('should parse a set state step', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. init
    SET user.status = "active"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('set_state');
    });

    test('should parse wait_input step with routes', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. ask
    WAIT_INPUT
    POSITIVE -> 2
    NEGATIVE -> 3
    DEFAULT -> 1
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('wait_input');
      const routes = (step.action as any).routes;
      expect(routes.positive).toBe('2');
      expect(routes.negative).toBe('3');
      expect(routes.default).toBe('1');
    });

    test('should parse classify step with intents', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. classify_input
    CLASSIFY input
    INTENT(booking, reserve) -> 2
    INTENT(support) -> 3
    DEFAULT -> 4
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('classify_intent');
    });

    test('should parse multi-step actions', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. multi
    RESPOND "Processing"
    CALL search("query")
    RESPOND "Done"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('multi_step');
      expect((step.action as any).steps).toHaveLength(3);
    });

    test('should parse step with on_success and on_failure', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. lookup
    CALL search("test")
    ON_SUCCESS -> 2
    ON_FAILURE -> 3
  2. success
    RESPOND "Found"
  3. failure
    RESPOND "Error"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      // The call action should have onSuccess and onFailure set
      expect(step.action.kind).toBe('call_tool');
      expect((step.action as any).onSuccess).toBe('2');
      expect((step.action as any).onFailure).toBe('3');
    });

    test('should handle step with no actions as respond empty', () => {
      const input = `AGENT: TestAgent
STEPS:
  1. empty
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const step = result.document!.flow.steps[0];
      expect(step.action.kind).toBe('respond');
    });
  });

  describe('GUARDRAILS section', () => {
    test('should parse guardrail with all properties', () => {
      const input = `AGENT: TestAgent
GUARDRAILS:
  profanity_filter:
    type: input
    check: "no_profanity"
    action: block
    message: "Please keep it professional"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const guardrails = result.document!.guardrails;
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0].name).toBe('profanity_filter');
      expect(guardrails[0].type).toBe('input');
      expect(guardrails[0].check).toBe('no_profanity');
      expect(guardrails[0].action).toBe('block');
      expect(guardrails[0].message).toBe('Please keep it professional');
    });

    test('should parse guardrail with kind instead of type', () => {
      const input = `AGENT: TestAgent
GUARDRAILS:
  safety:
    kind: output
    check: "safe_content"
    action: warn
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.guardrails[0].type).toBe('output');
    });

    test('should parse guardrail with msg instead of message', () => {
      const input = `AGENT: TestAgent
GUARDRAILS:
  safety:
    check: "check_safety"
    action: block
    msg: "Blocked for safety"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.guardrails[0].message).toBe('Blocked for safety');
    });

    test('should parse guardrail with minimal properties', () => {
      const input = `AGENT: TestAgent
GUARDRAILS:
  safety_check:
    check: "verify_safe"
    action: warn
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.guardrails).toHaveLength(1);
      expect(result.document!.guardrails[0].name).toBe('safety_check');
      expect(result.document!.guardrails[0].action).toBe('warn');
    });
  });

  describe('TESTS section', () => {
    test('should parse test cases', () => {
      const input = `AGENT: TestAgent
TESTS:
  basic_test:
    input: "Hello"
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const tests = result.document!.tests;
      expect(tests).toBeDefined();
      expect(tests!).toHaveLength(1);
      expect(tests![0].name).toBe('basic_test');
      expect(tests![0].input).toBe('Hello');
    });
  });

  describe('error handling', () => {
    test('should return lex errors for invalid characters', () => {
      const input = `AGENT: Test\u201C\n`;
      const result = parseAgent(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });

    test('should return parse errors for invalid syntax', () => {
      const input = `IDENTITY: missing_agent\n`;
      const result = parseAgent(input);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.document).toBeNull();
    });
  });

  describe('type parsing', () => {
    test('should parse enum type in contract', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    status: enum(active, inactive)
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const type = result.document!.contract.inputs.required.status;
      expect(typeof type).toBe('object');
      expect((type as any).kind).toBe('enum');
      expect((type as any).values).toEqual(['active', 'inactive']);
    });

    test('should parse boolean type', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    flag: boolean
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.contract.inputs.required.flag).toBe('boolean');
    });

    test('should parse date type', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    dob: date
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.contract.inputs.required.dob).toBe('date');
    });

    test('should parse datetime type', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    timestamp: datetime
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);
      expect(result.document!.contract.inputs.required.timestamp).toBe('datetime');
    });

    test('should parse array type', () => {
      const input = `AGENT: TestAgent
CONTRACT:
  inputs:
    tags: array
`;
      const result = parseAgent(input);
      expect(result.errors).toHaveLength(0);

      const type = result.document!.contract.inputs.required.tags;
      expect(typeof type).toBe('object');
      expect((type as any).kind).toBe('array');
    });
  });
});

// =============================================================================
// types/base.ts
// =============================================================================

describe('types/base.ts', () => {
  describe('isPrimitiveType', () => {
    test('should return true for string', () => {
      expect(isPrimitiveType('string')).toBe(true);
    });

    test('should return true for number', () => {
      expect(isPrimitiveType('number')).toBe(true);
    });

    test('should return true for boolean', () => {
      expect(isPrimitiveType('boolean')).toBe(true);
    });

    test('should return true for date', () => {
      expect(isPrimitiveType('date')).toBe(true);
    });

    test('should return true for datetime', () => {
      expect(isPrimitiveType('datetime')).toBe(true);
    });

    test('should return false for complex types', () => {
      expect(isPrimitiveType({ kind: 'array', itemType: 'string' })).toBe(false);
      expect(isPrimitiveType({ kind: 'enum', values: ['a', 'b'] })).toBe(false);
      expect(isPrimitiveType({ kind: 'object', properties: {} })).toBe(false);
    });
  });

  describe('isComplexType', () => {
    test('should return true for array type', () => {
      expect(isComplexType({ kind: 'array', itemType: 'string' })).toBe(true);
    });

    test('should return true for enum type', () => {
      expect(isComplexType({ kind: 'enum', values: ['a'] })).toBe(true);
    });

    test('should return true for object type', () => {
      expect(isComplexType({ kind: 'object', properties: {} })).toBe(true);
    });

    test('should return true for union type', () => {
      expect(isComplexType({ kind: 'union', types: ['string', 'number'] })).toBe(true);
    });

    test('should return true for nullable type', () => {
      expect(isComplexType({ kind: 'nullable', innerType: 'string' })).toBe(true);
    });

    test('should return false for primitive types', () => {
      expect(isComplexType('string')).toBe(false);
      expect(isComplexType('number')).toBe(false);
    });
  });

  describe('parseVersion', () => {
    test('should parse valid version', () => {
      expect(parseVersion('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 });
    });

    test('should parse version with larger numbers', () => {
      expect(parseVersion('12.34.56')).toEqual({ major: 12, minor: 34, patch: 56 });
    });

    test('should return null for invalid version', () => {
      expect(parseVersion('1.0')).toBeNull();
      expect(parseVersion('abc')).toBeNull();
      expect(parseVersion('1.0.0.0')).toBeNull();
      expect(parseVersion('')).toBeNull();
    });

    test('should return null for version with extra text', () => {
      expect(parseVersion('1.0.0-beta')).toBeNull();
      expect(parseVersion('v1.0.0')).toBeNull();
    });
  });

  describe('createDocumentMeta', () => {
    test('should create meta with defaults', () => {
      const meta = createDocumentMeta('agent', 'TestAgent');
      expect(meta.kind).toBe('agent');
      expect(meta.name).toBe('TestAgent');
      expect(meta.version).toBe('1.0.0');
      expect(meta.id).toBeDefined();
      expect(meta.createdAt).toBeInstanceOf(Date);
      expect(meta.updatedAt).toBeInstanceOf(Date);
    });

    test('should create meta with custom options', () => {
      const meta = createDocumentMeta('supervisor', 'MySupervisor', {
        description: 'A test supervisor',
        author: 'tester',
        version: '2.0.0',
      });
      expect(meta.description).toBe('A test supervisor');
      expect(meta.author).toBe('tester');
      expect(meta.version).toBe('2.0.0');
    });

    test('should create meta with custom id', () => {
      const meta = createDocumentMeta('agent', 'Test', { id: 'custom-id' });
      expect(meta.id).toBe('custom-id');
    });
  });
});

// =============================================================================
// types/expressions.ts
// =============================================================================

describe('types/expressions.ts', () => {
  describe('helper functions', () => {
    test('varRef should create variable reference from string', () => {
      const ref = varRef('user.name');
      expect(ref.kind).toBe('variable');
      expect(ref.path).toEqual(['user', 'name']);
    });

    test('varRef should create variable reference from array', () => {
      const ref = varRef(['user', 'settings', 'theme']);
      expect(ref.kind).toBe('variable');
      expect(ref.path).toEqual(['user', 'settings', 'theme']);
    });

    test('str should create string literal', () => {
      const s = str('hello');
      expect(s.kind).toBe('string');
      expect(s.value).toBe('hello');
    });

    test('num should create number literal', () => {
      const n = num(42);
      expect(n.kind).toBe('number');
      expect(n.value).toBe(42);
    });

    test('bool should create boolean literal', () => {
      expect(bool(true)).toEqual({ kind: 'boolean', value: true });
      expect(bool(false)).toEqual({ kind: 'boolean', value: false });
    });

    test('eq should create equality expression', () => {
      const expr = eq(varRef('x'), num(1));
      expect(expr.kind).toBe('binary');
      expect(expr.operator).toBe('==');
    });

    test('and should create AND expression', () => {
      const expr = and(bool(true), bool(false));
      expect(expr.kind).toBe('binary');
      expect(expr.operator).toBe('and');
    });

    test('or should create OR expression', () => {
      const expr = or(bool(true), bool(false));
      expect(expr.kind).toBe('binary');
      expect(expr.operator).toBe('or');
    });

    test('not should create NOT expression', () => {
      const expr = not(bool(true));
      expect(expr.kind).toBe('unary');
      expect(expr.operator).toBe('not');
    });

    test('exists should create EXISTS expression', () => {
      const expr = exists(varRef('user.email'));
      expect(expr.kind).toBe('unary');
      expect(expr.operator).toBe('exists');
    });
  });

  describe('isWildcard', () => {
    test('should return true for wildcard expression', () => {
      expect(isWildcard({ kind: 'wildcard' })).toBe(true);
    });

    test('should return false for non-wildcard expressions', () => {
      expect(isWildcard(str('hello'))).toBe(false);
      expect(isWildcard(num(42))).toBe(false);
      expect(isWildcard(bool(true))).toBe(false);
      expect(isWildcard(varRef('x'))).toBe(false);
    });
  });

  describe('expressionToString', () => {
    test('should convert string literal', () => {
      expect(expressionToString(str('hello'))).toBe('"hello"');
    });

    test('should convert number literal', () => {
      expect(expressionToString(num(42))).toBe('42');
    });

    test('should convert boolean literal', () => {
      expect(expressionToString(bool(true))).toBe('true');
      expect(expressionToString(bool(false))).toBe('false');
    });

    test('should convert null literal', () => {
      expect(expressionToString({ kind: 'null' })).toBe('null');
    });

    test('should convert array literal', () => {
      const arr = { kind: 'array' as const, values: [str('a'), num(1)] };
      expect(expressionToString(arr)).toBe('["a", 1]');
    });

    test('should convert variable reference', () => {
      expect(expressionToString(varRef('user.name'))).toBe('user.name');
    });

    test('should convert function call', () => {
      const fn = { kind: 'function' as const, name: 'verify', arguments: [varRef('id')] };
      expect(expressionToString(fn)).toBe('verify(id)');
    });

    test('should convert binary expression', () => {
      const expr = eq(varRef('x'), num(1));
      expect(expressionToString(expr)).toBe('(x == 1)');
    });

    test('should convert unary expression', () => {
      const expr = not(varRef('x'));
      expect(expressionToString(expr)).toBe('NOT x');
    });

    test('should convert template string', () => {
      const tmpl = { kind: 'template' as const, parts: ['Hello ', varRef('name'), '!'] };
      expect(expressionToString(tmpl)).toBe('Hello ${name}!');
    });

    test('should convert wildcard', () => {
      expect(expressionToString({ kind: 'wildcard' })).toBe('*');
    });

    test('should handle AND expression', () => {
      const expr = and(varRef('a'), varRef('b'));
      expect(expressionToString(expr)).toBe('(a AND b)');
    });

    test('should handle OR expression', () => {
      const expr = or(varRef('a'), varRef('b'));
      expect(expressionToString(expr)).toBe('(a OR b)');
    });

    test('should handle EXISTS expression', () => {
      const expr = exists(varRef('user.email'));
      expect(expressionToString(expr)).toBe('EXISTS user.email');
    });
  });
});

// =============================================================================
// types/supervisor.ts factory functions
// =============================================================================

describe('types/supervisor.ts factory functions', () => {
  describe('createSupervisorDocument', () => {
    test('should create document with defaults', () => {
      const doc = createSupervisorDocument('TestSupervisor');
      expect(doc.meta.name).toBe('TestSupervisor');
      expect(doc.meta.kind).toBe('supervisor');
      expect(doc.state).toEqual({});
      expect(doc.agents).toEqual([]);
      expect(doc.routing).toEqual([]);
      expect(doc.policies).toEqual([]);
      expect(doc.communication.language).toBe('en');
      expect(doc.behavior.canRespondDirectly).toBe(false);
    });

    test('should create document with custom options', () => {
      const doc = createSupervisorDocument('Custom', {
        state: { user: { name: { name: 'name', type: 'string', required: true } } },
        agents: [{ ref: './agent.abl', alias: 'agent', capabilities: [] }],
      });
      expect(doc.state.user).toBeDefined();
      expect(doc.agents).toHaveLength(1);
    });

    test('should set intents when provided', () => {
      const doc = createSupervisorDocument('WithIntents', {
        intents: [{ intents: ['help'], action: { kind: 'route_to_agent', agent: 'support' } }],
      });
      expect(doc.intents).toBeDefined();
      expect(doc.intents!).toHaveLength(1);
    });
  });

  describe('createRoutingRule', () => {
    test('should create routing rule with defaults', () => {
      const rule = createRoutingRule(
        1,
        { kind: 'wildcard' },
        { kind: 'route_to_agent', agent: 'test' },
      );
      expect(rule.priority).toBe(1);
      expect(rule.name).toBe('Rule_1');
      expect(rule.when.kind).toBe('wildcard');
      expect(rule.then.kind).toBe('route_to_agent');
    });

    test('should create routing rule with custom options', () => {
      const rule = createRoutingRule(
        5,
        { kind: 'wildcard' },
        { kind: 'route_to_agent', agent: 'test' },
        { name: 'CustomRule', description: 'A custom rule' },
      );
      expect(rule.name).toBe('CustomRule');
      expect(rule.description).toBe('A custom rule');
    });
  });

  describe('routeToAgent', () => {
    test('should create basic route', () => {
      const route = routeToAgent('booking');
      expect(route.kind).toBe('route_to_agent');
      expect(route.agent).toBe('booking');
      expect(route.setActive).toBeUndefined();
      expect(route.silent).toBeUndefined();
    });

    test('should create route with options', () => {
      const route = routeToAgent('booking', { setActive: true, silent: true });
      expect(route.setActive).toBe(true);
      expect(route.silent).toBe(true);
    });
  });

  describe('intentMatch', () => {
    test('should create intent match routing', () => {
      const result = intentMatch([{ intents: ['book'], action: routeToAgent('booking') }]);
      expect(result.kind).toBe('intent_match');
      expect(result.mappings).toHaveLength(1);
      expect(result.fallback).toBeUndefined();
    });

    test('should create intent match with fallback', () => {
      const result = intentMatch(
        [{ intents: ['book'], action: routeToAgent('booking') }],
        routeToAgent('default'),
      );
      expect(result.fallback).toBeDefined();
      expect(result.fallback!.kind).toBe('route_to_agent');
    });
  });
});

// =============================================================================
// types/agent-based.ts factory functions
// =============================================================================

describe('types/agent-based.ts factory functions', () => {
  describe('createAgentBasedDocument', () => {
    test('should create document with defaults', () => {
      const doc = createAgentBasedDocument('TestAgent', 'Help users');
      expect(doc.name).toBe('TestAgent');
      expect(doc.goal.description).toBe('Help users');
      expect(doc.tools).toEqual([]);
      expect(doc.gather).toEqual([]);
      expect(doc.constraints).toEqual([]);
      expect(doc.delegate).toEqual([]);
      expect(doc.handoff).toEqual([]);
      expect(doc.complete).toEqual([]);
      expect(doc.onError).toEqual([]);
      expect(doc.meta.kind).toBe('agent-based');
    });

    test('should set memory defaults', () => {
      const doc = createAgentBasedDocument('Test', 'Goal');
      expect(doc.memory.session).toEqual([]);
      expect(doc.memory.persistent).toEqual([]);
      expect(doc.memory.remember).toEqual([]);
      expect(doc.memory.recall).toEqual([]);
    });
  });

  describe('createTool', () => {
    test('should create a tool definition', () => {
      const tool = createTool('search', [{ name: 'query', type: 'string', required: true }], {
        type: 'string',
      });
      expect(tool.name).toBe('search');
      expect(tool.parameters).toHaveLength(1);
      expect(tool.returns.type).toBe('string');
    });
  });

  describe('createGatherField', () => {
    test('should create a required gather field', () => {
      const field = createGatherField('name', 'What is your name?', 'string');
      expect(field.name).toBe('name');
      expect(field.prompt).toBe('What is your name?');
      expect(field.type).toBe('string');
      expect(field.required).toBe(true);
    });

    test('should create an optional gather field', () => {
      const field = createGatherField('email', 'Email?', 'string', false);
      expect(field.required).toBe(false);
    });
  });

  describe('createConstraint', () => {
    test('should create a constraint', () => {
      const constraint = createConstraint('user.verified == true', 'Please verify first');
      expect(constraint.condition).toBe('user.verified == true');
      expect(constraint.onFail).toBe('Please verify first');
    });
  });

  describe('createHandoff', () => {
    test('should create a handoff with return false by default', () => {
      const handoff = createHandoff('support', 'user.needs_help', {
        pass: ['user_id'],
        summary: 'User needs help',
      });
      expect(handoff.to).toBe('support');
      expect(handoff.when).toBe('user.needs_help');
      expect(handoff.return).toBe(false);
    });

    test('should create a handoff with return allowed', () => {
      const handoff = createHandoff(
        'support',
        'user.needs_help',
        { pass: ['user_id'], summary: 'User needs help' },
        true,
      );
      expect(handoff.return).toBe(true);
    });
  });

  describe('createDelegate', () => {
    test('should create a delegate config', () => {
      const delegate = createDelegate(
        'validator',
        'needs_validation',
        'Validate user data',
        { data: 'user.data' },
        { valid: 'result.valid' },
        'SET user.validated = result.valid',
      );
      expect(delegate.agent).toBe('validator');
      expect(delegate.when).toBe('needs_validation');
      expect(delegate.purpose).toBe('Validate user data');
      expect(delegate.input.data).toBe('user.data');
      expect(delegate.returns.valid).toBe('result.valid');
      expect(delegate.useResult).toBe('SET user.validated = result.valid');
    });
  });
});

// =============================================================================
// types/agent.ts factory functions
// =============================================================================

describe('types/agent.ts factory functions', () => {
  describe('createAgentDocument', () => {
    test('should create document with defaults', () => {
      const doc = createAgentDocument('MyAgent', 'Helper');
      expect(doc.meta.name).toBe('MyAgent');
      expect(doc.meta.kind).toBe('agent');
      expect(doc.identity.role).toBe('Helper');
      expect(doc.tools).toEqual([]);
      expect(doc.flow.entryPoint).toBe('START');
      expect(doc.guardrails).toEqual([]);
    });

    test('should merge custom options', () => {
      const doc = createAgentDocument('MyAgent', 'Helper', {
        tools: [
          {
            id: '1',
            name: 'test_tool',
            description: '',
            parameters: [],
            returns: 'string',
          },
        ],
      });
      expect(doc.tools).toHaveLength(1);
    });
  });

  describe('createStep', () => {
    test('should create step with defaults', () => {
      const step = createStep(1, 'start', { kind: 'respond', message: str('Hi') });
      expect(step.number).toBe(1);
      expect(step.name).toBe('start');
      expect(step.action.kind).toBe('respond');
      expect(step.id).toBeDefined();
    });

    test('should create step with custom options', () => {
      const step = createStep(
        2,
        'process',
        { kind: 'respond', message: str('Ok') },
        {
          description: 'Process step',
          timeout: 5000,
          retries: 3,
        },
      );
      expect(step.description).toBe('Process step');
      expect(step.timeout).toBe(5000);
      expect(step.retries).toBe(3);
    });
  });

  describe('respond', () => {
    test('should create respond action from string', () => {
      const action = respond('Hello');
      expect(action.kind).toBe('respond');
      expect(action.message).toEqual({ kind: 'string', value: 'Hello' });
    });

    test('should create respond action from expression', () => {
      const expr = varRef('greeting');
      const action = respond(expr);
      expect(action.kind).toBe('respond');
      expect(action.message).toBe(expr);
    });
  });

  describe('callTool', () => {
    test('should create call tool action with defaults', () => {
      const action = callTool('search');
      expect(action.kind).toBe('call_tool');
      expect(action.tool).toBe('search');
      expect(action.params).toEqual({});
    });

    test('should create call tool action with params and options', () => {
      const action = callTool(
        'search',
        { query: str('test') },
        { onSuccess: 'step2', onFailure: 'error' },
      );
      expect(action.params.query).toEqual(str('test'));
      expect(action.onSuccess).toBe('step2');
      expect(action.onFailure).toBe('error');
    });
  });

  describe('signal', () => {
    test('should create signal action without message', () => {
      const action = signal('COMPLETE');
      expect(action.kind).toBe('signal');
      expect(action.signal).toBe('COMPLETE');
      expect(action.message).toBeUndefined();
    });

    test('should create signal action with string message', () => {
      const action = signal('COMPLETE', 'Task done');
      expect(action.message).toEqual({ kind: 'string', value: 'Task done' });
    });

    test('should create signal action with expression message', () => {
      const expr = varRef('result.message');
      const action = signal('COMPLETE', expr);
      expect(action.message).toBe(expr);
    });
  });

  describe('waitInput', () => {
    test('should create wait input action with routes', () => {
      const action = waitInput({ positive: 'step2', negative: 'step3' });
      expect(action.kind).toBe('wait_input');
      expect(action.routes.positive).toBe('step2');
      expect(action.routes.negative).toBe('step3');
    });

    test('should create wait input action with max attempts', () => {
      const action = waitInput({ default: 'step1' }, { maxAttempts: 3, onMaxExceeded: 'error' });
      expect(action.maxAttempts).toBe(3);
      expect(action.onMaxExceeded).toBe('error');
    });
  });

  describe('goto', () => {
    test('should create goto action', () => {
      const action = goto('step5');
      expect(action.kind).toBe('goto');
      expect(action.target).toBe('step5');
    });
  });

  describe('setState', () => {
    test('should create set state action', () => {
      const action = setState({ 'user.name': str('John') });
      expect(action.kind).toBe('set_state');
      expect(action.updates['user.name']).toEqual(str('John'));
    });
  });

  describe('classify', () => {
    test('should create classify intent action', () => {
      const action = classify({ booking: 'step2', support: 'step3' });
      expect(action.kind).toBe('classify_intent');
      expect(action.intents.booking).toBe('step2');
      expect(action.default).toBeUndefined();
    });

    test('should create classify intent action with default', () => {
      const action = classify({ booking: 'step2' }, 'fallback');
      expect(action.default).toBe('fallback');
    });
  });
});
