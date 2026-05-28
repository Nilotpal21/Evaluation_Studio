export type KnowledgeMode = 'upload' | 'connector' | 'crawl' | 'authored' | 'api';

export type KnowledgeStatus = 'active' | 'syncing' | 'stale' | 'deprecated' | 'error';

export type SensitiveTag = 'pii' | 'npi' | 'regulator-only';

export interface KnowledgeDocument {
  title: string;
  pages?: number;
  chunks?: number;
  lastUpdated: string;
}

export interface KnowledgeQualityFlag {
  severity: 'blocker' | 'warning' | 'suggestion';
  title: string;
  detail?: string;
}

export interface KnowledgeSource {
  id: string;
  name: string;
  mode: KnowledgeMode;
  provider?: string;
  scope: 'tenant' | 'project';
  projectId?: string;
  status: KnowledgeStatus;
  documents: number;
  chunks: number;
  appsConsuming: number;
  appsConsumingIds: string[];
  ownerInitials: string;
  ownerName: string;
  tags: string[];
  sensitiveTags: SensitiveTag[];
  refresh: 'push' | 'pull' | 'real-time' | 'manual';
  refreshCadence?: string;
  lastSyncedAgo: string;
  nextScheduledSync?: string;
  sourceRef?: string;
  region?: string;
  documentsPreview?: KnowledgeDocument[];
  flags?: KnowledgeQualityFlag[];
}

