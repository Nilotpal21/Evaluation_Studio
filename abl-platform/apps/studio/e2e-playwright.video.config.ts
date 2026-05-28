import { defineConfig } from '@playwright/test';
import baseConfig from './e2e-playwright.config';

export default defineConfig({
  ...baseConfig,
  use: {
    ...(baseConfig.use ?? {}),
    video: 'on',
    screenshot: 'on',
  },
});
