import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockInitChannelQueues,
  mockCloseChannelQueues,
  mockInitPromoteContextQueue,
  mockClosePromoteContextQueue,
  mockStartInboundWorker,
  mockStopInboundWorker,
  mockStartDeliveryWorker,
  mockStopDeliveryWorker,
  mockStartPromoteContextWorker,
  mockStopPromoteContextWorker,
} = vi.hoisted(() => ({
  mockInitChannelQueues: vi.fn(),
  mockCloseChannelQueues: vi.fn(),
  mockInitPromoteContextQueue: vi.fn(),
  mockClosePromoteContextQueue: vi.fn(),
  mockStartInboundWorker: vi.fn(),
  mockStopInboundWorker: vi.fn(),
  mockStartDeliveryWorker: vi.fn(),
  mockStopDeliveryWorker: vi.fn(),
  mockStartPromoteContextWorker: vi.fn(),
  mockStopPromoteContextWorker: vi.fn(),
}));

vi.mock('../services/queues/channel-queues.js', () => ({
  initChannelQueues: (...args: unknown[]) => mockInitChannelQueues(...args),
  closeChannelQueues: (...args: unknown[]) => mockCloseChannelQueues(...args),
}));

vi.mock('../services/queues/promote-context-producer.js', () => ({
  initPromoteContextQueue: (...args: unknown[]) => mockInitPromoteContextQueue(...args),
  closePromoteContextQueue: (...args: unknown[]) => mockClosePromoteContextQueue(...args),
}));

vi.mock('../services/queues/inbound-worker.js', () => ({
  startInboundWorker: (...args: unknown[]) => mockStartInboundWorker(...args),
  stopInboundWorker: (...args: unknown[]) => mockStopInboundWorker(...args),
}));

vi.mock('../services/queues/delivery-worker.js', () => ({
  startDeliveryWorker: (...args: unknown[]) => mockStartDeliveryWorker(...args),
  stopDeliveryWorker: (...args: unknown[]) => mockStopDeliveryWorker(...args),
}));

vi.mock('../services/queues/promote-context-worker.js', () => ({
  startPromoteContextWorker: (...args: unknown[]) => mockStartPromoteContextWorker(...args),
  stopPromoteContextWorker: (...args: unknown[]) => mockStopPromoteContextWorker(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('channel queue lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInitChannelQueues.mockResolvedValue(true);
    mockCloseChannelQueues.mockResolvedValue(undefined);
    mockInitPromoteContextQueue.mockResolvedValue(undefined);
    mockClosePromoteContextQueue.mockResolvedValue(undefined);
    mockStartInboundWorker.mockResolvedValue(undefined);
    mockStopInboundWorker.mockResolvedValue(undefined);
    mockStartDeliveryWorker.mockResolvedValue(undefined);
    mockStopDeliveryWorker.mockResolvedValue(undefined);
    mockStartPromoteContextWorker.mockResolvedValue(undefined);
    mockStopPromoteContextWorker.mockResolvedValue(undefined);
  });

  it('closes initialized queues even when worker startup fails before workers are marked started', async () => {
    mockStartDeliveryWorker.mockRejectedValueOnce(new Error('delivery worker unavailable'));
    const { startChannelQueues, stopChannelQueues } = await import('../services/queues/index.js');

    await startChannelQueues();
    await stopChannelQueues();

    expect(mockInitChannelQueues).toHaveBeenCalledOnce();
    expect(mockStartInboundWorker).toHaveBeenCalledOnce();
    expect(mockStartDeliveryWorker).toHaveBeenCalledOnce();
    expect(mockStartPromoteContextWorker).not.toHaveBeenCalled();
    expect(mockClosePromoteContextQueue).toHaveBeenCalledOnce();
    expect(mockCloseChannelQueues).toHaveBeenCalledOnce();
  });

  it('stops all workers before closing queues after a successful startup', async () => {
    const { startChannelQueues, stopChannelQueues } = await import('../services/queues/index.js');

    await startChannelQueues();
    await stopChannelQueues();

    expect(mockStopInboundWorker).toHaveBeenCalledOnce();
    expect(mockStopDeliveryWorker).toHaveBeenCalledOnce();
    expect(mockStopPromoteContextWorker).toHaveBeenCalledOnce();
    expect(mockClosePromoteContextQueue).toHaveBeenCalledOnce();
    expect(mockCloseChannelQueues).toHaveBeenCalledOnce();
  });
});
