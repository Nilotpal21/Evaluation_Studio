/**
 * AudioCapture — Mic access, AudioContext management, and PCM16 encoding.
 *
 * Encapsulates getUserMedia + ScriptProcessorNode to capture audio frames
 * and emit them as PCM16 data. No VAD dependency — VAD is layered on top.
 *
 * Extracted from apps/studio/src/app/preview/page.tsx inline implementation.
 */

import { TypedEventEmitter } from '../core/EventEmitter.js';

// =============================================================================
// TYPES
// =============================================================================

export interface AudioCaptureOptions {
  /** Sample rate for AudioContext (default: 16000) */
  sampleRate?: number;
  /** ScriptProcessorNode buffer size (default: 4096) */
  bufferSize?: number;
  /** Specific audio device ID to use */
  deviceId?: string;
}

export interface AudioCaptureEvents {
  /** Emitted per audio frame with raw PCM16 and float32 data */
  audioData: { pcm16: Int16Array; float32: Float32Array };
  /** Emitted when capture starts */
  started: void;
  /** Emitted when capture stops */
  stopped: void;
  /** Emitted on error */
  error: { error: Error };
}

// =============================================================================
// AUDIO CAPTURE
// =============================================================================

export class AudioCapture extends TypedEventEmitter<AudioCaptureEvents> {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private active = false;

  /**
   * Start capturing audio from the microphone.
   * Requests getUserMedia, creates AudioContext + ScriptProcessorNode,
   * and begins emitting audioData events per frame.
   */
  async start(options?: AudioCaptureOptions): Promise<void> {
    if (this.active) return;

    const sampleRate = options?.sampleRate ?? 16000;
    const bufferSize = options?.bufferSize ?? 4096;

    try {
      // Request microphone access
      const constraints: MediaStreamConstraints = {
        audio: options?.deviceId
          ? { deviceId: { exact: options.deviceId }, sampleRate: { ideal: sampleRate } }
          : { sampleRate: { ideal: sampleRate } },
      };
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Create AudioContext
      this.audioContext = new AudioContext({ sampleRate });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Wire up: mic → source → processor → destination
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.processor.onaudioprocess = (event) => {
        if (!this.active) return;
        const float32 = event.inputBuffer.getChannelData(0);
        // Copy to avoid buffer reuse issues
        const float32Copy = new Float32Array(float32);
        const pcm16 = AudioCapture.float32ToPCM16(float32Copy);
        this.emit('audioData', { pcm16, float32: float32Copy });
      };

      this.sourceNode.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.active = true;
      this.emit('started', undefined);
    } catch (err) {
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', { error });
      throw error;
    }
  }

  /**
   * Stop capturing audio and release all resources.
   */
  stop(): void {
    if (!this.active) return;
    this.cleanup();
    this.emit('stopped', undefined);
  }

  /**
   * Whether audio capture is currently active.
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get the underlying MediaStream (for mute/unmute track control).
   */
  getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  // ===========================================================================
  // STATIC HELPERS
  // ===========================================================================

  /**
   * Convert Float32Array audio samples to Int16Array (PCM 16-bit).
   * Clamps to [-1, 1] and scales to 16-bit range.
   */
  static float32ToPCM16(float32: Float32Array): Int16Array {
    const pcm16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm16;
  }

  /**
   * Convert Int16Array (PCM16) to base64-encoded string for WebSocket transport.
   */
  static pcm16ToBase64(pcm16: Int16Array): string {
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private cleanup(): void {
    this.active = false;

    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        /* already disconnected */
      }
      this.processor = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        /* already disconnected */
      }
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext) {
      this.audioContext.close().catch(() => {
        /* ignore close errors */
      });
      this.audioContext = null;
    }
  }
}
