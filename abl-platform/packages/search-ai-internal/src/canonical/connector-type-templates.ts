/**
 * Connector Type Schema Templates
 *
 * Pre-defined mapping hints for 8 connector categories covering 65+ connectors.
 * Used by MappingSuggestionService, BaseSchemaDiscoveryService, and
 * VocabularyGenerationWorker to narrow the LLM's mapping scope.
 *
 * These are code constants, not database records. Adding a new category
 * requires a code change and deploy.
 */

// ─── Types ───────────────────────────────────────────────────────────────

/** Predefined enum pattern for a canonical field */
export interface EnumPattern {
  /** Enum values (the actual values stored/filtered) */
  values: string[];
  /** Optional display names: value → display label */
  displayNames?: Record<string, string>;
}

/** Deterministic mapping: source path → canonical field (confidence 1.0) */
export interface FixedMapping {
  /** Source field path (must match DiscoveredField.path exactly) */
  sourcePath: string;
  /** Target canonical storage field */
  canonicalField: string;
  /** Transform to apply (default: direct) */
  transform?: 'direct' | 'parse_date' | 'lowercase' | 'value_map';
}

export interface ConnectorTypeTemplate {
  /** Category identifier */
  category: string;
  /** Human-readable category name */
  label: string;
  /** Connector type slugs in this category */
  connectors: string[];
  /**
   * Deterministic mappings for well-known source paths.
   * Applied first with confidence 1.0 — no algorithm needed.
   * Key: connector type slug. Value: fixed mappings for that connector's standard fields.
   */
  fixedMappings?: Record<string, FixedMapping[]>;
  /** Canonical field → typical source field name patterns (for rule-based matching) */
  fieldPatterns: Record<string, string[]>;
  /** Which canonical fields are typically relevant for this category */
  relevantFields: string[];
  /** Expected number of custom fields per instance */
  expectedCustomFields: number;
  /** Predefined enum patterns for fields with known static enums */
  enumPatterns?: Record<string, EnumPattern>;
}

// ─── Templates ───────────────────────────────────────────────────────────

const ISSUE_TICKET: ConnectorTypeTemplate = {
  category: 'issue_ticket',
  label: 'Issue / Ticket Tracker',
  connectors: [
    'jira',
    'linear',
    'asana',
    'monday',
    'clickup',
    'shortcut',
    'youtrack',
    'trello',
    'basecamp',
    'wrike',
    'teamwork',
    'notion',
  ],
  fieldPatterns: {
    title: ['summary', 'name', 'title', 'subject', 'task_name'],
    status: ['status', 'state', 'stage', 'status.name'],
    priority: ['priority', 'urgency', 'importance', 'priority.name'],
    assignee: ['assignee', 'assigned_to', 'owner', 'assignee.displayName'],
    reporter: ['reporter', 'creator', 'created_by', 'reporter.displayName'],
    category: ['issuetype', 'issue_type', 'type', 'kind', 'issuetype.name'],
    tags: ['labels', 'tags', 'keywords'],
    project: ['project', 'project.key', 'project.name', 'workspace'],
    sprint: ['sprint', 'sprint.name', 'iteration'],
    epic: ['epic', 'epic.name', 'parent', 'parent.key'],
    story_points: ['story_points', 'points', 'estimate', 'storyPoints'],
    component: ['components', 'component', 'module', 'area'],
    severity: ['severity', 'impact'],
    resolution: ['resolution', 'resolution.name'],
    due_date: ['duedate', 'due_date', 'deadline', 'target_date'],
    resolved_date: ['resolutiondate', 'resolved_date', 'closed_date', 'completedAt'],
    comment_count: ['comment_count', 'comments.total'],
    description: ['description', 'body', 'content'],
  },
  relevantFields: [
    'title',
    'status',
    'priority',
    'assignee',
    'reporter',
    'category',
    'tags',
    'project',
    'sprint',
    'epic',
    'story_points',
    'component',
    'severity',
    'resolution',
    'due_date',
    'resolved_date',
    'comment_count',
    'description',
  ],
  expectedCustomFields: 5,
  enumPatterns: {
    priority: {
      values: ['critical', 'high', 'medium', 'low', 'trivial'],
      displayNames: {
        critical: 'Critical',
        high: 'High',
        medium: 'Medium',
        low: 'Low',
        trivial: 'Trivial',
      },
    },
    status: {
      values: ['open', 'in_progress', 'resolved', 'closed', 'reopened'],
      displayNames: {
        open: 'Open',
        in_progress: 'In Progress',
        resolved: 'Resolved',
        closed: 'Closed',
        reopened: 'Reopened',
      },
    },
    severity: {
      values: ['blocker', 'critical', 'major', 'minor', 'trivial'],
      displayNames: {
        blocker: 'Blocker',
        critical: 'Critical',
        major: 'Major',
        minor: 'Minor',
        trivial: 'Trivial',
      },
    },
    resolution: {
      values: ['fixed', 'wont_fix', 'duplicate', 'cannot_reproduce', 'done'],
      displayNames: {
        fixed: 'Fixed',
        wont_fix: "Won't Fix",
        duplicate: 'Duplicate',
        cannot_reproduce: 'Cannot Reproduce',
        done: 'Done',
      },
    },
  },
};

