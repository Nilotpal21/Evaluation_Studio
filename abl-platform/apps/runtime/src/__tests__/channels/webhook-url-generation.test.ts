/**
 * Webhook URL Generation Tests
 *
 * Validates that buildWebhookUrl from the ChannelManifest generates URLs
 * matching the actual Express route shapes for each channel type.
 */

import { describe, it, expect } from 'vitest';
import { buildWebhookUrl } from '../../channels/manifest.js';

const BASE_URL = 'https://runtime.example.com';

describe('Webhook URL generation from manifest', () => {
  describe('path-based webhook channels', () => {
    it('should generate Slack webhook URL with identifier', () => {
      const url = buildWebhookUrl('slack', BASE_URL, 'my-slack-bot');
      expect(url).toBe('https://runtime.example.com/api/v1/channels/slack/webhook/my-slack-bot');
    });

    it('should generate MS Teams webhook URL with identifier', () => {
      const url = buildWebhookUrl('msteams', BASE_URL, 'teams-bot-1');
      expect(url).toBe('https://runtime.example.com/api/v1/channels/msteams/webhook/teams-bot-1');
    });

    it('should generate Slack webhook URL without identifier (strips param)', () => {
      const url = buildWebhookUrl('slack', BASE_URL);
      expect(url).toBe('https://runtime.example.com/api/v1/channels/slack/webhook');
    });
  });

  describe('VXML route shape', () => {
    it('should generate VXML URL matching /api/v1/channels/vxml/hooks/:streamId', () => {
      const url = buildWebhookUrl('voice_vxml', BASE_URL, 'stream-123');
      expect(url).toBe('https://runtime.example.com/api/v1/channels/vxml/hooks/stream-123');
    });

    it('should not generate old-style /webhook path for VXML', () => {
      const url = buildWebhookUrl('voice_vxml', BASE_URL, 'stream-123');
      expect(url).not.toContain('/webhook/');
    });
  });

  describe('Meta channels (body-based routing)', () => {
    it('should generate WhatsApp URL without identifier appended', () => {
      const url = buildWebhookUrl('whatsapp', BASE_URL);
      expect(url).toBe('https://runtime.example.com/api/v1/channels/whatsapp/webhook');
    });

    it('should generate Messenger URL without identifier appended', () => {
      const url = buildWebhookUrl('messenger', BASE_URL);
      expect(url).toBe('https://runtime.example.com/api/v1/channels/messenger/webhook');
    });
  });

  describe('voice channels', () => {
    it('should generate Twilio voice webhook URL', () => {
      const url = buildWebhookUrl('voice_twilio', BASE_URL);
      expect(url).toBe('https://runtime.example.com/api/v1/voice/connect');
    });
  });

  describe('non-webhook channels', () => {
    it('should return null for http_async', () => {
      expect(buildWebhookUrl('http_async', BASE_URL)).toBeNull();
    });

    it('should return null for korevg (websocket)', () => {
      expect(buildWebhookUrl('korevg', BASE_URL)).toBeNull();
    });

    it('should return null for email (smtp)', () => {
      expect(buildWebhookUrl('email', BASE_URL)).toBeNull();
    });

    it('should return null for unknown channel', () => {
      expect(buildWebhookUrl('nonexistent', BASE_URL)).toBeNull();
    });
  });

  describe('URL encoding', () => {
    it('should URL-encode identifiers with special characters', () => {
      const url = buildWebhookUrl('slack', BASE_URL, 'bot/special chars');
      expect(url).toContain('bot%2Fspecial%20chars');
    });
  });

  describe('base URL normalization', () => {
    it('should handle base URL with trailing slash', () => {
      const url = buildWebhookUrl('slack', 'https://runtime.example.com/', 'bot-1');
      // Should not have double slashes
      expect(url).not.toContain('//api');
    });
  });
});
