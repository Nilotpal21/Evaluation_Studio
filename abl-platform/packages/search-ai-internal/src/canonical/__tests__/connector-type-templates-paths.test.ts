/**
 * Connector Type Templates — Path Alignment Tests
 *
 * Verifies that SharePoint fixed mappings use dot-notation paths
 * (matching sourceMetadata.sharepoint.* structure) and not slash-delimited paths.
 */

import { describe, it, expect } from 'vitest';
import { getFixedMappings, CONNECTOR_TYPE_TEMPLATES } from '../connector-type-templates.js';

describe('SharePoint fixed mappings — path alignment', () => {
  it('should use dot-notation paths (not /)', () => {
    const mappings = getFixedMappings('sharepoint');

    for (const mapping of mappings) {
      expect(mapping.sourcePath).not.toContain('/');
    }
  });

  it('all sourcePaths should start with "sharepoint."', () => {
    const mappings = getFixedMappings('sharepoint');

    for (const mapping of mappings) {
      expect(mapping.sourcePath).toMatch(/^sharepoint\./);
    }
  });

  it('should return 11 fixed mappings for sharepoint', () => {
    const mappings = getFixedMappings('sharepoint');
    expect(mappings).toHaveLength(11);
  });

  it('each mapping path should be traversable with split(".") (no / characters)', () => {
    const mappings = getFixedMappings('sharepoint');

    for (const mapping of mappings) {
      const parts = mapping.sourcePath.split('.');
      expect(parts.length).toBeGreaterThanOrEqual(2);
      // No segment should contain a /
      for (const part of parts) {
        expect(part).not.toContain('/');
      }
    }
  });

  it('sharepoint_files should also use dot-notation paths', () => {
    const mappings = getFixedMappings('sharepoint_files');

    for (const mapping of mappings) {
      expect(mapping.sourcePath).not.toContain('/');
      expect(mapping.sourcePath).toMatch(/^sharepoint\./);
    }
  });

  it('sharepoint should be in file_storage category', () => {
    const template = CONNECTOR_TYPE_TEMPLATES.file_storage;
    expect(template.connectors).toContain('sharepoint');
    expect(template.connectors).toContain('sharepoint_files');
  });
});
