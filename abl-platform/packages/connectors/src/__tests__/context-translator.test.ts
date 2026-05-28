import { describe, it, expect } from 'vitest';
import { normalizeAuthForAP } from '../adapters/activepieces/context-translator.js';

describe('normalizeAuthForAP', () => {
  // UT-1: default branch — apiKey → secret_text shim
  it('shims apiKey to secret_text for unknown connectors', () => {
    const result = normalizeAuthForAP('unknown-piece', { apiKey: 'sk-123' });
    expect(result).toEqual({ apiKey: 'sk-123', secret_text: 'sk-123' });
  });

  // UT-2: default branch — passthrough when no apiKey mapping needed
  it('passes auth through unchanged when no mapping needed', () => {
    const auth = { secret_text: 'already-set', apiKey: 'sk-456' };
    const result = normalizeAuthForAP('', auth);
    expect(result).toEqual(auth);
  });

  // UT-3: zendesk branch — OAuth2 access_token
  it('normalizes zendesk oauth2 auth with access_token', () => {
    const result = normalizeAuthForAP('zendesk', {
      access_token: 'bearer-tok',
      connection: { connectionConfig: { subdomain: 'myco' } },
    });
    expect(result).toEqual({ props: { subdomain: 'myco', accessToken: 'bearer-tok' } });
  });

  // UT-4: zendesk branch — api_key fallback
  it('normalizes zendesk api_key auth falling back to apiKey field', () => {
    const result = normalizeAuthForAP('zendesk', {
      apiKey: 'api-123',
      connection: { connectionConfig: { subdomain: 'acme' } },
    });
    expect(result).toEqual({ props: { subdomain: 'acme', accessToken: 'api-123' } });
  });

  // UT-5: zendesk branch — missing subdomain throws
  it('throws for zendesk when subdomain is missing', () => {
    expect(() =>
      normalizeAuthForAP('zendesk', {
        access_token: 'tok',
        connection: { connectionConfig: {} },
      }),
    ).toThrow(/subdomain/);
  });

  // UT-6: servicenow branch — builds instanceUrl from subdomain
  it('normalizes servicenow auth and constructs instanceUrl', () => {
    const result = normalizeAuthForAP('servicenow', {
      access_token: 'snow-tok',
      connection: { connectionConfig: { subdomain: 'myinstance' } },
    });
    expect(result).toEqual({
      props: {
        instanceUrl: 'https://myinstance.service-now.com',
        accessToken: 'snow-tok',
      },
    });
  });

  // UT-7: jira-cloud branch — passes auth through unchanged
  it('passes jira-cloud auth through unchanged', () => {
    const auth = { access_token: 'jira-tok', token_type: 'Bearer', scope: 'read:jira-work' };
    const result = normalizeAuthForAP('jira-cloud', auth);
    expect(result).toBe(auth);
  });
});
