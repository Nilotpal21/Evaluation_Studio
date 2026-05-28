/**
 * Agent Editor Store Tests
 *
 * Comprehensive tests for the unified agent editor Zustand store:
 * loadAgent, updateSection, setActiveSection, setSaveStatus,
 * markSectionClean, markAllClean, setMenuCollapsed, updateDsl,
 * reset, deriveVisibleSections, and sectionModelsToEditorSections.
 *
 * Pure store tests — no DOM needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAgentEditorStore,
  deriveVisibleSections,
  sectionModelsToEditorSections,
  selectSectionData,
  selectIsSectionDirty,
  selectHasDirtyChanges,
  selectIsActiveSection,
} from '../../components/agent-editor/hooks/useAgentEditorStore';
import { parseIRToSections } from '../../store/agent-detail-store';
import type { EditorSection, SectionDataMap } from '../../components/agent-editor/types';

// =============================================================================
// HELPERS
// =============================================================================

/** Minimal valid IR that exercises all parseIRToSections branches */
function makeMinimalIR(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ir_version: '1.0',
    metadata: { name: 'test_agent', type: 'agent' },
    execution: { mode: 'reasoning', model: 'claude-sonnet-4-6' },
    identity: {
      goal: 'Help users with tasks',
      persona: 'Helpful assistant',
      limitations: ['No financial advice', 'No medical advice'],
    },
    tools: [
      {
        name: 'search',
        description: 'Search the web',
        parameters: [{ name: 'query', type: 'string', required: true }],
        returns: { type: 'string' },
        hints: { cacheable: false },
      },
    ],
    gather: {
      fields: [
        {
          name: 'user_name',
          prompt: 'What is your name?',
          type: 'string',
          required: true,
        },
      ],
      strategy: 'llm',
    },
    memory: {
      session: [{ name: 'ctx', type: 'string', description: 'Context var' }],
      persistent: [{ path: '/user/prefs' }],
      remember: [{ when: 'user says remember', store: { value: '$input', target: 'notes' } }],
      recall: [{ event: 'session_start', instruction: 'Load user preferences' }],
    },
    constraints: {
      constraints: [
        { condition: 'input.length < 10000', on_fail: { type: 'respond', message: 'Too long' } },
      ],
      guardrails: [
        {
          name: 'pii_check',
          description: 'Check for PII',
          check: 'no_pii',
          action: { type: 'block', message: 'PII detected' },
        },
      ],
    },
    coordination: {
      delegates: [{ agent: 'helper', when: 'complex_task', purpose: 'Handle complex tasks' }],
      handoffs: [
        {
          to: 'specialist',
          when: 'needs_expert',
          context: { summary: 'Escalating' },
          return: true,
        },
      ],
      escalation: {
        triggers: [
          {
            when: 'user_angry',
            reason: 'Customer frustrated',
            priority: 'high',
            tags: ['urgent'],
          },
        ],
        context_for_human: ['conversation_summary', 'user_sentiment'],
        on_human_complete: [{ condition: 'resolved', action: 'close_ticket' }],
      },
    },
    behavior_profiles: [
      {
        name: 'formal',
        when: 'business_context',
        priority: 10,
        instructions: 'Use formal language',
        tools_hide: ['casual_tool'],
        tools_add: ['formal_tool'],
      },
    ],
    conversation_behavior: {
      speaking: {
        style: 'warm and concise',
        tool_lead_in: 'brief',
      },
      interaction: {
        answer_shape: 'answer_first',
      },
    },
    on_start: {
      respond: 'Welcome!',
      call: 'init_tool',
      calls: [{ tool: 'setup', args: { mode: 'fast' } }],
      set: [{ variable: 'initialized', value: 'true' }],
    },
    hooks: { before_agent: true, after_turn: true },
    error_handling: {
      handlers: [{ type: 'timeout', respond: 'Request timed out', then: 'retry' }],
      default_handler: { type: 'default', then: 'continue' },
    },
    completion: {
      conditions: [{ when: 'task_complete', respond: 'Task done!' }],
    },
    templates: [
      {
        name: 'greeting',
        formats: {
          default: 'Hello {{name}}',
          markdown: '# Hello {{name}}',
          html: '<h1>Hello {{name}}</h1>',
          voice_instructions: 'Say hello warmly',
        },
      },
    ],
    ...overrides,
  };
}

