/**
 * Tests for test helper factories and fixtures.
 */
import { describe, it, expect } from 'vitest';
import {
  createMockRedis,
  createMockAdapter,
  createMockSmartAssistClient,
  sampleTransferPayload,
  sampleTransferSessionData,
  sampleAgentDesktopEventJob,
  sampleAgentEvent,
} from '../helpers/index.js';

describe('test helpers', () => {
  describe('createMockRedis', () => {
    it('returns a working mock Redis instance', async () => {
      const redis = createMockRedis();
      await redis.set('key', 'value');
      const result = await redis.get('key');
      expect(result).toBe('value');
    });
  });

  describe('createMockAdapter', () => {
    it('returns an adapter with default capabilities', () => {
      const adapter = createMockAdapter();
      expect(adapter.name).toBe('mock-adapter');
      expect(adapter.capabilities.supportsPreChecks).toBe(true);
      expect(adapter.capabilities.transportType).toBe('webhook');
    });

    it('allows overriding methods', async () => {
      const adapter = createMockAdapter({
        execute: async () => ({
          success: false,
          status: 'failed' as const,
          error: { code: 'TEST', message: 'fail' },
        }),
      });
      const result = await adapter.execute({} as any);
      expect(result.success).toBe(false);
    });
  });

  describe('createMockSmartAssistClient', () => {
    it('returns successful defaults', async () => {
      const client = createMockSmartAssistClient();
      const result = await client.checkAgentAvailability({} as any);
      expect(result.success).toBe(true);
      expect(result.data).toBe(true);
    });

    it('respects custom options', async () => {
      const client = createMockSmartAssistClient({ availability: false });
      const result = await client.checkAgentAvailability({} as any);
      expect(result.data).toBe(false);
    });

    it('returns custom transfer result', async () => {
      const client = createMockSmartAssistClient({
        transferResult: {
          success: false,
          status: 'no_agents',
          error: { code: 'NO_AGENTS', message: 'No agents available' },
        },
      });
      const result = await client.initTransfer({} as any);
      expect(result.status).toBe('no_agents');
    });
  });

  describe('fixtures', () => {
    it('sampleTransferPayload returns valid payload', () => {
      const payload = sampleTransferPayload();
      expect(payload.tenantId).toBe('tenant-1');
      expect(payload.channel).toBe('chat');
    });

    it('sampleTransferPayload accepts overrides', () => {
      const payload = sampleTransferPayload({ tenantId: 'custom', channel: 'voice' });
      expect(payload.tenantId).toBe('custom');
      expect(payload.channel).toBe('voice');
    });

    it('sampleTransferSessionData returns valid data', () => {
      const data = sampleTransferSessionData();
      expect(data.state).toBe('active');
      expect(data.provider).toBe('kore');
      expect(data.createdAt).toBeGreaterThan(0);
    });

    it('sampleAgentDesktopEventJob returns valid job', () => {
      const job = sampleAgentDesktopEventJob();
      expect(job.eventType).toBe('agent_message');
      expect(job.sessionKey).toContain('agent_transfer:');
    });

    it('sampleAgentEvent returns valid event', () => {
      const event = sampleAgentEvent();
      expect(event.type).toBe('agent:message');
      expect(event.timestamp).toBeTruthy();
    });
  });
});
