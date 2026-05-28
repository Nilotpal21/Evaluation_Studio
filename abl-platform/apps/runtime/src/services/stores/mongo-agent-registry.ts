import {
  AgentRegistry,
  AgentRegistryConfig,
  QueryAgentsParams,
  ActiveVersions,
} from '@abl/compiler/platform/stores/agent-registry.js';
import type { AgentVersion, AgentStatus, Environment } from '@abl/compiler/platform/core/types';
import type { AuditStore } from '@abl/compiler/platform/stores/audit-store.js';
import { ProjectAgent, AgentVersion as AgentVersionModel } from '@agent-platform/database/models';
import { buildProjectAgentPath } from '@agent-platform/shared';
import { refreshPersistedRuntimeProjectAgentDraftMetadata } from '../session/project-agent-draft-metadata.js';

export interface MongoAgentRegistryScope {
  tenantId: string;
  projectId: string;
}

/**
 * MongoDB-backed implementation of the AgentRegistry abstract class.
 *
 * All queries are scoped to a specific tenantId and projectId. Uses Mongoose models
 * from the database package and returns lean objects with _id mapped to id.
 */
export class MongoAgentRegistry extends AgentRegistry {
  private readonly tenantId: string;
  private readonly projectId: string;

  constructor(
    config: AgentRegistryConfig,
    scope: MongoAgentRegistryScope,
    auditStore?: AuditStore,
  ) {
    super(config, auditStore);
    assertMongoAgentRegistryScope(scope);
    this.tenantId = scope.tenantId;
    this.projectId = scope.projectId;
  }

  // ---------------------------------------------------------------------------
  // Helper: find a ProjectAgent document by name scoped to this tenant/project pair
  // ---------------------------------------------------------------------------

  private async findAgent(agentName: string): Promise<any | null> {
    return ProjectAgent.findOne({
      tenantId: this.tenantId,
      projectId: this.projectId,
      name: agentName,
    }).lean();
  }

  // ---------------------------------------------------------------------------
  // Mapper: convert a Mongoose lean doc to the compiler AgentVersion type
  // ---------------------------------------------------------------------------

