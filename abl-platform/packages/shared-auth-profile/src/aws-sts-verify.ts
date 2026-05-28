/**
 * AWS IAM Live Verification via STS GetCallerIdentity
 *
 * Verifies an `aws_iam` auth profile by calling AWS Security Token Service's
 * GetCallerIdentity API with SigV4-signed credentials. This is the standard
 * AWS pattern for "are these credentials valid and what identity do they
 * resolve to?" — it works for IAM users, IAM roles, and federated principals
 * without requiring any specific service permissions (GetCallerIdentity is
 * always implicitly allowed).
 *
 * Used by:
 *   - the validate route (saved aws_iam profiles)
 *   - the verify-draft helper (in-flight aws_iam form payloads)
 *
 * Returns the assumed identity (account, ARN, userId) on success so the UI
 * can show "Verified as arn:aws:iam::123:user/foo" — confirming both that
 * the credentials are valid AND that they resolve to the expected identity
 * (catches typos / wrong-account configurations).
 *
 * Reuses `@smithy/signature-v4` which is already a direct dependency for the
 * runtime `aws_iam` apply-auth handler — no new package added.
 */

const STS_API_VERSION = '2011-06-15';
const REQUEST_TIMEOUT_MS = 10_000;

export interface AwsIamVerifyParams {
  /** AWS region (e.g. 'us-east-1'). STS endpoint is region-specific. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional session token for temporary credentials (STS / role assumption). */
  sessionToken?: string;
}

export interface AwsIamVerifyOk {
  ok: true;
  identity: {
    /** AWS account ID (12-digit string). */
    account: string;
    /** ARN of the assumed identity. */
    arn: string;
    /** Unique identifier of the assumed identity. */
    userId: string;
    region: string;
  };
}

export interface AwsIamVerifyErr {
  ok: false;
  /** Compact error message safe for inclusion in user-facing messages. */
  error: string;
  /** AWS error code if the response was a structured AWS error (e.g. 'InvalidClientTokenId'). */
  awsErrorCode?: string;
  /** HTTP status code from the STS endpoint (undefined on transport errors). */
  statusCode?: number;
}

export type AwsIamVerifyResult = AwsIamVerifyOk | AwsIamVerifyErr;

/**
 * Calls STS GetCallerIdentity. Always returns a result struct — never throws,
 * because the caller (validate route / verify-draft) wants to surface the
 * outcome to the user, not crash the route on auth failures.
 */
export async function verifyAwsIamCredentials(
  params: AwsIamVerifyParams,
): Promise<AwsIamVerifyResult> {
  const region = params.region.trim();
  if (region.length === 0) {
    return { ok: false, error: 'AWS region is required for IAM verification.' };
  }
  if (params.accessKeyId.trim().length === 0 || params.secretAccessKey.trim().length === 0) {
    return { ok: false, error: 'AWS access key ID and secret access key are required.' };
  }

  // Dynamic imports keep these large packages out of the cold-start path for
  // routes that never call this function. Same pattern the runtime handler
  // uses in apply-auth.ts.
  const [{ SignatureV4 }, { HttpRequest }, { Hash }] = await Promise.all([
    import('@smithy/signature-v4'),
    import('@smithy/protocol-http'),
    import('@smithy/hash-node'),
  ]);

  const stsHostname = `sts.${region}.amazonaws.com`;
  const formBody = `Action=GetCallerIdentity&Version=${encodeURIComponent(STS_API_VERSION)}`;

  const credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  } = {
    accessKeyId: params.accessKeyId,
    secretAccessKey: params.secretAccessKey,
  };
  if (typeof params.sessionToken === 'string' && params.sessionToken.trim().length > 0) {
    credentials.sessionToken = params.sessionToken;
  }

  const signer = new SignatureV4({
    region,
    service: 'sts',
    credentials,
    sha256: Hash.bind(null, 'sha256'),
  });

  const unsignedRequest = new HttpRequest({
    method: 'POST',
    protocol: 'https:',
    hostname: stsHostname,
    path: '/',
    headers: {
      host: stsHostname,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: formBody,
  });

  let signedRequest;
  try {
    signedRequest = await signer.sign(unsignedRequest);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to sign STS request: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const url = `https://${stsHostname}/`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: signedRequest.headers as Record<string, string>,
      body: formBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: `STS request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let rawBody = '';
  try {
    rawBody = await response.text();
  } catch {
    // Fall through with empty body — error path handles it.
  }

  if (!response.ok) {
    const parsed = parseStsErrorResponse(rawBody);
    return {
      ok: false,
      statusCode: response.status,
      error: parsed.message,
      ...(parsed.code ? { awsErrorCode: parsed.code } : {}),
    };
  }

  const identity = parseGetCallerIdentityResponse(rawBody);
  if (!identity) {
    return {
      ok: false,
      statusCode: response.status,
      error: 'STS returned an unparseable success response.',
    };
  }

  return {
    ok: true,
    identity: { ...identity, region },
  };
}

/**
 * AWS responds to GetCallerIdentity with either XML (default) or JSON
 * (when Accept: application/json is set). We request JSON above so the
 * happy-path parser is JSON; XML is only seen on some legacy regional
 * variants. We try JSON first, fall back to a small XML extractor.
 */
function parseGetCallerIdentityResponse(
  body: string,
): { account: string; arn: string; userId: string } | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;

  // Try JSON first — AWS SDK style { GetCallerIdentityResponse: { GetCallerIdentityResult: {...} } }
  try {
    const json = JSON.parse(trimmed) as {
      GetCallerIdentityResponse?: {
        GetCallerIdentityResult?: { Account?: string; Arn?: string; UserId?: string };
      };
    };
    const r = json.GetCallerIdentityResponse?.GetCallerIdentityResult;
    if (
      r &&
      typeof r.Account === 'string' &&
      typeof r.Arn === 'string' &&
      typeof r.UserId === 'string'
    ) {
      return { account: r.Account, arn: r.Arn, userId: r.UserId };
    }
  } catch {
    // Not JSON — fall through to XML
  }

  const account = matchTag(trimmed, 'Account');
  const arn = matchTag(trimmed, 'Arn');
  const userId = matchTag(trimmed, 'UserId');
  if (account && arn && userId) {
    return { account, arn, userId };
  }
  return null;
}

interface ParsedStsError {
  code?: string;
  message: string;
}

function parseStsErrorResponse(body: string): ParsedStsError {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { message: 'STS returned an empty error body.' };
  }

  // JSON form: { Error: { Code, Message, Type } } or { error: ..., message: ... }
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown> & {
      Error?: { Code?: string; Message?: string };
    };
    if (json.Error && typeof json.Error === 'object') {
      const code = typeof json.Error.Code === 'string' ? json.Error.Code : undefined;
      const message = typeof json.Error.Message === 'string' ? json.Error.Message : trimmed;
      return code ? { code, message: `${code}: ${message}` } : { message };
    }
  } catch {
    // Not JSON — fall through to XML
  }

  const code = matchTag(trimmed, 'Code');
  const message = matchTag(trimmed, 'Message');
  if (code && message) {
    return { code, message: `${code}: ${message}` };
  }
  return { message: trimmed.slice(0, 200) };
}

function matchTag(body: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]+)</${tag}>`);
  const m = body.match(re);
  return m ? m[1] : null;
}
