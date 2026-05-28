import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  const locale = 'en'; // Phase 1: single locale, no routing yet

  // Load messages from the shared i18n package's locale files.
  // @i18n-locales is a Turbopack resolveAlias configured in next.config.mjs
  // pointing to packages/i18n/locales/.
  const studioMessages = (await import('@i18n-locales/en/studio.json')).default;
  const platformMessages = (await import('@i18n-locales/en/platform.json')).default;
  const marketplaceMessages = (await import('@i18n-locales/en/marketplace.json')).default;
  const academyMessages = (await import('@i18n-locales/en/academy.json')).default;

  return {
    locale,
    messages: {
      ...studioMessages,
      platform: platformMessages,
      marketplace: marketplaceMessages,
      academy: academyMessages,
    },
  };
});
