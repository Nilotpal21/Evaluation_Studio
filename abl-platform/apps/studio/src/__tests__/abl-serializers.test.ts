import { describe, it, expect } from 'vitest';
import { parseAgentBasedABL } from '@abl/core';
import {
  serializeIdentityToABL,
  serializeExecutionToABL,
  serializeToolsToABL,
  serializeGatherToABL,
  serializeFlowToABL,
  serializeRulesToABL,
  serializeCoordinationToABL,
  serializeOnStartToABL,
  serializeErrorHandlingToABL,
  serializeCompletionToABL,
  serializeLifecycleDiffToABL,
  serializeConversationBehaviorToABL,
  serializeLifecycleToABL,
} from '../lib/abl-serializers';

describe('abl-serializers', () => {
  describe('serializeIdentityToABL', () => {
    it('serializes a full identity section', () => {
      const edits = serializeIdentityToABL({
        goal: 'Help users book hotels',
        persona: 'Friendly booking assistant',
        limitations: ['No financial advice', 'Max 10 guests'],
      });

      expect(edits).toHaveLength(3);
      expect(edits[0]).toEqual({
        section: 'GOAL',
        content: 'GOAL: "Help users book hotels"',
      });
      expect(edits[1]).toEqual({
        section: 'PERSONA',
        content: 'PERSONA: "Friendly booking assistant"',
      });
      expect(edits[2].section).toBe('LIMITATIONS');
      expect(edits[2].content).toContain('- "No financial advice"');
      expect(edits[2].content).toContain('- "Max 10 guests"');
    });

    it('emits null for empty fields', () => {
      const edits = serializeIdentityToABL({
        goal: '',
        persona: '',
        limitations: [],
      });

      expect(edits[0]).toEqual({ section: 'GOAL', content: null });
      expect(edits[1]).toEqual({ section: 'PERSONA', content: null });
      expect(edits[2]).toEqual({ section: 'LIMITATIONS', content: null });
    });

    it('handles multiline persona with pipe syntax', () => {
      const edits = serializeIdentityToABL({
        goal: 'Help',
        persona: 'Line one\nLine two',
        limitations: [],
      });

      expect(edits[1].content).toBe('PERSONA: |\n  Line one\n  Line two');
    });

    it('escapes quotes in strings', () => {
      const edits = serializeIdentityToABL({
        goal: 'Help "users" find things',
        persona: '',
        limitations: [],
      });

      expect(edits[0].content).toBe('GOAL: "Help \\"users\\" find things"');
    });
  });

  describe('serializeExecutionToABL', () => {
    it('serializes a full execution block with all four DSL fields', () => {
      const edits = serializeExecutionToABL({
        model: 'gpt-4.1',
        temperature: 0.7,
        maxTokens: 4096,
        enableThinking: true,
      });

      expect(edits).toEqual([
        {
          section: 'EXECUTION',
          content:
            'EXECUTION:\n  model: gpt-4.1\n  temperature: 0.7\n  max_tokens: 4096\n  enable_thinking: true',
        },
      ]);
    });

    it('emits enable_thinking: false when explicitly disabled', () => {
      const edits = serializeExecutionToABL({
        model: 'claude-3-5-sonnet',
        enableThinking: false,
      });

      expect(edits[0].content).toBe(
        'EXECUTION:\n  model: claude-3-5-sonnet\n  enable_thinking: false',
      );
    });

    it('omits model when undefined or empty (so runtime falls back to project/tenant default)', () => {
      const edits = serializeExecutionToABL({
        model: '',
        temperature: 0.5,
      });

      expect(edits[0].content).toBe('EXECUTION:\n  temperature: 0.5');
      expect(edits[0].content).not.toContain('model:');
    });

    it('omits enable_thinking when null (inherit from project)', () => {
      const edits = serializeExecutionToABL({
        model: 'gpt-4.1',
        enableThinking: null,
      });

      expect(edits[0].content).toBe('EXECUTION:\n  model: gpt-4.1');
      expect(edits[0].content).not.toContain('enable_thinking');
    });

    it('removes the EXECUTION section entirely when no fields are set', () => {
      const edits = serializeExecutionToABL({});

      expect(edits).toEqual([{ section: 'EXECUTION', content: null }]);
    });

    it('removes the EXECUTION section when model is empty and other fields are undefined/null', () => {
      const edits = serializeExecutionToABL({
        model: '',
        temperature: undefined,
        maxTokens: undefined,
        enableThinking: null,
      });

      expect(edits).toEqual([{ section: 'EXECUTION', content: null }]);
    });

    it('quotes a model id only when it contains characters outside the plain-token set', () => {
      // Plain tokens (alphanum, _, ., /, :, -) emit unquoted
      const plain = serializeExecutionToABL({ model: 'openai/gpt-4-turbo' });
      expect(plain[0].content).toBe('EXECUTION:\n  model: openai/gpt-4-turbo');

      // Anything else gets inline-quoted
      const quoted = serializeExecutionToABL({ model: 'my model' });
      expect(quoted[0].content).toBe('EXECUTION:\n  model: "my model"');
    });

    it('emits temperature 0 (falsy but valid)', () => {
      const edits = serializeExecutionToABL({ temperature: 0 });
      expect(edits[0].content).toBe('EXECUTION:\n  temperature: 0');
    });

    it('skips non-finite or non-integer numeric values', () => {
      const edits = serializeExecutionToABL({
        temperature: Number.NaN,
        maxTokens: 4096.5,
      });
      expect(edits).toEqual([{ section: 'EXECUTION', content: null }]);
    });
  });

  describe('serializeToolsToABL', () => {
    it('serializes tools with parameters', () => {
      const edits = serializeToolsToABL([
        {
          name: 'search_hotels',
          description: 'Search for hotels',
          parameters: [
            { name: 'destination', type: 'string', required: true },
            { name: 'checkin', type: 'date', required: true },
          ],
          returns: { type: 'array' },
          hints: {},
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].section).toBe('TOOLS');
      expect(edits[0].content).toContain('search_hotels(destination: string, checkin: date)');
      expect(edits[0].content).toContain(' -> array');
      expect(edits[0].content).toContain('description: "Search for hotels"');
    });

    it('returns null content when empty', () => {
      const edits = serializeToolsToABL([]);
      expect(edits).toEqual([{ section: 'TOOLS', content: null }]);
    });

    it('serializes optional parameters with ? marker', () => {
      const edits = serializeToolsToABL([
        {
          name: 'find_user',
          description: '',
          parameters: [
            { name: 'name', type: 'string', required: true },
            { name: 'limit', type: 'number', required: false },
          ],
          returns: { type: 'object' },
          hints: {},
        },
      ]);

      expect(edits[0].content).toContain('find_user(name: string, limit?: number)');
    });

    it('serializes return type without {result:} wrapper', () => {
      const edits = serializeToolsToABL([
        {
          name: 'get_user',
          description: '',
          parameters: [],
          returns: { type: 'string' },
          hints: {},
        },
      ]);

      expect(edits[0].content).toContain('get_user() -> string');
      expect(edits[0].content).not.toContain('{result:');
    });

    it('serializes tool type', () => {
      const edits = serializeToolsToABL([
        {
          name: 'api_call',
          description: '',
          parameters: [],
          returns: { type: 'object' },
          toolType: 'http',
          hints: {},
        },
      ]);

      expect(edits[0].content).toContain('type: http');
    });

    it('serializes hints', () => {
      const edits = serializeToolsToABL([
        {
          name: 'slow_tool',
          description: '',
          parameters: [],
          returns: { type: 'object' },
          hints: {
            cacheable: true,
            latency: 'slow',
            side_effects: true,
            requires_auth: true,
            timeout: 30000,
          },
        },
      ]);

      const content = edits[0].content!;
      expect(content).toContain('hints:');
      expect(content).toContain('cacheable: true');
      expect(content).toContain('latency: slow');
      expect(content).toContain('side_effects: true');
      expect(content).toContain('requires_auth: true');
      expect(content).toContain('timeout: 30000');
    });

    it('omits hints block when no displayable hints', () => {
      const edits = serializeToolsToABL([
        {
          name: 'simple_tool',
          description: '',
          parameters: [],
          returns: { type: 'object' },
          hints: { latency: 'medium' },
        },
      ]);

      expect(edits[0].content).not.toContain('hints:');
    });
  });

  describe('serializeGatherToABL', () => {
    it('serializes gather fields in YAML-block format', () => {
      const edits = serializeGatherToABL([
        {
          name: 'destination',
          prompt: 'Where do you want to go?',
          type: 'string',
          required: true,
        },
        {
          name: 'budget',
          prompt: 'What is your budget?',
          type: 'number',
          required: false,
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].section).toBe('GATHER');
      // YAML-block format: "fieldname:" on its own line, properties indented below
      expect(edits[0].content).toContain('  destination:');
      expect(edits[0].content).toContain('    prompt: "Where do you want to go?"');
      expect(edits[0].content).toContain('  budget:');
      expect(edits[0].content).toContain('    type: number');
      expect(edits[0].content).toContain('    required: false');
      // String type is omitted (parser default)
      expect(edits[0].content).not.toMatch(/destination:\n\s+type: string/);
      // Required true is omitted (parser default)
      expect(edits[0].content).not.toMatch(/destination:[\s\S]*?required: true/);
    });

    it('returns null for empty gather', () => {
      const edits = serializeGatherToABL([]);
      expect(edits).toEqual([{ section: 'GATHER', content: null }]);
    });

    it('includes validation rules', () => {
      const edits = serializeGatherToABL([
        {
          name: 'email',
          prompt: 'Your email?',
          type: 'string',
          required: true,
          validation: {
            type: 'regex',
            rule: 'matches_email(email)',
            errorMessage: 'Please enter a valid email',
          },
        },
      ]);

      expect(edits[0].content).toContain('validate: matches_email(email)');
      expect(edits[0].content).toContain('on_fail: "Please enter a valid email"');
    });

    it('serializes pii_type and advanced semantics while keeping lookup in the semantics block', () => {
      const edits = serializeGatherToABL([
        {
          name: 'contact_info',
          prompt: 'How should we reach you?',
          type: 'string',
          required: true,
          piiType: 'email',
          lookupTable: 'contact_methods',
          semantics: {
            lookup: 'stale_lookup_should_be_overridden',
            format: 'email',
            locale: 'en-US',
            kore_entity_type: 'EMAIL',
          },
        },
      ]);

      expect(edits[0].content).toContain('pii_type: email');
      expect(edits[0].content).toContain('semantics:');
      expect(edits[0].content).toContain('lookup: contact_methods');
      expect(edits[0].content).toContain('format: email');
      expect(edits[0].content).toContain('locale: en-US');
      expect(edits[0].content).toContain('kore_entity_type: EMAIL');
    });

    it('preserves semantics.enum_set as the emitted enum source when present', () => {
      const edits = serializeGatherToABL([
        {
          name: 'priority',
          prompt: 'Priority?',
          type: 'enum',
          required: true,
          options: ['low', 'medium', 'high'],
          semantics: {
            enum_set: ['minor', 'major'],
            format: 'severity',
          },
        },
      ]);

      expect(edits[0].content).toContain('semantics:');
      expect(edits[0].content).toContain('enum_set: [low, medium, high]');
      expect(edits[0].content).toContain('format: severity');
      expect(edits[0].content).not.toContain('options: [low, medium, high]');
    });

    it('serializes transient gather fields even when sensitive is false', () => {
      const edits = serializeGatherToABL([
        {
          name: 'one_time_code',
          prompt: 'What is the one-time code?',
          type: 'string',
          required: true,
          transient: true,
          sensitive: false,
        },
      ]);

      expect(edits[0].content).toContain('transient: true');
      expect(edits[0].content).not.toContain('sensitive: true');
    });
  });

  describe('serializeFlowToABL', () => {
    it('serializes flow with deterministic steps', () => {
      const edits = serializeFlowToABL({
        steps: [
          {
            name: 'greet',
            respond: 'Hello!',
            then: 'ask_name',
            hasGather: false,
            hasBranching: false,
            reasoning: false,
          },
          {
            name: 'ask_name',
            call: 'lookup_user',
            then: 'COMPLETE',
            hasGather: true,
            hasBranching: false,
            reasoning: false,
          },
        ],
        entryPoint: 'greet',
      });

      expect(edits).toHaveLength(1);
      expect(edits[0].section).toBe('FLOW');
      expect(edits[0].content).toContain('entry_point: greet');
      expect(edits[0].content).toContain('- greet');
      expect(edits[0].content).toContain('- ask_name');
      expect(edits[0].content).toContain('REASONING: false');
      expect(edits[0].content).toContain('RESPOND: "Hello!"');
      expect(edits[0].content).toContain('CALL: lookup_user');
    });

    it('serializes reasoning step with GOAL, EXIT_WHEN, MAX_TURNS', () => {
      const edits = serializeFlowToABL({
        steps: [
          {
            name: 'collect',
            respond: 'What is your income?',
            then: 'advise',
            hasGather: true,
            hasBranching: false,
            reasoning: false,
          },
          {
            name: 'advise',
            goal: 'Recommend the best card based on spending habits',
            exitWhen: 'selected_card != null',
            maxTurns: 8,
            then: 'confirm',
            hasGather: false,
            hasBranching: false,
            reasoning: true,
          },
          {
            name: 'confirm',
            respond: 'You selected {{selected_card.name}}',
            then: 'COMPLETE',
            hasGather: false,
            hasBranching: false,
            reasoning: false,
          },
        ],
        entryPoint: 'collect',
      });

      expect(edits).toHaveLength(1);
      const content = edits[0].content!;
      // Deterministic step
      expect(content).toContain('collect:\n    REASONING: false');
      expect(content).toContain('RESPOND: "What is your income?"');
      // Reasoning step
      expect(content).toContain('advise:\n    REASONING: true');
      expect(content).toContain('GOAL: "Recommend the best card based on spending habits"');
      expect(content).toContain('EXIT_WHEN: selected_card != null');
      expect(content).toContain('MAX_TURNS: 8');
      // Deterministic step
      expect(content).toContain('confirm:\n    REASONING: false');
    });

    it('omits optional reasoning fields when not set', () => {
      const edits = serializeFlowToABL({
        steps: [
          {
            name: 'chat',
            reasoning: true,
            then: 'COMPLETE',
            hasGather: false,
            hasBranching: false,
          },
        ],
        entryPoint: 'chat',
      });

      const content = edits[0].content!;
      expect(content).toContain('REASONING: true');
      expect(content).not.toContain('GOAL:');
      expect(content).not.toContain('EXIT_WHEN:');
      expect(content).not.toContain('MAX_TURNS:');
    });

    it('serializes canonical CALL WITH/AS blocks for supported flow steps', () => {
      const edits = serializeFlowToABL({
        steps: [
          {
            name: 'lookup_customer',
            call: 'lookup_customer',
            callSpec: {
              tool: 'lookup_customer',
              with: {
                email: 'customer_email',
              },
              as: 'customer_record',
            },
            then: 'COMPLETE',
            hasGather: false,
            hasBranching: false,
            reasoning: false,
          },
        ],
        entryPoint: 'lookup_customer',
      });

      expect(edits).toEqual([
        {
          section: 'FLOW',
          content: `FLOW:
  entry_point: lookup_customer
  steps:
    - lookup_customer

  lookup_customer:
    REASONING: false
    CALL: lookup_customer
      WITH:
        email: customer_email
      AS: customer_record
    THEN: COMPLETE`,
        },
      ]);

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_Flow
GOAL: "Round-trip"
${edits[0].content!}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.flow?.definitions.lookup_customer?.callSpec).toEqual({
        tool: 'lookup_customer',
        with: {
          email: 'customer_email',
        },
        as: 'customer_record',
      });
    });

    it('returns null for null flow', () => {
      const edits = serializeFlowToABL(null);
      expect(edits).toEqual([{ section: 'FLOW', content: null }]);
    });
  });

  describe('serializeRulesToABL', () => {
    it('serializes constraints and guardrails', () => {
      const edits = serializeRulesToABL({
        constraints: [
          {
            condition: 'num_guests <= 10',
            onFail: { type: 'respond', message: 'Max 10 guests' },
          },
        ],
        guardrails: [
          {
            name: 'pii_check',
            description: 'Block PII',
            check: 'no_pii(input)',
            action: { type: 'block', message: 'PII detected' },
          },
        ],
      });

      expect(edits).toHaveLength(2);
      expect(edits[0].section).toBe('CONSTRAINTS');
      expect(edits[0].content).toContain('REQUIRE num_guests <= 10');
      expect(edits[0].content).toContain('ON_FAIL: "Max 10 guests"');

      expect(edits[1].section).toBe('GUARDRAILS');
      expect(edits[1].content).toContain('pii_check:');
      expect(edits[1].content).toContain('check: no_pii(input)');
      expect(edits[1].content).toContain('action: block');
    });

    it('returns null for empty rules', () => {
      const edits = serializeRulesToABL({ constraints: [], guardrails: [] });
      expect(edits).toEqual([
        { section: 'CONSTRAINTS', content: null },
        { section: 'GUARDRAILS', content: null },
      ]);
    });
  });

  describe('serializeCoordinationToABL', () => {
    it('serializes delegates and handoffs', () => {
      const edits = serializeCoordinationToABL({
        delegates: [
          { agent: 'Specialist', when: 'needs_specialist', purpose: 'Handle specialist request' },
        ],
        handoffs: [
          {
            to: 'Support',
            when: 'user.wants_help',
            summary: 'Transfer to support',
            returnable: true,
          },
        ],
        escalation: {
          triggers: [
            {
              when: 'user.wants_human == true',
              reason: 'User requested human assistance',
              priority: 'high',
            },
          ],
          contextForHuman: [],
          onHumanComplete: [],
        },
      });

      expect(edits).toHaveLength(3);
      expect(edits[0].section).toBe('DELEGATE');
      expect(edits[0].content).toContain('TO: Specialist');
      expect(edits[0].content).toContain('WHEN: needs_specialist');

      expect(edits[1].section).toBe('HANDOFF');
      expect(edits[1].content).toContain('TO: Support');
      expect(edits[1].content).toContain('RETURN: true');

      expect(edits[2].section).toBe('ESCALATE');
      expect(edits[2].content).toContain('ESCALATE:');
    });

    it('serializes full ESCALATE with routing and voice settings', () => {
      const edits = serializeCoordinationToABL({
        delegates: [],
        handoffs: [],
        escalation: {
          triggers: [
            {
              when: 'user.wants_human',
              reason: 'User requested',
              priority: 'high',
              tags: ['manual'],
            },
          ],
          contextForHuman: ['conversation_history', 'user_id'],
          onHumanComplete: [{ condition: 'human.resolved == true', action: 'COMPLETE' }],
          routing: {
            connectionId: 'smartassist-prod',
            queue: 'billing',
            skills: ['billing', 'english'],
            priority: 5,
            postAgentAction: 'return' as const,
            voice: {
              transferMethod: 'refer' as const,
              sipHeaders: { UUI: '{{contactId}}' },
            },
          },
        },
      });

      const escalateEdit = edits.find((e) => e.section === 'ESCALATE');
      expect(escalateEdit?.content).toContain('context_for_human:');
      expect(escalateEdit?.content).toContain('- conversation_history');
      expect(escalateEdit?.content).toContain('on_human_complete:');
      expect(escalateEdit?.content).toContain('IF: human.resolved == true');
      expect(escalateEdit?.content).toContain('routing:');
      expect(escalateEdit?.content).toContain('connection: smartassist-prod');
      expect(escalateEdit?.content).toContain('queue: billing');
      expect(escalateEdit?.content).toContain('skills: [billing, english]');
      expect(escalateEdit?.content).toContain('priority: 5');
      expect(escalateEdit?.content).toContain('post_agent: return');
      expect(escalateEdit?.content).toContain('voice:');
      expect(escalateEdit?.content).toContain('transfer_method: refer');
      expect(escalateEdit?.content).toContain('UUI:');
    });

    it('returns null for empty coordination', () => {
      const edits = serializeCoordinationToABL({
        delegates: [],
        handoffs: [],
        escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
      });

      expect(edits).toEqual([
        { section: 'DELEGATE', content: null },
        { section: 'HANDOFF', content: null },
        { section: 'ESCALATE', content: null },
      ]);
    });
  });

  describe('serializeLifecycleToABL', () => {
    it('serializes full lifecycle data', () => {
      const edits = serializeLifecycleToABL({
        hasOnStart: true,
        onStartRespond: 'Welcome!',
        hasHooks: true,
        hooks: ['before_turn', 'after_turn'],
        errorHandlers: [{ type: 'timeout', respond: 'Taking too long', then: 'continue' }],
        completionConditions: [{ when: 'task_complete == true', respond: 'All done!' }],
        memoryConfig: {
          sessionVars: ['current_intent'],
          persistentPaths: ['user.name'],
          rememberTriggers: 0,
          recallInstructions: 0,
        },
      });

      expect(edits).toHaveLength(5);

      // ON_START
      expect(edits[0].section).toBe('ON_START');
      expect(edits[0].content).toContain('RESPOND: "Welcome!"');

      // HOOKS
      expect(edits[1].section).toBe('HOOKS');
      expect(edits[1].content).toContain('before_turn: true');

      // ON_ERROR
      expect(edits[2].section).toBe('ON_ERROR');
      expect(edits[2].content).toContain('timeout:');
      expect(edits[2].content).toContain('THEN: CONTINUE');

      // COMPLETE
      expect(edits[3].section).toBe('COMPLETE');
      expect(edits[3].content).toContain('WHEN: task_complete == true');

      // MEMORY
      expect(edits[4].section).toBe('MEMORY');
      expect(edits[4].content).toContain('session:');
      expect(edits[4].content).toContain('- current_intent');
      expect(edits[4].content).toContain('persistent:');
      expect(edits[4].content).toContain('- user.name');
    });

    it('returns null for empty lifecycle', () => {
      const edits = serializeLifecycleToABL({
        hasOnStart: false,
        hasHooks: false,
        hooks: [],
        errorHandlers: [],
        completionConditions: [],
        memoryConfig: {
          sessionVars: [],
          persistentPaths: [],
          rememberTriggers: 0,
          recallInstructions: 0,
        },
      });

      expect(edits).toEqual([
        { section: 'ON_START', content: null },
        { section: 'HOOKS', content: null },
        { section: 'ON_ERROR', content: null },
        { section: 'COMPLETE', content: null },
        { section: 'MEMORY', content: null },
      ]);
    });

    it('serializes structured HOOKS bodies when hook configs are present', () => {
      const edits = serializeLifecycleToABL({
        hasOnStart: false,
        hasHooks: true,
        hooks: ['before_turn'],
        hookConfigs: {
          before_turn: {
            respond: 'Choose next step',
            voiceConfig: {
              plain_text: 'Choose next step',
            },
            richContent: {
              markdown: '### Choose next step',
            },
            actions: {
              elements: [{ id: 'done', type: 'button', label: 'Done' }],
            },
            critical: true,
          },
        },
        errorHandlers: [],
        completionConditions: [],
        memoryConfig: {
          sessionVars: [],
          persistentPaths: [],
          rememberTriggers: 0,
          recallInstructions: 0,
        },
      });

      const hooksEdit = edits.find((edit) => edit.section === 'HOOKS');
      expect(hooksEdit?.content).toContain('before_turn:');
      expect(hooksEdit?.content).toContain('RESPOND: "Choose next step"');
      expect(hooksEdit?.content).toContain('VOICE:');
      expect(hooksEdit?.content).toContain('FORMATS:');
      expect(hooksEdit?.content).toContain('ACTIONS:');
      expect(hooksEdit?.content).toContain('CRITICAL: true');
      expect(hooksEdit?.content).not.toContain('before_turn: true');

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_Hooks
GOAL: "Round-trip"
${hooksEdit?.content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.hooks?.before_turn).toMatchObject({
        respond: 'Choose next step',
        voiceConfig: {
          plainText: 'Choose next step',
        },
        richContent: {
          markdown: '### Choose next step',
        },
        actions: {
          elements: [{ id: 'done', type: 'button', label: 'Done' }],
        },
        critical: true,
      });
    });
  });

  describe('lifecycle section serializers', () => {
    it('serializes ON_ERROR structured handler metadata for round-trip fidelity', () => {
      const edits = serializeErrorHandlingToABL([
        {
          type: 'tool_timeout',
          subtypes: ['transient'],
          respond: 'Retrying your request.',
          then: 'handoff',
          handoffTarget: 'human_support',
          retry: 2,
          retryDelayMs: 2500,
          retryBackoff: 'exponential',
          retryMaxDelayMs: 10000,
          voiceConfig: {
            plain_text: 'Retrying your request.',
          },
          richContent: {
            markdown: '### Retrying your request',
          },
          actions: {
            elements: [{ id: 'retry', type: 'button', label: 'Retry now' }],
          },
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].content).toContain('tool_timeout:');
      expect(edits[0].content).toContain('RESPOND: "Retrying your request."');
      expect(edits[0].content).toContain('SUBTYPES: [transient]');
      expect(edits[0].content).toContain('VOICE:');
      expect(edits[0].content).toContain('FORMATS:');
      expect(edits[0].content).toContain('ACTIONS:');
      expect(edits[0].content).toContain('RETRY: 2');
      expect(edits[0].content).toContain('RETRY_DELAY: 2500');
      expect(edits[0].content).toContain('RETRY_BACKOFF: exponential');
      expect(edits[0].content).toContain('RETRY_MAX_DELAY: 10000');
      expect(edits[0].content).toContain('THEN: HANDOFF human_support');

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_OnError
GOAL: "Round-trip"
${edits[0].content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.onError?.[0]).toMatchObject({
        type: 'tool_timeout',
        subtypes: ['transient'],
        respond: 'Retrying your request.',
        retry: 2,
        retryDelay: 2500,
        retryBackoff: 'exponential',
        retryMaxDelay: 10000,
        then: 'HANDOFF human_support',
        voiceConfig: {
          plainText: 'Retrying your request.',
        },
        richContent: {
          markdown: '### Retrying your request',
        },
        actions: {
          elements: [{ id: 'retry', type: 'button', label: 'Retry now' }],
        },
      });
    });

    it('serializes DEFAULT handlers as the ON_ERROR default handler block', () => {
      const edits = serializeErrorHandlingToABL([
        {
          type: 'DEFAULT',
          respond: 'Catch-all fallback.',
          then: 'continue',
          actions: {
            elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
          },
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].content).toContain('DEFAULT:');
      expect(edits[0].content).toContain('RESPOND: "Catch-all fallback."');
      expect(edits[0].content).toContain('ACTIONS:');

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_DefaultHandler
GOAL: "Round-trip"
${edits[0].content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.onError?.[0]).toMatchObject({
        type: 'DEFAULT',
        respond: 'Catch-all fallback.',
        then: 'CONTINUE',
        actions: {
          elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
        },
      });
    });

    it('preserves structured-only DEFAULT handlers with an empty RESPOND carrier', () => {
      const edits = serializeErrorHandlingToABL([
        {
          type: 'DEFAULT',
          respond: '',
          then: 'continue',
          voiceConfig: {
            plain_text: 'Retry by voice only.',
          },
          richContent: {
            markdown: '### Retry card',
          },
          actions: {
            elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
          },
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].content).toContain('DEFAULT:');
      expect(edits[0].content).toContain('RESPOND: ""');
      expect(edits[0].content).toContain('VOICE:');
      expect(edits[0].content).toContain('FORMATS:');
      expect(edits[0].content).toContain('ACTIONS:');

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_DefaultHandlerStructuredOnly
GOAL: "Round-trip"
${edits[0].content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.onError?.[0]).toMatchObject({
        type: 'DEFAULT',
        respond: '',
        voiceConfig: {
          plainText: 'Retry by voice only.',
        },
        richContent: {
          markdown: '### Retry card',
        },
        actions: {
          elements: [{ id: 'retry', type: 'button', label: 'Retry' }],
        },
      });
    });

    it('serializes COMPLETE structured metadata for round-trip fidelity', () => {
      const edits = serializeCompletionToABL([
        {
          when: 'task_complete == true',
          respond: 'All done!',
          voiceConfig: {
            plain_text: 'All done!',
          },
          richContent: {
            markdown: '### All done!',
          },
          actions: {
            elements: [{ id: 'done', type: 'button', label: 'Done' }],
          },
          store: '{reservation_id, user.email} -> user.completed_reservations',
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].content).toContain('WHEN: task_complete == true');
      expect(edits[0].content).toContain('RESPOND: "All done!"');
      expect(edits[0].content).toContain('VOICE:');
      expect(edits[0].content).toContain('FORMATS:');
      expect(edits[0].content).toContain('ACTIONS:');
      expect(edits[0].content).toContain(
        'STORE: {reservation_id, user.email} -> user.completed_reservations',
      );

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_Complete
GOAL: "Round-trip"
${edits[0].content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.complete?.[0]).toMatchObject({
        when: 'task_complete == true',
        respond: 'All done!',
        store: '{reservation_id, user.email} -> user.completed_reservations',
        voiceConfig: {
          plainText: 'All done!',
        },
        richContent: {
          markdown: '### All done!',
        },
        actions: {
          elements: [{ id: 'done', type: 'button', label: 'Done' }],
        },
      });
    });

    it('preserves structured-only COMPLETE conditions with an empty RESPOND carrier', () => {
      const edits = serializeCompletionToABL([
        {
          when: 'task_complete == true',
          respond: '',
          voiceConfig: {
            plain_text: 'All done by voice.',
          },
          richContent: {
            markdown: '### Completion card',
          },
          actions: {
            elements: [{ id: 'done', type: 'button', label: 'Done' }],
          },
          store: '{reservation_id} -> user.completed_reservations',
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].content).toContain('WHEN: task_complete == true');
      expect(edits[0].content).toContain('RESPOND: ""');
      expect(edits[0].content).toContain('VOICE:');
      expect(edits[0].content).toContain('FORMATS:');
      expect(edits[0].content).toContain('ACTIONS:');
      expect(edits[0].content).toContain('STORE: {reservation_id} -> user.completed_reservations');

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_CompleteStructuredOnly
GOAL: "Round-trip"
${edits[0].content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.complete?.[0]).toMatchObject({
        when: 'task_complete == true',
        respond: '',
        store: '{reservation_id} -> user.completed_reservations',
        voiceConfig: {
          plainText: 'All done by voice.',
        },
        richContent: {
          markdown: '### Completion card',
        },
        actions: {
          elements: [{ id: 'done', type: 'button', label: 'Done' }],
        },
      });
    });

    it('round-trips lifecycle action sets with submit controls and input elements', () => {
      const edits = serializeCompletionToABL([
        {
          when: 'needs_claim_details == true',
          respond: 'Please provide claim details.',
          actions: {
            submit_id: 'submit_claim_details',
            submit_label: 'Send details',
            renderId: 'render-claim-details',
            elements: [
              {
                id: 'claim_email',
                type: 'input',
                label: 'Email',
                input_type: 'email',
                placeholder: 'you@example.com',
                required: true,
                description: 'Claim contact email',
              },
              {
                id: 'claim_priority',
                type: 'select',
                label: 'Priority',
                description: 'How urgent is this claim?',
                options: [
                  { id: 'normal', label: 'Normal', description: 'Standard handling' },
                  { id: 'urgent', label: 'Urgent', description: 'Needs same-day handling' },
                ],
              },
              {
                id: 'cancel_claim',
                type: 'button',
                label: 'Cancel',
                value: 'cancel_claim',
                description: 'Cancel claim intake',
              },
            ],
          },
        },
      ]);

      expect(edits).toHaveLength(1);
      expect(edits[0].content).toContain('SUBMIT_ID: submit_claim_details');
      expect(edits[0].content).toContain('SUBMIT_LABEL: "Send details"');
      expect(edits[0].content).toContain('RENDER_ID: render-claim-details');
      expect(edits[0].content).toContain('- INPUT: "Email"');
      expect(edits[0].content).toContain('INPUT_TYPE: email');
      expect(edits[0].content).toContain('PLACEHOLDER: "you@example.com"');
      expect(edits[0].content).toContain('REQUIRED: true');
      expect(edits[0].content).toContain('DESCRIPTION: "Needs same-day handling"');

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_CompleteActions
GOAL: "Round-trip"
${edits[0].content ?? ''}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.complete?.[0].actions).toMatchObject({
        submitId: 'submit_claim_details',
        submitLabel: 'Send details',
        renderId: 'render-claim-details',
        elements: [
          {
            id: 'claim_email',
            type: 'input',
            label: 'Email',
            inputType: 'email',
            placeholder: 'you@example.com',
            required: true,
            description: 'Claim contact email',
          },
          {
            id: 'claim_priority',
            type: 'select',
            label: 'Priority',
            description: 'How urgent is this claim?',
            options: [
              { id: 'normal', label: 'Normal', description: 'Standard handling' },
              { id: 'urgent', label: 'Urgent', description: 'Needs same-day handling' },
            ],
          },
          {
            id: 'cancel_claim',
            type: 'button',
            label: 'Cancel',
            value: 'cancel_claim',
            description: 'Cancel claim intake',
          },
        ],
      });
    });

    it('serializes ON_START with canonical CALL WITH/AS and SET assignments', () => {
      const edits = serializeOnStartToABL({
        respond: 'Welcome!',
        calls: [],
        sets: [{ variable: 'session_ready', value: 'true' }],
        hooks: [],
        hasOnStart: true,
        onStartCall: 'preload_member',
        onStartCallSpec: {
          tool: 'preload_member',
          with: {
            memberId: 'session.member_id',
          },
          as: 'member_profile',
        },
      });

      expect(edits).toEqual([
        {
          section: 'ON_START',
          content: `ON_START:
  RESPOND: "Welcome!"
  CALL: preload_member
    WITH:
      memberId: session.member_id
    AS: member_profile
  SET: session_ready = true`,
        },
      ]);

      const parseResult = parseAgentBasedABL(
        `AGENT: Serializer_OnStart
GOAL: "Round-trip"
${edits[0].content!}`,
      );

      expect(parseResult.errors).toEqual([]);
      expect(parseResult.document?.onStart?.callSpec).toEqual({
        tool: 'preload_member',
        with: {
          memberId: 'session.member_id',
        },
        as: 'member_profile',
      });
    });

    it('serializes lifecycle diffs without rewriting untouched hooks or memory', () => {
      const edits = serializeLifecycleDiffToABL(
        {
          hasOnStart: true,
          onStartRespond: 'Welcome!',
          onStartCall: 'preload_member',
          onStartCallSpec: {
            tool: 'preload_member',
            with: {
              memberId: 'session.member_id',
            },
            as: 'member_profile',
          },
          onStartSets: [{ variable: 'session_ready', value: 'true' }],
          hasHooks: true,
          hooks: ['before_turn'],
          errorHandlers: [{ type: 'timeout', respond: 'Too slow', then: 'continue' }],
          completionConditions: [{ when: 'done', respond: 'All set' }],
          memoryConfig: {
            sessionVars: ['session_ready'],
            persistentPaths: ['user.name'],
            rememberTriggers: 1,
            recallInstructions: 1,
          },
        },
        {
          hasOnStart: true,
          onStartRespond: 'Welcome back!',
          onStartCall: 'preload_member',
          onStartCallSpec: {
            tool: 'preload_member',
            with: {
              memberId: 'session.member_id',
            },
            as: 'member_profile',
          },
          onStartSets: [{ variable: 'session_ready', value: 'true' }],
          hasHooks: true,
          hooks: ['before_turn'],
          errorHandlers: [{ type: 'timeout', respond: 'Too slow', then: 'continue' }],
          completionConditions: [{ when: 'done', respond: 'All set' }],
          memoryConfig: {
            sessionVars: ['session_ready'],
            persistentPaths: ['user.name'],
            rememberTriggers: 1,
            recallInstructions: 1,
          },
        },
      );

      expect(edits).toEqual([
        {
          section: 'ON_START',
          content: `ON_START:
  RESPOND: "Welcome back!"
  CALL: preload_member
    WITH:
      memberId: session.member_id
    AS: member_profile
  SET: session_ready = true`,
        },
      ]);
    });

    it('serializes lifecycle diffs with hidden structured metadata preserved on partial visual edits', () => {
      const previous = {
        hasOnStart: false,
        hasHooks: false,
        hooks: [],
        errorHandlers: [
          {
            type: 'tool_timeout',
            respond: '',
            then: 'continue',
            subtypes: ['transient'],
            retry: 2,
            retryDelayMs: 2500,
            retryBackoff: 'exponential' as const,
            retryMaxDelayMs: 10000,
            voiceConfig: {
              plain_text: 'Retry by voice',
            },
            richContent: {
              markdown: '### Retry card',
            },
            actions: {
              elements: [{ id: 'retry', type: 'button' as const, label: 'Retry' }],
            },
          },
        ],
        completionConditions: [
          {
            when: 'task_complete == true',
            respond: '',
            voiceConfig: {
              plain_text: 'Done by voice',
            },
            richContent: {
              markdown: '### Done card',
            },
            actions: {
              elements: [{ id: 'done', type: 'button' as const, label: 'Done' }],
            },
            store: '{reservation_id} -> user.completed_reservations',
          },
        ],
        memoryConfig: {
          sessionVars: [],
          persistentPaths: [],
          rememberTriggers: 0,
          recallInstructions: 0,
        },
      };

      const edits = serializeLifecycleDiffToABL(previous, {
        ...previous,
        errorHandlers: [
          {
            ...previous.errorHandlers[0],
            respond: 'Retrying safely.',
          },
        ],
        completionConditions: [
          {
            ...previous.completionConditions[0],
            when: 'task_complete == true && customer_confirmed == true',
          },
        ],
      });

      const errorEdit = edits.find((edit) => edit.section === 'ON_ERROR');
      const completionEdit = edits.find((edit) => edit.section === 'COMPLETE');

      expect(errorEdit?.content).toContain('RESPOND: "Retrying safely."');
      expect(errorEdit?.content).toContain('SUBTYPES: [transient]');
      expect(errorEdit?.content).toContain('VOICE:');
      expect(errorEdit?.content).toContain('FORMATS:');
      expect(errorEdit?.content).toContain('ACTIONS:');
      expect(errorEdit?.content).toContain('RETRY: 2');
      expect(errorEdit?.content).toContain('RETRY_DELAY: 2500');
      expect(errorEdit?.content).toContain('RETRY_BACKOFF: exponential');
      expect(errorEdit?.content).toContain('RETRY_MAX_DELAY: 10000');

      expect(completionEdit?.content).toContain(
        'WHEN: task_complete == true && customer_confirmed == true',
      );
      expect(completionEdit?.content).toContain('RESPOND: ""');
      expect(completionEdit?.content).toContain('VOICE:');
      expect(completionEdit?.content).toContain('FORMATS:');
      expect(completionEdit?.content).toContain('ACTIONS:');
      expect(completionEdit?.content).toContain(
        'STORE: {reservation_id} -> user.completed_reservations',
      );
    });
  });

  describe('serializeConversationBehaviorToABL', () => {
    it('serializes a populated conversation behavior block', () => {
      const edits = serializeConversationBehaviorToABL({
        speaking: {
          style: 'warm and concise',
          tone: 'reassuring',
          language_policy: 'interaction_context',
          max_sentences: 2,
          one_thing_at_a_time: true,
          tool_lead_in: 'brief',
          tool_results: {
            style: 'top_option_first',
            max_points: 2,
          },
        },
        listening: {
          barge_in: 'allow',
          on_pause: 'wait_briefly',
        },
        interaction: {
          answer_shape: 'answer_first',
          clarification: {
            mode: 'ask_only_when_blocked',
            max_questions: 1,
            assume_when_low_risk: true,
          },
          uncertainty: {
            mode: 'say_when_unsure',
            offer_next_step: true,
          },
        },
      });

      expect(edits).toEqual([
        {
          section: 'CONVERSATION',
          content: [
            'CONVERSATION:',
            '  speaking:',
            '    style: "warm and concise"',
            '    tone: reassuring',
            '    language_policy: interaction_context',
            '    max_sentences: 2',
            '    one_thing_at_a_time: true',
            '    tool_lead_in: brief',
            '    tool_results:',
            '      style: top_option_first',
            '      max_points: 2',
            '  listening:',
            '    barge_in: allow',
            '    on_pause: wait_briefly',
            '  interaction:',
            '    answer_shape: answer_first',
            '    clarification:',
            '      mode: ask_only_when_blocked',
            '      max_questions: 1',
            '      assume_when_low_risk: true',
            '    uncertainty:',
            '      mode: say_when_unsure',
            '      offer_next_step: true',
          ].join('\n'),
        },
      ]);
    });

    it('removes the section when empty', () => {
      expect(serializeConversationBehaviorToABL(undefined)).toEqual([
        { section: 'CONVERSATION', content: null },
      ]);

      expect(
        serializeConversationBehaviorToABL({
          speaking: { style: '' },
        }),
      ).toEqual([{ section: 'CONVERSATION', content: null }]);
    });
  });

  // ===========================================================================
  // ROUND-TRIP: serializer output must parse without errors
  // ===========================================================================
  // Guards against serializer/parser mismatches — if the serializer writes
  // DSL that the parser rejects, this test fails.

  describe('Serializer → Parser round-trip', () => {
    function wrapToolsInAgentDsl(toolsContent: string): string {
      return `AGENT: RoundTripAgent\nGOAL: "Round-trip test"\n\n${toolsContent}`;
    }

    it('HTTP tool with timeout hint round-trips without errors', () => {
      const edits = serializeToolsToABL([
        {
          name: 'get_weather',
          description: 'Get weather data',
          parameters: [{ name: 'city', type: 'string', required: true }],
          returns: { type: 'object' },
          toolType: 'http',
          hints: { timeout: 15000, side_effects: true, requires_auth: true },
        },
      ]);

      const dsl = wrapToolsInAgentDsl(edits[0].content!);
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(1);
      expect(result.document!.tools[0].hints?.timeout).toBe(15000);
    });

    it('MCP tool round-trips without errors', () => {
      const edits = serializeToolsToABL([
        {
          name: 'list_accounts',
          description: 'List billing accounts',
          parameters: [],
          returns: { type: 'object' },
          toolType: 'mcp',
          hints: {},
        },
      ]);

      const dsl = wrapToolsInAgentDsl(edits[0].content!);
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(1);
    });

    it('sandbox tool round-trips without errors', () => {
      const edits = serializeToolsToABL([
        {
          name: 'format_report',
          description: 'Format a report',
          parameters: [{ name: 'data', type: 'object', required: true }],
          returns: { type: 'string' },
          toolType: 'sandbox',
          hints: { cacheable: true, latency: 'slow' },
        },
      ]);

      const dsl = wrapToolsInAgentDsl(edits[0].content!);
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(1);
    });

    it('workflow tool round-trips without errors', () => {
      const edits = serializeToolsToABL([
        {
          name: 'run_approval',
          description: 'Run approval workflow',
          parameters: [{ name: 'request_id', type: 'string', required: true }],
          returns: { type: 'object' },
          toolType: 'workflow',
          workflowBinding: {
            workflowId: 'wf-123',
            triggerId: 'tr-456',
            mode: 'async',
            timeoutMs: 60000,
          },
          hints: {},
        },
      ]);

      const dsl = wrapToolsInAgentDsl(edits[0].content!);
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(1);
    });

    it('mixed tools with all hint types round-trip without errors', () => {
      const edits = serializeToolsToABL([
        {
          name: 'http_tool',
          description: 'HTTP tool',
          parameters: [{ name: 'q', type: 'string', required: true }],
          returns: { type: 'object' },
          toolType: 'http',
          hints: {
            timeout: 30000,
            cacheable: true,
            latency: 'slow',
            side_effects: true,
            requires_auth: true,
          },
        },
        {
          name: 'sandbox_tool',
          description: 'Sandbox tool',
          parameters: [],
          returns: { type: 'object' },
          toolType: 'sandbox',
          hints: { cacheable: true },
        },
        {
          name: 'plain_tool',
          description: 'No type tool',
          parameters: [{ name: 'x', type: 'string', required: false }],
          returns: { type: 'object' },
          hints: {},
        },
      ]);

      const dsl = wrapToolsInAgentDsl(edits[0].content!);
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(3);
    });

    it('tool with confirmation round-trips without errors', () => {
      const edits = serializeToolsToABL([
        {
          name: 'delete_record',
          description: 'Delete a record',
          parameters: [{ name: 'id', type: 'string', required: true }],
          returns: { type: 'object' },
          toolType: 'http',
          hints: { side_effects: true, timeout: 10000 },
          confirmation: { require: 'always', immutableParams: ['id'] },
        },
      ]);

      const dsl = wrapToolsInAgentDsl(edits[0].content!);
      const result = parseAgentBasedABL(dsl);
      expect(result.errors).toHaveLength(0);
      expect(result.document?.tools).toHaveLength(1);
      expect(result.document!.tools[0].hints?.timeout).toBe(10000);
    });
  });
});
