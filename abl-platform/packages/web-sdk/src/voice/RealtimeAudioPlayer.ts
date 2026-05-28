/**
 * Realtime Audio Player
 *
 * Web Audio API player for realtime PCM audio streams from
 * realtime voice LLM providers. Handles:
 * - PCM16 decoding and playback
 * - Buffer queue for smooth playback
 * - Interrupt support (clear queue on barge-in)
 * - AudioContext lifecycle management
 */

const DEFAULT_SAMPLE_RATE = 24000;

export class RealtimeAudioPlayer {
  private audioContext: AudioContext | null = null;
  private sampleRate: number;
  private queue: AudioBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private nextStartTime = 0;
  private _isSpeaking = false;
  private onSpeakingChange?: (isSpeaking: boolean) => void;

  constructor(opts?: { sampleRate?: number; onSpeakingChange?: (isSpeaking: boolean) => void }) {
    this.sampleRate = opts?.sampleRate || DEFAULT_SAMPLE_RATE;
    this.onSpeakingChange = opts?.onSpeakingChange;
  }

  /**
   * Initialize the AudioContext. Must be called from a user gesture
   * on some browsers due to autoplay restrictions.
   */
  async init(): Promise<void> {
    if (this.audioContext) return;
    this.audioContext = new AudioContext({ sampleRate: this.sampleRate });
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Enqueue a PCM16 audio chunk for playback.
   * The chunk should be raw PCM16 bytes (little-endian, mono).
   */
  enqueue(pcm16Data: ArrayBuffer): void {
    if (!this.audioContext) return;

    const int16 = new Int16Array(pcm16Data);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const audioBuffer = this.audioContext.createBuffer(1, float32.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(float32);
    this.queue.push(audioBuffer);

    if (!this.isPlaying) {
      this.playNext();
    }
  }

  /**
   * Interrupt playback — clears the queue and stops current audio.
   * Used for barge-in support.
   */
  interrupt(): void {
    this.queue.length = 0;
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // Already stopped
      }
      this.currentSource = null;
    }
    this.isPlaying = false;
    this.nextStartTime = 0;
    this.setSpeaking(false);
  }

  /**
   * Clean up resources.
   */
  async destroy(): Promise<void> {
    this.onSpeakingChange = undefined;
    this.interrupt();
    const audioContext = this.audioContext;
    this.audioContext = null;

    if (audioContext) {
      await audioContext.close();
    }
  }

  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private playNext(): void {
    if (!this.audioContext || this.queue.length === 0) {
      this.isPlaying = false;
      this.setSpeaking(false);
      return;
    }

    this.isPlaying = true;
    this.setSpeaking(true);

    const buffer = this.queue.shift()!;
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext.destination);

    // Schedule playback at the correct time for gapless audio
    const startTime = Math.max(this.audioContext.currentTime, this.nextStartTime);
    source.start(startTime);
    this.nextStartTime = startTime + buffer.duration;
    this.currentSource = source;

    source.onended = () => {
      this.currentSource = null;
      // Use queueMicrotask to break synchronous recursion when many
      // short audio chunks finish rapidly — prevents call stack overflow.
      queueMicrotask(() => this.playNext());
    };
  }

  private setSpeaking(value: boolean): void {
    if (this._isSpeaking !== value) {
      this._isSpeaking = value;
      this.onSpeakingChange?.(value);
    }
  }
}
