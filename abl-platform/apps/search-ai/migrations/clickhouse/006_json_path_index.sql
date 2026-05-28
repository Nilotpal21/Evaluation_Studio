-- Migration: Create JSON Path Index Table for Hierarchical Structured Data
-- Purpose: Enable path-based queries on JSON/XML objects (e.g., "users[0].name")

CREATE TABLE IF NOT EXISTS json_path_index (
    -- Isolation (multi-tenant security)
    tenant_id String,
    index_id String,

    -- Object identity (maps to MongoDB SearchChunk documentId)
    object_id String,
    object_type Enum8('json' = 1, 'xml' = 2),

    -- Path information
    path String,                    -- Full path: 'users[0].name'
    path_normalized String,         -- Pattern: 'users[].name' (for pattern matching)
    depth UInt8,                    -- Nesting depth (0-255)

    -- Value information (nullable - one will be populated based on type)
    value_type Enum8(
        'string' = 1,
        'number' = 2,
        'boolean' = 3,
        'null' = 4,
        'object' = 5,
        'array' = 6
    ),
    value_string Nullable(String),
    value_number Nullable(Float64),
    value_boolean Nullable(UInt8),

    -- Parent-child relationships
    parent_path Nullable(String),

    -- Search optimization
    path_tokens Array(String),      -- Tokenized path: ['users', 'name']

    -- Metadata
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(created_at))
ORDER BY (tenant_id, index_id, object_id, path)
SETTINGS index_granularity = 8192;

-- Index for path pattern matching (enables queries like: "find all paths matching users[].name")
ALTER TABLE json_path_index ADD INDEX idx_path_pattern path_normalized TYPE minmax GRANULARITY 4;

-- Index for string value search (enables: "find paths where value contains 'alice'")
ALTER TABLE json_path_index ADD INDEX idx_value_string value_string TYPE bloom_filter() GRANULARITY 1;

-- Index for numeric value range queries (enables: "find paths where value > 100")
ALTER TABLE json_path_index ADD INDEX idx_value_number value_number TYPE minmax GRANULARITY 4;

-- Comments for documentation
ALTER TABLE json_path_index COMMENT 'Path index for hierarchical JSON/XML objects. Enables path-based queries and analytics.';

COMMENT ON COLUMN json_path_index.path IS 'Full JSON path with array indices: users[0].profile.name';
COMMENT ON COLUMN json_path_index.path_normalized IS 'Normalized path for pattern matching (array indices replaced with []): users[].profile.name';
COMMENT ON COLUMN json_path_index.path_tokens IS 'Searchable tokens extracted from path (array indices removed): [users, profile, name]';
COMMENT ON COLUMN json_path_index.parent_path IS 'Parent path for building hierarchical queries. NULL for root-level fields.';
