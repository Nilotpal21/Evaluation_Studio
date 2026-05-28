import { describe, test, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import { ACTIVITY_TYPES } from '../pipeline/activity-metadata.js';
import {
  registerAnalyticsNodes,
  registerBuiltinNodes,
  inferCategory,
} from '../pipeline/register-nodes.js';
import type { NodeCategory } from '../pipeline/types.js';

describe('registerAnalyticsNodes', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  test('registers all existing activity types', () => {
    registerAnalyticsNodes(registry);

    const activityKeys = Object.keys(ACTIVITY_TYPES);
    for (const key of activityKeys) {
      expect(registry.has(key)).toBe(true);
    }
    // Total count matches ACTIVITY_TYPES
    const registeredCount = registry.list().length;
    expect(registeredCount).toBe(activityKeys.length);
  });

  test('infers correct categories', () => {
    registerAnalyticsNodes(registry);

    // compute-* -> compute
    expect(registry.get('compute-toxicity')!.category).toBe('compute');
    expect(registry.get('compute-quality')!.category).toBe('compute');
    expect(registry.get('compute-intent')!.category).toBe('compute');
    expect(registry.get('compute-sentiment')!.category).toBe('compute');
    expect(registry.get('compute-tool-effectiveness')!.category).toBe('compute');
    expect(registry.get('conversation-analyzer')!.category).toBe('compute');
    expect(registry.get('compute-statistical')!.category).toBe('compute');
    expect(registry.get('compute-predictive-features')!.category).toBe('compute');
    expect(registry.get('compute-mentions')!.category).toBe('compute');

    // evaluate-* -> compute
    expect(registry.get('evaluate-metrics')!.category).toBe('compute');
    expect(registry.get('evaluate-policy')!.category).toBe('compute');

    // llm-evaluate -> compute
    expect(registry.get('llm-evaluate')!.category).toBe('compute');

    // store-* -> action
    expect(registry.get('store-results')!.category).toBe('action');
    expect(registry.get('store-insight')!.category).toBe('action');

    // send-* -> action
    expect(registry.get('send-notification')!.category).toBe('action');

    // read-* -> data
    expect(registry.get('read-conversation')!.category).toBe('data');
    expect(registry.get('read-message-window')!.category).toBe('data');

    // transform -> data
    expect(registry.get('transform')!.category).toBe('data');

    // run-* -> action
    expect(registry.get('run-legacy-workflow')!.category).toBe('action');
    expect(registry.get('run-eval-conversation')!.category).toBe('compute');

    // eval pipeline compute types -> compute
    expect(registry.get('simulate-persona')!.category).toBe('compute');
    expect(registry.get('execute-agent-turn')!.category).toBe('compute');
    expect(registry.get('judge-conversation')!.category).toBe('compute');
    expect(registry.get('aggregate-eval-run')!.category).toBe('compute');
  });

  test('preserves activity metadata', () => {
    registerAnalyticsNodes(registry);

    // Check a representative node: compute-toxicity
    const toxicity = registry.get('compute-toxicity')!;
    expect(toxicity.type).toBe('compute-toxicity');
    expect(toxicity.label).toBe('Compute Toxicity');
    expect(toxicity.description).toBe(ACTIVITY_TYPES['compute-toxicity'].description);
    expect(toxicity.defaultTimeout).toBe(60_000);
    expect(toxicity.defaultRetries).toBe(2);
    expect(toxicity.executionModel).toBe('async');

    // configSchema fields should match activity configSchema properties
    const activityMeta = ACTIVITY_TYPES['compute-toxicity'];
    const propNames = Object.keys(activityMeta.configSchema.properties);
    const fieldNames = toxicity.configSchema.fields.map((f) => f.name);
    expect(fieldNames).toEqual(expect.arrayContaining(propNames));
    expect(fieldNames.length).toBe(propNames.length);

    // Required fields should be marked as required
    for (const field of toxicity.configSchema.fields) {
      if (activityMeta.configSchema.required.includes(field.name)) {
        expect(field.required).toBe(true);
      }
    }

    // Check a node with required fields: evaluate-metrics
    const evalMetrics = registry.get('evaluate-metrics')!;
    const metricsField = evalMetrics.configSchema.fields.find((f) => f.name === 'metrics');
    expect(metricsField).toBeDefined();
    expect(metricsField!.required).toBe(true);

    // outputSchema should be preserved
    expect(toxicity.outputSchema).toBeDefined();
    expect(toxicity.outputSchema!.properties).toHaveProperty('score');
  });
});

