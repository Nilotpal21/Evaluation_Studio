import { describe, it, expect } from 'vitest';
import {
  TextChannelAdapter,
  PlainTextVoiceAdapter,
  ElevenLabsAdapter,
  RealtimeVoiceAdapter,
  SSMLVoiceAdapter,
  ChannelAdapterRegistry,
  stripForVoice,
  stripForVoiceStreamChunk,
  getChannelAdapterRegistry,
  type MessagePayload,
  type ChannelContext,
} from '../../services/channel/channel-adapter.js';
import { VOICE_ENGINE } from '../../services/channel/constants.js';

// =============================================================================
// stripForVoice
// =============================================================================

describe('stripForVoice', () => {
  it('strips bold markdown', () => {
    expect(stripForVoice('Hello **world**')).toBe('Hello world');
  });

  it('strips italic markdown (* and _)', () => {
    expect(stripForVoice('Hello *world*')).toBe('Hello world');
    expect(stripForVoice('Hello _world_')).toBe('Hello world');
  });

  it('strips markdown links, keeping text', () => {
    expect(stripForVoice('Click [here](https://example.com) now')).toBe('Click here now');
  });

  it('strips header markers', () => {
    expect(stripForVoice('## Heading\nContent')).toBe('Heading Content');
  });

  it('strips list markers (- and *)', () => {
    expect(stripForVoice('- item one\n- item two')).toBe('item one item two');
    expect(stripForVoice('* item one\n* item two')).toBe('item one item two');
  });

  it('strips numbered list markers', () => {
    expect(stripForVoice('1. first\n2. second')).toBe('first second');
  });

  it('strips common emoji', () => {
    expect(stripForVoice('Hello 😀 world')).toBe('Hello world');
  });

  it('collapses whitespace', () => {
    expect(stripForVoice('  Hello   world  ')).toBe('Hello world');
  });

  it('handles empty string', () => {
    expect(stripForVoice('')).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(stripForVoice(undefined as any)).toBe('');
    expect(stripForVoice(null as any)).toBe('');
  });
});

// =============================================================================
// stripForVoiceStreamChunk
// =============================================================================

describe('stripForVoiceStreamChunk', () => {
  it('preserves boundary spaces in streaming chunks', () => {
    expect(stripForVoiceStreamChunk(' sorry')).toBe(' sorry');
    expect(stripForVoiceStreamChunk('there ')).toBe('there ');
  });

  it('strips markup and collapses internal whitespace without trimming', () => {
    expect(stripForVoiceStreamChunk(' **hello**   world ')).toBe(' hello world ');
  });
});

// =============================================================================
// TextChannelAdapter
// =============================================================================

describe('TextChannelAdapter', () => {
  const adapter = new TextChannelAdapter();

  it('passes through text unchanged', () => {
    expect(adapter.resolve({ text: 'Hello **bold**' })).toBe('Hello **bold**');
  });

  it('returns empty string for undefined text', () => {
    expect(adapter.resolve({ text: undefined as any })).toBe('');
  });

  it('has correct name', () => {
    expect(adapter.name).toBe('text');
  });
});

// =============================================================================
// PlainTextVoiceAdapter
// =============================================================================

describe('PlainTextVoiceAdapter', () => {
  const adapter = new PlainTextVoiceAdapter();

  it('uses plain_text from voiceConfig when available', () => {
    const payload: MessagePayload = {
      text: 'Hello **bold**',
      voiceConfig: { plain_text: 'Hello bold' } as any,
    };
    expect(adapter.resolve(payload)).toBe('Hello bold');
  });

  it('strips markdown when no plain_text override', () => {
    expect(adapter.resolve({ text: 'Hello **bold** world' })).toBe('Hello bold world');
  });
});

// =============================================================================
// ElevenLabsAdapter
// =============================================================================

describe('ElevenLabsAdapter', () => {
  const adapter = new ElevenLabsAdapter();

  it('uses plain_text from voiceConfig when available', () => {
    const payload: MessagePayload = {
      text: 'Hello **bold**',
      voiceConfig: { plain_text: 'Hello bold' } as any,
    };
    expect(adapter.resolve(payload)).toBe('Hello bold');
  });

  it('strips markdown when no plain_text override', () => {
    expect(adapter.resolve({ text: 'Hello **bold** world' })).toBe('Hello bold world');
  });

  it('handles empty text', () => {
    expect(adapter.resolve({ text: '' })).toBe('');
  });
});

// =============================================================================
// RealtimeVoiceAdapter
// =============================================================================

