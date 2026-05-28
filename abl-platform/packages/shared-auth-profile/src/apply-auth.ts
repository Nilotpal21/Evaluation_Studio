/**
 * applyAuth Dispatcher
 *
 * Applies resolved auth credentials to an outgoing HTTP request
 * based on the auth type.
 */

import {
  applyHawkAuth,
  applyKerberosAuth,
  applySamlAuth,
  type HawkAuthConfig,
  type HawkAuthSecrets,
  type KerberosAuthConfig,
  type KerberosAuthSecrets,
  type SamlAuthConfig,
  type SamlAuthSecrets,
} from '@agent-platform/auth-enterprise';
import {
  resolveClientCredentialsToken,
  type ClientCredentialsDeps,
} from './client-credentials-service.js';
import { AuthProfileError } from './errors.js';

export interface AssembledRequest {
  method: string;
  url: string;
  headers: Headers;
  body?: string;
}

export interface ApplyAuthParams {
  authType: string;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  headers: Record<string, string>;
  queryParams?: URLSearchParams;
  /**
   * Optional runtime context for auth flows that need cache-scoped token
   * exchanges (for example azure_ad client-credentials).
   */
  context?: {
    tenantId?: string;
    profileId?: string;
    profileVersion?: number;
    redis?: ClientCredentialsDeps['redis'];
  };
  /** Phase 3: Addon data from the auth profile document */
  addons?: {
    certificatePinning?: {
      pins: Array<{ fingerprint: string; algorithm: string }>;
      rejectUnpinned: boolean;
    };
    jwtWrapping?: {
      algorithm: string;
      audience: string;
      issuer: string;
      expiresInSeconds: number;
      claims?: Record<string, unknown>;
    };
  };
}

export interface ApplyAuthResult {
  headers: Record<string, string>;
  queryParams?: URLSearchParams;
  tlsOptions?: { cert: string; key: string; ca?: string };
  awsCredentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
    service?: string;
    roleArn?: string;
    externalId?: string;
  };
  azureCredentials?: {
    tenantId: string;
    clientId: string;
    resource: string;
    endpoint: string;
  };
  sshCredentials?: { privateKey: string; passphrase?: string; keyType?: string };
  // Enterprise credential fields
  digestCredentials?: {
    username: string;
    password: string;
    realm: string;
  };
  kerberosCredentials?: {
    realm: string;
    kdc: string;
    servicePrincipal: string;
    principal: string;
    password?: string;
    keytab?: string;
  };
  kerberosTicket?: string;
  samlCredentials?: {
    idpMetadataUrl: string;
    entityId: string;
    privateKey: string;
    certificate: string;
  };
  hawkCredentials?: {
    id: string;
    key: string;
    algorithm: string;
  };
  wsSecurityCredentials?: {
    username: string;
    password: string;
    certificate?: string;
    mustUnderstand: boolean;
  };
  signRequest?: (assembled: AssembledRequest) => Promise<Headers>;
  /** Phase 3: Certificate pinning addon — downstream TLS enforcement */
  certificatePinning?: {
    pins: Array<{ fingerprint: string; algorithm: string }>;
    rejectUnpinned: boolean;
  };
  /** Phase 3: JWT wrapping addon — downstream token wrapping */
  jwtWrapping?: {
    algorithm: string;
    audience: string;
    issuer: string;
    expiresInSeconds: number;
    claims?: Record<string, unknown>;
  };
}

function isFlagEnabled(name: string, defaultEnabled = true): boolean {
  const value = process.env[name];
  if (!value) {
    return defaultEnabled;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized !== 'false' && normalized !== '0' && normalized !== 'off' && normalized !== 'no'
  );
}

function assertProtocolEnabled(authType: string, flagName: string, defaultEnabled = true): void {
  if (isFlagEnabled(flagName, defaultEnabled)) {
    return;
  }

  throw new AuthProfileError(
    'AUTH_PROTOCOL_DISABLED',
    `Auth protocol "${authType}" is disabled by ${flagName}`,
    503,
  );
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((scope): scope is string => typeof scope === 'string')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  return [];
}

