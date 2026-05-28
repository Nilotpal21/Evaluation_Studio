import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { applyServiceNowAuthAdapter } from '../adapters/activepieces/auth-adapters/servicenow.js';
import { applyJiraCloudAuthAdapter } from '../adapters/activepieces/auth-adapters/jira-cloud.js';

const localRequire = createRequire(import.meta.url);

// INT-7: Verify auth adapters and patched AP pieces expose the correct auth shapes
// for our normalizeAuthForAP contract.
describe('pnpm patch application', () => {
  it('zendesk auth props has accessToken (not token/email) after patch', () => {
    const mod = localRequire('@activepieces/piece-zendesk');
    const zendesk = mod.zendesk ?? mod.default?.zendesk ?? mod.default;
    expect(zendesk).toBeDefined();

    const rawAuth = zendesk.auth;
    // Auth can be called as a function (lazy getter) or be an object
    const auth = typeof rawAuth === 'function' ? rawAuth.call(zendesk) : rawAuth;
    expect(auth).toBeDefined();
    expect(auth.props).toBeDefined();

    // After patch: subdomain + accessToken, NOT email + token
    expect(auth.props).toHaveProperty('subdomain');
    expect(auth.props).toHaveProperty('accessToken');
    expect(auth.props).not.toHaveProperty('email');
    expect(auth.props).not.toHaveProperty('token');
  });

  it('servicenow auth adapter patches createServiceNowClient to use Bearer token', () => {
    // Load the AP piece to populate the require cache
    const mod = localRequire('@activepieces/piece-service-now');
    const serviceNow = mod.serviceNow ?? mod.default?.serviceNow ?? mod.default;
    expect(serviceNow).toBeDefined();

    // Apply the auth adapter (same as loader.ts does at boot)
    applyServiceNowAuthAdapter(localRequire);

    // Verify the adapter patched createServiceNowClient in the require cache
    const cacheKey = Object.keys(localRequire.cache).find(
      (k) => k.includes('piece-service-now') && k.includes('/common/') && k.endsWith('props.js'),
    );
    expect(cacheKey).toBeDefined();
    const propsExports = localRequire.cache[cacheKey!]?.exports as Record<string, unknown>;
    expect(typeof propsExports.createServiceNowClient).toBe('function');

    // Patched function should throw a ServiceNow-specific error when accessToken is missing
    expect(() =>
      (propsExports.createServiceNowClient as (auth: unknown) => unknown)({
        props: { instanceUrl: 'https://dev.service-now.com' },
      }),
    ).toThrow('accessToken is required');
  });

  it('jira-cloud auth adapter patches common/index.js to handle OAuth2 (access_token)', () => {
    // Load the AP piece to populate the require cache
    const mod = localRequire('@activepieces/piece-jira-cloud');
    const jiraCloud = mod.jiraCloud ?? mod.default?.jiraCloud ?? mod.default;
    expect(jiraCloud).toBeDefined();

    // Apply the auth adapter (same as loader.ts does at boot)
    applyJiraCloudAuthAdapter(localRequire);

    // Verify the adapter patched common/index.js in the require cache
    const cacheKey = Object.keys(localRequire.cache).find(
      (k) => k.includes('piece-jira-cloud') && k.includes('/common/') && k.endsWith('index.js'),
    );
    expect(cacheKey).toBeDefined();
    const commonExports = localRequire.cache[cacheKey!]?.exports as Record<string, unknown>;

    // Patched exports should have all three OAuth-aware entry points
    expect(typeof commonExports.jiraApiCall).toBe('function');
    expect(typeof commonExports.sendJiraRequest).toBe('function');
    expect(typeof commonExports.jiraPaginatedApiCall).toBe('function');

    // The patched jiraApiCall should be our named wrapper (not the original)
    const fnSource = (commonExports.jiraApiCall as () => unknown).toString();
    expect(fnSource).toContain('oauthJiraApiCall');
  });
});
