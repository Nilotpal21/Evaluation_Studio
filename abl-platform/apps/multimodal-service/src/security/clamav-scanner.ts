/**
 * ClamAV Virus Scanner
 *
 * Implements the `ScanProvider` interface from `@agent-platform/shared`
 * using the `clamscan` npm package to communicate with a ClamAV daemon
 * over TCP (clamdscan mode).
 *
 * Key guarantees:
 * - `scan()` never throws — all errors are returned as `{ status: 'error' }`
 * - `healthCheck()` never throws — connection failures return `{ ok: false }`
 * - All errors are logged with the `[ClamAVScanner]` prefix
 */

import type { Readable } from 'stream';
import type { ScanProvider } from '@agent-platform/shared';
import NodeClam from 'clamscan';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('clamav-scanner');

// =============================================================================
// TYPES
// =============================================================================

export interface ClamAVScannerOptions {
  /** ClamAV daemon host */
  host: string;
  /** ClamAV daemon port */
  port: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const ENGINE_NAME = 'clamav';

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class ClamAVScanner implements ScanProvider {
  readonly name = ENGINE_NAME;

  private readonly options: ClamAVScannerOptions;

  constructor(options: ClamAVScannerOptions) {
    this.options = options;
  }

  /**
   * Scan a file stream for malware using the ClamAV daemon.
   *
   * Initializes a fresh `NodeClam` instance configured for TCP-based
   * `clamdscan` mode, then pipes the stream through `scanStream()`.
   *
   * @returns Structured scan result — never throws.
   */
  async scan(params: { fileStream: Readable; filename: string; sizeBytes: number }): Promise<{
    status: 'clean' | 'infected' | 'error';
    engine: string;
    threats?: string[];
    scannedAt: Date;
  }> {
    try {
      const clam = await this.createInitializedInstance();
      const result = await clam.scanStream(params.fileStream);

      if (result.isInfected) {
        return {
          status: 'infected',
          engine: ENGINE_NAME,
          threats: result.viruses,
          scannedAt: new Date(),
        };
      }

      return {
        status: 'clean',
        engine: ENGINE_NAME,
        scannedAt: new Date(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Scan failed', { filename: params.filename, error: message });

      return {
        status: 'error',
        engine: ENGINE_NAME,
        scannedAt: new Date(),
      };
    }
  }

  /**
   * Check if the ClamAV daemon is reachable by attempting to initialize
   * a connection.
   *
   * @returns Health status with latency — never throws.
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.createInitializedInstance();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Health check failed', { error: message });
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  /**
   * Create and initialize a `NodeClam` instance configured for the
   * ClamAV daemon's TCP interface.
   */
  private async createInitializedInstance(): Promise<NodeClam> {
    const clam = new NodeClam();
    return clam.init({
      clamdscan: {
        host: this.options.host,
        port: this.options.port,
        socket: false,
        active: true,
        bypassTest: true,
      },
      clamscan: {
        active: false,
      },
      preference: 'clamdscan',
    });
  }
}
