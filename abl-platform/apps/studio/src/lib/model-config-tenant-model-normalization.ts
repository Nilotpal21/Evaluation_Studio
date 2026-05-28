export interface ModelConfigTenantBindingError {
  status: number;
  error: string;
  details?: Array<{ message: string }>;
}

export type ModelConfigTenantBindingResult<
  T extends { modelId?: string; tenantModelId?: string | null },
> = { ok: true; data: T } | { ok: false; error: ModelConfigTenantBindingError };

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export async function normalizeProjectModelTenantBinding<
  T extends {
    provider?: string;
    modelId?: string;
    tenantModelId?: string | null;
  },
>(input: {
  data: T;
  tenantId: string;
  requireModelIdentity: boolean;
}): Promise<ModelConfigTenantBindingResult<T>> {
  const tenantModelId = normalizeOptionalString(input.data.tenantModelId);
  if (!tenantModelId) {
    const modelId = normalizeOptionalString(input.data.modelId);
    if (input.requireModelIdentity && !modelId) {
      return {
        ok: false,
        error: {
          status: 400,
          error: 'Invalid request',
          details: [{ message: 'modelId or tenantModelId is required' }],
        },
      };
    }
    return {
      ok: true,
      data: modelId ? ({ ...input.data, modelId } as T) : input.data,
    };
  }

  const { TenantModel } = await import('@agent-platform/database/models');
  const tenantModel = (await TenantModel.findOne({
    _id: tenantModelId,
    tenantId: input.tenantId,
    isActive: true,
    inferenceEnabled: { $ne: false },
  }).lean()) as { provider?: unknown; modelId?: unknown } | null;

  if (!tenantModel) {
    return {
      ok: false,
      error: {
        status: 404,
        error: 'Tenant model not found',
      },
    };
  }

  const provider = normalizeOptionalString(tenantModel.provider);
  const modelId = normalizeOptionalString(tenantModel.modelId);
  if (!provider || !modelId) {
    return {
      ok: false,
      error: {
        status: 400,
        error: 'Tenant model is missing portable provider/model identity',
      },
    };
  }

  return {
    ok: true,
    data: {
      ...input.data,
      provider,
      modelId,
      tenantModelId,
    },
  };
}
