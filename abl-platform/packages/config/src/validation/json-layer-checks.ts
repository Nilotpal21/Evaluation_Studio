import { SENSITIVE_PATHS } from '../constants/sensitive-paths.js';

/**
 * Fields that must NEVER appear in environment JSON files.
 * These are infrastructure/secret values that should only come from
 * Vault or environment variables — never from the JSON layer in source control.
 *
 * If any of these fields are found in a JSON file, CI fails with an
 * actionable error to prevent data exfiltration via malicious defaults.
 */
const RESTRICTED_JSON_FIELDS = [
  ...SENSITIVE_PATHS,
  'llm.googleApiKey',
  'llm.azureOpenaiApiKey',
  'oauth.github.clientSecret',
  'oauth.microsoft.clientSecret',
  'sandbox.jwtSecret',
];

export interface JsonLayerIssue {
  level: 'error' | 'warning';
  file: string;
  field: string;
  message: string;
}

/**
 * Validate that an environment JSON file does not contain restricted fields.
 * Returns issues for any infrastructure/secret fields found.
 */
export function validateJsonLayerFields(
  jsonContent: Record<string, unknown>,
  fileName: string,
): JsonLayerIssue[] {
  const issues: JsonLayerIssue[] = [];

  function walk(obj: Record<string, unknown>, prefix: string): void {
    for (const key of Object.keys(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (RESTRICTED_JSON_FIELDS.includes(path)) {
        issues.push({
          level: 'error',
          file: fileName,
          field: path,
          message: `Restricted field "${path}" found in ${fileName}. Infrastructure and secret values must come from Vault or env vars, not JSON defaults.`,
        });
      }

      const val = obj[key];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        walk(val as Record<string, unknown>, path);
      }
    }
  }

  walk(jsonContent, '');
  return issues;
}
