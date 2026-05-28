/**
 * Shared Types for Agent Platform
 *
 * Auth payload types, request extensions, and common interfaces
 * used across Studio and Runtime.
 *
 * Pure types are re-exported from @agent-platform/shared-kernel.
 * This file adds Express global augmentation and zod-dependent schemas.
 */

// ─── Pure types from shared-kernel ──────────────────────────────────────
export type {
  JWTPayload,
  SDKSessionTokenPayload,
  SDKInitData,
  SDKAuthScope,
  AuthUser,
  AuthType,
  CallerContext,
  ChannelArtifactType,
  IdentityTier,
  VerificationMethod,
  HMACEnforcementMode,
  SessionResolutionStrategy,
  SessionResolutionConfig,
  CallerIdentity,
  AuthContext,
  PlatformMemberContext,
  ChannelUserContext,
  ApiKeyContext,
  // Project Tool Form Types
  ProjectToolFormData,
  HttpToolFormData,
  SandboxToolFormData,
  McpToolFormData,
  ToolFormParameter,
  RuntimeNumericValue,
  HttpAuthType,
  HttpAuthConfig,
  HttpConsentMode,
  HttpConnectionMode,
} from '@agent-platform/shared-kernel';
export { isPlatformMember, isChannelUser, isApiKey } from '@agent-platform/shared-kernel';

// Re-export TenantContextData (used by Express global augmentation below)
export type { TenantContextData } from '@agent-platform/shared-kernel';
import type { AuthContext as _AuthContext } from '@agent-platform/shared-kernel';

// ─── Workflow Types (Node-Based Canvas — from shared-kernel) ─────────────
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
} from '@agent-platform/shared-kernel';
export {
  STUB_NODE_TYPES,
  NODE_CATEGORY_MAP,
  NODE_COLOR_MAP,
  NODE_DISPLAY_NAMES,
  NODE_NAME_PATTERN,
  getOutputHandles,
  resolveExpression,
  generateNodeName,
} from '@agent-platform/shared-kernel';

// ─── Workflow Zod Schemas (Node-Based Canvas — remain in shared for zod dep) ─
export {
  NodeTypeSchema,
  StartNodeConfigSchema,
  EndNodeConfigSchema,
  TextToTextNodeConfigSchema,
  TextToImageNodeConfigSchema,
  AudioToTextNodeConfigSchema,
  ImageToTextNodeConfigSchema,
  ApiNodeConfigSchema,
  FunctionNodeConfigSchema,
  IntegrationNodeConfigSchema,
  ConditionNodeConfigSchema,
  LoopNodeConfigSchema,
  HumanNodeConfigSchema,
  AgenticAppNodeConfigSchema,
  DelayNodeConfigSchema,
  BrowserNodeConfigSchema,
  DocSearchNodeConfigSchema,
  DocIntelligenceNodeConfigSchema,
  NODE_CONFIG_SCHEMAS,
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  WorkflowDeploymentSchema,
  WorkflowDefinitionSchema,
  NodeExecutionSchema,
  TRIGGER_TYPES,
  WEBHOOK_MODES,
  WEBHOOK_DELIVERIES,
  REGISTRATION_TRIGGER_TYPES,
  WorkflowExecutionInputSchema,
  WORKFLOW_STATUSES,
  type WorkflowStatus,
} from './workflow-schemas.js';

export type {
  TriggerType,
  WebhookMode,
  WebhookDelivery,
  RegistrationTriggerType,
} from './workflow-schemas.js';

// ─── Express Global Augmentation ────────────────────────────────────────
import type { AuthUser, TenantContextData, SDKInitData } from '@agent-platform/shared-kernel';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenantContext?: TenantContextData;
      authContext?: _AuthContext;
      mfaPending?: boolean;
      sdkInit?: SDKInitData;
    }
  }
}
