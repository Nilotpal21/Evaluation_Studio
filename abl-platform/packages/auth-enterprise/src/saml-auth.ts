/**
 * SAML Authentication (SAML 2.0)
 *
 * Uses lazy dynamic import of the optional `@node-saml/node-saml` package.
 * If not installed, returns a stub SAML assertion for development/testing.
 */

export interface SamlAuthConfig {
  idpMetadataUrl: string;
  entityId: string;
  assertionConsumerServiceUrl: string;
}

export interface SamlAuthSecrets {
  privateKey: string;
  certificate: string;
}

export interface SamlAuthResult {
  samlAssertion: string;
}

/**
 * Generates a stub assertion (base64 JSON) when the SAML package is unavailable.
 */
function generateStubAssertion(config: SamlAuthConfig): SamlAuthResult {
  const stub = Buffer.from(
    JSON.stringify({
      type: 'saml-stub',
      entityId: config.entityId,
      idpMetadataUrl: config.idpMetadataUrl,
      assertionConsumerServiceUrl: config.assertionConsumerServiceUrl,
    }),
  ).toString('base64');

  return { samlAssertion: stub };
}

/**
 * Attempts to load the optional @node-saml/node-saml module.
 * Returns null if not available.
 */
async function loadSamlModule(): Promise<Record<string, unknown> | null> {
  try {
    const moduleName =
      process.env.ABL_OPTIONAL_NODE_SAML_MODULE ?? ['@node-saml', 'node-saml'].join('/');
    return (await import(/* @vite-ignore */ moduleName)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Generates a SAML assertion for the configured identity provider.
 *
 * Uses `@node-saml/node-saml` when available. If not installed,
 * returns a base64-encoded stub assertion for development/testing.
 */
export async function applySamlAuth(
  config: SamlAuthConfig,
  secrets: SamlAuthSecrets,
): Promise<SamlAuthResult> {
  const nodeSaml = await loadSamlModule();

  if (!nodeSaml) {
    return generateStubAssertion(config);
  }

  const SAML =
    (nodeSaml.SAML as
      | (new (opts: Record<string, unknown>) => Record<string, Function>)
      | undefined) ??
    ((nodeSaml.default as Record<string, unknown> | undefined)?.SAML as
      | (new (opts: Record<string, unknown>) => Record<string, Function>)
      | undefined);

  if (typeof SAML !== 'function') {
    return generateStubAssertion(config);
  }

  try {
    const samlInstance = new SAML({
      callbackUrl: config.assertionConsumerServiceUrl,
      entryPoint: config.idpMetadataUrl,
      issuer: config.entityId,
      privateKey: secrets.privateKey,
      cert: secrets.certificate,
    });

    const authorizeRequest = await samlInstance.getAuthorizeFormAsync('', '');
    const assertion =
      typeof authorizeRequest === 'string' ? authorizeRequest : JSON.stringify(authorizeRequest);

    return { samlAssertion: assertion };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SAML authentication failed: ${message}`);
  }
}
