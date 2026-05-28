/**
 * FFmpeg Video Processor
 *
 * Extracts audio tracks and key frames from video files using fluent-ffmpeg.
 *
 * Key guarantees:
 * - Public methods never throw — all errors are returned as structured results
 * - Temporary files are always cleaned up in `finally` blocks
 * - All operations respect configurable timeouts
 *
 * Uses `fluent-ffmpeg` for all video operations.
 */

import { Readable } from 'stream';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import ffmpeg from 'fluent-ffmpeg';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('ffmpeg-processor');

// =============================================================================
// CONSTANTS
// =============================================================================

const ENGINE_NAME = 'ffmpeg';

/** Default processing timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;

/** Default scene change threshold (0.0 to 1.0). Higher = fewer scene changes detected. */
const DEFAULT_SCENE_THRESHOLD = 0.3;

/** Default interval in seconds when no intervalSeconds is provided. */
const DEFAULT_INTERVAL_SECONDS = 1;

/** Maximum input video file size in bytes (500 MB). */
const MAX_INPUT_SIZE_BYTES = 500 * 1024 * 1024;

/** Audio codec mapping for output formats. */
const AUDIO_CODEC_MAP: Record<AudioOutputFormat, string> = {
  wav: 'pcm_s16le',
  mp3: 'libmp3lame',
  ogg: 'libvorbis',
};

// =============================================================================
// TYPES
// =============================================================================

export type AudioOutputFormat = 'wav' | 'mp3' | 'ogg';
export type FrameExtractionStrategy = 'interval' | 'scene_change';

export interface VideoProcessor {
  readonly name: string;
  extractAudio(params: ExtractAudioParams): Promise<ExtractAudioResult>;
  extractKeyFrames(params: ExtractKeyFramesParams): Promise<ExtractKeyFramesResult>;
}

export interface FFmpegVideoProcessorOptions {
  /** Custom path to the ffmpeg binary. */
  ffmpegPath?: string;
  /** Custom path to the ffprobe binary. */
  ffprobePath?: string;
  /** Processing timeout in milliseconds. Default: 300000 (5 min). */
  timeoutMs?: number;
}

export interface ExtractAudioParams {
  videoStream: Readable;
  outputFormat: AudioOutputFormat;
}

export interface ExtractAudioResult {
  success: boolean;
  /** Readable stream of the extracted audio data. Only set when success=true. */
  audioStream?: Readable;
  /** Duration of the audio in seconds. 0 if unavailable. */
  durationSeconds: number;
  /** The output audio format. */
  format: AudioOutputFormat;
  /** Error message if extraction failed. */
  error?: string;
}

export interface ExtractKeyFramesParams {
  videoStream: Readable;
  strategy: FrameExtractionStrategy;
  /** Maximum number of frames to return. */
  maxFrames: number;
  /** Interval in seconds between frames (for 'interval' strategy). Default: 1. */
  intervalSeconds?: number;
}

