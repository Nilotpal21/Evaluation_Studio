const COMMON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

function applyHeaders(res) {
  for (const [key, value] of Object.entries(COMMON_HEADERS)) {
    res.setHeader(key, value);
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    return req.body.trim() ? JSON.parse(req.body) : {};
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, statusCode, payload) {
  applyHeaders(res);
  return res.status(statusCode).json(payload);
}

function sendNoContent(res) {
  applyHeaders(res);
  return res.status(204).end();
}

function sendMethodNotAllowed(res, methods) {
  return sendJson(res, 405, {
    error: 'Method not allowed',
    allowed_methods: methods,
  });
}

function sendBadRequest(res, message) {
  return sendJson(res, 400, {
    error: 'invalid_request',
    message,
  });
}

module.exports = {
  readJsonBody,
  sendBadRequest,
  sendJson,
  sendMethodNotAllowed,
  sendNoContent,
};
