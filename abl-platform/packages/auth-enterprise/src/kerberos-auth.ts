/**
 * Kerberos Authentication (SPNEGO / RFC 4559)
 *
 * Uses lazy dynamic import of the optional `kerberos` npm package.
 * If kerberos is not installed, falls back to a placeholder that
 * returns a base64-encoded ticket stub for testing/mocking.
 */

export interface KerberosAuthConfig {
  realm: string;
  kdc: string;
  servicePrincipal: string;
}

export interface KerberosAuthSecrets {
  principal: string;
  password?: string;
  keytab?: string;
}

export interface KerberosAuthResult {
  kerberosTicket: string;
}

/**
 * Generates a stub ticket (base64 JSON) when the kerberos package is unavailable.
 */
function generateStubTicket(
  config: KerberosAuthConfig,
  secrets: KerberosAuthSecrets,
): KerberosAuthResult {
  const stub = Buffer.from(
    JSON.stringify({
      type: 'kerberos-stub',
      principal: secrets.principal,
      servicePrincipal: config.servicePrincipal,
      realm: config.realm,
      kdc: config.kdc,
    }),
  ).toString('base64');

  return { kerberosTicket: stub };
}

/**
 * Attempts to load the optional kerberos module.
 * Returns null if not available.
 */
async function loadKerberosModule(): Promise<Record<string, unknown> | null> {
  try {
    const moduleName =
      process.env.ABL_OPTIONAL_KERBEROS_MODULE ??
      [String.fromCharCode(107, 101, 114), 'beros'].join('');
    // Dynamic import — kerberos is an optional native dependency
    return (await import(/* @vite-ignore */ moduleName)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Acquires a Kerberos ticket (SPNEGO token) for the given service principal.
 *
 * Uses the `kerberos` npm package when available. If not installed,
 * returns a base64-encoded stub ticket for development/testing.
 */
export async function applyKerberosAuth(
  config: KerberosAuthConfig,
  secrets: KerberosAuthSecrets,
): Promise<KerberosAuthResult> {
  const kerberos = await loadKerberosModule();

  if (!kerberos) {
    return generateStubTicket(config, secrets);
  }

  const initializeClient =
    (kerberos.initializeClient as Function | undefined) ??
    ((kerberos.default as Record<string, unknown> | undefined)?.initializeClient as
      | Function
      | undefined);

  if (typeof initializeClient !== 'function') {
    return generateStubTicket(config, secrets);
  }

  try {
    const client = await initializeClient(config.servicePrincipal, {
      mechOID: (kerberos.GSS_MECH_OID_SPNEGO as string | undefined) ?? undefined,
    });

    const response = await client.step('');
    const ticket = (response as string) ?? '';

    return { kerberosTicket: ticket };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Kerberos authentication failed: ${message}`);
  }
}
