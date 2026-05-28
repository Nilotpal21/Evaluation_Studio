/**
 * SSO Service Tests
 *
 * Tests for SAML 2.0, OIDC, and domain verification services.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import * as samlService from '../services/sso/saml-service';
import * as oidcService from '../services/sso/oidc-service';
import type { SAMLConfig, OIDCConfig } from '../services/sso/sso-types';
import { expectRejectedMessage } from './helpers/expect-rejected-message';

// Mock org-repo (domain-service imports from @/repos/org-repo)
const mockFindDomainMapping = vi.fn();
const mockUpsertDomainMapping = vi.fn();
const mockUpdateDomainMapping = vi.fn();
const mockDeleteDomainMapping = vi.fn();
const mockFindDomainMappings = vi.fn();
const mockFindSSOConfig = vi.fn();

vi.mock('@/repos/org-repo', () => ({
  findDomainMapping: mockFindDomainMapping,
  upsertDomainMapping: mockUpsertDomainMapping,
  updateDomainMapping: mockUpdateDomainMapping,
  deleteDomainMapping: mockDeleteDomainMapping,
  findDomainMappings: mockFindDomainMappings,
  findSSOConfig: mockFindSSOConfig,
  findOrganizationById: vi.fn(),
}));

// ---------------------------------------------------------------------------
// SAML Tests
// ---------------------------------------------------------------------------

describe('SAML Service', () => {
  const samlConfig: SAMLConfig = {
    entityId: 'https://idp.example.com/saml',
    ssoUrl: 'https://idp.example.com/sso',
    certificate: '-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----',
    signRequests: false,
    nameIdFormat: 'email',
  };

  test('generateSPMetadata produces valid XML with entityID and ACS URL', () => {
    const entityId = 'https://sp.example.com/saml/metadata';
    const acsUrl = 'https://sp.example.com/saml/acs';

    const metadata = samlService.generateSPMetadata(entityId, acsUrl);

    expect(metadata).toContain('<?xml version="1.0"?>');
    expect(metadata).toContain(`entityID="${entityId}"`);
    expect(metadata).toContain(`Location="${acsUrl}"`);
    expect(metadata).toContain('md:EntityDescriptor');
    expect(metadata).toContain('md:SPSSODescriptor');
    expect(metadata).toContain('md:AssertionConsumerService');
    expect(metadata).toContain('urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress');
  });

  test('generateAuthnRequestUrl contains correct IdP SSO URL and SAMLRequest param', () => {
    const spEntityId = 'https://sp.example.com/metadata';
    const acsUrl = 'https://sp.example.com/acs';

    const url = samlService.generateAuthnRequestUrl(samlConfig, spEntityId, acsUrl);

    expect(url).toContain(samlConfig.ssoUrl);
    expect(url).toContain('SAMLRequest=');

    const urlObj = new URL(url);
    const samlRequest = urlObj.searchParams.get('SAMLRequest');
    expect(samlRequest).toBeTruthy();

    // Decode and verify structure
    const decoded = Buffer.from(samlRequest!, 'base64').toString('utf-8');
    expect(decoded).toContain('samlp:AuthnRequest');
    expect(decoded).toContain(spEntityId);
    expect(decoded).toContain(acsUrl);
  });

  test('validateSAMLResponse extracts email from NameID', async () => {
    const email = 'user@example.com';
    const assertionId = `_${crypto.randomBytes(16).toString('hex')}`;

    const samlXml = `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${assertionId}">
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;

    const samlResponse = Buffer.from(samlXml).toString('base64');
    const spEntityId = 'https://sp.example.com/metadata';

    const user = await samlService.validateSAMLResponse(samlResponse, samlConfig, spEntityId);

    expect(user.email).toBe(email);
    expect(user.provider).toBe('saml');
    expect(user.externalId).toBe(email);
  });

  test('validateSAMLResponse detects assertion replay (same assertionId twice)', async () => {
    const email = 'user@example.com';
    const assertionId = `_${crypto.randomBytes(16).toString('hex')}`;

    const samlXml = `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${assertionId}">
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;

    const samlResponse = Buffer.from(samlXml).toString('base64');
    const spEntityId = 'https://sp.example.com/metadata';

    // First call should succeed
    await samlService.validateSAMLResponse(samlResponse, samlConfig, spEntityId);

    // Second call with same assertion ID should fail
    await expectRejectedMessage(
      samlService.validateSAMLResponse(samlResponse, samlConfig, spEntityId),
      'SAML assertion replay detected',
    );
  });

  test('validateSAMLResponse rejects response without NameID', async () => {
    const assertionId = `_${crypto.randomBytes(16).toString('hex')}`;

    const samlXml = `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${assertionId}">
  <saml:Assertion>
    <saml:Subject>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;

    const samlResponse = Buffer.from(samlXml).toString('base64');
    const spEntityId = 'https://sp.example.com/metadata';

    await expectRejectedMessage(
      samlService.validateSAMLResponse(samlResponse, samlConfig, spEntityId),
      'No NameID found in SAML response',
    );
  });

  test('isAssertionConsumed returns false for new ID, true after validation', async () => {
    const newId = `_${crypto.randomBytes(16).toString('hex')}`;
    expect(await samlService.isAssertionConsumed(newId)).toBe(false);

    const email = 'user@example.com';
    const samlXml = `<?xml version="1.0"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${newId}">
  <saml:Assertion>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>
    </saml:Subject>
  </saml:Assertion>
</samlp:Response>`;

    const samlResponse = Buffer.from(samlXml).toString('base64');
    const spEntityId = 'https://sp.example.com/metadata';

    await samlService.validateSAMLResponse(samlResponse, samlConfig, spEntityId);

    expect(await samlService.isAssertionConsumed(newId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OIDC Tests
// ---------------------------------------------------------------------------

describe('OIDC Service', () => {
  const oidcConfig: OIDCConfig = {
    issuer: 'https://idp.example.com',
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    authorizationUrl: 'https://idp.example.com/authorize',
    tokenUrl: 'https://idp.example.com/token',
    userInfoUrl: 'https://idp.example.com/userinfo',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email', 'profile'],
  };

  test('generatePKCE produces valid S256 challenge', () => {
    const { codeVerifier, codeChallenge } = oidcService.generatePKCE();

    expect(codeVerifier).toBeTruthy();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);

    // Verify S256 challenge: base64url(sha256(codeVerifier))
    const expectedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    expect(codeChallenge).toBe(expectedChallenge);
  });

  test('generateNonce produces 32-char hex string', () => {
    const nonce = oidcService.generateNonce();

    expect(nonce).toBeTruthy();
    expect(nonce.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(nonce)).toBe(true);
  });

  test('generateAuthorizationUrl includes all required params', () => {
    const redirectUri = 'https://sp.example.com/callback';
    const state = 'test-state';
    const nonce = 'test-nonce';
    const codeChallenge = 'test-challenge';

    const url = oidcService.generateAuthorizationUrl(
      oidcConfig,
      redirectUri,
      state,
      nonce,
      codeChallenge,
    );

    const urlObj = new URL(url);

    expect(urlObj.origin + urlObj.pathname).toBe(oidcConfig.authorizationUrl);
    expect(urlObj.searchParams.get('response_type')).toBe('code');
    expect(urlObj.searchParams.get('client_id')).toBe(oidcConfig.clientId);
    expect(urlObj.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(urlObj.searchParams.get('scope')).toBe('openid email profile');
    expect(urlObj.searchParams.get('state')).toBe(state);
    expect(urlObj.searchParams.get('nonce')).toBe(nonce);
    expect(urlObj.searchParams.get('code_challenge')).toBe(codeChallenge);
    expect(urlObj.searchParams.get('code_challenge_method')).toBe('S256');
  });

  test('validateIdToken extracts email and sub from JWT payload', () => {
    const payload = {
      iss: oidcConfig.issuer,
      aud: oidcConfig.clientId,
      sub: 'user-external-id-123',
      email: 'user@example.com',
      name: 'Test User',
      nonce: 'test-nonce',
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    };

    const idToken = createTestJWT(payload);

    const user = oidcService.validateIdToken(idToken, oidcConfig, 'test-nonce');

    expect(user.email).toBe('user@example.com');
    expect(user.name).toBe('Test User');
    expect(user.externalId).toBe('user-external-id-123');
    expect(user.provider).toBe('oidc');
  });

  test('validateIdToken rejects expired token', () => {
    const payload = {
      iss: oidcConfig.issuer,
      aud: oidcConfig.clientId,
      sub: 'user-123',
      email: 'user@example.com',
      nonce: 'test-nonce',
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    };

    const idToken = createTestJWT(payload);

    expect(() => {
      oidcService.validateIdToken(idToken, oidcConfig, 'test-nonce');
    }).toThrow('ID token expired');
  });

  test('validateIdToken rejects wrong issuer', () => {
    const payload = {
      iss: 'https://wrong-issuer.com',
      aud: oidcConfig.clientId,
      sub: 'user-123',
      email: 'user@example.com',
      nonce: 'test-nonce',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const idToken = createTestJWT(payload);

    expect(() => {
      oidcService.validateIdToken(idToken, oidcConfig, 'test-nonce');
    }).toThrow('Invalid issuer');
  });

  test('validateIdToken rejects wrong nonce', () => {
    const payload = {
      iss: oidcConfig.issuer,
      aud: oidcConfig.clientId,
      sub: 'user-123',
      email: 'user@example.com',
      nonce: 'wrong-nonce',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const idToken = createTestJWT(payload);

    expect(() => {
      oidcService.validateIdToken(idToken, oidcConfig, 'test-nonce');
    }).toThrow('Invalid nonce');
  });
});

// ---------------------------------------------------------------------------
// Domain Service Tests
// ---------------------------------------------------------------------------

describe('Domain Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('lookupDomainOrg returns null for unverified domain', async () => {
    mockFindDomainMapping.mockResolvedValue({
      id: 'mapping-1',
      domain: 'example.com',
      organizationId: 'org-123',
      verified: false,
      verificationToken: 'kore-verify=abc123',
      verifiedAt: null,
      createdAt: new Date(),
    });

    const { lookupDomainOrg } = await import('../services/sso/domain-service');

    const result = await lookupDomainOrg('example.com');

    expect(result).toBeNull();
    expect(mockFindDomainMapping).toHaveBeenCalledWith('example.com');
  });

  test('claimDomain generates verification token', async () => {
    mockFindDomainMapping.mockResolvedValue(null);
    mockUpsertDomainMapping.mockResolvedValue({
      id: 'mapping-1',
      domain: 'example.com',
      organizationId: 'org-123',
      verified: false,
      verificationToken: 'kore-verify=abc123',
      verifiedAt: null,
      createdAt: new Date(),
    });

    const { claimDomain } = await import('../services/sso/domain-service');

    const result = await claimDomain('org-123', 'example.com');

    expect(result.verificationToken).toBeTruthy();
    expect(result.verificationToken).toContain('kore-verify=');
    expect(mockUpsertDomainMapping).toHaveBeenCalledWith(
      'example.com',
      expect.objectContaining({
        organizationId: 'org-123',
        verified: false,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Create a test JWT (header.payload.signature).
 * Signature is fake since we only test basic validation.
 */
function createTestJWT(payload: any): string {
  const header = { alg: 'RS256', typ: 'JWT' };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const fakeSignature = Buffer.from('fake-signature').toString('base64url');

  return `${encodedHeader}.${encodedPayload}.${fakeSignature}`;
}
