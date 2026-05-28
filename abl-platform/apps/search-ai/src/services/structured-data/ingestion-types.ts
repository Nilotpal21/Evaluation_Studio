/**
 * Types for Two-Phase Structured Data Ingestion API
 */

export interface AnalyzeRequest {
  // File data (multipart upload)
  file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
    size: number;
  };
  // Optional metadata
  metadata?: Record<string, unknown>;
}

export interface DetectedColumn {
  name: string;
  type: 'string' | 'number' | 'integer' | 'decimal' | 'boolean' | 'date' | 'enum';
  nullable: boolean;
  confidence: number; // 0-1
  sampleValues: any[];
  uniqueCount: number;
  nullCount: number;
  // Recommendations
  isEmbeddable: boolean; // Should this column be included in embeddings?
  isFilterable: boolean; // Should this column be indexed for filtering?
  avgLength?: number; // For string columns
  enumValues?: string[]; // For enum columns (if cardinality < 50)
}

export interface DetectedForeignKey {
  sourceField: string;
  targetTable: string;
  targetField: string;
  confidence: number; // 0-1
  detectionMethod:
    | 'naming_convention'
    | 'value_overlap'
    | 'naming_convention + validation'
    | 'naming_convention (validation failed)'
    | 'type_and_cardinality';
  matchRatio?: number; // For value_overlap method
}

export interface AnalyzeResponse {
  // Analysis ID for caching (1 hour TTL)
  analysisId: string;
  // Detected schema
  schema: {
    tableName: string; // Derived from filename
    rowCount: number;
    columns: DetectedColumn[];
    primaryKey: string | null;
    foreignKeys: DetectedForeignKey[];
  };
  // Cost estimates
  estimates: {
    embeddingTokens: number;
    embeddingCost: number; // USD
    storageBytes: number;
    chunkCount: number;
    processingTimeSeconds: number;
  };
  // Quality metrics
  quality: {
    overallConfidence: number; // 0-1
    warnings: string[];
    recommendations: string[];
  };
  // Cache expiry
  expiresAt: Date;
}

export interface FinalizeRequest {
  // Analysis ID from analyze phase
  analysisId: string;
  // User-approved schema (with corrections)
  schema: {
    tableName: string;
    displayName?: string;
    description?: string;
    columns: Array<{
      name: string;
      type: string;
      description?: string;
      isEmbeddable: boolean;
      isFilterable: boolean;
    }>;
    primaryKey: string | null;
  };
  // Optional metadata
  metadata?: Record<string, unknown>;
}

export interface FinalizeResponse {
  // Job ID for status polling
  jobId: string;
  // Initial job state
  status: 'pending' | 'processing' | 'completed' | 'failed';
  // Created table reference
  tableId: string;
  // Job details
  createdAt: Date;
  estimatedCompletionSeconds: number;
}

export interface CachedAnalysis {
  // Original file data
  fileBuffer: Buffer;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  // Analysis result
  analysis: AnalyzeResponse;
  // Cache metadata
  tenantId: string;
  indexId: string;
  cachedAt: Date;
  expiresAt: Date;
}

export interface IngestionJobData {
  tenantId: string;
  indexId: string;
  documentId: string; // SearchDocument _id (different from tableId)
  tableId: string;
  // Schema
  tableName: string;
  displayName: string;
  description: string;
  columns: Array<{
    name: string;
    type: string;
    description?: string;
    isEmbeddable: boolean;
    isFilterable: boolean;
  }>;
  primaryKey: string | null;
  // Source data
  fileBuffer: Buffer;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  // Metadata
  metadata: Record<string, unknown>;
  createdAt: Date;
}
