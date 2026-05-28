import type { EvalCategoryBrief } from './review-studio';

export interface EvalSourceStats {
  count: number;
  passed: number;
}

export interface EvalSources {
  preBuiltScenarios: EvalSourceStats;
  sopDerived: EvalSourceStats;
  userDefined: EvalSourceStats;
}

export interface EvalCategoryDetail extends EvalCategoryBrief {
  examplesPassed: number;
  examplesFailed: number;
  prevScore?: number;
  failingExamples?: {
    id: string;
    intent: string;
    expected: string;
    actual: string;
    why: string;
  }[];
}

export interface EvalTrendPoint {
  /** ISO date */
  date: string;
  score: number;
  trigger: 'manual' | 'auto_on_edit' | 'scheduled' | 'continuous';
}

export interface EvalReport {
  appId: string;
  runNumber: number;
  ranAgo: string;
  trigger: 'manual' | 'auto_on_edit' | 'scheduled' | 'continuous';
  overallScore: number;
  prevOverallScore: number | null;
  delta: number;
  trend: 'up' | 'flat' | 'down';
  sources: EvalSources;
  categories: EvalCategoryDetail[];
  trend30Day: EvalTrendPoint[];
  citationCoverage: number;
  topUsedSources: { name: string; uses: number }[];
  sourceHealth: { active: number; stale: number; deprecated: number };
}

function buildTrend(
  endScore: number,
  range: number,
  drop?: { atIdx: number; size: number },
): EvalTrendPoint[] {
  const points: EvalTrendPoint[] = [];
  const today = new Date('2026-05-28');
  for (let i = 0; i < 30; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() - (29 - i));
    let s = endScore - range + Math.round(((Math.sin(i * 0.7) + 1) / 2) * range);
    if (i === 29) s = endScore;
    if (drop && i >= drop.atIdx && i < drop.atIdx + 3) {
      s -= drop.size;
    }
    points.push({
      date: date.toISOString().slice(0, 10),
      score: Math.max(50, Math.min(100, s)),
      trigger: i === 29 ? 'auto_on_edit' : i % 3 === 0 ? 'continuous' : 'scheduled',
    });
  }
  return points;
}

const cardDispute: EvalReport = {
  appId: 'app_card_dispute_triage',
  runNumber: 14,
  ranAgo: '14 min ago',
  trigger: 'auto_on_edit',
  overallScore: 94,
  prevOverallScore: 91.6,
  delta: 2.4,
  trend: 'up',
  sources: {
    preBuiltScenarios: { count: 412, passed: 392 },
    sopDerived: { count: 87, passed: 81 },
    userDefined: { count: 14, passed: 13 },
  },
  categories: [
    {
      name: 'Intent coverage',
      score: 91,
      prevScore: 91,
      trend: 'flat',
      examplesPassed: 67,
      examplesFailed: 7,
      failingExamples: [
        {
          id: 'fx_cd_ic_1',
          intent: 'Member calls about a card charge that turned out to be a recurring subscription',
          expected: 'Ask one clarifying question, then route to "subscription review"',
          actual: 'Opened Reg E dispute case immediately',
          why: 'The SOP does not cover the subscription-recognition case explicitly; the app defaulted to dispute flow.',
        },
        {
          id: 'fx_cd_ic_2',
          intent: 'Member opens with ambiguous "something is wrong with my card"',
          expected: 'Ask whether the issue is unauthorized charge vs lock/replacement',
          actual: 'Routed to dispute flow without disambiguation',
          why: 'No clarifying-question guardrail in place before Account Services sub-agent runs.',
        },
      ],
    },
    {
      name: 'Member authentication',
      score: 96,
      prevScore: 96,
      trend: 'flat',
      examplesPassed: 71,
      examplesFailed: 3,
    },
    {
      name: 'Reg E disclosure',
      score: 94,
      prevScore: 89,
      trend: 'up',
      examplesPassed: 65,
      examplesFailed: 4,
    },
    {
      name: 'Escalation timing',
      score: 92,
      prevScore: 92,
      trend: 'flat',
      examplesPassed: 58,
      examplesFailed: 5,
    },
    {
      name: 'Citation accuracy',
      score: 96,
      prevScore: 95,
      trend: 'up',
      examplesPassed: 76,
      examplesFailed: 3,
    },
    {
      name: 'Task creation accuracy',
      score: 93,
      prevScore: 92,
      trend: 'up',
      examplesPassed: 62,
      examplesFailed: 4,
    },
  ],
  trend30Day: buildTrend(94, 6),
  citationCoverage: 96,
  topUsedSources: [
    { name: 'Reg E playbook', uses: 412 },
    { name: 'Card dispute disclosures', uses: 310 },
    { name: 'Cornerstone FAQ', uses: 98 },
    { name: 'Member identity policy', uses: 76 },
  ],
  sourceHealth: { active: 4, stale: 0, deprecated: 0 },
};

