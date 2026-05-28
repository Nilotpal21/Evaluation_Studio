/**
 * WS-Security Authentication (SOAP / WS-Security 1.1)
 *
 * Generates a WS-Security SOAP header XML with UsernameToken
 * and optional BinarySecurityToken for X.509 certificates.
 * No external dependencies — uses Node.js built-in `crypto`.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface WsSecurityConfig {
  mustUnderstand: boolean;
}

export interface WsSecuritySecrets {
  username: string;
  password: string;
  certificate?: string;
}

export interface WsSecurityResult {
  wsSecurityHeader: string;
}

/**
 * Minimal XML attribute / element-text escape for fields that are interpolated
 * directly into the WS-Security header. Username is tenant-admin-controlled at
 * configuration time; without escaping, characters like `<` or `&` would break
 * the envelope or allow injection of additional WSSE elements.
 */
function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a WS-Security SOAP header with UsernameToken.
 *
 * The header includes:
 * - A `wsse:UsernameToken` with Username, Password (PasswordDigest),
 *   Nonce, and Created timestamp.
 * - Optionally a `wsse:BinarySecurityToken` if a certificate is provided.
 *
 * @returns An object with the serialized WS-Security XML header.
 */
export function applyWsSecurity(
  config: WsSecurityConfig,
  secrets: WsSecuritySecrets,
): WsSecurityResult {
  const created = new Date().toISOString();
  const nonce = randomBytes(16);
  const nonceBase64 = nonce.toString('base64');

  // PasswordDigest = Base64(SHA-1(Nonce + Created + Password))
  const digest = createHash('sha1')
    .update(nonce)
    .update(created)
    .update(secrets.password)
    .digest('base64');

  const mustUnderstandAttr = config.mustUnderstand ? '1' : '0';

  let binarySecurityToken = '';
  if (secrets.certificate) {
    // Strip PEM headers/footers and any non-base64 characters to defend against
    // injected XML markers in the certificate body.
    const certBase64 = secrets.certificate
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/[^A-Za-z0-9+/=]/g, '');

    binarySecurityToken = `
    <wsse:BinarySecurityToken
      EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"
      ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3">
      ${certBase64}
    </wsse:BinarySecurityToken>`;
  }

  const usernameEscaped = escapeXmlText(secrets.username);

  const wsSecurityHeader = `<wsse:Security
  xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
  xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
  soap:mustUnderstand="${mustUnderstandAttr}">
  <wsu:Timestamp>
    <wsu:Created>${created}</wsu:Created>
  </wsu:Timestamp>
  <wsse:UsernameToken>
    <wsse:Username>${usernameEscaped}</wsse:Username>
    <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password>
    <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBase64}</wsse:Nonce>
    <wsu:Created>${created}</wsu:Created>
  </wsse:UsernameToken>${binarySecurityToken}
</wsse:Security>`;

  return { wsSecurityHeader };
}
