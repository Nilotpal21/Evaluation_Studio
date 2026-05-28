import type { Environment } from '@abl/compiler/platform';

const ENVIRONMENT_MAP: Record<string, Environment> = {
  dev: 'dev',
  development: 'dev',
  test: 'dev',
  staging: 'staging',
  stage: 'staging',
  production: 'production',
  prod: 'production',
};

export function getRuntimeAuditEnvironment(
  env: Record<string, string | undefined> = process.env,
): Environment {
  const rawEnvironment =
    env['DEPLOYMENT_ENVIRONMENT'] ?? env['RUNTIME_ENV'] ?? env['APP_ENV'] ?? env['NODE_ENV'];
  const normalized = rawEnvironment?.trim().toLowerCase();

  if (normalized && normalized in ENVIRONMENT_MAP) {
    return ENVIRONMENT_MAP[normalized];
  }

  return 'dev';
}
