/**
 * Jira Schema Discovery Service
 *
 * Discovers field schema from Jira by calling GET /rest/api/3/field.
 * Parses system fields (summary, status, assignee) and custom fields (customfield_*).
 */

import axios from 'axios';
import type { IConnectorSchemaField } from '@agent-platform/database/models';
import { BaseSchemaDiscoveryService, type DiscoveryResult } from './base-discovery.service.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('jira-discovery');

// ─── Types ───────────────────────────────────────────────────────────────────

interface JiraFieldSchema {
  id: string;
  name: string;
  custom: boolean;
  schema?: {
    type: string;
    system?: string;
    custom?: string;
    items?: string;
  };
  orderable?: boolean;
  searchable?: boolean;
}

// ─── Jira Discovery Service ──────────────────────────────────────────────────

export class JiraSchemaDiscoveryService extends BaseSchemaDiscoveryService {
  constructor() {
    super('jira');
  }

  /**
   * Discover Jira field schema.
   *
   * @param connectorId - Connector ID
   * @param tenantId - Tenant ID
   * @param credentials - Jira credentials { baseUrl, email, apiToken }
   * @returns Discovered fields
   */
  async discover(
    connectorId: string,
    tenantId: string,
    credentials: Record<string, unknown>,
  ): Promise<DiscoveryResult> {
    const { baseUrl, email, apiToken } = credentials;

    if (!baseUrl || !email || !apiToken) {
      throw new Error('Jira credentials incomplete: baseUrl, email, apiToken required');
    }

    logger.info('Discovering Jira schema', { connectorId, tenantId, baseUrl });

    // Call Jira API to get all fields
    const response = await axios.get<JiraFieldSchema[]>(`${baseUrl}/rest/api/3/field`, {
      auth: {
        username: email as string,
        password: apiToken as string,
      },
      timeout: 30000,
    });

    const jiraFields = response.data;
    const fields: IConnectorSchemaField[] = [];
    let customFieldCount = 0;

    for (const jiraField of jiraFields) {
      const field = this.mapJiraField(jiraField);
      fields.push(field);

      if (field.isCustom) {
        customFieldCount++;
      }
    }

    logger.info('Jira schema discovered', {
      connectorId,
      tenantId,
      fieldCount: fields.length,
      customFieldCount,
    });

    return {
      fields,
      fieldCount: fields.length,
      customFieldCount,
    };
  }

  // ─── Helper Methods ──────────────────────────────────────────────────────

  /**
   * Map Jira field to connector schema field.
   *
   * @param jiraField - Jira field metadata
   * @returns Connector schema field
   */
  private mapJiraField(jiraField: JiraFieldSchema): IConnectorSchemaField {
    const isCustom = jiraField.custom || jiraField.id.startsWith('customfield_');
    const type = this.mapJiraType(jiraField.schema?.type);

    return {
      path: jiraField.id,
      label: jiraField.name,
      type,
      isCustom,
      isRequired: false, // Jira doesn't expose required flag in field list API
      sampleValues: [], // Would require fetching actual issues
      metadata: {
        orderable: jiraField.orderable,
        searchable: jiraField.searchable,
        jiraType: jiraField.schema?.type,
        system: jiraField.schema?.system,
        customType: jiraField.schema?.custom,
      },
    };
  }

  /**
   * Map Jira field type to canonical type.
   *
   * @param jiraType - Jira field type
   * @returns Canonical type
   */
  private mapJiraType(jiraType?: string): string {
    if (!jiraType) {
      return 'unknown';
    }

    const typeMap: Record<string, string> = {
      string: 'string',
      number: 'number',
      datetime: 'date',
      date: 'date',
      array: 'array',
      user: 'object',
      option: 'string',
      priority: 'string',
      issuetype: 'string',
      project: 'object',
      status: 'string',
      resolution: 'string',
    };

    return typeMap[jiraType] || 'string';
  }
}
