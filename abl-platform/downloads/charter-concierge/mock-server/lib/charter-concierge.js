const FIXED_NOW = new Date('2026-04-18T00:00:00.000Z');
const SELF_SERVICE_CREDIT_LIMIT = 50;

const OFFER_CATALOG = [
  {
    offer_id: 'SP1-300-1L',
    name: 'Spectrum One 300 + 1 Unlimited Line',
    services: ['Internet 300', 'Advanced WiFi', '1 Mobile Line'],
    monthly_estimate: 55,
    one_time_fee_estimate: 30,
    fit: 'Great for streaming, school, and light remote work.',
  },
  {
    offer_id: 'SP1-GIG-2L',
    name: 'Spectrum One Gig + 2 Unlimited Lines',
    services: ['Gig Internet', 'Advanced WiFi', '2 Mobile Lines'],
    monthly_estimate: 95,
    one_time_fee_estimate: 30,
    fit: 'Best for heavy home WiFi, gaming, and multiple high-usage devices.',
  },
  {
    offer_id: 'INT-500-WIFI',
    name: 'Internet 500 + Advanced WiFi',
    services: ['Internet 500', 'Advanced WiFi'],
    monthly_estimate: 70,
    one_time_fee_estimate: 30,
    fit: 'Strong internet-only recommendation with room for lots of devices.',
  },
  {
    offer_id: 'BIZ-1G',
    name: 'Spectrum Business Gig Starter',
    services: ['Business Internet Gig', 'Business WiFi', 'Voice Optional'],
    monthly_estimate: 140,
    one_time_fee_estimate: 50,
    fit: 'Business-oriented recommendation for work-first or office contexts.',
  },
];

const OFFER_DETAILS = {
  'SP1-300-1L': {
    baseMonthly: 55,
    installFee: 30,
    label: 'Spectrum One 300 + 1 Unlimited Line',
  },
  'SP1-GIG-2L': {
    baseMonthly: 95,
    installFee: 30,
    label: 'Spectrum One Gig + 2 Unlimited Lines',
  },
  'INT-500-WIFI': {
    baseMonthly: 70,
    installFee: 30,
    label: 'Internet 500 + Advanced WiFi',
  },
  'BIZ-1G': {
    baseMonthly: 140,
    installFee: 50,
    label: 'Spectrum Business Gig Starter',
  },
};

const SERVICE_POLICIES = {
  'mobile eligibility': {
    policy:
      'Mobile bundle recommendations assume the customer is pairing mobile with a qualifying internet relationship.',
    rationale:
      'The bundle economics and support path depend on converged connectivity, not mobile in isolation.',
    deterministic_boundary:
      'The assistant can explain the eligibility rule, but it cannot waive qualification requirements.',
  },
  'promo pricing': {
    policy:
      'Promotional pricing is treated as time-bounded and should be explained separately from ongoing monthly pricing.',
    rationale:
      'Customers need to know which part of the recommendation is stable and which part is promotional.',
    deterministic_boundary:
      'The assistant can summarize promo language, but it cannot promise pricing beyond the mocked recommendation window.',
  },
  'identity verification': {
    policy:
      'Sensitive mobile and account actions require a verified customer state before self-service can proceed.',
    rationale:
      'SIM changes, ports, and other account-sensitive actions create fraud risk when identity is uncertain.',
    deterministic_boundary:
      'The assistant cannot bypass verification or reclassify a sensitive request as low-risk.',
  },
  'billing credit': {
    policy:
      'Self-service goodwill credits are capped and larger requests move into a supervised billing review path.',
    rationale:
      'Credits are deterministic policy decisions, not ad hoc LLM judgments, especially for higher-value requests.',
    deterministic_boundary:
      'The assistant can apply only low-risk mock credits inside the ceiling. Requests above the ceiling must route to live support.',
  },
  'installation windows': {
    policy: 'Same-day installs and exact appointment guarantees require live support confirmation.',
    rationale: 'Scheduling availability depends on workforce and local market conditions.',
    deterministic_boundary:
      'The assistant can set expectations, but it cannot guarantee an install window on its own.',
  },
  general: {
    policy:
      'Charter Concierge can explain services, gather setup state, route billing work, and hand off to live support, but hard identity, serviceability, and credit-approval boundaries remain deterministic.',
    rationale:
      'Customers need clarity on what the assistant can explain versus what only a live support path can approve.',
    deterministic_boundary:
      'Exception paths always go to human support instead of being improvised by the model.',
  },
};

