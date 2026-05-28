# SDLC Log: SSO Enterprise Auth -- HLD

**Phase**: 3 (High-Level Design)
**Date**: 2026-03-22
**Status**: Complete

## Clarifying Questions & Decisions

| #   | Question                                             | Classification | Resolution                                                                                                                    |
| --- | ---------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Should SSO be a separate microservice?               | DECIDED        | No. Current Studio-integrated architecture is appropriate given 60-70% completion and tight coupling with auth-repo/org-repo. |
| 2   | Should we use an external identity SaaS?             | DECIDED        | No. Cost, control, and data residency concerns outweigh benefits for enterprise customers.                                    |
| 3   | What is the Redis availability requirement?          | INFERRED       | Redis recommended for production (multi-pod). In-memory fallback acceptable for single-pod/dev.                               |
| 4   | How does SSO interact with existing auth middleware? | ANSWERED       | SSO issues standard JWT via `createTokenPair`, consumed by `createUnifiedAuthMiddleware` in all apps.                         |
| 5   | Is the data model ready for SSO?                     | ANSWERED       | Yes. Organization model already has `ssoConfigs[]` and `domainMappings[]` arrays with proper indexes.                         |

## Files Created

- `docs/specs/sso-enterprise-auth.hld.md` -- HLD with all 12 architectural concerns
- `docs/sdlc-logs/sso-enterprise-auth/hld.log.md` -- This log

## Review Summary

Round 1 -- Full Audit:

- All 12 architectural concerns addressed
- 3 alternatives considered with trade-off analysis
- System context diagram, component diagram, and two sequence diagrams included
- Data model documented (Organization.ssoConfigs, User.mfa, Redis ephemeral state)
- API design covers existing + planned endpoints
- 5 open questions listed

Round 2 -- Deep Dive:

- Data model verified against `packages/database/src/models/organization.model.ts`
- API design verified against existing route files in `apps/studio/src/app/api/sso/`
- Error model covers 7 failure scenarios with recovery paths
- Performance budget realistic based on external HTTP call latency estimates
- Security surface covers SAML signatures, OIDC SSRF, encryption, replay protection

Round 3 -- Cross-Phase Consistency:

- HLD addresses all 14 FRs from feature spec
- Test strategy aligns with test spec (7 E2E, 12 integration, 7 unit)
- No contradictions between feature spec and HLD
- Gaps from feature spec (GAP-001 through GAP-008) reflected in HLD concerns