describe('registerBuiltinNodes', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  test('registers logic nodes', () => {
    registerBuiltinNodes(registry);

    // node-group
    const nodeGroup = registry.get('node-group')!;
    expect(nodeGroup).toBeDefined();
    expect(nodeGroup.category).toBe('logic');
    expect(nodeGroup.label).toBe('Parallel Group');
    expect(nodeGroup.executionModel).toBe('control-flow');
    expect(nodeGroup.configSchema.fields).toHaveLength(0);

    // wait-for-event
    const waitEvent = registry.get('wait-for-event')!;
    expect(waitEvent).toBeDefined();
    expect(waitEvent.category).toBe('logic');
    expect(waitEvent.label).toBe('Wait for Event');
    expect(waitEvent.executionModel).toBe('control-flow');
    const eventNameField = waitEvent.configSchema.fields.find((f) => f.name === 'eventName');
    expect(eventNameField).toBeDefined();
    expect(eventNameField!.required).toBe(true);
    expect(eventNameField!.type).toBe('string');
    const timeoutMsField = waitEvent.configSchema.fields.find((f) => f.name === 'timeoutMs');
    expect(timeoutMsField).toBeDefined();
    expect(timeoutMsField!.required).toBe(false);
    expect(timeoutMsField!.default).toBe(86400000);
    expect(timeoutMsField!.validation).toEqual({ min: 1000, max: 604800000 });
    const timeoutActionField = waitEvent.configSchema.fields.find(
      (f) => f.name === 'timeoutAction',
    );
    expect(timeoutActionField).toBeDefined();
    expect(timeoutActionField!.type).toBe('enum');
    expect(timeoutActionField!.values).toEqual(['fail', 'skip', 'default-value']);
    expect(timeoutActionField!.default).toBe('fail');

    // delay
    const delay = registry.get('delay')!;
    expect(delay).toBeDefined();
    expect(delay.category).toBe('logic');
    expect(delay.label).toBe('Delay');
    expect(delay.executionModel).toBe('control-flow');
    const durationField = delay.configSchema.fields.find((f) => f.name === 'durationMs');
    expect(durationField).toBeDefined();
    expect(durationField!.required).toBe(true);
    expect(durationField!.validation).toEqual({ min: 1000, max: 86400000 });

    // sub-pipeline
    const subPipeline = registry.get('sub-pipeline')!;
    expect(subPipeline).toBeDefined();
    expect(subPipeline.category).toBe('logic');
    expect(subPipeline.label).toBe('Sub-Pipeline');
    expect(subPipeline.executionModel).toBe('control-flow');
    const pipelineIdField = subPipeline.configSchema.fields.find((f) => f.name === 'pipelineId');
    expect(pipelineIdField).toBeDefined();
    expect(pipelineIdField!.required).toBe(true);
  });

  test('registers data nodes', () => {
    registerBuiltinNodes(registry);

    // db-query
    const dbQuery = registry.get('db-query')!;
    expect(dbQuery).toBeDefined();
    expect(dbQuery.category).toBe('data');
    expect(dbQuery.label).toBe('Database Query');
    expect(dbQuery.executionModel).toBe('sync');
    const dbField = dbQuery.configSchema.fields.find((f) => f.name === 'database');
    expect(dbField).toBeDefined();
    expect(dbField!.type).toBe('enum');
    expect(dbField!.values).toEqual(['clickhouse', 'mongodb']);
    const limitField = dbQuery.configSchema.fields.find((f) => f.name === 'limit');
    expect(limitField).toBeDefined();
    expect(limitField!.default).toBe(1000);
    expect(limitField!.validation).toEqual({ min: 1, max: 10000 });
    expect(dbQuery.requiredCapabilities).toEqual(['database-access']);

    // filter
    const filter = registry.get('filter')!;
    expect(filter).toBeDefined();
    expect(filter.category).toBe('data');
    expect(filter.label).toBe('Filter');
    expect(filter.executionModel).toBe('sync');
    expect(filter.configSchema.fields.find((f) => f.name === 'source')!.required).toBe(true);
    expect(filter.configSchema.fields.find((f) => f.name === 'expression')!.required).toBe(true);

    // aggregate
    const aggregate = registry.get('aggregate')!;
    expect(aggregate).toBeDefined();
    expect(aggregate.category).toBe('data');
    expect(aggregate.label).toBe('Aggregate');
    expect(aggregate.executionModel).toBe('sync');
    expect(aggregate.configSchema.fields.find((f) => f.name === 'operations')!.type).toBe('array');
  });

  test('registers integration nodes', () => {
    registerBuiltinNodes(registry);

    // http-request is now in ACTIVITY_TYPES and auto-registered by registerAnalyticsNodes,
    // not registerBuiltinNodes. Verify it is NOT in builtin-only registry.
    expect(registry.get('http-request')).toBeUndefined();

    // send-email
    const email = registry.get('send-email')!;
    expect(email).toBeDefined();
    expect(email.category).toBe('integration');
    expect(email.executionModel).toBe('async');
    expect(email.retryable).toBe(true);
    expect(email.defaultRetries).toBe(2);
    expect(email.requiredCapabilities).toEqual(['email-send']);

    // send-slack
    const slack = registry.get('send-slack')!;
    expect(slack).toBeDefined();
    expect(slack.category).toBe('integration');
    expect(slack.executionModel).toBe('async');
    expect(slack.retryable).toBe(true);
    expect(slack.defaultRetries).toBe(2);
    expect(slack.requiredCapabilities).toEqual(['slack-integration']);

    // publish-kafka
    const kafka = registry.get('publish-kafka')!;
    expect(kafka).toBeDefined();
    expect(kafka.category).toBe('integration');
    expect(kafka.executionModel).toBe('async');
    expect(kafka.retryable).toBe(true);
    expect(kafka.defaultRetries).toBe(3);
  });

  test('all builtin nodes have configSchema', () => {
    registerBuiltinNodes(registry);

    const builtins = registry.list();
    for (const node of builtins) {
      expect(node.configSchema).toBeDefined();
      expect(node.configSchema.fields).toBeInstanceOf(Array);
    }
  });
});

