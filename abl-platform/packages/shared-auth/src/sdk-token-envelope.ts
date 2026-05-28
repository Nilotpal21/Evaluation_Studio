import {
  CompactEncrypt,
  compactDecrypt,
  decodeProtectedHeader,
  type JWEHeaderParameters,
} from 'jose';

export type SDKTokenEnvelopeMode = 'signed' | 'jwe';
export type SDKTokenEnvelopePurpose = 'sdk_bootstrap' | 'sdk_session';

export type SDKTokenEnvelopeErrorCode =
  | 'INVALID_TOKEN'
  | 'INVALID_HEADER'
  | 'INVALID_KEY'
  | 'INVALID_PURPOSE'
  | 'UNSUPPORTED_ENVELOPE'
  | 'TOKEN_TOO_LARGE'
  | 'DECRYPT_FAILED';

export class SDKTokenEnvelopeError extends Error {
  readonly code: SDKTokenEnvelopeErrorCode;

  constructor(code: SDKTokenEnvelopeErrorCode, message: string) {
    super(message);
    this.name = 'SDKTokenEnvelopeError';
    this.code = code;
  }
}

export interface SDKJweKeyHandle {
  readonly kid: string;
  readonly purpose: SDKTokenEnvelopePurpose;
  readonly alg: 'dir';
  toJSON(): { kid: string; purpose: SDKTokenEnvelopePurpose; alg: 'dir' };
}

export interface CreateLocalSdkJweKeyHandleInput {
  kid: string;
  purpose: SDKTokenEnvelopePurpose;
  keyBytes: Uint8Array;
}

export interface WrapCompactTokenInput {
  plaintext: string;
  key: SDKJweKeyHandle;
  purpose: SDKTokenEnvelopePurpose;
  maxPlaintextBytes?: number;
  maxCiphertextBytes?: number;
}

export interface UnwrapCompactTokenInput {
  token: string;
  purpose: SDKTokenEnvelopePurpose;
  resolveKey: (
    kid: string,
    purpose: SDKTokenEnvelopePurpose,
  ) => SDKJweKeyHandle | null | Promise<SDKJweKeyHandle | null>;
  maxPlaintextBytes?: number;
  maxCiphertextBytes?: number;
}

export interface SDKJweProtectedHeader {
  alg: 'dir';
  enc: 'A256GCM';
  kid: string;
  typ: 'abl-sdk-bootstrap+jwe' | 'abl-sdk-session+jwe';
  cty: 'abl-sdk-bootstrap+hmac' | 'abl-sdk-session+jwt';
  epv: 1;
}

const SDK_JWE_ENVELOPE_VERSION = 1;
const SDK_JWE_ALG = 'dir';
const SDK_JWE_ENC = 'A256GCM';
const SDK_JWE_KEY_BYTES = 32;
const textEncoder = new TextEncoder();
const keyMaterialByHandle = new WeakMap<SDKJweKeyHandle, Uint8Array>();

const HEADER_BY_PURPOSE: Record<
  SDKTokenEnvelopePurpose,
  Pick<SDKJweProtectedHeader, 'typ' | 'cty'>
> = {
  sdk_bootstrap: {
    typ: 'abl-sdk-bootstrap+jwe',
    cty: 'abl-sdk-bootstrap+hmac',
  },
  sdk_session: {
    typ: 'abl-sdk-session+jwe',
    cty: 'abl-sdk-session+jwt',
  },
};

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function assertSize(
  value: string,
  maxBytes: number | undefined,
  code: SDKTokenEnvelopeErrorCode,
): void {
  if (maxBytes !== undefined && byteLength(value) > maxBytes) {
    throw new SDKTokenEnvelopeError(code, 'SDK token envelope exceeds configured size limit');
  }
}

function getKeyMaterial(handle: SDKJweKeyHandle): Uint8Array {
  const keyBytes = keyMaterialByHandle.get(handle);
  if (!keyBytes) {
    throw new SDKTokenEnvelopeError('INVALID_KEY', 'SDK JWE key handle is not usable');
  }
  return keyBytes;
}

function assertKeyPurpose(handle: SDKJweKeyHandle, purpose: SDKTokenEnvelopePurpose): void {
  if (handle.purpose !== purpose) {
    throw new SDKTokenEnvelopeError('INVALID_PURPOSE', 'SDK JWE key purpose mismatch');
  }
}

function requireNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new SDKTokenEnvelopeError('INVALID_TOKEN', `${label} must not be empty`);
  }
}

function assertCanonicalBase64UrlSegment(segment: string, label: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new SDKTokenEnvelopeError('INVALID_TOKEN', `${label} is not base64url encoded`);
  }

  const canonical = Buffer.from(segment, 'base64url').toString('base64url');
  if (canonical !== segment) {
    throw new SDKTokenEnvelopeError('INVALID_TOKEN', `${label} is not canonical base64url`);
  }
}

function assertCompactJweTokenShape(token: string): void {
  const segments = token.split('.');
  if (segments.length !== 5) {
    throw new SDKTokenEnvelopeError('INVALID_HEADER', 'SDK JWE must use compact serialization');
  }

  assertCanonicalBase64UrlSegment(segments[0]!, 'protected header');
  if (segments[1] !== '') {
    throw new SDKTokenEnvelopeError('UNSUPPORTED_ENVELOPE', 'SDK JWE encrypted key is unsupported');
  }
  assertCanonicalBase64UrlSegment(segments[2]!, 'initialization vector');
  assertCanonicalBase64UrlSegment(segments[3]!, 'ciphertext');
  assertCanonicalBase64UrlSegment(segments[4]!, 'authentication tag');
}

