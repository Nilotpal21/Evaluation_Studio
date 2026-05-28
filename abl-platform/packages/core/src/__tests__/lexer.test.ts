/**
 * Lexer Tests
 */

import { describe, test, expect } from 'vitest';
import { tokenize } from '../parser/lexer.js';

describe('DSLLexer', () => {
  test('should tokenize SUPERVISOR keyword', () => {
    const result = tokenize('SUPERVISOR:');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.tokens[0].tokenType.name).toBe('SupervisorKeyword');
  });

  test('should tokenize AGENT keyword', () => {
    const result = tokenize('AGENT:');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens.length).toBeGreaterThan(0);
    expect(result.tokens[0].tokenType.name).toBe('AgentKeyword');
  });

  test('should tokenize step number', () => {
    const result = tokenize('1. START');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens[0].tokenType.name).toBe('StepNumber');
    expect(result.tokens[0].image).toBe('1');
    expect(result.tokens[1].tokenType.name).toBe('Dot');
  });

  test('should tokenize decimal step prefixes as number literals', () => {
    const result = tokenize('1.5. START');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens[0].tokenType.name).toBe('NumberLiteral');
    expect(result.tokens[0].image).toBe('1.5');
    expect(result.tokens[1].tokenType.name).toBe('Dot');
  });

  test('should tokenize string literal', () => {
    const result = tokenize('"Hello, World!"');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens.some((t) => t.tokenType.name === 'StringLiteral')).toBe(true);
  });

  test('should tokenize section keywords', () => {
    const sections = ['STATE:', 'AGENTS:', 'INTENTS:', 'POLICIES:'];
    for (const section of sections) {
      const result = tokenize(section);
      expect(result.errors).toHaveLength(0);
    }
  });

  test('should tokenize action keywords', () => {
    const actions = ['RESPOND', 'WAIT_INPUT', 'CALL', 'GOTO', 'SIGNAL'];
    for (const action of actions) {
      const result = tokenize(action);
      expect(result.errors).toHaveLength(0);
      expect(result.tokens[0].image.toUpperCase()).toBe(action);
    }
  });

  test('should tokenize comparison operators', () => {
    const operators = ['==', '!=', '>=', '<=', '>', '<'];
    for (const op of operators) {
      const result = tokenize(op);
      expect(result.errors).toHaveLength(0);
    }
  });

  test('should tokenize logical operators', () => {
    const operators = ['AND', 'OR', 'NOT'];
    for (const op of operators) {
      const result = tokenize(op);
      expect(result.errors).toHaveLength(0);
      expect(result.tokens[0].image.toUpperCase()).toBe(op);
    }
  });

  test('should handle comments', () => {
    const result = tokenize('SUPERVISOR: # This is a comment');
    expect(result.errors).toHaveLength(0);
    // Comments should be skipped
  });

  test('should tokenize multiline input', () => {
    const input = `SUPERVISOR: Test
STATE:
  user.name: string`;
    const result = tokenize(input);
    expect(result.errors).toHaveLength(0);
  });

  test('should tokenize variable reference', () => {
    const result = tokenize('user.is_validated');
    expect(result.errors).toHaveLength(0);
    // Should recognize identifiers and dot notation
  });

  test('should tokenize routing table delimiter', () => {
    const result = tokenize('|');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens.some((t) => t.tokenType.name === 'Pipe')).toBe(true);
  });

  test('should tokenize arrow', () => {
    const result = tokenize('→');
    expect(result.errors).toHaveLength(0);
    expect(result.tokens.some((t) => t.tokenType.name === 'Arrow')).toBe(true);
  });
});
