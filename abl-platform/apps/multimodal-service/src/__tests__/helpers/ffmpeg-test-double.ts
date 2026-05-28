/**
 * FFmpeg Video Processor Test Double
 *
 * An in-memory implementation of the `VideoProcessor` interface that
 * validates input parameters and returns fixture output without requiring
 * actual FFmpeg binaries. Allows tests to verify video processing pipeline
 * integration without Docker or native dependencies.
 *
 * Key behaviors:
 * - `extractAudio()` validates params and returns a fixture audio stream
 * - `extractKeyFrames()` validates params and returns fixture PNG buffers
 * - Tracks all calls for assertion in tests
 * - Can be configured to simulate errors
 */

import { Readable } from 'stream';
import type {
  VideoProcessor,
  ExtractAudioParams,
  ExtractAudioResult,
  ExtractKeyFramesParams,
  ExtractKeyFramesResult,
  AudioOutputFormat,
} from '../../processing/video-processor-ffmpeg.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Minimum valid PNG header (8 bytes). */
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Valid audio output formats. */
const VALID_AUDIO_FORMATS = new Set<AudioOutputFormat>(['wav', 'mp3', 'ogg']);

/** Default duration for fixture audio (seconds). */
const DEFAULT_DURATION_SECONDS = 10.5;

/** Default number of frames to generate in fixture output. */
const DEFAULT_FRAME_COUNT = 3;

// =============================================================================
// TYPES
// =============================================================================

export interface FFmpegTestDoubleOptions {
  /**
   * Duration in seconds to report for extracted audio.
   * Default: 10.5
   */
  audioDurationSeconds?: number;

  /**
   * Number of frames to include in extractKeyFrames results.
   * Capped at the caller's maxFrames parameter.
   * Default: 3
   */
  frameCount?: number;

  /**
   * If set, extractAudio will return an error result with this message.
   */
  extractAudioError?: string;

  /**
   * If set, extractKeyFrames will return an error result with this message.
   */
  extractKeyFramesError?: string;
}

export interface ExtractAudioCall {
  params: ExtractAudioParams;
  calledAt: Date;
}

export interface ExtractKeyFramesCall {
  params: ExtractKeyFramesParams;
  calledAt: Date;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class FFmpegTestDouble implements VideoProcessor {
  readonly name = 'ffmpeg-test-double';

  private readonly audioDurationSeconds: number;
  private readonly frameCount: number;
  private extractAudioError: string | undefined;
  private extractKeyFramesError: string | undefined;

  /** All extractAudio calls recorded for test assertions. */
  readonly extractAudioCalls: ExtractAudioCall[] = [];

  /** All extractKeyFrames calls recorded for test assertions. */
  readonly extractKeyFramesCalls: ExtractKeyFramesCall[] = [];

  constructor(options?: FFmpegTestDoubleOptions) {
    this.audioDurationSeconds = options?.audioDurationSeconds ?? DEFAULT_DURATION_SECONDS;
    this.frameCount = options?.frameCount ?? DEFAULT_FRAME_COUNT;
    this.extractAudioError = options?.extractAudioError;
    this.extractKeyFramesError = options?.extractKeyFramesError;
  }

  /**
   * Extract audio from a video stream (test double).
   *
   * Validates input parameters, consumes the input stream, and returns
   * a fixture audio buffer as a Readable stream.
   *
   * @returns Structured result — never throws.
   */
  async extractAudio(params: ExtractAudioParams): Promise<ExtractAudioResult> {
    this.extractAudioCalls.push({ params, calledAt: new Date() });

    // Validate output format
    if (!VALID_AUDIO_FORMATS.has(params.outputFormat)) {
      return {
        success: false,
        durationSeconds: 0,
        format: params.outputFormat,
        error: `Invalid output format: ${params.outputFormat}`,
      };
    }

    // Simulate configured error
    if (this.extractAudioError) {
      return {
        success: false,
        durationSeconds: 0,
        format: params.outputFormat,
        error: this.extractAudioError,
      };
    }

    // Consume the input stream (required to avoid backpressure issues)
    await this.consumeStream(params.videoStream);

    // Generate fixture audio data (a simple buffer — not real audio)
    const fixtureAudio = Buffer.from(`fixture-audio-${params.outputFormat}`, 'utf-8');
    const audioStream = Readable.from(fixtureAudio);

    return {
      success: true,
      audioStream,
      durationSeconds: this.audioDurationSeconds,
      format: params.outputFormat,
    };
  }

  /**
   * Extract key frames from a video stream (test double).
   *
   * Validates input parameters, consumes the input stream, and returns
   * fixture PNG buffers with estimated timestamps.
   *
   * @returns Structured result — never throws.
   */
  async extractKeyFrames(params: ExtractKeyFramesParams): Promise<ExtractKeyFramesResult> {
    this.extractKeyFramesCalls.push({ params, calledAt: new Date() });

    // Validate strategy
    if (params.strategy !== 'interval' && params.strategy !== 'scene_change') {
      return {
        success: false,
        frames: [],
        timestamps: [],
        totalFramesExtracted: 0,
        error: `Invalid strategy: ${String(params.strategy)}`,
      };
    }

    // Validate maxFrames
    if (params.maxFrames <= 0) {
      return {
        success: false,
        frames: [],
        timestamps: [],
        totalFramesExtracted: 0,
        error: `maxFrames must be positive, got ${params.maxFrames}`,
      };
    }

    // Simulate configured error
    if (this.extractKeyFramesError) {
      return {
        success: false,
        frames: [],
        timestamps: [],
        totalFramesExtracted: 0,
        error: this.extractKeyFramesError,
      };
    }

    // Consume the input stream
    await this.consumeStream(params.videoStream);

    // Generate fixture frames (PNG header + index marker)
    const actualFrameCount = Math.min(this.frameCount, params.maxFrames);
    const frames: Buffer[] = [];
    const timestamps: number[] = [];
    const interval = params.intervalSeconds ?? 1;

    for (let i = 0; i < actualFrameCount; i++) {
      // Create a buffer that starts with a valid PNG header + frame index
      const frameMarker = Buffer.from(`-frame-${i}`, 'utf-8');
      frames.push(Buffer.concat([PNG_HEADER, frameMarker]));

      if (params.strategy === 'interval') {
        timestamps.push(i * interval);
      } else {
        // scene_change: use frame index as timestamp estimate
        timestamps.push(i);
      }
    }

    return {
      success: true,
      frames,
      timestamps,
      totalFramesExtracted: actualFrameCount,
    };
  }

  /**
   * Set extractAudio error at runtime (for mid-test scenarios).
   */
  setExtractAudioError(error: string | undefined): void {
    this.extractAudioError = error;
  }

  /**
   * Set extractKeyFrames error at runtime (for mid-test scenarios).
   */
  setExtractKeyFramesError(error: string | undefined): void {
    this.extractKeyFramesError = error;
  }

  /**
   * Reset all recorded calls (for use in beforeEach).
   */
  reset(): void {
    this.extractAudioCalls.length = 0;
    this.extractKeyFramesCalls.length = 0;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  /**
   * Consume a Readable stream fully without storing its contents.
   * This prevents backpressure issues and mimics real processing.
   */
  private consumeStream(stream: Readable): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      stream.on('data', () => {
        // Consume but discard
      });
      stream.on('end', () => resolve());
      stream.on('error', (err) => reject(err));
    });
  }
}
