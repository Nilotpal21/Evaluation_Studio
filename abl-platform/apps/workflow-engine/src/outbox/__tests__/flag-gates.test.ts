/**
 * UT-03 — Flag-gate predicate (16-combination matrix).
 *
 * `readFlags` is a pure function of a `NodeJS.ProcessEnv` shape — injecting
 * a fake env object (not touching `process.env`) keeps the test hermetic.
 * Matrix covers every 4-flag combination (2^4 = 16) to prove there is no
 * cross-contamination or default leakage between flags.
 */

import { describe, expect, it } from 'vitest';
import { readFlags, type WorkflowEventSourcingFlags } from '../flag-gates.js';

type FlagName =
  | 'WORKFLOW_OUTBOX_ENABLED'
  | 'WORKFLOW_CH_SINK_ENABLED'
  | 'WORKFLOW_DUAL_READ_ENABLED'
  | 'WORKFLOW_MONGO_TTL_ENABLED';

const FLAG_NAMES: FlagName[] = [
  'WORKFLOW_OUTBOX_ENABLED',
  'WORKFLOW_CH_SINK_ENABLED',
  'WORKFLOW_DUAL_READ_ENABLED',
  'WORKFLOW_MONGO_TTL_ENABLED',
];

function buildEnv(bits: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (let i = 0; i < FLAG_NAMES.length; i++) {
    // eslint-disable-next-line security/detect-object-injection
    env[FLAG_NAMES[i]!] = (bits >> i) & 1 ? 'true' : 'false';
  }
  return env;
}

function expected(bits: number): WorkflowEventSourcingFlags {
  return {
    outboxEnabled: ((bits >> 0) & 1) === 1,
    chSinkEnabled: ((bits >> 1) & 1) === 1,
    dualReadEnabled: ((bits >> 2) & 1) === 1,
    mongoTtlEnabled: ((bits >> 3) & 1) === 1,
  };
}

describe('readFlags — 16-combination matrix', () => {
  for (let bits = 0; bits < 16; bits++) {
    const label = bits.toString(2).padStart(4, '0');
    it(`returns correct tuple for bit pattern ${label}`, () => {
      expect(readFlags(buildEnv(bits))).toEqual(expected(bits));
    });
  }
});

describe('readFlags — default behavior', () => {
  it('returns all-false when every flag is absent', () => {
    expect(readFlags({})).toEqual({
      outboxEnabled: false,
      chSinkEnabled: false,
      dualReadEnabled: false,
      mongoTtlEnabled: false,
    });
  });

  it('only treats the exact string "true" as enabled (not "1", "yes", or "TRUE")', () => {
    expect(
      readFlags({
        WORKFLOW_OUTBOX_ENABLED: '1',
        WORKFLOW_CH_SINK_ENABLED: 'yes',
        WORKFLOW_DUAL_READ_ENABLED: 'TRUE',
        WORKFLOW_MONGO_TTL_ENABLED: 'true',
      }),
    ).toEqual({
      outboxEnabled: false,
      chSinkEnabled: false,
      dualReadEnabled: false,
      mongoTtlEnabled: true,
    });
  });
});
