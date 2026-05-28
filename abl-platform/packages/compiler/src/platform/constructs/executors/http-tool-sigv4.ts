import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface Aws4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface Aws4RequestToSign {
  host: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  service: string;
  region: string;
}

interface Aws4Module {
  sign(
    request: Aws4RequestToSign,
    credentials: Aws4Credentials,
  ): Aws4RequestToSign & { headers: Record<string, string> };
}

const aws4 = require('aws4') as Aws4Module;

export interface HttpToolSigV4Auth {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

export function signHttpToolRequest(params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  auth: HttpToolSigV4Auth;
}): Record<string, string> {
  const requestUrl = new URL(params.url);
  const signedRequest = aws4.sign(
    {
      host: requestUrl.host,
      path: `${requestUrl.pathname}${requestUrl.search}`,
      method: params.method,
      headers: { ...params.headers },
      ...(params.body !== undefined ? { body: params.body } : {}),
      service: params.auth.service,
      region: params.auth.region,
    },
    {
      accessKeyId: params.auth.accessKeyId,
      secretAccessKey: params.auth.secretAccessKey,
      ...(params.auth.sessionToken ? { sessionToken: params.auth.sessionToken } : {}),
    },
  );

  const signedHeaders = { ...signedRequest.headers };
  delete signedHeaders.host;
  delete signedHeaders.Host;
  return signedHeaders;
}
