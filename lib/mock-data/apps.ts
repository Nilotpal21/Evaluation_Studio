export type AppStatus =
  | 'draft'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'deployed'
  | 'paused';

export type Channel = 'digital' | 'voice' | 'sms' | 'email';

export interface App {
  id: string;
  name: string;
  sopId: string;
  sopFilename: string;
  description: string;
  status: AppStatus;
  channels: Channel[];
  subAgents: string[];
  evaluationScore: number;
  evaluationTrend: 'up' | 'flat' | 'down';
  evaluationDelta: number;
  approvalsRequired: number;
  approvalsCompleted: number;
  conversations24h: number;
  tasksCompleted24h: number;
  escalations24h: number;
  guardrailTriggers24h: number;
  deployedAt: string | null;
  deployedVersion: number;
  lastEvaluatedAt: string;
  ownerInitials: string;
}

export const apps: App[] = [
  {
    id: 'app_card_dispute_triage',
    name: 'card-dispute-triage',
    sopId: 'sop_card_disputes',
    sopFilename: 'Card_Disputes_v3.2.pdf',
    description:
      'Triages inbound card-dispute inquiries, verifies member identity, and opens a Reg E case with the correct disclosure path.',
    status: 'deployed',
    channels: ['digital', 'voice'],
    subAgents: ['sa_member_auth', 'sa_account_services', 'sa_compliance'],
    evaluationScore: 94,
    evaluationTrend: 'up',
    evaluationDelta: 2.4,
    approvalsRequired: 2,
    approvalsCompleted: 2,
    conversations24h: 1240,
    tasksCompleted24h: 1102,
    escalations24h: 38,
    guardrailTriggers24h: 4,
    deployedAt: '2026-05-22',
    deployedVersion: 3,
    lastEvaluatedAt: '14 min ago',
    ownerInitials: 'DU',
  },
  {
    id: 'app_account_opening',
    name: 'account-opening-assistant',
    sopId: 'sop_acct_opening',
    sopFilename: 'AOS_Onboarding.pdf',
    description:
      'New-member account opening flow: identity verification, product selection, disclosure delivery, task creation.',
    status: 'deployed',
    channels: ['digital', 'sms'],
    subAgents: ['sa_member_auth', 'sa_account_services', 'sa_knowledge'],
    evaluationScore: 91,
    evaluationTrend: 'up',
    evaluationDelta: 1.2,
    approvalsRequired: 2,
    approvalsCompleted: 2,
    conversations24h: 412,
    tasksCompleted24h: 380,
    escalations24h: 18,
    guardrailTriggers24h: 1,
    deployedAt: '2026-05-15',
    deployedVersion: 2,
    lastEvaluatedAt: '1 hr ago',
    ownerInitials: 'DU',
  },
  {
    id: 'app_fraud_triage',
    name: 'fraud-triage',
    sopId: 'sop_fraud_triage',
    sopFilename: 'Fraud_Triage_v1.1.pdf',
    description:
      'Detects suspicious-activity signals during a member conversation, runs fraud scoring, escalates to fraud ops with full context.',
    status: 'approved',
    channels: ['digital', 'voice'],
    subAgents: ['sa_member_auth', 'sa_account_services', 'sa_compliance'],
    evaluationScore: 96,
    evaluationTrend: 'up',
    evaluationDelta: 0.8,
    approvalsRequired: 2,
    approvalsCompleted: 2,
    conversations24h: 0,
    tasksCompleted24h: 0,
    escalations24h: 0,
    guardrailTriggers24h: 0,
    deployedAt: null,
    deployedVersion: 0,
    lastEvaluatedAt: '6 hr ago',
    ownerInitials: 'DU',
  },
  {
    id: 'app_hardship_assist',
    name: 'hardship-assist',
    sopId: 'sop_hardship',
    sopFilename: 'Hardship_Plans_2026.docx',
    description:
      'Walks members through hardship eligibility, captures inputs, drafts the payment-plan task for back-office approval.',
    status: 'in_review',
    channels: ['digital'],
    subAgents: ['sa_member_auth', 'sa_collections', 'sa_financial_wellness'],
    evaluationScore: 88,
    evaluationTrend: 'flat',
    evaluationDelta: 0,
    approvalsRequired: 2,
    approvalsCompleted: 1,
    conversations24h: 0,
    tasksCompleted24h: 0,
    escalations24h: 0,
    guardrailTriggers24h: 0,
    deployedAt: null,
    deployedVersion: 0,
    lastEvaluatedAt: '20 hr ago',
    ownerInitials: 'DU',
  },
  {
    id: 'app_loan_intake',
    name: 'loan-application-intake',
    sopId: 'sop_loans',
    sopFilename: 'Loan_Intake_Draft.pdf',
    description:
      'Captures loan-application intent, runs eligibility pre-check, schedules underwriter handoff.',
    status: 'draft',
    channels: ['digital'],
    subAgents: ['sa_loans', 'sa_member_auth'],
    evaluationScore: 79,
    evaluationTrend: 'flat',
    evaluationDelta: 0,
    approvalsRequired: 2,
    approvalsCompleted: 0,
    conversations24h: 0,
    tasksCompleted24h: 0,
    escalations24h: 0,
    guardrailTriggers24h: 0,
    deployedAt: null,
    deployedVersion: 0,
    lastEvaluatedAt: '2 days ago',
    ownerInitials: 'DU',
  },
];

export const platformKPIs = {
  activeApps: 3,
  conversations24h: 1652,
  conversations24hDelta: '+8.2% vs yesterday',
  avgEvaluationScore: 92.3,
  avgEvaluationScoreDelta: '+0.6 vs 7d avg',
  tasksCompleted24h: 1482,
  tasksCompleted24hOfStarted: '94.0% of started',
  activeAppsDelta: '+1 this week',
};
