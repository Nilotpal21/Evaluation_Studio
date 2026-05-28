/**
 * Salesforce Schema Discovery Service
 *
 * Discovers field schema from Salesforce using DESCRIBE API.
 * Supports standard objects (Account, Lead, Opportunity) and custom objects.
 */

import axios from 'axios';
import type { IConnectorSchemaField } from '@agent-platform/database/models';
import { BaseSchemaDiscoveryService, type DiscoveryResult } from './base-discovery.service.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('salesforce-discovery');

export class SalesforceSchemaDiscoveryService extends BaseSchemaDiscoveryService {
  constructor() {
    super('salesforce');
  }

  async discover(
    connectorId: string,
    tenantId: string,
    credentials: Record<string, unknown>,
  ): Promise<DiscoveryResult> {
    const { instanceUrl, accessToken, objectType = 'Account' } = credentials;

    if (!instanceUrl || !accessToken) {
      throw new Error('Salesforce credentials incomplete: instanceUrl, accessToken required');
    }

    logger.info('Discovering Salesforce schema', { connectorId, tenantId, objectType });

    const response = await axios.get(
      `${instanceUrl}/services/data/v58.0/sobjects/${objectType}/describe`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30000,
      },
    );

    const fields: IConnectorSchemaField[] = response.data.fields.map((field: any) => ({
      path: field.name,
      label: field.label,
      type: this.mapSalesforceType(field.type),
      isCustom: field.custom || field.name.endsWith('__c'),
      isRequired: !field.nillable && !field.defaultedOnCreate,
      enumValues: field.picklistValues?.map((v: any) => v.value) || undefined,
      sampleValues: [],
      metadata: {
        relationshipName: field.relationshipName,
        referenceTo: field.referenceTo,
        length: field.length,
        precision: field.precision,
        scale: field.scale,
      },
    }));

    const customFieldCount = fields.filter((f) => f.isCustom).length;

    logger.info('Salesforce schema discovered', {
      connectorId,
      tenantId,
      objectType,
      fieldCount: fields.length,
      customFieldCount,
    });

    return {
      fields,
      fieldCount: fields.length,
      customFieldCount,
    };
  }

  private mapSalesforceType(sfType: string): string {
    const typeMap: Record<string, string> = {
      string: 'string',
      id: 'string',
      reference: 'string',
      picklist: 'string',
      multipicklist: 'array',
      textarea: 'string',
      phone: 'string',
      email: 'string',
      url: 'string',
      date: 'date',
      datetime: 'date',
      time: 'string',
      boolean: 'boolean',
      int: 'number',
      double: 'number',
      currency: 'number',
      percent: 'number',
    };
    return typeMap[sfType] || 'string';
  }
}
