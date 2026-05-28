import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { EventRegistry } from '../schema/event-registry.js';

describe('EventRegistry', () => {
  let registry: EventRegistry;

  beforeEach(() => {
    registry = new EventRegistry();
  });

  describe('register()', () => {
    it('registers an event type with schema and metadata', () => {
      const schema = z.object({ channel: z.string() });
      registry.register('session.started', schema, {
        version: '1.0.0',
        category: 'session',
        containsPII: false,
      });

      expect(registry.has('session.started')).toBe(true);
      expect(registry.getEventTypes()).toContain('session.started');
    });

    it('throws on duplicate registration', () => {
      const schema = z.object({ channel: z.string() });
      registry.register('session.started', schema, {
        version: '1.0.0',
        category: 'session',
        containsPII: false,
      });

      expect(() =>
        registry.register('session.started', schema, {
          version: '1.0.0',
          category: 'session',
          containsPII: false,
        }),
      ).toThrow('Event type already registered: session.started');
    });
  });

  describe('validate()', () => {
    beforeEach(() => {
      registry.register(
        'session.started',
        z.object({
          channel: z.string(),
          agent_name: z.string(),
          deployment_id: z.string(),
          resolution_method: z.enum(['new', 'resumed', 'artifact']),
          caller_identity_tier: z.enum(['anonymous', 'identified', 'verified']),
        }),
        { version: '1.0.0', category: 'session', containsPII: false },
      );
    });

    it('validates a correct event', () => {
      const result = registry.validate({
        event_type: 'session.started',
        data: {
          channel: 'web',
          agent_name: 'booking',
          deployment_id: 'deploy-1',
          resolution_method: 'new',
          caller_identity_tier: 'anonymous',
        },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('rejects event with missing required fields', () => {
      const result = registry.validate({
        event_type: 'session.started',
        data: {
          channel: 'web',
          // missing agent_name, deployment_id, etc.
        },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('rejects event with invalid enum value', () => {
      const result = registry.validate({
        event_type: 'session.started',
        data: {
          channel: 'web',
          agent_name: 'booking',
          deployment_id: 'deploy-1',
          resolution_method: 'invalid_method', // not in enum
          caller_identity_tier: 'anonymous',
        },
      });

      expect(result.valid).toBe(false);
    });

    it('rejects event with no event_type', () => {
      const result = registry.validate({ data: {} });

      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toBe('event_type is required');
    });

    it('rejects unknown event type', () => {
      const result = registry.validate({
        event_type: 'unknown.event',
        data: {},
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain('Unknown event type');
    });
  });

  describe('validateData()', () => {
    beforeEach(() => {
      registry.register(
        'tool.call.completed',
        z.object({
          tool_name: z.string(),
          success: z.boolean(),
          latency_ms: z.number(),
        }),
        { version: '1.0.0', category: 'tool', containsPII: false },
      );
    });

    it('parses and returns valid data', () => {
      const data = registry.validateData('tool.call.completed', {
        tool_name: 'search',
        success: true,
        latency_ms: 150,
      });

      expect(data).toEqual({
        tool_name: 'search',
        success: true,
        latency_ms: 150,
      });
    });

    it('throws on invalid data', () => {
      expect(() => registry.validateData('tool.call.completed', { tool_name: 123 })).toThrow();
    });

    it('throws on unknown event type', () => {
      expect(() => registry.validateData('unknown.type', {})).toThrow('Unknown event type');
    });
  });

  describe('safeValidateData()', () => {
    beforeEach(() => {
      registry.register('flow.step.entered', z.object({ step_name: z.string() }), {
        version: '1.0.0',
        category: 'flow',
        containsPII: false,
      });
    });

    it('returns parsed data on valid input', () => {
      const result = registry.safeValidateData('flow.step.entered', { step_name: 'greeting' });
      expect(result).toEqual({ step_name: 'greeting' });
    });

    it('returns undefined on invalid data', () => {
      const result = registry.safeValidateData('flow.step.entered', { step_name: 123 });
      expect(result).toBeUndefined();
    });

    it('returns undefined on unknown event type', () => {
      const result = registry.safeValidateData('unknown.type', {});
      expect(result).toBeUndefined();
    });
  });

  describe('PII event types', () => {
    it('getPIIEventTypes returns only PII-bearing event types', () => {
      registry.register('session.started', z.object({}), {
        version: '1.0.0',
        category: 'session',
        containsPII: false,
      });
      registry.register('channel.message.received', z.object({}), {
        version: '1.0.0',
        category: 'channel',
        containsPII: true,
      });
      registry.register('auth.login', z.object({}), {
        version: '1.0.0',
        category: 'audit',
        containsPII: true,
      });

      const piiTypes = registry.getPIIEventTypes();
      expect(piiTypes).toHaveLength(2);
      expect(piiTypes).toContain('channel.message.received');
      expect(piiTypes).toContain('auth.login');
      expect(piiTypes).not.toContain('session.started');
    });
  });

  describe('getEventTypesByCategory()', () => {
    it('filters event types by category', () => {
      registry.register('session.started', z.object({}), {
        version: '1.0.0',
        category: 'session',
        containsPII: false,
      });
      registry.register('session.ended', z.object({}), {
        version: '1.0.0',
        category: 'session',
        containsPII: false,
      });
      registry.register('llm.call.completed', z.object({}), {
        version: '1.0.0',
        category: 'llm',
        containsPII: false,
      });

      const sessionTypes = registry.getEventTypesByCategory('session');
      expect(sessionTypes).toHaveLength(2);
      expect(sessionTypes).toContain('session.started');
      expect(sessionTypes).toContain('session.ended');
    });
  });

  describe('getMetadata()', () => {
    it('returns metadata for registered event type', () => {
      registry.register('tool.call.completed', z.object({}), {
        version: '2.0.0',
        category: 'tool',
        containsPII: false,
        description: 'Tool call succeeded',
      });

      const meta = registry.getMetadata('tool.call.completed');
      expect(meta).toBeDefined();
      expect(meta!.version).toBe('2.0.0');
      expect(meta!.category).toBe('tool');
      expect(meta!.description).toBe('Tool call succeeded');
    });

    it('returns undefined for unregistered event type', () => {
      expect(registry.getMetadata('unknown')).toBeUndefined();
    });
  });
});
