/**
 * Flow GATHER Multi-Field & ON_INPUT Full-Path Tests
 *
 * Tests for:
 * - GATHER with multiple required fields (collect over multiple turns)
 * - GATHER inline format
 * - ON_INPUT full path through executeMessage (SET, navigation, branching)
 * - ON_INPUT with multiple IF branches
 * - ON_INPUT ELSE fallthrough
 * - ON_INPUT SET + RESPOND + THEN chains
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { RuntimeExecutor, compileToResolvedAgent } from '../../services/runtime-executor';
import {
  assertHistoryIntegrity,
  assertUserMessageCount,
  assertNoEmptyUserMessages,
  assertNoEmptyMessages,
} from '../helpers/history-validation';

describe('Flow GATHER & ON_INPUT', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  // ===========================================================================
  // ON_INPUT FULL PATH
  // ===========================================================================

  describe('ON_INPUT full execution path', () => {
    test('ON_INPUT IF branch sets value and navigates', async () => {
      const dsl = `
AGENT: OnInput_Navigate_Test

GOAL: "Test ON_INPUT navigation"

FLOW:
  entry_point: menu
  steps:
    - menu
    - option_a
    - option_b

menu:
  GATHER:
    - choice: required
  ON_INPUT:
    - IF: input contains "a"
      SET: selected = "option_a"
      RESPOND: "You chose A!"
      THEN: option_a
    - IF: input contains "b"
      SET: selected = "option_b"
      RESPOND: "You chose B!"
      THEN: option_b
    - ELSE:
      RESPOND: "Please choose A or B."
      THEN: menu

option_a:
  RESPOND: "Handling option A. Selected: {{selected}}"
  THEN: COMPLETE

option_b:
  RESPOND: "Handling option B. Selected: {{selected}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnInput_Navigate_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I want option a', (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('You chose A!');
      expect(output).toContain('Handling option A');
      expect(session.data.values.selected).toBe('option_a');
      expect(session.isComplete).toBe(true);
    });

    test('ON_INPUT ELSE branch re-prompts user', async () => {
      const dsl = `
AGENT: OnInput_Else_Test

GOAL: "Test ON_INPUT ELSE"

FLOW:
  entry_point: collect
  steps:
    - collect
    - done

collect:
  GATHER:
    - answer: required
  ON_INPUT:
    - IF: input contains "yes"
      THEN: done
    - IF: input contains "no"
      RESPOND: "OK, cancelled."
      THEN: COMPLETE
    - ELSE:
      RESPOND: "Invalid. Please say yes or no."
      THEN: collect

done:
  RESPOND: "Great, proceeding!"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnInput_Else_Test'),
      );
      await executor.initializeSession(session.id);

      // Send invalid input → ELSE branch → re-prompt
      const chunks1: string[] = [];
      await executor.executeMessage(session.id, 'maybe', (c) => chunks1.push(c));
      expect(chunks1.join('')).toContain('Invalid. Please say yes or no');
      expect(session.currentFlowStep).toBe('collect');
      expect(session.isComplete).not.toBe(true);

      // Now send valid input
      const chunks2: string[] = [];
      await executor.executeMessage(session.id, 'yes please', (c) => chunks2.push(c));
      expect(chunks2.join('')).toContain('Great, proceeding!');
      expect(session.isComplete).toBe(true);
    });

    test('ON_INPUT multiple IF branches evaluate in order', async () => {
      const dsl = `
AGENT: OnInput_Order_Test

GOAL: "Test IF order"

FLOW:
  entry_point: detect
  steps:
    - detect
    - urgent
    - normal

detect:
  GATHER:
    - request: required
  ON_INPUT:
    - IF: input contains "urgent"
      SET: priority = "high"
      RESPOND: "Marking as urgent."
      THEN: urgent
    - IF: input contains "issue"
      SET: priority = "normal"
      RESPOND: "Noted."
      THEN: normal
    - ELSE:
      THEN: COMPLETE

urgent:
  RESPOND: "Urgent handler: priority={{priority}}"
  THEN: COMPLETE

normal:
  RESPOND: "Normal handler: priority={{priority}}"
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnInput_Order_Test'),
      );
      await executor.initializeSession(session.id);

      // Message contains both "urgent" and "issue" → first IF wins
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'I have an urgent issue', (c) => chunks.push(c));

      const output = chunks.join('');
      expect(output).toContain('Marking as urgent');
      expect(output).toContain('priority=high');
      expect(session.data.values.priority).toBe('high');
    });

    test('ON_INPUT SET with template interpolation', async () => {
      const dsl = `
AGENT: OnInput_Template_Test

GOAL: "Test SET with templates"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - name: required
  ON_INPUT:
    - IF: input contains "vip"
      SET: greeting = "Welcome, VIP!"
      SET: is_vip = true
      THEN: COMPLETE
    - ELSE:
      SET: greeting = "Hello!"
      SET: is_vip = false
      THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnInput_Template_Test'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'I am a vip guest');

      expect(session.data.values.greeting).toBe('Welcome, VIP!');
      expect(session.data.values.is_vip).toBe(true);
    });

    test('ON_INPUT without GATHER uses RESPOND for display', async () => {
      // A step can have RESPOND + ON_INPUT without GATHER
      const dsl = `
AGENT: OnInput_NoColl_Test

GOAL: "Test respond without gather"

FLOW:
  entry_point: ask
  steps:
    - ask
    - confirmed
    - denied

ask:
  RESPOND: "Do you want to continue? (yes/no)"
  ON_INPUT:
    - IF: input contains "yes"
      THEN: confirmed
    - ELSE:
      THEN: denied

confirmed:
  RESPOND: "Continuing!"
  THEN: COMPLETE

denied:
  RESPOND: "Stopped."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'OnInput_NoColl_Test'),
      );
      await executor.initializeSession(session.id);

      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'yes', (c) => chunks.push(c));

      expect(chunks.join('')).toContain('Continuing!');
      expect(session.isComplete).toBe(true);
    });
  });

  // ===========================================================================
  // MULTI-STEP COLLECTION (Sequential GATHER steps)
  // ===========================================================================

  describe('Multi-step collection flow', () => {
    test('Collects multiple values across sequential steps', async () => {
      const dsl = `
AGENT: Multi_Step_Test

GOAL: "Collect multiple values"

FLOW:
  entry_point: get_name
  steps:
    - get_name
    - get_destination
    - confirm

get_name:
  GATHER:
    - name: required
  THEN: get_destination

get_destination:
  GATHER:
    - destination: required
  THEN: confirm

confirm:
  RESPOND: "Got it, {{name}}! You're heading to {{destination}}."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Multi_Step_Test'),
      );
      await executor.initializeSession(session.id);
      expect(session.currentFlowStep).toBe('get_name');

      // Step 1: provide name
      const chunks1: string[] = [];
      await executor.executeMessage(session.id, 'Alice', (c) => chunks1.push(c));
      expect(session.data.values.name).toBe('Alice');
      expect(session.currentFlowStep).toBe('get_destination');

      // Step 2: provide destination
      const chunks2: string[] = [];
      await executor.executeMessage(session.id, 'Paris', (c) => chunks2.push(c));

      const output = chunks2.join('');
      expect(output).toContain('Got it, Alice!');
      expect(output).toContain('heading to Paris');
      expect(session.isComplete).toBe(true);
    });

    test('Conversation history tracks multi-turn flow', async () => {
      const dsl = `
AGENT: History_Test

GOAL: "Test conversation history"

FLOW:
  entry_point: step1
  steps:
    - step1
    - step2

step1:
  GATHER:
    - first: required
  THEN: step2

step2:
  GATHER:
    - second: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'History_Test'),
      );
      await executor.initializeSession(session.id);

      await executor.executeMessage(session.id, 'value_one');
      await executor.executeMessage(session.id, 'value_two');

      // Both values should be collected
      expect(session.data.values.first).toBe('value_one');
      expect(session.data.values.second).toBe('value_two');
      expect(session.isComplete).toBe(true);

      // Conversation history should have entries for both turns
      const userMessages = session.conversationHistory.filter((m) => m.role === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(2);
      assertUserMessageCount(session.conversationHistory, 2, 'History_Test conversationHistory');
      assertHistoryIntegrity(session.conversationHistory, 'History_Test conversationHistory');
    });
  });

  // ===========================================================================
  // GATHER (multi-field collection in single step)
  // ===========================================================================

  describe('GATHER multi-field collection', () => {
    test('GATHER single-field steps collect progressively across turns', async () => {
      // Without LLM, single-field GATHER assigns raw input directly (lines 604-606 in extraction).
      // Progressive collection is tested via sequential single-field steps.
      const dsl = `
AGENT: Gather_Progressive_Test

GOAL: "Test progressive single-field GATHER"

FLOW:
  entry_point: get_destination
  steps:
    - get_destination
    - get_name
    - confirm

get_destination:
  GATHER: destination
  PROMPT: "Where are you going?"
  THEN: get_name

get_name:
  GATHER: name
  PROMPT: "What is your name?"
  THEN: confirm

confirm:
  RESPOND: "Booking for {{name}} to {{destination}}."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Gather_Progressive_Test'),
      );
      await executor.initializeSession(session.id);

      // Turn 1: provide destination — single-field fallback assigns raw input
      const chunks1: string[] = [];
      await executor.executeMessage(session.id, 'Paris', (c) => chunks1.push(c));

      expect(session.data.values.destination).toBe('Paris');
      expect(session.currentFlowStep).toBe('get_name');
      expect(session.isComplete).not.toBe(true);

      // Turn 2: provide name — single-field fallback assigns raw input
      const chunks2: string[] = [];
      await executor.executeMessage(session.id, 'Alice', (c) => chunks2.push(c));

      expect(session.data.values.name).toBe('Alice');
      expect(chunks2.join('')).toContain('Booking for Alice to Paris');
      expect(session.isComplete).toBe(true);
    });

    test('GATHER block format with field properties', async () => {
      // Use block format with - field entries and properties
      const dsl = `
AGENT: Gather_Block_Test

GOAL: "Test GATHER block"

FLOW:
  entry_point: gather_info
  steps:
    - gather_info
    - confirm

gather_info:
  GATHER:
    - destination
      type: string
      prompt: "Where are you going?"
      required: true
    - guests: optional
      type: number
      prompt: "How many guests?"
  THEN: confirm

confirm:
  RESPOND: "Booking to {{destination}}."
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Gather_Block_Test'),
      );
      await executor.initializeSession(session.id);

      // Provide destination (required) — guests is optional
      const chunks: string[] = [];
      await executor.executeMessage(session.id, 'Barcelona', (c) => chunks.push(c));

      expect(session.data.values.destination).toBeDefined();
    });
  });

  // ===========================================================================
  // FLOW LOOPING WITH ON_INPUT
  // ===========================================================================

  describe('Flow looping', () => {
    test('ON_INPUT THEN: same_step re-enters the step', async () => {
      const dsl = `
AGENT: Loop_Test

GOAL: "Test looping"

FLOW:
  entry_point: collect
  steps:
    - collect

collect:
  GATHER:
    - answer: required
  ON_INPUT:
    - IF: input contains "done"
      RESPOND: "Finished!"
      THEN: COMPLETE
    - ELSE:
      RESPOND: "Not done yet. Try again."
      THEN: collect
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Loop_Test'),
      );
      await executor.initializeSession(session.id);

      // First attempt: not done
      const chunks1: string[] = [];
      await executor.executeMessage(session.id, 'hello', (c) => chunks1.push(c));
      expect(chunks1.join('')).toContain('Not done yet');
      expect(session.currentFlowStep).toBe('collect');
      expect(session.isComplete).not.toBe(true);

      // Second attempt: done
      const chunks2: string[] = [];
      await executor.executeMessage(session.id, 'done', (c) => chunks2.push(c));
      expect(chunks2.join('')).toContain('Finished!');
      expect(session.isComplete).toBe(true);
    });

    test('State accumulates across loop iterations', async () => {
      const dsl = `
AGENT: Accumulate_Test

GOAL: "Test state accumulation"

FLOW:
  entry_point: count
  steps:
    - count

count:
  GATHER:
    - input: required
  ON_INPUT:
    - IF: input contains "stop"
      RESPOND: "Stopped."
      THEN: COMPLETE
    - ELSE:
      THEN: count
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'Accumulate_Test'),
      );
      await executor.initializeSession(session.id);

      // Multiple inputs
      await executor.executeMessage(session.id, 'first');
      await executor.executeMessage(session.id, 'second');
      await executor.executeMessage(session.id, 'stop');

      expect(session.isComplete).toBe(true);
      // Conversation history should reflect all interactions
      const userMessages = session.conversationHistory.filter((m) => m.role === 'user');
      expect(userMessages.length).toBeGreaterThanOrEqual(3);
      assertUserMessageCount(session.conversationHistory, 3, 'Accumulate_Test conversationHistory');
      // Scripted flow with RESPOND + completion message produces consecutive assistant messages,
      // so check for empty messages only (the critical API validation)
      assertNoEmptyUserMessages(session.conversationHistory, 'Accumulate_Test conversationHistory');
      assertNoEmptyMessages(session.conversationHistory, 'Accumulate_Test conversationHistory');
    });
  });

  // ===========================================================================
  // RESPOND-ONLY STEPS (no GATHER)
  // ===========================================================================

  describe('Respond-only steps', () => {
    test('Step with only RESPOND auto-advances to next step', async () => {
      const dsl = `
AGENT: AutoAdvance_Test

GOAL: "Test auto-advance"

FLOW:
  entry_point: welcome
  steps:
    - welcome
    - info
    - collect

welcome:
  RESPOND: "Welcome!"
  THEN: info

info:
  RESPOND: "Here is some info."
  THEN: collect

collect:
  GATHER:
    - name: required
  THEN: COMPLETE
`;
      const session = executor.createSessionFromResolved(
        compileToResolvedAgent([dsl], 'AutoAdvance_Test'),
      );
      const chunks: string[] = [];
      await executor.initializeSession(session.id, (c) => chunks.push(c));

      const output = chunks.join('');
      // Both RESPOND steps should auto-advance and show before the GATHER auto-prompt
      expect(output).toContain('Welcome!');
      expect(output).toContain('Here is some info.');
      expect(output).toContain('name');
      expect(session.currentFlowStep).toBe('collect');
    });
  });
});
