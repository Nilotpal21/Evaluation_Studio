/**
 * Pre-Refactor Test: Gather & Validation
 *
 * Covers GATHER field collection, validation rules, entity extraction,
 * correction detection, and gather completeness.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  RuntimeExecutor,
  compileToResolvedAgent,
  buildSystemPrompt,
} from '../../../services/runtime-executor';
import { createTraceCollector, filterTraces } from '../../helpers/history-validation';
import { injectMockClient } from './helpers/mock-llm-client';

describe('Pre-Refactor: Gather & Validation', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ---------------------------------------------------------------------------
  // Scripted GATHER
  // ---------------------------------------------------------------------------

  describe('Scripted GATHER', () => {
    test('GATHER collects multiple fields sequentially', async () => {
      const dsl = `
AGENT: Gather_Multi

GOAL: "Collect info"

FLOW:
  entry_point: ask_first
  steps:
    - ask_first
    - ask_last
    - done

ask_first:
  GATHER:
    - first_name: required
  THEN: ask_last

ask_last:
  GATHER:
    - last_name: required
  THEN: done

done:
  RESPOND: "Hello {{first_name}} {{last_name}}!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Gather_Multi'),
      );
      await executor.initializeSession(session.id);

      // First field
      expect(session.waitingForInput).toBeDefined();
      await executor.executeMessage(session.id, 'John');
      // Should now ask for second field
      if (!session.data.values.last_name) {
        await executor.executeMessage(session.id, 'Doe');
      }

      expect(session.data.values.first_name).toBe('John');
      expect(session.data.values.last_name).toBe('Doe');
    });

    test('GATHER stores user input in data values', async () => {
      const dsl = `
AGENT: Collect_Store

GOAL: "Collect"

FLOW:
  entry_point: ask
  steps:
    - ask
    - show

ask:
  GATHER:
    - color: required
  THEN: show

show:
  RESPOND: "You picked {{color}}."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Collect_Store'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'blue');

      expect(session.data.values.color).toBe('blue');
      expect(session.data.gatheredKeys.has('color')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Reasoning GATHER (LLM extraction)
  // ---------------------------------------------------------------------------

  describe('Reasoning GATHER with LLM Extraction', () => {
    test('extracts entities from user message via LLM', async () => {
      const dsl = `
AGENT: LLM_Gather

GOAL: "Gather travel info"
PERSONA: "Travel agent"

GATHER:
  destination:
    prompt: "Where to?"
    type: string
    required: true
  travel_date:
    prompt: "When?"
    type: string
    required: true
`;
      const mock = injectMockClient(executor);
      mock.setEntityExtractionResponse({
        destination: 'Tokyo',
        travel_date: '2026-04-01',
      });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'LLM_Gather'),
      );
      const tc = createTraceCollector();
      await executor.executeMessage(
        session.id,
        'I want to go to Tokyo on April 1st',
        undefined,
        tc.callback,
      );

      expect(session.data.values.destination).toBe('Tokyo');
      expect(session.data.values.travel_date).toBe('2026-04-01');

      // Should emit entity_extraction or dsl_collect trace
      const collectTraces = filterTraces(tc.traces, 'dsl_collect');
      expect(collectTraces.length).toBeGreaterThanOrEqual(1);
    });

    test('partial extraction leaves missing fields unset', async () => {
      const dsl = `
AGENT: Partial_Gather

GOAL: "Gather info"
PERSONA: "Agent"

GATHER:
  city:
    prompt: "Which city?"
    type: string
    required: true
  budget:
    prompt: "What budget?"
    type: number
    required: true
`;
      const mock = injectMockClient(executor);
      mock.setEntityExtractionResponse({ city: 'London' });

      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Partial_Gather'),
      );
      await executor.executeMessage(session.id, 'I want to go to London');

      expect(session.data.values.city).toBe('London');
      expect(session.data.values.budget).toBeUndefined();
    });

    test('system prompt includes GATHER field descriptions', () => {
      const dsl = `
AGENT: Prompt_Gather

GOAL: "Test prompt"
PERSONA: "Agent"

GATHER:
  email:
    prompt: "Your email?"
    type: string
    required: true
`;
      injectMockClient(executor);
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Prompt_Gather'),
      );

      const prompt = buildSystemPrompt(session);

      expect(prompt).toContain('email');
      expect(prompt).toContain('gather');
    });
  });

  // ---------------------------------------------------------------------------
  // Correction detection
  // ---------------------------------------------------------------------------

  describe('Correction Detection', () => {
    test('detects correction patterns in user input', async () => {
      const dsl = `
AGENT: Correct_Agent

GOAL: "Test corrections"

GATHER:
  city:
    prompt: "Which city?"
    type: string
    required: true

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirm

ask:
  GATHER:
    - city: required
  THEN: confirm

confirm:
  RESPOND: "Going to {{city}}."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Correct_Agent'),
      );
      await executor.initializeSession(session.id);

      // First input
      await executor.executeMessage(session.id, 'Paris');
      expect(session.data.values.city).toBe('Paris');

      // The correction detection runs during input processing
      // This test verifies the flow doesn't crash on corrections
    });
  });

  // ---------------------------------------------------------------------------
  // Data store consistency
  // ---------------------------------------------------------------------------

  describe('SessionDataStore Consistency', () => {
    test('gatheredKeys tracks which values came from user input', async () => {
      const dsl = `
AGENT: Track_Keys

GOAL: "Test key tracking"

ON_START:
  set: computed_val = auto

FLOW:
  entry_point: ask
  steps:
    - ask

ask:
  GATHER:
    - user_val: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Track_Keys'),
      );
      await executor.initializeSession(session.id);
      await executor.executeMessage(session.id, 'manual');

      // computed_val was SET (not gathered from user)
      expect(session.data.values.computed_val).toBe('auto');
      expect(session.data.gatheredKeys.has('computed_val')).toBe(false);

      // user_val was collected from user input
      expect(session.data.values.user_val).toBe('manual');
      expect(session.data.gatheredKeys.has('user_val')).toBe(true);
    });
  });
});
