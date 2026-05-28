/**
 * Reusable Circuit Breaker
 *
 * Three-state pattern (closed → open → half-open → closed) for protecting
 * against cascading failures from external dependencies.
 *
 * Supports:
 * - Configurable failure/success thresholds
 * - Sliding window failure counting
 * - Multiple fallback strategies
 * - Observable state transitions (event emitter)
 * - Persistent state via pluggable store (in-memory default, Redis for production)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  /** Unique name for this breaker (used as key in store) */
  name: string;
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Number of successes in half-open before closing */
  successThreshold: number;
  /** Time in ms to stay open before transitioning to half-open */
  resetTimeoutMs: number;
  /** Sliding window for failure counting (ms) */
  windowMs: number;
  /** Count timeouts as failures */
  monitorTimeouts: boolean;
}

export interface CircuitBreakerState {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureTime: number;
  lastStateChange: number;
  consecutiveSuccesses: number;
}

export interface CircuitBreakerEvent {
  type:
    | 'circuit_opened'
    | 'circuit_closed'
    | 'circuit_half_open'
    | 'fallback_executed'
    | 'probe_success'
    | 'probe_failure';
  breakerName: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export type CircuitBreakerListener = (event: CircuitBreakerEvent) => void;

/** Pluggable state store interface for cross-instance sharing */
export interface CircuitBreakerStore {
  getState(key: string): Promise<CircuitBreakerState | null>;
  setState(key: string, state: CircuitBreakerState): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_CIRCUIT_CONFIG: CircuitBreakerConfig = {
  name: 'default',
  failureThreshold: 5,
  successThreshold: 3,
  resetTimeoutMs: 30_000,
  windowMs: 60_000,
  monitorTimeouts: true,
};

// ---------------------------------------------------------------------------
// In-memory store (development / single-instance)
// ---------------------------------------------------------------------------

export class InMemoryCircuitBreakerStore implements CircuitBreakerStore {
  private states = new Map<string, CircuitBreakerState>();

  async getState(key: string): Promise<CircuitBreakerState | null> {
    return this.states.get(key) ?? null;
  }

  async setState(key: string, state: CircuitBreakerState): Promise<void> {
    this.states.set(key, { ...state });
  }

  /** Reset all breakers (for testing) */
  clear(): void {
    this.states.clear();
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker
// ---------------------------------------------------------------------------

export class CircuitBreaker {
  private state: CircuitBreakerState;
  private config: CircuitBreakerConfig;
  private store: CircuitBreakerStore;
  private listeners: CircuitBreakerListener[] = [];
  private probeInProgress = false;
  private hydrated = false;

  constructor(
    config: Partial<CircuitBreakerConfig> & { name: string },
    store?: CircuitBreakerStore,
  ) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    this.store = store ?? new InMemoryCircuitBreakerStore();
    this.state = this.initialState();
  }

  private initialState(): CircuitBreakerState {
    return {
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      lastStateChange: Date.now(),
      consecutiveSuccesses: 0,
    };
  }

  /** Register an event listener */
  onStateChange(listener: CircuitBreakerListener): void {
    this.listeners.push(listener);
  }

  private emit(event: CircuitBreakerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not break the breaker
      }
    }
  }

  /** Load state from store (call on startup or periodically for shared state) */
  async loadState(): Promise<void> {
    const stored = await this.store.getState(this.config.name);
    if (stored) {
      this.state = stored;
    }
    this.hydrated = true;
  }

  /** Persist state to store */
  private async persistState(): Promise<void> {
    await this.store.setState(this.config.name, { ...this.state });
  }

  /**
   * Best-effort background persist — used by synchronous methods (isOpen, getState)
   * that mutate state but cannot await.
   */
  private persistStateBackground(): void {
    this.persistState().catch(() => {
      // Errors are non-fatal — the persist will be retried on next recordSuccess/recordFailure
    });
  }

  /** Check if the circuit allows a request through */
  isOpen(): boolean {
    if (this.state.state === 'closed') {
      return false;
    }

    if (this.state.state === 'open') {
      // Check if reset timeout has elapsed → transition to half-open
      if (Date.now() - this.state.lastStateChange > this.config.resetTimeoutMs) {
        this.transitionTo('half-open');
        this.persistStateBackground();
        this.probeInProgress = true;
        return false; // Allow one probe request
      }
      return true;
    }

    // half-open: only allow one probe request through
    if (this.probeInProgress) {
      return true;
    }
    this.probeInProgress = true;
    return false;
  }

  /** Whether initial state has been loaded from the store */
  isHydrated(): boolean {
    return this.hydrated;
  }