function validateHeaderForPurpose(
  header: JWEHeaderParameters,
  purpose: SDKTokenEnvelopePurpose,
): SDKJweProtectedHeader {
  const expected = HEADER_BY_PURPOSE[purpose];

  if (header.alg !== SDK_JWE_ALG || header.enc !== SDK_JWE_ENC) {
    throw new SDKTokenEnvelopeError('UNSUPPORTED_ENVELOPE', 'Unsupported SDK JWE algorithm');
  }

  if (header.zip !== undefined) {
    throw new SDKTokenEnvelopeError('UNSUPPORTED_ENVELOPE', 'SDK JWE compression is not supported');
  }

  if (header.typ !== expected.typ || header.cty !== expected.cty) {
    throw new SDKTokenEnvelopeError('INVALID_HEADER', 'SDK JWE header purpose mismatch');
  }

  if (header.epv !== SDK_JWE_ENVELOPE_VERSION) {
    throw new SDKTokenEnvelopeError('UNSUPPORTED_ENVELOPE', 'Unsupported SDK JWE envelope version');
  }

  if (typeof header.kid !== 'string' || header.kid.trim().length === 0) {
    throw new SDKTokenEnvelopeError('INVALID_HEADER', 'SDK JWE header is missing kid');
  }

  return {
    alg: SDK_JWE_ALG,
    enc: SDK_JWE_ENC,
    kid: header.kid,
    typ: expected.typ,
    cty: expected.cty,
    epv: SDK_JWE_ENVELOPE_VERSION,
  };
}

export function createLocalSdkJweKeyHandle(
  input: CreateLocalSdkJweKeyHandleInput,
): SDKJweKeyHandle {
  if (input.kid.trim().length === 0) {
    throw new SDKTokenEnvelopeError('INVALID_KEY', 'SDK JWE kid must not be empty');
  }

  if (input.keyBytes.byteLength !== SDK_JWE_KEY_BYTES) {
    throw new SDKTokenEnvelopeError('INVALID_KEY', 'SDK JWE A256GCM keys must be 32 bytes');
  }

  const handle: SDKJweKeyHandle = Object.freeze({
    kid: input.kid,
    purpose: input.purpose,
    alg: SDK_JWE_ALG,
    toJSON() {
      return {
        kid: input.kid,
        purpose: input.purpose,
        alg: SDK_JWE_ALG as 'dir',
      };
    },
  });

  keyMaterialByHandle.set(handle, new Uint8Array(input.keyBytes));
  return handle;
}

export function readCompactJweProtectedHeader(token: string): SDKJweProtectedHeader | null {
  if (token.split('.').length !== 5) {
    return null;
  }

  try {
    const header = decodeProtectedHeader(token);
    if (header.typ === HEADER_BY_PURPOSE.sdk_bootstrap.typ) {
      return validateHeaderForPurpose(header, 'sdk_bootstrap');
    }
    if (header.typ === HEADER_BY_PURPOSE.sdk_session.typ) {
      return validateHeaderForPurpose(header, 'sdk_session');
    }
    return null;
  } catch {
    return null;
  }
}

export function isCompactJwe(token: string): boolean {
  return readCompactJweProtectedHeader(token) !== null;
}

export async function wrapCompactToken(input: WrapCompactTokenInput): Promise<string> {
  requireNonEmptyString(input.plaintext, 'plaintext');
  assertKeyPurpose(input.key, input.purpose);
  assertSize(input.plaintext, input.maxPlaintextBytes, 'TOKEN_TOO_LARGE');

  const purposeHeader = HEADER_BY_PURPOSE[input.purpose];
  const encrypted = await new CompactEncrypt(textEncoder.encode(input.plaintext))
    .setProtectedHeader({
      alg: SDK_JWE_ALG,
      enc: SDK_JWE_ENC,
      kid: input.key.kid,
      typ: purposeHeader.typ,
      cty: purposeHeader.cty,
      epv: SDK_JWE_ENVELOPE_VERSION,
    })
    .encrypt(getKeyMaterial(input.key));

  assertSize(encrypted, input.maxCiphertextBytes, 'TOKEN_TOO_LARGE');
  return encrypted;
}

export async function unwrapCompactToken(input: UnwrapCompactTokenInput): Promise<string> {
  requireNonEmptyString(input.token, 'token');
  assertSize(input.token, input.maxCiphertextBytes, 'TOKEN_TOO_LARGE');
  assertCompactJweTokenShape(input.token);

  let header: SDKJweProtectedHeader;
  try {
    const rawHeader = decodeProtectedHeader(input.token);
    header = validateHeaderForPurpose(rawHeader, input.purpose);
  } catch (error) {
    if (error instanceof SDKTokenEnvelopeError) {
      throw error;
    }
    throw new SDKTokenEnvelopeError('INVALID_HEADER', 'Invalid SDK JWE protected header');
  }

  let key: SDKJweKeyHandle | null;
  try {
    key = await input.resolveKey(header.kid, input.purpose);
  } catch {
    throw new SDKTokenEnvelopeError('DECRYPT_FAILED', 'SDK JWE decrypt failed');
  }
  if (!key) {
    throw new SDKTokenEnvelopeError('DECRYPT_FAILED', 'SDK JWE decrypt failed');
  }
  assertKeyPurpose(key, input.purpose);

  try {
    const decrypted = await compactDecrypt(input.token, getKeyMaterial(key));
    const plaintext = new TextDecoder().decode(decrypted.plaintext);
    assertSize(plaintext, input.maxPlaintextBytes, 'TOKEN_TOO_LARGE');
    requireNonEmptyString(plaintext, 'plaintext');
    return plaintext;
  } catch (error) {
    if (error instanceof SDKTokenEnvelopeError) {
      throw error;
    }
    throw new SDKTokenEnvelopeError('DECRYPT_FAILED', 'SDK JWE decrypt failed');
  }
}
