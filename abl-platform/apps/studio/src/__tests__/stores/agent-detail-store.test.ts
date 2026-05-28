import { describe, it, expect, beforeEach } from 'vitest';
import { useAgentDetailStore } from '../../store/agent-detail-store';

describe('agent-detail-store', () => {
  beforeEach(() => {
    useAgentDetailStore.getState().reset();
  });

  describe('section expand/collapse', () => {
    it('starts with all sections collapsed', () => {
      const state = useAgentDetailStore.getState();
      expect(state.expandedSection).toBeNull();
    });

    it('expands a section and collapses the previous one', () => {
      const { expandSection } = useAgentDetailStore.getState();
      expandSection('TOOLS');
      expect(useAgentDetailStore.getState().expandedSection).toBe('TOOLS');

      expandSection('GATHER');
      expect(useAgentDetailStore.getState().expandedSection).toBe('GATHER');
    });

    it('collapses when the same section is toggled', () => {
      const { expandSection, collapseSection } = useAgentDetailStore.getState();
      expandSection('TOOLS');
      collapseSection();
      expect(useAgentDetailStore.getState().expandedSection).toBeNull();
    });
  });

  describe('IR loading', () => {
    it('parses a minimal reasoning agent IR into section models', () => {
      const minimalIR = {
        ir_version: '1.0',
        metadata: { name: 'test_agent', type: 'agent' },
        execution: { mode: 'reasoning', model: 'claude-sonnet-4-6' },
        identity: {
          goal: 'Help users',
          persona: 'Helpful assistant',
          limitations: ['No financial advice'],
        },
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            parameters: [{ name: 'query', type: 'string', required: true }],
            returns: { type: 'string' },
            hints: { cacheable: false, latency: 'fast', side_effects: false },
          },
        ],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(minimalIR, 'agent-123');

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBe('agent-123');

      expect(state.sections.identity.goal).toBe('Help users');
      expect(state.sections.tools).toHaveLength(1);
      expect(state.sections.tools[0].name).toBe('search');
      expect(state.visibleSections).toContain('IDENTITY');
      expect(state.visibleSections).toContain('TOOLS');
      expect(state.visibleSections).not.toContain('FLOW');
    });

    it('shows FLOW section only for scripted agents', () => {
      const scriptedIR = {
        ir_version: '1.0',
        metadata: { name: 'scripted_agent', type: 'agent' },
        execution: { mode: 'scripted' },
        identity: { goal: 'Book hotels', persona: 'Booking agent', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
        flow: {
          steps: ['greet'],
          definitions: { greet: { name: 'greet', respond: 'Hello!' } },
          entry_point: 'greet',
        },
      };

      useAgentDetailStore.getState().loadFromIR(scriptedIR, 'agent-456');

      const state = useAgentDetailStore.getState();
      expect(state.visibleSections).toContain('FLOW');
      expect(state.sections.flow?.steps).toHaveLength(1);
    });

    it('shows all sections even when empty (except FLOW for reasoning agents)', () => {
      const emptyIR = {
        ir_version: '1.0',
        metadata: { name: 'empty_agent', type: 'agent' },
        execution: { mode: 'reasoning' },
        identity: { goal: 'Do nothing', persona: '', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(emptyIR, 'agent-789');

      const state = useAgentDetailStore.getState();
      expect(state.visibleSections).toContain('IDENTITY');
      expect(state.visibleSections).toContain('TOOLS');
      expect(state.visibleSections).toContain('GATHER');
      expect(state.visibleSections).toContain('RULES');
      expect(state.visibleSections).toContain('COORDINATION');
      expect(state.visibleSections).toContain('LIFECYCLE');
      // FLOW is NOT shown for reasoning agents
      expect(state.visibleSections).not.toContain('FLOW');
    });

    it('hydrates pii_type and advanced semantics into gather section state', () => {
      const irWithAdvancedGather = {
        ir_version: '1.0',
        metadata: { name: 'gather_agent', type: 'agent' },
        execution: { mode: 'reasoning' },
        identity: { goal: 'Collect contact data', persona: '', limitations: [] },
        tools: [],
        gather: {
          fields: [
            {
              name: 'contact_info',
              prompt: 'How should we reach you?',
              type: 'string',
              required: true,
              pii_type: 'email',
              semantics: {
                lookup: 'contact_methods',
                format: 'email',
                locale: 'en-US',
                kore_entity_type: 'EMAIL',
              },
            },
            {
              name: 'priority',
              prompt: 'Priority?',
              type: 'enum',
              required: true,
              enum_values: ['low', 'medium', 'high'],
              semantics: {
                enum_set: ['low', 'medium', 'high'],
              },
            },
          ],
          strategy: 'llm',
        },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(irWithAdvancedGather, 'agent-advanced');

      const state = useAgentDetailStore.getState();
      expect(state.sections.gather).toHaveLength(2);
      expect(state.sections.gather[0].piiType).toBe('email');
      expect(state.sections.gather[0].lookupTable).toBe('contact_methods');
      expect(state.sections.gather[0].semantics).toEqual({
        lookup: 'contact_methods',
        format: 'email',
        locale: 'en-US',
        kore_entity_type: 'EMAIL',
      });
      expect(state.sections.gather[1].options).toEqual(['low', 'medium', 'high']);
      expect(state.sections.gather[1].semantics?.enum_set).toEqual(['low', 'medium', 'high']);
    });
  });

  describe('updateSection', () => {
    it('updates a section and recomputes visibleSections', () => {
      const emptyIR = {
        ir_version: '1.0',
        metadata: { name: 'test', type: 'agent' },
        execution: { mode: 'reasoning' },
        identity: { goal: '', persona: '', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(emptyIR, 'a1');

      // Update identity section
      useAgentDetailStore.getState().updateSection('identity', {
        mode: 'reasoning',
        goal: 'New goal',
        persona: 'New persona',
        limitations: ['Limit 1'],
      });

      const state = useAgentDetailStore.getState();
      expect(state.sections.identity.goal).toBe('New goal');
      expect(state.sections.identity.persona).toBe('New persona');
      expect(state.sections.identity.limitations).toEqual(['Limit 1']);
    });

    it('adding flow data makes FLOW visible in sections', () => {
      const emptyIR = {
        ir_version: '1.0',
        metadata: { name: 'test', type: 'agent' },
        execution: { mode: 'reasoning' },
        identity: { goal: '', persona: '', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(emptyIR, 'a1');
      expect(useAgentDetailStore.getState().visibleSections).not.toContain('FLOW');

      // Add flow definitions
      useAgentDetailStore.getState().updateSection('flow', {
        steps: [{ name: 'greet', hasGather: false, hasBranching: false, reasoning: false }],
        entryPoint: 'greet',
      });

      expect(useAgentDetailStore.getState().visibleSections).toContain('FLOW');
    });

    it('updates tools section', () => {
      const emptyIR = {
        ir_version: '1.0',
        metadata: { name: 'test', type: 'agent' },
        execution: { mode: 'reasoning' },
        identity: { goal: '', persona: '', limitations: [] },
        tools: [],
        gather: { fields: [], strategy: 'llm' },
        memory: { session: [], persistent: [], remember: [], recall: [] },
        constraints: { constraints: [], guardrails: [] },
        coordination: { delegates: [], handoffs: [] },
        completion: { conditions: [] },
        error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
      };

      useAgentDetailStore.getState().loadFromIR(emptyIR, 'a1');

      useAgentDetailStore.getState().updateSection('tools', [
        {
          name: 'new_tool',
          description: 'A new tool',
          parameters: [],
          returns: { type: 'string' },
          hints: {},
        },
      ]);

      const state = useAgentDetailStore.getState();
      expect(state.sections.tools).toHaveLength(1);
      expect(state.sections.tools[0].name).toBe('new_tool');
    });
  });

  describe('save state', () => {
    it('tracks saving and saved state', () => {
      const store = useAgentDetailStore.getState();
      expect(store.saveStatus).toBe('idle');

      useAgentDetailStore.getState().setSaveStatus('saving');
      expect(useAgentDetailStore.getState().saveStatus).toBe('saving');

      useAgentDetailStore.getState().setSaveStatus('saved');
      expect(useAgentDetailStore.getState().saveStatus).toBe('saved');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      useAgentDetailStore.getState().loadFromIR(
        {
          ir_version: '1.0',
          metadata: { name: 'x', type: 'agent' },
          execution: { mode: 'reasoning' },
          identity: { goal: 'G', persona: 'P', limitations: [] },
          tools: [
            { name: 't', description: 'd', parameters: [], returns: { type: 'string' }, hints: {} },
          ],
          gather: { fields: [], strategy: 'llm' },
          memory: { session: [], persistent: [], remember: [], recall: [] },
          constraints: { constraints: [], guardrails: [] },
          coordination: { delegates: [], handoffs: [] },
          completion: { conditions: [] },
          error_handling: { handlers: [], default_handler: { type: 'default', then: 'continue' } },
        },
        'a1',
      );

      useAgentDetailStore.getState().reset();

      const state = useAgentDetailStore.getState();
      expect(state.agentId).toBeNull();
      expect(state.sections.identity.goal).toBe('');
      expect(state.sections.tools).toHaveLength(0);
      expect(state.expandedSection).toBeNull();
    });
  });
});