const DOCUMENT_PAGE: ConnectorTypeTemplate = {
  category: 'document_page',
  label: 'Document / Page',
  connectors: [
    'confluence',
    'notion',
    'sharepoint_pages',
    'google_docs',
    'dropbox_paper',
    'coda',
    'quip',
  ],
  fieldPatterns: {
    title: ['title', 'name', 'page_title'],
    author: ['creator', 'author', 'created_by', 'creator.publicName'],
    content_summary: ['excerpt', 'abstract', 'summary'],
    category: ['type', 'content_type', 'page_type'],
    tags: ['labels', 'tags', 'metadata.labels'],
    department: ['space', 'space.key', 'team', 'department'],
    version: ['version', 'version.number'],
    parent_id: ['parent', 'parent.id', 'parentId'],
    modified_date: ['lastModified', 'updated', 'modifiedDate', 'history.lastUpdated.when'],
    comment_count: ['comment_count', 'metadata.comment.count'],
    is_archived: ['archived', 'is_archived', 'status'],
    description: ['description', 'body.storage.value'],
  },
  relevantFields: [
    'title',
    'author',
    'content_summary',
    'category',
    'tags',
    'department',
    'version',
    'parent_id',
    'modified_date',
    'comment_count',
    'is_archived',
    'description',
  ],
  expectedCustomFields: 3,
  enumPatterns: {
    category: {
      values: ['page', 'blog_post', 'template', 'whiteboard', 'database'],
      displayNames: {
        page: 'Page',
        blog_post: 'Blog Post',
        template: 'Template',
        whiteboard: 'Whiteboard',
        database: 'Database',
      },
    },
    is_archived: {
      values: ['true', 'false'],
      displayNames: { true: 'Archived', false: 'Active' },
    },
  },
};

