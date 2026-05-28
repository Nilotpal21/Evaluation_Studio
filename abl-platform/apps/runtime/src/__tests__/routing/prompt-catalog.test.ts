import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { PromptCatalog } from '../../services/execution/prompt-catalog';
import { renderTemplate } from '../../services/execution/template-engine';
import { PromptTemplateLoader } from '../../services/execution/prompt-template-loader';
import { buildSystemPrompt, buildTools } from '../../services/execution/prompt-builder';
import { interpolateTemplate } from '../../services/execution/value-resolution';
import type { RuntimeSession } from '../../services/execution/types';
import type { AgentIR } from '@abl/compiler';

describe('PromptCatalog', () => {
  describe('systemPrompt templates', () => {
    test('supervisor template renders with all sections including context and memory', () => {
      const result = renderTemplate(PromptCatalog.systemPrompt.supervisor, {
        name: 'Travel_Router',
        goal: 'Route travel requests',
        persona: 'A helpful coordinator',
        routing_rules: '- **Flight_Agent**: Handles flights\n- **Hotel_Agent**: Handles hotels',
        escalation: true,
        escalation_triggers: '- Angry customer (priority: high)',
        context_json: '{"user_name": "Alice"}',
        recall_prompts: 'Remember the user prefers window seats.',
      });
      expect(result).toContain('You are Travel_Router');
      expect(result).toContain('Your goal: Route travel requests');
      expect(result).toContain('routing supervisor');
      expect(result).toContain('Route each user request to the appropriate specialist');
      expect(result).toContain('DO NOT respond to users directly with information or help');
      expect(result).toContain('## Current Context');
      expect(result).toContain('{"user_name": "Alice"}');
      expect(result).toContain('## Recalled Memory');
      expect(result).toContain('window seats');
    });

    test('supervisor template omits context/memory when empty', () => {
      const result = renderTemplate(PromptCatalog.systemPrompt.supervisor, {
        name: 'Router',
        routing_rules: '- **Agent_A**: handles A',
        handoff_tool: '__handoff__',
        fan_out_tool: '__fan_out__',
      });
      expect(result).not.toContain('## Current Context');
      expect(result).not.toContain('## Recalled Memory');
      expect(result).not.toContain('## Response Format (Voice');
    });

    test('specialist template includes context and voice when provided', () => {
      const result = renderTemplate(PromptCatalog.systemPrompt.specialist, {
        name: 'Flight_Agent',
        goal: 'Help book flights',
        handoff_rules: '- **Hotel_Agent**: For hotel requests',
        handoff_tool: '__handoff__',
        context_json: '{"currency": "USD"}',
        voice_channel: true,
        voice_format_rules: 'Use plain conversational text.',
      });
      expect(result).toContain('specialist agent');
      expect(result).toContain('## Current Context');
      expect(result).toContain('## Response Format (Voice');
    });

    test('standalone template renders correctly', () => {
      const result = renderTemplate(PromptCatalog.systemPrompt.standalone, {
        name: 'Helper',
        goal: 'Assist users',
      });
      expect(result).toContain('You are Helper');
      expect(result).toContain('Assist users');
    });
  });

  describe('toolSchemas', () => {
    test('handoff schema has reason, target, message, context properties', () => {
      const schema = PromptCatalog.toolSchemas.handoff;
      expect(schema.properties).toHaveProperty('reason');
      expect(schema.properties).toHaveProperty('target');
      expect(schema.properties).toHaveProperty('message');
      expect(schema.properties).toHaveProperty('context');
      expect(schema.properties.message.type).toBe('string');
      expect(schema.required).toContain('reason');
      expect(schema.required).toContain('target');
      expect(schema.required).toContain('message');
    });

    test('delegate schema has reason, target, message, input properties', () => {
      const schema = PromptCatalog.toolSchemas.delegate;
      expect(schema.properties).toHaveProperty('reason');
      expect(schema.properties).toHaveProperty('target');
      expect(schema.properties).toHaveProperty('message');
      expect(schema.properties).toHaveProperty('input');
      expect(schema.properties.message.type).toBe('string');
      expect(schema.required).toContain('reason');
      expect(schema.required).toContain('target');
      expect(schema.required).toContain('message');
    });

    test('fan_out schema has tasks array with type discriminator', () => {
      const schema = PromptCatalog.toolSchemas.fan_out;
      expect(schema.properties.tasks.type).toBe('array');
      const itemProps = schema.properties.tasks.items.properties;
      expect(itemProps).toHaveProperty('type');
      expect(itemProps).toHaveProperty('target');
      expect(itemProps).toHaveProperty('intent');
      expect(itemProps).toHaveProperty('params');
    });

    test('all tool schemas include reason property', () => {
      for (const [name, schema] of Object.entries(PromptCatalog.toolSchemas)) {
        expect(schema.properties, `${name} should have properties`).toHaveProperty('reason');
      }
    });
  });

  describe('sharedDescriptions', () => {
    test('reason and thought descriptions are non-empty', () => {
      expect(PromptCatalog.sharedDescriptions.reason).toBeTruthy();
      expect(PromptCatalog.sharedDescriptions.thought).toBeTruthy();
      expect(PromptCatalog.sharedDescriptions.thought_with_budget).toContain('{{budget}}');
    });
  });

  describe('messages', () => {
    test('all message keys have non-empty values', () => {
      for (const [key, value] of Object.entries(PromptCatalog.messages)) {
        expect(value, `messages.${key} should not be empty`).toBeTruthy();
      }
    });
  });

  describe('llmPrompts', () => {
    test('all llmPrompt keys have non-empty template values', () => {
      for (const [key, value] of Object.entries(PromptCatalog.llmPrompts)) {
        expect(value, `llmPrompts.${key} should not be empty`).toBeTruthy();
        expect(typeof value).toBe('string');
      }
    });

    test('entity_extraction template contains expected placeholders', () => {
      expect(PromptCatalog.llmPrompts.entity_extraction).toContain('{{contextSection}}');
      expect(PromptCatalog.llmPrompts.entity_extraction).toContain('{{today}}');
      expect(PromptCatalog.llmPrompts.entity_extraction).toContain('{{fieldDescriptions}}');
    });

    test('correction_detection template contains expected placeholders', () => {
      expect(PromptCatalog.llmPrompts.correction_detection).toContain('{{collectedEntries}}');
      expect(PromptCatalog.llmPrompts.correction_detection).toContain('{{fieldNames}}');
    });

    test('field_validation template contains expected placeholders', () => {
      expect(PromptCatalog.llmPrompts.field_validation).toContain('{{rule}}');
      expect(PromptCatalog.llmPrompts.field_validation).toContain('{{fieldName}}');
      expect(PromptCatalog.llmPrompts.field_validation).toContain('{{valueStr}}');
    });

    test('field_inference template contains expected placeholders', () => {
      expect(PromptCatalog.llmPrompts.field_inference).toContain('{{contextStr}}');
      expect(PromptCatalog.llmPrompts.field_inference).toContain('{{fieldDescriptions}}');
    });

    test('entity_extraction renders with interpolateTemplate', () => {
      const result = interpolateTemplate(PromptCatalog.llmPrompts.entity_extraction, {
        contextSection: '\nALREADY COLLECTED:\nname: Alice\n',
        today: '2026-03-02',
        fieldDescriptions: '- name (type: string)\n- email (type: email)',
      });
      expect(result).toContain('ALREADY COLLECTED');
      expect(result).toContain('2026-03-02');
      expect(result).toContain('name (type: string)');
    });
  });

  describe('toolDescriptions', () => {
    test('all tool description keys have non-empty values', () => {
      for (const [key, value] of Object.entries(PromptCatalog.toolDescriptions)) {
        if (typeof value === 'string') {
          expect(value, `toolDescriptions.${key} should not be empty`).toBeTruthy();
        } else {
          for (const [subKey, subValue] of Object.entries(value as Record<string, string>)) {
            expect(subValue, `toolDescriptions.${key}.${subKey} should not be empty`).toBeTruthy();
          }
        }
      }
    });
  });
});