async function resolveAzureAdToken(params: {
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  context: NonNullable<ApplyAuthParams['context']>;
}): Promise<string> {
  const scopedTenantId =
    typeof params.context.tenantId === 'string' && params.context.tenantId.trim().length > 0
      ? params.context.tenantId.trim()
      : null;
  const tenantId =
    typeof params.config.tenantId === 'string' && params.config.tenantId.trim().length > 0
      ? params.config.tenantId.trim()
      : null;
  const clientId =
    typeof params.secrets.clientId === 'string' && params.secrets.clientId.trim().length > 0
      ? params.secrets.clientId.trim()
      : null;
  const clientSecret =
    typeof params.secrets.clientSecret === 'string' && params.secrets.clientSecret.trim().length > 0
      ? params.secrets.clientSecret.trim()
      : null;

  if (!tenantId || !clientId || !clientSecret || !scopedTenantId) {
    throw new AuthProfileError(
      'AUTH_PROFILE_VALIDATION_FAILED',
      'Azure AD profile is missing tenant/client credentials',
      400,
    );
  }

  const endpoint =
    typeof params.config.endpoint === 'string' && params.config.endpoint.trim().length > 0
      ? params.config.endpoint.trim()
      : 'https://login.microsoftonline.com';

  const tokenUrl = `${endpoint.replace(/\/$/, '')}/${tenantId}/oauth2/v2.0/token`;
  const configuredScopes = normalizeScopes(params.config.scopes);
  const resourceScope =
    typeof params.config.resource === 'string' && params.config.resource.trim().length > 0
      ? [`${params.config.resource.trim()}/.default`]
      : [];
  const scopes = configuredScopes.length > 0 ? configuredScopes : resourceScope;

  const token = await resolveClientCredentialsToken(
    params.context.profileId ?? `azure_ad:${clientId}`,
    scopedTenantId,
    params.context.profileVersion ?? 1,
    tokenUrl,
    clientId,
    clientSecret,
    scopes,
    { redis: params.context.redis },
  );

  return token.accessToken;
}

/**
 * Applies auth credentials to request headers/query params based on auth type.
 *
 * For per-request signing protocols (`aws_iam`, `hawk`), the dispatcher returns
 * a `signRequest` closure that captures the resolved signing inputs.
 */
function withPrefix(prefix: string, value: string): string {
  if (!prefix) return value;
  return `${prefix}${prefix.endsWith(' ') ? '' : ' '}${value}`;
}

