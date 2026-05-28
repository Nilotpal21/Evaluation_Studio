/**
 * Behavioral tests that prove resolveFillerConfig output correctly drives
 * FillerMessageService behavior. Each test instantiates a real
 * FillerMessageService with the config returned by resolveFillerConfig —
 * no mocks, no stubs.
 *
 * These tests cover the wiring contract, not the resolver return values
 * (those are covered by filler-config-resolver.test.ts).
 *
 * Note: the runtime-executor guard `if (onTraceEvent && resolvedFillerConfig.enabled)`
 * is verified by code review (cannot be unit-tested without spinning up
 * runtime-executor) — search for `resolvedFillerConfig.enabled` in runtime-executor.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { resolveFillerConfig } from '../../services/filler/config-resolver.js';
import { resolveFillerConfig as resolveFillerRuntimeConfig } from '../../services/filler/config.js';
import { FillerMessageService } from '../../services/filler/filler-service.js';
import type { StatusEvent } from '../../services/filler/types.js';

describe('filler config propagation — resolveFillerConfig drives FillerMessageService behavior', () => {
  let emitted: StatusEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    emitted = [];
  });

  // ── none-mode: FillerMessageService respects enabled:false ────────────────

  it('disabled guard: voice_realtime config produces no emissions', () => {
    const config = resolveFillerConfig('voice_realtime');
    expect(config.enabled).toBe(false);

    const svc = new FillerMessageService('sess-disabled', config, (e) => emitted.push(e));
    svc.queueFiller('tool_call', 'Searching...', 'static');
    vi.advanceTimersByTime(5000);
    svc.destroy();

    expect(emitted).toHaveLength(0);
  });

  it('disabled guard: voice_vxml config produces no emissions', () => {
    const config = resolveFillerConfig('voice_vxml');
    expect(config.enabled).toBe(false);

    const svc = new FillerMessageService('sess-vxml', config, (e) => emitted.push(e));
    svc.queueFiller('general', 'Processing...', 'static');
    vi.advanceTimersByTime(5000);
    svc.destroy();

    expect(emitted).toHaveLength(0);
  });

  // ── chat mode: delay gate fires at chatDelayMs ────────────────────────────

  it('chat delay gate: web_chat filler fires after chatDelayMs (1200ms)', () => {
    const config = resolveFillerConfig('web_chat');
    expect(config.chatDelayMs).toBe(1200);

    const svc = new FillerMessageService('sess-chat', config, (e) => emitted.push(e));
    svc.queueFiller('tool_call', 'Searching...', 'static');

    vi.advanceTimersByTime(1100);
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('Searching.');
    expect(emitted[0].operation).toBe('tool_call');

    svc.destroy();
  });

  // ── voice_pipeline mode: maxPerTurn cap of 3 ─────────────────────────────

  it('voice_pipeline config enforces maxPerTurn:3', () => {
    const config = resolveFillerConfig('voice_pipeline');
    expect(config.maxPerTurn).toBe(3);
    expect(config.cooldownMs).toBe(5000);

    const svc = new FillerMessageService('sess-voice', { ...config, cooldownMs: 0 }, (e) =>
      emitted.push(e),
    );

    // Queue 4 fillers; maxPerTurn:3 means only 3 can emit.
    for (let i = 0; i < 4; i++) {
      svc.queueFiller('tool_call', `Filler ${i}`, 'static');
      vi.advanceTimersByTime(config.voiceDelayMs! + 10);
    }

    svc.destroy();

    expect(emitted).toHaveLength(3);
  });

  it('voice_pipeline config has longer cooldownMs than chat', () => {
    const chatConfig = resolveFillerConfig('web_chat');
    const voiceConfig = resolveFillerConfig('voice_pipeline');

    expect(voiceConfig.cooldownMs).toBeGreaterThan(chatConfig.cooldownMs);
  });

  // ── voice_pipeline mode: delay gate fires at voiceDelayMs ─────────────────

  it('voice_pipeline delay gate: static filler fires after voiceDelayMs (500ms)', () => {
    const config = resolveFillerConfig('voice_pipeline');
    expect(config.voiceDelayMs).toBe(500);

    const svc = new FillerMessageService('sess-vp', config, (e) => emitted.push(e));
    svc.queueFiller('tool_call', 'Processing...', 'static');

    vi.advanceTimersByTime(499);
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('Processing.');

    svc.destroy();
  });

  it('voice_pipeline delay gate is shorter than chat delay gate', () => {
    const chatConfig = resolveFillerConfig('web_chat');
    const voiceConfig = resolveFillerConfig('voice_pipeline');

    const effectiveVoiceDelay = voiceConfig.voiceDelayMs ?? voiceConfig.chatDelayMs;
    expect(effectiveVoiceDelay).toBe(500);
    expect(effectiveVoiceDelay).toBeLessThan(chatConfig.chatDelayMs);
  });

  // ── bridged path: resolveFillerRuntimeConfig with channelDefaults ─────────
  // These tests verify the ABLP-710 → ABLP-696 bridge introduced in runtime-executor.ts.
  // The channel-type defaults must flow through to FillerMessageService via
  // resolveFillerRuntimeConfig when no project-level override is set.

  it('bridged path: voice_pipeline channel defaults propagate voiceDelayMs:500 via resolveFillerRuntimeConfig', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({ isVoiceChannel: true, channelDefaults });

    expect(resolved.serviceConfig.enabled).toBe(true);
    expect(resolved.serviceConfig.voiceDelayMs).toBe(500);
    expect(resolved.serviceConfig.cooldownMs).toBe(5000);
    expect(resolved.serviceConfig.maxPerTurn).toBe(3);
  });

  it('bridged path: voice_pipeline uses the quality-gated voice delay by default', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({ isVoiceChannel: true, channelDefaults });

    const svc = new FillerMessageService('sess-bridge', resolved.serviceConfig, (e) =>
      emitted.push(e),
    );
    svc.queueFiller('tool_call', 'Checking...', 'static');

    vi.advanceTimersByTime(499);
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].text).toBe('Checking.');

    svc.destroy();
  });

  it('bridged path: explicit voiceEnabled false disables voice_pipeline filler', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({
      isVoiceChannel: true,
      channelDefaults,
      projectFiller: { voiceEnabled: false },
    });

    const svc = new FillerMessageService('sess-bridge-disabled', resolved.serviceConfig, (e) =>
      emitted.push(e),
    );
    svc.queueFiller('tool_call', 'Checking...', 'static');

    vi.advanceTimersByTime(499);
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(emitted).toHaveLength(0);

    svc.destroy();
  });

  it('bridged path: project voiceDelayMs override takes precedence over channel default', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({
      isVoiceChannel: true,
      channelDefaults,
      projectFiller: { voiceDelayMs: 200 },
    });

    expect(resolved.serviceConfig.voiceDelayMs).toBe(200);
    // cooldownMs still falls back to channel default (no project override)
    expect(resolved.serviceConfig.cooldownMs).toBe(5000);
  });

  it('bridged path: chat channel defaults propagate chatDelayMs:1200 via resolveFillerRuntimeConfig', () => {
    const channelDefaults = resolveFillerConfig('web_chat');
    const resolved = resolveFillerRuntimeConfig({ isVoiceChannel: false, channelDefaults });

    expect(resolved.serviceConfig.chatDelayMs).toBe(1200);
    expect(resolved.serviceConfig.voiceDelayMs).toBeUndefined();
    expect(resolved.serviceConfig.cooldownMs).toBe(3000);
    expect(resolved.serviceConfig.maxPerTurn).toBe(5);
  });

  // ── Optional voiceDelayMs fallback: absent means use the 500ms channel default ────

  it('absent project voiceDelayMs falls back to channel default 500ms', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({
      isVoiceChannel: true,
      channelDefaults,
      projectFiller: {},
    });

    expect(resolved.serviceConfig.enabled).toBe(true);
    expect(resolved.serviceConfig.voiceDelayMs).toBe(500);
    expect(resolved.serviceConfig.chatDelayMs).toBe(500);
  });

  it('absent project voiceDelayMs: FillerMessageService emits after the channel default', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({
      isVoiceChannel: true,
      channelDefaults,
      projectFiller: {},
    });

    const svc = new FillerMessageService('sess-absent', resolved.serviceConfig, (e) =>
      emitted.push(e),
    );
    svc.queueFiller('tool_call', 'Hold on...', 'static');

    vi.advanceTimersByTime(499);
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(emitted).toHaveLength(1);

    svc.destroy();
  });

  it('explicit positive voiceDelayMs overrides channel default', () => {
    const channelDefaults = resolveFillerConfig('voice_pipeline');
    const resolved = resolveFillerRuntimeConfig({
      isVoiceChannel: true,
      channelDefaults,
      projectFiller: { voiceDelayMs: 800 }, // intentional project override
    });

    expect(resolved.serviceConfig.enabled).toBe(true);
    expect(resolved.serviceConfig.voiceDelayMs).toBe(800);
    expect(resolved.serviceConfig.chatDelayMs).toBe(800); // effective delay on voice turn
  });
});
