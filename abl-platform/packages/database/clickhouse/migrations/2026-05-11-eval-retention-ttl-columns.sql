-- ABLP-999 eval retention TTL columns
--
-- ClickHouse MergeTree TTL clauses are evaluated from table columns at merge
-- time, so this migration chooses column-driven TTL over a separate
-- ClickHouse delete sweeper. The application resolves tenant/source retention
-- when writing each row and stores it in ttl_override_days; ClickHouse then
-- expires rows natively with toIntervalDay(ttl_override_days).
--
-- This SQL text uses the default `abl_platform` database for documentation and
-- manual repair only. Production deployments must use the TypeScript runner at
-- packages/database/src/clickhouse-schemas/migrations/eval-retention-ttl-columns.ts
-- so non-default ClickHouse databases are resolved from configuration.

ALTER TABLE abl_platform.eval_conversations
    ADD COLUMN IF NOT EXISTS known_source LowCardinality(String) DEFAULT 'eval' CODEC(ZSTD(1)),
    ADD COLUMN IF NOT EXISTS ttl_override_days UInt16 DEFAULT 730 CODEC(T64, ZSTD(1)),
    MODIFY TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE;

ALTER TABLE abl_platform.eval_scores
    ADD COLUMN IF NOT EXISTS known_source LowCardinality(String) DEFAULT 'eval' CODEC(ZSTD(1)),
    ADD COLUMN IF NOT EXISTS ttl_override_days UInt16 DEFAULT 730 CODEC(T64, ZSTD(1)),
    MODIFY TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE;

ALTER TABLE abl_platform.eval_production_scores
    ADD COLUMN IF NOT EXISTS ttl_override_days UInt16 DEFAULT 365 CODEC(T64, ZSTD(1)),
    MODIFY TTL toDateTime(timestamp) + toIntervalDay(ttl_override_days) DELETE;
