import type { AgentAssistBindingResolver as MongoResolver } from '../../repos/agent-assist-binding-repo.js';
import type { AgentAssistBinding, BindingStatus } from './types.js';

const VALID_STATUSES: readonly BindingStatus[] = ['active', 'disabled'];

export function isValidBindingStatus(value: unknown): value is BindingStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);
}

/**
 * Binding resolution interface used by the facade route handler.
 * Implementations front the Mongo-backed `AgentAssistBindingResolver` repo.
 */
export interface UnifiedBindingResolver {
  resolve(tenantId: string, appId: string, environment: string): Promise<AgentAssistBinding | null>;
}

/**
 * Wraps the Mongo-backed AgentAssistBindingResolver repo.
 * Converts the stored document into the facade's `AgentAssistBinding` shape.
 */
class MongoUnifiedResolver implements UnifiedBindingResolver {
  constructor(private readonly repo: MongoResolver) {}
  async resolve(
    tenantId: string,
    appId: string,
    environment: string,
  ): Promise<AgentAssistBinding | null> {
    const doc = await this.repo.get({ tenantId }, { appId, environment });
    if (!doc) return null;
    const rawId = (doc as { _id?: unknown })._id;
    const bindingId =
      typeof rawId === 'string'
        ? rawId
        : rawId && typeof (rawId as { toString?: () => string }).toString === 'function'
          ? (rawId as { toString: () => string }).toString()
          : undefined;
    const runtimeBaseUrlRaw = (doc as { runtimeBaseUrl?: unknown }).runtimeBaseUrl;
    const runtimeBaseUrl =
      typeof runtimeBaseUrlRaw === 'string' && runtimeBaseUrlRaw.length > 0
        ? runtimeBaseUrlRaw
        : undefined;
    const binding: AgentAssistBinding = {
      bindingId,
      appId: doc.appId,
      environment: doc.environment,
      tenantId: doc.tenantId,
      projectId: doc.projectId,
      status: doc.status === 'disabled' ? 'disabled' : 'active',
      deploymentId: doc.deploymentId ?? undefined,
      apiKeyId: doc.apiKeyId ?? undefined,
      runtimeBaseUrl,
      displayName: doc.displayName ?? undefined,
    };
    return binding;
  }
}

export interface BindingResolverFactoryOptions {
  mongoRepo: MongoResolver;
}

/**
 * Factory: create the Mongo-backed UnifiedBindingResolver.
 */
export function createBindingResolver(opts: BindingResolverFactoryOptions): UnifiedBindingResolver {
  return new MongoUnifiedResolver(opts.mongoRepo);
}
