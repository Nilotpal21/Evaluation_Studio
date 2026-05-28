/**
 * P2/T2 — findStoreTable destination-aware filter.
 *
 * The Preview tab reads from ClickHouse only. Before P2, findStoreTable returned
 * any table name regardless of destination, causing MongoDB-destination pipelines
 * to appear in the preview dropdown and then fail at query time with INVALID_TABLE.
 *
 * This test pins the new behaviour: only ClickHouse destinations with a valid
 * `database.table` table name return a non-null table.
 */

import { describe, it, expect } from 'vitest';
import { findStoreTable } from '../../services/pipeline-observability/previewable-pipelines-service.js';
import { CUSTOM_PIPELINE_RESULTS_TABLE } from '@agent-platform/pipeline-engine/contracts';

function defWith(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
  return { nodes };
}

describe('findStoreTable — destination-aware filtering (P2/T2)', () => {
  it('returns table for explicit ClickHouse destination with valid database.table name', () => {
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: {
          destination: 'clickhouse',
          table: 'abl_platform.conversation_sentiment',
          sourceStep: 'compute-sentiment',
        },
      },
    ]);
    expect(findStoreTable(def)).toBe('abl_platform.conversation_sentiment');
  });

  it('defaults ClickHouse destination without table to shared custom pipeline results table', () => {
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: {
          destination: 'clickhouse',
          sourceStep: 'llm-evaluate',
        },
      },
    ]);
    expect(findStoreTable(def)).toBe(CUSTOM_PIPELINE_RESULTS_TABLE);
  });

  it('returns null when destination is mongodb (preview cannot read Mongo)', () => {
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: {
          destination: 'mongodb',
          table: 'test_custom_politeness',
          sourceStep: 'llm-evaluate',
        },
      },
    ]);
    expect(findStoreTable(def)).toBeNull();
  });

  it('returns null when destination is callback', () => {
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: {
          destination: 'callback',
          callbackUrl: 'https://example.com/hook',
        },
      },
    ]);
    expect(findStoreTable(def)).toBeNull();
  });

  it('returns null when destination is "none"', () => {
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: { destination: 'none' },
      },
    ]);
    expect(findStoreTable(def)).toBeNull();
  });

  it('returns null when ClickHouse destination has a bare (non database.table) table name', () => {
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: {
          destination: 'clickhouse',
          table: 'test_custom_politeness',
        },
      },
    ]);
    expect(findStoreTable(def)).toBeNull();
  });

  it('treats missing destination as legacy ClickHouse when table format is database.table', () => {
    // Pre-P2 pipelines do not set `destination`. They were all ClickHouse by the
    // schema-resolver.ts defaults, so we preserve that behaviour for legacy entries.
    const def = defWith([
      {
        id: 'store',
        type: 'store-results',
        config: {
          table: 'abl_platform.conversation_sentiment',
        },
      },
    ]);
    expect(findStoreTable(def)).toBe('abl_platform.conversation_sentiment');
  });

  it('returns null when no store-results node exists', () => {
    const def = defWith([
      { id: 'read', type: 'read-conversation', config: {} },
      { id: 'compute', type: 'compute-sentiment', config: {} },
    ]);
    expect(findStoreTable(def)).toBeNull();
  });

  it('detects store-results inside legacy flat steps array', () => {
    const def = {
      steps: [
        {
          id: 'store',
          type: 'store-results',
          config: {
            destination: 'clickhouse',
            table: 'abl_platform.quality_evaluations',
          },
        },
      ],
    };
    expect(findStoreTable(def)).toBe('abl_platform.quality_evaluations');
  });

  it('detects store-results inside strategies.*.steps (per-trigger execution)', () => {
    const def = {
      strategies: {
        batch: {
          steps: [
            {
              id: 'store',
              type: 'store-results',
              config: {
                destination: 'clickhouse',
                table: 'abl_platform.intent_classifications',
              },
            },
          ],
        },
      },
    };
    expect(findStoreTable(def)).toBe('abl_platform.intent_classifications');
  });

  it('filters out strategy-level Mongo destinations too', () => {
    const def = {
      strategies: {
        batch: {
          steps: [
            {
              id: 'store',
              type: 'store-results',
              config: { destination: 'mongodb', table: 'junk' },
            },
          ],
        },
      },
    };
    expect(findStoreTable(def)).toBeNull();
  });
});