// =============================================================================
// Integration: buildSystemPrompt + buildTools use PromptCatalog via loader
// =============================================================================

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
      timeouts: { tool_timeout_ms: 30000 },
    },
    ...overrides,
  } as AgentIR;
}

describe('Stream B Integration: buildSystemPrompt uses PromptCatalog templates', () => {
  test('supervisor IR produces supervisor template output', () => {
    const ir = makeIR({
      metadata: {
        name: 'Router',
        version: '1.0.0',
        type: 'supervisor',
        compiled_at: '',
        source_hash: '',
        compiler_version: '',
      },
      identity: { name: 'Router', goal: 'Route requests' },
      routing: { rules: [{ to: 'Agent_A', when: '', description: 'Handles A', priority: 1 }] },
      coordination: {
        handoffs: [
          { to: 'Agent_A', when: '', context: { pass: [], summary: '' }, return: false },
        ] as any,
      },
    });
    const session = makeSession({ agentIR: ir, agentName: 'Router' });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('You are Router');
    expect(prompt).toContain('routing supervisor');
    expect(prompt).toContain('Route requests');
  });

  test('specialist IR with handoffs produces specialist template output', () => {
    const ir = makeIR({
      metadata: {
        name: 'Flight_Agent',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '',
        source_hash: '',
        compiler_version: '',
      },
      identity: { name: 'Flight_Agent', goal: 'Book flights' },
      coordination: {
        handoffs: [
          {
            to: 'Hotel_Agent',
            when: '',
            context: { pass: [], summary: 'Hotel requests' },
            return: false,
          },
        ] as any,
      },
    });
    const session = makeSession({ agentIR: ir, agentName: 'Flight_Agent' });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('You are Flight_Agent');
    expect(prompt).toContain('specialist agent');
    expect(prompt).toContain('Book flights');
  });

  test('standalone IR (no handoffs) produces standalone template output', () => {
    const ir = makeIR({
      metadata: {
        name: 'Helper',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '',
        source_hash: '',
        compiler_version: '',
      },
      identity: { name: 'Helper', goal: 'Assist users' },
    });
    const session = makeSession({ agentIR: ir, agentName: 'Helper' });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('You are Helper');
    expect(prompt).toContain('Assist users');
    expect(prompt).not.toContain('ROUTING-ONLY');
    expect(prompt).not.toContain('specialist');
  });

  test('null IR produces fallback template', () => {
    const session = makeSession({ agentIR: null });
    const prompt = buildSystemPrompt(session);
    expect(prompt).toContain('AI assistant');
    expect(prompt).toContain('Help the user');
  });
});