export const knowledgeSources: KnowledgeSource[] = [
  {
    id: 'kb_card_disputes_disclosures',
    name: 'Card dispute disclosures',
    mode: 'connector',
    provider: 'Confluence',
    scope: 'project',
    projectId: 'proj_card_services',
    status: 'active',
    documents: 24,
    chunks: 412,
    appsConsuming: 1,
    appsConsumingIds: ['app_card_dispute_triage'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['reg-e', 'card-services', 'disclosures'],
    sensitiveTags: [],
    refresh: 'pull',
    refreshCadence: 'Every 15 min',
    lastSyncedAgo: '8 min ago',
    nextScheduledSync: 'in 7 min',
    sourceRef: 'cornerstone.atlassian.net/wiki/spaces/CARD/disclosures',
    documentsPreview: [
      { title: 'Reg E member rights disclosure', pages: 4, lastUpdated: '2026-05-22' },
      { title: 'Card dispute resolution timeline', pages: 2, lastUpdated: '2026-05-19' },
      { title: 'Provisional credit policy', pages: 3, lastUpdated: '2026-05-15' },
      { title: 'Joint-account dispute handling', pages: 2, lastUpdated: '2026-05-12' },
    ],
  },
  {
    id: 'kb_reg_e_playbook',
    name: 'Reg E playbook',
    mode: 'upload',
    scope: 'tenant',
    status: 'active',
    documents: 6,
    chunks: 84,
    appsConsuming: 2,
    appsConsumingIds: ['app_card_dispute_triage', 'app_fraud_triage'],
    ownerInitials: 'NP',
    ownerName: 'Demo User',
    tags: ['reg-e', 'compliance', 'regulatory'],
    sensitiveTags: [],
    refresh: 'manual',
    lastSyncedAgo: '18 days ago',
    sourceRef: 'Uploaded files',
    documentsPreview: [
      { title: 'Reg E provisional credit rule.pdf', pages: 8, lastUpdated: '2026-05-10' },
      { title: 'Reg E timing requirements.pdf', pages: 6, lastUpdated: '2026-05-10' },
      { title: 'Reg E error resolution flowchart.pdf', pages: 2, lastUpdated: '2026-05-10' },
    ],
  },
  {
    id: 'kb_member_identity_policy',
    name: 'Member identity policy',
    mode: 'connector',
    provider: 'SharePoint',
    scope: 'tenant',
    status: 'active',
    documents: 12,
    chunks: 156,
    appsConsuming: 3,
    appsConsumingIds: [
      'app_card_dispute_triage',
      'app_account_opening',
      'app_fraud_triage',
    ],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['kyc', 'identity', 'pii', 'compliance'],
    sensitiveTags: ['pii'],
    refresh: 'pull',
    refreshCadence: 'Every 1 hour',
    lastSyncedAgo: '23 min ago',
    nextScheduledSync: 'in 37 min',
    sourceRef: 'cornerstone.sharepoint.com/sites/compliance/identity',
    region: 'us-east-1',
    documentsPreview: [
      { title: 'Knowledge-based authentication procedure', pages: 5, lastUpdated: '2026-05-20' },
      { title: 'Step-up identity verification matrix', pages: 3, lastUpdated: '2026-05-14' },
      { title: 'CIP & KYC compliance reference', pages: 14, lastUpdated: '2026-04-29' },
    ],
    flags: [
      {
        severity: 'suggestion',
        title: 'Document references joint-applicant handling but is not paginated for it',
        detail: 'Apps may have trouble citing the specific passage. Consider adding a heading anchor.',
      },
    ],
  },
  {
    id: 'kb_cornerstone_card_faq',
    name: 'Cornerstone Card Services FAQ',
    mode: 'crawl',
    scope: 'project',
    projectId: 'proj_card_services',
    status: 'active',
    documents: 38,
    chunks: 198,
    appsConsuming: 1,
    appsConsumingIds: ['app_card_dispute_triage'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['member-facing', 'card-services', 'faq'],
    sensitiveTags: [],
    refresh: 'pull',
    refreshCadence: 'Daily',
    lastSyncedAgo: '6 hr ago',
    nextScheduledSync: 'in 18 hr',
    sourceRef: 'cornerstonefcu.org/help/cards/*',
  },
  {
    id: 'kb_account_opening_disclosures',
    name: 'Account opening disclosures',
    mode: 'connector',
    provider: 'SharePoint',
    scope: 'project',
    projectId: 'proj_member_onboarding',
    status: 'active',
    documents: 19,
    chunks: 220,
    appsConsuming: 1,
    appsConsumingIds: ['app_account_opening'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['reg-d', 'disclosures', 'onboarding'],
    sensitiveTags: [],
    refresh: 'pull',
    refreshCadence: 'Every 1 hour',
    lastSyncedAgo: '42 min ago',
    sourceRef: 'cornerstone.sharepoint.com/sites/aos/disclosures',
  },
  {
    id: 'kb_hardship_programs',
    name: 'Hardship programs',
    mode: 'connector',
    provider: 'Confluence',
    scope: 'project',
    projectId: 'proj_collections',
    status: 'stale',
    documents: 14,
    chunks: 98,
    appsConsuming: 1,
    appsConsumingIds: ['app_hardship_assist'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['hardship', 'collections', 'payment-plans'],
    sensitiveTags: [],
    refresh: 'pull',
    refreshCadence: 'Daily',
    lastSyncedAgo: '34 days ago',
    sourceRef: 'cornerstone.atlassian.net/wiki/spaces/COLL/hardship',
    flags: [
      {
        severity: 'warning',
        title: 'Source last updated 34 days ago — past your staleness threshold (30 days)',
        detail:
          'The platform flagged this source as stale. Dependent apps may be operating with outdated guidance.',
      },
    ],
  },
  {
    id: 'kb_ffiec_fraud_guidance',
    name: 'FFIEC fraud guidance',
    mode: 'upload',
    scope: 'tenant',
    status: 'active',
    documents: 3,
    chunks: 48,
    appsConsuming: 1,
    appsConsumingIds: ['app_fraud_triage'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['fraud', 'ffiec', 'regulatory'],
    sensitiveTags: ['regulator-only'],
    refresh: 'manual',
    lastSyncedAgo: '9 days ago',
    sourceRef: 'Uploaded files',
  },
  {
    id: 'kb_tcpa_outbound',
    name: 'TCPA outbound rules',
    mode: 'authored',
    scope: 'tenant',
    status: 'active',
    documents: 11,
    chunks: 62,
    appsConsuming: 1,
    appsConsumingIds: ['app_hardship_assist'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['tcpa', 'sms', 'outbound', 'compliance'],
    sensitiveTags: [],
    refresh: 'manual',
    lastSyncedAgo: '3 days ago',
    sourceRef: 'In-platform authored',
    documentsPreview: [
      { title: 'TCPA opt-in language for SMS', lastUpdated: '2026-05-25' },
      { title: 'Outbound calling hours by state', lastUpdated: '2026-05-21' },
      { title: '10DLC registration FAQs', lastUpdated: '2026-05-15' },
    ],
  },
  {
    id: 'kb_loan_product_catalog',
    name: 'Loan product catalog',
    mode: 'connector',
    provider: 'Salesforce Knowledge',
    scope: 'project',
    projectId: 'proj_lending',
    status: 'syncing',
    documents: 47,
    chunks: 312,
    appsConsuming: 1,
    appsConsumingIds: ['app_loan_intake'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['lending', 'products', 'rates'],
    sensitiveTags: [],
    refresh: 'pull',
    refreshCadence: 'Every 15 min',
    lastSyncedAgo: 'now',
    sourceRef: 'cornerstone.lightning.force.com/knowledge',
  },
  {
    id: 'kb_legacy_intranet',
    name: 'Legacy intranet sync',
    mode: 'api',
    scope: 'tenant',
    status: 'error',
    documents: 0,
    chunks: 0,
    appsConsuming: 0,
    appsConsumingIds: [],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['legacy', 'pending'],
    sensitiveTags: [],
    refresh: 'push',
    lastSyncedAgo: '3 hr ago',
    sourceRef: 'api://intranet.cornerstone.cu/push',
    flags: [
      {
        severity: 'blocker',
        title: 'Sync failed: HTTP 401 from legacy intranet',
        detail:
          'API key may have rotated. Cycle the credential under Settings → Models & integrations.',
      },
    ],
  },
  {
    id: 'kb_old_hardship_faq',
    name: 'Old hardship FAQ',
    mode: 'connector',
    provider: 'Confluence',
    scope: 'project',
    projectId: 'proj_collections',
    status: 'deprecated',
    documents: 6,
    chunks: 28,
    appsConsuming: 0,
    appsConsumingIds: [],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['hardship', 'deprecated'],
    sensitiveTags: [],
    refresh: 'manual',
    lastSyncedAgo: '47 days ago',
    sourceRef: 'cornerstone.atlassian.net/wiki/spaces/COLL/legacy-hardship-faq',
  },
  {
    id: 'kb_google_drive_training',
    name: 'Member services training',
    mode: 'connector',
    provider: 'Google Drive',
    scope: 'tenant',
    status: 'active',
    documents: 28,
    chunks: 240,
    appsConsuming: 2,
    appsConsumingIds: ['app_card_dispute_triage', 'app_account_opening'],
    ownerInitials: 'JC',
    ownerName: 'Jordan Chen',
    tags: ['training', 'member-services'],
    sensitiveTags: [],
    refresh: 'pull',
    refreshCadence: 'Daily',
    lastSyncedAgo: '4 hr ago',
    sourceRef: 'drive.google.com/drive/folders/0BxYz...',
  },
];

export const knowledgeStats = {
  total: knowledgeSources.length,
  documents: knowledgeSources.reduce((sum, s) => sum + s.documents, 0),
  chunks: knowledgeSources.reduce((sum, s) => sum + s.chunks, 0),
  lastSyncAgo: '2 min ago',
};

export function getKnowledgeSourceById(id: string): KnowledgeSource | undefined {
  return knowledgeSources.find((s) => s.id === id);
}

// For Add Source dialog mode chooser
export const ingestionModes: {
  id: KnowledgeMode;
  label: string;
  description: string;
}[] = [
  {
    id: 'upload',
    label: 'Upload file(s)',
    description: 'PDF, DOCX, MD, HTML, TXT, XLSX, PPTX. Suited to policy snapshots and one-time uploads.',
  },
  {
    id: 'connector',
    label: 'Connect a service',
    description:
      'Confluence, SharePoint, Salesforce Knowledge, Zendesk Guide, Google Drive, OneDrive, Box, ServiceNow, Notion, Bloomfire, Guru, NetDocuments, iManage.',
  },
  {
    id: 'crawl',
    label: 'Crawl a URL',
    description: 'Public KB, member portal pages, policy pages. Schedule re-crawls; robots.txt respected.',
  },
  {
    id: 'authored',
    label: 'Author in-platform',
    description: 'FAQ entries, glossary terms, policy snippets — typed directly.',
  },
  {
    id: 'api',
    label: 'API push',
    description: 'For CU IT teams to push from custom systems. Idempotent upsert by external ID.',
  },
];

export const connectorProviders = [
  'Confluence',
  'SharePoint',
  'Salesforce Knowledge',
  'Zendesk Guide',
  'Google Drive',
  'OneDrive',
  'Box',
  'ServiceNow',
  'Notion',
  'Bloomfire',
  'Guru',
  'NetDocuments',
  'iManage',
];
