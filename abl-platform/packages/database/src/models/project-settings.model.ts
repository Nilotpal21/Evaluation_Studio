/**
 * Project Settings Model
 *
 * Stores project-level execution settings (working copy).
 * One document per project. Falls back to platform defaults when absent.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';

// ─── Document Interface ──────────────────────────────────────────────────

export type ProjectSessionLifecycleChannel =
  | 'voice'
  | 'web_chat'
  | 'web_debug'
  | 'whatsapp'
  | 'sms'
  | 'email'
  | 'api'
  | 'http_async';

export type ProjectSessionDisconnectBehavior = 'end' | 'detach';

export type ProjectSessionDisposition =
  | 'completed'
  | 'abandoned'
  | 'agent_hangup'
  | 'transferred'
  | 'failed'
  | 'timeout'
  | 'unengaged';

export type ProjectSessionEndHookSettings =
  | { mode: 'ignore' }
  | { mode: 'respond'; message: string };

export interface IProjectSessionLifecycleRuntimeSettings {
  idleSeconds?: number;
  maxAgeSeconds?: number;
}

export interface IProjectSessionLifecycleChannelSettings {
  defaultDisposition?: ProjectSessionDisposition;
  disconnectBehavior?: ProjectSessionDisconnectBehavior;
  endHook?: ProjectSessionEndHookSettings;
}

export interface IProjectSessionLifecycleSettings {
  runtime?: IProjectSessionLifecycleRuntimeSettings;
  endHook?: ProjectSessionEndHookSettings;
  channels?: Partial<
    Record<ProjectSessionLifecycleChannel, IProjectSessionLifecycleChannelSettings>
  >;
}

// ─── Public API Access Types ────────────────────────────────────────────

export interface IPublicApiAccessRateLimits {
  /** Per authenticated user per minute (default: 60) */
  perUserPerMinute: number;
  /** Aggregate per project per minute (default: 1000) */
  perProjectPerMinute: number;
}

export interface IPublicApiAccessScopeConfig {
  /** Whether this scope is enabled */
  enabled: boolean;
  /** References AuthProfile._id(s) (must be oauth2_app or azure_ad type). Multi-IdP: multiple profiles. */
  authProfileIds: string[];
  /** Restrict end-user email domains (e.g., ["acme.com"]). Empty = allow all. */
  allowedDomains: string[];
  /** CORS origins for browser-based access (e.g., ["https://portal.acme.com"]) */
  allowedOrigins: string[];
  /** Allowed redirect URIs for Path B (OAuth redirect/PKCE flow). Exact match only. */
  allowedRedirectUris: string[];
  /** Search session token TTL in seconds (default: 900 = 15 min) */
  sessionTokenTtlSeconds: number;
  /** Rate limits for end-user paths */
  rateLimits: IPublicApiAccessRateLimits;
}

export interface IPublicApiAccessSettings {
  scopes: {
    'search.query'?: IPublicApiAccessScopeConfig;
    // Future: 'files.upload'?, 'chat.execute'?
  };
}

/** Agent transfer settings stored per-project. */
export interface IAgentTransferSettings {
  session?: {
    ttl?: { chat?: number; email?: number; voice?: number; messaging?: number; campaign?: number };
    maxConcurrentPerContact?: number;
  };
  defaultRouting?: {
    /**
     * Canonical project-scoped routing reference.
     * Stores the durable connection document id plus optional denormalized hints
     * used during compatibility rollouts.
     */
    connection?: {
      connectionId?: string;
      authProfileId?: string;
      connectorName?: string;
    };
    /** @deprecated Legacy flat connection reference kept for compatibility reads. */
    connectionId?: string;
    queue?: string;
    priority?: number;
    postAgentAction?: 'return' | 'end';
  };
  voice?: {
    type?: 'korevg' | 'audiocodes' | 'jambonz';
    transferMethod?: 'invite' | 'refer' | 'bye';
    headerPassthrough?: boolean;
    recordingEnabled?: boolean;
  };
  pii?: {
    deTokenizeBeforeTransfer?: boolean;
    detectionPattern?: string;
  };
}

/**
 * Memory-subsystem settings.
 *
 * `dedupMaxDepth` — maximum recursion depth for REMEMBER-trigger value
 * comparison when deciding whether to skip an unchanged write.
 * null → platform default (see memory-dedup.DEFAULT_DEDUP_MAX_DEPTH).
 */
export interface IProjectMemorySettings {
  dedupMaxDepth?: number | null;
}

export interface IProjectSdkDefaults {
  hostedExchangeTokenEnvelopePolicy?:
    | 'inherit'
    | 'signed'
    | 'jwe_preferred'
    | 'jwe_required'
    | null;
}

export interface IProjectSettings {
  _id: string;
  tenantId: string;
  projectId: string;
  enableThinking: boolean;
  thinkingBudget: number | null;
  thoughtDescription: string | null;
  /** Flexible prompt overrides — keys use prompt_templates convention (e.g. "llm_prompt.entity_extraction") */
  promptOverrides: Record<string, unknown>;
  /** Context-usage ratio (0–1) at which auto-compaction triggers (null = use platform default) */
  compactionThreshold: number | null;
  /** Keys from session.data.values to auto-extract as custom_dimensions on every trace event */
  traceDimensions: string[];
  /** Agent transfer configuration (CCaaS routing, session TTLs, voice, PII) */
  agentTransfer: IAgentTransferSettings | null;
  /** Conversation-session lifecycle configuration (timeouts, disconnect behavior, end hooks) */
  sessionLifecycle: IProjectSessionLifecycleSettings | null;
  /** Memory-subsystem settings (REMEMBER dedup depth cap) */
  memory: IProjectMemorySettings | null;
  /** Public API access configuration (end-user auth, scopes) */
  publicApiAccess: IPublicApiAccessSettings | null;
  /** Browser SDK defaults applied before per-channel overrides. */
  sdkDefaults: IProjectSdkDefaults | null;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ProjectSettingsSchema = new Schema<IProjectSettings>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },
    enableThinking: { type: Boolean, default: false },
    thinkingBudget: { type: Number, default: null },
    thoughtDescription: { type: String, default: null },
    compactionThreshold: { type: Number, default: null },
    promptOverrides: { type: Schema.Types.Mixed, default: {} },
    traceDimensions: { type: [String], default: [] },
    agentTransfer: { type: Schema.Types.Mixed, default: null },
    sessionLifecycle: { type: Schema.Types.Mixed, default: null },
    memory: { type: Schema.Types.Mixed, default: null },
    publicApiAccess: { type: Schema.Types.Mixed, default: null },
    sdkDefaults: { type: Schema.Types.Mixed, default: null },
    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'project_settings' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ProjectSettingsSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

ProjectSettingsSchema.index({ tenantId: 1, projectId: 1 }, { unique: true });

// ─── Model ───────────────────────────────────────────────────────────────

export const ProjectSettings =
  (mongoose.models.ProjectSettings as mongoose.Model<IProjectSettings>) ||
  model<IProjectSettings>('ProjectSettings', ProjectSettingsSchema);
