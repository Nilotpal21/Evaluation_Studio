/**
 * Studio Permission Constants
 *
 * Typed permission identifiers for all Studio RBAC checks.
 * Uses `resource:operation` format compatible with the shared
 * `hasPermission()` / `hasAnyPermission()` from @agent-platform/shared/rbac.
 *
 * Usage:
 *   import { StudioPermission } from '@/lib/permissions';
 *   withRouteHandler({ permissions: StudioPermission.TOOL_READ }, handler);
 */

// ─── Permission Constants ─────────────────────────────────────────────────

export const StudioPermission = {
  // Tool operations (covers both tools and MCP servers)
  TOOL_READ: 'tool:read',
  TOOL_WRITE: 'tool:write',
  TOOL_DELETE: 'tool:delete',
  TOOL_EXECUTE: 'tool:execute',

  // Workflow operations
  WORKFLOW_READ: 'workflow:read',
  WORKFLOW_WRITE: 'workflow:write',
  WORKFLOW_DELETE: 'workflow:delete',
  WORKFLOW_EXECUTE: 'workflow:execute',

  // Connection operations
  CONNECTION_READ: 'connection:read',
  CONNECTION_WRITE: 'connection:write',
  CONNECTION_DELETE: 'connection:delete',

  // Approval operations
  APPROVAL_READ: 'approval:read',
  APPROVAL_WRITE: 'approval:write',

  // Human task (Inbox) operations — project-scoped
  HUMAN_TASK_READ: 'human_task:read',
  HUMAN_TASK_ASSIGN: 'human_task:assign',
  HUMAN_TASK_CLAIM: 'human_task:claim',
  HUMAN_TASK_RESOLVE: 'human_task:resolve',

  // Project-level operations
  PROJECT_READ: 'project:read',
  PROJECT_EXPORT: 'project:export',
  PROJECT_IMPORT: 'project:import',
  PROJECT_GIT: 'project:git',
  PROJECT_DEPLOY: 'project:deploy',

  // Auth Profile operations
  AUTH_PROFILE_READ: 'auth-profile:read',
  AUTH_PROFILE_WRITE: 'auth-profile:write',
  AUTH_PROFILE_DELETE: 'auth-profile:delete',
  AUTH_PROFILE_DECRYPT: 'auth-profile:decrypt',

  // External Agent (A2A) registry operations
  EXTERNAL_AGENT_READ: 'external_agent:read',
  EXTERNAL_AGENT_CREATE: 'external_agent:create',
  EXTERNAL_AGENT_UPDATE: 'external_agent:update',
  EXTERNAL_AGENT_DELETE: 'external_agent:delete',

  // Admin operations (OWNER/ADMIN role required)
  ADMIN_BILLING: 'admin:billing',
  ADMIN_KMS: 'admin:kms',
  ADMIN_ENV_VARS: 'admin:env-vars',
  ADMIN_ALERTS: 'admin:alerts',
  ADMIN_CHANNELS: 'admin:channels',
  ADMIN_GUARDRAILS: 'admin:guardrails',

  // Privacy operations
  GUARDRAIL_READ: 'guardrail:read',
  GUARDRAIL_WRITE: 'guardrail:write',
  PII_PATTERN_READ: 'pii-pattern:read',
  PII_PATTERN_WRITE: 'pii-pattern:write',
  PII_REVEAL: 'pii:reveal',

  // Module operations
  MODULE_READ: 'module:read',
  MODULE_MANAGE: 'module:manage',
  MODULE_PUBLISH: 'module:publish',
  MODULE_IMPORT: 'module:import',

  // Prompt Library operations
  PROMPT_CREATE: 'prompt:create',
  PROMPT_READ: 'prompt:read',
  PROMPT_UPDATE: 'prompt:update',
  PROMPT_DELETE: 'prompt:delete',
  PROMPT_TEST: 'prompt:test',
  PROMPT_PROMOTE: 'prompt:promote',
} as const;

export type StudioPermission = (typeof StudioPermission)[keyof typeof StudioPermission];
