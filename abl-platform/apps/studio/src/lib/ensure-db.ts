/**
 * Ensure MongoDB is connected and encryption key is set before querying.
 *
 * Calls ensureConnected() and setMasterKey() from the SAME module context
 * as the Mongoose models, guaranteeing the connection and encryption key
 * are on the same instance that compiled the schemas.
 * This avoids Next.js webpack bundling creating a separate instance that
 * never gets connected or doesn't have the encryption key set.
 */

let _masterKeySet = false;
let _dekFacadeSet = false;

export async function ensureDb(): Promise<void> {
  const { ensureConnected, setMasterKey, setEncryptionFacade } =
    await import('@agent-platform/database/models');
  const masterKey =
    process.env.ENCRYPTION_ENABLED !== 'false' ? process.env.ENCRYPTION_MASTER_KEY : undefined;

  if (!masterKey) {
    throw new Error('ENCRYPTION_MASTER_KEY is required for Studio database access');
  }

  if (process.env.MONGODB_MANAGED === 'true') {
    const { dbReady, isDatabaseAvailable } = await import('@/db');
    await dbReady;

    if (!isDatabaseAvailable()) {
      throw new Error('Managed MongoDB connection is not available');
    }
  } else {
    await ensureConnected();
  }

  // Set the encryption master key on this module's copy of the encryption plugin.
  // Only needs to be done once per webpack-bundled instance.
  if (!_masterKeySet) {
    setMasterKey(masterKey);
    _masterKeySet = true;
  }

  if (!_dekFacadeSet) {
    try {
      const { initDEKFacade, setGlobalKMSResolver } = await import('@agent-platform/database/kms');
      const dek = await initDEKFacade({ masterKeyHex: masterKey });
      // Reattach the returned facade to the exact models module instance used by Studio.
      setEncryptionFacade(dek.facade);
      setGlobalKMSResolver(dek.resolver);
      _dekFacadeSet = true;
    } catch (err) {
      throw new Error(
        `[studio] DEK facade initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
