/**
 * Shared Types for Agent Platform
 *
 * Auth payload types, request extensions, and common interfaces
 * used across Studio and Runtime.
 *
 * NOTE: Express global augmentation lives in @agent-platform/shared,
 * not here. shared-kernel is framework-agnostic.
 */

/**
 * JWT access token payload (Scenario 1: User login).
 */
export interface JWTPayload {
  sub: string; // User ID
  email: string;
  type: 'access' | 'mfa_pending';
  tokenClass?: 'user'; // Distinguishes from other token types
  tenantId?: string; // REQUIRED in new tokens — scoped to active tenant
  orgId?: string; // Parent organization (if tenant belongs to one)
  role?: string; // Resolved TenantMember role: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
  iat?: number;
  exp?: number;
}

/**
 * Auth type — which authentication path was used.
 */
export type AuthType = 'user' | 'sdk_session' | 'api_key';

export type SDKAuthScope = 'session' | 'user';

/**
 * Tenant context data propagated via AsyncLocalStorage.
 * All three auth flows converge to this shape in the request pipeline.
 */
export interface TenantContextData {
  tenantId: string;
  orgId?: string;
  userId: string; // User ID (scenario 1/3) or "sdk:{channelId}" (scenario 2)
  role: string; // TenantMember role (scenario 1) or "sdk_session" / "api_key" (scenario 2/3)
  permissions: string[]; // Resolved permissions (all scenarios)
  authType: AuthType; // Which auth path was used
  isSuperAdmin: boolean;
  // SDK-specific (scenario 2 only)
  projectId?: string;
  deploymentId?: string;
  channelId?: string;
  sessionId?: string;
  sessionPrincipal?: string;
  // SDK identity fields (scenario 2 only — propagated from SDKSessionTokenPayload)
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  authScope?: SDKAuthScope;
  verifiedUserId?: string;
  channelArtifact?: string; // Pre-hashed artifact from sdk/init
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
  // API key-specific (scenario 3 only)
  apiKeyId?: string;
  clientId?: string; // Identifies integrating system
  projectScope?: string[]; // Restricted project IDs
  environmentScope?: string[]; // Restricted environments
}

/**
 * SDK session token payload (Scenario 2: pk_* key exchange → short-lived session token).
 */
export interface SDKSessionTokenPayload {
  type: 'sdk_session';
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  environment?: string;
  channelId: string;
  sessionId?: string;
  sessionPrincipal?: string;
  contactId?: string;
  permissions: string[];
  /** User context for personalization (caller attributes, not test mocks) */
  userContext?: {
    userId?: string;
    customAttributes?: Record<string, unknown>;
  };
  // Session identity fields (Phase 1)
  identityTier?: IdentityTier;
  verificationMethod?: VerificationMethod;
  authScope?: SDKAuthScope;
  verifiedUserId?: string;
  channelArtifact?: string;
  iat: number;
  exp: number;
}

/**
 * Minimal user shape for request attachment.
 * Consumers should cast to their full User type as needed.
 */
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * SDK init request data — resolved from Runtime public-key bootstrap validation.
 */
export interface SDKInitData {
  keyId: string;
  projectId: string;
  tenantId: string;
  permissions: string[];
}

// =============================================================================
// LOCALIZED INTERACTION CONTEXT
// =============================================================================

export type InteractionContextSource =
  | 'message'
  | 'session'
  | 'contact'
  | 'channel'
  | 'project'
  | 'agent'
  | 'default';

export type InteractionContextConfidence = 'explicit' | 'high' | 'medium' | 'low';

/**
 * Partial inbound interaction-context payload accepted at message/session boundaries.
 * All fields are optional so callers can override only the dimension they know.
 */
export interface InteractionContextInput {
  language?: string;
  locale?: string;
  timezone?: string;
}

/**
 * Canonical resolved interaction context for a single runtime turn.
 */
export interface InteractionContext {
  language: string | null;
  locale: string | null;
  timezone: string | null;
  source: InteractionContextSource;
  confidence: InteractionContextConfidence;
  resolvedAt: string;
}

/**
 * Longer-lived session preference reused when the current message is silent.
 */
