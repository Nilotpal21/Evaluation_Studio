/**
 * Service Registry for Benchmark Orchestrator
 *
 * Maps services to their k6 scripts, categories, and deployment names.
 * Provides resolution from category/name inputs to service lists.
 */

export interface ServiceRegistryEntry {
  configKey: string;
  k6Script: string | null;
  category: ServiceCategory;
  /** Suffix after the deployment prefix (e.g., 'runtime' → '{prefix}-runtime') */
  deploymentSuffix: string;
  /** Resolved at runtime via getDeploymentName() */
  deploymentName: string;
}

export type ServiceCategory = 'compute' | 'data-stores' | 'ai' | 'integration';

/**
 * Deployment name prefix — configurable via DEPLOYMENT_PREFIX env var.
 * Defaults to 'abl'. Set in cloud.env for environments that use a different
 * naming convention (e.g., 'abl-platform-dev' for dev clusters).
 *
 * The full deployment name is: {prefix}-{suffix}
 *   DEPLOYMENT_PREFIX=abl              → abl-runtime, abl-bge-m3
 *   DEPLOYMENT_PREFIX=abl-platform-dev → abl-platform-dev-runtime, abl-platform-dev-bge-m3
 */
function getPrefix(): string {
  return process.env.DEPLOYMENT_PREFIX || 'abl';
}

/** Get the full deployment name for a service suffix. */
export function getDeploymentName(suffix: string): string {
  return `${getPrefix()}-${suffix}`;
}

/** Build registry entries with deployment names resolved from the prefix. */
function entry(
  configKey: string,
  k6Script: string | null,
  category: ServiceCategory,
  suffix: string,
): ServiceRegistryEntry {
  return {
    configKey,
    k6Script,
    category,
    deploymentSuffix: suffix,
    get deploymentName() {
      return getDeploymentName(suffix);
    },
  };
}

/** Static registry — bounded at compile time, deployment names resolved at runtime via DEPLOYMENT_PREFIX. */
export const SERVICE_REGISTRY: Readonly<Record<string, ServiceRegistryEntry>> = {
  runtime: entry('runtime', 'saturation/runtime.ts', 'compute', 'runtime'),
  studio: entry('studio', null, 'compute', 'studio'),
  admin: entry('admin', null, 'compute', 'admin'),
  'search-ai': entry('searchAi', 'saturation/search-ai.ts', 'compute', 'search-ai'),
  'search-ai-runtime': entry('searchAiRuntime', null, 'compute', 'search-ai-runtime'),
  'bge-m3': entry('bgeM3', 'saturation/bge-m3.ts', 'ai', 'bge-m3'),
  docling: entry('docling', null, 'ai', 'docling'),
  preprocessing: entry('preprocessing', null, 'ai', 'preprocessing'),
  'workflow-engine': entry('workflowEngine', null, 'integration', 'workflow-engine'),
  mongodb: entry('mongodb', null, 'data-stores', 'mongodb'),
  redis: entry('redis', null, 'data-stores', 'redis'),
  clickhouse: entry('clickhouse', null, 'data-stores', 'clickhouse'),
  opensearch: entry('opensearch', null, 'data-stores', 'opensearch'),
  qdrant: entry('qdrant', null, 'data-stores', 'qdrant'),
  neo4j: entry('neo4j', null, 'data-stores', 'neo4j'),
  restate: entry('restate', null, 'integration', 'restate'),
};

/** Category aliases that expand to multiple services. */
export const SERVICE_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  '@compute': ['runtime', 'studio', 'admin', 'search-ai', 'search-ai-runtime', 'workflow-engine'],
  '@data-stores': ['mongodb', 'redis', 'clickhouse', 'opensearch', 'qdrant', 'neo4j'],
  '@ai': ['bge-m3', 'docling', 'preprocessing'],
  '@integration': ['workflow-engine', 'restate'],
  '@all': [
    'mongodb',
    'redis',
    'clickhouse',
    'opensearch',
    'qdrant',
    'neo4j',
    'bge-m3',
    'docling',
    'preprocessing',
    'runtime',
    'studio',
    'admin',
    'search-ai',
    'search-ai-runtime',
    'workflow-engine',
    'restate',
  ],
};

/**
 * Bottom-up test order: data stores first, then AI services, then app services.
 * This ensures dependencies are validated before dependents.
 */
export const SERVICE_TEST_ORDER: readonly string[] = [
  // Data stores
  'mongodb',
  'redis',
  'clickhouse',
  'opensearch',
  'qdrant',
  'neo4j',
  // AI services
  'bge-m3',
  'docling',
  'preprocessing',
  // Integration
  'restate',
  'workflow-engine',
  // Application services
  'search-ai-runtime',
  'search-ai',
  'admin',
  'studio',
  'runtime',
];

/**
 * Resolve a list of service names and/or category aliases to an ordered,
 * deduplicated list of service names following SERVICE_TEST_ORDER.
 */
export function resolveServices(input: string[]): string[] {
  const seen: Record<string, boolean> = {};

  for (const token of input) {
    const categoryServices = SERVICE_CATEGORIES[token];
    if (categoryServices) {
      for (const svc of categoryServices) {
        seen[svc] = true;
      }
      continue;
    }

    if (!(token in SERVICE_REGISTRY)) {
      const known = Object.keys(SERVICE_REGISTRY).join(', ');
      const categories = Object.keys(SERVICE_CATEGORIES).join(', ');
      throw new Error(
        `Unknown service or category: "${token}". ` +
          `Known services: ${known}. Categories: ${categories}`,
      );
    }

    seen[token] = true;
  }

  // Return in test order
  return SERVICE_TEST_ORDER.filter((svc) => seen[svc]);
}
