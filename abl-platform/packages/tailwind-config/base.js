/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'var(--font-sans)',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: ['var(--font-mono)', 'Fira Code', 'SF Mono', 'Monaco', 'monospace'],
      },
      colors: {
        // Design system semantic colors (CSS variable-backed)
        // These enable Tailwind modifiers like bg-error/20, border-success/30, etc.
        background: {
          DEFAULT: 'hsl(var(--background) / <alpha-value>)',
          subtle: 'hsl(var(--background-subtle) / <alpha-value>)',
          muted: 'hsl(var(--background-muted) / <alpha-value>)',
          elevated: 'hsl(var(--background-elevated) / <alpha-value>)',
        },
        foreground: {
          DEFAULT: 'hsl(var(--foreground) / <alpha-value>)',
          muted: 'hsl(var(--foreground-muted) / <alpha-value>)',
          meta: 'hsl(var(--foreground-meta) / <alpha-value>)',
          subtle: 'hsl(var(--foreground-subtle) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'hsl(var(--border) / <alpha-value>)',
          muted: 'hsl(var(--border-muted) / <alpha-value>)',
          focus: 'hsl(var(--border-focus) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
          muted: 'hsl(var(--accent-muted) / <alpha-value>)',
          subtle: 'hsl(var(--accent-subtle) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
          muted: 'hsl(var(--success-muted) / <alpha-value>)',
          subtle: 'hsl(var(--success-subtle) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
          muted: 'hsl(var(--warning-muted) / <alpha-value>)',
          subtle: 'hsl(var(--warning-subtle) / <alpha-value>)',
        },
        error: {
          DEFAULT: 'hsl(var(--error) / <alpha-value>)',
          foreground: 'hsl(var(--error-foreground) / <alpha-value>)',
          muted: 'hsl(var(--error-muted) / <alpha-value>)',
          subtle: 'hsl(var(--error-subtle) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'hsl(var(--info) / <alpha-value>)',
          foreground: 'hsl(var(--info-foreground) / <alpha-value>)',
          muted: 'hsl(var(--info-muted) / <alpha-value>)',
          subtle: 'hsl(var(--info-subtle) / <alpha-value>)',
        },
        purple: {
          DEFAULT: 'hsl(var(--purple) / <alpha-value>)',
          foreground: 'hsl(var(--purple-foreground) / <alpha-value>)',
          muted: 'hsl(var(--purple-muted) / <alpha-value>)',
          subtle: 'hsl(var(--purple-subtle) / <alpha-value>)',
        },
        orange: {
          DEFAULT: 'hsl(var(--orange) / <alpha-value>)',
          foreground: 'hsl(var(--orange-foreground) / <alpha-value>)',
          muted: 'hsl(var(--orange-muted) / <alpha-value>)',
          subtle: 'hsl(var(--orange-subtle) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
