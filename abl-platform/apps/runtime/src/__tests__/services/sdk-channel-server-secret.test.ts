import { describe, expect, it } from 'vitest';
import {
  generateSdkChannelServerSecret,
  getSdkChannelServerSecretPrefix,
  verifySdkChannelServerSecret,
} from '../../services/identity/sdk-channel-server-secret.js';

describe('sdk-channel-server-secret', () => {
  it('generates a verifiable secret with a persisted prefix', async () => {
    const generated = await generateSdkChannelServerSecret();

    expect(generated.plaintext).toMatch(/^sk_[0-9a-f]+$/);
    expect(generated.prefix).toBe(getSdkChannelServerSecretPrefix(generated.plaintext));

    await expect(
      verifySdkChannelServerSecret({
        providedSecret: generated.plaintext,
        storedHash: generated.hash,
        storedSalt: generated.salt,
        storedPrefix: generated.prefix,
      }),
    ).resolves.toBe(true);
  });

  it('rejects a provided secret when the stored prefix does not match', async () => {
    const generated = await generateSdkChannelServerSecret();

    await expect(
      verifySdkChannelServerSecret({
        providedSecret: generated.plaintext,
        storedHash: generated.hash,
        storedSalt: generated.salt,
        storedPrefix: 'sk_deadbeefcafe',
      }),
    ).resolves.toBe(false);
  });

  it('rejects secrets when the persisted hash state is incomplete', async () => {
    const generated = await generateSdkChannelServerSecret();

    await expect(
      verifySdkChannelServerSecret({
        providedSecret: generated.plaintext,
        storedHash: null,
        storedSalt: generated.salt,
      }),
    ).resolves.toBe(false);

    await expect(
      verifySdkChannelServerSecret({
        providedSecret: generated.plaintext,
        storedHash: generated.hash,
        storedSalt: null,
      }),
    ).resolves.toBe(false);
  });
});
