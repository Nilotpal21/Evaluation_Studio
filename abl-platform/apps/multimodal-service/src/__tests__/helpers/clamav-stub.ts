/**
 * ClamAV Daemon Stub
 *
 * A minimal TCP server that implements the ClamAV daemon INSTREAM protocol
 * for testing purposes. Allows tests to verify the ClamAVScanner's
 * integration with a ClamAV-compatible daemon without requiring Docker.
 *
 * Protocol:
 * 1. Client sends `zINSTREAM\0`
 * 2. Client sends data chunks: [4-byte big-endian length][data]
 * 3. Client sends terminator: `\x00\x00\x00\x00`
 * 4. Server responds: `stream: OK\0` (clean) or `stream: <name> FOUND\0` (infected)
 *
 * The stub checks received content against a configurable set of "infected"
 * content patterns (by default, EICAR test string).
 */

import * as net from 'net';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Standard EICAR test string prefix used to trigger "infected" response. */
const EICAR_PREFIX = 'X5O!P%@AP';

/** ClamAV INSTREAM command (null-terminated). */
const INSTREAM_COMMAND = 'zINSTREAM\0';

/** ClamAV PING command (null-terminated). */
const PING_COMMAND = 'zPING\0';

// =============================================================================
// TYPES
// =============================================================================

export interface ClamAVStubOptions {
  /**
   * Content patterns that trigger an "infected" response.
   * If the received stream data contains any of these strings, the stub
   * responds with FOUND. Defaults to the EICAR test string prefix.
   */
  infectedPatterns?: string[];

  /**
   * Name of the "virus" reported when content matches an infected pattern.
   * Defaults to 'Eicar-Signature'.
   */
  virusName?: string;

  /**
   * If true, the server will forcibly close connections without responding.
   * Useful for testing connection error handling.
   */
  simulateConnectionError?: boolean;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class ClamAVStub {
  private server: net.Server | null = null;
  private readonly infectedPatterns: string[];
  private readonly virusName: string;
  private simulateConnectionError: boolean;

  /** The port the stub is listening on. Only valid after `start()` resolves. */
  port = 0;

  constructor(options?: ClamAVStubOptions) {
    this.infectedPatterns = options?.infectedPatterns ?? [EICAR_PREFIX];
    this.virusName = options?.virusName ?? 'Eicar-Signature';
    this.simulateConnectionError = options?.simulateConnectionError ?? false;
  }

  /**
   * Start the TCP server on a random available port.
   * Resolves once the server is listening.
   */
  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.on('error', (err) => {
        reject(err);
      });

      // Listen on port 0 for OS-assigned random port
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server?.address();
        if (addr && typeof addr !== 'string') {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  /**
   * Stop the TCP server and close all active connections.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /**
   * Toggle connection error simulation at runtime (for mid-test scenarios).
   */
  setSimulateConnectionError(value: boolean): void {
    this.simulateConnectionError = value;
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private handleConnection(socket: net.Socket): void {
    if (this.simulateConnectionError) {
      socket.destroy();
      return;
    }

    let receivedData = Buffer.alloc(0);
    let inStream = false;
    let streamData = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      receivedData = Buffer.concat([receivedData, chunk]);

      // Check for PING command
      if (receivedData.toString('utf-8').startsWith(PING_COMMAND.replace('\0', ''))) {
        socket.write('PONG\0');
        socket.end();
        return;
      }

      // Check for INSTREAM command
      if (!inStream) {
        const cmdStr = receivedData.toString('utf-8');
        if (cmdStr.startsWith(INSTREAM_COMMAND.replace('\0', ''))) {
          inStream = true;
          // Remove the command from the buffer
          const cmdEndIndex = INSTREAM_COMMAND.length;
          receivedData = receivedData.subarray(cmdEndIndex);
        }
      }

      if (inStream) {
        // Parse INSTREAM chunks: [4-byte big-endian length][data]
        // A zero-length chunk signals end of stream
        let offset = 0;
        const buf = receivedData;

        while (offset + 4 <= buf.length) {
          const chunkLength = buf.readUInt32BE(offset);
          offset += 4;

          if (chunkLength === 0) {
            // End of stream — generate response
            const isInfected = this.isContentInfected(streamData);
            const response = isInfected ? `stream: ${this.virusName} FOUND\0` : 'stream: OK\0';

            socket.write(response);
            socket.end();
            return;
          }

          if (offset + chunkLength <= buf.length) {
            streamData = Buffer.concat([streamData, buf.subarray(offset, offset + chunkLength)]);
            offset += chunkLength;
          } else {
            // Not enough data yet — wait for more
            break;
          }
        }

        // Keep any unparsed remainder for next data event
        receivedData = buf.subarray(offset);
      }
    });

    socket.on('error', () => {
      // Client disconnected — nothing to do
    });
  }

  /**
   * Check if the received stream data matches any infected content pattern.
   */
  private isContentInfected(data: Buffer): boolean {
    const content = data.toString('utf-8');
    return this.infectedPatterns.some((pattern) => content.includes(pattern));
  }
}
