import baseConfig from '@agent-platform/tailwind-config';
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [baseConfig],
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
    '!./src/**/*.test.{js,ts,jsx,tsx}',
    '!./src/**/__tests__/**/*',
    '../../packages/design-tokens/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      zIndex: {
        'portal-dropdown': '9999',
      },
      colors: {
        // Trace event type colors (Studio-specific)
        'trace-llm': '#3b82f6',
        'trace-tool': '#10b981',
        'trace-decision': '#3b82f6',
        'trace-constraint': '#f59e0b',
        'trace-handoff': '#ec4899',
        'trace-escalation': '#ef4444',
        'trace-error': '#dc2626',
      },
      keyframes: {
        'badge-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)', opacity: '0' },
          to: { transform: 'translateX(0)', opacity: '1' },
        },
        'slide-out-right': {
          from: { transform: 'translateX(0)', opacity: '1' },
          to: { transform: 'translateX(100%)', opacity: '0' },
        },
        'fade-scale-in': {
          from: { transform: 'scale(0.8)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        'node-appear': {
          from: { transform: 'scale(0.9)', opacity: '0' },
          to: { transform: 'scale(1)', opacity: '1' },
        },
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0.5)' },
          '70%': { boxShadow: '0 0 0 6px rgba(59, 130, 246, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(59, 130, 246, 0)' },
        },
        'completion-flash': {
          '0%': { opacity: '0.7' },
          '50%': { opacity: '1' },
          '100%': { opacity: '1' },
        },
        'error-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '20%': { transform: 'translateX(-4px)' },
          '40%': { transform: 'translateX(4px)' },
          '60%': { transform: 'translateX(-3px)' },
          '80%': { transform: 'translateX(3px)' },
        },
      },
      animation: {
        'badge-pulse': 'badge-pulse 1.5s ease-in-out infinite',
        'slide-in-right': 'slide-in-right 350ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-out-right': 'slide-out-right 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-scale-in': 'fade-scale-in 150ms cubic-bezier(0.16, 1, 0.3, 1)',
        'node-appear': 'node-appear 250ms cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-ring': 'pulse-ring 1.5s ease-in-out infinite',
        'completion-flash': 'completion-flash 400ms ease-out forwards',
        'error-shake': 'error-shake 400ms ease-in-out forwards',
      },
    },
  },
  plugins: [typography],
};
