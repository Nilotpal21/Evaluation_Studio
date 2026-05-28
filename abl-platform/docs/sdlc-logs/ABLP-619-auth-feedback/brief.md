# ABLP-619 — Auth Feedback Brief

## Source

Stakeholder feedback on auth profile UX and OAuth user-consent flow.

## Feedback

### a) User consent at Auth profile creation

- For **OAuth2 App** and **OAuth2 Client Credentials** auth profiles, user consent should occur **at auth-profile creation time**, both at **project** and **workspace** levels.
- The current "Test credentials" button on OAuth App and OAuth2 Client Credentials profile creation should be replaced with an **"Authorize"** button that invokes the OAuth flow (and obtains user consent) directly from the profile-creation surface.

### b) Integrations consume the OAuth profile (no second consent)

- Integrations should **use the existing OAuth profile** and must **not** trigger another OAuth flow for user consent.
- Existing function-step usage already has user consent today — that path is the reference behavior.

## Scope (proposed)

- Studio auth-profile creation UI — replace "Test credentials" with "Authorize" for `OAuth2_App` and `OAuth2_Client_Credentials` profile types at both project and workspace scopes.
- OAuth-initiation/callback wiring during profile creation, including token persistence and refresh setup.
- Integration runtime wiring — read the already-consented profile; remove any redundant OAuth-initiation hooks for integrations.

## Out of scope (until confirmed)

- Non-OAuth profile types (API key, Basic, Bearer).
- Backwards-compat behavior for profiles created before this change.
