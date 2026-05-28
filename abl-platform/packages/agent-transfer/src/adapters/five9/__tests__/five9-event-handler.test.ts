import { describe, it, expect } from 'vitest';
import { Five9EventHandler } from '../five9-event-handler.js';

describe('Five9EventHandler', () => {
  describe('mapEventType', () => {
    it('maps agent_message to agent:message', () => {
      expect(Five9EventHandler.mapEventType('agent_message')).toBe('agent:message');
    });

    it('maps agent_connected to agent:connected', () => {
      expect(Five9EventHandler.mapEventType('agent_connected')).toBe('agent:connected');
    });

    it('maps agent_joined to agent:joined', () => {
      expect(Five9EventHandler.mapEventType('agent_joined')).toBe('agent:joined');
    });

    it('maps agent_disconnected to agent:disconnected', () => {
      expect(Five9EventHandler.mapEventType('agent_disconnected')).toBe('agent:disconnected');
    });

    it('maps conversation_queued to agent:queued', () => {
      expect(Five9EventHandler.mapEventType('conversation_queued')).toBe('agent:queued');
    });

    it('maps conversation_closed to agent:disconnected', () => {
      expect(Five9EventHandler.mapEventType('conversation_closed')).toBe('agent:disconnected');
    });

    it('maps agent_typing to agent:typing', () => {
      expect(Five9EventHandler.mapEventType('agent_typing')).toBe('agent:typing');
    });

    it('maps agent_typing_stop to agent:typing_stop', () => {
      expect(Five9EventHandler.mapEventType('agent_typing_stop')).toBe('agent:typing_stop');
    });

    it('returns undefined for unknown event type', () => {
      expect(Five9EventHandler.mapEventType('unknown_event')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(Five9EventHandler.mapEventType('')).toBeUndefined();
    });
  });

  describe('supportedEventTypes', () => {
    it('returns all 8 supported event types', () => {
      const types = Five9EventHandler.supportedEventTypes();
      expect(types).toHaveLength(8);
      expect(types).toContain('agent_message');
      expect(types).toContain('agent_connected');
      expect(types).toContain('agent_joined');
      expect(types).toContain('agent_disconnected');
      expect(types).toContain('conversation_queued');
      expect(types).toContain('conversation_closed');
      expect(types).toContain('agent_typing');
      expect(types).toContain('agent_typing_stop');
    });
  });
});
