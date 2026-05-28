/**
 * GET /api/connectors/auth/callback
 *
 * OAuth redirect callback for enterprise connector Authorization Code flow.
 * Microsoft redirects here with ?code=...&state=... after the user signs in.
 *
 * Two scenarios:
 * 1. Popup: window.opener exists → postMessage the code back to the wizard, then close.
 * 2. Redirect (popup was blocked): no opener → exchange the code directly via
 *    the search-ai backend, then redirect the user back to the app.
 */

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code') || '';
  const state = searchParams.get('state') || '';
  const error = searchParams.get('error') || '';

  // The state parameter format is "connectorId:randomHex"
  const connectorId = state.split(':')[0] || '';

  // Return a minimal HTML page that handles both popup and redirect flows
  const html = `<!DOCTYPE html>
<html>
<head><title>Connector Auth</title></head>
<body>
<p id="status">Completing authentication...</p>
<script>
(async function() {
  var statusEl = document.getElementById('status');
  var code = ${JSON.stringify(code)};
  var state = ${JSON.stringify(state)};
  var error = ${JSON.stringify(error)};
  var connectorId = ${JSON.stringify(connectorId)};

  if (error) {
    statusEl.innerText = 'Authentication failed: ' + error;
    return;
  }

  // Popup flow: post message back to the opener (wizard) and close
  if (window.opener) {
    window.opener.postMessage({
      type: 'oauth_callback',
      code: code,
      state: state,
      error: error
    }, window.location.origin);
    window.close();
    return;
  }

  // Redirect flow (popup was blocked): exchange the code directly
  if (!code || !connectorId) {
    statusEl.innerText = 'Authentication failed: missing authorization code.';
    return;
  }

  statusEl.innerText = 'Exchanging authorization code...';
  try {
    var res = await fetch('/api/search-ai/connectors/' + encodeURIComponent(connectorId) + '/auth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ code: code, state: state })
    });
    if (!res.ok) {
      var body = await res.json().catch(function() { return {}; });
      throw new Error(body.error || body.message || 'Server returned ' + res.status);
    }
    statusEl.innerText = 'Authentication successful! Redirecting...';
    // Redirect back to the app — sessionStorage has the saved wizard context
    var savedState = sessionStorage.getItem('connector_oauth_state');
    sessionStorage.removeItem('connector_oauth_state');
    if (savedState) {
      try {
        var ctx = JSON.parse(savedState);
        window.location.href = window.location.origin;
      } catch(e) {
        window.location.href = window.location.origin;
      }
    } else {
      window.location.href = window.location.origin;
    }
  } catch(err) {
    statusEl.innerText = 'Authentication failed: ' + err.message;
  }
})();
</script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}
