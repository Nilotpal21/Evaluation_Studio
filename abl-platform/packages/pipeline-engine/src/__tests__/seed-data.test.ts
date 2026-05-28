import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const seedData = JSON.parse(
  readFileSync(resolve(__dirname, '../pipeline/seed-data/node-type-definitions.json'), 'utf-8'),
) as any[];

describe('seed data: node-type-definitions.json', () => {
  test('contains exactly 37 node type definitions', () => {
    expect(seedData).toHaveLength(37);
  });

  test('all entries have required top-level fields', () => {
    for (const entry of seedData) {
      expect(entry._id).toBeTruthy();
      expect(entry.tenantId).toBe('SYSTEM');
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
      expect(['data', 'logic', 'integration', 'compute', 'action']).toContain(entry.category);
      expect(['sync', 'async', 'control-flow']).toContain(entry.executionModel);
      expect(typeof entry.defaultTimeout).toBe('number');
      expect(typeof entry.defaultRetries).toBe('number');
      expect(Array.isArray(entry.traits)).toBe(true);
      expect(Array.isArray(entry.configSchema)).toBe(true);
      expect(entry.version).toBe(1);
      expect(entry.isActive).toBe(true);
    }
  });

  test('no duplicate _id values', () => {
    const ids = (seedData as any[]).map((d) => d._id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all configSchema fields have label and description', () => {
    for (const entry of seedData as any[]) {
      for (const field of entry.configSchema) {
        expect(field.name, `${entry._id} has field without name`).toBeTruthy();
        expect(field.type, `${entry._id}.${field.name} missing type`).toBeTruthy();
        // `info` fields are non-interactive inline banners; they have no label by design.
        // Their help text is carried in `description`.
        if (field.type !== 'info') {
          expect(field.label, `${entry._id}.${field.name} missing label`).toBeTruthy();
        }
        expect(field.description, `${entry._id}.${field.name} missing description`).toBeTruthy();
      }
    }
  });

  test('compute-intent has taxonomy with itemSchema', () => {
    const intent = (seedData as any[]).find((d) => d._id === 'compute-intent');
    expect(intent).toBeDefined();
    const taxonomy = intent.configSchema.find((f: any) => f.name === 'taxonomy');
    expect(taxonomy).toBeDefined();
    expect(taxonomy.type).toBe('object[]');
    expect(taxonomy.itemSchema).toBeDefined();
    expect(taxonomy.itemSchema.length).toBeGreaterThan(0);
  });

  test('compute-mentions has companyName, competitors, mentionTypes', () => {
    const mentions = (seedData as any[]).find((d) => d._id === 'compute-mentions');
    expect(mentions).toBeDefined();
    const names = mentions.configSchema.map((f: any) => f.name);
    expect(names).toContain('companyName');
    expect(names).toContain('competitors');
    expect(names).toContain('mentionTypes');
  });

  test('compute-statistical has showWhen conditionals', () => {
    const stat = (seedData as any[]).find((d) => d._id === 'compute-statistical');
    expect(stat).toBeDefined();
    const metricTable = stat.configSchema.find((f: any) => f.name === 'metricTable');
    expect(metricTable).toBeDefined();
    expect(metricTable.showWhen).toBeDefined();
    expect(metricTable.showWhen.field).toBe('analysisType');
  });

  test('traits are valid values', () => {
    const validTraits = ['compute', 'llm', 'storage'];
    for (const entry of seedData as any[]) {
      for (const trait of entry.traits) {
        expect(validTraits).toContain(trait);
      }
    }
  });

  test('all 36 expected IDs are present', () => {
    const ids = new Set((seedData as any[]).map((d) => d._id));
    const expected = [
      'read-conversation',
      'read-message-window',
      'compute-sentiment',
      'compute-intent',
      'compute-quality',
      'compute-mentions',
      'conversation-analyzer',
      'compute-toxicity',
      'compute-tool-effectiveness',
      'compute-statistical',
      'compute-predictive-features',
      'evaluate-metrics',
      'evaluate-policy',
      'llm-evaluate',
      'store-results',
      'store-insight',
      'send-notification',
      'transform',
      'run-legacy-workflow',
      'http-request',
      'simulate-persona',
      'execute-agent-turn',
      'run-eval-conversation',
      'judge-conversation',
      'aggregate-eval-run',
      'node-group',
      'wait-for-event',
      'delay',
      'sub-pipeline',
      'db-query',
      'filter',
      'aggregate',
      'send-email',
      'send-slack',
      'publish-kafka',
      'compute-goal-completion',
    ];
    for (const id of expected) {
      expect(ids.has(id), `Missing node type: ${id}`).toBe(true);
    }
  });

  test('evaluate-policy has rules with itemSchema containing severity enum', () => {
    const policy = (seedData as any[]).find((d) => d._id === 'evaluate-policy');
    expect(policy).toBeDefined();
    const rules = policy.configSchema.find((f: any) => f.name === 'rules');
    expect(rules).toBeDefined();
    expect(rules.type).toBe('object[]');
    const severity = rules.itemSchema.find((f: any) => f.name === 'severity');
    expect(severity).toBeDefined();
    expect(severity.type).toBe('enum');
    expect(severity.values).toContain('critical');
  });

  test('db-query sessionId suggestion uses {{input.sessionId}}, not {{steps.trigger.output.sessionId}}', () => {
    // Regression guard: the pipeline template engine hoists the trigger
    // payload into context.input, NOT context.steps.trigger. A chip that
    // inserts {{steps.trigger.output.sessionId}} silently renders to "" at
    // runtime and the user sees an empty Session ID with no obvious cause.
    const dbQuery = (seedData as any[]).find((d) => d._id === 'db-query');
    expect(dbQuery).toBeDefined();
    const sessionField = dbQuery.configSchema.find((f: any) => f.name === 'sessionId');
    expect(sessionField).toBeDefined();
    expect(sessionField.suggestions).toBeDefined();
    expect(sessionField.suggestions.length).toBeGreaterThan(0);
    for (const s of sessionField.suggestions as Array<{ value: string }>) {
      expect(s.value).not.toContain('steps.trigger');
    }
    expect(sessionField.suggestions[0].value).toBe('{{input.sessionId}}');
  });
});
