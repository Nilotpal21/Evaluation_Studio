import { describe, expect, it } from 'vitest';
import {
  normalizeStudioWidgetCapabilityConfig,
  resolveStudioProjectPreviewCapabilityState,
  resolveStudioWidgetCapabilityState,
} from '../lib/sdk-widget-capabilities';

describe('Studio widget capability hardening', () => {
  it('normalizes authoritative widget capability flags for deploy/embed surfaces', () => {
    expect(
      normalizeStudioWidgetCapabilityConfig({
        mode: 'unified',
        chatEnabled: false,
        voiceEnabled: true,
      }),
    ).toEqual({
      configuredMode: 'unified',
      chatEnabled: false,
      voiceEnabled: true,
    });
  });

  it('clamps share preview voice mode back to chat when voice is unsupported in the browser', () => {
    expect(
      resolveStudioWidgetCapabilityState({
        mode: 'unified',
        currentMode: 'voice',
        chatEnabled: true,
        voiceEnabled: true,
        voiceSupported: false,
      }),
    ).toMatchObject({
      chatAvailable: true,
      voiceAvailable: false,
      effectiveMode: 'chat',
      showModeToggle: false,
    });
  });

  it('fails closed for project preview when chat is disabled and voice is the only configured mode', () => {
    expect(
      resolveStudioProjectPreviewCapabilityState({
        mode: 'voice',
        chatEnabled: false,
        voiceEnabled: true,
      }),
    ).toMatchObject({
      chatAvailable: false,
      voiceAvailable: false,
      allowedModes: [],
      effectiveMode: null,
      showModeToggle: false,
    });
  });
});
