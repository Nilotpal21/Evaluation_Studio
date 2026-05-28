import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AgentTransferConfigReloader,
  type RedisSubscriber,
  type RedisPublisher,
  type ConfigReloadCallback,
} from '../../config/config-reloader.js';
import type { AgentTransferConfig } from '../../config/schema.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockSubscriber(): RedisSubscriber & { _trigger: (ch: string, msg: string) => void } {
  let handler: ((channel: string, message: string) => void) | null = null;
  return {
    subscribe: vi.fn().mockResolvedValue(undefined),
    on: vi
      .fn()
      .mockImplementation((_event: string, cb: (channel: string, message: string) => void) => {
        handler = cb;
      }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    _trigger(ch: string, msg: string) {
      handler?.(ch, msg);
    },
  };
}

const VALID_CONFIG: AgentTransferConfig = {
  session: {
    ttl: { chat: 1800, email: 14400, voice: 0, messaging: 1800, campaign: 3600, default: 1800 },
    maxConcurrentPerContact: 1,
    cleanupBatchSize: 100,
  },
  providers: [],
  voice: {
    type: 'korevg',
    sipDefaults: { transferMethod: 'invite', headerPassthrough: true },
    recording: { enabled: false, orgLevelCheck: true },
  },
  identity: { mapAgentIdToBotId: true, mapContactIdToUserId: true },
  pii: { deTokenizeBeforeTransfer: true, detectionPattern: '\\{\\{pii\\..*?\\}\\}' },
  analytics: { emitTraceEvents: true, trackContainment: true, trackDialogTone: false },
};

describe('AgentTransferConfigReloader', () => {
  let subscriber: ReturnType<typeof createMockSubscriber>;
  let onReload: ConfigReloadCallback;
  let reloader: AgentTransferConfigReloader;

  beforeEach(() => {
    subscriber = createMockSubscriber();
    onReload = vi.fn();
    reloader = new AgentTransferConfigReloader(subscriber, onReload);
  });

  it('start() subscribes to at_config_reload channel', async () => {
    await reloader.start();
    expect(subscriber.subscribe).toHaveBeenCalledWith('at_config_reload');
    expect(subscriber.on).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('stop() unsubscribes', async () => {
    await reloader.start();
    await reloader.stop();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('at_config_reload');
  });

  it('valid config triggers onReload callback', async () => {
    await reloader.start();
    subscriber._trigger('at_config_reload', JSON.stringify(VALID_CONFIG));

    // Wait for async handler
    await new Promise((r) => setTimeout(r, 10));
    expect(onReload).toHaveBeenCalledWith(expect.objectContaining({ providers: [] }));
  });

  it('invalid JSON logs warning, does not call onReload', async () => {
    await reloader.start();
    subscriber._trigger('at_config_reload', 'not-json{{{');

    await new Promise((r) => setTimeout(r, 10));
    expect(onReload).not.toHaveBeenCalled();
  });

  it('failed Zod validation logs warning, keeps old config', async () => {
    await reloader.start();
    // Valid JSON but missing required fields for schema validation
    subscriber._trigger('at_config_reload', JSON.stringify({ session: { ttl: 'invalid' } }));

    await new Promise((r) => setTimeout(r, 10));
    expect(onReload).not.toHaveBeenCalled();
  });

  it('callback errors are caught and logged', async () => {
    const errorReload = vi.fn().mockRejectedValue(new Error('callback failed'));
    const r = new AgentTransferConfigReloader(subscriber, errorReload);
    await r.start();

    subscriber._trigger('at_config_reload', JSON.stringify(VALID_CONFIG));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should not throw
    expect(errorReload).toHaveBeenCalled();
  });

  it('start() is idempotent', async () => {
    await reloader.start();
    await reloader.start();
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores messages on other channels', async () => {
    await reloader.start();
    subscriber._trigger('some_other_channel', JSON.stringify(VALID_CONFIG));

    await new Promise((r) => setTimeout(r, 10));
    expect(onReload).not.toHaveBeenCalled();
  });

  it('triggerReload publishes config to channel', async () => {
    const publisher: RedisPublisher = {
      publish: vi.fn().mockResolvedValue(1),
    };

    await AgentTransferConfigReloader.triggerReload(publisher, VALID_CONFIG);
    expect(publisher.publish).toHaveBeenCalledWith(
      'at_config_reload',
      JSON.stringify(VALID_CONFIG),
    );
  });
});