const ACCOUNT_DIRECTORY = {
  4782: {
    user_id: 'cust_55501',
    phone_of_record_masked: '***-***-4190',
    expected_otp: '384716',
    last_verified_at: '2026-01-10T11:04:00.000Z',
  },
  2719: {
    user_id: 'cust_81244',
    phone_of_record_masked: '***-***-2288',
    expected_otp: '271904',
    last_verified_at: '2026-04-10T09:15:00.000Z',
  },
  6631: {
    user_id: 'cust_33219',
    phone_of_record_masked: '***-***-6631',
    expected_otp: '663155',
    last_verified_at: '2026-02-01T18:20:00.000Z',
  },
};

const ACCOUNT_BY_USER = Object.fromEntries(
  Object.values(ACCOUNT_DIRECTORY).map((account) => [account.user_id, account]),
);

const BILLING_DATA = {
  cust_55501: {
    current: {
      total_due: 94.99,
      due_date: '2026-05-02',
      previous_balance: 0,
      daily_rate: 3.17,
      line_items: [
        { label: 'Spectrum One Gig', amount: 79.99 },
        { label: 'Advanced WiFi', amount: 10.0 },
        { label: '2 Unlimited Lines', amount: 5.0 },
      ],
    },
    payments: [
      { date: '2026-03-05', amount: 94.99, method: 'AutoPay card' },
      { date: '2026-02-05', amount: 92.49, method: 'AutoPay card' },
      { date: '2026-01-05', amount: 92.49, method: 'AutoPay card' },
    ],
    prior_goodwill_credits: 20,
  },
  cust_81244: {
    current: {
      total_due: 67.48,
      due_date: '2026-04-28',
      previous_balance: 12.5,
      daily_rate: 2.25,
      line_items: [
        { label: 'Internet 500', amount: 59.99 },
        { label: 'Advanced WiFi', amount: 7.49 },
      ],
    },
    payments: [
      { date: '2026-03-21', amount: 67.48, method: 'Bank draft' },
      { date: '2026-02-21', amount: 67.48, method: 'Bank draft' },
    ],
    prior_goodwill_credits: 0,
  },
  cust_33219: {
    current: {
      total_due: 121.35,
      due_date: '2026-05-10',
      previous_balance: 18.0,
      daily_rate: 4.05,
      line_items: [
        { label: 'Spectrum One 300', amount: 54.99 },
        { label: 'Advanced WiFi', amount: 10.0 },
        { label: '3 Unlimited Lines', amount: 38.0 },
        { label: 'Taxes and fees', amount: 18.36 },
      ],
    },
    payments: [
      { date: '2026-03-30', amount: 121.35, method: 'Saved card' },
      { date: '2026-02-28', amount: 118.1, method: 'Saved card' },
    ],
    prior_goodwill_credits: 45,
  },
};

function normalizeText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function normalizeLower(value, fallback = '') {
  return normalizeText(value, fallback).toLowerCase();
}

