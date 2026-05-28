// Static connector catalog registry
// Provides type-safe connector metadata for the Add Source flow

export type ConnectorFlowType =
  | 'enterprise_wizard'
  | 'file_upload'
  | 'web_modes'
  | 'config_form'
  | 'noop';

export type ConnectorCatalogCategory =
  | 'cloud_storage'
  | 'productivity_docs'
  | 'project_management'
  | 'crm_sales'
  | 'it_support'
  | 'communication'
  | 'developer_tools'
  | 'enterprise_hr'
  | 'media'
  | 'web_content'
  | 'file_sources'
  | 'enterprise_storage';

export interface CatalogConnectorEntry {
  name: string;
  displayName: string;
  subtitle?: string;
  description: string;
  category: ConnectorCatalogCategory;
  flowType: ConnectorFlowType;
  enterpriseType?: string;
  sourceType?: 'database' | 'api';
  aliases?: string[];
  featured?: boolean;
  sortOrder?: number;
}

export interface CatalogCategoryDef {
  id: ConnectorCatalogCategory;
  label: string;
  order: number;
}

// ---------------------------------------------------------------------------
// Category definitions (display order)
// ---------------------------------------------------------------------------

export const CATALOG_CATEGORIES: CatalogCategoryDef[] = [
  { id: 'cloud_storage', label: 'Cloud Storage', order: 1 },
  { id: 'productivity_docs', label: 'Productivity & Docs', order: 2 },
  { id: 'project_management', label: 'Project Management', order: 3 },
  { id: 'crm_sales', label: 'CRM & Sales', order: 4 },
  { id: 'it_support', label: 'IT & Support', order: 5 },
  { id: 'communication', label: 'Communication', order: 6 },
  { id: 'developer_tools', label: 'Developer Tools', order: 7 },
  { id: 'enterprise_hr', label: 'Enterprise & HR', order: 8 },
  { id: 'media', label: 'Media', order: 9 },
  { id: 'web_content', label: 'Web & Content', order: 10 },
  { id: 'file_sources', label: 'File Sources', order: 11 },
  { id: 'enterprise_storage', label: 'Enterprise Storage', order: 12 },
];

// ---------------------------------------------------------------------------
// Connector catalog — 88 connectors
// ---------------------------------------------------------------------------

