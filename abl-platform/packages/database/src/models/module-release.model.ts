/**
 * Module Release Model
 *
 * Stores immutable release artifacts for module projects.
 * Each release captures the DSL sources, compiled IR, and a contract
 * describing what the module provides and requires.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import type { ProjectToolType } from './project-tool.model.js';

// ─── Sub-document Types ─────────────────────────────────────────────────

export type ModuleReleaseAgentPromptLibraryRef = {
  promptId: string;
  versionId: string;
  resolvedHash?: string;
};

export type ModuleReleaseAgentCompanion = {
  systemPromptLibraryRef?: ModuleReleaseAgentPromptLibraryRef | null;
  resolvedSystemPrompt?: string | null;
};

export type ModuleReleaseArtifact = {
  dslFormat: 'legacy' | 'yaml';
  entryAgentName: string;
  agents: Record<
    string,
    {
      dslContent: string;
      sourceHash: string;
      /**
       * Non-DSL agent companion metadata captured at publish time so newer
       * deployment builds can recompile portable artifacts without reaching
       * back to source-project prompt library state.
       */
      companion?: ModuleReleaseAgentCompanion;
    }
  >;
  profiles?: Record<string, { dslContent: string; sourceHash: string }>;
  tools: Record<
    string,
    {
      dslContent: string;
      toolType: ProjectToolType;
      sourceHash: string;
      /**
       * Materialized runtime tool definition captured at publish time.
       * Optional for backward compatibility with older releases.
       */
      definition?: Record<string, unknown>;
    }
  >;
};

export type ModuleReleaseContractAgentEntry = {
  name: string;
  description?: string;
  mode?: string;
  tools?: string[];
  handoffTargets?: string[];
  delegateTargets?: string[];
  hasGather?: boolean;
  hasFlow?: boolean;
};

export type ModuleReleaseContractToolParameter = {
  name: string;
  type: string;
  required: boolean;
  description?: string;
};

export type ModuleReleaseContractToolEntry = {
  name: string;
  toolType: string;
  description?: string;
  parameters?: ModuleReleaseContractToolParameter[];
  returnType?: string;
  endpoint?: string;
  method?: string;
  authProfileRef?: string;
  requiredEnvVars?: string[];
};

export type ModuleReleaseContract = {
  providedAgents: ModuleReleaseContractAgentEntry[];
  providedBehaviorProfiles?: Array<{ name: string }>;
  providedTools: ModuleReleaseContractToolEntry[];
  requiredConfigKeys: Array<{ key: string; description?: string; isSecret: boolean }>;
  requiredEnvVars: Array<{ name: string; description?: string }>;
  requiredSecrets?: Array<{
    key: string;
    description?: string;
    referencedBy: string[];
    toolName?: string;
  }>;
  requiredAuthProfiles: Array<{
    name: string;
    authType?: string;
    scope?: string;
    referencedBy: string[];
  }>;
  requiredConnectors: Array<{ name: string; connectorType?: string }>;
  requiredMcpServers: Array<{ name: string }>;
  warnings: Array<{ code: string; message: string }>;
};

// ─── Document Interface ─────────────────────────────────────────────────

export interface IModuleRelease {
  _id: string;
  tenantId: string;
  moduleProjectId: string;
  version: string;
  releaseNotes: string | null;
  artifact: ModuleReleaseArtifact;
  /**
   * Compiled IR keyed by agent name. Typed as Record<string, unknown> rather
   * than Record<string, AgentIR> to avoid a compile-time dependency on
   * @abl/compiler in the database package. Consumers should cast as needed.
   */
  compiledIR: Record<string, unknown>;
  contract: ModuleReleaseContract;
  sourceHash: string;
  createdBy: string;
  createdAt: Date;
  archivedAt: Date | null;
  archivedBy: string | null;
}

// ─── Schema ─────────────────────────────────────────────────────────────

const ModuleReleaseSchema = new Schema<IModuleRelease>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    moduleProjectId: { type: String, required: true },
    version: { type: String, required: true },
    releaseNotes: { type: String, default: null },
    artifact: { type: Schema.Types.Mixed, required: true },
    compiledIR: { type: Schema.Types.Mixed, required: true },
    contract: { type: Schema.Types.Mixed, required: true },
    sourceHash: { type: String, required: true },
    createdBy: { type: String, required: true },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'module_releases' },
);

// ─── Plugins ────────────────────────────────────────────────────────────

ModuleReleaseSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ────────────────────────────────────────────────────────────

ModuleReleaseSchema.index({ tenantId: 1, moduleProjectId: 1, version: 1 }, { unique: true });
ModuleReleaseSchema.index({ tenantId: 1, moduleProjectId: 1, createdAt: -1 });

// ─── Model ──────────────────────────────────────────────────────────────

export const ModuleRelease =
  (mongoose.models.ModuleRelease as any) ||
  model<IModuleRelease>('ModuleRelease', ModuleReleaseSchema);
