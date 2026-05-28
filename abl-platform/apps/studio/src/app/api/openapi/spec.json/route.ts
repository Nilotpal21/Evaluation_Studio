import { NextRequest, NextResponse } from 'next/server';
import { createRouteRegistry } from '@agent-platform/openapi';
import { DEFAULT_STUDIO_PORT } from '@agent-platform/config';
import { AGENT_NAME_MAX_LENGTH, AGENT_NAME_PATTERN } from '@agent-platform/shared';
import type { RouteSchema } from '@agent-platform/openapi';
import { z } from 'zod';
import { requireInternalNetworkAccess } from '@/lib/internal-network';

// Force dynamic rendering
export const dynamic = 'force-dynamic';

// ─── Shared Schemas ────────────────────────────────────────────────────
const errorSchema = z.object({ error: z.string() });
const successSchema = z.object({ success: z.boolean() });
const messageSchema = z.object({ message: z.string() });
const idParam = z.object({ id: z.string() });
const agentNameSchema = z.string().max(AGENT_NAME_MAX_LENGTH).regex(AGENT_NAME_PATTERN);

const tokenResponseSchema = z.object({
  token: z.string(),
  refreshToken: z.string().optional(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string().optional() }).passthrough(),
});

const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    tenantId: z.string(),
  })
  .passthrough();

// ─── Route Definitions ─────────────────────────────────────────────────
// Each entry: [method, path, schema]
type RouteDef = ['get' | 'post' | 'put' | 'patch' | 'delete', string, RouteSchema];

