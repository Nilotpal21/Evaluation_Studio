export interface ScopeEntry {
  /** Human-readable label for UI display */
  readonly label: string;
  /** Description shown in UI and API responses */
  readonly description: string;
  /** UI grouping category */
  readonly category: 'execution' | 'management' | 'knowledge_base' | 'analytics' | 'admin';
  /** RBAC permissions granted when the scope is resolved */
  readonly requiredPermissions: readonly string[];
}

export const PLATFORM_KEY_SCOPES = {
  'workflows.execute': {
    label: 'Execute Workflows',
    description: 'Execute workflows via Process API',
    category: 'execution',
    requiredPermissions: ['workflow:read', 'workflow:execute'],
  },
  'workflows.read': {
    label: 'Read Workflows',
    description: 'Read workflow definitions and status',
    category: 'execution',
    requiredPermissions: ['workflow:read'],
  },
  'chat.execute': {
    label: 'Execute Chat',
    description: 'Send messages to agents via Chat API',
    category: 'execution',
    requiredPermissions: ['agent:execute', 'session:send_message'],
  },
  'agents.read': {
    label: 'Read Agents',
    description: 'List and inspect agent configurations',
    category: 'management',
    requiredPermissions: ['agent:read'],
  },
  'agents.write': {
    label: 'Write Agents',
    description: 'Create and update agent configurations',
    category: 'management',
    requiredPermissions: ['agent:read', 'agent:create', 'agent:update'],
  },
  'deployments.read': {
    label: 'Read Deployments',
    description: 'List deployment status and history',
    category: 'management',
    requiredPermissions: ['deployment:read'],
  },
  'deployments.write': {
    label: 'Write Deployments',
    description: 'Create and promote deployments',
    category: 'management',
    requiredPermissions: ['deployment:read', 'deployment:create'],
  },
  'sessions.read': {
    label: 'Read Sessions',
    description: 'Read session history and transcripts',
    category: 'management',
    requiredPermissions: ['session:read'],
  },
  'search.query': {
    label: 'Query Knowledge Base',
    description: 'Execute search queries against knowledge bases',
    category: 'knowledge_base',
    requiredPermissions: ['knowledge_base:read'],
  },
  'search.read': {
    label: 'Read Knowledge Base',
    description: 'Read knowledge base metadata and configurations',
    category: 'knowledge_base',
    requiredPermissions: ['knowledge_base:read'],
  },
  'search.ingest': {
    label: 'Ingest Documents',
    description: 'Upload files and ingest data into knowledge bases',
    category: 'knowledge_base',
    requiredPermissions: ['knowledge_base:read', 'document:write'],
  },
  'search.permission_write': {
    label: 'Write Document Permissions',
    description: 'Set document-level ACL permissions during ingestion',
    category: 'knowledge_base',
    requiredPermissions: ['knowledge_base:read', 'document:write', 'permission:write'],
  },
  'analytics.read': {
    label: 'Read Analytics',
    description: 'Read analytics dashboards and metrics',
    category: 'analytics',
    requiredPermissions: ['analytics:read'],
  },
  'tenant.read': {
    label: 'Read Workspace',
    description: 'Read workspace settings and usage data',
    category: 'admin',
    requiredPermissions: ['tenant:read'],
  },
} as const satisfies Record<string, ScopeEntry>;

export const PLATFORM_KEY_SCOPE_KEYS = Object.keys(PLATFORM_KEY_SCOPES) as Array<
  keyof typeof PLATFORM_KEY_SCOPES
>;

export type ScopeCategory = ScopeEntry['category'];
