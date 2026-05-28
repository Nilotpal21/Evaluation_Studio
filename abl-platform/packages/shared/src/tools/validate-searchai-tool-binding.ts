/**
 * Async DB cross-check for SearchAI tool bindings.
 *
 * SearchIndex is scoped by tenant and project. The DSL carries tenant_id for
 * runtime binding compatibility, but the authoritative tenant/project scope is
 * always the authenticated request context.
 */

export type SearchAIValidationErrorCode =
  | 'SEARCHAI_INDEX_NOT_FOUND'
  | 'SEARCHAI_TENANT_MISMATCH'
  | 'INVALID_TOOL_BINDING';

export interface SearchAIValidationSuccess {
  valid: true;
}

export interface SearchAIValidationFailure {
  valid: false;
  error: {
    code: SearchAIValidationErrorCode;
    message: string;
  };
}

export type SearchAIValidationResult = SearchAIValidationSuccess | SearchAIValidationFailure;

export interface SearchAIIndexDoc {
  _id: string;
  tenantId: string;
  projectId: string;
}

export interface SearchAIIndexesRepo {
  findOne(filter: Record<string, unknown>): Promise<SearchAIIndexDoc | null>;
}

export interface ValidateSearchAIBindingContext {
  tenantId: string;
  projectId: string;
  searchIndexesRepo: SearchAIIndexesRepo;
  allowConfigPlaceholders?: boolean;
}

export interface SearchAIToolBinding {
  indexId: string;
  tenantId: string;
}

const CONFIG_TEMPLATE_RE = /\{\{config\.[A-Za-z_][A-Za-z0-9_]*\}\}/;

function hasConfigTemplate(value: string | undefined): boolean {
  return typeof value === 'string' && CONFIG_TEMPLATE_RE.test(value);
}

export async function validateSearchAIToolBinding(
  binding: SearchAIToolBinding,
  ctx: ValidateSearchAIBindingContext,
): Promise<SearchAIValidationResult> {
  if (!binding.indexId) {
    return {
      valid: false,
      error: {
        code: 'INVALID_TOOL_BINDING',
        message: 'SearchAI tool requires index_id property',
      },
    };
  }

  if (!binding.tenantId) {
    return {
      valid: false,
      error: {
        code: 'INVALID_TOOL_BINDING',
        message: 'SearchAI tool requires tenant_id property',
      },
    };
  }

  if (hasConfigTemplate(binding.indexId) || hasConfigTemplate(binding.tenantId)) {
    if (!ctx.allowConfigPlaceholders) {
      return {
        valid: false,
        error: {
          code: 'INVALID_TOOL_BINDING',
          message: 'SearchAI tool identity fields cannot use config placeholders',
        },
      };
    }
    return { valid: true };
  }

  if (binding.tenantId !== ctx.tenantId) {
    return {
      valid: false,
      error: {
        code: 'SEARCHAI_TENANT_MISMATCH',
        message: 'SearchAI tool tenant_id does not match the authenticated tenant',
      },
    };
  }

  const index = await ctx.searchIndexesRepo.findOne({
    _id: binding.indexId,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
  });

  if (!index) {
    return {
      valid: false,
      error: {
        code: 'SEARCHAI_INDEX_NOT_FOUND',
        message: 'SearchAI index not found in project',
      },
    };
  }

  return { valid: true };
}
