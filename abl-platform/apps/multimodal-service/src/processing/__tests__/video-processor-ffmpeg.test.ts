import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'stream';

// =============================================================================
// HOISTED MOCKS (vi.mock factories are hoisted — variables must be too)
// =============================================================================

const { mockFfmpeg, mockFsMethods } = vi.hoisted(() => {
  const mockFfmpegInstance = {
    input: vi.fn().mockReturnThis(),
    noVideo: vi.fn().mockReturnThis(),
    audioCodec: vi.fn().mockReturnThis(),
    format: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    run: vi.fn(),
    kill: vi.fn(),
    setFfmpegPath: vi.fn().mockReturnThis(),
    setFfprobePath: vi.fn().mockReturnThis(),
  };

  const ffmpegFn = vi.fn(() => ({ ...mockFfmpegInstance })) as any;
  ffmpegFn.ffprobe = vi.fn();
  ffmpegFn.setFfmpegPath = vi.fn();
  ffmpegFn.setFfprobePath = vi.fn();
  ffmpegFn._instance = mockFfmpegInstance;

  // Mock file handle returned by fs.open
  const mockFileHandle = {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const fsMethods = {
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from('mock-audio-data')),
    readdir: vi.fn().mockResolvedValue([] as string[]),
    unlink: vi.fn().mockResolvedValue(undefined),
    mkdtemp: vi.fn().mockResolvedValue('/tmp/ffmpeg-test-abc123'),
    rm: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue(mockFileHandle),
  };

  return { mockFfmpeg: ffmpegFn, mockFsMethods: fsMethods, mockFileHandle };
});

vi.mock('fluent-ffmpeg', () => {
  return { default: mockFfmpeg };
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return { ...actual, ...mockFsMethods };
});

// =============================================================================
// IMPORTS (after mocks are set up)
// =============================================================================

import * as fs from 'fs/promises';
import { FFmpegVideoProcessor } from '../video-processor-ffmpeg.js';
import type { FFmpegVideoProcessorOptions } from '../video-processor-ffmpeg.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/** Create a Readable stream from a buffer for test inputs. */
function createTestStream(data: string | Buffer = 'fake-video-data'): Readable {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return Readable.from(buf);
}

/**
 * Helper to make the mock ffmpeg instance trigger the 'end' event
 * when `run()` is called. This simulates successful ffmpeg execution.
 */
function setupFfmpegSuccess(): void {
  mockFfmpeg.mockImplementation(() => {
    const handlers: Record<string, Function> = {};

    const instance = {
      input: vi.fn().mockReturnValue(null as any),
      noVideo: vi.fn().mockReturnValue(null as any),
      audioCodec: vi.fn().mockReturnValue(null as any),
      format: vi.fn().mockReturnValue(null as any),
      outputOptions: vi.fn().mockReturnValue(null as any),
      output: vi.fn().mockReturnValue(null as any),
      kill: vi.fn(),
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
        return instance;
      }),
      run: vi.fn(() => {
        if (handlers['end']) {
          Promise.resolve().then(() => handlers['end']());
        }
      }),
    };

    // Make all chainable methods return `instance`
    instance.input.mockReturnValue(instance);
    instance.noVideo.mockReturnValue(instance);
    instance.audioCodec.mockReturnValue(instance);
    instance.format.mockReturnValue(instance);
    instance.outputOptions.mockReturnValue(instance);
    instance.output.mockReturnValue(instance);

    return instance;
  });
}

/**
 * Helper to make the mock ffmpeg instance trigger the 'error' event
 * when `run()` is called. This simulates an ffmpeg failure.
 */
function setupFfmpegError(errorMessage: string): void {
  mockFfmpeg.mockImplementation(() => {
    const handlers: Record<string, Function> = {};

    const instance = {
      input: vi.fn().mockReturnValue(null as any),
      noVideo: vi.fn().mockReturnValue(null as any),
      audioCodec: vi.fn().mockReturnValue(null as any),
      format: vi.fn().mockReturnValue(null as any),
      outputOptions: vi.fn().mockReturnValue(null as any),
      output: vi.fn().mockReturnValue(null as any),
      kill: vi.fn(),
      on: vi.fn((event: string, cb: Function) => {
        handlers[event] = cb;
        return instance;
      }),
      run: vi.fn(() => {
        if (handlers['error']) {
          Promise.resolve().then(() => handlers['error'](new Error(errorMessage)));
        }
      }),
    };

    instance.input.mockReturnValue(instance);
    instance.noVideo.mockReturnValue(instance);
    instance.audioCodec.mockReturnValue(instance);
    instance.format.mockReturnValue(instance);
    instance.outputOptions.mockReturnValue(instance);
    instance.output.mockReturnValue(instance);

    return instance;
  });
}

/**
 * Setup ffprobe mock to return duration metadata.
 */
