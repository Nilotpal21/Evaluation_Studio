import { describe, expect, it, vi, afterEach } from 'vitest';
import { createLogger } from '../logger.js';

describe('crawler logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes structured log entries to stderr', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = createLogger('crawler-test');

    log.error('Browser cleanup failed', {
      error: 'boom',
      sessionId: 'session-1',
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const payload = writeSpy.mock.calls[0]?.[0];
    expect(typeof payload).toBe('string');

    const entry = JSON.parse((payload as string).trim()) as {
      level: string;
      module: string;
      message: string;
      timestamp: string;
      data?: Record<string, unknown>;
    };

    expect(entry).toMatchObject({
      level: 'error',
      module: 'crawler-test',
      message: 'Browser cleanup failed',
      data: {
        error: 'boom',
        sessionId: 'session-1',
      },
    });
    expect(typeof entry.timestamp).toBe('string');
  });
});
