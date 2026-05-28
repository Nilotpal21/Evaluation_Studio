# Studio OpenAPI Implementation Status

## Completed Routes (21/117) ✅ — 18% Complete

### Auth Routes (15 endpoints)

- ✅ POST /api/auth/login
- ✅ POST /api/auth/signup
- ✅ POST /api/auth/verify-email
- ✅ POST /api/auth/forgot-password
- ✅ POST /api/auth/reset-password
- ✅ POST /api/auth/refresh
- ✅ POST /api/auth/logout
- ✅ GET /api/auth/me
- ✅ GET /api/auth/google
- ✅ GET /api/auth/callback
- ✅ POST /api/auth/dev-login
- ✅ POST /api/auth/create-workspace
- ✅ POST /api/auth/resend-verification
- ✅ GET /api/auth/tenants
- ✅ POST /api/auth/tenants/switch

## Remaining Routes (96/117) - Prioritized

### High Priority (Core CRUD - 21 endpoints)

#### Projects (6 endpoints)

- [ ] GET /api/projects
- [ ] POST /api/projects
- [ ] GET /api/projects/[id]
- [ ] PATCH /api/projects/[id]
- [ ] DELETE /api/projects/[id]
- [ ] GET /api/projects/[id]/sessions

#### Agents (4 endpoints)

- [ ] GET /api/agents
- [ ] GET /api/agents/apps
- [ ] GET /api/agents/apps/[domain]
- [ ] GET /api/agents/[domain]/[name]

#### Credentials (5 endpoints)

- [ ] GET /api/credentials
- [ ] POST /api/credentials
- [ ] GET /api/credentials/[id]
- [ ] PATCH /api/credentials/[id]
- [ ] DELETE /api/credentials/[id]

#### SDK Keys (6 endpoints)

- [x] GET /api/sdk/keys
- [x] POST /api/sdk/keys
- [x] DELETE /api/sdk/keys/[keyId]
- [x] POST /api/sdk/preview-token
- [x] POST /api/sdk/share
- [x] POST /api/sdk/share/exchange

#### Widget (3 endpoints)

- [ ] GET /api/sdk/widget/[projectId]
- [ ] PUT /api/sdk/widget/[projectId]
- [ ] GET /api/sdk/embed/[projectId]

#### Tenant Models (3 endpoints - high traffic)

- [ ] GET /api/tenant-models
- [ ] POST /api/tenant-models
- [ ] GET /api/tenant-models/[id]

### Medium Priority (Admin/Config - 30 endpoints)

#### MFA (7 endpoints)

- [ ] POST /api/mfa/setup
- [ ] POST /api/mfa/confirm
- [ ] GET /api/mfa/status
- [ ] POST /api/mfa/verify
- [ ] DELETE /api/mfa/disable
- [ ] POST /api/mfa/recovery
- [ ] POST /api/mfa/recovery/regenerate

#### Workspaces & Invitations (8 endpoints)

- [ ] GET /api/workspaces/[tenantId]/members
- [ ] GET /api/workspaces/[tenantId]/invitations
- [ ] POST /api/workspaces/[tenantId]/invitations
- [ ] DELETE /api/workspaces/[tenantId]/invitations/[invitationId]
- [ ] GET /api/invitations/[token]
- [ ] POST /api/invitations/accept
- [ ] POST /api/organizations
- [ ] GET /api/organizations/[orgId]/workspaces

#### Service Nodes (5 endpoints)

- [ ] GET /api/service-nodes
- [ ] POST /api/service-nodes
- [ ] GET /api/service-nodes/[id]
- [ ] PATCH /api/service-nodes/[id]
- [ ] DELETE /api/service-nodes/[id]

#### Models (5 endpoints)

- [ ] GET /api/models
- [ ] POST /api/models
- [ ] GET /api/models/[id]
- [ ] PATCH /api/models/[id]
- [ ] DELETE /api/models/[id]

#### Tenant Model Extensions (5 endpoints)