  private mapDocToAgentVersion(agentName: string, doc: any): AgentVersion {
    return {
      agentName,
      version: doc.version,
      status: doc.status as AgentStatus,
      dslContent: doc.dslContent,
      irContent: doc.irContent,
      sourceHash: doc.sourceHash,
      createdAt: doc.createdAt,
      createdBy: doc.createdBy,
      changelog: doc.changelog ?? undefined,
      promotedAt: doc.promotedAt ?? undefined,
      promotedBy: doc.promotedBy ?? undefined,
      testResults: doc.testResults ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Abstract method implementations
  // ---------------------------------------------------------------------------

  async getVersion(agentName: string, version: string): Promise<AgentVersion | null> {
    const agent = await this.findAgent(agentName);
    if (!agent) return null;

    const versionDoc = await AgentVersionModel.findOne({
      agentId: agent._id,
      version,
    }).lean();

    if (!versionDoc) return null;

    return this.mapDocToAgentVersion(agentName, versionDoc);
  }

  async getLatestVersion(agentName: string): Promise<AgentVersion | null> {
    const agent = await this.findAgent(agentName);
    if (!agent) return null;

    const versionDoc = await AgentVersionModel.findOne({
      agentId: agent._id,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!versionDoc) return null;

    return this.mapDocToAgentVersion(agentName, versionDoc);
  }

  async saveVersion(version: AgentVersion): Promise<void> {
    // Find or create the ProjectAgent document
    let agent = await this.findAgent(version.agentName);

    if (!agent) {
      agent = await ProjectAgent.create({
        tenantId: this.tenantId,
        projectId: this.projectId,
        name: version.agentName,
        agentPath: buildProjectAgentPath(this.projectId, version.agentName),
        dslContent: version.dslContent,
        activeVersions: {},
      });
      // Re-fetch as lean so we have a plain object with _id
      agent = await this.findAgent(version.agentName);
    }

    // Upsert the AgentVersion document
    await AgentVersionModel.findOneAndUpdate(
      {
        agentId: agent._id,
        version: version.version,
      },
      {
        $set: {
          agentId: agent._id,
          version: version.version,
          status: version.status,
          dslContent: version.dslContent,
          irContent: version.irContent,
          sourceHash: version.sourceHash,
          createdBy: version.createdBy,
          changelog: version.changelog,
          promotedAt: version.promotedAt,
          promotedBy: version.promotedBy,
          testResults: version.testResults,
        },
        $setOnInsert: {
          createdAt: version.createdAt ?? new Date(),
        },
      },
      { upsert: true, new: true },
    );

    // Keep the parent ProjectAgent's dslContent in sync with the latest version
    await ProjectAgent.updateOne(
      { _id: agent._id, tenantId: this.tenantId, projectId: this.projectId },
      { $set: { dslContent: version.dslContent } },
    );
    await refreshPersistedRuntimeProjectAgentDraftMetadata({
      tenantId: this.tenantId,
      projectId: this.projectId,
      diagnosticSource: 'runtime-agent-registry',
    });
  }

  async getActiveVersion(agentName: string, environment: Environment): Promise<string | null> {
    const agent = await this.findAgent(agentName);
    if (!agent) return null;

    const activeVersions = agent.activeVersions ?? {};
    return activeVersions[environment] ?? null;
  }

  async setActiveVersion(
    agentName: string,
    version: string,
    environment: Environment,
  ): Promise<void> {
    await ProjectAgent.updateOne(
      { tenantId: this.tenantId, projectId: this.projectId, name: agentName },
      { $set: { [`activeVersions.${environment}`]: version } },
    );
  }

  async getActiveVersions(agentName: string): Promise<ActiveVersions> {
    const agent = await this.findAgent(agentName);
    if (!agent) return {};

    return (agent.activeVersions as ActiveVersions) ?? {};
  }

  async listAgents(): Promise<string[]> {
    const agents = await ProjectAgent.find(
      { tenantId: this.tenantId, projectId: this.projectId },
      { name: 1 },
    ).lean();

    return agents.map((a: any) => a.name);
  }

  async queryVersions(params: QueryAgentsParams): Promise<AgentVersion[]> {
    // Build a filter for ProjectAgent if we have a name filter
    const agentFilter: Record<string, any> = {
      tenantId: this.tenantId,
      projectId: this.projectId,
    };
    if (params.agentName) {
      agentFilter.name = params.agentName;
    }

    const agents = await ProjectAgent.find(agentFilter, {
      _id: 1,
      name: 1,
    }).lean();

    if (agents.length === 0) return [];

    // Build a lookup map: agentId -> agentName
    const agentIdToName = new Map<string, string>();
    const agentIds: string[] = [];
    for (const agent of agents) {
      const id = String(agent._id);
      agentIdToName.set(id, (agent as any).name);
      agentIds.push(id);
    }

    // Build the version query filter
    const versionFilter: Record<string, any> = {
      agentId: { $in: agentIds },
    };
    if (params.status) {
      versionFilter.status = params.status;
    }

    const versionDocs = await AgentVersionModel.find(versionFilter).sort({ createdAt: -1 }).lean();

    return versionDocs.map((doc: any) => {
      const agentName = agentIdToName.get(String(doc.agentId)) ?? 'unknown';
      return this.mapDocToAgentVersion(agentName, doc);
    });
  }

  async getVersionHistory(agentName: string, limit?: number): Promise<AgentVersion[]> {
    const agent = await this.findAgent(agentName);
    if (!agent) return [];

    let query = AgentVersionModel.find({ agentId: agent._id }).sort({
      createdAt: -1,
    });

    if (limit) {
      query = query.limit(limit);
    }

    const versionDocs = await query.lean();

    return versionDocs.map((doc: any) => this.mapDocToAgentVersion(agentName, doc));
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMongoAgentRegistry(
  scope: MongoAgentRegistryScope,
  auditStore?: AuditStore,
): MongoAgentRegistry {
  return new MongoAgentRegistry({ type: 'mongodb' }, scope, auditStore);
}

function assertMongoAgentRegistryScope(scope: MongoAgentRegistryScope): void {
  if (!scope || !scope.tenantId?.trim() || !scope.projectId?.trim()) {
    throw new Error('MongoAgentRegistry requires non-empty tenantId and projectId scope');
  }
}
