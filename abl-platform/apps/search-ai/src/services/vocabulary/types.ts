/** A single distinct value discovered in a field */
export interface EnumValueEntry {
  /** The actual value found in documents */
  value: string;
  /** Number of documents containing this value */
  count: number;
  /** Frequency as fraction of sampled documents (0-1) */
  frequency: number;
}

/** An enum candidate discovered from document sampling */
export interface EnumCandidate {
  /** Storage field name in OpenSearch (e.g., "status", "custom_string_1") */
  storageField: string;
  /** Alias name from CanonicalSchema (e.g., "ticket_status") */
  alias: string | null;
  /** Display label (e.g., "Ticket Status") */
  label: string | null;
  /** Distinct values discovered, sorted by count descending */
  values: EnumValueEntry[];
  /** Number of distinct values */
  cardinality: number;
  /** Confidence score (0-1) based on distribution uniformity */
  confidence: number;
}

/** Result of a document content sampling run */
export interface SamplingResult {
  /** Enum candidates discovered */
  candidates: EnumCandidate[];
  /** Number of documents in the sampled index */
  sampledDocCount: number;
  /** OpenSearch index that was sampled */
  indexName: string;
}

/** Options for controlling sampling behavior */
export interface SamplingOptions {
  /** Maximum documents to consider (default: 10000) */
  maxSampleSize?: number;
  /** Maximum distinct values per field before excluding (default: 50) */
  maxCardinality?: number;
  /** Minimum frequency threshold as fraction (default: 0.001 = 0.1%) */
  minFrequency?: number;
}
