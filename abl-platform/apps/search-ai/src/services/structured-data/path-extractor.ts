/**
 * Path Extractor for Hierarchical Structured Data
 *
 * Extracts all paths from JSON/XML objects for indexing in ClickHouse.
 * Enables path-based queries like "users[0].name" or "find all user emails".
 */

export interface PathIndexEntry {
  // Isolation
  tenantId: string;
  indexId: string;

  // Object identity
  objectId: string; // Maps to MongoDB chunk documentId
  objectType: 'json' | 'xml';

  // Path information
  path: string; // Full path: 'users[0].name'
  pathNormalized: string; // Pattern: 'users[].name'
  depth: number; // Nesting depth

  // Value information
  valueType: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';
  valueString?: string;
  valueNumber?: number;
  valueBoolean?: boolean;

  // Parent-child relationships
  parentPath: string | null;

  // Search optimization
  pathTokens: string[]; // ['users', 'name']
}

export interface PathExtractionConfig {
  /** Maximum depth to traverse (default: 15) */
  maxDepth: number;
  /** Maximum array size to index (default: 1000) */
  maxArraySize: number;
  /** Maximum string value length to store (default: 1000) */
  maxStringLength: number;
  /** Whether to sample large arrays (default: true) */
  sampleLargeArrays: boolean;
}

const DEFAULT_CONFIG: PathExtractionConfig = {
  maxDepth: 15,
  maxArraySize: 1000,
  maxStringLength: 1000,
  sampleLargeArrays: true,
};

export interface PathExtractionResult {
  entries: PathIndexEntry[];
  statistics: {
    totalPaths: number;
    maxDepth: number;
    truncatedArrays: number;
    truncatedValues: number;
  };
}

export class PathExtractor {
  private config: PathExtractionConfig;

