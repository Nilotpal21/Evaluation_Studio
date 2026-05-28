/**
 * Paths to sensitive configuration fields.
 *
 * Shared between config-hash (excludes these from hash computation)
 * and config-diff (redacts values in diff output).
 */
export const SENSITIVE_PATHS = [
  'jwt.secret',
  'encryption.masterKey',
  'llm.anthropicApiKey',
  'llm.openaiApiKey',
  'oauth.google.clientSecret',
  'database.url',
  'redis.url',
];