const routes: RouteDef[] = [
  // ── Auth (15) ──
  [
    'post',
    '/api/auth/login',
    {
      summary: 'Login with email and password',
      tags: ['Auth'],
      body: z.object({ email: z.string().email(), password: z.string() }),
      response: tokenResponseSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/signup',
    {
      summary: 'Create new account',
      tags: ['Auth'],
      body: z.object({
        email: z.string().email(),
        password: z.string(),
        name: z.string().optional(),
      }),
      response: z.object({ message: z.string(), userId: z.string() }),
      auth: false,
      successStatus: 201,
    },
  ],
  [
    'post',
    '/api/auth/verify-email',
    {
      summary: 'Verify email address',
      tags: ['Auth'],
      body: z.object({ token: z.string() }),
      response: messageSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/forgot-password',
    {
      summary: 'Request password reset email',
      tags: ['Auth'],
      body: z.object({ email: z.string().email() }),
      response: messageSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/reset-password',
    {
      summary: 'Reset password with token',
      tags: ['Auth'],
      body: z.object({ token: z.string(), password: z.string() }),
      response: messageSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/refresh',
    {
      summary: 'Refresh access token',
      tags: ['Auth'],
      body: z.object({ refreshToken: z.string() }),
      response: tokenResponseSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/logout',
    {
      summary: 'Logout and invalidate tokens',
      tags: ['Auth'],
      response: messageSchema,
    },
  ],
  [
    'get',
    '/api/auth/me',
    {
      summary: 'Get current user profile',
      tags: ['Auth'],
      response: z.object({
        user: z
          .object({ id: z.string(), email: z.string(), name: z.string().optional() })
          .passthrough(),
      }),
    },
  ],
  [
    'get',
    '/api/auth/google',
    {
      summary: 'Initiate Google OAuth flow',
      tags: ['Auth'],
      auth: false,
    },
  ],
  [
    'get',
    '/api/auth/callback',
    {
      summary: 'OAuth callback handler',
      tags: ['Auth'],
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/dev-login',
    {
      summary: 'Developer login (dev mode only)',
      tags: ['Auth'],
      body: z.object({ email: z.string().email() }),
      response: tokenResponseSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/create-workspace',
    {
      summary: 'Create a new workspace',
      tags: ['Auth'],
      body: z.object({ name: z.string() }),
      response: z.object({ tenantId: z.string(), name: z.string() }),
    },
  ],
  [
    'post',
    '/api/auth/resend-verification',
    {
      summary: 'Resend email verification',
      tags: ['Auth'],
      body: z.object({ email: z.string().email() }),
      response: messageSchema,
      auth: false,
    },
  ],
  [
    'get',
    '/api/auth/tenants',
    {
      summary: 'List user workspaces/tenants',
      tags: ['Auth'],
      response: z.object({
        tenants: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
      }),
    },
  ],
  [
    'post',
    '/api/auth/tenants/switch',
    {
      summary: 'Switch active tenant',
      tags: ['Auth'],
      body: z.object({ tenantId: z.string() }),
      response: tokenResponseSchema,
    },
  ],

  // ── MFA (7) ──
  [
    'post',
    '/api/mfa/setup',
    {
      summary: 'Begin MFA setup',
      tags: ['MFA'],
      response: z.object({ secret: z.string(), qrCode: z.string() }),
    },
  ],
  [
    'post',
    '/api/mfa/confirm',
    {
      summary: 'Confirm MFA setup with TOTP code',
      tags: ['MFA'],
      body: z.object({ code: z.string() }),
      response: z.object({ recoveryCodes: z.array(z.string()) }),
    },
  ],
  [
    'get',
    '/api/mfa/status',
    {
      summary: 'Check MFA enrollment status',
      tags: ['MFA'],
      response: z.object({ enabled: z.boolean() }),
    },
  ],
  [
    'post',
    '/api/mfa/verify',
    {
      summary: 'Verify MFA code during login',
      tags: ['MFA'],
      body: z.object({ code: z.string(), tempToken: z.string() }),
      response: tokenResponseSchema,
      auth: false,
    },
  ],
  [
    'delete',
    '/api/mfa/disable',
    {
      summary: 'Disable MFA',
      tags: ['MFA'],
      body: z.object({ code: z.string() }),
      response: messageSchema,
    },
  ],
  [
    'post',
    '/api/mfa/recovery',
    {
      summary: 'Login with MFA recovery code',
      tags: ['MFA'],
      body: z.object({ recoveryCode: z.string(), tempToken: z.string() }),
      response: tokenResponseSchema,
      auth: false,
    },
  ],
  [
    'post',
    '/api/mfa/recovery/regenerate',
    {
      summary: 'Regenerate MFA recovery codes',
      tags: ['MFA'],
      body: z.object({ code: z.string() }),
      response: z.object({ recoveryCodes: z.array(z.string()) }),
    },
  ],

  // ── Projects (6) ──
  [
    'get',
    '/api/projects',
    {
      summary: 'List projects',
      tags: ['Projects'],
      response: z.object({ projects: z.array(projectSchema) }),
    },
  ],
  [
    'post',
    '/api/projects',
    {
      summary: 'Create project',
      tags: ['Projects'],
      body: z.object({ name: z.string(), description: z.string().optional() }),
      response: projectSchema,
      successStatus: 201,
    },
  ],
  [
    'get',
    '/api/projects/{id}',
    {
      summary: 'Get project by ID',
      tags: ['Projects'],
      params: idParam,
      response: projectSchema,
    },
  ],
  [
    'patch',
    '/api/projects/{id}',
    {
      summary: 'Update project',
      tags: ['Projects'],
      params: idParam,
      body: z.object({ name: z.string().optional(), description: z.string().optional() }),
      response: projectSchema,
    },
  ],
  [
    'delete',
    '/api/projects/{id}',
    {
      summary: 'Delete project',
      tags: ['Projects'],
      params: idParam,
      response: messageSchema,
    },
  ],
  [
    'get',
    '/api/projects/{id}/sessions',
    {
      summary: 'List project sessions',
      tags: ['Projects'],
      params: idParam,
      response: z.object({ sessions: z.array(z.object({ id: z.string() }).passthrough()) }),
    },
  ],

  // ── Agents (4) ──
  [
    'get',
    '/api/agents',
    {
      summary: 'List all agents',
      tags: ['Agents'],
      response: z.object({
        agents: z.array(z.object({ domain: z.string(), name: z.string() }).passthrough()),
      }),
    },
  ],
  [
    'get',
    '/api/agents/apps',
    {
      summary: 'List agent applications',
      tags: ['Agents'],
      response: z.object({ apps: z.array(z.object({ domain: z.string() }).passthrough()) }),
    },
  ],
  [
    'get',
    '/api/agents/apps/{domain}',
    {
      summary: 'List agents in domain',
      tags: ['Agents'],
      params: z.object({ domain: z.string() }),
      response: z.object({ agents: z.array(z.object({ name: z.string() }).passthrough()) }),
    },
  ],
  [
    'get',
    '/api/agents/{domain}/{name}',
    {
      summary: 'Get agent by domain and name',
      tags: ['Agents'],
      params: z.object({ domain: z.string(), name: z.string() }),
    },
  ],

  // ── Credentials (5) ──
  [
    'get',
    '/api/credentials',
    {
      summary: 'List credentials',
      tags: ['Credentials'],
      response: z.object({
        credentials: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
      }),
    },
  ],
  [
    'post',
    '/api/credentials',
    {
      summary: 'Create credential',
      tags: ['Credentials'],
      body: z.object({ name: z.string(), type: z.string(), value: z.string() }),
      successStatus: 201,
    },
  ],
  [
    'get',
    '/api/credentials/{id}',
    {
      summary: 'Get credential by ID',
      tags: ['Credentials'],
      params: idParam,
    },
  ],
  [
    'patch',
    '/api/credentials/{id}',
    {
      summary: 'Update credential',
      tags: ['Credentials'],
      params: idParam,
      body: z.object({ name: z.string().optional(), value: z.string().optional() }),
    },
  ],
  [
    'delete',
    '/api/credentials/{id}',
    {
      summary: 'Delete credential',
      tags: ['Credentials'],
      params: idParam,
      response: messageSchema,
    },
  ],

  // ── SDK (9) ──
  [
    'get',
    '/api/sdk/keys',
    {
      summary: 'List SDK API keys',
      tags: ['SDK'],
    },
  ],
  [
    'post',
    '/api/sdk/keys',
    {
      summary: 'Create SDK API key',
      tags: ['SDK'],
      body: z.object({ name: z.string(), projectId: z.string() }),
      successStatus: 201,
    },
  ],
  [
    'delete',
    '/api/sdk/keys/{keyId}',
    {
      summary: 'Revoke SDK API key',
      tags: ['SDK'],
      params: z.object({ keyId: z.string() }),
      response: messageSchema,
    },
  ],
  [
    'post',
    '/api/sdk/preview-token',
    {
      summary: 'Generate preview token',
      tags: ['SDK'],
      body: z.object({ projectId: z.string() }),
    },
  ],
  [
    'post',
    '/api/sdk/share/exchange',
    {
      summary: 'Exchange share token',
      tags: ['SDK'],
    },
  ],
  [
    'post',
    '/api/sdk/share',
    {
      summary: 'Generate share URL',
      tags: ['SDK'],
    },
  ],
  [
    'get',
    '/api/sdk/widget/{projectId}',
    {
      summary: 'Get widget configuration',
      tags: ['SDK'],
      params: z.object({ projectId: z.string() }),
    },
  ],
  [
    'put',
    '/api/sdk/widget/{projectId}',
    {
      summary: 'Update widget configuration',
      tags: ['SDK'],
      params: z.object({ projectId: z.string() }),
    },
  ],
  [
    'get',
    '/api/sdk/embed/{projectId}',
    {
      summary: 'Get embed snippet',
      tags: ['SDK'],
      params: z.object({ projectId: z.string() }),
    },
  ],

  // ── Tenant Models (3) ──
  [
    'get',
    '/api/tenant-models',
    {
      summary: 'List tenant model configurations',
      tags: ['Tenant Models'],
    },
  ],
  [
    'post',
    '/api/tenant-models',
    {
      summary: 'Create tenant model configuration',
      tags: ['Tenant Models'],
      successStatus: 201,
    },
  ],
  [
    'get',
    '/api/tenant-models/{id}',
    {
      summary: 'Get tenant model configuration',
      tags: ['Tenant Models'],
      params: idParam,
    },
  ],

  // ── Workspaces & Invitations (6) ──
  [
    'get',
    '/api/workspaces/{tenantId}/members',
    {
      summary: 'List workspace members',
      tags: ['Workspaces'],
      params: z.object({ tenantId: z.string() }),
    },
  ],
  [
    'get',
    '/api/workspaces/{tenantId}/invitations',
    {
      summary: 'List workspace invitations',
      tags: ['Workspaces'],
      params: z.object({ tenantId: z.string() }),
    },
  ],
  [
    'post',
    '/api/workspaces/{tenantId}/invitations',
    {
      summary: 'Invite user to workspace',
      tags: ['Workspaces'],
      params: z.object({ tenantId: z.string() }),
      body: z.object({ email: z.string().email(), role: z.string().optional() }),
      successStatus: 201,
    },
  ],
  [
    'delete',
    '/api/workspaces/{tenantId}/invitations/{invitationId}',
    {
      summary: 'Cancel workspace invitation',
      tags: ['Workspaces'],
      params: z.object({ tenantId: z.string(), invitationId: z.string() }),
      response: messageSchema,
    },
  ],
  [
    'get',
    '/api/invitations/{token}',
    {
      summary: 'Get invitation details by token',
      tags: ['Workspaces'],
      params: z.object({ token: z.string() }),
      auth: false,
    },
  ],
  [
    'post',
    '/api/invitations/accept',
    {
      summary: 'Accept workspace invitation',
      tags: ['Workspaces'],
      body: z.object({ token: z.string() }),
    },
  ],

  // ── Models (5) ──
  [
    'get',
    '/api/models',
    {
      summary: 'List AI models',
      tags: ['Models'],
    },
  ],
  [
    'post',
    '/api/models',
    {
      summary: 'Register AI model',
      tags: ['Models'],
      successStatus: 201,
    },
  ],
  [
    'get',
    '/api/models/{id}',
    {
      summary: 'Get AI model by ID',
      tags: ['Models'],
      params: idParam,
    },
  ],
  [
    'patch',
    '/api/models/{id}',
    {
      summary: 'Update AI model',
      tags: ['Models'],
      params: idParam,
    },
  ],
  [
    'delete',
    '/api/models/{id}',
    {
      summary: 'Delete AI model',
      tags: ['Models'],
      params: idParam,
      response: messageSchema,
    },
  ],

  // ── Service Nodes (5) ──
  [
    'get',
    '/api/service-nodes',
    {
      summary: 'List service nodes',
      tags: ['Service Nodes'],
    },
  ],
  [
    'post',
    '/api/service-nodes',
    {
      summary: 'Register service node',
      tags: ['Service Nodes'],
      successStatus: 201,
    },
  ],
  [
    'get',
    '/api/service-nodes/{id}',
    {
      summary: 'Get service node by ID',
      tags: ['Service Nodes'],
      params: idParam,
    },
  ],
  [
    'patch',
    '/api/service-nodes/{id}',
    {
      summary: 'Update service node',
      tags: ['Service Nodes'],
      params: idParam,
    },
  ],
  [
    'delete',
    '/api/service-nodes/{id}',
    {
      summary: 'Delete service node',
      tags: ['Service Nodes'],
      params: idParam,
      response: messageSchema,
    },
  ],

  // ── ABL Compiler (2) ──
  [
    'post',
    '/api/abl/compile',
    {
      summary: 'Compile ABL DSL to intermediate representation',
      tags: ['ABL Compiler'],
      body: z.object({ dsl: z.string() }),
      response: z.object({
        success: z.boolean(),
        ir: z.unknown().optional(),
        errors: z.array(z.string()).optional(),
      }),
    },
  ],
  [
    'post',
    '/api/abl/parse',
    {
      summary: 'Parse ABL DSL syntax',
      tags: ['ABL Compiler'],
      body: z.object({ dsl: z.string() }),
      response: z.object({
        success: z.boolean(),
        document: z.unknown().optional(),
        errors: z.array(z.string()).optional(),
        warnings: z.array(z.string()).optional(),
      }),
    },
  ],

  // ── Admin (2) ──
  [
    'get',
    '/api/admin/scheduler',
    {
      summary: 'Get scheduler status',
      tags: ['Admin'],
      response: z.object({ status: z.string(), message: z.string().optional() }),
    },
  ],
  [
    'get',
    '/api/admin/sdk-clients',
    {
      summary: 'List connected SDK clients',
      tags: ['Admin'],
      response: z.object({
        count: z.number().optional(),
        clients: z.array(z.object({}).passthrough()),
      }),
    },
  ],

  // ── Archives (6) ──
  [
    'get',
    '/api/archives',
    {
      summary: 'List archives',
      tags: ['Archives'],
      query: z.object({
        type: z.string().optional(),
        limit: z.string().optional(),
        cursor: z.string().optional(),
      }),
      response: z.object({
        archives: z.array(z.object({}).passthrough()),
        nextCursor: z.string().optional(),
      }),
    },
  ],
  [
    'post',
    '/api/archives/audit-export',
    {
      summary: 'Export audit logs to archive',
      tags: ['Archives'],
      body: z.object({ olderThan: z.string().optional() }),
      response: z.object({ manifest: z.object({}).passthrough() }),
    },
  ],
  [
    'post',
    '/api/archives/sessions',
    {
      summary: 'Archive old sessions',
      tags: ['Archives'],
      body: z.object({ olderThan: z.string().optional() }),
      response: z.object({ manifest: z.object({}).passthrough() }),
    },
  ],
  [
    'post',
    '/api/archives/traces',
    {
      summary: 'Archive old traces',
      tags: ['Archives'],
      body: z.object({ olderThan: z.string().optional() }),
      response: z.object({ manifest: z.object({}).passthrough() }),
    },
  ],
  [
    'delete',
    '/api/archives/{id}',
    {
      summary: 'Delete archive',
      tags: ['Archives'],
      params: idParam,
      response: z.object({ deleted: z.boolean() }),
    },
  ],
  [
    'get',
    '/api/archives/{id}/download',
    {
      summary: 'Download archive file',
      tags: ['Archives'],
      params: idParam,
      response: z.object({ downloadUrl: z.string(), expiresIn: z.number() }),
    },
  ],

  // ── Audit (1) ──
  [
    'get',
    '/api/audit',
    {
      summary: 'Query audit logs',
      tags: ['Audit'],
      query: z.object({
        action: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
      response: z.object({
        logs: z.array(z.object({}).passthrough()),
        total: z.number(),
        limit: z.number(),
        offset: z.number(),
      }),
    },
  ],

  // ── Auth Device Flow (4) ──
  [
    'post',
    '/api/auth/device',
    {
      summary: 'Initiate device authorization flow',
      tags: ['Auth'],
      body: z.object({ scopes: z.array(z.string()).optional() }),
      response: z.object({
        device_code: z.string(),
        user_code: z.string(),
        verification_uri: z.string(),
        verification_uri_complete: z.string().optional(),
        expires_in: z.number(),
        interval: z.number(),
      }),
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/device/authorize',
    {
      summary: 'Authorize or deny device request',
      tags: ['Auth'],
      body: z.object({ user_code: z.string(), allow: z.boolean() }),
      response: z.object({ success: z.boolean(), message: z.string() }),
    },
  ],
  [
    'get',
    '/api/auth/device/lookup',
    {
      summary: 'Lookup device authorization request',
      tags: ['Auth'],
      query: z.object({ code: z.string() }),
      response: z.object({
        userCode: z.string(),
        scopes: z.array(z.string()),
        expiresAt: z.string(),
      }),
      auth: false,
    },
  ],
  [
    'post',
    '/api/auth/device/token',
    {
      summary: 'Exchange device code for access token',
      tags: ['Auth'],
      body: z.object({ device_code: z.string() }),
      response: z.object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        token_type: z.string(),
        expires_in: z.number(),
        scope: z.string().optional(),
      }),
      auth: false,
    },
  ],

  // ── Debug (5) ──
  [
    'post',
    '/api/debug/token',
    {
      summary: 'Create debug token',
      tags: ['Debug'],
      body: z.object({
        scopes: z.array(z.string()).optional(),
        sessionIds: z.array(z.string()).optional(),
      }),
      response: z.object({ token: z.string(), expiresAt: z.string(), scopes: z.array(z.string()) }),
    },
  ],
  [
    'delete',
    '/api/debug/token',
    {
      summary: 'Revoke debug token',
      tags: ['Debug'],
      body: z.object({ token: z.string() }),
      response: successSchema,
    },
  ],
  [
    'get',
    '/api/debug/tokens',
    {
      summary: 'List debug tokens',
      tags: ['Debug'],
      response: z.object({ tokens: z.array(z.object({}).passthrough()) }),
    },
  ],
  [
    'delete',
    '/api/debug/tokens',
    {
      summary: 'Revoke all debug tokens',
      tags: ['Debug'],
      response: successSchema,
    },
  ],
  [
    'post',
    '/api/debug/validate',
    {
      summary: 'Validate debug token',
      tags: ['Debug'],
      body: z.object({ token: z.string() }),
      response: z.object({
        valid: z.boolean(),
        error: z.string().optional(),
        userId: z.string().optional(),
        email: z.string().optional(),
        scopes: z.array(z.string()).optional(),
      }),
      auth: false,
    },
  ],

  // ── LiveKit (2) ──
  [
    'get',
    '/api/v1/livekit/capabilities',
    {
      summary: 'Get LiveKit capabilities',
      tags: ['LiveKit'],
      response: z.object({
        enabled: z.boolean(),
        configured: z.boolean(),
        error: z.string().optional(),
      }),
    },
  ],
  [
    'post',
    '/api/v1/livekit/token',
    {
      summary: 'Generate LiveKit room token',
      tags: ['LiveKit'],
      body: z.object({ roomName: z.string().optional(), participantName: z.string().optional() }),
    },
  ],

  // ── Model Catalog (1) ──
  [
    'get',
    '/api/model-catalog',
    {
      summary: 'List available AI models from catalog',
      tags: ['Models'],
    },
  ],

  // ── Organizations (3) ──
  [
    'post',
    '/api/organizations',
    {
      summary: 'Create organization',
      tags: ['Organizations'],
      body: z.object({
        name: z.string(),
        slug: z.string().optional(),
        billingEmail: z.string().email().optional(),
        linkWorkspaceId: z.string().optional(),
      }),
      successStatus: 201,
    },
  ],
  [
    'get',
    '/api/organizations/{orgId}/workspaces',
    {
      summary: 'List organization workspaces',
      tags: ['Organizations'],
      params: z.object({ orgId: z.string() }),
    },
  ],
  [
    'post',
    '/api/organizations/{orgId}/workspaces',
    {
      summary: 'Create workspace in organization',
      tags: ['Organizations'],
      params: z.object({ orgId: z.string() }),
      body: z.object({ name: z.string().optional(), tenantId: z.string().optional() }),
      successStatus: 201,
    },
  ],

  // ── Project Agents (5) ──
  [
    'get',
    '/api/projects/{id}/agents',
    {
      summary: 'List agents in project',
      tags: ['Projects'],
      params: idParam,
      response: z.object({ agents: z.array(z.object({}).passthrough()) }),
    },
  ],
  [
    'post',
    '/api/projects/{id}/agents',
    {
      summary: 'Add agent to project',
      tags: ['Projects'],
      params: idParam,
      body: z.object({
        name: agentNameSchema,
        description: z.string().optional(),
      }),
      successStatus: 201,
    },
  ],
  [
    'patch',
    '/api/projects/{id}/agents/{agentId}',
    {
      summary: 'Update project agent',
      tags: ['Projects'],
      params: z.object({ id: z.string(), agentId: z.string() }),
      body: z.object({
        name: agentNameSchema.optional(),
        description: z.string().optional(),
      }),
    },
  ],
  [
    'delete',
    '/api/projects/{id}/agents/{agentId}',
    {
      summary: 'Remove agent from project',
      tags: ['Projects'],
      params: z.object({ id: z.string(), agentId: z.string() }),
      response: successSchema,
    },
  ],
  [
    'put',
    '/api/projects/{id}/agents/{agentId}/dsl',
    {
      summary: 'Update agent DSL content',
      tags: ['Projects'],
      params: z.object({ id: z.string(), agentId: z.string() }),
      body: z.object({ dslContent: z.string() }),
      response: z.object({ success: z.boolean(), updatedAt: z.string() }),
    },
  ],

  // ── Runtime Sessions Proxy (2) ──
  [
    'get',
    '/api/runtime/sessions',
    {
      summary: 'List active runtime sessions',
      tags: ['Runtime'],
    },
  ],
  [
    'get',
    '/api/runtime/sessions/{id}',
    {
      summary: 'Get runtime session details',
      tags: ['Runtime'],
      params: idParam,
    },
  ],

  // ── SSO (7) ──
  [
    'post',
    '/api/sso/config',
    {
      summary: 'Create or update SSO configuration',
      tags: ['SSO'],
      body: z.object({
        protocol: z.enum(['saml', 'oidc']),
        forceSso: z.boolean().optional(),
        allowGoogleFallback: z.boolean().optional(),
        saml: z.object({}).passthrough().optional(),
        oidc: z.object({}).passthrough().optional(),
      }),
      response: z.object({
        id: z.string(),
        protocol: z.string(),
        forceSso: z.boolean(),
        allowGoogleFallback: z.boolean(),
      }),
    },
  ],
  [
    'post',
    '/api/sso/domains',
    {
      summary: 'Register SSO domain',
      tags: ['SSO'],
      body: z.object({ domain: z.string() }),
      response: z.object({
        domain: z.string(),
        verificationToken: z.string(),
        instructions: z.string(),
      }),
    },
  ],
  [
    'post',
    '/api/sso/domains/verify',
    {
      summary: 'Verify SSO domain ownership via DNS',
      tags: ['SSO'],
      body: z.object({ domain: z.string() }),
      response: z.object({
        domain: z.string(),
        verified: z.boolean(),
        message: z.string().optional(),
      }),
    },
  ],
  [
    'post',
    '/api/sso/exchange',
    {
      summary: 'Exchange SSO authorization code for tokens',
      tags: ['SSO'],
      body: z.object({ code: z.string() }),
      response: z.object({
        accessToken: z.string(),
        expiresIn: z.number(),
        needsOnboarding: z.boolean().optional(),
        pendingInvitations: z.array(z.object({}).passthrough()).optional(),
      }),
      auth: false,
    },
  ],
  [
    'get',
    '/api/sso/init',
    {
      summary: 'Initiate SSO login flow',
      tags: ['SSO'],
      query: z.object({ email: z.string() }),
      response: z.object({
        ssoEnabled: z.boolean(),
        protocol: z.string().optional(),
        redirectUrl: z.string().optional(),
        message: z.string().optional(),
      }),
      auth: false,
    },
  ],
  [
    'get',
    '/api/sso/oidc/callback',
    {
      summary: 'OIDC SSO callback handler',
      tags: ['SSO'],
      query: z.object({ code: z.string(), state: z.string() }),
      auth: false,
    },
  ],
  [
    'post',
    '/api/sso/saml/callback',
    {
      summary: 'SAML SSO callback handler',
      tags: ['SSO'],
      auth: false,
    },
  ],

  // ── Tenant Model Connections (6) ──
  [
    'get',
    '/api/tenant-models/{id}/connections',
    {
      summary: 'List model connections',
      tags: ['Tenant Models'],
      params: idParam,
    },
  ],
  [
    'post',
    '/api/tenant-models/{id}/connections',
    {
      summary: 'Create model connection',
      tags: ['Tenant Models'],
      params: idParam,
      successStatus: 201,
    },
  ],
  [
    'patch',
    '/api/tenant-models/{id}/connections/{connId}',
    {
      summary: 'Update model connection',
      tags: ['Tenant Models'],
      params: z.object({ id: z.string(), connId: z.string() }),
    },
  ],
  [
    'delete',
    '/api/tenant-models/{id}/connections/{connId}',
    {
      summary: 'Delete model connection',
      tags: ['Tenant Models'],
      params: z.object({ id: z.string(), connId: z.string() }),
      response: messageSchema,
    },
  ],
  [
    'post',
    '/api/tenant-models/{id}/connections/{connId}/validate',
    {
      summary: 'Validate model connection',
      tags: ['Tenant Models'],
      params: z.object({ id: z.string(), connId: z.string() }),
    },
  ],
  [
    'post',
    '/api/tenant-models/{id}/toggle-inference',
    {
      summary: 'Toggle inference for tenant model',
      tags: ['Tenant Models'],
      params: idParam,
    },
  ],

  // ── Voice (2) ──
  [
    'get',
    '/api/v1/voice/capabilities',
    {
      summary: 'Get voice capabilities and providers',
      tags: ['Voice'],
      response: z.object({
        voice: z.object({
          enabled: z.boolean(),
          twilio: z.boolean().optional(),
          stt: z.object({ provider: z.string(), configured: z.boolean() }).optional(),
          tts: z.object({ provider: z.string(), configured: z.boolean() }).optional(),
        }),
      }),
    },
  ],
  [
    'post',
    '/api/v1/voice/token',
    {
      summary: 'Generate voice access token',
      tags: ['Voice'],
      response: z.object({ token: z.string(), identity: z.string(), expiresIn: z.number() }),
    },
  ],
];

let cachedSpec: Record<string, unknown> | null = null;

export async function GET(request: NextRequest) {
  const accessError = requireInternalNetworkAccess(request);
  if (accessError) {
    return accessError;
  }

  if (!cachedSpec) {
    const registry = createRouteRegistry();

    for (const [method, path, schema] of routes) {
      registry.registerRoute(method, path, schema);
    }

    cachedSpec = registry.generateSpec({
      title: 'Agent Studio API',
      version: '1.0.0',
      description: 'Studio API for agent design, project management, auth, and administration',
      servers: [
        { url: `http://localhost:${DEFAULT_STUDIO_PORT}`, description: 'Local development' },
      ],
    });
  }

  return NextResponse.json(cachedSpec);
}
