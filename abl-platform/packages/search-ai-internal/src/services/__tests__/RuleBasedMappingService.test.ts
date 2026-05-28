import { describe, test, expect } from 'vitest';
import {
  generateMappings,
  normalizeFieldName,
  isTypeCompatible,
  matchField,
  type RuleBasedMappingResult,
  type RuleBasedMappingOptions,
} from '../RuleBasedMappingService.js';
import { getTemplateForConnector } from '../../canonical/index.js';
import type { IDiscoveredSchemaField } from '@agent-platform/database/models';

// ─── Test Fixtures ───────────────────────────────────────────────────────────

function makeField(
  name: string,
  type = 'string',
  overrides: Partial<IDiscoveredSchemaField> = {},
): IDiscoveredSchemaField {
  return {
    name,
    type,
    path: overrides.path ?? name,
    ...overrides,
  };
}

// ─── SharePoint fields (document_page / file_storage) ────────────────────────

const SHAREPOINT_FIELDS: IDiscoveredSchemaField[] = [
  makeField('title', 'string'),
  makeField('name', 'string'),
  makeField('creator', 'string'),
  makeField('author', 'string'),
  makeField('lastModified', 'date'),
  makeField('labels', 'array'),
  makeField('excerpt', 'string'),
  makeField('description', 'string'),
  makeField('space', 'string'),
  makeField('version', 'number'),
  makeField('parent', 'string', { path: 'parent.id' }),
  makeField('archived', 'boolean'),
  makeField('type', 'string'),
  makeField('comment_count', 'number'),
  makeField('url', 'string'),
  makeField('created_at', 'date'),
  makeField('status', 'string'),
  makeField('customField1', 'string'),
  makeField('customField2', 'number'),
  makeField('customField3', 'string'),
];

// ─── Jira fields (issue_ticket) ──────────────────────────────────────────────

const JIRA_FIELDS: IDiscoveredSchemaField[] = [
  makeField('summary', 'string'),
  makeField('status', 'string', {
    enumValues: ['To Do', 'In Progress', 'Done'],
  }),
  makeField('priority', 'string', {
    enumValues: ['Critical', 'High', 'Medium', 'Low'],
  }),
  makeField('assignee', 'string', { path: 'assignee.displayName' }),
  makeField('reporter', 'string', { path: 'reporter.displayName' }),
  makeField('issuetype', 'string', { path: 'issuetype.name' }),
  makeField('labels', 'array'),
  makeField('project', 'string', { path: 'project.key' }),
  makeField('sprint', 'string', { path: 'sprint.name' }),
  makeField('epic', 'string', { path: 'epic.name' }),
  makeField('story_points', 'number'),
  makeField('components', 'string'),
  makeField('severity', 'string'),
  makeField('resolution', 'string'),
  makeField('duedate', 'string'),
  makeField('resolutiondate', 'string'),
  makeField('description', 'string'),
  makeField('created', 'string'),
  makeField('updated', 'string'),
  makeField('customfield_10042', 'string'),
  makeField('customfield_10055', 'number'),
];

// ─── Google Sheets fields (generic) ──────────────────────────────────────────

const GOOGLE_SHEETS_FIELDS: IDiscoveredSchemaField[] = [
  makeField('title', 'string'),
  makeField('author', 'string'),
  makeField('created_at', 'date'),
  makeField('updated_at', 'date'),
  makeField('column_a', 'string'),
  makeField('column_b', 'number'),
  makeField('column_c', 'string'),
  makeField('column_d', 'boolean'),
  makeField('row_number', 'number'),
  makeField('sheet_name', 'string'),
];

// ─── normalizeFieldName ──────────────────────────────────────────────────────

describe('normalizeFieldName', () => {
  test('lowercases input', () => {
    expect(normalizeFieldName('CreatedAt')).toBe('createdat');
  });

  test('strips underscores', () => {
    expect(normalizeFieldName('created_at')).toBe('createdat');
  });

  test('strips hyphens', () => {
    expect(normalizeFieldName('created-at')).toBe('createdat');
  });

  test('strips dots', () => {
    expect(normalizeFieldName('status.name')).toBe('statusname');
  });

  test('collapses whitespace', () => {
    expect(normalizeFieldName('created at')).toBe('createdat');
  });

  test('handles mixed separators', () => {
    expect(normalizeFieldName('Last_Modified-Date')).toBe('lastmodifieddate');
  });
});

