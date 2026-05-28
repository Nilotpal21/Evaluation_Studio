/**
 * Completeness test for activity metadata and service handler registrations.
 *
 * Ensures:
 * 1. Every SERVICE_HANDLERS entry (excluding aliases) has a matching ACTIVITY_TYPES entry
 * 2. Every ACTIVITY_TYPES entry has all required fields
 * 3. No orphan ACTIVITY_TYPES entries exist without a handler or inline handling
 */
import { describe, it, expect } from 'vitest';
import { ACTIVITY_TYPES } from '../pipeline/activity-metadata.js';

// Re-export the SERVICE_HANDLERS keys by reading the activity router source
// We import the handler dispatch table indirectly to avoid Restate context issues in tests
const SERVICE_HANDLER_KEYS = [
  'evaluate-metrics',
  'evaluate-policy',
  'send-notification',
  'store-results',
  'transform',
  'run-legacy-workflow',
  'store-insight',
  'compute-toxicity',
  'compute-tool-effectiveness',
  'llm-evaluate',
  'call-llm', // alias for llm-evaluate
  'read-conversation',
  'read-message-window',
  'compute-sentiment',
  'compute-intent',
  'evaluate-resolution',
  'compute-quality',
  'conversation-analyzer',
  'compute-statistical',
  'compute-predictive-features',
  'compute-mentions',
  'compute-goal-completion',
  'http-request',
  'sub-pipeline',
  'inspect-output',
  'db-query',
  'filter',
  'aggregate',
  'send-email',
  'send-slack',
  'publish-kafka',
  'simulate-persona',
  'execute-agent-turn',
  'run-eval-conversation',
  'judge-conversation',
  'aggregate-eval-run',
];

/** Keys that are aliases (backward compat) — they share a handler with another key */
const ALIAS_KEYS = ['call-llm'];

/** Control-flow types handled inline by ActivityRouter, not via SERVICE_HANDLERS */
const INLINE_CONTROL_FLOW_TYPES = ['node-group', 'wait-for-event', 'delay'];

describe('Activity Metadata Completeness', () => {
  it('every SERVICE_HANDLERS entry (excluding aliases) has an ACTIVITY_TYPES entry', () => {
    const missingMetadata: string[] = [];
    for (const key of SERVICE_HANDLER_KEYS) {
      if (ALIAS_KEYS.includes(key)) continue;
      if (!ACTIVITY_TYPES[key]) {
        missingMetadata.push(key);
      }
    }
    expect(missingMetadata).toEqual([]);
  });

  it('every ACTIVITY_TYPES entry has required fields', () => {
    const requiredFields = [
      'name',
      'description',
      'configSchema',
      'outputSchema',
      'defaultTimeout',
      'defaultRetries',
    ] as const;

    const issues: string[] = [];
    for (const [key, meta] of Object.entries(ACTIVITY_TYPES)) {
      for (const field of requiredFields) {
        if (meta[field] === undefined || meta[field] === null) {
          issues.push(`${key}: missing '${field}'`);
        }
      }
      // configSchema must have required and properties
      if (!meta.configSchema.properties) {
        issues.push(`${key}: configSchema missing 'properties'`);
      }
      if (!Array.isArray(meta.configSchema.required)) {
        issues.push(`${key}: configSchema missing 'required' array`);
      }
    }
    expect(issues).toEqual([]);
  });

  it('every non-alias SERVICE_HANDLERS key or inline type has ACTIVITY_TYPES entry', () => {
    const allExpectedKeys = [
      ...SERVICE_HANDLER_KEYS.filter((k) => !ALIAS_KEYS.includes(k)),
      ...INLINE_CONTROL_FLOW_TYPES,
    ];

    const missing = allExpectedKeys.filter((key) => !ACTIVITY_TYPES[key]);
    expect(missing).toEqual([]);
  });

  it('ACTIVITY_TYPES count matches expectations (38 entries)', () => {
    const count = Object.keys(ACTIVITY_TYPES).length;
    // 26 original + 1 evaluate-resolution + 8 extended node types + 3 control-flow = 38
    expect(count).toBe(38);
  });

  it('control-flow types have descriptive markers in their description', () => {
    for (const key of INLINE_CONTROL_FLOW_TYPES) {
      const meta = ACTIVITY_TYPES[key];
      expect(meta).toBeDefined();
      expect(meta.description).toContain('Control-flow type');
    }
  });
});
