/**
 * Pre-refactor: Gather Execution Parity Tests
 *
 * Captures the current behavior of gather field collection before
 * the strangler migration. These tests verify session initialization
 * and data store setup for gather-capable agents.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuntimeExecutor } from '../../../services/runtime-executor.js';
import fixtures from './fixtures/gather-scenarios.json';

describe('Pre-refactor: Gather Execution', () => {
  let executor: RuntimeExecutor;

  beforeEach(() => {
    executor = new RuntimeExecutor();
  });

  describe('session initialization with gather DSL', () => {
    it('creates session from gather DSL', () => {
      const session = executor.createSession(fixtures[0].dsl, 'gather-test');
      expect(session).toBeDefined();
      expect(session.agentIR).not.toBeNull();
    });

    it('initializes empty gather progress', () => {
      const session = executor.createSession(fixtures[0].dsl, 'gather-test');
      expect(session.state.gatherProgress).toEqual({});
    });

    it('initializes data store with gatheredKeys set', () => {
      const session = executor.createSession(fixtures[0].dsl, 'gather-test');
      expect(session.data).toBeDefined();
      expect(session.data.gatheredKeys).toBeDefined();
      expect(session.data.gatheredKeys.size).toBe(0);
    });

    it('session starts not complete', () => {
      const session = executor.createSession(fixtures[0].dsl, 'gather-test');
      expect(session.isComplete).toBe(false);
    });
  });

  describe('fixture scenarios load correctly', () => {
    for (const fixture of fixtures) {
      it(`compiles and initializes: ${fixture.name}`, () => {
        const session = executor.createSession(fixture.dsl, 'gather-test');
        expect(session).toBeDefined();
        expect(session.agentIR).not.toBeNull();
      });
    }
  });

  describe('multi-field gather DSL', () => {
    it('compiles multi-field gather agent with data store ready', () => {
      const session = executor.createSession(fixtures[1].dsl, 'gather-test');
      expect(session.agentIR).not.toBeNull();
      // Data store should be initialized and ready for gather
      expect(session.data.values).toBeDefined();
      expect(session.data.gatheredKeys.size).toBe(0);
      expect(session.state.gatherProgress).toEqual({});
    });
  });

  describe('session data store mutations', () => {
    it('gathered values can be set on session data', () => {
      const session = executor.createSession(fixtures[0].dsl, 'gather-test');
      // Simulate what the runtime does when gathering a value
      session.data.values['userName'] = 'John';
      session.data.gatheredKeys.add('userName');
      expect(session.data.values['userName']).toBe('John');
      expect(session.data.gatheredKeys.has('userName')).toBe(true);
    });

    it('gathered keys track which values came from user input', () => {
      const session = executor.createSession(fixtures[0].dsl, 'gather-test');
      // Simulate computed vs gathered values
      session.data.values['computed'] = 'auto';
      session.data.values['userName'] = 'John';
      session.data.gatheredKeys.add('userName');

      expect(session.data.gatheredKeys.has('userName')).toBe(true);
      expect(session.data.gatheredKeys.has('computed')).toBe(false);
    });
  });

  describe('gather with optional fields', () => {
    it('compiles agent with optional gather fields', () => {
      const session = executor.createSession(fixtures[2].dsl, 'gather-test');
      expect(session.agentIR).not.toBeNull();
    });
  });
});