describe('full registry initialization', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
  });

  test('analytics + builtin do not conflict', () => {
    // Should not throw
    registerAnalyticsNodes(registry);
    registerBuiltinNodes(registry);
  });

  test('total count is correct', () => {
    registerAnalyticsNodes(registry);
    registerBuiltinNodes(registry);

    const analyticsCount = Object.keys(ACTIVITY_TYPES).length;
    // All 10 former builtin types (node-group, wait-for-event, delay, sub-pipeline, db-query,
    // filter, aggregate, send-email, send-slack, publish-kafka) are now in ACTIVITY_TYPES.
    // registerBuiltinNodes skips already-registered types, so total = analyticsCount.
    const total = registry.list().length;
    expect(total).toBe(analyticsCount);
  });

  test('http-request is registered via analytics nodes with integration category', () => {
    registerAnalyticsNodes(registry);

    const httpReq = registry.get('http-request');
    expect(httpReq).toBeDefined();
    expect(httpReq!.category).toBe('integration');
    expect(httpReq!.label).toBe('HTTP Request');
    expect(httpReq!.executionModel).toBe('async');
    expect(httpReq!.defaultTimeout).toBe(30_000);
    expect(httpReq!.defaultRetries).toBe(2);
  });
});

describe('inferCategory', () => {
  test('maps compute-* to compute', () => {
    expect(inferCategory('compute-toxicity')).toBe('compute');
    expect(inferCategory('compute-quality')).toBe('compute');
  });

  test('maps evaluate-* to compute', () => {
    expect(inferCategory('evaluate-metrics')).toBe('compute');
    expect(inferCategory('evaluate-policy')).toBe('compute');
  });

  test('maps call-* to compute', () => {
    expect(inferCategory('call-llm')).toBe('compute');
  });

  test('maps store-* to action', () => {
    expect(inferCategory('store-results')).toBe('action');
    expect(inferCategory('store-insight')).toBe('action');
  });

  test('maps send-* to action', () => {
    expect(inferCategory('send-notification')).toBe('action');
  });

  test('maps read-* to data', () => {
    expect(inferCategory('read-conversation')).toBe('data');
    expect(inferCategory('read-message-window')).toBe('data');
  });

  test('maps transform to data', () => {
    expect(inferCategory('transform')).toBe('data');
  });

  test('maps run-* to action', () => {
    expect(inferCategory('run-legacy-workflow')).toBe('action');
  });

  test('maps eval pipeline types to compute', () => {
    expect(inferCategory('simulate-persona')).toBe('compute');
    expect(inferCategory('execute-agent-turn')).toBe('compute');
    expect(inferCategory('run-eval-conversation')).toBe('compute');
    expect(inferCategory('judge-conversation')).toBe('compute');
    expect(inferCategory('aggregate-eval-run')).toBe('compute');
  });

  test('maps http-request to integration', () => {
    expect(inferCategory('http-request')).toBe('integration');
  });

  test('falls back to compute for unknown types', () => {
    expect(inferCategory('unknown-type')).toBe('compute');
  });
});
