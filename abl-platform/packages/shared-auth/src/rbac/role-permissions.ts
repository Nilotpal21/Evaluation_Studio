/**
 * Centralized Role Permission Definitions
 *
 * THE SINGLE SOURCE OF TRUTH for all role-to-permission mappings in the platform.
 * Both tenant-level and project-level roles are defined here.
 *
 * Consumers:
 *   - Runtime RBAC middleware (evaluateProjectPermission)
 *   - Runtime permission resolution (resolveEffectivePermissions fallback)
 *   - Studio permission resolution (resolveStudioPermissions fallback)
 *   - Database schema validation (ProjectMember.role enum)
 *   - Project I/O ownership permission resolution
 *   - Custom role validation (permission ceiling, allowlist)
 *
 * IMPORTANT: When adding new permission strings, update both the role maps
 * AND the VALID_CUSTOM_ROLE_PERMISSIONS allowlist below.
 */

import { hasPermission } from './permission-resolver.js';

export const BILLING_READ_PERMISSION = 'billing:read' as const;

// =============================================================================
// TENANT-LEVEL ROLE PERMISSIONS
// =============================================================================

/**
 * Tenant-level (workspace) role permissions.
 * Keys are UPPERCASE role names matching TenantMember.role values.
 *
 * Aligned with SYSTEM_ROLES in packages/database/src/constants/system-roles.ts.
 * A sync test verifies these stay in sync.
 */
