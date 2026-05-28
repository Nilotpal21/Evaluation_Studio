import { describe, it, expect } from 'vitest';
import {
  getCategoryFromEventType,
  getCategoryLabel,
  EVENT_CATEGORIES,
} from '../schema/event-categories.js';

describe('event-categories', () => {
  describe('getCategoryFromEventType()', () => {
    it('maps billing events', () => {
      expect(getCategoryFromEventType('billing.usage.updated')).toBe('billing');
    });

    it('maps session events', () => {
      expect(getCategoryFromEventType('session.started')).toBe('session');
      expect(getCategoryFromEventType('session.ended')).toBe('session');
      expect(getCategoryFromEventType('session.resumed')).toBe('session');
    });

    it('maps llm events', () => {
      expect(getCategoryFromEventType('llm.call.completed')).toBe('llm');
      expect(getCategoryFromEventType('llm.call.failed')).toBe('llm');
    });

    it('maps tool events', () => {
      expect(getCategoryFromEventType('tool.call.completed')).toBe('tool');
      expect(getCategoryFromEventType('tool.call.failed')).toBe('tool');
    });

    it('maps agent events', () => {
      expect(getCategoryFromEventType('agent.entered')).toBe('agent');
      expect(getCategoryFromEventType('agent.handoff')).toBe('agent');
      expect(getCategoryFromEventType('agent.escalated')).toBe('agent');
    });

    it('maps gather events', () => {
      expect(getCategoryFromEventType('gather.started')).toBe('gather');
      expect(getCategoryFromEventType('gather.field_collected')).toBe('gather');
    });

    it('maps flow events', () => {
      expect(getCategoryFromEventType('flow.step.entered')).toBe('flow');
      expect(getCategoryFromEventType('flow.transition')).toBe('flow');
    });

    it('maps channel events', () => {
      expect(getCategoryFromEventType('channel.message.received')).toBe('channel');
      expect(getCategoryFromEventType('channel.response.sent')).toBe('channel');
    });

    it('maps attachment events', () => {
      expect(getCategoryFromEventType('attachment.uploaded')).toBe('attachment');
      expect(getCategoryFromEventType('attachment.preprocessed')).toBe('attachment');
    });

    it('maps deployment events', () => {
      expect(getCategoryFromEventType('deployment.created')).toBe('deployment');
    });

    it('maps search events', () => {
      expect(getCategoryFromEventType('search.query.executed')).toBe('search');
    });

    it('maps voice events', () => {
      expect(getCategoryFromEventType('voice.call.initiated')).toBe('voice');
    });

    it('maps auth events to audit category', () => {
      expect(getCategoryFromEventType('auth.login')).toBe('audit');
      expect(getCategoryFromEventType('audit.permission.changed')).toBe('audit');
    });

    it('returns system for unknown prefixes', () => {
      expect(getCategoryFromEventType('unknown.something')).toBe('system');
      expect(getCategoryFromEventType('custom.event')).toBe('system');
    });
  });

  describe('getCategoryLabel()', () => {
    it('returns human-readable labels', () => {
      expect(getCategoryLabel('billing')).toBe('Billing');
      expect(getCategoryLabel('session')).toBe('Sessions');
      expect(getCategoryLabel('llm')).toBe('LLM Calls');
      expect(getCategoryLabel('tool')).toBe('Tool Calls');
      expect(getCategoryLabel('attachment')).toBe('Attachments');
      expect(getCategoryLabel('agent')).toBe('Agent Routing');
      expect(getCategoryLabel('gather')).toBe('Data Collection');
      expect(getCategoryLabel('flow')).toBe('Flow Execution');
      expect(getCategoryLabel('channel')).toBe('Channels');
      expect(getCategoryLabel('deployment')).toBe('Deployments');
      expect(getCategoryLabel('search')).toBe('Search');
      expect(getCategoryLabel('voice')).toBe('Voice');
      expect(getCategoryLabel('audit')).toBe('Audit & Auth');
      expect(getCategoryLabel('system')).toBe('System');
    });
  });

  describe('EVENT_CATEGORIES', () => {
    it('contains all supported categories', () => {
      const values = Object.values(EVENT_CATEGORIES);
      const expectedCategories = [
        'billing',
        'session',
        'message',
        'attachment',
        'llm',
        'tool',
        'agent',
        'gather',
        'flow',
        'channel',
        'deployment',
        'search',
        'voice',
        'audit',
        'evaluation',
        'feedback',
        'system',
      ];

      expect(values).toHaveLength(expectedCategories.length);
      expect(new Set(values).size).toBe(expectedCategories.length);
      expect(values).toEqual(expect.arrayContaining(expectedCategories));
    });
  });
});