// ─── isTypeCompatible ────────────────────────────────────────────────────────

describe('isTypeCompatible', () => {
  test('exact match is compatible', () => {
    expect(isTypeCompatible('string', 'string')).toBe(true);
  });

  test('string → text is compatible', () => {
    expect(isTypeCompatible('string', 'text')).toBe(true);
  });

  test('number → float is compatible', () => {
    expect(isTypeCompatible('number', 'float')).toBe(true);
  });

  test('date → date is compatible', () => {
    expect(isTypeCompatible('date', 'date')).toBe(true);
  });

  test('boolean → boolean is compatible', () => {
    expect(isTypeCompatible('boolean', 'boolean')).toBe(true);
  });

  test('array → array is compatible', () => {
    expect(isTypeCompatible('array', 'array')).toBe(true);
  });

  test('boolean → string is incompatible', () => {
    expect(isTypeCompatible('boolean', 'string')).toBe(false);
  });

  test('array → string is incompatible', () => {
    expect(isTypeCompatible('array', 'string')).toBe(false);
  });

  test('date → string is compatible (date can be stored as string)', () => {
    expect(isTypeCompatible('date', 'string')).toBe(true);
  });

  test('unknown type → string is compatible', () => {
    expect(isTypeCompatible('unknown_type', 'string')).toBe(true);
  });
});

// ─── matchField ──────────────────────────────────────────────────────────────

describe('matchField', () => {
  const jiraTemplate = getTemplateForConnector('jira');

  test('exact match returns confidence 1.0', () => {
    const field = makeField('summary', 'string');
    const result = matchField(field, jiraTemplate);
    expect(result).not.toBeNull();
    expect(result!.canonicalField).toBe('title');
    expect(result!.matchType).toBe('exact');
    expect(result!.confidence).toBe(1.0);
  });

  test('normalized match returns confidence 0.9', () => {
    // "Summary" with different casing from pattern "summary" — case-insensitive match
    const field = makeField('Summary', 'string');
    const result = matchField(field, jiraTemplate);
    expect(result).not.toBeNull();
    expect(result!.canonicalField).toBe('title');
    expect(result!.matchType).toBe('normalized');
    expect(result!.confidence).toBe(0.9);
  });

  test('partial match returns confidence 0.8 for suffix match', () => {
    // "item_description" ends with "description" which is a template pattern
    const field = makeField('item_description', 'string');
    const result = matchField(field, jiraTemplate);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
    expect(result!.matchType).toBe('partial');
  });

  test('rejects overly broad partial match (substring containment)', () => {
    // "my_description_field" contains "description" but does NOT end with it
    // This should NOT match — too ambiguous, should go to LLM
    const field = makeField('my_description_field', 'string');
    const result = matchField(field, jiraTemplate);
    expect(result).toBeNull();
  });

  test('returns null for unmatched field', () => {
    const field = makeField('totally_unknown_xyz', 'string');
    const result = matchField(field, jiraTemplate);
    expect(result).toBeNull();
  });

  test('matches via path when name does not match', () => {
    const field = makeField('displayName', 'string', { path: 'assignee.displayName' });
    const result = matchField(field, jiraTemplate);
    expect(result).not.toBeNull();
    expect(result!.canonicalField).toBe('assignee');
  });
});

// ─── generateMappings ────────────────────────────────────────────────────────

