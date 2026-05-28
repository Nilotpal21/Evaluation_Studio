/**
 * Agent Registry
 *
 * Version control and lifecycle management for agents.
 * Handles registration, promotion, rollback, and routing.
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import type { AgentBasedDocument } from '@abl/core';
import type { AgentVersion, AgentStatus, Environment, TestResults } from '../core/types.js';
import type { AgentIR, CompilationOutput } from '../ir/schema.js';
import { compileABLtoIR } from '../ir/compiler.js';
import type { AuditStore } from './audit-store.js';
import { createLogger } from '../logger.js';

const log = createLogger('agent-registry');

// =============================================================================
// INTERFACES
// =============================================================================

export interface AgentRegistryConfig {
  type: 'postgres' | 'memory' | 'mongodb';
  connectionString?: string;
}

export interface RegisterAgentParams {
  agentName: string;
  dslContent: string;
  changelog: string;
  createdBy: string;
}

export interface PromoteAgentParams {
  agentName: string;
  version: string;
  targetEnv: Environment;
  promotedBy: string;
}

export interface RollbackAgentParams {
  agentName: string;
  targetEnv: Environment;
  toVersion: string;
  reason: string;
  rolledBackBy: string;
}

export interface QueryAgentsParams {
  status?: AgentStatus;
  environment?: Environment;
  agentName?: string;
}

export interface ActiveVersions {
  dev?: string;
  staging?: string;
  production?: string;
}

// =============================================================================
// ABSTRACT REGISTRY
// =============================================================================

export abstract class AgentRegistry {
  protected config: AgentRegistryConfig;
  protected auditStore?: AuditStore;

  constructor(config: AgentRegistryConfig, auditStore?: AuditStore) {
    this.config = config;
    this.auditStore = auditStore;
  }

  /**
   * Register a new agent version
   */
  async register(params: RegisterAgentParams): Promise<AgentVersion> {
    log.info('Registering new agent version', {
      agentName: params.agentName,
      createdBy: params.createdBy,
    });

    // Compile DSL to IR
    const ir = this.compileDSL(params.dslContent);

    // Determine version number
    const latestVersion = await this.getLatestVersion(params.agentName);
    const newVersion = this.bumpVersion(latestVersion?.version || '0.0.0');

    const agentVersion: AgentVersion = {
      agentName: params.agentName,
      version: newVersion,
      status: 'draft',
      dslContent: params.dslContent,
      irContent: JSON.stringify(ir, null, 2),
      sourceHash: this.hashContent(params.dslContent),
      createdAt: new Date(),
      createdBy: params.createdBy,
      changelog: params.changelog,
    };

    await this.saveVersion(agentVersion);

    // Audit log
    if (this.auditStore) {
      await this.auditStore.logAgentCreated(params.agentName, newVersion, params.createdBy, 'dev');
    }

    log.info('Agent version registered successfully', {
      agentName: params.agentName,
      version: newVersion,
    });
    return agentVersion;
  }

  /**
   * Promote an agent version to a target environment
   */
  async promote(params: PromoteAgentParams): Promise<AgentVersion> {
    log.info('Promoting agent version', {
      agentName: params.agentName,
      version: params.version,
      targetEnv: params.targetEnv,
      promotedBy: params.promotedBy,
    });

    const version = await this.getVersion(params.agentName, params.version);
    if (!version) {
      throw new Error(`Version ${params.version} of ${params.agentName} not found`);
    }

    // Validation based on target environment
    if (params.targetEnv === 'staging') {
      // Must be in draft or testing status
      if (!['draft', 'testing'].includes(version.status)) {
        throw new Error(`Cannot promote ${version.status} version to staging`);
      }
    } else if (params.targetEnv === 'production') {
      // Must be staged first
      const stagedVersion = await this.getActiveVersion(params.agentName, 'staging');
      if (stagedVersion !== params.version) {
        throw new Error('Must be staged before production promotion');
      }

      // Must have passing tests
      if (!version.testResults?.passed) {
        throw new Error('Tests must pass before production promotion');
      }
    }

    // Determine new status
    const newStatus: AgentStatus = {
      dev: 'testing',
      staging: 'staged',
      production: 'active',
    }[params.targetEnv] as AgentStatus;

    // Get current active version for audit trail
    const currentVersion = await this.getActiveVersion(params.agentName, params.targetEnv);
    const fromEnv: Environment =
      params.targetEnv === 'staging'
        ? 'dev'
        : params.targetEnv === 'production'
          ? 'staging'
          : 'dev';

    // Update version status
    version.status = newStatus;
    version.promotedAt = new Date();
    version.promotedBy = params.promotedBy;
    await this.saveVersion(version);

    // Update routing
    await this.setActiveVersion(params.agentName, params.version, params.targetEnv);

    // Deprecate old version if exists
    if (currentVersion && currentVersion !== params.version) {
      const oldVersion = await this.getVersion(params.agentName, currentVersion);
      if (oldVersion) {
        oldVersion.status = 'deprecated';
        await this.saveVersion(oldVersion);
      }
    }

    // Audit log
    if (this.auditStore) {
      await this.auditStore.logAgentPromoted(
        params.agentName,
        params.version,
        fromEnv,
        params.targetEnv,
        params.promotedBy,
      );
    }

    log.info('Agent version promoted successfully', {
      agentName: params.agentName,
      version: params.version,
      targetEnv: params.targetEnv,
    });
    return version;
  }

  /**
   * Rollback to a previous version
   */
  async rollback(params: RollbackAgentParams): Promise<AgentVersion> {
    log.warn('Rolling back agent version', {
      agentName: params.agentName,
      targetEnv: params.targetEnv,
      toVersion: params.toVersion,
      reason: params.reason,
      rolledBackBy: params.rolledBackBy,
    });

    const targetVersion = await this.getVersion(params.agentName, params.toVersion);
    if (!targetVersion) {
      throw new Error(`Version ${params.toVersion} of ${params.agentName} not found`);
    }

    const currentVersion = await this.getActiveVersion(params.agentName, params.targetEnv);
    if (!currentVersion) {
      throw new Error(`No active version in ${params.targetEnv}`);
    }

    // Update routing to point to rollback version
    await this.setActiveVersion(params.agentName, params.toVersion, params.targetEnv);

    // Mark rollback version as active
    targetVersion.status = 'active';
    targetVersion.promotedAt = new Date();
    targetVersion.promotedBy = params.rolledBackBy;
    await this.saveVersion(targetVersion);

    // Audit log
    if (this.auditStore) {
      await this.auditStore.logAgentRolledBack(
        params.agentName,
        currentVersion,
        params.toVersion,
        params.reason,
        params.rolledBackBy,
        params.targetEnv,
      );
    }

    log.info('Agent version rolled back successfully', {
      agentName: params.agentName,
      fromVersion: currentVersion,
      toVersion: params.toVersion,
      targetEnv: params.targetEnv,
    });
    return targetVersion;
  }

  /**
   * Record test results for a version
   */
  async recordTestResults(
    agentName: string,
    version: string,
    results: TestResults,
  ): Promise<AgentVersion> {
    const agentVersion = await this.getVersion(agentName, version);
    if (!agentVersion) {
      throw new Error(`Version ${version} of ${agentName} not found`);
    }

    agentVersion.testResults = results;

    // Auto-transition to testing if tests pass
    if (results.passed && agentVersion.status === 'draft') {
      agentVersion.status = 'testing';
    }

    await this.saveVersion(agentVersion);
    return agentVersion;
  }

  /**
   * Get the IR for an agent in a specific environment
   */
  async getAgentIR(agentName: string, environment: Environment): Promise<AgentIR | null> {
    const version = await this.getActiveVersion(agentName, environment);
    if (!version) return null;

    const agentVersion = await this.getVersion(agentName, version);
    if (!agentVersion) return null;

    return JSON.parse(agentVersion.irContent);
  }

  /**
   * Get all active agent IRs for an environment
   */
  async getAllAgentIRs(environment: Environment): Promise<Record<string, AgentIR>> {
    const agents = await this.listAgents();
    const result: Record<string, AgentIR> = {};

    for (const agentName of agents) {
      const ir = await this.getAgentIR(agentName, environment);
      if (ir) {
        result[agentName] = ir;
      }
    }

    return result;
  }

  // Helper methods
  protected compileDSL(dslContent: string): CompilationOutput {
    // This would need the parser - for now return a stub
    // In real implementation: parse DSL -> compile to IR
    const parsed = this.parseDSL(dslContent);
    return compileABLtoIR(parsed);
  }

  protected parseDSL(_dslContent: string): AgentBasedDocument[] {
    // TODO: Implement actual DSL parsing
    // In real implementation:
    // import { parseAgentBasedABL } from '@abl/core';
    // return [parseAgentBasedABL(dslContent)];
    throw new Error(
      'DSL parsing not yet implemented. Use registerWithIR() to register pre-compiled agents.',
    );
  }

  protected hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  protected bumpVersion(currentVersion: string): string {
    const parts = currentVersion.split('.');
    if (parts.length !== 3 || parts.some((p) => isNaN(Number(p)))) {
      throw new Error(`Invalid version format: "${currentVersion}". Expected "major.minor.patch".`);
    }
    const [major, minor, patch] = parts.map(Number);
    return `${major}.${minor}.${patch + 1}`;
  }

  // Abstract methods
  abstract getVersion(agentName: string, version: string): Promise<AgentVersion | null>;
  abstract getLatestVersion(agentName: string): Promise<AgentVersion | null>;
  abstract saveVersion(version: AgentVersion): Promise<void>;
  abstract getActiveVersion(agentName: string, environment: Environment): Promise<string | null>;
  abstract setActiveVersion(
    agentName: string,
    version: string,
    environment: Environment,
  ): Promise<void>;
  abstract getActiveVersions(agentName: string): Promise<ActiveVersions>;
  abstract listAgents(): Promise<string[]>;
  abstract queryVersions(params: QueryAgentsParams): Promise<AgentVersion[]>;
  abstract getVersionHistory(agentName: string, limit?: number): Promise<AgentVersion[]>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION
