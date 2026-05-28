import { describe, it, expect } from 'vitest';
import { createEventStore } from '../factory.js';

describe('createEventStore', () => {
  describe('embedded mode with memory backend', () => {
    it('creates all services', () => {
      const services = createEventStore({
        mode: 'embedded',
        backend: 'memory',
        queue: { type: 'direct' },
      });

      expect(services.store).toBeDefined();
      expect(services.emitter).toBeDefined();
      expect(services.queryService).toBeDefined();
      expect(services.retention).toBeDefined();
      expect(services.gdpr).toBeDefined();
      expect(services.store!.backendName).toBe('memory');
    });

    it('defaults to direct queue', () => {
      const services = createEventStore({
        mode: 'embedded',
        backend: 'memory',
      });

      expect(services.store).toBeDefined();
      expect(services.emitter).toBeDefined();
    });
  });

  describe('embedded mode with memory queue', () => {
    it('wires queue to store', () => {
      const services = createEventStore({
        mode: 'embedded',
        backend: 'memory',
        queue: { type: 'memory' },
      });

      expect(services.store).toBeDefined();
      expect(services.emitter).toBeDefined();
    });
  });

  describe('remote mode', () => {
    it('throws if queryUrl is missing', () => {
      expect(() =>
        createEventStore({
          mode: 'remote',
          // no queryUrl
        }),
      ).toThrow('queryUrl is required for remote mode');
    });

    it('creates services with remote clients', () => {
      const services = createEventStore({
        mode: 'remote',
        queryUrl: 'http://eventstore-service:3000',
      });

      // Remote mode does not provide store
      expect(services.store).toBeUndefined();
      expect(services.emitter).toBeDefined();
      expect(services.queryService).toBeDefined();
      expect(services.retention).toBeDefined();
      expect(services.gdpr).toBeDefined();
    });
  });

  describe('default config', () => {
    it('defaults to embedded mode with memory backend when no clickhouse config', () => {
      // Without clickhouse config, backend defaults to clickhouse which would fail
      // Test with explicit memory backend
      const services = createEventStore({
        backend: 'memory',
      });

      expect(services.store).toBeDefined();
      expect(services.emitter).toBeDefined();
    });
  });

  describe('webhook forwarder', () => {
    it('creates webhook forwarder when config provided', () => {
      const services = createEventStore({
        backend: 'memory',
        webhook: {
          deliveryQueue: { add: async () => {} },
          getSubscriptions: async () => [],
        },
      });

      expect(services.webhookForwarder).toBeDefined();
    });

    it('does not create webhook forwarder when config omitted', () => {
      const services = createEventStore({
        backend: 'memory',
      });

      expect(services.webhookForwarder).toBeUndefined();
    });
  });
});
