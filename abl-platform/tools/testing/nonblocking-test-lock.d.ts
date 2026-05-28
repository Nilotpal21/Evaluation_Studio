export interface NonBlockingTestLock {
  release(): Promise<void>;
}

export function acquireNonBlockingTestLock(
  name: string,
  metadata?: Record<string, unknown>,
): Promise<NonBlockingTestLock>;
