import {
  InMemoryOAuthStateStore,
  RedisOAuthStateStore,
  type OAuthRedisClient,
  type OAuthStateStore,
} from './tool-oauth-service.js';

export type RuntimeOAuthStateStoreMode = 'redis' | 'memory-test' | 'disabled';

export interface RuntimeOAuthStateStoreSelection {
  mode: RuntimeOAuthStateStoreMode;
  stateStore: OAuthStateStore | null;
}

export interface ResolveRuntimeOAuthStateStoreOptions {
  redis: OAuthRedisClient | null | undefined;
  redisReady?: boolean;
  nodeEnv?: string;
}

/**
 * Runtime OAuth flows must use distributed state outside tests so callbacks can land on any pod.
 * Test runs may use an in-memory store when Redis is intentionally absent.
 */
export function createRuntimeOAuthStateStore({
  redis,
  redisReady = false,
  nodeEnv = process.env.NODE_ENV,
}: ResolveRuntimeOAuthStateStoreOptions): RuntimeOAuthStateStoreSelection {
  if (redis && redisReady) {
    return {
      mode: 'redis',
      stateStore: new RedisOAuthStateStore(redis),
    };
  }

  if (nodeEnv === 'test') {
    return {
      mode: 'memory-test',
      stateStore: new InMemoryOAuthStateStore(),
    };
  }

  return {
    mode: 'disabled',
    stateStore: null,
  };
}
