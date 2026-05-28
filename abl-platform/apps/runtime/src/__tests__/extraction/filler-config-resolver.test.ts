import { describe, it, expect } from 'vitest';

import { resolveFillerConfig } from '../../services/filler/config-resolver.js';
import {
  DEFAULT_FILLER_CONFIG,
  DEFAULT_VOICE_PIPELINE_FILLER_CONFIG,
} from '../../services/filler/types.js';

describe('resolveFillerConfig', () => {
  // ── undefined / unregistered fallback ──────────────────────────────────────

  it('undefined channelType returns chat defaults', () => {
    expect(resolveFillerConfig(undefined)).toEqual(DEFAULT_FILLER_CONFIG);
  });

  it('unregistered channel string returns chat defaults', () => {
    expect(resolveFillerConfig('unknown_channel')).toEqual(DEFAULT_FILLER_CONFIG);
  });

  it('empty string returns chat defaults', () => {
    expect(resolveFillerConfig('')).toEqual(DEFAULT_FILLER_CONFIG);
  });

  // ── chat-family channels ────────────────────────────────────────────────────

  it('web_chat returns DEFAULT_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('web_chat')).toEqual(DEFAULT_FILLER_CONFIG);
  });

  it('sdk_websocket returns DEFAULT_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('sdk_websocket')).toEqual(DEFAULT_FILLER_CONFIG);
  });

  it('slack returns DEFAULT_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('slack')).toEqual(DEFAULT_FILLER_CONFIG);
  });

  it('a2a returns DEFAULT_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('a2a')).toEqual(DEFAULT_FILLER_CONFIG);
  });

  // ── none-family channels ───────────────────────────────────────────────────

  it('voice_realtime returns enabled:false', () => {
    expect(resolveFillerConfig('voice_realtime').enabled).toBe(false);
  });

  it('voice_vxml returns enabled:false', () => {
    expect(resolveFillerConfig('voice_vxml').enabled).toBe(false);
  });

  it('none mode preserves other DEFAULT_FILLER_CONFIG fields except enabled', () => {
    const cfg = resolveFillerConfig('voice_realtime');
    expect(cfg.chatDelayMs).toBe(DEFAULT_FILLER_CONFIG.chatDelayMs);
    expect(cfg.cooldownMs).toBe(DEFAULT_FILLER_CONFIG.cooldownMs);
    expect(cfg.maxPerTurn).toBe(DEFAULT_FILLER_CONFIG.maxPerTurn);
    expect(cfg.enabled).toBe(false);
  });

  // ── voice_pipeline-family channels ────────────────────────────────────────

  it('voice_pipeline returns DEFAULT_VOICE_PIPELINE_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('voice_pipeline')).toEqual(DEFAULT_VOICE_PIPELINE_FILLER_CONFIG);
  });

  it('korevg returns DEFAULT_VOICE_PIPELINE_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('korevg')).toEqual(DEFAULT_VOICE_PIPELINE_FILLER_CONFIG);
  });

  it('audiocodes returns DEFAULT_VOICE_PIPELINE_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('audiocodes')).toEqual(DEFAULT_VOICE_PIPELINE_FILLER_CONFIG);
  });

  it('voice_twilio returns DEFAULT_VOICE_PIPELINE_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('voice_twilio')).toEqual(DEFAULT_VOICE_PIPELINE_FILLER_CONFIG);
  });

  it('voice_livekit returns DEFAULT_VOICE_PIPELINE_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('voice_livekit')).toEqual(DEFAULT_VOICE_PIPELINE_FILLER_CONFIG);
  });

  it('voice (generic) returns DEFAULT_VOICE_PIPELINE_FILLER_CONFIG', () => {
    expect(resolveFillerConfig('voice')).toEqual(DEFAULT_VOICE_PIPELINE_FILLER_CONFIG);
  });

  // ── voice_pipeline config shape contract ──────────────────────────────────

  it('voice_pipeline config has voiceDelayMs:500', () => {
    expect(resolveFillerConfig('voice_pipeline').voiceDelayMs).toBe(500);
  });

  it('voice_pipeline config has maxPerTurn:3', () => {
    expect(resolveFillerConfig('voice_pipeline').maxPerTurn).toBe(3);
  });

  it('voice_pipeline config has cooldownMs:5000', () => {
    expect(resolveFillerConfig('voice_pipeline').cooldownMs).toBe(5000);
  });

  it('voice_pipeline config is enabled', () => {
    expect(resolveFillerConfig('voice_pipeline').enabled).toBe(true);
  });
});
