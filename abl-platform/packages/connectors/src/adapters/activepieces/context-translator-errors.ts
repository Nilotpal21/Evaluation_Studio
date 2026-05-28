/**
 * Error types for the Activepieces context translator. Extracted into its own
 * file so that auth-adapter modules (which the translator imports) can also
 * throw `ConnectorConfigError` without a circular import.
 */

/**
 * Thrown by `normalizeAuthForAP` and the per-connector auth bridges when an
 * auth profile is missing required configuration (e.g. subdomain not set
 * during auth profile creation). Caught by DropdownOptionsService to return
 * a 400 VALIDATION_ERROR instead of a 502 RESOLVE_FAILED.
 */
export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorConfigError';
  }
}
