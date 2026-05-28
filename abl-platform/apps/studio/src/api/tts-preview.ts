/**
 * TTS Preview API Client
 *
 * Calls the runtime TTS preview endpoint to synthesize sample text
 * and return playable audio. Used by the TTSPreview component.
 */

import { apiFetch } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface TtsPreviewParams {
  text: string;
  serviceInstanceId: string;
  provider: 'elevenlabs' | 'custom:orpheus';
  voice?: string;
  model?: string;
  language?: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  useSpeakerBoost?: boolean;
}

export interface TtsPreviewResult {
  audioBlob: Blob;
  contentType: string;
  latencyMs: number;
}

// =============================================================================
// API
// =============================================================================

export async function synthesizeTTSPreview(params: TtsPreviewParams): Promise<TtsPreviewResult> {
  const response = await apiFetch('/api/voice/tts-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    let errorMessage = `TTS preview failed (${response.status})`;
    try {
      const errorBody = await response.json();
      if (errorBody?.error?.message) {
        errorMessage = errorBody.error.message;
      }
    } catch {
      // Response body wasn't JSON — use the status-based message
    }
    throw new Error(errorMessage);
  }

  const contentType = response.headers.get('Content-Type') || 'audio/mpeg';
  const latencyHeader = response.headers.get('X-Synthesis-Latency-Ms');
  const latencyMs = latencyHeader ? parseInt(latencyHeader, 10) : 0;
  const audioBlob = await response.blob();

  return { audioBlob, contentType, latencyMs };
}
