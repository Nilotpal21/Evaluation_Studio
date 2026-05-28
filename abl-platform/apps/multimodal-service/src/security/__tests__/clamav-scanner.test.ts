import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

// ---------------------------------------------------------------------------
// Mock createLogger before importing the scanner
// ---------------------------------------------------------------------------

const { mockLogError, mockLogWarn, mockLogInfo, mockLogDebug } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogDebug: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    error: mockLogError,
    warn: mockLogWarn,
    info: mockLogInfo,
    debug: mockLogDebug,
  }),
}));

// ---------------------------------------------------------------------------
// Mock the `clamscan` package before importing the scanner
// ---------------------------------------------------------------------------

const mockScanStream = vi.fn();
const mockInit = vi.fn();

vi.mock('clamscan', () => {
  return {
    default: class MockNodeClam {
      init = mockInit;
    },
  };
});

// Import *after* vi.mock so the mock takes effect
import { ClamAVScanner } from '../clamav-scanner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createReadableStream(content: string): Readable {
  return Readable.from(Buffer.from(content));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClamAVScanner', () => {
  let scanner: ClamAVScanner;

  beforeEach(() => {
    vi.clearAllMocks();

    scanner = new ClamAVScanner({ host: '127.0.0.1', port: 3310 });

    // Default: init returns an instance with scanStream
    mockInit.mockResolvedValue({ scanStream: mockScanStream });
  });

  // -------------------------------------------------------------------------
  // name property
  // -------------------------------------------------------------------------

  it('has name property equal to "clamav"', () => {
    expect(scanner.name).toBe('clamav');
  });

  // -------------------------------------------------------------------------
  // scan() — clean file
  // -------------------------------------------------------------------------

  it('returns clean status for a non-infected file', async () => {
    mockScanStream.mockResolvedValue({
      isInfected: false,
      viruses: [],
    });

    const result = await scanner.scan({
      fileStream: createReadableStream('safe file content'),
      filename: 'safe.txt',
      sizeBytes: 17,
    });

    expect(result.status).toBe('clean');
    expect(result.engine).toBe('clamav');
    expect(result.threats).toBeUndefined();
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // scan() — infected file
  // -------------------------------------------------------------------------

  it('returns infected status with threats for an infected file', async () => {
    mockScanStream.mockResolvedValue({
      isInfected: true,
      viruses: ['Eicar-Signature'],
    });

    const result = await scanner.scan({
      fileStream: createReadableStream('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR'),
      filename: 'eicar.txt',
      sizeBytes: 34,
    });

    expect(result.status).toBe('infected');
    expect(result.engine).toBe('clamav');
    expect(result.threats).toEqual(['Eicar-Signature']);
    expect(result.scannedAt).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // scan() — scanner unreachable
  // -------------------------------------------------------------------------

  it('returns error status when the ClamAV daemon is unreachable', async () => {
    mockInit.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3310'));

    const result = await scanner.scan({
      fileStream: createReadableStream('some content'),
      filename: 'test.txt',
      sizeBytes: 12,
    });

    expect(result.status).toBe('error');
    expect(result.engine).toBe('clamav');
    expect(result.threats).toBeUndefined();
    expect(result.scannedAt).toBeInstanceOf(Date);
    expect(mockLogError).toHaveBeenCalledWith(
      'Scan failed',
      expect.objectContaining({
        filename: 'test.txt',
        error: expect.stringContaining('ECONNREFUSED'),
      }),
    );
  });

  it('returns error status when scanStream throws', async () => {
    mockScanStream.mockRejectedValue(new Error('Scan timed out'));

    const result = await scanner.scan({
      fileStream: createReadableStream('some content'),
      filename: 'test.txt',
      sizeBytes: 12,
    });

    expect(result.status).toBe('error');
    expect(result.engine).toBe('clamav');
    expect(result.scannedAt).toBeInstanceOf(Date);
    expect(mockLogError).toHaveBeenCalledWith(
      'Scan failed',
      expect.objectContaining({
        filename: 'test.txt',
        error: expect.stringContaining('Scan timed out'),
      }),
    );
  });

  // -------------------------------------------------------------------------
  // healthCheck() — healthy
  // -------------------------------------------------------------------------

  it('returns ok: true when daemon is reachable', async () => {
    mockInit.mockResolvedValue({ scanStream: mockScanStream });

    const result = await scanner.healthCheck();

    expect(result.ok).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // healthCheck() — unhealthy
  // -------------------------------------------------------------------------

  it('returns ok: false when daemon is unreachable', async () => {
    mockInit.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3310'));

    const result = await scanner.healthCheck();

    expect(result.ok).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockLogError).toHaveBeenCalledWith(
      'Health check failed',
      expect.objectContaining({
        error: expect.stringContaining('ECONNREFUSED'),
      }),
    );
  });
});
