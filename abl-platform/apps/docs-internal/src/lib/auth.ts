import { SignJWT, jwtVerify } from 'jose';
import { OAuth2Client } from 'google-auth-library';

interface TokenPayload {
  email: string;
  name: string;
  picture: string;
  domain: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.DOCS_JWT_SECRET;
  if (!secret) {
    throw new Error('DOCS_JWT_SECRET environment variable is required');
  }
  return new TextEncoder().encode(secret);
}

export async function signToken(payload: TokenPayload): Promise<string> {
  const secret = getSecret();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret);
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const secret = getSecret();
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as TokenPayload;
  } catch {
    return null;
  }
}

export function getGoogleOAuth2Client(): OAuth2Client {
  const baseUrl = process.env.DOCS_APP_URL || 'http://localhost:3007';
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${baseUrl}/api/auth/callback`,
  );
}
