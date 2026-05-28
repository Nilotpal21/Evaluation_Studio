/**
 * Tests for the Editor Save Serialization Adapter
 *
 * Verifies that `serializeEditorSections` correctly maps the fine-grained
 * 17-section EditorSection dirty set to grouped serializer calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SectionEdit } from '../lib/abl-serializers';
import type { EditorSection, SectionDataMap } from '../components/agent-editor/types';

// ---------------------------------------------------------------------------
// Mock the serializer functions
// ---------------------------------------------------------------------------

vi.mock('../lib/abl-serializers', () => ({
  serializeIdentityToABL: vi.fn(() => [{ section: 'GOAL', content: 'GOAL: "test"' }]),
  serializeExecutionToABL: vi.fn(() => [
    { section: 'EXECUTION', content: 'EXECUTION:\n  model: gpt-4' },
  ]),
  serializeToolsToABL: vi.fn(() => [{ section: 'TOOLS', content: 'TOOLS:\n  test()' }]),
  serializeGatherToABL: vi.fn(() => [{ section: 'GATHER', content: 'GATHER:\n  - field' }]),
  serializeFlowToABL: vi.fn(() => [{ section: 'FLOW', content: 'FLOW:\n  steps' }]),
  serializeConversationBehaviorToABL: vi.fn(() => [
    { section: 'CONVERSATION', content: 'CONVERSATION:\n  speaking:\n    style: warm' },
  ]),
  serializeBehaviorRefsToABL: vi.fn(() => [
    { section: 'BEHAVIOR', content: 'USE BEHAVIOR_PROFILE: vip_voice' },
  ]),
  serializeRulesToABL: vi.fn(() => [
    { section: 'CONSTRAINTS', content: 'CONSTRAINTS:' },
    { section: 'GUARDRAILS', content: 'GUARDRAILS:' },
  ]),
  serializeCoordinationToABL: vi.fn(() => [
    { section: 'DELEGATE', content: 'DELEGATE:' },
    { section: 'HANDOFF', content: 'HANDOFF:' },
    { section: 'ESCALATE', content: 'ESCALATE:' },
  ]),
  serializeOnStartToABL: vi.fn(() => [{ section: 'ON_START', content: 'ON_START:' }]),
  serializeErrorHandlingToABL: vi.fn(() => [{ section: 'ON_ERROR', content: 'ON_ERROR:' }]),
  serializeCompletionToABL: vi.fn(() => [{ section: 'COMPLETE', content: 'COMPLETE:' }]),
  serializeLifecycleToABL: vi.fn(() => []),
}));

import {
  serializeIdentityToABL,
  serializeExecutionToABL,
  serializeToolsToABL,
  serializeGatherToABL,
  serializeFlowToABL,
  serializeConversationBehaviorToABL,
  serializeBehaviorRefsToABL,
  serializeRulesToABL,
  serializeCoordinationToABL,
  serializeOnStartToABL,
  serializeErrorHandlingToABL,
  serializeCompletionToABL,
  serializeLifecycleToABL,
} from '../lib/abl-serializers';

import { serializeEditorSections } from '../components/agent-editor/hooks/useEditorSave';

// ---------------------------------------------------------------------------
// Fixture: minimal SectionDataMap
// ---------------------------------------------------------------------------

function makeSectionDataMap(overrides?: Partial<SectionDataMap>): SectionDataMap {
  return {
    identity: {
      goal: 'Help users',
      persona: 'Friendly assistant',
      limitations: ['No financial advice'],
    },
    execution: {
      model: 'gpt-4',
      temperature: 0.7,
      maxTokens: 4096,
      enableThinking: false,
    },
    tools: [
      {
        name: 'search',
        description: 'Search',
        parameters: [],
        returns: { type: 'object' },
        hints: {},
      },
    ],
    gather: [{ name: 'email', prompt: 'Your email?', type: 'string', required: true }],
    memory: {
      sessionVars: [{ name: 'intent', type: 'string' }],
      persistentPaths: ['user.name'],
      rememberTriggers: [],
      recallInstructions: [],
    },
    flow: {
      steps: [
        {
          name: 'greet',
          respond: 'Hello!',
          then: 'COMPLETE',
          hasGather: false,
          hasBranching: false,
          reasoning: false,
        },
      ],
      entryPoint: 'greet',
    },
    constraints: [
      {
        condition: 'age >= 18',
        onFail: { type: 'respond', message: 'Must be 18+' },
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
    behavior: {
      conversationBehavior: {
        speaking: { style: 'warm', tool_lead_in: 'brief' },
      },
      profiles: [
        {
          name: 'vip_voice',
          priority: 10,
          whenSummary: 'channel == "voice"',
          overrideCategories: ['conversation'],
        },
      ],
    },
    handoffs: [{ to: 'Support', when: 'wants_help', summary: 'Transfer', returnable: true }],
    delegates: [{ agent: 'Specialist', when: 'needs_expert', purpose: 'Handle specialist' }],
    escalation: {
      triggers: [{ when: 'wants_human', reason: 'User requested', priority: 'high' }],
      contextForHuman: [],
      onHumanComplete: [],
    },
    onStart: {
      respond: 'Welcome!',
      calls: [],
      sets: [],
      hooks: [],
      hasOnStart: true,
    },
    errorHandling: [{ type: 'timeout', respond: 'Too slow', then: 'continue' }],
    completion: [{ when: 'task_done', respond: 'All done!' }],
    templates: [],
    definition: 'AGENT: test_agent\nGOAL: "Help users"\n',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serializeEditorSections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // FULL DSL replacement
  // =========================================================================

  describe('FULL DSL replacement (definition dirty)', () => {
    it('returns a single FULL edit with the DSL content', () => {
      const sections = makeSectionDataMap({
        definition: 'AGENT: my_agent\nGOAL: "Updated"',
      });
      const dirty = new Set<EditorSection>(['definition']);

      const edits = serializeEditorSections(dirty, sections);

      expect(edits).toHaveLength(1);
      expect(edits[0]).toEqual({
        section: 'FULL',
        content: 'AGENT: my_agent\nGOAL: "Updated"',
      });
    });

    it('ignores other dirty sections when definition is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>([
        'definition',
        'identity',
        'tools',
        'gather',
        'flow',
        'constraints',
        'handoffs',
        'onStart',
      ]);

      const edits = serializeEditorSections(dirty, sections);

      // Should only contain the FULL edit, nothing else
      expect(edits).toHaveLength(1);
      expect(edits[0].section).toBe('FULL');

      // No serializer should have been called
      expect(serializeIdentityToABL).not.toHaveBeenCalled();
      expect(serializeExecutionToABL).not.toHaveBeenCalled();
      expect(serializeToolsToABL).not.toHaveBeenCalled();
      expect(serializeGatherToABL).not.toHaveBeenCalled();
      expect(serializeFlowToABL).not.toHaveBeenCalled();
      expect(serializeRulesToABL).not.toHaveBeenCalled();
      expect(serializeCoordinationToABL).not.toHaveBeenCalled();
      expect(serializeLifecycleToABL).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Identity (GOAL/PERSONA/LIMITATIONS) — independent from execution
  // =========================================================================

  describe('identity serialization', () => {
    it('calls serializeIdentityToABL when identity is dirty (no execution merge)', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['identity']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeIdentityToABL).toHaveBeenCalledTimes(1);
      // Identity serializer receives the identity slice as-is — execution
      // fields are persisted via the dedicated EXECUTION serializer.
      expect(serializeIdentityToABL).toHaveBeenCalledWith(sections.identity);
      expect(serializeExecutionToABL).not.toHaveBeenCalled();
      expect(edits.length).toBeGreaterThan(0);
    });

    it('does NOT call serializeIdentityToABL when only execution is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['execution']);

      serializeEditorSections(dirty, sections);

      expect(serializeIdentityToABL).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Execution serialization (EXECUTION block — model/temperature/maxTokens/enableThinking)
  // =========================================================================

  describe('execution serialization', () => {
    it('calls serializeExecutionToABL when execution is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['execution']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeExecutionToABL).toHaveBeenCalledTimes(1);
      expect(serializeExecutionToABL).toHaveBeenCalledWith(sections.execution);
      expect(edits).toContainEqual({
        section: 'EXECUTION',
        content: 'EXECUTION:\n  model: gpt-4',
      });
    });

    it('does NOT call serializeExecutionToABL when only identity is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['identity']);

      serializeEditorSections(dirty, sections);

      expect(serializeExecutionToABL).not.toHaveBeenCalled();
    });

    it('calls both serializers independently when both identity and execution are dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['identity', 'execution']);

      serializeEditorSections(dirty, sections);

      expect(serializeIdentityToABL).toHaveBeenCalledTimes(1);
      expect(serializeExecutionToABL).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Tools
  // =========================================================================

  describe('tools serialization', () => {
    it('calls serializeToolsToABL when tools is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['tools']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeToolsToABL).toHaveBeenCalledTimes(1);
      expect(serializeToolsToABL).toHaveBeenCalledWith(sections.tools);
      expect(edits).toContainEqual({ section: 'TOOLS', content: 'TOOLS:\n  test()' });
    });

    it('does not call serializeToolsToABL when tools is not dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['identity']);

      serializeEditorSections(dirty, sections);

      expect(serializeToolsToABL).not.toHaveBeenCalled();
    });
  });

  describe('behavior serialization', () => {
    it('serializes conversation behavior and attached profile refs together', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['behavior']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeConversationBehaviorToABL).toHaveBeenCalledTimes(1);
      expect(serializeConversationBehaviorToABL).toHaveBeenCalledWith(
        sections.behavior.conversationBehavior,
      );
      expect(serializeBehaviorRefsToABL).toHaveBeenCalledTimes(1);
      expect(serializeBehaviorRefsToABL).toHaveBeenCalledWith(['vip_voice']);
      expect(edits).toContainEqual({
        section: 'CONVERSATION',
        content: 'CONVERSATION:\n  speaking:\n    style: warm',
      });
      expect(edits).toContainEqual({
        section: 'BEHAVIOR',
        content: 'USE BEHAVIOR_PROFILE: vip_voice',
      });
    });
  });

  // =========================================================================
  // Gather
  // =========================================================================

  describe('gather serialization', () => {
    it('calls serializeGatherToABL when gather is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['gather']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeGatherToABL).toHaveBeenCalledTimes(1);
      expect(serializeGatherToABL).toHaveBeenCalledWith(sections.gather);
      expect(edits).toContainEqual({ section: 'GATHER', content: 'GATHER:\n  - field' });
    });

    it('does not call serializeGatherToABL when gather is not dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['tools']);

      serializeEditorSections(dirty, sections);

      expect(serializeGatherToABL).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Flow
  // =========================================================================

  describe('flow serialization', () => {
    it('calls serializeFlowToABL when flow is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['flow']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeFlowToABL).toHaveBeenCalledTimes(1);
      expect(serializeFlowToABL).toHaveBeenCalledWith(sections.flow);
      expect(edits).toContainEqual({ section: 'FLOW', content: 'FLOW:\n  steps' });
    });

    it('does not call serializeFlowToABL when flow is not dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['gather']);

      serializeEditorSections(dirty, sections);

      expect(serializeFlowToABL).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Rules grouping (constraints + guardrails)
  // =========================================================================

  describe('rules grouping (constraints + guardrails)', () => {
    it('calls serializeRulesToABL when constraints is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['constraints']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeRulesToABL).toHaveBeenCalledTimes(1);
      expect(serializeRulesToABL).toHaveBeenCalledWith({
        constraints: sections.constraints,
        guardrails: sections.guardrails,
      });
      expect(edits).toContainEqual({ section: 'CONSTRAINTS', content: 'CONSTRAINTS:' });
      expect(edits).toContainEqual({ section: 'GUARDRAILS', content: 'GUARDRAILS:' });
    });

    it('calls serializeRulesToABL when guardrails is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['guardrails']);

      serializeEditorSections(dirty, sections);

      expect(serializeRulesToABL).toHaveBeenCalledTimes(1);
      expect(serializeRulesToABL).toHaveBeenCalledWith({
        constraints: sections.constraints,
        guardrails: sections.guardrails,
      });
    });

    it('serializes only once when both constraints and guardrails are dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['constraints', 'guardrails']);

      serializeEditorSections(dirty, sections);

      expect(serializeRulesToABL).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Coordination grouping (handoffs + delegates + escalation)
  // =========================================================================

  describe('coordination grouping (handoffs + delegates + escalation)', () => {
    it('calls serializeCoordinationToABL when handoffs is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['handoffs']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeCoordinationToABL).toHaveBeenCalledTimes(1);
      expect(serializeCoordinationToABL).toHaveBeenCalledWith({
        handoffs: sections.handoffs,
        delegates: sections.delegates,
        escalation: sections.escalation,
      });
      expect(edits).toContainEqual({ section: 'DELEGATE', content: 'DELEGATE:' });
      expect(edits).toContainEqual({ section: 'HANDOFF', content: 'HANDOFF:' });
      expect(edits).toContainEqual({ section: 'ESCALATE', content: 'ESCALATE:' });
    });

    it('calls serializeCoordinationToABL when delegates is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['delegates']);

      serializeEditorSections(dirty, sections);

      expect(serializeCoordinationToABL).toHaveBeenCalledTimes(1);
      expect(serializeCoordinationToABL).toHaveBeenCalledWith({
        handoffs: sections.handoffs,
        delegates: sections.delegates,
        escalation: sections.escalation,
      });
    });

    it('calls serializeCoordinationToABL when escalation is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['escalation']);

      serializeEditorSections(dirty, sections);

      expect(serializeCoordinationToABL).toHaveBeenCalledTimes(1);
    });

    it('serializes only once when all coordination sections are dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['handoffs', 'delegates', 'escalation']);

      serializeEditorSections(dirty, sections);

      expect(serializeCoordinationToABL).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Lifecycle section isolation
  // =========================================================================

  describe('lifecycle section isolation', () => {
    it('calls serializeOnStartToABL when onStart is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['onStart']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).toHaveBeenCalledTimes(1);
      expect(serializeOnStartToABL).toHaveBeenCalledWith(sections.onStart);
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).not.toHaveBeenCalled();
      expect(edits).toContainEqual({ section: 'ON_START', content: 'ON_START:' });
    });

    it('calls serializeErrorHandlingToABL when errorHandling is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['errorHandling']);

      serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).toHaveBeenCalledTimes(1);
      expect(serializeErrorHandlingToABL).toHaveBeenCalledWith(sections.errorHandling);
      expect(serializeCompletionToABL).not.toHaveBeenCalled();
    });

    it('calls serializeCompletionToABL when completion is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['completion']);

      serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).toHaveBeenCalledTimes(1);
      expect(serializeCompletionToABL).toHaveBeenCalledWith(sections.completion);
    });

    it('does not rewrite lifecycle sections when only memory is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['memory']);

      expect(serializeEditorSections(dirty, sections)).toEqual([]);
      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).not.toHaveBeenCalled();
    });

    it('does not rewrite lifecycle sections when only templates are dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['templates']);

      expect(serializeEditorSections(dirty, sections)).toEqual([]);
      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).not.toHaveBeenCalled();
    });

    it('serializes only the dirty lifecycle subsections', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['onStart', 'errorHandling', 'completion']);

      serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).toHaveBeenCalledTimes(1);
      expect(serializeErrorHandlingToABL).toHaveBeenCalledTimes(1);
      expect(serializeCompletionToABL).toHaveBeenCalledTimes(1);
    });

    it('passes canonical onStart call_spec data through to serializeOnStartToABL', () => {
      const sections = makeSectionDataMap({
        onStart: {
          respond: 'Hi',
          calls: [{ tool: 'init_session', args: '{}' }],
          sets: [],
          hooks: [],
          hasOnStart: true,
          onStartCall: 'init_session',
          onStartCallSpec: {
            tool: 'init_session',
            with: {
              customer_id: 'customer.id',
            },
            as: 'session_bootstrap',
          },
        },
      });
      const dirty = new Set<EditorSection>(['onStart']);

      serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).toHaveBeenCalledWith(
        expect.objectContaining({
          hasOnStart: true,
          respond: 'Hi',
          onStartCall: 'init_session',
          onStartCallSpec: {
            tool: 'init_session',
            with: {
              customer_id: 'customer.id',
            },
            as: 'session_bootstrap',
          },
        }),
      );
    });
  });

  // =========================================================================
  // Multiple dirty sections
  // =========================================================================

  describe('multiple dirty sections', () => {
    it('produces edits from multiple independent groups', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['tools', 'gather', 'flow']);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeToolsToABL).toHaveBeenCalledTimes(1);
      expect(serializeGatherToABL).toHaveBeenCalledTimes(1);
      expect(serializeFlowToABL).toHaveBeenCalledTimes(1);

      // Should not call unrelated serializers
      expect(serializeIdentityToABL).not.toHaveBeenCalled();
      expect(serializeExecutionToABL).not.toHaveBeenCalled();
      expect(serializeRulesToABL).not.toHaveBeenCalled();
      expect(serializeCoordinationToABL).not.toHaveBeenCalled();
      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).not.toHaveBeenCalled();

      // Combined edits from all three
      expect(edits).toHaveLength(3);
    });

    it('produces edits from grouped and independent sections together', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>([
        'identity',
        'tools',
        'constraints',
        'handoffs',
        'onStart',
      ]);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeIdentityToABL).toHaveBeenCalledTimes(1);
      expect(serializeToolsToABL).toHaveBeenCalledTimes(1);
      expect(serializeRulesToABL).toHaveBeenCalledTimes(1);
      expect(serializeCoordinationToABL).toHaveBeenCalledTimes(1);
      expect(serializeOnStartToABL).toHaveBeenCalledTimes(1);

      // 1 (identity) + 1 (tools) + 2 (rules) + 3 (coordination) + 1 (onStart)
      expect(edits).toHaveLength(8);
    });

    it('all serializers called when every non-definition section is dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>([
        'identity',
        'execution',
        'tools',
        'gather',
        'flow',
        'constraints',
        'guardrails',
        'handoffs',
        'delegates',
        'escalation',
        'onStart',
        'errorHandling',
        'completion',
        'memory',
        'templates',
      ]);

      const edits = serializeEditorSections(dirty, sections);

      expect(serializeIdentityToABL).toHaveBeenCalledTimes(1);
      expect(serializeExecutionToABL).toHaveBeenCalledTimes(1);
      expect(serializeToolsToABL).toHaveBeenCalledTimes(1);
      expect(serializeGatherToABL).toHaveBeenCalledTimes(1);
      expect(serializeFlowToABL).toHaveBeenCalledTimes(1);
      expect(serializeRulesToABL).toHaveBeenCalledTimes(1);
      expect(serializeCoordinationToABL).toHaveBeenCalledTimes(1);
      expect(serializeOnStartToABL).toHaveBeenCalledTimes(1);
      expect(serializeErrorHandlingToABL).toHaveBeenCalledTimes(1);
      expect(serializeCompletionToABL).toHaveBeenCalledTimes(1);

      // 1 (identity) + 1 (execution) + 1 (tools) + 1 (gather) + 1 (flow)
      // + 2 (rules) + 3 (coordination) + 3 (lifecycle subsections) = 13
      expect(edits).toHaveLength(13);
    });
  });

  // =========================================================================
  // Empty dirty set
  // =========================================================================

  describe('empty dirty set', () => {
    it('returns an empty array when no sections are dirty', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>();

      const edits = serializeEditorSections(dirty, sections);

      expect(edits).toEqual([]);
      expect(serializeIdentityToABL).not.toHaveBeenCalled();
      expect(serializeExecutionToABL).not.toHaveBeenCalled();
      expect(serializeToolsToABL).not.toHaveBeenCalled();
      expect(serializeGatherToABL).not.toHaveBeenCalled();
      expect(serializeFlowToABL).not.toHaveBeenCalled();
      expect(serializeRulesToABL).not.toHaveBeenCalled();
      expect(serializeCoordinationToABL).not.toHaveBeenCalled();
      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge cases for buildIdentityData and lifecycle section routing
  // =========================================================================

  describe('data reconstruction helpers', () => {
    it('passes the identity slice to serializeIdentityToABL without merging execution fields', () => {
      const sections = makeSectionDataMap({
        identity: { goal: 'G', persona: 'P', limitations: [] },
        execution: {
          model: 'claude-3',
          temperature: 0.5,
          maxTokens: 2048,
          enableThinking: true,
        },
      });
      const dirty = new Set<EditorSection>(['identity']);

      serializeEditorSections(dirty, sections);

      expect(serializeIdentityToABL).toHaveBeenCalledWith({
        goal: 'G',
        persona: 'P',
        limitations: [],
      });
      expect(serializeExecutionToABL).not.toHaveBeenCalled();
    });

    it('passes the execution slice as-is to serializeExecutionToABL', () => {
      const executionData = {
        model: 'claude-3',
        temperature: 0.5,
        maxTokens: 2048,
        enableThinking: true,
      };
      const sections = makeSectionDataMap({ execution: executionData });
      const dirty = new Set<EditorSection>(['execution']);

      serializeEditorSections(dirty, sections);

      expect(serializeExecutionToABL).toHaveBeenCalledWith(executionData);
    });

    it('passes the onStart slice through even when it is disabled', () => {
      const sections = makeSectionDataMap({
        onStart: {
          respond: undefined,
          calls: [],
          sets: [],
          hooks: [],
          hasOnStart: false,
        },
      });
      const dirty = new Set<EditorSection>(['onStart']);

      serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).toHaveBeenCalledWith(
        expect.objectContaining({
          hasOnStart: false,
          respond: undefined,
        }),
      );
    });

    it('passes through empty onStart respond values without collapsing the section', () => {
      const sections = makeSectionDataMap({
        onStart: {
          respond: '',
          calls: [{ tool: 'ping' }],
          sets: [],
          hooks: [],
          hasOnStart: true,
          onStartCall: 'ping',
        },
      });
      const dirty = new Set<EditorSection>(['onStart']);

      serializeEditorSections(dirty, sections);

      expect(serializeOnStartToABL).toHaveBeenCalledWith(
        expect.objectContaining({
          hasOnStart: true,
          onStartCall: 'ping',
          respond: '',
        }),
      );
    });
  });

  // =========================================================================
  // Behavior section
  // =========================================================================

  describe('behavior section', () => {
    it('routes behavior edits through conversation + profile-ref serializers only', () => {
      const sections = makeSectionDataMap();
      const dirty = new Set<EditorSection>(['behavior']);

      const edits = serializeEditorSections(dirty, sections);

      expect(edits).toEqual([
        {
          section: 'CONVERSATION',
          content: 'CONVERSATION:\n  speaking:\n    style: warm',
        },
        {
          section: 'BEHAVIOR',
          content: 'USE BEHAVIOR_PROFILE: vip_voice',
        },
      ]);
      expect(serializeIdentityToABL).not.toHaveBeenCalled();
      expect(serializeExecutionToABL).not.toHaveBeenCalled();
      expect(serializeToolsToABL).not.toHaveBeenCalled();
      expect(serializeGatherToABL).not.toHaveBeenCalled();
      expect(serializeFlowToABL).not.toHaveBeenCalled();
      expect(serializeConversationBehaviorToABL).toHaveBeenCalledTimes(1);
      expect(serializeBehaviorRefsToABL).toHaveBeenCalledTimes(1);
      expect(serializeRulesToABL).not.toHaveBeenCalled();
      expect(serializeCoordinationToABL).not.toHaveBeenCalled();
      expect(serializeOnStartToABL).not.toHaveBeenCalled();
      expect(serializeErrorHandlingToABL).not.toHaveBeenCalled();
      expect(serializeCompletionToABL).not.toHaveBeenCalled();
    });
  });
});
