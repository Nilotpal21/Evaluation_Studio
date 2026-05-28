import { Headphones, Globe, Phone, PhoneCall } from 'lucide-react';

export type AgentDesktopProvider =
  | 'smartassist'
  | 'genesys'
  | 'salesforce'
  | 'servicenow'
  | 'five9'
  | 'generic';

export type ConnectionCategory = 'agent_desktop' | 'tool' | 'messaging';

export interface AgentDesktopProviderDef {
  id: AgentDesktopProvider;
  label: string;
  description: string;
  helpUrl?: string;
  setupHint?: string;
  Icon: React.ComponentType<{ className?: string }>;
  authType: 'api_key' | 'oauth2' | 'custom';
  fields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'url';
    required: boolean;
    placeholder?: string;
    hint?: string;
  }>;
}

export const AGENT_DESKTOP_PROVIDERS: AgentDesktopProviderDef[] = [
  {
    id: 'smartassist',
    label: 'Kore SmartAssist',
    description: 'Kore.ai SmartAssist agent desktop',
    setupHint:
      'Find these credentials in SmartAssist under Settings > API Keys. The Org ID is on your account overview page.',
    Icon: Headphones,
    authType: 'api_key',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        type: 'url',
        required: true,
        placeholder: 'https://smartassist.example.com',
        hint: 'Your SmartAssist instance URL (e.g. https://your-org.smartassist.kore.ai)',
      },
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: false,
        hint: 'Optional. Generated in SmartAssist > Settings > API Keys',
      },
      {
        key: 'webhookSecret',
        label: 'Webhook Secret',
        type: 'password',
        required: false,
        hint: 'Optional. Used to verify incoming webhook payloads from SmartAssist',
      },
      {
        key: 'appId',
        label: 'App ID',
        type: 'text',
        required: true,
        hint: 'The SmartAssist App ID (Bot ID) used for agent transfer',
      },
      {
        key: 'orgId',
        label: 'Organization ID',
        type: 'text',
        required: false,
        hint: 'Optional. Auto-resolved from App ID if not provided',
      },
    ],
  },
  {
    id: 'genesys',
    label: 'Genesys Cloud',
    description: 'Genesys Cloud CX agent desktop',
    setupHint:
      'Create an OAuth client in Genesys Admin > Integrations > OAuth. Use "Client Credentials" grant type with the required scopes.',
    Icon: Phone,
    authType: 'oauth2',
    fields: [
      {
        key: 'region',
        label: 'Region',
        type: 'text',
        required: true,
        placeholder: 'mypurecloud.com',
        hint: 'Your Genesys Cloud region domain (e.g. mypurecloud.com, mypurecloud.de, mypurecloud.jp)',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        hint: 'From Genesys Admin > Integrations > OAuth > Your App',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        hint: 'Shown once when the OAuth client is created',
      },
      {
        key: 'deploymentId',
        label: 'Deployment ID',
        type: 'text',
        required: true,
        hint: 'The Genesys web messaging deployment ID used for routing',
      },
    ],
  },
  {
    id: 'salesforce',
    label: 'Salesforce',
    description: 'Salesforce Service Cloud agent desktop',
    setupHint:
      'Create a Connected App in Salesforce Setup > App Manager > New Connected App. Enable OAuth and add the required scopes.',
    Icon: Globe,
    authType: 'oauth2',
    fields: [
      {
        key: 'instanceUrl',
        label: 'Instance URL',
        type: 'url',
        required: true,
        hint: 'Your Salesforce instance (e.g. https://your-org.my.salesforce.com)',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        hint: 'Consumer Key from your Connected App settings',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        hint: 'Consumer Secret from your Connected App settings',
      },
      {
        key: 'orgId',
        label: 'Organization ID',
        type: 'text',
        required: true,
        hint: 'Found in Salesforce Setup > Company Information',
      },
    ],
  },
  {
    id: 'servicenow',
    label: 'ServiceNow',
    description: 'ServiceNow ITSM agent workspace',
    setupHint:
      'Register an OAuth application in ServiceNow under System OAuth > Application Registry. Use type "Connect to a third party OAuth Provider".',
    Icon: Globe,
    authType: 'oauth2',
    fields: [
      {
        key: 'instanceUrl',
        label: 'Instance URL',
        type: 'url',
        required: true,
        hint: 'Your ServiceNow instance (e.g. https://your-org.service-now.com)',
      },
      {
        key: 'clientId',
        label: 'Client ID',
        type: 'text',
        required: true,
        hint: 'From System OAuth > Application Registry in your ServiceNow instance',
      },
      {
        key: 'clientSecret',
        label: 'Client Secret',
        type: 'password',
        required: true,
        hint: 'Generated when registering the OAuth application',
      },
    ],
  },
  {
    id: 'five9',
    label: 'Five9',
    description: 'Five9 Virtual Contact Center agent desktop',
    setupHint:
      'Enter your Five9 tenant name and campaign name. For supervisor auth mode, provide credentials. The callback URL is auto-generated if left empty.',
    Icon: PhoneCall,
    authType: 'custom',
    fields: [
      {
        key: 'tenantName',
        label: 'Tenant Name',
        type: 'text',
        required: true,
        placeholder: 'your-tenant',
        hint: 'Your Five9 tenant name',
      },
      {
        key: 'campaignName',
        label: 'Campaign Name',
        type: 'text',
        required: true,
        hint: 'Five9 campaign for inbound routing',
      },
      {
        key: 'host',
        label: 'Host',
        type: 'text',
        required: false,
        placeholder: 'app.five9.com',
        hint: 'Five9 API host (default: app.five9.com)',
      },
      {
        key: 'authMode',
        label: 'Auth Mode',
        type: 'text',
        required: true,
        placeholder: 'anonymous',
        hint: 'anonymous or supervisor',
      },
      {
        key: 'username',
        label: 'Username',
        type: 'text',
        required: false,
        hint: 'Required for supervisor auth mode',
      },
      {
        key: 'password',
        label: 'Password',
        type: 'password',
        required: false,
        hint: 'Required for supervisor auth mode',
      },
      {
        key: 'callbackUrl',
        label: 'Callback URL',
        type: 'url',
        required: false,
        hint: 'Override webhook callback URL (auto-generated if empty)',
      },
    ],
  },
  {
    id: 'generic',
    label: 'Generic HTTP',
    description: 'Custom agent desktop via HTTP webhooks',
    setupHint:
      'Point this at any HTTP endpoint that accepts transfer requests. The platform will POST JSON payloads with session and routing data.',
    Icon: Globe,
    authType: 'custom',
    fields: [
      {
        key: 'webhookUrl',
        label: 'Webhook URL',
        type: 'url',
        required: true,
        hint: 'The endpoint that will receive transfer request payloads via POST',
      },
      {
        key: 'authHeader',
        label: 'Auth Header',
        type: 'text',
        required: false,
        placeholder: 'Authorization',
        hint: 'Optional. HTTP header name for authentication (defaults to "Authorization")',
      },
      {
        key: 'secret',
        label: 'Secret',
        type: 'password',
        required: false,
        hint: 'Optional. Value sent in the auth header (e.g. Bearer token or API key)',
      },
    ],
  },
];

export const CONNECTION_BACKED_AGENT_DESKTOP_PROVIDER_IDS = ['smartassist', 'five9'] as const;

const CONNECTION_BACKED_AGENT_DESKTOP_PROVIDER_ID_SET = new Set<string>(
  CONNECTION_BACKED_AGENT_DESKTOP_PROVIDER_IDS,
);

export const CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS = AGENT_DESKTOP_PROVIDERS.filter((p) =>
  CONNECTION_BACKED_AGENT_DESKTOP_PROVIDER_ID_SET.has(p.id),
);

export function getProviderDef(id: string): AgentDesktopProviderDef | undefined {
  return AGENT_DESKTOP_PROVIDERS.find((p) => p.id === id);
}

export function getConnectionCategory(connectorName: string): ConnectionCategory {
  if (CONNECTION_BACKED_AGENT_DESKTOP_PROVIDER_ID_SET.has(connectorName)) return 'agent_desktop';
  return 'tool';
}
