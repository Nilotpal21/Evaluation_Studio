export interface StoreEncryptionConfig {
  readonly fieldsToEncrypt: readonly string[];
}

export const CLICKHOUSE_ENCRYPTION_MANIFEST: Readonly<Record<string, StoreEncryptionConfig>> = {
  // Sensitive — fields encrypted
  messages: { fieldsToEncrypt: ['content'] },
  traces: { fieldsToEncrypt: ['data'] },
  platform_events: { fieldsToEncrypt: ['data'] },
  audit_events: { fieldsToEncrypt: ['metadata', 'old_value', 'new_value'] },
  facts: { fieldsToEncrypt: [] }, // No tenant_id column — cannot encrypt
  insight_results: { fieldsToEncrypt: ['dimensions'] },
  // Raw feedback text is PII (FeedbackSubmittedDataSchema declares containsPII).
  // Encrypted at rest via the same tenant-DEK pipeline used for messages.content.
  feedback: { fieldsToEncrypt: ['feedback_text'] },

  // Non-sensitive — explicitly no encryption
  llm_metrics: { fieldsToEncrypt: [] },
  llm_metrics_hourly_dest: { fieldsToEncrypt: [] },
  llm_metrics_daily_dest: { fieldsToEncrypt: [] },
  logs: { fieldsToEncrypt: [] },
  search_queries: { fieldsToEncrypt: [] },
  search_ingestion_events: { fieldsToEncrypt: [] },
  dead_letter_events: { fieldsToEncrypt: [] },
  kms_audit_log: { fieldsToEncrypt: [] },
  platform_events_agent_hourly_dest: { fieldsToEncrypt: [] },
  platform_events_tool_daily_dest: { fieldsToEncrypt: [] },
  platform_events_error_hourly_dest: { fieldsToEncrypt: [] },
};

export const REDIS_QUEUE_ENCRYPTION_MANIFEST: Readonly<Record<string, StoreEncryptionConfig>> = {
  'llm-requests': { fieldsToEncrypt: ['message'] },
  'message-persistence': { fieldsToEncrypt: ['content'] },
  'reencryption-queue': { fieldsToEncrypt: [] },
  'search-ingestion': { fieldsToEncrypt: [] },
  'search-extraction': { fieldsToEncrypt: [] },
  'search-docling-extraction': { fieldsToEncrypt: [] },
  'workflow-docling-extraction': { fieldsToEncrypt: ['callbackSecret', 'callbackUrl'] },
  'workflow-adi-poll': { fieldsToEncrypt: ['callbackSecret', 'apiKey', 'callbackUrl'] },
  'search-page-processing': { fieldsToEncrypt: [] },
  'search-tree-building': { fieldsToEncrypt: [] },
  'search-canonical-map': { fieldsToEncrypt: [] },
  'search-enrichment': { fieldsToEncrypt: [] },
  'search-embedding': { fieldsToEncrypt: [] },
  'search-knowledge-graph': { fieldsToEncrypt: [] },
  'search-multimodal': { fieldsToEncrypt: [] },
  'search-question-synthesis': { fieldsToEncrypt: [] },
  'search-scope-classification': { fieldsToEncrypt: [] },
  'search-visual-enrichment': { fieldsToEncrypt: [] },
  'search-cleanup': { fieldsToEncrypt: [] },
  'search-azuread-user-sync': { fieldsToEncrypt: [] },
  'search-azuread-group-sync': { fieldsToEncrypt: [] },
  'search-okta-user-sync': { fieldsToEncrypt: [] },
  'search-okta-group-sync': { fieldsToEncrypt: [] },
  'search-google-user-sync': { fieldsToEncrypt: [] },
  'search-google-group-sync': { fieldsToEncrypt: [] },
  'search-schema-sync': { fieldsToEncrypt: [] },
  'connector-discovery': { fieldsToEncrypt: [] },
  'connector-sync': { fieldsToEncrypt: [] },
  'connector-permission-crawl': { fieldsToEncrypt: [] },
  'structured-data-ingestion': { fieldsToEncrypt: [] },
  'webhook-notification': { fieldsToEncrypt: [] },
  'vocabulary-generation': { fieldsToEncrypt: [] },
  'permission-recrawl': { fieldsToEncrypt: [] },
  'taxonomy-setup': { fieldsToEncrypt: [] },
  'kg-enrichment': { fieldsToEncrypt: [] },
  'project-export': { fieldsToEncrypt: [] },
  'attachment-scan': { fieldsToEncrypt: [] },
  'attachment-validate': { fieldsToEncrypt: [] },
  'attachment-process': { fieldsToEncrypt: [] },
  'attachment-index': { fieldsToEncrypt: [] },
  'attachment-cleanup': { fieldsToEncrypt: [] },
  'scheduled-delta-sync': { fieldsToEncrypt: [] },
  'scheduled-delta-cleanup': { fieldsToEncrypt: [] },
  'scheduled-webhook-renewal': { fieldsToEncrypt: [] },
  'scheduled-webhook-cleanup': { fieldsToEncrypt: [] },
};

export function getClickHouseManifest(table: string): StoreEncryptionConfig {
  const config = CLICKHOUSE_ENCRYPTION_MANIFEST[table];
  if (!config) {
    throw new Error(
      `Unregistered ClickHouse table: "${table}". Add to CLICKHOUSE_ENCRYPTION_MANIFEST.`,
    );
  }
  return config;
}

export function getRedisQueueManifest(queue: string): StoreEncryptionConfig {
  const config = REDIS_QUEUE_ENCRYPTION_MANIFEST[queue];
  if (!config) {
    throw new Error(
      `Unregistered Redis queue: "${queue}". Add to REDIS_QUEUE_ENCRYPTION_MANIFEST.`,
    );
  }
  return config;
}
