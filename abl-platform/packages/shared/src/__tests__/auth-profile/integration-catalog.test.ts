/**
 * Integration Catalog Tests
 *
 * Verifies catalog shape, required fields, uniqueness, and deterministic ordering.
 */

import { describe, it, expect } from 'vitest';
import {
  INTEGRATION_CATALOG,
  getIntegrationCatalog,
} from '../../services/auth-profile/integration-catalog.js';

describe('INTEGRATION_CATALOG', () => {
  it('has at least 9 entries', () => {
    expect(INTEGRATION_CATALOG.length).toBeGreaterThanOrEqual(9);
  });

  it('every entry has required connector and displayName fields', () => {
    for (const entry of INTEGRATION_CATALOG) {
      expect(typeof entry.connector).toBe('string');
      expect(entry.connector.length).toBeGreaterThan(0);
      expect(typeof entry.displayName).toBe('string');
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });

  it('every entry has unique connector keys', () => {
    const connectors = INTEGRATION_CATALOG.map((e) => e.connector);
    const unique = new Set(connectors);
    expect(unique.size).toBe(connectors.length);
  });

  it('ordering is deterministic (alphabetical by connector)', () => {
    const connectors = INTEGRATION_CATALOG.map((e) => e.connector);
    const sorted = [...connectors].sort();
    expect(connectors).toEqual(sorted);
  });

  it('includes expected connectors', () => {
    const connectors = new Set(INTEGRATION_CATALOG.map((e) => e.connector));
    expect(connectors.has('salesforce')).toBe(true);
    expect(connectors.has('google')).toBe(true);
    expect(connectors.has('github')).toBe(true);
    expect(connectors.has('slack')).toBe(true);
    expect(connectors.has('hubspot')).toBe(true);
    expect(connectors.has('microsoft')).toBe(true);
    expect(connectors.has('zendesk')).toBe(true);
    expect(connectors.has('jira')).toBe(true);
    expect(connectors.has('servicenow')).toBe(true);
  });

  it('getIntegrationCatalog() returns the same catalog', () => {
    expect(getIntegrationCatalog()).toBe(INTEGRATION_CATALOG);
  });
});
