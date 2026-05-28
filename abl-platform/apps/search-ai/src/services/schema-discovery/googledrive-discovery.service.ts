/**
 * Google Drive Schema Discovery Service
 *
 * Discovers schema by sampling documents and analyzing common metadata fields.
 * Drive doesn't have a formal schema API, so we infer from actual documents.
 */

import axios from 'axios';
import type { IConnectorSchemaField } from '@agent-platform/database/models';
import { BaseSchemaDiscoveryService, type DiscoveryResult } from './base-discovery.service.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('googledrive-discovery');

export class GoogleDriveSchemaDiscoveryService extends BaseSchemaDiscoveryService {
  constructor() {
    super('google_drive');
  }

  async discover(
    connectorId: string,
    tenantId: string,
    credentials: Record<string, unknown>,
  ): Promise<DiscoveryResult> {
    const { accessToken, sampleSize = 50 } = credentials;

    if (!accessToken) {
      throw new Error('Google Drive credentials incomplete: accessToken required');
    }

    logger.info('Discovering Google Drive schema', { connectorId, tenantId, sampleSize });

    // Fetch sample files
    const response = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        pageSize: sampleSize,
        fields:
          'files(id,name,mimeType,createdTime,modifiedTime,size,owners,permissions,parents,webViewLink)',
      },
      timeout: 30000,
    });

    const samples = response.data.files || [];

    if (samples.length === 0) {
      logger.warn('No sample files found for schema discovery', { connectorId, tenantId });
      return { fields: [], fieldCount: 0, customFieldCount: 0 };
    }

    // Calculate field frequencies
    const frequencies = this.calculateFieldFrequency(samples);

    // Build schema fields
    const fields: IConnectorSchemaField[] = [];

    for (const [path, frequency] of frequencies.entries()) {
      // Only include fields that appear in at least 50% of samples
      if (frequency < 0.5) {
        continue;
      }

      const sampleValues = this.collectSampleValues(samples, path, 5);
      const typeInfo = this.detectFieldType(sampleValues);

      fields.push({
        path,
        label: this.humanizeFieldName(path),
        type: typeInfo.type,
        isCustom: false, // All Drive fields are standard
        isRequired: frequency >= 0.9, // Consider required if present in 90%+ of samples
        sampleValues,
        metadata: {
          frequency,
          typeConfidence: typeInfo.confidence,
        },
      });
    }

    logger.info('Google Drive schema discovered', {
      connectorId,
      tenantId,
      fieldCount: fields.length,
      sampleCount: samples.length,
    });

    return {
      fields,
      fieldCount: fields.length,
      customFieldCount: 0, // Drive has no custom fields
    };
  }

  /**
   * Convert field path to human-readable label.
   * e.g., "modifiedTime" → "Modified Time"
   */
  private humanizeFieldName(path: string): string {
    return path
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (str) => str.toUpperCase())
      .trim();
  }
}