- [ ] PATCH /api/tenant-models/[id]
- [ ] DELETE /api/tenant-models/[id]
- [ ] POST /api/tenant-models/[id]/toggle-inference
- [ ] GET /api/tenant-models/[id]/connections
- [ ] POST /api/tenant-models/[id]/connections

### Lower Priority (Advanced/Debug - 45 endpoints)

#### Device Auth (4 endpoints)

- [ ] POST /api/auth/device
- [ ] POST /api/auth/device/authorize
- [ ] GET /api/auth/device/lookup
- [ ] POST /api/auth/device/token

#### SSO (7 endpoints)

- [ ] POST /api/sso/exchange
- [ ] GET /api/sso/init
- [ ] POST /api/sso/domains
- [ ] POST /api/sso/domains/verify
- [ ] GET /api/sso/oidc/callback
- [ ] POST /api/sso/saml/callback
- [ ] POST /api/sso/config

#### Project Agents (6 endpoints)

- [ ] GET /api/projects/[id]/agents
- [ ] POST /api/projects/[id]/agents
- [ ] PATCH /api/projects/[id]/agents/[agentId]
- [ ] DELETE /api/projects/[id]/agents/[agentId]
- [ ] PUT /api/projects/[id]/agents/[agentId]/dsl
- [ ] POST /api/organizations/[orgId]/workspaces

#### Voice & LiveKit (4 endpoints)

- [ ] POST /api/voice/token
- [ ] GET /api/voice/capabilities
- [ ] POST /api/livekit/token
- [ ] GET /api/livekit/capabilities

#### Debug (5 endpoints)

- [ ] POST /api/debug/token
- [ ] DELETE /api/debug/token
- [ ] GET /api/debug/tokens
- [ ] DELETE /api/debug/tokens
- [ ] POST /api/debug/validate

#### Archives (6 endpoints)

- [ ] GET /api/archives
- [ ] POST /api/archives/sessions
- [ ] POST /api/archives/traces
- [ ] POST /api/archives/audit-export
- [ ] GET /api/archives/[id]/download
- [ ] DELETE /api/archives/[id]

#### ABL Compilation (2 endpoints)

- [ ] POST /api/abl/parse
- [ ] POST /api/abl/compile

#### Admin & Monitoring (5 endpoints)

- [ ] GET /api/audit
- [ ] GET /api/admin/scheduler
- [ [ ] GET /api/admin/sdk-clients
- [ ] GET /api/runtime/sessions
- [ ] GET /api/runtime/sessions/[id]

#### Tenant Model Connections (3 endpoints)

- [ ] PATCH /api/tenant-models/[id]/connections/[connId]
- [ ] DELETE /api/tenant-models/[id]/connections/[connId]
- [ ] POST /api/tenant-models/[id]/connections/[connId]/validate

#### Model Catalog (1 endpoint)

- [ ] GET /api/model-catalog

## Implementation Strategy

### Phase 3A: High Priority Routes (Next)

Focus on core CRUD operations that users interact with most:

- Projects (6)
- Agents (4)
- Credentials (5)
- SDK Keys/Widget (9)
- Tenant Models subset (3)

**Total: 27 endpoints**

### Phase 3B: Medium Priority Routes

Admin and configuration routes:

- MFA (7)
- Workspaces/Invitations (8)
- Service Nodes (5)
- Models (5)
- Tenant Model extensions (5)

**Total: 30 endpoints**

### Phase 3C: Lower Priority Routes (Optional)

Advanced features and debugging:

- Device Auth, SSO, Archives, Debug, Admin monitoring
- Can be done incrementally as needed

**Total: 45 endpoints**

## Notes

- All routes use Next.js App Router pattern with `route.ts` files
- Pattern: `export const METHOD = withOpenAPI({ summary, body?, response }, handler)`
- The `scanNextjsRoutes()` function auto-discovers all routes
- Routes without `withOpenAPI` still appear in spec with basic method + path info
- Priority is based on user-facing impact and usage frequency
