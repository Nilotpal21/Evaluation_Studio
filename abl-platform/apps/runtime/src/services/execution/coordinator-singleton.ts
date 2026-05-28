/**
 * ExecutionCoordinator Singleton
 *
 * Provides get/set access to the global ExecutionCoordinator instance.
 * Created during server startup (server.ts), consumed by WebSocket handlers
 * and HTTP routes.
 */

import type { ExecutionCoordinator } from './execution-coordinator.js';

let _coordinator: ExecutionCoordinator | null = null;

/**
 * Get the global ExecutionCoordinator instance.
 * Throws if called before setExecutionCoordinator().
 */
export function getExecutionCoordinator(): ExecutionCoordinator {
  if (!_coordinator) {
    throw new Error(
      'ExecutionCoordinator not initialized. Call setExecutionCoordinator() during server startup.',
    );
  }
  return _coordinator;
}

/**
 * Check whether the coordinator has been initialized.
 * Use this for graceful fallback in handlers that may run before startup completes.
 */
export function isCoordinatorAvailable(): boolean {
  return _coordinator !== null;
}

/**
 * Set the global ExecutionCoordinator instance. Called once during server startup.
 */
export function setExecutionCoordinator(coordinator: ExecutionCoordinator): void {
  _coordinator = coordinator;
}

/**
 * Reset the coordinator (for tests only).
 */
export function resetCoordinatorSingleton(): void {
  _coordinator = null;
}
