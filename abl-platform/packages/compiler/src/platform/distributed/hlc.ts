/**
 * Hybrid Logical Clock (HLC)
 *
 * Provides causal ordering of trace events across pods in a distributed
 * Kubernetes deployment. Combines physical wall clock time with a logical
 * counter to disambiguate events within the same millisecond, even when
 * clocks are skewed across nodes.
 *
 * Algorithm based on "Logical Physical Clocks" (Kulkarni et al., 2014).
 */

export interface HLCTimestamp {
  /** Wall clock milliseconds */
  wallMs: number;
  /** Logical counter (disambiguates within same ms) */
  logical: number;
  /** Pod/node identifier */
  nodeId: string;
}

export class HybridLogicalClock {
  private lastWallMs = 0;
  private lastLogical = 0;

  constructor(private readonly nodeId: string) {}

  /**
   * Generate a new HLC timestamp.
   * Takes max(wallClock, lastWallMs). If same as last, increments logical;
   * otherwise resets logical to 0.
   */
  now(): HLCTimestamp {
    const wallMs = Date.now();
    if (wallMs > this.lastWallMs) {
      this.lastWallMs = wallMs;
      this.lastLogical = 0;
    } else {
      this.lastLogical++;
    }
    return { wallMs: this.lastWallMs, logical: this.lastLogical, nodeId: this.nodeId };
  }

  /**
   * Merge with a remote event's timestamp to maintain causal ordering.
   * Takes max(wallClock, remote.wallMs, lastWallMs) and adjusts logical.
   */
  receive(remote: HLCTimestamp): HLCTimestamp {
    const wallMs = Date.now();
    const maxWall = Math.max(wallMs, remote.wallMs, this.lastWallMs);

    if (maxWall === this.lastWallMs && maxWall === remote.wallMs) {
      this.lastLogical = Math.max(this.lastLogical, remote.logical) + 1;
    } else if (maxWall === this.lastWallMs) {
      this.lastLogical++;
    } else if (maxWall === remote.wallMs) {
      this.lastLogical = remote.logical + 1;
    } else {
      this.lastLogical = 0;
    }

    this.lastWallMs = maxWall;
    return { wallMs: this.lastWallMs, logical: this.lastLogical, nodeId: this.nodeId };
  }

  /**
   * Compare two HLC timestamps for ordering.
   * Returns -1 if a < b, 0 if equal, 1 if a > b.
   */
  static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
    if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
    if (a.nodeId < b.nodeId) return -1;
    if (a.nodeId > b.nodeId) return 1;
    return 0;
  }

  /**
   * Serialize an HLC timestamp to a sortable string representation.
   * Format: `<wallMs-hex-padded>:<logical-hex-padded>:<nodeId>`
   * Hex-padded to 12 and 4 chars respectively for lexicographic sorting.
   */
  static toString(ts: HLCTimestamp): string {
    const wall = ts.wallMs.toString(16).padStart(12, '0');
    const logic = ts.logical.toString(16).padStart(4, '0');
    return `${wall}:${logic}:${ts.nodeId}`;
  }

  /**
   * Deserialize an HLC timestamp from its string representation.
   */
  static fromString(s: string): HLCTimestamp {
    const parts = s.split(':');
    if (parts.length < 3) {
      throw new Error(`Invalid HLC timestamp string: ${s}`);
    }
    return {
      wallMs: parseInt(parts[0], 16),
      logical: parseInt(parts[1], 16),
      nodeId: parts.slice(2).join(':'),
    };
  }
}