export interface SessionInteractionPreference extends InteractionContextInput {
  source: InteractionContextSource;
  confidence: InteractionContextConfidence;
  updatedAt: string;
}

/**
 * Canonical session-scoped interaction state.
 */
export interface SessionInteractionState {
  current: InteractionContext;
  preference?: SessionInteractionPreference;
}

// =============================================================================
// SESSION IDENTITY TYPES
// =============================================================================

export type ChannelArtifactType =
  | 'caller_id'
  | 'cookie'
  | 'device_id'
  | 'psid'
  | 'aad_id'
  | 'phone'
  | 'email_thread'
  | 'api_client'
  | 'sip_uri';

export type IdentityTier = 0 | 1 | 2;

export type VerificationMethod =
  | 'none'
  | 'cookie'
  | 'caller_id'
  | 'hmac'
  | 'otp'
  | 'oauth'
  | 'provider'
  | 'email_link'
  | 'webhook'
  | 'server_secret';

export type HMACEnforcementMode = 'disabled' | 'optional' | 'required';

export type SessionResolutionStrategy = 'channel_artifact' | 'contact_required' | 'always_new';

export interface CallerContext {
  tenantId: string;
  contactId?: string;
  channelArtifact?: string;
  channelArtifactType?: ChannelArtifactType;
  anonymousId?: string;
  customerId?: string;
  channel: string;
  channelId?: string;
  initiatedById?: string;
  identityTier: IdentityTier;
  verificationMethod: VerificationMethod;
  sourceIp?: string;
  userAgent?: string;
  /** Contact display name resolved from the Contact entity during session init. */
  contactDisplayName?: string | null;
  /** Cross-session contact dataValues, pre-populated from ContactContext on session init. */
  contactContext?: Record<string, unknown>;
  /** Cross-session contact preferences, pre-populated from ContactContext on session init. */
  contactPreferences?: Record<string, unknown>;
}

export interface SessionResolutionConfig {
  strategy: SessionResolutionStrategy;
  artifactType: ChannelArtifactType;
  resumeWindowSeconds: number;
  maxActiveSessions: number;
  promotionTrigger: 'manual' | 'auto_on_gather' | 'disabled';
}

export type {
  CallerIdentity,
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
} from './auth-context.js';
export { isPlatformMember, isChannelUser, isApiKey } from './auth-context.js';

// ─── Workflow Types (Node-Based Canvas) ──────────────────────────────────
export type {
  NodeType,
  NodeCategory,
  WorkflowNode,
  WorkflowEdge,
  WorkflowDeployment,
  WorkflowContext,
  NodeExecutorResult,
  NodeExecution,
  WorkflowEvent,
  ContextExpression,
  WorkflowStatus,
  WorkflowType,
} from './workflow-types.js';
export {
  WORKFLOW_STATUSES,
  WORKFLOW_TYPES,
  STUB_NODE_TYPES,
  HIDDEN_NODE_TYPES,
  NODE_CATEGORY_MAP,
  NODE_COLOR_MAP,
  NODE_DISPLAY_NAMES,
  NODE_NAME_PATTERN,
  getOutputHandles,
  resolveExpression,
  generateNodeName,
} from './workflow-types.js';

// ─── Trace Event Types ──────────────────────────────────────────────────
export type { TraceEventType, ExtendedTraceEventType, TraceEvent } from './trace-event.js';
export {
  FUNCTION_CONTEXT_IMMUTABLE_TOP_LEVEL_KEYS,
  FUNCTION_CONTEXT_READONLY_TOP_LEVEL_KEYS,
  FUNCTION_CONTEXT_RESERVED_TOP_LEVEL_KEYS,
} from './function-context-keys.js';
export type {
  FunctionContextImmutableTopLevelKey,
  FunctionContextReadonlyTopLevelKey,
  FunctionContextReservedTopLevelKey,
} from './function-context-keys.js';

// ─── Project Tool Form Types ────────────────────────────────────────────
export type {
  ProjectToolFormData,
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  WorkflowToolFormData,
  SearchAIToolFormData,
  ToolFormParameter,
  RuntimeNumericValue,
  HttpAuthType,
  HttpAuthConfig,
  HttpConsentMode,
  HttpConnectionMode,
} from './project-tool-form.js';
