/**
 * Version Vector
 *
 * Captures immutable version information at process startup.
 * Stamped on every STR at flush time for version-aware trace analysis.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VersionVector {
  /** Git SHA or package version — identifies the code revision */
  codeVersion: string;
  /** IR schema version — tracks structural changes to the agent IR */
  irSchemaVersion: number;
  /** Deployment identifier — distinguishes deploys within the same code version */
  deployId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current IR schema version — bump when the AgentIR shape changes */
const IR_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let cached: VersionVector | undefined;

/**
 * Build the version vector from environment variables and package metadata.
 * Called once at first access; result is cached for the process lifetime.
 */
function build(): VersionVector {
  return {
    codeVersion: process.env.GIT_SHA || process.env.npm_package_version || 'unknown',
    irSchemaVersion: IR_SCHEMA_VERSION,
    deployId: process.env.DEPLOY_ID || 'local',
  };
}

/**
 * Get the cached version vector (singleton — captured once per process).
 */
export function getVersionVector(): VersionVector {
  if (!cached) {
    cached = build();
  }
  return cached;
}

/**
 * Reset the cached version vector. Useful for testing.
 */
export function resetVersionVector(): void {
  cached = undefined;
}