const FILE_STORAGE: ConnectorTypeTemplate = {
  category: 'file_storage',
  label: 'File / Storage',
  connectors: [
    'google_drive',
    'onedrive',
    'sharepoint',
    'sharepoint_files',
    'dropbox',
    'box',
    's3',
  ],
  fixedMappings: {
    sharepoint: [
      { sourcePath: 'sharepoint.itemName', canonicalField: 'title' },
      { sourcePath: 'sharepoint.createdBy', canonicalField: 'author' },
      { sourcePath: 'sharepoint.lastModifiedBy', canonicalField: 'modified_by' },
      {
        sourcePath: 'sharepoint.createdDateTime',
        canonicalField: 'created_date',
        transform: 'parse_date',
      },
      {
        sourcePath: 'sharepoint.lastModifiedDateTime',
        canonicalField: 'modified_date',
        transform: 'parse_date',
      },
      { sourcePath: 'sharepoint.itemWebUrl', canonicalField: 'source_url' },
      { sourcePath: 'sharepoint.mimeType', canonicalField: 'mime_type' },
      { sourcePath: 'sharepoint.parentPath', canonicalField: 'parent_id' },
      { sourcePath: 'sharepoint.siteId', canonicalField: 'department' },
      { sourcePath: 'sharepoint.driveId', canonicalField: 'project' },
      { sourcePath: 'sharepoint.size', canonicalField: 'attachment_count' },
    ],
    sharepoint_files: [
      { sourcePath: 'sharepoint.itemName', canonicalField: 'title' },
      { sourcePath: 'sharepoint.createdBy', canonicalField: 'author' },
      { sourcePath: 'sharepoint.lastModifiedBy', canonicalField: 'modified_by' },
      {
        sourcePath: 'sharepoint.createdDateTime',
        canonicalField: 'created_date',
        transform: 'parse_date',
      },
      {
        sourcePath: 'sharepoint.lastModifiedDateTime',
        canonicalField: 'modified_date',
        transform: 'parse_date',
      },
      { sourcePath: 'sharepoint.itemWebUrl', canonicalField: 'source_url' },
      { sourcePath: 'sharepoint.mimeType', canonicalField: 'mime_type' },
      { sourcePath: 'sharepoint.parentPath', canonicalField: 'parent_id' },
      { sourcePath: 'sharepoint.siteId', canonicalField: 'department' },
      { sourcePath: 'sharepoint.driveId', canonicalField: 'project' },
      { sourcePath: 'sharepoint.size', canonicalField: 'attachment_count' },
    ],
    google_drive: [
      { sourcePath: 'name', canonicalField: 'title' },
      { sourcePath: 'owners', canonicalField: 'author' },
      { sourcePath: 'createdTime', canonicalField: 'created_date' },
      { sourcePath: 'modifiedTime', canonicalField: 'modified_date' },
      { sourcePath: 'webViewLink', canonicalField: 'source_url' },
      { sourcePath: 'mimeType', canonicalField: 'mime_type' },
      { sourcePath: 'parents', canonicalField: 'parent_id' },
      { sourcePath: 'size', canonicalField: 'attachment_count' },
      { sourcePath: 'trashed', canonicalField: 'is_archived' },
    ],
    onedrive: [
      { sourcePath: 'name', canonicalField: 'title' },
      { sourcePath: 'createdBy', canonicalField: 'author' },
      { sourcePath: 'createdDateTime', canonicalField: 'created_date' },
      { sourcePath: 'lastModifiedDateTime', canonicalField: 'modified_date' },
      { sourcePath: 'webUrl', canonicalField: 'source_url' },
      { sourcePath: 'file/mimeType', canonicalField: 'mime_type' },
      { sourcePath: 'parentReference', canonicalField: 'parent_id' },
      { sourcePath: 'size', canonicalField: 'attachment_count' },
    ],
  },
  fieldPatterns: {
    title: ['name', 'title', 'fileName'],
    author: ['owners', 'createdBy', 'creator'],
    modified_by: ['lastModifyingUser', 'lastModifiedBy', 'modifiedBy'],
    mime_type: ['mimeType', 'contentType', 'file_type'],
    source_url: ['webViewLink', 'webUrl', 'url', 'link'],
    created_date: ['createdTime', 'createdDateTime', 'created_at'],
    modified_date: ['modifiedTime', 'lastModifiedDateTime', 'modified_at', 'client_modified'],
    access_level: ['shared', 'sharingInfo', 'permissions'],
    parent_id: ['parents', 'parentReference', 'path_display'],
    attachment_count: ['size', 'fileSize'],
    is_archived: ['trashed', 'deleted', 'archived'],
  },
  relevantFields: [
    'title',
    'author',
    'modified_by',
    'mime_type',
    'source_url',
    'created_date',
    'modified_date',
    'access_level',
    'parent_id',
    'attachment_count',
    'is_archived',
  ],
  expectedCustomFields: 2,
  enumPatterns: {
    mime_type: {
      values: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
        'text/html',
        'image/jpeg',
        'image/png',
        'image/gif',
      ],
      displayNames: {
        'application/pdf': 'PDF Document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word Document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel Spreadsheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
        'text/plain': 'Plain Text',
        'text/csv': 'CSV File',
        'text/html': 'HTML Page',
        'image/jpeg': 'JPEG Image',
        'image/png': 'PNG Image',
        'image/gif': 'GIF Image',
      },
    },
    access_level: {
      values: ['private', 'shared', 'public'],
      displayNames: { private: 'Private', shared: 'Shared', public: 'Public' },
    },
  },
};

