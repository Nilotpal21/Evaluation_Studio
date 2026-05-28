/**
 * OpenSearch Index Mapping Templates
 *
 * Strict mappings to prevent schema bloat and ensure query performance.
 * All vector indices (shared, per-app, per-connector) use the same mapping.
 */

/**
 * Complete mapping template for vector indices.
 * Combines vector field, content field, and structured metadata.
 */
export const VECTOR_INDEX_MAPPING = {
  settings: {
    index: {
      // k-NN plugin settings
      knn: true,
      'knn.algo_param.ef_search': 100, // HNSW search parameter (trade-off: recall vs latency)

      // Refresh interval (how often index is refreshed for search)
      // 1s = near real-time, 30s = better indexing throughput
      refresh_interval: '5s',

      // Number of shards (distribute across nodes)
      // Shared indices: set via config (default: 1)
      // Per-app/connector: 1 shard (small indices)
      number_of_shards: 1,

      // Number of replicas (high availability)
      // 0 = no replicas (dev), 1 = one replica (prod)
      number_of_replicas: 1,

      // Translog settings (durability vs performance)
      'translog.durability': 'async', // Async for better write performance
      'translog.sync_interval': '5s',

      // Merge policy (background segment merging)
      'merge.policy.max_merged_segment': '5gb',

      // Codec (compression)
      codec: 'best_compression', // Trade-off: storage vs CPU
    },
    analysis: {
      analyzer: {
        // Custom analyzer for content field
        content_analyzer: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'stop', 'snowball'], // English stemming
        },
      },
    },
  },
  mappings: {
    // CRITICAL: Strict mode prevents unknown fields from being indexed
    dynamic: 'strict',

    properties: {
      // ─── Vector Field ────────────────────────────────────────────────
      vector: {
        type: 'knn_vector',
        dimension: 1024, // BGE-M3 dimensions
        method: {
          name: 'hnsw', // Hierarchical Navigable Small World algorithm
          space_type: 'cosinesimil', // Cosine similarity
          engine: 'faiss', // Faiss: SIMD-accelerated, native kNN filtering (2.9+), NMSLIB deprecated in 2.16
          parameters: {
            ef_construction: 128, // HNSW construction parameter (trade-off: quality vs build time)
            m: 16, // HNSW max connections per node (trade-off: recall vs memory)
          },
        },
      },

      // ─── Content Field ───────────────────────────────────────────────
      // Analyzed text for full-text search (optional, fallback to vector search)
      content: {
        type: 'text',
        analyzer: 'content_analyzer',
        // Store original text for highlighting
        store: false, // Set to true if you need to retrieve original content
        // Term vectors for more-like-this queries
        term_vector: 'no',
      },

      // ─── Permissions Field ──────────────────────────────────────────
      // Document-level access control (IdP-based authentication)
      // Populated by embedding worker from Neo4j permission graph
      permissions: {
        type: 'object',
        dynamic: 'strict',
        properties: {
          // Public access flags
          publicEverywhere: {
            type: 'boolean',
            index: true,
          },
          publicInDomain: {
            type: 'boolean',
            index: true,
          },
          // Direct user access (array of email addresses)
          allowedUsers: {
            type: 'keyword',
            index: true,
          },
          // Group access (array of group IDs: "azuread:g_123", "sharepoint:g_456")
          allowedGroups: {
            type: 'keyword',
            index: true,
          },
          // Domain access (array of verified domains: "company.com")
          allowedDomains: {
            type: 'keyword',
            index: true,
          },
          // Permission source (sharepoint, google-drive, manual, etc.)
          source: {
            type: 'keyword',
            index: true,
          },
          // Last permission sync timestamp
          lastSyncedAt: {
            type: 'date',
            format: 'strict_date_optional_time||epoch_millis',
            index: true,
          },
        },
      },

      // ─── Metadata: System (sys) ──────────────────────────────────────
      // System metadata - indexing concerns, always present
      metadata: {
        type: 'object',
        dynamic: 'strict', // No unknown fields in metadata
        properties: {
          sys: {
            type: 'object',
            dynamic: 'strict',
            properties: {
              // Tenant identifier (multi-tenancy isolation)
              tenantId: {
                type: 'keyword', // Exact match, filtering
                index: true,
              },
              // App/index identifier (SearchIndex _id)
              appId: {
                type: 'keyword',
                index: true,
              },
              // Connector/source identifier (SearchSource _id)
              connectorId: {
                type: 'keyword',
                index: true,
              },
              // Document identifier
              documentId: {
                type: 'keyword',
                index: true,
              },
              // Chunk identifier
              chunkId: {
                type: 'keyword',
                index: true,
              },
              // Chunk position within document
              chunkIndex: {
                type: 'integer',
                index: true,
              },
              // Question identifier (for question vectors from question synthesis)
              questionId: {
                type: 'keyword',
                index: true,
              },
              // Question scope: 'chunk' or 'document'
              questionScope: {
                type: 'keyword',
                index: true,
              },
            },
          },

          // ─── Metadata: Document (doc) ────────────────────────────────
          // Document metadata - source information
          doc: {
            type: 'object',
            dynamic: 'strict',
            properties: {
              // Original filename or URL
              name: {
                type: 'keyword',
                index: true,
              },
              // MIME type (application/pdf, text/html, etc.)
              contentType: {
                type: 'keyword',
                index: true,
              },
              // SHA-256 hash for deduplication
              contentHash: {
                type: 'keyword',
                index: false, // No need to search by hash
              },
              // Detected language (en, es, fr, etc.)
              language: {
                type: 'keyword',
                index: true,
              },
              // Document-level summary (generated)
              summary: {
                type: 'text',
                analyzer: 'content_analyzer',
                index: false, // No search on summary (too long)
              },
            },
          },

          // ─── Metadata: Question (question) ───────────────────────────
          // Question metadata - for question synthesis vectors
          question: {
            type: 'object',
            dynamic: 'strict',
            properties: {
              // Question type (factual, conceptual, etc.)
              type: {
                type: 'keyword',
                index: true,
              },
              // Confidence score (0.0 - 1.0)
              confidence: {
                type: 'float',
                index: true,
              },
              // Question scope: 'chunk' or 'document'
              scope: {
                type: 'keyword',
                index: true,
              },
            },
          },

          // ─── Metadata: Canonical (canonical) ─────────────────────────
          // 75-field fixed canonical schema. All fields pre-defined at index
          // creation. Aliases (business names) live in MongoDB CanonicalSchema,
          // not here. dynamic:"false" allows storing overflow fields that aren't
          // indexed. See 04-CANONICAL-SCHEMA-ALIAS-DESIGN.md for full design.
          canonical: {
            type: 'object',
            dynamic: 'false',
            properties: {
              // ── 15 CORE fields (always populated) ─────────────────────
              id: { type: 'keyword', index: true },
              tenant_id: { type: 'keyword', index: true },
              document_id: { type: 'keyword', index: true },
              title: {
                type: 'text',
                analyzer: 'content_analyzer',
                index: true,
                fields: { keyword: { type: 'keyword', ignore_above: 256 } },
              },
              content_summary: {
                type: 'text',
                analyzer: 'content_analyzer',
                index: true,
                fields: { keyword: { type: 'keyword', ignore_above: 256 } },
              },
              source_type: { type: 'keyword', index: true },
              source_url: { type: 'keyword', index: false },
              created_date: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              modified_date: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              author: { type: 'keyword', index: true },
              access_level: { type: 'keyword', index: true },
              language: { type: 'keyword', index: true },
              mime_type: { type: 'keyword', index: true },
              status: { type: 'keyword', index: true },
              category: { type: 'keyword', index: true },

              // ── 26 COMMON fields (populated when available) ───────────
              description: {
                type: 'text',
                analyzer: 'content_analyzer',
                index: true,
                fields: { keyword: { type: 'keyword', ignore_above: 256 } },
              },
              tags: { type: 'keyword', index: true },
              priority: { type: 'float', index: true },
              assignee: { type: 'keyword', index: true },
              reporter: { type: 'keyword', index: true },
              modified_by: { type: 'keyword', index: true },
              department: { type: 'keyword', index: true },
              project: { type: 'keyword', index: true },
              version: { type: 'keyword', index: true },
              parent_id: { type: 'keyword', index: true },
              due_date: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              resolved_date: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              attachment_count: { type: 'integer', index: true },
              comment_count: { type: 'integer', index: true },
              is_archived: { type: 'boolean', index: true },
              severity: { type: 'keyword', index: true },
              resolution: { type: 'keyword', index: true },
              component: { type: 'keyword', index: true },
              label: { type: 'keyword', index: true },
              story_points: { type: 'float', index: true },
              sprint: { type: 'keyword', index: true },
              epic: { type: 'keyword', index: true },
              environment: { type: 'keyword', index: true },
              customer: { type: 'keyword', index: true },
              deal_amount: { type: 'float', index: true },
              stage: { type: 'keyword', index: true },

              // ── Entities (NER-extracted, nested) ──────────────────────
              entities: {
                type: 'object',
                dynamic: 'false',
                properties: {
                  person: { type: 'keyword', index: true },
                  organization: { type: 'keyword', index: true },
                  location: { type: 'keyword', index: true },
                  date: { type: 'keyword', index: true },
                  money: { type: 'keyword', index: true },
                },
              },

              // ── 20 Custom String slots ────────────────────────────────
              custom_string_1: { type: 'keyword', index: true },
              custom_string_2: { type: 'keyword', index: true },
              custom_string_3: { type: 'keyword', index: true },
              custom_string_4: { type: 'keyword', index: true },
              custom_string_5: { type: 'keyword', index: true },
              custom_string_6: { type: 'keyword', index: true },
              custom_string_7: { type: 'keyword', index: true },
              custom_string_8: { type: 'keyword', index: true },
              custom_string_9: { type: 'keyword', index: true },
              custom_string_10: { type: 'keyword', index: true },
              custom_string_11: { type: 'keyword', index: true },
              custom_string_12: { type: 'keyword', index: true },
              custom_string_13: { type: 'keyword', index: true },
              custom_string_14: { type: 'keyword', index: true },
              custom_string_15: { type: 'keyword', index: true },
              custom_string_16: { type: 'keyword', index: true },
              custom_string_17: { type: 'keyword', index: true },
              custom_string_18: { type: 'keyword', index: true },
              custom_string_19: { type: 'keyword', index: true },
              custom_string_20: { type: 'keyword', index: true },

              // ── 10 Custom Number slots ────────────────────────────────
              custom_number_1: { type: 'float', index: true },
              custom_number_2: { type: 'float', index: true },
              custom_number_3: { type: 'float', index: true },
              custom_number_4: { type: 'float', index: true },
              custom_number_5: { type: 'float', index: true },
              custom_number_6: { type: 'float', index: true },
              custom_number_7: { type: 'float', index: true },
              custom_number_8: { type: 'float', index: true },
              custom_number_9: { type: 'float', index: true },
              custom_number_10: { type: 'float', index: true },

              // ── 5 Custom Date slots ───────────────────────────────────
              custom_date_1: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              custom_date_2: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              custom_date_3: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              custom_date_4: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },
              custom_date_5: {
                type: 'date',
                format: 'strict_date_optional_time||epoch_millis',
                index: true,
              },

              // ── 5 Custom Boolean slots ────────────────────────────────
              custom_bool_1: { type: 'boolean', index: true },
              custom_bool_2: { type: 'boolean', index: true },
              custom_bool_3: { type: 'boolean', index: true },
              custom_bool_4: { type: 'boolean', index: true },
              custom_bool_5: { type: 'boolean', index: true },

              // ── Overflow (stored but not indexed) ─────────────────────
              custom: {
                type: 'object',
                enabled: false,
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Get mapping template for a specific dimension size.
 * Used for different embedding models (BGE-M3: 1024, OpenAI: 1536, etc.).
 */
export function getVectorIndexMapping(options: {
  dimensions: number;
  distance?: 'cosine' | 'euclidean' | 'dot_product';
  shards?: number;
  replicas?: number;
  refreshInterval?: string;
  efConstruction?: number;
  m?: number;
  efSearch?: number;
}): typeof VECTOR_INDEX_MAPPING {
  const {
    dimensions,
    distance = 'cosine',
    shards = 1,
    replicas = 1,
    refreshInterval = '5s',
    efConstruction = 128,
    m = 16,
    efSearch = 100,
  } = options;

  // Map distance metrics to OpenSearch space_type
  const spaceTypeMap = {
    cosine: 'cosinesimil',
    euclidean: 'l2',
    dot_product: 'innerproduct',
  };

  return {
    settings: {
      index: {
        knn: true,
        'knn.algo_param.ef_search': efSearch,
        refresh_interval: refreshInterval,
        number_of_shards: shards,
        number_of_replicas: replicas,
        'translog.durability': 'async',
        'translog.sync_interval': '5s',
        'merge.policy.max_merged_segment': '5gb',
        codec: 'best_compression',
      },
      analysis: VECTOR_INDEX_MAPPING.settings.analysis,
    },
    mappings: {
      ...VECTOR_INDEX_MAPPING.mappings,
      properties: {
        ...VECTOR_INDEX_MAPPING.mappings.properties,
        vector: {
          type: 'knn_vector',
          dimension: dimensions,
          method: {
            name: 'hnsw',
            space_type: spaceTypeMap[distance],
            engine: 'faiss', // Faiss: SIMD-accelerated, native kNN filtering (2.9+)
            parameters: {
              ef_construction: efConstruction,
              m: m,
            },
          },
        },
      },
    },
  };
}

/**
 * Mapping for shared indices.
 * Higher capacity, optimized for mixed workloads.
 */
export function getSharedIndexMapping(config: {
  dimensions: number;
  shards?: number;
  replicas?: number;
}): typeof VECTOR_INDEX_MAPPING {
  return getVectorIndexMapping({
    dimensions: config.dimensions,
    distance: 'cosine',
    shards: config.shards || 1,
    replicas: config.replicas || 1,
    refreshInterval: '5s', // Balanced for mixed workloads
    efConstruction: 128,
    m: 16,
    efSearch: 100,
  });
}

/**
 * Mapping for dedicated indices (per-app, per-connector).
 * Lower capacity, optimized for single app.
 */
export function getDedicatedIndexMapping(config: {
  dimensions: number;
}): typeof VECTOR_INDEX_MAPPING {
  return getVectorIndexMapping({
    dimensions: config.dimensions,
    distance: 'cosine',
    shards: 1, // Single shard (dedicated indices are smaller)
    replicas: 1,
    refreshInterval: '5s',
    efConstruction: 128,
    m: 16,
    efSearch: 100,
  });
}

/**
 * Field types reference (for documentation).
 */
export const FIELD_TYPES = {
  // ── Exact Match Fields ──────────────────────────────────────────────
  keyword: 'Exact match, sorting, aggregations. Not analyzed. (e.g., IDs, statuses, tags)',

  // ── Full-Text Search Fields ─────────────────────────────────────────
  text: 'Analyzed text for full-text search. Tokenized, stemmed, lowercased.',

  // ── Numeric Fields ──────────────────────────────────────────────────
  integer: 'Integer numbers (-2^31 to 2^31-1)',
  long: 'Long integers (-2^63 to 2^63-1)',
  float: 'Single-precision floating point',
  double: 'Double-precision floating point',

  // ── Date Fields ─────────────────────────────────────────────────────
  date: 'Date/time field. Supports multiple formats (ISO 8601, epoch_millis)',

  // ── Boolean Fields ──────────────────────────────────────────────────
  boolean: 'True/false values',

  // ── Object Fields ───────────────────────────────────────────────────
  object: 'Nested JSON object. Can contain sub-fields.',

  // ── Vector Fields ───────────────────────────────────────────────────
  knn_vector: 'Dense vector for k-NN search. Requires dimension and method.',
};

/**
 * Dynamic settings reference (for documentation).
 */
export const DYNAMIC_SETTINGS = {
  strict: 'Reject documents with unknown fields (recommended for production)',
  true: 'Allow new fields (dynamic mapping)',
  false: 'Ignore new fields (store but do not index)',
};
