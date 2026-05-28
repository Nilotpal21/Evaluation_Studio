import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('studio:default-variable-namespace');

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

export async function getOrCreateDefaultVariableNamespaceIds(params: {
  tenantId: string;
  projectId: string;
  createdBy: string;
  required?: boolean;
}): Promise<string[]> {
  try {
    const { VariableNamespace } = await import('@agent-platform/database/models');
    let defaultNamespace = await VariableNamespace.findOne({
      tenantId: params.tenantId,
      projectId: params.projectId,
      isDefault: true,
    }).lean();

    if (!defaultNamespace) {
      try {
        defaultNamespace = (
          await VariableNamespace.create({
            tenantId: params.tenantId,
            projectId: params.projectId,
            name: 'default',
            displayName: 'Default',
            description: 'Default variable namespace',
            isDefault: true,
            order: 0,
            createdBy: params.createdBy,
          })
        ).toObject();
      } catch (err) {
        if (!isDuplicateKeyError(err)) {
          throw err;
        }
        defaultNamespace = await VariableNamespace.findOne({
          tenantId: params.tenantId,
          projectId: params.projectId,
          isDefault: true,
        }).lean();
      }
    }

    if (!defaultNamespace) {
      if (params.required) {
        throw new Error('Default variable namespace is unavailable');
      }
      return [];
    }

    return [String(defaultNamespace._id)];
  } catch (err) {
    log.warn('Failed to get or create default variable namespace', {
      tenantId: params.tenantId,
      projectId: params.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    if (params.required) {
      throw err;
    }
    return [];
  }
}
