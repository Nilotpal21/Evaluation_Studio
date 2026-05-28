import { describe, expect, it } from 'vitest';

import {
  buildStageOutputInstructions,
  getStageOutputSchemaDocument,
  validateStageOutputData,
} from '../pipeline/stage-output-schema.js';
import type { StageOutputSchemaId } from '../types.js';

describe('stage-output-schema', () => {
  it('requires every declared object property for Codex structured outputs', () => {
    const schemaIds: StageOutputSchemaId[] = [
      'analysis-report',
      'reproduction-report',
      'slice-plan',
      'plan-review',
      'impact-analysis',
      'oracle-review',
      'workspace-reconcile',
      'failure-advisory',
    ];

    for (const schemaId of schemaIds) {
      const schema = getStageOutputSchemaDocument({ id: schemaId });
      assertAllObjectPropertiesRequired(schema, schemaId);
    }
  });

  it('uses a valid null example for oracle severity instructions', () => {
    const instructions = buildStageOutputInstructions({ id: 'oracle-review' });

    expect(instructions).toContain('"severity": null');
    expect(instructions).toContain('"horizon": "immediate|next|near-term|long-term|null"');
    expect(instructions).not.toContain('critical|high|medium|low|info|null');
  });

  it('documents the required reproduction test file in reproduction instructions', () => {
    const instructions = buildStageOutputInstructions({ id: 'reproduction-report' });

    expect(instructions).toContain('"testFile": "path/to/regression.test.ts"');
    expect(instructions).toContain('exact regression test file you changed');
  });

  it('requires exact finding ids in slice-plan instructions', () => {
    const instructions = buildStageOutputInstructions({ id: 'slice-plan' });

    expect(instructions).toContain('"findings": ["existing-finding-id-1"]');
    expect(instructions).toContain('exact HELIX finding ID');
    expect(instructions).toContain('Do not use slugified titles');
  });

  it('documents per-slice assessments and safe backlog deferrals in plan-review instructions', () => {
    const instructions = buildStageOutputInstructions({ id: 'plan-review' });

    expect(instructions).toContain('"sliceAssessments"');
    expect(instructions).toContain('"deferredFindings"');
    expect(instructions).toContain('emit one sliceAssessments entry per slice');
    expect(instructions).toContain('safe to backlog');
  });

  it('documents ignore-vs-block decisions for workspace reconcile instructions', () => {
    const instructions = buildStageOutputInstructions({ id: 'workspace-reconcile' });

    expect(instructions).toContain('"disposition": "ignore|block"');
    expect(instructions).toContain('one assessment for EVERY out-of-scope file');
    expect(instructions).toContain('When in doubt, choose "block"');
  });

  it('documents retry-vs-pause decisions for failure advisory instructions', () => {
    const instructions = buildStageOutputInstructions({ id: 'failure-advisory' });

    expect(instructions).toContain(
      '"recommendedAction": "retry-stage|synthesize-stage|switch-model|continue-immediate-only|promote-stage|pause-and-resume"',
    );
    expect(instructions).toContain('Do not default to narrowing scope');
    expect(instructions).toContain('Emit at least one concrete operator action');
  });

  // ─── plan-c-with-divergence schema (2.C.4) ────────────────────

  it('registers plan-c-with-divergence as a valid JsonSchemaDocument', () => {
    const schema = getStageOutputSchemaDocument({ id: 'plan-c-with-divergence' });
    expect(schema).toBeDefined();
    expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema['$id']).toBe('helix.plan-c-with-divergence');
    expect(schema['type']).toBe('object');

    const props = schema['properties'] as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props['summary']).toBeDefined();
    expect(props['slices']).toBeDefined();
    expect(props['divergenceNotes']).toBeDefined();
    expect((props['divergenceNotes'] as Record<string, unknown>)['type']).toBe('string');
    expect((props['divergenceNotes'] as Record<string, unknown>)['minLength']).toBe(0);

    // required contains 'summary' and 'slices' (from slice-plan) but NOT 'divergenceNotes'
    const required = schema['required'] as string[];
    expect(required).toContain('summary');
    expect(required).toContain('slices');
    expect(required).not.toContain('divergenceNotes');
  });

  it('validates a well-formed plan-c-with-divergence sample', () => {
    const sample = {
      summary: 'Convergent plan combining both approaches.',
      slices: [
        {
          title: 'Extract shared seam',
          description: 'Move validation to shared boundary',
          findings: ['finding-001'],
          files: ['src/shared/validation.ts'],
          tests: ['src/shared/validation.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
      divergenceNotes: 'Plan A prefers extract-first; Plan B prefers inline.',
    };

    const result = validateStageOutputData({ id: 'plan-c-with-divergence', strict: true }, sample);
    expect(result).toEqual({ ok: true });
  });

  it('validates plan-c-with-divergence without divergenceNotes (optional)', () => {
    const sample = {
      summary: 'Plan with no divergence notes.',
      slices: [
        {
          title: 'Fix consumer route',
          description: 'Apply the fix directly',
          findings: ['finding-001'],
          files: ['src/routes/consumer.ts'],
          tests: ['src/routes/consumer.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    };

    const result = validateStageOutputData({ id: 'plan-c-with-divergence', strict: true }, sample);
    expect(result).toEqual({ ok: true });
  });

  it('rejects plan-c-with-divergence with extra properties (additionalProperties: false)', () => {
    const sample = {
      summary: 'Plan with extra prop.',
      slices: [
        {
          title: 'Fix route',
          description: 'Apply fix',
          findings: ['finding-001'],
          files: ['src/fix.ts'],
          tests: ['src/fix.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
      divergenceNotes: 'Some notes.',
      unexpectedField: 'should be rejected',
    };

    const result = validateStageOutputData({ id: 'plan-c-with-divergence', strict: true }, sample);
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects plan-c-with-divergence with empty summary (NON_EMPTY_STRING_SCHEMA)', () => {
    const sample = {
      summary: '',
      slices: [
        {
          title: 'Fix route',
          description: 'Apply fix',
          findings: ['finding-001'],
          files: ['src/fix.ts'],
          tests: ['src/fix.test.ts'],
          dependencies: [],
          legacyPaths: [],
        },
      ],
    };

    const result = validateStageOutputData({ id: 'plan-c-with-divergence', strict: true }, sample);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('generates output instructions for plan-c-with-divergence', () => {
    const instructions = buildStageOutputInstructions({ id: 'plan-c-with-divergence' });
    expect(instructions).toContain('convergent plan');
    expect(instructions).toContain('divergenceNotes');
  });

  it('accepts valid structured analysis output and rejects invalid enum values', () => {
    const valid = validateStageOutputData(
      { id: 'analysis-report' },
      {
        summary: 'Validated output',
        findings: [
          {
            severity: 'high',
            category: 'bug',
            title: 'Missing auth guard',
            description: 'The route never checks project membership.',
            files: ['apps/runtime/src/routes/project.ts'],
          },
        ],
        decisions: [
          {
            classification: 'DECIDED',
            question: 'Should the route require project permission?',
            context: null,
            answer: 'Yes',
          },
        ],
      },
    );
    const invalid = validateStageOutputData(
      { id: 'analysis-report' },
      {
        summary: 'Still invalid',
        findings: [
          {
            severity: 'severe',
            category: 'bug',
            title: 'Missing auth guard',
            description: 'The route never checks project membership.',
            files: ['apps/runtime/src/routes/project.ts'],
          },
        ],
        decisions: [],
      },
    );

    expect(valid).toEqual({ ok: true });
    expect(invalid).toMatchObject({ ok: false });
    if (!invalid.ok) {
      expect(invalid.errors).toEqual(
        expect.arrayContaining([expect.stringContaining('/findings/0/severity')]),
      );
    }
  });
});

function assertAllObjectPropertiesRequired(value: unknown, path: string): void {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }

  const schema = value as Record<string, unknown>;
  const properties = schema['properties'];
  const type = schema['type'];

  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    const propertyKeys = Object.keys(properties as Record<string, unknown>).sort();
    const required = Array.isArray(schema['required']) ? [...schema['required']] : [];
    const requiredKeys = required
      .filter((entry): entry is string => typeof entry === 'string')
      .sort();

    expect(requiredKeys, `${path} should require all declared properties`).toEqual(propertyKeys);

    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      assertAllObjectPropertiesRequired(child, `${path}.properties.${key}`);
    }
  }

  const items = schema['items'];
  if (items != null) {
    assertAllObjectPropertiesRequired(items, `${path}.items`);
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf)) {
    for (const [index, option] of anyOf.entries()) {
      assertAllObjectPropertiesRequired(option, `${path}.anyOf[${index}]`);
    }
  }

  if (Array.isArray(type) && !type.includes('object')) {
    return;
  }
}