// =============================================================================

export class InMemoryAgentRegistry extends AgentRegistry {
  private versions: Map<string, AgentVersion> = new Map();
  private activeVersions: Map<string, ActiveVersions> = new Map();

  private versionKey(agentName: string, version: string): string {
    return `${agentName}:${version}`;
  }

  async getVersion(agentName: string, version: string): Promise<AgentVersion | null> {
    return this.versions.get(this.versionKey(agentName, version)) || null;
  }

  async getLatestVersion(agentName: string): Promise<AgentVersion | null> {
    const agentVersions = Array.from(this.versions.values())
      .filter((v) => v.agentName === agentName)
      .sort((a, b) => {
        const [aMajor, aMinor, aPatch] = a.version.split('.').map(Number);
        const [bMajor, bMinor, bPatch] = b.version.split('.').map(Number);
        if (aMajor !== bMajor) return bMajor - aMajor;
        if (aMinor !== bMinor) return bMinor - aMinor;
        return bPatch - aPatch;
      });

    return agentVersions[0] || null;
  }

  async saveVersion(version: AgentVersion): Promise<void> {
    this.versions.set(this.versionKey(version.agentName, version.version), version);
  }

  async getActiveVersion(agentName: string, environment: Environment): Promise<string | null> {
    const active = this.activeVersions.get(agentName);
    return active?.[environment] || null;
  }

