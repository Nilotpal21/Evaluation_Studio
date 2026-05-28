import { describe, expect, it } from 'vitest';
import { isBrowserSdkRoute } from '../sdk-browser-routes.js';

describe('isBrowserSdkRoute', () => {
  it('matches sdk bootstrap and refresh endpoints', () => {
    expect(isBrowserSdkRoute('/api/v1/sdk/init')).toBe(true);
    expect(isBrowserSdkRoute('/api/v1/sdk/refresh')).toBe(true);
  });

  it('matches project session attachment routes used by the browser sdk', () => {
    expect(isBrowserSdkRoute('/api/projects/project-1/sessions/session-1/attachments')).toBe(true);
    expect(
      isBrowserSdkRoute('/api/projects/project-1/sessions/session-1/attachments/file-1/url'),
    ).toBe(true);
  });

  it('matches project session message history routes used by the browser sdk', () => {
    expect(isBrowserSdkRoute('/api/projects/project-1/sessions/session-1/messages')).toBe(true);
    expect(isBrowserSdkRoute('/api/projects/project-1/sessions/session-1/messages/')).toBe(true);
  });

  it('does not match unrelated management routes', () => {
    expect(isBrowserSdkRoute('/api/projects/project-1/sdk-channels')).toBe(false);
    expect(isBrowserSdkRoute('/api/platform/admin/tenants')).toBe(false);
  });
});
