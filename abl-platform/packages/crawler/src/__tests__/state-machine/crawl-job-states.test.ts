/**
 * CrawlJob State Machine Tests
 *
 * Tests the state transition logic and validation for CrawlJob statuses.
 * This is a pure logic test — no MongoDB, no database mocks.
 *
 * Valid statuses (from ICrawlJob):
 *   'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed' | 'cancelled'
 *
 * processingErrors.phase values (from schema enum):
 *   'crawl' | 'ingest' | 'extract' | 'embed' | 'index'
 */

import { describe, test, expect } from 'vitest';

// ---------------------------------------------------------------------------
// State machine definition
// ---------------------------------------------------------------------------

type CrawlJobStatus =
  | 'queued'
  | 'crawling'
  | 'ingesting'
  | 'indexing'
  | 'completed'
  | 'failed'
  | 'cancelled';

const ALL_STATUSES: CrawlJobStatus[] = [
  'queued',
  'crawling',
  'ingesting',
  'indexing',
  'completed',
  'failed',
  'cancelled',
];

const TERMINAL_STATUSES: CrawlJobStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Valid state transitions for CrawlJob.
 *
 * Derived from code analysis of the crawler workers:
 *   - queued → crawling: Go worker picks up job
 *   - queued → ingesting: Go worker may skip 'crawling' for direct ingest
 *   - queued → failed: worker crash before start
 *   - queued → cancelled: user cancels before start
 *   - crawling → ingesting: crawl phase completes, ingestion begins
 *   - crawling → failed: crawl-phase crash
 *   - crawling → cancelled: user cancels during crawl
 *   - ingesting → completed: docs ingested > 0, job finishes
 *   - ingesting → failed: all URLs failed
 *   - ingesting → cancelled: user cancels during ingestion
 *   - indexing → completed: indexing finishes (future use)
 *   - indexing → failed: indexing crash (future use)
 */
const VALID_TRANSITIONS: Record<CrawlJobStatus, CrawlJobStatus[]> = {
  queued: ['crawling', 'ingesting', 'failed', 'cancelled'],
  crawling: ['ingesting', 'failed', 'cancelled'],
  ingesting: ['completed', 'failed', 'cancelled'],
  indexing: ['completed', 'failed'],
  completed: [], // terminal
  failed: [], // terminal
  cancelled: [], // terminal
};

