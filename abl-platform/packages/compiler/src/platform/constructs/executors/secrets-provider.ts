/**
 * Secrets Provider Interface
 *
 * Resolves {{secrets.KEY}} placeholders at runtime.
 * Also exposes optional runtime configuration variable lookup for preserved
 * {{config.KEY}} placeholders in namespace-scoped tool bindings.
 * Platform provides implementation backed by EncryptionService.
 */

/**
 * Interface for resolving secrets at runtime.
 * Secrets are referenced in ABL via {{secrets.KEY}} placeholders.
 */
export interface SecretsProvider {
  /** Resolve a secret by key. Returns undefined if not found. */
  getSecret(key: string, options?: { toolName?: string }): Promise<string | undefined>;

  /** Resolve an environment variable by key. Returns undefined if not found. */
  getEnvVar?(key: string): Promise<string | undefined>;

  /** Resolve a project configuration variable by key. Returns undefined if not found. */
  getConfigVar?(key: string): Promise<string | undefined>;

  /** Resolve end-user's delegated OAuth token. */
  getUserOAuthToken?(userId: string, provider: string): Promise<string | undefined>;

  /**
   * Create a scoped copy of this provider that filters env var resolution
   * by the given variable namespace IDs. Used for per-tool namespace scoping.
   * Returns itself if namespace scoping is not supported.
   */
  withNamespaceScope?(variableNamespaceIds: string[]): SecretsProvider;
}

/**
 * No-op secrets provider for testing or contract-only tools
 */
export class NoopSecretsProvider implements SecretsProvider {
  async getSecret(): Promise<string | undefined> {
    return undefined;
  }
}
