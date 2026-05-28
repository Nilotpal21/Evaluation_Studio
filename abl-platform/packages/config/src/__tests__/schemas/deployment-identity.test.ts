import { describe, it, expect } from 'vitest';
import {
  loadDeploymentIdentity,
  resolveVaultBasePath,
} from '../../schemas/deployment-identity.schema.js';

describe('loadDeploymentIdentity', () => {
  it('loads identity from valid env vars', () => {
    const env = {
      DEPLOYMENT_ENVIRONMENT: 'production',
      DEPLOYMENT_REGION: 'eu-west-1',
      DEPLOYMENT_TYPE: 'saas-multi-tenant',
      CUSTOMER_ID: 'cust-123',
    };
    const identity = loadDeploymentIdentity(env);
    expect(identity.environment).toBe('production');
    expect(identity.region).toBe('eu-west-1');
    expect(identity.deploymentType).toBe('saas-multi-tenant');
    expect(identity.customerId).toBe('cust-123');
  });

  it('defaults to dev when no env vars are set', () => {
    const identity = loadDeploymentIdentity({});
    expect(identity.environment).toBe('dev');
    expect(identity.region).toBe('us-east-1');
    expect(identity.deploymentType).toBe('shared-dev');
    expect(identity.customerId).toBeUndefined();
  });

  it('throws on invalid environment value', () => {
    const env = {
      DEPLOYMENT_ENVIRONMENT: 'invalid-env',
      DEPLOYMENT_REGION: 'us-east-1',
      DEPLOYMENT_TYPE: 'shared-dev',
    };
    expect(() => loadDeploymentIdentity(env)).toThrow();
  });

  it('maps NODE_ENV=test to dev environment', () => {
    const identity = loadDeploymentIdentity({ NODE_ENV: 'test' });
    expect(identity.environment).toBe('dev');
  });

  it('uses explicit vaultPath from env', () => {
    const env = {
      DEPLOYMENT_ENVIRONMENT: 'production',
      DEPLOYMENT_REGION: 'us-east-1',
      DEPLOYMENT_TYPE: 'saas-multi-tenant',
      VAULT_PATH: 'secret/data/custom/path',
    };
    const identity = loadDeploymentIdentity(env);
    expect(identity.vaultPath).toBe('secret/data/custom/path');
  });
});

describe('resolveVaultBasePath', () => {
  it('returns dev path for shared-dev', () => {
    const path = resolveVaultBasePath({
      environment: 'dev',
      region: 'us-east-1',
      deploymentType: 'shared-dev',
    });
    expect(path).toBe('secret/data/abl-platform/dev');
  });

  it('returns region-specific path for saas-multi-tenant', () => {
    const path = resolveVaultBasePath({
      environment: 'production',
      region: 'eu-west-1',
      deploymentType: 'saas-multi-tenant',
    });
    expect(path).toBe('secret/data/abl-platform/prod/eu-west-1');
  });

  it('returns customer path for saas-dedicated with customerId', () => {
    const path = resolveVaultBasePath({
      environment: 'production',
      region: 'us-east-1',
      deploymentType: 'saas-dedicated',
      customerId: 'cust-456',
    });
    expect(path).toBe('secret/data/customers/cust-456');
  });

  it('returns region path for private-vpc without customerId', () => {
    const path = resolveVaultBasePath({
      environment: 'production',
      region: 'ap-south-1',
      deploymentType: 'private-vpc',
    });
    expect(path).toBe('secret/data/abl-platform/prod/ap-south-1');
  });

  it('returns local path for on-premise', () => {
    const path = resolveVaultBasePath({
      environment: 'production',
      region: 'local',
      deploymentType: 'on-premise',
    });
    expect(path).toBe('secret/data/local');
  });

  it('returns explicit vaultPath when provided', () => {
    const path = resolveVaultBasePath({
      environment: 'production',
      region: 'us-east-1',
      deploymentType: 'saas-multi-tenant',
      vaultPath: 'secret/data/custom/override',
    });
    expect(path).toBe('secret/data/custom/override');
  });
});
