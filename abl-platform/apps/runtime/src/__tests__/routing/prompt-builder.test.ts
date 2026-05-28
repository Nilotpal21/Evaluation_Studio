/**
 * Tests for prompt-builder module
 *
 * Covers:
 * - ablTypeToJsonSchema: ABL type string -> JSON Schema mapping
 * - buildSystemPrompt: agent IR -> system prompt text
 * - conditionToDescription: routing condition -> human-readable text
 * - buildTools: agent IR -> LLM tool definitions
 * - isVoiceChannel: detect voice channel from session data
 */

import { describe, it, expect } from 'vitest';
import {
  ablTypeToJsonSchema,
  buildSystemPrompt,
  conditionToDescription,
  buildTools,
  isVoiceChannel,
} from '../../services/execution/prompt-builder.js';
import type { RuntimeSession } from '../../services/execution/types.js';
import type { AgentIR } from '@abl/compiler';

// =============================================================================
// HELPERS — minimal mock factories
// =============================================================================

/** Create a minimal RuntimeSession with overrides */
function makeSession(overrides: Partial<RuntimeSession> = {}): RuntimeSession {
  return {
    id: 'test-session',
    agentName: 'test_agent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  } as RuntimeSession;
}

/** Create a minimal AgentIR with overrides */
function makeIR(overrides: Partial<AgentIR> = {}): AgentIR {
  return {
    ir_version: '1.0',
    metadata: {
      name: 'test_agent',
      version: '1.0.0',
      type: 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    },
    execution: {
      mode: 'reasoning',
      hints: {
        voice_optimized: false,
        requires_persistence: false,
        supports_hitl: false,
        parallel_tools: false,
        complexity: 'simple',
      },
      timeouts: {
        tool_timeout_ms: 30000,
        llm_timeout_ms: 60000,
        session_timeout_ms: 1800000,
      },
    },
    identity: {
      goal: '',
      persona: '',
      limitations: [],
      system_prompt: { template: '', sections: {} },
    },
    tools: [],
    gather: { fields: [], strategy: 'llm' },
    memory: { session: [], persistent: [], remember: [], recall: [] },
    constraints: { constraints: [], guardrails: [] },
    coordination: { delegates: [], handoffs: [], escalation: undefined },
    completion: { conditions: [] },
    error_handling: {
      handlers: [],
      default_handler: { type: 'default', then: 'continue' },
    },
    ...overrides,
  } as AgentIR;
}

// =============================================================================
// ablTypeToJsonSchema
// =============================================================================

describe('ablTypeToJsonSchema', () => {
  describe('primitive types', () => {
    it('maps "string" to JSON Schema string', () => {
      expect(ablTypeToJsonSchema('string')).toEqual({ type: 'string' });
    });

    it('maps "text" to JSON Schema string', () => {
      expect(ablTypeToJsonSchema('text')).toEqual({ type: 'string' });
    });

    it('maps "integer" to JSON Schema integer', () => {
      expect(ablTypeToJsonSchema('integer')).toEqual({ type: 'integer' });
    });

    it('maps "int" to JSON Schema integer', () => {
      expect(ablTypeToJsonSchema('int')).toEqual({ type: 'integer' });
    });

    it('maps "number" to JSON Schema number', () => {
      expect(ablTypeToJsonSchema('number')).toEqual({ type: 'number' });
    });

    it('maps "float" to JSON Schema number', () => {
      expect(ablTypeToJsonSchema('float')).toEqual({ type: 'number' });
    });

    it('maps "double" to JSON Schema number', () => {
      expect(ablTypeToJsonSchema('double')).toEqual({ type: 'number' });
    });

    it('maps "boolean" to JSON Schema boolean', () => {
      expect(ablTypeToJsonSchema('boolean')).toEqual({ type: 'boolean' });
    });

    it('maps "bool" to JSON Schema boolean', () => {
      expect(ablTypeToJsonSchema('bool')).toEqual({ type: 'boolean' });
    });

    it('maps "object" to JSON Schema object', () => {
      expect(ablTypeToJsonSchema('object')).toEqual({ type: 'object' });
    });

    it('maps "json" to JSON Schema object', () => {
      expect(ablTypeToJsonSchema('json')).toEqual({ type: 'object' });
    });

    it('maps "map" to JSON Schema object', () => {
      expect(ablTypeToJsonSchema('map')).toEqual({ type: 'object' });
    });
  });

  describe('semantic string subtypes', () => {
    it('maps "date" to string with ISO 8601 date hint', () => {
      expect(ablTypeToJsonSchema('date')).toEqual({
        type: 'string',
        description: 'ISO 8601 date',
      });
    });

    it('maps "datetime" to string with ISO 8601 datetime hint', () => {
      expect(ablTypeToJsonSchema('datetime')).toEqual({
        type: 'string',
        description: 'ISO 8601 datetime',
      });
    });

    it('maps "email" to string with email hint', () => {
      expect(ablTypeToJsonSchema('email')).toEqual({
        type: 'string',
        description: 'Email address',
      });
    });

    it('maps "phone" to string with phone hint', () => {
      expect(ablTypeToJsonSchema('phone')).toEqual({
        type: 'string',
        description: 'Phone number',
      });
    });

    it('maps "url" to string with URL hint', () => {
      expect(ablTypeToJsonSchema('url')).toEqual({
        type: 'string',
        description: 'URL',
      });
    });
  });

  describe('array types', () => {
    it('maps "string[]" to array of strings', () => {
      expect(ablTypeToJsonSchema('string[]')).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('maps "integer[]" to array of integers', () => {
      expect(ablTypeToJsonSchema('integer[]')).toEqual({
        type: 'array',
        items: { type: 'integer' },
      });
    });

    it('maps "boolean[]" to array of booleans', () => {
      expect(ablTypeToJsonSchema('boolean[]')).toEqual({
        type: 'array',
        items: { type: 'boolean' },
      });
    });

    it('maps "number[]" to array of numbers', () => {
      expect(ablTypeToJsonSchema('number[]')).toEqual({
        type: 'array',
        items: { type: 'number' },
      });
    });

    it('maps "object[]" to array of objects', () => {
      expect(ablTypeToJsonSchema('object[]')).toEqual({
        type: 'array',
        items: { type: 'object' },
      });
    });

    it('maps "date[]" to array of date strings', () => {
      const result = ablTypeToJsonSchema('date[]');
      expect(result.type).toBe('array');
      expect(result.items).toEqual({ type: 'string', description: 'ISO 8601 date' });
    });

    it('maps "email[]" to array of email strings', () => {
      const result = ablTypeToJsonSchema('email[]');
      expect(result.type).toBe('array');
      expect(result.items).toEqual({ type: 'string', description: 'Email address' });
    });
  });

  describe('description propagation', () => {
    it('includes description for primitive string', () => {
      expect(ablTypeToJsonSchema('string', 'User name')).toEqual({
        type: 'string',
        description: 'User name',
      });
    });

    it('includes description for integer', () => {
      expect(ablTypeToJsonSchema('integer', 'Number of guests')).toEqual({
        type: 'integer',
        description: 'Number of guests',
      });
    });

    it('includes description for boolean', () => {
      expect(ablTypeToJsonSchema('boolean', 'Is active')).toEqual({
        type: 'boolean',
        description: 'Is active',
      });
    });

    it('includes description for object', () => {
      expect(ablTypeToJsonSchema('object', 'Config data')).toEqual({
        type: 'object',
        description: 'Config data',
      });
    });

    it('appends format hint to description for date', () => {
      expect(ablTypeToJsonSchema('date', 'Check-in date')).toEqual({
        type: 'string',
        description: 'Check-in date (ISO 8601 date)',
      });
    });

    it('appends format hint to description for datetime', () => {
      expect(ablTypeToJsonSchema('datetime', 'Created at')).toEqual({
        type: 'string',
        description: 'Created at (ISO 8601 datetime)',
      });
    });

    it('appends format hint to description for email', () => {
      expect(ablTypeToJsonSchema('email', 'Contact email')).toEqual({
        type: 'string',
        description: 'Contact email (email address)',
      });
    });

    it('appends format hint to description for phone', () => {
      expect(ablTypeToJsonSchema('phone', 'Mobile number')).toEqual({
        type: 'string',
        description: 'Mobile number (phone number)',
      });
    });

    it('appends format hint to description for url', () => {
      expect(ablTypeToJsonSchema('url', 'Website')).toEqual({
        type: 'string',
        description: 'Website (URL)',
      });
    });

    it('includes description on array wrapper, not on items', () => {
      const result = ablTypeToJsonSchema('string[]', 'List of tags');
      expect(result).toEqual({
        type: 'array',
        description: 'List of tags',
        items: { type: 'string' },
      });
    });

    it('omits description when not provided', () => {
      const result = ablTypeToJsonSchema('string');
      expect(result).not.toHaveProperty('description');
    });

    it('omits description from items even when array has description', () => {
      const result = ablTypeToJsonSchema('integer[]', 'List of IDs');
      expect(result.items).toEqual({ type: 'integer' });
      expect(result.items).not.toHaveProperty('description');
    });
  });

  describe('case insensitivity and whitespace', () => {
    it('handles uppercase type names', () => {
      expect(ablTypeToJsonSchema('INTEGER')).toEqual({ type: 'integer' });
      expect(ablTypeToJsonSchema('BOOLEAN')).toEqual({ type: 'boolean' });
      expect(ablTypeToJsonSchema('STRING')).toEqual({ type: 'string' });
    });

    it('handles mixed case type names', () => {
      expect(ablTypeToJsonSchema('Integer')).toEqual({ type: 'integer' });
      expect(ablTypeToJsonSchema('Number')).toEqual({ type: 'number' });
      expect(ablTypeToJsonSchema('Boolean')).toEqual({ type: 'boolean' });
    });

    it('trims leading and trailing whitespace', () => {
      expect(ablTypeToJsonSchema('  string  ')).toEqual({ type: 'string' });
      expect(ablTypeToJsonSchema('\tinteger\t')).toEqual({ type: 'integer' });
    });

    it('trims whitespace for array types', () => {
      expect(ablTypeToJsonSchema(' integer[] ')).toEqual({
        type: 'array',
        items: { type: 'integer' },
      });
    });

    it('handles uppercase array notation', () => {
      expect(ablTypeToJsonSchema('STRING[]')).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });
  });

  describe('unknown types fallback', () => {
    it('falls back to string for unknown types', () => {
      expect(ablTypeToJsonSchema('uuid')).toEqual({ type: 'string' });
    });

    it('falls back to string for arbitrary type names', () => {
      expect(ablTypeToJsonSchema('customType')).toEqual({ type: 'string' });
    });

    it('falls back to string with description for unknown types', () => {
      expect(ablTypeToJsonSchema('uuid', 'Session ID')).toEqual({
        type: 'string',
        description: 'Session ID',
      });
    });

    it('falls back to array of string for unknown array types', () => {
      expect(ablTypeToJsonSchema('uuid[]')).toEqual({
        type: 'array',
        items: { type: 'string' },
      });
    });
  });

  describe('nested tool parameter schemas', () => {
    it('maps "object[]" with items.properties to array with nested object schema', () => {
      const param = {
        name: 'queries',
        type: 'object[]',
        required: true,
        items: {
          type: 'object',
          properties: [
            { name: 'query', type: 'string', description: 'Search text', required: true },
            { name: 'namespace', type: 'string', description: 'Target namespace', required: true },
            { name: 'filter', type: 'object', description: 'Optional filters', required: false },
          ],
        },
      };

      expect(ablTypeToJsonSchema('object[]', 'Array of queries', param)).toEqual({
        type: 'array',
        description: 'Array of queries',
        items: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search text' },
            namespace: { type: 'string', description: 'Target namespace' },
            filter: { type: 'object', description: 'Optional filters' },
          },
          required: ['query', 'namespace'],
        },
      });
    });

    it('maps "object" with properties to object with nested schema', () => {
      const param = {
        name: 'config',
        type: 'object',
        required: true,
        properties: [
          { name: 'limit', type: 'integer', description: 'Max results', required: false },
          { name: 'offset', type: 'integer', description: 'Skip count', required: false },
        ],
      };

      expect(ablTypeToJsonSchema('object', 'Configuration', param)).toEqual({
        type: 'object',
        description: 'Configuration',
        properties: {
          limit: { type: 'integer', description: 'Max results' },
          offset: { type: 'integer', description: 'Skip count' },
        },
      });
    });

    it('maps "object" with properties including required fields', () => {
      const param = {
        name: 'pagination',
        type: 'object',
        required: true,
        properties: [
          { name: 'page', type: 'integer', description: 'Page number', required: true },
          { name: 'size', type: 'integer', description: 'Page size', required: true },
          { name: 'sort', type: 'string', description: 'Sort field', required: false },
        ],
      };

      expect(ablTypeToJsonSchema('object', 'Pagination options', param)).toEqual({
        type: 'object',
        description: 'Pagination options',
        properties: {
          page: { type: 'integer', description: 'Page number' },
          size: { type: 'integer', description: 'Page size' },
          sort: { type: 'string', description: 'Sort field' },
        },
        required: ['page', 'size'],
      });
    });

    it('maps "object[]" with param-level properties to array with nested object schema', () => {
      const param = {
        name: 'items',
        type: 'object[]',
        required: true,
        properties: [
          { name: 'id', type: 'string', description: 'Item ID', required: true },
          { name: 'quantity', type: 'integer', description: 'Count', required: true },
        ],
      };

      expect(ablTypeToJsonSchema('object[]', 'List of items', param)).toEqual({
        type: 'array',
        description: 'List of items',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Item ID' },
            quantity: { type: 'integer', description: 'Count' },
          },
          required: ['id', 'quantity'],
        },
      });
    });

    it('maps "array" type with items.properties to array with nested object schema', () => {
      const param = {
        name: 'records',
        type: 'array',
        required: false,
        items: {
          type: 'object',
          properties: [
            { name: 'key', type: 'string', description: 'Record key', required: true },
            { name: 'value', type: 'string', description: 'Record value', required: false },
          ],
        },
      };

      expect(ablTypeToJsonSchema('array', 'Data records', param)).toEqual({
        type: 'array',
        description: 'Data records',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Record key' },
            value: { type: 'string', description: 'Record value' },
          },
          required: ['key'],
        },
      });
    });
  });
});

