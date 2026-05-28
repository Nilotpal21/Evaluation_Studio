import { describe, it, expect } from 'vitest';
import {
  periodToDays,
  validatePipelineType,
  parseClickHouseRows,
  VALID_PIPELINE_TYPES,
  PIPELINE_TABLES,
  PIPELINE_MV_TABLES,
  PIPELINE_DATE_COLUMNS,
  buildLatestPipelineRowsSubquery,
  shouldDedupePipelineBySession,
  dateWindowPredicate,
  isSessionEvaluationPipeline,
  parseOffsetDays,
  pipelineSourcePredicate,
  pipelineTableExpression,
} from '../routes/pipeline-analytics-helpers';

// ── periodToDays tests ──────────────────────────────────────────────────────

describe('periodToDays', () => {
  it('parses standard day periods', () => {
    expect(periodToDays('7d')).toBe(7);
    expect(periodToDays('30d')).toBe(30);
    expect(periodToDays('90d')).toBe(90);
    expect(periodToDays('1d')).toBe(1);
  });

  it('caps oversized periods to the maximum supported analytics window', () => {
    expect(periodToDays('91d')).toBe(90);
    expect(periodToDays('365d')).toBe(90);
  });

  it('defaults to 7 for invalid input', () => {
    expect(periodToDays('')).toBe(7);
    expect(periodToDays('abc')).toBe(7);
    expect(periodToDays('7')).toBe(7);
    expect(periodToDays('7h')).toBe(7);
    expect(periodToDays('d')).toBe(7);
  });

  it('defaults to 7 for edge cases', () => {
    expect(periodToDays('0d')).toBe(7);
    expect(periodToDays('-1d')).toBe(7); // negative not matched by \d+
  });
});

describe('parseOffsetDays', () => {
  it('parses non-negative integer offsets', () => {
    expect(parseOffsetDays('0')).toBe(0);
    expect(parseOffsetDays('7')).toBe(7);
  });

  it('defaults invalid offsets to zero', () => {
    expect(parseOffsetDays(undefined)).toBe(0);
    expect(parseOffsetDays('-1')).toBe(0);
    expect(parseOffsetDays('1.5')).toBe(0);
    expect(parseOffsetDays('abc')).toBe(0);
  });
});

describe('session evaluation query helpers', () => {
  it('marks all Agent Performance pipelines as session-level evaluation tables', () => {
    for (const pipelineType of [
      'quality_evaluation',
      'hallucination_detection',
      'knowledge_gap',
      'guardrail_analysis',
      'context_preservation',
    ]) {
      expect(isSessionEvaluationPipeline(pipelineType)).toBe(true);
      expect(pipelineTableExpression(pipelineType, PIPELINE_TABLES[pipelineType])).toContain(
        ' FINAL',
      );
      expect(pipelineSourcePredicate(pipelineType)).toBe("AND (source = 'batch' OR source = '')");
    }
  });

  it('does not add FINAL or source filter to non-Agent Performance tables', () => {
    expect(pipelineTableExpression('sentiment_analysis', PIPELINE_TABLES.sentiment_analysis)).toBe(
      PIPELINE_TABLES.sentiment_analysis,
    );
    expect(pipelineSourcePredicate('sentiment_analysis')).toBe('');
  });

  it('builds a true previous-window predicate when offsetDays is present', () => {
    expect(dateWindowPredicate('session_started_at', 7)).toContain(
      'session_started_at < now() - INTERVAL {offsetDays:UInt32} DAY',
    );
  });
});

// ── validatePipelineType tests ──────────────────────────────────────────────

describe('validatePipelineType', () => {
  it('accepts all valid pipeline types', () => {
    const validTypes = [
      'sentiment_analysis',
      'intent_classification',
      'quality_evaluation',
      'hallucination_detection',
      'knowledge_gap',
      'guardrail_analysis',
      'context_preservation',
      'friction_detection',
      'anomaly_detection',
      'drift_detection',
      'llm_evaluate',
    ];

    for (const type of validTypes) {
      expect(validatePipelineType(type)).toBe(true);
    }
  });

  it('rejects invalid pipeline types', () => {
    expect(validatePipelineType('invalid_type')).toBe(false);
    expect(validatePipelineType('')).toBe(false);
    expect(validatePipelineType('SENTIMENT_ANALYSIS')).toBe(false);
    expect(validatePipelineType('sentiment-analysis')).toBe(false);
  });

  it('is consistent with VALID_PIPELINE_TYPES set', () => {
    expect(VALID_PIPELINE_TYPES.size).toBe(11);
    for (const type of VALID_PIPELINE_TYPES) {
      expect(validatePipelineType(type)).toBe(true);
    }
  });
});

// ── parseClickHouseRows tests ───────────────────────────────────────────────

