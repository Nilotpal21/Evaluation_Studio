/**
 * Integration Catalog
 *
 * Static catalog of supported integration connectors with pre-filled
 * OAuth and vendor metadata. Used by the /integrations route to left-join
 * existing profiles so vendors with zero profiles still appear.
 *
 * Added per 2026-05-09 meeting delta (FR-10 update).
 */

// ─── Types ────────────────────────────────────────────────────────────

export interface IntegrationCatalogEntry {
  connector: string;
  displayName: string;
  iconKey?: string;
  defaultScopes?: string;
  knownAuthorizationUrl?: string;
  knownTokenUrl?: string;
  knownRefreshUrl?: string;
}

// ─── Catalog ──────────────────────────────────────────────────────────

export const INTEGRATION_CATALOG: ReadonlyArray<IntegrationCatalogEntry> = [
  {
    connector: 'github',
    displayName: 'GitHub',
    iconKey: 'github',
    defaultScopes: 'repo read:user',
    knownAuthorizationUrl: 'https://github.com/login/oauth/authorize',
    knownTokenUrl: 'https://github.com/login/oauth/access_token',
  },
  {
    connector: 'google',
    displayName: 'Google',
    iconKey: 'google',
    defaultScopes: 'openid email profile',
    knownAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    knownTokenUrl: 'https://oauth2.googleapis.com/token',
    knownRefreshUrl: 'https://oauth2.googleapis.com/token',
  },
  {
    connector: 'hubspot',
    displayName: 'HubSpot',
    iconKey: 'hubspot',
    defaultScopes: 'crm.objects.contacts.read',
    knownAuthorizationUrl: 'https://app.hubspot.com/oauth/authorize',
    knownTokenUrl: 'https://api.hubapi.com/oauth/v1/token',
    knownRefreshUrl: 'https://api.hubapi.com/oauth/v1/token',
  },
  {
    connector: 'jira',
    displayName: 'Jira',
    iconKey: 'jira',
    defaultScopes: 'read:jira-work write:jira-work',
    knownAuthorizationUrl: 'https://auth.atlassian.com/authorize',
    knownTokenUrl: 'https://auth.atlassian.com/oauth/token',
    knownRefreshUrl: 'https://auth.atlassian.com/oauth/token',
  },
  {
    connector: 'microsoft',
    displayName: 'Microsoft',
    iconKey: 'microsoft',
    defaultScopes: 'openid profile email User.Read',
    knownAuthorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    knownTokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    knownRefreshUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  },
  {
    connector: 'salesforce',
    displayName: 'Salesforce',
    iconKey: 'salesforce',
    defaultScopes: 'full refresh_token',
    knownAuthorizationUrl: 'https://login.salesforce.com/services/oauth2/authorize',
    knownTokenUrl: 'https://login.salesforce.com/services/oauth2/token',
    knownRefreshUrl: 'https://login.salesforce.com/services/oauth2/token',
  },
  {
    connector: 'servicenow',
    displayName: 'ServiceNow',
    iconKey: 'servicenow',
    defaultScopes: 'useraccount',
    knownAuthorizationUrl: 'https://<instance>.service-now.com/oauth_auth.do',
    knownTokenUrl: 'https://<instance>.service-now.com/oauth_token.do',
    knownRefreshUrl: 'https://<instance>.service-now.com/oauth_token.do',
  },
  {
    connector: 'slack',
    displayName: 'Slack',
    iconKey: 'slack',
    defaultScopes: 'chat:write channels:read',
    knownAuthorizationUrl: 'https://slack.com/oauth/v2/authorize',
    knownTokenUrl: 'https://slack.com/api/oauth.v2.access',
  },
  {
    connector: 'zendesk',
    displayName: 'Zendesk',
    iconKey: 'zendesk',
    defaultScopes: 'read write',
    knownAuthorizationUrl: 'https://<subdomain>.zendesk.com/oauth/authorizations/new',
    knownTokenUrl: 'https://<subdomain>.zendesk.com/oauth/tokens',
    knownRefreshUrl: 'https://<subdomain>.zendesk.com/oauth/tokens',
  },
];

/**
 * Returns the full integration catalog.
 * This is a pure getter for code that prefers function access over direct const reference.
 */
export function getIntegrationCatalog(): ReadonlyArray<IntegrationCatalogEntry> {
  return INTEGRATION_CATALOG;
}
