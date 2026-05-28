/**
 * Resilience Interfaces
 *
 * Pluggable interfaces for circuit breaker and rate limiter, decoupling
 * the executor layer from concrete implementations. In-memory defaults
 * use the existing CircuitBreaker and RateLimiter classes from http-resilience.ts.
 * For multi-pod deployments, inject Redis-backed implementations at the platform layer.
 */

import { CircuitBreaker, RateLimiter } from './http-resilience.js';

/** Pluggable circuit breaker interface */
export interface ICircuitBreaker {
  isOpen(): boolean | Promise<boolean>;
  recordSuccess(): void | Promise<void>;
  recordFailure(): void | Promise<void>;
  getState(): ('closed' | 'open' | 'half-open') | Promise<'closed' | 'open' | 'half-open'>;
}

/** Pluggable rate limiter interface */
export interface IRateLimiter {
  acquire(): Promise<void>;
}

/** Factory for creating resilience primitives — allows runtime injection of Redis-backed implementations */
export interface ResilienceFactory {
  createCircuitBreaker(
    name: string,
    config: { threshold: number; resetMs: number },
  ): ICircuitBreaker;
  createRateLimiter(name: string, requestsPerMinute: number): IRateLimiter;
}

/** Default factory — returns in-memory implementations (existing CircuitBreaker and RateLimiter classes) */
export function createDefaultResilienceFactory(): ResilienceFactory {
  return {
    createCircuitBreaker(
      _name: string,
      config: { threshold: number; resetMs: number },
    ): ICircuitBreaker {
      return new CircuitBreaker(config.threshold, config.resetMs);
    },
    createRateLimiter(_name: string, requestsPerMinute: number): IRateLimiter {
      return new RateLimiter(requestsPerMinute);
    },
  };
}