/** Empty IR with no tools, no gather, etc. */
function makeEmptyIR(): Record<string, unknown> {
  return {
    ir_version: '1.0',
    metadata: { name: 'empty_agent', type: 'agent' },
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
}

/** Build a minimal SectionDataMap for testing pure functions */
function makeSectionDataMap(overrides: Partial<SectionDataMap> = {}): SectionDataMap {
  return {
    identity: { goal: '', persona: '', limitations: [], mode: 'reasoning' },
    execution: {},
    tools: [],
    gather: [],
    memory: {
      sessionVars: [],
      persistentPaths: [],
      rememberTriggers: [],
      recallInstructions: [],
    },
    flow: null,
    constraints: [],
    guardrails: [],
    behavior: { conversationBehavior: undefined, profiles: [] },
    handoffs: [],
    delegates: [],
    escalation: { triggers: [], contextForHuman: [], onHumanComplete: [] },
    onStart: { calls: [], sets: [], hooks: [], hasOnStart: false },
    errorHandling: [],
    completion: [],
    templates: [],
    definition: '',
    ...overrides,
  };
}

const SAMPLE_DSL = 'AGENT test_agent\nGOAL Help users with tasks';

// =============================================================================
// TESTS
// =============================================================================

describe('Agent Editor Store', () => {
  beforeEach(() => {
    useAgentEditorStore.getState().reset();
  });

  // ---------------------------------------------------------------------------
  // loadAgent
  // ---------------------------------------------------------------------------
  describe('loadAgent', () => {
    it('loads agent with IR and DSL, populates all 17 sections', () => {
      const ir = makeMinimalIR();
      useAgentEditorStore.getState().loadAgent('test_agent', 'proj-1', ir, SAMPLE_DSL);

      const state = useAgentEditorStore.getState();

      // All 17 section keys should be present
      const expectedKeys: EditorSection[] = [
        'identity',
        'execution',
        'tools',
        'gather',
        'memory',
        'flow',
        'constraints',
        'guardrails',
        'behavior',
        'handoffs',
        'delegates',
        'escalation',
        'onStart',
        'errorHandling',
        'completion',
        'templates',
        'definition',
      ];
      for (const key of expectedKeys) {
        expect(state.sections).toHaveProperty(key);
      }

      // Verify identity section parsed correctly
      expect(state.sections.identity.goal).toBe('Help users with tasks');
      expect(state.sections.identity.persona).toBe('Helpful assistant');
      expect(state.sections.identity.limitations).toEqual([
        'No financial advice',
        'No medical advice',
      ]);

      // Verify tools parsed
      expect(state.sections.tools).toHaveLength(1);
      expect(state.sections.tools[0].name).toBe('search');

      // Verify gather parsed
      expect(state.sections.gather).toHaveLength(1);
      expect(state.sections.gather[0].name).toBe('user_name');

      // Verify constraints/guardrails parsed
      expect(state.sections.constraints).toHaveLength(1);
      expect(state.sections.guardrails).toHaveLength(1);

      // Verify coordination parsed
      expect(state.sections.handoffs).toHaveLength(1);
      expect(state.sections.delegates).toHaveLength(1);

      // Verify definition is the DSL
      expect(state.sections.definition).toBe(SAMPLE_DSL);
    });

    it('sets agentName, projectId, rawDsl', () => {
      const ir = makeMinimalIR();
      useAgentEditorStore.getState().loadAgent('my-agent', 'proj-42', ir, 'AGENT my-agent');

      const state = useAgentEditorStore.getState();
      expect(state.agentName).toBe('my-agent');
      expect(state.projectId).toBe('proj-42');
      expect(state.rawDsl).toBe('AGENT my-agent');
    });

    it('preserves structured ON_ERROR and COMPLETE lifecycle metadata in editor sections', () => {
      const ir = makeMinimalIR({
        error_handling: {
          handlers: [
            {
              type: 'tool_timeout',
              subtypes: ['transient'],
              respond: 'Retrying',
              then: 'handoff',
              handoff_target: 'human_support',
              retry: 2,
              retry_delay_ms: 2500,
              retry_backoff: 'exponential',
              retry_max_delay_ms: 10000,
              voice_config: {
                plain_text: 'Retrying',
              },
              rich_content: {
                markdown: '### Retrying',
              },
              actions: {
                elements: [{ id: 'retry', type: 'button', label: 'Retry now' }],
              },
            },
          ],
          default_handler: { type: 'default', then: 'continue' },
        },
        completion: {
          conditions: [
            {
              when: 'task_complete',
              respond: 'Task done!',
              voice_config: {
                plain_text: 'Task done!',
              },
              rich_content: {
                markdown: '### Task done!',
              },
              actions: {
                elements: [{ id: 'done', type: 'button', label: 'Done' }],
              },
              store: '{task_complete} -> user.last_completion',
            },
          ],
        },
      });

      useAgentEditorStore.getState().loadAgent('structured-agent', 'proj-7', ir, SAMPLE_DSL);

      const state = useAgentEditorStore.getState();
      expect(state.sections.errorHandling).toEqual([
        {
          type: 'tool_timeout',
          subtypes: ['transient'],
          respond: 'Retrying',
          then: 'handoff',
          handoffTarget: 'human_support',
          retry: 2,
          retryDelayMs: 2500,
          retryBackoff: 'exponential',
          retryMaxDelayMs: 10000,
          voiceConfig: {
            plain_text: 'Retrying',
          },
          richContent: {
            markdown: '### Retrying',
          },
          actions: {
            elements: [{ id: 'retry', type: 'button', label: 'Retry now' }],
          },
        },
        {
          type: 'default',
          then: 'continue',
        },
      ]);
      expect(state.sections.completion).toEqual([
        {
          when: 'task_complete',
          respond: 'Task done!',
          voiceConfig: {
            plain_text: 'Task done!',
          },
          richContent: {
            markdown: '### Task done!',
          },
          actions: {
            elements: [{ id: 'done', type: 'button', label: 'Done' }],
          },
          store: '{task_complete} -> user.last_completion',
        },
      ]);
    });

    it('resets dirtySections to empty', () => {
      // First, make some sections dirty
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'changed',
        persona: '',
        limitations: [],
        mode: 'reasoning',
      });
      expect(useAgentEditorStore.getState().dirtySections.size).toBeGreaterThan(0);

      // Reload agent — dirty sections should be cleared
      useAgentEditorStore.getState().loadAgent('b', 'p2', makeEmptyIR(), '');

      expect(useAgentEditorStore.getState().dirtySections.size).toBe(0);
    });

    it('resets saveStatus to idle', () => {
      useAgentEditorStore.getState().setSaveStatus('saving');
      expect(useAgentEditorStore.getState().saveStatus).toBe('saving');

      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');

      expect(useAgentEditorStore.getState().saveStatus).toBe('idle');
    });

    it('computes visibleSections (excludes hidden sections)', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeMinimalIR(), SAMPLE_DSL);

      const { visibleSections } = useAgentEditorStore.getState();

      // Hidden sections should NOT appear
      const hiddenSections: EditorSection[] = ['memory', 'escalation', 'templates'];
      for (const hidden of hiddenSections) {
        expect(visibleSections).not.toContain(hidden);
      }

      // Visible sections should include these
      expect(visibleSections).toContain('identity');
      expect(visibleSections).toContain('execution');
      expect(visibleSections).toContain('tools');
      expect(visibleSections).toContain('behavior');
      expect(visibleSections).toContain('definition');
      expect(visibleSections).toContain('constraints');
      expect(visibleSections).toContain('guardrails');
    });

    it('preserves activeSection when reloading the same agent', () => {
      useAgentEditorStore.getState().setActiveSection('tools');
      expect(useAgentEditorStore.getState().activeSection).toBe('tools');

      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      useAgentEditorStore.getState().setActiveSection('tools');
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');

      expect(useAgentEditorStore.getState().activeSection).toBe('tools');
    });

    it('resets activeSection to identity when loading a different agent', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      useAgentEditorStore.getState().setActiveSection('tools');

      useAgentEditorStore.getState().loadAgent('b', 'p', makeEmptyIR(), '');

      expect(useAgentEditorStore.getState().activeSection).toBe('identity');
    });

    it('clears compileErrors on load', () => {
      useAgentEditorStore.getState().setCompileErrors(['some error']);
      expect(useAgentEditorStore.getState().compileErrors).toHaveLength(1);

      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');

      expect(useAgentEditorStore.getState().compileErrors).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateSection
  // ---------------------------------------------------------------------------
  describe('updateSection', () => {
    beforeEach(() => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
    });

    it("updates a section's data", () => {
      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'New goal',
        persona: 'New persona',
        limitations: ['Limit A'],
        mode: 'reasoning',
      });

      const state = useAgentEditorStore.getState();
      expect(state.sections.identity.goal).toBe('New goal');
      expect(state.sections.identity.persona).toBe('New persona');
      expect(state.sections.identity.limitations).toEqual(['Limit A']);
    });

    it('marks section as dirty', () => {
      expect(useAgentEditorStore.getState().dirtySections.has('identity')).toBe(false);

      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'Changed',
        persona: '',
        limitations: [],
        mode: 'reasoning',
      });

      expect(useAgentEditorStore.getState().dirtySections.has('identity')).toBe(true);
    });

    it('recomputes visibleSections', () => {
      const before = useAgentEditorStore.getState().visibleSections;

      useAgentEditorStore.getState().updateSection('tools', [
        {
          name: 'new_tool',
          description: 'A tool',
          parameters: [],
          returns: { type: 'string' },
          hints: {},
        },
      ]);

      const after = useAgentEditorStore.getState().visibleSections;
      // visibleSections is recomputed (may or may not change depending on hidden rules,
      // but it should still be a valid array)
      expect(Array.isArray(after)).toBe(true);
      // Should still contain the same set of visible sections since hidden set is fixed
      expect(after).toEqual(before);
    });

    it('multiple sections can be dirty simultaneously', () => {
      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'G',
        persona: 'P',
        limitations: [],
        mode: 'reasoning',
      });
      useAgentEditorStore.getState().updateSection('tools', [
        {
          name: 'tool1',
          description: 'Desc',
          parameters: [],
          returns: { type: 'string' },
          hints: {},
        },
      ]);
      useAgentEditorStore
        .getState()
        .updateSection('constraints', [
          { condition: 'x', onFail: { type: 'respond', message: 'fail' } },
        ]);

      const { dirtySections } = useAgentEditorStore.getState();
      expect(dirtySections.has('identity')).toBe(true);
      expect(dirtySections.has('tools')).toBe(true);
      expect(dirtySections.has('constraints')).toBe(true);
      expect(dirtySections.size).toBe(3);
    });

    it('updates definition section', () => {
      useAgentEditorStore.getState().updateSection('definition', 'AGENT new_dsl');

      expect(useAgentEditorStore.getState().sections.definition).toBe('AGENT new_dsl');
      expect(useAgentEditorStore.getState().dirtySections.has('definition')).toBe(true);
    });

    it('updates escalation section', () => {
      useAgentEditorStore.getState().updateSection('escalation', {
        triggers: [{ when: 'angry', reason: 'frustrated', priority: 'high' }],
        contextForHuman: ['summary'],
        onHumanComplete: [{ condition: 'resolved', action: 'close' }],
      });

      const { escalation } = useAgentEditorStore.getState().sections;
      expect(escalation.triggers).toHaveLength(1);
      expect(escalation.triggers[0].when).toBe('angry');
    });
  });

  // ---------------------------------------------------------------------------
  // setActiveSection
  // ---------------------------------------------------------------------------
  describe('setActiveSection', () => {
    it('changes active section', () => {
      expect(useAgentEditorStore.getState().activeSection).toBe('identity');

      useAgentEditorStore.getState().setActiveSection('tools');
      expect(useAgentEditorStore.getState().activeSection).toBe('tools');

      useAgentEditorStore.getState().setActiveSection('definition');
      expect(useAgentEditorStore.getState().activeSection).toBe('definition');
    });

    it('can be set to any valid EditorSection', () => {
      const sections: EditorSection[] = [
        'identity',
        'execution',
        'tools',
        'gather',
        'memory',
        'flow',
        'constraints',
        'guardrails',
        'behavior',
        'handoffs',
        'delegates',
        'escalation',
        'onStart',
        'errorHandling',
        'completion',
        'templates',
        'definition',
      ];

      for (const section of sections) {
        useAgentEditorStore.getState().setActiveSection(section);
        expect(useAgentEditorStore.getState().activeSection).toBe(section);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // setSaveStatus
  // ---------------------------------------------------------------------------
  describe('setSaveStatus', () => {
    it('sets saving state', () => {
      useAgentEditorStore.getState().setSaveStatus('saving');

      const state = useAgentEditorStore.getState();
      expect(state.saveStatus).toBe('saving');
      expect(state.saveError).toBeNull();
    });

    it('sets saved state', () => {
      useAgentEditorStore.getState().setSaveStatus('saved');

      expect(useAgentEditorStore.getState().saveStatus).toBe('saved');
      expect(useAgentEditorStore.getState().saveError).toBeNull();
    });

    it('sets error state with error message', () => {
      useAgentEditorStore.getState().setSaveStatus('error', 'Permission denied');

      const state = useAgentEditorStore.getState();
      expect(state.saveStatus).toBe('error');
      expect(state.saveError).toBe('Permission denied');
    });

    it('clears error when transitioning to non-error status', () => {
      useAgentEditorStore.getState().setSaveStatus('error', 'Something failed');
      expect(useAgentEditorStore.getState().saveError).toBe('Something failed');

      useAgentEditorStore.getState().setSaveStatus('idle');
      expect(useAgentEditorStore.getState().saveError).toBeNull();
    });

    it('sets idle state', () => {
      useAgentEditorStore.getState().setSaveStatus('saving');
      useAgentEditorStore.getState().setSaveStatus('idle');

      expect(useAgentEditorStore.getState().saveStatus).toBe('idle');
    });
  });

  // ---------------------------------------------------------------------------
  // markSectionClean / markAllClean
  // ---------------------------------------------------------------------------
  describe('markSectionClean / markAllClean', () => {
    beforeEach(() => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      // Make several sections dirty
      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'G',
        persona: 'P',
        limitations: [],
        mode: 'reasoning',
      });
      useAgentEditorStore.getState().updateSection('tools', [
        {
          name: 't',
          description: 'd',
          parameters: [],
          returns: { type: 'string' },
          hints: {},
        },
      ]);
      useAgentEditorStore
        .getState()
        .updateSection('constraints', [{ condition: 'c', onFail: { type: 'respond' } }]);
    });

    it('markSectionClean removes one section from dirtySections', () => {
      expect(useAgentEditorStore.getState().dirtySections.has('identity')).toBe(true);
      expect(useAgentEditorStore.getState().dirtySections.size).toBe(3);

      useAgentEditorStore.getState().markSectionClean('identity');

      expect(useAgentEditorStore.getState().dirtySections.has('identity')).toBe(false);
      expect(useAgentEditorStore.getState().dirtySections.has('tools')).toBe(true);
      expect(useAgentEditorStore.getState().dirtySections.has('constraints')).toBe(true);
      expect(useAgentEditorStore.getState().dirtySections.size).toBe(2);
    });

    it('markSectionClean is a no-op for already-clean sections', () => {
      useAgentEditorStore.getState().markSectionClean('definition');

      // Should not throw or change anything
      expect(useAgentEditorStore.getState().dirtySections.size).toBe(3);
    });

    it('markAllClean clears all dirty sections', () => {
      expect(useAgentEditorStore.getState().dirtySections.size).toBe(3);

      useAgentEditorStore.getState().markAllClean();

      expect(useAgentEditorStore.getState().dirtySections.size).toBe(0);
    });

    it('markAllClean is idempotent', () => {
      useAgentEditorStore.getState().markAllClean();
      useAgentEditorStore.getState().markAllClean();

      expect(useAgentEditorStore.getState().dirtySections.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // setMenuCollapsed
  // ---------------------------------------------------------------------------
  describe('setMenuCollapsed', () => {
    it('toggles menu collapsed state to true', () => {
      expect(useAgentEditorStore.getState().menuCollapsed).toBe(false);

      useAgentEditorStore.getState().setMenuCollapsed(true);

      expect(useAgentEditorStore.getState().menuCollapsed).toBe(true);
    });

    it('toggles menu collapsed state to false', () => {
      useAgentEditorStore.getState().setMenuCollapsed(true);
      useAgentEditorStore.getState().setMenuCollapsed(false);

      expect(useAgentEditorStore.getState().menuCollapsed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // updateDsl
  // ---------------------------------------------------------------------------
  describe('updateDsl', () => {
    it('updates rawDsl and sections.definition', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), 'original');

      useAgentEditorStore.getState().updateDsl('AGENT updated\nGOAL New goal');

      const state = useAgentEditorStore.getState();
      expect(state.rawDsl).toBe('AGENT updated\nGOAL New goal');
      expect(state.sections.definition).toBe('AGENT updated\nGOAL New goal');
    });

    it('does not affect other sections', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeMinimalIR(), SAMPLE_DSL);
      const toolsBefore = useAgentEditorStore.getState().sections.tools;

      useAgentEditorStore.getState().updateDsl('AGENT changed');

      expect(useAgentEditorStore.getState().sections.tools).toEqual(toolsBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // reset
  // ---------------------------------------------------------------------------
  describe('reset', () => {
    it('clears all state back to initial', () => {
      // Load an agent and make changes
      useAgentEditorStore.getState().loadAgent('agent-x', 'proj-1', makeMinimalIR(), SAMPLE_DSL);
      useAgentEditorStore.getState().setActiveSection('tools');
      useAgentEditorStore.getState().setSaveStatus('error', 'Something broke');
      useAgentEditorStore.getState().setMenuCollapsed(true);
      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'dirty',
        persona: 'dirty',
        limitations: [],
        mode: 'reasoning',
      });

      useAgentEditorStore.getState().reset();

      const state = useAgentEditorStore.getState();
      expect(state.agentName).toBeNull();
      expect(state.projectId).toBeNull();
      expect(state.rawDsl).toBe('');
      expect(state.activeSection).toBe('identity');
      expect(state.saveStatus).toBe('idle');
      expect(state.saveError).toBeNull();
      expect(state.menuCollapsed).toBe(false);
      expect(state.compileErrors).toEqual([]);
    });

    it('resets sections to empty defaults', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeMinimalIR(), SAMPLE_DSL);
      expect(useAgentEditorStore.getState().sections.tools.length).toBeGreaterThan(0);

      useAgentEditorStore.getState().reset();

      const { sections } = useAgentEditorStore.getState();
      expect(sections.identity.goal).toBe('');
      expect(sections.identity.persona).toBe('');
      expect(sections.identity.limitations).toEqual([]);
      expect(sections.execution).toEqual({});
      expect(sections.tools).toEqual([]);
      expect(sections.gather).toEqual([]);
      expect(sections.flow).toBeNull();
      expect(sections.constraints).toEqual([]);
      expect(sections.guardrails).toEqual([]);
      expect(sections.behavior).toEqual({ conversationBehavior: undefined, profiles: [] });
      expect(sections.handoffs).toEqual([]);
      expect(sections.delegates).toEqual([]);
      expect(sections.escalation).toEqual({
        triggers: [],
        contextForHuman: [],
        onHumanComplete: [],
      });
      expect(sections.onStart).toEqual({
        calls: [],
        sets: [],
        hooks: [],
        hasOnStart: false,
      });
      expect(sections.errorHandling).toEqual([]);
      expect(sections.completion).toEqual([]);
      expect(sections.templates).toEqual([]);
      expect(sections.definition).toBe('');
    });

    it('clears dirty sections', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'dirty',
        persona: '',
        limitations: [],
        mode: 'reasoning',
      });
      expect(useAgentEditorStore.getState().dirtySections.size).toBeGreaterThan(0);

      useAgentEditorStore.getState().reset();

      expect(useAgentEditorStore.getState().dirtySections.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // setCompileErrors
  // ---------------------------------------------------------------------------
  describe('setCompileErrors', () => {
    it('sets compile errors', () => {
      useAgentEditorStore.getState().setCompileErrors(['Error 1', 'Error 2']);

      expect(useAgentEditorStore.getState().compileErrors).toEqual(['Error 1', 'Error 2']);
    });

    it('clears compile errors with empty array', () => {
      useAgentEditorStore.getState().setCompileErrors(['error']);
      useAgentEditorStore.getState().setCompileErrors([]);

      expect(useAgentEditorStore.getState().compileErrors).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Selectors
  // ---------------------------------------------------------------------------
  describe('selectors', () => {
    it('selectSectionData returns typed section data', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeMinimalIR(), SAMPLE_DSL);

      const state = useAgentEditorStore.getState();
      const identity = selectSectionData('identity')(state);
      expect(identity.goal).toBe('Help users with tasks');

      const tools = selectSectionData('tools')(state);
      expect(tools).toHaveLength(1);
    });

    it('selectIsSectionDirty returns correct dirty status', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      expect(selectIsSectionDirty('identity')(useAgentEditorStore.getState())).toBe(false);

      useAgentEditorStore.getState().updateSection('identity', {
        goal: 'dirty',
        persona: '',
        limitations: [],
        mode: 'reasoning',
      });
      expect(selectIsSectionDirty('identity')(useAgentEditorStore.getState())).toBe(true);
    });

    it('selectHasDirtyChanges reflects overall dirty status', () => {
      useAgentEditorStore.getState().loadAgent('a', 'p', makeEmptyIR(), '');
      expect(selectHasDirtyChanges(useAgentEditorStore.getState())).toBe(false);

      useAgentEditorStore.getState().updateSection('tools', [
        {
          name: 't',
          description: 'd',
          parameters: [],
          returns: { type: 'string' },
          hints: {},
        },
      ]);
      expect(selectHasDirtyChanges(useAgentEditorStore.getState())).toBe(true);

      useAgentEditorStore.getState().markAllClean();
      expect(selectHasDirtyChanges(useAgentEditorStore.getState())).toBe(false);
    });

    it('selectIsActiveSection returns correct active status', () => {
      useAgentEditorStore.getState().setActiveSection('tools');

      expect(selectIsActiveSection('tools')(useAgentEditorStore.getState())).toBe(true);
      expect(selectIsActiveSection('identity')(useAgentEditorStore.getState())).toBe(false);
    });
  });
});

// =============================================================================
// PURE FUNCTION TESTS — deriveVisibleSections
// =============================================================================

describe('deriveVisibleSections', () => {
  it('returns ordered sections excluding HIDDEN_UNTIL_SERIALIZER set', () => {
    const data = makeSectionDataMap();
    const visible = deriveVisibleSections(data);

    // Hidden sections must NOT appear
    expect(visible).not.toContain('memory');
    expect(visible).not.toContain('escalation');
    expect(visible).not.toContain('templates');
    expect(visible).toContain('behavior');
  });

  it('always includes definition section', () => {
    const data = makeSectionDataMap();
    const visible = deriveVisibleSections(data);

    expect(visible).toContain('definition');
  });

  it('includes identity, execution, tools, gather, flow, constraints, guardrails', () => {
    const data = makeSectionDataMap();
    const visible = deriveVisibleSections(data);

    expect(visible).toContain('identity');
    expect(visible).toContain('execution');
    expect(visible).toContain('tools');
    expect(visible).toContain('gather');
    expect(visible).toContain('flow');
    expect(visible).toContain('constraints');
    expect(visible).toContain('guardrails');
  });

  it('includes handoffs, delegates, onStart, errorHandling, completion', () => {
    const data = makeSectionDataMap();
    const visible = deriveVisibleSections(data);

    expect(visible).toContain('handoffs');
    expect(visible).toContain('delegates');
    expect(visible).toContain('onStart');
    expect(visible).toContain('errorHandling');
    expect(visible).toContain('completion');
  });

  it('returns exactly 14 sections (17 minus 3 hidden)', () => {
    const data = makeSectionDataMap();
    const visible = deriveVisibleSections(data);

    // 17 total - 3 hidden (memory, escalation, templates) = 14
    expect(visible).toHaveLength(14);
  });

  it('preserves SECTION_ORDER ordering', () => {
    const data = makeSectionDataMap();
    const visible = deriveVisibleSections(data);

    // The expected order (from SECTION_ORDER, minus hidden)
    const expectedOrder: EditorSection[] = [
      'identity',
      'execution',
      'tools',
      'gather',
      'flow',
      'constraints',
      'guardrails',
      'behavior',
      'handoffs',
      'delegates',
      'onStart',
      'errorHandling',
      'completion',
      'definition',
    ];

    expect(visible).toEqual(expectedOrder);
  });
});

// =============================================================================
// PURE FUNCTION TESTS — sectionModelsToEditorSections
// =============================================================================

describe('sectionModelsToEditorSections', () => {
  it('splits identity into identity + execution', () => {
    const ir = makeMinimalIR();
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, SAMPLE_DSL);

    // Identity should have goal, persona, limitations, mode — no model/temperature
    expect(sections.identity.goal).toBe('Help users with tasks');
    expect(sections.identity.persona).toBe('Helpful assistant');
    expect(sections.identity).not.toHaveProperty('model');
    expect(sections.identity).not.toHaveProperty('temperature');

    // Execution should have model from IR
    expect(sections.execution.model).toBe('claude-sonnet-4-6');
  });

  it('splits lifecycle into onStart, errorHandling, completion, memory, templates', () => {
    const ir = makeMinimalIR();
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, SAMPLE_DSL);

    // onStart should have parsed calls, sets, hooks
    expect(sections.onStart.hasOnStart).toBe(true);
    expect(sections.onStart.respond).toBe('Welcome!');
    // call + calls array: init_tool + setup = 2 calls
    expect(sections.onStart.calls.length).toBeGreaterThanOrEqual(2);
    expect(sections.onStart.sets).toHaveLength(1);
    expect(sections.onStart.sets[0].variable).toBe('initialized');
    expect(sections.onStart.hooks).toContain('before_agent');
    expect(sections.onStart.hooks).toContain('after_turn');

    // errorHandling
    expect(sections.errorHandling).toHaveLength(2);
    expect(sections.errorHandling[0].type).toBe('timeout');
    expect(sections.errorHandling[1].type).toBe('default');

    // completion
    expect(sections.completion).toHaveLength(1);
    expect(sections.completion[0].when).toBe('task_complete');

    // memory
    expect(sections.memory.sessionVars).toHaveLength(1);
    expect(sections.memory.sessionVars[0].name).toBe('ctx');
    expect(sections.memory.persistentPaths).toHaveLength(1);
    expect(sections.memory.rememberTriggers).toHaveLength(1);
    expect(sections.memory.recallInstructions).toHaveLength(1);

    // templates
    expect(sections.templates).toHaveLength(1);
    expect(sections.templates[0].name).toBe('greeting');
    expect(sections.templates[0].formats.default).toBe('Hello {{name}}');
    expect(sections.templates[0].formats.markdown).toBe('# Hello {{name}}');
    expect(sections.templates[0].formats.html).toBe('<h1>Hello {{name}}</h1>');
    expect(sections.templates[0].formats.voiceInstructions).toBe('Say hello warmly');
  });

  it('preserves canonical flow call_spec metadata for supported visual round-trips', () => {
    const ir = makeMinimalIR({
      flow: {
        entry_point: 'lookup_customer',
        steps: ['lookup_customer'],
        definitions: {
          lookup_customer: {
            name: 'lookup_customer',
            call_spec: {
              tool: 'lookup_customer',
              with: {
                email: 'customer_email',
              },
              as: 'customer_record',
            },
            then: 'COMPLETE',
          },
        },
      },
    });
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, SAMPLE_DSL);

    expect(sections.flow?.steps[0]).toMatchObject({
      call: 'lookup_customer',
      callSpec: {
        tool: 'lookup_customer',
        with: {
          email: 'customer_email',
        },
        as: 'customer_record',
      },
    });
  });

  it('parses escalation from IR', () => {
    const ir = makeMinimalIR();
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, SAMPLE_DSL);

    expect(sections.escalation.triggers).toHaveLength(1);
    expect(sections.escalation.triggers[0].when).toBe('user_angry');
    expect(sections.escalation.triggers[0].reason).toBe('Customer frustrated');
    expect(sections.escalation.triggers[0].priority).toBe('high');
    expect(sections.escalation.triggers[0].tags).toEqual(['urgent']);

    expect(sections.escalation.contextForHuman).toEqual(['conversation_summary', 'user_sentiment']);

    expect(sections.escalation.onHumanComplete).toHaveLength(1);
    expect(sections.escalation.onHumanComplete[0].condition).toBe('resolved');
    expect(sections.escalation.onHumanComplete[0].action).toBe('close_ticket');
  });

  it('parses behavior data from IR', () => {
    const ir = makeMinimalIR();
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, SAMPLE_DSL);

    expect(sections.behavior.conversationBehavior).toEqual({
      speaking: {
        style: 'warm and concise',
        tool_lead_in: 'brief',
      },
      interaction: {
        answer_shape: 'answer_first',
      },
    });
    expect(sections.behavior.profiles).toHaveLength(1);
    expect(sections.behavior.profiles[0]).toEqual({
      name: 'formal',
      priority: 10,
      whenSummary: 'business_context',
      overrideCategories: ['instructions', 'tools'],
    });
  });

  it('handles empty IR gracefully', () => {
    const ir = makeEmptyIR();
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, '');

    expect(sections.identity.goal).toBe('');
    expect(sections.tools).toEqual([]);
    expect(sections.gather).toEqual([]);
    expect(sections.flow).toBeNull();
    expect(sections.constraints).toEqual([]);
    expect(sections.guardrails).toEqual([]);
    expect(sections.handoffs).toEqual([]);
    expect(sections.delegates).toEqual([]);
    expect(sections.escalation).toEqual({
      triggers: [],
      contextForHuman: [],
      onHumanComplete: [],
    });
    expect(sections.memory.sessionVars).toEqual([]);
    expect(sections.memory.persistentPaths).toEqual([]);
    expect(sections.memory.rememberTriggers).toEqual([]);
    expect(sections.memory.recallInstructions).toEqual([]);
    expect(sections.behavior).toEqual({ conversationBehavior: undefined, profiles: [] });
    expect(sections.templates).toEqual([]);
    expect(sections.definition).toBe('');
  });

  it('stores DSL in the definition section', () => {
    const ir = makeEmptyIR();
    const models = parseIRToSections(ir);
    const dsl = 'AGENT my_agent\nGOAL Do things';
    const sections = sectionModelsToEditorSections(models, ir, dsl);

    expect(sections.definition).toBe(dsl);
  });

  it('handles templates as an object keyed by name', () => {
    const ir = makeMinimalIR({
      templates: {
        welcome: { content: 'Welcome!', markdown: '# Welcome!' },
        goodbye: { content: 'Goodbye!', html: '<p>Goodbye!</p>' },
      },
    });
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, '');

    expect(sections.templates).toHaveLength(2);
    const names = sections.templates.map((t) => t.name);
    expect(names).toContain('welcome');
    expect(names).toContain('goodbye');

    const welcome = sections.templates.find((t) => t.name === 'welcome')!;
    expect(welcome.formats.default).toBe('Welcome!');
    expect(welcome.formats.markdown).toBe('# Welcome!');
  });

  it('handles behavior profiles without tool overrides', () => {
    const ir = makeMinimalIR({
      behavior_profiles: [
        {
          name: 'casual',
          when: 'informal',
          priority: 5,
          instructions: 'Be casual',
          // No tools_hide or tools_add
        },
      ],
    });
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, '');

    expect(sections.behavior.profiles).toEqual([
      {
        name: 'casual',
        priority: 5,
        whenSummary: 'informal',
        overrideCategories: ['instructions'],
      },
    ]);
  });

  it('handles escalation without coordination block', () => {
    const ir = makeMinimalIR({ coordination: {} });
    const models = parseIRToSections(ir);
    const sections = sectionModelsToEditorSections(models, ir, '');

    expect(sections.escalation).toEqual({
      triggers: [],
      contextForHuman: [],
      onHumanComplete: [],
    });
  });
});