const accountOpening: EvalReport = {
  appId: 'app_account_opening',
  runNumber: 9,
  ranAgo: '1 hr ago',
  trigger: 'scheduled',
  overallScore: 91,
  prevOverallScore: 90,
  delta: 1.2,
  trend: 'up',
  sources: {
    preBuiltScenarios: { count: 220, passed: 205 },
    sopDerived: { count: 64, passed: 58 },
    userDefined: { count: 8, passed: 8 },
  },
  categories: [
    {
      name: 'Product matching',
      score: 88,
      prevScore: 86,
      trend: 'up',
      examplesPassed: 41,
      examplesFailed: 5,
      failingExamples: [
        {
          id: 'fx_ao_pm_1',
          intent: 'Joint applicant with one new and one existing member',
          expected: 'Route to joint-application flow',
          actual: 'Treated as two separate primary applications',
          why: 'Joint applicant handling is referenced in the SOP but not explicitly scripted.',
        },
      ],
    },
    {
      name: 'Disclosure delivery',
      score: 90,
      prevScore: 90,
      trend: 'flat',
      examplesPassed: 48,
      examplesFailed: 5,
    },
    {
      name: 'Identity verification',
      score: 95,
      prevScore: 94,
      trend: 'up',
      examplesPassed: 56,
      examplesFailed: 3,
    },
    {
      name: 'Task creation',
      score: 92,
      prevScore: 91,
      trend: 'up',
      examplesPassed: 46,
      examplesFailed: 4,
    },
    {
      name: 'Citation accuracy',
      score: 94,
      prevScore: 92,
      trend: 'up',
      examplesPassed: 60,
      examplesFailed: 4,
    },
  ],
  trend30Day: buildTrend(91, 5),
  citationCoverage: 92,
  topUsedSources: [
    { name: 'Account opening disclosures', uses: 268 },
    { name: 'Product catalog', uses: 184 },
    { name: 'KYC and identity policy', uses: 92 },
  ],
  sourceHealth: { active: 5, stale: 0, deprecated: 0 },
};

const fraud: EvalReport = {
  appId: 'app_fraud_triage',
  runNumber: 6,
  ranAgo: '6 hr ago',
  trigger: 'continuous',
  overallScore: 96,
  prevOverallScore: 95.2,
  delta: 0.8,
  trend: 'up',
  sources: {
    preBuiltScenarios: { count: 180, passed: 173 },
    sopDerived: { count: 50, passed: 48 },
    userDefined: { count: 6, passed: 6 },
  },
  categories: [
    {
      name: 'Fraud signal detection',
      score: 98,
      prevScore: 97,
      trend: 'up',
      examplesPassed: 49,
      examplesFailed: 1,
    },
    {
      name: 'Identity verification',
      score: 96,
      prevScore: 96,
      trend: 'flat',
      examplesPassed: 47,
      examplesFailed: 2,
    },
    {
      name: 'Escalation routing',
      score: 95,
      prevScore: 94,
      trend: 'up',
      examplesPassed: 45,
      examplesFailed: 2,
      failingExamples: [
        {
          id: 'fx_fr_er_1',
          intent: 'Member confirms transaction but suspects card cloning',
          expected: 'Route to fraud operations with card-cloning context',
          actual: 'Routed to general escalation queue',
          why: 'No explicit routing rule for "card cloning suspected but transaction confirmed" case.',
        },
      ],
    },
    {
      name: 'Member language',
      score: 94,
      prevScore: 93,
      trend: 'up',
      examplesPassed: 49,
      examplesFailed: 3,
    },
    {
      name: 'PII handling',
      score: 100,
      prevScore: 100,
      trend: 'flat',
      examplesPassed: 51,
      examplesFailed: 0,
    },
  ],
  trend30Day: buildTrend(96, 4),
  citationCoverage: 98,
  topUsedSources: [
    { name: 'Fraud detection patterns', uses: 173 },
    { name: 'FFIEC fraud guidance', uses: 64 },
    { name: 'Member identity policy', uses: 41 },
  ],
  sourceHealth: { active: 4, stale: 0, deprecated: 0 },
};