  constructor(config: Partial<PathExtractionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Extract all paths from a JSON object
   */
  extractPathsFromJSON(
    obj: any,
    tenantId: string,
    indexId: string,
    objectId: string,
  ): PathExtractionResult {
    const entries: PathIndexEntry[] = [];
    const statistics = {
      totalPaths: 0,
      maxDepth: 0,
      truncatedArrays: 0,
      truncatedValues: 0,
    };

    this.extractRecursive(
      obj,
      '', // basePath
      entries,
      0, // depth
      null, // parentPath
      tenantId,
      indexId,
      objectId,
      'json',
      statistics,
    );

    statistics.totalPaths = entries.length;

    return { entries, statistics };
  }

  /**
   * Recursive path extraction
   */
  private extractRecursive(
    value: any,
    path: string,
    entries: PathIndexEntry[],
    depth: number,
    parentPath: string | null,
    tenantId: string,
    indexId: string,
    objectId: string,
    objectType: 'json' | 'xml',
    statistics: PathExtractionResult['statistics'],
  ): void {
    // Stop at max depth
    if (depth > this.config.maxDepth) {
      return;
    }

    // Track max depth
    if (depth > statistics.maxDepth) {
      statistics.maxDepth = depth;
    }

    const valueType = this.inferValueType(value);

    // Create entry for this path
    const entry: PathIndexEntry = {
      tenantId,
      indexId,
      objectId,
      objectType,
      path,
      pathNormalized: this.normalizePath(path),
      depth,
      valueType,
      parentPath,
      pathTokens: this.tokenizePath(path),
      ...this.extractValue(value, valueType, statistics),
    };

    entries.push(entry);

    // Recurse for objects and arrays
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        this.extractFromArray(
          value,
          path,
          entries,
          depth,
          tenantId,
          indexId,
          objectId,
          objectType,
          statistics,
        );
      } else {
        this.extractFromObject(
          value,
          path,
          entries,
          depth,
          tenantId,
          indexId,
          objectId,
          objectType,
          statistics,
        );
      }
    }
  }

  /**
   * Extract paths from array elements
   */
  private extractFromArray(
    arr: any[],
    path: string,
    entries: PathIndexEntry[],
    depth: number,
    tenantId: string,
    indexId: string,
    objectId: string,
    objectType: 'json' | 'xml',
    statistics: PathExtractionResult['statistics'],
  ): void {
    let indicesToProcess: number[] = [];

    if (arr.length <= this.config.maxArraySize) {
      // Process all elements
      indicesToProcess = Array.from({ length: arr.length }, (_, i) => i);
    } else {
      // Sample large arrays
      statistics.truncatedArrays++;

      if (this.config.sampleLargeArrays) {
        // Take first 100, last 100, and 100 random samples
        const first100 = Array.from({ length: Math.min(100, arr.length) }, (_, i) => i);
        const last100 = Array.from(
          { length: Math.min(100, arr.length) },
          (_, i) => arr.length - 100 + i,
        ).filter((i) => i >= 0);
        const random100 = this.randomSample(arr.length, 100, new Set([...first100, ...last100]));

        indicesToProcess = Array.from(new Set([...first100, ...last100, ...random100])).sort(
          (a, b) => a - b,
        );
      } else {
        // Just take first maxArraySize elements
        indicesToProcess = Array.from({ length: this.config.maxArraySize }, (_, i) => i);
      }
    }

    for (const idx of indicesToProcess) {
      const childPath = `${path}[${idx}]`;
      this.extractRecursive(
        arr[idx],
        childPath,
        entries,
        depth + 1,
        path,
        tenantId,
        indexId,
        objectId,
        objectType,
        statistics,
      );
    }
  }

  /**
   * Extract paths from object properties
   */
  private extractFromObject(
    obj: Record<string, any>,
    path: string,
    entries: PathIndexEntry[],
    depth: number,
    tenantId: string,
    indexId: string,
    objectId: string,
    objectType: 'json' | 'xml',
    statistics: PathExtractionResult['statistics'],
  ): void {
    for (const key of Object.keys(obj)) {
      const childPath = path ? `${path}.${key}` : key;
      this.extractRecursive(
        obj[key],
        childPath,
        entries,
        depth + 1,
        path || null,
        tenantId,
        indexId,
        objectId,
        objectType,
        statistics,
      );
    }
  }

  /**
   * Infer value type from a value
   */
  private inferValueType(value: any): PathIndexEntry['valueType'] {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'object') return 'object';
    return 'string'; // Default fallback
  }

  /**
   * Extract value based on type
   */
  private extractValue(
    value: any,
    valueType: PathIndexEntry['valueType'],
    statistics: PathExtractionResult['statistics'],
  ): Pick<PathIndexEntry, 'valueString' | 'valueNumber' | 'valueBoolean'> {
    const result: Pick<PathIndexEntry, 'valueString' | 'valueNumber' | 'valueBoolean'> = {};

    switch (valueType) {
      case 'string':
        if (typeof value === 'string') {
          if (value.length > this.config.maxStringLength) {
            result.valueString = value.slice(0, this.config.maxStringLength);
            statistics.truncatedValues++;
          } else {
            result.valueString = value;
          }
        }
        break;
      case 'number':
        if (typeof value === 'number') {
          result.valueNumber = value;
        }
        break;
      case 'boolean':
        if (typeof value === 'boolean') {
          result.valueBoolean = value;
        }
        break;
      case 'object':
      case 'array':
        // Store JSON string representation
        const jsonStr = JSON.stringify(value);
        if (jsonStr.length > this.config.maxStringLength) {
          result.valueString = jsonStr.slice(0, this.config.maxStringLength) + '...';
          statistics.truncatedValues++;
        } else {
          result.valueString = jsonStr;
        }
        break;
      case 'null':
        // No value to store
        break;
    }

    return result;
  }

  /**
   * Normalize path for pattern matching
   * Example: users[0].name → users[].name
   */
  private normalizePath(path: string): string {
    return path.replace(/\[\d+\]/g, '[]');
  }

  /**
   * Tokenize path for search
   * Example: users[0].profile.name → ['users', 'profile', 'name']
   */
  private tokenizePath(path: string): string[] {
    return path
      .split(/[\.\[\]]+/)
      .filter(Boolean)
      .filter((token) => !/^\d+$/.test(token)); // Remove numeric indices
  }

  /**
   * Random sample from range, excluding certain indices
   */
  private randomSample(max: number, count: number, exclude: Set<number>): number[] {
    const samples: number[] = [];
    const attempts = count * 3; // Try 3x to avoid infinite loop

    for (let i = 0; i < attempts && samples.length < count; i++) {
      const idx = Math.floor(Math.random() * max);
      if (!exclude.has(idx) && !samples.includes(idx)) {
        samples.push(idx);
      }
    }

    return samples;
  }
}