// =============================================================================
// conditionToDescription
// =============================================================================

describe('conditionToDescription', () => {
  describe('summary takes precedence', () => {
    it('returns summary when provided, ignoring condition', () => {
      const result = conditionToDescription(
        'intent.category == "escalation"',
        'escalation_agent',
        'Handle user complaints gracefully',
      );
      expect(result).toBe('Handle user complaints gracefully');
    });

    it('returns summary even when condition is undefined', () => {
      const result = conditionToDescription(undefined, 'support_agent', 'General support');
      expect(result).toBe('General support');
    });
  });

  describe('no condition and no summary', () => {
    it('generates fallback description from target name', () => {
      const result = conditionToDescription(undefined, 'booking_agent');
      expect(result).toBe('Route here when appropriate for booking agent');
    });

    it('replaces underscores with spaces in target name', () => {
      const result = conditionToDescription(undefined, 'hotel_booking_agent');
      expect(result).toBe('Route here when appropriate for hotel booking agent');
    });
  });

  describe('intent-based condition patterns', () => {
    it('maps escalation intent', () => {
      const result = conditionToDescription('intent.category == "escalation"', 'escalation_agent');
      expect(result).toContain('human agent');
    });

    it('maps farewell intent', () => {
      const result = conditionToDescription('intent.category == "farewell"', 'farewell_agent');
      expect(result).toContain('goodbye');
    });

    it('maps greeting intent', () => {
      const result = conditionToDescription('intent.category == "greeting"', 'greeting_agent');
      expect(result).toContain('greeting');
    });

    it('maps new_booking intent', () => {
      const result = conditionToDescription('intent.category == "new_booking"', 'booking_agent');
      expect(result).toContain('booking');
    });

    it('maps travel_search intent', () => {
      const result = conditionToDescription('intent.category == "travel_search"', 'search_agent');
      expect(result).toContain('search');
    });

    it('maps manage_existing_booking intent', () => {
      const result = conditionToDescription(
        'intent.category == "manage_existing_booking"',
        'manage_agent',
      );
      expect(result).toContain('existing booking');
    });

    it('maps complaint intent', () => {
      const result = conditionToDescription('intent.category == "complaint"', 'complaint_agent');
      expect(result).toContain('complaint');
    });

    it('handles single-quoted intent values', () => {
      const result = conditionToDescription("intent.category == 'escalation'", 'escalation_agent');
      expect(result).toContain('human agent');
    });
  });

  describe('user state conditions', () => {
    it('maps wants_human_agent', () => {
      const result = conditionToDescription('user.wants_human_agent == true', 'human_agent');
      expect(result).toContain('human');
    });

    it('maps is_authenticated == false', () => {
      const result = conditionToDescription('user.is_authenticated == false', 'auth_agent');
      expect(result).toContain('log in');
    });

    it('maps is_authenticated == true', () => {
      const result = conditionToDescription('user.is_authenticated == true', 'auth_agent');
      expect(result).toContain('authenticated');
    });

    it('maps frustration_detected', () => {
      const result = conditionToDescription('user.frustration_detected == true', 'support_agent');
      expect(result).toContain('frustration');
    });
  });

  describe('intent property conditions', () => {
    it('maps intent.unclear', () => {
      const result = conditionToDescription('intent.unclear == true', 'clarify_agent');
      expect(result).toContain('unclear');
    });

    it('maps intent.confidence threshold', () => {
      const result = conditionToDescription('intent.confidence < 0.5', 'clarify_agent');
      expect(result).toContain('ambiguous');
    });

    it('maps intent.has_specific_request', () => {
      const result = conditionToDescription('intent.has_specific_request', 'specific_agent');
      expect(result).toContain('specific request');
    });
  });

  describe('combined conditions', () => {
    it('joins multiple matched descriptions with semicolons', () => {
      const result = conditionToDescription(
        'intent.category == "escalation" AND user.frustration_detected == true',
        'escalation_agent',
      );
      expect(result).toContain(';');
      expect(result).toContain('human agent');
      expect(result).toContain('frustration');
    });
  });

  describe('fallback condition cleaning', () => {
    it('converts unrecognized intent conditions to readable form', () => {
      const result = conditionToDescription('intent.category == "custom_intent"', 'custom_agent');
      expect(result).toContain('user intent is "custom intent"');
    });

    it('converts user boolean conditions to readable form', () => {
      const result = conditionToDescription('user.is_vip == true', 'vip_agent');
      expect(result).toContain('user is_vip');
    });

    it('converts user negation conditions to readable form', () => {
      const result = conditionToDescription('user.has_account == false', 'signup_agent');
      expect(result).toContain('user has not has_account');
    });

    it('replaces AND/OR with lowercase equivalents', () => {
      const result = conditionToDescription(
        'intent.category == "other" AND user.custom_flag == true',
        'agent',
      );
      expect(result).toContain(' and ');
    });

    it('returns fallback description for empty condition string (treated as falsy)', () => {
      // Empty string is falsy, so it hits the !condition branch
      const result = conditionToDescription('', 'fallback_agent');
      expect(result).toBe('Route here when appropriate for fallback agent');
    });

    it('replaces underscores in target for empty condition fallback', () => {
      const result = conditionToDescription('', 'my_special_agent');
      expect(result).toBe('Route here when appropriate for my special agent');
    });
  });

  describe('routing_failures condition', () => {
    it('maps routing_failures pattern', () => {
      const result = conditionToDescription('routing_failures >= 3', 'fallback_agent');
      expect(result).toContain('routing attempts have failed');
    });
  });
});