export const TENANT_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  OWNER: ['*:*'],
  ADMIN: [
    'tenant:read',
    'tenant:update',
    'tenant:manage_settings',
    'tenant:manage_members',
    BILLING_READ_PERMISSION,
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
  OPERATOR: [
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
  MEMBER: [
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
  VIEWER: [
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
  AUDITOR: ['tenant:read', 'auth-profile:read'],
} as const;

/** Valid tenant role names */
export type TenantRoleName = keyof typeof TENANT_ROLE_PERMISSIONS;

/** All tenant role names as an array (useful for validation) */
export const TENANT_ROLE_NAMES = Object.keys(TENANT_ROLE_PERMISSIONS) as TenantRoleName[];

// =============================================================================
// PROJECT-LEVEL ROLE PERMISSIONS
// =============================================================================

/**
 * Project-level role permissions.
 * Keys are lowercase role names matching ProjectMember.role values.
 */
export const PROJECT_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  admin: ['*:*'],
  developer: [
    'agent:*',
    'tool:*',
    'version:*',
    'deployment:read',
    'channel:read',
    'channel:create',
    'channel:update',
    'channel:delete',
    'env_var:read',
    'session:*',
    'workflow:*',
    'channel_connection:*',
    'credential:*',
    'lookup_data:*',
    'project:export',
    'project:import',
    'attachment:read',
    // Guardrails + PII — developers configure agent guardrails as part of
    // shipping; without read+write the screen 403s. (Audit-flagged.)
    'guardrail:read',
    'guardrail:write',
    'pii-pattern:read',
    'pii-pattern:write',
    'prompt:*',
    'external_agent:*',
    'analytics:read',
    'governance:write',
  ],
  tester: [
    'agent:read',
    'tool:read',
    'version:read',
    'deployment:read',
    'channel:read',
    'env_var:read',
    'session:read',
    'session:create',
    'workflow:read',
    'channel_connection:read',
    'credential:read',
    'lookup_data:read',
    'attachment:read',
    'simulate:execute',
    'analytics:read',
    // Read-only access to guardrail / PII configuration so testers can
    // verify the safety policies that wrap an agent under test.
    'guardrail:read',
    'pii-pattern:read',
    'prompt:read',
    'prompt:test',
    'external_agent:read',
    'governance:audit-read',
  ],
  viewer: [
    'agent:read',
    'tool:read',
    'version:read',
    'deployment:read',
    'channel:read',
    'env_var:read',
    'session:read',
    'workflow:read',
    'channel_connection:read',
    'credential:read',
    'lookup_data:read',
    'project:export',
    'attachment:read',
    'guardrail:read',
    'pii-pattern:read',
    'prompt:read',
    'external_agent:read',
    'analytics:read',
    'governance:audit-read',
  ],
} as const;

/** Valid project role names */
export type ProjectRoleName = keyof typeof PROJECT_ROLE_PERMISSIONS;

/** All project role names as an array (useful for Zod enums, dropdowns) */
export const PROJECT_ROLE_NAMES = Object.keys(PROJECT_ROLE_PERMISSIONS) as ProjectRoleName[];

// =============================================================================
// CUSTOM ROLE PERMISSION CONTROLS
// =============================================================================

/**
 * Permission Registry — THE SINGLE SOURCE OF TRUTH for custom role permissions.
 *
 * Every permission that can be assigned to a custom role is defined here,
 * grouped by domain category with human-readable labels.
 *
 * Consumers:
 *   - VALID_CUSTOM_ROLE_PERMISSIONS (derived flat list, used for validation)
 *   - Studio CustomRolesPage (imports categories directly for the UI)
 *   - validateCustomRolePermissions() (uses the flat list)
 *
 * To add a new permission: add it to the appropriate category below.
 * Both the validation allowlist AND the UI will pick it up automatically.
 */
export interface PermissionCategory {
  /** Machine-readable category key */
  readonly category: string;
  /** Human-readable label for UI display */
  readonly label: string;
  /** Permissions in this category */
  readonly permissions: readonly string[];
}

export const PERMISSION_REGISTRY: readonly PermissionCategory[] = [
  // ── Workspace-level ──────────────────────────────────────────────────
  {
    category: 'workspace',
    label: 'Workspace',
    permissions: [
      'tenant:read',
      'tenant:update',
      'tenant:manage_settings',
      'tenant:manage_members',
      BILLING_READ_PERMISSION,
    ],
  },
  // ── Project-level ────────────────────────────────────────────────────
  {
    category: 'project',
    label: 'Project',
    permissions: [
      'project:read',
      'project:create',
      'project:update',
      'project:export',
      'project:import',
    ],
  },
  {
    category: 'agents',
    label: 'Agents',
    permissions: ['agent:read', 'agent:create', 'agent:update', 'agent:delete', 'agent:execute'],
  },
  {
    category: 'tools',
    label: 'Tools',
    permissions: ['tool:read', 'tool:write', 'tool:delete', 'tool:execute'],
  },
  {
    category: 'versions',
    label: 'Versions',
    permissions: ['version:read', 'version:create', 'version:update', 'version:delete'],
  },
  {
    category: 'workflows',
    label: 'Workflows',
    permissions: [
      'workflow:read',
      'workflow:write',
      'workflow:create',
      'workflow:update',
      'workflow:delete',
      'workflow:execute',
    ],
  },
  {
    category: 'sessions',
    label: 'Sessions',
    permissions: [
      'session:read',
      'session:create',
      'session:write',
      'session:execute',
      'session:delete',
      'session:send_message',
    ],
  },
  {
    category: 'deployments',
    label: 'Deployments',
    permissions: ['deployment:read', 'deployment:create', 'deployment:retire'],
  },
  {
    category: 'channels',
    label: 'Channels',
    permissions: ['channel:read', 'channel:create', 'channel:update', 'channel:delete'],
  },
  {
    category: 'channel_connections',
    label: 'Channel Connections',
    permissions: [
      'channel_connection:read',
      'channel_connection:create',
      'channel_connection:update',
      'channel_connection:delete',
    ],
  },
  {
    category: 'environments',
    label: 'Environments',
    permissions: ['environment:read', 'environment:deploy'],
  },
  {
    category: 'env_vars',
    label: 'Environment Variables',
    permissions: ['env_var:read', 'env_var:create', 'env_var:update', 'env_var:delete'],
  },
  {
    category: 'credentials',
    label: 'Credentials',
    permissions: ['credential:read', 'credential:write', 'credential:delete', 'credential:manage'],
  },
  {
    category: 'connections',
    label: 'Connections',
    permissions: ['connection:read', 'connection:write', 'connection:delete'],
  },
  {
    category: 'knowledge_base',
    label: 'Knowledge Base',
    permissions: ['knowledge_base:read', 'document:write', 'permission:write'],
  },
  {
    category: 'lookup_data',
    label: 'Lookup Data',
    permissions: ['lookup_data:read', 'lookup_data:write', 'lookup_data:delete'],
  },
  // ── Security & Config ────────────────────────────────────────────────
  {
    category: 'auth_profiles',
    label: 'Auth Profiles',
    permissions: [
      'auth-profile:read',
      'auth-profile:create',
      'auth-profile:write',
      'auth-profile:delete',
      'auth-profile:decrypt',
    ],
  },
  {
    category: 'guardrails',
    label: 'Guardrails & PII',
    permissions: ['guardrail:read', 'guardrail:write', 'pii-pattern:read', 'pii-pattern:write'],
  },
  {
    category: 'privacy',
    label: 'Privacy',
    permissions: ['pii:reveal'],
  },
  {
    category: 'runtime_config',
    label: 'Runtime Config',
    permissions: ['runtime_config:read', 'runtime_config:write'],
  },
  {
    category: 'model_config',
    label: 'Model Config',
    permissions: ['model_config:read', 'model_config:write'],
  },
  // ── Operations ───────────────────────────────────────────────────────
  {
    category: 'modules',
    label: 'Modules',
    permissions: ['module:read', 'module:manage', 'module:publish', 'module:import'],
  },
  {
    category: 'namespaces',
    label: 'Namespaces',
    permissions: ['namespace:read', 'namespace:create', 'namespace:update', 'namespace:delete'],
  },
  {
    category: 'human_tasks',
    label: 'Human Tasks',
    permissions: ['human_task:read', 'human_task:assign', 'human_task:claim', 'human_task:resolve'],
  },
  {
    category: 'attachments',
    label: 'Attachments',
    permissions: ['attachment:read', 'attachment:write'],
  },
  {
    category: 'proxy',
    label: 'Proxy',
    permissions: ['proxy:read', 'proxy:write', 'proxy:delete'],
  },
  // ── Read-only / Admin ────────────────────────────────────────────────
  {
    category: 'platform_keys',
    label: 'Platform Keys & Secrets',
    permissions: ['api_key:read', 'secret:read'],
  },
  {
    category: 'analytics',
    label: 'Analytics & Simulate',
    permissions: ['analytics:read', 'simulate:execute'],
  },
  {
    category: 'kms',
    label: 'KMS',
    permissions: ['kms:admin'],
  },
  {
    category: 'prompt-library',
    label: 'Prompt Library',
    permissions: [
      'prompt:create',
      'prompt:read',
      'prompt:update',
      'prompt:delete',
      'prompt:test',
      'prompt:promote',
    ],
  },
  {
    category: 'external_agents',
    label: 'External Agents',
    permissions: [
      'external_agent:create',
      'external_agent:read',
      'external_agent:update',
      'external_agent:delete',
    ],
  },
  {
    category: 'governance',
    label: 'Governance',
    permissions: ['governance:write', 'governance:audit-read'],
  },
] as const;

/**
 * Flat allowlist derived from PERMISSION_REGISTRY.
 * Used for validation — no permissions should be defined outside the registry.
 */
export const VALID_CUSTOM_ROLE_PERMISSIONS: readonly string[] = PERMISSION_REGISTRY.flatMap(
  (c) => c.permissions,
);

type CustomProjectRolePermissions = readonly string[] | string | null | undefined;

function resolveCustomProjectRolePermissions(
  permissions: CustomProjectRolePermissions,
): readonly string[] {
  if (!permissions) {
    return [];
  }

  let rawPermissions: unknown = permissions;

  if (typeof permissions === 'string') {
    const trimmedPermissions = permissions.trim();
    if (trimmedPermissions.length === 0) {
      return [];
    }

    try {
      rawPermissions = JSON.parse(trimmedPermissions);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(rawPermissions)) {
    return [];
  }

  const normalizedPermissions = rawPermissions.filter(
    (permission): permission is string => typeof permission === 'string' && permission.length > 0,
  );
  const { invalid } = validateCustomRolePermissions(normalizedPermissions);
  if (invalid.length === 0) {
    return [...new Set(normalizedPermissions)];
  }

  const invalidPermissions = new Set(invalid);
  return [
    ...new Set(normalizedPermissions.filter((permission) => !invalidPermissions.has(permission))),
  ];
}

function resolveProjectPermissionSource(
  role: string | null | undefined,
  customRolePermissions?: CustomProjectRolePermissions,
): readonly string[] {
  const normalizedRole = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const builtInPermissions = PROJECT_ROLE_PERMISSIONS[normalizedRole];
  if (builtInPermissions) {
    return builtInPermissions;
  }

  if (normalizedRole === 'custom') {
    return resolveCustomProjectRolePermissions(customRolePermissions);
  }

  return [];
}

/**
 * Validate that a list of permissions contains only allowed values.
 * Rejects wildcards (* :*) and unknown permission strings.
 */
export function validateCustomRolePermissions(permissions: string[]): {
  valid: boolean;
  invalid: string[];
} {
  const allowSet = new Set<string>(VALID_CUSTOM_ROLE_PERMISSIONS);
  const invalid = permissions.filter((permission) => !allowSet.has(permission));
  return { valid: invalid.length === 0, invalid };
}

/**
 * Get the permission ceiling for a given creator's tenant role.
 * A user can only create custom roles with permissions they themselves have.
 */
export function getPermissionCeiling(creatorTenantRole: string): readonly string[] {
  return TENANT_ROLE_PERMISSIONS[creatorTenantRole.toUpperCase()] ?? [];
}

/**
 * Evaluate whether a project member role grants a required permission.
 *
 * Built-in roles resolve from PROJECT_ROLE_PERMISSIONS. Custom roles resolve from
 * the supplied permission list and are filtered through the custom-role allowlist
 * so invalid or wildcard permissions fail closed.
 */
export function evaluateProjectPermission(
  role: string | null | undefined,
  requiredPermission: string,
  customRolePermissions?: CustomProjectRolePermissions,
): boolean {
  const grantedPermissions = resolveProjectPermissionSource(role, customRolePermissions);
  return hasPermission(grantedPermissions, requiredPermission);
}
