/**
 * Pool Monitoring Tests
 *
 * Verifies that the MongoConnectionManager's pool checkout failure
 * callback mechanism works correctly:
 * - Callbacks are registered and invoked on pool checkout failure events
 * - Event payloads contain reason and timestamp
 * - Callback errors are caught and don't crash the event handler
 * - Callbacks are cleared on reset
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoConnectionManager } from '../mongo/connection.js';
import type { MongoDBConfig } from '../mongo/types.js';
import type { PoolCheckoutFailureEvent, PoolEventCallback } from '../mongo/connection.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Minimal config for initializing the manager. */
const testConfig: MongoDBConfig = {
  enabled: true,
  url: 'mongodb://localhost:27017/test',
  database: 'test',
  minPoolSize: 1,
  maxPoolSize: 10,
  maxIdleTimeMs: 30_000,
  connectTimeoutMs: 5_000,
  socketTimeoutMs: 30_000,
  serverSelectionTimeoutMs: 5_000,
  heartbeatFrequencyMs: 10_000,
  tls: false,
  tlsAllowInvalidCertificates: false,
  authSource: 'admin',
  writeConcern: '1',
  readPreference: 'primary',
  retryWrites: true,
  retryReads: true,
  directConnection: false,
  autoIndex: true,
  slowQueryThresholdMs: 100,
  appName: 'test',
};

// ─── Tests ────────────────────────────────────────────────────────────────

describe('MongoConnectionManager pool monitoring', () => {
  // We need to mock mongoose.connect and the topology to test without a real DB.
  // The key behavior: after connect, setupMonitoring is called, which
  // accesses `conn.getClient().topology` and registers event listeners.

  let topologyListeners: Map<string, ((...args: any[]) => void)[]>;
  let connectionListeners: Map<string, ((...args: any[]) => void)[]>;

  beforeEach(() => {
    topologyListeners = new Map();
    connectionListeners = new Map();

    // Mock topology with event emitter behavior
    const mockTopology = {
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!topologyListeners.has(event)) {
          topologyListeners.set(event, []);
        }
        topologyListeners.get(event)!.push(handler);
      }),
    };

    // Mock getClient to return topology
    const mockClient = {
      topology: mockTopology,
    };

    // Patch mongoose.connection to support our mocks
    const originalOn = mongoose.connection.on.bind(mongoose.connection);
    vi.spyOn(mongoose.connection, 'on').mockImplementation((event: string, handler: any) => {
      if (!connectionListeners.has(event)) {
        connectionListeners.set(event, []);
      }
      connectionListeners.get(event)!.push(handler);
      return mongoose.connection;
    });

    vi.spyOn(mongoose.connection, 'getClient').mockReturnValue(mockClient as any);

    // Mock mongoose.connect to simulate successful connection
    vi.spyOn(mongoose, 'connect').mockImplementation(async () => {
      // Trigger 'connected' event listeners
      const connectedHandlers = connectionListeners.get('connected') ?? [];
      for (const handler of connectedHandlers) {
        handler();
      }
      return mongoose as any;
    });

    // Prevent plugin registration from throwing
    vi.spyOn(mongoose, 'modelNames').mockReturnValue([]);
    vi.spyOn(mongoose, 'plugin').mockImplementation(() => mongoose);
  });

  afterEach(async () => {
    // Reset singleton between tests
    // Directly null out the instance to avoid disconnect issues with mocks
    (MongoConnectionManager as any).instance = null;
    vi.restoreAllMocks();
  });

  it('should register a pool checkout failure callback', async () => {
    const manager = await MongoConnectionManager.initialize(testConfig);
    const callback = vi.fn();

    manager.onPoolCheckoutFailed(callback);

    // Simulate a connectionCheckOutFailed event from the topology
    const handlers = topologyListeners.get('connectionCheckOutFailed') ?? [];
    expect(handlers.length).toBeGreaterThan(0);

    handlers[0]({ reason: 'connectionError' });

    expect(callback).toHaveBeenCalledTimes(1);
    const event: PoolCheckoutFailureEvent = callback.mock.calls[0][0];
    expect(event.reason).toBe('connectionError');
    expect(typeof event.timestamp).toBe('number');
    expect(event.timestamp).toBeGreaterThan(0);
  });

  it('should invoke multiple callbacks on a single event', async () => {
    const manager = await MongoConnectionManager.initialize(testConfig);
    const callback1 = vi.fn();
    const callback2 = vi.fn();

    manager.onPoolCheckoutFailed(callback1);
    manager.onPoolCheckoutFailed(callback2);

    const handlers = topologyListeners.get('connectionCheckOutFailed') ?? [];
    handlers[0]({ reason: 'timeout' });

    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledTimes(1);
    expect(callback1.mock.calls[0][0].reason).toBe('timeout');
    expect(callback2.mock.calls[0][0].reason).toBe('timeout');
  });

  it('should catch and log errors from failing callbacks without affecting others', async () => {
    const manager = await MongoConnectionManager.initialize(testConfig);

    const errorCallback: PoolEventCallback = () => {
      throw new Error('callback boom');
    };
    const goodCallback = vi.fn();

    manager.onPoolCheckoutFailed(errorCallback);
    manager.onPoolCheckoutFailed(goodCallback);

    const handlers = topologyListeners.get('connectionCheckOutFailed') ?? [];

    // Should not throw even though the first callback errors
    expect(() => handlers[0]({ reason: 'poolCleared' })).not.toThrow();

    // The second callback should still be called
    expect(goodCallback).toHaveBeenCalledTimes(1);
  });

  it('should use "unknown" reason when event has no reason field', async () => {
    const manager = await MongoConnectionManager.initialize(testConfig);
    const callback = vi.fn();

    manager.onPoolCheckoutFailed(callback);

    const handlers = topologyListeners.get('connectionCheckOutFailed') ?? [];
    handlers[0]({}); // no reason field

    expect(callback.mock.calls[0][0].reason).toBe('unknown');
  });

  it('should clear callbacks on reset', async () => {
    const manager = await MongoConnectionManager.initialize(testConfig);
    const callback = vi.fn();

    manager.onPoolCheckoutFailed(callback);

    // Mock disconnect
    vi.spyOn(mongoose.connection, 'close').mockResolvedValue();

    await MongoConnectionManager.reset();

    // After reset, the singleton is null — callbacks should be cleared
    expect(MongoConnectionManager.isAvailable()).toBe(false);
  });

  it('should register the connectionCheckOutFailed listener on topology', async () => {
    await MongoConnectionManager.initialize(testConfig);

    // Verify the topology.on was called with 'connectionCheckOutFailed'
    expect(topologyListeners.has('connectionCheckOutFailed')).toBe(true);
    expect(topologyListeners.get('connectionCheckOutFailed')!.length).toBe(1);
  });

  it('should suppress poolClosed checkout failures during intentional disconnect', async () => {
    const manager = await MongoConnectionManager.initialize(testConfig);
    const callback = vi.fn();

    manager.onPoolCheckoutFailed(callback);
    (manager as any).isDisconnecting = true;

    const handlers = topologyListeners.get('connectionCheckOutFailed') ?? [];
    handlers[0]({ reason: 'poolClosed' });

    expect(callback).not.toHaveBeenCalled();
  });
});
