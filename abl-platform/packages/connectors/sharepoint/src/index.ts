/**
 * @agent-platform/connector-sharepoint
 *
 * SharePoint connector for enterprise Search AI platform.
 * Implements full sync, delta sync, filtering, and permission crawling.
 */

// ─── Main Connector ──────────────────────────────────────────────────────

export { SharePointConnector } from './sharepoint-connector.js';

// ─── OAuth ───────────────────────────────────────────────────────────────

export {
  MicrosoftOAuthProvider,
  type MicrosoftOAuthConfig,
} from './auth/microsoft-oauth-provider.js';

// ─── Graph Client ────────────────────────────────────────────────────────

export { GraphClient, type GraphClientConfig } from './client/graph-client.js';
export type {
  Site,
  SiteCollection,
  Drive,
  DriveCollection,
  DriveItem,
  DriveItemCollection,
  Permission,
  PermissionCollection,
  GroupMember,
  GroupMemberCollection,
  GraphErrorResponse,
  GraphList,
  GraphListCollection,
  GraphColumnDefinition,
  GraphColumnCollection,
} from './client/graph-types.js';

// ─── Sync Coordinators ───────────────────────────────────────────────────

export { SharePointFullSyncCoordinator } from './sync/full-sync-coordinator.js';
export { SharePointDeltaSyncCoordinator } from './sync/delta-sync-coordinator.js';

// ─── Filters ─────────────────────────────────────────────────────────────

export {
  SharePointFilterEngine,
  type SharePointScopeConfig,
} from './filters/sharepoint-filter-engine.js';
export { ODataTranslator, type TranslationResult } from './filters/odata-translator.js';

// ─── Discovery ──────────────────────────────────────────────────────────

export { SharePointResourceDiscovery } from './discovery/sharepoint-resource-discovery.js';

// ─── Webhooks ────────────────────────────────────────────────────────────

export { SharePointWebhookManager } from './webhooks/index.js';
