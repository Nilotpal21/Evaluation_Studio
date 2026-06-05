export interface Tenant {
  id: string;
  name: string;
  shortName: string;
  region: string;
  charter: 'federal' | 'state';
  assetsUSD: number;
  workspaceSummary?: string;
}

export interface Persona {
  id: string;
  name: string;
  firstName: string;
  email: string;
  role: 'Process Owner' | 'Compliance Reviewer' | 'Credit Union Admin';
  uiRole?: string;
  initials: string;
  avatarHue: 'purple' | 'success' | 'info' | 'warning';
  home: string;
}

export const tenant: Tenant = {
  id: 'acme_workspace',
  name: 'Acme Corp',
  shortName: 'Acme Corp',
  region: 'us-east',
  charter: 'federal',
  assetsUSD: 2_400_000_000,
  workspaceSummary: '4 apps · 12 connectors · sandbox-first setup',
};

export const personas: Record<'processOwner' | 'reviewer' | 'admin', Persona> = {
  processOwner: {
    id: 'u_np',
    name: 'Nilotpal Prakash',
    firstName: 'Nilotpal',
    email: 'nilotpal@acmecorp.com',
    role: 'Process Owner',
    uiRole: 'Product Manager',
    initials: 'NP',
    avatarHue: 'purple',
    home: '/projects',
  },
  reviewer: {
    id: 'u_rs',
    name: 'Sarah Chen',
    firstName: 'Rina',
    email: 'sarah.chen@acmecorp.com',
    role: 'Compliance Reviewer',
    uiRole: 'Integration Reviewer',
    initials: 'RS',
    avatarHue: 'success',
    home: '/queue',
  },
  admin: {
    id: 'u_jc',
    name: 'Jordan Chen',
    firstName: 'Jordan',
    email: 'jordan.chen@acmecorp.com',
    role: 'Credit Union Admin',
    uiRole: 'Platform Admin',
    initials: 'JC',
    avatarHue: 'info',
    home: '/mission-control',
  },
};