export async function applyAuth(params: ApplyAuthParams): Promise<ApplyAuthResult> {
  const { authType, config, secrets, headers, queryParams } = params;
  const resultHeaders = { ...headers };
  const resultQuery = queryParams ? new URLSearchParams(queryParams) : undefined;
  const result: ApplyAuthResult = { headers: resultHeaders, queryParams: resultQuery };

  switch (authType) {
    case 'none':
      break;

    case 'api_key': {
      const headerName = (config.headerName as string) || 'Authorization';
      const prefix = (config.prefix as string) || '';
      const placement = (config.placement as string) || 'header';
      const apiKey = secrets.apiKey as string;
      const prefixedValue = withPrefix(prefix, apiKey);

      if (placement === 'query') {
        if (resultQuery) {
          resultQuery.set(headerName, prefixedValue);
        }
      } else {
        resultHeaders[headerName] = prefixedValue;
      }
      break;
    }

    case 'bearer': {
      const token = secrets.token as string;
      const prefix = typeof config.prefix === 'string' ? config.prefix : 'Bearer';
      resultHeaders['Authorization'] = withPrefix(prefix, token);
      break;
    }

    case 'oauth2_token':
    case 'oauth2_client_credentials': {
      const accessToken = secrets.accessToken as string;
      resultHeaders['Authorization'] = `Bearer ${accessToken}`;
      break;
    }

    case 'oauth2_app': {
      // oauth2_app is Layer 1 — not directly applied to requests.
      // Tokens are resolved through oauth2_token or client_credentials.
      break;
    }

    case 'basic': {
      const username = secrets.username as string;
      const password = secrets.password as string;
      resultHeaders['Authorization'] =
        `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      break;
    }

    case 'custom_header': {
      const headerValues = secrets.headerValues as Record<string, string>;
      for (const [name, value] of Object.entries(headerValues)) {
        resultHeaders[name] = value;
      }
      break;
    }

    case 'aws_iam': {
      assertProtocolEnabled('aws_iam', 'AUTH_SIGV4_ENABLED');

      const region =
        typeof config.region === 'string' && config.region.length > 0 ? config.region : null;
      const service =
        typeof config.service === 'string' && config.service.length > 0
          ? config.service
          : 'execute-api';
      const accessKeyId =
        typeof secrets.accessKeyId === 'string' && secrets.accessKeyId.length > 0
          ? secrets.accessKeyId
          : null;
      const secretAccessKey =
        typeof secrets.secretAccessKey === 'string' && secrets.secretAccessKey.length > 0
          ? secrets.secretAccessKey
          : null;

      if (!region || !accessKeyId || !secretAccessKey) {
        throw new AuthProfileError(
          'AUTH_PROFILE_VALIDATION_FAILED',
          'AWS IAM profile is missing region or access key credentials',
          400,
        );
      }

      const awsCreds: ApplyAuthResult['awsCredentials'] = {
        accessKeyId,
        secretAccessKey,
        region,
        service,
      };
      if (typeof secrets.sessionToken === 'string' && secrets.sessionToken.length > 0) {
        awsCreds.sessionToken = secrets.sessionToken;
      }
      if (typeof config.roleArn === 'string' && config.roleArn.length > 0) {
        awsCreds.roleArn = config.roleArn;
      }
      if (typeof config.externalId === 'string' && config.externalId.length > 0) {
        awsCreds.externalId = config.externalId;
      }
      result.awsCredentials = awsCreds;

      const [{ SignatureV4 }, { HttpRequest }, { Hash }] = await Promise.all([
        import('@smithy/signature-v4'),
        import('@smithy/protocol-http'),
        import('@smithy/hash-node'),
      ]);

      const signer = new SignatureV4({
        service,
        region,
        credentials: {
          accessKeyId,
          secretAccessKey,
          ...(awsCreds.sessionToken ? { sessionToken: awsCreds.sessionToken } : {}),
        },
        sha256: Hash.bind(null, 'sha256'),
      });

      result.signRequest = async (assembled: AssembledRequest): Promise<Headers> => {
        const parsed = new URL(assembled.url);
        const requestHeaders: Record<string, string> = {};
        assembled.headers.forEach((value, key) => {
          requestHeaders[key] = value;
        });
        // @smithy/signature-v4 only signs headers explicitly in the map; unlike
        // `aws4`, it does NOT auto-inject host. Without this line, SignedHeaders
        // omits `host` and AWS rejects with: "'Host' or ':authority' must be a
        // 'SignedHeader' in the AWS Authorization." parsed.host carries the
        // port for non-default ports (e.g. example.com:8443) and bare host
        // otherwise — matching what undici/node sends on the wire.
        requestHeaders.host = parsed.host;

        const signed = await signer.sign(
          new HttpRequest({
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port ? Number(parsed.port) : undefined,
            method: assembled.method.toUpperCase(),
            path: `${parsed.pathname}${parsed.search}`,
            headers: requestHeaders,
            body: assembled.body,
          }),
        );

        const merged = new Headers(assembled.headers);
        for (const [key, value] of Object.entries(signed.headers)) {
          if (typeof value === 'string') {
            merged.set(key, value);
          }
        }
        return merged;
      };
      break;
    }

    case 'azure_ad': {
      assertProtocolEnabled('azure_ad', 'AUTH_AZURE_AD_ENABLED');

      const context = params.context;
      if (!context?.tenantId) {
        throw new AuthProfileError(
          'AUTH_PROFILE_CREDENTIAL_RESOLUTION_FAILED',
          'Azure AD token resolution requires tenant-scoped context',
          500,
        );
      }

      const accessToken =
        typeof secrets.accessToken === 'string' && secrets.accessToken.trim().length > 0
          ? secrets.accessToken
          : await resolveAzureAdToken({
              config,
              secrets,
              context,
            });

      resultHeaders['Authorization'] = `Bearer ${accessToken}`;

      const tenantId = typeof config.tenantId === 'string' ? config.tenantId : '';
      const clientId = typeof secrets.clientId === 'string' ? secrets.clientId : '';
      const resource = typeof config.resource === 'string' ? config.resource : '';
      const endpoint =
        typeof config.endpoint === 'string' && config.endpoint.length > 0
          ? config.endpoint
          : 'https://login.microsoftonline.com';
      result.azureCredentials = { tenantId, clientId, resource, endpoint };
      break;
    }

    case 'mtls': {
      const tlsOpts: { cert: string; key: string; ca?: string } = {
        cert: secrets.clientCert as string,
        key: secrets.clientKey as string,
      };
      if (secrets.caCert) {
        tlsOpts.ca = secrets.caCert as string;
      }
      result.tlsOptions = tlsOpts;
      break;
    }

    case 'ssh_key': {
      const sshCreds: NonNullable<ApplyAuthResult['sshCredentials']> = {
        privateKey: secrets.privateKey as string,
      };
      if (secrets.passphrase) {
        sshCreds.passphrase = secrets.passphrase as string;
      }
      if (config.keyType) {
        sshCreds.keyType = config.keyType as string;
      }
      result.sshCredentials = sshCreds;
      break;
    }

    case 'digest': {
      assertProtocolEnabled('digest', 'AUTH_DIGEST_ENABLED');
      result.digestCredentials = {
        username: secrets.username as string,
        password: secrets.password as string,
        realm: config.realm as string,
      };
      break;
    }

    case 'kerberos': {
      if (!isFlagEnabled('ENABLE_KERBEROS', false)) {
        throw new AuthProfileError(
          'AUTH_KERBEROS_NOT_BUILT',
          'Kerberos support is not enabled in this build',
          400,
        );
      }

      const kerberosConfig: KerberosAuthConfig = {
        realm: String(config.realm ?? ''),
        kdc: String(config.kdc ?? ''),
        servicePrincipal: String(config.servicePrincipal ?? ''),
      };
      const kerberosSecrets: KerberosAuthSecrets = {
        principal: String(secrets.principal ?? ''),
      };
      if (typeof secrets.password === 'string' && secrets.password.length > 0) {
        kerberosSecrets.password = secrets.password;
      }
      if (typeof secrets.keytab === 'string' && secrets.keytab.length > 0) {
        kerberosSecrets.keytab = secrets.keytab;
      }

      const kerberosResult = await applyKerberosAuth(kerberosConfig, kerberosSecrets);
      resultHeaders['Authorization'] = `Negotiate ${kerberosResult.kerberosTicket}`;
      result.kerberosTicket = kerberosResult.kerberosTicket;
      result.kerberosCredentials = {
        ...kerberosConfig,
        ...kerberosSecrets,
      };
      break;
    }

    case 'saml': {
      assertProtocolEnabled('saml', 'AUTH_SAML_ENABLED');

      const accessToken =
        typeof secrets.accessToken === 'string' && secrets.accessToken.trim().length > 0
          ? secrets.accessToken
          : (
              await applySamlAuth(
                {
                  idpMetadataUrl: String(config.idpMetadataUrl ?? ''),
                  entityId: String(config.entityId ?? ''),
                  assertionConsumerServiceUrl: String(config.assertionConsumerServiceUrl ?? ''),
                } satisfies SamlAuthConfig,
                {
                  privateKey: String(secrets.privateKey ?? ''),
                  certificate: String(secrets.certificate ?? ''),
                } satisfies SamlAuthSecrets,
              )
            ).samlAssertion;

      resultHeaders['Authorization'] = `Bearer ${accessToken}`;
      result.samlCredentials = {
        idpMetadataUrl: String(config.idpMetadataUrl ?? ''),
        entityId: String(config.entityId ?? ''),
        privateKey: String(secrets.privateKey ?? ''),
        certificate: String(secrets.certificate ?? ''),
      };
      break;
    }

    case 'hawk': {
      assertProtocolEnabled('hawk', 'AUTH_HAWK_ENABLED');

      const hawkConfig = {
        algorithm: (config.algorithm === 'sha1' ? 'sha1' : 'sha256') as 'sha256' | 'sha1',
      } satisfies HawkAuthConfig;
      const hawkSecrets = {
        id: String(secrets.id ?? ''),
        key: String(secrets.key ?? ''),
      } satisfies HawkAuthSecrets;

      result.hawkCredentials = {
        id: hawkSecrets.id,
        key: hawkSecrets.key,
        algorithm: hawkConfig.algorithm,
      };

      result.signRequest = async (assembled: AssembledRequest): Promise<Headers> => {
        const signed = applyHawkAuth(hawkConfig, hawkSecrets, assembled.url, assembled.method, {
          contentType: assembled.headers.get('content-type') ?? undefined,
          payload: assembled.body,
          ...(typeof config.ext === 'string' && config.ext.length > 0 ? { ext: config.ext } : {}),
        });

        const merged = new Headers(assembled.headers);
        if (signed.headers.Authorization) {
          merged.set('Authorization', signed.headers.Authorization);
        }
        return merged;
      };
      break;
    }

    case 'ws_security': {
      const wsCreds: NonNullable<ApplyAuthResult['wsSecurityCredentials']> = {
        username: secrets.username as string,
        password: secrets.password as string,
        mustUnderstand: (config.mustUnderstand as boolean) ?? false,
      };
      if (secrets.certificate) {
        wsCreds.certificate = secrets.certificate as string;
      }
      result.wsSecurityCredentials = wsCreds;
      break;
    }

    default:
      break;
  }

  if (params.addons?.certificatePinning) {
    result.certificatePinning = {
      pins: params.addons.certificatePinning.pins,
      rejectUnpinned: params.addons.certificatePinning.rejectUnpinned,
    };
  }

  if (params.addons?.jwtWrapping) {
    result.jwtWrapping = {
      algorithm: params.addons.jwtWrapping.algorithm,
      audience: params.addons.jwtWrapping.audience,
      issuer: params.addons.jwtWrapping.issuer,
      expiresInSeconds: params.addons.jwtWrapping.expiresInSeconds,
      claims: params.addons.jwtWrapping.claims,
    };
  }

  return result;
}
