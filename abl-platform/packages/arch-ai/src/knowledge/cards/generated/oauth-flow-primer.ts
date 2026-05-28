// L2 knowledge card — OAuth Flow Primer.
// Loaded when the user mentions OAuth, consent, authorize, callback,
// client_secret, or access_token — anything indicating they need the
// two-profile OAuth model (oauth2_app + oauth2_token) explained.
// Token estimate: ~800 (~4 chars/token, content length ~3200 chars).

export const OAUTH_FLOW_PRIMER_CARD = `## OAuth Flow Primer

OAuth setup has TWO halves.

### oauth2_app profile (you create)
Holds client_id and client_secret. One per (tenant, provider). Created via \`auth_ops:create({ authType: 'oauth2_app' })\` with the user supplying client_secret via SecretInput. Default visibility: 'shared'.

### oauth2_token profile (system creates)
Holds the user-grant linkage. Created automatically by /api/projects/:id/auth-profiles/oauth/callback. References oauth2_app via linkedAppProfileId. Default connectionMode: 'per_user'. Never call \`auth_ops:create({ authType: 'oauth2_token' })\`.

### OAuthLaunch widget
Emit \`ask_user\` with \`widgetType: 'OAuthLaunch'\`. Receives oauth2_app id + ConsentConnector fields. Opens popup → /oauth/initiate. On consent, callback creates oauth2_token + EndUserOAuthToken server-side. Widget submits \`{ status: 'connected', oauthTokenProfileId, expiresAt }\`.

### Downstream references
\`tools_ops:create\` and \`connection_ops:create\` reference the oauth2_token id (not oauth2_app). The runtime resolves auth_profile_ref against oauth2_token, which looks up EndUserOAuthToken.

### Failures
- User dismisses popup → tool answer { status: 'canceled' }. Re-emit with retry.
- Provider error → sanitize via sanitize-tool-error.ts before surfacing.
- Token expired → integration_ops:revalidate flags 'oauth_grant_missing_or_expired'. Re-emit OAuthLaunch.

### Refresh
Reactive (no background worker). First call after expiry triggers refresh under 2-second lock. Idle drafts may stall on next test invocation.`;
