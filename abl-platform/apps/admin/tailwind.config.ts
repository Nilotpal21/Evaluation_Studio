import type { Config } from 'tailwindcss';
import baseConfig from '@agent-platform/tailwind-config';

const config: Config = {
  presets: [baseConfig],
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
    '../../packages/admin-ui/src/**/*.{js,ts,jsx,tsx}',
    '../../packages/design-tokens/src/**/*.{ts,tsx}',
  ],
};

export default config;
