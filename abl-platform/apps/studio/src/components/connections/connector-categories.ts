export type ConnectorCategory =
  | 'communication'
  | 'productivity'
  | 'storage'
  | 'crm'
  | 'service_management'
  | 'ai_dev'
  | 'custom';

export const CATEGORY_ORDER: ConnectorCategory[] = [
  'communication',
  'productivity',
  'storage',
  'crm',
  'service_management',
  'ai_dev',
  'custom',
];

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  communication: 'Communication',
  productivity: 'Productivity',
  storage: 'Storage',
  crm: 'CRM & Sales',
  service_management: 'Service Management',
  ai_dev: 'AI & Dev',
  custom: 'Others',
};

const CONNECTOR_TO_CATEGORY: Record<string, ConnectorCategory> = {
  slack: 'communication',
  discord: 'communication',
  'microsoft-teams': 'communication',
  'microsoft-outlook': 'communication',
  'amazon-ses': 'communication',
  'amazon-sns': 'communication',
  gmail: 'communication',
  twilio: 'communication',
  sendgrid: 'communication',
  'microsoft-sharepoint': 'productivity',
  'microsoft-outlook-calendar': 'productivity',
  'microsoft-power-bi': 'productivity',
  notion: 'productivity',
  asana: 'productivity',
  clickup: 'productivity',
  'jira-cloud': 'productivity',
  linear: 'productivity',
  'google-calendar': 'productivity',
  'google-drive': 'storage',
  'amazon-s3': 'storage',
  'microsoft-onedrive': 'storage',
  'azure-blob-storage': 'storage',
  'google-sheets': 'storage',
  airtable: 'storage',
  postgres: 'storage',
  'amazon-sqs': 'custom',
  hubspot: 'crm',
  salesforce: 'crm',
  pipedrive: 'crm',
  'microsoft-dynamics-365-business-central': 'crm',
  shopify: 'crm',
  stripe: 'crm',
  openai: 'ai_dev',
  claude: 'ai_dev',
  github: 'ai_dev',
  zendesk: 'service_management',
  servicenow: 'service_management',
  http: 'custom',
};

export function getConnectorCategory(connectorName: string): ConnectorCategory {
  return CONNECTOR_TO_CATEGORY[connectorName] ?? 'custom';
}

export function getCategoryLabel(category: ConnectorCategory): string {
  return CATEGORY_LABELS[category];
}
