import { describe, expect, it, vi } from 'vitest';
import { SessionEndHookRunner } from '../end-hook-runner.js';

describe('SessionEndHookRunner', () => {
  it('returns ignored for ignore hooks', async () => {
    const runner = new SessionEndHookRunner();

    await expect(
      runner.run({
        config: { mode: 'ignore' },
        sessionId: 'sess-1',
        disposition: 'completed',
        source: 'close_api',
      }),
    ).resolves.toEqual({
      attempted: true,
      mode: 'ignore',
      outcome: 'ignored',
    });
  });

  it('skips respond hooks when no sender is available', async () => {
    const runner = new SessionEndHookRunner();

    await expect(
      runner.run({
        config: { mode: 'respond', message: 'Conversation closed.' },
        sessionId: 'sess-2',
        disposition: 'completed',
        source: 'disconnect',
      }),
    ).resolves.toEqual({
      attempted: true,
      mode: 'respond',
      outcome: 'skipped',
    });
  });

  it('sends respond hooks through the provided sender', async () => {
    const sendResponse = vi.fn(async () => {});
    const runner = new SessionEndHookRunner();

    await expect(
      runner.run({
        config: { mode: 'respond', message: 'Conversation closed.' },
        sessionId: 'sess-3',
        channel: 'web_chat',
        disposition: 'completed',
        source: 'sdk_end_session',
        sendResponse,
      }),
    ).resolves.toEqual({
      attempted: true,
      mode: 'respond',
      outcome: 'sent',
    });

    expect(sendResponse).toHaveBeenCalledWith('Conversation closed.');
  });

  it('fails open when the sender throws', async () => {
    const runner = new SessionEndHookRunner();

    await expect(
      runner.run({
        config: { mode: 'respond', message: 'Conversation closed.' },
        sessionId: 'sess-4',
        channel: 'web_chat',
        disposition: 'completed',
        source: 'sdk_end_session',
        sendResponse: vi.fn(async () => {
          throw new Error('socket unavailable');
        }),
      }),
    ).resolves.toEqual({
      attempted: true,
      mode: 'respond',
      outcome: 'failed',
      error: 'socket unavailable',
    });
  });
});
