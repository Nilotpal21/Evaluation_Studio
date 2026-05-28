import { describe, it, expect } from 'vitest';
import {
  getConnectorCategory,
  getCategoryLabel,
  CATEGORY_ORDER,
  type ConnectorCategory,
} from '../connector-categories';

describe('connector-categories', () => {
  it('maps known connectors to categories', () => {
    expect(getConnectorCategory('slack')).toBe('communication');
    expect(getConnectorCategory('google-sheets')).toBe('storage');
    expect(getConnectorCategory('hubspot')).toBe('crm');
    expect(getConnectorCategory('openai')).toBe('ai_dev');
    expect(getConnectorCategory('notion')).toBe('productivity');
    expect(getConnectorCategory('zendesk')).toBe('service_management');
    expect(getConnectorCategory('servicenow')).toBe('service_management');
  });

  it('returns "custom" for unknown connectors', () => {
    expect(getConnectorCategory('unknown-thing')).toBe('custom');
  });

  it('returns human-readable category labels', () => {
    expect(getCategoryLabel('communication')).toBe('Communication');
    expect(getCategoryLabel('crm')).toBe('CRM & Sales');
    expect(getCategoryLabel('ai_dev')).toBe('AI & Dev');
    expect(getCategoryLabel('service_management')).toBe('Service Management');
    expect(getCategoryLabel('custom')).toBe('Others');
  });

  it('CATEGORY_ORDER defines display order', () => {
    expect(CATEGORY_ORDER).toEqual([
      'communication',
      'productivity',
      'storage',
      'crm',
      'service_management',
      'ai_dev',
      'custom',
    ]);
  });
});
