/**
 * Signing Addon — HMAC/RSA signing for outgoing requests.
 */
import crypto from 'node:crypto';

export function applySigning(
  request: { headers: Record<string, string>; body?: string; url?: string; method?: string },
  signing: {
    algorithm: string;
    signedComponents: string[];
    timestampHeader?: string;
    signatureHeader?: string;
  },
  signingSecret: string,
): void {
  const timestamp = new Date().toISOString();
  const components: string[] = [];
  for (const component of signing.signedComponents) {
    switch (component) {
      case 'body':
        components.push(request.body ?? '');
        break;
      case 'timestamp':
        components.push(timestamp);
        break;
      case 'url':
        components.push(request.url ?? '');
        break;
      case 'headers':
        components.push(JSON.stringify(request.headers));
        break;
    }
  }
  const payload = components.join('\n');
  const algoMap: Record<string, string> = {
    'hmac-sha256': 'sha256',
    'hmac-sha512': 'sha512',
  };
  const hmacAlgo = algoMap[signing.algorithm];
  if (hmacAlgo) {
    const signature = crypto.createHmac(hmacAlgo, signingSecret).update(payload).digest('hex');
    request.headers[signing.signatureHeader ?? 'X-Signature'] = signature;
  } else if (signing.algorithm === 'rsa-sha256') {
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(payload);
    const signature = sign.sign(signingSecret, 'hex');
    request.headers[signing.signatureHeader ?? 'X-Signature'] = signature;
  } else if (signing.algorithm === 'aws-sig-v4') {
    // aws-sig-v4 signing is handled by applyAuth() for aws_iam auth type.
    // The invalid combination matrix blocks aws_iam + signing addon.
    throw new Error('aws-sig-v4 signing addon is not supported; use aws_iam auth type instead');
  }
  if (signing.timestampHeader) {
    request.headers[signing.timestampHeader] = timestamp;
  }
}