function normalizeUpper(value, fallback = '') {
  return normalizeText(value, fallback).toUpperCase();
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function daysSince(dateString) {
  if (!dateString) {
    return 999;
  }

  const parsed = new Date(dateString);
  const diffMs = FIXED_NOW.getTime() - parsed.getTime();
  return Math.max(0, Math.floor(diffMs / 86400000));
}

function searchServiceOffers(params = {}) {
  const address = normalizeText(params.service_address);
  const addressLower = address.toLowerCase();
  const internetNeed = normalizeLower(params.internet_need);
  const mobileLines = normalizeNumber(params.mobile_line_count);
  const bundleInterest = normalizeLower(params.bundle_interest, 'internet');

  const market = addressLower.includes('stamford')
    ? 'CT'
    : addressLower.includes('dallas')
      ? 'TX'
      : addressLower.includes('charlotte')
        ? 'NC'
        : addressLower.includes('los angeles')
          ? 'CA'
          : 'GENERAL';

  const serviceable = !addressLower.includes('unsupported') && !addressLower.includes('po box');

  let recommended = OFFER_CATALOG[0];

  if (bundleInterest.includes('business')) {
    recommended = OFFER_CATALOG[3];
  } else if (internetNeed.includes('gig') || internetNeed.includes('gaming') || mobileLines >= 2) {
    recommended = OFFER_CATALOG[1];
  } else if (bundleInterest.includes('mobile')) {
    recommended = OFFER_CATALOG[0];
  } else {
    recommended = OFFER_CATALOG[2];
  }

  const requiresHumanReview =
    !serviceable || mobileLines > 4 || bundleInterest.includes('business');

  return {
    status: serviceable ? 'offers_ready' : 'unsupported_market',
    market,
    recommended_offer_id: serviceable ? recommended.offer_id : '',
    offers: serviceable ? OFFER_CATALOG : [],
    requires_human_review: requiresHumanReview,
    serviceable,
  };
}

function assessRequestRisk(params = {}) {
  const requestType = normalizeLower(params.request_type, 'new_service');
  const authStatus = normalizeLower(params.auth_status, 'new_customer');
  const deviceAction = normalizeLower(params.device_action);
  const notesText = normalizeLower(params.freeform_notes);
  const notes = [];

  let allowed = true;
  let riskLevel = 'low';
  let requiresHumanReview = false;

  if (
    notesText.includes('sim swap without verification') ||
    notesText.includes('bypass identity') ||
    notesText.includes('stolen phone') ||
    notesText.includes('port a number not mine')
  ) {
    allowed = false;
    riskLevel = 'blocked';
    requiresHumanReview = true;
    notes.push('The request matches a blocked fraud or identity-evasion pattern.');
  }

  if (deviceAction.includes('sim') || deviceAction.includes('port')) {
    if (authStatus !== 'verified') {
      riskLevel = allowed ? 'high' : riskLevel;
      requiresHumanReview = true;
      notes.push('Sensitive mobile changes require a verified customer state.');
    }
  }

  if (requestType.includes('same_day_install')) {
    riskLevel = allowed ? 'medium' : riskLevel;
    requiresHumanReview = true;
    notes.push('Same-day install requests require live support confirmation.');
  }

  if (notes.length === 0) {
    notes.push('No deterministic fraud or support-lane flags were triggered.');
  }

  return {
    allowed,
    risk_level: riskLevel,
    requires_human_review: requiresHumanReview,
    notes,
  };
}

function lookupAccount(params = {}) {
  const last4 = normalizeText(params.account_last4);
  const account = ACCOUNT_DIRECTORY[last4];

  if (!account) {
    return {
      found: false,
      user_id: '',
      phone_of_record_masked: '',
    };
  }

  return {
    found: true,
    user_id: account.user_id,
    phone_of_record_masked: account.phone_of_record_masked,
  };
}

function checkRecentVerification(params = {}) {
  const userId = normalizeText(params.user_id);
  const account = ACCOUNT_BY_USER[userId];

  if (!account) {
    return {
      verified_recently: false,
      last_verified_at: '',
      days_since: 999,
    };
  }

  const days = daysSince(account.last_verified_at);

  return {
    verified_recently: days <= 30,
    last_verified_at: account.last_verified_at,
    days_since: days,
  };
}

function sendOtp(params = {}) {
  const userId = normalizeText(params.user_id);
  const account = ACCOUNT_BY_USER[userId];

  return {
    sent: Boolean(account),
    expires_in_seconds: 120,
  };
}

function verifyOtp(params = {}) {
  const userId = normalizeText(params.user_id);
  const code = normalizeText(params.code);
  const account = ACCOUNT_BY_USER[userId];

  if (!account) {
    return {
      valid: false,
      auth_token: '',
    };
  }

  const valid = code === account.expected_otp;

  return {
    valid,
    auth_token: valid ? `abl.tkn.${userId}.verified` : '',
  };
}

function lockSession(params = {}) {
  const userId = normalizeText(params.user_id);

  return {
    locked: userId.length > 0,
    unlock_at: '2026-04-19T00:00:00.000Z',
  };
}

function createPlanRecommendation(params = {}) {
  const offerId = normalizeUpper(params.offer_id);
  const mobileLineCount = normalizeNumber(params.mobile_line_count);
  const wifiNeed = normalizeLower(params.wifi_need);
  const tvInterest = params.tv_interest === true;
  const selected = OFFER_DETAILS[offerId];

  if (!selected) {
    return {
      status: 'missing_offer',
      plan_id: '',
      monthly_total: 0,
      install_fee: 0,
      promo_summary: '',
      requires_manual_review: false,
      line_items: [],
    };
  }

  const extraLines = Math.max(0, mobileLineCount - 1) * 20;
  const wifiAdjustment =
    wifiNeed.includes('large home') || wifiNeed.includes('lots of devices') ? 10 : 0;
  const tvAdjustment = tvInterest ? 25 : 0;
  const monthlyTotal = selected.baseMonthly + extraLines + wifiAdjustment + tvAdjustment;
  const requiresManualReview = offerId === 'BIZ-1G' || mobileLineCount > 4;

  return {
    status: 'ok',
    plan_id: `PLAN-${offerId}`,
    monthly_total: monthlyTotal,
    install_fee: selected.installFee,
    promo_summary: 'Mocked 12-month introductory recommendation window for the demo bundle.',
    requires_manual_review: requiresManualReview,
    line_items: [
      { label: 'Base package', amount: selected.baseMonthly, detail: selected.label },
      { label: 'Extra mobile lines', amount: extraLines },
      { label: 'Advanced WiFi fit adjustment', amount: wifiAdjustment },
      { label: 'TV or streaming package adjustment', amount: tvAdjustment },
    ],
  };
}

function validateSetupReadiness(params = {}) {
  const serviceCount = normalizeNumber(params.service_count);
  const mobileLines = normalizeNumber(params.mobile_lines_requested);
  const addressStatus = normalizeUpper(params.address_status, 'ADDR_PENDING');
  const modemStatus = normalizeUpper(params.modem_status, 'MODEM_UNKNOWN');
  const deviceStatus = normalizeUpper(params.device_status, 'DEVICE_UNKNOWN');
  const missing = [];

  if (serviceCount <= 0) {
    missing.push('selected service count');
  }
  if (addressStatus !== 'ADDR_VERIFIED') {
    missing.push('verified service address');
  }
  if (modemStatus !== 'MODEM_READY') {
    missing.push('ready modem or router state');
  }
  if (mobileLines > 0 && deviceStatus === 'DEVICE_UNKNOWN') {
    missing.push('mobile device activation state');
  }

  const requiresHumanReview = mobileLines > 0 && deviceStatus === 'DEVICE_PORTING';

  return {
    status: missing.length === 0 ? 'ready' : 'needs_follow_up',
    ready: missing.length === 0,
    missing_items: missing,
    summary:
      missing.length === 0
        ? 'All deterministic setup inputs are present for installation or activation readiness.'
        : 'The selected plan still has setup gaps that block deterministic readiness.',
    requires_human_review: requiresHumanReview,
  };
}

function lookupServicePolicy(params = {}) {
  const requestedTopic = normalizeLower(params.topic, 'general');
  const selected = SERVICE_POLICIES[requestedTopic] || SERVICE_POLICIES.general;

  return {
    topic: requestedTopic,
    policy: selected.policy,
    rationale: selected.rationale,
    deterministic_boundary: selected.deterministic_boundary,
  };
}

function getBill(params = {}) {
  const userId = normalizeText(params.user_id);
  const cycle = normalizeLower(params.cycle, 'current');
  const billing = BILLING_DATA[userId];
  const bill = billing?.[cycle];

  if (!bill) {
    return {
      status: 'not_found',
      total_due: 0,
      due_date: '',
      previous_balance: 0,
      daily_rate: 0,
      line_items: [],
    };
  }

  return {
    status: 'ok',
    total_due: bill.total_due,
    due_date: bill.due_date,
    previous_balance: bill.previous_balance,
    daily_rate: bill.daily_rate,
    line_items: bill.line_items,
  };
}

function getPaymentHistory(params = {}) {
  const userId = normalizeText(params.user_id);
  const lastN = normalizeNumber(params.last_n, 6);
  const billing = BILLING_DATA[userId];

  if (!billing) {
    return {
      payments: [],
      prior_goodwill_credits: 0,
    };
  }

  return {
    payments: billing.payments.slice(0, Math.max(0, lastN)),
    prior_goodwill_credits: billing.prior_goodwill_credits,
  };
}

function applyCredit(params = {}) {
  const userId = normalizeText(params.user_id);
  const amount = normalizeNumber(params.amount_usd);
  const reason = normalizeText(params.reason);
  const billing = BILLING_DATA[userId];

  if (!billing) {
    return {
      credit_id: '',
      applied: false,
      new_balance: 0,
      approval_required: false,
    };
  }

  if (amount > SELF_SERVICE_CREDIT_LIMIT) {
    return {
      credit_id: '',
      applied: false,
      new_balance: billing.current.total_due,
      approval_required: true,
    };
  }

  if (amount <= 0 || reason.length === 0) {
    return {
      credit_id: '',
      applied: false,
      new_balance: billing.current.total_due,
      approval_required: false,
    };
  }

  const newBalance = Number(Math.max(0, billing.current.total_due - amount).toFixed(2));

  return {
    credit_id: `CR-${userId.slice(-4)}-${Math.round(amount * 100)}`,
    applied: true,
    new_balance: newBalance,
    approval_required: false,
  };
}

function scheduleSupportCallback(params = {}) {
  const reason = normalizeLower(params.reason);
  const queue =
    reason.includes('identity') || reason.includes('fraud') || reason.includes('verification')
      ? 'fraud_support'
      : reason.includes('billing')
        ? 'billing_supervisor'
        : reason.includes('install') || reason.includes('activation')
          ? 'activation_support'
          : 'connectivity_care';

  const ticketId =
    queue === 'fraud_support'
      ? 'SUP-9104'
      : queue === 'activation_support'
        ? 'SUP-6221'
        : queue === 'billing_supervisor'
          ? 'SUP-4472'
          : 'SUP-3057';

  return {
    status: 'scheduled',
    callback_window: normalizeText(params.preferred_window, 'next available'),
    ticket_id: ticketId,
    queue,
  };
}

function getServiceBrief(params = {}) {
  const planId = normalizeUpper(params.plan_id);

  if (planId === 'PLAN-SP1-GIG-2L') {
    return {
      brief:
        'Gig internet, Advanced WiFi, and two mobile lines with a high-capacity home connectivity profile.',
      outage_note:
        'No specific outage is modeled in the demo; use the brief for current-service explanation only.',
      device_note:
        'Advanced WiFi fit is important because the recommendation assumed many devices or heavy usage.',
      next_actions: [
        'Verify setup readiness',
        'Confirm modem state',
        'Route material plan changes back to intake',
      ],
    };
  }

  if (planId === 'PLAN-SP1-300-1L') {
    return {
      brief:
        'Internet 300, Advanced WiFi, and one mobile line for a mainstream converged connectivity setup.',
      outage_note: 'No outage is modeled for this plan in the demo.',
      device_note:
        'One mobile line is included; sensitive mobile changes still require verified support paths.',
      next_actions: [
        'Verify address and equipment',
        'Confirm mobile device readiness',
        'Escalate if a sensitive account action appears',
      ],
    };
  }

  return {
    brief: 'Generic service brief for the Charter Concierge example.',
    outage_note: 'No special outage context is attached to this mocked plan.',
    device_note: 'Use normal troubleshooting and recommendation boundaries.',
    next_actions: [
      'Review current setup state',
      'Clarify whether the user wants advice or a material plan change',
      'Route material changes back to intake',
    ],
  };
}

function getHealth() {
  return {
    service: 'abl-charter-concierge-mock',
    status: 'ok',
    endpoints: [
      'search-service-offers',
      'assess-request-risk',
      'lookup-account',
      'check-recent-verification',
      'send-otp',
      'verify-otp',
      'lock-session',
      'create-plan-recommendation',
      'validate-setup-readiness',
      'lookup-service-policy',
      'get-bill',
      'get-payment-history',
      'apply-credit',
      'schedule-support-callback',
      'get-service-brief',
    ],
  };
}

module.exports = {
  applyCredit,
  assessRequestRisk,
  checkRecentVerification,
  createPlanRecommendation,
  getBill,
  getHealth,
  getPaymentHistory,
  getServiceBrief,
  lockSession,
  lookupAccount,
  lookupServicePolicy,
  scheduleSupportCallback,
  searchServiceOffers,
  sendOtp,
  validateSetupReadiness,
  verifyOtp,
};
