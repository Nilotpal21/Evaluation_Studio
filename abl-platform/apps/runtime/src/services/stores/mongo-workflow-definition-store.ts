import {
  WorkflowDefinitionStore,
  WorkflowDefinitionStoreConfig,
  CreateWorkflowDefinitionParams,
  UpdateWorkflowDefinitionParams,
  QueryWorkflowDefinitionsParams,
} from '@abl/compiler/platform/stores/workflow-definition-store.js';
import type { WorkflowDefinition } from '@abl/compiler/platform/core/types';
import { Workflow } from '@agent-platform/database/models';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

function mapDocToDefinition(doc: any): WorkflowDefinition {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    projectId: doc.projectId,
    name: doc.name,
    type: doc.type,
    description: doc.description,
    entryAgent: doc.entryAgent,
    steps: doc.steps,
    triggers: doc.triggers,
    slaMinutes: doc.slaMinutes,
    escalationRules: doc.escalationRules,
    notificationRules: doc.notificationRules,
    status: doc.status,
    metadata: doc.metadata,
    tags: doc.tags,
    // Node-based canvas fields
    nodes: doc.nodes,
    edges: doc.edges,
    envVars: doc.envVars,
    inputSchema: doc.inputSchema,
    outputSchema: doc.outputSchema,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    archivedAt: doc.archivedAt,
  };
}

export class MongoWorkflowDefinitionStore extends WorkflowDefinitionStore {
  constructor(config: WorkflowDefinitionStoreConfig) {
    super(config);
  }

  async create(params: CreateWorkflowDefinitionParams): Promise<WorkflowDefinition> {
    const doc = await Workflow.create({
      tenantId: params.tenantId,
      projectId: params.projectId,
      name: params.name,
      type: params.type,
      description: params.description,
      entryAgent: params.entryAgent,
      steps: params.steps,
      triggers: params.triggers,
      slaMinutes: params.slaMinutes,
      escalationRules: params.escalationRules,
      status: params.status || 'active',
      metadata: params.metadata,
      tags: params.tags,
      // Node-based canvas fields
      nodes: params.nodes,
      edges: params.edges,
      envVars: params.envVars,
      inputSchema: params.inputSchema,
      outputSchema: params.outputSchema,
      createdBy: params.createdBy ?? '',
    });

    return mapDocToDefinition(doc);
  }

  async getById(
    id: string,
    tenantId: string,
    projectId: string,
  ): Promise<WorkflowDefinition | null> {
    const doc = await Workflow.findOne({ _id: id, tenantId, projectId }).lean();
    if (!doc) return null;
    return mapDocToDefinition(doc);
  }

  async getByName(
    tenantId: string,
    projectId: string,
    name: string,
  ): Promise<WorkflowDefinition | null> {
    const doc = await Workflow.findOne({ tenantId, projectId, name }).lean();
    if (!doc) return null;
    return mapDocToDefinition(doc);
  }

  async update(
    id: string,
    tenantId: string,
    projectId: string,
    params: UpdateWorkflowDefinitionParams,
  ): Promise<WorkflowDefinition> {
    const doc = await Workflow.findOneAndUpdate(
      { _id: id, tenantId, projectId },
      { $set: params },
      { new: true, lean: true },
    );

    if (!doc) {
      throw new AppError(`Workflow definition not found: ${id}`, { ...ErrorCodes.NOT_FOUND });
    }

    return mapDocToDefinition(doc);
  }

  async query(
    params: QueryWorkflowDefinitionsParams,
  ): Promise<{ definitions: WorkflowDefinition[]; total: number }> {
    const filter: Record<string, unknown> = {
      tenantId: params.tenantId,
      // Exclude soft-deleted and uninitialized-field docs from list views.
      // Use { $ne: true } so legacy documents without the deleted field are
      // still returned — only explicitly deleted (deleted: true) ones are hidden.
      deleted: { $ne: true },
    };

    if (params.projectId) {
      filter.projectId = params.projectId;
    }

    if (params.status) {
      filter.status = params.status;
    } else {
      // Archived workflows are retired — exclude them from default list views.
      // Pass status='archived' (or ['archived']) to fetch them explicitly.
      filter.status = { $ne: 'archived' };
    }

    if (params.type) {
      filter.type = params.type;
    }

    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;

    const [docs, total] = await Promise.all([
      Workflow.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      Workflow.countDocuments(filter),
    ]);

    return {
      definitions: docs.map(mapDocToDefinition),
      total,
    };
  }

  async archive(id: string, tenantId: string, projectId: string): Promise<void> {
    const result = await Workflow.findOneAndUpdate(
      { _id: id, tenantId, projectId },
      {
        $set: {
          status: 'archived',
          archivedAt: new Date(),
        },
      },
    );

    if (!result) {
      throw new AppError(`Workflow definition not found: ${id}`, { ...ErrorCodes.NOT_FOUND });
    }
  }
}

export function createMongoWorkflowDefinitionStore(
  config?: Partial<WorkflowDefinitionStoreConfig>,
): MongoWorkflowDefinitionStore {
  return new MongoWorkflowDefinitionStore({
    type: 'mongodb',
    ...config,
  });
}
