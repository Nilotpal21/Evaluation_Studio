/**
 * Channel Manifest Conformance Tests
 *
 * Ensures the channel manifest stays in sync with the channel registry,
 * route configuration, and DB model. Catches drift between these layers
 * before it reaches production.
 */
import { describe, it, expect } from 'vitest';
import {
  CHANNEL_MANIFEST,
  getChannelManifest,
  getConnectionChannelTypes,
  getVoiceChannelTypes,
  getWebhookChannelTypes,
} from '../../channels/manifest.js';
import { getChannelRegistry } from '../../channels/registry.js';

// =============================================================================
// REGISTRY ↔ MANIFEST ALIGNMENT
// =============================================================================

describe('registry ↔ manifest alignment', () => {
  const registry = getChannelRegistry();
  const registeredTypes = registry.getRegisteredTypes();

  it('every registered adapter has a manifest entry', () => {
    for (const type of registeredTypes) {
      expect(
        getChannelManifest(type),
        `Adapter "${type}" is registered but missing from CHANNEL_MANIFEST`,
      ).toBeDefined();
    }
  });

  it('every connection-eligible manifest entry has an adapter or is a protocol channel', () => {
    const connectionTypes = getConnectionChannelTypes();
    // Protocol / feature-flagged channels may not have adapters in the default registry.
    const optionalAdapterChannels = new Set([
      'a2a',
      'ai4w',
      'voice_twilio',
      'voice_pipeline',
      'voice_realtime',
      'instagram',
    ]);
    for (const type of connectionTypes) {
      if (optionalAdapterChannels.has(type)) continue;
      expect(
        registry.has(type as any),
        `Connection-eligible channel "${type}" has no registered adapter`,
      ).toBe(true);
    }
  });
});

// =============================================================================
// WEBHOOK CHANNELS
// =============================================================================

describe('webhook channel manifest entries', () => {
  const webhookTypes = getWebhookChannelTypes();

  it('every webhook channel has a webhookPathPattern', () => {
    for (const type of webhookTypes) {
      const entry = getChannelManifest(type);
      expect(
        entry?.webhookPathPattern,
        `Webhook channel "${type}" has no webhookPathPattern`,
      ).toBeTruthy();
    }
  });

  it('non-webhook channels do not have a webhookPathPattern (except voice_twilio)', () => {
    for (const [type, entry] of Object.entries(CHANNEL_MANIFEST)) {
      if (webhookTypes.includes(type)) continue;
      // voice_twilio has a webhookPathPattern but uses websocket delivery
      if (type === 'voice_twilio') continue;
      expect(
        entry.webhookPathPattern,
        `Non-webhook channel "${type}" should not have a webhookPathPattern`,
      ).toBeNull();
    }
  });
});

// =============================================================================
// VOICE CHANNELS
// =============================================================================

describe('voice channel classification', () => {
  const voiceTypes = new Set(getVoiceChannelTypes());

  it('voice channels have isVoice=true', () => {
    for (const type of voiceTypes) {
      const entry = getChannelManifest(type);
      expect(entry?.isVoice, `Voice channel "${type}" should have isVoice=true`).toBe(true);
    }
  });

  it('non-voice channels have isVoice=false', () => {
    for (const [type, entry] of Object.entries(CHANNEL_MANIFEST)) {
      if (voiceTypes.has(type)) continue;
      expect(entry.isVoice, `Non-voice channel "${type}" should have isVoice=false`).toBe(false);
    }
  });

  it('known voice channels are classified correctly', () => {
    expect(voiceTypes.has('voice_vxml')).toBe(true);
    expect(voiceTypes.has('korevg')).toBe(true);
    expect(voiceTypes.has('voice')).toBe(true);
    expect(voiceTypes.has('voice_twilio')).toBe(true);
    expect(voiceTypes.has('voice_livekit')).toBe(true);
  });

  it('text channels are not classified as voice', () => {
    expect(voiceTypes.has('slack')).toBe(false);
    expect(voiceTypes.has('msteams')).toBe(false);
    expect(voiceTypes.has('web_debug')).toBe(false);
    expect(voiceTypes.has('ag_ui')).toBe(false);
    expect(voiceTypes.has('a2a')).toBe(false);
  });
});

// =============================================================================
// JAMBONZ EXCLUSION
// =============================================================================

describe('jambonz exclusion', () => {
  it('jambonz is NOT in the channel manifest', () => {
    expect(CHANNEL_MANIFEST['jambonz']).toBeUndefined();
  });

  it('jambonz is NOT in connection-eligible types', () => {
    expect(getConnectionChannelTypes()).not.toContain('jambonz');
  });

  it('jambonz is NOT in voice types', () => {
    expect(getVoiceChannelTypes()).not.toContain('jambonz');
  });

  it('jambonz is NOT in webhook types', () => {
    expect(getWebhookChannelTypes()).not.toContain('jambonz');
  });
});

// =============================================================================
// CONNECTION-ELIGIBLE CONSISTENCY
// =============================================================================

describe('connection-eligible consistency', () => {
  const connectionTypes = getConnectionChannelTypes();

  it('every connection-eligible channel is in the manifest', () => {
    for (const type of connectionTypes) {
      expect(
        CHANNEL_MANIFEST[type],
        `Connection-eligible type "${type}" missing from manifest`,
      ).toBeDefined();
    }
  });

  it('connection-eligible channels have isConnectionEligible=true', () => {
    for (const type of connectionTypes) {
      const entry = getChannelManifest(type);
      expect(
        entry?.isConnectionEligible,
        `"${type}" in connection types but isConnectionEligible is false`,
      ).toBe(true);
    }
  });

  it('non-connection-eligible channels are excluded', () => {
    for (const [type, entry] of Object.entries(CHANNEL_MANIFEST)) {
      if (entry.isConnectionEligible) {
        expect(
          connectionTypes,
          `"${type}" has isConnectionEligible=true but is not in connection types`,
        ).toContain(type);
      } else {
        expect(
          connectionTypes,
          `"${type}" has isConnectionEligible=false but is in connection types`,
        ).not.toContain(type);
      }
    }
  });
});
