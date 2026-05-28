export interface Tenant {
  id: string;
  name: string;
  shortName: string;
  region: string;
  charter: 'federal' | 'state';
  assetsUSD: number;
}

export interface Persona {
  id: string;
  name: string;
  firstName: string;
  email: string;
  role: 'Process Owner' | 'Compliance Reviewer' | 'Credit Union Admin';
  initials: string;
  avatarHue: 'purple' | 'success' | 'info' | 'warning';
  home: string;
}

export const tenant: Tenant = {
  id: 'cu_cornerstone',
  name: 'Cornerstone Federal Credit Union',
  shortName: 'Cornerstone FCU',
  region: 'us-east',
  charter: 'federal',
  assetsUSD: 2_400_000_000,
};

export const personas: Record<'processOwner' | 'reviewer' | 'admin', Persona> = {
  processOwner: {
    id: 'u_np',
    name: 'Demo User',
    firstName: 'Demo',
    email: 'demo@cornerstone.cu',
    role: 'Process Owner',
    initials: 'DU',
    avatarHue: 'purple',
    home: '/',
  },
  reviewer: {
    id: 'u_rs',
    name: 'Rina Salgado',
    firstName: 'Rina',
    email: 'rina.salgado@cornerstone.cu',
    role: 'Compliance Reviewer',
    initials: 'RS',
    avatarHue: 'success',
    home: '/queue',
  },
  admin: {
    id: 'u_jc',
    name: 'Jordan Chen',
    firstName: 'Jordan',
    email: 'jordan.chen@cornerstone.cu',
    role: 'Credit Union Admin',
    initials: 'JC',
    avatarHue: 'info',
    home: '/mission-control',
  },
};
