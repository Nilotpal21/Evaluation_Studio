const {
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
} = require('../lib/charter-concierge');
const {
  readJsonBody,
  sendBadRequest,
  sendJson,
  sendMethodNotAllowed,
  sendNoContent,
} = require('../lib/http');

const ENDPOINTS = {
  'apply-credit': {
    method: 'POST',
    fn: applyCredit,
  },
  'assess-request-risk': {
    method: 'POST',
    fn: assessRequestRisk,
  },
  'check-recent-verification': {
    method: 'POST',
    fn: checkRecentVerification,
  },
  'create-plan-recommendation': {
    method: 'POST',
    fn: createPlanRecommendation,
  },
  'get-bill': {
    method: 'POST',
    fn: getBill,
  },
  'get-payment-history': {
    method: 'POST',
    fn: getPaymentHistory,
  },
  'get-service-brief': {
    method: 'POST',
    fn: getServiceBrief,
  },
  health: {
    method: 'GET',
    fn: getHealth,
  },
  'lock-session': {
    method: 'POST',
    fn: lockSession,
  },
  'lookup-account': {
    method: 'POST',
    fn: lookupAccount,
  },
  'lookup-service-policy': {
    method: 'POST',
    fn: lookupServicePolicy,
  },
  'schedule-support-callback': {
    method: 'POST',
    fn: scheduleSupportCallback,
  },
  'search-service-offers': {
    method: 'POST',
    fn: searchServiceOffers,
  },
  'send-otp': {
    method: 'POST',
    fn: sendOtp,
  },
  'validate-setup-readiness': {
    method: 'POST',
    fn: validateSetupReadiness,
  },
  'verify-otp': {
    method: 'POST',
    fn: verifyOtp,
  },
};

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return sendNoContent(res);
  }

  const endpoint = String(req.query?.endpoint ?? '');
  const selected = ENDPOINTS[endpoint];

  if (!selected) {
    return sendBadRequest(res, `Unknown endpoint: ${endpoint}`);
  }

  if (req.method !== selected.method) {
    return sendMethodNotAllowed(res, [selected.method]);
  }

  try {
    if (selected.method === 'GET') {
      return sendJson(res, 200, selected.fn());
    }

    const payload = await readJsonBody(req);
    return sendJson(res, 200, selected.fn(payload));
  } catch (error) {
    return sendBadRequest(
      res,
      error instanceof Error ? error.message : 'Unable to parse request body.',
    );
  }
};
