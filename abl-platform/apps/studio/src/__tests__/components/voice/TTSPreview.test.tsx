/**
 * TTSPreview Component Tests
 *
 * Tests the shared TTS preview widget's rendering, state transitions,
 * and user interactions. Uses global fetch stubbing (from setup.tsx)
 * to intercept API calls without module mocks.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TTSPreview } from '../../../components/voice/TTSPreview';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAudioBlob(): Blob {
  return new Blob([new Uint8Array([0, 0, 0, 0])], { type: 'audio/mpeg' });
}

function stubFetchSuccess(latencyMs = 150): void {
  const blob = createAudioBlob();
  const response = {
    ok: true,
    status: 200,
    headers: new Headers({
      'Content-Type': 'audio/mpeg',
      'X-Synthesis-Latency-Ms': String(latencyMs),
    }),
    blob: async () => blob,
    json: async () => ({}),
    text: async () => '',
    clone: () => response,
  } as unknown as Response;

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function stubFetchError(status: number, message: string): void {
  const response = {
    ok: false,
    status,
    headers: new Headers({}),
    json: async () => ({ error: { message } }),
    text: async () => JSON.stringify({ error: { message } }),
    clone: function () {
      return this;
    },
  } as unknown as Response;

  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function stubFetchReject(error: string): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(error)));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TTSPreview', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:tts-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('renders with default text and Generate button', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    const textarea = screen.getByPlaceholderText('Type sample text to preview...');
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveValue('Hello, how can I help you today?');

    expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument();
    expect(screen.getByText('Preview Voice')).toBeInTheDocument();
  });

  it('shows character counter', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    expect(screen.getByText(/\/ 500 characters/)).toBeInTheDocument();
  });

  it('disables Generate when serviceInstanceId is empty', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="" />);

    const generateButton = screen.getByRole('button', { name: /generate/i });
    expect(generateButton).toBeDisabled();
  });

  it('disables Generate when text is empty', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    const textarea = screen.getByPlaceholderText('Type sample text to preview...');
    fireEvent.change(textarea, { target: { value: '' } });

    const generateButton = screen.getByRole('button', { name: /generate/i });
    expect(generateButton).toBeDisabled();
  });

  it('displays latency after successful playback', async () => {
    stubFetchSuccess(247);

    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    fireEvent.click(screen.getByRole('button', { name: /generate/i })!);

    await waitFor(() => {
      expect(screen.getByText('Generated in 247ms')).toBeInTheDocument();
    });
  });

  it('shows audio player after successful playback', async () => {
    stubFetchSuccess();

    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    expect(document.querySelector('audio')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /generate/i })!);

    await waitFor(() => {
      expect(document.querySelector('audio')).toBeInTheDocument();
    });
  });

  it('displays error message on API failure', async () => {
    stubFetchError(502, 'TTS synthesis failed');

    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    fireEvent.click(screen.getByRole('button', { name: /generate/i })!);

    await waitFor(() => {
      expect(screen.getByText('TTS synthesis failed')).toBeInTheDocument();
    });
  });

  it('displays generic error on network failure', async () => {
    stubFetchReject('Network error');

    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    fireEvent.click(screen.getByRole('button', { name: /generate/i })!);

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('does not show voice override input by default', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    expect(
      screen.queryByPlaceholderText('Leave empty to use configured voice'),
    ).not.toBeInTheDocument();
  });

  it('shows voice override input when allowVoiceOverride is true', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" allowVoiceOverride />);

    expect(screen.getByPlaceholderText('Leave empty to use configured voice')).toBeInTheDocument();
  });

  it('updates text in textarea', () => {
    render(<TTSPreview provider="elevenlabs" serviceInstanceId="svc-123" />);

    const textarea = screen.getByPlaceholderText('Type sample text to preview...');
    fireEvent.change(textarea, { target: { value: 'Custom test text' } });

    expect(textarea).toHaveValue('Custom test text');
  });
});
