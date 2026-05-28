import type mongoose from 'mongoose';
import { SYSTEM_ROLES } from '../constants/system-roles.js';
import { RoleDefinition } from '../models/role-definition.model.js';
import { TenantLLMPolicy } from '../models/tenant-llm-policy.model.js';
import { uuidv7 } from '../mongo/base-document.js';
import { upsertOne } from './upsert-helpers.js';

export const DEFAULT_TENANT_LLM_POLICY = {
  allowedProviders: [] as string[],
  credentialPolicy: 'org_first',
  monthlyTokenBudget: 10000000,
  dailyTokenBudget: 1000000,
  defaultModel: null,
  defaultFastModel: null,
  defaultVoiceModel: null,
  maxRequestsPerMinute: 100,
  allowProjectCredentials: true,
  platformDemoEnabled: false,
} as const;

export interface SeedTenantBootstrapOptions {
  tenantId: string;
  createdBy: string;
  session?: mongoose.ClientSession | null;
}

export interface SeedTenantBootstrapResult {
  roleCount: number;
  policyEnsured: boolean;
}

/**
 * Seed tenant-scoped defaults required for a workspace to function, without
 * bringing along dev-only fixtures like example projects or debug tokens.
 */
export async function seedTenantBootstrapDefaults(
  options: SeedTenantBootstrapOptions,
): Promise<SeedTenantBootstrapResult> {
  const { tenantId, createdBy, session } = options;

  let roleCount = 0;
  for (const role of SYSTEM_ROLES) {
    await upsertOne(
      RoleDefinition,
      { tenantId, name: role.name },
      {
        tenantId,
        name: role.name,
        description: role.description,
        isSystem: true,
        permissions: role.permissions,
        createdBy,
      },
      {
        description: role.description,
        permissions: role.permissions,
      },
      { session },
    );
    roleCount++;
  }

  await TenantLLMPolicy.findOneAndUpdate(
    { tenantId },
    {
      $setOnInsert: {
        _id: `policy-${uuidv7()}`,
        tenantId,
        ...DEFAULT_TENANT_LLM_POLICY,
      },
    },
    {
      upsert: true,
      new: true,
      session: session ?? undefined,
      setDefaultsOnInsert: true,
    },
  );

  return {
    roleCount,
    policyEnsured: true,
  };
}
