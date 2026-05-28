/**
 * Tests for Construct Types
 *
 * Tests type factory functions and action creators.
 */

import { describe, test, expect } from 'vitest';
import {
  createInitialState,
  continueAction,
  respondAction,
  escalateAction,
  handoffAction,
  completeAction,
  blockAction,
  collectAction,
  type AgentState,
  type ConstructAction,
} from '../../platform/constructs/types.js';

describe('Construct Types', () => {
  describe('createInitialState', () => {
    test('should create state with empty context by default', () => {
      const state = createInitialState();

      expect(state.context).toEqual({});
      expect(state.conversationPhase).toBe('start');
      expect(state.gatherProgress).toEqual({});
      expect(state.constraintResults).toEqual({});
      expect(state.lastToolResults).toEqual({});
      expect(state.memory.session).toEqual({});
      expect(state.memory.persistentCache).toEqual({});
      expect(state.memory.pendingRemembers).toEqual([]);
    });

    test('should merge initial context', () => {
      const state = createInitialState({
        userId: '123',
        sessionId: 'abc',
      });

      expect(state.context.userId).toBe('123');
      expect(state.context.sessionId).toBe('abc');
    });

    test('should not have flowState or errorState initially', () => {
      const state = createInitialState();

      expect(state.flowState).toBeUndefined();
      expect(state.errorState).toBeUndefined();
    });
  });

  describe('Action Creators', () => {
    describe('continueAction', () => {
      test('should create continue action without data', () => {
        const action = continueAction();

        expect(action.type).toBe('continue');
        expect((action as { data?: unknown }).data).toBeUndefined();
      });

      test('should create continue action with data', () => {
        const action = continueAction({ result: 'success' });

        expect(action.type).toBe('continue');
        expect((action as { data?: unknown }).data).toEqual({ result: 'success' });
      });
    });

    describe('respondAction', () => {
      test('should create respond action with message', () => {
        const action = respondAction('Hello, user!');

        expect(action.type).toBe('respond');
        expect((action as { message: string }).message).toBe('Hello, user!');
        expect((action as { continueProcessing?: boolean }).continueProcessing).toBe(false);
      });

      test('should create respond action with continueProcessing', () => {
        const action = respondAction('Intermediate response', true);

        expect(action.type).toBe('respond');
        expect((action as { continueProcessing?: boolean }).continueProcessing).toBe(true);
      });
    });

    describe('escalateAction', () => {
      test('should create escalate action with defaults', () => {
        const action = escalateAction('Complex query');

        expect(action.type).toBe('escalate');
        expect((action as { reason: string }).reason).toBe('Complex query');
        expect((action as { priority: string }).priority).toBe('medium');
        expect((action as { context?: unknown }).context).toBeUndefined();
      });

      test('should create escalate action with priority and context', () => {
        const action = escalateAction('Urgent issue', 'critical', { caseId: '123' });

        expect(action.type).toBe('escalate');
        expect((action as { priority: string }).priority).toBe('critical');
        expect((action as { context?: unknown }).context).toEqual({ caseId: '123' });
      });

      test('should accept all priority levels', () => {
        const priorities = ['low', 'medium', 'high', 'critical'] as const;

        priorities.forEach((priority) => {
          const action = escalateAction('Test', priority);
          expect((action as { priority: string }).priority).toBe(priority);
        });
      });
    });

    describe('handoffAction', () => {
      test('should create handoff action without return', () => {
        const action = handoffAction('SpecialistAgent', { topic: 'billing' });

        expect(action.type).toBe('handoff');
        expect((action as { target: string }).target).toBe('SpecialistAgent');
        expect((action as { context: unknown }).context).toEqual({ topic: 'billing' });
        expect((action as { returnExpected: boolean }).returnExpected).toBe(false);
      });

      test('should create handoff action with return expected', () => {
        const action = handoffAction('Helper', { data: 'test' }, true, 'Need help with X');

        expect((action as { returnExpected: boolean }).returnExpected).toBe(true);
        expect((action as { summary?: string }).summary).toBe('Need help with X');
      });
    });

    describe('completeAction', () => {
      test('should create complete action without message', () => {
        const action = completeAction();

        expect(action.type).toBe('complete');
        expect((action as { message?: string }).message).toBeUndefined();
        expect((action as { store?: unknown }).store).toBeUndefined();
      });

      test('should create complete action with message and store', () => {
        const action = completeAction('Session complete!', { result: 'success' });

        expect((action as { message?: string }).message).toBe('Session complete!');
        expect((action as { store?: unknown }).store).toEqual({ result: 'success' });
      });
    });

    describe('blockAction', () => {
      test('should create block action', () => {
        const action = blockAction('Constraint violated', 'max_requests');

        expect(action.type).toBe('block');
        expect((action as { reason: string }).reason).toBe('Constraint violated');
        expect((action as { constraint?: string }).constraint).toBe('max_requests');
      });
    });

    describe('collectAction', () => {
      test('should create collect action', () => {
        const action = collectAction(['email', 'phone'], {
          email: 'What is your email?',
          phone: 'What is your phone number?',
        });

        expect(action.type).toBe('collect');
        expect((action as { fields: string[] }).fields).toEqual(['email', 'phone']);
        expect((action as { prompts: Record<string, string> }).prompts.email).toBe(
          'What is your email?',
        );
      });
    });
  });

  describe('Type Compatibility', () => {
    test('all action types should be assignable to ConstructAction', () => {
      const actions: ConstructAction[] = [
        continueAction(),
        respondAction('test'),
        escalateAction('test'),
        handoffAction('agent', {}),
        completeAction(),
        blockAction('test'),
        collectAction(['field'], { field: 'prompt' }),
        { type: 'retry', delay: 1000 },
        { type: 'delegate', agent: 'sub', input: {}, useResult: 'merge' },
      ];

      expect(actions.length).toBe(9);
      actions.forEach((action) => {
        expect(action.type).toBeDefined();
      });
    });

    test('AgentState should have all required properties', () => {
      const state: AgentState = createInitialState();

      // Type check - these should compile without errors
      const _context: Record<string, unknown> = state.context;
      const _phase: string = state.conversationPhase;
      const _gather: Record<string, unknown> = state.gatherProgress;
      const _constraints: Record<string, boolean> = state.constraintResults;
      const _tools: Record<string, unknown> = state.lastToolResults;
      const _memory = state.memory;

      expect(_context).toBeDefined();
      expect(_phase).toBeDefined();
      expect(_gather).toBeDefined();
      expect(_constraints).toBeDefined();
      expect(_tools).toBeDefined();
      expect(_memory).toBeDefined();
    });
  });
});
