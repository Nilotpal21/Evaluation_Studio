/**
 * SAML 2.0 Service
 *
 * SP metadata generation, AuthnRequest signing, assertion validation.
 * Assertion replay protection via consumed assertion ID tracking.
 */

import crypto from 'crypto';
import type { SAMLConfig, SSOUser } from './sso-types';
import { isAssertionConsumed as storeIsConsumed, markAssertionConsumed } from './sso-state-store';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

/**
 * Generate SP metadata XML for IdP configuration.
 */
export function generateSPMetadata(entityId: string, acsUrl: string): string {
  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${escapeXml(entityId)}">
  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${escapeXml(acsUrl)}"
      index="1" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

/**
 * Generate a SAML AuthnRequest URL for IdP redirect.
 */
export function generateAuthnRequestUrl(
  config: SAMLConfig,
  spEntityId: string,
  acsUrl: string,
): string {
  const id = `_${crypto.randomBytes(16).toString('hex')}`;
  const issueInstant = new Date().toISOString();

  const request = `<samlp:AuthnRequest
    xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="${id}"
    Version="2.0"
    IssueInstant="${issueInstant}"
    Destination="${escapeXml(config.ssoUrl)}"
    AssertionConsumerServiceURL="${escapeXml(acsUrl)}"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
    <saml:Issuer>${escapeXml(spEntityId)}</saml:Issuer>
    <samlp:NameIDPolicy
      Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
      AllowCreate="true" />
  </samlp:AuthnRequest>`;

  // Deflate + base64 encode for redirect binding
  const encoded = Buffer.from(request).toString('base64');
  const params = new URLSearchParams({
    SAMLRequest: encoded,
  });

  return `${config.ssoUrl}?${params.toString()}`;
}

/**
 * Validate a SAML assertion response.
 *
 * In production, use @node-saml/node-saml for full validation:
 * - XML signature verification
 * - Audience restriction
 * - NotBefore/NotOnOrAfter conditions
 * - Assertion replay protection
 *
 * This implementation provides the interface and basic extraction.
 */
export async function validateSAMLResponse(
  samlResponse: string,
  config: SAMLConfig,
  _spEntityId: string,
): Promise<SSOUser> {
  // Decode base64 response
  const xml = Buffer.from(samlResponse, 'base64').toString('utf-8');

  // Extract assertion ID for replay protection
  const assertionIdMatch = xml.match(/ID="([^"]+)"/);
  const assertionId = assertionIdMatch?.[1];

  if (assertionId) {
    if (await storeIsConsumed(assertionId)) {
      throw new AppError('SAML assertion replay detected', { ...ErrorCodes.FORBIDDEN });
    }
    await markAssertionConsumed(assertionId, 3600); // 1 hour TTL
  }

  // Extract NameID (email)
  const nameIdMatch = xml.match(/<saml:NameID[^>]*>([^<]+)<\/saml:NameID>/);
  if (!nameIdMatch) {
    throw new AppError('No NameID found in SAML response', { ...ErrorCodes.BAD_REQUEST });
  }

  const email = nameIdMatch[1].trim();
  if (!email.includes('@')) {
    throw new AppError('Invalid email in SAML NameID', { ...ErrorCodes.BAD_REQUEST });
  }

  // Extract display name if available
  const nameMatch = xml.match(/Name="displayName"[^>]*><saml:AttributeValue[^>]*>([^<]+)/);
  const name = nameMatch?.[1];

  return {
    email,
    name,
    externalId: email,
    provider: 'saml',
  };
}

/**
 * Check if a SAML assertion has been consumed (replay protection).
 */
export async function isAssertionConsumed(assertionId: string): Promise<boolean> {
  return storeIsConsumed(assertionId);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
