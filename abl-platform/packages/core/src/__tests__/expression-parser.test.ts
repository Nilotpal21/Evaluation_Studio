/**
 * Expression Parser Tests
 */

import { describe, test, expect } from 'vitest';
import {
  parseExpression,
  parseCondition,
  expressionToPython,
} from '../parser/expression-parser.js';

describe('Expression Parser', () => {
  describe('parseExpression', () => {
    test('should parse simple variable reference', () => {
      const expr = parseExpression('user.is_validated');
      expect(expr.kind).toBe('variable');
      expect((expr as any).path).toEqual(['user', 'is_validated']);
    });

    test('should parse string literal', () => {
      const expr = parseExpression('"hello"');
      expect(expr.kind).toBe('string');
      expect((expr as any).value).toBe('hello');
    });

    test('should parse number literal', () => {
      const expr = parseExpression('42');
      expect(expr.kind).toBe('number');
      expect((expr as any).value).toBe(42);
    });

    test('should parse boolean literal', () => {
      const trueExpr = parseExpression('true');
      expect(trueExpr.kind).toBe('boolean');
      expect((trueExpr as any).value).toBe(true);

      const falseExpr = parseExpression('false');
      expect(falseExpr.kind).toBe('boolean');
      expect((falseExpr as any).value).toBe(false);
    });

    test('should parse comparison expression', () => {
      const expr = parseExpression('user.age >= 18');
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('>=');
    });

    test('should parse equality expression', () => {
      const expr = parseExpression('status == "active"');
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('==');
    });

    test('should ignore comparison operators inside quoted string literals', () => {
      const expr = parseExpression('message >= "status == active"');
      expect(expr).toMatchObject({
        kind: 'binary',
        operator: '>=',
        left: { kind: 'variable', path: ['message'] },
        right: { kind: 'string', value: 'status == active' },
      });
    });

    test('should parse NOT IN as a not_in comparison', () => {
      const expr = parseExpression('user.role NOT IN ["admin", "moderator"]');
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('not_in');
      expect((expr as any).left).toEqual({
        kind: 'variable',
        path: ['user', 'role'],
      });
    });

    test('should parse NOT expression', () => {
      const expr = parseExpression('NOT user.is_validated');
      expect(expr.kind).toBe('unary');
      expect((expr as any).operator).toBe('not');
    });

    test('should parse AND expression', () => {
      const expr = parseExpression('user.is_validated AND user.age >= 18');
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('and');
    });

    test('should parse OR expression', () => {
      const expr = parseExpression('user.role == "admin" OR user.role == "moderator"');
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('or');
    });

    test('should ignore operators inside string literals when splitting expressions', () => {
      const expr = parseExpression('title == "A OR B" AND status == "ready"');
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('and');
      expect((expr as any).left).toMatchObject({
        kind: 'binary',
        operator: '==',
        left: { kind: 'variable', path: ['title'] },
        right: { kind: 'string', value: 'A OR B' },
      });
      expect((expr as any).right).toMatchObject({
        kind: 'binary',
        operator: '==',
        left: { kind: 'variable', path: ['status'] },
        right: { kind: 'string', value: 'ready' },
      });
    });

    test('should close strings after double-escaped trailing backslashes', () => {
      const expr = parseExpression(String.raw`title == "test\\\\" AND status == "ready"`);
      expect(expr).toMatchObject({
        kind: 'binary',
        operator: 'and',
        left: {
          kind: 'binary',
          operator: '==',
          left: { kind: 'variable', path: ['title'] },
          right: { kind: 'string', value: String.raw`test\\\\` },
        },
        right: {
          kind: 'binary',
          operator: '==',
          left: { kind: 'variable', path: ['status'] },
          right: { kind: 'string', value: 'ready' },
        },
      });
    });

    test('should parse IS SET expression', () => {
      const expr = parseExpression('conversation.active_agent IS SET');
      expect(expr.kind).toBe('unary');
      expect((expr as any).operator).toBe('exists');
    });

    test('should parse IS NOT SET expression', () => {
      const expr = parseExpression('user.email IS NOT SET');
      expect(expr.kind).toBe('unary');
      expect((expr as any).operator).toBe('not');
    });

    test('should parse complex nested expression', () => {
      const expr = parseExpression(
        '(user.is_validated AND user.age >= 18) OR user.role == "admin"',
      );
      expect(expr.kind).toBe('binary');
      expect((expr as any).operator).toBe('or');
    });

    test('should parse function call', () => {
      const expr = parseExpression('verify_identity(cedula)');
      expect(expr.kind).toBe('function');
      expect((expr as any).name).toBe('verify_identity');
    });
  });

  describe('parseCondition', () => {
    test('should parse wildcard condition', () => {
      const expr = parseCondition('*');
      expect(expr.kind).toBe('wildcard');
    });
  });

  describe('expressionToPython', () => {
    test('should convert variable reference to Python', () => {
      const expr = parseExpression('user.is_validated');
      const python = expressionToPython(expr);
      expect(python).toBe('state["user"]["is_validated"]');
    });

    test('should convert string literal to Python', () => {
      const expr = parseExpression('"hello"');
      const python = expressionToPython(expr);
      expect(python).toBe('"hello"');
    });

    test('should convert number literal to Python', () => {
      const expr = parseExpression('42');
      const python = expressionToPython(expr);
      expect(python).toBe('42');
    });

    test('should convert boolean literal to Python', () => {
      const trueExpr = parseExpression('true');
      expect(expressionToPython(trueExpr)).toBe('True');

      const falseExpr = parseExpression('false');
      expect(expressionToPython(falseExpr)).toBe('False');
    });

    test('should convert comparison to Python', () => {
      const expr = parseExpression('user.age >= 18');
      const python = expressionToPython(expr);
      expect(python).toContain('>=');
      expect(python).toContain('18');
    });

    test('should swap operands for CONTAINS when converting to Python', () => {
      const expr = parseExpression('path.items CONTAINS selected.item');
      expect(expressionToPython(expr)).toBe(
        '(state["selected"]["item"] in state["path"]["items"])',
      );
    });

    test('should convert NOT to Python', () => {
      const expr = parseExpression('NOT user.is_validated');
      const python = expressionToPython(expr);
      expect(python).toContain('not');
    });

    test('should convert AND to Python', () => {
      const expr = parseExpression('a AND b');
      const python = expressionToPython(expr);
      expect(python).toContain('and');
    });

    test('should convert OR to Python', () => {
      const expr = parseExpression('a OR b');
      const python = expressionToPython(expr);
      expect(python).toContain('or');
    });

    test('should convert IS SET to Python', () => {
      const expr = parseExpression('conversation.active_agent IS SET');
      const python = expressionToPython(expr);
      expect(python).toContain('is not None');
    });

    test('should convert wildcard to Python', () => {
      const expr = parseCondition('*');
      const python = expressionToPython(expr);
      expect(python).toBe('True');
    });

    test('should convert function call to Python', () => {
      const expr = parseExpression('verify_identity(cedula)');
      const python = expressionToPython(expr);
      expect(python).toContain('verify_identity');
    });

    test('should throw on unknown unary operators', () => {
      const invalidExpr = {
        kind: 'unary',
        operator: 'mystery',
        operand: { kind: 'variable', path: ['user', 'status'] },
      } as unknown as Parameters<typeof expressionToPython>[0];

      expect(() => expressionToPython(invalidExpr)).toThrow('Unknown unary operator: mystery');
    });
  });
});
