/**
 * Schema Discovery Services
 *
 * Exports all connector-specific schema discovery services.
 */

import { BaseSchemaDiscoveryService } from './base-discovery.service.js';

export { BaseSchemaDiscoveryService, type DiscoveryResult } from './base-discovery.service.js';
export { JiraSchemaDiscoveryService } from './jira-discovery.service.js';
export { SalesforceSchemaDiscoveryService } from './salesforce-discovery.service.js';
export { HubSpotSchemaDiscoveryService } from './hubspot-discovery.service.js';
export { GoogleDriveSchemaDiscoveryService } from './googledrive-discovery.service.js';

/**
 * Factory function to get discovery service by connector type.
 */
export function getDiscoveryService(connectorType: string): BaseSchemaDiscoveryService {
  switch (connectorType) {
    case 'jira':
      return new (require('./jira-discovery.service.js').JiraSchemaDiscoveryService)();
    case 'salesforce':
      return new (require('./salesforce-discovery.service.js').SalesforceSchemaDiscoveryService)();
    case 'hubspot':
      return new (require('./hubspot-discovery.service.js').HubSpotSchemaDiscoveryService)();
    case 'google_drive':
      return new (require('./googledrive-discovery.service.js').GoogleDriveSchemaDiscoveryService)();
    default:
      throw new Error(`Unsupported connector type: ${connectorType}`);
  }
}
