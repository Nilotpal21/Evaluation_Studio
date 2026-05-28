import {
  buildSearchAIBindingFromProps,
  buildWorkflowBindingFromProps,
  parseDslProperties,
  validateSearchAIToolBinding,
  validateWorkflowToolBinding,
  type ProjectToolType,
  type SearchAIIndexesRepo,
  type TriggerRegistrationsRepo,
  type WorkflowVersionsRepo,
  type WorkflowsRepo,
} from '@agent-platform/shared/tools';

export interface ProjectToolBindingSaveValidationInput {
  tenantId: string;
  projectId: string;
  toolType: ProjectToolType;
  dslContent: string;
}

export type ProjectToolBindingSaveValidationResult =
  | { valid: true }
  | {
      valid: false;
      status: number;
      code: string;
      message: string;
    };

export async function validateProjectToolBindingsForSave(
  input: ProjectToolBindingSaveValidationInput,
): Promise<ProjectToolBindingSaveValidationResult> {
  if (input.toolType === 'workflow') {
    return validateWorkflowBindingForSave(input);
  }

  if (input.toolType === 'searchai') {
    return validateSearchAIBindingForSave(input);
  }

  return { valid: true };
}

async function validateWorkflowBindingForSave({
  tenantId,
  projectId,
  dslContent,
}: ProjectToolBindingSaveValidationInput): Promise<ProjectToolBindingSaveValidationResult> {
  try {
    const binding = buildWorkflowBindingFromProps(parseDslProperties(dslContent));
    const { Workflow, WorkflowVersion, TriggerRegistration } =
      await import('@agent-platform/database/models');
    const workflowsRepo: WorkflowsRepo = {
      // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
      findOne: (filter) => Workflow.findOne(filter).lean(),
    };
    const workflowVersionsRepo: WorkflowVersionsRepo = {
      // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
      findOne: (filter) => WorkflowVersion.findOne(filter).lean(),
    };
    const triggerRegistrationsRepo: TriggerRegistrationsRepo = {
      // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
      findOne: (filter) => TriggerRegistration.findOne(filter).lean(),
    };

    const result = await validateWorkflowToolBinding(
      {
        workflowId: binding.workflowId,
        workflowVersionId: binding.workflowVersionId,
        workflowVersion: binding.workflowVersion,
        triggerId: binding.triggerId,
      },
      {
        tenantId,
        projectId,
        workflowsRepo,
        workflowVersionsRepo,
        triggerRegistrationsRepo,
      },
    );
    if (!result.valid) {
      return {
        valid: false,
        status: result.error.code === 'WORKFLOW_NOT_FOUND' ? 404 : 400,
        code: result.error.code,
        message: result.error.message,
      };
    }
  } catch (err: unknown) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_TOOL_BINDING',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { valid: true };
}

async function validateSearchAIBindingForSave({
  tenantId,
  projectId,
  dslContent,
}: ProjectToolBindingSaveValidationInput): Promise<ProjectToolBindingSaveValidationResult> {
  try {
    const binding = buildSearchAIBindingFromProps(parseDslProperties(dslContent));
    const { SearchIndex } = await import('@agent-platform/database/models');
    const searchIndexesRepo: SearchAIIndexesRepo = {
      // eslint-disable-next-line studio-tenant/no-unscoped-mongoose-query
      findOne: (filter) => SearchIndex.findOne(filter).lean(),
    };
    const result = await validateSearchAIToolBinding(binding, {
      tenantId,
      projectId,
      searchIndexesRepo,
    });
    if (!result.valid) {
      return {
        valid: false,
        status: result.error.code === 'SEARCHAI_INDEX_NOT_FOUND' ? 404 : 400,
        code: result.error.code,
        message: result.error.message,
      };
    }
  } catch (err: unknown) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_TOOL_BINDING',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  return { valid: true };
}
