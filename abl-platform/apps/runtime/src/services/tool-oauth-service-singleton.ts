/**
 * ToolOAuthService Singleton
 *
 * Provides lazy-initialized singleton access to ToolOAuthService.
 * Used by RuntimeExecutor to create OAuthTokenResolver adapters
 * without importing the full service directly (avoids circular deps).
 */

import type { ToolOAuthService } from './tool-oauth-service.js';

let instance: ToolOAuthService | null = null;

/**
 * Set the global ToolOAuthService instance.
 * Called during server startup after all dependencies are available.
 */
export function setToolOAuthService(service: ToolOAuthService): void {
  instance = service;
}

/**
 * Get the global ToolOAuthService instance.
 * Returns null if not yet initialized (encryption/DB not available).
 */
export function getToolOAuthService(): ToolOAuthService | null {
  return instance;
}

/** Reset the global ToolOAuthService instance. */
export function resetToolOAuthService(): void {
  instance = null;
}