describe('parseClickHouseRows', () => {
  it('returns the array directly when result is an array (Shape A)', () => {
    const rows = [{ total_conversations: 42 }, { total_conversations: 100 }];
    expect(parseClickHouseRows(rows)).toBe(rows);
  });

  it('extracts data array from ClickHouse JSON format (Shape B)', () => {
    const rows = [{ total_conversations: 42 }];
    const chResponse = {
      meta: [{ name: 'total_conversations', type: 'UInt64' }],
      data: rows,
      rows: 1,
      statistics: { elapsed: 0.001 },
    };
    expect(parseClickHouseRows(chResponse)).toBe(rows);
  });

  it('returns empty array for empty ClickHouse response', () => {
    const chResponse = { meta: [], data: [], rows: 0 };
    expect(parseClickHouseRows(chResponse)).toEqual([]);
  });

  it('returns empty array for null/undefined', () => {
    expect(parseClickHouseRows(null)).toEqual([]);
    expect(parseClickHouseRows(undefined)).toEqual([]);
  });

  it('returns empty array for object without data property', () => {
    expect(parseClickHouseRows({ something: 'else' })).toEqual([]);
  });

  it('returns empty array for empty object', () => {
    expect(parseClickHouseRows({})).toEqual([]);
  });
});

// ── Table/column mapping consistency tests ──────────────────────────────────

describe('pipeline table mappings', () => {
  it('every valid pipeline type has a table mapping', () => {
    for (const type of VALID_PIPELINE_TYPES) {
      expect(PIPELINE_TABLES[type]).toBeDefined();
      expect(PIPELINE_TABLES[type]).toMatch(/^abl_platform\./);
    }
  });

  it('every valid pipeline type has a date column mapping', () => {
    for (const type of VALID_PIPELINE_TYPES) {
      expect(PIPELINE_DATE_COLUMNS[type]).toBeDefined();
      expect(['session_started_at', 'processed_at']).toContain(PIPELINE_DATE_COLUMNS[type]);
    }
  });

  it('MV tables are a subset of valid pipeline types', () => {
    for (const type of Object.keys(PIPELINE_MV_TABLES)) {
      expect(VALID_PIPELINE_TYPES.has(type)).toBe(true);
    }
  });

  it('MV table names follow naming convention', () => {
    for (const table of Object.values(PIPELINE_MV_TABLES)) {
      expect(table).toMatch(/^abl_platform\.mv_daily_/);
    }
  });
});

// ── ReplacingMergeTree dedupe helpers ───────────────────────────────────────

describe('session dedupe helpers', () => {
  it('dedupes Dashboard pipeline tables that can be reprocessed per session', () => {
    expect(shouldDedupePipelineBySession('sentiment_analysis')).toBe(true);
    expect(shouldDedupePipelineBySession('intent_classification')).toBe(true);
    expect(shouldDedupePipelineBySession('quality_evaluation')).toBe(true);
  });

  it('does not dedupe non-Dashboard pipeline tables through the session helper', () => {
    expect(shouldDedupePipelineBySession('hallucination_detection')).toBe(false);
    expect(shouldDedupePipelineBySession('anomaly_detection')).toBe(false);
  });

  it('builds latest-session subquery with argMax over processed_at', () => {
    const query = buildLatestPipelineRowsSubquery(
      'quality_evaluation',
      'abl_platform.quality_evaluations',
      'session_started_at',
    );

    expect(query).toContain('argMax(overall_score, processed_at) AS overall_score');
    expect(query).toContain('argMax(flagged, processed_at) AS flagged');
    expect(query).toContain('FROM abl_platform.quality_evaluations');
    expect(query).toContain('GROUP BY session_id');
  });

  it('avoids ClickHouse ILLEGAL_AGGREGATION by aliasing the date column to _<col> in the inner query and remapping it in the outer query', () => {
    const query = buildLatestPipelineRowsSubquery(
      'sentiment_analysis',
      'abl_platform.conversation_sentiment',
      'session_started_at',
    );

    // Inner SELECT must use a non-colliding alias for the date column
    expect(query).toContain('argMax(session_started_at, processed_at) AS _session_started_at');
    // The original alias must NOT appear in the inner SELECT (would shadow the WHERE column)
    expect(query).not.toMatch(
      /argMax\(session_started_at[^)]*\)\s+AS\s+session_started_at(?!\s*_)/,
    );
    // Outer SELECT must remap it back so callers still see session_started_at
    expect(query).toContain('_session_started_at AS session_started_at');
    // Non-date columns must pass through with their original names unchanged
    expect(query).toContain('argMax(avg_sentiment, processed_at) AS avg_sentiment');
    // The WHERE clause (inside inner query) must still reference the original column name
    expect(query).toContain('AND session_started_at >= now()');
  });
});
