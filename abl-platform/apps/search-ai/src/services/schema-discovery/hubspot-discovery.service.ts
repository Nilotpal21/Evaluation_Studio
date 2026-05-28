/**
 * HubSpot Schema Discovery Service
 *
 * Discovers field schema from HubSpot using Properties API.
 * Supports contacts, companies, deals, and tickets.
 */

import axios from 'axios';
import type { IConnectorSchemaField } from '@agent-platform/database/models';
import { BaseSchemaDiscoveryService, type DiscoveryResult } from './base-discovery.service.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('hubspot-discovery');

export class HubSpotSchemaDiscoveryService extends BaseSchemaDiscoveryService {
  constructor() {
    super('hubspot');
  }

  async discover(
    connectorId: string,
    tenantId: string,
    credentials: Record<string, unknown>,
  ): Promise<DiscoveryResult> {
    const { accessToken, objectType = 'contacts' } = credentials;

    if (!accessToken) {
      throw new Error('HubSpot credentials incomplete: accessToken required');
    }

    logger.info('Discovering HubSpot schema', { connectorId, tenantId, objectType });

    const response = await axios.get(`https://api.hubapi.com/crm/v3/properties/${objectType}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30000,
    });

    const fields: IConnectorSchemaField[] = response.data.results.map((prop: any) => ({
      path: prop.name,
      label: prop.label,
      type: this.mapHubSpotType(prop.type, prop.fieldType),
      isCustom: !prop.hubspotDefined,
      isRequired: false, // HubSpot doesn't expose required flag in properties API
      enumValues: prop.options?.map((o: any) => o.value) || undefined,
      sampleValues: [],
      metadata: {
        fieldType: prop.fieldType,
        groupName: prop.groupName,
        hubspotDefined: prop.hubspotDefined,
      },
    }));

    const customFieldCount = fields.filter((f) => f.isCustom).length;

    logger.info('HubSpot schema discovered', {
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

  private mapHubSpotType(type: string, fieldType?: string): string {
    const typeMap: Record<string, string> = {
      string: 'string',
      number: 'number',
      bool: 'boolean',
      date: 'date',
      datetime: 'date',
      enumeration: 'string',
      phone_number: 'string',
      object_coordinates: 'object',
    };
    return typeMap[type] || typeMap[fieldType || ''] || 'string';
  }
}
