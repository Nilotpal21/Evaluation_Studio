import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, setLogHandler, type LogEntry } from '../logger.js';

describe('createLogger', () => {
  const capturedEntries: LogEntry[] = [];

  afterEach(() => {
    setLogHandler(null);
    capturedEntries.length = 0;
  });

  it('returns a Logger with all expected methods', () => {
    const log = createLogger('test-module');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  it('writes structured log output', () => {
    setLogHandler((entry) => capturedEntries.push(entry));
    const log = createLogger('my-module');
    log.info('hello world', { key: 'value' });
    expect(capturedEntries).toMatchObject([
      { level: 'info', module: 'my-module', message: 'hello world', data: { key: 'value' } },
    ]);
  });

  it('creates child loggers with additional metadata', () => {
    setLogHandler((entry) => capturedEntries.push(entry));
    const log = createLogger('parent');
    const child = log.child({ requestId: '123' });
    child.info('child message');
    expect(capturedEntries[0]).toMatchObject({
      module: 'parent',
      message: 'child message',
      data: { requestId: '123' },
    });
  });

  it('redacts sensitive fields', () => {
    setLogHandler((entry) => capturedEntries.push(entry));
    const log = createLogger('security-test');
    log.info('creds', { password: 'secret123', safe: 'visible' });
    expect(capturedEntries[0]?.data).toMatchObject({ password: '[REDACTED]', safe: 'visible' });
  });

  it('accepts optional default metadata', () => {
    setLogHandler((entry) => capturedEntries.push(entry));
    const log = createLogger('meta-test', { service: 'auth' });
    log.info('with metadata');
    expect(capturedEntries[0]?.data).toMatchObject({ service: 'auth' });
  });
});
