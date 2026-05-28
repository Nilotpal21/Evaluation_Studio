import { describe, test, expect } from 'vitest';
import {
  CONNECTOR_TYPE_TEMPLATES,
  getTemplateForConnector,
  matchFieldByPattern,
} from '../connector-type-templates.js';

// --- Template Lookup Tests ---------------------------------------------------

describe('getTemplateForConnector', () => {
  test('returns issue_ticket for jira', () => {
    expect(getTemplateForConnector('jira').category).toBe('issue_ticket');
  });

  test('returns issue_ticket for linear', () => {
    expect(getTemplateForConnector('linear').category).toBe('issue_ticket');
  });

  test('returns file_storage for google_drive', () => {
    expect(getTemplateForConnector('google_drive').category).toBe('file_storage');
  });

  test('returns code_devops for github', () => {
    expect(getTemplateForConnector('github').category).toBe('code_devops');
  });

  test('returns communication for slack', () => {
    expect(getTemplateForConnector('slack').category).toBe('communication');
  });

  test('returns crm_sales for salesforce', () => {
    expect(getTemplateForConnector('salesforce').category).toBe('crm_sales');
  });

  test('returns incident_itsm for servicenow', () => {
    expect(getTemplateForConnector('servicenow').category).toBe('incident_itsm');
  });

  test('returns document_page for confluence', () => {
    expect(getTemplateForConnector('confluence').category).toBe('document_page');
  });

  test('returns generic for unknown connector', () => {
    expect(getTemplateForConnector('unknown_thing').category).toBe('generic');
  });

  test('is case-insensitive', () => {
    expect(getTemplateForConnector('JIRA').category).toBe('issue_ticket');
    expect(getTemplateForConnector('GitHub').category).toBe('code_devops');
  });
});

// --- matchFieldByPattern Tests -----------------------------------------------

describe('matchFieldByPattern', () => {
  const issueTemplate = CONNECTOR_TYPE_TEMPLATES.issue_ticket;

  test('matches exact source field name', () => {
    expect(matchFieldByPattern('summary', issueTemplate)).toBe('title');
    expect(matchFieldByPattern('status', issueTemplate)).toBe('status');
  });

  test('matches case-insensitively', () => {
    expect(matchFieldByPattern('Summary', issueTemplate)).toBe('title');
    expect(matchFieldByPattern('STATUS', issueTemplate)).toBe('status');
  });

  test('matches dotted path suffix', () => {
    expect(matchFieldByPattern('fields.assignee.displayName', issueTemplate)).toBe('assignee');
  });

  test('returns null for unknown field', () => {
    expect(matchFieldByPattern('totally_unknown_field', issueTemplate)).toBeNull();
  });
});

// --- Enum Pattern Structure Tests --------------------------------------------

describe('enum patterns', () => {
  const allTemplates = Object.values(CONNECTOR_TYPE_TEMPLATES);

  test('all 8 templates have enumPatterns defined', () => {
    for (const template of allTemplates) {
      expect(
        template.enumPatterns,
        `Template '${template.category}' should have enumPatterns`,
      ).toBeDefined();
      expect(
        Object.keys(template.enumPatterns!).length,
        `Template '${template.category}' should have at least one enum pattern`,
      ).toBeGreaterThan(0);
    }
  });

  test('all enum patterns have non-empty values arrays', () => {
    for (const template of allTemplates) {
      for (const [field, pattern] of Object.entries(template.enumPatterns!)) {
        expect(
          pattern.values.length,
          `${template.category}.${field} should have non-empty values`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test('displayNames keys are subset of values (no orphan display names)', () => {
    for (const template of allTemplates) {
      for (const [field, pattern] of Object.entries(template.enumPatterns!)) {
        if (pattern.displayNames) {
          for (const key of Object.keys(pattern.displayNames)) {
            expect(
              pattern.values,
              `${template.category}.${field} displayName '${key}' is not in values`,
            ).toContain(key);
          }
        }
      }
    }
  });

  test('issue_ticket has priority, status, severity, resolution', () => {
    const template = CONNECTOR_TYPE_TEMPLATES.issue_ticket;
    expect(template.enumPatterns).toHaveProperty('priority');
    expect(template.enumPatterns).toHaveProperty('status');
    expect(template.enumPatterns).toHaveProperty('severity');
    expect(template.enumPatterns).toHaveProperty('resolution');
  });

  test('file_storage has mime_type with display names', () => {
    const template = CONNECTOR_TYPE_TEMPLATES.file_storage;
    const mimePattern = template.enumPatterns!.mime_type;
    expect(mimePattern).toBeDefined();
    expect(mimePattern.values).toContain('application/pdf');
    expect(mimePattern.displayNames).toBeDefined();
    expect(mimePattern.displayNames!['application/pdf']).toBe('PDF Document');
    expect(mimePattern.displayNames!['image/jpeg']).toBe('JPEG Image');
  });

  test('generic has minimal status enum', () => {
    const template = CONNECTOR_TYPE_TEMPLATES.generic;
    expect(template.enumPatterns).toHaveProperty('status');
    expect(template.enumPatterns!.status.values.length).toBeGreaterThan(0);
  });

  test('specific enum values for issue_ticket priority', () => {
    const priority = CONNECTOR_TYPE_TEMPLATES.issue_ticket.enumPatterns!.priority;
    expect(priority.values).toEqual(['critical', 'high', 'medium', 'low', 'trivial']);
    expect(priority.displayNames).toBeDefined();
    expect(priority.displayNames!.critical).toBe('Critical');
    expect(priority.displayNames!.trivial).toBe('Trivial');
  });
});
