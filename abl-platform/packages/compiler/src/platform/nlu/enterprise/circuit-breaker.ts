/**
 * NLU Circuit Breaker
 *
 * Per-layer circuit breaker for LLM provider calls.
 * When a layer's circuit is open, the pipeline skips to the next layer.
 *
 * States: closed (normal) → open (skip) → half-open (probe)
 */

import type { NLUConfig } from '../config.js';

// =============================================================================
// TYPES
// =============================================================================

type CircuitState = 'closed' | 'open' | 'half-open';

interface LayerCircuit {
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number;
  successCount: number;
}

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================

export class NLUCircuitBreaker {
  private circuits = new Map<string, LayerCircuit>();
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private enabled: boolean;

  constructor(config: NLUConfig['circuitBreaker']) {
    this.enabled = config.enabled;
    this.failureThreshold = config.failureThreshold;
    this.resetTimeoutMs = config.resetTimeoutMs;
  }

  /**
   * Wrap an LLM call with circuit breaker protection.
   * Implements PipelineHooks.wrapLLMCall
   */
  async wrapLLMCall<T>(layerName: string, fn: () => Promise<T>): Promise<T | null> {
    if (!this.enabled) return fn();

    const circuit = this.getOrCreate(layerName);

    // Check circuit state
    switch (circuit.state) {
      case 'open':
        // Check if reset timeout has elapsed
        if (Date.now() - circuit.lastFailureTime >= this.resetTimeoutMs) {
          circuit.state = 'half-open';
          circuit.successCount = 0;
          // Fall through to try the call
        } else {
          // Circuit is open — skip this layer
          return null;
        }
        break;

      case 'half-open':
        // Allow the probe call through
        break;

      case 'closed':
        // Normal operation
        break;
    }

    try {
      const result = await fn();
      this.onSuccess(layerName);
      return result;
    } catch (error) {
      this.onFailure(layerName);
      throw error;
    }
  }

  /**
   * Get the current state of a layer's circuit
   */
  getState(layerName: string): CircuitState {
    return this.getOrCreate(layerName).state;
  }

  /**
   * Reset a specific layer's circuit
   */
  reset(layerName: string): void {
    this.circuits.delete(layerName);
  }

  /**
   * Reset all circuits
   */
  resetAll(): void {
    this.circuits.clear();
  }

  // =========================================================================
  // PRIVATE
  // =========================================================================

  private getOrCreate(layerName: string): LayerCircuit {
    let circuit = this.circuits.get(layerName);
    if (!circuit) {
      circuit = {
        state: 'closed',
        failureCount: 0,
        lastFailureTime: 0,
        successCount: 0,
      };
      this.circuits.set(layerName, circuit);
    }
    return circuit;
  }

  private onSuccess(layerName: string): void {
    const circuit = this.getOrCreate(layerName);

    if (circuit.state === 'half-open') {
      // Successful probe — close the circuit
      circuit.state = 'closed';
      circuit.failureCount = 0;
      circuit.successCount = 0;
    } else {
      circuit.failureCount = 0;
    }
  }

  private onFailure(layerName: string): void {
    const circuit = this.getOrCreate(layerName);
    circuit.failureCount++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === 'half-open') {
      // Failed probe — re-open the circuit
      circuit.state = 'open';
    } else if (circuit.failureCount >= this.failureThreshold) {
      circuit.state = 'open';
    }
  }
}