function setupFfprobe(durationSeconds: number): void {
  mockFfmpeg.ffprobe.mockImplementation(
    (_filePath: string, cb: (err: Error | null, data: any) => void) => {
      cb(null, {
        format: { duration: durationSeconds },
        streams: [{ codec_type: 'audio', duration: durationSeconds }],
      });
    },
  );
}

/**
 * Setup ffprobe mock to fail.
 */
function setupFfprobeError(errorMessage: string): void {
  mockFfmpeg.ffprobe.mockImplementation(
    (_filePath: string, cb: (err: Error | null, data: any) => void) => {
      cb(new Error(errorMessage), null);
    },
  );
}

// =============================================================================
// TESTS
// =============================================================================

describe('FFmpegVideoProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupFfmpegSuccess();
    setupFfprobe(120.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('creates instance with default options', () => {
      const processor = new FFmpegVideoProcessor();

      expect(processor.name).toBe('ffmpeg');
    });

    it('accepts custom ffmpeg path', () => {
      const options: FFmpegVideoProcessorOptions = {
        ffmpegPath: '/usr/local/bin/ffmpeg',
        ffprobePath: '/usr/local/bin/ffprobe',
      };

      const processor = new FFmpegVideoProcessor(options);

      expect(processor.name).toBe('ffmpeg');
      // Verify setFfmpegPath was called on the module
      expect(mockFfmpeg.setFfmpegPath).toHaveBeenCalledWith('/usr/local/bin/ffmpeg');
      expect(mockFfmpeg.setFfprobePath).toHaveBeenCalledWith('/usr/local/bin/ffprobe');
    });

    it('accepts custom timeout', () => {
      const processor = new FFmpegVideoProcessor({ timeoutMs: 60_000 });

      expect(processor.name).toBe('ffmpeg');
    });
  });

  // ---------------------------------------------------------------------------
  // extractAudio
  // ---------------------------------------------------------------------------

  describe('extractAudio', () => {
    it('writes input stream to temp file via fs.open and runs ffmpeg', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'wav',
      });

      // Should have opened a temp file for writing
      expect(fs.open).toHaveBeenCalled();
      // Should have called ffmpeg
      expect(mockFfmpeg).toHaveBeenCalled();
    });

    it('returns audio stream with duration', async () => {
      setupFfprobe(95.3);
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'mp3',
      });

      expect(result.success).toBe(true);
      expect(result.durationSeconds).toBe(95.3);
      expect(result.audioStream).toBeDefined();
      expect(result.format).toBe('mp3');
    });

    it('uses correct output format for wav', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'wav',
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('wav');
    });

    it('uses correct output format for ogg', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'ogg',
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('ogg');
    });

    it('cleans up temp files on success', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'wav',
      });

      // Both input and output temp files should be cleaned up
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('cleans up temp files on ffmpeg error', async () => {
      setupFfmpegError('ffmpeg process exited with code 1');
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'wav',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ffmpeg process exited with code 1');
      // Temp files should still be cleaned up
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('returns structured error on ffprobe failure', async () => {
      setupFfprobeError('Cannot determine duration');
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractAudio({
        videoStream: stream,
        outputFormat: 'mp3',
      });

      // Should still succeed for audio extraction even if duration probe fails
      // Duration should fall back to 0
      expect(result.success).toBe(true);
      expect(result.durationSeconds).toBe(0);
    });

    it('rejects input video exceeding max size', async () => {
      // Create a stream that reports more than 500MB
      const bigChunk = Buffer.alloc(1024 * 1024); // 1MB chunk
      let bytesSent = 0;
      const maxBytes = 500 * 1024 * 1024;

      // Override the mock file handle write to track bytes and simulate the size check
      // The implementation checks totalBytes > MAX_INPUT_SIZE_BYTES during streaming
      const mockFileHandle = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockFsMethods.open.mockResolvedValue(mockFileHandle);

      // Create a stream that pushes data beyond the limit
      const oversizedStream = new Readable({
        read() {
          if (bytesSent < maxBytes + 1024 * 1024) {
            this.push(bigChunk);
            bytesSent += bigChunk.length;
          } else {
            this.push(null);
          }
        },
      });

      const processor = new FFmpegVideoProcessor();
      const result = await processor.extractAudio({
        videoStream: oversizedStream,
        outputFormat: 'wav',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum allowed size');
      // File handle should still be closed
      expect(mockFileHandle.close).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // extractKeyFrames
  // ---------------------------------------------------------------------------

  describe('extractKeyFrames', () => {
    beforeEach(() => {
      // Mock readdir to return some frame files
      mockFsMethods.readdir.mockResolvedValue(['frame-001.png', 'frame-002.png', 'frame-003.png']);
      // Mock readFile to return fake image data for each frame
      mockFsMethods.readFile.mockResolvedValue(Buffer.from('fake-png-frame-data'));
    });

    it('extracts frames at specified interval', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'interval',
        maxFrames: 10,
        intervalSeconds: 5,
      });

      expect(result.success).toBe(true);
      expect(result.frames.length).toBe(3);
      expect(result.frames[0]).toBeInstanceOf(Buffer);
    });

    it('uses scene change detection strategy', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'scene_change',
        maxFrames: 10,
      });

      expect(result.success).toBe(true);
      expect(result.frames.length).toBe(3);
    });

    it('caps output at maxFrames', async () => {
      // Return more frames than maxFrames
      mockFsMethods.readdir.mockResolvedValue([
        'frame-001.png',
        'frame-002.png',
        'frame-003.png',
        'frame-004.png',
        'frame-005.png',
      ]);

      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'interval',
        maxFrames: 3,
        intervalSeconds: 2,
      });

      expect(result.success).toBe(true);
      expect(result.frames.length).toBeLessThanOrEqual(3);
      expect(result.totalFramesExtracted).toBe(3);
    });

    it('cleans up temp files after extraction', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'interval',
        maxFrames: 10,
        intervalSeconds: 5,
      });

      // Temp directory should be cleaned up via rm
      expect(fs.rm).toHaveBeenCalled();
    });

    it('returns structured error on ffmpeg failure', async () => {
      setupFfmpegError('Scene detection failed');
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'scene_change',
        maxFrames: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Scene detection failed');
      expect(result.frames).toEqual([]);
      expect(result.timestamps).toEqual([]);
    });

    it('returns empty result when no frames are extracted', async () => {
      mockFsMethods.readdir.mockResolvedValue([]);

      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'interval',
        maxFrames: 10,
        intervalSeconds: 5,
      });

      expect(result.success).toBe(true);
      expect(result.frames).toEqual([]);
      expect(result.timestamps).toEqual([]);
      expect(result.totalFramesExtracted).toBe(0);
    });

    it('uses default interval of 1s when intervalSeconds not provided', async () => {
      const processor = new FFmpegVideoProcessor();
      const stream = createTestStream();

      const result = await processor.extractKeyFrames({
        videoStream: stream,
        strategy: 'interval',
        maxFrames: 10,
      });

      expect(result.success).toBe(true);
    });

    it('rejects oversized video input', async () => {
      const bigChunk = Buffer.alloc(1024 * 1024);
      let bytesSent = 0;
      const maxBytes = 500 * 1024 * 1024;

      const mockFileHandle = {
        write: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockFsMethods.open.mockResolvedValue(mockFileHandle);

      const oversizedStream = new Readable({
        read() {
          if (bytesSent < maxBytes + 1024 * 1024) {
            this.push(bigChunk);
            bytesSent += bigChunk.length;
          } else {
            this.push(null);
          }
        },
      });

      const processor = new FFmpegVideoProcessor();
      const result = await processor.extractKeyFrames({
        videoStream: oversizedStream,
        strategy: 'interval',
        maxFrames: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('exceeds maximum allowed size');
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout behavior
  // ---------------------------------------------------------------------------

  describe('timeout', () => {
    it('kills ffmpeg process with SIGKILL on timeout', async () => {
      vi.useFakeTimers();

      let killFn: ReturnType<typeof vi.fn>;

      // Create an ffmpeg mock that never resolves (simulates hanging process)
      mockFfmpeg.mockImplementation(() => {
        const handlers: Record<string, Function> = {};
        killFn = vi.fn();

        const instance = {
          input: vi.fn().mockReturnValue(null as any),
          noVideo: vi.fn().mockReturnValue(null as any),
          audioCodec: vi.fn().mockReturnValue(null as any),
          format: vi.fn().mockReturnValue(null as any),
          outputOptions: vi.fn().mockReturnValue(null as any),
          output: vi.fn().mockReturnValue(null as any),
          kill: killFn,
          on: vi.fn((event: string, cb: Function) => {
            handlers[event] = cb;
            return instance;
          }),
          run: vi.fn(), // Never calls 'end' or 'error' — simulates hang
        };

        instance.input.mockReturnValue(instance);
        instance.noVideo.mockReturnValue(instance);
        instance.audioCodec.mockReturnValue(instance);
        instance.format.mockReturnValue(instance);
        instance.outputOptions.mockReturnValue(instance);
        instance.output.mockReturnValue(instance);

        return instance;
      });

      const processor = new FFmpegVideoProcessor({ timeoutMs: 5000 });
      const stream = createTestStream();

      const resultPromise = processor.extractAudio({
        videoStream: stream,
        outputFormat: 'wav',
      });

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
      expect(killFn!).toHaveBeenCalledWith('SIGKILL');

      vi.useRealTimers();
    });
  });
});
