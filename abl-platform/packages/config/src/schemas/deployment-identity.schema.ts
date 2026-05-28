import { z } from 'zod';

export const DeploymentIdentitySchema = z.object({
  environment: z.enum(['dev', 'staging', 'production']),
  region: z.string().min(1),
  deploymentType: z.enum([
    'shared-dev',
    'saas-multi-tenant',
    'saas-dedicated',
    'private-vpc',
    'on-premise',
  ]),
  customerId: z.string().optional(),
  vaultPath: z.string().optional(),
});

export type DeploymentIdentityInput = z.input<typeof DeploymentIdentitySchema>;
export type DeploymentIdentityParsed = z.infer<typeof DeploymentIdentitySchema>;

export const BuildManifestSchema = z.object({
  productVersion: z.string(),
  buildHash: z.string(),
  buildTimestamp: z.string(),
  configSchemaVersion: z.string(),
});

export type BuildManifestParsed = z.infer<typeof BuildManifestSchema>;

/**
 * Load deployment identity from environment variables.
 * Falls back to dev defaults if not set.
 */
export function loadDeploymentIdentity(
  env: Record<string, string | undefined> = process.env,
): DeploymentIdentityParsed {
  // Map NODE_ENV=test to 'dev' since 'test' is not a valid deployment environment
  const rawEnv = env.DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'dev';
  const environment = rawEnv === 'test' ? 'dev' : rawEnv;

  const raw = {
    environment,
    region: env.DEPLOYMENT_REGION || 'us-east-1',
    deploymentType: env.DEPLOYMENT_TYPE || 'shared-dev',
    customerId: env.CUSTOMER_ID || undefined,
    vaultPath: env.VAULT_PATH || undefined,
  };

  try {
    return DeploymentIdentitySchema.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse deployment identity: ${message}`);
  }
}

/**
 * Derive the Vault base path from deployment identity.
 */
export function resolveVaultBasePath(identity: DeploymentIdentityParsed): string {
  // Explicit vault path takes precedence over convention-based resolution
  if (identity.vaultPath) {
    return identity.vaultPath;
  }

  switch (identity.deploymentType) {
    case 'shared-dev':
      return 'secret/data/abl-platform/dev';
    case 'saas-multi-tenant':
      return `secret/data/abl-platform/prod/${identity.region}`;
    case 'saas-dedicated':
    case 'private-vpc':
      return identity.customerId
        ? `secret/data/customers/${identity.customerId}`
        : `secret/data/abl-platform/prod/${identity.region}`;
    case 'on-premise':
      return 'secret/data/local';
  }
}
