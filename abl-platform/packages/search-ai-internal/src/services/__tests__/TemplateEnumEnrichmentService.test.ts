import { describe, test, expect } from 'vitest';
import { applyTemplateEnumPatterns } from '../TemplateEnumEnrichmentService.js';
import type { DiscoveredSchema, DiscoveredField } from '../SchemaDiscoveryService.js';

// --- Test Fixtures -----------------------------------------------------------

function makeField(name: string, type = 'string', enumValues?: string[]): DiscoveredField {
  return {
    name,
    type,
    path: `columns/${name}`,
    metadata: {
      description: `Test field: ${name}`,
      ...(enumValues ? { enumValues } : {}),
    },
  };
}

function makeSchema(fields: DiscoveredField[], connectorId = 'conn-001'): DiscoveredSchema {
  return {
    connectorId,
    tenantId: 'tenant-test',
    fields,
    discoveryMethod: 'hybrid',
    discoveredAt: new Date(),
    metadata: { connectorType: 'test' },
  };
}

// --- Basic Enrichment Tests --------------------------------------------------

describe('applyTemplateEnumPatterns', () => {
  describe('basic enrichment', () => {
    test('applies template enums to field with no existing enums', () => {
      const schema = makeSchema([makeField('status'), makeField('title')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      const statusField = result.fields.find((f) => f.name === 'status');
      expect(statusField!.metadata.enumValues).toBeDefined();
      expect(statusField!.metadata.enumValues!.length).toBeGreaterThan(0);
      expect(statusField!.metadata.enumSource).toBe('template');
    });

    test('template enums replace inferred enums (template priority)', () => {
      const schema = makeSchema([makeField('priority', 'string', ['p1', 'p2', 'p3'])]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      const priorityField = result.fields.find((f) => f.name === 'priority');
      expect(priorityField!.metadata.enumValues).toEqual([
        'critical',
        'high',
        'medium',
        'low',
        'trivial',
      ]);
      expect(priorityField!.metadata.enumSource).toBe('template');
    });

    test('preserves inferred enums when no template match', () => {
      const inferredEnums = ['alpha', 'beta', 'gamma'];
      const schema = makeSchema([makeField('custom_field', 'string', inferredEnums)]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      const customField = result.fields.find((f) => f.name === 'custom_field');
      expect(customField!.metadata.enumValues).toEqual(inferredEnums);
      expect(customField!.metadata.enumSource).toBe('inferred');
    });

    test('no change for field without enums and no template match', () => {
      const schema = makeSchema([makeField('title')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      const titleField = result.fields.find((f) => f.name === 'title');
      expect(titleField!.metadata.enumValues).toBeUndefined();
      expect(titleField!.metadata.enumSource).toBeUndefined();
    });
  });

  describe('display names', () => {
    test('populates enumDisplayNames from template', () => {
      const schema = makeSchema([makeField('priority')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      const priorityField = result.fields.find((f) => f.name === 'priority');
      expect(priorityField!.metadata.enumDisplayNames).toBeDefined();
      expect(priorityField!.metadata.enumDisplayNames!.critical).toBe('Critical');
      expect(priorityField!.metadata.enumDisplayNames!.low).toBe('Low');
    });

    test('mime_type display names for file_storage connector', () => {
      const schema = makeSchema([makeField('mime_type')]);
      const result = applyTemplateEnumPatterns(schema, 'google_drive');

      const mimeField = result.fields.find((f) => f.name === 'mime_type');
      expect(mimeField!.metadata.enumDisplayNames).toBeDefined();
      expect(mimeField!.metadata.enumDisplayNames!['application/pdf']).toBe('PDF Document');
      expect(mimeField!.metadata.enumDisplayNames!['image/jpeg']).toBe('JPEG Image');
    });
  });

  describe('enum source tracking', () => {
    test('template-applied fields have enumSource: template', () => {
      const schema = makeSchema([makeField('status')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumSource).toBe('template');
    });

    test('inferred-only fields get enumSource: inferred', () => {
      const schema = makeSchema([makeField('custom', 'string', ['a', 'b'])]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumSource).toBe('inferred');
    });

    test('fields without any enums have no enumSource', () => {
      const schema = makeSchema([makeField('title')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumSource).toBeUndefined();
    });
  });

  describe('matching strategies', () => {
    test('matches by exact field name (case-insensitive)', () => {
      const schema = makeSchema([makeField('Status')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumValues).toBeDefined();
      expect(result.fields[0].metadata.enumSource).toBe('template');
    });

    test('matches by exact field name lowercase', () => {
      const schema = makeSchema([makeField('severity')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumValues).toBeDefined();
      expect(result.fields[0].metadata.enumSource).toBe('template');
    });

    test('matches via fieldPatterns alias (state → status)', () => {
      // "state" is a fieldPattern alias for "status" in issue_ticket template
      const schema = makeSchema([makeField('state')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumValues).toBeDefined();
      expect(result.fields[0].metadata.enumSource).toBe('template');
      expect(result.fields[0].metadata.enumValues).toContain('open');
      expect(result.fields[0].metadata.enumValues).toContain('in_progress');
    });

    test('matches via fieldPatterns alias (urgency → priority)', () => {
      // "urgency" is a fieldPattern alias for "priority" in issue_ticket template
      const schema = makeSchema([makeField('urgency')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumValues).toBeDefined();
      expect(result.fields[0].metadata.enumSource).toBe('template');
      expect(result.fields[0].metadata.enumValues).toContain('critical');
      expect(result.fields[0].metadata.enumValues).toContain('trivial');
    });

    test('matches dotted path via fieldPatterns (fields.issue.impact → severity)', () => {
      // "impact" is a fieldPattern alias for "severity" in issue_ticket template
      const schema = makeSchema([makeField('fields.issue.impact')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumValues).toBeDefined();
      expect(result.fields[0].metadata.enumSource).toBe('template');
      expect(result.fields[0].metadata.enumValues).toContain('blocker');
    });
  });

  describe('immutability', () => {
    test('does not mutate input schema', () => {
      const originalField = makeField('status');
      const schema = makeSchema([originalField]);
      const originalEnums = schema.fields[0].metadata.enumValues;

      applyTemplateEnumPatterns(schema, 'jira');

      // Original schema unchanged
      expect(schema.fields[0].metadata.enumValues).toBe(originalEnums);
      expect(schema.fields[0].metadata.enumSource).toBeUndefined();
    });

    test('returns a new schema object', () => {
      const schema = makeSchema([makeField('status')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result).not.toBe(schema);
      expect(result.fields).not.toBe(schema.fields);
    });
  });

  describe('edge cases', () => {
    test('empty fields array returns schema unchanged', () => {
      const schema = makeSchema([]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields).toEqual([]);
    });

    test('unknown connector uses generic template', () => {
      const schema = makeSchema([makeField('status')]);
      const result = applyTemplateEnumPatterns(schema, 'totally_unknown');

      const statusField = result.fields[0];
      expect(statusField.metadata.enumValues).toBeDefined();
      expect(statusField.metadata.enumSource).toBe('template');
      // Generic template status values
      expect(statusField.metadata.enumValues).toContain('active');
    });

    test('preserves non-enum metadata fields', () => {
      const field = makeField('status');
      field.metadata.description = 'Custom description';
      field.metadata.required = true;
      field.metadata.format = 'custom-format';
      const schema = makeSchema([field]);

      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.description).toBe('Custom description');
      expect(result.fields[0].metadata.required).toBe(true);
      expect(result.fields[0].metadata.format).toBe('custom-format');
    });

    test('preserves discoveredAt as Date instance', () => {
      const schema = makeSchema([makeField('status')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.discoveredAt).toBeInstanceOf(Date);
    });

    test('preserves all schema-level metadata', () => {
      const schema = makeSchema([makeField('status')]);
      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.connectorId).toBe(schema.connectorId);
      expect(result.tenantId).toBe(schema.tenantId);
      expect(result.discoveryMethod).toBe(schema.discoveryMethod);
      expect(result.metadata).toEqual(schema.metadata);
    });
  });

  describe('multi-field enrichment', () => {
    test('enriches multiple fields in a single pass', () => {
      const schema = makeSchema([
        makeField('status'),
        makeField('priority'),
        makeField('severity'),
        makeField('title'), // no enum pattern
        makeField('custom', 'string', ['x', 'y']), // inferred only
      ]);

      const result = applyTemplateEnumPatterns(schema, 'jira');

      expect(result.fields[0].metadata.enumSource).toBe('template'); // status
      expect(result.fields[1].metadata.enumSource).toBe('template'); // priority
      expect(result.fields[2].metadata.enumSource).toBe('template'); // severity
      expect(result.fields[3].metadata.enumSource).toBeUndefined(); // title
      expect(result.fields[4].metadata.enumSource).toBe('inferred'); // custom
    });
  });

  describe('connector-specific templates', () => {
    test('google_drive gets file_storage mime_type enums', () => {
      const schema = makeSchema([makeField('mime_type')]);
      const result = applyTemplateEnumPatterns(schema, 'google_drive');

      expect(result.fields[0].metadata.enumValues).toContain('application/pdf');
      expect(result.fields[0].metadata.enumValues).toContain('image/jpeg');
    });

    test('servicenow gets incident_itsm priority enums', () => {
      const schema = makeSchema([makeField('priority')]);
      const result = applyTemplateEnumPatterns(schema, 'servicenow');

      expect(result.fields[0].metadata.enumValues).toContain('critical');
      expect(result.fields[0].metadata.enumValues).toContain('high');
    });

    test('salesforce gets crm_sales stage enums', () => {
      const schema = makeSchema([makeField('stage')]);
      const result = applyTemplateEnumPatterns(schema, 'salesforce');

      expect(result.fields[0].metadata.enumValues).toContain('prospecting');
      expect(result.fields[0].metadata.enumValues).toContain('closed_won');
    });

    test('slack gets communication status enums', () => {
      const schema = makeSchema([makeField('status')]);
      const result = applyTemplateEnumPatterns(schema, 'slack');

      expect(result.fields[0].metadata.enumValues).toContain('read');
      expect(result.fields[0].metadata.enumValues).toContain('unread');
    });
  });
});
