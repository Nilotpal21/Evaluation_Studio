import { describe, expect, test } from 'vitest';
import {
  auditKafkaSubscriptions,
  buildKafkaSubscriptionSources,
  summarizeStartupProbes,
} from '../pipeline/startup-diagnostics.js';

describe('buildKafkaSubscriptionSources', () => {
  test('maps Kafka topics to Restate subscription URIs', () => {
    expect(buildKafkaSubscriptionSources(['abl.message.user', 'abl.message.agent'])).toEqual([
      'kafka://local/abl.message.user',
      'kafka://local/abl.message.agent',
    ]);
  });
});

describe('auditKafkaSubscriptions', () => {
  test('reports missing expected subscriptions', () => {
    const expectedSources = buildKafkaSubscriptionSources([
      'abl.session.created',
      'abl.session.ended',
      'abl.message.user',
    ]);

    expect(
      auditKafkaSubscriptions(expectedSources, [
        'kafka://local/abl.message.user',
        'kafka://local/abl.session.created',
      ]),
    ).toEqual({
      expectedSources: [
        'kafka://local/abl.message.user',
        'kafka://local/abl.session.created',
        'kafka://local/abl.session.ended',
      ],
      existingSources: ['kafka://local/abl.message.user', 'kafka://local/abl.session.created'],
      missingSources: ['kafka://local/abl.session.ended'],
      totalExpected: 3,
      totalExisting: 2,
      isComplete: false,
    });
  });

  test('deduplicates existing subscriptions before auditing completeness', () => {
    const expectedSources = buildKafkaSubscriptionSources(['abl.session.created']);

    expect(
      auditKafkaSubscriptions(expectedSources, [
        'kafka://local/abl.session.created',
        'kafka://local/abl.session.created',
      ]),
    ).toEqual({
      expectedSources: ['kafka://local/abl.session.created'],
      existingSources: ['kafka://local/abl.session.created'],
      missingSources: [],
      totalExpected: 1,
      totalExisting: 1,
      isComplete: true,
    });
  });
});

describe('summarizeStartupProbes', () => {
  test('returns pass when every dependency passes', () => {
    expect(
      summarizeStartupProbes([
        { dependency: 'mongodb', status: 'pass', detail: 'connected' },
        { dependency: 'clickhouse', status: 'pass', detail: 'initialized' },
      ]),
    ).toEqual({
      overall: 'pass',
      failingDependencies: [],
      warningDependencies: [],
      checks: [
        { dependency: 'mongodb', status: 'pass', detail: 'connected' },
        { dependency: 'clickhouse', status: 'pass', detail: 'initialized' },
      ],
    });
  });

  test('returns warn when dependencies degrade but do not fail startup', () => {
    expect(
      summarizeStartupProbes([
        { dependency: 'mongodb', status: 'pass', detail: 'connected' },
        { dependency: 'redis_definition_cache', status: 'warn', detail: 'disabled fail-open' },
      ]),
    ).toEqual({
      overall: 'warn',
      failingDependencies: [],
      warningDependencies: ['redis_definition_cache'],
      checks: [
        { dependency: 'mongodb', status: 'pass', detail: 'connected' },
        { dependency: 'redis_definition_cache', status: 'warn', detail: 'disabled fail-open' },
      ],
    });
  });

  test('returns fail when any dependency fails', () => {
    expect(
      summarizeStartupProbes([
        { dependency: 'mongodb', status: 'pass', detail: 'connected' },
        { dependency: 'restate_admin_registration', status: 'fail', detail: 'admin unreachable' },
        { dependency: 'redis_definition_cache', status: 'warn', detail: 'disabled fail-open' },
      ]),
    ).toEqual({
      overall: 'fail',
      failingDependencies: ['restate_admin_registration'],
      warningDependencies: ['redis_definition_cache'],
      checks: [
        { dependency: 'mongodb', status: 'pass', detail: 'connected' },
        { dependency: 'restate_admin_registration', status: 'fail', detail: 'admin unreachable' },
        { dependency: 'redis_definition_cache', status: 'warn', detail: 'disabled fail-open' },
      ],
    });
  });
});
