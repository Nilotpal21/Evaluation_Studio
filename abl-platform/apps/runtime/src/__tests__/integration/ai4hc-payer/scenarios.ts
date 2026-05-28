// apps/runtime/src/__tests__/e2e/ai4hc-payer/scenarios.ts

/**
 * AI4HC Payer Provider-Facing E2E Test Scenarios
 *
 * Each scenario targets a specific agent workflow path.
 * All scenarios are web-channel (provider portal).
 *
 * NOTE: Expectations accept BOTH auth-gated and already-authenticated paths
 * because the Kore.ai platform may reuse sessions across scenarios.
 */

export interface Turn {
  user: string;
  /** Keywords expected in the response */
  expectAny?: string[];
  /** Keywords that must NOT appear */
  expectNone?: string[];
  /** Expected agent routing (if detectable from SSE) */
  expectAgent?: string;
  /** Max acceptable response time in ms */
  maxTimeMs?: number;
}

export interface Scenario {
  name: string;
  description: string;
  turns: Turn[];
  /** Create fresh session for this scenario */
  freshSession: boolean;
  /** Tags for filtering: auth, plan, coverage, claim, greeting, farewell */
  tags: string[];
}

export const SCENARIOS: Scenario[] = [
  // ── S1: Pure Greeting ──
  {
    name: 'S1: Greeting Only',
    description:
      'Provider sends a greeting with no use case — expects welcome message without auth',
    freshSession: true,
    tags: ['greeting'],
    turns: [
      {
        user: 'Hello',
        expectAny: ['welcome', 'provider portal', 'help', 'assist', 'plan', 'coverage', 'claim'],
        maxTimeMs: 15000,
      },
    ],
  },

  // ── S2: Authentication with Provider ID ──
  {
    name: 'S2: Auth via Provider ID → Plan Info',
    description:
      'Provider asks for plan info → auth triggered → provides 9-digit Provider ID → confirms → authenticated → plan info',
    freshSession: true,
    tags: ['auth', 'plan'],
    turns: [
      {
        user: "I need to check a member's plan information",
        expectAny: [
          'authenticate',
          'Provider ID',
          'NPI',
          'verify',
          'identity',
          'Member ID',
          'provide',
        ],
        maxTimeMs: 30000,
      },
      {
        user: '485736201',
        expectAny: ['confirm', 'Provider ID', '485736201', 'correct', 'verify', 'plan', 'Member'],
        maxTimeMs: 30000,
      },
      {
        user: "Yes, that's correct",
        expectAny: [
          'authenticated',
          'success',
          'verified',
          'Member ID',
          'member',
          'provide',
          'plan',
        ],
        maxTimeMs: 30000,
      },
      {
        user: '7823564',
        expectAny: ['plan', 'deductible', 'coverage', 'effective', 'status', 'network'],
        expectAgent: 'Plan_Information_Agent',
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S3: Coverage Info Query ──
  {
    name: 'S3: Coverage Info Query',
    description:
      'Provider asks about coverage — may go through auth or directly if already authenticated',
    freshSession: true,
    tags: ['coverage'],
    turns: [
      {
        user: 'What services are covered for one of my patients?',
        expectAny: [
          'authenticate',
          'Provider ID',
          'NPI',
          'verify',
          'Member ID',
          'provide',
          'coverage',
        ],
        maxTimeMs: 30000,
      },
      {
        user: '7823564',
        expectAny: [
          'coverage',
          'copay',
          'coinsurance',
          'covered',
          'service',
          'plan',
          'confirm',
          'NPI',
          'Provider',
        ],
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S4: Plan Information — Deductible Query ──
  {
    name: 'S4: Plan Info — Deductible Query',
    description: 'Provider asks specifically about deductibles for a member',
    freshSession: true,
    tags: ['plan'],
    turns: [
      {
        user: 'I want to check the deductible status for a member',
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'Member ID', 'provide', 'deductible'],
        maxTimeMs: 30000,
      },
      {
        user: '7823564',
        expectAny: [
          'deductible',
          'in-network',
          'out-of-network',
          'met',
          'remaining',
          'total',
          'plan',
          'confirm',
          'Provider',
        ],
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S5: Claim Status Query ──
  {
    name: 'S5: Claim Status Query',
    description: 'Provider asks for claim status for a member',
    freshSession: true,
    tags: ['claim'],
    turns: [
      {
        user: 'I need to check claim status for a patient',
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'Member ID', 'provide', 'claim'],
        maxTimeMs: 30000,
      },
      {
        user: '7823566',
        expectAny: [
          'claim',
          'status',
          'amount',
          'date',
          'submitted',
          'paid',
          'denied',
          'confirm',
          'Provider',
        ],
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S6: Invalid Provider ID ──
  {
    name: 'S6: Invalid Provider ID Format',
    description: 'Provider gives wrong format ID — expects format error or Member ID prompt',
    freshSession: true,
    tags: ['auth', 'error'],
    turns: [
      {
        user: 'Check plan info for a member please',
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'Member ID', 'provide'],
        maxTimeMs: 30000,
      },
      {
        user: '12345',
        expectAny: [
          'invalid',
          'format',
          '9 digits',
          '10 digits',
          'Provider ID',
          'NPI',
          'plan',
          'member',
          'No active',
          'not found',
        ],
        maxTimeMs: 30000,
      },
    ],
  },

  // ── S7: Multi-Intent (Plan then Claim) ──
  {
    name: 'S7: Multi-Intent — Plan Info Then Claim Status',
    description: 'After getting plan info, provider asks about claims in same session',
    freshSession: true,
    tags: ['plan', 'claim', 'multi'],
    turns: [
      {
        user: 'I need plan information for a member',
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'Member ID', 'provide'],
        maxTimeMs: 30000,
      },
      {
        user: '7823564',
        expectAny: ['plan', 'deductible', 'coverage', 'effective', 'confirm', 'Provider'],
        maxTimeMs: 45000,
      },
      {
        user: 'Now show me claim status for member 7823566',
        expectAny: ['claim', 'status', 'amount', 'Member', 'provide'],
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S8: Coverage — Specific Service Query ──
  {
    name: 'S8: Coverage — Specific Service Inquiry',
    description: 'Provider asks if a specific service is covered',
    freshSession: true,
    tags: ['coverage'],
    turns: [
      {
        user: 'Is physical therapy covered for my patient?',
        expectAny: [
          'authenticate',
          'Provider ID',
          'NPI',
          'Member ID',
          'provide',
          'physical therapy',
          'coverage',
        ],
        maxTimeMs: 30000,
      },
      {
        user: '7823564',
        expectAny: [
          'physical therapy',
          'covered',
          'copay',
          'coinsurance',
          'prior auth',
          'coverage',
          'service',
          'plan',
          'confirm',
          'Provider',
        ],
        maxTimeMs: 45000,
      },
    ],
  },

  // ── S9: Farewell ──
  {
    name: 'S9: Farewell Flow',
    description: 'Provider says goodbye after completed interaction',
    freshSession: true,
    tags: ['farewell'],
    turns: [
      {
        user: 'Hello',
        expectAny: ['welcome', 'help', 'assist'],
        maxTimeMs: 15000,
      },
      {
        user: "That's all, thank you",
        expectAny: ['thank', 'great day', 'goodbye', 'welcome', 'glad', 'help'],
        maxTimeMs: 15000,
      },
    ],
  },

  // ── S10: Claim with Filters ──
  {
    name: 'S10: Claim Status with Date Filter',
    description: 'Provider asks for claims filtered by date',
    freshSession: true,
    tags: ['claim'],
    turns: [
      {
        user: 'I need to check claims for a patient',
        expectAny: ['authenticate', 'Provider ID', 'NPI', 'Member ID', 'provide', 'claim'],
        maxTimeMs: 30000,
      },
      {
        user: '7823566, I only need claims from January 2025',
        expectAny: ['claim', 'January', '2025', 'status', 'amount', 'confirm', 'Provider'],
        maxTimeMs: 45000,
      },
    ],
  },
];

export function getScenariosByTag(tag: string): Scenario[] {
  return SCENARIOS.filter((s) => s.tags.includes(tag));
}

export function getScenarioByName(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name.toLowerCase().includes(name.toLowerCase()));
}
