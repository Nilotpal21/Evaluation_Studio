import { describe, expect, it } from 'vitest';
import { resolveDocHref } from '../../lib/docs/links';

describe('docs link resolution', () => {
  it('resolves relative links from a section index page within that section', () => {
    expect(resolveDocHref('./core-concepts', { section: 'getting-started', slug: 'index' })).toBe(
      '/docs/getting-started/core-concepts',
    );
  });

  it('resolves sibling links from a nested doc page', () => {
    expect(
      resolveDocHref('./quickstart', {
        section: 'getting-started',
        slug: 'platform-overview-user',
      }),
    ).toBe('/docs/getting-started/quickstart');
  });

  it('resolves parent-section links from a nested doc page', () => {
    expect(
      resolveDocHref('../tutorials/build-your-first-agent', {
        section: 'getting-started',
        slug: 'platform-overview-user',
      }),
    ).toBe('/docs/tutorials/build-your-first-agent');
  });

  it('preserves anchors and external links', () => {
    expect(resolveDocHref('#agents', { section: 'getting-started', slug: 'index' })).toBe(
      '#agents',
    );
    expect(
      resolveDocHref('https://agents-staging.kore.ai/docs/getting-started/core-concepts', {
        section: 'getting-started',
        slug: 'index',
      }),
    ).toBe('https://agents-staging.kore.ai/docs/getting-started/core-concepts');
  });
});
