import nextPlugin from '@next/eslint-plugin-next';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import noUnscopedMongooseQuery from './eslint-rules/no-unscoped-mongoose-query.js';

export default [
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
    ignores: [
      '.next/**',
      'coverage/**',
      'dist/**',
      'e2e/**',
      'node_modules/**',
      'public/**',
      'test-results/**',
      'src/__tests__/**',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}', 'eslint-rules/**/*.{ts,tsx}'],
    ignores: ['src/__tests__/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@next/next': nextPlugin,
      '@typescript-eslint': tsPlugin,
      'jsx-a11y': jsxA11yPlugin,
      'react-hooks': reactHooksPlugin,
      'studio-tenant': {
        rules: {
          'no-unscoped-mongoose-query': noUnscopedMongooseQuery,
        },
      },
    },
    rules: {
      'studio-tenant/no-unscoped-mongoose-query': 'error',
    },
  },
];
