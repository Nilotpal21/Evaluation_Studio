import { createLogger } from '@abl/compiler/platform';

const log = createLogger('voice-service-instance-repo');

export interface VoiceServiceInstanceRecord {
  _id?: string;
  id?: string;
  tenantId: string;
  serviceType: string;
  authProfileId?: string | null;
  encryptedApiKey?: string;
  encryptedConfig?: Record<string, unknown> | string | null;
  isActive?: boolean;
  isDefault?: boolean;
}

async function findVoiceServiceInstance(
  filter: Record<string, unknown>,
): Promise<VoiceServiceInstanceRecord | null> {
  const { TenantServiceInstance } = await import('@agent-platform/database/models');

  // Do not use `.lean()` here. TenantServiceInstance stores encrypted fields and
  // relies on Mongoose document reads for automatic decryption before the voice
  // providers consume the API keys / config payload.
  return (await TenantServiceInstance.findOne(filter)) as VoiceServiceInstanceRecord | null;
}

/**
 * Resolve the tenant-scoped voice service instance, preferring the default
 * active instance and falling back to any active instance of the same type.
 */
export async function findDefaultActiveVoiceServiceInstance(
  tenantId: string,
  serviceType: string,
): Promise<VoiceServiceInstanceRecord | null> {
  try {
    const defaultInstance = await findVoiceServiceInstance({
      tenantId,
      serviceType,
      isDefault: true,
      isActive: true,
    });

    if (defaultInstance) {
      return defaultInstance;
    }

    return await findVoiceServiceInstance({
      tenantId,
      serviceType,
      isActive: true,
    });
  } catch (err) {
    log.warn('Failed to resolve service instance', {
      tenantId,
      serviceType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function findActiveVoiceServiceInstanceById(
  tenantId: string,
  instanceId: string,
  serviceType?: string,
): Promise<VoiceServiceInstanceRecord | null> {
  try {
    const filter: Record<string, unknown> = {
      _id: instanceId,
      tenantId,
      isActive: true,
    };

    if (serviceType) {
      filter.serviceType = serviceType;
    }

    return await findVoiceServiceInstance(filter);
  } catch (err) {
    log.warn('Failed to resolve service instance by id', {
      tenantId,
      instanceId,
      serviceType,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
