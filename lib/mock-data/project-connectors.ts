export type ProjectConnector = {
  id: string;
  connectionName: string;
  appId: 'hubspot' | 'salesforce' | 'zendesk' | 'calendly';
  appName: string;
  authType: string;
  recordStatus: 'draft' | 'active';
  availabilityStatus: 'active' | 'disabled' | 'revoked';
  updatedAt: string;
};

export const connectorsByProject: Record<string, ProjectConnector[]> = {
  proj_card_services: [
    {
      id: 'crm-hubspot-prod',
      connectionName: 'HubSpot US Prod',
      appId: 'hubspot',
      appName: 'HubSpot',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'Jun 4, 1:12 PM',
    },
    {
      id: 'crm-salesforce-sandbox',
      connectionName: 'Salesforce Sandbox',
      appId: 'salesforce',
      appName: 'Salesforce',
      authType: 'OAuth',
      recordStatus: 'active',
      availabilityStatus: 'disabled',
      updatedAt: 'Jun 3, 6:45 PM',
    },
    {
      id: 'crm-hubspot-eu',
      connectionName: 'HubSpot EU Analytics',
      appId: 'hubspot',
      appName: 'HubSpot',
      authType: 'PAT',
      recordStatus: 'draft',
      availabilityStatus: 'revoked',
      updatedAt: 'Jun 2, 10:18 AM',
    },
    {
      id: 'crm-zendesk-ops',
      connectionName: 'Zendesk Support Ops',
      appId: 'zendesk',
      appName: 'Zendesk',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'Jun 1, 4:20 PM',
    },
    {
      id: 'crm-calendly-revops',
      connectionName: 'Calendly RevOps',
      appId: 'calendly',
      appName: 'Calendly',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'disabled',
      updatedAt: 'May 30, 11:10 AM',
    },
  ],
  proj_member_onboarding: [
    {
      id: 'support-zendesk-prod',
      connectionName: 'Zendesk Support Prod',
      appId: 'zendesk',
      appName: 'Zendesk',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'Jun 4, 9:30 AM',
    },
    {
      id: 'support-zendesk-csat',
      connectionName: 'Zendesk CSAT Mirror',
      appId: 'zendesk',
      appName: 'Zendesk',
      authType: 'PAT',
      recordStatus: 'draft',
      availabilityStatus: 'disabled',
      updatedAt: 'Jun 1, 2:05 PM',
    },
    {
      id: 'support-hubspot-lifecycle',
      connectionName: 'HubSpot Lifecycle Sync',
      appId: 'hubspot',
      appName: 'HubSpot',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'May 31, 10:40 AM',
    },
    {
      id: 'support-salesforce-intake',
      connectionName: 'Salesforce Intake Queue',
      appId: 'salesforce',
      appName: 'Salesforce',
      authType: 'OAuth',
      recordStatus: 'active',
      availabilityStatus: 'disabled',
      updatedAt: 'May 29, 5:55 PM',
    },
    {
      id: 'support-calendly-onboarding',
      connectionName: 'Calendly Onboarding Calls',
      appId: 'calendly',
      appName: 'Calendly',
      authType: 'PAT',
      recordStatus: 'draft',
      availabilityStatus: 'revoked',
      updatedAt: 'May 27, 9:15 AM',
    },
  ],
  proj_collections: [
    {
      id: 'sched-calendly-prod',
      connectionName: 'Calendly Executive Team',
      appId: 'calendly',
      appName: 'Calendly',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'Jun 4, 8:15 AM',
    },
    {
      id: 'sched-calendly-emea',
      connectionName: 'Calendly EMEA Usage',
      appId: 'calendly',
      appName: 'Calendly',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'disabled',
      updatedAt: 'May 29, 4:50 PM',
    },
    {
      id: 'sched-zendesk-recovery',
      connectionName: 'Zendesk Recovery Desk',
      appId: 'zendesk',
      appName: 'Zendesk',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'May 28, 2:25 PM',
    },
    {
      id: 'sched-salesforce-renewals',
      connectionName: 'Salesforce Renewals',
      appId: 'salesforce',
      appName: 'Salesforce',
      authType: 'OAuth',
      recordStatus: 'active',
      availabilityStatus: 'disabled',
      updatedAt: 'May 26, 3:40 PM',
    },
    {
      id: 'sched-hubspot-reminders',
      connectionName: 'HubSpot Reminder Sequences',
      appId: 'hubspot',
      appName: 'HubSpot',
      authType: 'PAT',
      recordStatus: 'draft',
      availabilityStatus: 'revoked',
      updatedAt: 'May 24, 11:30 AM',
    },
  ],
  proj_lending: [
    {
      id: 'tmpl-hubspot-baseline',
      connectionName: 'HubSpot Read-only Template',
      appId: 'hubspot',
      appName: 'HubSpot',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'Jun 4, 11:05 AM',
    },
    {
      id: 'tmpl-salesforce-baseline',
      connectionName: 'Salesforce Accounts Template',
      appId: 'salesforce',
      appName: 'Salesforce',
      authType: 'OAuth',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'Jun 3, 3:20 PM',
    },
    {
      id: 'tmpl-zendesk-baseline',
      connectionName: 'Zendesk Tickets Template',
      appId: 'zendesk',
      appName: 'Zendesk',
      authType: 'PAT',
      recordStatus: 'draft',
      availabilityStatus: 'revoked',
      updatedAt: 'May 31, 12:40 PM',
    },
    {
      id: 'tmpl-calendly-baseline',
      connectionName: 'Calendly Events Template',
      appId: 'calendly',
      appName: 'Calendly',
      authType: 'PAT',
      recordStatus: 'active',
      availabilityStatus: 'active',
      updatedAt: 'May 30, 4:15 PM',
    },
  ],
};

export function getProjectConnectors(projectId: string): ProjectConnector[] {
  return connectorsByProject[projectId] ?? [];
}

export function getProjectAppGroups(projectId: string) {
  const connectors = getProjectConnectors(projectId);
  return Object.values(
    connectors.reduce<
      Record<
        string,
        {
          appId: ProjectConnector['appId'];
          appName: string;
          connectors: ProjectConnector[];
        }
      >
    >((groups, connector) => {
      if (!groups[connector.appId]) {
        groups[connector.appId] = {
          appId: connector.appId,
          appName: connector.appName,
          connectors: [],
        };
      }
      groups[connector.appId].connectors.push(connector);
      return groups;
    }, {}),
  ).sort((left, right) => left.appName.localeCompare(right.appName));
}
