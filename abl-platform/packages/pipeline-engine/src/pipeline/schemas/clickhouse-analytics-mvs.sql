-- =========================================================================
-- Analytics Pipeline Materialized Views
--
-- Daily aggregation MVs for sentiment, intent, and quality tables.
-- Uses SummingMergeTree for efficient incremental rollups.
--
-- Created by: init-analytics-tables.ts (called at pipeline engine startup)
-- =========================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_sentiment
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    count() AS conversation_count,
    sum(avg_sentiment) AS total_sentiment,
    sum(CASE WHEN sentiment_trajectory = 'declining' THEN 1 ELSE 0 END) AS declining_count,
    sum(CASE WHEN frustration_detected = 1 THEN 1 ELSE 0 END) AS frustrated_count
FROM abl_platform.conversation_sentiment
GROUP BY tenant_id, project_id, date, agent_name;

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    intent,
    count() AS conversation_count,
    sum(confidence) AS total_confidence
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent;

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_quality_scores
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    channel,
    count() AS conversation_count,
    sum(overall_score) AS total_score,
    sum(helpfulness) AS total_helpfulness,
    sum(accuracy) AS total_accuracy,
    sum(professionalism) AS total_professionalism,
    sum(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
FROM abl_platform.quality_evaluations
GROUP BY tenant_id, project_id, date, agent_name, channel;
