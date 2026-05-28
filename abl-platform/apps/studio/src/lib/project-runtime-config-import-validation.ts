import type {
  CoreImportRuntimeConfigSaveValidationInputV2,
  CoreImportRuntimeConfigSaveValidationResultV2,
  CoreImportRuntimeConfigSaveValidatorV2,
} from '@agent-platform/project-io/import';
import {
  collectImportedProjectModelIds,
  collectImportedPromptVersionSnapshots,
  resolveAdvancedNluEntitlement,
  validateProjectRuntimeConfigWrite,
} from '@agent-platform/project-io/import';
import { ensureDb } from '@/lib/ensure-db';

const ADVANCED_NLU_UNAVAILABLE = {
  valid: false as const,
  status: 403,
  code: 'PLAN_FEATURE_UNAVAILABLE',
  message: 'Advanced NLU provider requires an Enterprise plan',
};

async function validateAdvancedNluEntitlement(
  tenantId: string,
  config: Record<string, unknown> | undefined,
): Promise<CoreImportRuntimeConfigSaveValidationResultV2 | null> {
  const extraction = config?.extraction;
  if (
    typeof extraction !== 'object' ||
    extraction === null ||
    (extraction as Record<string, unknown>).nlu_provider !== 'advanced'
  ) {
    return null;
  }

  const entitlement = await resolveAdvancedNluEntitlement(tenantId, { ensureReady: ensureDb });
  if (entitlement.allowed) {
    return null;
  }

  return ADVANCED_NLU_UNAVAILABLE;
}

export async function validateProjectRuntimeConfigForSave({
  tenantId,
  projectId,
  data,
}: CoreImportRuntimeConfigSaveValidationInputV2): Promise<CoreImportRuntimeConfigSaveValidationResultV2> {
  const result = await validateProjectRuntimeConfigWrite({ tenantId, projectId, data });
  if (!result.valid) {
    return {
      valid: false,
      status: result.status,
      code: result.code,
      message: result.message,
    };
  }

  const entitlementFailure = await validateAdvancedNluEntitlement(tenantId, result.data);
  if (entitlementFailure) {
    return entitlementFailure;
  }

  return { valid: true, data: result.data };
}

export function createProjectRuntimeConfigSaveValidatorForFiles(
  files: ReadonlyMap<string, string>,
): CoreImportRuntimeConfigSaveValidatorV2 {
  const importedPromptVersions = collectImportedPromptVersionSnapshots(files);
  const importedProjectModelIds = collectImportedProjectModelIds(files);

  return async ({
    tenantId,
    projectId,
    data,
  }: CoreImportRuntimeConfigSaveValidationInputV2): Promise<CoreImportRuntimeConfigSaveValidationResultV2> => {
    const result = await validateProjectRuntimeConfigWrite({
      tenantId,
      projectId,
      data,
      importedPromptVersions,
      importedProjectModelIds,
    });
    if (!result.valid) {
      return {
        valid: false,
        status: result.status,
        code: result.code,
        message: result.message,
      };
    }

    const entitlementFailure = await validateAdvancedNluEntitlement(tenantId, result.data);
    if (entitlementFailure) {
      return entitlementFailure;
    }

    return { valid: true, data: result.data };
  };
}
