import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SDK_CHANNEL_SERVER_SECRET_PREFIX = 'sk_';
const SDK_CHANNEL_SERVER_SECRET_BYTES = 24;
const SDK_CHANNEL_SERVER_SECRET_SALT_BYTES = 16;
const SDK_CHANNEL_SERVER_SECRET_HASH_BYTES = 32;
const SDK_CHANNEL_SERVER_SECRET_PREFIX_CHARS = 15;
const SDK_CHANNEL_SERVER_SECRET_SCRYPT_COST = 1 << 15;
const SDK_CHANNEL_SERVER_SECRET_SCRYPT_BLOCK_SIZE = 8;
const SDK_CHANNEL_SERVER_SECRET_SCRYPT_PARALLELIZATION = 1;
const SDK_CHANNEL_SERVER_SECRET_SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface GeneratedSdkChannelServerSecret {
  plaintext: string;
  hash: string;
  salt: string;
  prefix: string;
  rotatedAt: Date;
}

function normalizeSecret(value: string): string {
  return value.trim();
}

export function getSdkChannelServerSecretPrefix(secret: string): string {
  return normalizeSecret(secret).slice(0, SDK_CHANNEL_SERVER_SECRET_PREFIX_CHARS);
}

async function hashSdkChannelServerSecret(secret: string, salt: string): Promise<string> {
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      secret,
      salt,
      SDK_CHANNEL_SERVER_SECRET_HASH_BYTES,
      {
        cost: SDK_CHANNEL_SERVER_SECRET_SCRYPT_COST,
        blockSize: SDK_CHANNEL_SERVER_SECRET_SCRYPT_BLOCK_SIZE,
        parallelization: SDK_CHANNEL_SERVER_SECRET_SCRYPT_PARALLELIZATION,
        maxmem: SDK_CHANNEL_SERVER_SECRET_SCRYPT_MAXMEM,
      },
      (error, output) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(output as Buffer);
      },
    );
  });
  return derived.toString('base64url');
}

export async function generateSdkChannelServerSecret(): Promise<GeneratedSdkChannelServerSecret> {
  const plaintext = `${SDK_CHANNEL_SERVER_SECRET_PREFIX}${randomBytes(
    SDK_CHANNEL_SERVER_SECRET_BYTES,
  ).toString('hex')}`;
  const salt = randomBytes(SDK_CHANNEL_SERVER_SECRET_SALT_BYTES).toString('base64url');
  const hash = await hashSdkChannelServerSecret(plaintext, salt);
  const rotatedAt = new Date();

  return {
    plaintext,
    hash,
    salt,
    prefix: getSdkChannelServerSecretPrefix(plaintext),
    rotatedAt,
  };
}

export async function verifySdkChannelServerSecret(params: {
  providedSecret: string;
  storedHash: string | null | undefined;
  storedSalt: string | null | undefined;
  storedPrefix?: string | null | undefined;
}): Promise<boolean> {
  const { providedSecret, storedHash, storedSalt, storedPrefix } = params;
  if (!storedHash || !storedSalt) {
    return false;
  }

  const normalizedSecret = normalizeSecret(providedSecret);
  if (!normalizedSecret.startsWith(SDK_CHANNEL_SERVER_SECRET_PREFIX)) {
    return false;
  }
  if (storedPrefix && getSdkChannelServerSecretPrefix(normalizedSecret) !== storedPrefix) {
    return false;
  }

  const computedHash = await hashSdkChannelServerSecret(normalizedSecret, storedSalt);
  const providedBuffer = Buffer.from(computedHash);
  const expectedBuffer = Buffer.from(storedHash);

  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
