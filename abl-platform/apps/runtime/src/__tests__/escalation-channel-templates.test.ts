/**
 * Escalation Channel Templates — Tests
 *
 * Verifies that escalation messages are resolved per-channel:
 * - Channel-specific templates (msteams, slack, whatsapp, messenger) produce correct output
 * - Voice channels get voice template
 * - Web/digital channels get digital template
 * - Unknown channels fall back to plain
 * - DB/project overrides take precedence
 * - IR escalation_format overrides everything
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { PromptTemplateLoader } from '../services/execution/prompt-template-loader';
import { PromptCatalog } from '../services/execution/prompt-catalog';
import { interpolateTemplate } from '../services/execution/value-resolution';

describe('Escalation Channel Templates', () => {
  let loader: PromptTemplateLoader;

  beforeEach(() => {
    loader = new PromptTemplateLoader();
  });

  // ===========================================================================
  // resolveEscalationChannel
  // ===========================================================================

  describe('resolveEscalationChannel', () => {
    test('returns "plain" when no channel type provided', () => {
      expect(loader.resolveEscalationChannel()).toBe('plain');
      expect(loader.resolveEscalationChannel(undefined)).toBe('plain');
    });

    test('maps msteams to msteams', () => {
      expect(loader.resolveEscalationChannel('msteams')).toBe('msteams');
    });

    test('maps slack to slack', () => {
      expect(loader.resolveEscalationChannel('slack')).toBe('slack');
    });

    test('maps whatsapp to whatsapp', () => {
      expect(loader.resolveEscalationChannel('whatsapp')).toBe('whatsapp');
    });

    test('maps messenger to messenger', () => {
      expect(loader.resolveEscalationChannel('messenger')).toBe('messenger');
    });

    test('maps instagram to messenger (same platform)', () => {
      expect(loader.resolveEscalationChannel('instagram')).toBe('messenger');
    });

    test('maps voice channels to voice', () => {
      expect(loader.resolveEscalationChannel('voice')).toBe('voice');
      expect(loader.resolveEscalationChannel('voice_twilio')).toBe('voice');
      expect(loader.resolveEscalationChannel('voice_livekit')).toBe('voice');
      expect(loader.resolveEscalationChannel('vxml')).toBe('voice');
      expect(loader.resolveEscalationChannel('audiocodes')).toBe('voice');
    });

    test('maps web channels to digital', () => {
      expect(loader.resolveEscalationChannel('web_chat')).toBe('digital');
      expect(loader.resolveEscalationChannel('web_debug')).toBe('digital');
      expect(loader.resolveEscalationChannel('sdk_websocket')).toBe('digital');
      expect(loader.resolveEscalationChannel('http_async')).toBe('digital');
      expect(loader.resolveEscalationChannel('ag_ui')).toBe('digital');
    });

    test('maps telegram and line to digital', () => {
      expect(loader.resolveEscalationChannel('telegram')).toBe('digital');
      expect(loader.resolveEscalationChannel('line')).toBe('digital');
      expect(loader.resolveEscalationChannel('email')).toBe('digital');
    });

    test('maps web and digital channel types to digital', () => {
      expect(loader.resolveEscalationChannel('web')).toBe('digital');
      expect(loader.resolveEscalationChannel('digital')).toBe('digital');
    });

    test('returns "plain" for unknown channels', () => {
      expect(loader.resolveEscalationChannel('unknown')).toBe('plain');
      expect(loader.resolveEscalationChannel('api')).toBe('plain');
      expect(loader.resolveEscalationChannel('http')).toBe('plain');
    });

    test('maps legacy voice websocket channels to voice', () => {
      expect(loader.resolveEscalationChannel('korevg')).toBe('voice');
    });
  });

  // ===========================================================================
  // getEscalation with channel-specific templates
  // ===========================================================================

  describe('getEscalation', () => {
    test('returns msteams template for msteams channel', () => {
      const template = loader.getEscalation('msteams');
      expect(template).toBe(PromptCatalog.escalation.msteams);
      expect(template).toContain('{{reason}}');
      expect(template).toContain('{{priority}}');
    });

    test('returns slack template for slack channel', () => {
      const template = loader.getEscalation('slack');
      expect(template).toBe(PromptCatalog.escalation.slack);
      expect(template).toContain('{{reason}}');
      expect(template).toContain('{{priority}}');
    });

    test('returns whatsapp template for whatsapp channel', () => {
      const template = loader.getEscalation('whatsapp');
      expect(template).toBe(PromptCatalog.escalation.whatsapp);
      expect(template).toContain('{{reason}}');
    });

    test('returns messenger template for messenger channel', () => {
      const template = loader.getEscalation('messenger');
      expect(template).toBe(PromptCatalog.escalation.messenger);
      expect(template).toContain('{{reason}}');
    });

    test('preserves existing digital/voice/plain templates', () => {
      expect(loader.getEscalation('digital')).toBe(PromptCatalog.escalation.digital);
      expect(loader.getEscalation('voice')).toBe(PromptCatalog.escalation.voice);
      expect(loader.getEscalation('plain')).toBe(PromptCatalog.escalation.plain);
    });

    test('DB-loaded entries override channel-specific templates', () => {
      loader.loadFromEntries([
        { key: 'escalation.msteams', content: 'Custom Teams escalation: {{reason}}' },
      ]);
      expect(loader.getEscalation('msteams')).toBe('Custom Teams escalation: {{reason}}');
      // Other channels unaffected
      expect(loader.getEscalation('slack')).toBe(PromptCatalog.escalation.slack);
    });

    test('legacy plain-only DB override applies to all channels without channel-specific override', () => {
      loader.loadFromEntries([
        { key: 'escalation.plain', content: 'Custom tenant escalation: {{reason}}' },
      ]);
      // Channels without their own DB override should fall back to the plain DB override
      expect(loader.getEscalation('slack')).toBe('Custom tenant escalation: {{reason}}');
      expect(loader.getEscalation('msteams')).toBe('Custom tenant escalation: {{reason}}');
      expect(loader.getEscalation('digital')).toBe('Custom tenant escalation: {{reason}}');
      expect(loader.getEscalation('voice')).toBe('Custom tenant escalation: {{reason}}');
      // Plain itself returns the DB override
      expect(loader.getEscalation('plain')).toBe('Custom tenant escalation: {{reason}}');
    });

    test('channel-specific DB override takes precedence over plain DB override', () => {
      loader.loadFromEntries([
        { key: 'escalation.plain', content: 'Custom tenant escalation: {{reason}}' },
        { key: 'escalation.slack', content: 'Custom Slack escalation: {{reason}}' },
      ]);
      // Slack gets its own override
      expect(loader.getEscalation('slack')).toBe('Custom Slack escalation: {{reason}}');
      // Other channels still fall back to the plain DB override
      expect(loader.getEscalation('msteams')).toBe('Custom tenant escalation: {{reason}}');
    });
  });

  // ===========================================================================
  // Template interpolation produces correct output per channel
  // ===========================================================================

  describe('interpolation per channel', () => {
    const vars = { reason: 'User requested human agent', priority: 'high' };

    test('msteams template renders with bold markdown', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.msteams, vars);
      expect(result).toContain('**Escalated to Human Agent**');
      expect(result).toContain('User requested human agent');
      expect(result).toContain('high');
    });

    test('slack template renders with bold formatting', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.slack, vars);
      expect(result).toContain('*Escalated to Human Agent*');
      expect(result).toContain('User requested human agent');
      expect(result).toContain('high');
    });

    test('whatsapp template renders with WhatsApp bold', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.whatsapp, vars);
      expect(result).toContain('*Escalated to Human Agent*');
      expect(result).toContain('User requested human agent');
    });

    test('messenger template renders without formatting', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.messenger, vars);
      expect(result).toContain('Escalated to Human Agent');
      expect(result).toContain('User requested human agent');
      expect(result).not.toContain('**');
      expect(result).not.toContain('*Escalated');
    });

    test('voice template renders plain spoken text', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.voice, vars);
      expect(result).not.toContain('**');
      expect(result).not.toContain('*');
      expect(result).toContain('User requested human agent');
    });

    test('plain template renders minimal text', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.plain, vars);
      expect(result).not.toContain('**');
      expect(result).toContain('User requested human agent');
      expect(result).toContain('high');
    });

    test('digital template renders with full markdown', () => {
      const result = interpolateTemplate(PromptCatalog.escalation.digital, vars);
      expect(result).toContain('**Escalated to Human Agent**');
      expect(result).toContain('User requested human agent');
    });

    test('localized template variables survive channel-specific rendering', () => {
      const localizedVars = {
        reason: 'Besoin d aide humaine',
        priority: 'elevee',
        locale: 'fr-CA',
        messages: {
          handoff: 'Transfert vers un agent humain',
        },
      };

      const template = '{{messages.handoff}} [{{locale}}]\n' + PromptCatalog.escalation.slack;
      const result = interpolateTemplate(template, localizedVars);

      expect(result).toContain('Transfert vers un agent humain [fr-CA]');
      expect(result).toContain('*Escalated to Human Agent*');
      expect(result).toContain('Besoin d aide humaine');
      expect(result).toContain('elevee');
    });
  });

  // ===========================================================================
  // End-to-end: resolveEscalationChannel → getEscalation → interpolate
  // ===========================================================================

  describe('end-to-end channel resolution', () => {
    const vars = { reason: 'Complex billing issue', priority: 'critical' };

    test('Teams session gets Teams-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('msteams');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toContain('**Escalated to Human Agent**');
      expect(result).toContain('Complex billing issue');
      expect(result).toContain('critical');
    });

    test('Slack session gets Slack-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('slack');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toContain('*Escalated to Human Agent*');
      expect(result).toContain('Complex billing issue');
    });

    test('WhatsApp session gets WhatsApp-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('whatsapp');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toContain('*Escalated to Human Agent*');
      expect(result).toContain('Complex billing issue');
    });

    test('web_chat session gets digital-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('web_chat');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toContain('**Escalated to Human Agent**');
    });

    test('voice session gets voice-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('voice_twilio');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).not.toContain('**');
      expect(result).toContain('Complex billing issue');
    });

    test('web channel type gets digital-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('web');
      expect(channel).toBe('digital');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toContain('**Escalated to Human Agent**');
      expect(result).toContain('Complex billing issue');
    });

    test('digital channel type gets digital-formatted escalation', () => {
      const channel = loader.resolveEscalationChannel('digital');
      expect(channel).toBe('digital');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toContain('**Escalated to Human Agent**');
      expect(result).toContain('Complex billing issue');
    });

    test('unknown channel gets plain escalation', () => {
      const channel = loader.resolveEscalationChannel('some_unknown');
      const template = loader.getEscalation(channel);
      const result = interpolateTemplate(template, vars);
      expect(result).toBe(
        'Escalated to human agent. Reason: Complex billing issue. Priority: critical',
      );
    });
  });
});
