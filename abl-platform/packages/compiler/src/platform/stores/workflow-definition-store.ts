/**
 * Workflow Definition Store
 *
 * Manages workflow templates/definitions (name, steps blueprint,
 * SLA, escalation rules). Distinct from the runtime's WorkflowStore which
 * tracks live workflow execution instances.
 */

import { randomUUID } from 'crypto';
import type {
  WorkflowDefinition,
  WorkflowDefinitionType,
  WorkflowDefinitionStatus,
} from '../core/types.js';

// =============================================================================
// INTERFACES
// =============================================================================

export interface WorkflowDefinitionStoreConfig {
  type: 'postgres' | 'mongodb' | 'memory';
  connectionString?: string;
}

export interface CreateWorkflowDefinitionParams {
  tenantId: string;
  projectId: string;
  name: string;
  type?: WorkflowDefinitionType;
  description?: string;
  entryAgent?: string;
  steps?: Record<string, unknown>[];
  triggers?: Record<string, unknown>[];
  slaMinutes?: number;
  escalationRules?: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
  tags?: string[];
  // Node-based canvas fields
  nodes?: Record<string, unknown>[];
  edges?: Record<string, unknown>[];
  envVars?: Record<string, string>;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  status?: WorkflowDefinitionStatus;
  createdBy?: string;
}

export interface UpdateWorkflowDefinitionParams {
  name?: string;
  type?: WorkflowDefinitionType;
  description?: string;
  entryAgent?: string;
  steps?: Record<string, unknown>[];
  triggers?: Record<string, unknown>[];
  slaMinutes?: number;
  escalationRules?: Record<string, unknown>[];
  status?: WorkflowDefinitionStatus;
  metadata?: Record<string, unknown>;
  tags?: string[];
  // Node-based canvas fields
  nodes?: Record<string, unknown>[];
  edges?: Record<string, unknown>[];
  envVars?: Record<string, string>;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
}

export interface QueryWorkflowDefinitionsParams {
  tenantId: string;
  projectId?: string;
  type?: WorkflowDefinitionType;
  status?: WorkflowDefinitionStatus;
  limit?: number;
  offset?: number;
}

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class WorkflowDefinitionStore {
  protected config: WorkflowDefinitionStoreConfig;

  constructor(config: WorkflowDefinitionStoreConfig) {
    this.config = config;
  }

  abstract create(params: CreateWorkflowDefinitionParams): Promise<WorkflowDefinition>;
  abstract getById(
    id: string,
    tenantId: string,
    projectId: string,
  ): Promise<WorkflowDefinition | null>;
  abstract getByName(
    tenantId: string,
    projectId: string,
    name: string,
  ): Promise<WorkflowDefinition | null>;
  abstract update(
    id: string,
    tenantId: string,
    projectId: string,
    params: UpdateWorkflowDefinitionParams,
  ): Promise<WorkflowDefinition>;
  abstract query(
    params: QueryWorkflowDefinitionsParams,
  ): Promise<{ definitions: WorkflowDefinition[]; total: number }>;
  abstract archive(id: string, tenantId: string, projectId: string): Promise<void>;
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION
// =============================================================================

export class InMemoryWorkflowDefinitionStore extends WorkflowDefinitionStore {
  private definitions: Map<string, WorkflowDefinition> = new Map();

  async create(params: CreateWorkflowDefinitionParams): Promise<WorkflowDefinition> {
    const definition: WorkflowDefinition = {
      id: randomUUID(),
      tenantId: params.tenantId,
      projectId: params.projectId,
      name: params.name,
      type: params.type || 'cx_automation',
      description: params.description,
      entryAgent: params.entryAgent,
      steps: params.steps || [],
      triggers: params.triggers || [],
      slaMinutes: params.slaMinutes,
      escalationRules: params.escalationRules || [],
      status: 'active',
      metadata: params.metadata || {},
      tags: params.tags || [],
      createdAt: new Date(),
    };

    this.definitions.set(definition.id, definition);
    return definition;
  }

  async getById(
    id: string,
    tenantId: string,
    projectId: string,
  ): Promise<WorkflowDefinition | null> {
    const def = this.definitions.get(id);
    if (!def || def.tenantId !== tenantId || def.projectId !== projectId) return null;
    return def;
  }

  async getByName(
    tenantId: string,
    projectId: string,
    name: string,
  ): Promise<WorkflowDefinition | null> {
    for (const def of this.definitions.values()) {
      if (def.tenantId === tenantId && def.projectId === projectId && def.name === name) {
        return def;
      }
    }
    return null;
  }

  async update(
    id: string,
    tenantId: string,
    projectId: string,
    params: UpdateWorkflowDefinitionParams,
  ): Promise<WorkflowDefinition> {
    const definition = this.definitions.get(id);
    if (!definition || definition.tenantId !== tenantId || definition.projectId !== projectId) {
      throw new Error(`WorkflowDefinition ${id} not found`);
    }

    const updated: WorkflowDefinition = {
      ...definition,
      ...params,
      metadata: params.metadata
        ? { ...definition.metadata, ...params.metadata }
        : definition.metadata,
    };

    this.definitions.set(id, updated);
    return updated;
  }

  async query(
    params: QueryWorkflowDefinitionsParams,
  ): Promise<{ definitions: WorkflowDefinition[]; total: number }> {
    let definitions = Array.from(this.definitions.values()).filter(
      (d) => d.tenantId === params.tenantId,
    );

    if (params.projectId) {
      definitions = definitions.filter((d) => d.projectId === params.projectId);
    }
    if (params.type) {
      definitions = definitions.filter((d) => d.type === params.type);
    }
    if (params.status) {
      definitions = definitions.filter((d) => d.status === params.status);
    }

    definitions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = definitions.length;
    const offset = params.offset || 0;
    const limit = params.limit || 50;

    return {
      definitions: definitions.slice(offset, offset + limit),
      total,
    };
  }

  async archive(id: string, tenantId: string, projectId: string): Promise<void> {
    const definition = this.definitions.get(id);
    if (!definition || definition.tenantId !== tenantId || definition.projectId !== projectId) {
      throw new Error(`WorkflowDefinition ${id} not found`);
    }
    definition.status = 'archived';
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createWorkflowDefinitionStore(
  config: WorkflowDefinitionStoreConfig,
): WorkflowDefinitionStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryWorkflowDefinitionStore(config);
    case 'postgres':
      throw new Error('PostgreSQL workflow definition store not yet implemented');
    case 'mongodb':
      throw new Error('MongoDB workflow definition store not yet implemented');
    default:
      throw new Error(`Unknown workflow definition store type: ${config.type}`);
  }
}