function isValidTransition(from: CrawlJobStatus, to: CrawlJobStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// processingErrors.phase definition
// ---------------------------------------------------------------------------

/**
 * Valid phase values from the CrawlJob schema enum.
 * Note: the cancel handler in the codebase uses 'cancel' as a phase value,
 * which is NOT in the schema enum — this is a known bug.
 */
const VALID_PHASES = ['crawl', 'ingest', 'extract', 'embed', 'index'] as const;
type ProcessingPhase = (typeof VALID_PHASES)[number];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrawlJob State Machine', () => {
  // -----------------------------------------------------------------------
  // 1. Valid forward transitions
  // -----------------------------------------------------------------------
  describe('valid forward transitions', () => {
    const forwardCases: [CrawlJobStatus, CrawlJobStatus][] = [
      ['queued', 'crawling'],
      ['queued', 'ingesting'], // skip crawling for direct ingest
      ['crawling', 'ingesting'],
      ['ingesting', 'completed'],
      ['ingesting', 'failed'],
    ];

    test.each(forwardCases)('%s → %s is valid', (from, to) => {
      expect(isValidTransition(from, to)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 2. Valid cancel transitions
  // -----------------------------------------------------------------------
  describe('valid cancel transitions', () => {
    const cancelCases: [CrawlJobStatus, CrawlJobStatus][] = [
      ['queued', 'cancelled'],
      ['crawling', 'cancelled'],
      ['ingesting', 'cancelled'],
    ];

    test.each(cancelCases)('%s → cancelled is valid', (from) => {
      expect(isValidTransition(from, 'cancelled')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 3. Valid failure transitions
  // -----------------------------------------------------------------------
  describe('valid failure transitions', () => {
    const failureCases: CrawlJobStatus[] = ['queued', 'crawling', 'ingesting'];

    test.each(failureCases)('%s → failed is valid', (from) => {
      expect(isValidTransition(from, 'failed')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Invalid backward transitions
  // -----------------------------------------------------------------------
  describe('invalid backward transitions', () => {
    const backwardCases: [CrawlJobStatus, CrawlJobStatus][] = [
      ['completed', 'queued'],
      ['completed', 'crawling'],
      ['failed', 'queued'],
      ['cancelled', 'queued'],
      ['ingesting', 'crawling'], // no backward
      ['ingesting', 'queued'], // no backward
    ];

    test.each(backwardCases)('%s → %s is invalid', (from, to) => {
      expect(isValidTransition(from, to)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Terminal state tests
  // -----------------------------------------------------------------------
  describe('terminal states cannot transition to anything', () => {
    for (const terminal of TERMINAL_STATUSES) {
      test.each(ALL_STATUSES)(`${terminal} → %s is invalid`, (targetStatus) => {
        expect(isValidTransition(terminal, targetStatus)).toBe(false);
      });
    }
  });

  // -----------------------------------------------------------------------
  // 6. No self-transitions
  // -----------------------------------------------------------------------
  describe('self-transitions are not valid', () => {
    test.each(ALL_STATUSES)('%s → %s (self) is invalid', (status) => {
      expect(isValidTransition(status, status)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Skip states
  // -----------------------------------------------------------------------
  describe('skip states', () => {
    test('queued → ingesting is valid (Go worker may skip crawling)', () => {
      expect(isValidTransition('queued', 'ingesting')).toBe(true);
    });

    test('queued → completed is invalid (cannot skip ingesting)', () => {
      expect(isValidTransition('queued', 'completed')).toBe(false);
    });

    test('crawling → completed is invalid (must pass through ingesting)', () => {
      expect(isValidTransition('crawling', 'completed')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Dual completion path
  // -----------------------------------------------------------------------
  describe('dual completion path', () => {
    /**
     * Both the ingestion worker and the embedding worker can mark a job as
     * completed. In the database, this is guarded by an atomic update with
     * `{ status: { $ne: 'completed' } }` to prevent double-completion.
     *
     * The state machine allows ingesting → completed. The guard against
     * duplicate completion is a database-level concern, not a state machine
     * concern. This test documents the pattern.
     */
    test('ingesting → completed is the primary completion path', () => {
      expect(isValidTransition('ingesting', 'completed')).toBe(true);
    });

    test('indexing → completed is the secondary completion path (future)', () => {
      expect(isValidTransition('indexing', 'completed')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 9. The unused 'indexing' state
  // -----------------------------------------------------------------------
  describe('indexing state', () => {
    /**
     * The 'indexing' status exists in the ICrawlJob schema enum but no
     * current code transitions a job into the 'indexing' state. It is
     * reserved for a future phase where embedding/indexing becomes a
     * distinct pipeline stage separate from ingestion.
     *
     * Despite being unused, we still define valid transitions out of it
     * (indexing → completed, indexing → failed) so the state machine is
     * complete and ready for future use.
     */
    test('indexing → completed is valid (reserved for future)', () => {
      expect(isValidTransition('indexing', 'completed')).toBe(true);
    });

    test('indexing → failed is valid (reserved for future)', () => {
      expect(isValidTransition('indexing', 'failed')).toBe(true);
    });

    test('no current state transitions INTO indexing', () => {
      const statesThatCanReachIndexing = ALL_STATUSES.filter((s) =>
        isValidTransition(s, 'indexing'),
      );
      expect(statesThatCanReachIndexing).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // 10. processingErrors.phase values
  // -----------------------------------------------------------------------
  describe('processingErrors.phase values', () => {
    test('valid phases match the schema enum', () => {
      expect(VALID_PHASES).toEqual(['crawl', 'ingest', 'extract', 'embed', 'index']);
    });

    test('all valid phases are present', () => {
      expect(VALID_PHASES).toHaveLength(5);
    });

    /**
     * Known bug: the cancel handler in the codebase pushes a
     * processingError with phase: 'cancel', which is NOT in the schema
     * enum ['crawl', 'ingest', 'extract', 'embed', 'index'].
     *
     * Mongoose validation would reject this if strict validation were
     * enforced, but the current schema allows it through because the
     * error is pushed via $push without full document validation.
     */
    test('cancel is NOT a valid phase (known bug in cancel handler)', () => {
      const cancelPhase = 'cancel';
      const isValid = (VALID_PHASES as readonly string[]).includes(cancelPhase);
      expect(isValid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // 11. Exhaustiveness — every non-terminal state has at least one exit
  // -----------------------------------------------------------------------
  describe('state machine completeness', () => {
    test('every non-terminal state has at least one valid transition', () => {
      const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));
      for (const status of nonTerminal) {
        expect(VALID_TRANSITIONS[status].length).toBeGreaterThan(0);
      }
    });

    test('every non-terminal state can reach failed', () => {
      const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));
      for (const status of nonTerminal) {
        expect(VALID_TRANSITIONS[status]).toContain('failed');
      }
    });

    test('terminal states have no valid transitions', () => {
      for (const status of TERMINAL_STATUSES) {
        expect(VALID_TRANSITIONS[status]).toHaveLength(0);
      }
    });
  });
});
