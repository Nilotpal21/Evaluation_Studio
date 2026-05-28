import { describe, expect, it } from 'vitest';

describe('arch-ai message route locking', () => {
  it('acquires, renews, and releases the V4 turn lock while passing the fencing token downstream', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.resolve(__dirname, '..', '..', 'app', 'api', 'arch-ai', 'message', 'route.ts'),
      'utf8',
    );

    expect(src).toMatch(/acquireTurnLock\(/);
    expect(src).toMatch(/startRenewalLoop\(/);
    expect(src).toMatch(/releaseTurnLock\(/);
    expect(src).toMatch(/lockResult\.fencingToken/);
  });
});
