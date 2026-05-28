/**
 * Reusable mock Redis factory for agent-transfer tests.
 */
import Redis from 'ioredis-mock';

export function createMockRedis(): InstanceType<typeof Redis> {
  return new Redis();
}
