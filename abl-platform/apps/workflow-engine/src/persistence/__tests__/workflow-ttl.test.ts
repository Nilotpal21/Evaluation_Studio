/**
 * workflow-ttl.ts helper unit tests (LLD §6.1 + §6.2).
 *
 * Covers the 4 gating dimensions:
 *   1. `WORKFLOW_MONGO_TTL_ENABLED` flag off ⇒ null (no TTL write path).
 *   2. Terminal vs non-terminal status.
 *   3. Mailbox guard on human tasks (workflow vs agent).
 *   4. Custom `WORKFLOW_MONGO_TTL_SECONDS` override.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeExecutionExpiresAt,
  computeHumanTaskExpiresAt,
  computeHumanTaskTerminalCandidate,
  WORKFLOW_TTL_DEFAULT_SECONDS,
} from '../workflow-ttl.js';

const originalFlag = process.env.WORKFLOW_MONGO_TTL_ENABLED;
const originalSeconds = process.env.WORKFLOW_MONGO_TTL_SECONDS;

beforeEach(() => {
  delete process.env.WORKFLOW_MONGO_TTL_ENABLED;
  delete process.env.WORKFLOW_MONGO_TTL_SECONDS;
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env.WORKFLOW_MONGO_TTL_ENABLED;
  else process.env.WORKFLOW_MONGO_TTL_ENABLED = originalFlag;
  if (originalSeconds === undefined) delete process.env.WORKFLOW_MONGO_TTL_SECONDS;
  else process.env.WORKFLOW_MONGO_TTL_SECONDS = originalSeconds;
});

describe('computeExecutionExpiresAt', () => {
  it('flag off: always returns null regardless of status', () => {
    expect(computeExecutionExpiresAt('completed')).toBeNull();
    expect(computeExecutionExpiresAt('failed')).toBeNull();
    expect(computeExecutionExpiresAt('running')).toBeNull();
  });

  it('flag on + terminal: returns now + 14 days by default', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    const now = new Date('2026-04-21T00:00:00Z');
    const expected = new Date(now.getTime() + WORKFLOW_TTL_DEFAULT_SECONDS * 1000);
    expect(computeExecutionExpiresAt('completed', now)?.toISOString()).toBe(expected.toISOString());
    expect(computeExecutionExpiresAt('failed', now)?.toISOString()).toBe(expected.toISOString());
    expect(computeExecutionExpiresAt('cancelled', now)?.toISOString()).toBe(expected.toISOString());
    expect(computeExecutionExpiresAt('rejected', now)?.toISOString()).toBe(expected.toISOString());
  });

  it('flag on + non-terminal: returns null', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    expect(computeExecutionExpiresAt('running')).toBeNull();
    expect(computeExecutionExpiresAt('waiting_human')).toBeNull();
    expect(computeExecutionExpiresAt('pending')).toBeNull();
  });

  it('honours WORKFLOW_MONGO_TTL_SECONDS override', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    process.env.WORKFLOW_MONGO_TTL_SECONDS = '60';
    const now = new Date('2026-04-21T00:00:00Z');
    const expected = new Date(now.getTime() + 60 * 1000);
    expect(computeExecutionExpiresAt('completed', now)?.toISOString()).toBe(expected.toISOString());
  });

  it('ignores malformed TTL seconds env (falls back to default)', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    process.env.WORKFLOW_MONGO_TTL_SECONDS = 'not-a-number';
    const now = new Date('2026-04-21T00:00:00Z');
    const expected = new Date(now.getTime() + WORKFLOW_TTL_DEFAULT_SECONDS * 1000);
    expect(computeExecutionExpiresAt('completed', now)?.toISOString()).toBe(expected.toISOString());
  });
});

describe('computeHumanTaskExpiresAt', () => {
  it('flag off: always returns null regardless of status/mailbox', () => {
    expect(computeHumanTaskExpiresAt('completed', 'workflow')).toBeNull();
  });

  it('flag on + workflow mailbox + terminal: returns future Date', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    const now = new Date('2026-04-21T00:00:00Z');
    expect(computeHumanTaskExpiresAt('completed', 'workflow', now)).not.toBeNull();
    expect(computeHumanTaskExpiresAt('expired', 'workflow', now)).not.toBeNull();
    expect(computeHumanTaskExpiresAt('cancelled', 'workflow', now)).not.toBeNull();
  });

  it('flag on + agent mailbox: returns null (scope guard)', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    expect(computeHumanTaskExpiresAt('completed', 'agent')).toBeNull();
    expect(computeHumanTaskExpiresAt('expired', 'agent')).toBeNull();
  });

  it('flag on + undefined mailbox: returns null', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    expect(computeHumanTaskExpiresAt('completed', undefined)).toBeNull();
  });

  it('flag on + workflow mailbox + non-terminal: returns null', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    expect(computeHumanTaskExpiresAt('pending', 'workflow')).toBeNull();
    expect(computeHumanTaskExpiresAt('in_progress', 'workflow')).toBeNull();
    expect(computeHumanTaskExpiresAt('assigned', 'workflow')).toBeNull();
  });
});

describe('computeHumanTaskTerminalCandidate (mailbox-agnostic)', () => {
  it('flag off: returns null even for terminal statuses', () => {
    expect(computeHumanTaskTerminalCandidate('completed')).toBeNull();
  });

  it('flag on + terminal: returns future Date regardless of mailbox', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    const now = new Date('2026-04-21T00:00:00Z');
    // Unlike computeHumanTaskExpiresAt, this helper does NOT check mailbox —
    // that's enforced downstream by the aggregation-pipeline $cond.
    expect(computeHumanTaskTerminalCandidate('completed', now)).not.toBeNull();
    expect(computeHumanTaskTerminalCandidate('cancelled', now)).not.toBeNull();
  });

  it('flag on + non-terminal: returns null', () => {
    process.env.WORKFLOW_MONGO_TTL_ENABLED = 'true';
    expect(computeHumanTaskTerminalCandidate('pending')).toBeNull();
    expect(computeHumanTaskTerminalCandidate('in_progress')).toBeNull();
  });
});
