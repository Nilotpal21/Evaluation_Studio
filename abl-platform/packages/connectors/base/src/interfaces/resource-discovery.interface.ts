/**
 * Resource Discovery Interface
 *
 * Connector-agnostic types for auto-discovering resources (sites, drives,
 * libraries, etc.) and profiling their content before sync.
 */

// ─── Discovered Resource ────────────────────────────────────────────────

export interface DiscoveredResource {
  /** Unique ID within the data source (e.g., site ID, drive ID) */
  id: string;
  /** Internal name */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** URL to the resource in the source system */
  url: string;
  /** Resource type (connector-specific, e.g., 'site', 'drive', 'library', 'space') */
  resourceType: string;
  /** Parent resource ID for building hierarchies (null for root resources) */
  parentId: string | null;
  /** Connector-specific metadata */
  metadata: Record<string, unknown>;
  /** Child resources (populated by buildResourceTree) */
  children?: DiscoveredResource[];
}

// ─── Content Profile ────────────────────────────────────────────────────

export interface ContentProfile {
  /** ID of the resource this profile describes */
  resourceId: string;
  /** Total number of documents in the resource */
  totalDocuments: number;
  /** Total size of all documents in bytes */
  totalSizeBytes: number;
  /** Distribution of file types (e.g., { 'pdf': 120, 'docx': 45 }) */
  fileTypeDistribution: Record<string, number>;
  /** Date range of document modification times */
  dateRange: {
    earliest: Date | null;
    latest: Date | null;
  };
  /** Average document size in bytes */
  averageDocumentSizeBytes: number;
  /** Estimated update frequency based on modification patterns */
  updateFrequency: 'daily' | 'weekly' | 'monthly' | 'rarely';
  /** Indicators of sensitive content detected in file names or metadata */
  sensitivityIndicators: string[];
  /** Number of documents sampled to build this profile */
  sampleDocumentCount: number;
}

// ─── Discovery Progress ─────────────────────────────────────────────────

export interface DiscoveryProgress {
  /** Current phase of discovery */
  phase: 'discovering' | 'profiling';
  /** Number of resources found so far */
  resourcesFound: number;
  /** Resource currently being processed */
  currentResource: string;
  /** Estimated completion percentage (0-100) */
  percentComplete: number;
}

export type DiscoveryProgressCallback = (progress: DiscoveryProgress) => void;

// ─── Discovery Result ───────────────────────────────────────────────────

export interface ResourceDiscoveryResult {
  /** All discovered resources (flat list with parentId linkage) */
  resources: DiscoveredResource[];
  /** Total number of resources found */
  totalResources: number;
  /** Content profiles for profiled resources */
  profiles: ContentProfile[];
  /** When discovery was performed */
  discoveredAt: Date;
  /** Duration of discovery in milliseconds */
  durationMs: number;
}

// ─── Resource Discovery Interface ───────────────────────────────────────

export interface IResourceDiscovery {
  /** Connector type this discovery handles */
  readonly connectorType: string;

  /**
   * Discover all available resources in the data source.
   * Returns a flat list of resources with parentId linkage for hierarchy.
   *
   * @param progressCallback - Optional callback for progress updates
   */
  discoverResources(progressCallback?: DiscoveryProgressCallback): Promise<DiscoveredResource[]>;

  /**
   * Profile content for a specific resource.
   * Samples documents to analyze file types, sizes, dates, and sensitivity.
   *
   * @param resourceId - ID of the resource to profile
   * @param sampleSize - Number of documents to sample (default: 100)
   */
  profileContent(resourceId: string, sampleSize?: number): Promise<ContentProfile>;
}