export const CATALOG_CONNECTORS: CatalogConnectorEntry[] = [
  // ── Cloud Storage (8) ───────────────────────────────────────────────
  {
    name: 'google_drive',
    displayName: 'Google Drive',
    description: 'Index files and folders from Google Drive',
    category: 'cloud_storage',
    flowType: 'noop',
    aliases: ['GDrive'],
    featured: true,
    sortOrder: 5,
  },
  {
    name: 'onedrive',
    displayName: 'OneDrive',
    description: 'Index files and folders from Microsoft OneDrive',
    category: 'cloud_storage',
    flowType: 'noop',
  },
  {
    name: 'dropbox',
    displayName: 'Dropbox',
    description: 'Index files and folders from Dropbox',
    category: 'cloud_storage',
    flowType: 'noop',
  },
  {
    name: 'box',
    displayName: 'Box',
    description: 'Index files and folders from Box cloud storage',
    category: 'cloud_storage',
    flowType: 'noop',
  },
  {
    name: 'amazon_s3',
    displayName: 'Amazon S3',
    description: 'Index objects from Amazon S3 buckets',
    category: 'cloud_storage',
    flowType: 'noop',
    aliases: ['AWS S3'],
  },
  {
    name: 'azure_blob_storage',
    displayName: 'Azure Blob Storage',
    description: 'Index blobs from Azure Blob Storage containers',
    category: 'cloud_storage',
    flowType: 'noop',
    aliases: ['Azure Storage'],
  },
  {
    name: 'google_cloud_storage',
    displayName: 'Google Cloud Storage',
    description: 'Index objects from Google Cloud Storage buckets',
    category: 'cloud_storage',
    flowType: 'noop',
  },
  {
    name: 'egnyte',
    displayName: 'Egnyte',
    description: 'Index files and folders from Egnyte cloud storage',
    category: 'cloud_storage',
    flowType: 'noop',
  },

  // ── Productivity & Docs (12) ────────────────────────────────────────
  {
    name: 'confluence',
    displayName: 'Confluence',
    subtitle: 'Cloud & Server',
    description: 'Index pages and spaces from Atlassian Confluence',
    category: 'productivity_docs',
    flowType: 'noop',
    aliases: ['Atlassian Confluence'],
    featured: true,
    sortOrder: 4,
  },
  {
    name: 'notion',
    displayName: 'Notion',
    description: 'Index pages and databases from Notion workspaces',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'google_docs',
    displayName: 'Google Docs',
    description: 'Index documents from Google Docs',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'ms_word_online',
    displayName: 'MS Word Online',
    description: 'Index documents from Microsoft Word Online',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'coda',
    displayName: 'Coda',
    description: 'Index docs and tables from Coda',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'quip',
    displayName: 'Quip',
    description: 'Index documents and spreadsheets from Quip',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'slite',
    displayName: 'Slite',
    description: 'Index notes and documents from Slite',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'gitbook',
    displayName: 'GitBook',
    description: 'Index documentation from GitBook spaces',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'airtable',
    displayName: 'Airtable',
    description: 'Index spreadsheets and databases from Airtable bases',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'guru',
    displayName: 'Guru',
    description: 'Index knowledge cards and collections from Guru',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'miro',
    displayName: 'Miro',
    description: 'Index boards and content from Miro whiteboards',
    category: 'productivity_docs',
    flowType: 'noop',
  },
  {
    name: 'slab',
    displayName: 'Slab',
    description: 'Index posts and topics from Slab knowledge base',
    category: 'productivity_docs',
    flowType: 'noop',
  },

  // ── Project Management (12) ─────────────────────────────────────────
  {
    name: 'jira',
    displayName: 'Jira',
    subtitle: 'Cloud & On-Prem',
    description: 'Index issues and projects from Atlassian Jira',
    category: 'project_management',
    flowType: 'noop',
    aliases: ['Atlassian Jira', 'Jira On-Prem'],
    featured: true,
    sortOrder: 6,
  },
  {
    name: 'asana',
    displayName: 'Asana',
    description: 'Index tasks and projects from Asana',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'monday_com',
    displayName: 'Monday.com',
    description: 'Index boards and items from Monday.com',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'clickup',
    displayName: 'ClickUp',
    description: 'Index tasks and spaces from ClickUp',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'linear',
    displayName: 'Linear',
    description: 'Index issues and projects from Linear',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'trello',
    displayName: 'Trello',
    description: 'Index boards and cards from Trello',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'aha',
    displayName: 'Aha!',
    description: 'Index ideas, features, and roadmaps from Aha!',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'hive',
    displayName: 'Hive',
    description: 'Index projects, tasks, and actions from Hive',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'shortcut',
    displayName: 'Shortcut',
    description: 'Index stories, epics, and iterations from Shortcut',
    category: 'project_management',
    flowType: 'noop',
    aliases: ['Clubhouse'],
  },
  {
    name: 'teamwork',
    displayName: 'Teamwork',
    description: 'Index projects, tasks, and milestones from Teamwork',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'wrike',
    displayName: 'Wrike',
    description: 'Index projects, tasks, and folders from Wrike',
    category: 'project_management',
    flowType: 'noop',
  },
  {
    name: 'youtrack',
    displayName: 'YouTrack',
    description: 'Index issues and projects from JetBrains YouTrack',
    category: 'project_management',
    flowType: 'noop',
    aliases: ['JetBrains YouTrack'],
  },

  // ── CRM & Sales (6) ────────────────────────────────────────────────
  {
    name: 'salesforce',
    displayName: 'Salesforce',
    description: 'Index knowledge articles and records from Salesforce',
    category: 'crm_sales',
    flowType: 'noop',
    aliases: ['SFDC'],
    featured: true,
    sortOrder: 7,
  },
  {
    name: 'hubspot',
    displayName: 'HubSpot',
    description: 'Index contacts, deals, and knowledge base from HubSpot',
    category: 'crm_sales',
    flowType: 'noop',
    aliases: ['HS'],
    featured: true,
    sortOrder: 9,
  },
  {
    name: 'pipedrive',
    displayName: 'Pipedrive',
    description: 'Index deals, contacts, and activities from Pipedrive',
    category: 'crm_sales',
    flowType: 'noop',
  },
  {
    name: 'zoho_crm',
    displayName: 'Zoho CRM',
    description: 'Index leads, contacts, and records from Zoho CRM',
    category: 'crm_sales',
    flowType: 'noop',
  },
  {
    name: 'dynamics_365',
    displayName: 'Dynamics 365',
    description: 'Index entities and records from Microsoft Dynamics 365',
    category: 'crm_sales',
    flowType: 'noop',
    aliases: ['Microsoft Dynamics', 'D365'],
  },
  {
    name: 'shopify',
    displayName: 'Shopify',
    description: 'Index products, orders, and content from Shopify stores',
    category: 'crm_sales',
    flowType: 'noop',
  },

  // ── IT & Support (12) ──────────────────────────────────────────────
  {
    name: 'servicenow',
    displayName: 'ServiceNow',
    description: 'Index incidents, knowledge articles, and records from ServiceNow',
    category: 'it_support',
    flowType: 'noop',
    aliases: ['SNOW'],
    featured: true,
    sortOrder: 8,
  },
  {
    name: 'zendesk',
    displayName: 'Zendesk',
    description: 'Index tickets, articles, and help center content from Zendesk',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'freshdesk',
    displayName: 'FreshDesk',
    description: 'Index tickets and knowledge base from FreshDesk',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'intercom',
    displayName: 'Intercom',
    description: 'Index conversations and articles from Intercom',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'pagerduty',
    displayName: 'PagerDuty',
    description: 'Index incidents and services from PagerDuty',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'freshservice',
    displayName: 'Freshservice',
    description: 'Index solution articles and tickets from Freshservice',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'front',
    displayName: 'Front',
    description: 'Index knowledge base articles from Front',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'helpscout',
    displayName: 'HelpScout',
    description: 'Index docs, articles, and conversations from HelpScout',
    category: 'it_support',
    flowType: 'noop',
    aliases: ['Help Scout'],
  },
  {
    name: 'opsgenie',
    displayName: 'Opsgenie',
    description: 'Index alerts, incidents, and on-call schedules from Opsgenie',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'reamaze',
    displayName: 'Re:amaze',
    description: 'Index conversations and knowledge base from Re:amaze',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'wolken',
    displayName: 'Wolken Service Desk',
    description: 'Index tickets and knowledge articles from Wolken Service Desk',
    category: 'it_support',
    flowType: 'noop',
  },
  {
    name: 'xmatters',
    displayName: 'xMatters',
    description: 'Index incidents, on-call schedules, and workflows from xMatters',
    category: 'it_support',
    flowType: 'noop',
  },

  // ── Communication (9) ──────────────────────────────────────────────
  {
    name: 'ms_teams',
    displayName: 'MS Teams',
    description: 'Index messages and files from Microsoft Teams channels',
    category: 'communication',
    flowType: 'noop',
    aliases: ['Microsoft Teams'],
  },
  {
    name: 'slack',
    displayName: 'Slack',
    description: 'Index messages and files from Slack channels',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'discord',
    displayName: 'Discord',
    description: 'Index messages from Discord servers and channels',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Index emails and attachments from Gmail',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'google_chat',
    displayName: 'Google Chat',
    description: 'Index messages from Google Chat spaces',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'zoom',
    displayName: 'Zoom',
    description: 'Index meeting transcripts and recordings from Zoom',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'axero',
    displayName: 'Axero',
    description: 'Index articles and content from Axero intranet',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'lumapps',
    displayName: 'LumApps',
    description: 'Index content and communities from LumApps intranet',
    category: 'communication',
    flowType: 'noop',
  },
  {
    name: 'zulip',
    displayName: 'Zulip',
    description: 'Index messages and topics from Zulip chat streams',
    category: 'communication',
    flowType: 'noop',
  },

  // ── Developer Tools (14) ───────────────────────────────────────────
  {
    name: 'github',
    displayName: 'GitHub',
    subtitle: 'Cloud & On-Prem',
    description: 'Index repositories, issues, and wikis from GitHub',
    category: 'developer_tools',
    flowType: 'noop',
    aliases: ['GH', 'GitHub On-Prem'],
  },
  {
    name: 'gitlab',
    displayName: 'GitLab',
    description: 'Index repositories, issues, and wikis from GitLab',
    category: 'developer_tools',
    flowType: 'noop',
    aliases: ['GL'],
  },
  {
    name: 'bitbucket',
    displayName: 'Bitbucket',
    description: 'Index repositories and pull requests from Bitbucket',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'stackoverflow_teams',
    displayName: 'Stack Overflow Teams',
    description: 'Index questions and answers from Stack Overflow for Teams',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'readme',
    displayName: 'ReadMe',
    description: 'Index API documentation from ReadMe',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'swagger_openapi',
    displayName: 'Swagger/OpenAPI',
    description: 'Index API specifications from Swagger and OpenAPI definitions',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'custom_connector',
    displayName: 'Custom Connector',
    description: 'Build a custom connector with your own data source integration',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'json_connector',
    displayName: 'JSON Connector',
    description: 'Index structured data from JSON endpoints and files',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'datadog',
    displayName: 'Datadog',
    description: 'Index metrics, dashboards, and monitors from Datadog',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'jenkins',
    displayName: 'Jenkins',
    description: 'Index build jobs, pipelines, and logs from Jenkins',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'jfrog_artifactory',
    displayName: 'JFrog Artifactory',
    description: 'Index artifacts and repositories from JFrog Artifactory',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'figma',
    displayName: 'Figma',
    description: 'Index design files and components from Figma',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'testrail',
    displayName: 'TestRail',
    description: 'Index test cases, runs, and plans from TestRail',
    category: 'developer_tools',
    flowType: 'noop',
  },
  {
    name: 'zeplin',
    displayName: 'Zeplin',
    description: 'Index design specs and styleguides from Zeplin',
    category: 'developer_tools',
    flowType: 'noop',
  },

  // ── Enterprise & HR (4) ────────────────────────────────────────────
  {
    name: 'oracle',
    displayName: 'Oracle Knowledge',
    description: 'Index records and knowledge articles from Oracle applications',
    category: 'enterprise_hr',
    flowType: 'noop',
    aliases: ['Oracle'],
  },
  {
    name: 'workday',
    displayName: 'Workday',
    description: 'Index employee records and documents from Workday',
    category: 'enterprise_hr',
    flowType: 'noop',
  },
  {
    name: 'sap',
    displayName: 'SAP',
    description: 'Index records and documents from SAP systems',
    category: 'enterprise_hr',
    flowType: 'noop',
  },
  {
    name: 'bigtincan',
    displayName: 'Bigtincan',
    description: 'Index training courses and content from Bigtincan',
    category: 'enterprise_hr',
    flowType: 'noop',
  },

  // ── Media (2) ──────────────────────────────────────────────────────
  {
    name: 'youtube',
    displayName: 'YouTube',
    description: 'Index video transcripts and metadata from YouTube',
    category: 'media',
    flowType: 'noop',
  },
  {
    name: 'vimeo',
    displayName: 'Vimeo',
    description: 'Index video transcripts and metadata from Vimeo',
    category: 'media',
    flowType: 'noop',
  },

  // ── Web & Content (6) ──────────────────────────────────────────────
  {
    name: 'web_crawler',
    displayName: 'Web Crawler',
    description: 'Crawl and index content from any website URL',
    category: 'web_content',
    flowType: 'web_modes',
    featured: true,
    sortOrder: 2,
  },
  {
    name: 'rss_feed',
    displayName: 'RSS Feed',
    description: 'Index articles and content from RSS feeds',
    category: 'web_content',
    flowType: 'noop',
  },
  {
    name: 'sitemap',
    displayName: 'Sitemap',
    description: 'Discover and index pages from XML sitemaps',
    category: 'web_content',
    flowType: 'noop',
  },
  {
    name: 'wordpress',
    displayName: 'WordPress',
    description: 'Index posts, pages, and content from WordPress sites',
    category: 'web_content',
    flowType: 'noop',
  },
  {
    name: 'dotcms',
    displayName: 'DotCMS',
    description: 'Index content and pages from DotCMS',
    category: 'web_content',
    flowType: 'noop',
  },
  {
    name: 'invision_community',
    displayName: 'Invision Community',
    description: 'Index forums, articles, and discussions from Invision Community',
    category: 'web_content',
    flowType: 'noop',
  },

  // ── File Sources (2) ───────────────────────────────────────────────
  {
    name: 'file_upload',
    displayName: 'File Upload',
    description: 'Upload and index local files (PDF, DOCX, TXT, and more)',
    category: 'file_sources',
    flowType: 'file_upload',
    featured: true,
    sortOrder: 1,
  },
  {
    name: 'rich_media',
    displayName: 'Rich Media',
    description: 'Upload and index images, audio, and video files',
    category: 'file_sources',
    flowType: 'noop',
  },

  // ── Enterprise Storage (1) ─────────────────────────────────────────
  {
    name: 'sharepoint',
    displayName: 'SharePoint',
    description: 'Index sites, libraries, and documents from Microsoft SharePoint',
    category: 'enterprise_storage',
    flowType: 'enterprise_wizard',
    enterpriseType: 'sharepoint',
    aliases: ['Office 365', 'O365', 'Microsoft SharePoint'],
    featured: true,
    sortOrder: 3,
  },
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Groups connectors by category, sorted by sortOrder within each group.
 */
export function getCatalogConnectorsByCategory(
  connectors: CatalogConnectorEntry[],
): Map<ConnectorCatalogCategory, CatalogConnectorEntry[]> {
  const map = new Map<ConnectorCatalogCategory, CatalogConnectorEntry[]>();

  for (const connector of connectors) {
    const list = map.get(connector.category);
    if (list) {
      list.push(connector);
    } else {
      map.set(connector.category, [connector]);
    }
  }

  // Sort each group by sortOrder (entries without sortOrder go to the end)
  for (const [, list] of map) {
    list.sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
  }

  return map;
}

/**
 * Returns featured/popular connectors sorted by sortOrder.
 */
export function getPopularConnectors(connectors: CatalogConnectorEntry[]): CatalogConnectorEntry[] {
  return connectors
    .filter((c) => c.featured)
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999));
}

/**
 * Case-insensitive search against displayName, name, description, and aliases.
 */
export function searchConnectors(
  connectors: CatalogConnectorEntry[],
  query: string,
): CatalogConnectorEntry[] {
  const q = query.toLowerCase();

  return connectors.filter((c) => {
    if (c.displayName.toLowerCase().includes(q)) return true;
    if (c.name.toLowerCase().includes(q)) return true;
    if (c.description.toLowerCase().includes(q)) return true;
    if (c.aliases?.some((alias) => alias.toLowerCase().includes(q))) return true;
    return false;
  });
}