const CODE_DEVOPS: ConnectorTypeTemplate = {
  category: 'code_devops',
  label: 'Code / DevOps',
  connectors: ['github', 'gitlab', 'bitbucket', 'azure_devops'],
  fieldPatterns: {
    title: ['title', 'name', 'subject', 'message'],
    status: ['state', 'status', 'merged'],
    assignee: ['assignees', 'assignee', 'reviewer', 'author'],
    category: ['type', 'pull_request', 'issue', 'commit'],
    tags: ['labels', 'tags', 'topics'],
    project: ['repository', 'repo', 'full_name'],
    version: ['ref', 'branch', 'tag_name', 'sha'],
    environment: ['environment', 'deployment_environment'],
    component: ['path', 'changed_files', 'directory'],
    description: ['body', 'description', 'message'],
  },
  relevantFields: [
    'title',
    'status',
    'assignee',
    'category',
    'tags',
    'project',
    'version',
    'environment',
    'component',
    'description',
  ],
  expectedCustomFields: 2,
  enumPatterns: {
    status: {
      values: ['open', 'closed', 'merged', 'draft'],
      displayNames: { open: 'Open', closed: 'Closed', merged: 'Merged', draft: 'Draft' },
    },
    category: {
      values: ['pull_request', 'issue', 'commit', 'release', 'branch'],
      displayNames: {
        pull_request: 'Pull Request',
        issue: 'Issue',
        commit: 'Commit',
        release: 'Release',
        branch: 'Branch',
      },
    },
  },
};

const COMMUNICATION: ConnectorTypeTemplate = {
  category: 'communication',
  label: 'Communication',
  connectors: ['slack', 'teams', 'discord', 'gmail', 'outlook', 'intercom', 'front', 'zendesk'],
  fieldPatterns: {
    title: ['subject', 'title', 'topic', 'name'],
    author: ['from', 'sender', 'user', 'author', 'creator'],
    content_summary: ['text', 'snippet', 'preview', 'bodyPreview'],
    created_date: ['ts', 'date', 'sentDateTime', 'created_at'],
    tags: ['labels', 'tags', 'categories'],
    category: ['channel', 'type', 'thread_type', 'conversationType'],
    customer: ['to', 'recipient', 'contact', 'requester'],
    status: ['status', 'state', 'read', 'isRead'],
    description: ['body', 'text', 'content', 'html_body'],
  },
  relevantFields: [
    'title',
    'author',
    'content_summary',
    'created_date',
    'tags',
    'category',
    'customer',
    'status',
    'description',
  ],
  expectedCustomFields: 3,
  enumPatterns: {
    status: {
      values: ['read', 'unread', 'archived', 'snoozed'],
      displayNames: { read: 'Read', unread: 'Unread', archived: 'Archived', snoozed: 'Snoozed' },
    },
    category: {
      values: ['channel', 'direct_message', 'thread', 'email', 'group'],
      displayNames: {
        channel: 'Channel',
        direct_message: 'Direct Message',
        thread: 'Thread',
        email: 'Email',
        group: 'Group',
      },
    },
  },
};

