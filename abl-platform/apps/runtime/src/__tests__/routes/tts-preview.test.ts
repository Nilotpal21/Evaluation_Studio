import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttsPreviewRequestSchema, getMaxChars, getRateLimit } from '../../routes/tts-preview.js';

// =============================================================================
// Schema Validation Tests
// =============================================================================

describe('ttsPreviewRequestSchema', () => {
  it('accepts a valid ElevenLabs request with all fields', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello, how can I help you today?',
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
      voice: 'voice-abc',
      model: 'eleven_turbo_v2_5',
      language: 'en',
      speed: 1.1,
      stability: 0.8,
      similarityBoost: 0.9,
      style: 0.2,
      useSpeakerBoost: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('elevenlabs');
      expect(result.data.voice).toBe('voice-abc');
      expect(result.data.speed).toBe(1.1);
      expect(result.data.useSpeakerBoost).toBe(false);
    }
  });

  it('accepts a valid Orpheus request with required fields only', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Test speech synthesis.',
      serviceInstanceId: 'svc-456',
      provider: 'custom:orpheus',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('custom:orpheus');
      expect(result.data.voice).toBeUndefined();
      expect(result.data.model).toBeUndefined();
    }
  });

  it('rejects empty text', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: '',
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
    });
    expect(result.success).toBe(false);
  });

  it('rejects text exceeding max characters', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'x'.repeat(501),
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
    });
    expect(result.success).toBe(false);
  });

  it('accepts text at exactly max characters', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'x'.repeat(500),
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing serviceInstanceId', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      provider: 'elevenlabs',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty serviceInstanceId', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      serviceInstanceId: '',
      provider: 'elevenlabs',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unsupported provider', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      serviceInstanceId: 'svc-123',
      provider: 'google',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing provider', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      serviceInstanceId: 'svc-123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty voice string when provided', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
      voice: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty model string when provided', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
      model: '',
    });
    expect(result.success).toBe(false);
  });

  it('allows language as any string including empty', () => {
    const result = ttsPreviewRequestSchema.safeParse({
      text: 'Hello',
      serviceInstanceId: 'svc-123',
      provider: 'elevenlabs',
      language: '',
    });
    expect(result.success).toBe(true);
  });
});

// =============================================================================
// Config Function Tests
// =============================================================================

describe('getMaxChars', () => {
  afterEach(() => {
    delete process.env.TTS_PREVIEW_MAX_CHARS;
  });

  it('returns 500 by default', () => {
    delete process.env.TTS_PREVIEW_MAX_CHARS;
    expect(getMaxChars()).toBe(500);
  });

  it('reads TTS_PREVIEW_MAX_CHARS from env', () => {
    process.env.TTS_PREVIEW_MAX_CHARS = '1000';
    expect(getMaxChars()).toBe(1000);
  });

  it('returns 500 for non-numeric env value', () => {
    process.env.TTS_PREVIEW_MAX_CHARS = 'abc';
    expect(getMaxChars()).toBe(500);
  });
});

describe('getRateLimit', () => {
  afterEach(() => {
    delete process.env.TTS_PREVIEW_RATE_LIMIT;
  });

  it('returns 20 by default', () => {
    delete process.env.TTS_PREVIEW_RATE_LIMIT;
    expect(getRateLimit()).toBe(20);
  });

  it('reads TTS_PREVIEW_RATE_LIMIT from env', () => {
    process.env.TTS_PREVIEW_RATE_LIMIT = '10';
    expect(getRateLimit()).toBe(10);
  });

  it('returns 20 for non-numeric env value', () => {
    process.env.TTS_PREVIEW_RATE_LIMIT = 'xyz';
    expect(getRateLimit()).toBe(20);
  });
});
