/**
 * Workflow Document Extraction Types
 *
 * Wire-format job payloads consumed by the search-ai docling worker's
 * `workflow-docling-extraction` queue branch and produced by the
 * workflow-engine's `extract_document` connector action.
 *
 * The ingestion-path `DoclingExtractionJobData` stays worker-local —
 * only the workflow shape is lifted to the SDK because workflow-engine
 * is a producer of the wire format.
 */

export interface DoclingWorkflowExtractionOptions {
  /** Optional page range, e.g. "1-5" or "1,3,7" (provider honors where supported). */
  pages?: string;
  extractImages?: boolean;
  extractTables?: boolean;
  ocrEnabled?: boolean;
  /** ISO-639-1 language hint. */
  language?: string;
  /** Per-job timeout in seconds (5–1800). Defaults to FR-4 default of 60. */
  timeout?: number;
}

export interface WorkflowDoclingExtractionJobData {
  /** Discriminator: distinguishes workflow-path payloads from the ingestion-path `DoclingExtractionJobData`. */
  mode: 'extraction-only';
  /** Public file URL — validated for SSRF both pre-enqueue and at the worker. */
  sourceUrl: string;
  tenantId: string;
  projectId: string;
  workflowExecutionId: string;
  stepId: string;
  /** Opaque id used for callback correlation (currently mirrors `stepId`). */
  callbackId: string;
  /** Absolute URL the worker POSTs back to once extraction completes. */
  callbackUrl: string;
  /**
   * Plaintext HMAC secret used to sign the callback POST. Redis is an internal,
   * network-isolated, trusted store under the platform threat model (same store
   * already carries tenant identifiers and resource ids). The ciphertext copy
   * persisted on the step record remains the source of truth for callback
   * verification on resume after pod restart.
   */
  callbackSecret: string;
  options?: DoclingWorkflowExtractionOptions;
  /** Optional cross-service correlation id. */
  traceId?: string;
}

/** Type guard for the workflow-path branch inside the shared worker processor. */
export function isWorkflowDoclingExtractionJob(
  data: unknown,
): data is WorkflowDoclingExtractionJobData {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { mode?: unknown }).mode === 'extraction-only'
  );
}