// =============================================================================
// buildSystemPrompt
// =============================================================================

describe('buildSystemPrompt', () => {
  describe('fallback (no IR)', () => {
    it('produces prompt with agent name when IR is null', () => {
      const session = makeSession({ agentName: 'my_agent', agentIR: null });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('You are my_agent');
      expect(prompt).toContain('Help the user');
    });
  });

  describe('basic identity', () => {
    it('uses metadata.name for the agent identity', () => {
      const ir = makeIR({
        metadata: {
          name: 'booking_bot',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '',
          source_hash: '',
          compiler_version: '',
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('You are booking_bot');
    });

    it('falls back to session.agentName when metadata.name is empty', () => {
      const ir = makeIR({
        metadata: {
          name: '',
          version: '1.0.0',
          type: 'agent',
          compiled_at: '',
          source_hash: '',
          compiler_version: '',
        },
      });
      const session = makeSession({ agentName: 'fallback_name', agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('You are fallback_name');
    });

    it('includes goal when present', () => {
      const ir = makeIR({
        identity: {
          goal: 'Help users book hotels',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Your goal: Help users book hotels');
    });

    it('includes persona when present', () => {
      const ir = makeIR({
        identity: {
          goal: '',
          persona: 'Friendly and professional',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Persona: Friendly and professional');
    });

    it('omits goal section when goal is empty', () => {
      const ir = makeIR({
        identity: {
          goal: '',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('Your goal:');
    });

    it('omits persona section when persona is empty', () => {
      const ir = makeIR({
        identity: {
          goal: '',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('Persona:');
    });
  });

  describe('limitations', () => {
    it('lists limitations as bullet points', () => {
      const ir = makeIR({
        identity: {
          goal: '',
          persona: '',
          limitations: ['No medical advice', 'No financial recommendations'],
          system_prompt: { template: '', sections: {} },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Limitations:');
      expect(prompt).toContain('- No medical advice');
      expect(prompt).toContain('- No financial recommendations');
    });

    it('omits limitations section when array is empty', () => {
      const ir = makeIR({
        identity: {
          goal: '',
          persona: '',
          limitations: [],
          system_prompt: { template: '', sections: {} },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('Limitations:');
    });
  });

  describe('tools info', () => {
    it('adds tools notice when tools are present', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'search_hotels',
            description: 'Search hotels',
            parameters: [],
            returns: { type: 'object' },
            hints: {
              cacheable: false,
              latency: 'medium',
              parallelizable: false,
              side_effects: false,
              requires_auth: false,
            },
          },
        ],
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('You have access to tools');
    });

    it('omits tools notice when no tools', () => {
      const ir = makeIR({ tools: [] });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('You have access to tools');
    });
  });

  describe('gather fields', () => {
    it('lists gather fields with required flag', () => {
      const ir = makeIR({
        gather: {
          fields: [
            {
              name: 'destination',
              prompt: 'Where do you want to go?',
              type: 'string',
              required: true,
            },
            { name: 'budget', prompt: 'What is your budget?', type: 'number', required: false },
          ],
          strategy: 'llm',
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('gather the following information');
      expect(prompt).toContain('destination: Where do you want to go? (required)');
      expect(prompt).toContain('budget: What is your budget? (optional)');
    });

    it('adds instruction to continue asking for missing fields', () => {
      const ir = makeIR({
        gather: {
          fields: [{ name: 'name', prompt: 'Your name?', type: 'string', required: true }],
          strategy: 'llm',
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Continue asking for any missing required fields');
    });

    it('omits gather section when no fields', () => {
      const ir = makeIR({ gather: { fields: [], strategy: 'llm' } });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('gather the following information');
    });
  });

  describe('supervisor routing', () => {
    const supervisorMeta = {
      name: 'test_agent',
      version: '1.0.0',
      type: 'supervisor' as const,
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    };

    it('includes routing supervisor instructions when routing rules exist', () => {
      const ir = makeIR({
        metadata: supervisorMeta,
        routing: {
          rules: [
            {
              to: 'booking_agent',
              when: 'intent.category == "booking"',
              description: 'Handles bookings',
              priority: 1,
            },
          ],
          default_agent: 'booking_agent',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('routing supervisor');
      expect(prompt).toContain('Route each user request to the appropriate specialist');
      expect(prompt).toContain('DO NOT respond to users directly with information or help');
      expect(prompt).toContain('your ONLY job is to route them');
    });

    it('creates per-agent handoff tools for routing targets with correct descriptions', () => {
      const ir = makeIR({
        metadata: supervisorMeta,
        routing: {
          rules: [
            {
              to: 'booking_agent',
              when: 'intent.category == "new_booking"',
              description: 'User wants to book',
              priority: 1,
            },
            {
              to: 'support_agent',
              when: 'intent.category == "complaint"',
              description: 'User has complaint',
              priority: 2,
            },
          ],
          default_agent: 'booking_agent',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const bookingTool = tools.find((t) => t.name === 'handoff_to_booking_agent');
      const supportTool = tools.find((t) => t.name === 'handoff_to_support_agent');
      expect(bookingTool).toBeDefined();
      expect(bookingTool!.description).toContain('User wants to book');
      expect(supportTool).toBeDefined();
      expect(supportTool!.description).toContain('User has complaint');
    });

    it('creates a handoff_to_agent_a tool for the routing target', () => {
      const ir = makeIR({
        metadata: supervisorMeta,
        routing: {
          rules: [{ to: 'agent_a', when: 'true', description: 'Always', priority: 1 }],
          default_agent: 'agent_a',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const handoffTool = tools.find((t) => t.name === 'handoff_to_agent_a');
      expect(handoffTool).toBeDefined();
      expect(handoffTool!.description).toBeTruthy();
      expect(handoffTool!.input_schema.properties).toHaveProperty('reason');
      expect(handoffTool!.input_schema.properties).toHaveProperty('message');
    });

    it('includes multi-intent routing instructions in supervisor prompt', () => {
      const ir = makeIR({
        metadata: supervisorMeta,
        routing: {
          rules: [{ to: 'agent_a', when: 'true', description: 'A', priority: 1 }],
          default_agent: 'agent_a',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('For multi-part requests with multiple distinct intents');
      expect(prompt).toContain('call multiple routing tools in one response');
    });
  });

  describe('regular agent with handoffs', () => {
    it('includes specialist role description instead of routing-only', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'support_agent',
              when: 'user.needs_help',
              context: { pass: [], summary: '' },
              return: false,
            },
          ],
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('specialist agent');
      expect(prompt).toContain('Help the user directly');
      expect(prompt).not.toContain('ROUTING-ONLY');
    });

    it('creates per-agent handoff tools for available handoff targets', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [
            {
              to: 'billing_agent',
              when: 'billing',
              context: { pass: [], summary: '' },
              return: false,
            },
            { to: 'tech_support', when: 'tech', context: { pass: [], summary: '' }, return: false },
          ],
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const billingTool = tools.find((t) => t.name === 'handoff_to_billing_agent');
      const techTool = tools.find((t) => t.name === 'handoff_to_tech_support');
      expect(billingTool).toBeDefined();
      expect(techTool).toBeDefined();
    });

    it('warns against self-handoff', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [
            { to: 'other', when: 'true', context: { pass: [], summary: '' }, return: false },
          ],
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Do NOT hand off to yourself');
    });
  });

  describe('escalation', () => {
    it('includes escalation instructions when configured', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [],
          escalation: {
            triggers: [{ when: 'user.angry', reason: 'User is angry', priority: 'high' }],
            context_for_human: [],
            on_human_complete: [],
          },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Escalation');
      expect(prompt).toContain('__escalate__');
      expect(prompt).toContain('User is angry (priority: high)');
    });

    it('includes note about not escalating for normal routing', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [],
          escalation: {
            triggers: [{ when: 'true', reason: 'Fallback', priority: 'low' }],
            context_for_human: [],
            on_human_complete: [],
          },
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('Do NOT escalate for normal routing');
    });

    it('omits escalation section when not configured', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [],
          escalation: undefined,
        },
      });
      const session = makeSession({ agentIR: ir });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('## Escalation');
    });
  });

  describe('context values', () => {
    it('projects gathered values into gather progress instead of generic current context', () => {
      const ir = makeIR();
      const session = makeSession({
        agentIR: ir,
        data: {
          values: { destination: 'Paris', guests: 2 },
          gatheredKeys: new Set(['destination', 'guests']),
        },
      });
      const prompt = buildSystemPrompt(session);
      expect(prompt).toContain('## Gather Progress');
      expect(prompt).not.toContain('Current Context');
      expect(prompt).toContain('"destination": "Paris"');
      expect(prompt).toContain('"guests": 2');
    });

    it('omits context section when data values are empty', () => {
      const ir = makeIR();
      const session = makeSession({
        agentIR: ir,
        data: { values: {}, gatheredKeys: new Set() },
      });
      const prompt = buildSystemPrompt(session);
      expect(prompt).not.toContain('Current Context');
    });

    it('renders projected session memory, granted memory, gather progress, and policy once', () => {
      const ir = makeIR({
        memory: {
          session: [{ name: 'customer_id', type: 'string' }] as AgentIR['memory']['session'],
          persistent: [],
          remember: [],
          recall: [],
        },
      });
      const session = makeSession({
        agentIR: ir,
        data: {
          values: {
            customer_id: 'cust-123',
            from_account: 'checking',
            internal_note: 'keep hidden from session memory',
            _granted_memory: { verified_customer: true },
          },
          gatheredKeys: new Set(['from_account']),
        },
        _guardrailPolicy: {
          disabledGuardrails: ['suppress-small-talk'],
          additionalGuardrails: [{ name: 'banking-safe' }],
          settings: { failMode: 'closed' },
        } as RuntimeSession['_guardrailPolicy'],
        _guardrailPolicyScopeKey: 'test_agent:live:unhashed',
      });

      const prompt = buildSystemPrompt(session);

      expect(prompt).toContain('## Session Memory');
      expect(prompt).toContain('"customer_id": "cust-123"');
      expect(prompt).toContain('## Granted Memory');
      expect(prompt).toContain('"verified_customer": true');
      expect(prompt).toContain('## Gather Progress');
      expect(prompt).toContain('"from_account": "checking"');
      expect(prompt).toContain('## Current Policy');
      expect(prompt).toContain('"failMode": "closed"');
      expect(prompt.match(/## Current Context/g)).toHaveLength(1);
    });
  });
});

// =============================================================================
// buildTools
// =============================================================================

describe('buildTools', () => {
  describe('regular tools from IR', () => {
    it('includes tools defined in agent IR', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'search_hotels',
            description: 'Search for hotels',
            parameters: [
              { name: 'city', type: 'string', required: true, description: 'City name' },
              { name: 'stars', type: 'integer', required: false, description: 'Star rating' },
            ],
            returns: { type: 'object' },
            hints: {
              cacheable: false,
              latency: 'medium',
              parallelizable: false,
              side_effects: false,
              requires_auth: false,
            },
          },
        ],
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const searchTool = tools.find((t) => t.name === 'search_hotels');
      expect(searchTool).toBeDefined();
      expect(searchTool!.description).toBe('Search for hotels');
      expect(searchTool!.input_schema.properties.city).toEqual({
        type: 'string',
        description: 'City name',
      });
      expect(searchTool!.input_schema.properties.stars).toEqual({
        type: 'integer',
        description: 'Star rating',
      });
      expect(searchTool!.input_schema.required).toContain('city');
      expect(searchTool!.input_schema.required).not.toContain('stars');
    });

    it('generates default description when tool has no description', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'my_tool',
            description: '',
            parameters: [],
            returns: { type: 'object' },
            hints: {
              cacheable: false,
              latency: 'medium',
              parallelizable: false,
              side_effects: false,
              requires_auth: false,
            },
          },
        ],
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const tool = tools.find((t) => t.name === 'my_tool');
      expect(tool!.description).toBe('Execute the my_tool tool');
    });

    it('hides auth-bound tools when user-scoped auth context is missing', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'crm_lookup',
            description: 'Look up CRM data',
            parameters: [],
            returns: { type: 'object' },
            auth_profile_ref: 'crm_profile',
            connection_mode: 'per_user',
          } as AgentIR['tools'][number],
          {
            name: 'public_lookup',
            description: 'Public lookup',
            parameters: [],
            returns: { type: 'object' },
          } as AgentIR['tools'][number],
        ],
      });
      const session = makeSession({
        agentIR: ir,
        _activationAuthContext: { authScope: 'user' },
      });

      const tools = buildTools(session);

      expect(tools.map((tool) => tool.name)).toContain('public_lookup');
      expect(tools.map((tool) => tool.name)).not.toContain('crm_lookup');
    });

    it('skips system tools from IR tool list', () => {
      const ir = makeIR({
        tools: [
          {
            name: '__handoff__',
            description: 'System handoff',
            parameters: [],
            returns: { type: 'object' },
            hints: {
              cacheable: false,
              latency: 'fast',
              parallelizable: false,
              side_effects: true,
              requires_auth: false,
            },
            system: true,
          },
          {
            name: 'real_tool',
            description: 'A real tool',
            parameters: [],
            returns: { type: 'object' },
            hints: {
              cacheable: false,
              latency: 'medium',
              parallelizable: false,
              side_effects: false,
              requires_auth: false,
            },
          },
        ],
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const handoffFromIR = tools.filter((t) => t.name === '__handoff__');
      // Handoff may still be present (added as system tool below), but it should not be the IR version
      const realTool = tools.find((t) => t.name === 'real_tool');
      expect(realTool).toBeDefined();
    });
  });

  describe('handoff tool from routing rules (supervisor)', () => {
    const supervisorMeta = {
      name: 'test_agent',
      version: '1.0.0',
      type: 'supervisor' as const,
      compiled_at: new Date().toISOString(),
      source_hash: 'abc123',
      compiler_version: '1.0.0',
    };

    it('adds per-agent handoff_to_X tools for routing targets', () => {
      const ir = makeIR({
        metadata: supervisorMeta,
        routing: {
          rules: [
            { to: 'booking_agent', when: 'intent == "booking"', description: 'Book', priority: 1 },
            {
              to: 'support_agent',
              when: 'intent == "support"',
              description: 'Support',
              priority: 2,
            },
          ],
          default_agent: 'booking_agent',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const bookingHandoff = tools.find((t) => t.name === 'handoff_to_booking_agent');
      const supportHandoff = tools.find((t) => t.name === 'handoff_to_support_agent');
      expect(bookingHandoff).toBeDefined();
      expect(bookingHandoff!.description).toContain('Book');
      expect(bookingHandoff!.input_schema.required).toContain('reason');
      expect(bookingHandoff!.input_schema.required).toContain('message');
      expect(supportHandoff).toBeDefined();
      expect(supportHandoff!.description).toContain('Support');
    });

    it('handoff_to_X schema has required message property', () => {
      const ir = makeIR({
        metadata: supervisorMeta,
        routing: {
          rules: [
            { to: 'booking_agent', when: 'intent == "booking"', description: 'Book', priority: 1 },
          ],
          default_agent: 'booking_agent',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const handoff = tools.find((t) => t.name === 'handoff_to_booking_agent');
      expect(handoff).toBeDefined();
      expect(handoff!.input_schema.properties).toHaveProperty('message');
      expect(handoff!.input_schema.properties.message.type).toBe('string');
      expect(handoff!.input_schema.required).toContain('message');
    });

    it('creates per-agent handoff_to_X tools (no generic __fan_out__ tool)', () => {
      const ir = makeIR({
        routing: {
          rules: [{ to: 'agent_a', when: 'true', description: 'A', priority: 1 }],
          default_agent: 'agent_a',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const perAgentTool = tools.find((t) => t.name === 'handoff_to_agent_a');
      expect(perAgentTool).toBeDefined();
      expect(perAgentTool!.input_schema.properties).toHaveProperty('reason');
      expect(perAgentTool!.input_schema.properties).toHaveProperty('message');
      // No generic __fan_out__ tool — multi-intent routing uses multiple handoff_to_X calls
      const fanOut = tools.find((t) => t.name === '__fan_out__');
      expect(fanOut).toBeUndefined();
    });
  });

  describe('handoff tool from coordination.handoffs (regular agent)', () => {
    it('adds handoff_to_other_agent tool for specialist handoff', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [
            { to: 'other_agent', when: 'true', context: { pass: [], summary: '' }, return: false },
          ],
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const handoff = tools.find((t) => t.name === 'handoff_to_other_agent');
      expect(handoff).toBeDefined();
      expect(handoff!.description).toBeTruthy();
      expect(handoff!.input_schema.properties).toHaveProperty('reason');
      expect(handoff!.input_schema.properties).toHaveProperty('message');
    });
  });

  describe('handoff tool from available_agents', () => {
    it('does not add generic __handoff__ for available_agents (uses per-agent tools via routing/handoffs)', () => {
      const ir = makeIR({
        available_agents: ['agent_x', 'agent_y'],
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      // Per-agent tools come from routing.rules or coordination.handoffs, not available_agents alone
      const handoff = tools.find((t) => t.name === '__handoff__');
      expect(handoff).toBeUndefined();
    });
  });

  describe('handoff return info', () => {
    it('does not mutate session control-plane state when building routing tools', () => {
      const ir = makeIR({
        routing: {
          rules: [
            { to: 'agent_a', when: 'true', description: 'A', priority: 1, return: true },
            { to: 'agent_b', when: 'true', description: 'B', priority: 2 },
          ],
          default_agent: 'agent_a',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({
        agentIR: ir,
        handoffReturnInfo: { stale_target: true },
        intentQueue: { items: ['queued-intent'] } as RuntimeSession['intentQueue'],
      });

      const before = {
        handoffReturnInfo: session.handoffReturnInfo,
        intentQueue: session.intentQueue,
        activeThreadIndex: session.activeThreadIndex,
        threadStack: [...session.threadStack],
      };

      buildTools(session);

      expect(session.handoffReturnInfo).toEqual(before.handoffReturnInfo);
      expect(session.intentQueue).toBe(before.intentQueue);
      expect(session.activeThreadIndex).toBe(before.activeThreadIndex);
      expect(session.threadStack).toEqual(before.threadStack);
    });

    it('includes return info in handoff_to_agent_a tool description', () => {
      const ir = makeIR({
        routing: {
          rules: [{ to: 'agent_a', when: 'true', description: 'A', priority: 1, return: true }],
          default_agent: 'agent_a',
          intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const handoff = tools.find((t) => t.name === 'handoff_to_agent_a');
      expect(handoff).toBeDefined();
      expect(handoff!.description).toContain('returns control after completion');
    });
  });

  describe('delegate tool', () => {
    it('adds delegate_to_payment_processor tool when delegates are configured', () => {
      const ir = makeIR({
        coordination: {
          delegates: [
            {
              agent: 'payment_processor',
              when: 'needs_payment',
              purpose: 'Process payment',
              input: { amount: 'total' },
              returns: { receipt: 'payment_receipt' },
              use_result: 'result',
              on_failure: 'continue',
            },
          ],
          handoffs: [],
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const delegate = tools.find((t) => t.name === 'delegate_to_payment_processor');
      expect(delegate).toBeDefined();
      expect(delegate!.description).toContain('Process payment');
      expect(delegate!.description).toContain('Runs to completion and returns a result');
    });

    it('delegate_to_payment_processor schema has required message property', () => {
      const ir = makeIR({
        coordination: {
          delegates: [
            {
              agent: 'payment_processor',
              when: 'needs_payment',
              purpose: 'Process payment',
              input: { amount: 'total' },
              returns: { receipt: 'payment_receipt' },
              use_result: 'result',
              on_failure: 'continue',
            },
          ],
          handoffs: [],
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const delegate = tools.find((t) => t.name === 'delegate_to_payment_processor');
      expect(delegate).toBeDefined();
      expect(delegate!.input_schema.properties).toHaveProperty('message');
      expect(delegate!.input_schema.properties.message.type).toBe('string');
      expect(delegate!.input_schema.required).toContain('message');
    });

    it('omits __delegate__ tool when no delegates configured', () => {
      const ir = makeIR({
        coordination: { delegates: [], handoffs: [] },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const delegate = tools.find((t) => t.name === '__delegate__');
      expect(delegate).toBeUndefined();
    });
  });

  describe('escalate tool', () => {
    it('includes __escalate__ when escalation is configured', () => {
      const ir = makeIR({
        coordination: {
          delegates: [],
          handoffs: [],
          escalation: {
            triggers: [{ when: 'user asks for human', reason: 'User request', priority: 'high' }],
            context_for_human: [],
            on_human_complete: [],
          },
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const escalate = tools.find((t) => t.name === '__escalate__');
      expect(escalate).toBeDefined();
      expect(escalate!.input_schema.properties.reason).toBeDefined();
      expect(escalate!.input_schema.properties.priority).toBeDefined();
      expect(escalate!.input_schema.properties.priority.enum).toEqual([
        'low',
        'medium',
        'high',
        'critical',
      ]);
      expect(escalate!.input_schema.required).toContain('reason');
    });

    it('omits __escalate__ when no escalation config is present', () => {
      const session = makeSession({ agentIR: makeIR() });
      const tools = buildTools(session);
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('__escalate__');
    });

    it('omits __escalate__ when ir.coordination.escalation is undefined', () => {
      const ir = makeIR({
        coordination: { delegates: [], handoffs: [], escalation: undefined },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const escalate = tools.find((t) => t.name === '__escalate__');
      expect(escalate).toBeUndefined();
    });
  });

  describe('does not include __complete__ tool', () => {
    it('does not add __complete__ (Option C: runtime-evaluated completion)', () => {
      const ir = makeIR({
        completion: {
          conditions: [{ when: 'all_gathered', respond: 'Done!' }],
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const complete = tools.find((t) => t.name === '__complete__');
      expect(complete).toBeUndefined();
    });
  });

  describe('tool parameter type mapping', () => {
    it('maps tool parameter types through ablTypeToJsonSchema', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'complex_tool',
            description: 'A tool with various types',
            parameters: [
              { name: 'name', type: 'string', required: true, description: 'User name' },
              { name: 'age', type: 'integer', required: true, description: 'Age' },
              { name: 'email', type: 'email', required: false, description: 'Email' },
              { name: 'tags', type: 'string[]', required: false, description: 'Tags' },
            ],
            returns: { type: 'object' },
            hints: {
              cacheable: false,
              latency: 'medium',
              parallelizable: false,
              side_effects: false,
              requires_auth: false,
            },
          },
        ],
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const tool = tools.find((t) => t.name === 'complex_tool')!;
      expect(tool.input_schema.properties.name).toEqual({
        type: 'string',
        description: 'User name',
      });
      expect(tool.input_schema.properties.age).toEqual({ type: 'integer', description: 'Age' });
      expect(tool.input_schema.properties.email).toEqual({
        type: 'string',
        description: 'Email (email address)',
      });
      expect(tool.input_schema.properties.tags).toEqual({
        type: 'array',
        description: 'Tags',
        items: { type: 'string' },
      });
    });
  });

  describe('empty IR', () => {
    it('returns no tools when agent has no tools, handoffs, delegates, or escalation config', () => {
      const ir = makeIR();
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      expect(tools).toHaveLength(0);
    });
  });

  describe('null IR', () => {
    it('returns no tools when agentIR is null', () => {
      const session = makeSession({ agentIR: null });
      const tools = buildTools(session);
      expect(tools).toHaveLength(0);
    });
  });

  describe('buildTools — reason parameter removal', () => {
    it('should NOT inject reason parameter into regular tools', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'check_balance',
            description: 'Check account balance',
            parameters: [{ name: 'account_id', type: 'string', description: 'Account ID' }],
          },
        ],
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const checkBalance = tools.find((t) => t.name === 'check_balance');
      expect(checkBalance).toBeDefined();
      expect(checkBalance!.input_schema.properties).not.toHaveProperty('reason');
      expect(checkBalance!.input_schema.required).not.toContain('reason');
    });

    it('should still inject thought parameter when extended thinking is enabled', () => {
      const ir = makeIR({
        tools: [
          {
            name: 'check_balance',
            description: 'Check account balance',
            parameters: [{ name: 'account_id', type: 'string', description: 'Account ID' }],
          },
        ],
        execution: {
          ...makeIR().execution,
          enable_thinking: true,
        },
      });
      const session = makeSession({ agentIR: ir });
      const tools = buildTools(session);
      const checkBalance = tools.find((t) => t.name === 'check_balance');
      expect(checkBalance!.input_schema.properties).toHaveProperty('thought');
      expect(checkBalance!.input_schema.properties).not.toHaveProperty('reason');
      expect(checkBalance!.input_schema.required).toContain('thought');
    });
  });
});

// =============================================================================
// buildSystemPrompt — dynamic IDENTITY interpolation
// =============================================================================

describe('buildSystemPrompt — IDENTITY interpolation', () => {
  it('resolves {{customer_name}} in goal from session values', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help {{customer_name}} with their account',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { customer_name: 'Alice' },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Help Alice with their account');
    expect(prompt).not.toContain('{{customer_name}}');
  });

  it('resolves {{customer_tier}} in persona from session values', () => {
    const ir = makeIR({
      identity: {
        goal: 'Assist users',
        persona: 'You are a {{customer_tier}} support specialist',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { customer_tier: 'premium' },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('You are a premium support specialist');
    expect(prompt).not.toContain('{{customer_tier}}');
  });

  it('resolves {{restricted_topic}} in limitations from session values', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help users',
        persona: '',
        limitations: ['Never discuss {{restricted_topic}}', 'Be concise'],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { restricted_topic: 'pricing' },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Never discuss pricing');
    expect(prompt).not.toContain('{{restricted_topic}}');
    expect(prompt).toContain('Be concise');
  });

  it('leaves goal unchanged when no {{}} templates present', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help users with travel bookings',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: {}, gatheredKeys: new Set() },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Help users with travel bookings');
  });

  it('preserves {{missing_key}} as-is when not in session values', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help {{missing_key}} with their account',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: {}, gatheredKeys: new Set() },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('{{missing_key}}');
  });

  it('resolves {{workflow.*}} in goal from execution tree projection', () => {
    const ir = makeIR({
      identity: {
        goal: 'Current appointment time: {{workflow.current_date_time}}',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      channelType: 'voice',
      data: {
        values: {
          session: {
            s2sProvider: 's2s:google',
          },
          execution_tree: {
            workflow: {
              current_date_time: '2026-04-21 18:30:00',
            },
          },
        },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Current appointment time: 2026-04-21 18:30:00');
    expect(prompt).not.toContain('{{workflow.current_date_time}}');
  });

  it('does not resolve {{workflow.*}} from projections outside Google realtime voice sessions', () => {
    const ir = makeIR({
      identity: {
        goal: 'Current appointment time: {{workflow.current_date_time}}',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: {
          execution_tree: {
            workflow: {
              current_date_time: '2026-04-21 18:30:00',
            },
          },
        },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('{{workflow.current_date_time}}');
  });

  it('resolves templates in custom system prompt path', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help {{customer_name}}',
        persona: 'A {{role}} assistant',
        system_prompt: {
          custom: true,
          template: 'You are {{name}}. Goal: {{goal}}. Persona: {{persona}}.',
          sections: {},
        },
        limitations: [],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { customer_name: 'Bob', role: 'senior' },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Help Bob');
    expect(prompt).toContain('A senior assistant');
  });

  it('resolves {{workflow.*}} in custom system prompts from granted memory projection', () => {
    const ir = makeIR({
      identity: {
        goal: 'Manage bookings',
        system_prompt: {
          custom: true,
          template: 'Appointment context: {{workflow.current_date_time}}',
          sections: {},
        },
        limitations: [],
      },
    });
    const session = makeSession({
      agentIR: ir,
      channelType: 'voice',
      data: {
        values: {
          session: {
            s2sProvider: 's2s:google',
          },
          granted_memory: {
            workflow: {
              current_date_time: '2026-04-21 19:00:00',
            },
          },
        },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Appointment context: 2026-04-21 19:00:00');
    expect(prompt).not.toContain('{{workflow.current_date_time}}');
  });

  it('resolves session variables directly in custom system prompt template', () => {
    const ir = makeIR({
      identity: {
        goal: 'Manage bookings',
        system_prompt: {
          custom: true,
          template:
            'You are {{name}}. The current booking is {{flight_booking_id}} for {{customer_name}}.',
          sections: {},
        },
        limitations: [],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { flight_booking_id: 'FL-12345', customer_name: 'Alice' },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('FL-12345');
    expect(prompt).toContain('Alice');
    expect(prompt).not.toContain('{{flight_booking_id}}');
    expect(prompt).not.toContain('{{customer_name}}');
  });

  it('supports tools, context, and history in custom system prompts without duplicating context sections', () => {
    const ir = makeIR({
      identity: {
        goal: 'Handle banking support',
        persona: 'A banking assistant',
        system_prompt: {
          custom: true,
          template: [
            'You are {{name}}.',
            '{% if tools %}TOOLS={{ tools | json }}{% endif %}',
            '{% if context %}CONTEXT={{ context | json }}{% endif %}',
            '{% if history %}HISTORY={{history}}{% endif %}',
          ].join('\n'),
          sections: {},
        },
        limitations: [],
      },
      tools: [
        {
          name: 'get_account_info',
          description: 'Fetch banking data',
          parameters: [{ name: 'requestedData', type: 'string', required: true }],
        },
      ],
    });
    const session = makeSession({
      agentIR: ir,
      conversationHistory: [
        { role: 'user', content: 'What is my balance?' },
        { role: 'system', content: 'Auth already satisfied.' },
      ],
      data: {
        values: { customer_name: 'Alice' },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('TOOLS=');
    expect(prompt).toContain('"name": "get_account_info"');
    expect(prompt).toContain('CONTEXT=');
    expect(prompt).toContain('"customer_name": "Alice"');
    expect(prompt).toContain('HISTORY=User: What is my balance?');
    expect(prompt).toContain('System: Auth already satisfied.');
    expect(prompt).not.toContain('{% if tools %}');
    expect(prompt).not.toContain('{{ tools | json }}');
    expect(prompt.match(/customer_name/g)?.length).toBe(1);
  });

  it('renders bare {{context}} as JSON in custom system prompts', () => {
    const ir = makeIR({
      identity: {
        goal: 'Handle banking support',
        persona: 'A banking assistant',
        system_prompt: {
          custom: true,
          template: 'CONTEXT={{context}}',
          sections: {},
        },
        limitations: [],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { customer_name: 'Alice' },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('CONTEXT={');
    expect(prompt).toContain('"customer_name": "Alice"');
    expect(prompt).not.toContain('[object Object]');
  });

  it('supports handlebars tools, history, and context path references in custom system prompts', () => {
    const ir = makeIR({
      identity: {
        goal: 'Handle banking support',
        persona: 'A banking assistant',
        system_prompt: {
          custom: true,
          template: [
            '{{#if context.customer_name}}NAME={{context.customer_name}}{{/if}}',
            '{{#each tools}}TOOL={{name}}:{{description}}{{/each}}',
            '{{#if history}}HISTORY={{history}}{{/if}}',
          ].join('\n'),
          sections: {},
        },
        limitations: [],
      },
      tools: [
        {
          name: 'get_account_info',
          description: 'Fetch banking data',
          parameters: [{ name: 'requestedData', type: 'string', required: true }],
        },
      ],
    });
    const session = makeSession({
      agentIR: ir,
      conversationHistory: [
        { role: 'user', content: 'What is my balance?' },
        { role: 'system', content: 'Auth already satisfied.' },
      ],
      data: {
        values: { customer_name: 'Alice' },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('NAME=Alice');
    expect(prompt).toContain('TOOL=get_account_info:Fetch banking data');
    expect(prompt).toContain('HISTORY=User: What is my balance?');
    expect(prompt).toContain('System: Auth already satisfied.');
    expect(prompt).not.toContain('"customer_name": "Alice"');
    expect(prompt).not.toContain('{{#if context.customer_name}}');
    expect(prompt).not.toContain('{{#each tools}}');
    expect(prompt).not.toContain('{{#if history}}');
  });

  it('preserves unrelated Jinja-like syntax in custom system prompts', () => {
    const ir = makeIR({
      identity: {
        goal: 'Explain templates',
        persona: 'A teacher',
        system_prompt: {
          custom: true,
          template: 'Example literal: {% if mode %}{{ mode | upper }}{% endif %}',
          sections: {},
        },
        limitations: [],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { mode: 'demo' },
        gatheredKeys: new Set(),
      },
    });

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('{% if mode %}');
    expect(prompt).toContain('{{ mode | upper }}');
  });
});

// =============================================================================
// isVoiceChannel
// =============================================================================

describe('isVoiceChannel', () => {
  it('returns true when session.channel is "voice"', () => {
    const session = makeSession({
      data: {
        values: { session: { channel: 'voice' } },
        gatheredKeys: new Set(),
      },
    });
    expect(isVoiceChannel(session)).toBe(true);
  });

  it('returns false when session.channel is "digital"', () => {
    const session = makeSession({
      data: {
        values: { session: { channel: 'digital' } },
        gatheredKeys: new Set(),
      },
    });
    expect(isVoiceChannel(session)).toBe(false);
  });

  it('returns false when session metadata is missing', () => {
    const session = makeSession({
      data: { values: {}, gatheredKeys: new Set() },
    });
    expect(isVoiceChannel(session)).toBe(false);
  });

  it('returns false when channel is undefined', () => {
    const session = makeSession({
      data: {
        values: { session: {} },
        gatheredKeys: new Set(),
      },
    });
    expect(isVoiceChannel(session)).toBe(false);
  });

  it('returns true when session.channel is "voice_twilio"', () => {
    const session = makeSession({
      data: {
        values: { session: { channel: 'voice_twilio' } },
        gatheredKeys: new Set(),
      },
    });
    expect(isVoiceChannel(session)).toBe(true);
  });

  it('returns true when session.channel is "voice_livekit"', () => {
    const session = makeSession({
      data: {
        values: { session: { channel: 'voice_livekit' } },
        gatheredKeys: new Set(),
      },
    });
    expect(isVoiceChannel(session)).toBe(true);
  });

  it('returns false when session.channel is "sdk_websocket"', () => {
    const session = makeSession({
      data: {
        values: { session: { channel: 'sdk_websocket' } },
        gatheredKeys: new Set(),
      },
    });
    expect(isVoiceChannel(session)).toBe(false);
  });

  it('returns true from top-level channelType even when data.values is empty (survives handoff)', () => {
    const session = makeSession({
      data: { values: {}, gatheredKeys: new Set() },
    });
    (session as any).channelType = 'voice_twilio';
    expect(isVoiceChannel(session)).toBe(true);
  });

  it('returns true from top-level channelType "voice" even after handoff wipes data', () => {
    const session = makeSession({
      data: { values: { some_field: 'value' }, gatheredKeys: new Set() },
    });
    (session as any).channelType = 'voice';
    expect(isVoiceChannel(session)).toBe(true);
  });

  it('top-level channelType takes precedence over data store', () => {
    const session = makeSession({
      data: {
        values: { session: { channel: 'digital' } },
        gatheredKeys: new Set(),
      },
    });
    (session as any).channelType = 'voice';
    expect(isVoiceChannel(session)).toBe(true);
  });
});

// =============================================================================
// buildSystemPrompt — voice channel
// =============================================================================

describe('buildSystemPrompt — voice channel', () => {
  it('includes voice formatting instructions for voice sessions', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help users',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { session: { channel: 'voice' } },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('Response Format (Voice Channel)');
    expect(prompt).toContain('text-to-speech');
    expect(prompt).toContain('No markdown');
    expect(prompt).toContain('No emoji');
    expect(prompt).not.toContain('Before each tool call, emit a brief status message');
  });

  it('omits voice instructions for digital channel', () => {
    const ir = makeIR({
      identity: {
        goal: 'Help users',
        persona: '',
        limitations: [],
        system_prompt: { template: '', sections: {} },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: {
        values: { session: { channel: 'digital' } },
        gatheredKeys: new Set(),
      },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).not.toContain('Response Format (Voice Channel)');
    expect(prompt).not.toContain('text-to-speech');
    expect(prompt).toContain('Before each tool call, emit a brief status message');
  });

  it('omits voice instructions when no channel is set', () => {
    const ir = makeIR();
    const session = makeSession({
      agentIR: ir,
      data: { values: {}, gatheredKeys: new Set() },
    });
    const prompt = buildSystemPrompt(session);
    expect(prompt).not.toContain('Response Format (Voice Channel)');
  });
});

// =============================================================================
// Routing pre-evaluation (condition-based tool filtering)
// =============================================================================

describe('buildTools — routing pre-evaluation', () => {
  const supervisorMeta = {
    name: 'test_agent',
    version: '1.0.0',
    type: 'supervisor' as const,
    compiled_at: new Date().toISOString(),
    source_hash: 'abc123',
    compiler_version: '1.0.0',
  };

  it('filters routing tool when WHEN condition is deterministically false', () => {
    const ir = makeIR({
      metadata: supervisorMeta,
      routing: {
        rules: [
          { to: 'fiber_agent', when: 'category == "fiber_cut"', description: 'Fiber', priority: 1 },
          {
            to: 'power_agent',
            when: 'category == "power_outage"',
            description: 'Power',
            priority: 2,
          },
        ],
        default_agent: 'fiber_agent',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: { category: 'fiber_cut' }, gatheredKeys: new Set(['category']) },
    });
    const tools = buildTools(session);
    expect(tools.find((t) => t.name === 'handoff_to_fiber_agent')).toBeDefined();
    expect(tools.find((t) => t.name === 'handoff_to_power_agent')).toBeUndefined();
  });

  it('keeps all routing tools when WHEN variables are not yet in session data', () => {
    const ir = makeIR({
      metadata: supervisorMeta,
      routing: {
        rules: [
          { to: 'fiber_agent', when: 'category == "fiber_cut"', description: 'Fiber', priority: 1 },
          {
            to: 'power_agent',
            when: 'category == "power_outage"',
            description: 'Power',
            priority: 2,
          },
        ],
        default_agent: 'fiber_agent',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: {}, gatheredKeys: new Set() },
    });
    const tools = buildTools(session);
    expect(tools.find((t) => t.name === 'handoff_to_fiber_agent')).toBeDefined();
    expect(tools.find((t) => t.name === 'handoff_to_power_agent')).toBeDefined();
  });

  it('keeps routing tool when WHEN condition is always true', () => {
    const ir = makeIR({
      metadata: supervisorMeta,
      routing: {
        rules: [{ to: 'default_agent', when: 'true', description: 'Default', priority: 1 }],
        default_agent: 'default_agent',
        intent_classification: { use_llm: true, categories: [], min_confidence: 0.5 },
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: { anything: 'val' }, gatheredKeys: new Set(['anything']) },
    });
    const tools = buildTools(session);
    expect(tools.find((t) => t.name === 'handoff_to_default_agent')).toBeDefined();
  });

  it('filters coordination handoff tool when WHEN condition is deterministically false', () => {
    const ir = makeIR({
      coordination: {
        delegates: [],
        handoffs: [
          {
            to: 'billing',
            when: 'needs_billing == true',
            context: { pass: [], summary: '' },
            return: false,
          },
          {
            to: 'support',
            when: 'needs_billing == false',
            context: { pass: [], summary: '' },
            return: false,
          },
        ],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: { needs_billing: true }, gatheredKeys: new Set(['needs_billing']) },
    });
    const tools = buildTools(session);
    expect(tools.find((t) => t.name === 'handoff_to_billing')).toBeDefined();
    expect(tools.find((t) => t.name === 'handoff_to_support')).toBeUndefined();
  });

  it('does NOT filter delegate tools even when WHEN condition is false', () => {
    const ir = makeIR({
      coordination: {
        delegates: [
          {
            agent: 'payment',
            when: 'total > 100',
            purpose: 'Pay',
            input: {},
            returns: {},
            use_result: 'result',
            on_failure: 'continue',
          },
        ],
        handoffs: [],
      },
    });
    const session = makeSession({
      agentIR: ir,
      data: { values: { total: 50 }, gatheredKeys: new Set(['total']) },
    });
    const tools = buildTools(session);
    expect(tools.find((t) => t.name === 'delegate_to_payment')).toBeDefined();
  });
});

// =============================================================================
// check_workflow_status injection (FR-1)
// =============================================================================

describe('buildTools — check_workflow_status injection (FR-1)', () => {
  it('injects check_workflow_status when _workflowStatusToolActive is true', () => {
    const ir = makeIR({
      tools: [
        {
          name: 'run_summary',
          description: 'Run a summary workflow',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'high',
            parallelizable: false,
            side_effects: true,
            requires_auth: false,
          },
        },
      ],
    });
    const session = makeSession({
      agentIR: ir,
      _workflowStatusToolActive: true,
    } as Partial<RuntimeSession>);
    const tools = buildTools(session);

    const statusTool = tools.find((t) => t.name === 'check_workflow_status');
    expect(statusTool).toBeDefined();
    expect(statusTool!.description).toContain('asynchronous workflow execution');
    expect(statusTool!.input_schema.properties.executionId).toBeDefined();
    expect(statusTool!.input_schema.required).toContain('executionId');
  });

  it('does NOT inject check_workflow_status when _workflowStatusToolActive is falsy', () => {
    const ir = makeIR({
      tools: [
        {
          name: 'run_summary',
          description: 'Run a summary workflow',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: false,
            latency: 'high',
            parallelizable: false,
            side_effects: true,
            requires_auth: false,
          },
        },
      ],
    });
    const session = makeSession({ agentIR: ir });
    const tools = buildTools(session);

    const statusTool = tools.find((t) => t.name === 'check_workflow_status');
    expect(statusTool).toBeUndefined();
  });
});

// =============================================================================
// Conversation Behavior prompt sections
// =============================================================================

describe('buildSystemPrompt — conversation behavior', () => {
  it('renders resolved conversation behavior instructions into the system prompt', () => {
    const session = makeSession({
      channelType: 'voice',
      agentIR: makeIR(),
      data: {
        values: {
          session: {
            interaction: {
              current: {
                language: 'es',
                locale: 'es-ES',
                timezone: 'Europe/Madrid',
                source: 'message',
                confidence: 'explicit',
              },
            },
          },
          _language: 'es',
          _locale: 'es-ES',
          _timezone: 'Europe/Madrid',
        },
        gatheredKeys: new Set<string>(),
      },
      _effectiveConfig: {
        additionalInstructions: [],
        tools: [],
        additionalConstraints: [],
        activeProfileNames: ['voice-profile'],
        conversationBehavior: {
          speaking: {
            style: 'warm and concise',
            language_policy: 'interaction_context',
            max_sentences: 2,
          },
          interaction: {
            confirmation: {
              actions: 'before_sensitive_actions',
            },
          },
          sourceChain: ['agent', 'profile:voice-profile'],
          capabilityDrops: [],
        },
      },
    } as Partial<RuntimeSession>);

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('## Conversation Behavior');
    expect(prompt).toContain('Adopt a warm and concise speaking style.');
    expect(prompt).toContain('Match the current interaction language (es)');
    expect(prompt).toContain('locale es-ES');
    expect(prompt).toContain('timezone Europe/Madrid');
    expect(prompt).toContain('Keep most replies to 2 sentences or fewer.');
    expect(prompt).toContain('Confirm actions before sensitive actions.');
  });

  it('falls back to agent-scoped conversation behavior when effective config is absent', () => {
    const session = makeSession({
      channelType: 'web_chat',
      agentIR: makeIR({
        conversation_behavior: {
          speaking: {
            one_thing_at_a_time: true,
          },
          listening: {
            barge_in: 'allow',
          },
        },
      }),
    });

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('## Conversation Behavior');
    expect(prompt).toContain('Ask for or present one thing at a time.');
    expect(prompt).not.toContain('barge-in');
  });

  it('keeps the status tag protocol instruction when behavior profile tool lead-ins are active', () => {
    const session = makeSession({
      channelType: 'web_chat',
      agentIR: makeIR(),
      _effectiveConfig: {
        additionalInstructions: [],
        tools: [],
        additionalConstraints: [],
        activeProfileNames: ['chat-support'],
        conversationBehavior: {
          speaking: {
            tool_lead_in: 'explained',
          },
          sourceChain: ['profile:chat-support'],
          capabilityDrops: [],
        },
      },
    } as Partial<RuntimeSession>);

    const prompt = buildSystemPrompt(session);

    expect(prompt).toContain('## Conversation Behavior');
    expect(prompt).toContain('Use explained tool lead-ins.');
    const statusInstruction =
      'Before each tool call, emit a brief status message wrapped in <status>...</status> tags.';
    expect(prompt).toContain(statusInstruction);
    expect(prompt.indexOf('## Conversation Behavior')).toBeLessThan(
      prompt.indexOf(statusInstruction),
    );
  });
});