describe('RealtimeVoiceAdapter', () => {
  const adapter = new RealtimeVoiceAdapter();

  it('uses plain_text from voiceConfig when available', () => {
    const payload: MessagePayload = {
      text: 'Hello **bold**',
      voiceConfig: { plain_text: 'Hello bold' } as any,
    };
    expect(adapter.resolve(payload)).toBe('Hello bold');
  });

  it('falls back to raw text (no stripping)', () => {
    expect(adapter.resolve({ text: 'Hello **bold**' })).toBe('Hello **bold**');
  });
});

// =============================================================================
// SSMLVoiceAdapter
// =============================================================================

describe('SSMLVoiceAdapter', () => {
  const adapter = new SSMLVoiceAdapter();

  it('uses SSML from voiceConfig when available', () => {
    const ssml = '<speak>Hello</speak>';
    const payload: MessagePayload = {
      text: 'Hello',
      voiceConfig: { ssml } as any,
    };
    expect(adapter.resolve(payload)).toBe(ssml);
  });

  it('falls back to raw text when no SSML', () => {
    expect(adapter.resolve({ text: 'Hello world' })).toBe('Hello world');
  });
});

// =============================================================================
// ChannelAdapterRegistry
// =============================================================================

describe('ChannelAdapterRegistry', () => {
  it('resolves by engine (highest priority)', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register('elevenlabs', new ElevenLabsAdapter());
    registry.register('voice', new TextChannelAdapter());

    const result = registry.resolve(
      { text: 'Hello **bold**' },
      { channelType: 'voice', engine: 'elevenlabs' },
    );
    expect(result).toBe('Hello bold');
  });

  it('resolves by channelType when no engine', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register('voice', new ElevenLabsAdapter());

    const result = registry.resolve({ text: 'Hello **bold**' }, { channelType: 'voice' });
    expect(result).toBe('Hello bold');
  });

  it('falls back to text adapter when no match', () => {
    const registry = new ChannelAdapterRegistry();
    const result = registry.resolve({ text: 'Hello **bold**' }, { channelType: 'unknown_channel' });
    expect(result).toBe('Hello **bold**');
  });

  it('falls back from an unknown engine to the channelType adapter', () => {
    const registry = new ChannelAdapterRegistry();
    registry.register('voice', new PlainTextVoiceAdapter());

    const result = registry.resolve(
      { text: 'Hello **bold**' },
      { channelType: 'voice', engine: 'unregistered-engine' },
    );
    expect(result).toBe('Hello bold');
  });

  it('falls back to text adapter with no context', () => {
    const registry = new ChannelAdapterRegistry();
    const result = registry.resolve({ text: 'Hello' });
    expect(result).toBe('Hello');
  });
});

// =============================================================================
// Global singleton registry
// =============================================================================

describe('getChannelAdapterRegistry (singleton)', () => {
  const registry = getChannelAdapterRegistry();

  it('has elevenlabs registered', () => {
    const result = registry.resolve(
      { text: 'Hello **bold**' },
      { channelType: 'voice', engine: VOICE_ENGINE.ELEVENLABS },
    );
    expect(result).toBe('Hello bold');
  });

  it('has openai_realtime registered', () => {
    const result = registry.resolve(
      { text: 'Hello **bold**' },
      { channelType: 'voice', engine: VOICE_ENGINE.OPENAI_REALTIME },
    );
    // Realtime adapter does NOT strip — returns raw text
    expect(result).toBe('Hello **bold**');
  });

  it('has google_tts registered (SSML adapter)', () => {
    const payload: MessagePayload = {
      text: 'Hello',
      voiceConfig: { ssml: '<speak>Hi</speak>' } as any,
    };
    const result = registry.resolve(payload, {
      channelType: 'voice',
      engine: VOICE_ENGINE.GOOGLE_TTS,
    });
    expect(result).toBe('<speak>Hi</speak>');
  });

  it('web channel is passthrough', () => {
    const result = registry.resolve({ text: 'Hello **bold**' }, { channelType: 'web' });
    expect(result).toBe('Hello **bold**');
  });

  it('bridge voice channels default to the plain-text voice adapter', () => {
    const result = registry.resolve({ text: 'Hello **bold**' }, { channelType: 'voice_vxml' });
    expect(result).toBe('Hello bold');
  });

  it('realtime voice channels resolve spoken text through the shared voice adapter', () => {
    const result = registry.resolve(
      {
        text: 'Hello **bold**',
        voiceConfig: { plain_text: 'Hello bold' } as any,
      },
      { channelType: 'voice_realtime' },
    );
    expect(result).toBe('Hello bold');
  });
});
