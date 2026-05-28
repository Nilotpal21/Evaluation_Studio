/**
 * Document Vocabulary Generator Tests
 *
 * Tests static vocabulary generation for document uploads.
 * NO LLM - tests deterministic logic only.
 */

import { describe, it, expect } from 'vitest';
import { generateDocumentVocabularyEntries } from '../document-vocabulary-generator.js';

describe('generateDocumentVocabularyEntries', () => {
  it('should return empty entries with no metadata', () => {
    const entries = generateDocumentVocabularyEntries({});

    expect(entries).toHaveLength(0);
  });

  it('should include only mime_type when only mime_type is passed', () => {
    const entries = generateDocumentVocabularyEntries({
      mime_type: 'application/pdf',
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].fieldRef).toBe('mime_type');
    expect(entries[0].generatedBy).toBe('static');
    expect(entries[0].aliases).toContain('file type');
  });

  it('should generate entries for core fields with rich aliases', () => {
    const metadata = {
      author: 'John Doe',
      department: 'Engineering',
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: author + department
    expect(entries).toHaveLength(2);

    const authorEntry = entries.find((e) => e.fieldRef === 'author');
    expect(authorEntry).toBeDefined();
    expect(authorEntry!.generatedBy).toBe('static');
    expect(authorEntry!.aliases).toContain('creator');
    expect(authorEntry!.aliases).toContain('written by');
    expect(authorEntry!.aliases).toContain('uploaded by');
    expect(authorEntry!.confidence).toBe(1.0);

    const deptEntry = entries.find((e) => e.fieldRef === 'department');
    expect(deptEntry).toBeDefined();
    expect(deptEntry!.generatedBy).toBe('static');
    expect(deptEntry!.aliases).toContain('team');
    expect(deptEntry!.aliases).toContain('division');
  });

  it('should generate basic entries for custom fields (no rich aliases)', () => {
    const metadata = {
      custom_string_1: 'Contract-2024-001',
      custom_number_1: 42,
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: custom_string_1 + custom_number_1
    expect(entries).toHaveLength(2);

    const customStringEntry = entries.find((e) => e.fieldRef === 'custom_string_1');
    expect(customStringEntry).toBeDefined();
    expect(customStringEntry!.generatedBy).toBe('auto');
    expect(customStringEntry!.term).toBe('custom string 1');
    expect(customStringEntry!.aliases).toEqual(['custom string 1']); // Basic entry, no synonyms
    expect(customStringEntry!.confidence).toBe(0.7); // Lower confidence

    const customNumberEntry = entries.find((e) => e.fieldRef === 'custom_number_1');
    expect(customNumberEntry).toBeDefined();
    expect(customNumberEntry!.generatedBy).toBe('auto');
    expect(customNumberEntry!.aliases).toEqual(['custom number 1']); // Basic entry
  });

  it('should mix core and custom fields correctly', () => {
    const metadata = {
      author: 'Jane Smith',
      category: 'Legal',
      custom_string_1: 'ID-123',
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: author + category + custom_string_1
    expect(entries).toHaveLength(3);

    // Core fields should have rich aliases
    const authorEntry = entries.find((e) => e.fieldRef === 'author');
    expect(authorEntry!.generatedBy).toBe('static');
    expect(authorEntry!.aliases.length).toBeGreaterThan(1);

    // Custom fields should have basic aliases only
    const customEntry = entries.find((e) => e.fieldRef === 'custom_string_1');
    expect(customEntry!.generatedBy).toBe('auto');
    expect(customEntry!.aliases).toHaveLength(1);
  });

  it('should skip empty string values', () => {
    const metadata = {
      author: 'John Doe',
      category: '', // Empty string - should skip
      tags: '   ', // Whitespace only - should skip
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: author only (category and tags skipped)
    expect(entries).toHaveLength(1);
    expect(entries.find((e) => e.fieldRef === 'category')).toBeUndefined();
    expect(entries.find((e) => e.fieldRef === 'tags')).toBeUndefined();
  });

  it('should skip empty arrays', () => {
    const metadata = {
      author: 'John Doe',
      tags: [], // Empty array - should skip
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: author only
    expect(entries).toHaveLength(1);
    expect(entries.find((e) => e.fieldRef === 'tags')).toBeUndefined();
  });

  it('should skip null and undefined values', () => {
    const metadata = {
      author: 'John Doe',
      category: null,
      department: undefined,
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: author only
    expect(entries).toHaveLength(1);
    expect(entries.find((e) => e.fieldRef === 'category')).toBeUndefined();
    expect(entries.find((e) => e.fieldRef === 'department')).toBeUndefined();
  });

  it('should skip internal/system fields', () => {
    const metadata = {
      author: 'John Doe',
      _id: '12345', // Internal field - should skip
      tenantId: 'tenant-123', // System field - should skip
      __proto__: 'danger', // Prototype pollution - should skip
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // Should have: author only
    expect(entries).toHaveLength(1);
    expect(entries.find((e) => e.fieldRef === '_id')).toBeUndefined();
    expect(entries.find((e) => e.fieldRef === 'tenantId')).toBeUndefined();
    expect(entries.find((e) => e.fieldRef === '__proto__')).toBeUndefined();
  });

  it('should generate human-readable labels for custom fields with underscores', () => {
    const metadata = {
      my_custom_field: 'value',
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    const customEntry = entries.find((e) => e.fieldRef === 'my_custom_field');
    expect(customEntry).toBeDefined();
    expect(customEntry!.term).toBe('my custom field');
    expect(customEntry!.description).toContain('My Custom Field');
  });

  it('should generate human-readable labels for custom fields with camelCase', () => {
    const metadata = {
      myCustomField: 'value',
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    const customEntry = entries.find((e) => e.fieldRef === 'myCustomField');
    expect(customEntry).toBeDefined();
    expect(customEntry!.term).toBe('my custom field');
  });

  it('should handle all 16 core fields correctly when all are passed', () => {
    const metadata = {
      mime_type: 'application/pdf',
      source_type: 'manual',
      author: 'John',
      category: 'Legal',
      tags: 'contract',
      department: 'Legal Ops',
      project: 'Q1-2024',
      status: 'Draft',
      priority: 'High',
      description: 'Important doc',
      modified_by: 'Jane',
      assignee: 'Bob',
      due_date: '2024-12-31',
      version: '1.0',
      access_level: 'Internal',
      language: 'en',
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    // All 16 core fields passed.
    expect(entries).toHaveLength(16);

    // All should be static with rich aliases
    entries.forEach((entry) => {
      expect(entry.generatedBy).toBe('static');
      expect(entry.confidence).toBe(1.0);
      expect(entry.aliases.length).toBeGreaterThan(1); // Rich aliases
    });
  });

  it('should set correct capabilities for all entries', () => {
    const metadata = {
      author: 'John',
      custom_string_1: 'value',
    };

    const entries = generateDocumentVocabularyEntries(metadata);

    entries.forEach((entry) => {
      expect(entry.capabilities).toEqual({
        canFilter: true,
        canDisplay: true,
        canAggregate: true,
        canSort: true,
      });
    });
  });

  it('should return unique entries (no duplicates)', () => {
    const metadata = {
      author: 'John',
    };

    const entries = generateDocumentVocabularyEntries(metadata);
    const fieldRefs = entries.map((e) => e.fieldRef);
    const uniqueFieldRefs = new Set(fieldRefs);

    expect(fieldRefs.length).toBe(uniqueFieldRefs.size);
  });
});
