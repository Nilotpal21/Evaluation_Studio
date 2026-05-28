export const studioCoverageConfig = {
  provider: 'v8' as const,
  reporter: ['text', 'json-summary', 'html'],
  reportsDirectory: './coverage',
  include: ['src/**/*.{ts,tsx}'],
  exclude: ['src/__tests__/**'],
};
