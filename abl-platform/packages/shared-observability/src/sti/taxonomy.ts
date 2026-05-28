import taxonomyData from './taxonomy.json' with { type: 'json' };

/** All registered STI paths from the controlled vocabulary. */
export const STI_PATHS = taxonomyData.paths as readonly string[];

/** Set for O(1) validation lookups. */
const pathSet = new Set<string>(STI_PATHS);

/** Union type of all valid STI path strings. */
export type STIPath = (typeof STI_PATHS)[number];

/**
 * Check whether a string is a registered STI path.
 */
export function isValidSTIPath(path: string): path is STIPath {
  return pathSet.has(path);
}

/**
 * Validate an STI path, throwing if it is not in the taxonomy.
 */
export function assertSTIPath(path: string): asserts path is STIPath {
  if (!isValidSTIPath(path)) {
    throw new Error(`Unknown STI path: "${path}". Valid paths: ${STI_PATHS.join(', ')}`);
  }
}

/**
 * Return the depth (number of segments) of an STI path.
 */
export function pathDepth(path: string): number {
  return path.split('/').length;
}

/**
 * Check if a path starts with a given prefix.
 */
export function pathStartsWith(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}
