/**
 * Structured Logger Tests (RFC-003 Phase 2)
 *
 * Tests for structured logging with correlation IDs.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { StructuredLogger } from '../services/metrics/structured-logger.js';

// =============================================================================
// SETUP
// =============================================================================

const originalConsoleLog = console.log;

beforeEach(() => {
  // Mock console.log to capture output
  console.log = vi.fn();
});

afterEach(() => {
  console.log = originalConsoleLog;
});

// =============================================================================
// TESTS
// =============================================================================

describe('StructuredLogger', () => {
  // ─── Basic Logging ─────────────────────────────────────────────────────────

  describe('Basic Logging', () => {
    test('logs info message', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.info('Test message', { key: 'value' });

      expect(console.log).toHaveBeenCalledOnce();
      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);

      expect(loggedData).toMatchObject({
        level: 'info',
        component: 'TestComponent',
        message: 'Test message',
        metadata: { key: 'value' },
      });

      expect(loggedData.timestamp).toBeDefined();
    });

    test('logs debug message', () => {
      const logger = new StructuredLogger({
        component: 'TestComponent',
        minLevel: 'debug',
        pretty: false,
      });

      logger.debug('Debug message');

      expect(console.log).toHaveBeenCalledOnce();
      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);

      expect(loggedData.level).toBe('debug');
      expect(loggedData.message).toBe('Debug message');
    });

    test('logs warn message', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.warn('Warning message');

      expect(console.log).toHaveBeenCalledOnce();
      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);

      expect(loggedData.level).toBe('warn');
    });

    test('logs error message with Error object', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });
      const error = new Error('Test error');

      logger.error('Error occurred', error);

      expect(console.log).toHaveBeenCalledOnce();
      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);

      expect(loggedData.level).toBe('error');
      expect(loggedData.error).toMatchObject({
        name: 'Error',
        message: 'Test error',
      });
      expect(loggedData.error.stack).toBeDefined();
    });

    test('logs error message with non-Error object', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.error('Error occurred', 'string error');

      expect(console.log).toHaveBeenCalledOnce();
      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);

      expect(loggedData.level).toBe('error');
      expect(loggedData.error).toBeUndefined(); // Non-Error not serialized
    });
  });

  // ─── Log Levels ────────────────────────────────────────────────────────────

  describe('Log Levels', () => {
    test('respects minLevel (info)', () => {
      const logger = new StructuredLogger({
        component: 'TestComponent',
        minLevel: 'info',
        pretty: false,
      });

      logger.debug('Debug message'); // Should NOT log
      expect(console.log).not.toHaveBeenCalled();

      logger.info('Info message'); // Should log
      expect(console.log).toHaveBeenCalledOnce();
    });

    test('respects minLevel (warn)', () => {
      const logger = new StructuredLogger({
        component: 'TestComponent',
        minLevel: 'warn',
        pretty: false,
      });

      logger.debug('Debug message'); // Should NOT log
      logger.info('Info message'); // Should NOT log
      expect(console.log).not.toHaveBeenCalled();

      logger.warn('Warning message'); // Should log
      expect(console.log).toHaveBeenCalledOnce();
    });

    test('respects minLevel (error)', () => {
      const logger = new StructuredLogger({
        component: 'TestComponent',
        minLevel: 'error',
        pretty: false,
      });

      logger.debug('Debug');
      logger.info('Info');
      logger.warn('Warning');
      expect(console.log).not.toHaveBeenCalled();

      logger.error('Error message'); // Should log
      expect(console.log).toHaveBeenCalledOnce();
    });

    test('defaults to info level', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.debug('Debug'); // Should NOT log (below info)
      expect(console.log).not.toHaveBeenCalled();

      logger.info('Info'); // Should log
      expect(console.log).toHaveBeenCalledOnce();
    });
  });

  // ─── Correlation ID ────────────────────────────────────────────────────────

  describe('Correlation ID', () => {
    test('includes correlation ID when provided', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.info('Message', { key: 'value' }, 'corr-123');

      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(loggedData.correlationId).toBe('corr-123');
    });

    test('creates correlated logger with baked-in correlation ID', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });
      const correlated = logger.withCorrelationId('corr-456');

      correlated.info('Message 1');
      correlated.warn('Message 2');

      expect(console.log).toHaveBeenCalledTimes(2);

      const log1 = JSON.parse((console.log as any).mock.calls[0][0]);
      const log2 = JSON.parse((console.log as any).mock.calls[1][0]);

      expect(log1.correlationId).toBe('corr-456');
      expect(log2.correlationId).toBe('corr-456');
    });

    test('correlated logger passes through metadata', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });
      const correlated = logger.withCorrelationId('corr-789');

      correlated.info('Message', { foo: 'bar' });

      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(loggedData.correlationId).toBe('corr-789');
      expect(loggedData.metadata).toEqual({ foo: 'bar' });
    });

    test('correlated logger handles errors', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });
      const correlated = logger.withCorrelationId('corr-error');
      const error = new Error('Test error');

      correlated.error('Error message', error);

      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(loggedData.correlationId).toBe('corr-error');
      expect(loggedData.error.message).toBe('Test error');
    });
  });

  // ─── Metadata ──────────────────────────────────────────────────────────────

  describe('Metadata', () => {
    test('includes metadata in log entry', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.info('Message', {
        userId: 123,
        action: 'search',
        nested: { foo: 'bar' },
      });

      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(loggedData.metadata).toEqual({
        userId: 123,
        action: 'search',
        nested: { foo: 'bar' },
      });
    });

    test('handles undefined metadata', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.info('Message without metadata');

      const loggedData = JSON.parse((console.log as any).mock.calls[0][0]);
      expect(loggedData.metadata).toBeUndefined();
    });
  });

  // ─── Pretty Print ──────────────────────────────────────────────────────────

  describe('Pretty Print', () => {
    test('pretty prints in development mode', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: true });

      logger.info('Test message', { key: 'value' });

      expect(console.log).toHaveBeenCalled();
      const output = (console.log as any).mock.calls[0][0];

      // Pretty output should be a formatted string, not JSON
      expect(typeof output).toBe('string');
      expect(output).toContain('INFO');
      expect(output).toContain('TestComponent');
      expect(output).toContain('Test message');
    });

    test('outputs JSON in production mode', () => {
      const logger = new StructuredLogger({ component: 'TestComponent', pretty: false });

      logger.info('Test message');

      const output = (console.log as any).mock.calls[0][0];

      // Should be valid JSON
      expect(() => JSON.parse(output)).not.toThrow();
    });
  });

  // ─── Component Name ────────────────────────────────────────────────────────

  describe('Component Name', () => {
    test('includes component name in all logs', () => {
      const logger = new StructuredLogger({ component: 'MyComponent', pretty: false });

      logger.debug('Debug', {}, undefined);
      logger.info('Info');
      logger.warn('Warning');
      logger.error('Error');

      // Only info, warn, error should log (debug below minLevel)
      expect(console.log).toHaveBeenCalledTimes(3);

      for (let i = 0; i < 3; i++) {
        const loggedData = JSON.parse((console.log as any).mock.calls[i][0]);
        expect(loggedData.component).toBe('MyComponent');
      }
    });
  });
});
