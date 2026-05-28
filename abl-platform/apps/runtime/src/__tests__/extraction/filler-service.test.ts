import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { FillerMessageService } from '../../services/filler/filler-service.js';
import type { StatusEvent, FillerConfig } from '../../services/filler/types.js';

describe('FillerMessageService', () => {
  let service: FillerMessageService;
  let emittedEvents: StatusEvent[];
  let onEmit: (event: StatusEvent) => void;
  const config: FillerConfig = {
    enabled: true,
    chatDelayMs: 100, // Short delay for tests
    cooldownMs: 200,
    maxPerTurn: 5,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    emittedEvents = [];
    onEmit = (event) => emittedEvents.push(event);
    service = new FillerMessageService('test-session', config, onEmit);
  });

  afterEach(() => {
    service.destroy();
    vi.useRealTimers();
  });

  test('emits status event after delay', () => {
    service.queueFiller('tool_call', 'Searching...');
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Searching.');
    expect(emittedEvents[0].operation).toBe('tool_call');
    expect(emittedEvents[0].transient).toBe(true);
  });

  test('does not append English punctuation to localized sentence punctuation', () => {
    service.queueFiller('tool_call', '確認しています。');

    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('確認しています。');
  });

  test('startTurn emits from the message boundary without an operation event', () => {
    service.startTurn('reasoning', 'Working on that...');

    vi.advanceTimersByTime(config.chatDelayMs - 1);
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Working on that.');
    expect(emittedEvents[0].operation).toBe('reasoning');
  });

  test('openTurn waits for an immediate custom filler instead of scheduling static fallback', () => {
    service.openTurn();

    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(0);

    service.emitImmediate(
      'tool_call',
      'Please stay connected while I review the information.',
      'pipeline',
    );

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Please stay connected while I review the information.');
    expect(emittedEvents[0].operation).toBe('tool_call');
  });

  test('discards filler if cancelled before delay', () => {
    service.queueFiller('tool_call', 'Searching...');
    vi.advanceTimersByTime(50); // Before delay
    service.cancel();

    vi.advanceTimersByTime(200); // Well past delay
    expect(emittedEvents).toHaveLength(0);
  });

  test('respects cooldown between emissions', () => {
    service.queueFiller('tool_call', 'First...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);

    // Queue another immediately — should be blocked by cooldown
    service.queueFiller('reasoning', 'Second...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1); // Still 1

    // Advance past cooldown
    vi.advanceTimersByTime(config.cooldownMs);
    service.queueFiller('reasoning', 'Third...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(2);
  });

  test('respects maxPerTurn limit', () => {
    const shortConfig: FillerConfig = { ...config, maxPerTurn: 2, cooldownMs: 0 };
    service.destroy();
    service = new FillerMessageService('test-session', shortConfig, onEmit);

    service.queueFiller('tool_call', 'One');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    service.queueFiller('tool_call', 'Two');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    service.queueFiller('tool_call', 'Three');
    vi.advanceTimersByTime(config.chatDelayMs + 10);

    expect(emittedEvents).toHaveLength(2);
  });

  test('new filler replaces pending filler', () => {
    service.queueFiller('tool_call', 'First...');
    vi.advanceTimersByTime(50); // Before delay
    service.queueFiller('handoff', 'Transferring...');
    vi.advanceTimersByTime(config.chatDelayMs + 10);

    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Transferring.');
  });

  test('reset clears pending filler (output reached user)', () => {
    service.queueFiller('tool_call', 'Searching...');
    vi.advanceTimersByTime(50);
    service.reset(); // LLM chunk reached user

    vi.advanceTimersByTime(200);
    expect(emittedEvents).toHaveLength(0);
  });

  test('destroy clears all timers', () => {
    service.queueFiller('tool_call', 'Searching...');
    service.destroy();

    vi.advanceTimersByTime(500);
    expect(emittedEvents).toHaveLength(0);
  });

  test('does nothing when disabled', () => {
    service.destroy();
    service = new FillerMessageService('test-session', { ...config, enabled: false }, onEmit);

    service.queueFiller('tool_call', 'Searching...');
    vi.advanceTimersByTime(500);
    expect(emittedEvents).toHaveLength(0);
  });

  test('resetTurn resets turn counter for new execution', () => {
    const shortConfig: FillerConfig = { ...config, maxPerTurn: 1, cooldownMs: 0 };
    service.destroy();
    service = new FillerMessageService('test-session', shortConfig, onEmit);

    service.queueFiller('tool_call', 'One');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);

    // Max reached, next is blocked
    service.queueFiller('tool_call', 'Two');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);

    // Reset for new turn
    service.resetTurn();
    service.queueFiller('tool_call', 'Three');
    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(2);
  });

  test('setPipelineFiller stores filler and consumePipelineFiller returns it once', () => {
    service.setPipelineFiller('Searching for red sneakers...');
    expect(service.consumePipelineFiller()).toBe('Searching for red sneakers...');
    // Second consume returns null (already consumed)
    expect(service.consumePipelineFiller()).toBeNull();
  });

  test('consumePipelineFiller returns null when no pipeline filler set', () => {
    expect(service.consumePipelineFiller()).toBeNull();
  });

  test('pipeline source updates pending text without moving the message timer', () => {
    service.startTurn('reasoning', 'Static one', 'static');
    vi.advanceTimersByTime(50);

    service.queueFiller('tool_call', 'Pipeline one', 'pipeline');
    vi.advanceTimersByTime(49);
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]!.text).toBe('Pipeline one.');
    expect(emittedEvents[0]!.operation).toBe('tool_call');
    expect(emittedEvents[0]!.source).toBe('pipeline');
  });

  test('lower-priority static text cannot overwrite pending pipeline text', () => {
    service.startTurn('reasoning', 'Static pending', 'static');
    vi.advanceTimersByTime(40);

    service.queueFiller('tool_call', 'Checking warranty details', 'pipeline');
    service.queueFiller('handoff', 'Checking now', 'static');

    vi.advanceTimersByTime(config.chatDelayMs);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]!.text).toBe('Checking warranty details.');
    expect(emittedEvents[0]!.operation).toBe('tool_call');
    expect(emittedEvents[0]!.source).toBe('pipeline');
  });

  test('piggybacked LLM status is not degraded by static text', () => {
    service.startTurn('reasoning', 'Reviewing now', 'static');
    vi.advanceTimersByTime(40);

    service.queueFiller('general', 'Reviewing Voltmart warranty coverage', 'piggybacked');
    service.queueFiller('tool_call', 'Checking now', 'static');

    vi.advanceTimersByTime(config.chatDelayMs);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]!.text).toBe('Reviewing Voltmart warranty coverage.');
    expect(emittedEvents[0]!.source).toBe('piggybacked');
  });

  test('pipeline filler respects the original trigger interval', () => {
    service.startTurn('reasoning', 'Static pending', 'static');
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(50);
    service.queueFiller('tool_call', 'Pipeline contextual', 'pipeline');
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(50);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Pipeline contextual.');
  });

  test('late pipeline filler is ignored after real output closes the turn', () => {
    service.startTurn('reasoning', 'Static pending', 'static');
    vi.advanceTimersByTime(50);

    service.cancel();
    service.queueFiller('tool_call', 'Pipeline contextual', 'pipeline');

    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(0);
  });

  test('static filler fires after delay if no pipeline filler arrives', () => {
    service.queueFiller('tool_call', 'Static fallback', 'static');
    expect(emittedEvents).toHaveLength(0);

    vi.advanceTimersByTime(config.chatDelayMs + 10);
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].text).toBe('Static fallback.');
  });

  test('isDestroyed returns true after destroy', () => {
    expect(service.isDestroyed()).toBe(false);
    service.destroy();
    expect(service.isDestroyed()).toBe(true);
  });
});
