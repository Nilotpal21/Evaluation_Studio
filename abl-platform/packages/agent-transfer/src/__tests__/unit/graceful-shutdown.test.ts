/**
 * Tests for graceful shutdown handler.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  registerTransferShutdownHandlers,
  type ShutdownComponents,
} from '../../events/graceful-shutdown.js';

beforeAll(() => {
  process.setMaxListeners(20);
});

// Mock createLogger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockComponent() {
  return { close: vi.fn().mockResolvedValue(undefined) };
}

function createMockAdapter(name: string, closeFn?: () => Promise<void>) {
  return {
    name,
    capabilities: {
      supportsPreChecks: false,
      supportsPostAgentDialog: false,
      supportsFileUpload: false,
      supportsTranslation: false,
      transportType: 'webhook' as const,
      authType: 'internal_key' as const,
    },
    initialize: vi.fn(),
    execute: vi.fn(),
    sendUserMessage: vi.fn(),
    endSession: vi.fn(),
    onAgentMessage: vi.fn(),
    onSessionEvent: vi.fn(),
    close: closeFn ? vi.fn().mockImplementation(closeFn) : vi.fn().mockResolvedValue(undefined),
  };
}

describe('registerTransferShutdownHandlers', () => {
  let unregister: () => void;

  afterEach(() => {
    if (unregister) unregister();
  });

  it('returns an unregister function', () => {
    unregister = registerTransferShutdownHandlers({});
    expect(typeof unregister).toBe('function');
  });

  it('closes all components on SIGTERM', async () => {
    const eventQueue = createMockComponent();
    const eventWorker = createMockComponent();
    const sdkQueue = createMockComponent();
    const timeoutScheduler = createMockComponent();

    const components: ShutdownComponents = {
      eventQueue: eventQueue as any,
      eventWorker: eventWorker as any,
      sdkQueue: sdkQueue as any,
      timeoutScheduler: timeoutScheduler as any,
    };

    unregister = registerTransferShutdownHandlers(components);

    // Emit SIGTERM
    process.emit('SIGTERM', 'SIGTERM');

    // Give time for the async shutdown to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(eventWorker.close).toHaveBeenCalledOnce();
    expect(eventQueue.close).toHaveBeenCalledOnce();
    expect(sdkQueue.close).toHaveBeenCalledOnce();
    expect(timeoutScheduler.close).toHaveBeenCalledOnce();
  });

  it('handles missing components gracefully', async () => {
    unregister = registerTransferShutdownHandlers({});
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    // No errors expected
  });

  it('only shuts down once on multiple signals', async () => {
    const eventWorker = createMockComponent();
    const components: ShutdownComponents = { eventWorker: eventWorker as any };

    unregister = registerTransferShutdownHandlers(components);

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGINT', 'SIGINT');

    await new Promise((r) => setTimeout(r, 100));

    expect(eventWorker.close).toHaveBeenCalledOnce();
  });

  it('handles component close timeout', async () => {
    const slowComponent = {
      close: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10_000))),
    };

    const components: ShutdownComponents = { eventWorker: slowComponent as any };
    unregister = registerTransferShutdownHandlers(components);

    process.emit('SIGTERM', 'SIGTERM');

    // Wait longer than the 5s drain timeout
    await new Promise((r) => setTimeout(r, 6_000));

    // The close was called even though it timed out
    expect(slowComponent.close).toHaveBeenCalledOnce();
  }, 10_000);

  it('unregister removes signal listeners', async () => {
    const eventWorker = createMockComponent();
    const components: ShutdownComponents = { eventWorker: eventWorker as any };

    unregister = registerTransferShutdownHandlers(components);
    unregister();

    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 50));

    expect(eventWorker.close).not.toHaveBeenCalled();
  });

  it('closes adapters during shutdown', async () => {
    const adapter1 = createMockAdapter('kore');
    const adapter2 = createMockAdapter('genesys');

    const components: ShutdownComponents = {
      adapters: [adapter1 as any, adapter2 as any],
    };

    unregister = registerTransferShutdownHandlers(components);
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 100));

    expect(adapter1.close).toHaveBeenCalledOnce();
    expect(adapter2.close).toHaveBeenCalledOnce();
  });

  it('closes adapters after workers but before queues', async () => {
    const callOrder: string[] = [];
    const eventWorker = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push('worker');
      }),
    };
    const adapter = createMockAdapter('kore', async () => {
      callOrder.push('adapter');
    });
    const eventQueue = {
      close: vi.fn().mockImplementation(async () => {
        callOrder.push('queue');
      }),
    };

    const components: ShutdownComponents = {
      eventWorker: eventWorker as any,
      adapters: [adapter as any],
      eventQueue: eventQueue as any,
    };

    unregister = registerTransferShutdownHandlers(components);
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 100));

    expect(callOrder).toEqual(['worker', 'adapter', 'queue']);
  });

  it('skips adapters without close method', async () => {
    const adapterWithoutClose = {
      name: 'no-close',
      capabilities: {
        supportsPreChecks: false,
        supportsPostAgentDialog: false,
        supportsFileUpload: false,
        supportsTranslation: false,
        transportType: 'webhook' as const,
        authType: 'internal_key' as const,
      },
      initialize: vi.fn(),
      execute: vi.fn(),
      sendUserMessage: vi.fn(),
      endSession: vi.fn(),
      onAgentMessage: vi.fn(),
      onSessionEvent: vi.fn(),
    };

    const components: ShutdownComponents = {
      adapters: [adapterWithoutClose as any],
    };

    unregister = registerTransferShutdownHandlers(components);
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    // No errors expected — adapter without close is skipped
  });

  it('handles adapter close failure gracefully', async () => {
    const failingAdapter = createMockAdapter('failing', async () => {
      throw new Error('Pool drain failed');
    });

    const eventQueue = createMockComponent();
    const components: ShutdownComponents = {
      adapters: [failingAdapter as any],
      eventQueue: eventQueue as any,
    };

    unregister = registerTransferShutdownHandlers(components);
    process.emit('SIGTERM', 'SIGTERM');
    await new Promise((r) => setTimeout(r, 100));

    // Adapter close was attempted
    expect(failingAdapter.close).toHaveBeenCalledOnce();
    // Queue still closed despite adapter failure
    expect(eventQueue.close).toHaveBeenCalledOnce();
  });
});