  /** Record a successful call */
  async recordSuccess(): Promise<void> {
    this.probeInProgress = false;
    this.state.consecutiveSuccesses++;

    if (this.state.state === 'half-open') {
      this.state.successes++;
      this.emit({
        type: 'probe_success',
        breakerName: this.config.name,
        timestamp: Date.now(),
        metadata: { consecutiveSuccesses: this.state.consecutiveSuccesses },
      });

      if (this.state.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    } else if (this.state.state === 'closed') {
      // Reset failure count on success in closed state
      this.state.failures = Math.max(0, this.state.failures - 1);
    }

    await this.persistState();
  }

  /** Record a failed call */
  async recordFailure(error?: Error): Promise<void> {
    this.probeInProgress = false;
    this.state.failures++;
    this.state.lastFailureTime = Date.now();
    this.state.consecutiveSuccesses = 0;

    if (this.state.state === 'half-open') {
      // Any failure in half-open → back to open
      this.emit({
        type: 'probe_failure',
        breakerName: this.config.name,
        timestamp: Date.now(),
        metadata: { error: error?.message },
      });
      this.transitionTo('open');
    } else if (this.state.state === 'closed') {
      // Check if failure threshold is reached
      if (this.state.failures >= this.config.failureThreshold) {
        this.transitionTo('open');
      }
    }

    await this.persistState();
  }

  /** Record a timeout (counted as failure if monitorTimeouts is true) */
  async recordTimeout(): Promise<void> {
    if (this.config.monitorTimeouts) {
      await this.recordFailure(new Error('Timeout'));
    }
  }

  /** Get current circuit state */
  getState(): CircuitState {
    // Re-check in case reset timeout has elapsed
    if (
      this.state.state === 'open' &&
      Date.now() - this.state.lastStateChange > this.config.resetTimeoutMs
    ) {
      this.transitionTo('half-open');
      this.persistStateBackground();
    }
    return this.state.state;
  }

  /** Get full state snapshot */
  getSnapshot(): Readonly<CircuitBreakerState> {
    return { ...this.state };
  }

  /** Force reset to closed (admin operation) */
  async reset(): Promise<void> {
    this.state = this.initialState();
    this.probeInProgress = false;
    await this.persistState();
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state.state;
    this.state.state = newState;
    this.state.lastStateChange = Date.now();

    if (newState === 'closed') {
      this.state.failures = 0;
      this.state.successes = 0;
      this.state.consecutiveSuccesses = 0;
    }
    if (newState === 'half-open') {
      this.state.consecutiveSuccesses = 0;
    }

    const eventType =
      newState === 'open'
        ? 'circuit_opened'
        : newState === 'closed'
          ? 'circuit_closed'
          : 'circuit_half_open';

    this.emit({
      type: eventType,
      breakerName: this.config.name,
      timestamp: Date.now(),
      metadata: {
        previousState: oldState,
        failures: this.state.failures,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Circuit Breaker Registry (manages multiple breakers)
// ---------------------------------------------------------------------------

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();
  private store: CircuitBreakerStore;
  private globalListeners: CircuitBreakerListener[] = [];

  constructor(store?: CircuitBreakerStore) {
    this.store = store ?? new InMemoryCircuitBreakerStore();
  }

  /** Get or create a breaker for the given name */
  getBreaker(config: Partial<CircuitBreakerConfig> & { name: string }): CircuitBreaker {
    let breaker = this.breakers.get(config.name);
    if (!breaker) {
      breaker = new CircuitBreaker(config, this.store);
      // Forward events to global listeners
      for (const listener of this.globalListeners) {
        breaker.onStateChange(listener);
      }
      this.breakers.set(config.name, breaker);
      // Hydrate persisted state from store (non-blocking — breaker uses defaults until resolved)
      breaker.loadState().catch(() => {
        // Store unavailable — continue with in-memory defaults
      });
    }
    return breaker;
  }

  /** Register a global listener for all breakers */
  onAnyStateChange(listener: CircuitBreakerListener): void {
    this.globalListeners.push(listener);
    // Register on existing breakers
    for (const breaker of this.breakers.values()) {
      breaker.onStateChange(listener);
    }
  }

  /** Get all breaker states (for dashboard) */
  getAllStates(): Record<string, { state: CircuitState; failures: number }> {
    const result: Record<string, { state: CircuitState; failures: number }> = {};
    for (const [name, breaker] of this.breakers) {
      const snap = breaker.getSnapshot();
      result[name] = { state: snap.state, failures: snap.failures };
    }
    return result;
  }

  /** Reset all breakers */
  async resetAll(): Promise<void> {
    for (const breaker of this.breakers.values()) {
      await breaker.reset();
    }
  }
}
