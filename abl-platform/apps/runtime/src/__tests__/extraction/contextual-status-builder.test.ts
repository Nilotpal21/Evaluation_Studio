import { describe, expect, test } from 'vitest';

import {
  buildStaticFillerCandidate,
  normalizeFillerStatusText,
} from '../../services/filler/contextual-status-builder.js';

describe('contextual status builder', () => {
  test('sanitizes internal runtime language before emitting customer status', () => {
    const text = normalizeFillerStatusText('Calling internal handoff tool for agent routing', {
      isVoiceChannel: false,
    });

    expect(text).toBe('One moment.');
  });

  test('sanitizes unsafe status text to the resolved locale fallback', () => {
    const text = normalizeFillerStatusText('Calling internal handoff tool for agent routing', {
      isVoiceChannel: false,
      locale: 'es-MX',
    });

    expect(text).toBe('Un momento.');
  });

  test('voice status keeps contextual text without rewriting meaning', () => {
    const text = normalizeFillerStatusText('Searching Voltmart charger warranty...', {
      isVoiceChannel: true,
    });

    expect(text).toBe('Searching Voltmart charger warranty.');
  });

  test('voice status preserves localized sentence punctuation', () => {
    const text = normalizeFillerStatusText('確認しています。', {
      isVoiceChannel: true,
      locale: 'ja-JP',
    });

    expect(text).toBe('確認しています。');
  });

  test('voice status completes CJK text with localized punctuation', () => {
    const text = normalizeFillerStatusText('確認しています...', {
      isVoiceChannel: true,
      locale: 'ja-JP',
    });

    expect(text).toBe('確認しています。');
  });

  test('strips curly quotes without rewriting the status text', () => {
    const text = normalizeFillerStatusText('“Checking the latest account details”', {
      isVoiceChannel: true,
    });

    expect(text).toBe('Checking the latest account details.');
  });

  test('static fallback does not infer context from user keywords', () => {
    const candidate = buildStaticFillerCandidate({
      operation: 'tool_call',
      isVoiceChannel: true,
    });

    expect(candidate.operation).toBe('tool_call');
    expect(candidate.source).toBe('static');
    expect([
      "I'm checking that for you.",
      'Let me check that.',
      "I'll take a quick look.",
    ]).toContain(candidate.text);
  });

  test('voice sanitization falls back to conversational generic text', () => {
    const text = normalizeFillerStatusText('Sorry, calling the internal tool now', {
      isVoiceChannel: true,
    });

    expect(text).toBe("I'm checking that for you.");
  });

  test('static fallback localizes from interaction locale without inferring context', () => {
    const candidate = buildStaticFillerCandidate({
      operation: 'tool_call',
      isVoiceChannel: true,
      locale: 'fr-CA',
    });

    expect(candidate.operation).toBe('tool_call');
    expect(candidate.source).toBe('static');
    expect(['Un instant.', 'Vérification en cours.', 'Examen en cours.']).toContain(candidate.text);
  });

  test('questions fall back to a generic status', () => {
    const candidate = buildStaticFillerCandidate({
      operation: 'general',
      isVoiceChannel: false,
    });
    const normalized = normalizeFillerStatusText('Should I call the next tool?', {
      isVoiceChannel: false,
    });

    expect(candidate.source).toBe('static');
    expect(normalized).toBe('One moment.');
  });
});