const CRM_SALES: ConnectorTypeTemplate = {
  category: 'crm_sales',
  label: 'CRM / Sales',
  connectors: ['salesforce', 'hubspot', 'pipedrive', 'zoho_crm', 'freshsales', 'close'],
  fieldPatterns: {
    title: ['Name', 'name', 'subject', 'dealname', 'deal_name'],
    status: ['Status', 'status', 'StageName'],
    stage: ['Stage', 'pipeline_stage', 'StageName', 'dealstage'],
    customer: ['Account', 'company', 'AccountName', 'associatedcompanyid'],
    deal_amount: ['Amount', 'amount', 'value', 'dealAmount'],
    assignee: ['Owner', 'OwnerId', 'hubspot_owner_id', 'owner'],
    priority: ['Priority', 'priority', 'Rating'],
    tags: ['Tags', 'tags', 'labels'],
    due_date: ['CloseDate', 'close_date', 'expected_close_date'],
    category: ['Type', 'RecordType', 'pipeline', 'objectType'],
    description: ['Description', 'description', 'notes'],
  },
  relevantFields: [
    'title',
    'status',
    'stage',
    'customer',
    'deal_amount',
    'assignee',
    'priority',
    'tags',
    'due_date',
    'category',
    'description',
  ],
  expectedCustomFields: 8,
  enumPatterns: {
    status: {
      values: ['new', 'open', 'in_progress', 'won', 'lost', 'closed'],
      displayNames: {
        new: 'New',
        open: 'Open',
        in_progress: 'In Progress',
        won: 'Won',
        lost: 'Lost',
        closed: 'Closed',
      },
    },
    stage: {
      values: [
        'prospecting',
        'qualification',
        'proposal',
        'negotiation',
        'closed_won',
        'closed_lost',
      ],
      displayNames: {
        prospecting: 'Prospecting',
        qualification: 'Qualification',
        proposal: 'Proposal',
        negotiation: 'Negotiation',
        closed_won: 'Closed Won',
        closed_lost: 'Closed Lost',
      },
    },
    priority: {
      values: ['high', 'medium', 'low'],
      displayNames: { high: 'High', medium: 'Medium', low: 'Low' },
    },
  },
};

