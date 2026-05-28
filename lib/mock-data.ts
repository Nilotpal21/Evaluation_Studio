export type AgentStatus = 'active' | 'paused' | 'draft' | 'error';

export interface Project {
  id: string;
  name: string;
  description: string;
  agents: number;
  runs24h: number;
  successRate: number;
  status: AgentStatus;
  updatedAt: string;
  ownerInitials: string;
}

export interface ActivityEvent {
  id: string;
  agent: string;
  project: string;
  event: 'completed' | 'failed' | 'started' | 'paused';
  durationMs: number;
  user: string;
  ago: string;
}

export const projects: Project[] = [
  {
    id: 'p_01',
    name: 'support-triage',
    description: 'Routes inbound support tickets to the right agent based on intent and SLA.',
    agents: 7,
    runs24h: 4823,
    successRate: 98.4,
    status: 'active',
    updatedAt: '2026-05-27',
    ownerInitials: 'NP',
  },
  {
    id: 'p_02',
    name: 'invoice-extractor',
    description: 'Multimodal pipeline that parses vendor invoices into structured rows.',
    agents: 3,
    runs24h: 1140,
    successRate: 94.1,
    status: 'active',
    updatedAt: '2026-05-26',
    ownerInitials: 'AS',
  },
  {
    id: 'p_03',
    name: 'lead-enrichment',
    description: 'Enriches new CRM leads with firmographic data from a dozen sources.',
    agents: 5,
    runs24h: 2407,
    successRate: 91.7,
    status: 'active',
    updatedAt: '2026-05-25',
    ownerInitials: 'KM',
  },
  {
    id: 'p_04',
    name: 'voice-concierge',
    description: 'Twilio-driven voice assistant for hotel booking workflows.',
    agents: 2,
    runs24h: 318,
    successRate: 89.2,
    status: 'paused',
    updatedAt: '2026-05-24',
    ownerInitials: 'JT',
  },
  {
    id: 'p_05',
    name: 'rag-knowledge-bot',
    description: 'Internal knowledge assistant grounded in 14k engineering docs.',
    agents: 4,
    runs24h: 962,
    successRate: 96.0,
    status: 'active',
    updatedAt: '2026-05-23',
    ownerInitials: 'RM',
  },
  {
    id: 'p_06',
    name: 'eval-harness',
    description: 'Continuous evaluation harness running golden datasets on every PR.',
    agents: 1,
    runs24h: 73,
    successRate: 100,
    status: 'draft',
    updatedAt: '2026-05-22',
    ownerInitials: 'NP',
  },
];

export const activity: ActivityEvent[] = [
  {
    id: 'a1',
    agent: 'classify-intent',
    project: 'support-triage',
    event: 'completed',
    durationMs: 412,
    user: 'webhook',
    ago: '12s ago',
  },
  {
    id: 'a2',
    agent: 'extract-line-items',
    project: 'invoice-extractor',
    event: 'completed',
    durationMs: 2880,
    user: 'cron',
    ago: '38s ago',
  },
  {
    id: 'a3',
    agent: 'enrich-from-clearbit',
    project: 'lead-enrichment',
    event: 'failed',
    durationMs: 5210,
    user: 'webhook',
    ago: '1m ago',
  },
  {
    id: 'a4',
    agent: 'verify-pii-removal',
    project: 'support-triage',
    event: 'completed',
    durationMs: 198,
    user: 'webhook',
    ago: '2m ago',
  },
  {
    id: 'a5',
    agent: 'transcribe-call',
    project: 'voice-concierge',
    event: 'paused',
    durationMs: 0,
    user: 'NP',
    ago: '4m ago',
  },
  {
    id: 'a6',
    agent: 'rerank-results',
    project: 'rag-knowledge-bot',
    event: 'completed',
    durationMs: 644,
    user: 'webhook',
    ago: '6m ago',
  },
  {
    id: 'a7',
    agent: 'classify-intent',
    project: 'support-triage',
    event: 'completed',
    durationMs: 380,
    user: 'webhook',
    ago: '7m ago',
  },
  {
    id: 'a8',
    agent: 'route-to-team',
    project: 'support-triage',
    event: 'started',
    durationMs: 0,
    user: 'webhook',
    ago: '8m ago',
  },
];

export const runsByHour: { hour: string; success: number; failure: number }[] = [
  { hour: '14:00', success: 320, failure: 4 },
  { hour: '15:00', success: 412, failure: 7 },
  { hour: '16:00', success: 488, failure: 9 },
  { hour: '17:00', success: 519, failure: 12 },
  { hour: '18:00', success: 612, failure: 8 },
  { hour: '19:00', success: 707, failure: 15 },
  { hour: '20:00', success: 643, failure: 11 },
  { hour: '21:00', success: 588, failure: 6 },
  { hour: '22:00', success: 471, failure: 5 },
  { hour: '23:00', success: 388, failure: 3 },
  { hour: '00:00', success: 295, failure: 2 },
  { hour: '01:00', success: 244, failure: 1 },
];

export const kpis = {
  activeAgents: 22,
  runs24h: 9723,
  successRate: 96.4,
  avgLatencyMs: 814,
};

export const currentUser = {
  name: 'Nilotpal',
  email: 'nilotpal.prksh@gmail.com',
  org: 'Kore Studio',
  initials: 'NP',
};
