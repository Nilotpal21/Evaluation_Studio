import { describe, expect, test } from 'vitest';
import {
  isBrowserVoiceCaptureSupported,
  resolveSdkWidgetCapabilityState,
} from '../sdk-widget-capabilities.js';

describe('resolveSdkWidgetCapabilityState', () => {
  test('keeps both chat and voice available for unified widgets when voice is supported', () => {
    expect(
      resolveSdkWidgetCapabilityState({
        configuredMode: 'unified',
        currentMode: 'chat',
        chatEnabled: true,
        voiceEnabled: true,
        voiceSupported: true,
      }),
    ).toEqual({
      chatEnabled: true,
      voiceEnabled: true,
      chatAvailable: true,
      voiceAvailable: true,
      allowedModes: ['chat', 'voice'],
      effectiveMode: 'chat',
      showModeToggle: true,
    });
  });

  test('clamps voice requests back to chat when voice is disabled', () => {
    expect(
      resolveSdkWidgetCapabilityState({
        configuredMode: 'unified',
        currentMode: 'voice',
        chatEnabled: true,
        voiceEnabled: false,
        voiceSupported: true,
      }),
    ).toEqual({
      chatEnabled: true,
      voiceEnabled: false,
      chatAvailable: true,
      voiceAvailable: false,
      allowedModes: ['chat'],
      effectiveMode: 'chat',
      showModeToggle: false,
    });
  });

  test('clamps chat requests to voice when chat is disabled but voice is available', () => {
    expect(
      resolveSdkWidgetCapabilityState({
        configuredMode: 'unified',
        currentMode: 'chat',
        chatEnabled: false,
        voiceEnabled: true,
        voiceSupported: true,
      }),
    ).toEqual({
      chatEnabled: false,
      voiceEnabled: true,
      chatAvailable: false,
      voiceAvailable: true,
      allowedModes: ['voice'],
      effectiveMode: 'voice',
      showModeToggle: false,
    });
  });

  test('returns no effective mode when no configured capability is usable in the browser', () => {
    expect(
      resolveSdkWidgetCapabilityState({
        configuredMode: 'voice',
        currentMode: 'voice',
        chatEnabled: false,
        voiceEnabled: true,
        voiceSupported: false,
      }),
    ).toEqual({
      chatEnabled: false,
      voiceEnabled: true,
      chatAvailable: false,
      voiceAvailable: false,
      allowedModes: [],
      effectiveMode: null,
      showModeToggle: false,
    });
  });

  test('treats microphone capture plus AudioContext as sufficient browser voice support', () => {
    expect(
      isBrowserVoiceCaptureSupported(
        {
          AudioContext: class MockAudioContext {},
        },
        {
          mediaDevices: {
            getUserMedia: () => Promise.resolve(undefined),
          },
        },
      ),
    ).toBe(true);
  });

  test('accepts webkitAudioContext as a browser-compatible voice capability signal', () => {
    expect(
      isBrowserVoiceCaptureSupported(
        {
          webkitAudioContext: class MockWebkitAudioContext {},
        },
        {
          mediaDevices: {
            getUserMedia: () => Promise.resolve(undefined),
          },
        },
      ),
    ).toBe(true);
  });

  test('rejects browser voice support when getUserMedia is unavailable', () => {
    expect(
      isBrowserVoiceCaptureSupported(
        {
          AudioContext: class MockAudioContext {},
        },
        {
          mediaDevices: {},
        },
      ),
    ).toBe(false);
  });
});