const INCIDENT_ITSM: ConnectorTypeTemplate = {
  category: 'incident_itsm',
  label: 'Incident / ITSM',
  connectors: ['servicenow', 'pagerduty', 'opsgenie', 'statuspage', 'freshservice'],
  fieldPatterns: {
    title: ['short_description', 'title', 'summary', 'message'],
    status: ['state', 'status', 'incident_status'],
    priority: ['priority', 'urgency', 'severity'],
    severity: ['severity', 'impact', 'incident_severity'],
    assignee: ['assigned_to', 'assignee', 'responders'],
    reporter: ['caller_id', 'reporter', 'created_by'],
    category: ['category', 'type', 'incident_type', 'service'],
    resolution: ['close_notes', 'resolution', 'resolved_summary'],
    environment: ['environment', 'cmdb_ci', 'service'],
    customer: ['company', 'account', 'affected_users'],
    due_date: ['due_date', 'sla_due', 'expected_resolution'],
    resolved_date: ['resolved_at', 'closed_at', 'resolve_time'],
    description: ['description', 'details', 'body'],
  },
  relevantFields: [
    'title',
    'status',
    'priority',
    'severity',
    'assignee',
    'reporter',
    'category',
    'resolution',
    'environment',
    'customer',
    'due_date',
    'resolved_date',
    'description',
  ],
  expectedCustomFields: 4,
  enumPatterns: {
    status: {
      values: ['new', 'investigating', 'identified', 'monitoring', 'resolved'],
      displayNames: {
        new: 'New',
        investigating: 'Investigating',
        identified: 'Identified',
        monitoring: 'Monitoring',
        resolved: 'Resolved',
      },
    },
    priority: {
      values: ['critical', 'high', 'medium', 'low'],
      displayNames: { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' },
    },
    severity: {
      values: ['sev1', 'sev2', 'sev3', 'sev4'],
      displayNames: {
        sev1: 'SEV-1 (Critical)',
        sev2: 'SEV-2 (High)',
        sev3: 'SEV-3 (Medium)',
        sev4: 'SEV-4 (Low)',
      },
    },
  },
};

const GENERIC: ConnectorTypeTemplate = {
  category: 'generic',
  label: 'Generic',
  connectors: ['file_upload'],
  fixedMappings: {
    file_upload: [
      { sourcePath: 'file_upload.title', canonicalField: 'title' },
      { sourcePath: 'file_upload.mimeType', canonicalField: 'mime_type' },
      { sourcePath: 'file_upload.size', canonicalField: 'attachment_count' },
      { sourcePath: 'file_upload.author', canonicalField: 'author' },
      { sourcePath: 'file_upload.category', canonicalField: 'category' },
      { sourcePath: 'file_upload.department', canonicalField: 'department' },
      { sourcePath: 'file_upload.status', canonicalField: 'status' },
      { sourcePath: 'file_upload.tags', canonicalField: 'tags' },
      { sourcePath: 'file_upload.version', canonicalField: 'version' },
      { sourcePath: 'file_upload.description', canonicalField: 'description' },
      { sourcePath: 'file_upload.project', canonicalField: 'project' },
    ],
  },
  fieldPatterns: {
    title: ['title', 'name', 'subject', 'summary'],
    author: ['author', 'creator', 'created_by', 'owner'],
    content_summary: ['summary', 'description', 'excerpt', 'abstract'],
    source_url: ['url', 'link', 'href', 'web_url'],
    created_date: ['created_at', 'createdDate', 'created', 'date'],
    modified_date: ['updated_at', 'modifiedDate', 'modified', 'lastModified'],
    tags: ['tags', 'labels', 'keywords', 'categories'],
    category: ['type', 'category', 'kind', 'class'],
    status: ['status', 'state', 'stage'],
    description: ['description', 'body', 'content', 'text'],
  },
  relevantFields: [
    'title',
    'author',
    'content_summary',
    'source_type',
    'source_url',
    'created_date',
    'modified_date',
    'tags',
    'category',
    'status',
    'description',
  ],
  expectedCustomFields: 5,
  enumPatterns: {
    status: {
      values: ['active', 'inactive', 'archived'],
      displayNames: { active: 'Active', inactive: 'Inactive', archived: 'Archived' },
    },
  },
};

// ─── Registry ────────────────────────────────────────────────────────────

/** All connector type templates indexed by category */
export const CONNECTOR_TYPE_TEMPLATES: Record<string, ConnectorTypeTemplate> = {
  issue_ticket: ISSUE_TICKET,
  document_page: DOCUMENT_PAGE,
  file_storage: FILE_STORAGE,
  code_devops: CODE_DEVOPS,
  communication: COMMUNICATION,
  crm_sales: CRM_SALES,
  incident_itsm: INCIDENT_ITSM,
  generic: GENERIC,
};

/**
 * Get the template for a connector type slug.
 * Returns the matching category template, or Generic if not found.
 */
export function getTemplateForConnector(connectorType: string): ConnectorTypeTemplate {
  const slug = connectorType.toLowerCase();

  for (const template of Object.values(CONNECTOR_TYPE_TEMPLATES)) {
    if (template.connectors.includes(slug)) {
      return template;
    }
  }

  return GENERIC;
}

/**
 * Get fixed (deterministic) mappings for a specific connector type.
 * Returns the exact source path → canonical field mappings, or empty array if none defined.
 */
export function getFixedMappings(connectorType: string): FixedMapping[] {
  const slug = connectorType.toLowerCase();
  const template = getTemplateForConnector(slug);
  return template.fixedMappings?.[slug] ?? [];
}

/**
 * Get suggested canonical field for a source field name using template patterns.
 * Returns the canonical field name if a pattern matches, or null.
 */
export function matchFieldByPattern(
  sourceFieldName: string,
  template: ConnectorTypeTemplate,
): string | null {
  const sourceLower = sourceFieldName.toLowerCase();

  for (const [canonicalField, patterns] of Object.entries(template.fieldPatterns)) {
    for (const pattern of patterns) {
      if (
        sourceLower === pattern.toLowerCase() ||
        sourceLower.endsWith(`.${pattern.toLowerCase()}`)
      ) {
        return canonicalField;
      }
    }
  }

  return null;
}
