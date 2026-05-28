/**
 * Permission Crawler Interface
 *
 * Crawls and normalizes permissions from source systems.
 * Supports enabled (100% accurate) and disabled modes.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface NormalizedPermission {
  /** User-level permissions */
  users: Array<{
    userId: string;
    displayName: string;
    permissions: string[];
  }>;
  /** Group-level permissions */
  groups: Array<{
    groupId: string;
    displayName: string;
    permissions: string[];
  }>;
  /** Public access flag */
  everyone: boolean;
}

/**
 * Document permission data returned by crawler.
 * This is a simplified view used for syncing permissions to Neo4j.
 */
export interface DocumentPermissionData {
  documentId: string;
  tenantId: string;
  sourceId: string;
  permissions: NormalizedPermission;
  crawlMode: 'enabled' | 'disabled';
  accuracy: number;
}

export interface PermissionCrawlOptions {
  /** Crawl mode */
  mode: 'enabled' | 'disabled';
  /** Document IDs to crawl (null = all documents) */
  documentIds?: string[] | null;
  /** Progress callback */
  onProgress?: (progress: {
    processedCount: number;
    totalCount?: number;
    currentDocumentId: string;
  }) => void;
}

export interface PermissionCrawlStats {
  documentsProcessed: number;
  averageAccuracy: number;
  averageLatencyMs: number;
  errors: number;
}

// ─── Interface ───────────────────────────────────────────────────────────

export interface IPermissionCrawler {
  /** Crawl mode */
  readonly mode: 'enabled' | 'disabled';

  /**
   * Crawl permissions for a document.
   *
   * @param documentId - Document to crawl
   * @param sourceMetadata - Document metadata from source system
   * @returns Normalized permissions
   */
  crawlDocument(documentId: string, sourceMetadata: any): Promise<NormalizedPermission>;

  /**
   * Crawl permissions for multiple documents.
   * Batches requests for efficiency.
   *
   * @param documentIds - Documents to crawl
   * @param options - Crawl options
   * @returns Array of document permissions
   */
  crawlBatch(
    documentIds: string[],
    options?: PermissionCrawlOptions,
  ): Promise<DocumentPermissionData[]>;

  /**
   * Get expected accuracy for current mode.
   * Enabled: 100%, Disabled: 0%
   */
  getExpectedAccuracy(): number;

  /**
   * Get OAuth scopes required for this mode.
   * Full mode requires more scopes than simplified.
   */
  getRequiredScopes(): string[];

  /**
   * Get crawl statistics.
   */
  getStatistics(): PermissionCrawlStats;
}
