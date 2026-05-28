import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyAwsIamCredentials } from '../aws-sts-verify.js';

describe('verifyAwsIamCredentials', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects missing region', async () => {
    const result = await verifyAwsIamCredentials({
      region: '',
      accessKeyId: 'AKIA123',
      secretAccessKey: 'secret',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/region/i);
    }
  });

  it('rejects missing access key or secret', async () => {
    const noKey = await verifyAwsIamCredentials({
      region: 'us-east-1',
      accessKeyId: '',
      secretAccessKey: 'secret',
    });
    expect(noKey.ok).toBe(false);

    const noSecret = await verifyAwsIamCredentials({
      region: 'us-east-1',
      accessKeyId: 'AKIA123',
      secretAccessKey: '',
    });
    expect(noSecret.ok).toBe(false);
  });

  it('parses a successful JSON GetCallerIdentity response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          GetCallerIdentityResponse: {
            GetCallerIdentityResult: {
              Account: '123456789012',
              Arn: 'arn:aws:iam::123456789012:user/test-user',
              UserId: 'AIDAEXAMPLE',
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await verifyAwsIamCredentials({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'sekrit',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.account).toBe('123456789012');
      expect(result.identity.arn).toBe('arn:aws:iam::123456789012:user/test-user');
      expect(result.identity.userId).toBe('AIDAEXAMPLE');
      expect(result.identity.region).toBe('us-east-1');
    }
  });

  it('parses a successful XML GetCallerIdentity response (legacy regional variants)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:iam::111122223333:user/legacy</Arn>
    <UserId>AIDALEGACY</UserId>
    <Account>111122223333</Account>
  </GetCallerIdentityResult>
</GetCallerIdentityResponse>`;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(xml, { status: 200, headers: { 'content-type': 'text/xml' } }),
      ) as unknown as typeof globalThis.fetch;

    const result = await verifyAwsIamCredentials({
      region: 'us-west-2',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'sekrit',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.account).toBe('111122223333');
      expect(result.identity.arn).toBe('arn:aws:iam::111122223333:user/legacy');
    }
  });

  it('extracts AWS error code + message on InvalidClientTokenId failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          Error: {
            Code: 'InvalidClientTokenId',
            Message: 'The security token included in the request is invalid.',
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof globalThis.fetch;

    const result = await verifyAwsIamCredentials({
      region: 'us-east-1',
      accessKeyId: 'AKIAINVALID',
      secretAccessKey: 'wrong',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.awsErrorCode).toBe('InvalidClientTokenId');
      expect(result.error).toContain('InvalidClientTokenId');
      expect(result.error).toContain('The security token');
      expect(result.statusCode).toBe(403);
    }
  });

  it('handles XML error responses', async () => {
    const xml = `<?xml version="1.0"?>
<ErrorResponse>
  <Error>
    <Type>Sender</Type>
    <Code>SignatureDoesNotMatch</Code>
    <Message>Bad signature</Message>
  </Error>
</ErrorResponse>`;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(xml, { status: 403, headers: { 'content-type': 'text/xml' } }),
      ) as unknown as typeof globalThis.fetch;

    const result = await verifyAwsIamCredentials({
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'wrong',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.awsErrorCode).toBe('SignatureDoesNotMatch');
      expect(result.error).toContain('SignatureDoesNotMatch');
    }
  });

  it('handles transport errors (network failures) without throwing', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;

    const result = await verifyAwsIamCredentials({
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'sekrit',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/ECONNREFUSED/);
    }
  });
});
