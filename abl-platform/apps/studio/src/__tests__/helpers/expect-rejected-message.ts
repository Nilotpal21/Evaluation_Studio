import { expect } from 'vitest';

export async function expectRejectedMessage(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringContaining(expectedMessage),
  });
}
