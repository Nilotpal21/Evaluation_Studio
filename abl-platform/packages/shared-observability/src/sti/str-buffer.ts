/**
 * STR Ring Buffer
 *
 * Per-trace ring buffer for Structured Trace Records (STR).
 * All operations are synchronous to avoid blocking the hot path.
 * Includes a circuit breaker to stop writes after repeated flush failures.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum entries stored per trace before oldest are dropped. */
export const MAX_ENTRIES_PER_TRACE = 10_000;

/** TTL for trace entries — evicted on access after this duration. */
export const TRACE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Consecutive flush failures before the circuit opens. */
export const CIRCUIT_FAILURE_THRESHOLD = 5;

/** Duration the circuit stays open before allowing writes again. */
export const CIRCUIT_RESET_MS = 30 * 1000; // 30 seconds

/** Maximum number of distinct traces tracked simultaneously. */
const MAX_TRACES = 50_000;

/** Minimum interval between stale-eviction scans. */
const EVICT_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface STREntry {
  path: string;
  timestamp: number; // Date.now()
  durationUs: number;
  outcome: 'success' | 'error' | 'pending';
  depth: number;
}

export interface EntryHandle {
  markSuccess(): void;
  markError(): void;
  recordDuration(us: number): void;
}

interface TraceSlot {
  entries: STREntry[];
  head: number; // overwrite position (only used when at capacity)
  createdAt: number;
}

// ---------------------------------------------------------------------------
// STRBuffer
// ---------------------------------------------------------------------------

export class STRBuffer {
  private readonly traces = new Map<string, TraceSlot>();
  private consecutiveFlushFailures = 0;
  private circuitOpenUntil = 0;
  private lastEvictAt = 0;

  /**
   * Record a new entry for the given trace.
   * Returns a handle to mark outcome and duration after the operation completes.
   */
  recordEntry(traceId: string, path: string, depth = 0): EntryHandle {
    // Circuit breaker: reject writes while open
    if (this.isCircuitOpen()) {
      return STRBuffer.noopHandle;
    }

    this.evictStale();
    this.enforceTotalCap();

    let slot = this.traces.get(traceId);
    if (!slot) {
      slot = { entries: [], head: 0, createdAt: Date.now() };
      this.traces.set(traceId, slot);
    }

    const entry: STREntry = {
      path,
      timestamp: Date.now(),
      durationUs: 0,
      outcome: 'pending',
      depth,
    };

    // Ring-buffer eviction: O(1) overwrite when at capacity instead of O(n) shift
    if (slot.entries.length < MAX_ENTRIES_PER_TRACE) {
      slot.entries.push(entry);
    } else {
      slot.entries[slot.head] = entry;
      slot.head = (slot.head + 1) % MAX_ENTRIES_PER_TRACE;
    }

    return {
      markSuccess() {
        entry.outcome = 'success';
      },
      markError() {
        entry.outcome = 'error';
      },
      recordDuration(us: number) {
        entry.durationUs = us;
      },
    };
  }

  /**
   * Flush all entries for a trace, removing it from the buffer.
   * Returns the entries array (empty array if trace not found).
   */
  flush(traceId: string): STREntry[] {
    const slot = this.traces.get(traceId);
    if (!slot) {
      return [];
    }
    this.traces.delete(traceId);
    if (slot.entries.length < MAX_ENTRIES_PER_TRACE) {
      return slot.entries;
    }
    // Ring is full — reorder from head (oldest) to end
    return [...slot.entries.slice(slot.head), ...slot.entries.slice(0, slot.head)];
  }

  /**
   * Report a flush failure (called externally by the flush consumer).
   * Increments the consecutive failure counter and may open the circuit.
   */
  reportFlushFailure(): void {
    this.consecutiveFlushFailures++;
    if (this.consecutiveFlushFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + CIRCUIT_RESET_MS;
    }
  }

  /**
   * Report a flush success. Resets the consecutive failure counter.
   */
  reportFlushSuccess(): void {
    this.consecutiveFlushFailures = 0;
  }

  /** Whether the circuit breaker is currently open (writes are rejected). */
  isCircuitOpen(): boolean {
    if (this.circuitOpenUntil === 0) return false;
    if (Date.now() >= this.circuitOpenUntil) {
      // Half-open → reset
      this.circuitOpenUntil = 0;
      this.consecutiveFlushFailures = 0;
      return false;
    }
    return true;
  }

  /** Number of distinct traces currently tracked. */
  get size(): number {
    return this.traces.size;
  }

  /** Tear down all state. */
  destroy(): void {
    this.traces.clear();
    this.consecutiveFlushFailures = 0;
    this.circuitOpenUntil = 0;
    this.lastEvictAt = 0;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /** Evict traces whose slot has exceeded the TTL (amortized, at most once per EVICT_INTERVAL_MS). */
  private evictStale(): void {
    const now = Date.now();
    if (now - this.lastEvictAt < EVICT_INTERVAL_MS) return;
    this.lastEvictAt = now;
    for (const [id, slot] of this.traces) {
      if (now - slot.createdAt > TRACE_TTL_MS) {
        this.traces.delete(id);
      }
    }
  }

  /** Enforce a hard cap on total tracked traces to bound memory. */
  private enforceTotalCap(): void {
    if (this.traces.size < MAX_TRACES) return;
    // Drop oldest traces (Map iteration order = insertion order)
    const excess = this.traces.size - MAX_TRACES + 1;
    let dropped = 0;
    for (const key of this.traces.keys()) {
      if (dropped >= excess) break;
      this.traces.delete(key);
      dropped++;
    }
  }

  /** A no-op handle returned when the circuit is open. */
  private static readonly noopHandle: EntryHandle = {
    markSuccess() {},
    markError() {},
    recordDuration() {},
  };
}