  async setActiveVersion(
    agentName: string,
    version: string,
    environment: Environment,
  ): Promise<void> {
    const active = this.activeVersions.get(agentName) || {};
    active[environment] = version;
    this.activeVersions.set(agentName, active);
  }

  async getActiveVersions(agentName: string): Promise<ActiveVersions> {
    return this.activeVersions.get(agentName) || {};
  }

  async listAgents(): Promise<string[]> {
    const agents = new Set<string>();
    for (const version of this.versions.values()) {
      agents.add(version.agentName);
    }
    return Array.from(agents);
  }

  async queryVersions(params: QueryAgentsParams): Promise<AgentVersion[]> {
    let versions = Array.from(this.versions.values());

    if (params.agentName) {
      versions = versions.filter((v) => v.agentName === params.agentName);
    }
    if (params.status) {
      versions = versions.filter((v) => v.status === params.status);
    }

    // Note: environment filter is not applicable to individual versions.
    // Versions are environment-agnostic; use getActiveVersion() to find
    // which version is active in a specific environment.

    // Sort by created date descending
    versions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return versions;
  }

  async getVersionHistory(agentName: string, limit = 10): Promise<AgentVersion[]> {
    const versions = Array.from(this.versions.values())
      .filter((v) => v.agentName === agentName)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return versions.slice(0, limit);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createAgentRegistry(
  config: AgentRegistryConfig,
  auditStore?: AuditStore,
): AgentRegistry {
  switch (config.type) {
    case 'memory':
      return new InMemoryAgentRegistry(config, auditStore);
    case 'postgres':
      // TODO: Implement PostgreSQL registry
      throw new Error('PostgreSQL agent registry not yet implemented');
    default:
      throw new Error(`Unknown registry type: ${config.type}`);
  }
}
