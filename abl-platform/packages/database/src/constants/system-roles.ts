/**
 * System Role Definitions
 *
 * Canonical list of built-in RBAC roles seeded into every new tenant.
 * Used by:
 *   - seed-mongo.ts (initial DB seed)
 *   - workspace-repo.ts (new workspace creation)
 *
 * Keep in sync with platform RBAC documentation.
 */

export interface SystemRoleDefinition {
  name: string;
  description: string;
  permissions: string[];
}

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    name: 'OWNER',
    description: 'Full access to all resources and operations',
    permissions: ['*:*'],
  },
  {
    name: 'ADMIN',
    description: 'All operations except tenant deletion and billing management',
    permissions: [
      'tenant:read',
      'tenant:update',
      'tenant:manage_settings',
      'tenant:manage_members',
      'project:*',
      'agent:*',
      'tool:*',
      'environment:*',
      'knowledge_base:*',
      'workflow:*',
      'deployment:*',
      'api_key:*',
      'secret:*',
      'credential:*',
      'auth-profile:*',
      'guardrail:read',
      'guardrail:write',
      'pii-pattern:read',
      'pii-pattern:write',
      'proxy:*',
      'module:*',
      'kms:admin',
    ],
  },
  {
    name: 'OPERATOR',
    description: 'Read all, execute agents, deploy to dev/staging, manage sessions',
    permissions: [
      'tenant:read',
      'project:read',
      'agent:read',
      'agent:execute',
      'tool:read',
      'tool:execute',
      'environment:read',
      'environment:deploy',
      'knowledge_base:read',
      'workflow:read',
      'workflow:execute',
      'deployment:read',
      'deployment:create',
      'api_key:read',
      'secret:read',
      'credential:read',
      'proxy:read',
      'module:read',
      'module:import',
    ],
  },
  {
    name: 'MEMBER',
    description: 'Read all, create projects, update agents and tools, execute',
    permissions: [
      'tenant:read',
      'project:create',
      'project:read',
      'project:update',
      'agent:read',
      'agent:update',
      'agent:execute',
      'tool:read',
      'tool:write',
      'tool:execute',
      'environment:read',
      'knowledge_base:read',
      'workflow:read',
      'deployment:read',
      'api_key:read',
      'secret:read',
      'credential:read',
      'module:read',
      'module:import',
    ],
  },
  {
    name: 'VIEWER',
    description: 'Read-only access to all resources',
    permissions: [
      'tenant:read',
      'project:read',
      'agent:read',
      'tool:read',
      'environment:read',
      'knowledge_base:read',
      'workflow:read',
      'deployment:read',
      'api_key:read',
      'secret:read',
      'credential:read',
      'module:read',
    ],
  },
  {
    name: 'AUDITOR',
    description: 'Audit-only access to auth profiles for compliance review',
    permissions: ['tenant:read', 'auth-profile:read'],
  },
];
