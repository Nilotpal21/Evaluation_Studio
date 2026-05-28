import { describe, test, expect, beforeEach } from 'vitest';
import { NodeRegistry } from '../pipeline/node-registry.js';
import type { NodeTypeDefinitionDoc } from '../pipeline/types.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load seed data the same way the seed script does
const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(currentDir, '..');
const jsonPath = resolve(packageRoot, 'pipeline', 'seed-data', 'node-type-definitions.json');
const seedData: NodeTypeDefinitionDoc[] = JSON.parse(readFileSync(jsonPath, 'utf-8'));

describe('Config-driven full integration', () => {
  let registry: NodeRegistry;

  beforeEach(() => {
    registry = new NodeRegistry();
    registry.loadFromDocs(seedData);
  });

  test('registry has all 37 node types', () => {
    expect(registry.list()).toHaveLength(37);
  });

  test('compute nodes no longer have trait-merged sourceStep field', () => {
    const intent = registry.get('compute-intent')!;
    const fields = intent.configSchema.fields.map((f) => f.name);
    expect(fields).not.toContain('sourceStep');
    expect(fields).toContain('model');
    expect(fields).toContain('skipDirectWrite');
    // Original fields should also be there
    expect(fields).toContain('taxonomy');
  });

  test('llm+storage nodes get model and skipDirectWrite but not sourceStep', () => {
    const llmEval = registry.get('llm-evaluate')!;
    const fields = llmEval.configSchema.fields.map((f) => f.name);
    expect(fields).toContain('model');
    expect(fields).toContain('skipDirectWrite');
    expect(fields).not.toContain('sourceStep');
  });

  test('control-flow nodes have no trait fields', () => {
    const delay = registry.get('delay')!;
    const fields = delay.configSchema.fields.map((f) => f.name);
    expect(fields).not.toContain('sourceStep');
    expect(fields).not.toContain('model');
    expect(fields).not.toContain('skipDirectWrite');
    expect(fields).toContain('durationMs');
  });

  test('validateConfig works against DB-loaded types', () => {
    // compute-intent has no required fields (taxonomy is optional)
    const result = registry.validateConfig('compute-intent', {});
    expect(result.valid).toBe(true);

    // delay requires durationMs
    const delayResult = registry.validateConfig('delay', {});
    expect(delayResult.valid).toBe(false);
    expect(delayResult.errors[0]).toContain('durationMs');

    // evaluate-policy requires policyId
    const policyResult = registry.validateConfig('evaluate-policy', {});
    expect(policyResult.valid).toBe(false);
    expect(policyResult.errors[0]).toContain('policyId');
  });

  test('can filter by category', () => {
    const logic = registry.list({ category: 'logic' });
    expect(logic.length).toBe(4); // node-group, wait-for-event, delay, sub-pipeline
    for (const node of logic) {
      expect(node.category).toBe('logic');
    }
  });

  test('can filter by category: data', () => {
    const data = registry.list({ category: 'data' });
    // read-conversation, read-message-window, transform, store-results, db-query, filter, aggregate
    expect(data.length).toBe(7);
    for (const node of data) {
      expect(node.category).toBe('data');
    }
  });

  test('can filter by category: integration', () => {
    const integration = registry.list({ category: 'integration' });
    // http-request, send-email, send-slack, publish-kafka
    expect(integration.length).toBe(4);
  });

  test('can filter by category: action', () => {
    const action = registry.list({ category: 'action' });
    // store-results, store-insight, send-notification, run-legacy-workflow
    expect(action.length).toBe(4);
  });

  test('compute category has correct count', () => {
    const compute = registry.list({ category: 'compute' });
    // All compute-* + evaluate-* + llm-evaluate + eval pipeline types
    // compute-sentiment, compute-intent, compute-quality, compute-mentions,
    // conversation-analyzer, compute-toxicity, compute-tool-effectiveness,
    // compute-statistical, compute-predictive-features, compute-goal-completion = 10
    // evaluate-metrics, evaluate-policy = 2
    // llm-evaluate = 1
    // simulate-persona, execute-agent-turn, run-eval-conversation,
    // judge-conversation, aggregate-eval-run = 5
    // Total: 18
    expect(compute.length).toBe(18);
  });

  test('every node type has a label and description', () => {
    const all = registry.list();
    for (const node of all) {
      expect(node.label).toBeTruthy();
      expect(node.description).toBeTruthy();
    }
  });

  test('all configSchema fields have descriptions', () => {
    const all = registry.list();
    for (const node of all) {
      for (const field of node.configSchema.fields) {
        expect(field.description, `${node.type}.${field.name} missing description`).toBeTruthy();
      }
    }
  });
});