const hardship: EvalReport = {
  appId: 'app_hardship_assist',
  runNumber: 11,
  ranAgo: '20 hr ago',
  trigger: 'scheduled',
  overallScore: 88,
  prevOverallScore: 91.1,
  delta: -3.1,
  trend: 'down',
  sources: {
    preBuiltScenarios: { count: 140, passed: 123 },
    sopDerived: { count: 42, passed: 36 },
    userDefined: { count: 5, passed: 4 },
  },
  categories: [
    {
      name: 'Hardship eligibility logic',
      score: 78,
      prevScore: 82,
      trend: 'down',
      examplesPassed: 27,
      examplesFailed: 8,
      failingExamples: [
        {
          id: 'fx_hs_he_1',
          intent: 'Member requests hardship plan after 2 missed payments without documentation',
          expected: 'Collect income-loss documentation before drafting plan',
          actual: 'Drafted plan without documentation step',
          why: 'SOP §4 calls for documentation step but Account Services sub-agent\'s flow skipped it.',
        },
        {
          id: 'fx_hs_he_2',
          intent: 'Member with co-borrower mentions hardship',
          expected: 'Confirm co-borrower consent before drafting plan',
          actual: 'Drafted plan against primary borrower only',
          why: 'Co-borrower handling not explicitly defined in the SOP.',
        },
      ],
    },
    {
      name: 'TCPA-safe outbound',
      score: 86,
      prevScore: 84,
      trend: 'up',
      examplesPassed: 34,
      examplesFailed: 6,
    },
    {
      name: 'Escalation timing',
      score: 88,
      prevScore: 88,
      trend: 'flat',
      examplesPassed: 36,
      examplesFailed: 5,
    },
    {
      name: 'Citation accuracy',
      score: 92,
      prevScore: 90,
      trend: 'up',
      examplesPassed: 39,
      examplesFailed: 4,
    },
    {
      name: 'Member language',
      score: 90,
      prevScore: 89,
      trend: 'up',
      examplesPassed: 37,
      examplesFailed: 4,
    },
  ],
  trend30Day: buildTrend(88, 8, { atIdx: 23, size: 4 }),
  citationCoverage: 89,
  topUsedSources: [
    { name: 'Hardship programs', uses: 96 },
    { name: 'Collections compliance', uses: 72 },
    { name: 'TCPA outbound rules', uses: 48 },
  ],
  sourceHealth: { active: 3, stale: 1, deprecated: 0 },
};

const loan: EvalReport = {
  appId: 'app_loan_intake',
  runNumber: 1,
  ranAgo: '2 days ago',
  trigger: 'manual',
  overallScore: 79,
  prevOverallScore: null,
  delta: 0,
  trend: 'flat',
  sources: {
    preBuiltScenarios: { count: 95, passed: 78 },
    sopDerived: { count: 38, passed: 28 },
    userDefined: { count: 0, passed: 0 },
  },
  categories: [
    {
      name: 'Rate-language compliance',
      score: 75,
      trend: 'down',
      examplesPassed: 22,
      examplesFailed: 8,
      failingExamples: [
        {
          id: 'fx_ln_rl_1',
          intent: 'Member asks "what rate will I get?"',
          expected: 'Reply with indicative range subject to underwriting',
          actual: 'Quoted advertised best rate as expected rate',
          why: 'Rate-language guardrail not active; the Loan sub-agent committed to a final-feeling quote.',
        },
      ],
    },
    {
      name: 'Eligibility pre-check',
      score: 82,
      trend: 'flat',
      examplesPassed: 28,
      examplesFailed: 6,
    },
    {
      name: 'Identity verification',
      score: 91,
      trend: 'up',
      examplesPassed: 32,
      examplesFailed: 3,
    },
    {
      name: 'Disclosure delivery',
      score: 80,
      trend: 'flat',
      examplesPassed: 26,
      examplesFailed: 6,
    },
    {
      name: 'Intent coverage',
      score: 78,
      trend: 'flat',
      examplesPassed: 24,
      examplesFailed: 7,
    },
  ],
  trend30Day: [
    {
      date: '2026-05-26',
      score: 79,
      trigger: 'manual',
    },
  ],
  citationCoverage: 84,
  topUsedSources: [
    { name: 'Loan product catalog', uses: 52 },
    { name: 'Underwriting eligibility guidelines', uses: 28 },
  ],
  sourceHealth: { active: 3, stale: 0, deprecated: 0 },
};

const reports: Record<string, EvalReport> = {
  app_card_dispute_triage: cardDispute,
  app_account_opening: accountOpening,
  app_fraud_triage: fraud,
  app_hardship_assist: hardship,
  app_loan_intake: loan,
};

export function getEvalReport(appId: string): EvalReport {
  return reports[appId] ?? cardDispute;
}