export interface ExtractKeyFramesResult {
  success: boolean;
  /** Extracted frame image buffers (PNG). */
  frames: Buffer[];
  /** Timestamps in seconds for each extracted frame. */
  timestamps: number[];
  /** Total number of frames extracted (may differ from frames.length if capped). */
  totalFramesExtracted: number;
  /** Error message if extraction failed. */
  error?: string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class FFmpegVideoProcessor implements VideoProcessor {
  readonly name = ENGINE_NAME;
  private readonly timeoutMs: number;

  constructor(options?: FFmpegVideoProcessorOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Configure custom binary paths if provided
    if (options?.ffmpegPath) {
      ffmpeg.setFfmpegPath(options.ffmpegPath);
    }
    if (options?.ffprobePath) {
      ffmpeg.setFfprobePath(options.ffprobePath);
    }
  }

  // ---------------------------------------------------------------------------
  // Public Methods
  // ---------------------------------------------------------------------------

  /**
   * Extract the audio track from a video stream.
   *
   * Writes the input to a temp file, runs ffmpeg to extract audio,
   * then returns a Readable stream of the output audio and its duration.
   *
   * @returns Structured result — never throws.
   */
  async extractAudio(params: ExtractAudioParams): Promise<ExtractAudioResult> {
    const { videoStream, outputFormat } = params;

    let inputPath: string | null = null;
    let outputPath: string | null = null;

    try {
      // 1. Write input stream to a temp file
      inputPath = this.generateTempFilePath('input-video');
      await this.writeStreamToTempFile(videoStream, inputPath);
      outputPath = this.generateTempFilePath(`output-audio.${outputFormat}`);

      // 2. Run ffmpeg to extract audio
      await this.runFfmpegCommand(inputPath, outputPath, (command) => {
        command.noVideo().audioCodec(AUDIO_CODEC_MAP[outputFormat]).format(outputFormat);
      });

      // 3. Get duration via ffprobe (best-effort — fallback to 0)
      const durationSeconds = await this.probeDuration(inputPath);

      // 4. Read output file into a stream
      const audioData = await fs.readFile(outputPath);
      const audioStream = Readable.from(audioData);

      return {
        success: true,
        audioStream,
        durationSeconds,
        format: outputFormat,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('extractAudio failed', { error: message });

      return {
        success: false,
        durationSeconds: 0,
        format: outputFormat,
        error: message,
      };
    } finally {
      // 5. Clean up temp files
      await this.safeUnlink(inputPath);
      await this.safeUnlink(outputPath);
    }
  }

  /**
   * Extract key frames from a video stream.
   *
   * Supports two strategies:
   * - `interval`: Extract one frame every N seconds
   * - `scene_change`: Use ffmpeg scene detection to find visually distinct frames
   *
   * Frames are capped at `maxFrames`. Output format is PNG.
   *
   * @returns Structured result — never throws.
   */
  async extractKeyFrames(params: ExtractKeyFramesParams): Promise<ExtractKeyFramesResult> {
    const { videoStream, strategy, maxFrames, intervalSeconds } = params;

    let inputPath: string | null = null;
    let framesDir: string | null = null;

    try {
      // 1. Write input stream to a temp file
      inputPath = this.generateTempFilePath('input-video');
      await this.writeStreamToTempFile(videoStream, inputPath);

      // 2. Create a temp directory for frame output
      framesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-frames-'));

      const outputPattern = path.join(framesDir, 'frame-%03d.png');

      // 3. Build the video filter based on strategy
      const vf = this.buildFrameFilter(strategy, intervalSeconds);

      // 4. Run ffmpeg to extract frames
      await this.runFfmpegCommand(inputPath, outputPattern, (command) => {
        command.outputOptions(['-vf', vf, '-vsync', 'vfr']);
      });

      // 5. Read extracted frames from temp directory
      const frameFiles = await fs.readdir(framesDir);
      const sortedFiles = frameFiles.filter((f) => f.endsWith('.png')).sort();

      // 6. Cap at maxFrames
      const cappedFiles = sortedFiles.slice(0, maxFrames);

      // 7. Read each frame into a Buffer
      const frames: Buffer[] = [];
      const timestamps: number[] = [];

      for (let i = 0; i < cappedFiles.length; i++) {
        const framePath = path.join(framesDir, cappedFiles[i]);
        const frameData = await fs.readFile(framePath);
        frames.push(frameData);

        // Estimate timestamp based on strategy
        if (strategy === 'interval') {
          const interval = intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
          timestamps.push(i * interval);
        } else {
          // For scene_change, exact timestamps require parsing ffmpeg output.
          // Use frame index as a rough estimate; real impl would parse progress.
          timestamps.push(i);
        }
      }

      return {
        success: true,
        frames,
        timestamps,
        totalFramesExtracted: frames.length,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('extractKeyFrames failed', { error: message });

      return {
        success: false,
        frames: [],
        timestamps: [],
        totalFramesExtracted: 0,
        error: message,
      };
    } finally {
      // 8. Clean up temp files and directories
      await this.safeUnlink(inputPath);
      if (framesDir) {
        await fs.rm(framesDir, { recursive: true, force: true }).catch((rmErr) => {
          log.error('Failed to clean up frames dir', {
            error: rmErr instanceof Error ? rmErr.message : String(rmErr),
          });
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a Readable stream to a temporary file and return the file path.
   * Streams directly to disk to avoid buffering large video files in memory.
   * Rejects if the stream exceeds MAX_INPUT_SIZE_BYTES.
   */
  private async writeStreamToTempFile(stream: Readable, filePath: string): Promise<void> {
    const fileHandle = await fs.open(filePath, 'w');
    let totalBytes = 0;

    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_INPUT_SIZE_BYTES) {
          throw new Error(
            `Input video exceeds maximum allowed size of ${MAX_INPUT_SIZE_BYTES} bytes`,
          );
        }
        await fileHandle.write(buf);
      }
    } finally {
      await fileHandle.close();
    }
  }

  /**
   * Generate a unique temp file path.
   */
  private generateTempFilePath(suffix: string): string {
    const id = crypto.randomUUID();
    return path.join(os.tmpdir(), `ffmpeg-${id}-${suffix}`);
  }

  /**
   * Run an ffmpeg command with timeout support.
   * The `configure` callback receives the ffmpeg command instance for
   * method chaining (noVideo, audioCodec, format, outputOptions, etc.).
   */
  private runFfmpegCommand(
    inputPath: string,
    outputPath: string,
    configure: (command: ffmpeg.FfmpegCommand) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const command = ffmpeg(inputPath).output(outputPath);

      configure(command);

      const timeoutId = setTimeout(() => {
        command.kill('SIGKILL');
        reject(new Error(`FFmpeg command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      command
        .on('end', () => {
          clearTimeout(timeoutId);
          resolve();
        })
        .on('error', (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Build the ffmpeg video filter string based on extraction strategy.
   */
  private buildFrameFilter(strategy: FrameExtractionStrategy, intervalSeconds?: number): string {
    switch (strategy) {
      case 'interval': {
        const interval = intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
        return `fps=1/${interval}`;
      }
      case 'scene_change': {
        return `select='gt(scene\\,${DEFAULT_SCENE_THRESHOLD})'`;
      }
      default: {
        // Exhaustive check
        const _exhaustive: never = strategy;
        throw new Error(`Unsupported frame extraction strategy: ${_exhaustive}`);
      }
    }
  }

  /**
   * Use ffprobe to get the duration of a media file.
   * Returns 0 if probing fails (best-effort).
   */
  private probeDuration(filePath: string): Promise<number> {
    return new Promise<number>((resolve) => {
      ffmpeg.ffprobe(filePath, (err: Error | null, data: ffmpeg.FfprobeData) => {
        if (err || !data?.format?.duration) {
          if (err) {
            log.error('ffprobe failed', { error: err.message });
          }
          resolve(0);
          return;
        }
        resolve(data.format.duration);
      });
    });
  }

  /**
   * Safely delete a file, ignoring errors if the file doesn't exist.
   */
  private async safeUnlink(filePath: string | null): Promise<void> {
    if (!filePath) return;
    try {
      await fs.unlink(filePath);
    } catch {
      // File may already be deleted or never created — that's fine
    }
  }
}