describe('generateMappings', () => {
  describe('SharePoint fields (document_page)', () => {
    test('achieves >=70% coverage for SharePoint fields', () => {
      const results = generateMappings({
        fields: SHAREPOINT_FIELDS,
        connectorType: 'sharepoint_pages',
      });

      const coverage = results.length / SHAREPOINT_FIELDS.length;
      expect(coverage).toBeGreaterThanOrEqual(0.7);
    });

    test('maps title field correctly', () => {
      const results = generateMappings({
        fields: SHAREPOINT_FIELDS,
        connectorType: 'sharepoint_pages',
      });

      const titleMapping = results.find((r) => r.canonicalField === 'title');
      expect(titleMapping).toBeDefined();
      expect(titleMapping!.confidence).toBe(1.0);
    });
  });

  describe('Jira fields (issue_ticket)', () => {
    test('achieves >=70% coverage for Jira fields', () => {
      const results = generateMappings({
        fields: JIRA_FIELDS,
        connectorType: 'jira',
      });

      const coverage = results.length / JIRA_FIELDS.length;
      expect(coverage).toBeGreaterThanOrEqual(0.7);
    });

    test('maps summary to title with exact confidence', () => {
      const results = generateMappings({
        fields: JIRA_FIELDS,
        connectorType: 'jira',
      });

      const titleMapping = results.find((r) => r.canonicalField === 'title');
      expect(titleMapping).toBeDefined();
      expect(titleMapping!.sourcePath).toBe('summary');
      expect(titleMapping!.confidence).toBe(1.0);
    });

    test('maps status field with value_map transform when enums match', () => {
      const results = generateMappings({
        fields: JIRA_FIELDS,
        connectorType: 'jira',
      });

      const statusMapping = results.find((r) => r.canonicalField === 'status');
      expect(statusMapping).toBeDefined();
      expect(statusMapping!.transform.type).toBe('value_map');
      expect(statusMapping!.transform.valueMap).toBeDefined();
    });

    test('maps priority field with value_map transform', () => {
      const results = generateMappings({
        fields: JIRA_FIELDS,
        connectorType: 'jira',
      });

      const priorityMapping = results.find((r) => r.canonicalField === 'priority');
      expect(priorityMapping).toBeDefined();
      expect(priorityMapping!.transform.type).toBe('value_map');
      expect(priorityMapping!.transform.valueMap).toBeDefined();
      // "High" should map to "high", "Critical" to "critical" etc.
      expect(priorityMapping!.transform.valueMap!['High']).toBe('high');
      expect(priorityMapping!.transform.valueMap!['Critical']).toBe('critical');
    });
  });

  describe('Google Sheets (generic template)', () => {
    test('maps basic fields with lower coverage', () => {
      const results = generateMappings({
        fields: GOOGLE_SHEETS_FIELDS,
        connectorType: 'google_sheets',
      });

      // Should match at least title, author, created_at, updated_at
      expect(results.length).toBeGreaterThanOrEqual(4);

      // Coverage may be lower for generic connectors
      const coverage = results.length / GOOGLE_SHEETS_FIELDS.length;
      expect(coverage).toBeGreaterThanOrEqual(0.3);
    });
  });

  describe('confidence scoring', () => {
    test('exact match returns confidence 1.0', () => {
      const results = generateMappings({
        fields: [makeField('summary', 'string')],
        connectorType: 'jira',
      });

      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe(1.0);
    });

    test('normalized match returns confidence 0.9', () => {
      // "Summary" has different casing than pattern "summary"
      const results = generateMappings({
        fields: [makeField('Summary', 'string')],
        connectorType: 'jira',
      });

      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe(0.9);
    });

    test('partial match returns confidence 0.8 for suffix match', () => {
      // "item_description" ends with "description" — suffix match against template pattern
      const results = generateMappings({
        fields: [makeField('item_description', 'string')],
        connectorType: 'jira',
      });

      expect(results).toHaveLength(1);
      expect(results[0].confidence).toBe(0.8);
    });
  });

  describe('type compatibility', () => {
    test('skips mapping when types are incompatible', () => {
      // "summary" maps to "title" (string), but we pass it as boolean
      const results = generateMappings({
        fields: [makeField('summary', 'boolean')],
        connectorType: 'jira',
      });

      // boolean → string is incompatible, so should be skipped
      expect(results).toHaveLength(0);
    });

    test('allows compatible type mappings with penalty', () => {
      // story_points expects number, passing float which is compatible
      const results = generateMappings({
        fields: [makeField('story_points', 'float')],
        connectorType: 'jira',
      });

      expect(results).toHaveLength(1);
      // Exact name match (1.0) but float→number is not exact type, penalty applies
      // 1.0 - 0.1 = 0.9
      expect(results[0].confidence).toBe(0.9);
    });
  });

  describe('transform generation', () => {
    test('generates direct transform for simple string mapping', () => {
      const results = generateMappings({
        fields: [makeField('summary', 'string')],
        connectorType: 'jira',
      });

      expect(results[0].transform.type).toBe('direct');
    });

    test('generates value_map transform when enums match template', () => {
      const results = generateMappings({
        fields: [
          makeField('status', 'string', {
            enumValues: ['Open', 'In Progress', 'Closed'],
          }),
        ],
        connectorType: 'jira',
      });

      expect(results[0].transform.type).toBe('value_map');
      expect(results[0].transform.valueMap).toBeDefined();
      expect(results[0].transform.valueMap!['Open']).toBe('open');
    });

    test('generates parse_date transform for string→date mapping', () => {
      const results = generateMappings({
        fields: [makeField('duedate', 'string')],
        connectorType: 'jira',
      });

      const dueDateMapping = results.find((r) => r.canonicalField === 'due_date');
      expect(dueDateMapping).toBeDefined();
      expect(dueDateMapping!.transform.type).toBe('parse_date');
    });

    test('includes sourceFormat in parse_date when available', () => {
      const results = generateMappings({
        fields: [makeField('duedate', 'string', { format: 'ISO8601' })],
        connectorType: 'jira',
      });

      const dueDateMapping = results.find((r) => r.canonicalField === 'due_date');
      expect(dueDateMapping).toBeDefined();
      expect(dueDateMapping!.transform.type).toBe('parse_date');
      expect(dueDateMapping!.transform.sourceFormat).toBe('ISO8601');
    });
  });

  describe('de-duplication', () => {
    test('keeps highest confidence when multiple fields match same canonical', () => {
      // Both "summary" and "task_name" can match "title"
      const results = generateMappings({
        fields: [makeField('summary', 'string'), makeField('task_name', 'string')],
        connectorType: 'jira',
      });

      const titleMappings = results.filter((r) => r.canonicalField === 'title');
      expect(titleMappings).toHaveLength(1);
      // "summary" is exact match (1.0), "task_name" is partial (0.8) — summary wins
      expect(titleMappings[0].sourcePath).toBe('summary');
      expect(titleMappings[0].confidence).toBe(1.0);
    });
  });

  describe('edge cases', () => {
    test('returns empty array for empty fields', () => {
      const results = generateMappings({
        fields: [],
        connectorType: 'jira',
      });
      expect(results).toEqual([]);
    });

    test('uses generic template for unknown connector type', () => {
      const results = generateMappings({
        fields: [makeField('title', 'string'), makeField('status', 'string')],
        connectorType: 'some_unknown_connector',
      });

      // Should still match via generic template
      expect(results.length).toBeGreaterThanOrEqual(1);
      const titleMapping = results.find((r) => r.canonicalField === 'title');
      expect(titleMapping).toBeDefined();
    });
  });

  describe('output format compatibility', () => {
    test('results have all MappingSuggestion-compatible fields', () => {
      const results = generateMappings({
        fields: [makeField('summary', 'string')],
        connectorType: 'jira',
      });

      expect(results).toHaveLength(1);
      const result = results[0];

      // Required MappingSuggestion fields
      expect(result).toHaveProperty('canonicalField');
      expect(result).toHaveProperty('sourcePath');
      expect(result).toHaveProperty('transform');
      expect(result).toHaveProperty('transform.type');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('reasoning');

      // Optional MappingSuggestion fields
      expect(result).toHaveProperty('suggestedAlias');
      expect(result).toHaveProperty('suggestedLabel');

      // Our addition
      expect(result).toHaveProperty('mappingSource');
      expect(result.mappingSource).toBe('rule-based');
    });

    test('suggestedAlias is humanized canonical field name', () => {
      const results = generateMappings({
        fields: [makeField('created', 'string')],
        connectorType: 'jira',
      });

      // "created" should match something like created_at or created_date
      expect(results).toHaveLength(1);
      // Alias should be humanized (e.g., "Created At" or similar)
      expect(results[0].suggestedAlias).toBeDefined();
      expect(typeof results[0].suggestedAlias).toBe('string');
      // First character should be uppercase
      expect(results[0].suggestedAlias![0]).toMatch(/[A-Z]/);
    });

    test('reasoning includes match type and template info', () => {
      const results = generateMappings({
        fields: [makeField('summary', 'string')],
        connectorType: 'jira',
      });

      expect(results[0].reasoning).toContain('Rule-based');
      expect(results[0].reasoning).toContain('exact');
      expect(results[0].reasoning).toContain('Issue / Ticket Tracker');
    });
  });

  describe('fixed mappings', () => {
    test('SharePoint DriveItem fields use fixed mappings with confidence 1.0', () => {
      const fields = [
        makeField('itemName', 'string', { path: 'sharepoint.itemName' }),
        makeField('createdBy', 'string', { path: 'sharepoint.createdBy' }),
        makeField('lastModifiedBy', 'string', { path: 'sharepoint.lastModifiedBy' }),
        makeField('createdDateTime', 'date', { path: 'sharepoint.createdDateTime' }),
        makeField('lastModifiedDateTime', 'date', { path: 'sharepoint.lastModifiedDateTime' }),
        makeField('itemWebUrl', 'string', { path: 'sharepoint.itemWebUrl' }),
        makeField('mimeType', 'string', { path: 'sharepoint.mimeType' }),
        makeField('parentPath', 'string', { path: 'sharepoint.parentPath' }),
        makeField('siteId', 'string', { path: 'sharepoint.siteId' }),
        makeField('driveId', 'string', { path: 'sharepoint.driveId' }),
        makeField('size', 'number', { path: 'sharepoint.size' }),
      ];

      const results = generateMappings({ fields, connectorType: 'sharepoint' });

      // All 11 fields should have fixed mappings
      expect(results).toHaveLength(11);

      const byCanonical = new Map(results.map((r) => [r.canonicalField, r]));
      expect(byCanonical.get('title')?.confidence).toBe(1.0);
      expect(byCanonical.get('title')?.sourcePath).toBe('sharepoint.itemName');
      expect(byCanonical.get('author')?.confidence).toBe(1.0);
      expect(byCanonical.get('modified_by')?.confidence).toBe(1.0);
      expect(byCanonical.get('modified_by')?.sourcePath).toBe('sharepoint.lastModifiedBy');
      expect(byCanonical.get('created_date')?.confidence).toBe(1.0);
      expect(byCanonical.get('modified_date')?.confidence).toBe(1.0);
      expect(byCanonical.get('source_url')?.confidence).toBe(1.0);
      expect(byCanonical.get('mime_type')?.confidence).toBe(1.0);
      expect(byCanonical.get('parent_id')?.confidence).toBe(1.0);
      expect(byCanonical.get('department')?.confidence).toBe(1.0);
      expect(byCanonical.get('project')?.confidence).toBe(1.0);
      expect(byCanonical.get('attachment_count')?.confidence).toBe(1.0);
    });

    test('fixed mappings prevent incorrect rule-based matches', () => {
      // lastModifiedBy has a fixed mapping to modified_by, NOT modified_date
      const fields = [
        makeField('itemName', 'string', { path: 'sharepoint.itemName' }),
        makeField('lastModifiedBy', 'string', { path: 'sharepoint.lastModifiedBy' }),
      ];

      const results = generateMappings({ fields, connectorType: 'sharepoint' });

      const modifiedByMapping = results.find((r) => r.canonicalField === 'modified_by');
      expect(modifiedByMapping).toBeDefined();
      expect(modifiedByMapping?.confidence).toBe(1.0);

      // Should NOT produce a modified_date mapping from a person field
      const modifiedDateMapping = results.find((r) => r.canonicalField === 'modified_date');
      expect(modifiedDateMapping).toBeUndefined();
    });

    test('connector without fixed mappings uses only rule engine', () => {
      const results = generateMappings({
        fields: [makeField('Summary', 'string')],
        connectorType: 'jira',
      });

      // Jira has no fixed mappings — matches via rule engine (normalized, not exact)
      expect(results).toHaveLength(1);
      expect(results[0].canonicalField).toBe('title');
      expect(results[0].confidence).toBe(0.9); // Normalized match, not fixed
    });
  });
});