describe('Stream B Integration: buildTools uses catalog tool descriptions', () => {
  test('supervisor tools include per-agent handoff_to_Agent_A tool', () => {
    const ir = makeIR({
      metadata: {
        name: 'Router',
        version: '1.0.0',
        type: 'supervisor',
        compiled_at: '',
        source_hash: '',
        compiler_version: '',
      },
      routing: { rules: [{ to: 'Agent_A', when: '', description: 'Handles A', priority: 1 }] },
      coordination: {
        handoffs: [
          { to: 'Agent_A', when: '', context: { pass: [], summary: '' }, return: false },
        ] as any,
      },
    });
    const session = makeSession({ agentIR: ir, agentName: 'Router' });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_Agent_A');
    expect(handoff).toBeDefined();
    expect(handoff!.description).toBeTruthy();
    expect(handoff!.input_schema.properties).toHaveProperty('reason');
    expect(handoff!.input_schema.properties).toHaveProperty('message');
  });

  test('specialist tools include per-agent handoff tool and escalate when escalation is configured', () => {
    const ir = makeIR({
      metadata: {
        name: 'Agent_A',
        version: '1.0.0',
        type: 'agent',
        compiled_at: '',
        source_hash: '',
        compiler_version: '',
      },
      identity: { name: 'Agent_A', goal: 'Help' },
      coordination: {
        handoffs: [
          { to: 'Agent_B', when: '', context: { pass: [], summary: '' }, return: false },
        ] as any,
        escalation: { triggers: [{ reason: 'Angry customer', priority: 'high' }] },
      },
    });
    const session = makeSession({ agentIR: ir, agentName: 'Agent_A' });
    const tools = buildTools(session);
    const handoff = tools.find((t) => t.name === 'handoff_to_Agent_B');
    const escalate = tools.find((t) => t.name === '__escalate__');
    expect(handoff).toBeDefined();
    expect(handoff!.description).toBeTruthy();
    expect(escalate).toBeDefined();
    expect(escalate!.description).toBeTruthy();
  });
});

describe('Stream B Integration: PromptTemplateLoader DB override flows through', () => {
  let loader: PromptTemplateLoader;

  beforeEach(() => {
    loader = new PromptTemplateLoader();
  });

  test('DB-loaded system prompt overrides catalog', () => {
    const customTemplate = 'You are {{name}}, a CUSTOM supervisor.';
    loader.loadFromEntries([{ key: 'system_prompt.supervisor', content: customTemplate }]);
    // Verify the override takes effect
    const template = loader.getSystemPrompt('supervisor');
    expect(template).toBe(customTemplate);
    // Verify rendering works with the custom template
    const rendered = renderTemplate(template, { name: 'MyRouter' });
    expect(rendered).toContain('CUSTOM supervisor');
    expect(rendered).toContain('MyRouter');
  });

  test('DB-loaded tool description overrides catalog', () => {
    loader.loadFromEntries([
      { key: 'tool_description.handoff.supervisor', content: 'Custom handoff for routing' },
    ]);
    expect(loader.getToolDescription('handoff', 'supervisor')).toBe('Custom handoff for routing');
    // Non-overridden keys still use catalog
    expect(loader.getToolDescription('handoff', 'agent')).toBe(
      PromptCatalog.toolDescriptions.handoff.agent,
    );
  });

  test('missing DB gracefully falls back to catalog for all getter types', () => {
    // loader not loaded from DB — all getters return catalog defaults
    expect(loader.isLoaded).toBe(false);
    expect(loader.getSystemPrompt('supervisor')).toBe(PromptCatalog.systemPrompt.supervisor);
    expect(loader.getToolSchema('handoff')).toEqual(PromptCatalog.toolSchemas.handoff);
    expect(loader.getSharedDescription('reason')).toBe(PromptCatalog.sharedDescriptions.reason);
    expect(loader.getMessage('error_default')).toBe(PromptCatalog.messages.error_default);
    expect(loader.getEscalation('digital')).toBe(PromptCatalog.escalation.digital);
  });
});
