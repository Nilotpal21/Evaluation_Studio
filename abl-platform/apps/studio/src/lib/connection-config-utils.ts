/**
 * Nango URL Template Utilities
 *
 * Parses and resolves `${connectionConfig.xxx}` patterns in Nango provider URLs.
 * Used by the integration provider service and UI slide-over.
 */

const TEMPLATE_REGEX = /\$\{connectionConfig\.(\w+)\}/g;

/**
 * Extract unique connection config field names from template strings.
 * Scans URLs and param object values for `${connectionConfig.xxx}` references.
 *
 * @example
 * extractConnectionConfigFields(
 *   ['https://${connectionConfig.instance}.salesforce.com/...'],
 *   [{ application_id: '${connectionConfig.applicationId}' }],
 * )
 * // => ['instance', 'applicationId']
 */
export function extractConnectionConfigFields(
  urls: string[],
  paramObjects?: Array<Record<string, unknown> | undefined>,
): string[] {
  const fields = new Set<string>();
  for (const url of urls) {
    for (const match of url.matchAll(TEMPLATE_REGEX)) {
      fields.add(match[1]);
    }
  }
  if (paramObjects) {
    for (const params of paramObjects) {
      if (!params) continue;
      for (const value of Object.values(params)) {
        if (typeof value === 'string') {
          for (const match of value.matchAll(TEMPLATE_REGEX)) {
            fields.add(match[1]);
          }
        }
      }
    }
  }
  return [...fields];
}

/**
 * Resolve template variables in a URL using provided config values.
 *
 * @throws Error if a required config value is missing
 *
 * @example
 * resolveConnectionConfigTemplate(
 *   'https://${connectionConfig.instance}.salesforce.com/oauth2/authorize',
 *   { instance: 'myco' }
 * )
 * // => 'https://myco.salesforce.com/oauth2/authorize'
 */
export function resolveConnectionConfigTemplate(
  url: string,
  config: Record<string, string>,
): string {
  return url.replace(TEMPLATE_REGEX, (_, key) => {
    const value = config[key];
    if (!value) throw new Error(`Missing connectionConfig value: ${key}`);
    return value;
  });
}
